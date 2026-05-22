/**
 * Gemini API 客户端
 *
 * 直接调用各服务 API，使用设置中配置的 API Key
 */
import {
  getApiConfig,
  isArkJimengEndpoint,
  resolveConfiguredModelName,
  resolveJimengApiKey,
  syncApiConfigToServerProxy,
} from "@/lib/api-config";
import { getServerProxyEndpoint, isServerProxyEndpoint } from "@/lib/server-proxy";
import { getNetworkRetrySettings } from "@/lib/network-retry-settings";
import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import {
  buildThumbnailRelativePath,
  persistAssetToProjectCache,
  safeCacheName,
} from "@/lib/upload-base64-to-storage";
import { uploadBase64ToCloudMedia } from "@/lib/home-agent/cloud-media-storage";

export const DEFAULT_GEMINI_BASE_URL = "https://api.tu-zi.com/v1beta";
export const DEFAULT_GEMINI_RETRY_COUNT = 1;
export const DEFAULT_GEMINI_RETRY_DELAY_MS = 800;

/** 移除模型输出中的 <think>...</think> 推理块（含不完整块） */
function stripThinkingBlocks(text: string): string {
  // 移除完整的 <think>...</think> 块（含跨行内容）
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
export const DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS = 240;
export const DEFAULT_ASYNC_IMAGE_POLL_INTERVAL_MS = 2500;
export const DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS = 4 * 60_000;

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0 秒";
  if (durationMs % 60_000 === 0) {
    return `${durationMs / 60_000} 分钟`;
  }
  return `${Math.ceil(durationMs / 1_000)} 秒`;
}

function createAbortError(message = "请求已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class AsyncImageTaskPendingError extends Error {
  readonly taskId: string;
  readonly status: string;
  readonly progress: number | null;
  readonly createdAt: number | null;
  readonly attempts: number;
  readonly maxDurationMs: number;

  constructor(params: {
    taskId: string;
    status: string;
    progress?: number | null;
    createdAt?: number | null;
    attempts: number;
    maxDurationMs: number;
    maxAttempts?: number;
  }) {
    super(
      `异步图像任务仍在排队中。已等待约 ${formatDurationMs(params.maxDurationMs)}。`,
    );
    this.name = "AsyncImageTaskPendingError";
    this.taskId = params.taskId;
    this.status = params.status;
    this.attempts = params.attempts;
    this.maxDurationMs = params.maxDurationMs;
    this.progress =
      typeof params.progress === "number" && Number.isFinite(params.progress)
        ? params.progress
        : null;
    this.createdAt =
      typeof params.createdAt === "number" && Number.isFinite(params.createdAt)
        ? params.createdAt
        : null;
  }
}

export function isAsyncImageTaskPendingError(error: unknown): error is AsyncImageTaskPendingError {
  return (
    error instanceof AsyncImageTaskPendingError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name === "AsyncImageTaskPendingError")
  );
}

export function getProgressiveAsyncImagePollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 5_000) return 1_000;
  if (elapsedMs < 15_000) return 2_000;
  return 5_000;
}

async function waitForAsyncImagePollDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
const imageBase64Cache = new Map<
  string,
  Promise<{ data: string; mimeType: string } | null>
>();

/** 全局 Gemini 并发控制：同一时间最多 N 个请求打到 OneAPI */
const MAX_CONCURRENT_GEMINI = 6;
const geminiSem = { count: 0, queue: [] as Array<() => void> };

function waitForGeminiSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (geminiSem.count < MAX_CONCURRENT_GEMINI) {
      geminiSem.count++;
      resolve();
    } else {
      geminiSem.queue.push(() => {
        geminiSem.count++;
        resolve();
      });
    }
  });
}

function releaseGeminiSlot() {
  geminiSem.count--;
  const next = geminiSem.queue.shift();
  if (next) next();
}

// ===== 服务名称映射 =====
export type AiService = "gemini" | "gpt" | "claude" | "grok" | "seedream" | "jimeng" | "aliyun" | "runninghub" | "tuzi";

function shouldUseLocalImageDevProxy(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.electronAPI?.invoke === "function") return false;
  const { protocol, hostname } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return false;
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(hostname);
}

// ===== 按服务解析密钥 =====

export function resolveDirectApiKey(service: AiService | null): string {
  const c = getApiConfig();
  if (service === "tuzi") {
    if (!c.tuziKey?.trim())
      throw new Error("请先在设置中配置 Sora API Key");
    return c.tuziKey.trim();
  }
  if (service === "jimeng") {
    const k = resolveJimengApiKey(c);
    if (!k) {
      if (isArkJimengEndpoint(c.jimengEndpoint)) {
        throw new Error("请先在设置中配置 Seedance / Ark 专用 API Key；当前 Ark 直连不能复用 Gemini API Key");
      }
      throw new Error("请先在设置中配置 Seedance API Key，或与 Gemini 共用同一密钥");
    }
    return k;
  }
  if (service === "aliyun") {
    const k = c.aliyunKey?.trim();
    if (!k) throw new Error("璇峰厛鍦ㄨ缃腑閰嶇疆阿里云 HappyHorse API Key");
    return k;
  }
  if (service === "runninghub") {
    const k = c.runninghubKey?.trim();
    if (!k) throw new Error("璇峰厛鍦ㄨ缃腑閰嶇疆 RunningHub API Key");
    return k;
  }
  if (service === "gpt") {
    const k = c.gptKey?.trim() || c.geminiKey?.trim();
    if (!k) throw new Error("请先在设置中配置 GPT API Key");
    return k;
  }
  if (service === "claude") {
    const k = c.claudeKey?.trim() || c.geminiKey?.trim();
    if (!k) throw new Error("请先在设置中配置 Claude API Key");
    return k;
  }
  if (service === "grok") {
    const k = c.grokKey?.trim() || c.geminiKey?.trim();
    if (!k) throw new Error("请先在设置中配置 Grok API Key");
    return k;
  }
  if (service === "seedream") {
    const k = c.seedreamKey?.trim() || c.geminiKey?.trim();
    if (!k) throw new Error("请先在设置中配置 Seedream API Key");
    return k;
  }
  if (!c.geminiKey?.trim())
    throw new Error("请先在设置中配置 Gemini API Key");
  return c.geminiKey.trim();
}

// ===== 直连 Fetch（Bearer 使用对应服务的 Key）=====

/** OneAPI / 推理网关常见不可用状态码，触发重试 */
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504, 429, 500, 502]);

/**
 * 直连 API 请求
 */
export async function directFetch(
  targetUrl: string,
  targetHeaders: Record<string, string>,
  body?: string | FormData,
  signal?: AbortSignal,
  serviceHint: AiService | null = null,
): Promise<Response> {
  if (isServerProxyEndpoint(targetUrl)) {
    await syncApiConfigToServerProxy();
  }
  const apiKey = isServerProxyEndpoint(targetUrl) ? "" : resolveDirectApiKey(serviceHint);

  const { maxRetries: MAX_RETRIES, delayMs: BASE_DELAY_MS } =
    getNetworkRetrySettings();

  const doFetch = () => {
    const headers: Record<string, string> = { ...targetHeaders };
    if (apiKey && !headers["Authorization"] && !headers["authorization"]) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    // Determine method: POST if Content-Type is set OR if body is FormData
    const method = targetHeaders["Content-Type"] || body instanceof FormData ? "POST" : "GET";

    // Don't set Content-Type for FormData - browser will set it with boundary
    const finalHeaders = body instanceof FormData
      ? Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'))
      : headers;

    return fetch(targetUrl, {
      method,
      headers: finalHeaders,
      body: method === "POST" ? (body || undefined) : undefined,
      signal,
    });
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw createAbortError();

    try {
      const resp = await doFetch();
      if (RETRYABLE_STATUS_CODES.has(resp.status) && attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 60_000);
        await waitForAsyncImagePollDelay(delay, signal);
        continue;
      }
      return resp;
    } catch (fetchErr: any) {
      if (signal?.aborted) throw fetchErr;
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 60_000);
        await waitForAsyncImagePollDelay(delay, signal);
        continue;
      }
      throw fetchErr;
    }
  }

  return doFetch();
}

