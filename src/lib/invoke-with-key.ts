/**
 * 函数调用封装
 * 直接调用各服务 API，使用设置中配置的 API Key
 */
import {
  getApiConfig,
  prefersJimengCli,
  resolveConfiguredModelName,
} from "@/lib/api-config";
import { getNetworkRetrySettings } from "@/lib/network-retry-settings";
import {
  callGemini,
  callGeminiStream,
  extractText,
  extractImageBase64,
  explainGeminiNoText,
  getInlineData,
  fetchImageAsBase64,
  uploadImageToStorage,
  callSeedreamImage,
  callTuziImageGeneration,
  callAsyncImageGeneration,
  pollAsyncImageResult,
  isAsyncImageTaskPendingError,
  rewriteToFirstFrame,
  directFetch,
  resolveDirectApiKey,
  DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS,
  DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS,
  CHAR_STYLE_MAP,
  SCENE_STYLE_MAP,
  STORYBOARD_STYLE_MAP,
  DEFAULT_GEMINI_BASE_URL,
} from "@/lib/gemini-client";
import {
  DEFAULT_DECOMPOSE_MODEL,
  readStoredDecomposeModel,
} from "@/lib/gemini-text-models";
import { resolveVideoImageRequestPrefs } from "@/lib/home-agent/image-models";
import { videoModelSupportsDirectReferenceImage } from "@/lib/home-agent/video-models";
import { compressImage } from "@/lib/image-compress";
import {
  dreaminaCliCancelVideo,
  dreaminaCliGenerateVideo,
  dreaminaCliQueryResult,
  getDreaminaCliModelCatalog,
  isDreaminaCliAvailable,
} from "@/lib/dreamina-cli";
import { createAccumulatedTextDeltaForwarder } from "@/lib/streaming-delta";

const TUZI_BASE_URL = "https://api.tuziapi.com";

/** 剧本识别（阶段一）单次请求上限 */
const SCRIPT_EXTRACT_TIMEOUT_MS = 20 * 60_000;
/** 剧本拆解（阶段二）每块 / 整本单次请求上限 */
const SCRIPT_DECOMPOSE_TIMEOUT_MS = 20 * 60_000;

function trimApiBase(raw: string | undefined, fallback: string): string {
  const t = (raw || "").trim().replace(/\/$/, "");
  return t || fallback;
}

function getTuziBaseUrl(): string {
  return trimApiBase(getApiConfig().tuziEndpoint, TUZI_BASE_URL);
}

function getSeedanceBaseUrl(): string {
  const c = getApiConfig();
  const raw = (c.jimengEndpoint || c.geminiEndpoint || "").trim();
  return (
    raw
      .replace(/\/v1beta(\/.*)?$/i, "")
      .replace(/\/v1(\/.*)?$/i, "")
      .replace(/\/$/, "") || DEFAULT_GEMINI_BASE_URL.replace(/\/v1beta$/i, "")
  );
}

function getSeedanceVideoTasksBaseUrl(): string {
  return `${getSeedanceBaseUrl()}/v1/videos`;
}

function isJimengArkTasksEndpoint(value: string | undefined): boolean {
  return /\/contents\/generations\/tasks$/i.test(trimApiBase(value, ""));
}

function getJimengVideoTasksBaseUrl(): string {
  const configured = trimApiBase(getApiConfig().jimengEndpoint, "");
  if (!configured) return getSeedanceVideoTasksBaseUrl();
  if (isJimengArkTasksEndpoint(configured)) return configured;
  if (/\/api\/v3$/i.test(configured)) {
    return `${configured}/contents/generations/tasks`;
  }
  if (/ark\.cn-beijing\.volces\.com/i.test(configured)) {
    return configured.includes("/api/v3/")
      ? configured
      : `${configured}/api/v3/contents/generations/tasks`;
  }
  return getSeedanceVideoTasksBaseUrl();
}

