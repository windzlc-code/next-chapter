/**
 * API Client - 使用本地配置的端点和密钥
 */

import { getApiConfig, isArkJimengEndpoint, resolveJimengApiKey } from "@/lib/api-config";
import { smartDirectOrProxyFetch } from "@/lib/gemini-client";

const DEFAULT_TIMEOUT = 300_000;

/**
 * 调用 AI 模型 API
 */
export async function callAiApi<T = any>(
  body: Record<string, unknown>,
  options: {
    endpoint?: string;
    path?: string;
    timeout?: number;
  } = {},
): Promise<T> {
  const config = getApiConfig();
  const endpoint =
    options.endpoint ||
    config.geminiEndpoint ||
    "https://api.zhanhu.ai/v1";
  const path = options.path || "/chat/completions";
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  if (!config.geminiKey?.trim()) {
    throw new Error("请先在设置中配置 Gemini API Key");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await smartDirectOrProxyFetch(
      `${endpoint}${path}`,
      {
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
      controller.signal,
      "gemini",
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用视频生成 API
 */
export async function callVideoApi<T = any>(
  body: Record<string, unknown>,
  options: {
    endpoint?: string;
    timeout?: number;
  } = {},
): Promise<T> {
  const config = getApiConfig();
  const endpoint =
    options.endpoint || config.jimengEndpoint || config.geminiEndpoint || "https://api.zhanhu.ai/v1";
  const timeout = options.timeout || 600_000;

  if (!resolveJimengApiKey(config)) {
    throw new Error(
      isArkJimengEndpoint(config.jimengEndpoint)
        ? "请先在设置中配置即梦 / Ark 专用 API Key"
        : "请先在设置中配置即梦视频或 Gemini API Key",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await smartDirectOrProxyFetch(
      `${endpoint.replace(/\/$/, "")}/v1/video/generate`,
      {
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
      controller.signal,
      "jimeng",
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
    }

    const data = await response.json();
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式调用 AI API (带心跳)
 */
export async function* callAiStreamingApi(
  body: Record<string, unknown>,
  options: {
    endpoint?: string;
    path?: string;
    timeout?: number;
  } = {},
): AsyncGenerator<string> {
  const config = getApiConfig();
  const endpoint =
    options.endpoint ||
    config.geminiEndpoint ||
    "https://api.zhanhu.ai/v1";
  const path = options.path || "/chat/completions";
  const timeout = options.timeout || DEFAULT_TIMEOUT;

  if (!config.geminiKey?.trim()) {
    throw new Error("请先在设置中配置 Gemini API Key");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await smartDirectOrProxyFetch(
      `${endpoint}${path}`,
      {
        "Content-Type": "application/json",
      },
      JSON.stringify({ ...body, stream: true }),
      controller.signal,
      "gemini",
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          yield line;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