/**
 * Gemini 专用的带并发控制的请求。
 * 限制同时最多 MAX_CONCURRENT_GEMINI 个请求，避免打爆 OneAPI。
 * 对 503 / 429 / 502 / 500 / 504 进行指数退避重试。
 */
export async function geminiFetch(
  targetUrl: string,
  targetHeaders: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
): Promise<Response> {
  await waitForGeminiSlot();
  try {
    if (isServerProxyEndpoint(targetUrl)) {
      await syncApiConfigToServerProxy();
    }
    const apiKey = isServerProxyEndpoint(targetUrl) ? "" : resolveDirectApiKey("gemini");
    const { maxRetries: MAX_RETRIES, delayMs: BASE_DELAY_MS } =
      getNetworkRetrySettings();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw createAbortError();

      try {
        const headers: Record<string, string> = { ...targetHeaders };
        if (apiKey && !headers["Authorization"] && !headers["authorization"]) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }
        const resp = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: body || undefined,
          signal,
        });

        if (RETRYABLE_STATUS_CODES.has(resp.status) && attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 60_000);
          await waitForAsyncImagePollDelay(delay, signal);
          continue;
        }
        return resp;
      } catch (fetchErr: any) {
        if (signal?.aborted) throw fetchErr;
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 60_000);
          await waitForAsyncImagePollDelay(delay, signal);
          continue;
        }
        throw fetchErr;
      }
    }
    // unreachable, but satisfy TS
    throw new Error("geminiFetch exhausted retries");
  } finally {
    releaseGeminiSlot();
  }
}

// ===== 别名（兼容旧调用方）=====
export { directFetch as proxiedFetch };
export { directFetch as getFetchMethod };

export const smartDirectOrProxyFetch = directFetch;

function isChatCompletionsModel(model: string): boolean {
  return /^(gpt-|grok-)/i.test(String(model || "").trim());
}

function isMessagesApiModel(model: string): boolean {
  return /^claude-/i.test(String(model || "").trim());
}

function buildChatCompletionsUrl(base: string): string {
  const root = String(base || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/i, "")
    .replace(/\/v1(\/.*)?$/i, "");
  return `${root}/v1/chat/completions`;
}

function buildMessagesApiUrl(base: string): string {
  const root = String(base || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/i, "")
    .replace(/\/v1(\/.*)?$/i, "");
  return `${root}/v1/messages`;
}

function convertContentsToChatMessages(contents: any[]): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  return (Array.isArray(contents) ? contents : [])
    .map((entry) => {
      const role =
        entry?.role === "model"
          ? "assistant"
          : entry?.role === "system"
            ? "system"
            : "user";
      const content = Array.isArray(entry?.parts)
        ? entry.parts
            .map((part: any) => {
              if (typeof part?.text === "string") return part.text;
              if (part?.fileData?.fileUri) return `[file] ${part.fileData.fileUri}`;
              if (part?.inlineData) return "[inline data omitted]";
              return "";
            })
            .filter(Boolean)
            .join("\n\n")
        : "";
      return { role: role as "system" | "user" | "assistant", content: String(content || "").trim() };
    })
    .filter((message) => !!message.content);
}

function buildStructuredJsonResponseFormat(
  generationConfig?: Record<string, any>,
): Record<string, unknown> | undefined {
  if (generationConfig?.responseMimeType !== "application/json") return undefined;

  const schema =
    generationConfig?.responseSchema &&
    typeof generationConfig.responseSchema === "object"
      ? generationConfig.responseSchema
      : null;

  if (schema) {
    return {
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        schema,
        strict: true,
      },
    };
  }

  return { type: "json_object" };
}

function splitSystemInstructions(contents: any[]): {
  systemPrompt: string | undefined;
  contents: any[];
} {
  const messages = convertContentsToChatMessages(contents);
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim() || undefined;

  return {
    systemPrompt,
    contents: (Array.isArray(contents) ? contents : []).filter((entry) => entry?.role !== "system"),
  };
}