function extractVideoTaskVideoUrl(payload: any): string | undefined {
  const candidates = [
    payload?.video_url,
    payload?.videoUrl,
    payload?.content?.video_url,
    payload?.content?.videoUrl,
    payload?.data?.video_url,
    payload?.data?.videoUrl,
    payload?.output?.video_url,
    payload?.output?.videoUrl,
    Array.isArray(payload?.content?.video_urls) ? payload.content.video_urls[0] : undefined,
    Array.isArray(payload?.output?.videos) ? payload.output.videos[0]?.url : undefined,
    Array.isArray(payload?.generations) ? payload.generations[0]?.url : undefined,
  ];

  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function normalizeTaskApiStatus(value: unknown): string {
  const lowered = String(value || "").trim().toLowerCase();
  if (!lowered) return "processing";
  if (/(completed|succeeded|success|done|finished)/.test(lowered)) return "succeeded";
  if (/(failed|error|cancel)/.test(lowered)) return "failed";
  if (/(queued|pending|submitted|created)/.test(lowered)) return "queued";
  return "processing";
}

function videoHttp(
  url: string,
  headers: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
  service: "tuzi" | "jimeng" = "jimeng",
) {
  return directFetch(url, headers, body, signal, service);
}

async function videoHttpRequest(params: {
  url: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
  service?: "tuzi" | "jimeng";
  method?: "GET" | "POST" | "DELETE";
}) {
  const {
    url,
    headers = {},
    body,
    signal,
    service = "jimeng",
    method = "GET",
  } = params;

  if (method === "GET" || method === "POST") {
    return directFetch(url, headers, body, signal, service);
  }

  if (signal?.aborted) {
    throw new Error("请求已取消");
  }

  const mergedHeaders: Record<string, string> = {
    ...headers,
    Authorization: headers.Authorization || headers.authorization || `Bearer ${resolveDirectApiKey(service)}`,
  };
  const finalHeaders = body instanceof FormData
    ? Object.fromEntries(
        Object.entries(mergedHeaders).filter(([key]) => key.toLowerCase() !== "content-type"),
      )
    : mergedHeaders;

  return fetch(url, {
    method,
    headers: finalHeaders,
    body: method === "DELETE" ? undefined : body,
    signal,
  });
}

function extractFirstJsonObject(raw: string): string {
  const cleaned = String(raw || "").replace(/^\uFEFF/, "").trim();
  const fenceMatch =
    cleaned.match(/```json\s*([\s\S]*?)```/i) ||
    cleaned.match(/```\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function parseJsonResponseLoose<T>(raw: string): T | null {
  try {
    return JSON.parse(extractFirstJsonObject(raw)) as T;
  } catch {
    return null;
  }
}

function summarizeInlineData(
  inlineData: { mimeType?: string; data?: string } | null | undefined,
) {
  return {
    hasData: !!inlineData?.data,
    mimeType: inlineData?.mimeType ?? null,
    dataLength: inlineData?.data?.length ?? 0,
  };
}

function summarizeExtractedImage(
  image: { base64?: string; mimeType?: string } | null | undefined,
) {
  return {
    hasImage: !!image?.base64,
    base64Length: image?.base64?.length ?? 0,
    mimeType: image?.mimeType ?? null,
  };
}

function summarizeGeminiImageResponse(response: any) {
  const parts = response?.candidates?.[0]?.content?.parts;
  return {
    hasCandidates: Array.isArray(response?.candidates),
    candidatesLength: response?.candidates?.length ?? 0,
    firstCandidateFinishReason: response?.candidates?.[0]?.finishReason ?? null,
    partsLength: Array.isArray(parts) ? parts.length : 0,
    inlineDataParts: Array.isArray(parts) ? parts.filter((part: any) => !!part?.inlineData).length : 0,
    textParts:
      Array.isArray(parts)
        ? parts.filter((part: any) => typeof part?.text === "string" && part.text.length > 0).length
        : 0,
  };
}

function summarizeUploadImagePayload(imageBase64: string, mimeType: string) {
  return {
    imageBase64Type: typeof imageBase64,
    imageBase64Length: imageBase64?.length ?? 0,
    mimeType,
  };
}

function resolveImageFallbackModel(model: string): string | null {
  const fallbackMap: Record<string, string> = {
    "gemini-3-pro-image-preview-async": "gemini-3-pro-image-preview",
    "gemini-3-pro-image-preview-2k-async": "gemini-3-pro-image-preview-2k",
    "gemini-3-pro-image-preview-4k-async": "gemini-3-pro-image-preview-4k",
    "nano-banana-pro": "nano-banana-pro",
    "nano-banana-pro-2k": "nano-banana-pro-2k",
    "nano-banana-pro-4k": "nano-banana-pro-4k",
    "nano-banana-2": "gemini-3-pro-image-preview",
    "nano-banana-2-2k": "gemini-3-pro-image-preview-2k",
    "nano-banana-2-4k": "gemini-3-pro-image-preview-4k",
    "nano-banana-2-async": "gemini-3-pro-image-preview",
    "nano-banana-2-2k-async": "gemini-3-pro-image-preview-2k",
    "nano-banana-2-4k-async": "gemini-3-pro-image-preview-4k",
    "gpt-image-2": "gpt-image-2",
  };
  return fallbackMap[model] || null;
}

async function appendReferenceInlineData(parts: any[], referenceImageUrl?: string) {
  if (!referenceImageUrl) return;
  const inlineData = await getInlineData(referenceImageUrl);
  if (!inlineData) return;

  if (inlineData.data.length >= 512 * 1024) {
    const compressed = await compressImage(
      `data:${inlineData.mimeType};base64,${inlineData.data}`,
      1.5 * 1024 * 1024,
      { maxDim: 2048, minQuality: 0.3 },
    );
    const base64Data = compressed.split(",")[1];
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: base64Data },
    });
    return;
  }

  parts.push({ inlineData });
}

async function callSyncResolvedImageModel(
  model: string,
  parts: any[],
  options: {
    aspectRatio: string;
    imageSize: "1K" | "2K" | "4K";
    signal?: AbortSignal;
  },
) {
  return callGemini(model, [{ role: "user", parts }], {
    responseModalities: ["IMAGE", "TEXT"],
    imageConfig: {
      aspectRatio: options.aspectRatio,
      imageSize: options.imageSize,
    },
  }, options.signal);
}

async function callResolvedSyncImageModel(params: {
  model: string;
  prompt: string;
  parts: any[];
  providerAspectRatio: string;
  providerImageSize: "1K" | "2K" | "4K";
  referenceImageUrl?: string;
  signal?: AbortSignal;
  usesImageGenerationsEndpoint: boolean;
}) {
  const {
    model,
    prompt,
    parts,
    providerAspectRatio,
    providerImageSize,
    referenceImageUrl,
    signal,
    usesImageGenerationsEndpoint,
  } = params;

  if (usesImageGenerationsEndpoint) {
    return callTuziImageGeneration(prompt, {
      model,
      size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
      aspectRatio: providerAspectRatio,
      imageSize: providerImageSize,
      input_reference: referenceImageUrl,
      signal,
    });
  }

  const response = await callSyncResolvedImageModel(model, parts, {
    aspectRatio: providerAspectRatio,
    imageSize: providerImageSize,
    signal,
  });
  const extracted = await extractImageBase64(response);
  if (!extracted) {
    throw new Error(explainGeminiNoText(response) || "Synchronous image model returned no image.");
  }
  return extracted;
}

async function runResolvedGeminiImageGeneration(params: {
  prompt: string;
  parts: any[];
  selectedModel: string;
  transportModel: string;
  fallbackModel: string;
  usesAsyncTransport: boolean;
  providerAspectRatio: string;
  providerImageSize: "1K" | "2K" | "4K";
  referenceImageUrl?: string;
  signal?: AbortSignal;
  usesImageGenerationsEndpoint: boolean;
}) {
  const {
    prompt,
    parts,
    selectedModel,
    transportModel,
    fallbackModel,
    usesAsyncTransport,
    providerAspectRatio,
    providerImageSize,
    referenceImageUrl,
    signal,
    usesImageGenerationsEndpoint,
  } = params;

  if (usesAsyncTransport) {
    try {
      const { task_id, shouldUseFallback } = await callAsyncImageGeneration(prompt, {
        model: transportModel,
        size: providerAspectRatio,
        input_reference: referenceImageUrl,
        signal,
      });

      if (shouldUseFallback) {
        return callResolvedSyncImageModel({
          model: fallbackModel,
          prompt,
          parts,
          providerAspectRatio,
          providerImageSize,
          referenceImageUrl,
          signal,
          usesImageGenerationsEndpoint,
        });
      }

      return pollAsyncImageResult(task_id, {
        maxAttempts: DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS,
        maxDurationMs: DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS,
        signal,
        prompt,
        size: providerAspectRatio,
        input_reference: referenceImageUrl,
      });
    } catch (error) {
      if (isAsyncImageTaskPendingError(error) || isAbortLikeError(error)) {
        throw error;
      }
      return callResolvedSyncImageModel({
        model: fallbackModel,
        prompt,
        parts,
        providerAspectRatio,
        providerImageSize,
        referenceImageUrl,
        signal,
        usesImageGenerationsEndpoint,
      });
    }
  }

  try {
    return await callResolvedSyncImageModel({
      model: selectedModel,
      prompt,
      parts,
      providerAspectRatio,
      providerImageSize,
      referenceImageUrl,
      signal,
      usesImageGenerationsEndpoint,
    });
  } catch (error) {
    const resolvedFallbackModel = resolveImageFallbackModel(selectedModel);
    if (resolvedFallbackModel && resolvedFallbackModel !== selectedModel) {
      return callResolvedSyncImageModel({
        model: resolvedFallbackModel,
        prompt,
        parts,
        providerAspectRatio,
        providerImageSize,
        referenceImageUrl,
        signal,
        usesImageGenerationsEndpoint,
      });
    }
    throw error;
  }
}

const HOME_AGENT_MANAGED_IMAGE_MODELS = new Set([
  "ano-banana-pro",
  "nano-banana-pro",
  "nano-banana-pro-2k",
  "nano-banana-pro-4k",
  "nano-banana-2",
  "nano-banana-2-2k",
  "nano-banana-2-4k",
  "nano-banana-2-async",
  "nano-banana-2-2k-async",
  "nano-banana-2-4k-async",
  "gemini-3-pro-image-preview",
  "gemini-3-pro-image-preview-2k",
  "gemini-3-pro-image-preview-4k",
  "gemini-3-pro-image-preview-async",
  "gemini-3-pro-image-preview-2k-async",
  "gemini-3-pro-image-preview-4k-async",
  "gpt-image-2",
]);

function isHomeAgentManagedImageModel(model?: string | null): boolean {
  const normalized = String(model || "").trim().toLowerCase();
  return normalized ? HOME_AGENT_MANAGED_IMAGE_MODELS.has(normalized) : false;
}

function shouldResolveManagedImageRequest(model: string, body: any): boolean {
  if (body?.modelFamily || body?.imageGenerationPrefs) return true;
  if (!model && (body?.resolution || body?.aspectRatio)) return true;
  return isHomeAgentManagedImageModel(model);
}

function resolveProviderAspectRatio(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return ["16:9", "9:16", "1:1", "2:3", "3:2"].includes(normalized)
    ? normalized
    : fallback;
}

function inferProviderImageSize(
  model: string,
  requestedResolution: unknown,
  fallback: "1K" | "2K" | "4K" = "2K",
): "1K" | "2K" | "4K" {
  const normalizedResolution =
    typeof requestedResolution === "string"
      ? requestedResolution.trim().toLowerCase()
      : "";
  if (normalizedResolution === "4k") return "4K";
  if (normalizedResolution === "2k") return "2K";
  if (normalizedResolution === "default") return "1K";

  const normalizedModel = String(model || "").trim().toLowerCase();
  if (normalizedModel.includes("-4k")) return "4K";
  if (normalizedModel.includes("-2k")) return "2K";
  return fallback;
}

function resolveSeedreamSize(
  aspectRatio: string,
  imageSize: "1K" | "2K" | "4K",
): string {
  const matrix: Record<string, Record<"1K" | "2K" | "4K", string>> = {
    "16:9": {
      "1K": "1280x720",
      "2K": "2560x1440",
      "4K": "3840x2160",
    },
    "9:16": {
      "1K": "720x1280",
      "2K": "1440x2560",
      "4K": "2160x3840",
    },
    "1:1": {
      "1K": "1024x1024",
      "2K": "2048x2048",
      "4K": "4096x4096",
    },
    "2:3": {
      "1K": "1024x1536",
      "2K": "1536x2304",
      "4K": "3072x4608",
    },
    "3:2": {
      "1K": "1536x1024",
      "2K": "2304x1536",
      "4K": "4608x3072",
    },
  };

  return matrix[aspectRatio]?.[imageSize] ?? matrix["16:9"][imageSize];
}

function resolveImageRuntimeConfig(
  body: any,
  options: {
    defaultModel: string;
    fallbackAspectRatio: string;
    fallbackImageSize?: "1K" | "2K" | "4K";
    overrideAspectRatio?: string;
  },
) {
  const explicitModel = typeof body?.model === "string" ? body.model.trim() : "";
  const providerAspectRatio = resolveProviderAspectRatio(
    options.overrideAspectRatio ?? body?.aspectRatio,
    options.fallbackAspectRatio,
  );

  if (shouldResolveManagedImageRequest(explicitModel, body)) {
    const resolved = resolveVideoImageRequestPrefs({
      model: explicitModel || undefined,
      modelFamily: body?.modelFamily,
      resolution: body?.resolution,
      aspectRatio: providerAspectRatio,
      imageGenerationPrefs: body?.imageGenerationPrefs,
    });

    return {
      selectedModel: resolved.resolvedModel,
      transportModel: resolved.transportModel,
      fallbackModel: resolved.fallbackModel,
      providerAspectRatio: resolved.providerAspectRatio,
      providerImageSize: resolved.providerImageSize,
      usesAsyncTransport: resolved.usesAsyncTransport,
      usesImageGenerationsEndpoint: resolved.usesImageGenerationsEndpoint,
    };
  }

  const selectedModel = explicitModel || options.defaultModel;
  return {
    selectedModel,
    transportModel: selectedModel,
    fallbackModel: resolveImageFallbackModel(selectedModel) ?? selectedModel,
    providerAspectRatio,
    providerImageSize: inferProviderImageSize(
      selectedModel,
      body?.resolution,
      options.fallbackImageSize ?? "2K",
    ),
    usesAsyncTransport: selectedModel.includes("-async"),
    usesImageGenerationsEndpoint: false,
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "请求已取消" ||
    error.message === "任务已取消"
  );
}

// ===== PROMPTS =====

const EXTRACTION_PROMPT = `你是一位专业影视制作分析师，擅长从剧本中精确提取角色和场景信息。

你的任务是仔细阅读用户提供的剧本，提取所有角色和场景设定。

### ⚠️ 最重要原则：零遗漏 + 严格分类

**【严禁混淆角色与场景】**
- "角色"是指**有名字的人物**（人、动物、AI等有行为主体）。
- "场景设定"是指**地点、环境、空间**（如"实验室"、"城市废墟"、"宇宙飞船内部"）。
- 地名、建筑名、组织名、物品名 **绝对不是角色**，严禁放入 characters 数组。
- 判定标准：该名称是否能"说话"、"行动"、"穿衣服"？如果不能，它就是场景或道具，不是角色。

你必须执行以下两步流程：

**第一步：全文扫描，列出所有角色名**
- 从头到尾逐行扫描剧本，记录每一个出现过的角色名称。
- 角色名可能出现在以下位置：方括号标注如[角色名]或[角色名·年龄·服装]、对白前缀如"角色名："、叙述文本中直接提及。
- **任何有名字的人物都算角色**，哪怕只出现一次。
- 群众演员/无名路人不需要提取，但有称谓的（如"老板"、"医生张"）需要提取。
- **角色名统一**：无论剧本中角色名后缀如何变化，name 字段统一为角色的基础名称（不含年龄和服装后缀），例如 [NATHAN COLE·32岁·探险装备] 的 name 应为 "NATHAN COLE"。

**第二步：逐个角色填写详细信息**
- 确认第一步列出的每个角色都在最终输出中，不允许遗漏任何一个。

### 角色提取要求

1. **外貌描述**：基于剧本中的直接描述或隐含线索，给出角色的外貌特征（年龄、体型、发型、肤色等）。如果剧本没有明确描写，请根据角色身份和情境做合理推断。
2. **识别角色变体（可选）**：如果同一角色在剧本中明确出现了 2 种及以上可区分的形象变体，请输出 "costumes" 数组。
   - 角色变体不仅限于服装，也可以包含年龄阶段、战损状态、妆容气质、职业伪装等会影响参考图生成的明显视觉变化。
   - 只有在剧本中能明确区分时才输出；如果没有清晰变体，不要硬编，留空或省略即可。
   - "label" 要简短可选，如“校服”“战损红衣”“成年后”“夜行伪装”。
   - "description" 写清该变体相对主形象的关键视觉差异。

### 场景设定提取要求

1. 识别剧本中出现的所有不同场景/地点。
2. 为每个场景提供详细的环境描述（时间、光线、空间特征、氛围等）。
3. 场景名称应简洁明了。
4. **识别场景变体（可选）**：如果同一场景在剧本中明确出现了 2 种及以上可区分的时间/天气/季节/环境状态，请输出 "timeVariants" 数组。
   - 例如：清晨 / 黄昏 / 雨夜 / 雪后 / 断电状态 / 火灾后。
   - 只有在剧本中能明确区分时才输出；如果没有清晰变体，不要硬编，留空或省略即可。
   - "label" 要简短可选。
   - "description" 写清该场景变体相对基础场景的环境变化。

### 输出格式

输出一个合法的 JSON 对象，包含以下字段：

1. "characters" - 角色信息数组（**只包含人物角色，严禁包含场景/地点/物品**），每个包含：
   - name: 角色名称（基础名称，不含年龄/服装后缀）
   - description: 角色外貌描述
   - costumes: 可选数组。仅当该角色有明确角色变体时输出，每项包含：
     - label: 变体名称
     - description: 变体说明

2. "sceneSettings" - 场景设定数组（**只包含地点/环境，严禁包含人物角色**），每个包含：
   - name: 场景名称
   - description: 环境详细描述
   - timeVariants: 可选数组。仅当该场景有明确场景变体时输出，每项包含：
     - label: 变体名称
     - description: 变体说明

3. "characterNameList" - 字符串数组，列出所有提取到的角色名称（用于交叉验证，确保零遗漏）

请严格按此 JSON 格式输出，不要输出任何其他文字。直接输出 JSON。`;

const DECOMPOSE_PROMPT_BASE = `你是专业电影分镜师。将剧本拆解为AI视频生成用的15秒分段分镜脚本。

规则：
1. **【片段数量目标】** 每集**目标{SEGMENTS_PER_EPISODE}个片段**（即{SEGMENTS_PER_EPISODE}个不同的segmentLabel），每片段15秒。如果剧本某一集内容不足以填满{SEGMENTS_PER_EPISODE}个片段，则**必须**通过拓展镜头语言（环境描写、反应特写、空镜头、过渡画面等）来补足。**台词字数限制（规则3）优先级高于片段数量目标，但请通过精简台词（在不改变原意的前提下缩减冗余用词）来尽量控制在{SEGMENTS_PER_EPISODE}个片段以内，最多允许超出2个片段（即上限{SEGMENTS_PER_EPISODE}+2个）。**
2. **【最重要】每个片段必须包含{SHOTS_PER_SEGMENT}个分镜（即{SHOTS_PER_SEGMENT}个scene对象共享同一个segmentLabel）。严禁每个片段只有1个分镜！** 例如片段"1-1"必须拆成{SHOTS_PER_SEGMENT}个不同画面的scene对象，每个scene描述该片段内的一个具体镜头/画面。
3. **【台词容量硬限制 — 最高优先级，不可违反】**：
   - 每个片段（同一segmentLabel）尽量不超过3条对话。
   - 台词字数上限取决于该片段的对话条数（**必须严格遵守，这是最高优先级的硬性约束**）：
     · 1条对话：{CHARS_1_DIAL_MIN}~{CHARS_1_DIAL_MAX}字（超过{CHARS_1_DIAL_MAX}字必须拆分）
     · 2条对话：每条{CHARS_2_DIAL_MIN}~{CHARS_2_DIAL_MAX}字（超过{CHARS_2_DIAL_MAX}字必须拆分）
     · 3条对话：每条{CHARS_3_DIAL_MIN}~{CHARS_3_DIAL_MAX}字（超过{CHARS_3_DIAL_MAX}字必须拆分）
   - **任何单条对话超出对应上限时，必须拆分为两个片段**，将多余台词顺延至下一个segmentLabel。宁可多拆片段也绝不塞词。
   - 拆分时保持台词完整性：不要在一句话中间断开，应在自然停顿处分割。
   - 每个分镜的dialogue只分配该画面时刻对应的台词，不要把整个片段的台词堆到一个分镜里。
4. 基于原文拆分，人名地名用[]包裹，禁止加戏、禁止镜头术语、对白完整保留
5. 在场但未提及的角色补充简短站位描述
6. 敏感描述替换（对白原样保留）
7. **服装匹配**：如果提供了角色服装变体信息，必须为每个分镜中的多服装角色指定当前穿着的服装label。根据剧本上下文（场景、时间线、剧情发展、年龄阶段）精确判断角色在该分镜中应穿哪套服装。
8. **角色名与服装解析**：剧本中角色名可能以 [角色名·年龄·服装名] 格式出现（如 [NATHAN COLE·32岁·探险装备]）。在 characters 数组中只填写基础角色名（如 "NATHAN COLE"），服装信息填入 characterCostumes 字段（如 {"NATHAN COLE": "32岁·探险装备"}）。同一角色在不同分镜的服装后缀变化即为服装切换的直接依据。

输出JSON，仅含"scenes"数组。每个对象：
- sceneNumber: 全局序号(整数递增，从1开始连续编号)
- segmentLabel: 片段编号如"1-1","1-2"(按15秒重新划分，同片段内的多个分镜必须共享相同的segmentLabel)
- sceneName: 场景名
- description: **只写看得到的画面内容**，不得写台词、旁白、画外音、心声；同一片段内不同分镜应有不同的画面角度或动作
- characters: 出场角色数组
- dialogue: **承载所有听得到的语言内容**，包括角色对白、旁白、画外音、电话音、心声/内心独白；"角色：台词"格式，多条换行，无则空串；如同一分镜同时有画面和语言，description写画面，dialogue写语言，不要混写；台词只分配给该分镜对应的画面时刻
- cameraDirection: 固定"无字幕、无水印、无背景音"
- duration: 该分镜建议时长（整数秒），同一 segmentLabel 下所有分镜的 duration 总和必须等于 15
- characterCostumes: 对象，key为角色名，value为该角色在此分镜中穿着的服装label（仅对有多套服装的角色填写，无多套服装的角色不填）

示例结构（片段1-1包含3个分镜）：
[
  {"sceneNumber":1,"segmentLabel":"1-1","sceneName":"战场","description":"远景：荒野上两军对峙","characters":["角色A"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"}},
  {"sceneNumber":2,"segmentLabel":"1-1","sceneName":"战场","description":"中景：角色A举刀冲锋","characters":["角色A"],"dialogue":"角色A：冲啊！","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"}},
  {"sceneNumber":3,"segmentLabel":"1-1","sceneName":"战场","description":"特写：刀刃碰撞火花四溅","characters":["角色A","角色B"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"}}
]


⚠️ 最终检查清单（输出前必须逐条验证）：
1. 每条对话是否都在字数上限之内？超过则必须拆分片段。
2. 每个片段是否有{SHOTS_PER_SEGMENT}个分镜？
3. 片段总数是否接近{SEGMENTS_PER_EPISODE}？（因台词拆分可以略多，但不可少于{SEGMENTS_PER_EPISODE}）
4. description 是否只写画面内容，没有混入台词/旁白/心声？
5. dialogue 是否承载了所有语言内容（旁白/画外音/心声均放入dialogue，不遗漏）？

直接输出JSON，不得截断，无思考过程。`;

const PACE_CONFIG: Record<
  string,
  {
    shots: string;
    preferredShots: number;
    chars1: [number, number]; // 1 dialogue: [min, max]
    chars2: [number, number]; // 2 dialogues: per-line [min, max]
    chars3: [number, number]; // 3 dialogues: per-line [min, max]
  }
> = {
  slow: { shots: "2~4", preferredShots: 3, chars1: [15, 22], chars2: [11, 18], chars3: [7, 14] },
  medium: { shots: "3~5", preferredShots: 4, chars1: [15, 27], chars2: [11, 22], chars3: [7, 17] },
  fast: { shots: "4~6", preferredShots: 5, chars1: [15, 32], chars2: [11, 26], chars3: [7, 20] },
};


function buildDecomposePrompt(
  pace?: string,
  segmentsPerEpisode?: number | null,
  episodeDurationSeconds?: number | null,
): string {
  const cfg = PACE_CONFIG[pace || "medium"] || PACE_CONFIG.medium;
  const segments = segmentsPerEpisode || 5;
  const basePrompt = DECOMPOSE_PROMPT_BASE.replace(
    /\{SEGMENTS_PER_EPISODE\}/g,
    String(segments),
  )
    .replace(/\{SHOTS_PER_SEGMENT\}/g, cfg.shots)
    .replace(/\{CHARS_1_DIAL_MIN\}/g, String(cfg.chars1[0]))
    .replace(/\{CHARS_1_DIAL_MAX\}/g, String(cfg.chars1[1]))
    .replace(/\{CHARS_2_DIAL_MIN\}/g, String(cfg.chars2[0]))
    .replace(/\{CHARS_2_DIAL_MAX\}/g, String(cfg.chars2[1]))
    .replace(/\{CHARS_3_DIAL_MIN\}/g, String(cfg.chars3[0]))
    .replace(/\{CHARS_3_DIAL_MAX\}/g, String(cfg.chars3[1]));

  if (episodeDurationSeconds && episodeDurationSeconds > 0) {
    const durationConstraint = `\n\n⚠️ 【时长硬性约束 — 最高优先级，不可违反】本集视频总时长为 ${episodeDurationSeconds} 秒，每片段固定 15 秒，因此必须输出**恰好 ${segments} 个片段**，不得多也不得少。台词过多时只精简台词用词（不改变原意），description 的画面细节描述不得缩减；内容不足时必须补充空镜/环境镜头，以确保片段数严格等于 ${segments}。`;
    return `${basePrompt}${durationConstraint}`;
  }

  return basePrompt;
}

function resolveShotRangeForPace(pace?: string): { min: number; max: number; preferred: number } {
  const cfg = PACE_CONFIG[pace || "medium"] || PACE_CONFIG.medium;
  const match = cfg.shots.match(/^(\d+)\D+(\d+)$/);
  const min = match ? Number.parseInt(match[1], 10) : cfg.preferredShots;
  const max = match ? Number.parseInt(match[2], 10) : cfg.preferredShots;
  return {
    min: Number.isFinite(min) && min > 0 ? min : cfg.preferredShots,
    max: Number.isFinite(max) && max > 0 ? max : cfg.preferredShots,
    preferred: cfg.preferredShots,
  };
}

function resolveMinShotsPerSegment(pace?: string): number {
  return resolveShotRangeForPace(pace).min;
}

const VISIBLE_AUDIO_PREFIX_RE =
  /^(对白|台词|Dialogue|旁白|画外音|内心独白|心声|独白|VO|V\.O\.|OS|O\.S\.)\s*[：:]\s*/i;
const NON_DIALOGUE_LABEL_RE =
  /^(全景|中景|近景|远景|特写|大全景|中近景|近特写|双人近景|双人中景|双人特写|空镜|俯拍|仰拍|跟拍|推进|拉远|拉近|侧拍|背拍|背影|正面|全身|半身|局部|镜头|机位|画面|场景|转场|内景|外景|音效|SFX|字幕)$/i;

const NARRATION_SPEAKER_RE =
  /^(鏃佺櫧|鐢诲闊硘鍐呭績鐙櫧|蹇冨０|鐙櫧|VO|V\.O\.|OS|O\.S\.)$/i;
const SEGMENT_DURATION_SECONDS = 15;

function normalizeNarrationSpeakerToken(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/^[[【\s]+|[\]】\s]+$/g, "")
    .replace(/[（(]\s*(VO|V\.O\.|OS|O\.S\.|画外音)\s*[)）]$/i, "")
    .trim();
}

function uniqueTrimmedStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });

  return result;
}

function splitStructuredText(value: string): string[] {
  return String(value || "")
    .split(/\s*\|\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isNarrationSpeaker(value: string): boolean {
  return NARRATION_SPEAKER_RE.test(normalizeNarrationSpeakerToken(value));
}

function normalizeSceneCharacterName(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized || isNarrationSpeaker(normalized)) return null;
  return normalized;
}

function normalizeDialogueLine(line: string): string | null {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;

  if (VISIBLE_AUDIO_PREFIX_RE.test(trimmed)) {
    const content = trimmed.replace(VISIBLE_AUDIO_PREFIX_RE, "").trim();
    if (!content) return null;
    if (/^(旁白|画外音|内心独白|心声|独白|VO|V\.O\.|OS|O\.S\.)\s*[：:]/i.test(trimmed)) {
      return `旁白：${content}`;
    }
    return content;
  }

  const speakerMatch = trimmed.match(/^([^\s:：[\]()（）|]{1,20})\s*[：:]\s*(.+)$/);
  if (!speakerMatch) return null;

  const speaker = speakerMatch[1].trim();
  const content = speakerMatch[2].trim();
  if (!speaker || !content || NON_DIALOGUE_LABEL_RE.test(speaker)) {
    return null;
  }

  return `${speaker}：${content}`;
}

function extractDialogueSpeaker(line: string): string | null {
  const normalized = String(line || "").trim();
  const match = normalized.match(/^([^：:\n]{1,20})[：:]\s*(.+)$/);
  if (!match) return null;
  const speaker = match[1].trim();
  if (!speaker || speaker === "旁白") return null;
  return speaker;
}

function stripDialogueSpeaker(line: string): string {
  const normalized = String(line || "").trim();
  const match = normalized.match(/^[^：:\n]{1,20}[：:]\s*(.+)$/);
  return (match?.[1] || normalized).replace(/\s+/g, "");
}

export function normalizeDecomposeScenes(scenes: any[]): any[] {
  const normalizedScenes = (Array.isArray(scenes) ? scenes : []).map((scene, index) => {
    const normalizedDescriptionParts: string[] = [];
    const normalizedDialogueLines: string[] = [];

    splitStructuredText(String(scene?.dialogue || "")).forEach((part) => {
      normalizedDialogueLines.push(normalizeDialogueLine(part) || part.trim());
    });

    splitStructuredText(String(scene?.description || "")).forEach((part) => {
      const normalizedLine = normalizeDialogueLine(part);
      if (normalizedLine) {
        normalizedDialogueLines.push(normalizedLine);
      } else {
        normalizedDescriptionParts.push(part);
      }
    });

    const description =
      normalizedDescriptionParts.join(" | ").trim() ||
      String(scene?.sceneName || "").trim() ||
      `镜头 ${index + 1}`;

    return {
      ...scene,
      sceneNumber:
        typeof scene?.sceneNumber === "number" && Number.isFinite(scene.sceneNumber)
          ? Math.round(scene.sceneNumber)
          : index + 1,
      description,
      dialogue: uniqueTrimmedStrings(normalizedDialogueLines).join("\n"),
      characters: uniqueTrimmedStrings([
        ...(Array.isArray(scene?.characters)
          ? scene.characters.map((characterName: string) => normalizeSceneCharacterName(characterName))
          : []),
        ...normalizedDialogueLines.map((line) => normalizeSceneCharacterName(extractDialogueSpeaker(line))),
      ]),
      cameraDirection: String(scene?.cameraDirection || "").trim() || "无字幕、无水印、无背景音",
      duration:
        typeof scene?.duration === "number" && Number.isFinite(scene.duration)
          ? Math.max(1, Math.round(scene.duration))
          : 15,
    };
  });

  return normalizeSegmentDurations(normalizedScenes);
}

function buildBalancedSegmentDurations(count: number): number[] {
  const safeCount = Math.max(1, Math.round(count || 1));
  const baseDuration = Math.floor(SEGMENT_DURATION_SECONDS / safeCount);
  let remainder = SEGMENT_DURATION_SECONDS - baseDuration * safeCount;

  return Array.from({ length: safeCount }, () => {
    const duration = baseDuration + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return Math.max(1, duration);
  });
}

function normalizeSegmentDurations(scenes: any[]): any[] {
  const normalizedScenes = Array.isArray(scenes) ? [...scenes] : [];
  const segmentIndexes = new Map<string, number[]>();

  normalizedScenes.forEach((scene, index) => {
    const segmentLabel = String(scene?.segmentLabel || "").trim() || `__segment_${index}`;
    const indexes = segmentIndexes.get(segmentLabel) || [];
    indexes.push(index);
    segmentIndexes.set(segmentLabel, indexes);
  });

  for (const indexes of segmentIndexes.values()) {
    const roundedDurations = indexes.map((sceneIndex) => {
      const duration = normalizedScenes[sceneIndex]?.duration;
      return typeof duration === "number" && Number.isFinite(duration)
        ? Math.max(1, Math.round(duration))
        : null;
    });
    const hasCompleteDurations = roundedDurations.every((duration) => duration !== null);
    const durationTotal = hasCompleteDurations
      ? roundedDurations.reduce((sum, duration) => sum + (duration || 0), 0)
      : -1;
    const nextDurations =
      hasCompleteDurations && durationTotal === SEGMENT_DURATION_SECONDS
        ? (roundedDurations as number[])
        : buildBalancedSegmentDurations(indexes.length);

    indexes.forEach((sceneIndex, offset) => {
      normalizedScenes[sceneIndex] = {
        ...normalizedScenes[sceneIndex],
        duration: nextDurations[offset],
      };
    });
  }

  return normalizedScenes;
}

function finalizeDecomposeScenes(
  scenes: any[],
  options: {
    segmentsTarget: number;
    videoPace?: string;
    allowExtraSegments?: number;
  },
): any[] {
  const normalizedScenes = normalizeDecomposeScenes(scenes);
  validateDecomposeSceneCounts(normalizedScenes, options);
  return normalizedScenes;
}

export function validateDecomposeSceneCounts(
  scenes: any[],
  options: {
    segmentsTarget: number;
    videoPace?: string;
    allowExtraSegments?: number;
  },
): void {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error("拆解结果为空，无法继续。");
  }

  const segmentsTarget = Math.max(1, Math.round(options.segmentsTarget || 1));
  const allowExtraSegments = Math.max(0, options.allowExtraSegments ?? 2);
  const shotRange = resolveShotRangeForPace(options.videoPace);
  const minShotsPerSegment = shotRange.min;
  const segmentCounts = new Map<string, number>();
  const segmentDialogueLines = new Map<string, string[]>();
  const segmentDurationTotals = new Map<string, number>();
  const cfg = PACE_CONFIG[options.videoPace || "medium"] || PACE_CONFIG.medium;

  scenes.forEach((scene, index) => {
    const segmentLabel = String(scene?.segmentLabel || "").trim();
    if (!segmentLabel) {
      throw new Error(`拆解结果缺少 segmentLabel（scene #${index + 1}）。`);
    }
    const description = String(scene?.description || "").trim();
    if (!description) {
      throw new Error(`拆解结果缺少 description（scene #${index + 1}）。`);
    }
    if (splitStructuredText(description).some((part) => Boolean(normalizeDialogueLine(part)))) {
      throw new Error(`拆解结果字段错位：scene #${index + 1} 的对白被写进 description。`);
    }
    segmentCounts.set(segmentLabel, (segmentCounts.get(segmentLabel) || 0) + 1);
    segmentDurationTotals.set(
      segmentLabel,
      (segmentDurationTotals.get(segmentLabel) || 0) +
        (typeof scene?.duration === "number" && Number.isFinite(scene.duration)
          ? Math.max(1, Math.round(scene.duration))
          : 0),
    );

    const dialogueLines = splitStructuredText(String(scene?.dialogue || ""));
    if (dialogueLines.length > 0) {
      const group = segmentDialogueLines.get(segmentLabel) || [];
      group.push(...dialogueLines);
      segmentDialogueLines.set(segmentLabel, group);
    }
  });

  const segmentCount = segmentCounts.size;
  if (segmentCount < segmentsTarget) {
    throw new Error(`拆解结果片段数不足：期望至少 ${segmentsTarget} 个，实际 ${segmentCount} 个。`);
  }

  const maxAllowedSegments = segmentsTarget + allowExtraSegments;
  if (segmentCount > maxAllowedSegments) {
    throw new Error(`拆解结果片段数超出上限：期望至多 ${maxAllowedSegments} 个，实际 ${segmentCount} 个。`);
  }

  const underfilledSegments = [...segmentCounts.entries()].filter(
    ([, shotCount]) => shotCount < minShotsPerSegment,
  );
  if (underfilledSegments.length > 0) {
    const sample = underfilledSegments
      .slice(0, 3)
      .map(([segmentLabel, shotCount]) => `${segmentLabel}(${shotCount}/${minShotsPerSegment})`)
      .join("、");
    throw new Error(`拆解结果分镜数不足：${sample}。`);
  }

  const overfilledSegments = [...segmentCounts.entries()].filter(
    ([, shotCount]) => shotCount > shotRange.max,
  );
  if (overfilledSegments.length > 0) {
    const sample = overfilledSegments
      .slice(0, 3)
      .map(([segmentLabel, shotCount]) => `${segmentLabel}(${shotCount}/${shotRange.max})`)
      .join("、");
    throw new Error(`拆解结果分镜数超出提示词上限：${sample}。`);
  }

  const durationMismatchedSegments = [...segmentDurationTotals.entries()].filter(
    ([, totalDuration]) => totalDuration > 0 && totalDuration !== SEGMENT_DURATION_SECONDS,
  );
  if (durationMismatchedSegments.length > 0) {
    const sample = durationMismatchedSegments
      .slice(0, 3)
      .map(([segmentLabel, totalDuration]) => `${segmentLabel}(${totalDuration}/${SEGMENT_DURATION_SECONDS})`)
      .join(", ");
    throw new Error(`Duration mismatch across segment shots: ${sample}`);
  }

  for (const [segmentLabel, lines] of segmentDialogueLines.entries()) {
    const normalizedLines = lines.map((line) => String(line || "").trim()).filter(Boolean);
    if (normalizedLines.length > 3) {
      throw new Error(`拆解结果对白条数超限：${segmentLabel} 含 ${normalizedLines.length} 条对白。`);
    }
    if (!normalizedLines.length) continue;

    const [, maxChars] =
      normalizedLines.length === 1
        ? cfg.chars1
        : normalizedLines.length === 2
          ? cfg.chars2
          : cfg.chars3;

    const oversizedLine = normalizedLines.find((line) => stripDialogueSpeaker(line).length > maxChars);
    if (oversizedLine) {
      throw new Error(
        `拆解结果对白字数超限：${segmentLabel} 中“${oversizedLine.slice(0, 24)}”超过 ${maxChars} 字。`,
      );
    }
  }
}

const ENHANCE_PROMPT = `你是一位专业的影视视频生成提示词工程师。你的任务是将简短的分镜描述扩展为丰富、具体、富有画面感的视频生成提示词。

## 核心原则

1. **动态感**：明确描述运动轨迹、速度变化、力量冲击。
2. **空间感**：描述前景、中景、背景的层次关系，营造纵深。
3. **画面细节**：补充材质质感、光照效果。
4. **镜头语言**：根据内容暗示合适的镜头运动。
5. **情绪氛围**：通过色调、节奏强化情绪。
6. **镜头衔接**：若输入中提供了 [Previous Shot] 或 [Next Shot]，必须确保当前镜头与相邻镜头自然过渡——当前镜头的起始状态应承接前一镜头的结束动作与情绪，结束状态应为下一镜头的开场做好铺垫；避免景别无故突变、人物位置跳切、情绪断层。

## 约束

- 输出只包含增强后的提示词文本，不要任何解释
- 保持原文核心叙事不变
- 控制在1000词以内
- 使用中文输出
- 不要添加原文没有的角色或剧情事件
- 如果输入包含【对白】或 [Dialogue]，增强后的提示词必须逐字保留全部台词内容；不得改写、删减、同义替换、换序或新增台词。可以补充语气、停顿、口型和情绪描述，但台词文字必须完全一致。
- 如果输入没有对白，增强后的提示词必须明确“无台词”，不得生成任何角色对白、旁白、画外音、心声或其他可听语言内容。
- 若有前后镜头信息，衔接处理优先级高于画面细节扩展

## 输出格式

请严格按以下 JSON 格式输出：
{"enhanced":"增强后的提示词","duration":秒数(整数,4到15),"durationReason":"简短说明时长判定理由"}

## duration 判定规则（整数，范围4~15秒）

### 维度1：动作复杂度（权重最高）
- 无动作/静态画面 → 基准4秒
- 单一简单动作 → 基准5~6秒
- 中等动作 → 基准6~8秒
- 复杂动作 → 基准8~10秒
- 极复杂多阶段动作 → 基准10~12秒
- 史诗级长镜头/蒙太奇 → 基准12~15秒

### 维度2：对白长度
- 无对白 → +0秒
- 短对白（≤10字） → +0秒
- 中对白（11~25字） → +1~2秒
- 长对白（>25字） → +2~4秒

### 维度3：情绪节奏
- 快节奏 → -1秒
- 正常节奏 → +0秒
- 慢节奏 → +1~2秒

最终时长 = clamp(基准 + 对白加成 + 情绪调整, 4, 15)`;

const SEGMENT_ENHANCE_PROMPT = `你是一位拥有20年经验的专业影视剪辑师、导演和AI视频提示词总监，精通多分镜叙事、镜头语言、节奏压缩、转场设计、画面连续性和短剧出片提示词工程。你的任务不是概括分镜，而是把一个片段内的所有分镜重新编排成一条可直接交给视频生成模型的高质量、多镜头、电影化片段提示词。

## 你的专业身份
你同时承担四个角色：
1. 导演：确保剧情、人物动作、情绪变化、视线方向、走位和表演节奏完整成立。
2. 剪辑师：把多个分镜压缩进目标时长，设计切点、转场、节奏强弱和镜头衔接。
3. 摄影指导：明确景别、机位、镜头运动、焦段感、景深、光影、前中后景层次和画面重心。
4. 提示词总监：把上述内容写成视频模型能执行的连续画面描述，避免抽象评价、空泛风格词和遗漏剧情动作。

## 最高优先级
1. **完整保留全部分镜内容**：输入的每个分镜都必须在最终 prompt 中出现，且顺序不能改变。不得合并到看不出来、不得省略、不得只用一句话概括。
2. **台词逐字锁定**：分镜列表中如含【台词】，整合后的 prompt 必须逐字保留全部台词内容，并保持原顺序；不得改写、删减、同义替换、换序或新增台词。可以补充语气、停顿、口型和情绪描述，但台词文字必须完全一致。
3. **无台词锁定**：如果所有分镜都没有台词，整合后的 prompt 必须明确“无台词”，不得生成任何角色对白、旁白、画外音、心声或其他可听语言内容。
4. **角色一致性**：同一角色在所有分镜中必须保持完全相同的面部轮廓、发型发色、肤色、年龄感、身形、服装款式、服装颜色、饰品和识别点。若提供角色参考图，必须把图中可见特征融入描述。
5. **场景一致性**：同一场景在不同镜头中的空间结构、光源方向、色调、天气、时间段、道具位置必须连续。若提供场景参考图，必须把图中的构图、材质、光线、空间氛围融入描述。
6. **不得新增剧情**：可以补充可视化细节、动作过渡、表演微反应、镜头调度和环境质感，但不得添加原始分镜没有的新角色、新事件、新台词或改变剧情因果。

## 工作方法：必须先在心中完成以下剪辑规划，再写 final prompt
你不需要把规划过程输出到 JSON 外部，但最终 prompt 必须体现这些规划。

### 1. 时间轴规划
- 根据输入的目标时长、模型最大时长和每个分镜建议时长，重新分配每个分镜的屏幕时间。
- 所有分镜都必须获得明确的时间段，例如 0.0-2.4s、2.4-5.1s。
- 如果目标时长被压缩，优先压缩停顿、环境铺垫和转场冗余；不得压缩掉关键动作、台词、情绪转折或剧情信息。
- 分镜时间段必须连续，不要出现空档；总时长不得超过模型最大支持时长。

### 2. 切镜与转场设计
每两个相邻分镜之间都必须设计一个明确的衔接方式。可使用但不限于：
- 动作匹配剪辑：用上一镜头的动作方向、手势、转身、奔跑、抬头、回眸衔接下一镜头。
- 视线匹配剪辑：上一镜头人物看向某处，下一镜头展示被看的对象或反应。
- 情绪反应切：冲突、震惊、沉默、愤怒、犹豫等情绪点切到近景或特写。
- 景别推进：远景建立空间，中景承接动作，近景/特写强化情绪或信息。
- 运动方向延续：角色移动方向、镜头推拉摇移方向必须连贯，避免左右方向突然反转。
- 光影/色彩转场：用同一光源、同一色调、阴影移动、雨雾烟尘、门窗遮挡等完成自然过渡。
- 硬切：只在动作点、情绪爆点、信息揭示、节奏加速时使用，并说明切点。
- 淡入淡出/叠化：只在时间流逝、回忆感、梦境感、情绪缓冲时使用。
不要泛泛写“自然转场”，必须写出“从什么切到什么、为什么这样切、画面如何连续”。

### 3. 镜头内容写法
每个分镜在 final prompt 中至少包含：
- 分镜编号与时间段
- 景别与机位，例如远景、中景、近景、特写、俯拍、仰拍、肩后镜头、跟拍、推进
- 画面主体和动作变化
- 角色表情、口型、情绪或身体反应
- 光线、色调、环境材质、天气/烟尘/雨雾/空间层次
- 与前后分镜的衔接方式
- 若有台词，必须写明台词出现在哪个时间段、谁说、口型和情绪如何，但台词文字不得变

### 4. 电影质感要求
- 画面要具体，不写空泛词。避免只写“电影感”“高级”“震撼”，要写出具体的镜头调度、光影、构图、材质、运动轨迹。
- 多使用可执行的视觉动词：推进、跟随、掠过、压近、横移、摇向、拉开、切到、聚焦、虚化、遮挡、揭示。
- 节奏要有起伏：建立空间、承接动作、强化情绪、信息揭示、收束到下一镜头状态。
- 短剧节奏要紧：每个镜头都承担剧情信息或情绪推进，避免无意义空镜和重复描述。

## 字数与信息密度要求
- final prompt 必须足够详细，不能只写概括。
- 1-2个分镜：建议 600-900 字。
- 3-4个分镜：建议 900-1400 字。
- 5个及以上分镜：建议 1200-1800 字。
- 总长度控制在 2000 字以内，但不得低于 600 字；如果你的初稿低于 600 字，必须自行扩写镜头调度、切点、角色反应、光影材质和环境细节。
- 如果为了保留所有分镜和台词导致接近 2000 字，优先保留剧情动作、台词、切镜和角色一致性，减少形容词堆砌。

## 输出内容必须包含的结构
prompt 字段中必须按以下顺序写成一段完整中文提示词，可以使用短标题，但不要输出解释性废话：
1. 片段总目标：总时长、整体情绪、视觉风格、无字幕/无水印/无背景音要求。
2. 角色与场景一致性锁定：人物外貌服装、场景光影、参考图细节。
3. 时间轴与分镜调度：逐分镜写明时间段、景别、动作、表演、台词和切镜方式。
4. 转场与节奏：逐个相邻分镜写明切点和转场方法，不允许只写“自然衔接”。
5. 结尾状态：最后一帧人物状态、画面构图和为后续片段留下的动作/情绪钩子。
6. 台词约束：有台词则逐字列出；无台词则明确无台词。

## 质量自检
输出 JSON 前必须自检，但不要把自检过程单独输出：
- 是否覆盖了每一个输入分镜？
- 是否每个分镜都有时间段？
- 是否每两个相邻分镜都有具体切点或转场？
- 是否逐字保留台词且没有新增台词？
- 是否保持角色外貌、服装、场景、光线连续？
- 是否在目标时长内完成所有动作？
- 是否达到最低 600 字且足够具体？

## 输出格式
请严格按以下 JSON 格式输出，不要输出 JSON 以外的任何内容：
{"prompt":"完整的多分镜视频生成提示词","duration":秒数(整数,4到15),"durationReason":"用一句话说明为什么选择这个总时长，以及如何在该时长内压缩但保留全部分镜"}

## duration 判定规则（整数，范围4~15秒）
- 以输入的 targetDuration / maxDuration 为上限，不得超过模型最大支持时长。
- 片段只有1个简单分镜且无台词：4-6秒。
- 片段含2个分镜或轻微动作变化：6-8秒。
- 片段含3-4个分镜、有动作或中等台词量：8-12秒。
- 片段含5个及以上分镜、复杂动作、强情绪或较多台词：12-15秒，但仍不得超过 maxDuration。
- 如果模型上限小于叙事理想时长，duration 取模型上限，并在 prompt 中通过更紧凑切镜、动作点硬切、缩短环境停顿来保留全部分镜。`;

const SEGMENT_RAW_SHOT_ENHANCE_RULES = `对标记为“未生成单镜头提示词”的分镜，片段合成时必须参考 ENHANCE_PROMPT 的单镜头增强规则即时扩写，但不要额外要求先生成单镜头提示词：
- 明确运动轨迹、速度变化、动作起止状态和力量方向。
- 补足前景、中景、背景层次，说明机位、景别、镜头运动、焦段感和画面重心。
- 补足材质、光线、色调、天气、环境质感和角色微表情。
- 若提供前后分镜信息，衔接优先级高于画面细节：当前分镜起始承接上一镜头结束动作与情绪，结尾为下一镜头开场铺垫，避免跳切、轴线混乱和情绪断层。
- 台词必须逐字保留；无台词分镜必须明确无台词，不得新增对白、旁白、画外音或心声。`;

const ETHNICITY_RULE = `### Ethnicity, Era & Cultural Consistency (HIGHEST PRIORITY)
You MUST first determine TWO things from the script:
1. The cultural/geographical setting (e.g., Western/European, East Asian, Middle Eastern, etc.)
2. The historical era / time period (e.g., medieval, modern, futuristic, ancient, 1920s, etc.)

**Ethnicity rules:**
- ALL characters MUST default to the ethnicity, skin tone, and facial features typical of that setting UNLESS the script explicitly states otherwise.
- For a Western/European story: characters should have Caucasian features by default.
- For an East Asian story: characters should have East Asian features by default.
- Apply the same logic for any other cultural setting.
- Ethnicity must be explicitly stated in every description.

**Era & costume rules (EQUALLY IMPORTANT):**
- ALL clothing, armor, accessories, hairstyles, and props MUST be historically/setting-appropriate for the identified era.
- For a medieval/fantasy setting: use period-appropriate garments (robes, tunics, armor, cloaks, leather gear, etc.). NEVER use modern clothing (suits, t-shirts, jeans, sneakers, etc.).
- For a futuristic setting: use sci-fi appropriate attire. NEVER use anachronistic historical clothing.
- When the script is set in a specific era, EVERY costume variant must respect that era. No exceptions.
- Explicitly state the era-appropriate clothing style in every description.
This rule overrides any other inference.`;

// ===== MAIN INTERFACE =====

export interface InvokeOptions {
  onProgress?: (partialData: any) => void;
  onStreamText?: (text: string) => void;
  abortSignal?: AbortSignal;
}

export async function invokeFunction<T = any>(
  functionName: string,
  body: Record<string, unknown>,
  options?: InvokeOptions,
): Promise<{ data: T; error: null } | { data: null; error: Error }> {
  try {
    const data = await routeFunction(functionName, body, options);
    return { data: data as T, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** Retry a single failed chunk during decomposition */
export async function retryDecomposeChunk(
  chunkIndex: number,
  episodes: string[],
  costumeContext: string,
  model: string,
  prompt: string,
  options?: {
    chunkSegments?: number;
    isRealEpisodes?: boolean;
    videoPace?: string;
    episodeDuration?: number;
  },
): Promise<any[]> {
  const ep = episodes[chunkIndex];
  if (!ep) throw new Error(`无效的分块索引: ${chunkIndex}`);

  // Use chunk-specific prompt if segment count is provided
  const actualPrompt = options?.chunkSegments
    ? buildDecomposePrompt(options.videoPace, options.chunkSegments, options.episodeDuration)
    : prompt;

  const epPrefix =
    options?.isRealEpisodes && episodes.length > 1 ? `${chunkIndex + 1}-` : "";
  const chunkLabel = options?.isRealEpisodes
    ? `以下是第${chunkIndex + 1}集剧本`
    : `以下是剧本的第${chunkIndex + 1}部分（共${episodes.length}部分，属于同一集，本部分需要恰好${options?.chunkSegments || "?"}个片段）`;
  const userText = `${actualPrompt}\n\n---\n\n${chunkLabel}：\n\n${ep}${costumeContext}`;
  const chunkSignal = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
  const data = await callGemini(
    model,
    [{ role: "user", parts: [{ text: userText }] }],
    { temperature: 0.3, maxOutputTokens: 16384 },
    chunkSignal,
  );
  const resultText = extractText(data);
  if (!resultText)
    throw new Error(
      `第${chunkIndex + 1}${options?.isRealEpisodes ? "集" : "段"}重试失败：AI 未返回内容`,
    );
  const epScenes = parseDecomposeResult(resultText);
  for (const scene of epScenes) {
    if (epPrefix) {
      scene.segmentLabel = normalizeEpisodeSegmentLabel(scene.segmentLabel, chunkIndex + 1);
    }
  }
  return finalizeDecomposeScenes(epScenes, {
    segmentsTarget: options?.chunkSegments || 1,
    videoPace: options?.videoPace,
  });
}

export function normalizeEpisodeSegmentLabel(value: unknown, episodeNumber: number): string {
  const label = String(value || "").trim();
  const safeEpisodeNumber = Math.max(1, Math.round(episodeNumber || 1));
  if (!label) return `${safeEpisodeNumber}-1`;

  const episodeSegmentMatch = label.match(/^(\d+)-(\d+)$/);
  if (episodeSegmentMatch) {
    return `${safeEpisodeNumber}-${episodeSegmentMatch[2]}`;
  }

  const duplicatedEpisodeMatch = label.match(/^(\d+)-(\d+)-(\d+)$/);
  if (duplicatedEpisodeMatch) {
    return `${safeEpisodeNumber}-${duplicatedEpisodeMatch[3]}`;
  }

  if (/^\d+$/.test(label)) {
    return `${safeEpisodeNumber}-${label}`;
  }

  const trailingNumberMatch = label.match(/(\d+)\s*$/);
  if (trailingNumberMatch) {
    return `${safeEpisodeNumber}-${trailingNumberMatch[1]}`;
  }

  return `${safeEpisodeNumber}-${label}`;
}

function getSegmentEpisodeNumber(value: unknown): number | null {
  const match = String(value || "").trim().match(/^(\d+)-/);
  if (!match) return null;
  const episodeNumber = Number(match[1]);
  return Number.isFinite(episodeNumber) && episodeNumber > 0 ? episodeNumber : null;
}

export function buildIncompleteDecomposeError(failedChunks: number[], totalChunks: number): Error {
  const failedLabels = failedChunks
    .map((index) => `第 ${index + 1} 集`)
    .join("、");
  const succeededCount = Math.max(0, totalChunks - failedChunks.length);
  return new Error(
    `剧本拆解未完成：${failedLabels} 拆解失败，仅完成 ${succeededCount}/${totalChunks} 集。请重试剧本拆解，避免保存不完整分镜。`,
  );
}

export function buildFetchBodyWithKeys(body: Record<string, unknown>) {
  // No longer needed for Edge Functions, but kept for backward compatibility
  return { ...body };
}

// ===== ROUTER =====

async function routeFunction(
  functionName: string,
  body: any,
  options?: InvokeOptions,
): Promise<any> {
  switch (functionName) {
    case "extract-video-upload-script":
      return localExtractVideoUploadScript(body, options?.abortSignal);
    case "extract-characters-scenes":
      return localExtract(body, options?.onStreamText);
    case "script-decompose":
      return localDecompose(
        body,
        options?.onProgress,
        options?.abortSignal,
        options?.onStreamText,
      );
    case "generate-character":
      return localGenerateCharacterV2(body, options?.abortSignal);
    case "generate-scene":
      return localGenerateSceneV2(body, options?.abortSignal);
    case "generate-storyboard":
      return localGenerateStoryboardV2(body, options?.abortSignal);
    case "generate-video":
      return localGenerateVideo(body, options?.abortSignal);
    case "enhance-video-prompt":
      return localEnhancePromptV2(body);
    case "generate-character-description":
      return localCharDesc(body, options?.onStreamText);
    case "generate-scene-description":
      return localSceneDesc(body, options?.onStreamText);
    default:
      throw new Error(`未知函数: ${functionName}`);
  }
}

// ===== IMPLEMENTATIONS =====

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal.aborted ? signal : timeoutSignal;
}

async function localExtractVideoUploadScript(body: unknown, abortSignal?: AbortSignal) {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const sourceText = String(record.script || "").trim();
  if (!sourceText) throw new Error("Missing uploaded document text");

  const fileNames = Array.isArray(record.fileNames)
    ? record.fileNames.map((name: unknown) => String(name || "").trim()).filter(Boolean)
    : [];
  const title = String(record.title || "").trim();
  const model = typeof record.model === "string" && record.model.trim()
    ? record.model.trim()
    : readStoredDecomposeModel() || DEFAULT_DECOMPOSE_MODEL;

  const prompt = [
    "你正在为视频生产工作流，从上传文档中识别真正需要拆解的剧本正文。",
    "只能返回合法 JSON，结构如下：",
    '{"script":"...","title":"...","summary":"..."}',
    "",
    "规则：",
    "- script 字段必须是后续要拆成视频镜头的剧本正文。",
    "- 尽量保留上传剧本里的原文、台词、集标题、分场标题和顺序。",
    "- 封面、目录、创作方案说明、项目设定、元数据、导出说明、剧情大纲、卖点总结都不是剧本正文，不能放入 script。",
    "- 分集简介、目录条目、未来集计划、关键场景预告不是剧本正文。不要因为它们写了“第2集”“第28集”“EP02”之类标签就当成正文。",
    "- 如果输入本身已经是剧本正文，必须原样返回，不要概括、改写或截取关键片段。",
    "- 不要编造上传文档里不存在的剧情、台词、角色、集数或场景。",
    "- summary 字段用一句简短中文说明识别到了什么正文内容。",
    "",
    fileNames.length ? `文件名：${fileNames.join(", ")}` : "",
    title ? `当前标题：${title}` : "",
    "",
    "上传文档提取文本：",
    sourceText,
  ]
    .filter((part) => part !== "")
    .join("\n");

  const data = await callGemini(
    model,
    [{ role: "user", parts: [{ text: prompt }] }],
    {
      temperature: 0.1,
      maxOutputTokens: 16384,
      responseMimeType: "application/json",
    },
    withTimeoutSignal(abortSignal, SCRIPT_EXTRACT_TIMEOUT_MS),
  );
  const rawText = extractText(data);
  if (!rawText) throw new Error("AI returned no script extraction result");

  const parsed = parseJsonResponseLoose<{
    script?: string;
    title?: string;
    summary?: string;
  }>(rawText);
  const script = parsed?.script?.trim();
  if (!script) throw new Error("AI did not identify usable screenplay body");

  return {
    script,
    title: parsed?.title?.trim() || title || undefined,
    summary: parsed?.summary?.trim() || undefined,
  };
}

async function localExtract(body: any, onStreamText?: (text: string) => void) {
  const { script, model: requestedModel } = body;
  if (!script) throw new Error("缺少剧本内容");

  const model = requestedModel || readStoredDecomposeModel() || DEFAULT_DECOMPOSE_MODEL;

  // Pre-scan: extract CONFIRMED character names from costume-annotated brackets
  // These are highly reliable — only brackets with · separator like [Name·Age·Costume]
  const confirmedNames = new Set<string>();
  // Hint names from dialogue prefixes — used for AI prompt only, NOT for post-verification
  const hintNames = new Set<string>();

  const costumePattern = /\[([^\]·]+)[·・]([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = costumePattern.exec(script)) !== null) {
    const baseName = m[1].trim();
    if (baseName && baseName.length <= 30) confirmedNames.add(baseName);
  }

  // Dialogue prefixes — hints only, may include scene headings
  const dialoguePattern = /^\s*([^\s:：（([/]{1,20})[：:]\s*[""「\S]/gm;
  while ((m = dialoguePattern.exec(script)) !== null) {
    const name = m[1].trim();
    if (
      name &&
      name.length <= 20 &&
      !/^[\d第片段场景分镜EP]/.test(name) &&
      !isNarrationSpeaker(name)
    ) {
      hintNames.add(name);
    }
  }

  // Remove confirmed names from hints (no duplication)
  for (const n of confirmedNames) hintNames.delete(n);

  // Filter out obvious locations from hints
  const locationSuffixes =
    /(办公室|实验室|会议室|休息室|控制室|大厅|走廊|基地|总部|废墟|遗迹|空间站|飞船|星球|广场|码头|港口|机场|车站|公寓|医院|学校|教堂|监狱|工厂|仓库|酒吧|餐厅|咖啡馆|修车厂|拍卖[会行]|博物馆|图书馆|甲板|沙滩|海滩|丛林|悬崖|深潭|岩壁|巷道?|街道|特写|游艇|海中|海上)[\s\-/]*[\u4e00-\u9fff]*$/;
  const locationPrefixes = /^(第.+集|EP\s*\d|场景|分镜|片段)/i;
  for (const name of hintNames) {
    if (
      locationSuffixes.test(name) ||
      locationPrefixes.test(name) ||
      name.includes("/")
    ) {
      hintNames.delete(name);
    }
  }

  // Combine all names for the AI prompt hint (but only confirmedNames trigger post-verification)
  const allHintNames = new Set([...confirmedNames, ...hintNames]);

  // Build pre-scan hints
  let preScanHint = "";
  if (allHintNames.size > 0) {
    preScanHint = `\n\n---\n\n【系统预扫描提示】以下名称在剧本中被检测到可能是角色名，请核实后将真正的角色包含在输出中（注意区分角色与场景/物品）：\n${[...allHintNames].join("、")}\n`;
  }

  const promptText = `${EXTRACTION_PROMPT}\n\n---\n\n以下是用户的剧本：\n\n${script}${preScanHint}`;

  const extractSignal = AbortSignal.timeout(SCRIPT_EXTRACT_TIMEOUT_MS);

  let textContent: string;
  if (onStreamText) {
    const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
    // Use streaming for real-time feedback
    const finalText = await callGeminiStream(
      model,
      [{ role: "user", parts: [{ text: promptText }] }],
      forwardStreamDelta,
      { temperature: 0.1, maxOutputTokens: 8192 },
      extractSignal,
    );
    textContent = finalText;
  } else {
    const data = await callGemini(
      model,
      [{ role: "user", parts: [{ text: promptText }] }],
      {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
      extractSignal,
    );
    textContent = extractText(data);
  }

  if (!textContent) throw new Error("AI 返回格式异常");

  let cleanedText = textContent;
  if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    const match = cleanedText.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error("无法解析 AI 返回的 JSON");
  }

  // === Post-filter: remove scene/location entries misclassified as characters ===
  const sceneNames = new Set(
    (parsed.sceneSettings || []).map((s: any) => s.name?.trim().toLowerCase()),
  );
  if (parsed.characters) {
    const before = parsed.characters.length;
    parsed.characters = parsed.characters.filter((c: any) => {
      const name = c.name?.trim() || "";
      if (sceneNames.has(name.toLowerCase())) {
        return false;
      }
      const isLikelyLocation =
        locationSuffixes.test(name) ||
        locationPrefixes.test(name) ||
        name.includes("/");
      if (isLikelyLocation) {
        if (!parsed.sceneSettings) parsed.sceneSettings = [];
        parsed.sceneSettings.push({ name, description: c.description || "" });
        return false;
      }
      return true;
    });
  }

  // === Post-verification: only for CONFIRMED names (from · brackets), not dialogue hints ===
  const extractedNames = new Set(
    (parsed.characters || []).map((c: any) => c.name?.trim()),
  );
  const missingConfirmed = [...confirmedNames].filter(
    (n) => !extractedNames.has(n),
  );

  if (missingConfirmed.length > 0) {
    for (const name of missingConfirmed) {
      parsed.characters.push({
        name,
        description: `（AI 未提取到该角色的详细描述，请根据剧本手动补充）`,
      });
    }
  }

  return {
    characters: parsed.characters || [],
    sceneSettings: parsed.sceneSettings || [],
  };
}

async function localDecompose(
  body: any,
  onProgress?: (partialData: any) => void,
  abortSignal?: AbortSignal,
  onStreamText?: (text: string) => void,
) {
  const {
    script,
    systemPrompt,
    model: requestedModel,
    costumeInfo,
    videoPace,
    segmentsPerEpisode,
    episodeDuration,
    existingScenes,
    retryMissingEpisodes,
  } = body;
  if (!script) throw new Error("缺少剧本内容");

  const model = requestedModel || readStoredDecomposeModel() || DEFAULT_DECOMPOSE_MODEL;

  // Build costume context if available
  let costumeContext = "";
  if (costumeInfo && Array.isArray(costumeInfo) && costumeInfo.length > 0) {
    costumeContext =
      "\n\n---\n\n以下是阶段一识别到的角色服装变体信息（仅列出有多套服装的角色）：\n\n";
    for (const char of costumeInfo) {
      costumeContext += `【${char.name}】的服装变体：\n`;
      for (const cos of char.costumes) {
        costumeContext += `  - "${cos.label}"：${cos.description}\n`;
      }
      costumeContext += "\n";
    }
    costumeContext +=
      "请在每个分镜的 characterCostumes 字段中，为上述角色指定当前穿着的服装label。务必根据剧本上下文精确判断。\n";
  }

  // Split by episodes if script is large to reduce per-request payload
  const splitResult = splitScriptByEpisodes(script);
  const episodes = splitResult.chunks;

  if (episodes.length > 1) {
    const { maxRetries: maxChunkRetries, delayMs: chunkRetryDelayMs } =
      getNetworkRetrySettings();
    const allScenes: any[] = [];
    const failedChunks: number[] = [];
    const globalSceneNumber = 1;

    // For length-based splits, distribute segments proportionally across chunks
    // For real episodes, each episode gets the full segmentsPerEpisode count
    const totalSegments = segmentsPerEpisode || 5;
    let chunkSegmentCounts: number[];
    if (splitResult.isRealEpisodes) {
      // Each real episode gets the full segment count
      chunkSegmentCounts = episodes.map(() => totalSegments);
    } else {
      // Distribute segments proportionally by chunk text length
      const totalChars = episodes.reduce((sum, ep) => sum + ep.length, 0);
      const rawCounts = episodes.map(
        (ep) => (ep.length / totalChars) * totalSegments,
      );
      // Round while preserving total
      chunkSegmentCounts = rawCounts.map((c) => Math.max(1, Math.round(c)));
      // Adjust to match exact total
      let diff = totalSegments - chunkSegmentCounts.reduce((a, b) => a + b, 0);
      while (diff !== 0) {
        if (diff > 0) {
          // Add to the chunk with the largest fractional part that was rounded down
          let bestIdx = 0;
          let bestFrac = -1;
          for (let i = 0; i < rawCounts.length; i++) {
            const frac = rawCounts[i] - Math.floor(rawCounts[i]);
            if (frac > bestFrac && chunkSegmentCounts[i] < rawCounts[i] + 1) {
              bestFrac = frac;
              bestIdx = i;
            }
          }
          chunkSegmentCounts[bestIdx]++;
          diff--;
        } else {
          // Remove from the chunk with the smallest fractional part that was rounded up
          let bestIdx = 0;
          let bestFrac = 2;
          for (let i = 0; i < rawCounts.length; i++) {
            const frac = rawCounts[i] - Math.floor(rawCounts[i]);
            if (frac < bestFrac && chunkSegmentCounts[i] > 1) {
              bestFrac = frac;
              bestIdx = i;
            }
          }
          chunkSegmentCounts[bestIdx]--;
          diff++;
        }
      }
    }

    // Results array indexed by episode. When retrying, keep complete existing
    // episode results and only send missing/underfilled episodes back to the model.
    const episodeResults: (any[] | null)[] = new Array(episodes.length).fill(
      null,
    );
    if (retryMissingEpisodes && splitResult.isRealEpisodes && Array.isArray(existingScenes)) {
      const existingByEpisode = new Map<number, any[]>();
      for (const scene of existingScenes) {
        const episodeNumber = getSegmentEpisodeNumber(scene?.segmentLabel);
        if (!episodeNumber || episodeNumber < 1 || episodeNumber > episodes.length) continue;
        const group = existingByEpisode.get(episodeNumber) || [];
        group.push(scene);
        existingByEpisode.set(episodeNumber, group);
      }

      for (let index = 0; index < episodes.length; index++) {
        const episodeNumber = index + 1;
        const scenesForEpisode = existingByEpisode.get(episodeNumber) || [];
        if (!scenesForEpisode.length) continue;

        const segmentCount = new Set(
          scenesForEpisode.map((scene) => String(scene?.segmentLabel || "").trim()).filter(Boolean),
        ).size;
        if (segmentCount < chunkSegmentCounts[index]) continue;

        episodeResults[index] = scenesForEpisode.map((scene) => ({ ...scene }));
      }
    }

    const targetEpisodeIndexes = episodes
      .map((_, index) => index)
      .filter((index) => !episodeResults[index]);

    if (targetEpisodeIndexes.length < episodes.length) {
      let num = 1;
      const mergedScenes: any[] = [];
      for (let i = 0; i < episodeResults.length; i++) {
        if (episodeResults[i]) {
          for (const s of episodeResults[i]!) {
            s.sceneNumber = num++;
            mergedScenes.push(s);
          }
        }
      }
      allScenes.push(...mergedScenes);
    }

    // Notify frontend of chunk count immediately (include meta for early retry support)
    if (onProgress) {
      onProgress({
        scenes: allScenes,
        chunkIndex: -1,
        totalChunks: episodes.length,
        status: "init",
        failedChunks,
        chunkSegmentCounts,
        isRealEpisodes: true,
        originallyEpisodes: splitResult.originallyEpisodes,
        // Early meta so frontend can support retry before full completion
        episodes,
        costumeContext,
        model,
        prompt: buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
        videoPace,
      });
    }

    if (targetEpisodeIndexes.length === 0) {
      let finalNum = 1;
      const finalScenes: any[] = [];
      for (const scenesForEpisode of episodeResults) {
        if (!scenesForEpisode) continue;
        for (const scene of scenesForEpisode) {
          scene.sceneNumber = finalNum++;
          finalScenes.push(scene);
        }
      }
      return {
        scenes: finalScenes,
        failedChunks,
        episodes,
        costumeContext,
        model,
        prompt: buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
        chunkSegmentCounts,
        isRealEpisodes: splitResult.isRealEpisodes,
        originallyEpisodes: splitResult.originallyEpisodes,
        videoPace,
      };
    }

    // Parallel decomposition with max 3 concurrent episodes
    const MAX_PARALLEL = 3;
    const sem = { current: 0, queue: [] as (() => void)[] };
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (sem.current < MAX_PARALLEL) {
          sem.current++;
          resolve();
        } else
          sem.queue.push(() => {
            sem.current++;
            resolve();
          });
      });
    const release = () => {
      sem.current--;
      if (sem.queue.length > 0) sem.queue.shift()!();
    };

    const processEpisode = async (epIdx: number) => {
      if (abortSignal?.aborted) {
        if (onProgress)
          onProgress({
            scenes: allScenes,
            chunkIndex: epIdx,
            totalChunks: episodes.length,
            status: "cancelled",
            failedChunks,
          });
        return;
      }

      await acquire();
      if (abortSignal?.aborted) {
        release();
        if (onProgress)
          onProgress({
            scenes: allScenes,
            chunkIndex: epIdx,
            totalChunks: episodes.length,
            status: "cancelled",
            failedChunks,
          });
        return;
      }

      const ep = episodes[epIdx];
      const chunkSegments = chunkSegmentCounts[epIdx];
      const epPrefix = episodes.length > 1 ? `${epIdx + 1}-` : "";

      const chunkPrompt = buildDecomposePrompt(videoPace, chunkSegments, episodeDuration);

      if (onProgress) {
        onProgress({
          scenes: allScenes,
          chunkIndex: epIdx,
          totalChunks: episodes.length,
          status: "processing",
          failedChunks,
        });
      }

      let chunkAttempt = 0;
      let lastChunkError: any = null;

      while (chunkAttempt <= maxChunkRetries) {
        if (chunkAttempt > 0) {
          await new Promise((r) => setTimeout(r, chunkRetryDelayMs));
          if (abortSignal?.aborted) break;
          if (onProgress) {
            onProgress({
              scenes: allScenes,
              chunkIndex: epIdx,
              totalChunks: episodes.length,
              status: "processing",
              failedChunks,
              retryAttempt: chunkAttempt,
            });
          }
        }

        try {
          // ── Build cross-episode context from ANY already-completed episodes (bidirectional) ──
          let crossEpContext = "";
          const completedOther: { idx: number; scenes: any[] }[] = [];
          for (let i = 0; i < episodes.length; i++) {
            if (i !== epIdx && episodeResults[i])
              completedOther.push({ idx: i, scenes: episodeResults[i]! });
          }
          if (completedOther.length > 0) {
            const allOtherScenes = completedOther.flatMap((e) => e.scenes);
            const otherCharacters = [
              ...new Set(
                allOtherScenes.flatMap((s: any) => s.characters || []),
              ),
            ];
            const otherSceneNames = [
              ...new Set(
                allOtherScenes.map((s: any) => s.sceneName).filter(Boolean),
              ),
            ];

            // Get nearby scenes for narrative continuity
            const prevEp = completedOther
              .filter((e) => e.idx < epIdx)
              .sort((a, b) => b.idx - a.idx)[0];
            const nextEp = completedOther
              .filter((e) => e.idx > epIdx)
              .sort((a, b) => a.idx - b.idx)[0];
            let contextScenesDesc = "";
            if (prevEp) {
              const lastScenes = prevEp.scenes.slice(-3);
              contextScenesDesc +=
                `前一集（第${prevEp.idx + 1}集）最后几个分镜：\n` +
                lastScenes
                  .map(
                    (s: any) =>
                      `[分镜${s.sceneNumber}] 片段${s.segmentLabel} | 场景：${s.sceneName} | 角色：${(s.characters || []).join("、")} | ${s.description}`,
                  )
                  .join("\n") +
                "\n";
            }
            if (nextEp) {
              const firstScenes = nextEp.scenes.slice(0, 3);
              contextScenesDesc +=
                `后一集（第${nextEp.idx + 1}集）开头几个分镜：\n` +
                firstScenes
                  .map(
                    (s: any) =>
                      `[分镜${s.sceneNumber}] 片段${s.segmentLabel} | 场景：${s.sceneName} | 角色：${(s.characters || []).join("、")} | ${s.description}`,
                  )
                  .join("\n") +
                "\n";
            }

            crossEpContext = `\n\n---\n\n【跨集上下文（必须保持一致性）】
已完成的其他集数中出现的角色：${otherCharacters.join("、") || "无"}
已完成的其他集数中出现的场景：${otherSceneNames.join("、") || "无"}

${contextScenesDesc}
重要：
- 角色名必须与其他集数保持完全一致，不要改变拼写或格式
- 场景名如果是同一地点，必须使用相同名称
- segmentLabel 编号请使用"${epIdx + 1}-N"格式`;
          }

          const chunkLabel = splitResult.isRealEpisodes
            ? `以下是第${epIdx + 1}集剧本（共${episodes.length}集）`
            : `以下是剧本的第${epIdx + 1}集（共${episodes.length}集，本集需要恰好${chunkSegments}个片段）。segmentLabel请使用"${epIdx + 1}-N"格式（如"${epIdx + 1}-1","${epIdx + 1}-2"等）`;
          const userText = `${chunkPrompt}\n\n---\n\n${chunkLabel}：\n\n${ep}${costumeContext}${crossEpContext}`;

          const correctionHint =
            chunkAttempt > 0 && lastChunkError
              ? `\n\n銆愪笂涓€娆¤緭鍑哄瓨鍦ㄧ殑闂锛屽繀椤诲叏閮ㄤ慨姝ｃ€慭n${String(lastChunkError?.message || lastChunkError)}\n璇风洿鎺ヨ繑鍥炰慨姝ｅ悗鐨勫畬鏁?JSON锛屼笉瑕佽В閲娿€俙`
              : "";
          const retryUserText = `${userText}${correctionHint}`;

          const chunkTimeout = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
          const combinedSignal = abortSignal
            ? AbortSignal.any([abortSignal, chunkTimeout])
            : chunkTimeout;

          let resultText: string;
          if (onStreamText) {
            const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
            resultText = await callGeminiStream(
              model,
              [{ role: "user", parts: [{ text: retryUserText }] }],
              forwardStreamDelta,
              { temperature: 0.3, maxOutputTokens: 16384 },
              combinedSignal,
            );
          } else {
            const data = await callGemini(
              model,
              [{ role: "user", parts: [{ text: retryUserText }] }],
              { temperature: 0.3, maxOutputTokens: 16384 },
              combinedSignal,
            );
            resultText = extractText(data);
          }
          if (!resultText)
            throw new Error(
              `第${epIdx + 1}${splitResult.isRealEpisodes ? "集" : "段"}拆解失败：AI 未返回内容`,
            );

          const epScenes = parseDecomposeResult(resultText);
          for (const scene of epScenes) {
            if (epPrefix) {
              scene.segmentLabel = normalizeEpisodeSegmentLabel(scene.segmentLabel, epIdx + 1);
            }
          }

          episodeResults[epIdx] = finalizeDecomposeScenes(epScenes, {
            segmentsTarget: chunkSegments,
            videoPace,
          });

          // Merge all completed results in order for progress update
          const mergedScenes: any[] = [];
          let num = 1;
          for (let i = 0; i < episodeResults.length; i++) {
            if (episodeResults[i]) {
              for (const s of episodeResults[i]!) {
                s.sceneNumber = num++;
                mergedScenes.push(s);
              }
            }
          }
          allScenes.length = 0;
          allScenes.push(...mergedScenes);

          if (onProgress) {
            onProgress({
              scenes: [...allScenes],
              chunkIndex: epIdx,
              totalChunks: episodes.length,
              status: "done",
              failedChunks,
            });
          }
          lastChunkError = null;
          break; // success, exit retry loop
        } catch (err: any) {
          lastChunkError = err;
          chunkAttempt++;
          if (chunkAttempt > maxChunkRetries) {
            failedChunks.push(epIdx);
            if (onProgress) {
              onProgress({
                scenes: [...allScenes],
                chunkIndex: epIdx,
                totalChunks: episodes.length,
                status: "failed",
                failedChunks,
                error: err?.message,
              });
            }
          }
        }
      } // end retry loop
      release();
    };

    // Launch all episodes concurrently (semaphore limits to MAX_PARALLEL)
    await Promise.all(targetEpisodeIndexes.map((epIdx) => processEpisode(epIdx)));

    // Final renumber after all complete
    let finalNum = 1;
    const finalScenes: any[] = [];
    for (let i = 0; i < episodeResults.length; i++) {
      if (episodeResults[i]) {
        for (const s of episodeResults[i]!) {
          s.sceneNumber = finalNum++;
          finalScenes.push(s);
        }
      }
    }
    allScenes.length = 0;
    allScenes.push(...finalScenes);

    if (failedChunks.length > 0) {
      throw buildIncompleteDecomposeError(failedChunks, episodes.length);
    }

    return {
      scenes: allScenes,
      failedChunks,
      episodes,
      costumeContext,
      model,
      prompt: buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
      chunkSegmentCounts,
      isRealEpisodes: splitResult.isRealEpisodes,
      originallyEpisodes: splitResult.originallyEpisodes,
      videoPace,
    };
  }

  // Single episode or couldn't split - send as one request
  const prompt = buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration);
  const userText = `${prompt}\n\n---\n\n以下是用户的剧本：\n\n${script}${costumeContext}`;
  const { maxRetries: maxSingleRetries, delayMs: singleRetryDelayMs } =
    getNetworkRetrySettings();
  let singleAttempt = 0;
  let lastSingleError: unknown = null;

  while (singleAttempt <= maxSingleRetries) {
    if (singleAttempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, singleRetryDelayMs));
      if (abortSignal?.aborted) {
        throw lastSingleError instanceof Error ? lastSingleError : new Error("请求已取消");
      }
    }

    const decomposeSignal = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, decomposeSignal])
      : decomposeSignal;

    try {
      const correctionHint =
        singleAttempt > 0 && lastSingleError
          ? `\n\n【上一次输出存在的问题，必须全部修正】\n${String((lastSingleError as Error)?.message || lastSingleError)}\n请直接返回修正后的完整 JSON，不要解释。`
          : "";
      const retryUserText = `${userText}${correctionHint}`;
      let resultText: string;
      if (onStreamText) {
        const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
        resultText = await callGeminiStream(
          model,
          [{ role: "user", parts: [{ text: retryUserText }] }],
          forwardStreamDelta,
          { temperature: 0.3, maxOutputTokens: 16384 },
          combinedSignal,
        );
      } else {
        const data = await callGemini(
          model,
          [{ role: "user", parts: [{ text: retryUserText }] }],
          { temperature: 0.3, maxOutputTokens: 16384 },
          combinedSignal,
        );
        resultText = extractText(data);
      }

      if (!resultText) throw new Error("AI 未返回内容");

      const scenes = finalizeDecomposeScenes(parseDecomposeResult(resultText), {
        segmentsTarget: segmentsPerEpisode || 5,
        videoPace,
      });
      return { scenes };
    } catch (error) {
      lastSingleError = error;
      if (abortSignal?.aborted) {
        throw error;
      }
      singleAttempt++;
      if (singleAttempt > maxSingleRetries) {
        break;
      }
    }
  }

  throw lastSingleError instanceof Error ? lastSingleError : new Error("拆解失败");
}

