/**
 * 函数调用封装
 * 直接调用各服务 API，使用设置中配置的 API Key
 */
import {
  getApiConfig,
  resolveConfiguredModelName,
  resolveConfiguredModelNameFromConfig,
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
import { hasUsableApiCredential, isServerProxyEndpoint } from "@/lib/server-proxy";
import {
  DEFAULT_DECOMPOSE_MODEL,
  readStoredDecomposeModel,
} from "@/lib/gemini-text-models";
import {
  readStoredHomeAgentTextModelKey,
  resolveHomeAgentTextModelRuntime,
} from "@/lib/home-agent/text-models";
import {
  resolveVideoImageAspectRatioForViewMode,
  resolveVideoImageRequestPrefs,
} from "@/lib/home-agent/image-models";
import {
  getVideoModelMaxDuration,
  getVideoModelMinDuration,
  normalizeHomeAgentVideoModelKey,
  SEEDANCE_2_0_FAST_MODEL_KEY,
  SEEDANCE_2_0_MODEL_KEY,
  videoModelRequiresRunningHubTransport,
  videoModelSupportsRunningHubFallback,
  videoModelSupportsDirectReferenceImage,
  videoModelSupportsMultiReferenceImages,
} from "@/lib/home-agent/video-models";
import { compressImage } from "@/lib/image-compress";
import { createAccumulatedTextDeltaForwarder } from "@/lib/streaming-delta";

const TUZI_BASE_URL = "https://api.tuziapi.com";
const ALIYUN_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com";
const ALIYUN_VIDEO_SYNTHESIS_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const ALIYUN_VIDEO_TASKS_PATH = "/api/v1/tasks";
const RUNNINGHUB_BASE_URL = "https://www.runninghub.cn";
const RUNNINGHUB_QUERY_PATH = "/openapi/v2/query";
const RUNNINGHUB_UPLOAD_PATH = "/openapi/v2/media/upload/binary";
const HAPPYHORSE_VISIBLE_MODEL = "happyhorse-1.0";
const HAPPYHORSE_TEXT_MODEL = "happyhorse-1.0-t2v";
const HAPPYHORSE_IMAGE_MODEL = "happyhorse-1.0-i2v";
const HAPPYHORSE_REFERENCE_MODEL = "happyhorse-1.0-r2v";
const RUNNINGHUB_SEEDANCE_PROVIDER = "runninghub-seedance";
const RUNNINGHUB_SEEDANCE_FAST_PROVIDER = "runninghub-seedance-fast";
const RUNNINGHUB_HAPPYHORSE_PROVIDER = "runninghub-happyhorse";

type RunningHubVideoProvider =
  | typeof RUNNINGHUB_SEEDANCE_PROVIDER
  | typeof RUNNINGHUB_SEEDANCE_FAST_PROVIDER
  | typeof RUNNINGHUB_HAPPYHORSE_PROVIDER;

/** 剧本识别（阶段一）单次请求上限 */
const SCRIPT_EXTRACT_TIMEOUT_MS = 20 * 60_000;
const EXTRACTED_VARIANT_QA_TIMEOUT_MS = 90_000;
/** 剧本拆解（阶段二）每块 / 整本单次请求上限 */
const SCRIPT_DECOMPOSE_TIMEOUT_MS = 20 * 60_000;
/** 剧本拆解的内部自愈重试下限，独立于网络重试设置。 */
const DECOMPOSE_MAX_TOTAL_ATTEMPTS = 3;
const DECOMPOSE_MAX_SELF_HEAL_RETRIES = DECOMPOSE_MAX_TOTAL_ATTEMPTS - 1;
const DECOMPOSE_JSON_FORMAT_MAX_TOTAL_ATTEMPTS = 3;
const DECOMPOSE_JSON_FORMAT_SELF_HEAL_RETRIES =
  DECOMPOSE_JSON_FORMAT_MAX_TOTAL_ATTEMPTS - 1;
const LEGACY_DECOMPOSE_MAX_PARALLEL = 3;
const MIN_DECOMPOSE_RETRY_DELAY_MS = 150;
const MAX_DECOMPOSE_RETRY_DELAY_MS = 1200;
const DEFAULT_DECOMPOSE_PARALLEL_EPISODES = 3;
const MAX_DECOMPOSE_PARALLEL_REAL_EPISODES = 6;
const MAX_DECOMPOSE_PARALLEL_LENGTH_SPLITS = 4;
const DEFAULT_DECOMPOSE_SINGLE_PASS = true;
const DEFAULT_DECOMPOSE_PRESERVE_EPISODE_INTEGRITY = true;
const DECOMPOSE_MIN_OUTPUT_TOKENS = 4096;
const DECOMPOSE_MAX_OUTPUT_TOKENS = 24576;
const DECOMPOSE_ESTIMATED_TOKENS_PER_SEGMENT = 1900;
const DECOMPOSE_MEDIUM_CHUNK_OUTPUT_BONUS = 1536;
const DECOMPOSE_LARGE_CHUNK_OUTPUT_BONUS = 3072;
const DECOMPOSE_SINGLE_PASS_SPLIT_OUTPUT_THRESHOLD = DECOMPOSE_MAX_OUTPUT_TOKENS - 2048;
const DECOMPOSE_SINGLE_PASS_EXTRA_SEGMENT_BUDGET = 2;
const DECOMPOSE_SERIALIZATION_GUARD = [
  "【JSON 序列化硬规则】",
  '只返回合法 JSON，对外层结构固定使用 {"scenes":[...]}。',
  '不要输出 markdown 代码块、解释文字、注释或省略号。',
  '任意字符串字段里如果必须出现半角双引号，必须写成 \\"；更推荐直接改用中文引号。',
  "不要输出尾逗号；多条对白请用 \\n 分隔，不要把提示说明写进 JSON。",
].join("\n");
const DECOMPOSE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["scenes"],
  properties: {
    scenes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: [
          "sceneNumber",
          "segmentLabel",
          "sceneName",
          "description",
          "characters",
          "dialogue",
          "cameraDirection",
          "duration",
        ],
        properties: {
          sceneNumber: { type: "INTEGER" },
          segmentLabel: { type: "STRING" },
          sceneName: { type: "STRING" },
          description: { type: "STRING" },
          characters: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          dialogue: { type: "STRING" },
          cameraDirection: { type: "STRING" },
          duration: { type: "INTEGER" },
          characterCostumes: { type: "OBJECT" },
          sceneTimeVariantId: { type: "STRING" },
        },
      },
    },
  },
} as const;

function estimateDecomposeOutputTokens(params?: {
  segmentsTarget?: number | null;
  averageChunkChars?: number | null;
}) {
  const segmentsTarget = Math.max(1, Math.round(params?.segmentsTarget || 1));
  const averageChunkChars = Math.max(0, Math.round(params?.averageChunkChars || 0));
  return (
    segmentsTarget * DECOMPOSE_ESTIMATED_TOKENS_PER_SEGMENT +
    (averageChunkChars >= 9000
      ? DECOMPOSE_LARGE_CHUNK_OUTPUT_BONUS
      : averageChunkChars >= 6000
        ? DECOMPOSE_MEDIUM_CHUNK_OUTPUT_BONUS
        : 0)
  );
}

function buildDecomposeGenerationConfig(params?: {
  segmentsTarget?: number | null;
  averageChunkChars?: number | null;
  retryAttempt?: number | null;
}) {
  const retryAttempt = Math.max(0, Math.round(params?.retryAttempt || 0));
  const estimatedTokens = estimateDecomposeOutputTokens(params);
  const maxOutputTokens = Math.max(
    DECOMPOSE_MIN_OUTPUT_TOKENS,
    Math.min(DECOMPOSE_MAX_OUTPUT_TOKENS, estimatedTokens),
  );
  return {
    temperature: retryAttempt > 0 ? 0.05 : 0.1,
    topP: 0.3,
    maxOutputTokens,
    responseMimeType: "application/json",
    responseSchema: DECOMPOSE_RESPONSE_SCHEMA,
  } as const;
}

export function resolveDecomposeRetryDelayMs(networkDelayMs: number): number {
  const normalizedDelay = Number.isFinite(networkDelayMs) ? Math.floor(networkDelayMs) : 800;
  return Math.min(
    MAX_DECOMPOSE_RETRY_DELAY_MS,
    Math.max(MIN_DECOMPOSE_RETRY_DELAY_MS, Math.floor(normalizedDelay * 0.5)),
  );
}

export function resolveDecomposeParallelism(params: {
  totalChunks: number;
  targetChunks?: number;
  isRealEpisodes: boolean;
  averageChunkChars?: number;
}): number {
  const totalChunks = Math.max(0, Math.floor(params.totalChunks || 0));
  const targetChunks = Math.max(0, Math.floor(params.targetChunks ?? totalChunks));
  if (totalChunks <= 1 || targetChunks <= 1) return 1;

  const hardCap = params.isRealEpisodes
    ? MAX_DECOMPOSE_PARALLEL_REAL_EPISODES
    : MAX_DECOMPOSE_PARALLEL_LENGTH_SPLITS;
  const averageChunkChars = Math.max(0, Math.floor(params.averageChunkChars || 0));
  const sizeSoftCap =
    averageChunkChars >= 9000 ? 3 : averageChunkChars >= 6000 ? 4 : hardCap;
  const densityBoost = targetChunks >= 10 ? 2 : targetChunks >= 6 ? 1 : 0;
  const preferredParallelism = DEFAULT_DECOMPOSE_PARALLEL_EPISODES + 1 + densityBoost;

  return Math.max(
    2,
    Math.min(targetChunks, hardCap, sizeSoftCap, preferredParallelism),
  );
}

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

function normalizeAliyunVideoSynthesisUrl(raw: string | undefined): string {
  const fallback = `${ALIYUN_DASHSCOPE_BASE_URL}${ALIYUN_VIDEO_SYNTHESIS_PATH}`;
  const trimmed = trimApiBase(raw, fallback);
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (pathname.endsWith(ALIYUN_VIDEO_SYNTHESIS_PATH)) {
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    }
    if (pathname.endsWith("/api/v1/services/aigc/video-generation")) {
      parsed.pathname = `${pathname}/video-synthesis`;
    } else if (pathname.endsWith("/api/v1")) {
      parsed.pathname = `${pathname}/services/aigc/video-generation/video-synthesis`;
    } else if (!pathname || pathname === "/") {
      parsed.pathname = ALIYUN_VIDEO_SYNTHESIS_PATH;
    } else {
      parsed.pathname = `${pathname}${ALIYUN_VIDEO_SYNTHESIS_PATH}`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.endsWith("/video-synthesis")
      ? trimmed
      : `${trimmed}${ALIYUN_VIDEO_SYNTHESIS_PATH}`;
  }
}

function getAliyunVideoSynthesisUrl(config = getApiConfig()): string {
  return normalizeAliyunVideoSynthesisUrl(config.aliyunEndpoint);
}

function getAliyunVideoTasksBaseUrl(config = getApiConfig()): string {
  try {
    const parsed = new URL(getAliyunVideoSynthesisUrl(config));
    parsed.pathname = ALIYUN_VIDEO_TASKS_PATH;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return `${ALIYUN_DASHSCOPE_BASE_URL}${ALIYUN_VIDEO_TASKS_PATH}`;
  }
}

function normalizeRunningHubBaseUrl(raw: string | undefined): string {
  const trimmed = trimApiBase(raw, RUNNINGHUB_BASE_URL);
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

function getRunningHubBaseUrl(config = getApiConfig()): string {
  return normalizeRunningHubBaseUrl(config.runninghubEndpoint);
}

function getRunningHubQueryUrl(config = getApiConfig()): string {
  return `${getRunningHubBaseUrl(config)}${RUNNINGHUB_QUERY_PATH}`;
}

function getRunningHubUploadUrl(config = getApiConfig()): string {
  return `${getRunningHubBaseUrl(config)}${RUNNINGHUB_UPLOAD_PATH}`;
}

function hasUsableRunningHubApiCredential(config = getApiConfig()): boolean {
  return hasUsableApiCredential(config.runninghubEndpoint, config.runninghubKey);
}

function buildServiceAuthorizationHeaders(
  url: string,
  headers: Record<string, string>,
  service: "runninghub",
): Record<string, string> {
  const authHeader = headers.Authorization ||
    headers.authorization ||
    (isServerProxyEndpoint(url) ? "" : `Bearer ${resolveDirectApiKey(service)}`);

  return authHeader ? { ...headers, Authorization: authHeader } : { ...headers };
}

async function serviceFetch(
  url: string,
  options: {
    body?: string | FormData;
    headers?: Record<string, string>;
    method?: "GET" | "POST";
    signal?: AbortSignal;
  },
  service: "runninghub",
): Promise<Response> {
  const mergedHeaders = buildServiceAuthorizationHeaders(url, options.headers || {}, service);
  const finalHeaders = options.body instanceof FormData
    ? Object.fromEntries(
        Object.entries(mergedHeaders).filter(([key]) => key.toLowerCase() !== "content-type"),
      )
    : mergedHeaders;

  return fetch(url, {
    method: options.method || (options.body instanceof FormData || options.body ? "POST" : "GET"),
    headers: finalHeaders,
    body: options.body,
    signal: options.signal,
  });
}

function isRunningHubVideoProvider(value: unknown): value is RunningHubVideoProvider {
  return (
    value === RUNNINGHUB_SEEDANCE_PROVIDER ||
    value === RUNNINGHUB_SEEDANCE_FAST_PROVIDER ||
    value === RUNNINGHUB_HAPPYHORSE_PROVIDER
  );
}

function resolveRunningHubProvider(
  model: string | undefined,
  provider?: string | null,
): RunningHubVideoProvider | null {
  if (isRunningHubVideoProvider(provider)) {
    return provider;
  }

  const normalizedModel = normalizeHomeAgentVideoModelKey(model);
  if (normalizedModel === SEEDANCE_2_0_MODEL_KEY) {
    return RUNNINGHUB_SEEDANCE_PROVIDER;
  }
  if (normalizedModel === SEEDANCE_2_0_FAST_MODEL_KEY) {
    return RUNNINGHUB_SEEDANCE_FAST_PROVIDER;
  }
  if (normalizedModel === HAPPYHORSE_VISIBLE_MODEL) {
    return RUNNINGHUB_HAPPYHORSE_PROVIDER;
  }
  return null;
}

function isJimengArkTasksEndpoint(value: string | undefined): boolean {
  return /\/contents\/generations\/tasks$/i.test(trimApiBase(value, ""));
}

type JimengVideoTransport = {
  contract: "ark" | "seedance";
  taskBaseUrl: string;
};

function resolveJimengVideoTransport(config = getApiConfig()): JimengVideoTransport {
  const configured = trimApiBase(config.jimengEndpoint || config.geminiEndpoint, "");
  if (!configured) {
    return {
      contract: "seedance",
      taskBaseUrl: getSeedanceVideoTasksBaseUrl(),
    };
  }

  if (isServerProxyEndpoint(configured)) {
    return {
      contract: "ark",
      taskBaseUrl: configured,
    };
  }

  if (isJimengArkTasksEndpoint(configured)) {
    return {
      contract: "ark",
      taskBaseUrl: configured,
    };
  }

  if (/\/api\/v3$/i.test(configured)) {
    return {
      contract: "ark",
      taskBaseUrl: `${configured}/contents/generations/tasks`,
    };
  }

  if (/ark\.cn-beijing\.volces\.com/i.test(configured)) {
    return {
      contract: "ark",
      taskBaseUrl: configured.includes("/api/v3/")
        ? configured
        : `${configured}/api/v3/contents/generations/tasks`,
    };
  }

  const normalizedBase = configured
    .replace(/\/v1beta(\/.*)?$/i, "")
    .replace(/\/v1(\/.*)?$/i, "")
    .replace(/\/$/, "");

  if (/api\.tu-zi\.com/i.test(normalizedBase)) {
    return {
      contract: "ark",
      taskBaseUrl: `${normalizedBase}/doubao/api/v3/contents/generations/tasks`,
    };
  }

  return {
    contract: "seedance",
    taskBaseUrl: `${normalizedBase}/v1/videos`,
  };
}

function resolveJimengSubmittedModelName(
  model: string,
  transport: JimengVideoTransport,
  config = getApiConfig(),
): string {
  if (transport.contract === "seedance") {
    return resolveConfiguredModelName(model);
  }

  const forcedArkConfig = {
    ...config,
    jimengEndpoint: isJimengArkTasksEndpoint(config.jimengEndpoint)
      ? config.jimengEndpoint
      : "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
  };
  return resolveConfiguredModelNameFromConfig(forcedArkConfig, model);
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

function extractVideoTaskLastFrameUrl(payload: any): string | undefined {
  const candidates = [
    payload?.last_frame_url,
    payload?.lastFrameUrl,
    payload?.content?.last_frame_url,
    payload?.content?.lastFrameUrl,
    payload?.data?.last_frame_url,
    payload?.data?.lastFrameUrl,
    payload?.output?.last_frame_url,
    payload?.output?.lastFrameUrl,
    Array.isArray(payload?.last_frames) ? payload.last_frames[0]?.url : undefined,
    Array.isArray(payload?.lastFrames) ? payload.lastFrames[0]?.url : undefined,
    Array.isArray(payload?.output?.images) ? payload.output.images[0]?.url : undefined,
    Array.isArray(payload?.data?.images) ? payload.data.images[0]?.url : undefined,
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

function isHappyHorseModel(value?: string | null): boolean {
  return String(value || "").trim().toLowerCase().startsWith(HAPPYHORSE_VISIBLE_MODEL);
}

function extractAliyunTaskId(payload: any): string {
  const candidates = [
    payload?.task_id,
    payload?.taskId,
    payload?.output?.task_id,
    payload?.output?.taskId,
    payload?.data?.task_id,
    payload?.data?.taskId,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ||
    ""
  );
}

function extractAliyunTaskState(payload: any): string {
  const candidates = [
    payload?.output?.task_status,
    payload?.output?.taskStatus,
    payload?.task_status,
    payload?.taskStatus,
    payload?.status,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ||
    ""
  );
}

function extractAliyunVideoUrl(payload: any): string | undefined {
  const candidates = [
    payload?.output?.video_url,
    payload?.output?.videoUrl,
    payload?.output?.result_url,
    payload?.output?.resultUrl,
    Array.isArray(payload?.output?.results) ? payload.output.results[0]?.url : undefined,
    Array.isArray(payload?.output?.video_urls) ? payload.output.video_urls[0] : undefined,
    extractVideoTaskVideoUrl(payload),
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function extractRunningHubTaskId(payload: any): string {
  return extractVideoTaskId(payload);
}

function pickFirstNonEmptyToken(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return "";
}

function extractVideoTaskId(payload: any): string {
  return pickFirstNonEmptyToken([
    payload?.task_id,
    payload?.taskId,
    payload?.id,
    payload?.content?.task_id,
    payload?.content?.taskId,
    payload?.content?.id,
    payload?.output?.task_id,
    payload?.output?.taskId,
    payload?.output?.id,
    payload?.data?.task_id,
    payload?.data?.taskId,
    payload?.data?.id,
  ]);
}

function extractRunningHubTaskState(payload: any): string {
  const candidates = [
    payload?.status,
    payload?.state,
    payload?.data?.status,
    payload?.data?.state,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ||
    ""
  );
}

function extractRunningHubFailureCode(payload: any): string {
  return pickFirstNonEmptyToken([
    payload?.errorCode,
    payload?.code,
    payload?.error?.code,
    payload?.data?.errorCode,
    payload?.data?.code,
    payload?.failedReason?.code,
  ]);
}

function extractRunningHubPromptTips(payload: any): string {
  return pickFirstNonEmptyToken([
    payload?.promptTips,
    payload?.prompt_tips,
    payload?.data?.promptTips,
    payload?.data?.prompt_tips,
  ]);
}

function extractAliyunPromptTips(payload: any): string {
  return pickFirstNonEmptyToken([
    payload?.promptTips,
    payload?.prompt_tips,
    payload?.output?.promptTips,
    payload?.output?.prompt_tips,
    payload?.data?.promptTips,
    payload?.data?.prompt_tips,
  ]);
}

function extractRunningHubFailureMessage(payload: any): string {
  const failedReason =
    payload?.failedReason && typeof payload.failedReason === "object"
      ? payload.failedReason
      : payload?.data?.failedReason && typeof payload.data.failedReason === "object"
        ? payload.data.failedReason
        : null;
  return pickFirstNonEmptyToken([
    payload?.errorMessage,
    payload?.message,
    payload?.msg,
    payload?.error?.message,
    payload?.data?.errorMessage,
    payload?.data?.message,
    payload?.data?.msg,
    failedReason?.message,
    failedReason?.reason,
    failedReason?.detail,
    extractRunningHubPromptTips(payload),
  ]);
}

function extractRunningHubVideoUrl(payload: any): string | undefined {
  const candidates = [
    Array.isArray(payload?.results) ? payload.results[0]?.url : undefined,
    Array.isArray(payload?.data?.results) ? payload.data.results[0]?.url : undefined,
    payload?.output?.url,
    payload?.data?.output?.url,
    extractVideoTaskVideoUrl(payload),
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function extractRunningHubLastFrameUrl(payload: any): string | undefined {
  const candidates = [
    Array.isArray(payload?.results) ? payload.results.find((item: any) => item?.type === "image")?.url : undefined,
    Array.isArray(payload?.data?.results)
      ? payload.data.results.find((item: any) => item?.type === "image")?.url
      : undefined,
    extractVideoTaskLastFrameUrl(payload),
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function shouldRetryViaRunningHubModerationFallback(
  status: number,
  detail: VideoApiErrorDetail,
  model: string,
  apiConfig: ReturnType<typeof getApiConfig>,
): boolean {
  if (!hasUsableRunningHubApiCredential(apiConfig)) return false;
  if (!videoModelSupportsRunningHubFallback(model)) return false;
  if (status < 400) return false;
  const normalized = [detail.code, detail.message, detail.rawText]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return (
    normalized.includes("inputimagesensitivecontentdetected") ||
    normalized.includes("privacyinformation") ||
    normalized.includes("sensitivecontent") ||
    normalized.includes("sensitive") ||
    normalized.includes("moderation") ||
    normalized.includes("content safety") ||
    normalized.includes("policy") ||
    normalized.includes("audit") ||
    normalized.includes("review") ||
    normalized.includes("compliance") ||
    normalized.includes("审核") ||
    normalized.includes("审查") ||
    normalized.includes("敏感") ||
    normalized.includes("违规") ||
    normalized.includes("合规") ||
    normalized.includes("隐私") ||
    normalized.includes("真人") ||
    normalized.includes("real person")
  );
}

async function submitRunningHubVideoTask(
  body: any,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
  options?: {
    provider?: RunningHubVideoProvider;
    reason?: string;
  },
) {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const provider = options?.provider || resolveRunningHubProvider(model, body.provider);
  if (!provider) {
    throw new Error("当前模型未匹配到可用 RunningHub 视频通道。");
  }
  if (!hasUsableRunningHubApiCredential(apiConfig)) {
    throw new Error("缺少可用 RunningHub API Key，无法发起兜底出片。");
  }

  const normalizedModel = normalizeHomeAgentVideoModelKey(model);
  const normalizedDuration = Math.max(
    getVideoModelMinDuration(normalizedModel),
    Math.min(
      getVideoModelMaxDuration(normalizedModel),
      Number(body.duration) || getVideoModelMinDuration(normalizedModel),
    ),
  );
  const promptForLog = String(body.prompt || "");
  const effectivePrompt = alignPromptDurationText(
    String(body.prompt || ""),
    Number.isFinite(Number(body.duration)) ? Number(body.duration) : null,
    normalizedDuration,
  );
  const effectivePromptForLog = alignPromptDurationText(
    promptForLog,
    Number.isFinite(Number(body.duration)) ? Number(body.duration) : null,
    normalizedDuration,
  );
  if ((options?.reason || "direct") === "direct") {
    logVideoPromptSummary(provider, model || normalizedModel, normalizedDuration, effectivePromptForLog);
    await pauseBeforeBackendMediaSubmit({
      kind: "video",
      provider,
      model: model || normalizedModel,
      abortSignal,
    });
  }
  const primaryReferenceImage =
    typeof body.imageUrl === "string"
      ? await normalizeRunningHubReferenceImageUrl(body.imageUrl, apiConfig, abortSignal)
      : null;
  const referenceImageUrls = await normalizeRunningHubReferenceImageUrls(
    body.referenceImageUrls,
    apiConfig,
    abortSignal,
  );
  const referenceVideoUrls = await normalizeRunningHubReferenceVideoUrls(
    body.videoUrls,
    apiConfig,
    abortSignal,
  );
  const referenceAudioUrls = await normalizeRunningHubReferenceAudioUrls(
    body.audioUrls,
    apiConfig,
    abortSignal,
  );
  const mergedReferenceImages = Array.from(
    new Set(
      [primaryReferenceImage, ...referenceImageUrls].filter((value): value is string => !!value),
    ),
  ).slice(0, 9);
  const baseUrl = getRunningHubBaseUrl(apiConfig);
  const seedValue = Number(body.seed);
  const commonSeed = Number.isInteger(seedValue) ? seedValue : undefined;

  let url = "";
  let payload: Record<string, unknown> = {};
  const shouldEnableRealPersonMode =
    provider === RUNNINGHUB_SEEDANCE_PROVIDER
      ? typeof body.realPersonMode === "boolean"
        ? body.realPersonMode
        : true
      : undefined;
  const shouldGenerateAudio =
    typeof body.generateAudio === "boolean" ? body.generateAudio : true;
  const normalizedConversionSlots = Array.isArray(body.conversionSlots)
    ? Array.from(
        new Set(
          body.conversionSlots
            .map((slot) => String(slot || "").trim())
            .filter((slot) =>
              [
                "all",
                "image1",
                "image2",
                "image3",
                "image4",
                "image5",
                "image6",
                "image7",
                "image8",
                "image9",
                "video1",
                "video2",
                "video3",
              ].includes(slot),
            ),
        ),
      )
    : shouldEnableRealPersonMode
      ? ["all"]
      : [];
  const shouldReturnLastFrame =
    typeof body.returnLastFrame === "boolean" ? body.returnLastFrame : false;

  if (provider === RUNNINGHUB_HAPPYHORSE_PROVIDER) {
    const commonPayload = {
      prompt: effectivePrompt.slice(0, 2500),
      resolution: String(body.resolution || "").trim().toLowerCase() === "1080p" ? "1080p" : "720p",
      duration: normalizedDuration,
      aspectRatio: resolveAliyunVideoRatio(body.aspectRatio),
      ...(commonSeed !== undefined ? { seed: commonSeed } : {}),
    };
    if (mergedReferenceImages.length > 1) {
      url = `${baseUrl}/openapi/v2/alibaba/happyhorse-1.0/reference-to-video`;
      payload = {
        ...commonPayload,
        imageUrls: mergedReferenceImages,
      };
    } else if (mergedReferenceImages.length === 1) {
      url = `${baseUrl}/openapi/v2/alibaba/happyhorse-1.0/image-to-video`;
      payload = {
        ...commonPayload,
        imageUrl: mergedReferenceImages[0],
      };
    } else {
      url = `${baseUrl}/openapi/v2/alibaba/happyhorse-1.0/text-to-video`;
      payload = commonPayload;
    }
  } else {
    url =
      provider === RUNNINGHUB_SEEDANCE_FAST_PROVIDER
        ? `${baseUrl}/openapi/v2/bytedance/seedance-2.0-global-fast/multimodal-video`
        : `${baseUrl}/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video`;
    payload = {
      prompt: effectivePrompt.slice(0, 2500),
      resolution: String(body.resolution || "1080p").trim().toLowerCase(),
      duration: normalizedDuration,
      ratio: resolveRunningHubVideoRatio(body.aspectRatio),
      generateAudio: shouldGenerateAudio,
      ...(shouldEnableRealPersonMode !== undefined ? { realPersonMode: shouldEnableRealPersonMode } : {}),
      ...(mergedReferenceImages.length ? { imageUrls: mergedReferenceImages } : {}),
      ...(referenceVideoUrls.length ? { videoUrls: referenceVideoUrls } : {}),
      ...(referenceAudioUrls.length ? { audioUrls: referenceAudioUrls } : {}),
      ...(normalizedConversionSlots.length ? { conversionSlots: normalizedConversionSlots } : {}),
      returnLastFrame: shouldReturnLastFrame,
      ...(commonSeed !== undefined ? { seed: commonSeed } : {}),
    };
  }

  logVideoReferenceSummary("reference submit", {
    provider,
    route: options?.reason || "direct",
    model: model || normalizedModel,
    requestedReferenceAssets: summarizeVideoReferenceDebugInfoList(body.referenceImageDebugInfo),
    submittedReferenceAssets: summarizeVideoReferenceDebugInfoList(
      body.referenceImageDebugInfo,
      mergedReferenceImages.length,
    ),
  });
  console.warn(
    `[video] RunningHub submit provider=${provider} reason=${options?.reason || "direct"} model=${model || normalizedModel} resolution=${String(body.resolution || "") || "(missing)"}`,
  );
  const res = await serviceFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    },
    "runninghub",
  );
  if (!res.ok) {
    const detail = await readVideoApiErrorDetail(res);
    throw new Error(
      formatVideoApiError("RunningHub video task creation failed", res.status, detail, {
        provider: "runninghub",
      }),
    );
  }

  const data = await safeParseVideoResponse(res, "RunningHub create task");
  const taskId = extractRunningHubTaskId(data);
  if (!taskId) {
    const reason = extractRunningHubResponseMessage(data);
    const code = pickFirstNonEmptyToken([data?.code, data?.errorCode, data?.data?.code]);
    const summary = JSON.stringify(
      {
        code: code || undefined,
        message: reason || undefined,
        status: extractRunningHubTaskState(data) || undefined,
        keys: data && typeof data === "object" ? Object.keys(data).slice(0, 12) : [],
        dataKeys:
          data?.data && typeof data.data === "object" ? Object.keys(data.data).slice(0, 12) : undefined,
      },
      null,
      0,
    );
    throw new Error(
      reason
        ? `RunningHub 视频任务提交失败：${reason}`
        : `RunningHub 视频任务提交响应缺少 taskId：${summary}`,
    );
  }
  const status = extractRunningHubTaskState(data) || "QUEUED";
  console.log(`[video] RunningHub submit success provider=${provider} task_id=${taskId} status=${status}`);
  return {
    task_id: taskId,
    status,
    provider,
  };
}

async function maybeSubmitRunningHubVideoFallback(params: {
  status: number;
  detail: VideoApiErrorDetail;
  model: string;
  body: any;
  apiConfig: ReturnType<typeof getApiConfig>;
  abortSignal?: AbortSignal;
}) {
  if (
    !shouldRetryViaRunningHubModerationFallback(
      params.status,
      params.detail,
      params.model,
      params.apiConfig,
    )
  ) {
    return null;
  }

  const provider = resolveRunningHubProvider(params.model);
  if (!provider) return null;
  console.warn(
    `[video] RunningHub fallback triggered provider=${provider} status=${params.status} code=${params.detail.code || "(none)"}`,
  );
  return submitRunningHubVideoTask(
    {
      ...params.body,
      model: params.model,
      provider,
    },
    params.apiConfig,
    params.abortSignal,
    {
      provider,
      reason: "moderation_fallback",
    },
  );
}

async function maybeSubmitAliyunHappyHorseFallback(params: {
  provider: RunningHubVideoProvider;
  model?: string;
  body: any;
  apiConfig: ReturnType<typeof getApiConfig>;
  abortSignal?: AbortSignal;
  error: unknown;
}) {
  if (params.provider !== RUNNINGHUB_HAPPYHORSE_PROVIDER) {
    return null;
  }
  if (!hasUsableApiCredential(params.apiConfig.aliyunEndpoint, params.apiConfig.aliyunKey)) {
    return null;
  }
  const reason = String(params.error instanceof Error ? params.error.message : params.error || "")
    .replace(/\s+/g, " ")
    .trim();
  console.warn(
    `[video] Aliyun HappyHorse fallback triggered after RunningHub failure provider=${params.provider}${reason ? ` reason=${reason}` : ""}`,
  );
  return localGenerateVideo(
    {
      ...params.body,
      model: params.model || HAPPYHORSE_VISIBLE_MODEL,
      provider: "aliyun",
    },
    params.abortSignal,
  );
}

function isPublicHttpUrl(value?: string | null): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function logVideoReferenceSummary(
  stage: string,
  payload: Record<string, unknown>,
) {
  const normalizedPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null),
  );
  console.log(`[video] ${stage} ${JSON.stringify(normalizedPayload)}`);
}

function logVideoPromptSummary(
  provider: string,
  model: string,
  duration: number | string | null | undefined,
  prompt: string,
) {
  const normalizedPrompt = String(prompt || "");
  console.log(
    [
      `[video] pending submit provider=${provider} model=${model || "default"} duration=${duration ?? "(missing)"}s promptLength=${normalizedPrompt.length}`,
      "[video] prompt begin",
      normalizedPrompt,
      "[video] prompt end",
    ].join("\n"),
  );
}

function logImageSubmissionPreview(
  provider: string,
  model: string,
  promptLength: number,
) {
  console.log(
    `[image] pending submit provider=${provider} model=${model || "default"} promptLength=${Math.max(0, Math.floor(promptLength || 0))}`,
  );
}

function extractVideoReferenceFileName(value: unknown): string | null {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.startsWith("data:")) return null;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const queryFileName = parsed.searchParams.get("filename");
      if (queryFileName?.trim()) return queryFileName.trim();
      const pathnameName = parsed.pathname.split("/").filter(Boolean).at(-1);
      return pathnameName ? decodeURIComponent(pathnameName) : null;
    } catch {
      return null;
    }
  }
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) || null;
}

function summarizeVideoReferenceDebugInfoEntry(
  value: unknown,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const labelCandidates = [
    raw.label,
    raw.entityName,
    raw.sceneName,
    raw.variantLabel,
    extractVideoReferenceFileName(raw.url),
  ];
  for (const candidate of labelCandidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
}

function summarizeVideoReferenceDebugInfoList(
  value: unknown,
  maxCount = 9,
): string | null {
  if (!Array.isArray(value)) return null;
  const collected: string[] = [];
  for (const entry of value) {
    const summarized = summarizeVideoReferenceDebugInfoEntry(entry);
    if (!summarized) continue;
    if (collected.includes(summarized)) continue;
    collected.push(summarized);
    if (collected.length >= maxCount) break;
  }
  return collected.length ? `（${collected.join("、")}）` : null;
}

async function normalizeAliyunReferenceImageUrls(value: unknown): Promise<string[]> {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? [value]
      : [];
  const collected: string[] = [];
  for (const entry of rawValues) {
    const normalized = await normalizeArkReferenceImageUrl(String(entry || ""));
    if (!normalized || collected.includes(normalized)) continue;
    collected.push(normalized);
    if (collected.length >= 9) break;
  }
  return collected;
}

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function inferRunningHubUploadExtension(mimeType: string): string {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized.includes("mp4")) return ".mp4";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("bmp")) return ".bmp";
  return ".jpg";
}

function extractRunningHubResponseMessage(payload: any): string {
  const candidates = [
    payload?.message,
    payload?.msg,
    payload?.errorMessage,
    payload?.error?.message,
    payload?.data?.message,
    payload?.data?.msg,
    payload?.data?.errorMessage,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ||
    ""
  );
}

function extractRunningHubUploadedAssetUrl(payload: any): string {
  const candidates = [
    payload?.download_url,
    payload?.downloadUrl,
    payload?.url,
    payload?.data?.download_url,
    payload?.data?.downloadUrl,
    payload?.data?.url,
    payload?.data?.fileUrl,
  ];
  return (
    candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ||
    ""
  );
}

async function uploadRunningHubReferenceBinary(
  dataUrl: string,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error("RunningHub 参考图上传失败：不支持的图片数据格式。");
  }

  const mimeType = match[1] || "application/octet-stream";
  const base64 = match[2] || "";
  const blob = new Blob([decodeBase64ToUint8Array(base64)], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, `runninghub-reference${inferRunningHubUploadExtension(mimeType)}`);

  const res = await serviceFetch(
    getRunningHubUploadUrl(apiConfig),
    {
      method: "POST",
      body: formData,
      signal: abortSignal,
    },
    "runninghub",
  );
  if (!res.ok) {
    const detail = await readVideoApiErrorDetail(res);
    throw new Error(
      formatVideoApiError("RunningHub reference upload failed", res.status, detail, {
        provider: "runninghub",
      }),
    );
  }

  const payload = await safeParseVideoResponse(res, "RunningHub upload reference");
  const uploadedUrl = extractRunningHubUploadedAssetUrl(payload);
  if (uploadedUrl) return uploadedUrl;

  const reason = extractRunningHubResponseMessage(payload);
  throw new Error(
    reason
      ? `RunningHub 参考图上传失败：${reason}`
      : `RunningHub 参考图上传响应缺少 download_url：${JSON.stringify(payload).slice(0, 500)}`,
  );
}