function buildGeminiGenerateContentBody(
  contents: any[],
  generationConfig?: Record<string, any>,
): Record<string, unknown> {
  const { systemPrompt, contents: userContents } = splitSystemInstructions(contents);
  const body: Record<string, unknown> = {
    contents:
      userContents.length > 0
        ? userContents
        : [{ role: "user", parts: [{ text: "" }] }],
  };
  if (systemPrompt) {
    body.systemInstruction = {
      role: "system",
      parts: [{ text: systemPrompt }],
    };
  }
  if (generationConfig && Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

function buildChatCompletionsBody(
  resolvedModel: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  stream = false,
) {
  const body: Record<string, any> = {
    model: resolvedModel,
    messages: convertContentsToChatMessages(contents),
    stream,
  };
  if (typeof generationConfig?.temperature === "number") {
    body.temperature = generationConfig.temperature;
  }
  if (typeof generationConfig?.topP === "number") {
    body.top_p = generationConfig.topP;
  }
  if (typeof generationConfig?.maxOutputTokens === "number") {
    body.max_tokens = generationConfig.maxOutputTokens;
  }
  const responseFormat = buildStructuredJsonResponseFormat(generationConfig);
  if (responseFormat) {
    body.response_format = responseFormat;
  }
  return body;
}

function buildMessagesApiBody(
  resolvedModel: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  stream = false,
) {
  return {
    model: resolvedModel,
    messages: convertContentsToChatMessages(contents).filter(
      (message) => message.role !== "system",
    ),
    system: convertContentsToChatMessages(contents)
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n")
      .trim() || undefined,
    stream,
    max_tokens:
      typeof generationConfig?.maxOutputTokens === "number"
        ? generationConfig.maxOutputTokens
        : 4096,
    temperature:
      typeof generationConfig?.temperature === "number"
        ? generationConfig.temperature
        : undefined,
    top_p:
      typeof generationConfig?.topP === "number"
        ? generationConfig.topP
        : undefined,
  };
}

// ===== Core API Call =====

export async function callGemini(
  model: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const config = getApiConfig();
  const resolvedModel = resolveConfiguredModelName(model);
  if (isMessagesApiModel(model) || isMessagesApiModel(resolvedModel)) {
    const response = await directFetch(
      buildMessagesApiUrl(config.claudeEndpoint || DEFAULT_GEMINI_BASE_URL),
      { "Content-Type": "application/json" },
      JSON.stringify(
        buildMessagesApiBody(resolvedModel, contents, generationConfig, false),
      ),
      signal,
      "claude",
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    return response.json();
  }
  if (isChatCompletionsModel(model) || isChatCompletionsModel(resolvedModel)) {
    const service: AiService = /^grok-/i.test(String(resolvedModel || model)) ? "grok" : "gpt";
    const endpointBase = service === "grok" ? config.grokEndpoint : config.gptEndpoint;
    const response = await directFetch(
      buildChatCompletionsUrl(endpointBase || DEFAULT_GEMINI_BASE_URL),
      { "Content-Type": "application/json" },
      JSON.stringify(
        buildChatCompletionsBody(resolvedModel, contents, generationConfig, false),
      ),
      signal,
      service,
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    return response.json();
  }
  const baseUrl = (config.geminiEndpoint || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");
  const url = `${baseUrl}/v1beta/models/${resolvedModel}:generateContent`;
  const body = buildGeminiGenerateContentBody(contents, generationConfig);
  const jsonBody = JSON.stringify(body);
  if (signal?.aborted) throw new Error("请求已取消");

  const response = await geminiFetch(
    url,
    { "Content-Type": "application/json" },
    jsonBody,
    signal,
  );

  if (response.ok) {
    const data = await response.json();
    const errMsg =
      data?.error?.message ??
      (typeof data?.error === "string" ? data.error : null);
    if (errMsg) throw new Error(String(errMsg));
    return data;
  }
  const text = await response.text().catch(() => "");
  throw new Error(
    `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
  );
}

/** 当 extractText 为空时，从原始响应推断原因（安全拦截、仅 thought 等） */
export function explainGeminiNoText(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;

  const err = d.error as { message?: string } | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && err.message) return String(err.message);

  const chatChoice = (d.choices as unknown[] | undefined)?.[0] as
    | {
        finish_reason?: string;
        message?: {
          content?: unknown;
          refusal?: string;
          reasoning_content?: string;
        };
      }
    | undefined;
  if (chatChoice) {
    const refusal = String(chatChoice.message?.refusal || "").trim();
    if (refusal) {
      return `模型拒绝返回正文：${refusal}`;
    }
    const reasoningContent = String(chatChoice.message?.reasoning_content || "").trim();
    if (reasoningContent) {
      return "模型只返回了 reasoning_content，没有可见正文。请关闭思维链模型或改用更稳定的拆解模型后重试。";
    }
    const finishReason = String(chatChoice.finish_reason || "").trim();
    if (finishReason && finishReason !== "stop") {
      const finishReasonMap: Record<string, string> = {
        length: "输出被长度上限截断，未能返回完整正文。",
        content_filter: "输出被内容安全过滤截断，未能返回正文。",
        tool_calls: "模型返回了工具调用而不是正文，请改用纯文本拆解模型。",
      };
      return finishReasonMap[finishReason] ?? `模型结束原因：${finishReason}`;
    }
  }

  const pf = d.promptFeedback as
    | { blockReason?: string; blockReasonMessage?: string }
    | undefined;
  if (pf?.blockReason) {
    const extra = pf.blockReasonMessage ? `（${pf.blockReasonMessage}）` : "";
    return `请求未生成正文：内容审核 ${pf.blockReason}${extra}`;
  }

  const cand = (d.candidates as unknown[] | undefined)?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!cand) {
    return "模型未返回候选结果，可能被安全策略拦截或网关截断了响应。";
  }

  const fr = cand.finishReason as string | undefined;
  if (fr && fr !== "STOP" && fr !== "FINISH_REASON_STOP") {
    const frMap: Record<string, string> = {
      SAFETY: "因安全策略未输出文本，请换一张参考图或简化画面内容后重试。",
      RECITATION: "因模型版权引用限制未输出文本。",
      MAX_TOKENS: "输出被长度限制截断，请重试。",
      OTHER: "模型提前结束（OTHER），请稍后重试。",
    };
    return frMap[fr] ?? `模型结束原因：${fr}`;
  }

  const parts = (cand.content as { parts?: unknown[] } | undefined)?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const onlyThought = parts.every(
      (p: unknown) => (p as { thought?: boolean }).thought === true,
    );
    if (onlyThought) {
      return "模型只返回了内部推理，没有可见文本。请稍后重试，或检查网关是否支持当前模型。";
    }
  }

  const anthropicStopReason = String(d.stop_reason || "").trim();
  const anthropicContent = d.content as unknown[];
  if (Array.isArray(anthropicContent) && anthropicContent.length > 0) {
    const onlyThinkingBlocks = anthropicContent.every(
      (part) => String((part as { type?: unknown }).type || "") === "thinking",
    );
    if (onlyThinkingBlocks) {
      return "Claude 只返回了 thinking blocks，没有可见正文。请关闭 thinking 模型或改用稳定的拆解模型。";
    }
  }
  if (anthropicStopReason && anthropicStopReason !== "end_turn") {
    return `Claude 结束原因：${anthropicStopReason}`;
  }

  return null;
}

/**
 * Streaming version of callGemini — calls streamGenerateContent and invokes
 * onChunk with the accumulated text after each SSE event.
 * Returns the final complete text.
 */
export async function callGeminiStream(
  model: string,
  contents: any[],
  onChunk: (accumulated: string) => void,
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<string> {
  const config = getApiConfig();
  const resolvedModel = resolveConfiguredModelName(model);
  if (isMessagesApiModel(model) || isMessagesApiModel(resolvedModel)) {
    const response = await directFetch(
      buildMessagesApiUrl(config.claudeEndpoint || DEFAULT_GEMINI_BASE_URL),
      { "Content-Type": "application/json" },
      JSON.stringify(
        buildMessagesApiBody(resolvedModel, contents, generationConfig, true),
      ),
      signal,
      "claude",
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("浏览器不支持流式读取");

    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";

    while (true) {
      if (signal?.aborted) { void reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta =
            parsed?.delta?.text ??
            parsed?.content_block?.text ??
            parsed?.content?.[0]?.text;
          if (typeof delta === "string" && delta) {
            accumulated += delta;
            onChunk(accumulated);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    if (signal?.aborted) throw new Error("请求已取消");
    return stripThinkingBlocks(accumulated);
  }
  if (isChatCompletionsModel(model) || isChatCompletionsModel(resolvedModel)) {
    const service: AiService = /^grok-/i.test(String(resolvedModel || model)) ? "grok" : "gpt";
    const endpointBase = service === "grok" ? config.grokEndpoint : config.gptEndpoint;
    const response = await directFetch(
      buildChatCompletionsUrl(endpointBase || DEFAULT_GEMINI_BASE_URL),
      { "Content-Type": "application/json" },
      JSON.stringify(
        buildChatCompletionsBody(resolvedModel, contents, generationConfig, true),
      ),
      signal,
      service,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("浏览器不支持流式读取");

    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";

    while (true) {
      if (signal?.aborted) { void reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            accumulated += delta;
            onChunk(accumulated);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    if (signal?.aborted) throw new Error("请求已取消");
    return stripThinkingBlocks(accumulated);
  }
  const baseUrl = (config.geminiEndpoint || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");
  const url = `${baseUrl}/v1beta/models/${resolvedModel}:streamGenerateContent?alt=sse`;
  const body = buildGeminiGenerateContentBody(contents, generationConfig);
  if (signal?.aborted) throw new Error("请求已取消");

  const jsonBody = JSON.stringify(body);

  const response = await geminiFetch(
    url,
    { "Content-Type": "application/json" },
    jsonBody,
    signal,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `模型 ${model} 调用失败 (${response.status}): ${text.slice(0, 200)}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器不支持流式读取");

  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    if (signal?.aborted) { void reader.cancel(); break; }
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const parts = parsed?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.thought) continue; // skip thinking tokens
          if (part.text) {
            accumulated += part.text;
            onChunk(accumulated);
          }
        }
      } catch {
        // skip malformed JSON
      }
    }
  }

  if (signal?.aborted) throw new Error("请求已取消");
  return stripThinkingBlocks(accumulated);
}

// ===== Response Parsing =====

export function extractText(data: any): string {
  const anthropicContent = data?.content;
  if (Array.isArray(anthropicContent)) {
    return stripThinkingBlocks(
      anthropicContent
        .filter((part: any) => part?.type !== "thinking")
        .map((part: any) =>
          typeof part?.text === "string"
            ? part.text
            : typeof part?.content === "string"
              ? part.content
              : "",
        )
        .join("")
        .trim()
    );
  }
  const chatContent = data?.choices?.[0]?.message?.content;
  if (chatContent && typeof chatContent === "object" && typeof chatContent.text === "string") {
    return stripThinkingBlocks(chatContent.text.trim());
  }
  if (typeof chatContent === "string") {
    return stripThinkingBlocks(chatContent.trim());
  }
  if (Array.isArray(chatContent)) {
    return stripThinkingBlocks(
      chatContent
        .map((part: any) =>
          typeof part?.text === "string"
            ? part.text
            : typeof part?.content === "string"
              ? part.content
              : "",
        )
        .join("")
        .trim()
    );
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || "")
    .join("")
    .trim();
}

export async function extractImageBase64(
  data: any,
): Promise<{ base64: string; mimeType: string } | null> {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  // Try inlineData first
  for (const part of parts) {
    if (part.inlineData) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      };
    }
  }

  // Fallback: fileData
  for (const part of parts) {
    if (part.fileData?.fileUri) {
      const result = await fetchImageAsBase64(part.fileData.fileUri);
      if (result) return { base64: result.data, mimeType: result.mimeType };
    }
  }

  // Fallback: URL in text
  for (const part of parts) {
    if (part.text) {
      const mdMatch = part.text.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      const urlMatch =
        mdMatch?.[1] ||
        part.text.match(/(https?:\/\/\S+\.(?:png|jpg|jpeg|webp|gif))/i)?.[1];
      if (urlMatch) {
        const result = await fetchImageAsBase64(urlMatch);
        if (result) return { base64: result.data, mimeType: result.mimeType };
      }
    }
  }

  return null;
}