/** Detect if text is primarily logographic (Chinese/Japanese/Korean) */
function isLogographicText(text: string): boolean {
  const sample = text.slice(0, 2000);
  const cjkChars = (
    sample.match(
      /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
    ) || []
  ).length;
  return cjkChars / sample.length > 0.15;
}

function getChunkLimits(text: string): { max: number; min: number } {
  if (isLogographicText(text)) {
    return { max: 12000, min: 6000 };
  }
  return { max: 30000, min: 15000 };
}

interface SplitResult {
  chunks: string[];
  isRealEpisodes: boolean;
  /** True if original split was by episode markers, even if sub-split occurred */
  originallyEpisodes: boolean;
}

/** Convert Chinese numeral string to number */
function chineseToNumber(s: string): number {
  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    百: 100,
    千: 1000,
    壹: 1,
    贰: 2,
    叁: 3,
    肆: 4,
    伍: 5,
    陆: 6,
    柒: 7,
    捌: 8,
    玖: 9,
    拾: 10,
    佰: 100,
    仟: 1000,
  };
  let result = 0,
    current = 0;
  for (const ch of s) {
    const val = digitMap[ch];
    if (val === undefined) continue;
    if (val >= 10) {
      result += (current || 1) * val;
      current = 0;
    } else {
      current = current * 10 + val;
    }
  }
  return result + current;
}