async function normalizeRunningHubReferenceImageUrl(
  imageUrl: string,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  return normalizeRunningHubReferenceMediaUrl(imageUrl, apiConfig, abortSignal);
}

async function normalizeRunningHubReferenceImageUrls(
  value: unknown,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  return normalizeRunningHubReferenceMediaUrls(value, apiConfig, abortSignal, 9);
}

async function normalizeRunningHubReferenceMediaUrl(
  source: string,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const trimmed = String(source || "").trim();
  if (!trimmed || trimmed.startsWith("blob:")) return null;
  if (isPublicHttpUrl(trimmed)) return trimmed;
  const inlineData = await getInlineData(trimmed);
  if (!inlineData?.data) return null;
  return uploadRunningHubReferenceBinary(
    `data:${inlineData.mimeType || "application/octet-stream"};base64,${inlineData.data}`,
    apiConfig,
    abortSignal,
  );
}

async function normalizeRunningHubReferenceMediaUrls(
  value: unknown,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal: AbortSignal | undefined,
  maxCount: number,
): Promise<string[]> {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? [value]
      : [];
  const collected: string[] = [];
  for (const entry of rawValues) {
    const normalized = await normalizeRunningHubReferenceMediaUrl(
      String(entry || ""),
      apiConfig,
      abortSignal,
    );
    if (!normalized || collected.includes(normalized)) continue;
    collected.push(normalized);
    if (collected.length >= maxCount) break;
  }
  return collected;
}

async function normalizeRunningHubReferenceVideoUrls(
  value: unknown,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  return normalizeRunningHubReferenceMediaUrls(value, apiConfig, abortSignal, 3);
}

async function normalizeRunningHubReferenceAudioUrls(
  value: unknown,
  apiConfig: ReturnType<typeof getApiConfig>,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  return normalizeRunningHubReferenceMediaUrls(value, apiConfig, abortSignal, 3);
}

async function normalizeArkReferenceImageUrls(value: unknown): Promise<string[]> {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? [value]
      : [];
  const collected: string[] = [];
  for (const entry of rawValues) {
    const normalized = await normalizeArkReferenceImageUrl(String(entry || ""));
    if (!normalized || collected.includes(normalized)) continue;
    collected.push(normalized);
    if (collected.length >= 9) break;
  }
  return collected;
}

function resolveAliyunVideoResolution(value: unknown): "720P" | "1080P" {
  return String(value || "").trim().toLowerCase() === "1080p" ? "1080P" : "720P";
}

function resolveAliyunVideoRatio(
  value: unknown,
): "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "4:5" | "5:4" {
  const normalized = String(value || "").trim();
  if (
    normalized === "16:9" ||
    normalized === "9:16" ||
    normalized === "1:1" ||
    normalized === "4:3" ||
    normalized === "3:4" ||
    normalized === "4:5" ||
    normalized === "5:4"
  ) {
    return normalized as "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "4:5" | "5:4";
  }
  return "16:9";
}

function resolveRunningHubVideoRatio(
  value: unknown,
): "adaptive" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" {
  const normalized = String(value || "").trim();
  if (
    normalized === "adaptive" ||
    normalized === "16:9" ||
    normalized === "9:16" ||
    normalized === "1:1" ||
    normalized === "4:3" ||
    normalized === "3:4" ||
    normalized === "21:9"
  ) {
    return normalized as "adaptive" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9";
  }
  if (normalized === "4:5") return "3:4";
  if (normalized === "5:4") return "4:3";
  return "16:9";
}

function videoHttp(
  url: string,
  headers: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
  service: "tuzi" | "jimeng" | "aliyun" = "jimeng",
) {
  return directFetch(url, headers, body, signal, service);
}

