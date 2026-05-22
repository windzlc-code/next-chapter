import { getResolvedFilesStoragePath } from "@/lib/storage-path";

export function parseSignedUrlDate(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

export function getSignedUrlExpiryTime(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const signedAt = parseSignedUrlDate(
      parsed.searchParams.get("X-Tos-Date") ?? parsed.searchParams.get("X-Amz-Date"),
    );
    const expires = Number(
      parsed.searchParams.get("X-Tos-Expires") ?? parsed.searchParams.get("X-Amz-Expires"),
    );
    if (!signedAt || !Number.isFinite(expires)) return null;
    return signedAt + expires * 1000;
  } catch {
    return null;
  }
}

export function isRemoteHttpUrl(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
}

const KNOWN_PLACEHOLDER_MEDIA_HOSTS = new Set(["example.com", "www.example.com"]);
const KNOWN_PLACEHOLDER_MEDIA_PATHS = new Set([
  "/char-1.jpg",
  "/scene-1.jpg",
  "/storyboard-1.jpg",
  "/video-1.mp4",
]);

export function isKnownPlaceholderMediaUrl(url: string | undefined): boolean {
  if (!isRemoteHttpUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      KNOWN_PLACEHOLDER_MEDIA_HOSTS.has(parsed.hostname.toLowerCase()) &&
      KNOWN_PLACEHOLDER_MEDIA_PATHS.has(parsed.pathname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function isExpiredSignedMediaUrl(
  url: string | undefined,
  now: number = Date.now(),
): boolean {
  const expiresAt = getSignedUrlExpiryTime(url);
  return expiresAt !== null && now >= expiresAt;
}

export function isExpiredRemoteSignedMediaUrl(
  url: string | undefined,
  now: number = Date.now(),
): boolean {
  return isRemoteHttpUrl(url) && isExpiredSignedMediaUrl(url, now);
}

export function hasUsableMediaUrl(url: string | undefined): boolean {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  if (isKnownPlaceholderMediaUrl(trimmed)) return false;
  if (isExpiredRemoteSignedMediaUrl(trimmed)) return false;
  return true;
}

export function isLocalMediaFilePath(value: string | undefined): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function normalizeLocalMediaFilePath(value: string): string {
  if (!value.startsWith("file://")) return value;

  let normalized = decodeURIComponent(value.replace(/^file:\/\/+/, ""));
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\//g, "\\");
}

let cachedFilesRoot: string | null | undefined = undefined;
const remoteMediaProbeCache = new Map<string, Promise<boolean>>();
const REMOTE_MEDIA_PROBE_TIMEOUT_MS = 15000;
type LocalMediaExistenceStatus = "exists" | "missing" | "unknown";

function isJsdomRuntime(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "");
}

function isLikelyVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v|webm|avi)(?:$|[?#])/i.test(url);
}

function createProbeTimeout(resolve: (value: boolean) => void) {
  return window.setTimeout(() => resolve(false), REMOTE_MEDIA_PROBE_TIMEOUT_MS);
}

function probeRemoteImageUrl(url: string): Promise<boolean> {
  if (typeof Image === "undefined") return Promise.resolve(true);

  return new Promise((resolve) => {
    const image = new Image();
    const timeout = createProbeTimeout((value) => {
      cleanup();
      resolve(value);
    });
    const cleanup = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      cleanup();
      resolve(true);
    };
    image.onerror = () => {
      cleanup();
      resolve(false);
    };
    image.src = url;
  });
}

function probeRemoteVideoUrl(url: string): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(true);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    const timeout = createProbeTimeout((value) => {
      cleanup();
      resolve(value);
    });
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.onloadeddata = null;
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    const succeed = () => {
      cleanup();
      resolve(true);
    };
    const fail = () => {
      cleanup();
      resolve(false);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadeddata = succeed;
    video.onloadedmetadata = succeed;
    video.onerror = fail;
    video.src = url;
    video.load();
  });
}