/** Split a multi-episode script into chunks */
function splitScriptByEpisodes(script: string): SplitResult {
  const { max: MAX_CHUNK_CHARS, min: MIN_CHUNK_CHARS } = getChunkLimits(script);

  // First try to split by episode markers (supports Arabic digits and Chinese numerals)
  const epPattern =
    /(?:^|\n)[\s\r]*(?:EP\s*(\d+)|第\s*([零一二三四五六七八九十百千万\d]+)\s*[集话期章]|Episode\s+(\d+))/gim;
  const markers: { index: number; num: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = epPattern.exec(script)) !== null) {
    const numStr = m[1] || m[2] || m[3] || "0";
    const num = /^\d+$/.test(numStr)
      ? parseInt(numStr)
      : chineseToNumber(numStr);
    markers.push({ index: m.index, num });
  }

  let rawChunks: string[] = [];
  let isRealEpisodes = false;
  let detectedEpisodes = false;
  if (markers.length > 1) {
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].index;
      const end = i < markers.length - 1 ? markers[i + 1].index : script.length;
      const ep = script.slice(start, end).trim();
      if (ep.length > 20) rawChunks.push(ep);
    }
    if (rawChunks.length > 1) {
      isRealEpisodes = true;
      detectedEpisodes = true;
    } else {
      if (script.length <= MAX_CHUNK_CHARS)
        return {
          chunks: [script],
          isRealEpisodes: false,
          originallyEpisodes: false,
        };
      rawChunks = [script];
    }
  } else {
    if (script.length <= MAX_CHUNK_CHARS)
      return {
        chunks: [script],
        isRealEpisodes: false,
        originallyEpisodes: false,
      };
    rawChunks = [script];
  }

  const finalChunks: string[] = [];
  let hadSubSplit = false;
  for (const chunk of rawChunks) {
    if (chunk.length <= MAX_CHUNK_CHARS) {
      finalChunks.push(chunk);
      continue;
    }
    hadSubSplit = true;
    let paragraphs = chunk.split(/\n{2,}/);
    if (paragraphs.length < 3) {
      paragraphs = chunk.split(/\n/);
    }
    const sep =
      paragraphs.length === chunk.split(/\n{2,}/).length ? "\n\n" : "\n";
    let current = "";
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      if (!para.trim()) continue;
      const wouldBe = current.length + (current ? sep.length : 0) + para.length;
      if (wouldBe > MAX_CHUNK_CHARS && current.length >= MIN_CHUNK_CHARS) {
        finalChunks.push(current.trim());
        current = para;
      } else {
        current += (current ? sep : "") + para;
      }
    }
    if (current.trim()) {
      if (current.trim().length < MIN_CHUNK_CHARS && finalChunks.length > 0) {
        finalChunks[finalChunks.length - 1] += sep + current.trim();
      } else {
        finalChunks.push(current.trim());
      }
    }
  }

  // If real episodes were sub-split by length, mark as not real episodes
  if (hadSubSplit && isRealEpisodes) isRealEpisodes = false;

  return finalChunks.length > 1
    ? {
        chunks: finalChunks,
        isRealEpisodes,
        originallyEpisodes: detectedEpisodes,
      }
    : { chunks: [script], isRealEpisodes: false, originallyEpisodes: false };
}