async function videoHttpRequest(params: {
  url: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  signal?: AbortSignal;
  service?: "tuzi" | "jimeng" | "aliyun";
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

  const authHeader = headers.Authorization ||
    headers.authorization ||
    (isServerProxyEndpoint(url) ? "" : `Bearer ${resolveDirectApiKey(service)}`);
  const mergedHeaders: Record<string, string> = authHeader
    ? { ...headers, Authorization: authHeader }
    : { ...headers };
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
    "4:3": {
      "1K": "1365x1024",
      "2K": "2730x2048",
      "4K": "4096x3072",
    },
    "3:4": {
      "1K": "1024x1365",
      "2K": "2048x2730",
      "4K": "3072x4096",
    },
    "4:5": {
      "1K": "1024x1280",
      "2K": "2048x2560",
      "4K": "3277x4096",
    },
    "5:4": {
      "1K": "1280x1024",
      "2K": "2560x2048",
      "4K": "4096x3277",
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

const BACKEND_MEDIA_SUBMISSION_GUARD_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 3000;
let backendMediaSubmissionGuardDelayMsOverride: number | null = null;

function resolveBackendMediaSubmissionGuardDelayMs(): number {
  return backendMediaSubmissionGuardDelayMsOverride ?? BACKEND_MEDIA_SUBMISSION_GUARD_DELAY_MS;
}

export function __setInvokeWithKeyMediaSubmissionGuardDelayForTests(
  delayMs: number | null,
): void {
  backendMediaSubmissionGuardDelayMsOverride =
    typeof delayMs === "number" && Number.isFinite(delayMs)
      ? Math.max(0, Math.floor(delayMs))
      : null;
}

function createInvokeAbortError(message = "请求已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfInvokeSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createInvokeAbortError();
}

function waitForInvokeAbortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfInvokeSignalAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createInvokeAbortError());
      return;
    }
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(createInvokeAbortError());
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function pauseBeforeBackendMediaSubmit(params: {
  kind: "image" | "video";
  provider: string;
  model: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const delayMs = resolveBackendMediaSubmissionGuardDelayMs();
  throwIfInvokeSignalAborted(params.abortSignal);
  if (delayMs <= 0) return;
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  const guardedActionLabel = params.kind === "image" ? "生图请求" : "生视频请求";
  console.log(
    `[${params.kind}] 已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交${guardedActionLabel} provider=${params.provider || "default"} model=${params.model || "default"} delayMs=${delayMs}`,
  );
  await waitForInvokeAbortableDelay(delayMs, params.abortSignal);
  console.log(
    `[${params.kind}] 防误触保护已结束，开始提交${guardedActionLabel} provider=${params.provider || "default"} model=${params.model || "default"}`,
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

**【过滤旁白与未撰写内容】**
- 只根据**已经写出的剧本正文内容**提取角色与场景，只认正文里已经被正式描写、已经发生或已经明确呈现的资产信息。
- 旁白、画外音、VO、OS、作者说明、创作备注、剧情提要、分集简介、下集预告、未来计划、设定列表、章节标题中提到但正文尚未展开的内容，都**不是当前资产提取依据**。
- “旁白”“画外音”“解说”“VO”“OS”等只是语言层标记，**绝对不是角色**，严禁写入 characters。
- 如果文本只是总结、预告、假设、计划、愿景，或用“将会 / 未来 / 待续 / 下一集”描述尚未正式写出的剧情，即使出现角色名或场景名，也不要提取为当前角色与场景资产。

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
   - 只保留**足以单独生成一张角色参考图**的稳定视觉变体。服装、发型、妆造、年龄阶段、战损、神化/魔化、明确伪装等可以算；情绪、气质、身份称呼、修为高低、剧情前后期如果没有稳定外观差异，一律不算。
   - 只有在剧本中能明确区分时才输出；如果没有清晰变体，不要硬编，留空或省略即可。
   - 基础默认形象不要重复写成变体，例如“常态”“普通状态”“日常”不要输出；角色本身的 description 已经承担基础形象。
   - 如果两个标签本质上描述的是同一视觉状态，只保留一个最简洁、最稳定的名称，例如“华服”/“锦衣华服”只保留一个，“神化状态”/“新神姿态”只保留一个。
   - "label" 要简短可用，如“校服”“战损红衣”“成年后”“夜行伪装”。
   - "description" 写清该变体相对主形象的关键视觉差异。

### 场景设定提取要求

1. 识别剧本中出现的所有不同场景/地点。
2. 为每个场景提供详细的环境描述（时间、光线、空间特征、氛围等）。
3. 场景名称应简洁明了。
4. **识别场景变体（可选）**：如果同一场景在剧本中明确出现了 2 种及以上可区分的时间/天气/季节/环境状态，请输出 "timeVariants" 数组。
   - 例如：清晨 / 黄昏 / 雨夜 / 雪后 / 断电状态 / 火灾后。
   - 只保留**足以单独生成一张场景参考图**的稳定环境差异，例如时间、天气、季节、灯光、电力状态、重大破坏或灾后状态；不要把“日常”“平时”这类默认状态写成变体。
   - 剧情节点、情绪氛围、一次性动作结果如果没有形成稳定环境变化，不算场景变体。
   - 只有在剧本中能明确区分时才输出；如果没有清晰变体，不要硬编，留空或省略即可。
   - 如果两个标签本质上是同一环境状态，只保留一个最简洁名称，例如“雷雨夜”/“雨夜”只保留一个。
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
4. **【剧情完整性优先】** 必须完整覆盖原剧本已经写出的剧情信息、动作起因、人物反应、关系变化、状态变化、冲突结果和信息揭示。宁可适当增加 description 字数，也不要为了简短而省略会影响后续理解的剧情细节。禁止把多个已发生的关键情节压缩成模糊概述，禁止跳过会影响后续剧情成立的重要动作或结果。
5. 基于原文拆分，人名地名用[]包裹，禁止加戏、禁止镜头术语、对白完整保留
6. 在场但未提及的角色补充简短站位描述
7. 敏感描述替换（对白原样保留）
8. **服装匹配**：如果提供了角色服装变体信息，必须为每个分镜中的多服装角色指定当前穿着的服装label。根据剧本上下文（场景、时间线、剧情发展、年龄阶段）精确判断角色在该分镜中应穿哪套服装。
9. **角色名与服装解析**：剧本中角色名可能以 [角色名·年龄·服装名] 格式出现（如 [NATHAN COLE·32岁·探险装备]）。在 characters 数组中只填写基础角色名（如 "NATHAN COLE"），服装信息填入 characterCostumes 字段（如 {"NATHAN COLE": "32岁·探险装备"}）。同一角色在不同分镜的服装后缀变化即为服装切换的直接依据。

输出JSON，仅含"scenes"数组。每个对象：
- sceneNumber: 全局序号(整数递增，从1开始连续编号)
- segmentLabel: 片段编号如"1-1","1-2"(按15秒重新划分，同片段内的多个分镜必须共享相同的segmentLabel)
- sceneName: 场景名
- description: **只写看得到的画面内容**，不得写台词、旁白、画外音、心声；同一片段内不同分镜应有不同的画面角度或动作；优先把“谁在做什么、发生了什么、造成什么结果/承接”写完整，允许适当增加字数，避免只写关键词式短句
- characters: 出场角色数组
- dialogue: **承载所有听得到的语言内容**，包括角色对白、旁白、画外音、电话音、心声/内心独白；"角色：台词"格式，多条用 \\n 分隔（JSON转义，不是真实换行），无则空串；如同一分镜同时有画面和语言，description写画面，dialogue写语言，不要混写；台词只分配给该分镜对应的画面时刻
- cameraDirection: 固定"无字幕、无水印、无背景音"
- duration: 该分镜建议时长（整数秒），同一 segmentLabel 下所有分镜的 duration 总和必须等于 15
- characterCostumes: 对象，key为角色名，value为该角色在此分镜中穿着的服装label（仅对有多套服装的角色填写，无多套服装的角色不填）
- sceneTimeVariantId: 字符串，填写该分镜命中的场景时间/天气/环境变体 label（仅对有多套场景变体的 sceneName 填写，无明确变体时不填）

示例结构（片段1-1包含3个分镜）：
[
  {"sceneNumber":1,"segmentLabel":"1-1","sceneName":"战场","description":"荒野上两军对峙，旌旗在风里猛然绷紧","characters":["角色A"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"},"sceneTimeVariantId":"黄昏"},
  {"sceneNumber":2,"segmentLabel":"1-1","sceneName":"战场","description":"角色A举刀冲锋，脚下扬起尘土直扑敌阵","characters":["角色A"],"dialogue":"角色A：冲啊！","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"},"sceneTimeVariantId":"黄昏"},
  {"sceneNumber":3,"segmentLabel":"1-1","sceneName":"战场","description":"刀刃正面碰撞，火花沿着刃口猛然炸开","characters":["角色A","角色B"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":5,"characterCostumes":{"角色A":"青年·战甲"},"sceneTimeVariantId":"黄昏"}
]


⚠️ 最终检查清单（输出前必须逐条验证）：
1. 每条对话是否都在字数上限之内？超过则必须拆分片段。
2. 每个片段是否有{SHOTS_PER_SEGMENT}个分镜？
3. 片段总数是否接近{SEGMENTS_PER_EPISODE}？（因台词拆分可以略多，但不可少于{SEGMENTS_PER_EPISODE}）
4. description 是否只写画面内容，没有混入台词/旁白/心声？
5. dialogue 是否承载了所有语言内容（旁白/画外音/心声均放入dialogue，不遗漏）？
6. 原剧本中的关键剧情、动作结果、关系变化、信息揭示是否都已覆盖，没有因为压缩字数而遗漏？

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
    const durationConstraint = `\n\n⚠️ 【时长硬性约束 — 最高优先级，不可违反】本集视频总时长为 ${episodeDurationSeconds} 秒，每片段固定 15 秒，因此必须输出**恰好 ${segments} 个片段**，不得多也不得少。台词过多时只精简台词用词（不改变原意），description 的画面细节和剧情动作不得缩减；如原剧本信息密度高，可适当增加 description 字数，优先完整呈现剧情。内容不足时必须补充空镜/环境镜头，以确保片段数严格等于 ${segments}。`;
    return `${basePrompt}${durationConstraint}\n\n${DECOMPOSE_SERIALIZATION_GUARD}`;
  }

  return `${basePrompt}\n\n${DECOMPOSE_SERIALIZATION_GUARD}`;
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
  const normalized = normalizeNarrationSpeakerToken(value);
  return (
    NARRATION_SPEAKER_RE.test(normalized) ||
    /^(旁白|画外音|内心独白|心声|独白|VO|V\.O\.|OS|O\.S\.)$/i.test(normalized)
  );
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

interface DecomposeSourceSignals {
  explicitDialogueLines: string[];
  dialogueSpeakers: string[];
  roleAnchors: string[];
  headPreview: string[];
  tailPreview: string[];
}

function collectStructuredScriptLines(script: string): string[] {
  return String(script || "")
    .split(/\r?\n+/)
    .flatMap((line) => String(line || "").split(/\s*\|\s*/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^第\s*[一二三四五六七八九十百千万0-9]+\s*集(?:\s*[：:]\s*.*)?$/u.test(line));
}

function extractBracketRoleAnchors(script: string): string[] {
  const anchors: string[] = [];
  const matcher = /[\[【]([^\]】\n]{1,80})[\]】]/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(String(script || ""))) !== null) {
    const rawValue = String(match[1] || "").trim();
    if (!rawValue) continue;
    const normalized = normalizeSceneCharacterName(
      rawValue
        .split(/[·•｜|/]/, 1)[0]
        ?.replace(/[（(].*$/u, "")
        .trim(),
    );
    if (normalized) anchors.push(normalized);
  }
  return uniqueTrimmedStrings(anchors);
}

function extractDecomposeSourceSignals(script: string): DecomposeSourceSignals {
  const scriptLines = collectStructuredScriptLines(script);
  const explicitDialogueLines = uniqueTrimmedStrings(
    scriptLines.map((line) => normalizeDialogueLine(line)).filter(Boolean),
  );
  const dialogueSpeakers = uniqueTrimmedStrings(
    explicitDialogueLines.map((line) => normalizeSceneCharacterName(extractDialogueSpeaker(line))),
  );
  const roleAnchors = uniqueTrimmedStrings([
    ...extractBracketRoleAnchors(script),
    ...dialogueSpeakers,
  ]);

  return {
    explicitDialogueLines,
    dialogueSpeakers,
    roleAnchors,
    headPreview: scriptLines.slice(0, 3),
    tailPreview: scriptLines.slice(-3),
  };
}

function collectSceneDialogueLines(scenes: Array<Record<string, unknown>>): string[] {
  return scenes
    .flatMap((scene) => splitStructuredText(String(scene?.dialogue || "")))
    .map((line) => normalizeDialogueLine(line) || String(line || "").trim())
    .filter(Boolean);
}

function collectSceneCharacterNames(scenes: Array<Record<string, unknown>>): string[] {
  return uniqueTrimmedStrings(
    scenes.flatMap((scene) => [
      ...(Array.isArray(scene?.characters) ? scene.characters.map((name) => String(name || "").trim()) : []),
      ...splitStructuredText(String(scene?.dialogue || "")).map((line) =>
        normalizeSceneCharacterName(extractDialogueSpeaker(line)),
      ),
    ]),
  );
}

type DecomposeValidationErrorKind =
  | "segment-count-underflow"
  | "segment-count-overflow"
  | "shot-count-underflow"
  | "shot-count-overflow"
  | "segment-duration-mismatch"
  | "dialogue-count-overflow"
  | "dialogue-char-overflow"
  | "dialogue-coverage-underflow";

class DecomposeValidationError extends Error {
  readonly kind: DecomposeValidationErrorKind;
  readonly segmentLabel?: string;
  readonly actual?: number;
  readonly expected?: number;
  readonly maxAllowed?: number;
  readonly linePreview?: string;

  constructor(
    message: string,
    details: {
      kind: DecomposeValidationErrorKind;
      segmentLabel?: string;
      actual?: number;
      expected?: number;
      maxAllowed?: number;
      linePreview?: string;
    },
  ) {
    super(message);
    this.name = "DecomposeValidationError";
    this.kind = details.kind;
    this.segmentLabel = details.segmentLabel;
    this.actual = details.actual;
    this.expected = details.expected;
    this.maxAllowed = details.maxAllowed;
    this.linePreview = details.linePreview;
  }
}

function isDecomposeValidationError(error: unknown): error is DecomposeValidationError {
  return error instanceof DecomposeValidationError;
}

function rebuildDialogueLine(originalLine: string, content: string): string {
  const trimmed = String(originalLine || "").trim();
  const speakerMatch = trimmed.match(/^([^：:\n]{1,20})[：:]\s*(.+)$/);
  const separator = trimmed.includes(":") && !trimmed.includes("：") ? ":" : "：";
  if (speakerMatch) {
    return `${speakerMatch[1].trim()}${separator}${content}`;
  }
  return content;
}

function countDialogueChars(value: string): number {
  return String(value || "").replace(/\s+/g, "").length;
}

function splitDialogueContentIntoChunks(content: string, maxChars: number): string[] {
  const source = String(content || "").trim();
  if (!source) return [];
  if (countDialogueChars(source) <= maxChars) return [source];

  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    let visibleChars = 0;
    let lastSoftBreak = -1;
    while (end < source.length && visibleChars < maxChars) {
      const char = source[end];
      if (!/\s/.test(char)) visibleChars += 1;
      if (/[，。！？；、,.!?;:：]/.test(char) && visibleChars >= Math.max(1, Math.floor(maxChars * 0.55))) {
        lastSoftBreak = end + 1;
      }
      end += 1;
    }
    if (end >= source.length) {
      chunks.push(source.slice(start).trim());
      break;
    }
    const cutAt = lastSoftBreak > start ? lastSoftBreak : end;
    const chunk = source.slice(start, cutAt).trim();
    if (!chunk) break;
    chunks.push(chunk);
    start = cutAt;
  }
  return chunks.filter(Boolean);
}

function resolveDialogueMaxChars(
  cfg: { chars1: [number, number]; chars2: [number, number]; chars3: [number, number] },
  lineCount: number,
): number {
  if (lineCount <= 1) return cfg.chars1[1];
  if (lineCount === 2) return cfg.chars2[1];
  return cfg.chars3[1];
}

function repairDialogueOverflowScenes(
  scenes: Array<Record<string, unknown>>,
  options: {
    segmentsTarget: number;
    videoPace?: string;
    allowExtraSegments?: number;
  },
): Array<Record<string, unknown>> {
  const normalizedScenes = Array.isArray(scenes) ? scenes.map((scene) => ({ ...scene })) : [];
  const cfg = PACE_CONFIG[options.videoPace || "medium"] || PACE_CONFIG.medium;
  const segmentIndexes = new Map<string, number[]>();

  normalizedScenes.forEach((scene, index) => {
    const segmentLabel = String(scene?.segmentLabel || "").trim();
    if (!segmentLabel) return;
    const group = segmentIndexes.get(segmentLabel) || [];
    group.push(index);
    segmentIndexes.set(segmentLabel, group);
  });

  for (const indexes of segmentIndexes.values()) {
    const originalLines = indexes
      .flatMap((sceneIndex) => splitStructuredText(String(normalizedScenes[sceneIndex]?.dialogue || "")))
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    if (!originalLines.length || originalLines.length > 3) continue;

    let repairedLines: string[] | null = null;
    for (let allowedLineCount = originalLines.length; allowedLineCount <= 3; allowedLineCount += 1) {
      const maxChars = resolveDialogueMaxChars(cfg, allowedLineCount);
      const nextLines = originalLines.flatMap((line) => {
        const contentMatch = String(line || "").trim().match(/^([^：:\n]{1,20})[：:]\s*(.+)$/);
        const sourceContent = (contentMatch?.[2] || String(line || "").trim()).trim();
        return splitDialogueContentIntoChunks(sourceContent, maxChars).map((chunk) =>
          rebuildDialogueLine(line, chunk),
        );
      });
      if (
        nextLines.length <= allowedLineCount &&
        nextLines.every((line) => countDialogueChars(stripDialogueSpeaker(line)) <= maxChars)
      ) {
        repairedLines = nextLines;
        break;
      }
    }

    if (!repairedLines) continue;

    let changed = repairedLines.length !== originalLines.length;
    if (!changed) {
      changed = repairedLines.some((line, index) => line !== originalLines[index]);
    }
    if (!changed) continue;

    indexes.forEach((sceneIndex, offset) => {
      normalizedScenes[sceneIndex] = {
        ...normalizedScenes[sceneIndex],
        dialogue: repairedLines?.[offset] || "",
      };
    });
  }

  return normalizedScenes;
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

function resolveDecomposeSourceSignalsForValidation(options: {
  sourceScript?: string | null;
  sourceSignals?: DecomposeSourceSignals | null;
}): DecomposeSourceSignals | null {
  if (options.sourceSignals) return options.sourceSignals;
  if (typeof options.sourceScript === "string" && options.sourceScript.trim()) {
    return extractDecomposeSourceSignals(options.sourceScript);
  }
  return null;
}

function validateDecomposeSourceCoverage(
  scenes: Array<Record<string, unknown>>,
  sourceSignals: DecomposeSourceSignals | null,
): void {
  if (!sourceSignals?.explicitDialogueLines.length) return;

  const outputDialogueLines = collectSceneDialogueLines(scenes);
  if (!outputDialogueLines.length) {
    throw new DecomposeValidationError("源剧本包含显式对白，但输出的 dialogue 字段为空。", {
      kind: "dialogue-coverage-underflow",
      actual: 0,
      expected: sourceSignals.explicitDialogueLines.length,
      linePreview: clipDecomposeContextText(sourceSignals.explicitDialogueLines[0], 36),
    });
  }

  if (!sourceSignals.dialogueSpeakers.length) return;

  const outputCharacters = new Set(collectSceneCharacterNames(scenes));
  const coveredSpeakers = sourceSignals.dialogueSpeakers.filter((name) => outputCharacters.has(name));
  if (coveredSpeakers.length > 0) return;

  throw new DecomposeValidationError("源剧本中的显式对白角色未在输出中得到覆盖。", {
    kind: "dialogue-coverage-underflow",
    actual: 0,
    expected: sourceSignals.dialogueSpeakers.length,
    linePreview: clipDecomposeContextText(sourceSignals.explicitDialogueLines[0], 36),
  });
}

function finalizeDecomposeScenes(
  scenes: any[],
  options: {
    segmentsTarget: number;
    videoPace?: string;
    allowExtraSegments?: number;
    sourceScript?: string | null;
    sourceSignals?: DecomposeSourceSignals | null;
  },
): any[] {
  const normalizedScenes = normalizeDecomposeScenes(scenes);
  const repairedScenes = repairDialogueOverflowScenes(normalizedScenes, options);
  validateDecomposeSceneCounts(repairedScenes, options);
  return repairedScenes;
}

export function validateDecomposeSceneCounts(
  scenes: any[],
  options: {
    segmentsTarget: number;
    videoPace?: string;
    allowExtraSegments?: number;
    sourceScript?: string | null;
    sourceSignals?: DecomposeSourceSignals | null;
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
    throw new DecomposeValidationError(
      `拆解结果片段数不足：期望至少 ${segmentsTarget} 个，实际 ${segmentCount} 个。`,
      {
        kind: "segment-count-underflow",
        actual: segmentCount,
        expected: segmentsTarget,
      },
    );
  }

  const maxAllowedSegments = segmentsTarget + allowExtraSegments;
  if (segmentCount > maxAllowedSegments) {
    throw new DecomposeValidationError(
      `拆解结果片段数超出上限：期望至多 ${maxAllowedSegments} 个，实际 ${segmentCount} 个。`,
      {
        kind: "segment-count-overflow",
        actual: segmentCount,
        maxAllowed: maxAllowedSegments,
      },
    );
  }

  const underfilledSegments = [...segmentCounts.entries()].filter(
    ([, shotCount]) => shotCount < minShotsPerSegment,
  );
  if (underfilledSegments.length > 0) {
    const sample = underfilledSegments
      .slice(0, 3)
      .map(([segmentLabel, shotCount]) => `${segmentLabel}(${shotCount}/${minShotsPerSegment})`)
      .join("、");
    throw new DecomposeValidationError(`拆解结果分镜数不足：${sample}。`, {
      kind: "shot-count-underflow",
      segmentLabel: sample,
      expected: minShotsPerSegment,
    });
  }

  const overfilledSegments = [...segmentCounts.entries()].filter(
    ([, shotCount]) => shotCount > shotRange.max,
  );
  if (overfilledSegments.length > 0) {
    const sample = overfilledSegments
      .slice(0, 3)
      .map(([segmentLabel, shotCount]) => `${segmentLabel}(${shotCount}/${shotRange.max})`)
      .join("、");
    throw new DecomposeValidationError(`拆解结果分镜数超出提示词上限：${sample}。`, {
      kind: "shot-count-overflow",
      segmentLabel: sample,
      maxAllowed: shotRange.max,
    });
  }

  const durationMismatchedSegments = [...segmentDurationTotals.entries()].filter(
    ([, totalDuration]) => totalDuration > 0 && totalDuration !== SEGMENT_DURATION_SECONDS,
  );
  if (durationMismatchedSegments.length > 0) {
    const sample = durationMismatchedSegments
      .slice(0, 3)
      .map(([segmentLabel, totalDuration]) => `${segmentLabel}(${totalDuration}/${SEGMENT_DURATION_SECONDS})`)
      .join(", ");
    throw new DecomposeValidationError(`Duration mismatch across segment shots: ${sample}`, {
      kind: "segment-duration-mismatch",
      segmentLabel: sample,
      expected: SEGMENT_DURATION_SECONDS,
    });
  }

  for (const [segmentLabel, lines] of segmentDialogueLines.entries()) {
    const normalizedLines = lines.map((line) => String(line || "").trim()).filter(Boolean);
    if (normalizedLines.length > 3) {
      throw new DecomposeValidationError(
        `拆解结果对白条数超限：${segmentLabel} 含 ${normalizedLines.length} 条对白。`,
        {
          kind: "dialogue-count-overflow",
          segmentLabel,
          actual: normalizedLines.length,
          maxAllowed: 3,
        },
      );
    }
    if (!normalizedLines.length) continue;

    const maxChars = resolveDialogueMaxChars(cfg, normalizedLines.length);

    const oversizedLine = normalizedLines.find(
      (line) => countDialogueChars(stripDialogueSpeaker(line)) > maxChars,
    );
    if (oversizedLine) {
      throw new DecomposeValidationError(
        `拆解结果对白字数超限：${segmentLabel} 中“${oversizedLine.slice(0, 24)}”超过 ${maxChars} 字。`,
        {
          kind: "dialogue-char-overflow",
          segmentLabel,
          actual: countDialogueChars(stripDialogueSpeaker(oversizedLine)),
          maxAllowed: maxChars,
          linePreview: oversizedLine.slice(0, 24),
        },
      );
    }
  }

  validateDecomposeSourceCoverage(
    Array.isArray(scenes) ? (scenes as Array<Record<string, unknown>>) : [],
    resolveDecomposeSourceSignalsForValidation(options),
  );
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

const SEGMENT_ENHANCE_PROMPT = `你是一位擅长 AI 短剧、AI 漫剧和高情绪剧情视频出片的导演型提示词编辑。你的任务是把一个片段里的多个分镜整理成一条可直接提交给视频模型的高质量中文片段 prompt。

## 唯一链路要求
1. 只输出一条最终可提交 prompt，不要输出规则清单、QA 清单、导演阐述或旧版中间结构。
2. 图片参考说明会由系统统一写在 prompt 最前面，你不要自行重复生成“图片 1 / 图片 2”段落。
3. 最终 prompt 只保留这些层级：全局风格、逐个分镜、环境细节、结尾钩子、通用后缀。
4. 旧版“视觉锚点 / 起始衔接 / 衔接原则 / 台词”这些信息，必须真正融进分镜内容本身，不能再单独拆成旧段落。

## 核心目标
1. 保留全部输入分镜，顺序不变，每一个关键镜头都要落成独立分镜，不能吞掉中段和尾段。
2. 所有图片类型描述优先级最高。图片里已经明确的角色外貌、服装、场景结构、镜头关系、光影氛围和时间连续性，必须优先服从；文字只补动作推进、情绪变化和镜头语言。
3. 只有在存在六宫格连续时间参考时，才把它理解为“上一段镜头如何一步步运动到这里”的时间线；此时分镜1第一句话必须以“镜头直接承接上一段最后尾帧画面”开头，并从六宫格尾帧状态直接开始。没有六宫格连续时间参考时，严禁使用这句固定开头。
4. 片段必须保持连续叙事，不新增输入里没有的新角色、新事件、新台词，不改变剧情因果，不提前下一段剧情，也不回演上一段已经结束的动作。
5. 若有台词，只保留一次原文，并挂在对应分镜下面，不要再输出独立“台词：”段落，不要改成字幕提示。
6. 片段开场要快速给出最强视觉推进，片段结尾必须停在下一段可直接接拍的动作势能、视线锁定或情绪高压点。

## 输出格式
1. 全局风格：单独一行，写清风格、总时长、氛围、光影、材质和镜头质感。
2. 分镜：从“分镜1（x-y秒）：”开始逐行写。每个分镜开头先用一小句明确镜头和运镜，后面再接主体动作与关键结果；保持原有篇幅，不要为了补镜头词把正文越写越长。
3. 环境细节：单独一行，只写可见或可听的动态环境元素。
4. 结尾钩子：单独一行，明确最后一帧定格在哪里、保留什么势能，以及如何直接衔接下一段。
5. 通用后缀：全文最后单独一行，固定写“通用后缀：无字幕、无水印、无屏幕文字”。

## 写法边界
1. 分镜内容要清楚、连续、可执行，不要把多个关键变化压成一句空泛概括。
2. 多用可视化动作词和镜头词，少用抽象判断；除非剧情真的需要，不要额外补太多微表情、焦点变化和环境枝节。
3. 第一镜必须直接承接起拍状态，最后一镜必须留下明确的下一段接力点。
4. 参考图已经确定的静态事实不要重复发明，重点补动作推进、反应、节奏和画面落点。

## 输出 JSON
请严格按以下 JSON 输出，不要输出 JSON 以外的任何内容：
{"prompt":"完整的最终中文片段 prompt","duration":秒数(整数,4到15),"durationReason":"一句话说明为何选择这个总时长，以及如何在该时长内保留全部关键分镜"}

## duration 规则
1. 以输入 targetDuration / maxDuration 为上限，不得超过模型上限。
2. 1-2 个镜头、动作简单、对白少：4-8 秒。
3. 3-4 个镜头，或动作 / 情绪变化明显：8-12 秒。
4. 5 个及以上镜头，或动作复杂、情绪强、对白偏多：12-15 秒，但仍不得超过 maxDuration。`;

const SEGMENT_RAW_SHOT_ENHANCE_RULES = `对标记为“未生成单镜头提示词”的分镜，只补高价值的可拍画面，不要扩写成旧版规则清单：
1. 先承接上一镜结果，再推进当前动作，最后留给下一镜自然停点。
2. 优先补主体动作链、微表情、视线变化、镜头运动、环境动态和情绪爆点。
3. 参考图已明确的静态事实不要重复发明，重点补动作推进、节奏和画面落点。
4. 若有台词，只保留原文，并挂在对应分镜下，不要单独生成“台词：”段落。`;

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
  sceneVariantContext: string,
  model: string,
  prompt: string,
  options?: {
    chunkSegments?: number;
    isRealEpisodes?: boolean;
    videoPace?: string;
    episodeDuration?: number;
    systemPrompt?: string;
  },
): Promise<Array<Record<string, unknown>>> {
  const ep = episodes[chunkIndex];
  if (!ep) throw new Error(`无效的分块索引: ${chunkIndex}`);
  const episodeSourceSignals = episodes.map((episodeScript) => extractDecomposeSourceSignals(episodeScript));
  const sourceSignals = episodeSourceSignals[chunkIndex] || extractDecomposeSourceSignals(ep);
  const sourceAnchorContext = buildDecomposeSourceAnchorContext(sourceSignals);
  const crossEpisodeContext = buildDeterministicCrossEpisodeContextForChunk(
    chunkIndex,
    episodeSourceSignals,
  );

  // Use chunk-specific prompt if segment count is provided
  const actualPrompt = options?.chunkSegments
    ? buildDecomposePrompt(options.videoPace, options.chunkSegments, options.episodeDuration)
    : prompt;

  const epPrefix =
    options?.isRealEpisodes && episodes.length > 1 ? `${chunkIndex + 1}-` : "";
  const chunkLabel = options?.isRealEpisodes
    ? `以下是第${chunkIndex + 1}集剧本`
    : `以下是剧本的第${chunkIndex + 1}部分（共${episodes.length}部分，属于同一集，本部分需要恰好${options?.chunkSegments || "?"}个片段）`;
  const userText = `${actualPrompt}\n\n---\n\n${chunkLabel}：\n\n${ep}${sourceAnchorContext}${crossEpisodeContext}${costumeContext}${sceneVariantContext}`;
  const requestContents = buildDecomposeRequestContents(userText, options?.systemPrompt);
  const chunkSignal = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
  const data = await callGemini(
    model,
    requestContents,
    buildDecomposeGenerationConfig({
      segmentsTarget: options?.chunkSegments || 1,
      averageChunkChars: ep.length,
      retryAttempt: 0,
    }),
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
    sourceSignals,
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

function normalizeDecomposeFailureReason(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "未知错误")
    .replace(/\s+/g, " ")
    .trim();
}

function isDecomposeJsonFormatError(error: unknown): boolean {
  const reason = normalizeDecomposeFailureReason(error);
  return (
    reason.includes("拆解结果 JSON 格式错误") ||
    reason.includes("无法解析 AI 返回的 JSON")
  );
}

function resolveDecomposeRetryBudget(error: unknown, singlePass = false): number {
  if (singlePass) return 0;
  return isDecomposeJsonFormatError(error)
    ? DECOMPOSE_JSON_FORMAT_SELF_HEAL_RETRIES
    : DECOMPOSE_MAX_SELF_HEAL_RETRIES;
}

function clipDecomposeContextText(value: unknown, maxChars = 120): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function buildDecomposeCostumeContext(costumeInfo: unknown, scriptChunk?: string): string {
  const characters = Array.isArray(costumeInfo)
    ? costumeInfo.filter(
        (char) =>
          char &&
          typeof char === "object" &&
          String((char as { name?: unknown }).name || "").trim() &&
          Array.isArray((char as { costumes?: unknown[] }).costumes) &&
          (char as { costumes?: unknown[] }).costumes!.length > 0,
      )
    : [];
  if (!characters.length) return "";

  const scriptText = String(scriptChunk || "").trim();
  const matchedCharacters = scriptText
    ? characters.filter((char) => scriptText.includes(String((char as { name?: unknown }).name || "").trim()))
    : characters;
  const selectedCharacters = matchedCharacters;
  if (!selectedCharacters.length) return "";

  let costumeContext =
    "\n\n---\n\n以下是阶段一识别到的角色服装变体信息（仅列出有多套服装的角色）：\n\n";
  for (const char of selectedCharacters) {
    const name = String((char as { name?: unknown }).name || "").trim();
    const costumes = Array.isArray((char as { costumes?: unknown[] }).costumes)
      ? (char as { costumes?: unknown[] }).costumes!
      : [];
    if (!name || !costumes.length) continue;
    costumeContext += `【${name}】的服装变体：\n`;
    for (const costume of costumes) {
      const label = String((costume as { label?: unknown }).label || "").trim();
      if (!label) continue;
      const description = clipDecomposeContextText(
        (costume as { description?: unknown }).description,
        90,
      );
      costumeContext += description
        ? `  - "${label}"：${description}\n`
        : `  - "${label}"\n`;
    }
    costumeContext += "\n";
  }
  costumeContext +=
    "请在每个分镜的 characterCostumes 字段中，为上述角色指定当前穿着的服装label。务必根据剧本上下文精确判断。\n";
  return costumeContext;
}

function buildDecomposeSceneVariantContext(sceneSettingInfo: unknown, scriptChunk?: string): string {
  const sceneSettings = Array.isArray(sceneSettingInfo)
    ? sceneSettingInfo.filter(
        (sceneSetting) =>
          sceneSetting &&
          typeof sceneSetting === "object" &&
          String((sceneSetting as { name?: unknown }).name || "").trim() &&
          Array.isArray((sceneSetting as { timeVariants?: unknown[] }).timeVariants) &&
          (sceneSetting as { timeVariants?: unknown[] }).timeVariants!.length > 0,
      )
    : [];
  if (!sceneSettings.length) return "";

  const scriptText = String(scriptChunk || "").trim();
  const matchedSceneSettings = scriptText
    ? sceneSettings.filter((sceneSetting) =>
        scriptText.includes(String((sceneSetting as { name?: unknown }).name || "").trim()),
      )
    : sceneSettings;
  const selectedSceneSettings = matchedSceneSettings.length ? matchedSceneSettings : sceneSettings;
  if (!selectedSceneSettings.length) return "";

  let sceneVariantContext =
    "\n\n以下是阶段一识别到的场景时间/天气/环境变体信息（仅列出有多套场景变体的场景）：\n\n";
  for (const sceneSetting of selectedSceneSettings) {
    const name = String((sceneSetting as { name?: unknown }).name || "").trim();
    const timeVariants = Array.isArray((sceneSetting as { timeVariants?: unknown[] }).timeVariants)
      ? (sceneSetting as { timeVariants?: unknown[] }).timeVariants!
      : [];
    if (!name || !timeVariants.length) continue;
    sceneVariantContext += `【${name}】的场景变体：\n`;
    for (const variant of timeVariants) {
      const label = String((variant as { label?: unknown }).label || "").trim();
      if (!label) continue;
      const description = clipDecomposeContextText(
        (variant as { description?: unknown }).description,
        90,
      );
      sceneVariantContext += description
        ? `  - "${label}"：${description}\n`
        : `  - "${label}"\n`;
    }
    sceneVariantContext += "\n";
  }
  sceneVariantContext +=
    "请在命中上述场景变体的分镜里填写 sceneTimeVariantId 字段，值直接使用对应的场景变体 label；没有明确命中时不要硬填。\n";
  return sceneVariantContext;
}

function buildDecomposeSourceAnchorContext(sourceSignals: DecomposeSourceSignals): string {
  const chunks: string[] = [];

  if (sourceSignals.roleAnchors.length > 0) {
    chunks.push(`显式角色锚点：${sourceSignals.roleAnchors.slice(0, 8).join("、")}`);
  }

  if (sourceSignals.explicitDialogueLines.length > 0) {
    chunks.push(
      `检测到 ${sourceSignals.explicitDialogueLines.length} 条显式对白，角色：${
        sourceSignals.dialogueSpeakers.join("、") || "旁白/未署名"
      }`,
    );
    chunks.push(
      `首条显式对白：${clipDecomposeContextText(sourceSignals.explicitDialogueLines[0], 60)}`,
    );
    const lastLine =
      sourceSignals.explicitDialogueLines[sourceSignals.explicitDialogueLines.length - 1] || "";
    if (lastLine && lastLine !== sourceSignals.explicitDialogueLines[0]) {
      chunks.push(`末条显式对白：${clipDecomposeContextText(lastLine, 60)}`);
    }
    chunks.push("要求：原文里的显式对白不能整体漏掉，必须写入 dialogue 字段，不能塞进 description。");
  }

  if (sourceSignals.headPreview.length > 0) {
    chunks.push(
      `开场原文锚点：${sourceSignals.headPreview
        .slice(0, 2)
        .map((line) => clipDecomposeContextText(line, 40))
        .join(" / ")}`,
    );
  }

  if (sourceSignals.tailPreview.length > 0) {
    chunks.push(
      `收束原文锚点：${sourceSignals.tailPreview
        .slice(-2)
        .map((line) => clipDecomposeContextText(line, 40))
        .join(" / ")}`,
    );
  }

  return chunks.length ? `\n\n---\n\n【本集原文锚点（本地确定性提取）】\n${chunks.join("\n")}` : "";
}

function buildDeterministicCrossEpisodeContextForChunk(
  episodeIndex: number,
  episodeSignals: DecomposeSourceSignals[],
): string {
  const prevEpisode = episodeIndex > 0 ? episodeSignals[episodeIndex - 1] || null : null;
  const nextEpisode =
    episodeIndex + 1 < episodeSignals.length ? episodeSignals[episodeIndex + 1] || null : null;

  if (!prevEpisode && !nextEpisode) return "";

  const nearbyCharacters = new Set<string>();
  const chunks: string[] = [];

  if (prevEpisode) {
    prevEpisode.roleAnchors.forEach((name) => nearbyCharacters.add(name));
    prevEpisode.dialogueSpeakers.forEach((name) => nearbyCharacters.add(name));
    chunks.push(
      `前一集（第${episodeIndex}集）结尾原文摘录：\n${prevEpisode.tailPreview
        .map((line) => `- ${clipDecomposeContextText(line, 72)}`)
        .join("\n")}`,
    );
  }

  if (nextEpisode) {
    nextEpisode.roleAnchors.forEach((name) => nearbyCharacters.add(name));
    nextEpisode.dialogueSpeakers.forEach((name) => nearbyCharacters.add(name));
    chunks.push(
      `后一集（第${episodeIndex + 2}集）开头原文摘录：\n${nextEpisode.headPreview
        .map((line) => `- ${clipDecomposeContextText(line, 72)}`)
        .join("\n")}`,
    );
  }

  return `\n\n---\n\n【跨集衔接锚点（确定性提取，仅保留相邻原文）】\n临近集角色：${
    [...nearbyCharacters].join("、") || "无"
  }\n\n${chunks.join("\n\n")}\n重要：当前集开头承接上一集结尾的角色位置、动作和情绪；当前集结尾为下一集开场预留连续动作。角色名、场景名和称呼必须前后一致，segmentLabel 使用 "${
    episodeIndex + 1
  }-N" 格式。`;
}

function buildCrossEpisodeContextForChunk(
  episodeIndex: number,
  episodeResults: (Array<Record<string, unknown>> | null)[],
): string {
  const prevEpisode = (() => {
    for (let index = episodeIndex - 1; index >= 0; index -= 1) {
      if (episodeResults[index]?.length) return { index, scenes: episodeResults[index]! };
    }
    return null;
  })();
  const nextEpisode = (() => {
    for (let index = episodeIndex + 1; index < episodeResults.length; index += 1) {
      if (episodeResults[index]?.length) return { index, scenes: episodeResults[index]! };
    }
    return null;
  })();

  if (!prevEpisode && !nextEpisode) return "";

  const nearbyCharacters = new Set<string>();
  const nearbyScenes = new Set<string>();
  const chunks: string[] = [];

  if (prevEpisode) {
    const lastScenes = prevEpisode.scenes.slice(-2);
    lastScenes.forEach((scene) => {
      (scene?.characters || []).forEach((name: unknown) => {
        const normalized = String(name || "").trim();
        if (normalized) nearbyCharacters.add(normalized);
      });
      const sceneName = String(scene?.sceneName || "").trim();
      if (sceneName) nearbyScenes.add(sceneName);
    });
    chunks.push(
      `前一集（第${prevEpisode.index + 1}集）结尾镜头：\n${lastScenes
        .map(
          (scene: Record<string, unknown>) =>
            `[${scene.segmentLabel}] ${clipDecomposeContextText(scene.sceneName, 24)} | 角色：${
              (scene.characters || []).join("、") || "无"
            } | ${clipDecomposeContextText(scene.description, 96)}`,
        )
        .join("\n")}`,
    );
  }

  if (nextEpisode) {
    const firstScenes = nextEpisode.scenes.slice(0, 2);
    firstScenes.forEach((scene) => {
      (scene?.characters || []).forEach((name: unknown) => {
        const normalized = String(name || "").trim();
        if (normalized) nearbyCharacters.add(normalized);
      });
      const sceneName = String(scene?.sceneName || "").trim();
      if (sceneName) nearbyScenes.add(sceneName);
    });
    chunks.push(
      `后一集（第${nextEpisode.index + 1}集）开头镜头：\n${firstScenes
        .map(
          (scene: Record<string, unknown>) =>
            `[${scene.segmentLabel}] ${clipDecomposeContextText(scene.sceneName, 24)} | 角色：${
              (scene.characters || []).join("、") || "无"
            } | ${clipDecomposeContextText(scene.description, 96)}`,
        )
        .join("\n")}`,
    );
  }

  return `\n\n---\n\n【跨集上下文（只保留相邻集的连续性信息）】
临近集角色：${[...nearbyCharacters].join("、") || "无"}
临近集场景：${[...nearbyScenes].join("、") || "无"}

${chunks.join("\n\n")}
重要：
- 角色名必须与相邻集保持完全一致，不要改变拼写或格式
- 场景名如果是同一地点，必须使用相同名称
- segmentLabel 编号请使用"${episodeIndex + 1}-N"格式`;
}

function buildDecomposeCorrectionHint(lastError: unknown): string {
  const reason = normalizeDecomposeFailureReason(lastError);
  const targetedHints: string[] = [];
  if (isDecomposeJsonFormatError(lastError)) {
    targetedHints.push("只返回标准 JSON，不要 markdown 代码块、解释文本、注释或省略号。");
    targetedHints.push('所有字符串里的英文双引号必须转义成 \\"，不要输出未转义的引号。');
  }
  if (isDecomposeValidationError(lastError)) {
    switch (lastError.kind) {
      case "segment-count-underflow":
        targetedHints.push(
          `当前只拆出 ${lastError.actual ?? "?"} 个 segment，必须至少补到 ${lastError.expected ?? "?"} 个。`,
        );
        break;
      case "segment-count-overflow":
        targetedHints.push(
          `segmentLabel 总数过多，必须收敛到不超过 ${lastError.maxAllowed ?? "?"} 个，避免把小动作拆成额外片段。`,
        );
        break;
      case "shot-count-underflow":
        targetedHints.push(
          `以下片段分镜数偏少：${lastError.segmentLabel || "未知片段"}。请优先补足缺失镜头，不要把多个剧情节点硬塞进同一镜头。`,
        );
        break;
      case "shot-count-overflow":
        targetedHints.push(
          `以下片段分镜数超限：${lastError.segmentLabel || "未知片段"}。请合并重复或弱信息镜头，保留主动作和情绪推进。`,
        );
        break;
      case "segment-duration-mismatch":
        targetedHints.push(
          `每个 segment 的全部分镜 duration 相加必须严格等于 ${lastError.expected ?? SEGMENT_DURATION_SECONDS} 秒。`,
        );
        break;
      case "dialogue-count-overflow":
        targetedHints.push(
          `${lastError.segmentLabel || "当前片段"} 含 ${lastError.actual ?? "?"} 条对白，必须压到 3 条以内；必要时拆到下一段。`,
        );
        break;
      case "dialogue-char-overflow":
        targetedHints.push(
          `${lastError.segmentLabel || "当前片段"} 中单条对白超出 ${lastError.maxAllowed ?? "?"} 字，请拆句并分配到相邻镜头或下一 segment。`,
        );
        if (lastError.linePreview) {
          targetedHints.push(`超限对白片段：${lastError.linePreview}`);
        }
        break;
      case "dialogue-coverage-underflow":
        targetedHints.push("源剧本里检测到了显式对白，但你输出的 dialogue 覆盖不完整。");
        targetedHints.push("请保留原文里的显式对白角色和可听内容，至少不要把 dialogue 整体漏空。");
        if (lastError.linePreview) {
          targetedHints.push(`原文对白锚点：${lastError.linePreview}`);
        }
        break;
      default:
        break;
    }
  }
  if (reason.includes("对白字数超限") || reason.includes("对白条数超限")) {
    targetedHints.push("每个 segment 最多 3 条对白；任何超长对白必须拆到下一个 segment。");
    targetedHints.push("description 字段只写可视画面，不得混入对白、旁白、心声或引号包裹的台词。");
  }
  if (reason.includes("分镜数不足") || reason.includes("片段数不足")) {
    targetedHints.push("优先补足缺失的 segmentLabel 和分镜，不要把多个剧情节点硬塞回同一段。");
  }
  return [
    "",
    "",
    "【上一次输出存在的问题，必须全部修正】",
    reason,
    ...targetedHints,
    "请重新生成完整、合法的 JSON。",
    "不要解释，不要补充说明文字，只返回可解析的完整 JSON。",
  ].join("\n");
}

function buildDecomposeUserText(params: {
  prompt: string;
  script: string;
  costumeContext: string;
  sceneVariantContext: string;
  heading?: string;
  systemPrompt?: unknown;
}): string {
  const {
    prompt,
    script,
    costumeContext,
    sceneVariantContext,
    heading = "以下是用户的剧本",
    systemPrompt,
  } = params;
  const promptPrefix =
    typeof systemPrompt === "string" && systemPrompt.trim()
      ? `${systemPrompt.trim()}\n\n`
      : "";
  return `${promptPrefix}${prompt}\n\n---\n\n${heading}：\n\n${script}${costumeContext}${sceneVariantContext}`;
}

function buildDecomposeRequestContents(userText: string, systemPrompt?: unknown) {
  const contents: Array<{ role: "system" | "user"; parts: Array<{ text: string }> }> = [];
  const normalizedSystemPrompt = typeof systemPrompt === "string" ? systemPrompt.trim() : "";
  if (normalizedSystemPrompt) {
    contents.push({ role: "system", parts: [{ text: normalizedSystemPrompt }] });
  }
  contents.push({ role: "user", parts: [{ text: userText }] });
  return contents;
}

export function buildIncompleteDecomposeError(
  failedChunks: number[],
  totalChunks: number,
  failureReasons?: Record<number, string>,
  chunkLabels?: string[],
): Error {
  const failedLabels = failedChunks
    .map((index) => chunkLabels?.[index] || `第 ${index + 1} 集`)
    .join("、");
  const succeededCount = Math.max(0, totalChunks - failedChunks.length);
  const reasonSummary = failureReasons
    ? failedChunks
        .map((index) => {
          const reason = failureReasons[index];
          const label = chunkLabels?.[index] || `第 ${index + 1} 集`;
          return reason ? `${label}：${reason}` : "";
        })
        .filter(Boolean)
        .join("；")
    : "";
  return new Error(
    `剧本拆解未完成：${failedLabels} 拆解失败，仅完成 ${succeededCount}/${totalChunks} 集。${reasonSummary ? `最近失败原因：${reasonSummary}。` : ""}请重试剧本拆解，避免保存不完整分镜。`,
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
      return body?.decomposeEngine === "current"
        ? localDecompose(
            body,
            options?.onProgress,
            options?.abortSignal,
            options?.onStreamText,
          )
        : localDecompose0444(
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
      return localEnhancePromptV2(body, options?.abortSignal);
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

const EXTRACTED_COSTUME_CORE_TERMS = [
  "日常装",
  "便装",
  "便服",
  "常服",
  "校服",
  "制服",
  "婚纱",
  "礼服",
  "旗袍",
  "华服",
  "法袍",
  "道袍",
  "睡衣",
  "浴袍",
  "长裙",
  "短裙",
  "红衣",
  "白衣",
  "黑衣",
  "青衣",
  "战甲",
  "铠甲",
  "盔甲",
  "披风",
  "斗篷",
  "官服",
  "军装",
  "西装",
].sort((a, b) => b.length - a.length);

const EXTRACTED_COSTUME_GENERIC_BASELINE_PATTERN = /^(?:常态|常规|普通|默认|基础|原始|原貌|本体|平时|日常)(?:状态|形态|姿态|版|款)?$/;
const EXTRACTED_SCENE_GENERIC_BASELINE_PATTERN = /^(?:日常|常态|常规|普通|默认|基础|平时|原貌)(?:状态|场景|版|款)?$/;
const EXTRACTED_COSTUME_VISUAL_SIGNAL_PATTERN =
  /(?:装|服装|校服|制服|便服|常服|礼服|华服|官服|军装|囚服|丧服|法服|衣|袍|裙|甲|冠|纱|披风|斗篷|面具|发髻|发型|妆容|战损|破损|染血|血污|神化|新神|成神|黑化|魔化|入魔|白发|银发|少年|幼年|成年|老年)/;
const EXTRACTED_SCENE_VISUAL_SIGNAL_PATTERN =
  /(?:夜|晨|昏|午|日间|白天|白昼|雨|雪|雾|晴|阴|风|雷|霾|春|夏|秋|冬|断电|停电|熄灯|火灾|火场|火后|战后|战斗后|废墟|毁坏|坍塌|残破|雨后|雪后|洪水|夕阳|黎明|霓虹|灯火)/;

function normalizeExtractedEntityName(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeExtractedVariantLabel(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[【】「」『』《》()（）[\]{}"'“”‘’、，,。.!！?？:：;；\s_-]+/g, "")
    .replace(/(?:状态|形态|姿态|版本|版|造型|模式)$/g, "")
    .replace(/颜色/g, "色")
    .replace(/暗红色/g, "暗红")
    .replace(/绛红色/g, "绛红")
    .replace(/深红色/g, "深红");
}

function buildExtractedVariantSignalText(label: string, description: string): string {
  return normalizeExtractedVariantLabel(`${label} ${description}`);
}

function resolveExtractedCostumeVariantStateKey(normalized: string): string {
  if (/(?:神化|新神|成神)/.test(normalized)) return "神化";
  if (/(?:魔化|入魔|妖化|兽化|龙化)/.test(normalized)) return "魔化";
  if (/(?:黑化)/.test(normalized)) return "黑化";
  if (/(?:战损|破损|染血|血污|受伤|负伤)/.test(normalized)) return "战损";
  if (/(?:白发|银发)/.test(normalized)) return "白发";
  if (/(?:伪装|易容)/.test(normalized)) return "伪装";
  if (/(?:男装)/.test(normalized)) return "男装";
  if (/(?:女装)/.test(normalized)) return "女装";
  if (/(?:少年|幼年|童年)/.test(normalized)) return "少年";
  if (/(?:成年)/.test(normalized)) return "成年";
  if (/(?:老年|暮年)/.test(normalized)) return "老年";
  if (/(?:病弱|虚弱)/.test(normalized)) return "病弱";
  return "";
}

function shouldKeepExtractedVariantCandidate(
  label: string,
  description: string,
  kind: "costume" | "scene-time",
): boolean {
  const normalizedLabel = normalizeExtractedVariantLabel(label);
  if (!normalizedLabel) return false;

  const signalText = buildExtractedVariantSignalText(label, description);
  if (kind === "costume") {
    if (EXTRACTED_COSTUME_GENERIC_BASELINE_PATTERN.test(normalizedLabel)) return false;
    return EXTRACTED_COSTUME_VISUAL_SIGNAL_PATTERN.test(signalText);
  }

  if (EXTRACTED_SCENE_GENERIC_BASELINE_PATTERN.test(normalizedLabel)) return false;
  return EXTRACTED_SCENE_VISUAL_SIGNAL_PATTERN.test(signalText);
}

function resolveExtractedCostumeVariantKey(label: string): string {
  const normalized = normalizeExtractedVariantLabel(label);
  if (!normalized) return "";

  const core = EXTRACTED_COSTUME_CORE_TERMS.find((term) => normalized.includes(term));
  const state = resolveExtractedCostumeVariantStateKey(normalized);
  if (core) {
    return state ? `${state}:${core}` : core;
  }
  return state || normalized;
}

function resolveExtractedSceneVariantKey(label: string): string {
  const normalized = normalizeExtractedVariantLabel(label);
  if (!normalized) return "";

  const time =
    /(?:夜|夜晚|夜间|夜景|雨夜|雷雨夜|深夜)/.test(normalized) ? "夜间" :
    /(?:清晨|晨间|早晨|黎明|拂晓)/.test(normalized) ? "清晨" :
    /(?:黄昏|傍晚|夕阳|日落)/.test(normalized) ? "黄昏" :
    /(?:正午|中午|午间)/.test(normalized) ? "正午" :
    /(?:日间|白天|白昼|日景|晴天|上午|下午)/.test(normalized) ? "日间" :
    "";
  const weather =
    /(?:雷雨|暴雨|大雨|雨夜|雨天|雨中|下雨|雨)/.test(normalized) ? "雨" :
    /(?:暴雪|大雪|雪夜|雪天|雪中|下雪|雪)/.test(normalized) ? "雪" :
    /(?:浓雾|雾天|雾中|雾)/.test(normalized) ? "雾" :
    /(?:阴天|阴沉|阴云)/.test(normalized) ? "阴" :
    /(?:晴天|晴朗)/.test(normalized) ? "晴" :
    "";
  const state =
    /(?:断电|停电|熄灯)/.test(normalized) ? "断电" :
    /(?:火灾后|火灾|火场|火后)/.test(normalized) ? "火灾" :
    /(?:废墟|战斗后|战后|毁坏|坍塌)/.test(normalized) ? "毁坏" :
    "";

  return [weather, time, state].filter(Boolean).join(":") || normalized;
}

function areExtractedVariantLabelsEquivalent(
  leftLabel: string,
  rightLabel: string,
  kind: "costume" | "scene-time",
): boolean {
  const left = normalizeExtractedVariantLabel(leftLabel);
  const right = normalizeExtractedVariantLabel(rightLabel);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftKey = kind === "costume"
    ? resolveExtractedCostumeVariantKey(leftLabel)
    : resolveExtractedSceneVariantKey(leftLabel);
  const rightKey = kind === "costume"
    ? resolveExtractedCostumeVariantKey(rightLabel)
    : resolveExtractedSceneVariantKey(rightLabel);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function chooseMergedExtractedVariantLabel(
  currentLabel: string,
  nextLabel: string,
  kind: "costume" | "scene-time",
): string {
  const current = normalizeExtractedVariantLabel(currentLabel);
  const next = normalizeExtractedVariantLabel(nextLabel);
  if (!current) return nextLabel;
  if (!next) return currentLabel;

  const currentKey = kind === "costume"
    ? resolveExtractedCostumeVariantKey(currentLabel)
    : resolveExtractedSceneVariantKey(currentLabel);
  const nextKey = kind === "costume"
    ? resolveExtractedCostumeVariantKey(nextLabel)
    : resolveExtractedSceneVariantKey(nextLabel);
  if (currentKey && currentKey === nextKey) {
    if (current === currentKey) return currentLabel;
    if (next === nextKey) return nextLabel;
    return currentLabel.trim().length <= nextLabel.trim().length ? currentLabel : nextLabel;
  }
  if (next.includes(current) && next.length > current.length) return nextLabel;
  return currentLabel;
}

function chooseMergedExtractedDescription(currentDescription: string, nextDescription: string): string {
  const current = currentDescription.trim();
  const next = nextDescription.trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function dedupeExtractedVariants(
  rawVariants: unknown,
  kind: "costume" | "scene-time",
  fallbackPrefix: string,
): Array<{ label: string; description: string }> | undefined {
  if (!Array.isArray(rawVariants) || rawVariants.length === 0) return undefined;

  const deduped: Array<{ label: string; description: string }> = [];
  rawVariants.forEach((variant, index) => {
    if (!variant || typeof variant !== "object") return;
    const label = String((variant as { label?: unknown }).label || "").trim() || `${fallbackPrefix} ${index + 1}`;
    const description = String((variant as { description?: unknown }).description || "").trim();
    const existingIndex = deduped.findIndex((item) =>
      areExtractedVariantLabelsEquivalent(item.label, label, kind),
    );

    if (existingIndex < 0) {
      if (!shouldKeepExtractedVariantCandidate(label, description, kind)) return;
      deduped.push({ label, description });
      return;
    }

    deduped[existingIndex] = {
      label: chooseMergedExtractedVariantLabel(deduped[existingIndex]!.label, label, kind),
      description: chooseMergedExtractedDescription(deduped[existingIndex]!.description, description),
    };
  });

  return deduped.length ? deduped : undefined;
}

async function filterWeaklyDistinctExtractedEntitiesWithQa(params: {
  model: string;
  characters: Array<{ name: string; description: string; costumes?: Array<{ label: string; description: string }> }>;
  sceneSettings: Array<{ name: string; description: string; timeVariants?: Array<{ label: string; description: string }> }>;
}): Promise<{
  characters: Array<{ name: string; description: string; costumes?: Array<{ label: string; description: string }> }>;
  sceneSettings: Array<{ name: string; description: string; timeVariants?: Array<{ label: string; description: string }> }>;
}> {
  const qaCharacters = params.characters
    .filter((character) => (character.costumes?.length ?? 0) > 0)
    .map((character) => ({
      name: character.name,
      baseDescription: character.description,
      variants: character.costumes?.map((costume) => ({
        label: costume.label,
        description: costume.description,
      })) || [],
    }));
  const qaSceneSettings = params.sceneSettings
    .filter((sceneSetting) => (sceneSetting.timeVariants?.length ?? 0) > 0)
    .map((sceneSetting) => ({
      name: sceneSetting.name,
      baseDescription: sceneSetting.description,
      variants: sceneSetting.timeVariants?.map((variant) => ({
        label: variant.label,
        description: variant.description,
      })) || [],
    }));

  if (!qaCharacters.length && !qaSceneSettings.length) {
    return {
      characters: params.characters,
      sceneSettings: params.sceneSettings,
    };
  }

  const prompt = [
    "You are a strict QA reviewer for extracted reference variants in an AI video workflow.",
    "Each entity has a base/main description and extracted variants.",
    "Keep a variant only when it is visually distinct enough from the base/main entity to deserve a separate reference image.",
    "Drop variants when the difference is weak, generic, mood-only, alias-like, or likely to generate an image that looks almost the same as the base/main image.",
    "Keep variants when the difference is large and visually actionable, such as clear costume, silhouette, damage, accessory, age-state, weather, lighting, time-of-day, destruction, or environment changes.",
    "Be conservative: if the difference is weak or ambiguous, drop it here. Strong variants can continue to downstream image QA later.",
    "Return JSON only with this schema:",
    '{"characters":[{"name":"entity name","keepCostumeLabels":["label 1"]}],"sceneSettings":[{"name":"entity name","keepTimeVariantLabels":["label 1"]}]}',
    "Only include labels that should be kept. If an entity has no strong variants, omit it or return an empty keep list.",
    "Input JSON:",
    JSON.stringify({
      characters: qaCharacters,
      sceneSettings: qaSceneSettings,
    }),
  ].join("\n");

  try {
    const data = await callGemini(
      params.model,
      [{ role: "user", parts: [{ text: prompt }] }],
      {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
      AbortSignal.timeout(EXTRACTED_VARIANT_QA_TIMEOUT_MS),
    );
    const parsed = parseJsonResponseLoose<{
      characters?: Array<{ name?: unknown; keepCostumeLabels?: unknown }>;
      sceneSettings?: Array<{ name?: unknown; keepTimeVariantLabels?: unknown }>;
    }>(extractText(data));
    const reviewedCharacters = Array.isArray(parsed?.characters) ? parsed.characters : undefined;
    const reviewedSceneSettings = Array.isArray(parsed?.sceneSettings) ? parsed.sceneSettings : undefined;
    const hasStructuredReview =
      Boolean(
        reviewedCharacters?.some(
          (item) => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "keepCostumeLabels"),
        ) ||
        reviewedSceneSettings?.some(
          (item) =>
            item &&
            typeof item === "object" &&
            Object.prototype.hasOwnProperty.call(item, "keepTimeVariantLabels"),
        ) ||
        (reviewedCharacters && reviewedCharacters.length === 0) ||
        (reviewedSceneSettings && reviewedSceneSettings.length === 0),
      );
    if (!hasStructuredReview) {
      return {
        characters: params.characters,
        sceneSettings: params.sceneSettings,
      };
    }

    const characterKeepMap = new Map<string, string[]>();
    reviewedCharacters?.forEach((character) => {
      const name = String(character?.name || "").trim();
      const keepLabels = Array.isArray(character?.keepCostumeLabels)
        ? character.keepCostumeLabels
          .filter((label): label is string => typeof label === "string")
          .map((label) => label.trim())
          .filter(Boolean)
        : [];
      if (!name) return;
      characterKeepMap.set(normalizeExtractedEntityName(name), keepLabels);
    });

    const sceneKeepMap = new Map<string, string[]>();
    reviewedSceneSettings?.forEach((sceneSetting) => {
      const name = String(sceneSetting?.name || "").trim();
      const keepLabels = Array.isArray(sceneSetting?.keepTimeVariantLabels)
        ? sceneSetting.keepTimeVariantLabels
          .filter((label): label is string => typeof label === "string")
          .map((label) => label.trim())
          .filter(Boolean)
        : [];
      if (!name) return;
      sceneKeepMap.set(normalizeExtractedEntityName(name), keepLabels);
    });

    return {
      characters: params.characters.map((character) => {
        if (!character.costumes?.length) return character;
        const keepLabels = characterKeepMap.get(normalizeExtractedEntityName(character.name)) || [];
        const costumes = character.costumes.filter((costume) =>
          keepLabels.some((label) => areExtractedVariantLabelsEquivalent(label, costume.label, "costume")),
        );
        return costumes.length ? { ...character, costumes } : { ...character, costumes: undefined };
      }),
      sceneSettings: params.sceneSettings.map((sceneSetting) => {
        if (!sceneSetting.timeVariants?.length) return sceneSetting;
        const keepLabels = sceneKeepMap.get(normalizeExtractedEntityName(sceneSetting.name)) || [];
        const timeVariants = sceneSetting.timeVariants.filter((variant) =>
          keepLabels.some((label) => areExtractedVariantLabelsEquivalent(label, variant.label, "scene-time")),
        );
        return timeVariants.length ? { ...sceneSetting, timeVariants } : { ...sceneSetting, timeVariants: undefined };
      }),
    };
  } catch {
    return {
      characters: params.characters,
      sceneSettings: params.sceneSettings,
    };
  }
}

function dedupeExtractedEntities(payload: {
  characters?: unknown;
  sceneSettings?: unknown;
}): {
  characters: Array<{ name: string; description: string; costumes?: Array<{ label: string; description: string }> }>;
  sceneSettings: Array<{ name: string; description: string; timeVariants?: Array<{ label: string; description: string }> }>;
} {
  const dedupedCharacters: Array<{
    name: string;
    description: string;
    costumes?: Array<{ label: string; description: string }>;
  }> = [];
  const dedupedSceneSettings: Array<{
    name: string;
    description: string;
    timeVariants?: Array<{ label: string; description: string }>;
  }> = [];

  if (Array.isArray(payload.characters)) {
    payload.characters.forEach((character, index) => {
      if (!character || typeof character !== "object") return;
      const name = String((character as { name?: unknown }).name || "").trim() || `角色 ${index + 1}`;
      if (isNarrationSpeaker(name)) return;
      const nextCharacter = {
        name,
        description: String((character as { description?: unknown }).description || "").trim(),
        costumes: dedupeExtractedVariants((character as { costumes?: unknown }).costumes, "costume", "角色变体"),
      };
      const existingIndex = dedupedCharacters.findIndex((item) =>
        normalizeExtractedEntityName(item.name) === normalizeExtractedEntityName(name),
      );

      if (existingIndex < 0) {
        dedupedCharacters.push(nextCharacter);
        return;
      }

      const existing = dedupedCharacters[existingIndex]!;
      dedupedCharacters[existingIndex] = {
        name: existing.name.length <= nextCharacter.name.length ? existing.name : nextCharacter.name,
        description: chooseMergedExtractedDescription(existing.description, nextCharacter.description),
        costumes: dedupeExtractedVariants(
          [...(existing.costumes || []), ...(nextCharacter.costumes || [])],
          "costume",
          "角色变体",
        ),
      };
    });
  }

  if (Array.isArray(payload.sceneSettings)) {
    payload.sceneSettings.forEach((sceneSetting, index) => {
      if (!sceneSetting || typeof sceneSetting !== "object") return;
      const name = String((sceneSetting as { name?: unknown }).name || "").trim() || `场景 ${index + 1}`;
      const nextSceneSetting = {
        name,
        description: String((sceneSetting as { description?: unknown }).description || "").trim(),
        timeVariants: dedupeExtractedVariants(
          (sceneSetting as { timeVariants?: unknown }).timeVariants,
          "scene-time",
          "场景变体",
        ),
      };
      const existingIndex = dedupedSceneSettings.findIndex((item) =>
        normalizeExtractedEntityName(item.name) === normalizeExtractedEntityName(name),
      );

      if (existingIndex < 0) {
        dedupedSceneSettings.push(nextSceneSetting);
        return;
      }

      const existing = dedupedSceneSettings[existingIndex]!;
      dedupedSceneSettings[existingIndex] = {
        name: existing.name.length <= nextSceneSetting.name.length ? existing.name : nextSceneSetting.name,
        description: chooseMergedExtractedDescription(existing.description, nextSceneSetting.description),
        timeVariants: dedupeExtractedVariants(
          [...(existing.timeVariants || []), ...(nextSceneSetting.timeVariants || [])],
          "scene-time",
          "场景变体",
        ),
      };
    });
  }

  return {
    characters: dedupedCharacters,
    sceneSettings: dedupedSceneSettings,
  };
}

async function localExtract(body: any, onStreamText?: (text: string) => void) {
  const { script, model: requestedModel, extractionHint } = body;
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

  const hintBlock =
    typeof extractionHint === "string" && extractionHint.trim()
      ? `\n\n【补漏提示】\n${extractionHint.trim()}`
      : "";
  const promptText = `${EXTRACTION_PROMPT}${hintBlock}\n\n---\n\n以下是用户的剧本：\n\n${script}${preScanHint}`;

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

  const dedupedEntities = dedupeExtractedEntities({
    characters: parsed.characters,
    sceneSettings: parsed.sceneSettings,
  });
  const qaFilteredEntities = await filterWeaklyDistinctExtractedEntitiesWithQa({
    model,
    characters: dedupedEntities.characters,
    sceneSettings: dedupedEntities.sceneSettings,
  });

  return {
    characters: qaFilteredEntities.characters,
    sceneSettings: qaFilteredEntities.sceneSettings,
  };
}

function buildLegacyDecomposePrompt(
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

function buildLegacyDecomposeCostumeContext(costumeInfo: unknown): string {
  if (!Array.isArray(costumeInfo) || costumeInfo.length === 0) return "";

  let costumeContext =
    "\n\n---\n\n以下是阶段一识别到的角色服装变体信息（仅列出有多套服装的角色）：\n\n";
  for (const character of costumeInfo) {
    if (!character || typeof character !== "object") continue;
    const name = String((character as { name?: unknown }).name || "").trim();
    const costumes = Array.isArray((character as { costumes?: unknown[] }).costumes)
      ? (character as { costumes?: unknown[] }).costumes
      : [];
    if (!name || !costumes.length) continue;
    costumeContext += `【${name}】的服装变体：\n`;
    for (const costume of costumes) {
      if (!costume || typeof costume !== "object") continue;
      const label = String((costume as { label?: unknown }).label || "").trim();
      if (!label) continue;
      const description = String((costume as { description?: unknown }).description || "").trim();
      costumeContext += description
        ? `  - "${label}"：${description}\n`
        : `  - "${label}"\n`;
    }
    costumeContext += "\n";
  }
  costumeContext +=
    "请在每个分镜的 characterCostumes 字段中，为上述角色指定当前穿着的服装label。务必根据剧本上下文精确判断。\n";
  return costumeContext;
}

function buildLegacyDecomposeSceneVariantContext(sceneSettingInfo: unknown): string {
  const sceneSettings = Array.isArray(sceneSettingInfo)
    ? sceneSettingInfo.filter(
        (sceneSetting) =>
          sceneSetting &&
          typeof sceneSetting === "object" &&
          String((sceneSetting as { name?: unknown }).name || "").trim() &&
          Array.isArray((sceneSetting as { timeVariants?: unknown[] }).timeVariants) &&
          (sceneSetting as { timeVariants?: unknown[] }).timeVariants!.length > 0,
      )
    : [];
  if (!sceneSettings.length) return "";

  let sceneVariantContext =
    "\n\n---\n\n以下是阶段一识别到的场景时间/天气/环境变体信息（仅列出有多套场景变体的场景）：\n\n";
  for (const sceneSetting of sceneSettings) {
    if (!sceneSetting || typeof sceneSetting !== "object") continue;
    const name = String((sceneSetting as { name?: unknown }).name || "").trim();
    const timeVariants = Array.isArray((sceneSetting as { timeVariants?: unknown[] }).timeVariants)
      ? (sceneSetting as { timeVariants?: unknown[] }).timeVariants
      : [];
    if (!name || !timeVariants.length) continue;
    sceneVariantContext += `【${name}】的场景变体：\n`;
    for (const variant of timeVariants) {
      if (!variant || typeof variant !== "object") continue;
      const label = String((variant as { label?: unknown }).label || "").trim();
      if (!label) continue;
      const description = String((variant as { description?: unknown }).description || "").trim();
      sceneVariantContext += description
        ? `  - "${label}"：${description}\n`
        : `  - "${label}"\n`;
    }
    sceneVariantContext += "\n";
  }
  sceneVariantContext +=
    "请在命中上述场景变体的分镜里填写 sceneTimeVariantId 字段，值直接使用对应的场景变体 label；没有明确命中时不要硬填。\n";
  return sceneVariantContext;
}

function buildLegacyCrossEpisodeContextForChunk(
  episodeIndex: number,
  episodeResults: (Array<Record<string, unknown>> | null)[],
): string {
  const completedOther: Array<{ idx: number; scenes: Array<Record<string, unknown>> }> = [];
  for (let index = 0; index < episodeResults.length; index += 1) {
    if (index !== episodeIndex && episodeResults[index]?.length) {
      completedOther.push({ idx: index, scenes: episodeResults[index]! });
    }
  }
  if (!completedOther.length) return "";

  const allOtherScenes = completedOther.flatMap((entry) => entry.scenes);
  const otherCharacters = [
    ...new Set(
      allOtherScenes.flatMap((scene) =>
        Array.isArray(scene?.characters)
          ? scene.characters.map((name) => String(name || "").trim()).filter(Boolean)
          : [],
      ),
    ),
  ];
  const otherSceneNames = [
    ...new Set(
      allOtherScenes
        .map((scene) => String(scene?.sceneName || "").trim())
        .filter(Boolean),
    ),
  ];

  const prevEpisode = completedOther
    .filter((entry) => entry.idx < episodeIndex)
    .sort((left, right) => right.idx - left.idx)[0];
  const nextEpisode = completedOther
    .filter((entry) => entry.idx > episodeIndex)
    .sort((left, right) => left.idx - right.idx)[0];

  let contextScenesDesc = "";
  if (prevEpisode) {
    const lastScenes = prevEpisode.scenes.slice(-3);
    contextScenesDesc +=
      `前一集（第${prevEpisode.idx + 1}集）最后几个分镜：\n` +
      lastScenes
        .map(
          (scene) =>
            `[分镜${scene.sceneNumber}] 片段${scene.segmentLabel} | 场景：${scene.sceneName} | 角色：${(scene.characters || []).join("、")} | ${String(scene.description || "").trim()}`,
        )
        .join("\n") +
      "\n";
  }
  if (nextEpisode) {
    const firstScenes = nextEpisode.scenes.slice(0, 3);
    contextScenesDesc +=
      `后一集（第${nextEpisode.idx + 1}集）开头几个分镜：\n` +
      firstScenes
        .map(
          (scene) =>
            `[分镜${scene.sceneNumber}] 片段${scene.segmentLabel} | 场景：${scene.sceneName} | 角色：${(scene.characters || []).join("、")} | ${String(scene.description || "").trim()}`,
        )
        .join("\n") +
      "\n";
  }

  return `\n\n---\n\n【跨集上下文（必须保持一致性）】
已完成的其他集数中出现的角色：${otherCharacters.join("、") || "无"}
已完成的其他集数中出现的场景：${otherSceneNames.join("、") || "无"}

${contextScenesDesc}
重要：
- 角色名必须与其他集数保持完全一致，不要改变拼写或格式
- 场景名如果是同一地点，必须使用相同名称
- segmentLabel 编号请使用"${episodeIndex + 1}-N"格式`;
}

async function localDecompose0444(
  body: any,
  onProgress?: (partialData: any) => void,
  abortSignal?: AbortSignal,
  onStreamText?: (text: string) => void,
) {
  const {
    script,
    model: requestedModel,
    costumeInfo,
    sceneSettingInfo,
    videoPace,
    segmentsPerEpisode,
    episodeDuration,
    existingScenes,
    retryMissingEpisodes,
  } = body;
  if (!script) throw new Error("缺少剧本内容");

  const model = requestedModel || readStoredDecomposeModel() || DEFAULT_DECOMPOSE_MODEL;
  const costumeContext = buildLegacyDecomposeCostumeContext(costumeInfo);
  const sceneVariantContext = buildLegacyDecomposeSceneVariantContext(sceneSettingInfo);
  const splitResult = splitScriptByEpisodes(script);
  const episodes = splitResult.chunks;

  if (episodes.length > 1) {
    const { maxRetries: maxChunkRetries, delayMs: chunkRetryDelayMs } =
      getNetworkRetrySettings();
    const allScenes: any[] = [];
    const failedChunks: number[] = [];

    const totalSegments = segmentsPerEpisode || 5;
    let chunkSegmentCounts: number[];
    if (splitResult.isRealEpisodes) {
      chunkSegmentCounts = episodes.map(() => totalSegments);
    } else {
      const totalChars = episodes.reduce((sum, episodeScript) => sum + episodeScript.length, 0);
      const rawCounts = episodes.map(
        (episodeScript) => (episodeScript.length / totalChars) * totalSegments,
      );
      chunkSegmentCounts = rawCounts.map((count) => Math.max(1, Math.round(count)));
      let diff = totalSegments - chunkSegmentCounts.reduce((sum, count) => sum + count, 0);
      while (diff !== 0) {
        if (diff > 0) {
          let bestIndex = 0;
          let bestFraction = -1;
          for (let index = 0; index < rawCounts.length; index += 1) {
            const fraction = rawCounts[index] - Math.floor(rawCounts[index]);
            if (fraction > bestFraction && chunkSegmentCounts[index] < rawCounts[index] + 1) {
              bestFraction = fraction;
              bestIndex = index;
            }
          }
          chunkSegmentCounts[bestIndex] += 1;
          diff -= 1;
        } else {
          let bestIndex = 0;
          let bestFraction = 2;
          for (let index = 0; index < rawCounts.length; index += 1) {
            const fraction = rawCounts[index] - Math.floor(rawCounts[index]);
            if (fraction < bestFraction && chunkSegmentCounts[index] > 1) {
              bestFraction = fraction;
              bestIndex = index;
            }
          }
          chunkSegmentCounts[bestIndex] -= 1;
          diff += 1;
        }
      }
    }

    const episodeResults: (any[] | null)[] = new Array(episodes.length).fill(null);
    if (retryMissingEpisodes && splitResult.isRealEpisodes && Array.isArray(existingScenes)) {
      const existingByEpisode = new Map<number, any[]>();
      for (const scene of existingScenes) {
        const episodeNumber = getSegmentEpisodeNumber(scene?.segmentLabel);
        if (!episodeNumber || episodeNumber < 1 || episodeNumber > episodes.length) continue;
        const group = existingByEpisode.get(episodeNumber) || [];
        group.push(scene);
        existingByEpisode.set(episodeNumber, group);
      }

      for (let index = 0; index < episodes.length; index += 1) {
        const episodeNumber = index + 1;
        const scenesForEpisode = existingByEpisode.get(episodeNumber) || [];
        if (!scenesForEpisode.length) continue;

        const segmentCount = new Set(
          scenesForEpisode
            .map((scene) => String(scene?.segmentLabel || "").trim())
            .filter(Boolean),
        ).size;
        if (segmentCount < chunkSegmentCounts[index]) continue;

        episodeResults[index] = scenesForEpisode.map((scene) => ({ ...scene }));
      }
    }

    const targetEpisodeIndexes = episodes
      .map((_, index) => index)
      .filter((index) => !episodeResults[index]);

    if (targetEpisodeIndexes.length < episodes.length) {
      let nextSceneNumber = 1;
      const mergedScenes: any[] = [];
      for (let index = 0; index < episodeResults.length; index += 1) {
        if (!episodeResults[index]) continue;
        for (const scene of episodeResults[index]!) {
          scene.sceneNumber = nextSceneNumber++;
          mergedScenes.push(scene);
        }
      }
      allScenes.push(...mergedScenes);
    }

    if (onProgress) {
      onProgress({
        scenes: allScenes,
        chunkIndex: -1,
        totalChunks: episodes.length,
        status: "init",
        failedChunks,
        chunkSegmentCounts,
        isRealEpisodes: splitResult.isRealEpisodes,
        originallyEpisodes: splitResult.originallyEpisodes,
        episodes,
        costumeContext,
        model,
        prompt: buildLegacyDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
        videoPace,
      });
    }

    if (targetEpisodeIndexes.length === 0) {
      let nextSceneNumber = 1;
      const finalScenes: any[] = [];
      for (const scenesForEpisode of episodeResults) {
        if (!scenesForEpisode) continue;
        for (const scene of scenesForEpisode) {
          scene.sceneNumber = nextSceneNumber++;
          finalScenes.push(scene);
        }
      }
      return {
        scenes: finalScenes,
        failedChunks,
        episodes,
        costumeContext,
        model,
        prompt: buildLegacyDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
        chunkSegmentCounts,
        isRealEpisodes: splitResult.isRealEpisodes,
        originallyEpisodes: splitResult.originallyEpisodes,
        videoPace,
      };
    }

    const semaphore = { current: 0, queue: [] as Array<() => void> };
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (semaphore.current < LEGACY_DECOMPOSE_MAX_PARALLEL) {
          semaphore.current += 1;
          resolve();
        } else {
          semaphore.queue.push(() => {
            semaphore.current += 1;
            resolve();
          });
        }
      });
    const release = () => {
      semaphore.current -= 1;
      if (semaphore.queue.length > 0) semaphore.queue.shift()?.();
    };

    const processEpisode = async (episodeIndex: number) => {
      if (abortSignal?.aborted) {
        onProgress?.({
          scenes: allScenes,
          chunkIndex: episodeIndex,
          totalChunks: episodes.length,
          status: "cancelled",
          failedChunks,
        });
        return;
      }

      await acquire();
      if (abortSignal?.aborted) {
        release();
        onProgress?.({
          scenes: allScenes,
          chunkIndex: episodeIndex,
          totalChunks: episodes.length,
          status: "cancelled",
          failedChunks,
        });
        return;
      }

      const episodeScript = episodes[episodeIndex];
      const chunkSegments = chunkSegmentCounts[episodeIndex];
      const epPrefix = episodes.length > 1 ? `${episodeIndex + 1}-` : "";
      const chunkPrompt = buildLegacyDecomposePrompt(
        videoPace,
        chunkSegments,
        episodeDuration,
      );

      onProgress?.({
        scenes: allScenes,
        chunkIndex: episodeIndex,
        totalChunks: episodes.length,
        status: "processing",
        failedChunks,
      });

      let chunkAttempt = 0;
      let lastChunkError: unknown = null;

      while (chunkAttempt <= maxChunkRetries) {
        if (chunkAttempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunkRetryDelayMs));
          if (abortSignal?.aborted) break;
          onProgress?.({
            scenes: allScenes,
            chunkIndex: episodeIndex,
            totalChunks: episodes.length,
            status: "processing",
            failedChunks,
            retryAttempt: chunkAttempt,
          });
        }

        try {
          const crossEpisodeContext = buildLegacyCrossEpisodeContextForChunk(
            episodeIndex,
            episodeResults,
          );
          const chunkLabel = splitResult.isRealEpisodes
            ? `以下是第${episodeIndex + 1}集剧本（共${episodes.length}集）`
            : `以下是剧本的第${episodeIndex + 1}集（共${episodes.length}集，本集需要恰好${chunkSegments}个片段）。segmentLabel请使用"${episodeIndex + 1}-N"格式（如"${episodeIndex + 1}-1","${episodeIndex + 1}-2"等）`;
          const userText = `${chunkPrompt}\n\n---\n\n${chunkLabel}：\n\n${episodeScript}${costumeContext}${sceneVariantContext}${crossEpisodeContext}`;
          const correctionHint =
            chunkAttempt > 0 && lastChunkError
              ? `\n\n【上一次输出存在的问题，必须全部修正】\n${String((lastChunkError as Error)?.message || lastChunkError)}\n请直接返回修正后的完整 JSON，不要解释。`
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
          if (!resultText) {
            throw new Error(
              `第${episodeIndex + 1}${splitResult.isRealEpisodes ? "集" : "段"}拆解失败：AI 未返回内容`,
            );
          }

          const episodeScenes = parseDecomposeResult(resultText);
          for (const scene of episodeScenes) {
            if (epPrefix) {
              scene.segmentLabel = normalizeEpisodeSegmentLabel(
                scene.segmentLabel,
                episodeIndex + 1,
              );
            }
          }

          episodeResults[episodeIndex] = finalizeDecomposeScenes(episodeScenes, {
            segmentsTarget: chunkSegments,
            videoPace,
          });

          const mergedScenes: any[] = [];
          let nextSceneNumber = 1;
          for (let index = 0; index < episodeResults.length; index += 1) {
            if (!episodeResults[index]) continue;
            for (const scene of episodeResults[index]!) {
              scene.sceneNumber = nextSceneNumber++;
              mergedScenes.push(scene);
            }
          }
          allScenes.length = 0;
          allScenes.push(...mergedScenes);

          onProgress?.({
            scenes: [...allScenes],
            chunkIndex: episodeIndex,
            totalChunks: episodes.length,
            status: "done",
            failedChunks,
          });
          lastChunkError = null;
          break;
        } catch (error) {
          lastChunkError = error;
          chunkAttempt += 1;
          if (chunkAttempt > maxChunkRetries) {
            failedChunks.push(episodeIndex);
            onProgress?.({
              scenes: [...allScenes],
              chunkIndex: episodeIndex,
              totalChunks: episodes.length,
              status: "failed",
              failedChunks,
              error: String((error as Error)?.message || error || "未知错误"),
            });
          }
        }
      }

      release();
    };

    await Promise.all(targetEpisodeIndexes.map((episodeIndex) => processEpisode(episodeIndex)));

    let nextSceneNumber = 1;
    const finalScenes: any[] = [];
    for (let index = 0; index < episodeResults.length; index += 1) {
      if (!episodeResults[index]) continue;
      for (const scene of episodeResults[index]!) {
        scene.sceneNumber = nextSceneNumber++;
        finalScenes.push(scene);
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
      prompt: buildLegacyDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
      chunkSegmentCounts,
      isRealEpisodes: splitResult.isRealEpisodes,
      originallyEpisodes: splitResult.originallyEpisodes,
      videoPace,
    };
  }

  const prompt = buildLegacyDecomposePrompt(
    videoPace,
    segmentsPerEpisode,
    episodeDuration,
  );
  const userText = `${prompt}\n\n---\n\n以下是用户的剧本：\n\n${script}${costumeContext}${sceneVariantContext}`;
  const { maxRetries: maxSingleRetries, delayMs: singleRetryDelayMs } =
    getNetworkRetrySettings();
  let singleAttempt = 0;
  let lastSingleError: unknown = null;

  while (singleAttempt <= maxSingleRetries) {
    if (singleAttempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, singleRetryDelayMs));
      if (abortSignal?.aborted) {
        throw lastSingleError instanceof Error
          ? lastSingleError
          : new Error("请求已取消");
      }
    }

    try {
      const correctionHint =
        singleAttempt > 0 && lastSingleError
          ? `\n\n【上一次输出存在的问题，必须全部修正】\n${String((lastSingleError as Error)?.message || lastSingleError)}\n请直接返回修正后的完整 JSON，不要解释。`
          : "";
      const retryUserText = `${userText}${correctionHint}`;
      const decomposeSignal = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
      const combinedSignal = abortSignal
        ? AbortSignal.any([abortSignal, decomposeSignal])
        : decomposeSignal;
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
      if (abortSignal?.aborted) throw error;
      singleAttempt += 1;
      if (singleAttempt > maxSingleRetries) break;
    }
  }

  throw lastSingleError instanceof Error ? lastSingleError : new Error("拆解失败");
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
    singlePass = DEFAULT_DECOMPOSE_SINGLE_PASS,
    preserveEpisodeIntegrity = DEFAULT_DECOMPOSE_PRESERVE_EPISODE_INTEGRITY,
  } = body;
  if (!script) throw new Error("缺少剧本内容");

  const model = requestedModel || readStoredDecomposeModel() || DEFAULT_DECOMPOSE_MODEL;

  const costumeContext = buildDecomposeCostumeContext(costumeInfo, script);
  const sceneVariantContext = buildDecomposeSceneVariantContext(sceneSettingInfo, script);

  // Split by episodes if script is large to reduce per-request payload
  const splitResult = splitScriptByEpisodes(script, { preserveEpisodeIntegrity: singlePass || preserveEpisodeIntegrity });
  const executionPlan = buildDecomposeExecutionPlan({
    splitResult,
    segmentsPerEpisode,
    singlePass,
  });
  const workUnits = executionPlan.units;
  const episodes = workUnits.map((unit) => unit.script);
  const crossEpisodeSignalSource =
    splitResult.isRealEpisodes && splitResult.chunks.length > 0 ? splitResult.chunks : episodes;
  const crossEpisodeSignals = crossEpisodeSignalSource.map((episodeScript) =>
    extractDecomposeSourceSignals(episodeScript),
  );
  const episodeSourceSignals = episodes.map((episodeScript) => extractDecomposeSourceSignals(episodeScript));
  const episodeSourceAnchorContexts = episodeSourceSignals.map((signals) =>
    buildDecomposeSourceAnchorContext(signals),
  );
  const episodeCrossContexts = workUnits.map((unit, index) =>
    executionPlan.originallyEpisodes
      ? buildDeterministicCrossEpisodeContextForChunk(
          Math.max(0, unit.episodeNumber - 1),
          crossEpisodeSignals,
        )
      : buildDeterministicCrossEpisodeContextForChunk(index, episodeSourceSignals),
  );

  if (episodes.length > 1) {
    const { delayMs: configuredChunkRetryDelayMs } = getNetworkRetrySettings();
    const chunkRetryDelayMs = resolveDecomposeRetryDelayMs(configuredChunkRetryDelayMs);
    const allScenes: any[] = [];
    const failedChunks: number[] = [];
    const failedChunkReasons: Record<number, string> = {};

    const chunkSegmentCounts = executionPlan.chunkSegmentCounts;

    // Results array indexed by episode. When retrying, keep complete existing
    // episode results and only send missing/underfilled episodes back to the model.
    const episodeResults: (any[] | null)[] = new Array(episodes.length).fill(
      null,
    );
    if (retryMissingEpisodes && executionPlan.isRealEpisodes && Array.isArray(existingScenes)) {
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
        try {
          episodeResults[index] = finalizeDecomposeScenes(
            scenesForEpisode.map((scene) => ({ ...scene })),
            {
              segmentsTarget: chunkSegmentCounts[index],
              videoPace,
              sourceSignals: episodeSourceSignals[index],
            },
          );
        } catch {
          episodeResults[index] = null;
        }
      }
    }

    const targetEpisodeIndexes = episodes
      .map((_, index) => index)
      .filter((index) => !episodeResults[index]);
    const averageTargetChunkChars = targetEpisodeIndexes.length
      ? Math.round(
          targetEpisodeIndexes.reduce((sum, index) => sum + episodes[index].length, 0) /
            targetEpisodeIndexes.length,
        )
      : 0;

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
        isRealEpisodes: executionPlan.isRealEpisodes,
        originallyEpisodes: executionPlan.originallyEpisodes,
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
        isRealEpisodes: executionPlan.isRealEpisodes,
        originallyEpisodes: executionPlan.originallyEpisodes,
        videoPace,
      };
    }

    const maxParallel = singlePass
      ? 1
      : resolveDecomposeParallelism({
          totalChunks: episodes.length,
          targetChunks: targetEpisodeIndexes.length,
          isRealEpisodes: executionPlan.isRealEpisodes,
          averageChunkChars: averageTargetChunkChars,
        });
    const sem = { current: 0, queue: [] as (() => void)[] };
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (sem.current < maxParallel) {
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

      const unit = workUnits[epIdx];
      const ep = unit.script;
      const chunkSegments = chunkSegmentCounts[epIdx];
      const chunkCostumeContext = buildDecomposeCostumeContext(costumeInfo, ep);
      const chunkSceneVariantContext = buildDecomposeSceneVariantContext(sceneSettingInfo, ep);
      const sourceAnchorContext = episodeSourceAnchorContexts[epIdx] || "";
      const crossEpContext = episodeCrossContexts[epIdx] || "";

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
      let maxChunkRetries = singlePass ? 0 : DECOMPOSE_MAX_SELF_HEAL_RETRIES;
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
          const chunkLabel = buildDecomposeWorkUnitHeading(unit, executionPlan);
          const effectiveUserText = buildDecomposeUserText({
            prompt: chunkPrompt,
            script: `${ep}${sourceAnchorContext}${crossEpContext}`,
            costumeContext: chunkCostumeContext,
            sceneVariantContext: chunkSceneVariantContext,
            heading: chunkLabel,
            systemPrompt,
          });
          const correctionHint =
            chunkAttempt > 0 && lastChunkError
              ? buildDecomposeCorrectionHint(lastChunkError)
              : "";
          const retryUserText = `${effectiveUserText}${correctionHint}`;
          const requestContents = buildDecomposeRequestContents(retryUserText, systemPrompt);

          const chunkTimeout = AbortSignal.timeout(SCRIPT_DECOMPOSE_TIMEOUT_MS);
          const combinedSignal = abortSignal
            ? AbortSignal.any([abortSignal, chunkTimeout])
            : chunkTimeout;

          let resultText: string;
          let rawResponse: unknown = null;
          if (onStreamText) {
            const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
            resultText = await callGeminiStream(
              model,
              requestContents,
              forwardStreamDelta,
              buildDecomposeGenerationConfig({
                segmentsTarget: chunkSegments,
                averageChunkChars: ep.length,
                retryAttempt: chunkAttempt,
              }),
              combinedSignal,
            );
          } else {
            const data = await callGemini(
              model,
              requestContents,
              buildDecomposeGenerationConfig({
                segmentsTarget: chunkSegments,
                averageChunkChars: ep.length,
                retryAttempt: chunkAttempt,
              }),
              combinedSignal,
            );
            rawResponse = data;
            resultText = extractText(data);
          }
          if (!resultText && rawResponse) {
            throw new Error(explainGeminiNoText(rawResponse) || "AI 鏈繑鍥炲唴瀹?");
          }
          if (!resultText)
            throw new Error(
              `${buildDecomposeWorkUnitName(unit, executionPlan)}拆解失败：AI 未返回内容`,
            );

          const epScenes = parseDecomposeResult(resultText);
          const normalizedScenes = epScenes.map((scene) => ({
            ...scene,
            segmentLabel: normalizeEpisodeSegmentLabel(scene?.segmentLabel, unit.episodeNumber),
          }));

          let finalizedScenes = finalizeDecomposeScenes(normalizedScenes, {
            segmentsTarget: chunkSegments,
            videoPace,
            sourceSignals: episodeSourceSignals[epIdx],
            allowExtraSegments: unit.partCount > 1 ? 0 : undefined,
          });
          finalizedScenes = renumberDecomposeWorkUnitSegments(finalizedScenes, unit);
          episodeResults[epIdx] = finalizedScenes;

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
              retryReason: undefined,
            });
          }
          lastChunkError = null;
          delete failedChunkReasons[epIdx];
          break; // success, exit retry loop
        } catch (err: any) {
          lastChunkError = err;
          maxChunkRetries = resolveDecomposeRetryBudget(err, singlePass);
          failedChunkReasons[epIdx] = normalizeDecomposeFailureReason(err);
          chunkAttempt++;
          if (onProgress && chunkAttempt <= maxChunkRetries) {
            onProgress({
              scenes: [...allScenes],
              chunkIndex: epIdx,
              totalChunks: episodes.length,
              status: "processing",
              failedChunks,
              retryAttempt: chunkAttempt,
              retryReason: failedChunkReasons[epIdx],
            });
          }
          if (chunkAttempt > maxChunkRetries) {
            failedChunks.push(epIdx);
            if (onProgress) {
              onProgress({
                scenes: [...allScenes],
                chunkIndex: epIdx,
                totalChunks: episodes.length,
                status: "failed",
                failedChunks,
                error: failedChunkReasons[epIdx],
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
      throw buildIncompleteDecomposeError(
        failedChunks,
        episodes.length,
        failedChunkReasons,
        workUnits.map((workUnit) => buildDecomposeWorkUnitName(workUnit, executionPlan)),
      );
    }

    return {
      scenes: allScenes,
      failedChunks,
      episodes,
      costumeContext,
      model,
      prompt: buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration),
      chunkSegmentCounts,
      isRealEpisodes: executionPlan.isRealEpisodes,
      originallyEpisodes: executionPlan.originallyEpisodes,
      videoPace,
    };
  }

  // Single episode or couldn't split - send as one request
  const prompt = buildDecomposePrompt(videoPace, segmentsPerEpisode, episodeDuration);
  const singleEpisodeCostumeContext = buildDecomposeCostumeContext(costumeInfo, script);
  const singleEpisodeSceneVariantContext = buildDecomposeSceneVariantContext(sceneSettingInfo, script);
  const singleEpisodeSourceSignals =
    episodeSourceSignals[0] || extractDecomposeSourceSignals(String(script || ""));
  const singleEpisodeSourceAnchorContext =
    episodeSourceAnchorContexts[0] || buildDecomposeSourceAnchorContext(singleEpisodeSourceSignals);
  const effectiveUserText = buildDecomposeUserText({
    prompt,
    script: `${script}${singleEpisodeSourceAnchorContext}`,
    costumeContext: singleEpisodeCostumeContext,
    sceneVariantContext: singleEpisodeSceneVariantContext,
    systemPrompt,
  });
  const { delayMs: configuredSingleRetryDelayMs } = getNetworkRetrySettings();
  const singleRetryDelayMs = resolveDecomposeRetryDelayMs(configuredSingleRetryDelayMs);
  let maxSingleRetries = singlePass ? 0 : DECOMPOSE_MAX_SELF_HEAL_RETRIES;
  let singleAttempt = 0;
  let lastSingleError: unknown = null;

  if (onProgress) {
    onProgress({
      scenes: [],
      chunkIndex: 0,
      totalChunks: 1,
      status: "init",
      failedChunks: [],
    });
  }

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
          ? buildDecomposeCorrectionHint(lastSingleError)
          : "";
      const retryUserText = `${effectiveUserText}${correctionHint}`;
      const requestContents = buildDecomposeRequestContents(retryUserText, systemPrompt);
      if (onProgress) {
        onProgress({
          scenes: [],
          chunkIndex: 0,
          totalChunks: 1,
          status: "processing",
          failedChunks: [],
          retryAttempt: singleAttempt > 0 ? singleAttempt : undefined,
          retryReason: singleAttempt > 0 ? normalizeDecomposeFailureReason(lastSingleError) : undefined,
        });
      }
      let resultText: string;
      let rawResponse: unknown = null;
      if (onStreamText) {
        const forwardStreamDelta = createAccumulatedTextDeltaForwarder(onStreamText);
        resultText = await callGeminiStream(
          model,
          requestContents,
          forwardStreamDelta,
          buildDecomposeGenerationConfig({
            segmentsTarget: segmentsPerEpisode || 5,
            averageChunkChars: script.length,
            retryAttempt: singleAttempt,
          }),
          combinedSignal,
        );
      } else {
        const data = await callGemini(
          model,
          requestContents,
          buildDecomposeGenerationConfig({
            segmentsTarget: segmentsPerEpisode || 5,
            averageChunkChars: script.length,
            retryAttempt: singleAttempt,
          }),
          combinedSignal,
        );
        rawResponse = data;
        resultText = extractText(data);
      }
      if (!resultText && rawResponse) {
        throw new Error(explainGeminiNoText(rawResponse) || "AI 鏈繑鍥炲唴瀹?");
      }

      if (!resultText) throw new Error("AI 未返回内容");

      const scenes = finalizeDecomposeScenes(parseDecomposeResult(resultText), {
        segmentsTarget: segmentsPerEpisode || 5,
        videoPace,
        sourceSignals: singleEpisodeSourceSignals,
      });
      onProgress?.({
        scenes,
        chunkIndex: 0,
        totalChunks: 1,
        status: "done",
        failedChunks: [],
      });
      return { scenes };
    } catch (error) {
      lastSingleError = error;
      maxSingleRetries = resolveDecomposeRetryBudget(error, singlePass);
      if (abortSignal?.aborted) {
        throw error;
      }
      singleAttempt++;
      onProgress?.({
        scenes: [],
        chunkIndex: 0,
        totalChunks: 1,
        status: singleAttempt > maxSingleRetries ? "failed" : "processing",
        failedChunks: singleAttempt > maxSingleRetries ? [0] : [],
        retryAttempt: singleAttempt,
        retryReason: normalizeDecomposeFailureReason(error),
        error: singleAttempt > maxSingleRetries ? normalizeDecomposeFailureReason(error) : undefined,
      });
      if (singleAttempt > maxSingleRetries) {
        break;
      }
    }
  }

  throw new Error(
    `${singlePass ? "剧本拆解单轮执行失败" : "剧本拆解多次重试仍未成功"}：${normalizeDecomposeFailureReason(lastSingleError || "未知错误")}`,
  );
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

interface DecomposeWorkUnit {
  script: string;
  episodeNumber: number;
  partIndex: number;
  partCount: number;
  segmentsTarget: number;
  segmentStart: number;
}

interface DecomposeExecutionPlan {
  units: DecomposeWorkUnit[];
  chunkSegmentCounts: number[];
  isRealEpisodes: boolean;
  originallyEpisodes: boolean;
  totalEpisodeCount: number;
}

function splitTextIntoDecomposeChunks(
  text: string,
  maxChunkChars: number,
  minChunkChars: number,
): string[] {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return [];
  if (normalizedText.length <= maxChunkChars) return [normalizedText];

  let paragraphs = normalizedText.split(/\n{2,}/);
  if (paragraphs.length < 3) {
    paragraphs = normalizedText.split(/\n/);
  }
  const sep = paragraphs.length === normalizedText.split(/\n{2,}/).length ? "\n\n" : "\n";
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const wouldBe = current.length + (current ? sep.length : 0) + para.length;
    if (wouldBe > maxChunkChars && current.length >= minChunkChars) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? sep : "") + para;
    }
  }

  if (current.trim()) {
    if (current.trim().length < minChunkChars && chunks.length > 0) {
      chunks[chunks.length - 1] += sep + current.trim();
    } else {
      chunks.push(current.trim());
    }
  }

  return chunks.length > 0 ? chunks : [normalizedText];
}

function mergeDecomposeChunkParts(parts: string[], maxParts: number): string[] {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  const limit = Math.max(1, Math.floor(maxParts || 1));
  if (normalized.length <= limit) return normalized;

  const merged = [...normalized];
  while (merged.length > limit) {
    const tail = merged.pop();
    if (!tail) break;
    merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${tail}`.trim();
  }
  return merged;
}

function distributeDecomposeSegmentCounts(lengths: number[], totalSegments: number): number[] {
  const safeTotalSegments = Math.max(1, Math.round(totalSegments || 1));
  if (!lengths.length) return [];
  if (lengths.length === 1) return [safeTotalSegments];

  const totalChars = lengths.reduce((sum, length) => sum + Math.max(1, length), 0);
  const rawCounts = lengths.map((length) => (Math.max(1, length) / totalChars) * safeTotalSegments);
  const counts = rawCounts.map((count) => Math.max(1, Math.round(count)));
  let diff = safeTotalSegments - counts.reduce((sum, count) => sum + count, 0);

  while (diff !== 0) {
    if (diff > 0) {
      let bestIdx = 0;
      let bestFrac = -1;
      for (let index = 0; index < rawCounts.length; index += 1) {
        const frac = rawCounts[index] - Math.floor(rawCounts[index]);
        if (frac > bestFrac && counts[index] < rawCounts[index] + 1) {
          bestFrac = frac;
          bestIdx = index;
        }
      }
      counts[bestIdx] += 1;
      diff -= 1;
      continue;
    }

    let bestIdx = -1;
    let bestFrac = 2;
    for (let index = 0; index < rawCounts.length; index += 1) {
      const frac = rawCounts[index] - Math.floor(rawCounts[index]);
      if (frac < bestFrac && counts[index] > 1) {
        bestFrac = frac;
        bestIdx = index;
      }
    }
    if (bestIdx < 0) break;
    counts[bestIdx] -= 1;
    diff += 1;
  }

  return counts;
}

function shouldSubSplitEpisodeForSinglePass(episodeScript: string, segmentsTarget: number): boolean {
  const normalizedScript = String(episodeScript || "").trim();
  if (!normalizedScript) return false;
  const { max: maxChunkChars } = getChunkLimits(normalizedScript);
  if (normalizedScript.length > maxChunkChars) return true;
  return (
    estimateDecomposeOutputTokens({
      segmentsTarget,
      averageChunkChars: normalizedScript.length,
    }) > DECOMPOSE_SINGLE_PASS_SPLIT_OUTPUT_THRESHOLD
  );
}

export function buildDecomposeExecutionPlan(params: {
  splitResult: SplitResult;
  segmentsPerEpisode?: number | null;
  singlePass: boolean;
}): DecomposeExecutionPlan {
  const segmentsPerEpisode = Math.max(1, Math.round(params.segmentsPerEpisode || 5));
  const singlePassMaxSegments = params.singlePass
    ? segmentsPerEpisode + DECOMPOSE_SINGLE_PASS_EXTRA_SEGMENT_BUDGET
    : segmentsPerEpisode;

  if (params.splitResult.isRealEpisodes) {
    const units: DecomposeWorkUnit[] = [];

    params.splitResult.chunks.forEach((episodeScript, episodeIndex) => {
      const { max: maxChunkChars, min: minChunkChars } = getChunkLimits(episodeScript);
      let parts = [episodeScript.trim()].filter(Boolean);
      if (params.singlePass && shouldSubSplitEpisodeForSinglePass(episodeScript, segmentsPerEpisode)) {
        parts = splitTextIntoDecomposeChunks(episodeScript, maxChunkChars, minChunkChars);
      }
      parts = mergeDecomposeChunkParts(parts, singlePassMaxSegments);
      const plannedSegments = Math.max(segmentsPerEpisode, Math.min(parts.length, singlePassMaxSegments));
      const segmentCounts = distributeDecomposeSegmentCounts(
        parts.map((part) => part.length),
        plannedSegments,
      );
      let segmentCursor = 1;
      parts.forEach((part, partIndex) => {
        units.push({
          script: part,
          episodeNumber: episodeIndex + 1,
          partIndex: partIndex + 1,
          partCount: parts.length,
          segmentsTarget: segmentCounts[partIndex] || 1,
          segmentStart: segmentCursor,
        });
        segmentCursor += segmentCounts[partIndex] || 1;
      });
    });

    return {
      units,
      chunkSegmentCounts: units.map((unit) => unit.segmentsTarget),
      isRealEpisodes: units.every((unit) => unit.partCount === 1),
      originallyEpisodes: true,
      totalEpisodeCount: params.splitResult.chunks.length,
    };
  }

  const units: DecomposeWorkUnit[] = [];
  params.splitResult.chunks.forEach((chunk, index) => {
    const { max: maxChunkChars, min: minChunkChars } = getChunkLimits(chunk);
    let parts = [chunk.trim()].filter(Boolean);
    if (params.singlePass && shouldSubSplitEpisodeForSinglePass(chunk, segmentsPerEpisode)) {
      parts = splitTextIntoDecomposeChunks(chunk, maxChunkChars, minChunkChars);
    }
    parts = mergeDecomposeChunkParts(parts, singlePassMaxSegments);
    parts.forEach((part, partIndex) => {
      units.push({
        script: part,
        episodeNumber: index + 1,
        partIndex: partIndex + 1,
        partCount: parts.length,
        segmentsTarget: 1,
        segmentStart: 1,
      });
    });
  });

  const plannedSegments = Math.max(
    segmentsPerEpisode,
    Math.min(units.length, params.singlePass ? singlePassMaxSegments : segmentsPerEpisode),
  );
  const chunkSegmentCounts = distributeDecomposeSegmentCounts(
    units.map((unit) => unit.script.length),
    plannedSegments,
  );
  let segmentCursor = 1;
  units.forEach((unit, index) => {
    unit.segmentsTarget = chunkSegmentCounts[index] || 1;
    unit.segmentStart = segmentCursor;
    segmentCursor += unit.segmentsTarget;
  });

  return {
    units,
    chunkSegmentCounts,
    isRealEpisodes: units.every((unit) => unit.partCount === 1) && params.splitResult.isRealEpisodes,
    originallyEpisodes: params.splitResult.originallyEpisodes,
    totalEpisodeCount: params.splitResult.chunks.length,
  };
}

function buildDecomposeWorkUnitName(unit: DecomposeWorkUnit, plan: DecomposeExecutionPlan): string {
  if (plan.originallyEpisodes) {
    if (unit.partCount > 1) {
      return `第${unit.episodeNumber}集第${unit.partIndex}/${unit.partCount}部分`;
    }
    return `第${unit.episodeNumber}集`;
  }
  return `第${unit.episodeNumber}段`;
}

function buildDecomposeWorkUnitHeading(unit: DecomposeWorkUnit, plan: DecomposeExecutionPlan): string {
  if (plan.originallyEpisodes) {
    if (unit.partCount > 1) {
      const segmentEnd = unit.segmentStart + unit.segmentsTarget - 1;
      return `以下是第${unit.episodeNumber}集的第${unit.partIndex}/${unit.partCount}部分（本部分需要恰好${unit.segmentsTarget}个片段，segmentLabel 请从 "${unit.episodeNumber}-${unit.segmentStart}" 连续编号到 "${unit.episodeNumber}-${segmentEnd}"）`;
    }
    return `以下是第${unit.episodeNumber}集剧本（共${plan.totalEpisodeCount}集）`;
  }
  return `以下是剧本的第${unit.episodeNumber}部分（共${plan.totalEpisodeCount}部分，本部分需要恰好${unit.segmentsTarget}个片段）`;
}

function renumberDecomposeWorkUnitSegments(scenes: any[], unit: DecomposeWorkUnit): any[] {
  if (unit.partCount <= 1 && unit.segmentStart === 1) return scenes;

  const labelMap = new Map<string, string>();
  let nextSegmentNumber = unit.segmentStart;

  return scenes.map((scene) => {
    const normalizedLabel = normalizeEpisodeSegmentLabel(scene?.segmentLabel, unit.episodeNumber);
    let mappedLabel = labelMap.get(normalizedLabel);
    if (!mappedLabel) {
      mappedLabel = `${unit.episodeNumber}-${nextSegmentNumber}`;
      labelMap.set(normalizedLabel, mappedLabel);
      nextSegmentNumber += 1;
    }
    return { ...scene, segmentLabel: mappedLabel };
  });
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
function splitScriptByEpisodes(
  script: string,
  options?: { preserveEpisodeIntegrity?: boolean },
): SplitResult {
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

  if (isRealEpisodes && options?.preserveEpisodeIntegrity) {
    const preservedChunks = rawChunks.map((chunk) => chunk.trim()).filter(Boolean);
    return preservedChunks.length > 1
      ? {
          chunks: preservedChunks,
          isRealEpisodes: true,
          originallyEpisodes: detectedEpisodes,
        }
      : { chunks: [script], isRealEpisodes: false, originallyEpisodes: detectedEpisodes };
  }

  const finalChunks: string[] = [];
  let hadSubSplit = false;
  for (const chunk of rawChunks) {
    const chunkParts = splitTextIntoDecomposeChunks(chunk, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS);
    if (chunkParts.length > 1) hadSubSplit = true;
    finalChunks.push(...chunkParts);
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
function extractJsonErrorSnippet(text: string, errorMessage: string, radius = 48): string {
  const match = errorMessage.match(/position\s+(\d+)/i);
  const position = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isFinite(position) || position < 0 || position >= text.length) return "";
  const start = Math.max(0, position - radius);
  const end = Math.min(text.length, position + radius);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function buildDecomposeJsonError(error: unknown, sourceText: string): Error {
  const message = normalizeDecomposeFailureReason(error);
  const snippet = extractJsonErrorSnippet(sourceText, message);
  return new Error(
    `拆解结果 JSON 格式错误：${message}${snippet ? `。问题附近：${snippet}` : ""}`,
  );
}

function extractPrimaryJsonCandidate(rawText: string): string | null {
  const objectStart = rawText.indexOf("{");
  const arrayStart = rawText.indexOf("[");
  if (objectStart < 0 && arrayStart < 0) return null;

  const useObject =
    objectStart >= 0 && (arrayStart < 0 || objectStart <= arrayStart);
  const start = useObject ? objectStart : arrayStart;
  const end = useObject ? rawText.lastIndexOf("}") : rawText.lastIndexOf("]");
  if (start < 0) return null;
  if (end > start) return rawText.slice(start, end + 1);
  return rawText.slice(start);
}

function escapeLikelyUnescapedJsonQuotes(rawText: string): string {
  let nextText = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (!inString) {
      if (char === '"') inString = true;
      nextText += char;
      continue;
    }

    if (escaped) {
      nextText += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      nextText += char;
      escaped = true;
      continue;
    }

    // Escape literal control characters inside strings (e.g. real newlines AI outputs)
    if (char === "\n") { nextText += "\\n"; continue; }
    if (char === "\r") { nextText += "\\r"; continue; }
    if (char === "\t") { nextText += "\\t"; continue; }

    if (char === '"') {
      let probe = index + 1;
      while (probe < rawText.length && /[ \t]/.test(rawText[probe])) probe += 1;
      const nextChar = rawText[probe];
      if (nextChar === "," || nextChar === "}" || nextChar === "]" || nextChar === ":") {
        inString = false;
        nextText += char;
      } else {
        nextText += '\\"';
      }
      continue;
    }

    nextText += char;
  }

  return nextText;
}

function closeUnterminatedJsonCandidate(rawText: string): string | null {
  const baseText = String(rawText || "").trim();
  if (!baseText) return null;

  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  let lastContainerCloseIndex = -1;

  for (let index = 0; index < baseText.length; index += 1) {
    const char = baseText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push(char);
      continue;
    }
    if (char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) {
        stack.pop();
        lastContainerCloseIndex = index + 1;
      }
    }
  }

  let repaired = baseText;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    repaired += stack[index] === "{" ? "}" : "]";
  }

  repaired = repaired.replace(/,\s*([}\]])/g, "$1").trim();

  if (repaired !== baseText) return repaired;
  if (lastContainerCloseIndex > 0) {
    const truncated = baseText.slice(0, lastContainerCloseIndex).replace(/,\s*$/, "");
    return truncated !== baseText ? truncated : null;
  }
  return null;
}

function trimJsonCandidateToLastContainerClose(rawText: string): string | null {
  const baseText = String(rawText || "").trim();
  if (!baseText) return null;

  let inString = false;
  let escaped = false;
  let lastContainerCloseIndex = -1;

  for (let index = 0; index < baseText.length; index += 1) {
    const char = baseText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "}" || char === "]") {
      lastContainerCloseIndex = index + 1;
    }
  }

  if (lastContainerCloseIndex <= 0 || lastContainerCloseIndex >= baseText.length) return null;
  const trimmed = baseText.slice(0, lastContainerCloseIndex).replace(/,\s*$/, "").trim();
  return trimmed || null;
}

function buildDecomposeJsonRepairCandidates(rawText: string): string[] {
  const candidates = new Set<string>();
  const pushCandidate = (value: unknown) => {
    const text = String(value || "").trim();
    if (text) candidates.add(text);
  };

  const repairLikelyMissingPropertyCommas = (text: string) =>
    text
      .replace(/"\s*"(?=(?:[^"\\]|\\.)+"\s*:)/g, '","')
      .replace(/([}\]"0-9])\s*(?="(?:[^"\\]|\\.)+"\s*:)/g, "$1,");

  // Escape literal control characters that are invalid inside JSON strings.
  // AI models sometimes output real newlines/tabs in dialogue fields instead of \n/\t.
  const escapeControlCharsInStrings = (text: string): string =>
    escapeLikelyUnescapedJsonQuotes(text);

  const baseText = String(rawText || "").trim().replace(/^\uFEFF/, "");
  // First candidate: escape control chars (handles the most common "literal newline in dialogue" failure)
  const controlCharsEscaped = escapeControlCharsInStrings(baseText);
  const baseMissingCommas = repairLikelyMissingPropertyCommas(baseText);
  const escapedQuotes = escapeLikelyUnescapedJsonQuotes(baseText);
  const repairedMissingCommas = repairLikelyMissingPropertyCommas(
    escapeLikelyUnescapedJsonQuotes(baseMissingCommas),
  );
  const withoutTrailingCommas = repairedMissingCommas.replace(/,\s*([}\]])/g, "$1");
  const closedBaseText = closeUnterminatedJsonCandidate(baseText);
  const trimmedBaseText = trimJsonCandidateToLastContainerClose(baseText);

  // Push control-chars-escaped first so it's tried before other candidates
  pushCandidate(controlCharsEscaped);
  pushCandidate(repairLikelyMissingPropertyCommas(controlCharsEscaped).replace(/,\s*([}\]])/g, "$1"));
  pushCandidate(baseText);
  pushCandidate(baseMissingCommas);
  pushCandidate(escapedQuotes);
  pushCandidate(repairedMissingCommas);
  pushCandidate(withoutTrailingCommas);
  pushCandidate(closedBaseText);
  pushCandidate(trimmedBaseText);
  pushCandidate(closeUnterminatedJsonCandidate(controlCharsEscaped));
  pushCandidate(trimJsonCandidateToLastContainerClose(controlCharsEscaped));

  const primaryCandidate = extractPrimaryJsonCandidate(baseText);
  if (primaryCandidate) {
    const primaryMissingCommas = repairLikelyMissingPropertyCommas(primaryCandidate);
    pushCandidate(primaryCandidate);
    pushCandidate(primaryMissingCommas);
    pushCandidate(escapeLikelyUnescapedJsonQuotes(primaryCandidate));
    pushCandidate(
      repairLikelyMissingPropertyCommas(escapeLikelyUnescapedJsonQuotes(primaryMissingCommas))
        .replace(/,\s*([}\]])/g, "$1"),
    );
    pushCandidate(closeUnterminatedJsonCandidate(primaryCandidate));
    pushCandidate(trimJsonCandidateToLastContainerClose(primaryCandidate));
  }

  return [...candidates];
}

function tryParseDecomposeJson(rawText: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(rawText) };
  } catch (error) {
    return { ok: false, error: buildDecomposeJsonError(error, rawText) };
  }
}

function parseDecomposeResult(resultText: string): Array<Record<string, unknown>> {
  let cleanedText = resultText.trim();
  if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  let parseResult = tryParseDecomposeJson(cleanedText);
  if (!parseResult.ok) {
    for (const candidate of buildDecomposeJsonRepairCandidates(cleanedText)) {
      parseResult = tryParseDecomposeJson(candidate);
      if (parseResult.ok) break;

      const lastBrace = candidate.lastIndexOf("}");
      const lastBracket = candidate.lastIndexOf("]");
      const cutAt = Math.max(lastBrace, lastBracket);
      if (cutAt > 0) {
        parseResult = tryParseDecomposeJson(candidate.slice(0, cutAt + 1));
        if (parseResult.ok) break;
      }
    }
  }

  if (!parseResult.ok) {
    throw parseResult.error;
  }

  const parsed = parseResult.value as
    | Array<Record<string, unknown>>
    | { scenes?: Array<Record<string, unknown>> };
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
  const singleAspectRatio = resolveVideoImageAspectRatioForViewMode(
    "single",
    body?.aspectRatio,
  );
  const singleFrameShape =
    singleAspectRatio === "1:1"
      ? "square"
      : singleAspectRatio === "3:2"
        ? "landscape"
        : "portrait";

  // 首套服装：完整角色描述；后续服装：以修改为主，简洁指令
  let prompt: string;
  if (isCostumeVariation) {
    // 后续服装变体：以参考图为基准，只修改服装，保持人物面部特征一致
    // 提示词极简：换装指令 + 面部一致性
    prompt = `基于图1角色图，生成同一角色的新服装版本。

【面部特征】与图1保持完全一致（脸型、眉形、眼睛、鼻梁、嘴唇等），确保是同一个角色。

【服装】${characterDesc}

Art style: ${styleDesc}.
${isSingleMode ? `${singleAspectRatio} ${singleFrameShape} single-character composition, front view, pure white background.` : "16:9 horizontal, 4-view character sheet (front/side/back/face closeup), pure white background."}`;
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

=== STORY FIDELITY ===
Treat the shot description and scene environment as the latest decomposed story facts.
Do NOT collapse explicit actions, reactions, state changes, or outcomes into a generic pose, mood board, or empty atmosphere shot.
If the shot description contains multiple dramatic beats, preserve the clearest key action/result state in this frame.

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
  const singleAspectRatio = resolveVideoImageAspectRatioForViewMode(
    "single",
    body?.aspectRatio,
  );
  const singleFrameShape =
    singleAspectRatio === "1:1"
      ? "square"
      : singleAspectRatio === "3:2"
        ? "landscape"
        : "portrait";

  let prompt: string;
  if (isCostumeVariation) {
    prompt = `基于图 1 角色图，生成同一角色的新服装版本。

【面部特征】与图 1 保持完全一致（脸型、眉形、眼睛、鼻梁、嘴唇等），确保是同一个角色。

【服装】${characterDesc}

Art style: ${styleDesc}.
${isSingleMode ? `${singleAspectRatio} ${singleFrameShape} single-character composition, front view, pure white background.` : "16:9 horizontal, 4-view character sheet (front/side/back/face closeup), pure white background."}`;
  } else {
    const whiteBackgroundRule = "The background MUST be a plain, pure white background (#FFFFFF). No gradients, no shadows on the background, no environment elements. Clean white only.";
    const fullBodyRule = "CRITICAL: The character MUST be FULL BODY visible from head to toe - feet MUST be inside the frame, not cut off. Standing straight, complete figure in view.";
    prompt = isSingleMode
      ? `Create a professional full-body character design portrait for: "${name}" - ${characterDesc}.

Art style: ${styleDesc}.

${whiteBackgroundRule}
${fullBodyRule}

The image should be a single full-body FRONT VIEW portrait of the character standing in a neutral, upright pose on a plain white background. The character should face the camera directly. Show the character from head to toe with clear details of face, clothing, and accessories. Compose the final result for a ${singleAspectRatio} ${singleFrameShape} frame. Professional character design sheet quality - NO text labels, clean composition. The entire image MUST be in ${styleDesc} style.

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
    fallbackAspectRatio: isSingleMode ? singleAspectRatio : "16:9",
    fallbackImageSize: "2K",
    overrideAspectRatio: isSingleMode ? singleAspectRatio : "16:9",
  });

  const imageProvider = selectedModel.startsWith("doubao-seedream")
    ? "seedream"
    : usesImageGenerationsEndpoint
      ? "tuzi-image"
      : "gemini-image";
  logImageSubmissionPreview(imageProvider, selectedModel, prompt.length);
  await pauseBeforeBackendMediaSubmit({
    kind: "image",
    provider: imageProvider,
    model: selectedModel,
    abortSignal: signal,
  });

  const isSeedream = selectedModel.startsWith("doubao-seedream");
  let imageBase64 = "";
  let mimeType = "image/jpeg";

  if (isSeedream) {
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
      image: referenceImageUrl ? [referenceImageUrl] : undefined,
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

  const imageProvider = selectedModel.startsWith("doubao-seedream")
    ? "seedream"
    : usesImageGenerationsEndpoint
      ? "tuzi-image"
      : "gemini-image";
  logImageSubmissionPreview(imageProvider, selectedModel, prompt.length);
  await pauseBeforeBackendMediaSubmit({
    kind: "image",
    provider: imageProvider,
    model: selectedModel,
    abortSignal: signal,
  });

  const isSeedream = selectedModel.startsWith("doubao-seedream");
  let imageBase64 = "";
  let mimeType = "image/jpeg";

  if (isSeedream) {
    const result = await callSeedreamImage(prompt, {
      model: selectedModel,
      size: resolveSeedreamSize(providerAspectRatio, providerImageSize),
      image: referenceImageUrl ? [referenceImageUrl] : undefined,
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

=== STORY FIDELITY ===
Treat the shot description and scene environment as the latest decomposed story facts.
Do NOT collapse explicit actions, reactions, state changes, or outcomes into a generic pose, mood board, or empty atmosphere shot.
If the shot description contains multiple dramatic beats, preserve the clearest key action/result state in this frame.

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

  const imageProvider = selectedModel.startsWith("doubao-seedream")
    ? "seedream"
    : usesImageGenerationsEndpoint
      ? "tuzi-image"
      : "gemini-image";
  logImageSubmissionPreview(imageProvider, selectedModel, prompt.length);
  await pauseBeforeBackendMediaSubmit({
    kind: "image",
    provider: imageProvider,
    model: selectedModel,
    abortSignal: signal,
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
      code = String(primary?.code || primary?.errorCode || parsed.code || parsed.errorCode || "").trim();
      message = String(
        primary?.message ||
          primary?.errorMessage ||
          primary?.msg ||
          parsed.message ||
          parsed.errorMessage ||
          parsed.msg ||
          "",
      ).trim();
      requestId = String(
        primary?.request_id ||
          primary?.requestId ||
          primary?.traceId ||
          parsed.request_id ||
          parsed.requestId ||
          parsed.traceId ||
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
    provider?: "ark" | "seedance" | "tuzi" | "aliyun" | "runninghub";
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

  if (options?.provider === "seedance" && /pre_consume_quota_failed/i.test(detail.code)) {
    const balanceMatch = detail.message.match(/用户剩余额度:\s*([^\s,，]+)/i);
    const requiredMatch = detail.message.match(/需要预扣费额度:\s*([^\s,，]+)/i);
    parts.push("当前视频网关余额不足，任务在预扣费阶段被拦截。");
    if (balanceMatch?.[1] && requiredMatch?.[1]) {
      parts.push(`余额 ${balanceMatch[1]}，本次至少需要 ${requiredMatch[1]}。`);
    }
    parts.push("请先充值，或切换更低成本的模型 / 分辨率后重试。");
  }

  if (detail.requestId) {
    parts.push(`request_id: ${detail.requestId}`);
  }

  return parts.length > 0
    ? `${label} (${status}): ${parts.join(" | ")}`
    : `${label} (${status})`;
}

function shouldRetrySeedanceFastWithStandardModel(
  status: number,
  detail: VideoApiErrorDetail,
  model: string,
): boolean {
  if (status !== 503) return false;
  if (normalizeHomeAgentVideoModelKey(model) !== SEEDANCE_2_0_FAST_MODEL_KEY) return false;
  const normalized = [detail.code, detail.message, detail.rawText]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return (
    normalized.includes("\u65e0\u53ef\u7528\u6e20\u9053") ||
    normalized.includes("no available channel") ||
    normalized.includes("all token groups") ||
    normalized.includes("\u4ee4\u724c\u5206\u7ec4")
  );
}

function alignPromptDurationText(
  prompt: string,
  requestedDuration: number | null,
  normalizedDuration: number,
): string {
  const basePrompt = String(prompt || "");
  if (
    !basePrompt.trim() ||
    requestedDuration === null ||
    !Number.isFinite(requestedDuration) ||
    requestedDuration <= 0 ||
    requestedDuration === normalizedDuration
  ) {
    return basePrompt;
  }

  const integerDuration = Math.round(requestedDuration);
  const replacementPatterns: Array<[RegExp, string]> = [
    [new RegExp(`\\b${integerDuration}-second(s)?\\b`, "gi"), `${normalizedDuration}-second$1`],
    [new RegExp(`\\b${integerDuration}\\s*second(s)?\\b`, "gi"), `${normalizedDuration} second$1`],
    [new RegExp(`\\b${integerDuration}\\s*sec(ond)?s?\\b`, "gi"), `${normalizedDuration} seconds`],
    [new RegExp(`\\b${integerDuration}s\\b`, "g"), `${normalizedDuration}s`],
    [new RegExp(`${integerDuration}\\s*秒`, "g"), `${normalizedDuration}秒`],
  ];

  let nextPrompt = basePrompt;
  let replaced = false;
  for (const [pattern, replacement] of replacementPatterns) {
    if (!pattern.test(nextPrompt)) continue;
    pattern.lastIndex = 0;
    nextPrompt = nextPrompt.replace(pattern, replacement);
    replaced = true;
  }

  if (replaced) return nextPrompt;
  return `${basePrompt}\n\n[Duration] Generate a ${normalizedDuration}-second version.`;
}

const SEEDANCE_GATEWAY_SUPPORTED_SECONDS = [4, 8, 12] as const;

function normalizeSeedanceGatewaySeconds(requestedDuration: number | null): number {
  if (requestedDuration === null || !Number.isFinite(requestedDuration)) {
    return SEEDANCE_GATEWAY_SUPPORTED_SECONDS[0];
  }

  let best = SEEDANCE_GATEWAY_SUPPORTED_SECONDS[0];
  let smallestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of SEEDANCE_GATEWAY_SUPPORTED_SECONDS) {
    const delta = Math.abs(candidate - requestedDuration);
    if (delta < smallestDelta || (delta === smallestDelta && candidate > best)) {
      best = candidate;
      smallestDelta = delta;
    }
  }
  return best;
}

function resolveSeedanceGatewayVideoSize(
  aspectRatio: string | undefined,
  resolution: string | undefined,
): string {
  const normalizedRatio = String(aspectRatio || "").trim() || "16:9";
  const normalizedResolution = String(resolution || "").trim().toLowerCase();
  const sizeMatrix: Record<string, Record<string, string>> = {
    "480p": {
      "16:9": "854x480",
      "9:16": "480x854",
      "1:1": "640x640",
      "4:3": "640x480",
      "3:4": "480x640",
    },
    "720p": {
      "16:9": "1280x720",
      "9:16": "720x1280",
      "1:1": "1024x1024",
      "4:3": "960x720",
      "3:4": "720x960",
    },
    "1080p": {
      "16:9": "1920x1080",
      "9:16": "1080x1920",
      "1:1": "1440x1440",
      "4:3": "1440x1080",
      "3:4": "1080x1440",
    },
  };

  const sizePreset = sizeMatrix[normalizedResolution] || sizeMatrix["720p"];
  return sizePreset[normalizedRatio] || sizePreset["16:9"];
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
  const explicitRunningHubProvider = isRunningHubVideoProvider(provider) ? provider : null;
  const isSora2 = model?.startsWith("sora-2") || provider === "tuzi";
  const isHappyHorseProvider =
    !explicitRunningHubProvider && (provider === "aliyun" || isHappyHorseModel(model));
  const seedanceBaseUrl = getSeedanceBaseUrl();
  const jimengTransport = resolveJimengVideoTransport(apiConfig);
  const jimengVideoTasksBaseUrl = jimengTransport.taskBaseUrl;
  const usesJimengArkTasksApi = jimengTransport.contract === "ark";
  const tuziBase = getTuziBaseUrl();
  const aliyunVideoSynthesisUrl = getAliyunVideoSynthesisUrl(apiConfig);
  const aliyunVideoTasksBaseUrl = getAliyunVideoTasksBaseUrl(apiConfig);
  const directRunningHubProvider =
    !action && explicitRunningHubProvider
      ? explicitRunningHubProvider
      : !action &&
          videoModelRequiresRunningHubTransport({
            modelKey: model,
            resolution: body.resolution,
            mode:
              typeof body.videoMode === "string" && body.videoMode.trim()
                ? body.videoMode
                : typeof body.mode === "string" && body.mode.trim()
                  ? body.mode
                  : undefined,
          })
        ? resolveRunningHubProvider(model)
        : null;

  if (action === "status" && explicitRunningHubProvider) {
    if (!taskId) throw new Error("缂哄皯 taskId");
    const res = await serviceFetch(
      getRunningHubQueryUrl(apiConfig),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ taskId }),
        signal: abortSignal,
      },
      "runninghub",
    );
    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      throw new Error(
        formatVideoApiError("RunningHub video task query failed", res.status, detail, {
          provider: "runninghub",
        }),
      );
    }
    const data = await safeParseVideoResponse(res, "RunningHub query task");
    const state = extractRunningHubTaskState(data);
    const status = normalizeTaskApiStatus(state);
    const videoUrl = extractRunningHubVideoUrl(data);
    const lastFrameUrl = extractRunningHubLastFrameUrl(data);
    const errorCode = extractRunningHubFailureCode(data);
    const errorMessage = extractRunningHubFailureMessage(data);
    const promptTips = extractRunningHubPromptTips(data);
    console.log(
      `[video] status result taskId=${taskId} provider=${explicitRunningHubProvider} status=${status} hasUrl=${!!videoUrl} hasLastFrame=${!!lastFrameUrl}${errorCode ? ` errorCode=${errorCode}` : ""}`,
    );
    return {
      status,
      video_url: videoUrl,
      ...(lastFrameUrl ? { last_frame_url: lastFrameUrl } : {}),
      state,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
      ...(promptTips ? { prompt_tips: promptTips } : {}),
    };
  }

  if (action === "cancel" && explicitRunningHubProvider) {
    if (!taskId) throw new Error("缂哄皯 taskId");
    console.warn(
      `[video] RunningHub provider=${explicitRunningHubProvider} does not expose a documented cancel endpoint, marking local task as cancelled.`,
    );
    return {
      task_id: taskId,
      status: "cancelled",
      provider: explicitRunningHubProvider,
    };
  }

  if (action === "status" && isHappyHorseProvider) {
    if (!taskId) throw new Error("缂哄皯 taskId");
    const res = await videoHttp(
      `${aliyunVideoTasksBaseUrl}/${taskId}`,
      {},
      undefined,
      abortSignal,
      "aliyun",
    );
    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      throw new Error(
        formatVideoApiError("HappyHorse 瑙嗛鐘舵€佹煡璇㈠け璐?", res.status, detail, {
          provider: "aliyun",
        }),
      );
    }
    const data = await safeParseVideoResponse(res, "HappyHorse 鐘舵€佹煡璇?");
    const state = extractAliyunTaskState(data);
    const status = normalizeTaskApiStatus(state);
    const videoUrl = extractAliyunVideoUrl(data);
    const lastFrameUrl = extractVideoTaskLastFrameUrl(data);
    const promptTips = extractAliyunPromptTips(data);
    const promptTipsForLog =
      promptTips.length > 80 ? `${promptTips.slice(0, 77).trimEnd()}...` : promptTips;
    console.log(
      `[video] 状态返回 taskId=${taskId} provider=aliyun status=${status} hasUrl=${!!videoUrl}${promptTipsForLog ? ` promptTips=${promptTipsForLog}` : ""}`,
    );
    return {
      status,
      video_url: videoUrl,
      ...(lastFrameUrl ? { last_frame_url: lastFrameUrl } : {}),
      state,
      ...(promptTips ? { prompt_tips: promptTips } : {}),
    };
  }

  if (action === "cancel" && isHappyHorseProvider) {
    if (!taskId) throw new Error("缂哄皯 taskId");
    const res = await videoHttpRequest({
      url: `${aliyunVideoTasksBaseUrl}/${taskId}/cancel`,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: abortSignal,
      service: "aliyun",
      method: "POST",
    });
    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      throw new Error(
        formatVideoApiError("HappyHorse 瑙嗛浠诲姟鍙栨秷澶辫触", res.status, detail, {
          provider: "aliyun",
        }),
      );
    }
    return {
      task_id: taskId,
      status: "cancelled",
      provider: "aliyun",
    };
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
      const lastFrameUrl = extractVideoTaskLastFrameUrl(data);
      console.log(`[video] 状态返回 taskId=${taskId} provider=tuzi status=${status} hasUrl=${!!videoUrl}`);
      return {
        status,
        video_url: videoUrl,
        ...(lastFrameUrl ? { last_frame_url: lastFrameUrl } : {}),
        state: data.status,
      };
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
          ...(extractVideoTaskLastFrameUrl(data) ? { last_frame_url: extractVideoTaskLastFrameUrl(data) } : {}),
          state: data.status,
        };
        console.log(`[video] 状态返回 taskId=${taskId} provider=ark status=${arkResult.status} hasUrl=${!!arkResult.video_url}`);
        return arkResult;
      }
      // Jimeng status query
      const res = await videoHttp(
        `${jimengVideoTasksBaseUrl}/${taskId}`,
        {},
        undefined,
        abortSignal,
        "jimeng",
      );
      if (!res.ok) throw new Error(`查询视频状态失败 (${res.status})`);
      const seedancePayload = await safeParseVideoResponse(res, "Seedance 状态查询");
      const seedanceVideoUrl = extractVideoTaskVideoUrl(seedancePayload);
      const seedanceLastFrameUrl = extractVideoTaskLastFrameUrl(seedancePayload);
      const seedanceResult = {
        ...seedancePayload,
        ...(seedanceVideoUrl ? { video_url: seedanceVideoUrl } : {}),
        ...(seedanceLastFrameUrl ? { last_frame_url: seedanceLastFrameUrl } : {}),
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
        /*
          if (fallbackRes.ok) {
            const fallbackData = await safeParseVideoResponse(fallbackRes, "Ark 鍒涘缓浠诲姟");
            console.log(
              `[video] 鎻愪氦鎴愬姛 provider=ark task_id=${extractVideoTaskId(fallbackData)} status=${fallbackData.status} fallback_model=${fallbackPayload.model}`,
            );
            return {
              task_id: extractVideoTaskId(fallbackData),
              status: fallbackData.status || "queued",
              progress: fallbackData.progress,
              provider: "jimeng",
            };
          }
          const fallbackDetail = await readVideoApiErrorDetail(fallbackRes);
          throw new Error(
            formatVideoApiError("Ark 瑙嗛鐢熸垚浠诲姟鍒涘缓澶辫触", fallbackRes.status, fallbackDetail, {
              provider: "ark",
              endpointId: fallbackPayload.model,
            }),
          );
        }
        */
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
      url: `${jimengVideoTasksBaseUrl}/${taskId}`,
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

  if (directRunningHubProvider) {
    try {
      return await submitRunningHubVideoTask(body, apiConfig, abortSignal, {
        provider: directRunningHubProvider,
        reason: "direct",
      });
    } catch (error) {
      const aliyunFallback = await maybeSubmitAliyunHappyHorseFallback({
        provider: directRunningHubProvider,
        model,
        body,
        apiConfig,
        abortSignal,
        error,
      });
      if (aliyunFallback) {
        return aliyunFallback;
      }
      throw error;
    }
  }

  if (isHappyHorseProvider) {
    if (!body.prompt) throw new Error("缂哄皯瑙嗛鎻忚堪 (prompt)");
    const promptForLog = String(body.prompt);
    const normalizedDuration = Math.max(
      getVideoModelMinDuration(HAPPYHORSE_VISIBLE_MODEL),
      Math.min(
        getVideoModelMaxDuration(HAPPYHORSE_VISIBLE_MODEL),
        Number(body.duration) || getVideoModelMinDuration(HAPPYHORSE_VISIBLE_MODEL),
      ),
    );
    const effectivePrompt = alignPromptDurationText(
      String(body.prompt),
      Number.isFinite(Number(body.duration)) ? Number(body.duration) : null,
      normalizedDuration,
    );
    const effectivePromptForLog = alignPromptDurationText(
      promptForLog,
      Number.isFinite(Number(body.duration)) ? Number(body.duration) : null,
      normalizedDuration,
    );
    logVideoPromptSummary("aliyun", HAPPYHORSE_VISIBLE_MODEL, normalizedDuration, effectivePromptForLog);
    await pauseBeforeBackendMediaSubmit({
      kind: "video",
      provider: "aliyun",
      model: HAPPYHORSE_VISIBLE_MODEL,
      abortSignal,
    });
    const referenceImageUrls = await normalizeAliyunReferenceImageUrls(body.referenceImageUrls);
    const primaryReferenceImage =
      typeof body.imageUrl === "string"
        ? await normalizeArkReferenceImageUrl(body.imageUrl)
        : null;
    if (primaryReferenceImage && !referenceImageUrls.includes(primaryReferenceImage)) {
      referenceImageUrls.unshift(primaryReferenceImage);
    }

    const submittedModel =
      referenceImageUrls.length > 1
        ? HAPPYHORSE_REFERENCE_MODEL
        : referenceImageUrls.length === 1
          ? HAPPYHORSE_IMAGE_MODEL
          : HAPPYHORSE_TEXT_MODEL;

    const payload: Record<string, any> = {
      model: submittedModel,
      input: {
        prompt: effectivePrompt,
      },
      parameters: {
        resolution: resolveAliyunVideoResolution(body.resolution),
        duration: normalizedDuration,
      },
    };

    if (submittedModel === HAPPYHORSE_REFERENCE_MODEL) {
      payload.input.media = referenceImageUrls.map((url) => ({
        type: "reference_image",
        url,
      }));
      payload.parameters.ratio = resolveAliyunVideoRatio(body.aspectRatio);
    } else if (submittedModel === HAPPYHORSE_IMAGE_MODEL) {
      payload.input.media = [
        {
          type: "first_frame",
          url: referenceImageUrls[0],
        },
      ];
    } else {
      payload.parameters.ratio = resolveAliyunVideoRatio(body.aspectRatio);
    }
    logVideoReferenceSummary("reference submit", {
      provider: "aliyun",
      route:
        submittedModel === HAPPYHORSE_REFERENCE_MODEL
          ? "multi-reference"
          : submittedModel === HAPPYHORSE_IMAGE_MODEL
            ? "first-frame"
            : "text-only",
      model: submittedModel,
      submittedReferenceAssets: summarizeVideoReferenceDebugInfoList(
        body.referenceImageDebugInfo,
        submittedModel === HAPPYHORSE_REFERENCE_MODEL
          ? referenceImageUrls.length
          : submittedModel === HAPPYHORSE_IMAGE_MODEL
            ? 1
            : 0,
      ),
    });

    const res = await videoHttp(
      aliyunVideoSynthesisUrl,
      {
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      JSON.stringify(payload),
      abortSignal,
      "aliyun",
    );
    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      throw new Error(
        formatVideoApiError("HappyHorse 瑙嗛鐢熸垚浠诲姟鍒涘缓澶辫触", res.status, detail, {
          provider: "aliyun",
          endpointId: payload.model,
        }),
      );
    }
    const data = await safeParseVideoResponse(res, "HappyHorse 鍒涘缓浠诲姟");
    const createdTaskId = extractAliyunTaskId(data);
    const createdStatus = extractAliyunTaskState(data) || "queued";
    console.log(`[video] 提交成功 provider=aliyun task_id=${createdTaskId} status=${createdStatus}`);
    return {
      task_id: createdTaskId,
      status: createdStatus,
      provider: "aliyun",
    };
  }

  // Create video
  if (!body.prompt) throw new Error("缺少视频描述 (prompt)");
  const promptForLog = String(body.prompt);
  const requestedDurationValue = Number(body.duration);
  const requestedDuration = Number.isFinite(requestedDurationValue)
    ? requestedDurationValue
    : null;
  const requestedVideoMode =
    typeof body.videoMode === "string" && body.videoMode.trim()
      ? body.videoMode.trim()
      : typeof body.mode === "string" && body.mode.trim()
        ? body.mode.trim()
        : undefined;
  logVideoReferenceSummary("reference input", {
    provider: isSora2 ? "tuzi" : usesJimengArkTasksApi ? "ark" : "seedance",
    model: body.model || "default",
    mode: requestedVideoMode,
    referenceAssets: summarizeVideoReferenceDebugInfoList(body.referenceImageDebugInfo),
  });

  if (isSora2) {
    const resolution = body.resolution || "1080p";
    const actualModel = resolution === "720p" ? "sora-2" : "sora-2-pro";
    const normalizedDuration = Math.max(4, Math.min(12, body.duration || 5));
    const effectivePromptForLog = alignPromptDurationText(
      promptForLog,
      requestedDuration,
      normalizedDuration,
    );
    logVideoPromptSummary(
      "tuzi",
      resolveConfiguredModelName(actualModel),
      normalizedDuration,
      effectivePromptForLog,
    );
    await pauseBeforeBackendMediaSubmit({
      kind: "video",
      provider: "tuzi",
      model: resolveConfiguredModelName(actualModel),
      abortSignal,
    });

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

    const payload: any = {
      model: resolveConfiguredModelName(actualModel),
      content,
      resolution,
      duration: normalizedDuration,
      ratio: aspectRatioMap[body.aspectRatio] || "16:9",
      watermark: false,
    };
    logVideoReferenceSummary("reference submit", {
      provider: "tuzi",
      route: body.imageUrl ? "first-frame" : "text-only",
      model: resolveConfiguredModelName(actualModel),
      submittedReferenceAssets: summarizeVideoReferenceDebugInfoList(
        body.referenceImageDebugInfo,
        body.imageUrl ? 1 : 0,
      ),
    });

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
    console.log(`[video] 提交成功 provider=tuzi task_id=${extractVideoTaskId(data)} status=${data.status}`);
    return {
      task_id: extractVideoTaskId(data),
      status: data.status || "queued",
      provider: "tuzi",
    };
  } else {

    // Jimeng (Seedance) implementation.
    // The non-Ark gateway keeps the frontend alias model id, but the request
    // fields themselves must follow the /v1/videos async contract.
    const resolution = body.resolution || "1080p";
    const fallbackModel =
      resolution === "480p"
        ? "doubao-seedance-1-5-pro_480p"
        : resolution === "720p"
          ? "doubao-seedance-1-5-pro_720p"
          : "doubao-seedance-1-5-pro_1080p";
    const actualModel =
      typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : fallbackModel;
    const maxDuration = getVideoModelMaxDuration(actualModel);
    const canAttachReferenceImage = videoModelSupportsDirectReferenceImage(actualModel);
    const supportsMultiReferenceImages = videoModelSupportsMultiReferenceImages(actualModel);
    const normalizedDuration = usesJimengArkTasksApi
      ? Math.max(
          getVideoModelMinDuration(actualModel),
          Math.min(
            maxDuration,
            Number(body.duration) || getVideoModelMinDuration(actualModel),
          ),
        )
      : normalizeSeedanceGatewaySeconds(requestedDuration);
    const effectivePrompt = alignPromptDurationText(
      String(body.prompt),
      requestedDuration,
      normalizedDuration,
    );
    const effectivePromptForLog = alignPromptDurationText(
      promptForLog,
      requestedDuration,
      normalizedDuration,
    );
    logVideoPromptSummary(
      isSora2 ? "tuzi" : usesJimengArkTasksApi ? "ark" : "seedance",
      body.model || "default",
      normalizedDuration,
      effectivePromptForLog,
    );
    await pauseBeforeBackendMediaSubmit({
      kind: "video",
      provider: usesJimengArkTasksApi ? "ark" : "seedance",
      model: actualModel,
      abortSignal,
    });
    const submittedModel = actualModel;
    const normalizedReferenceImageUrls = canAttachReferenceImage
      ? await normalizeArkReferenceImageUrls(body.referenceImageUrls)
      : [];
    const normalizedPrimaryReferenceImage =
      canAttachReferenceImage && body.imageUrl && typeof body.imageUrl === "string"
        ? await normalizeArkReferenceImageUrl(body.imageUrl as string)
        : null;
    const normalizedReferenceImageChain = Array.from(
      new Set(
        [
          normalizedPrimaryReferenceImage,
          ...normalizedReferenceImageUrls,
        ].filter((value): value is string => !!value),
      ),
    ).slice(0, 9);
    const primaryReferenceImage = normalizedReferenceImageChain[0] || null;
    const usesReferenceImageRoleContract =
      supportsMultiReferenceImages && normalizedReferenceImageChain.length > 1;
    const prefersFirstFrameReference =
      Boolean(body.preferFirstFrameReference) && Boolean(primaryReferenceImage);
    const extraReferenceImages = supportsMultiReferenceImages
      ? normalizedReferenceImageChain.slice(1)
      : [];

    if (usesJimengArkTasksApi) {
      const aspectRatioMap: Record<string, string> = {
        "16:9": "16:9",
        "9:16": "9:16",
        "1:1": "1:1",
        "4:3": "4:3",
        "3:4": "3:4",
      };

      const arkContent: Array<Record<string, unknown>> = [
        { type: "text", text: effectivePrompt },
      ];

      if (canAttachReferenceImage && primaryReferenceImage) {
        if (usesReferenceImageRoleContract && !prefersFirstFrameReference) {
          normalizedReferenceImageChain.forEach((refImageUrl) => {
            arkContent.push({
              type: "image_url",
              image_url: { url: refImageUrl },
              role: "reference_image",
            });
          });
        } else {
          arkContent.push({
            type: "image_url",
            image_url: { url: primaryReferenceImage },
            role: "first_frame",
          });
          extraReferenceImages.forEach((refImageUrl) => {
            arkContent.push({
              type: "image_url",
              image_url: { url: refImageUrl },
              ...(usesReferenceImageRoleContract ? { role: "reference_image" } : {}),
            });
          });
        }
      } else if (canAttachReferenceImage && body.imageUrl && typeof body.imageUrl === "string") {
        throw new Error("Ark 图生视频参考图不可用，无法读取为可提交的 URL 或 data URL。");
      }

      const payload = {
        model: resolveJimengSubmittedModelName(actualModel, jimengTransport, apiConfig),
        content: arkContent,
        resolution,
        duration: normalizedDuration,
        ratio: aspectRatioMap[body.aspectRatio] || "16:9",
        watermark: false,
      };
      logVideoReferenceSummary("reference submit", {
        provider: "ark",
        route:
          usesReferenceImageRoleContract && !prefersFirstFrameReference
            ? "multi-reference"
            : usesReferenceImageRoleContract
              ? "first-frame-reference-chain"
            : primaryReferenceImage
              ? "first-frame"
              : "text-only",
        model: resolveJimengSubmittedModelName(actualModel, jimengTransport, apiConfig),
        submittedReferenceAssets: summarizeVideoReferenceDebugInfoList(
          body.referenceImageDebugInfo,
          normalizedReferenceImageChain.length,
        ),
        droppedReferenceAssets: summarizeVideoReferenceDebugInfoList(
          Array.isArray(body.referenceImageDebugInfo)
            ? body.referenceImageDebugInfo.slice(normalizedReferenceImageChain.length)
            : [],
        ),
      });

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
        if (shouldRetrySeedanceFastWithStandardModel(res.status, detail, actualModel)) {
          const fallbackPayload = {
            ...payload,
            model: resolveJimengSubmittedModelName(SEEDANCE_2_0_MODEL_KEY, jimengTransport, apiConfig),
          };
          console.warn(
            `[video] Ark fallback model ${payload.model} -> ${fallbackPayload.model} after unavailable channel response`,
          );
          const fallbackRes = await videoHttp(
            jimengVideoTasksBaseUrl,
            {
              "Content-Type": "application/json",
            },
            JSON.stringify(fallbackPayload),
            undefined,
            "jimeng",
          );
          if (fallbackRes.ok) {
            const fallbackData = await safeParseVideoResponse(fallbackRes, "Ark create task");
            console.log(
              `[video] submit success provider=ark task_id=${extractVideoTaskId(fallbackData)} status=${fallbackData.status} fallback_model=${fallbackPayload.model}`,
            );
            return {
              task_id: extractVideoTaskId(fallbackData),
              status: fallbackData.status || "queued",
              progress: fallbackData.progress,
              provider: "jimeng",
            };
          }
          const fallbackDetail = await readVideoApiErrorDetail(fallbackRes);
          const runningHubFallback = await maybeSubmitRunningHubVideoFallback({
            status: fallbackRes.status,
            detail: fallbackDetail,
            model: actualModel,
            body: {
              ...body,
              model: actualModel,
            },
            apiConfig,
            abortSignal,
          });
          if (runningHubFallback) {
            return runningHubFallback;
          }
          throw new Error(
            formatVideoApiError("Ark video task creation failed", fallbackRes.status, fallbackDetail, {
              provider: "ark",
              endpointId: fallbackPayload.model,
            }),
          );
        }
        const runningHubFallback = await maybeSubmitRunningHubVideoFallback({
          status: res.status,
          detail,
          model: actualModel,
          body: {
            ...body,
            model: actualModel,
          },
          apiConfig,
          abortSignal,
        });
        if (runningHubFallback) {
          return runningHubFallback;
        }
        throw new Error(
          formatVideoApiError("Ark 视频生成任务创建失败", res.status, detail, {
            provider: "ark",
            endpointId: payload.model,
          }),
        );
      }
      const data = await safeParseVideoResponse(res, "Ark 创建任务");
      console.log(`[video] 提交成功 provider=ark task_id=${extractVideoTaskId(data)} status=${data.status}`);
      return {
        task_id: extractVideoTaskId(data),
        status: data.status || "queued",
        progress: data.progress,
        provider: "jimeng",
      };
    }

    const submittedSize = resolveSeedanceGatewayVideoSize(
      typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
      typeof resolution === "string" ? resolution : undefined,
    );

    // Build multipart/form-data using the non-Ark /v1/videos async contract.
    console.log(
      `[video] Seedance submit actualModel=${actualModel} submittedModel=${submittedModel} resolution=${String(body.resolution || "") || "(missing)"} size=${submittedSize} seconds=${normalizedDuration}`,
    );
    const textFields: Record<string, string> = {
      model: resolveJimengSubmittedModelName(submittedModel, jimengTransport, apiConfig),
      prompt: effectivePrompt,
      size: submittedSize,
      seconds: String(normalizedDuration),
    };

    // Prepare image binary data if available
    let imageBlob: Blob | null = null;
    let imageMimeType = "image/jpeg";

    if (canAttachReferenceImage && primaryReferenceImage) {
      let imageDataUri: string | null = null;
      if (primaryReferenceImage.startsWith("data:")) {
        imageDataUri = primaryReferenceImage;
      } else {
        const fetched = await fetchImageAsBase64(primaryReferenceImage);
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
    logVideoReferenceSummary("reference submit", {
      provider: "seedance",
      route: imageBlob ? "single-input-reference" : "text-only",
      model: resolveJimengSubmittedModelName(submittedModel, jimengTransport, apiConfig),
      submittedReferenceAssets: summarizeVideoReferenceDebugInfoList(
        body.referenceImageDebugInfo,
        imageBlob ? 1 : 0,
      ),
      droppedReferenceAssets: summarizeVideoReferenceDebugInfoList(
        imageBlob
          ? Array.isArray(body.referenceImageDebugInfo)
            ? body.referenceImageDebugInfo.slice(1)
            : []
          : body.referenceImageDebugInfo,
      ),
    });

    const targetUrl = jimengVideoTasksBaseUrl;

      const res = await fetch(targetUrl, {
        method: "POST",
        headers: isServerProxyEndpoint(targetUrl)
          ? {}
          : {
              "Authorization": `Bearer ${resolveDirectApiKey("jimeng")}`,
            },
        body: formData,
      });

    if (!res.ok) {
      const detail = await readVideoApiErrorDetail(res);
      const runningHubFallback = await maybeSubmitRunningHubVideoFallback({
        status: res.status,
        detail,
        model: actualModel,
        body: {
          ...body,
          model: actualModel,
        },
        apiConfig,
        abortSignal,
      });
      if (runningHubFallback) {
        return runningHubFallback;
      }
      throw new Error(
        formatVideoApiError("Seedance 视频生成任务创建失败", res.status, detail, {
          provider: "seedance",
        }),
      );
    }
    const data = await safeParseVideoResponse(res, "Seedance 创建任务");
    console.log(`[video] 提交成功 provider=seedance task_id=${extractVideoTaskId(data)} status=${data.status}`);
    return {
      task_id: extractVideoTaskId(data),
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

type VideoPromptGuidanceProfile =
  | "generic"
  | "image-to-video"
  | "text-to-video-pure"
  | "text-to-video-reference-guided";

function hasVisualReferenceInputs(options: {
  referenceImageUrl?: unknown;
  characterImages?: unknown;
  sceneImages?: unknown;
}): boolean {
  if (typeof options.referenceImageUrl === "string" && options.referenceImageUrl.trim()) {
    return true;
  }
  if (Array.isArray(options.characterImages) && options.characterImages.some((item) => item?.imageUrl)) {
    return true;
  }
  if (Array.isArray(options.sceneImages) && options.sceneImages.some((item) => item?.imageUrl)) {
    return true;
  }
  return false;
}

function resolveVideoPromptGuidanceProfile(options: {
  videoMode?: unknown;
  referenceImageUrl?: unknown;
  characterImages?: unknown;
  sceneImages?: unknown;
}): VideoPromptGuidanceProfile {
  const normalizedVideoMode =
    typeof options.videoMode === "string" ? options.videoMode.trim().toLowerCase() : "";
  const hasVisualReferences = hasVisualReferenceInputs(options);

  if (normalizedVideoMode === "text-to-video") {
    return hasVisualReferences ? "text-to-video-reference-guided" : "text-to-video-pure";
  }
  if (normalizedVideoMode === "image-to-video") {
    return "image-to-video";
  }
  return "generic";
}

function buildVideoPromptGuidanceNotes(
  profile: VideoPromptGuidanceProfile,
  scope: "single" | "segment",
): string[] {
  const promptTarget = scope === "segment" ? "最终片段 prompt" : "最终 prompt";
  if (scope === "segment") {
    switch (profile) {
      case "text-to-video-pure":
        return [
          `[提示词策略] 当前为纯文生视频。${promptTarget}主动补角色、场景、动作和环境锚点；先给强钩子，再用 2-4 个分镜时间段推进，不写抽象解释和静态设定清单。`,
        ];
      case "text-to-video-reference-guided":
        return [
          `[提示词策略] 当前为附参考图的文生视频。参考图锁定静态视觉事实；文字只补动作、表演、情绪推进、镜头运动和衔接结果，先给强钩子，再用 2-4 个分镜时间段推进。`,
        ];
      case "image-to-video":
        return [
          `[提示词策略] 当前为图生视频，首帧已固定基础构图。${promptTarget}只写后续动作变化、镜头运动、表演节奏和环境动态，把第一段当作首帧之后立刻发生的动作钩子。`,
        ];
      default:
        return [];
    }
  }

  switch (profile) {
    case "text-to-video-pure":
      return [
        `[提示词策略] 当前为纯文生视频，没有可用参考图。${promptTarget}必须主动补足角色外貌、服装、场景空间、光线、材质和氛围，避免只写抽象情绪词。`,
      ];
    case "text-to-video-reference-guided":
      return [
        `[提示词策略] 当前为文生视频，但已附参考图。把参考图视为角色外貌、服装、场景结构、光线色调和材质的唯一视觉锚点。${promptTarget}不要重新发明、覆盖或改写参考图里已经明确可见的视觉事实。`,
        `[提示词策略] 仅保留必要的识别锚点，例如角色名、服装标签、场景名和少量稳定特征；把描述重点放在动作、表演、机位、景别、镜头运动、节奏、衔接和剧情推进上。若文字设定与参考图冲突，以参考图中的可见外观与场景为准，同时保留剧情动作、叙事因果和台词约束。`,
      ];
    case "image-to-video":
      return [
        `[提示词策略] 当前为图生视频，首帧或参考图已经确定基础构图。${promptTarget}重点描述后续动作变化、镜头运动、表演节奏和环境动态，不要重写首帧里已经固定的静态视觉事实。`,
      ];
    default:
      return [];
  }
}

function parseSegmentPromptTimeValue(raw: string): number {
  const cleaned = String(raw || "").trim().replace(/[^\d:]/g, "");
  if (!cleaned) return 0;
  const parts = cleaned.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 1) return parts[0] || 0;
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return 0;
}

function normalizeSegmentPromptTimeCodes(text: string): string {
  return String(text || "")
    .replace(
      /\[(\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})s?\]\s*(?:镜头\s*\d+[:：]?)?/gi,
      (_, start, end) => `${parseSegmentPromptTimeValue(start)}-${parseSegmentPromptTimeValue(end)}秒：`,
    )
    .replace(
      /Scene\s*\d+\s*\((\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})\)[:：]?/gi,
      (_, start, end) => `${parseSegmentPromptTimeValue(start)}-${parseSegmentPromptTimeValue(end)}秒：`,
    )
    .replace(
      /(\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})\s*s\b/gi,
      (_, start, end) => `${parseSegmentPromptTimeValue(start)}-${parseSegmentPromptTimeValue(end)}秒`,
    );
}

