export type ProxyProvider =
  | "gemini"
  | "gpt"
  | "claude"
  | "grok"
  | "aliyun"
  | "runninghub"
  | "seedream"
  | "jimeng"
  | "tuzi";

export const SERVER_PROXY_PREFIX = "/api/proxy";

export const SERVER_PROXY_ENDPOINTS: Record<ProxyProvider, string> = {
  gemini: `${SERVER_PROXY_PREFIX}/gemini`,
  gpt: `${SERVER_PROXY_PREFIX}/gpt`,
  claude: `${SERVER_PROXY_PREFIX}/claude`,
  grok: `${SERVER_PROXY_PREFIX}/grok`,
  aliyun: `${SERVER_PROXY_PREFIX}/aliyun`,
  runninghub: `${SERVER_PROXY_PREFIX}/runninghub`,
  seedream: `${SERVER_PROXY_PREFIX}/seedream`,
  jimeng: `${SERVER_PROXY_PREFIX}/jimeng`,
  tuzi: `${SERVER_PROXY_PREFIX}/tuzi`,
};

export function getServerProxyEndpoint(provider: ProxyProvider): string {
  return SERVER_PROXY_ENDPOINTS[provider];
}

export function isServerProxyEndpoint(value?: string | null): boolean {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;

  if (trimmed.startsWith(`${SERVER_PROXY_PREFIX}/`)) {
    return true;
  }

  try {
    const parsed = typeof window !== "undefined"
      ? new URL(trimmed, window.location.href)
      : new URL(trimmed);
    return parsed.pathname.startsWith(`${SERVER_PROXY_PREFIX}/`);
  } catch {
    return false;
  }
}

export function shouldUseServerProxyRouting(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.electronAPI === "object" && window.electronAPI !== null) return false;

  const { protocol } = window.location;
  return protocol === "http:" || protocol === "https:";
}

export function shouldPreferServerProxyDefaults(): boolean {
  if (!shouldUseServerProxyRouting()) return false;

  const { hostname } = window.location;

  return !/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(hostname);
}

export function hasUsableApiCredential(
  endpoint?: string | null,
  apiKey?: string | null,
): boolean {
  return isServerProxyEndpoint(endpoint) || Boolean(String(apiKey || "").trim());
}