async function probeRemoteMediaUrl(url: string): Promise<boolean> {
  if (url.startsWith("blob:")) return true;
  if (typeof window === "undefined" || isJsdomRuntime()) return true;

  const cached = remoteMediaProbeCache.get(url);
  if (cached) return cached;

  const probePromise = (isLikelyVideoUrl(url) ? probeRemoteVideoUrl(url) : probeRemoteImageUrl(url))
    .catch(() => false)
    .finally(() => {
      remoteMediaProbeCache.delete(url);
    });
  remoteMediaProbeCache.set(url, probePromise);
  return probePromise;
}

export async function remapLocalMediaPathToCurrentFilesRoot(localPath: string): Promise<string> {
  const normalizedLocalPath = normalizeLocalMediaFilePath(localPath);
  const projectPathIndex = normalizedLocalPath.search(/[/\\]projects[/\\]/i);
  if (projectPathIndex === -1) return normalizedLocalPath;

  if (cachedFilesRoot === undefined) {
    cachedFilesRoot = await getResolvedFilesStoragePath();
  }
  if (!cachedFilesRoot) return normalizedLocalPath;

  const relativeProjectPath = normalizedLocalPath
    .slice(projectPathIndex)
    .replace(/\\/g, "/");
  return `${cachedFilesRoot.replace(/[\\/]+$/, "")}${relativeProjectPath}`.replace(/\//g, "\\");
}

async function buildLocalMediaCandidatePaths(localPath: string): Promise<string[]> {
  const normalizedLocalPath = normalizeLocalMediaFilePath(localPath);
  const remappedLocalPath = await remapLocalMediaPathToCurrentFilesRoot(localPath);
  return Array.from(
    new Set(
      [normalizedLocalPath, normalizeLocalMediaFilePath(remappedLocalPath)]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

async function readLocalMediaExistenceStatus(filePath: string): Promise<LocalMediaExistenceStatus> {
  const readBase64 = window.electronAPI?.storage?.readBase64;
  if (!readBase64) return "unknown";

  try {
    const result = await readBase64(filePath);
    if (!result?.ok) return "unknown";
    return result.exists ? "exists" : "missing";
  } catch {
    return "unknown";
  }
}

export async function isMediaAssetDefinitelyMissing(url: string | undefined): Promise<boolean> {
  const trimmed = String(url || "").trim();
  if (!trimmed) return true;
  if (isKnownPlaceholderMediaUrl(trimmed)) return true;
  if (isExpiredRemoteSignedMediaUrl(trimmed)) return true;
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return false;
  if (!isLocalMediaFilePath(trimmed)) return false;

  const candidates = await buildLocalMediaCandidatePaths(trimmed);
  if (!candidates.length) return false;

  let sawUnknown = false;
  for (const candidate of candidates) {
    const status = await readLocalMediaExistenceStatus(candidate);
    if (status === "exists") return false;
    if (status === "unknown") sawUnknown = true;
  }

  return !sawUnknown;
}

export async function doesUsableMediaAssetExist(url: string | undefined): Promise<boolean> {
  if (!hasUsableMediaUrl(url)) return false;
  if (!url) return false;

  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return true;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return probeRemoteMediaUrl(url);
  }

  if (!isLocalMediaFilePath(url)) return true;

  const candidates = await buildLocalMediaCandidatePaths(url);
  if (!candidates.length) return true;

  let sawUnknown = false;
  for (const candidate of candidates) {
    const status = await readLocalMediaExistenceStatus(candidate);
    if (status === "exists") return true;
    if (status === "unknown") sawUnknown = true;
  }

  return sawUnknown ? true : false;
}

export async function resolveLocalMediaPreviewDataUrl(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (!isLocalMediaFilePath(url)) return null;

  const readBase64 = window.electronAPI?.storage?.readBase64;
  if (!readBase64) return null;

  const candidates = await buildLocalMediaCandidatePaths(url);
  for (const candidate of candidates) {
    try {
      const result = await readBase64(candidate);
      if (!result?.ok || !result?.base64) continue;
      return `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
    } catch {
      continue;
    }
  }

  return null;
}
