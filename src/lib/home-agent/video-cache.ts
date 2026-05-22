import { getProjectRootPath } from "@/lib/file-cache";
import { cacheRemoteMediaToCloud } from "./cloud-media-storage";

const VIDEO_CACHE_DIR = "media\\videos\\generated";

export type CachedProjectVideo = {
  localPath: string;
  previewUrl: string;
  size: number;
  mimeType: string;
};

export function isRemoteHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function sanitizeGeneratedVideoFileName(fileName: string, fallback: string): string {
  const normalized = fileName
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const safeName = normalized || fallback;
  return safeName.toLowerCase().endsWith(".mp4") ? safeName : `${safeName}.mp4`;
}

export function toLocalVideoPreviewUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, "/")}`;
}

export function normalizeLocalVideoPath(url: string): string {
  if (!url.startsWith("file://")) return url;

  let normalized = decodeURIComponent(url.replace(/^file:\/\/+/, ""));
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\//g, "\\");
}

export function resolveVideoAttachmentSource(url: string): Pick<CachedProjectVideo, "localPath" | "previewUrl"> {
  if (!url) {
    return { localPath: "", previewUrl: "" };
  }

  if (isRemoteHttpUrl(url)) {
    return { localPath: url, previewUrl: url };
  }

  const localPath = normalizeLocalVideoPath(url);
  return {
    localPath,
    previewUrl: toLocalVideoPreviewUrl(localPath),
  };
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read generated video"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

function appendFileNameSequence(fileName: string, sequence: number): string {
  if (sequence <= 1) return fileName;
  const extensionMatch = fileName.match(/(\.[A-Za-z0-9]{1,10})$/);
  const extension = extensionMatch?.[1] || "";
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  return `${baseName}_${String(sequence).padStart(2, "0")}${extension}`;
}

async function resolveUniqueVideoLocalPath(projectRoot: string, fileName: string): Promise<string> {
  const baseDir = `${projectRoot.replace(/[\\/]+$/, "")}\\${VIDEO_CACHE_DIR}`;
  const readBase64 = window.electronAPI?.storage?.readBase64;
  if (!readBase64) return `${baseDir}\\${fileName}`;

  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const candidate = `${baseDir}\\${appendFileNameSequence(fileName, sequence)}`;
    const result = await readBase64(candidate);
    if (!result?.exists) return candidate;
  }

  return `${baseDir}\\${Date.now()}-${fileName}`;
}

// 防止同一远程 URL 被并发下载多次，导致 session 和 project 存储不同的本地路径
const inFlightVideoDownloads = new Map<string, Promise<CachedProjectVideo | null>>();

export async function cacheProjectVideoSource(
  url: string,
  fileName: string,
  projectId: string | undefined,
): Promise<CachedProjectVideo | null> {
  if (!projectId || !isRemoteHttpUrl(url)) return null;

  const dedupeKey = `${projectId}::${url}`;
  const existing = inFlightVideoDownloads.get(dedupeKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      if (!window.electronAPI?.jimeng?.writeFile) {
        const cloudAsset = await cacheRemoteMediaToCloud({
          sourceUrl: url,
          folder: `projects/${projectId}/media/videos/generated`,
          fileName,
          mimeType: "video/mp4",
        });
        if (!cloudAsset?.url) return null;
        return {
          localPath: cloudAsset.url,
          previewUrl: cloudAsset.url,
          size: cloudAsset.size,
          mimeType: cloudAsset.mimeType || "video/mp4",
        };
      }

      const projectRoot = await getProjectRootPath(projectId);
      if (!projectRoot) return null;

      const response = await fetch(url);
      if (!response.ok) return null;

      const blob = await response.blob();
      const base64 = await readBlobAsBase64(blob);
      const fallbackName = `generated-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const safeFileName = sanitizeGeneratedVideoFileName(fileName, fallbackName);
      const localPath = await resolveUniqueVideoLocalPath(projectRoot, safeFileName);
      const result = await window.electronAPI.jimeng.writeFile(localPath, base64);
      if (!result?.ok) return null;

      return {
        localPath,
        previewUrl: toLocalVideoPreviewUrl(localPath),
        size: blob.size,
        mimeType: blob.type || "video/mp4",
      };
    } catch {
      return null;
    }
  })();

  inFlightVideoDownloads.set(dedupeKey, promise);
  promise.finally(() => inFlightVideoDownloads.delete(dedupeKey));
  return promise;
}
