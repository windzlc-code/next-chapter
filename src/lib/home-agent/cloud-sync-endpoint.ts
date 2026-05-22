const LOCAL_HOME_AGENT_API_BASE = "http://127.0.0.1:3001";

function trimLeadingSlash(value: string): string {
  return String(value || "").replace(/^\/+/, "");
}

export function resolveHomeAgentSyncEndpoint(pathname: string): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (typeof window === "undefined") return normalizedPath;

  if (window.electronAPI?.storage || window.location.protocol === "file:") {
    return `${LOCAL_HOME_AGENT_API_BASE}/${trimLeadingSlash(normalizedPath)}`;
  }

  return normalizedPath;
}

export function canUseHomeAgentSyncFetch(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.fetch === "function" &&
    typeof window.localStorage !== "undefined"
  );
}