const SEGMENT_PROMPT_PRIMARY_SECTION_LABELS = [
  "全局风格",
  "视觉锚点",
  "起始衔接",
  "衔接原则",
  "镜头推进",
  "环境细节",
  "结尾钩子",
  "通用后缀",
] as const;

const SEGMENT_PROMPT_ALL_SECTION_LABELS = [
  ...SEGMENT_PROMPT_PRIMARY_SECTION_LABELS,
  "台词",
] as const;

type SegmentPromptSectionLabel = (typeof SEGMENT_PROMPT_ALL_SECTION_LABELS)[number];

const SEGMENT_PROMPT_DETAIL_MIN_LENGTHS: Record<
  Exclude<SegmentPromptSectionLabel, "镜头推进" | "通用后缀" | "台词">,
  number
> = {
  全局风格: 12,
  视觉锚点: 16,
  起始衔接: 16,
  衔接原则: 14,
  环境细节: 12,
  结尾钩子: 12,
};

function escapeSegmentPromptSectionRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEGMENT_PROMPT_FINAL_SECTION_LABELS = [
  "全局风格",
  "镜头推进",
  "环境细节",
  "结尾钩子",
  "通用后缀",
] as const;

const SEGMENT_PROMPT_LEGACY_AUXILIARY_SECTION_LABELS = [
  "视觉锚点",
  "起始衔接",
  "衔接原则",
  "台词",
] as const;