/** Parse decompose JSON result from AI text */
function parseDecomposeResult(resultText: string): any[] {
  let cleanedText = resultText.trim();
  if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    // Try to extract JSON object or array from text with trailing content
    const objMatch = cleanedText.match(/\{[\s\S]*\}/);
    const arrMatch = cleanedText.match(/\[[\s\S]*\]/);
    const candidate =
      objMatch && arrMatch
        ? objMatch.index! <= arrMatch.index!
          ? objMatch[0]
          : arrMatch[0]
        : arrMatch?.[0] || objMatch?.[0];
    if (candidate) {
      try {
        parsed = JSON.parse(candidate);
      } catch {
        // Last resort: try truncating at last valid closing bracket
        const lastBrace = candidate.lastIndexOf("}");
        const lastBracket = candidate.lastIndexOf("]");
        const cutAt = Math.max(lastBrace, lastBracket);
        if (cutAt > 0) {
          const truncated = candidate.slice(0, cutAt + 1);
          parsed = JSON.parse(truncated);
        } else {
          throw new Error("无法解析返回的 JSON");
        }
      }
    } else {
      throw new Error("无法解析返回的 JSON");
    }
  }

  return Array.isArray(parsed) ? parsed : parsed?.scenes || [];
}

async function localGenerateCharacter(body: any) {
  console.log("🔵 localGenerateCharacter called with body:", { name: body.name, model: body.model });

  const { name, description, style, model, referenceImageUrl, viewMode } = body;
  if (!name) throw new Error("缺少角色名称");

  const characterDesc = description || name;
  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : CHAR_STYLE_MAP[style] || CHAR_STYLE_MAP["live-action"];
  const isSingleMode = viewMode === "single";
  const isCostumeVariation = !!referenceImageUrl;

  // 首套服装：完整角色描述；后续服装：以修改为主，简洁指令
  let prompt: string;
  if (isCostumeVariation) {
    // 后续服装变体：以参考图为基准，只修改服装，保持人物面部特征一致
    // 提示词极简：换装指令 + 面部一致性
    prompt = `基于图1角色图，生成同一角色的新服装版本。

【面部特征】与图1保持完全一致（脸型、眉形、眼睛、鼻梁、嘴唇等），确保是同一个角色。

【服装】${characterDesc}

Art style: ${styleDesc}.
${isSingleMode ? "9:16 vertical portrait, front view, pure white background." : "16:9 horizontal, 4-view character sheet (front/side/back/face closeup), pure white background."}`;
  } else {
    // 首套服装：完整角色描述
    const whiteBackgroundRule = `The background MUST be a plain, pure white background (#FFFFFF). No gradients, no shadows on the background, no environment elements. Clean white only.`;
    const fullBodyRule = `CRITICAL: The character MUST be FULL BODY visible from head to toe — feet MUST be inside the frame, not cut off. Standing straight, complete figure in view.`;
    prompt = isSingleMode
      ? `Create a professional full-body character design portrait for: "${name}" - ${characterDesc}.

Art style: ${styleDesc}.

${whiteBackgroundRule}
${fullBodyRule}

The image should be a single full-body FRONT VIEW portrait of the character standing in a neutral, upright pose on a plain white background. The character should face the camera directly. Show the character from head to toe with clear details of face, clothing, and accessories. Professional character design sheet quality — NO text labels, clean composition. The entire image MUST be in ${styleDesc} style.

CRITICAL: The character's clothing, armor, and accessories MUST match the era and setting described above. If the description mentions medieval, fantasy, ancient, or any specific historical period, ALL clothing must be era-appropriate. NEVER use modern clothing (suits, t-shirts, jeans, sneakers) for historical/fantasy characters.`
      : `Create a professional character design reference sheet for an animated character: "${name}" - ${characterDesc}.

Art style: ${styleDesc}.

${whiteBackgroundRule}
${fullBodyRule}

The image should be a clean character turnaround sheet with 4 views arranged in a 2x2 grid on a plain white background:
- Top-left: FRONT VIEW (full body from head to toe, facing camera)
- Top-right: SIDE VIEW (full body from head to toe, profile view from the right)
- Bottom-left: BACK VIEW (full body from head to toe, facing away)
- Bottom-right: FACE CLOSE-UP (detailed head/face portrait)

Each view should be labeled clearly. The character design must be consistent across all 4 views. The entire image MUST be in ${styleDesc} style.

CRITICAL: The character's clothing, armor, and accessories MUST match the era and setting described above. If the description mentions medieval, fantasy, ancient, or any specific historical period, ALL clothing must be era-appropriate. NEVER use modern clothing (suits, t-shirts, jeans, sneakers) for historical/fantasy characters.`;
  }

  const selectedModel = model || "gemini-3.1-flash-image-preview";
  const isSeedream = selectedModel.startsWith("doubao-seedream");
  const isAsync = selectedModel.includes("-async");

  const aspectRatio = isSingleMode ? "9:16" : "16:9";
  const seedreamSize = isSingleMode ? "1440x2560" : "2560x1440";
  const asyncSize = isSingleMode ? "9:16" : "16:9";

  let imageBase64: string = "";
  let mimeType: string = "image/jpeg"; // 默认值

  console.log("🔵 Image generation config:", { selectedModel, isSeedream, isAsync, hasReferenceImage: !!referenceImageUrl });

  if (isSeedream) {
    console.log("🟢 Using Seedream model");
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: seedreamSize,
    });
    imageBase64 = result.base64;
    mimeType = result.mimeType;
    console.log("🟢 Seedream result:", { base64Length: imageBase64.length, mimeType });
  } else if (isAsync) {
    console.log("🟡 Using async model");
    // 使用新的异步 API
    try {
      const { task_id, fallbackModel, shouldUseFallback } = await callAsyncImageGeneration(prompt, {
        model: selectedModel,
        size: asyncSize,
        input_reference: referenceImageUrl,
      });

      // 如果异步API不支持（如有参考图像），直接使用回退模型
      if (shouldUseFallback && fallbackModel) {
        console.log("🟣 [START] 异步API不支持此请求，直接使用同步回退模型:", fallbackModel);

        try {
          // 使用同步API
          const parts: any[] = [{ text: prompt }];

          if (referenceImageUrl) {
            console.log("🟣 Processing reference image:", referenceImageUrl);
            const inlineData = await getInlineData(referenceImageUrl);
            console.log("🟣 Got inline data:", summarizeInlineData(inlineData));

            if (inlineData) {
              // 如果图片太大（>512KB），先压缩
              if (inlineData.data.length >= 512 * 1024) {
                console.log("🟣 Compressing large image...");
                const compressed = await compressImage(
                  `data:${inlineData.mimeType};base64,${inlineData.data}`,
                  1.5 * 1024 * 1024,
                  { maxDim: 2048, minQuality: 0.3 }
                );
                const base64Data = compressed.split(",")[1];
                parts.push({
                  inlineData: { mimeType: "image/jpeg", data: base64Data },
                });
                console.log("🟣 Compressed image added to parts");
              } else {
                parts.push({ inlineData });
                console.log("🟣 Original image added to parts");
              }
            }
          }

          console.log("🟣 Calling Gemini with fallback model...");
          const response = await callGemini(
            fallbackModel,
            [{ role: "user", parts }],
            {
              responseModalities: ["IMAGE", "TEXT"],
              imageSize: "2K",
            }
          );

          console.log("🟣 Sync fallback response structure:", summarizeGeminiImageResponse(response));

          const extracted = await extractImageBase64(response);
          console.log("🟣 Extracted result:", summarizeExtractedImage(extracted));

          if (!extracted) {
            console.error("❌ Failed to extract image. Response summary:", summarizeGeminiImageResponse(response));
            throw new Error("回退模型未返回图像");
          }
          imageBase64 = extracted.base64;
          mimeType = extracted.mimeType;
          console.log("🟣 [SUCCESS] Image extracted successfully");
        } catch (error) {
          console.error("❌ [ERROR] Sync fallback failed:", error);
          throw error;
        }
      } else {
        // 正常轮询异步结果
        const result = await pollAsyncImageResult(task_id, {
          maxAttempts: DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS,
          maxDurationMs: DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS,
          fallbackModel,
          prompt,
          size: asyncSize,
          input_reference: referenceImageUrl,
        });
        imageBase64 = result.base64;
        mimeType = result.mimeType;
        if (result.usedFallback) {
          console.log(`角色图像生成使用了回退模型: ${fallbackModel}`);
        }
      }
    } catch (asyncFailure: any) {
      if (isAsyncImageTaskPendingError(asyncFailure) || isAbortLikeError(asyncFailure)) {
        throw asyncFailure;
      }
      const asyncError = asyncFailure;
      // 异步API提交失败，尝试使用同步回退模型
      console.warn("异步API提交失败，使用同步回退模型:", asyncError.message);

      // 确定回退模型
      const fallbackMap: Record<string, string> = {
        "gemini-3-pro-image-preview-async": "gemini-3-pro-image-preview",
        "gemini-3-pro-image-preview-2k-async": "gemini-3-pro-image-preview-2k",
        "gemini-3-pro-image-preview-4k-async": "gemini-3-pro-image-preview-4k",
        "nano-banana-2": "gemini-3-pro-image-preview",
        "nano-banana-2-2k": "gemini-3-pro-image-preview-2k",
        "nano-banana-2-4k": "gemini-3-pro-image-preview-4k",
      };
      const fallbackModel = fallbackMap[selectedModel];

      if (!fallbackModel) {
        throw asyncError; // 如果没有回退模型，抛出原始错误
      }

      // 使用同步API作为回退
      const parts: any[] = [{ text: prompt }];

      if (referenceImageUrl) {
        const inlineData = await getInlineData(referenceImageUrl);
        if (inlineData) {
          // 如果图片太大（>512KB），先压缩
          if (inlineData.data.length >= 512 * 1024) {
            const compressed = await compressImage(
              `data:${inlineData.mimeType};base64,${inlineData.data}`,
              1.5 * 1024 * 1024,
              { maxDim: 2048, minQuality: 0.3 }
            );
            const base64Data = compressed.split(",")[1];
            parts.push({
              inlineData: { mimeType: "image/jpeg", data: base64Data },
            });
          } else {
            parts.push({ inlineData });
          }
        }
      }

      const response = await callGemini(
        fallbackModel,
        [{ role: "user", parts }],
        {
          responseModalities: ["IMAGE", "TEXT"],
          imageSize: "2K",
        }
      );

      const extracted = await extractImageBase64(response);
      if (!extracted) {
        throw new Error("回退模型未返回图像");
      }
      imageBase64 = extracted.base64;
      mimeType = extracted.mimeType;
      console.log(`🟡 角色图像生成使用了回退模型: ${fallbackModel}`);
    }
  } else {
    console.log("🟣 Using sync model (else branch)");
    // Build multimodal parts
    const parts: any[] = [{ text: prompt }];

    // Add reference image if provided (for costume variations)
    if (referenceImageUrl) {
      const inlineData = await getInlineData(referenceImageUrl);
      if (inlineData) {
        // 如果图片太大（>512KB），先压缩
        if (inlineData.data.length >= 512 * 1024) {
          const compressed = await compressImage(
            `data:${inlineData.mimeType};base64,${inlineData.data}`,
            1.5 * 1024 * 1024, // 压缩到 1.5MB 以内
            { maxDim: 1024, minQuality: 0.3 },
          );
          const match = compressed.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: { mimeType: match[1], data: match[2] },
            });
          }
        } else {
          parts.push({
            inlineData: {
              mimeType: inlineData.mimeType,
              data: inlineData.data,
            },
          });
        }
      }
    }

    let data = await callGemini(selectedModel, [{ role: "user", parts }], {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: { aspectRatio, imageSize: "2K" },
    });

    let img = await extractImageBase64(data);
    if (!img) {
      const fallbackModel = resolveImageFallbackModel(selectedModel);
      if (fallbackModel && fallbackModel !== selectedModel) {
        console.warn(
          "Primary character image model returned text-only output, retrying fallback:",
          fallbackModel,
          summarizeGeminiImageResponse(data),
        );
        data = await callGemini(fallbackModel, [{ role: "user", parts }], {
          responseModalities: ["IMAGE", "TEXT"],
          imageConfig: { aspectRatio, imageSize: "2K" },
        });
        img = await extractImageBase64(data);
      }
    }
    if (!img) {
      console.error("extractImageBase64 returned null, response summary:", summarizeGeminiImageResponse(data));
      throw new Error("AI 未返回角色图");
    }
    if (!img) {
      throw new Error(explainGeminiNoText(data) || "AI 未返回角色图");
    }
    if (!img.base64 || img.base64.trim().length === 0) {
      console.error("extractImageBase64 returned empty base64, img summary:", summarizeExtractedImage(img));
      throw new Error("AI 返回的图像数据为空");
    }
    console.log("Image extracted successfully, base64 length:", img.base64.length, "mimeType:", img.mimeType);
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  console.log("Before uploadImageToStorage:", summarizeUploadImagePayload(imageBase64, mimeType));

  if (!imageBase64 || imageBase64.length === 0) {
    throw new Error("图像生成失败：未获取到图像数据");
  }

  const imageUrl = await uploadImageToStorage(
    imageBase64,
    mimeType,
    "characters",
  );
  return { imageUrl };
}

async function localGenerateScene(body: any) {
  const { name, description, style, model, referenceImageUrl } = body;
  if (!name) throw new Error("缺少场景名称");

  const sceneDesc = description || name;
  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : SCENE_STYLE_MAP[style] || SCENE_STYLE_MAP["live-action"];

  const staticSceneRule = `\n\n⚠️ STATIC ENVIRONMENT ONLY — CRITICAL RULE ⚠️
This image must depict ONLY the permanent, static environment — the architecture, landscape, terrain, vegetation, bodies of water, sky, and fixed structures.
DO NOT include ANY of the following:
- Characters, people, creatures, monsters, animals, or any living beings
- Temporary or dynamic objects from the story (e.g. tentacles, magic effects, explosions, blood, weapons, floating objects)
- Any narrative-specific elements that are NOT a permanent part of the physical location
Think of this as an "empty stage" — show only what would exist in this location when no story events are occurring.`;

  let prompt: string;

  if (referenceImageUrl) {
    // EDIT mode: treat it as an image modification task, not a new creation
    prompt = `You are an image editor. The attached image is the ORIGINAL scene. Your task is to create a MODIFIED VERSION of this EXACT image.

ABSOLUTE RULES — ZERO TOLERANCE FOR DEVIATION:
1. DO NOT redraw, recreate, or reinterpret the scene. You are EDITING the existing image, not creating a new one.
2. Every single pixel of structure, architecture, terrain, vegetation, water bodies, and objects MUST remain in the EXACT same position, shape, size, and proportion.
3. The camera angle, perspective, focal length, and composition are LOCKED. Nothing moves.
4. The art style, rendering technique, brush strokes, and color palette base MUST remain identical.

YOUR ONLY PERMITTED MODIFICATIONS:
- Change the time of day (dawn / day / dusk / night)
- Adjust lighting direction, color temperature, and shadow angles accordingly
- Change weather/atmosphere (clear / cloudy / rainy / snowy / foggy)
- Adjust sky appearance to match the new time/weather

Think of this as applying a "time-of-day filter" or "weather filter" to the original photograph. The underlying image content must be 100% preserved.

Target scene description: ${sceneDesc}
Art style (maintain exactly): ${styleDesc}.
${staticSceneRule}`;
  } else {
    // CREATE mode: first variant, generate from scratch
    prompt = `Create a detailed, high-quality background/environment concept art for a scene called "${name}".

Scene description: ${sceneDesc}

Art style: ${styleDesc}.

This is a wide establishing shot showing the full environment. Focus on atmosphere, lighting, and mood. Professional concept art quality.${staticSceneRule}`;
  }

  const selectedModel = model || "gemini-3.1-flash-image-preview";
  const isSeedream = selectedModel.startsWith("doubao-seedream");
  const isAsync = selectedModel.includes("-async");

  let imageBase64: string = "";
  let mimeType: string = "image/jpeg"; // 默认值

  if (isSeedream) {
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: "2560x1440",
    });
    imageBase64 = result.base64;
    mimeType = result.mimeType;
  } else if (isAsync) {
    // 使用新的异步 API
    try {
      const { task_id, fallbackModel, shouldUseFallback } = await callAsyncImageGeneration(prompt, {
        model: selectedModel,
        size: "16:9",
        input_reference: referenceImageUrl,
      });

      // 如果异步API不支持（如有参考图像），直接使用回退模型
      if (shouldUseFallback && fallbackModel) {
        console.log("异步API不支持此请求，直接使用同步回退模型:", fallbackModel);

        // 使用同步API
        const parts: any[] = [{ text: prompt }];

        if (referenceImageUrl) {
          const inlineData = await getInlineData(referenceImageUrl);
          if (inlineData) {
            // 如果图片太大（>512KB），先压缩
            if (inlineData.data.length >= 512 * 1024) {
              const compressed = await compressImage(
                `data:${inlineData.mimeType};base64,${inlineData.data}`,
                1.5 * 1024 * 1024,
                { maxDim: 2048, minQuality: 0.3 }
              );
              const base64Data = compressed.split(",")[1];
              parts.push({
                inlineData: { mimeType: "image/jpeg", data: base64Data },
              });
            } else {
              parts.push({ inlineData });
            }
          }
        }

        const response = await callGemini(
          fallbackModel,
          [{ role: "user", parts }],
          {
            responseModalities: ["IMAGE", "TEXT"],
            imageSize: "2K",
          }
        );

        const extracted = await extractImageBase64(response);
        if (!extracted) {
          throw new Error("回退模型未返回图像");
        }
        imageBase64 = extracted.base64;
        mimeType = extracted.mimeType;
      } else {
        // 正常轮询异步结果
        const result = await pollAsyncImageResult(task_id, {
          maxAttempts: DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS,
          maxDurationMs: DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS,
          fallbackModel,
          prompt,
          size: "16:9",
          input_reference: referenceImageUrl,
        });
        imageBase64 = result.base64;
        mimeType = result.mimeType;
        if (result.usedFallback) {
          console.log(`场景图像生成使用了回退模型: ${fallbackModel}`);
        }
      }
    } catch (asyncFailure: any) {
      if (isAsyncImageTaskPendingError(asyncFailure) || isAbortLikeError(asyncFailure)) {
        throw asyncFailure;
      }
      const asyncError = asyncFailure;
      // 异步API提交失败，尝试使用同步回退模型
      console.warn("异步API提交失败，使用同步回退模型:", asyncError.message);

      // 确定回退模型
      const fallbackMap: Record<string, string> = {
        "gemini-3-pro-image-preview-async": "gemini-3-pro-image-preview",
        "gemini-3-pro-image-preview-2k-async": "gemini-3-pro-image-preview-2k",
        "gemini-3-pro-image-preview-4k-async": "gemini-3-pro-image-preview-4k",
        "nano-banana-2": "gemini-3-pro-image-preview",
        "nano-banana-2-2k": "gemini-3-pro-image-preview-2k",
        "nano-banana-2-4k": "gemini-3-pro-image-preview-4k",
      };
      const fallbackModel = fallbackMap[selectedModel];

      if (!fallbackModel) {
        throw asyncError; // 如果没有回退模型，抛出原始错误
      }

      // 使用同步API作为回退
      const parts: any[] = [{ text: prompt }];

      if (referenceImageUrl) {
        const inlineData = await getInlineData(referenceImageUrl);
        if (inlineData) {
          // 如果图片太大（>512KB），先压缩
          if (inlineData.data.length >= 512 * 1024) {
            const compressed = await compressImage(
              `data:${inlineData.mimeType};base64,${inlineData.data}`,
              1.5 * 1024 * 1024,
              { maxDim: 2048, minQuality: 0.3 }
            );
            const base64Data = compressed.split(",")[1];
            parts.push({
              inlineData: { mimeType: "image/jpeg", data: base64Data },
            });
          } else {
            parts.push({ inlineData });
          }
        }
      }

      const response = await callGemini(
        fallbackModel,
        [{ role: "user", parts }],
        {
          responseModalities: ["IMAGE", "TEXT"],
          imageSize: "2K",
        }
      );

      const extracted = await extractImageBase64(response);
      if (!extracted) {
        throw new Error("回退模型未返回图像");
      }
      imageBase64 = extracted.base64;
      mimeType = extracted.mimeType;
      console.log(`场景图像生成使用了回退模型: ${fallbackModel}`);
    }
  } else {
    // Build multimodal parts
    const parts: any[] = [{ text: prompt }];

    // Add reference image if provided (for time variants)
    if (referenceImageUrl) {
      const inlineData = await getInlineData(referenceImageUrl);
      if (inlineData) {
        // 如果图片太大（>512KB），先压缩
        if (inlineData.data.length >= 512 * 1024) {
          const compressed = await compressImage(
            `data:${inlineData.mimeType};base64,${inlineData.data}`,
            1.5 * 1024 * 1024,
            { maxDim: 1024, minQuality: 0.3 },
          );
          const match = compressed.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            parts.push({
              inlineData: { mimeType: match[1], data: match[2] },
            });
          }
        } else {
          parts.push({
            inlineData: {
              mimeType: inlineData.mimeType,
              data: inlineData.data,
            },
          });
        }
      }
    }

    const data = await callGemini(selectedModel, [{ role: "user", parts }], {
      responseModalities: ["IMAGE", "TEXT"],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
    });

    const img = await extractImageBase64(data);
    if (!img) throw new Error("AI 未返回场景图");
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  const imageUrl = await uploadImageToStorage(imageBase64, mimeType, "scenes");
  return { imageUrl };
}