// ===== Image Utilities =====

function normalizeLocalImagePath(value: string): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      let pathname = decodeURIComponent(parsed.pathname || "");
      if (/^\/[a-z]:/i.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname || null;
    } catch {
      return trimmed.replace(/^file:\/\/\/?/i, "");
    }
  }
  if (/^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.includes("/") || trimmed.includes("\\") ? trimmed : null;
}

async function readLocalImageAsBase64(
  source: string,
): Promise<{ data: string; mimeType: string } | null> {
  const localPath = normalizeLocalImagePath(source);
  if (!localPath) return null;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.storage?.readBase64) return null;

  try {
    const result = await electronAPI.storage.readBase64(localPath);
    if (result?.ok && result?.base64) {
      return {
        data: result.base64,
        mimeType: result.mimeType || "image/jpeg",
      };
    }
  } catch {
    // Fall through to null; callers can decide whether to skip or fail.
  }
  return null;
}

export async function fetchImageAsBase64(
  url: string,
): Promise<{ data: string; mimeType: string } | null> {
  const cached = imageBase64Cache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const localImage = await readLocalImageAsBase64(url);
      if (localImage) return localImage;
      if (normalizeLocalImagePath(url)) return null;

      const resp = url.startsWith("http://")
        ? await smartDirectOrProxyFetch(url, {}, undefined, undefined, "gemini")
        : await fetch(url);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);
      const contentType = resp.headers.get("content-type") || "image/png";
      return { mimeType: contentType.split(";")[0], data: base64 };
    } catch {
      return null;
    }
  })();

  imageBase64Cache.set(url, pending);
  const result = await pending;
  if (!result) {
    imageBase64Cache.delete(url);
  }
  return result;
}

export async function getInlineData(
  imageUrl: string,
): Promise<{ mimeType: string; data: string } | null> {
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
  }
  if (imageUrl.startsWith("http")) {
    return fetchImageAsBase64(imageUrl);
  }
  const isLocalFilePath = imageUrl.length > 0 && !imageUrl.startsWith("blob:");
  if (isLocalFilePath) {
    const localImage = await readLocalImageAsBase64(imageUrl);
    if (localImage) {
      return { mimeType: localImage.mimeType, data: localImage.data };
    }
  }
  return null;
}

// ===== Image as Data URL =====

/**
 * 保存图像到本地文件系统并返回文件路径
 * 对于大图像，避免使用 data URL 导致内存溢出
 */
export async function uploadImageToStorage(
  base64: string,
  mimeType: string,
  folder: string,
  suggestedFileStem?: string,
): Promise<string> {
  // 🛡️ 验证参数
  if (!base64 || typeof base64 !== "string" || base64.trim().length === 0) {
    console.error("uploadImageToStorage: Invalid base64 data", { base64Length: base64?.length, type: typeof base64 });
    throw new Error("Invalid base64 data: empty or invalid string");
  }

  // 🛡️ 设置默认 mimeType
  const safeMimeType = mimeType && typeof mimeType === "string" && mimeType.trim().length > 0
    ? mimeType
    : "image/jpeg";

  // 🛡️ 检查是否在 Electron 环境中
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.jimeng?.writeFile || !electronAPI?.storage?.getDefaultPath) {
    const projectId = localStorage.getItem("storyforge_current_project");
    const ext = safeMimeType.includes("png") ? ".png" : safeMimeType.includes("webp") ? ".webp" : ".jpg";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const semanticStem = suggestedFileStem?.trim() ? safeCacheName(suggestedFileStem.trim()) : "generated-image";
    const cloudUrl = await uploadBase64ToCloudMedia({
      base64,
      mimeType: safeMimeType,
      folder: `projects/${projectId || "shared"}/images/generated/${folder}`,
      fileName: `${semanticStem}_${timestamp}${ext}`,
    });
    if (cloudUrl) return cloudUrl;

    // 非 Electron 且云端保存失败时才回退 data URL，避免生成流程直接中断。
    console.warn("Not in Electron environment and cloud media upload failed, returning data URL");
    return `data:${safeMimeType};base64,${base64}`;
  }

  try {
    // 获取项目根目录
    const filesRoot = await getResolvedFilesStoragePath();
    const projectId = localStorage.getItem("storyforge_current_project");

    if (!projectId || !filesRoot) {
      // 无法获取项目路径，返回 data URL
      console.warn("No project ID or files path, returning data URL", {
        hasProjectId: Boolean(projectId),
        hasFilesPath: Boolean(filesRoot),
      });
      return `data:${safeMimeType};base64,${base64}`;
    }

    // 生成文件名
    const ext = safeMimeType.includes("png") ? ".png" : safeMimeType.includes("webp") ? ".webp" : ".jpg";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const hash = Math.random().toString(36).substring(2, 8);
    const semanticStem = suggestedFileStem?.trim() ? safeCacheName(suggestedFileStem.trim()) : "";
    const fileName = semanticStem ? `${semanticStem}_${timestamp}-${hash}${ext}` : `${timestamp}-${hash}${ext}`;

    // 构建文件路径 - 使用正斜杠以确保跨平台兼容性
    const filePath = `${filesRoot.replace(/[\\/]+$/, "")}/projects/${projectId}/images/generated/${folder}/${fileName}`;

    console.log("Saving image to:", filePath, "size:", Math.round(base64.length * 0.75 / 1024), "KB");

    // 保存文件
    const result = await electronAPI.jimeng.writeFile(filePath, base64);

    if (result.ok) {
      const dataUrl = `data:${safeMimeType};base64,${base64}`;
      try {
        await persistAssetToProjectCache(
          dataUrl,
          buildThumbnailRelativePath(filePath),
          projectId,
        );
      } catch {
        // Ignore thumbnail cache write failures and keep the original image save successful.
      }
      console.log("Image saved successfully to:", filePath);
      // ⚠️ 重要：返回文件路径而不是 data URL
      // 浏览器会通过 Electron API 读取文件，避免在内存中存储大 data URL
      return filePath;
    } else {
      console.warn("Failed to save image to file system, falling back to data URL:", result.error);
      return `data:${safeMimeType};base64,${base64}`;
    }
  } catch (err) {
    console.error("Error saving image to storage:", err);
    // 出错时返回 data URL
    return `data:${safeMimeType};base64,${base64}`;
  }
}