function canonicalizeSegmentPromptSectionContent(content: string, joiner = "；"): string {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(joiner)
    .replace(/\s+/g, " ")
    .replace(/\s*([，。；：！？])/g, "$1")
    .replace(/([，。；：！？])(?=[，。；：！？])/g, "")
    .trim();
}

function normalizeSegmentPromptImageReferenceLine(
  line: string,
  fallbackIndex?: number,
): string {
  const match = String(line || "")
    .trim()
    .match(/^(?:图片|图)\s*(\d+)\s*[:：]\s*(.+)$/);
  if (!match) return "";
  const numericIndex = Number.parseInt(match[1] || "", 10);
  const index =
    Number.isFinite(numericIndex) && numericIndex > 0
      ? numericIndex
      : fallbackIndex || 1;
  const content = canonicalizeSegmentPromptSectionContent(match[2] || "", " ");
  return content ? `图片 ${index}：${content}` : "";
}

function normalizeSegmentPromptImageReferenceLines(
  value: string | null | undefined,
): string[] {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^逐图参考\s*[:：]?$/.test(line));
  const normalized = lines
    .map((line, index) => normalizeSegmentPromptImageReferenceLine(line, index + 1))
    .filter(Boolean);
  return normalized.map((line, index) =>
    normalizeSegmentPromptImageReferenceLine(line, index + 1),
  );
}