async function localGenerateStoryboard(body: any) {
  const {
    description,
    characters,
    cameraDirection,
    sceneName,
    dialogue,
    style,
    characterDescriptions,
    sceneDescription,
    mode,
    characterImages,
    sceneImageUrl,
    prevStoryboardUrl,
    scriptExcerpt,
    neighborContext,
    aspectRatio,
    model,
  } = body;

  const isPanorama = mode === "panorama";
  if (!description && !isPanorama) throw new Error("缺少分镜描述");

  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : STORYBOARD_STYLE_MAP[style] || STORYBOARD_STYLE_MAP["live-action"];
  let prompt: string;

  if (isPanorama) {
    const charList = (characters || []).join("、");
    const charDescList = (characterDescriptions || [])
      .map((c: any) => `${c.name}: ${c.description}`)
      .join("\n");

    prompt = `Create a wide panoramic establishing shot showing character positions in a scene.

Scene: "${sceneName}"
Scene description: ${sceneDescription || sceneName}
Characters present: ${charList}

Character details:
${charDescList || "No specific character details provided."}

Scene content/action: ${description}

Art style: ${styleDesc}

IMPORTANT REQUIREMENTS:
- This is a WIDE PANORAMIC shot (ultra-wide 21:9 or wider aspect ratio)
- Show ALL characters in their relative positions within the scene
- Each character should be clearly identifiable
- Show the full environment/background
- Characters should be full-body, showing their spatial relationships
- Professional concept art quality, clear composition`;
  } else {
    const charList = (characters || []).join("、");
    const charDescList = (characterDescriptions || [])
      .map((c: any) => `${c.name}: ${c.description}`)
      .join("\n");

    let narrativeContext = "";
    if (scriptExcerpt) {
      narrativeContext += `\n[SCRIPT CONTEXT]\n${scriptExcerpt}\n`;
    }
    if (neighborContext) {
      const nc = neighborContext;
      narrativeContext += `\n[SCENE CONTINUITY — Shot ${nc.currentShotIndex} of ${nc.totalShotsInScene}]`;
      if (nc.prevDescription)
        narrativeContext += `\nPrevious shot: ${nc.prevDescription}`;
      if (nc.nextDescription)
        narrativeContext += `\nNext shot: ${nc.nextDescription}`;
      narrativeContext += "\n";
    }

    const firstFrameDesc = rewriteToFirstFrame(description);

    prompt = `You are a professional cinematic storyboard artist. Create a single storyboard frame for the shot described below.

=== TWO CO-EQUAL TOP PRIORITIES ===

⚠️ **PRIORITY A — CHARACTER CONSISTENCY** ⚠️
Every character MUST be an EXACT visual clone of their reference image. FACE, HAIR, CLOTHING, BODY must match exactly.

⚠️ **PRIORITY B — FIRST-FRAME PRINCIPLE** ⚠️
This image is the STARTING FRAME (T=0). Depict the moment JUST BEFORE action begins. NO motion blur, mid-swing limbs, impact effects.

=== CURRENT SHOT ===
Scene: "${sceneName || "Unknown"}"
Shot description: ${firstFrameDesc}
Characters present: ${charList || "None specified"}
${charDescList ? `\nCharacter appearance:\n${charDescList}` : ""}
Camera: ${cameraDirection || "Medium shot"}
${dialogue ? `Dialogue: ${dialogue}` : ""}
Scene environment: ${sceneDescription || sceneName || "Not specified"}

=== ART STYLE ===
${styleDesc}
Every element MUST be rendered in this EXACT art style.
${narrativeContext}
=== ADDITIONAL REQUIREMENTS ===
1. Enrich visual details based on context.
2. Maintain spatial consistency with previous/next shots. VARY composition (change angle, shot size, framing).
3. ${aspectRatio || "16:9"} cinematic composition.
4. Ultra high resolution.`;
  }

  // Build multimodal parts
  const parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }> = [];
  parts.push({ text: prompt });

  const curProtagonistName = (characters || [])[0] || "";

  // 并行加载所有参考图（场景图 + 角色图 + 上一帧 + 主角锚定）
  const sortedCharImages = Array.isArray(characterImages)
    ? [...characterImages].sort((a: any, b: any) =>
        (a.name === curProtagonistName ? 1 : 0) - (b.name === curProtagonistName ? 1 : 0),
      )
    : [];

  const prevChars: string[] = neighborContext?.prevCharacters || [];
  const prevProtagonist = prevChars[0] || "";
  const sameProtagonist =
    curProtagonistName && prevProtagonist && curProtagonistName === prevProtagonist;

  const protagonistImg = characterImages?.find((c: any) => c.name === curProtagonistName);

  // 并行发起所有图片加载
  const [sceneInline, prevInline, anchorInline, ...charInlines] = await Promise.all([
    sceneImageUrl && typeof sceneImageUrl === "string"
      ? getInlineData(sceneImageUrl)
      : Promise.resolve(null),
    prevStoryboardUrl && typeof prevStoryboardUrl === "string" && sameProtagonist
      ? getInlineData(prevStoryboardUrl)
      : Promise.resolve(null),
    protagonistImg?.imageUrl
      ? getInlineData(protagonistImg.imageUrl)
      : Promise.resolve(null),
    ...sortedCharImages
      .filter((c: any) => c.imageUrl && typeof c.imageUrl === "string")
      .map((c: any) => getInlineData(c.imageUrl)),
  ]);

  // Add scene reference image
  if (sceneInline) {
    parts.push({ inlineData: sceneInline });
    parts.push({
      text: `[SCENE ENVIRONMENT REFERENCE IMAGE]\nUse for environment style, color palette, architecture, props, and lighting.`,
    });
  }

  // Add character reference images — protagonist last
  let charRefCount = 0;
  const validCharImages = sortedCharImages.filter((c: any) => c.imageUrl && typeof c.imageUrl === "string");
  for (let i = 0; i < validCharImages.length; i++) {
    const charImg = validCharImages[i];
    const inlineData = charInlines[i];
    if (inlineData) {
      charRefCount++;
      const isProtagonist = charImg.name === curProtagonistName;
      parts.push({ inlineData });
      if (isProtagonist) {
        parts.push({
          text: `[★★★ VISUAL PROTAGONIST — ${charImg.name} ★★★]\nThis character's face, hair, clothing MUST be an EXACT clone of this reference.`,
        });
      } else {
        parts.push({
          text: `[CHARACTER REFERENCE — ${charImg.name}]\nReproduce their appearance faithfully.`,
        });
      }
    }
  }

  if (charRefCount > 0) {
    parts.push({
      text: `[ART STYLE ENFORCEMENT]\nALL characters and environments MUST be rendered in: ${styleDesc}`,
    });
  }

  // Previous storyboard for continuity
  if (prevInline) {
    parts.push({ inlineData: prevInline });
    parts.push({
      text: `[PREVIOUS SHOT — ENVIRONMENT & SPATIAL CONTINUITY]\nMaintain environment consistency. Character "${curProtagonistName}" appears in both shots.`,
    });
  }

  // Double anchor: re-send protagonist reference
  if (anchorInline) {
    parts.push({ inlineData: anchorInline });
    parts.push({
      text: `[★ FINAL ANCHOR — ${curProtagonistName} ★]\nFINAL REMINDER: protagonist MUST have THIS EXACT face, hair, and clothing.`,
    });
  }

  const selectedModel = model || "gemini-3.1-flash-image-preview";
  const isSeedream = selectedModel.startsWith("doubao-seedream");
  const isAsync = selectedModel.includes("-async");

  let imageBase64: string = "";
  let mimeType: string = "image/jpeg"; // 默认值

  if (isSeedream) {
    // Build Seedream prompt with image URLs
    const refImages: string[] = [];
    let imageDescriptions = "";
    if (Array.isArray(characterImages)) {
      for (const charImg of characterImages) {
        if (
          charImg.imageUrl &&
          typeof charImg.imageUrl === "string" &&
          !charImg.imageUrl.startsWith("data:")
        ) {
          refImages.push(charImg.imageUrl);
          imageDescriptions += `\n图${refImages.length} 是角色「${charImg.name}」的外观设计参考图。`;
        }
      }
    }
    if (
      sceneImageUrl &&
      typeof sceneImageUrl === "string" &&
      !sceneImageUrl.startsWith("data:")
    ) {
      refImages.push(sceneImageUrl);
      imageDescriptions += `\n图${refImages.length} 是场景环境参考图。`;
    }
    if (
      prevStoryboardUrl &&
      typeof prevStoryboardUrl === "string" &&
      !prevStoryboardUrl.startsWith("data:")
    ) {
      refImages.push(prevStoryboardUrl);
      imageDescriptions += `\n图${refImages.length} 是上一个镜头的分镜图，仅用于保持环境连续性。`;
    }

    const fullPrompt =
      refImages.length > 0
        ? `${prompt}\n\n参考图说明：${imageDescriptions}`
        : prompt;
    const result = await callSeedreamImage(fullPrompt, {
      model: selectedModel,
      size: "2K",
      image: refImages.length > 0 ? refImages : undefined,
    });
    imageBase64 = result.base64;
    mimeType = result.mimeType;
  } else if (isAsync) {
    // 使用新的异步 API
    // 确定分辨率和尺寸
    let asyncSize = "1:1";
    if (selectedModel.includes("2k")) {
      asyncSize = "1:1";
    } else if (selectedModel.includes("4k")) {
      asyncSize = "1:1";
    }

    // 收集参考图像 URL（只使用第一个角色图像作为主要参考）
    let referenceImageUrl: string | undefined;
    if (Array.isArray(characterImages) && characterImages.length > 0) {
      const firstChar = characterImages[0];
      if (
        firstChar.imageUrl &&
        typeof firstChar.imageUrl === "string" &&
        !firstChar.imageUrl.startsWith("data:")
      ) {
        referenceImageUrl = firstChar.imageUrl;
      }
    }
    // 如果没有角色图像，尝试使用场景图像
    if (
      !referenceImageUrl &&
      sceneImageUrl &&
      typeof sceneImageUrl === "string" &&
      !sceneImageUrl.startsWith("data:")
    ) {
      referenceImageUrl = sceneImageUrl;
    }

    // 提交异步任务
    try {
      const { task_id, fallbackModel, shouldUseFallback } = await callAsyncImageGeneration(prompt, {
        model: selectedModel,
        size: asyncSize,
        input_reference: referenceImageUrl,
      });

      // 如果异步API不支持（如有参考图像），直接使用回退模型
      if (shouldUseFallback && fallbackModel) {
        console.log("异步API不支持此请求，直接使用同步回退模型:", fallbackModel);

        // 使用同步API作为回退，使用已经构建好的 parts
        const data = await callGemini(fallbackModel, [{ role: "user", parts }], {
          responseModalities: ["IMAGE", "TEXT"],
          imageSize: "2K",
        });

        const img = await extractImageBase64(data);
        if (!img) throw new Error("回退模型未返回分镜图");
        imageBase64 = img.base64;
        mimeType = img.mimeType;
      } else {
        // 正常轮询异步结果
        const result = await pollAsyncImageResult(task_id, {
          maxAttempts: DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS,
          maxDurationMs: DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS,
          fallbackModel,
          prompt,
          size: asyncSize,
          input_reference: referenceImageUrl,
        });
        imageBase64 = result.base64;
        mimeType = result.mimeType;
        if (result.usedFallback) {
          console.log(`分镜图生成使用了回退模型: ${fallbackModel}`);
        }
      }
    } catch (asyncError: any) {
      if (isAsyncImageTaskPendingError(asyncError) || isAbortLikeError(asyncError)) {
        throw asyncError;
      }
      // 异步API提交失败，尝试使用同步回退模型
      console.warn("异步API提交失败，使用同步回退模型:", asyncError.message);

      // 确定回退模型
      const fallbackMap: Record<string, string> = {
        "gemini-3-pro-image-preview-async": "gemini-3-pro-image-preview",
        "gemini-3-pro-image-preview-2k-async": "gemini-3-pro-image-preview-2k",
        "gemini-3-pro-image-preview-4k-async": "gemini-3-pro-image-preview-4k",
        "nano-banana-2": "gemini-3-pro-image-preview",
        "nano-banana-2-2k": "gemini-3-pro-image-preview-2k",
        "nano-banana-2-4k": "gemini-3-pro-image-preview-4k",
      };
      const fallbackModel = fallbackMap[selectedModel];

      if (!fallbackModel) {
        throw asyncError; // 如果没有回退模型，抛出原始错误
      }

      // 使用同步API作为回退，使用已经构建好的 parts
      const data = await callGemini(fallbackModel, [{ role: "user", parts }], {
        responseModalities: ["IMAGE", "TEXT"],
        imageSize: "2K",
      });

      const img = await extractImageBase64(data);
      if (!img) throw new Error("回退模型未返回分镜图");
      imageBase64 = img.base64;
      mimeType = img.mimeType;
      console.log(`分镜图生成使用了回退模型: ${fallbackModel}`);
    }
  } else {
    const data = await callGemini(selectedModel, [{ role: "user", parts }], {
      responseModalities: ["IMAGE", "TEXT"],
      imageSize: "2K",
    });

    const img = await extractImageBase64(data);
    if (!img) throw new Error("AI 未返回分镜图");
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  const folder = isPanorama ? "panoramas" : "storyboards";
  const imageUrl = await uploadImageToStorage(imageBase64, mimeType, folder);
  return { imageUrl };
}

async function localGenerateCharacterV2(body: any, signal?: AbortSignal) {
  const { name, description, style, referenceImageUrl, viewMode, assetFileNameStem } = body;
  if (!name) throw new Error("缺少角色名称");

  const characterDesc = description || name;
  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : CHAR_STYLE_MAP[style] || CHAR_STYLE_MAP["live-action"];
  const isSingleMode = viewMode === "single";
  const isCostumeVariation = Boolean(referenceImageUrl);

  let prompt: string;
  if (isCostumeVariation) {
    prompt = `基于图 1 角色图，生成同一角色的新服装版本。

【面部特征】与图 1 保持完全一致（脸型、眉形、眼睛、鼻梁、嘴唇等），确保是同一个角色。

【服装】${characterDesc}

Art style: ${styleDesc}.
${isSingleMode ? "9:16 vertical portrait, front view, pure white background." : "16:9 horizontal, 4-view character sheet (front/side/back/face closeup), pure white background."}`;
  } else {
    const whiteBackgroundRule = "The background MUST be a plain, pure white background (#FFFFFF). No gradients, no shadows on the background, no environment elements. Clean white only.";
    const fullBodyRule = "CRITICAL: The character MUST be FULL BODY visible from head to toe - feet MUST be inside the frame, not cut off. Standing straight, complete figure in view.";
    prompt = isSingleMode
      ? `Create a professional full-body character design portrait for: "${name}" - ${characterDesc}.

Art style: ${styleDesc}.

${whiteBackgroundRule}
${fullBodyRule}

The image should be a single full-body FRONT VIEW portrait of the character standing in a neutral, upright pose on a plain white background. The character should face the camera directly. Show the character from head to toe with clear details of face, clothing, and accessories. Professional character design sheet quality - NO text labels, clean composition. The entire image MUST be in ${styleDesc} style.

CRITICAL: The character's clothing, armor, and accessories MUST match the era and setting described above. If the description mentions medieval, fantasy, ancient, or any specific historical period, ALL clothing must be era-appropriate. NEVER use modern clothing (suits, t-shirts, jeans, sneakers) for historical/fantasy characters.`
      : `Create a professional character design reference sheet for an animated character: "${name}" - ${characterDesc}.

Art style: ${styleDesc}.

${whiteBackgroundRule}
${fullBodyRule}

The image should be a clean character turnaround sheet with 4 views arranged in a 2x2 grid on a plain white background:
- Top-left: FRONT VIEW (full body from head to toe, facing camera)
- Top-right: SIDE VIEW (full body from head to toe, profile view from the right)
- Bottom-left: BACK VIEW (full body from head to toe, facing away)
- Bottom-right: FACE CLOSE-UP (detailed head/face portrait)

Each view should be labeled clearly. The character design must be consistent across all 4 views. The entire image MUST be in ${styleDesc} style.

CRITICAL: The character's clothing, armor, and accessories MUST match the era and setting described above. If the description mentions medieval, fantasy, ancient, or any specific historical period, ALL clothing must be era-appropriate. NEVER use modern clothing (suits, t-shirts, jeans, sneakers) for historical/fantasy characters.`;
  }

  const {
    selectedModel,
    transportModel,
    fallbackModel,
    providerAspectRatio,
    providerImageSize,
    usesAsyncTransport,
    usesImageGenerationsEndpoint,
  } = resolveImageRuntimeConfig(body, {
    defaultModel: "gemini-3.1-flash-image-preview",
    fallbackAspectRatio: isSingleMode ? "9:16" : "16:9",
    fallbackImageSize: "2K",
    overrideAspectRatio: isSingleMode ? "9:16" : "16:9",
  });

  const isSeedream = selectedModel.startsWith("doubao-seedream");
  let imageBase64 = "";
  let mimeType = "image/jpeg";

  if (isSeedream) {
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
    });
    imageBase64 = result.base64;
    mimeType = result.mimeType;
  } else {
    const parts: any[] = [{ text: prompt }];
    await appendReferenceInlineData(parts, referenceImageUrl);
    const img = await runResolvedGeminiImageGeneration({
      prompt,
      parts,
      selectedModel,
      transportModel,
      fallbackModel,
      usesAsyncTransport,
      providerAspectRatio,
      providerImageSize,
      referenceImageUrl,
      signal,
      usesImageGenerationsEndpoint,
    });
    if (!img?.base64?.trim()) {
      throw new Error("AI 未返回角色图像");
    }
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  const imageUrl = await uploadImageToStorage(imageBase64, mimeType, "characters", assetFileNameStem || name);
  return { imageUrl };
}

async function localGenerateSceneV2(body: any, signal?: AbortSignal) {
  const { name, description, style, referenceImageUrl, assetFileNameStem } = body;
  if (!name) throw new Error("缺少场景名称");

  const sceneDesc = description || name;
  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : SCENE_STYLE_MAP[style] || SCENE_STYLE_MAP["live-action"];

  const staticSceneRule = `\n\nSTATIC ENVIRONMENT ONLY - CRITICAL RULE
This image must depict ONLY the permanent, static environment - the architecture, landscape, terrain, vegetation, bodies of water, sky, and fixed structures.
DO NOT include ANY of the following:
- Characters, people, creatures, monsters, animals, or any living beings
- Temporary or dynamic objects from the story (e.g. tentacles, magic effects, explosions, blood, weapons, floating objects)
- Any narrative-specific elements that are NOT a permanent part of the physical location
Think of this as an "empty stage" - show only what would exist in this location when no story events are occurring.`;

  const prompt = referenceImageUrl
    ? `You are an image editor. The attached image is the ORIGINAL scene. Your task is to create a MODIFIED VERSION of this EXACT image.

ABSOLUTE RULES - ZERO TOLERANCE FOR DEVIATION:
1. DO NOT redraw, recreate, or reinterpret the scene. You are EDITING the existing image, not creating a new one.
2. Every single pixel of structure, architecture, terrain, vegetation, water bodies, and objects MUST remain in the EXACT same position, shape, size, and proportion.
3. The camera angle, perspective, focal length, and composition are LOCKED. Nothing moves.
4. The art style, rendering technique, brush strokes, and color palette base MUST remain identical.

YOUR ONLY PERMITTED MODIFICATIONS:
- Change the time of day (dawn / day / dusk / night)
- Adjust lighting direction, color temperature, and shadow angles accordingly
- Change weather/atmosphere (clear / cloudy / rainy / snowy / foggy)
- Adjust sky appearance to match the new time/weather

Think of this as applying a "time-of-day filter" or "weather filter" to the original photograph. The underlying image content must be 100% preserved.

Target scene description: ${sceneDesc}
Art style (maintain exactly): ${styleDesc}.
${staticSceneRule}`
    : `Create a detailed, high-quality background/environment concept art for a scene called "${name}".

Scene description: ${sceneDesc}

Art style: ${styleDesc}.

This is a wide establishing shot showing the full environment. Focus on atmosphere, lighting, and mood. Professional concept art quality.${staticSceneRule}`;

  const {
    selectedModel,
    transportModel,
    fallbackModel,
    providerAspectRatio,
    providerImageSize,
    usesAsyncTransport,
    usesImageGenerationsEndpoint,
  } = resolveImageRuntimeConfig(body, {
    defaultModel: "gemini-3.1-flash-image-preview",
    fallbackAspectRatio: "16:9",
    fallbackImageSize: "2K",
  });

  const isSeedream = selectedModel.startsWith("doubao-seedream");
  let imageBase64 = "";
  let mimeType = "image/jpeg";

  if (isSeedream) {
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
    });
    imageBase64 = result.base64;
    mimeType = result.mimeType;
  } else {
    const parts: any[] = [{ text: prompt }];
    await appendReferenceInlineData(parts, referenceImageUrl);
    const img = await runResolvedGeminiImageGeneration({
      prompt,
      parts,
      selectedModel,
      transportModel,
      fallbackModel,
      usesAsyncTransport,
      providerAspectRatio,
      providerImageSize,
      referenceImageUrl,
      signal,
      usesImageGenerationsEndpoint,
    });
    if (!img?.base64?.trim()) {
      throw new Error("AI 未返回场景图像");
    }
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  const imageUrl = await uploadImageToStorage(imageBase64, mimeType, "scenes", assetFileNameStem || name);
  return { imageUrl };
}