/**
 * @deprecated 上传功能已移除，返回 data URL
 */
export async function uploadFileToStorage(
  file: File,
  _folder: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader 失败"));
    reader.readAsDataURL(file);
  });
}

// ===== Seedream Image Generation =====

export async function callSeedreamImage(
  prompt: string,
  options: {
    model?: string;
    size?: string;
    image?: string[];
    signal?: AbortSignal;
  } = {},
): Promise<{ base64: string; mimeType: string }> {
  const config = getApiConfig();
  const seedreamEndpoint = config.seedreamEndpoint || DEFAULT_GEMINI_BASE_URL;
  const baseUrl = seedreamEndpoint
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");
  const resolvedModel = resolveConfiguredModelName(options.model || "doubao-seedream-3-0");
  const targetUrl = shouldUseLocalImageDevProxy()
    ? `${getServerProxyEndpoint("seedream")}/v1beta/models/${resolvedModel}:generateImages`
    : isServerProxyEndpoint(seedreamEndpoint)
      ? `${seedreamEndpoint}/v1beta/models/${resolvedModel}:generateImages`
      : `${baseUrl}/v1beta/models/${resolvedModel}:generateImages`;

  const legacyPayload: any = {
    prompt,
    size: options.size || "2560x1440",
    watermark: false,
  };
  const processedImages: string[] = [];
  if (options.image && options.image.length > 0) {
    for (const img of options.image) {
      if (img.startsWith("data:")) {
        processedImages.push(img);
      } else {
        try {
          const fetched = await fetchImageAsBase64(img);
          if (fetched) {
            processedImages.push(`data:${fetched.mimeType};base64,${fetched.data}`);
          } else if (normalizeLocalImagePath(img)) {
            throw new Error(`无法读取本地参考图: ${img}`);
          } else {
            processedImages.push(img);
          }
        } catch {
          if (normalizeLocalImagePath(img)) {
            throw new Error(`无法读取本地参考图: ${img}`);
          }
          processedImages.push(img);
        }
      }
    }
    legacyPayload.image = processedImages;
    legacyPayload.sequential_image_generation = "disabled";
  }

  const seedreamParts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of processedImages) {
    const inlineData = await getInlineData(image);
    if (inlineData?.data) {
      seedreamParts.push({ inlineData });
      continue;
    }
    if (/^https?:\/\//i.test(image)) {
      seedreamParts.push({ fileData: { fileUri: image } });
    }
  }

  const contentsPayload: any = {
    contents: [{ role: "user", parts: seedreamParts }],
    size: options.size || "2560x1440",
    watermark: false,
  };
  if (processedImages.length > 0) {
    contentsPayload.sequential_image_generation = "disabled";
  }

  const prefersContentsPayload =
    isServerProxyEndpoint(seedreamEndpoint) || /api\.tu-zi\.com/i.test(seedreamEndpoint);
  const requestBodies = prefersContentsPayload
    ? [contentsPayload, legacyPayload]
    : [legacyPayload, contentsPayload];

  let lastError: Error | null = null;

  for (let index = 0; index < requestBodies.length; index += 1) {
    const candidateBody = requestBodies[index];
    const usingContentsPayload = Object.prototype.hasOwnProperty.call(candidateBody, "contents");
    const resp = await smartDirectOrProxyFetch(
      targetUrl,
      {
        "Content-Type": "application/json",
      },
      JSON.stringify(candidateBody),
      options.signal,
      "seedream",
    );

    if (!resp.ok) {
      const errText = await resp.text();
      lastError = new Error(`Seedream 生成失败 (${resp.status}): ${errText.slice(0, 200)}`);
      const shouldRetryWithAlternateContract =
        index + 1 < requestBodies.length &&
        ((!usingContentsPayload && /contents is required/i.test(errText)) ||
          (usingContentsPayload && /prompt is required/i.test(errText)));
      if (shouldRetryWithAlternateContract) {
        continue;
      }
      throw lastError;
    }

    const data = await resp.json();
    const imgItem = data.data?.[0];
    if (imgItem?.b64_json) {
      return { base64: imgItem.b64_json, mimeType: "image/png" };
    }
    if (imgItem?.url) {
      const imgResp = await fetch(imgItem.url);
      if (!imgResp.ok) throw new Error("Seedream 图片下载失败");
      const buf = await imgResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const ct = imgResp.headers.get("content-type") || "";
      return {
        base64: btoa(binary),
        mimeType: ct.includes("png") ? "image/png" : "image/jpeg",
      };
    }

    const extracted = await extractImageBase64(data);
    if (extracted?.base64?.trim()) {
      return extracted;
    }

    lastError = new Error("Seedream did not return an image.");
  }

  throw lastError || new Error("Seedream did not return an image.");
}
export async function callTuziImageGeneration(
  prompt: string,
  options: {
    model?: string;
    size?: string;
    aspectRatio?: string;
    imageSize?: "1K" | "2K" | "4K";
    input_reference?: string | string[];
    signal?: AbortSignal;
  } = {},
): Promise<{ base64: string; mimeType: string }> {
  const config = getApiConfig();
  const resolvedModel = resolveConfiguredModelName(options.model || "nano-banana-pro");
  const usesLocalImageDevProxy = shouldUseLocalImageDevProxy();
  const prefersProxyImageGenerations =
    usesLocalImageDevProxy || isServerProxyEndpoint(config.gptEndpoint || "");
  const imageService: AiService = resolvedModel.startsWith("gpt-image-")
    ? "gpt"
    : prefersProxyImageGenerations
      ? "gpt"
      : config.geminiKey?.trim()
        ? "gemini"
        : "tuzi";
  const imageEndpoint =
    usesLocalImageDevProxy
      ? getServerProxyEndpoint("gpt")
      : imageService === "gpt"
      ? config.gptEndpoint || config.tuziEndpoint || config.geminiEndpoint || DEFAULT_GEMINI_BASE_URL
      : config.geminiEndpoint || config.tuziEndpoint || DEFAULT_GEMINI_BASE_URL;
  const baseUrl = imageEndpoint
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");

  const payload: any = {
    model: resolvedModel,
    prompt,
    n: 1,
    size: options.size || "1024x1024",
  };

  const references = (Array.isArray(options.input_reference)
    ? options.input_reference
    : [options.input_reference])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (references.length > 0) {
    const processedImages: string[] = [];
    for (const reference of references) {
      if (reference.startsWith("data:")) {
        processedImages.push(reference);
        continue;
      }

      const fetched = await fetchImageAsBase64(reference);
      if (fetched?.data) {
        processedImages.push(`data:${fetched.mimeType};base64,${fetched.data}`);
      } else if (normalizeLocalImagePath(reference)) {
        throw new Error(`无法读取本地参考图：${reference}`);
      } else {
        processedImages.push(reference);
      }
    }

    if (processedImages.length > 0) {
      payload.image = processedImages;
    }
  }

  console.info("[image-generation] submitting /v1/images/generations", {
    model: payload.model,
    service: imageService,
    size: payload.size,
    aspectRatio: options.aspectRatio || null,
    imageSize: options.imageSize || null,
    referenceCount: references.length,
  });

  const resp = await smartDirectOrProxyFetch(
    `${baseUrl}/v1/images/generations`,
    {
      "Content-Type": "application/json",
    },
    JSON.stringify(payload),
    options.signal,
    imageService,
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Tuzi 图像生成失败 (${resp.status}): ${errText.slice(0, 300)}`,
    );
  }

  const data = await resp.json();
  const imageItem =
    data?.data?.[0] ??
    data?.images?.[0] ??
    data?.output?.[0] ??
    data?.result?.[0] ??
    null;

  const base64 = imageItem?.b64_json || imageItem?.base64 || data?.b64_json;
  if (typeof base64 === "string" && base64.trim()) {
    return {
      base64,
      mimeType: imageItem?.mime_type || imageItem?.mimeType || "image/png",
    };
  }

  const imageUrl =
    imageItem?.url ||
    imageItem?.image_url ||
    data?.url ||
    data?.image_url ||
    data?.output?.image_url ||
    data?.output?.url ||
    data?.result?.url;

  if (typeof imageUrl === "string" && imageUrl.trim()) {
    const fetched = await fetchImageAsBase64(imageUrl.trim());
    if (fetched?.data) {
      return { base64: fetched.data, mimeType: fetched.mimeType };
    }
  }

  throw new Error("Tuzi 图像接口未返回可用图片");
}

// ===== Text Processing =====

export function rewriteToFirstFrame(desc: string): string {
  if (!desc) return desc;

  const splitPatterns =
    /[，,]?\s*(?:瞬间|顿时|随即|紧接着|突然间|立刻|马上|随后|接着|于是|结果|导致|使得)/;
  const splitMatch = desc.match(splitPatterns);
  let cleaned = splitMatch ? desc.slice(0, splitMatch.index) : desc;

  const removePatterns = [
    /化[为成].*?(血雾|碎片|粉末|灰烬|废墟|齑粉)/g,
    /鲜血[溅飞洒喷].*?[。，,]/g,
    /血[溅飞洒喷花].*?[。，,]/g,
    /[炸爆]成.*?(碎片|粉末|废墟)/g,
    /倒[地下飞].*?[。，,]/g,
    /身体.*?(?:碎裂|断裂|爆裂|粉碎)/g,
    /尸体/g,
    /惨死/g,
  ];
  for (const pat of removePatterns) {
    cleaned = cleaned.replace(pat, "");
  }

  cleaned = cleaned
    .replace(/飞来击中/g, "飞向")
    .replace(/飞来砸中/g, "飞向")
    .replace(/飞来射中/g, "射向")
    .replace(/击中/g, "朝其飞去")
    .replace(/砍中/g, "朝其挥去")
    .replace(/刺中/g, "朝其刺去")
    .replace(/射中/g, "射向")
    .replace(/撞上/g, "冲向")
    .replace(/砸中/g, "砸向")
    .replace(/劈中/g, "朝其劈去")
    .replace(/一拳砸在/g, "举拳准备砸向")
    .replace(/一拳打在/g, "举拳准备打向")
    .replace(/一拳击在/g, "举拳准备击向")
    .replace(/踹开/g, "准备踹向")
    .replace(/踢中/g, "踢向")
    .replace(/摔在/g, "即将摔向")
    .replace(/重重摔/g, "即将摔")
    .replace(/按在.*?地面/g, "按向地面")
    .replace(/反复捶打/g, "举拳准备捶打")
    .replace(/拖向/g, "准备拖向")
    .replace(/架住/g, "准备架住")
    .replace(/将其/g, "准备将其")
    .replace(/渗出鲜血/g, "")
    .replace(/嘴角渗出/g, "")
    .replace(/痛苦地倒地/g, "即将倒地")
    .replace(/倒地咳嗽/g, "即将倒地");

  cleaned = cleaned
    .replace(/[，,、]+\s*(\[[^\]]*\])\s*$/, "")
    .replace(/[，,、。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || desc;
}

// ===== Style Maps =====

export const CHAR_STYLE_MAP: Record<string, string> = {
  "live-action":
    "Photorealistic live-action cinematography. Shot on high-end cinema camera (ARRI Alexa / RED V-Raptor). Cinematic lighting with motivated key light, soft fill, and subtle rim light. Film-grade color grading with natural skin tones, accurate subsurface scattering on skin, pore-level detail, real fabric weave and stitching on clothing. Shallow depth of field with anamorphic bokeh. No post-processing glow or bloom. The image must look indistinguishable from a real film still.",
  "hyper-cg":
    "Hyper-realistic CG render at AAA game cinematic quality (Unreal Engine 5 / Nanite-level detail). Physically-based rendering (PBR) with ray-traced global illumination, accurate subsurface scattering on skin, micro-detail normal maps on all surfaces. Ultra-high polygon count with no visible faceting. Realistic hair strand simulation, cloth physics folds, and specular response on metals and wet surfaces. Studio-quality three-point lighting setup with HDRI environment reflections.",
  "3d-cartoon":
    "3D cartoon animation style matching Pixar / Disney / Illumination feature-film quality. Smooth subdivided surfaces with appealing stylized proportions (slightly oversized head, expressive eyes). Soft volumetric ambient occlusion, subsurface scattering on skin for a warm translucent feel. Rim lighting for silhouette readability. Rich saturated color palette with complementary accent colors. Clean topology with no artifacts. The character should feel like a frame from a theatrical animated feature.",
  "2.5d-stylized":
    "2.5D stylized illustration blending hand-painted 2D textures over 3D geometry, inspired by Spider-Man: Into the Spider-Verse and Arcane: League of Legends. Visible artistic brushstrokes, Ben-Day dots, and cross-hatching layered on top of three-dimensional forms. Graphic novel panel aesthetic with strong ink outlines of varying weight. Limited but bold color palette with intentional color holds on linework. Slight printing misregistration effect. Mixed frame-rate feel captured in a still image.",
  "anime-3d":
    "3D cel-shaded anime style inspired by Genshin Impact, Honkai: Star Rail, and Guilty Gear Strive. Hard-edge toon shading with exactly 2-3 shadow steps and no smooth gradients. Crisp black outlines of uniform weight rendered over clean 3D geometry. Anime-proportioned facial features: large luminous eyes with detailed iris highlights, small nose and mouth. Vibrant highly-saturated color palette. Specular highlights rendered as sharp geometric shapes. Hair rendered as stylized chunky planes with clear silhouette.",
  "cel-animation":
    "Traditional 2D hand-drawn cel animation style evoking classic Disney Renaissance, Studio Ghibli, and golden-age theatrical shorts. Crisp confident ink lineart with consistent line weight and occasional taper. Large areas of flat solid color fills with no gradients. Shadow rendered as a single flat darker tone with a razor-sharp terminator line (no soft falloff). Highlight as a single lighter shape. Clean negative space. Slight paper-texture grain overlay. The image should feel like a hand-inked and hand-painted animation cel photographed on a rostrum camera.",
  "retro-comic":
    "Vintage American comic book style evoking 1960s-1970s Marvel / DC print era and pulp illustration. Bold, confident ink outlines with dramatic thick-to-thin brush strokes. High-contrast flat color blocks using a limited CMYK print palette. Mechanical halftone Ben-Day dot patterns for all mid-tones, shadows, and gradients (visible dot grid, not smooth). Slight ink bleed and paper yellowing. Strong chiaroscuro lighting with deep black shadows. Dynamic poses with foreshortening. Speech-balloon-ready composition. The image must feel like a freshly printed newsprint comic page.",
};

export const SCENE_STYLE_MAP: Record<string, string> = {
  "live-action":
    "Photorealistic live-action cinematography of an environment / location. Shot on high-end cinema camera with cinematic lighting, motivated practical light sources, film-grade color grading, real-world material textures (concrete, wood, metal, fabric), atmospheric haze and depth fog, shallow depth of field with anamorphic bokeh. The image must look indistinguishable from a real film location scout photograph.",
  "hyper-cg":
    "Hyper-realistic CG environment render at AAA game cinematic quality (Unreal Engine 5 / Nanite-level). Physically-based rendering with ray-traced global illumination, accurate material PBR responses, volumetric fog and god rays, ultra-detailed environment props with micro-surface detail. HDRI sky lighting with realistic time-of-day atmosphere. No visible LOD pop-in or texture stretching.",
  "3d-cartoon":
    "3D cartoon environment matching Pixar / Disney / Illumination feature-film quality. Stylized but detailed world-building with appealing shape language (rounded edges, exaggerated proportions). Soft volumetric lighting with warm ambient occlusion. Rich saturated color palette with clear color storytelling. Clean modular set design that feels like a miniature stage set brought to life.",
  "2.5d-stylized":
    "2.5D stylized environment illustration blending hand-painted 2D textures over 3D geometry, inspired by Spider-Man: Into the Spider-Verse and Arcane: League of Legends. Visible artistic brushstrokes and cross-hatching on architectural surfaces. Graphic novel aesthetic with strong ink outlines of varying weight. Bold limited color palette with intentional color holds. Slight printing misregistration effect. Atmospheric depth achieved through layered parallax planes.",
  "anime-3d":
    "3D cel-shaded anime environment inspired by Genshin Impact and Honkai: Star Rail open-world landscapes. Hard-edge toon shading with 2-3 shadow steps on all surfaces. Clean outlines on major architectural forms. Vibrant highly-saturated color palette with stylized foliage and sky. Specular highlights as sharp geometric shapes on water and metal. Anime-style clouds and atmospheric perspective.",
  "cel-animation":
    "Traditional 2D hand-painted background art in the style of classic Disney, Studio Ghibli, and golden-age animation. Lush painterly environment with visible gouache / watercolor brushwork. Flat perspective with subtle depth layering for multiplane camera effect. Warm natural color palette with soft atmospheric gradients in sky and distance. No lineart on backgrounds — shapes defined by color and value changes. Slight paper-texture grain overlay.",
  "retro-comic":
    "Vintage American comic book environment evoking 1960s-1970s Marvel / DC print era. Bold ink outlines on architecture and props with dramatic thick-to-thin brushwork. High-contrast flat color blocks using limited CMYK palette. Mechanical halftone Ben-Day dot patterns for skies, shadows, and gradients. Slight ink bleed and paper yellowing. Strong chiaroscuro lighting with deep black shadow areas. The environment must feel like a freshly printed comic panel background.",
};

export const STORYBOARD_STYLE_MAP: Record<string, string> = {
  "live-action":
    "Photorealistic live-action cinematography. Cinema camera look with cinematic lighting, film-grade color grading, real-world textures, shallow depth of field, anamorphic bokeh. Indistinguishable from a real film still.",
  "hyper-cg":
    "Hyper-realistic CG render, AAA game cinematic quality (UE5-level). PBR materials, ray-traced global illumination, volumetric fog, ultra-detailed surfaces, HDRI environment lighting.",
  "3d-cartoon":
    "3D cartoon animation, Pixar/Disney feature-film quality. Stylized proportions, smooth subsurface skin, soft volumetric AO, rich saturated colors, appealing shape language.",
  "2.5d-stylized":
    "2.5D stylized illustration, Spider-Verse / Arcane aesthetic. Hand-painted textures over 3D forms, visible brushstrokes, Ben-Day dots, bold ink outlines, limited color palette, printing misregistration effect.",
  "anime-3d":
    "3D cel-shaded anime, Genshin Impact / Guilty Gear Strive style. Hard-edge 2-3 step toon shading, crisp uniform outlines, anime facial features, vibrant saturated colors, sharp geometric specular highlights.",
  "cel-animation":
    "Traditional 2D cel animation, Disney Renaissance / Studio Ghibli style. Crisp ink lineart, flat solid color fills, razor-sharp shadow terminator, no gradients, paper-texture grain overlay.",
  "retro-comic":
    "Vintage 1960s-70s American comic book style. Bold ink brush outlines, flat CMYK color blocks, mechanical halftone Ben-Day dot patterns, ink bleed, paper yellowing, deep chiaroscuro shadows.",
};

// ===== Async Image Generation (Gemini 3 Pro Image Preview Async) =====

function inferAsyncFallbackImageSize(model?: string | null): "1K" | "2K" | "4K" {
  const normalized = String(model || "").trim().toLowerCase();
  if (normalized.includes("-4k")) return "4K";
  if (normalized.includes("-2k")) return "2K";
  return "1K";
}

function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function inferReferenceFileExtension(mimeType: string): string {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  return ".jpg";
}

async function resolveAsyncReferenceInlineData(
  reference: string,
): Promise<{ mimeType: string; data: string } | null> {
  const normalized = String(reference || "").trim();
  if (!normalized) return null;

  if (normalized.startsWith("blob:")) {
    try {
      const response = await fetch(normalized);
      if (!response.ok) return null;
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 8192;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return {
        mimeType: blob.type || "image/jpeg",
        data: btoa(binary),
      };
    } catch {
      return null;
    }
  }

  return getInlineData(normalized);
}

async function appendAsyncImageReferences(
  formData: FormData,
  inputReference?: string | string[],
): Promise<boolean> {
  const references = (Array.isArray(inputReference) ? inputReference : [inputReference])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (references.length === 0) return true;

  for (const [index, reference] of references.entries()) {
    const inlineData = await resolveAsyncReferenceInlineData(reference);
    if (!inlineData?.data) {
      return false;
    }

    const blob = new Blob([decodeBase64ToUint8Array(inlineData.data)], {
      type: inlineData.mimeType || "image/jpeg",
    });
    const extension = inferReferenceFileExtension(inlineData.mimeType || "image/jpeg");
    formData.append("input_reference", blob, `reference-${index + 1}${extension}`);
  }

  return true;
}

export async function callAsyncImageGeneration(
  prompt: string,
  options: {
    model?: string;
    size?: string;
    input_reference?: string | string[];
    signal?: AbortSignal;
  } = {},
): Promise<{ task_id: string; fallbackModel?: string; shouldUseFallback?: boolean }> {
  const config = getApiConfig();
  const imageService: AiService = config.geminiKey?.trim() ? "gemini" : "tuzi";
  const baseUrl = (config.geminiEndpoint || config.tuziEndpoint || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");

  const requestedModel = options.model || "gemini-3-pro-image-preview-async";

  // 定义回退模型映射
  const fallbackMap: Record<string, string> = {
    "gemini-3-pro-image-preview-async": "gemini-3-pro-image-preview",
    "gemini-3-pro-image-preview-2k-async": "gemini-3-pro-image-preview-2k",
    "gemini-3-pro-image-preview-4k-async": "gemini-3-pro-image-preview-4k",
    "ano-banana-pro": "nano-banana-pro",
    "nano-banana-pro": "nano-banana-pro",
    "nano-banana-pro-2k": "nano-banana-pro-2k",
    "nano-banana-pro-4k": "nano-banana-pro-4k",
    "nano-banana-2": "gemini-3-pro-image-preview",
    "nano-banana-2-2k": "gemini-3-pro-image-preview-2k",
    "nano-banana-2-4k": "gemini-3-pro-image-preview-4k",
    "nano-banana-2-async": "gemini-3-pro-image-preview",
    "nano-banana-2-2k-async": "gemini-3-pro-image-preview-2k",
    "nano-banana-2-4k-async": "gemini-3-pro-image-preview-4k",
  };

  // 如果有参考图像，异步API不支持，直接返回标记使用回退模型
  if (options.input_reference && !options.input_reference) {
    console.warn("异步API不支持参考图像，将使用同步回退模型");
    return {
      task_id: "",
      fallbackModel: fallbackMap[requestedModel],
      shouldUseFallback: true,
    };
  }

  const formData = new FormData();
  // 直接使用原始模型名称，不经过 resolveConfiguredModelName 映射
  // 因为这是内部API调用，不应该受用户配置的模型映射影响
  formData.append("model", requestedModel);
  formData.append("prompt", prompt);
  formData.append("size", options.size || "1:1");
  // Tuzi async image tasks accept multipart `input_reference` uploads, so we keep
  // Gemini-family requests on the async transport whenever the references can be resolved.
  const referencesAttached = await appendAsyncImageReferences(formData, options.input_reference);
  if (!referencesAttached) {
    return {
      task_id: "",
      fallbackModel: fallbackMap[requestedModel],
      shouldUseFallback: true,
    };
  }

  // Note: Don't set Content-Type for FormData - browser will set it with boundary
  const resp = await smartDirectOrProxyFetch(
    `${baseUrl}/v1/videos`,
    {},
    formData,
    options.signal,
    imageService,
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`异步图像生成提交失败 (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  console.log("异步图像生成任务已提交:", data);
  const taskId = data.id || data.task_id;
  if (!taskId) {
    console.error("API 响应缺少任务 ID:", JSON.stringify(data, null, 2));
    throw new Error("API 未返回任务 ID");
  }

  return {
    task_id: taskId,
    fallbackModel: fallbackMap[requestedModel]
  };
}

export async function pollAsyncImageResult(
  taskId: string,
  options: {
    maxAttempts?: number;
    intervalMs?: number;
    maxDurationMs?: number;
    signal?: AbortSignal;
    fallbackModel?: string;
    prompt?: string;
    size?: string;
    input_reference?: string | string[];
  } = {},
): Promise<{ base64: string; mimeType: string; usedFallback?: boolean }> {
  const config = getApiConfig();
  const imageService: AiService = config.geminiKey?.trim() ? "gemini" : "tuzi";
  const baseUrl = (config.geminiEndpoint || config.tuziEndpoint || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/, "")
    .replace(/\/v1(\/.*)?$/, "");

  const maxAttempts = options.maxAttempts || DEFAULT_ASYNC_IMAGE_POLL_ATTEMPTS;
  const maxDurationMs = options.maxDurationMs || DEFAULT_ASYNC_IMAGE_POLL_MAX_DURATION_MS;
  let lastKnownStatus = "queued";
  let lastKnownProgress: number | null = null;
  let lastKnownCreatedAt: number | null = null;
  const startedAt = Date.now();
  let attemptsMade = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startedAt >= maxDurationMs) {
      break;
    }
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    attemptsMade = attempt + 1;

    const resp = await smartDirectOrProxyFetch(
      `${baseUrl}/v1/videos/${taskId}`,
      {},
      undefined,
      options.signal,
      imageService,
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`查询异步图像结果失败 (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    lastKnownStatus = typeof data.status === "string" ? data.status : lastKnownStatus;
    lastKnownProgress =
      typeof data.progress === "number" && Number.isFinite(data.progress)
        ? data.progress
        : lastKnownProgress;
    lastKnownCreatedAt =
      typeof data.created_at === "number" && Number.isFinite(data.created_at)
        ? data.created_at
        : lastKnownCreatedAt;
    console.log(`轮询异步图像任务 ${taskId} (第 ${attempt + 1}/${maxAttempts} 次):`, data);

    // 检查状态
    if (data.status === "completed" || data.status === "succeeded") {
      // 获取图像 URL - 支持多种可能的响应格式
      const imageUrl =
        data.video_url ||
        data.output?.image_url ||
        data.output?.url ||
        data.result?.url ||
        data.url ||
        data.data?.url ||
        data.image_url;

      if (!imageUrl) {
        console.error("API 响应数据结构:", JSON.stringify(data, null, 2));
        throw new Error("API 返回成功但未包含图像 URL");
      }

      // 下载图像并转换为 base64
      const imageResp = await fetch(imageUrl, { signal: options.signal });
      if (!imageResp.ok) {
        throw new Error(`下载生成的图像失败: ${imageResp.status}`);
      }

      const blob = await imageResp.blob();
      const arrayBuffer = await blob.arrayBuffer();

      // 🛡️ 使用分块处理避免大图像导致内存溢出和渲染进程崩溃
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 8192; // 8KB chunks
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
      }
      const base64 = btoa(binary);

      return {
        base64,
        mimeType: blob.type || "image/jpeg",
        usedFallback: false,
      };
    }

    if (data.status === "failed" || data.status === "error") {
      const errorMsg = data.error?.message || data.message || "任务失败";

      // 如果有回退模型且提供了必要参数，尝试使用回退模型
      if (options.fallbackModel && options.prompt) {
        console.warn(`异步模型失败，尝试使用回退模型: ${options.fallbackModel}`);

        // 使用同步 API 调用回退模型
        const parts: any[] = [{ text: options.prompt }];

        // 如果有参考图像，添加到 parts
        if (options.input_reference) {
          const fallbackReference = Array.isArray(options.input_reference)
            ? options.input_reference[0]
            : options.input_reference;
          // 下载参考图像并转换为 base64
          try {
            const refResp = fallbackReference
              ? await fetch(fallbackReference, { signal: options.signal })
              : null;
            if (refResp?.ok) {
              const refBlob = await refResp.blob();
              const refArrayBuffer = await refBlob.arrayBuffer();

              // 🛡️ 使用分块处理避免大图像导致内存溢出
              const bytes = new Uint8Array(refArrayBuffer);
              let binary = "";
              const chunkSize = 8192;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                const chunk = bytes.subarray(i, i + chunkSize);
                binary += String.fromCharCode(...chunk);
              }
              const refBase64 = btoa(binary);

              parts.push({
                inlineData: {
                  mimeType: refBlob.type || "image/jpeg",
                  data: refBase64,
                },
              });
            }
          } catch (e) {
            console.warn("无法加载参考图像，继续使用纯文本提示词", e);
          }
        }

        // 调用同步 Gemini API
        const fallbackData = await callGemini(
          options.fallbackModel,
          [{ role: "user", parts }],
          {
            responseModalities: ["IMAGE", "TEXT"],
            imageSize: options.size === "1:1" ? "1K" : options.size === "16:9" ? "2K" : "2K",
          },
          options.signal,
        );

        const img = await extractImageBase64(fallbackData);
        if (!img) {
          throw new Error(`回退模型也失败: ${errorMsg}`);
        }

        return {
          base64: img.base64,
          mimeType: img.mimeType,
          usedFallback: true,
        };
      }

      throw new Error(`异步图像生成失败: ${errorMsg}`);
    }

    // 状态为 pending/processing，继续等待（0-5 秒每 1 秒、5-15 秒每 2 秒、之后每 5 秒）
    const adaptiveInterval =
      typeof options.intervalMs === "number" && options.intervalMs > 0
        ? options.intervalMs
        : getProgressiveAsyncImagePollIntervalMs(Date.now() - startedAt);
    await waitForAsyncImagePollDelay(adaptiveInterval, options.signal);
  }

  throw new AsyncImageTaskPendingError({
    taskId,
    status: lastKnownStatus,
    progress: lastKnownProgress,
    createdAt: lastKnownCreatedAt,
    attempts: attemptsMade,
    maxDurationMs,
    maxAttempts,
  });
}