function extractSegmentPromptImageReferenceLines(text: string): string[] {
  return normalizeSegmentPromptImageReferenceLines(
    String(text || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /^(?:图片|图)\s*\d+\s*[:：]/.test(line))
      .join("\n"),
  );
}

function containsSufficientSegmentDetail(
  label: Exclude<SegmentPromptSectionLabel, "镜头推进" | "通用后缀" | "台词">,
  content: string,
): boolean {
  const normalized = canonicalizeSegmentPromptSectionContent(content, "；");
  return normalized.length >= SEGMENT_PROMPT_DETAIL_MIN_LENGTHS[label];
}

function stripSegmentPromptCommonControlTerms(content: string): string {
  return String(content || "")
    .replace(/\bno subtitles?\b/gi, "")
    .replace(/\bno watermark\b/gi, "")
    .replace(/\bno on[- ]screen text\b/gi, "")
    .replace(/无字幕|无水印|无屏幕文字/g, "")
    .replace(/[，,]\s*[，,]/g, "，")
    .replace(/^[，,\s]+|[，,\s]+$/g, "")
    .trim();
}

function normalizeSegmentPromptDialogueLine(line: string): string {
  return String(line || "")
    .replace(/^[【\[]?\s*(?:台词|对白)\s*[:：]\s*/i, "")
    .replace(/^音频\s*[:：]\s*/i, "")
    .replace(/[】\]]$/g, "")
    .replace(/([：:])\s*[“"'「『]+/g, "$1")
    .replace(/[“”"'「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSegmentPromptDialogueKey(line: string): string {
  return normalizeSegmentPromptDialogueLine(line)
    .replace(/[“”"'「」『』\s]/g, "")
    .replace(/：/g, ":")
    .trim();
}

function extractSegmentPromptDialogueSpeechText(line: string): string {
  const normalized = normalizeSegmentPromptDialogueLine(line);
  const separatorIndex = normalized.search(/[:：]/);
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1).trim() : normalized;
}

function buildSegmentPromptDialogueSpeechKey(line: string): string {
  return extractSegmentPromptDialogueSpeechText(line)
    .replace(/[“”"'「」『』\s]/g, "")
    .replace(/[，。；：！？,.!?…]/g, "")
    .trim();
}

function buildSegmentPromptDialogueSpeakerKey(line: string): string {
  const normalized = normalizeSegmentPromptDialogueLine(line);
  const separatorIndex = normalized.search(/[:：]/);
  const speaker = separatorIndex >= 0 ? normalized.slice(0, separatorIndex).trim() : normalized;
  return speaker
    .replace(/[“”"'「」『』\s]/g, "")
    .replace(/[，。；：！？,.!?…]/g, "")
    .trim();
}

const SEGMENT_PROMPT_CAMERA_LABEL_PREFIX_PATTERN =
  /^(?:镜头|特写|近景|中景|远景|全景|大全景|空镜|俯拍|仰拍|平视|侧拍|背拍|主观|推进|拉近|拉开|切至|切回|切换|转至|转向|摇向|摇镜|跟随|跟拍|定格|聚焦|焦点|转焦)\s*[:：]/;

function isLikelySegmentPromptDialogueLine(line: string): boolean {
  const trimmed = String(line || "").trim();
  if (!trimmed) return false;
  const withoutAudioPrefix = trimmed.replace(/^音频\s*[:：]\s*/, "");
  if (SEGMENT_PROMPT_CAMERA_LABEL_PREFIX_PATTERN.test(withoutAudioPrefix)) return false;
  return /^(?:音频\s*[:：]\s*)?[^：:\n]{1,20}[：:][^：\n]+$/.test(trimmed);
}

function splitSegmentPromptDialogueCandidates(line: string): string[] {
  const raw = String(line || "").replace(/[【】]/g, "").trim();
  if (!raw || raw.includes("无台词")) return [];
  const matches = Array.from(
    raw.matchAll(/(?:音频\s*[:：]\s*)?[^：:\n]{1,20}[：:][^：\n]+?(?=(?:\s*(?:音频\s*[:：]\s*)?[^：:\n]{1,20}[：:])|$)/g),
  )
    .map((match) => normalizeSegmentPromptDialogueLine(match[0]))
    .filter((candidate) => {
      const withoutAudioPrefix = candidate.replace(/^音频\s*[:：]\s*/, "");
      return !SEGMENT_PROMPT_CAMERA_LABEL_PREFIX_PATTERN.test(withoutAudioPrefix);
    })
    .filter(Boolean);
  if (matches.length) return matches;
  const normalized = normalizeSegmentPromptDialogueLine(raw);
  return normalized ? [normalized] : [];
}

function normalizeSegmentPromptDialogueGroup(
  value: string[] | string | null | undefined,
): string[] {
  const rawLines = Array.isArray(value)
    ? value
    : String(value || "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
  const normalizedLines: string[] = [];
  const seenKeys = new Set<string>();
  rawLines
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .flatMap((line) => splitSegmentPromptDialogueCandidates(line))
    .forEach((line) => {
      const normalized = normalizeSegmentPromptDialogueLine(line);
      const key = buildSegmentPromptDialogueKey(normalized);
      if (!normalized || !key || seenKeys.has(key)) return;
      seenKeys.add(key);
      normalizedLines.push(normalized);
    });
  return normalizedLines;
}

function normalizeSegmentPromptShotDialogueGroups(
  groups: Array<string[] | string | null | undefined> | undefined,
): string[][] {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => normalizeSegmentPromptDialogueGroup(group));
}

function distributeDetachedSegmentPromptDialogues(
  detachedDialogueLines: string[],
  shotDialogueGroups: string[][],
  blockCount: number,
): string[][] {
  const distributed = Array.from({ length: Math.max(0, blockCount) }, () => [] as string[]);
  if (!distributed.length) return distributed;

  const hintedDialogueKeys = new Set(
    shotDialogueGroups.flatMap((group) =>
      group
        .map((line) => buildSegmentPromptDialogueKey(line))
        .filter(Boolean),
    ),
  );
  const remainingDetachedLines = detachedDialogueLines
    .map((line) => normalizeSegmentPromptDialogueLine(line))
    .filter((line) => {
      const key = buildSegmentPromptDialogueKey(line);
      return !!line && !!key && !hintedDialogueKeys.has(key);
    });

  remainingDetachedLines.forEach((line, index) => {
    distributed[Math.min(index, distributed.length - 1)]?.push(line);
  });

  return distributed;
}

function stripTrailingSegmentPromptSpeechCue(text: string): string {
  return String(text || "")
    .replace(/[，、；]?\s*[^，；。！？\n]{1,24}[:：]\s*$/g, "")
    .replace(/[，、；\s]+$/g, "")
    .trim();
}

function stripMatchedInlineSegmentPromptDialogue(
  line: string,
  hintDialogueLines: string[],
): string {
  const spokenKeys = new Set(
    hintDialogueLines
      .map((dialogueLine) => buildSegmentPromptDialogueSpeechKey(dialogueLine))
      .filter(Boolean),
  );
  const speakerKeys = new Set(
    hintDialogueLines
      .map((dialogueLine) => buildSegmentPromptDialogueSpeakerKey(dialogueLine))
      .filter(Boolean),
  );
  let output = String(line || "").trim();
  if (!output || !spokenKeys.size) return output;

  const originalOutput = output;
  output = output.replace(/[“"'「『]([^”"」』]+)[”"」』]/g, (match, quotedText) => {
    const key = buildSegmentPromptDialogueSpeechKey(String(quotedText || ""));
    return key && spokenKeys.has(key) ? "" : match;
  });

  const lastSeparatorIndex = Math.max(output.lastIndexOf("："), output.lastIndexOf(":"));
  if (lastSeparatorIndex >= 0) {
    const head = output.slice(0, lastSeparatorIndex).trim();
    const tail = output.slice(lastSeparatorIndex + 1).trim();
    const tailKey = buildSegmentPromptDialogueSpeechKey(tail);
    if (tailKey && spokenKeys.has(tailKey)) {
      output = speakerKeys.has(buildSegmentPromptDialogueSpeakerKey(head)) ? "" : head;
    }
  }

  if (output !== originalOutput) {
    output = stripTrailingSegmentPromptSpeechCue(output);
    if (speakerKeys.has(buildSegmentPromptDialogueSpeakerKey(output))) {
      output = "";
    }
  }

  return output.replace(/[，、；\s]+$/g, "").trim();
}

function extractInlineSegmentPromptDialogues(
  line: string,
  hintDialogueLines: string[] = [],
): { content: string; dialogueLines: string[] } {
  let content = String(line || "").trim();
  const dialogueLines: string[] = [];
  const inlineAudioPattern =
    /(?:^|[，,\s])音频\s*[:：]\s*([^：:\n]{1,20}\s*[：:]\s*(?:[“"'「『][^”"'」』]+[”"'」』]|[^；;\n]+?))(?=(?:\s*[，,]?\s*音频\s*[:：])|$)/g;

  content = content.replace(/【\s*台词\s*[:：]([^】]+)】/g, (_match, dialogue) => {
    dialogueLines.push(...splitSegmentPromptDialogueCandidates(dialogue));
    return "";
  });

  const descriptivePieces: string[] = [];
  for (const piece of content.split(/；/).map((item) => item.trim()).filter(Boolean)) {
    const descriptive = stripMatchedInlineSegmentPromptDialogue(
      piece
      .replace(inlineAudioPattern, (_match, dialogue) => {
        dialogueLines.push(...splitSegmentPromptDialogueCandidates(dialogue));
        return "";
      })
      .replace(/[，,\s]+$/g, "")
      .trim(),
      hintDialogueLines,
    );
    if (!descriptive) {
      continue;
    }
    if (isLikelySegmentPromptDialogueLine(descriptive)) {
      dialogueLines.push(...splitSegmentPromptDialogueCandidates(descriptive));
      continue;
    }
    descriptivePieces.push(descriptive);
  }

  return {
    content: descriptivePieces.join("；").trim(),
    dialogueLines,
  };
}

function normalizeSegmentPromptSectionLabels(text: string): string {
  let normalized = normalizeSegmentPromptTimeCodes(String(text || ""))
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*[-*•]\s*/gm, "")
    .replace(/^\s*\d+[.)、]\s*/gm, "")
    .replace(/^\s*\[([^\]]+)\]\s*$/gm, "$1")
    .trim();

  const aliasReplacements: Array<[RegExp, string]> = [
    [/片段总目标[:：]?/g, "全局风格："],
    [/总目标[:：]?/g, "全局风格："],
    [/风格设定[:：]?/g, "全局风格："],
    [/角色设定[:：]?/g, "视觉锚点："],
    [/角色锚点[:：]?/g, "视觉锚点："],
    [/角色锁定[:：]?/g, "视觉锚点："],
    [/角色\/场景锚点[:：]?/g, "视觉锚点："],
    [/角色与场景一致性锁定[:：]?/g, "视觉锚点："],
    [/场景锚点[:：]?/g, "视觉锚点："],
    [/开场承接[:：]?/g, "起始衔接："],
    [/开头承接[:：]?/g, "起始衔接："],
    [/首帧承接[:：]?/g, "起始衔接："],
    [/接拍起点[:：]?/g, "起始衔接："],
    [/片段衔接[:：]?/g, "衔接原则："],
    [/镜头接力[:：]?/g, "衔接原则："],
    [/连续性要求[:：]?/g, "衔接原则："],
    [/镜头流程[:：]?/g, "镜头推进："],
    [/时间轴与分镜调度[:：]?/g, "镜头推进："],
    [/时间戳分镜法[:：]?/g, "镜头推进："],
    [/动作序列[:：]?/g, "镜头推进："],
    [/环境动态[:：]?/g, "环境细节："],
    [/环境变化[:：]?/g, "环境细节："],
    [/声音氛围[:：]?/g, "环境细节："],
    [/声音环境[:：]?/g, "环境细节："],
    [/音效提示[:：]?/g, "环境细节："],
    [/声音设计[:：]?/g, "环境细节："],
    [/节奏衔接[:：]?/g, "衔接原则："],
    [/转场与节奏[:：]?/g, "衔接原则："],
    [/结尾状态[:：]?/g, "结尾钩子："],
    [/台词约束[:：]?/g, "台词："],
    [/台词（仅音频\/口型，不以上屏文字呈现）[:：]?/g, "台词："],
  ];

  aliasReplacements.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });

  const labelPattern = SEGMENT_PROMPT_ALL_SECTION_LABELS
    .map((label) => escapeSegmentPromptSectionRegExp(label))
    .join("|");

  return normalized
    .replace(new RegExp(`\\s*(${labelPattern})\\s*[:：]`, "g"), "\n$1：")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function parseSegmentPromptSections(text: string): Map<SegmentPromptSectionLabel, string[]> {
  const sections = new Map<SegmentPromptSectionLabel, string[]>();
  const headingPattern = new RegExp(
    `^(${SEGMENT_PROMPT_ALL_SECTION_LABELS.map((label) => escapeSegmentPromptSectionRegExp(label)).join("|")})：\\s*(.*)$`,
  );
  const directBeatPattern = /^分镜\d+(?:（[^）]+）)?：/;
  let currentLabel: SegmentPromptSectionLabel | null = null;

  for (const rawLine of String(text || "").split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(headingPattern);
    if (match) {
      currentLabel = match[1] as SegmentPromptSectionLabel;
      if (!sections.has(currentLabel)) sections.set(currentLabel, []);
      if (match[2]?.trim()) sections.get(currentLabel)?.push(match[2].trim());
      continue;
    }
    if (directBeatPattern.test(line)) {
      currentLabel = "镜头推进";
      if (!sections.has(currentLabel)) sections.set(currentLabel, []);
      sections.get(currentLabel)?.push(line);
      continue;
    }
    if (!currentLabel) continue;
    sections.get(currentLabel)?.push(line);
  }

  return sections;
}

function normalizeSegmentTimelineMarker(marker: string, beatIndex: number): string {
  const trimmed = String(marker || "").trim();
  const storyboardMatch = trimmed.match(/^分镜\s*(\d+)\s*[（(]\s*([^）)]*)\s*[）)]\s*[:：]?$/);
  if (storyboardMatch) {
    const shotNumber = Number.parseInt(storyboardMatch[1], 10) || beatIndex;
    const timeLabel = String(storyboardMatch[2] || "").trim();
    return timeLabel ? `分镜${shotNumber}（${timeLabel}）：` : `分镜${shotNumber}：`;
  }
  const plainTimeMatch = trimmed.match(/^(\d+(?:\.\d+)?-\d+(?:\.\d+)?秒)\s*[:：]?$/);
  if (plainTimeMatch) {
    return `分镜${beatIndex}（${plainTimeMatch[1]}）：`;
  }
  const cameraMatch = trimmed.match(/^镜头\s*(\d+)\s*[:：]?$/);
  if (cameraMatch) {
    const shotNumber = Number.parseInt(cameraMatch[1], 10) || beatIndex;
    return `分镜${shotNumber}：`;
  }
  return `分镜${beatIndex}：`;
}

const SEGMENT_DIRECT_CONTINUATION_OPENING = "镜头直接承接上一段最后尾帧画面";

const SEGMENT_BEAT_CAMERA_OPENING_PATTERN =
  /^(?:镜头|特写|近景|中景|远景|全景|大全景|空镜|俯拍|仰拍|平视|侧拍|背拍|主观|低机位|高机位|低角度|高角度|广角|长焦|正面近景)/;

const SEGMENT_BEAT_MOTION_OPENING_PATTERN =
  /(推进|推近|拉近|拉开|横移|跟拍|跟随|切至|切回|切换|转至|转向|摇向|摇镜|扫过|压近|贴近|俯冲|抬升|滑向|掠过|逼近|后拉|移向|移至|承接|定格|停在|晃动)/;

function buildSegmentBeatOpeningPrefix(
  cameraDirectionHint: string,
  descriptionHint = "",
): string {
  const hint = String(cameraDirectionHint || "")
    .replace(/[【】[\]]/g, "")
    .replace(/^镜头\s*[:：]?\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallbackDescription = String(descriptionHint || "").replace(/\s+/g, " ").trim();
  const source = hint || fallbackDescription;
  const cameraMatch = source.match(
    /(特写|近景|中景|远景|全景|大全景|空镜|俯拍|仰拍|平视|侧拍|背拍|主观|低机位|高机位|低角度|高角度|广角|长焦|正面近景|镜头)/,
  );
  const motionMatch = source.match(SEGMENT_BEAT_MOTION_OPENING_PATTERN);
  const cameraWord = cameraMatch?.[1] || "镜头";
  const motionWord = motionMatch?.[1] || "推进";
  if (cameraWord === "镜头") {
    return `镜头${motionWord}`;
  }
  return `${cameraWord}${motionWord}`;
}

function stripSegmentBeatLeadingCameraCue(description: string): string {
  return String(description || "")
    .replace(
      /^(?:镜头|特写|近景|中景|远景|全景|大全景|空镜|俯拍|仰拍|平视|侧拍|背拍|主观|低机位|高机位|低角度|高角度|广角|长焦|正面近景)(?:\s*(?:推进|推近|拉近|拉开|横移|跟拍|跟随|切至|切回|切换|转至|转向|摇向|摇镜|扫过|压近|贴近|俯冲|抬升|滑向|掠过|逼近|后拉|移向|移至|承接|定格|停在|晃动))?[\s：:，,；;]*/,
      "",
    )
    .trim();
}

function ensureSegmentBeatCameraAndContinuityLanguage(
  description: string,
  beatIndex: number,
  options?: {
    forceDirectContinuationOnFirstBeat?: boolean;
    cameraDirectionHint?: string;
  },
): string {
  const trimmed = String(description || "").replace(/^[，,、；：\s]+/, "").trim();
  const normalizedWithoutForcedOpening = trimmed
    .replace(
      new RegExp(`^${escapeSegmentPromptSectionRegExp(SEGMENT_DIRECT_CONTINUATION_OPENING)}[，,、；：\\s]*`),
      "",
    )
    .replace(/^[，,、；：\s]+/, "")
    .trim();
  const baseDescription = beatIndex === 1 ? normalizedWithoutForcedOpening : trimmed;
  const openingClause = baseDescription.split(/[，,；;。！？]/)[0]?.trim() || "";
  const hasOpeningCamera = SEGMENT_BEAT_CAMERA_OPENING_PATTERN.test(openingClause);
  const hasOpeningMotion = SEGMENT_BEAT_MOTION_OPENING_PATTERN.test(openingClause);
  const normalizedDescription =
    baseDescription && (!hasOpeningCamera || !hasOpeningMotion)
      ? `${buildSegmentBeatOpeningPrefix(options?.cameraDirectionHint || "", baseDescription)}，${stripSegmentBeatLeadingCameraCue(baseDescription)}`
      : baseDescription;

  if (options?.forceDirectContinuationOnFirstBeat && beatIndex === 1) {
    if (!normalizedDescription) {
      return SEGMENT_DIRECT_CONTINUATION_OPENING;
    }
    return `${SEGMENT_DIRECT_CONTINUATION_OPENING}，${normalizedDescription}`;
  }
  return normalizedDescription;
}

function normalizeSegmentTimelineContent(
  content: string,
  detachedDialogueLines: string[],
  shotDialogueGroups: string[][],
  options?: {
    forceDirectContinuationOnFirstBeat?: boolean;
    shotCameraDirections?: Array<string | null | undefined>;
  },
): string {
  const normalized = normalizeSegmentPromptTimeCodes(String(content || ""))
    .replace(/^镜头推进\s*[:：]\s*/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/；\s*(?=(?:分镜\s*\d+\s*[（(]|镜头\s*\d+\s*[:：]|\d+(?:\.\d+)?-\d+(?:\.\d+)?秒\s*[:：]))/g, "\n")
    .replace(/(分镜\s*\d+\s*[（(][^）)]*[）)]\s*[:：])/g, "\n$1")
    .replace(/(镜头\s*\d+\s*[:：])/g, "\n$1")
    .replace(/(^|[^\n])(\d+(?:\.\d+)?-\d+(?:\.\d+)?秒\s*[:：])/g, "$1\n$2")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const markerPattern = /^(分镜\s*\d+\s*[（(][^）)]*[）)]\s*[:：]?|镜头\s*\d+\s*[:：]?|\d+(?:\.\d+)?-\d+(?:\.\d+)?秒\s*[:：]?)(.*)$/;
  const blocks: Array<{ marker: string; body: string[] }> = [];
  let currentBlock: { marker: string; body: string[] } | null = null;

  normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(markerPattern);
      if (match) {
        currentBlock = {
          marker: match[1].trim(),
          body: match[2]?.trim() ? [match[2].trim()] : [],
        };
        blocks.push(currentBlock);
        return;
      }
      if (!currentBlock) {
        currentBlock = { marker: `分镜${blocks.length + 1}：`, body: [line] };
        blocks.push(currentBlock);
        return;
      }
      currentBlock.body.push(line);
    });

  if (!blocks.length) {
    return canonicalizeSegmentPromptSectionContent(normalized, "；");
  }

  const distributedDetachedDialogues = distributeDetachedSegmentPromptDialogues(
    detachedDialogueLines,
    shotDialogueGroups,
    blocks.length,
  );

  const seenDialogueKeys = new Set<string>();
  return blocks
    .map((block, blockIndex) => {
      const descriptionPieces: string[] = [];
      const dialogueLines: string[] = [];
      const blockHintDialogueLines = [
        ...(shotDialogueGroups[blockIndex] || []),
        ...(distributedDetachedDialogues[blockIndex] || []),
      ];

      block.body.forEach((line) => {
        const extracted = extractInlineSegmentPromptDialogues(line, blockHintDialogueLines);
        if (extracted.content) {
          descriptionPieces.push(extracted.content);
        }
        extracted.dialogueLines.forEach((dialogueLine) => {
          const key = buildSegmentPromptDialogueKey(dialogueLine);
          if (!key || seenDialogueKeys.has(key)) return;
          seenDialogueKeys.add(key);
          dialogueLines.push(dialogueLine);
        });
      });

      (shotDialogueGroups[blockIndex] || []).forEach((dialogueLine) => {
        const normalizedLine = normalizeSegmentPromptDialogueLine(dialogueLine);
        const key = buildSegmentPromptDialogueKey(normalizedLine);
        if (!normalizedLine || !key || seenDialogueKeys.has(key)) return;
        seenDialogueKeys.add(key);
        dialogueLines.push(normalizedLine);
      });

      distributedDetachedDialogues[blockIndex]?.forEach((dialogueLine) => {
        const normalizedLine = normalizeSegmentPromptDialogueLine(dialogueLine);
        const key = buildSegmentPromptDialogueKey(normalizedLine);
        if (!normalizedLine || !key || seenDialogueKeys.has(key)) return;
        seenDialogueKeys.add(key);
        dialogueLines.push(normalizedLine);
      });

      const marker = normalizeSegmentTimelineMarker(block.marker, blockIndex + 1);
      const description = ensureSegmentBeatCameraAndContinuityLanguage(
        canonicalizeSegmentPromptSectionContent(descriptionPieces.join("；"), "；").replace(/。(?=；)/g, ""),
        blockIndex + 1,
        {
          forceDirectContinuationOnFirstBeat: options?.forceDirectContinuationOnFirstBeat,
          cameraDirectionHint: options?.shotCameraDirections?.[blockIndex] || "",
        },
      );
      const lines = [`${marker}${description}`.trim()];
      dialogueLines.forEach((dialogueLine) => lines.push(dialogueLine));
      return lines.filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function resolvePromptEnhancerTextModel(requestedModel: unknown): string {
  const explicitModel =
    typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (explicitModel) return explicitModel;

  const storedModel = readStoredHomeAgentTextModelKey();
  const storedRuntime = resolveHomeAgentTextModelRuntime(
    { getApiConfig, resolveConfiguredModelName },
    storedModel,
  );

  if (hasUsableApiCredential(storedRuntime.baseUrl, storedRuntime.apiKey)) {
    return storedModel;
  }

  return "gemini-3-flash-preview";
}

function hasDetailedSegmentTimelineContent(content: string): boolean {
  const beatLines = String(content || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^分镜\d+/.test(line));

  if (!beatLines.length) return false;
  return beatLines.every((line) => {
    const description = line.replace(/^分镜\d+(?:（[^）]+）)?：/, "").trim();
    return description.length >= 10;
  });
}

export function formatDetailedSegmentPrompt(
  value: string,
  options?: {
    shotDialogueGroups?: Array<string[] | string | null | undefined>;
    shotCameraDirections?: Array<string | null | undefined>;
    referenceUsageText?: string | null | undefined;
    hasContinuityGridReference?: boolean | null | undefined;
  },
): string {
  const normalized = normalizeSegmentPromptSectionLabels(value);
  const sections = parseSegmentPromptSections(normalized);
  const detachedDialogueLines = (sections.get("台词") || [])
    .flatMap((line) => splitSegmentPromptDialogueCandidates(line))
    .filter(Boolean);
  const shotDialogueGroups = normalizeSegmentPromptShotDialogueGroups(options?.shotDialogueGroups);
  const finalSectionOrder = SEGMENT_PROMPT_FINAL_SECTION_LABELS;
  const imageReferenceLines =
    typeof options?.referenceUsageText === "string" && options.referenceUsageText.trim()
      ? normalizeSegmentPromptImageReferenceLines(options.referenceUsageText)
      : extractSegmentPromptImageReferenceLines(value);
  const hasContinuityGridReference =
    typeof options?.hasContinuityGridReference === "boolean"
      ? options.hasContinuityGridReference
      : imageReferenceLines.some((line) => /六宫格/.test(line));

  const resolveSection = (label: SegmentPromptSectionLabel): string =>
    canonicalizeSegmentPromptSectionContent((sections.get(label) || []).join("\n"), "；");

  const globalStyle = stripSegmentPromptCommonControlTerms(resolveSection("全局风格"));
  const legacyVisualAnchors = resolveSection("视觉锚点");
  const legacyStartContinuity = resolveSection("起始衔接");
  const environmentDetails = resolveSection("环境细节");
  const endingHook = resolveSection("结尾钩子");
  const suffix = resolveSection("通用后缀") || "无字幕、无水印、无屏幕文字";
  const rawTimelineSource =
    (sections.get("镜头推进") || []).join("\n") ||
    String(value || "")
      .replace(/\r\n?/g, "\n")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /^分镜\d+/.test(line))
      .join("\n");
  const timelineContent = normalizeSegmentTimelineContent(
    rawTimelineSource,
    detachedDialogueLines,
    shotDialogueGroups,
    {
      forceDirectContinuationOnFirstBeat: hasContinuityGridReference,
      shotCameraDirections: options?.shotCameraDirections,
    },
  );

  const missingSections = [
    !globalStyle ? "全局风格" : "",
    !timelineContent ? "分镜" : "",
    !environmentDetails ? "环境细节" : "",
    !endingHook ? "结尾钩子" : "",
  ].filter(Boolean);
  if (missingSections.length) {
    throw new Error(`segment prompt missing required sections: ${missingSections.join("、")}`);
  }

  const terseSections = [
    globalStyle.length < SEGMENT_PROMPT_DETAIL_MIN_LENGTHS["全局风格"] ? "全局风格" : "",
    environmentDetails.length < SEGMENT_PROMPT_DETAIL_MIN_LENGTHS["环境细节"] ? "环境细节" : "",
    endingHook.length < SEGMENT_PROMPT_DETAIL_MIN_LENGTHS["结尾钩子"] ? "结尾钩子" : "",
  ].filter(Boolean);
  if (terseSections.length) {
    throw new Error(`segment prompt sections too terse: ${terseSections.join("、")}`);
  }

  if (!hasDetailedSegmentTimelineContent(timelineContent)) {
    throw new Error("segment prompt storyboard beats too terse");
  }

  const timelineLines = timelineContent
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!imageReferenceLines.length && timelineLines.length) {
    const legacyOpeningContext = SEGMENT_PROMPT_LEGACY_AUXILIARY_SECTION_LABELS
      .filter((label) => label === "视觉锚点" || label === "起始衔接")
      .map((label) =>
        label === "视觉锚点" ? legacyVisualAnchors : legacyStartContinuity,
      )
      .filter(Boolean)
      .join("；");
    if (legacyOpeningContext) {
      timelineLines[0] = timelineLines[0].replace(
        /^(分镜\d+(?:（[^）]+）)?：)/,
        `$1${legacyOpeningContext}；`,
      );
    }
  }

  const normalizedTimelineLines = timelineLines.map((line, index) => {
    const normalizedLine = String(line || "")
      .replace(/。(?=；)/g, "")
      .trim();
    const match = normalizedLine.match(/^(分镜\d+(?:（[^）]+）)?：)(.*)$/);
    if (!match) return normalizedLine;
    const description = ensureSegmentBeatCameraAndContinuityLanguage(match[2].trim(), index + 1, {
      forceDirectContinuationOnFirstBeat: hasContinuityGridReference,
      cameraDirectionHint: options?.shotCameraDirections?.[index] || "",
    });
    return `${match[1]}${description}`.trim();
  });

  return [
    ...imageReferenceLines,
    `全局风格：${globalStyle}`,
    ...normalizedTimelineLines,
    `环境细节：${environmentDetails}`,
    `结尾钩子：${endingHook}`,
    `通用后缀：${suffix}`,
  ]
    .filter((line, index) => {
      if (index < imageReferenceLines.length) return true;
      return finalSectionOrder.length > 0;
    })
    .join("\n");
}

async function localEnhancePromptV2(body: any, abortSignal?: AbortSignal) {
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
    videoMode,
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
    continuityReferenceImageUrl,
    continuityReferenceUsageText,
    hasContinuityGridReference,
    continuityRules,
    previousSegmentSummary,
    nextSegmentSummary,
    previousSegmentPrompt,
    previousSegmentEndState,
    currentSegmentStartState,
    currentSegmentEndState,
    nextSegmentStartState,
    currentSegmentStoryGoal,
    currentSegmentScriptSource,
    currentSegmentScriptSkeleton,
    currentSegmentShotRelayPlan,
    retryFeedback,
    textModel,
  } = body;
  const promptEnhancerModel = resolvePromptEnhancerTextModel(textModel);
  const guidanceProfile = resolveVideoPromptGuidanceProfile({
    videoMode,
    referenceImageUrl,
    characterImages,
    sceneImages,
  });

  // transition-decision 模式：AI 决定 xfade 转场类型
  if (mode === "transition-decision") {
    const rawPrompt = typeof body._rawPrompt === "string" ? body._rawPrompt : "";
    if (!rawPrompt) throw new Error("transition-decision 模式缺少 _rawPrompt");

    const parts = [{ text: rawPrompt }];
    const result = await callGemini(promptEnhancerModel, [{ role: "user", parts }]);
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
    promptParts.push(...buildVideoPromptGuidanceNotes(guidanceProfile, "segment"));

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
      promptParts.push(`[上一片段结尾状态]\n只提取下一段开头接拍所需的停点：动作结果、角色站位、视线方向、镜头轴线和情绪状态，不要复述上一片段完整剧情。\n${previousSegmentPrompt}`);
    }

    if (previousSegmentEndState) {
      promptParts.push(`[上一片段末帧停点]\n${previousSegmentEndState}`);
    }

    if (typeof continuityReferenceUsageText === "string" && continuityReferenceUsageText.trim()) {
      promptParts.push(`[图片参考优先级与用途]\n${continuityReferenceUsageText}`);
    }

    if (typeof continuityReferenceImageUrl === "string" && continuityReferenceImageUrl.trim()) {
      promptParts.push(
        [
          "[连续性参考图解读要求]",
          "若已上传上一片段连续性参考图，不要把它当普通风格图。",
          "若这是一张六宫格前情图，就按画面顺序理解上一段镜头如何一步步运动到当前片段开场：角色如何位移、视线如何转移、镜头轴线和主光如何延续、情绪如何递进，并把六宫格尾帧当作本段首镜直接接拍的基准。",
          "若这是一张上一片段真实末帧或关键帧，就把它当作首镜动作结果和构图落点的硬约束，只在其基础上继续，不重演上一段。",
          "其他参考图只补角色外观、场景结构与材质，不得推翻连续性参考图已经确定的动作关系、姿态、站位、视线、轴线和环境动势。",
        ].join("\n"),
      );
    }

    if (currentSegmentStartState) {
      promptParts.push(`[本片段开场画面目标]\n${currentSegmentStartState}`);
    }

    if (currentSegmentScriptSkeleton) {
      promptParts.push(`[当前片段分镜拆解骨架]\n${currentSegmentScriptSkeleton}`);
    }

    if (currentSegmentShotRelayPlan) {
      promptParts.push(`[当前片段镜头接力骨架]\n${currentSegmentShotRelayPlan}`);
    }

    if (currentSegmentStoryGoal) {
      promptParts.push(`[当前片段剧情主线]\n${currentSegmentStoryGoal}`);
    }

    if (currentSegmentScriptSource) {
      promptParts.push(`[对应剧本补全参考]\n${currentSegmentScriptSource}`);
    }

    promptParts.push(
      "[拆解结果继承原则]\n后续所有分镜扩写、参考图解读和最终提交都必须以当前片段分镜拆解骨架与对应剧本补全参考为最高优先级剧情事实，不能为了压缩字数、追求镜头感或贴参考图而吞掉已拆解的关键动作、反应、结果和信息揭示。",
    );

    promptParts.push(
      "[上下文补全规则]\n只检查上一片段停点、本片段开场目标、当前分镜骨架、本片段结尾目标和下一片段开场目标这几个交界。若剧本在这些位置明确缺少动作、反应、视线、状态变化或衔接结果，只补进最邻近的对应分镜，不要留在分镜外，也不要塞进起始衔接、衔接原则、环境细节或结尾钩子。",
    );
    promptParts.push(
      "[跨片段剧情兜底]\n若剧本关键拍点正好压在片段边界，可并入最近的上一片段结尾或下一片段开场，但在当前片段与相邻片段组成的上下文窗口里，这条剧情不能缺失。",
    );

    promptParts.push(
      "[剧情扩写边界]\n先严格按当前片段已拆解分镜的顺序、时长和基础动作逐镜扩写；只有剧本原文明确存在缺口时，才补对应动作、反应、视线、状态变化或衔接结果，不新增剧本外事件、不提前结果，也不改写人物关系和因果顺序。",
    );

    if (currentSegmentEndState) {
      promptParts.push(`[本片段结尾画面目标]\n${currentSegmentEndState}`);
    }

    if (nextSegmentSummary) {
      promptParts.push(`[下一片段摘要]\n${nextSegmentSummary}`);
    }

    if (nextSegmentStartState) {
      promptParts.push(`[下一片段开场承接目标]\n${nextSegmentStartState}`);
    }

    if (typeof retryFeedback === "string" && retryFeedback.trim()) {
      promptParts.push(`[本轮修正重点]\n${retryFeedback.trim()}`);
    }

    promptParts.push(`[未增强分镜处理规则]\n${SEGMENT_RAW_SHOT_ENHANCE_RULES}`);

    const shotLines = (shots as any[]).map((shot) => {
      const sourceLabel = shot.promptSource === "enhanced"
        ? "复用已有镜头 prompt"
        : "片段内补足镜头 prompt";
      return [
        `分镜${shot.index}（${shot.duration}秒，${sourceLabel}）：${shot.prompt}`,
        shot.rawDescription && shot.rawDescription !== shot.prompt ? `【原始分镜】${shot.rawDescription}` : "",
        shot.cameraDirection ? `【镜头：${shot.cameraDirection}】` : "",
        shot.dialogue ? `【台词：${shot.dialogue}】` : "",
      ].filter(Boolean).join("");
    });
    promptParts.push(`[分镜列表]\n${shotLines.join("\n")}`);

    if (hasRefImage || referenceImageUrl) {
      promptParts.push(
        "若附有场景参考图，把它当作场景构图、光线、材质和空间氛围的主要视觉锚点；文字重点补动作变化、情绪推进和环境动态。",
      );
    }
    if (Array.isArray(characterImages) && characterImages.length) {
      promptParts.push(
        "若附有角色参考图，把它当作角色外貌、服装和识别点的主要视觉锚点；文字重点写动作、表演、情绪和镜头调度。",
      );
    }
    if (Array.isArray(sceneImages) && sceneImages.length) {
      promptParts.push(
        "若附有多张场景参考图，先对齐共通视觉事实，再补镜头内的变化和环境动态。",
      );
    }

    promptParts.push(
      [
        "[最终提交版要求]",
        "只输出一份可直接交给视频模型执行的片段 prompt，不输出分析过程，不重复输入清单，不堆砌 QA 规则。",
        "最终结构必须稳定为：图片参考段落（若存在） -> 全局风格 -> 分镜1...分镜N -> 环境细节 -> 结尾钩子 -> 通用后缀。",
        "不要再输出“视觉锚点”“起始衔接”“衔接原则”“台词”这些独立旧区块；它们的有效信息必须融进图片参考说明、分镜1起拍、后续分镜推进和对应分镜台词落位里。",
        "全局风格第一句同时写风格、时长、氛围、镜头质感，不要把“无字幕、无水印、无屏幕文字”写进开头或正文。",
        "分镜必须逐行输出，固定使用“分镜1（0-5秒）：”“分镜2（5-10秒）：”这种格式；不要改成工程说明，也不要把多个分镜挤进一行。",
        "只要输入里有多个关键分镜或多个 source shots，就必须把这些关键分镜全部落成独立时间段；不要只写第一镜，不要把中段和结尾关键动作吞进概括句，也不要用一段笼统描述替代后续分镜。",
        "分镜正文只能写在“分镜1…分镜N”这些时间段里；不要把具体分镜动作、台词或后续镜头内容塞进起始衔接、衔接原则、环境细节或结尾钩子。",
        "第一段先给最强视觉钩子、冲突、异动或情绪突变；中段负责升级、反应或转折；最后一段负责落点并给下一片段留衔接。",
        "若存在图片参考，默认图片段落排在最前面，并且所有图片里已经确定的人物状态、镜头关系、动作惯性、烟尘漂浮和光影氛围优先级最高。",
        "若存在六宫格连续时间参考，分镜1第一句话必须以“镜头直接承接上一段最后尾帧画面”开头；若不存在六宫格连续时间参考，严禁使用这句话，分镜1只需直接从当前首镜起拍状态切入，不得另起炉灶重铺垫；分镜尾部要保留给下一镜和下一片段的明确接力点。",
        "后续所有分镜都必须以当前片段分镜拆解骨架与对应剧本补全参考为最高优先级剧情事实，不得吞掉已拆解的关键动作、反应、结果和信息揭示。",
        "每个分镜开头只需先给一个明确的镜头和运镜起手，例如“中景推进”“特写拉近”“远景横移”；后面正文保持原有篇幅，不要为了补镜头词额外扩写大段表演、焦点变化或环境枝节。",
        "优先保持同一视角关系和同一动作链的连续拍摄逻辑，只做必要的推进、横移、转焦或关注重心递进；除非剧情明确要求，不要每个分镜都重新建立完全无关的新视角。",
        "单独补一句环境细节，优先写风、雨、烟尘、光影、粒子、碎屑、能量波动、呼吸、脚步、衣料摩擦、远处人声等能被模型转成画面动势的元素。",
        "prompt 开头要自然承接上一片段结尾状态，分镜1第一句直接从上一片段最后一个可见动作结果起拍；如果给了本片段开场/结尾画面目标，要把它们分别落进分镜1和结尾钩子里。",
        "结尾单独补一个“结尾钩子：”区块，停在下一片段可以直接接上的动作、视线、姿态势能或情绪停点，尽量形成尾帧对首帧的连续长片衔接。",
        "不要让片段内部出现非剧情要求的跨地点、跨时间、跨服装、跨光位、跳轴、反向或动作重演；不要把下一片段的关键事件提前演出来。",
        "若输入里有台词，把台词直接挂在对应“分镜N（x-y秒）：”下面另起一行并保持原文；不要额外输出独立“台词：”区块，也不要把台词改成字幕提示或锁定协议。同一句台词若已在更早分镜出现，后续分镜不要重复输出。",
        "在全文最后单独追加一行“通用后缀： 无字幕、无水印、无屏幕文字”；正文其他位置不要重复这些控制词。",
        "参考图已明确的静态视觉事实不要反复重写；把篇幅优先留给核心动作、必要的情绪变化和衔接结果。",
        "每个时间段尽量 1-2 句，优先使用具体动作、速度、方向和视线词；除非剧情真的需要，不要堆砌过多微表情、焦点变化或环境枝节。",
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

    const segData = await callGemini(
      promptEnhancerModel,
      [{ role: "user", parts: segParts }],
      {
        temperature: 0.1,
        topP: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
      abortSignal,
    );
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

    const finalSegPrompt = formatDetailedSegmentPrompt(segPrompt, {
      shotDialogueGroups: Array.isArray(shots) ? shots.map((shot) => shot?.dialogue || "") : [],
      shotCameraDirections: Array.isArray(shots) ? shots.map((shot) => shot?.cameraDirection || "") : [],
      referenceUsageText: continuityReferenceUsageText,
      hasContinuityGridReference:
        typeof hasContinuityGridReference === "boolean"
          ? hasContinuityGridReference
          : undefined,
    });
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
  promptParts.push(...buildVideoPromptGuidanceNotes(guidanceProfile, "single"));
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

  const data = await callGemini(
    promptEnhancerModel,
    [{ role: "user", parts }],
    undefined,
    abortSignal,
  );
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