async function localGenerateStoryboardV2(body: any, signal?: AbortSignal) {
  const {
    description,
    characters,
    cameraDirection,
    sceneName,
    dialogue,
    style,
    characterDescriptions,
    sceneDescription,
    mode,
    characterImages,
    sceneImageUrl,
    prevStoryboardUrl,
    scriptExcerpt,
    neighborContext,
    assetFileNameStem,
  } = body;

  const isPanorama = mode === "panorama";
  if (!description && !isPanorama) throw new Error("缺少分镜描述");

  const styleDesc = style?.startsWith("custom:")
    ? style.slice(7)
    : STORYBOARD_STYLE_MAP[style] || STORYBOARD_STYLE_MAP["live-action"];
  let prompt: string;

  if (isPanorama) {
    const charList = (characters || []).join("、");
    const charDescList = (characterDescriptions || [])
      .map((c: any) => `${c.name}: ${c.description}`)
      .join("\n");

    prompt = `Create a wide panoramic establishing shot showing character positions in a scene.

Scene: "${sceneName}"
Scene description: ${sceneDescription || sceneName}
Characters present: ${charList}

Character details:
${charDescList || "No specific character details provided."}

Scene content/action: ${description}

Art style: ${styleDesc}

IMPORTANT REQUIREMENTS:
- This is a WIDE PANORAMIC shot
- Show ALL characters in their relative positions within the scene
- Each character should be clearly identifiable
- Show the full environment/background
- Characters should be full-body, showing their spatial relationships
- Professional concept art quality, clear composition`;
  } else {
    const charList = (characters || []).join("、");
    const charDescList = (characterDescriptions || [])
      .map((c: any) => `${c.name}: ${c.description}`)
      .join("\n");

    let narrativeContext = "";
    if (scriptExcerpt) {
      narrativeContext += `\n[SCRIPT CONTEXT]\n${scriptExcerpt}\n`;
    }
    if (neighborContext) {
      const nc = neighborContext;
      narrativeContext += `\n[SCENE CONTINUITY - Shot ${nc.currentShotIndex} of ${nc.totalShotsInScene}]`;
      if (nc.prevDescription) narrativeContext += `\nPrevious shot: ${nc.prevDescription}`;
      if (nc.nextDescription) narrativeContext += `\nNext shot: ${nc.nextDescription}`;
      narrativeContext += "\n";
    }

    const firstFrameDesc = rewriteToFirstFrame(description);
    prompt = `You are a professional cinematic storyboard artist. Create a single storyboard frame for the shot described below.

=== TWO CO-EQUAL TOP PRIORITIES ===

PRIORITY A - CHARACTER CONSISTENCY
Every character MUST be an EXACT visual clone of their reference image. FACE, HAIR, CLOTHING, BODY must match exactly.

PRIORITY B - FIRST-FRAME PRINCIPLE
This image is the STARTING FRAME (T=0). Depict the moment JUST BEFORE action begins. NO motion blur, mid-swing limbs, impact effects.

=== CURRENT SHOT ===
Scene: "${sceneName || "Unknown"}"
Shot description: ${firstFrameDesc}
Characters present: ${charList || "None specified"}
${charDescList ? `\nCharacter appearance:\n${charDescList}` : ""}
Camera: ${cameraDirection || "Medium shot"}
${dialogue ? `Dialogue: ${dialogue}` : ""}
Scene environment: ${sceneDescription || sceneName || "Not specified"}

=== ART STYLE ===
${styleDesc}
Every element MUST be rendered in this EXACT art style.
${narrativeContext}
=== ADDITIONAL REQUIREMENTS ===
1. Enrich visual details based on context.
2. Maintain spatial consistency with previous/next shots. VARY composition (change angle, shot size, framing).
3. Cinematic composition.
4. Ultra high resolution.`;
  }

  const {
    selectedModel,
    transportModel,
    fallbackModel,
    providerAspectRatio,
    providerImageSize,
    usesAsyncTransport,
    usesImageGenerationsEndpoint,
  } = resolveImageRuntimeConfig(body, {
    defaultModel: "gemini-3.1-flash-image-preview",
    fallbackAspectRatio: "16:9",
    fallbackImageSize: "2K",
  });

  const parts: Array<{
    text?: string;
    inlineData?: { mimeType: string; data: string };
  }> = [{ text: prompt }];

  const currentProtagonistName = (characters || [])[0] || "";
  const sortedCharacterImages = Array.isArray(characterImages)
    ? [...characterImages].sort((a: any, b: any) =>
        (a.name === currentProtagonistName ? 1 : 0) -
        (b.name === currentProtagonistName ? 1 : 0),
      )
    : [];
  const previousCharacters: string[] = neighborContext?.prevCharacters || [];
  const previousProtagonist = previousCharacters[0] || "";
  const sameProtagonist =
    currentProtagonistName &&
    previousProtagonist &&
    currentProtagonistName === previousProtagonist;
  const protagonistImage = characterImages?.find(
    (item: any) => item.name === currentProtagonistName,
  );

  const [sceneInline, previousInline, anchorInline, ...characterInlines] =
    await Promise.all([
      sceneImageUrl && typeof sceneImageUrl === "string"
        ? getInlineData(sceneImageUrl)
        : Promise.resolve(null),
      prevStoryboardUrl &&
      typeof prevStoryboardUrl === "string" &&
      sameProtagonist
        ? getInlineData(prevStoryboardUrl)
        : Promise.resolve(null),
      protagonistImage?.imageUrl
        ? getInlineData(protagonistImage.imageUrl)
        : Promise.resolve(null),
      ...sortedCharacterImages
        .filter((item: any) => item.imageUrl && typeof item.imageUrl === "string")
        .map((item: any) => getInlineData(item.imageUrl)),
    ]);

  if (sceneInline) {
    parts.push({ inlineData: sceneInline });
    parts.push({
      text: "[SCENE ENVIRONMENT REFERENCE IMAGE]\nUse for environment style, color palette, architecture, props, and lighting.",
    });
  }

  let characterReferenceCount = 0;
  const validCharacterImages = sortedCharacterImages.filter(
    (item: any) => item.imageUrl && typeof item.imageUrl === "string",
  );
  for (let index = 0; index < validCharacterImages.length; index += 1) {
    const characterImage = validCharacterImages[index];
    const inlineData = characterInlines[index];
    if (!inlineData) continue;
    characterReferenceCount += 1;
    const isProtagonist = characterImage.name === currentProtagonistName;
    parts.push({ inlineData });
    parts.push({
      text: isProtagonist
        ? `[VISUAL PROTAGONIST - ${characterImage.name}]\nThis character's face, hair, clothing MUST be an EXACT clone of this reference.`
        : `[CHARACTER REFERENCE - ${characterImage.name}]\nReproduce their appearance faithfully.`,
    });
  }

  if (characterReferenceCount > 0) {
    parts.push({
      text: `[ART STYLE ENFORCEMENT]\nALL characters and environments MUST be rendered in: ${styleDesc}`,
    });
  }

  if (previousInline) {
    parts.push({ inlineData: previousInline });
    parts.push({
      text: `[PREVIOUS SHOT - ENVIRONMENT & SPATIAL CONTINUITY]\nMaintain environment consistency. Character "${currentProtagonistName}" appears in both shots.`,
    });
  }

  if (anchorInline) {
    parts.push({ inlineData: anchorInline });
    parts.push({
      text: `[FINAL ANCHOR - ${currentProtagonistName}]\nFINAL REMINDER: protagonist MUST have THIS EXACT face, hair, and clothing.`,
    });
  }

  const asyncReferenceImageUrl =
    validCharacterImages.find(
      (item: any) =>
        item.imageUrl &&
        typeof item.imageUrl === "string" &&
        !item.imageUrl.startsWith("data:"),
    )?.imageUrl ||
    (typeof sceneImageUrl === "string" && !sceneImageUrl.startsWith("data:")
      ? sceneImageUrl
      : undefined) ||
    (typeof prevStoryboardUrl === "string" &&
    !prevStoryboardUrl.startsWith("data:")
      ? prevStoryboardUrl
      : undefined);

  const isSeedream = selectedModel.startsWith("doubao-seedream");
  let imageBase64 = "";
  let mimeType = "image/jpeg";

  if (isSeedream) {
    const referenceImages: string[] = [];
    let imageDescriptions = "";
    for (const characterImage of validCharacterImages) {
      if (
        characterImage.imageUrl &&
        typeof characterImage.imageUrl === "string" &&
        !characterImage.imageUrl.startsWith("data:")
      ) {
        referenceImages.push(characterImage.imageUrl);
        imageDescriptions += `\n图 ${referenceImages.length} 是角色“${characterImage.name}”的外观参考图。`;
      }
    }
    if (
      sceneImageUrl &&
      typeof sceneImageUrl === "string" &&
      !sceneImageUrl.startsWith("data:")
    ) {
      referenceImages.push(sceneImageUrl);
      imageDescriptions += `\n图 ${referenceImages.length} 是场景环境参考图。`;
    }
    if (
      prevStoryboardUrl &&
      typeof prevStoryboardUrl === "string" &&
      !prevStoryboardUrl.startsWith("data:")
    ) {
      referenceImages.push(prevStoryboardUrl);
      imageDescriptions += `\n图 ${referenceImages.length} 是上一个镜头的分镜图，仅用于保持环境连续性。`;
    }

    const result = await callSeedreamImage(
      referenceImages.length > 0
        ? `${prompt}\n\n参考图说明：${imageDescriptions}`
        : prompt,
      {
        model: selectedModel,
        size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
        image: referenceImages.length > 0 ? referenceImages : undefined,
      },
    );
    imageBase64 = result.base64;
    mimeType = result.mimeType;
  } else {
    const img = await runResolvedGeminiImageGeneration({
      prompt,
      parts,
      selectedModel,
      transportModel,
      fallbackModel,
      usesAsyncTransport,
      providerAspectRatio,
      providerImageSize,
      referenceImageUrl: asyncReferenceImageUrl,
      signal,
      usesImageGenerationsEndpoint,
    });
    if (!img?.base64?.trim()) {
      throw new Error("AI 未返回分镜图像");
    }
    imageBase64 = img.base64;
    mimeType = img.mimeType;
  }

  const folder = isPanorama ? "panoramas" : "storyboards";
  const imageUrl = await uploadImageToStorage(
    imageBase64,
    mimeType,
    folder,
    assetFileNameStem || sceneName || (isPanorama ? "全景图" : "分镜图"),
  );
  return { imageUrl };
}

async function safeParseVideoResponse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new Error(`${label} 返回了非 JSON 响应 (${res.status}): ${preview}`);
  }
}

type VideoApiErrorDetail = {
  code: string;
  message: string;
  requestId: string;
  rawText: string;
};

async function readVideoApiErrorDetail(res: Response): Promise<VideoApiErrorDetail> {
  const rawText = (await res.text().catch(() => "")).trim();
  let code = "";
  let message = "";
  let requestId = "";

  if (rawText) {
    try {
      const parsed = JSON.parse(rawText) as Record<string, any>;
      const nestedError =
        parsed && typeof parsed.error === "object" && parsed.error
          ? (parsed.error as Record<string, any>)
          : null;
      const primary = nestedError || parsed;
      code = String(primary?.code || parsed.code || "").trim();
      message = String(primary?.message || parsed.message || "").trim();
      requestId = String(
        primary?.request_id ||
          primary?.requestId ||
          parsed.request_id ||
          parsed.requestId ||
          "",
      ).trim();
    } catch {
      // Fall back to the raw response body for non-JSON errors.
    }
  }

  return {
    code,
    message,
    requestId,
    rawText,
  };
}

function formatVideoApiError(
  label: string,
  status: number,
  detail: VideoApiErrorDetail,
  options?: {
    provider?: "ark" | "seedance" | "tuzi";
    endpointId?: string;
  },
): string {
  const parts: string[] = [];
  if (detail.code) parts.push(detail.code);
  if (detail.message) {
    parts.push(detail.message);
  } else if (detail.rawText) {
    parts.push(detail.rawText.slice(0, 500));
  }

  if (options?.provider === "ark" && status === 403) {
    if (/operationdenied\.servicenotopen/i.test(detail.code)) {
      parts.push("当前 Ark 账号或 API Key 尚未开通该视频能力。");
    } else if (/accountoverdue/i.test(detail.code)) {
      parts.push("当前 Ark 账号可能已欠费。");
    } else {
      parts.push("这通常表示 Ark API Key、Endpoint ID 或账号权限不匹配。");
    }

    if (options.endpointId) {
      parts.push(`请确认 endpoint id ${options.endpointId} 属于当前 Ark 账号且已授权。`);
    }
  }

  if (detail.requestId) {
    parts.push(`request_id: ${detail.requestId}`);
  }

  return parts.length > 0
    ? `${label} (${status}): ${parts.join(" | ")}`
    : `${label} (${status})`;
}

async function normalizeArkReferenceImageUrl(imageUrl: string): Promise<string | null> {
  const trimmed = String(imageUrl || "").trim();
  if (!trimmed || trimmed.startsWith("blob:")) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) {
    return trimmed;
  }

  const inlineData = await getInlineData(trimmed);
  if (!inlineData?.data) return null;
  return `data:${inlineData.mimeType || "image/jpeg"};base64,${inlineData.data}`;
}

async function localGenerateVideo(body: any, abortSignal?: AbortSignal) {
  const { action, model, taskId, provider } = body;
  const apiConfig = getApiConfig();
  const isSora2 = model?.startsWith("sora-2") || provider === "tuzi";
  const requestedJimengProvider = provider === "jimeng" || provider === "dreamina-cli" || !provider;
  const wantsDreaminaCli =
    requestedJimengProvider &&
    !isSora2 &&
    (provider === "dreamina-cli" || (!provider && prefersJimengCli(apiConfig)));
  const dreaminaCliAvailable = wantsDreaminaCli ? await isDreaminaCliAvailable() : false;
  const seedanceBaseUrl = getSeedanceBaseUrl();
  const seedanceVideoTasksBaseUrl = getSeedanceVideoTasksBaseUrl();
  const jimengVideoTasksBaseUrl = getJimengVideoTasksBaseUrl();
  const usesJimengArkTasksApi = isJimengArkTasksEndpoint(jimengVideoTasksBaseUrl);
  const tuziBase = getTuziBaseUrl();

  if (wantsDreaminaCli && !dreaminaCliAvailable) {
    throw new Error("当前已切换到 Dreamina CLI，但本机未检测到可用的 Dreamina CLI。请先安装并登录，或在设置中切回 API。");
  }

  if (action === "status") {
    if (!taskId) throw new Error("缺少 taskId");
    console.log(`[video] 查询状态 taskId=${taskId} provider=${provider}`);
    if (provider === "tuzi") {
      // Query Sora 2 task status
      const res = await videoHttp(
        `${tuziBase}/doubao/api/v3/contents/generations/tasks/${taskId}`,
        {
          "Content-Type": "application/json",
        },
        undefined,
        abortSignal,
        "tuzi",
      );
      if (!res.ok) throw new Error(`查询 Sora 2 状态失败 (${res.status})`);
      const data = await safeParseVideoResponse(res, "Sora 2 状态查询");
      const status =
        data.status === "completed"
          ? "succeeded"
          : data.status === "failed"
            ? "failed"
            : "processing";
      const videoUrl = data.status === "completed" && data.video_url ? data.video_url : undefined;
      console.log(`[video] 状态返回 taskId=${taskId} provider=tuzi status=${status} hasUrl=${!!videoUrl}`);
      return { status, video_url: videoUrl, state: data.status };
    } else if (provider === "dreamina-cli" || wantsDreaminaCli) {
      return await dreaminaCliQueryResult(taskId);
    } else {
      if (usesJimengArkTasksApi) {
        const res = await videoHttp(
          `${jimengVideoTasksBaseUrl}/${taskId}`,
          {},
          undefined,
          abortSignal,
          "jimeng",
        );
        if (!res.ok) {
          const detail = await readVideoApiErrorDetail(res);
          throw new Error(
            formatVideoApiError("查询 Ark 视频状态失败", res.status, detail, {
              provider: "ark",
            }),
          );
        }
        const data = await safeParseVideoResponse(res, "Ark 状态查询");
        const arkResult = {
          status: normalizeTaskApiStatus(data.status),
          video_url: extractVideoTaskVideoUrl(data),
          state: data.status,
        };
        console.log(`[video] 状态返回 taskId=${taskId} provider=ark status=${arkResult.status} hasUrl=${!!arkResult.video_url}`);
        return arkResult;
      }
      // Jimeng status query
      const res = await videoHttp(
        `${seedanceVideoTasksBaseUrl}/${taskId}`,
        {},
        undefined,
        abortSignal,
        "jimeng",
      );
      if (!res.ok) throw new Error(`查询视频状态失败 (${res.status})`);
      const seedancePayload = await safeParseVideoResponse(res, "Seedance 状态查询");
      const seedanceVideoUrl = extractVideoTaskVideoUrl(seedancePayload);
      const seedanceResult = {
        ...seedancePayload,
        ...(seedanceVideoUrl ? { video_url: seedanceVideoUrl } : {}),
      };
      console.log(`[video] 状态返回 taskId=${taskId} provider=seedance status=${seedanceResult?.status} hasUrl=${!!seedanceResult?.video_url}`);
      return seedanceResult;
    }
  }

  if (action === "cancel") {
    if (!taskId) throw new Error("缺少 taskId");

    if (provider === "tuzi") {
      const res = await videoHttpRequest({
        url: `${tuziBase}/doubao/api/v3/contents/generations/tasks/${taskId}`,
        headers: {
          "Content-Type": "application/json",
        },
        signal: abortSignal,
        service: "tuzi",
        method: "DELETE",
      });
      if (!res.ok) {
        const detail = await readVideoApiErrorDetail(res);
        throw new Error(
          formatVideoApiError("取消 Sora 2 视频任务失败", res.status, detail, {
            provider: "tuzi",
          }),
        );
      }
      return {
        task_id: taskId,
        status: "cancelled",
        provider: "tuzi",
      };
    }

    if (provider === "dreamina-cli" || wantsDreaminaCli) {
      return await dreaminaCliCancelVideo(taskId);
    }

    if (usesJimengArkTasksApi) {
      const res = await videoHttpRequest({
        url: `${jimengVideoTasksBaseUrl}/${taskId}`,
        signal: abortSignal,
        service: "jimeng",
        method: "DELETE",
      });
      if (!res.ok) {
        const detail = await readVideoApiErrorDetail(res);
        throw new Error(
          formatVideoApiError("取消 Ark 视频任务失败", res.status, detail, {
            provider: "ark",
          }),
        );
      }
      return {
        task_id: taskId,
        status: "cancelled",
        provider: "jimeng",
      };
    }

    const res = await videoHttpRequest({
      url: `${seedanceVideoTasksBaseUrl}/${taskId}`,
      signal: abortSignal,
      service: "jimeng",
      method: "DELETE",
    });
    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      throw new Error(
        formatVideoApiError("取消 Seedance 视频任务失败", res.status, detail, {
          provider: "seedance",
        }),
      );
    }
    return {
      task_id: taskId,
      status: "cancelled",
      provider: "jimeng",
    };
  }

  if (action === "models") {
    if (requestedJimengProvider && wantsDreaminaCli) {
      return getDreaminaCliModelCatalog();
    }
    const res = await videoHttp(
      `${seedanceBaseUrl}/models`,
      {},
      undefined,
      undefined,
      "jimeng",
    );
    if (!res.ok) throw new Error(`查询模型列表失败 (${res.status})`);
    return await safeParseVideoResponse(res, "模型列表查询");
  }

  // Create video
  if (!body.prompt) throw new Error("缺少视频描述 (prompt)");
  const promptForLog = String(body.prompt);
  console.log(
    [
      `[video] 提交生成请求 provider=${isSora2 ? "tuzi" : wantsDreaminaCli ? "dreamina-cli" : usesJimengArkTasksApi ? "ark" : "seedance"} model=${body.model || "default"} duration=${body.duration}s promptLength=${promptForLog.length}`,
      "[video] prompt begin",
      promptForLog,
      "[video] prompt end",
    ].join("\n"),
  );

  if (isSora2) {
    // Sora 2 API implementation
    const content: any[] = [
      {
        type: "text",
        text: body.prompt,
      },
    ];

    // Add image if provided
    if (body.imageUrl) {
      let imageUrl = body.imageUrl as string;
      if (imageUrl.startsWith("data:")) {
        const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          imageUrl = await uploadImageToStorage(
            match[2],
            match[1],
            "video-frames",
          );
        }
      }
      content.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
        },
        role: "first_frame",
      });
    }

    // Map aspect ratio
    const aspectRatioMap: Record<string, string> = {
      "16:9": "16:9",
      "9:16": "9:16",
      "1:1": "1:1",
      "4:3": "4:3",
      "3:4": "3:4",
    };

    // Determine resolution and model based on body.resolution
    // 720p -> sora-2, 1080p -> sora-2-pro
    const resolution = body.resolution || "1080p";
    const actualModel = resolution === "720p" ? "sora-2" : "sora-2-pro";
    const payload: any = {
      model: resolveConfiguredModelName(actualModel),
      content,
      resolution,
      duration: Math.max(4, Math.min(12, body.duration || 5)),
      ratio: aspectRatioMap[body.aspectRatio] || "16:9",
      watermark: false,
    };

    const res = await videoHttp(
      `${tuziBase}/doubao/api/v3/contents/generations/tasks`,
      {
        "Content-Type": "application/json",
      },
      JSON.stringify(payload),
      undefined,
      "tuzi",
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Sora 2 视频生成任务创建失败 (${res.status}): ${errText}`);
    }
    const data = await safeParseVideoResponse(res, "Sora 2 创建任务");
    console.log(`[video] 提交成功 provider=tuzi task_id=${data.id} status=${data.status}`);
    return {
      task_id: data.id,
      status: data.status || "queued",
      provider: "tuzi",
    };
  } else {
    if (wantsDreaminaCli) {
      return await dreaminaCliGenerateVideo({
        prompt: body.prompt,
        imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : undefined,
        duration: Number(body.duration) || 5,
        aspectRatio: body.aspectRatio || "16:9",
      });
    }

    // Jimeng (Seedance) implementation. The Tuzi Seedance endpoint expects the
    // resolution suffix to be part of the model name, e.g.
    // doubao-seedance-1-5-pro_1080p.
    const resolution = body.resolution || "1080p";
    const fallbackModel = resolution === "720p"
      ? "doubao-seedance-1-5-pro_720p"
      : "doubao-seedance-1-5-pro_1080p";
    const actualModel =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : fallbackModel;
    const canAttachReferenceImage = videoModelSupportsDirectReferenceImage(actualModel);

    if (usesJimengArkTasksApi) {
      const aspectRatioMap: Record<string, string> = {
        "16:9": "16:9",
        "9:16": "9:16",
        "1:1": "1:1",
        "4:3": "4:3",
        "3:4": "3:4",
      };

      const arkContent: Array<Record<string, unknown>> = [
        { type: "text", text: body.prompt },
      ];

      if (canAttachReferenceImage && body.imageUrl && typeof body.imageUrl === "string") {
        const refImageUrl = await normalizeArkReferenceImageUrl(body.imageUrl as string);
        if (!refImageUrl) {
          throw new Error("Ark 图生视频参考图不可用，无法读取为可提交的 URL 或 data URL。");
        }
        arkContent.push({
          type: "image_url",
          image_url: { url: refImageUrl },
          role: "first_frame",
        });
      }

      const payload = {
        model: resolveConfiguredModelName(actualModel),
        content: arkContent,
        resolution,
        duration: Math.max(4, Math.min(12, Number(body.duration) || 4)),
        ratio: aspectRatioMap[body.aspectRatio] || "16:9",
        watermark: false,
      };

      const res = await videoHttp(
        jimengVideoTasksBaseUrl,
        {
          "Content-Type": "application/json",
        },
        JSON.stringify(payload),
        undefined,
        "jimeng",
      );
      if (!res.ok) {
        const detail = await readVideoApiErrorDetail(res);
        throw new Error(
          formatVideoApiError("Ark 视频生成任务创建失败", res.status, detail, {
            provider: "ark",
            endpointId: payload.model,
          }),
        );
      }
      const data = await safeParseVideoResponse(res, "Ark 创建任务");
      console.log(`[video] 提交成功 provider=ark task_id=${data.id || data.task_id} status=${data.status}`);
      return {
        task_id: data.id || data.task_id,
        status: data.status || "queued",
        progress: data.progress,
        provider: "jimeng",
      };
    }

    // Build multipart/form-data as the API requires
    const textFields: Record<string, string> = {
      model: resolveConfiguredModelName(actualModel),
      prompt: body.prompt,
      size: body.aspectRatio || "16:9",
    };

    // Prepare image binary data if available
    let imageBlob: Blob | null = null;
    let imageMimeType = "image/jpeg";

    if (canAttachReferenceImage && body.imageUrl && typeof body.imageUrl === "string") {
      let imageDataUri: string | null = null;
      if (body.imageUrl.startsWith("data:")) {
        imageDataUri = body.imageUrl;
      } else {
        const fetched = await fetchImageAsBase64(body.imageUrl);
        if (fetched) {
          imageDataUri = `data:${fetched.mimeType};base64,${fetched.data}`;
        }
      }
      if (imageDataUri) {
        // Compress using configurable parameters from settings
        const cfg = getApiConfig();
        const maxBytes = (cfg.firstFrameMaxKB || 1024) * 1024;
        const maxDim = cfg.firstFrameMaxDim || 2048;
        try {
          imageDataUri = await compressImage(imageDataUri, maxBytes, {
            maxDim,
            minQuality: 0.3,
          });
        } catch (e) {
          // 图片压缩失败，使用原图
        }
        // Convert data URI to binary Blob
        const match = imageDataUri.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          imageMimeType = match[1];
          const binaryStr = atob(match[2]);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++)
            bytes[i] = binaryStr.charCodeAt(i);
          imageBlob = new Blob([bytes], { type: imageMimeType });
        }
      }
    }

    // Build proper multipart/form-data using FormData for binary file support
    const formData = new FormData();
    for (const [key, value] of Object.entries(textFields)) {
      formData.append(key, value);
    }
    if (imageBlob) {
      const ext = imageMimeType === "image/png" ? "png" : "jpeg";
      formData.append("input_reference", imageBlob, `frame.${ext}`);
    }

    const targetUrl = seedanceVideoTasksBaseUrl;

    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resolveDirectApiKey("jimeng")}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`视频生成任务创建失败 (${res.status}): ${errText}`);
    }
    const data = await safeParseVideoResponse(res, "Seedance 创建任务");
    console.log(`[video] 提交成功 provider=seedance task_id=${data.id} status=${data.status}`);
    return {
      task_id: data.id,
      status: data.status,
      progress: data.progress,
      provider: "jimeng",
    };
  }
}

async function localEnhancePrompt(body: any) {
  const {
    description,
    sceneName,
    characters,
    dialogue,
    prevDescription,
    nextDescription,
    hasRefImage,
  } = body;
  if (!description) throw new Error("缺少分镜描述");

  const promptParts: string[] = [];
  if (sceneName) promptParts.push(`【场景】${sceneName}`);
  if (characters?.length)
    promptParts.push(
      `【人物】${characters.join("、")}（共${characters.length}人）`,
    );
  if (prevDescription) promptParts.push(`【上一个分镜】${prevDescription}`);
  promptParts.push(`【当前分镜描述】${description}`);
  if (nextDescription) promptParts.push(`【下一个分镜】${nextDescription}`);
  if (dialogue) promptParts.push(`【对白】${dialogue}（${dialogue.length}字）`);
  if (hasRefImage)
    promptParts.push(`（注意：此分镜已有参考图，重点描述动态变化和运动过程）`);

  const userPrompt = promptParts.join("\n");

  const data = await callGemini("gemini-3-flash-preview", [
    { role: "user", parts: [{ text: `${ENHANCE_PROMPT}\n\n${userPrompt}` }] },
  ]);

  const rawText = extractText(data);
  let enhanced = description;
  let duration = 5;
  let durationReason = "";

  try {
    const cleaned = rawText
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.enhanced) enhanced = parsed.enhanced;
    if (
      typeof parsed.duration === "number" &&
      parsed.duration >= 4 &&
      parsed.duration <= 8
    )
      duration = Math.round(parsed.duration);
    if (parsed.durationReason) durationReason = parsed.durationReason;
  } catch {
    enhanced = rawText || description;
  }

  const finalPrompt =
    enhanced.length > 2500 ? enhanced.substring(0, 2500) : enhanced;
  return { enhanced: finalPrompt, duration, durationReason };
}

async function localEnhancePromptV2(body: any) {
  const {
    description,
    sceneName,
    characters,
    dialogue,
    prevDescription,
    nextDescription,
    hasRefImage,
    cameraDirection,
    style,
    characterDescriptions,
    sceneDescription,
    referenceImageUrl,
    characterImages,
    // segment 模式字段
    mode,
    shots,
    segmentLabel,
    targetDuration,
    maxDuration,
    visualStyle,
    tone,
    sceneImages,
    sceneDescriptions,
    continuityRules,
    previousSegmentSummary,
    nextSegmentSummary,
    previousSegmentPrompt,
  } = body;

  // transition-decision 模式：AI 决定 xfade 转场类型
  if (mode === "transition-decision") {
    const rawPrompt = typeof body._rawPrompt === "string" ? body._rawPrompt : "";
    if (!rawPrompt) throw new Error("transition-decision 模式缺少 _rawPrompt");

    const parts = [{ text: rawPrompt }];
    const result = await callGemini("gemini-3-flash-preview", [{ role: "user", parts }]);
    const rawText = extractText(result);
    try {
      const cleaned = rawText.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { transitions: [] };
    }
  }

  // segment 模式：多分镜合并提示词
  if (mode === "segment") {
    if (!Array.isArray(shots) || !shots.length) {
      throw new Error("segment 模式缺少 shots 数组");
    }

    const promptParts: string[] = [];
    if (segmentLabel) promptParts.push(`[片段编号] ${segmentLabel}`);
    if (visualStyle) promptParts.push(`[视觉风格] ${visualStyle}`);
    if (tone) promptParts.push(`[情绪基调] ${tone}`);
    if (style) promptParts.push(`[艺术风格] ${style}`);
    if (targetDuration) promptParts.push(`[目标时长] ${targetDuration}秒（模型最大支持 ${maxDuration ?? targetDuration}秒）`);

    if (Array.isArray(characterDescriptions) && characterDescriptions.length) {
      promptParts.push(
        `[角色设定]\n${characterDescriptions.map((c: any) => `- ${c.name}：${c.description}`).join("\n")}`,
      );
    }

    if (Array.isArray(sceneDescriptions) && sceneDescriptions.length) {
      promptParts.push(
        `[场景设定]\n${sceneDescriptions.map((s: any) => `- ${s.name}：${s.description}`).join("\n")}`,
      );
    }

    if (continuityRules) {
      promptParts.push(`[连贯性要求] ${continuityRules}`);
    }

    if (previousSegmentSummary) {
      promptParts.push(`[上一片段摘要]\n${previousSegmentSummary}`);
    }

    if (previousSegmentPrompt) {
      promptParts.push(`[上一片段结尾状态]\n只承接上一片段结尾的动作结果、角色站位、视线方向、镜头轴线和情绪状态，不要复述上一片段完整剧情。\n${previousSegmentPrompt}`);
    }

    if (nextSegmentSummary) {
      promptParts.push(`[下一片段摘要]\n${nextSegmentSummary}`);
    }

    promptParts.push(`[未增强分镜处理规则]\n${SEGMENT_RAW_SHOT_ENHANCE_RULES}`);

    const shotLines = (shots as any[]).map((shot) => {
      const sourceLabel = shot.promptSource === "enhanced"
        ? "已生成单镜头提示词，优先复用"
        : "未生成单镜头提示词，按 ENHANCE_PROMPT 规则在片段内扩写";
      return [
        `分镜${shot.index}（${shot.duration}秒，${sourceLabel}）：${shot.prompt}`,
        shot.rawDescription && shot.rawDescription !== shot.prompt ? `【原始分镜】${shot.rawDescription}` : "",
        shot.prevDescription ? `【上一个分镜】${shot.prevDescription}` : "",
        shot.nextDescription ? `【下一个分镜】${shot.nextDescription}` : "",
        shot.cameraDirection ? `【镜头：${shot.cameraDirection}】` : "",
        shot.dialogue ? `【台词：${shot.dialogue}】` : "",
      ].filter(Boolean).join("");
    });
    promptParts.push(`[分镜列表]\n${shotLines.join("\n")}`);

    if (hasRefImage || referenceImageUrl) {
      promptParts.push(
        "若附有场景参考图，请分析图中的环境构图、光线色调、空间氛围，并将这些视觉细节融入提示词中，确保生成视频与参考图的场景风格保持一致。",
      );
    }
    if (Array.isArray(characterImages) && characterImages.length) {
      promptParts.push(
        "若附有角色参考图，请仔细分析每位角色的面部特征、发型发色、肤色、服装款式与颜色，并将这些视觉细节精确融入提示词中，确保所有分镜中该角色的外貌完全一致。",
      );
    }
    if (Array.isArray(sceneImages) && sceneImages.length) {
      promptParts.push(
        "若附有多张场景参考图，请综合分析各图的视觉风格，确保提示词中的场景描述与参考图保持一致。",
      );
    }

    promptParts.push(
      [
        "[最终提交版要求]",
        "只输出一份可直接交给视频生成模型执行的片段 prompt，不要输出分析过程、不要重复输入清单、不要堆叠无效风格词。",
        "prompt 开头必须明确承接上一片段结尾状态；结尾必须留下可被下一片段承接的角色位置、动作方向、视线方向或情绪钩子。",
        "优先写清楚每个分镜的机位、景别、角色站位、动作方向、视线方向、切点和时间段；少写泛泛的电影感形容词。",
        "总长度控制在 1200-1800 个中文字符以内；如果信息过多，压缩环境形容和重复风格，不要压缩剧情动作、台词和衔接状态。",
      ].join("\n"),
    );

    const userPrompt = promptParts.join("\n\n");
    const segParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
      { text: `${SEGMENT_ENHANCE_PROMPT}\n\n${userPrompt}` },
    ];
    await appendReferenceInlineData(segParts, referenceImageUrl);
    if (Array.isArray(characterImages)) {
      for (const charImg of characterImages) {
        if (charImg?.imageUrl) await appendReferenceInlineData(segParts, charImg.imageUrl);
      }
    }
    if (Array.isArray(sceneImages)) {
      for (const sceneImg of sceneImages) {
        if (sceneImg?.imageUrl) await appendReferenceInlineData(segParts, sceneImg.imageUrl);
      }
    }

    const segData = await callGemini("gemini-3-flash-preview", [{ role: "user", parts: segParts }]);
    const segRawText = extractText(segData);
    let segPrompt = (shots as any[]).map((s) => s.prompt).join(" ");
    let segDuration: number = typeof targetDuration === "number" ? targetDuration : 15;

    try {
      const cleaned = segRawText.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.prompt) segPrompt = parsed.prompt;
      if (typeof parsed.duration === "number" && parsed.duration >= 4) {
        segDuration = Math.min(Math.round(parsed.duration), typeof maxDuration === "number" ? maxDuration : 15);
      }
    } catch {
      segPrompt = segRawText || segPrompt;
    }

    const finalSegPrompt = segPrompt.length > 2200 ? segPrompt.substring(0, 2200) : segPrompt;
    return { prompt: finalSegPrompt, duration: segDuration };
  }

  if (!description) throw new Error("Missing storyboard description");

  const promptParts: string[] = [];
  if (sceneName) promptParts.push(`[Scene] ${sceneName}`);
  if (Array.isArray(characters) && characters.length) {
    promptParts.push(`[Characters] ${characters.join(", ")}`);
  }
  if (sceneDescription) promptParts.push(`[Environment] ${sceneDescription}`);
  if (cameraDirection) promptParts.push(`[Camera] ${cameraDirection}`);
  if (style) promptParts.push(`[Style] ${style}`);
  if (Array.isArray(characterDescriptions) && characterDescriptions.length) {
    promptParts.push(`[Character Details] ${characterDescriptions.map((c: any) => `${c.name}: ${c.description}`).join(" | ")}`);
  }
  if (prevDescription) promptParts.push(`[Previous Shot] ${prevDescription}`);
  promptParts.push(`[Current Shot] ${description}`);
  if (nextDescription) promptParts.push(`[Next Shot] ${nextDescription}`);
  if (dialogue) promptParts.push(`[Dialogue] ${dialogue}`);
  if (hasRefImage || referenceImageUrl) {
    promptParts.push(
      "If a storyboard image is attached, analyze the visible composition, subjects, lighting, mood, and implied motion first, then convert that visual plan into a dynamic text-to-video prompt. Keep the final prompt text-only and do not mention the image file itself.",
    );
  }
  if (Array.isArray(characterImages) && characterImages.length) {
    promptParts.push(
      "If character reference images are attached, analyze each character's appearance (face, hair, clothing, build) and incorporate those visual details into the prompt description for that character.",
    );
  }

  const userPrompt = promptParts.join("\n");
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: `${ENHANCE_PROMPT}\n\n${userPrompt}` },
  ];
  await appendReferenceInlineData(parts, referenceImageUrl);
  if (Array.isArray(characterImages)) {
    for (const charImg of characterImages) {
      if (charImg?.imageUrl) {
        await appendReferenceInlineData(parts, charImg.imageUrl);
      }
    }
  }

  const data = await callGemini("gemini-3-flash-preview", [{ role: "user", parts }]);
  const rawText = extractText(data);
  let enhanced = description;
  let duration = 5;
  let durationReason = "";

  try {
    const cleaned = rawText
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.enhanced) enhanced = parsed.enhanced;
    if (typeof parsed.duration === "number" && parsed.duration >= 4 && parsed.duration <= 15) {
      duration = Math.round(parsed.duration);
    }
    if (parsed.durationReason) durationReason = parsed.durationReason;
  } catch {
    enhanced = rawText || description;
  }

  const finalPrompt = enhanced.length > 2500 ? enhanced.substring(0, 2500) : enhanced;
  return { enhanced: finalPrompt, duration, durationReason };
}

async function localCharDesc(body: any, onStreamText?: (text: string) => void) {
  const {
    characterName,
    script,
    costumes,
    discoverCostumes,
    segmentLabels,
    model: requestedModel,
  } = body;
  if (!characterName || !script) throw new Error("缺少角色名称或剧本内容");

  const hasCostumes = Array.isArray(costumes) && costumes.length > 0;
  // discoverCostumes: when true and no costumes exist, ask AI to also discover costume variants
  const shouldDiscover = discoverCostumes && !hasCostumes;

  const systemPrompt = shouldDiscover
    ? `You are a professional film character designer. Based on the script and character name:
1. Produce a brief base character description (gender, age, build, facial features, hairstyle, skin tone — NO clothing).
2. Analyze the script and identify ALL distinct costume/outfit variants this character wears throughout the story.
   - Only include variants if the character clearly has 2 or more distinct outfits/looks in the script.
   - Each variant needs a short label (e.g. "校服", "晚礼服", "休闲装") and a detailed description.
   - If the character only has one outfit or no clear outfit changes, return an empty array for discoveredCostumes.
3. If segmentLabels are provided, assign the correct costume label to each listed segment where this character appears.
   - Use ONLY the provided segment labels.
   - Return segmentCostumeAssignments with {segmentLabel, costumeLabel}.
   - Omit uncertain segments rather than guessing.

${ETHNICITY_RULE}

### Layout Constraints
- Character Design Sheet with multiple angles (front, side, back) and face close-up.
- NO text labels. Pure white background. Neutral expression, upright standing pose.

### Output Format
Return JSON: {"description": "base description", "discoveredCostumes": [{"label": "outfit name", "description": "detailed outfit description"}], "segmentCostumeAssignments": [{"segmentLabel": "1-1-1", "costumeLabel": "outfit name"}]}
Return ONLY valid JSON.`
    : hasCostumes
      ? `You are a professional film character designer. Based on the script and character name, produce:
1. A brief base character description (gender, age, build, facial features, hairstyle, skin tone — NO clothing).
2. For EACH costume variant, produce a detailed AI-ready appearance description for a character design sheet.
3. If segmentLabels are provided, assign the correct costume label to each listed segment where this character appears.
   - Use ONLY labels from the provided Costumes list.
   - Return segmentCostumeAssignments with {segmentLabel, costumeLabel}.
   - Omit uncertain segments rather than guessing.

${ETHNICITY_RULE}

### Layout Constraints
- Character Design Sheet with multiple angles (front, side, back) and face close-up.
- NO text labels. Pure white background. Neutral expression, upright standing pose.

### Output Format
Return JSON: {"description": "base description", "costumeDescriptions": [{"label": "...", "description": "..."}], "segmentCostumeAssignments": [{"segmentLabel": "1-1-1", "costumeLabel": "..."}]}
Return ONLY valid JSON.`
      : `You are a professional film character designer. Based on the script and character name, produce a detailed AI-ready appearance description for a character design sheet.

${ETHNICITY_RULE}

### Layout Constraints
- Character Design Sheet with multiple angles (front, side, back) and face close-up.
- NO text labels. Pure white background. Neutral expression.

### Output Format
Return ONLY plain text character description. NO JSON, NO code blocks.`;

  const userContent = hasCostumes
    ? `Script:\n${script}\n\nCharacter: "${characterName}"\nCostumes: ${JSON.stringify(costumes)}${Array.isArray(segmentLabels) && segmentLabels.length > 0 ? `\nSegments: ${JSON.stringify(segmentLabels)}` : ""}`
    : shouldDiscover
      ? `Script:\n${script}\n\nCharacter: "${characterName}"\nAnalyze the script and discover all distinct costume/outfit variants for this character.${Array.isArray(segmentLabels) && segmentLabels.length > 0 ? `\nSegments: ${JSON.stringify(segmentLabels)}` : ""}`
      : `Script:\n${script}\n\nGenerate appearance description for "${characterName}".`;

  const useModel = requestedModel || "gemini-3-pro-preview";
  const isThinking = useModel.toLowerCase().includes("thinking");
  const generationConfig: any = {
    ...(hasCostumes || shouldDiscover
      ? { responseMimeType: "application/json" }
      : {}),
    ...(isThinking ? { thinkingConfig: { thinkingBudget: 2048 } } : {}),
  };

  let rawText: string;
  if (onStreamText) {
    const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
    rawText = await callGeminiStream(
      useModel,
      [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userContent}` }],
        },
      ],
      forwardStreamDelta,
      generationConfig,
    );
  } else {
    const data = await callGemini(
      useModel,
      [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userContent}` }],
        },
      ],
      generationConfig,
    );
    rawText = extractText(data);
  }

  if (hasCostumes || shouldDiscover) {
    const parsed = parseJsonResponseLoose<{
      description?: string;
      costumeDescriptions?: any[];
      discoveredCostumes?: any[];
      segmentCostumeAssignments?: any[];
    }>(rawText);
    if (parsed) {
      return {
        description: parsed.description || "",
        costumeDescriptions: parsed.costumeDescriptions || [],
        discoveredCostumes: parsed.discoveredCostumes || [],
        segmentCostumeAssignments: parsed.segmentCostumeAssignments || [],
      };
    }
    return { description: rawText };
  }
  return { description: rawText };
}

async function localSceneDesc(
  body: any,
  onStreamText?: (text: string) => void,
) {
  const {
    sceneName,
    script,
    discoverTimeVariants,
    segmentLabels,
    model: requestedModel,
  } = body;
  if (!sceneName || !script) throw new Error("缺少场景名称或剧本内容");

  const shouldDiscover = !!discoverTimeVariants;

  const systemPrompt = shouldDiscover
    ? `You are a professional film production designer. Based on the script and scene name:
1. Produce a detailed environment description for AI image generation — a grand Panoramic View scene concept.
2. Analyze the script and identify ALL distinct time/environment variants this scene appears in (e.g. "黄昏", "夜间", "雨天", "清晨").
   - Only include variants if the scene clearly appears in 2 or more distinct time/weather conditions in the script.
   - Each variant needs a short label and a description of how the environment changes.
   - If the scene only appears in one condition, return an empty array for discoveredTimeVariants.
3. If segmentLabels are provided, assign the correct time/environment variant label to each listed segment where this scene appears.
   - Use ONLY the provided segment labels.
   - Return segmentTimeAssignments with {segmentLabel, timeVariantLabel}.
   - Omit uncertain segments rather than guessing.

### Core Principles
1. Panoramic perspective with depth and grandeur.
2. Pure environment — NO active characters. Static scene elements only.
3. Infer details from context: era, genre, geography, season, time of day.

### Required Elements
- Perspective & composition, spatial layout, architectural style
- Lighting, mood & color palette, time of day & weather
- Key props, ground/surface materials

### Output Format
Return JSON: {"description": "base environment description", "discoveredTimeVariants": [{"label": "variant name", "description": "how environment changes"}], "segmentTimeAssignments": [{"segmentLabel": "1-1-1", "timeVariantLabel": "variant name"}]}
Return ONLY valid JSON.`
    : `You are a professional film production designer. Based on the script and scene name, produce a detailed environment description for AI image generation — a grand Panoramic View scene concept.

### Core Principles
1. Panoramic perspective with depth and grandeur.
2. Pure environment — NO active characters. Static scene elements only.
3. Infer details from context: era, genre, geography, season, time of day.

### Required Elements
- Perspective & composition, spatial layout, architectural style
- Lighting, mood & color palette, time of day & weather
- Key props, ground/surface materials

### Output Format
Return ONLY plain text description in English. NO JSON.`;

  const userContent = shouldDiscover
    ? `Script:\n${script}\n\nScene: "${sceneName}"\nAnalyze the script and discover all distinct time/environment variants for this scene.${Array.isArray(segmentLabels) && segmentLabels.length > 0 ? `\nSegments: ${JSON.stringify(segmentLabels)}` : ""}`
    : `Script:\n${script}\n\nGenerate environment description for scene "${sceneName}".`;

  const useModel = requestedModel || "gemini-3-pro-preview";
  const isThinking = useModel.toLowerCase().includes("thinking");
  const generationConfig: any = {
    ...(shouldDiscover ? { responseMimeType: "application/json" } : {}),
    ...(isThinking ? { thinkingConfig: { thinkingBudget: 2048 } } : {}),
  };

  let rawText: string;
  if (onStreamText) {
    const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
    rawText = await callGeminiStream(
      useModel,
      [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userContent}` }],
        },
      ],
      forwardStreamDelta,
      generationConfig,
    );
  } else {
    const data = await callGemini(
      useModel,
      [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\n${userContent}` }],
        },
      ],
      generationConfig,
    );
    rawText = extractText(data);
  }

  if (shouldDiscover) {
    const parsed = parseJsonResponseLoose<{
      description?: string;
      discoveredTimeVariants?: any[];
      segmentTimeAssignments?: any[];
    }>(rawText);
    if (parsed) {
      return {
        description: parsed.description || "",
        discoveredTimeVariants: parsed.discoveredTimeVariants || [],
        segmentTimeAssignments: parsed.segmentTimeAssignments || [],
      };
    }
    return { description: rawText };
  }
  return { description: rawText };
}
