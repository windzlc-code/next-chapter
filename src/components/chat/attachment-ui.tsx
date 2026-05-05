import * as React from "react";
import {
  AlertCircle,
  Download,
  File as FileIcon,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  FolderInput,
  Paperclip,
  Play,
  RefreshCw,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import { cn } from "@/lib/utils";

function AttachmentKindIcon({
  kind,
  className,
}: {
  kind: ChatAttachment["kind"];
  className?: string;
}) {
  if (kind === "image") return <FileImage className={className} />;
  if (kind === "video") return <Film className={className} />;
  if (kind === "document" || kind === "text") return <FileText className={className} />;
  return <FileIcon className={className} />;
}

/** 为 File 对象创建并管理 object URL 预览（图片 + 视频） */
function useFilePreviews(files: File[]): Map<number, string> {
  const [previews, setPreviews] = React.useState<Map<number, string>>(new Map());

  React.useEffect(() => {
    const newPreviews = new Map<number, string>();
    files.forEach((file, index) => {
      if (
        (file.type.startsWith("image/") || file.type.startsWith("video/")) &&
        typeof URL.createObjectURL === "function"
      ) {
        newPreviews.set(index, URL.createObjectURL(file));
      }
    });
    setPreviews(newPreviews);
    return () => {
      if (typeof URL.revokeObjectURL === "function") {
        newPreviews.forEach((url) => URL.revokeObjectURL(url));
      }
    };
  }, [files]);

  return previews;
}

export function DraftAttachmentList({
  files,
  activeTheme,
  collapsed,
  onToggleCollapsed,
  onRemove,
}: {
  files: File[];
  activeTheme: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRemove: (index: number) => void;
}) {
  const imagePreviews = useFilePreviews(files);

  if (!files.length) return null;

  const mediaFiles = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
  const nonMediaFiles = files.filter((f) => !f.type.startsWith("image/") && !f.type.startsWith("video/"));

  return (
    <div
      className={cn(
        "mb-2 rounded-xl border px-3 py-2",
        activeTheme ? "border-white/[0.08] bg-white/[0.04]" : "border-border bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-[11.5px] font-medium", activeTheme ? "text-white/60" : "text-muted-foreground")}>
          已附加 {files.length} 个文件
        </span>
        <button
          type="button"
          className={cn(
            "text-[11px] transition",
            activeTheme ? "text-white/40 hover:text-white/70" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={onToggleCollapsed}
        >
          {collapsed ? "展开" : "收起"}
        </button>
      </div>
      {!collapsed ? (
        <div className="mt-2 space-y-2">
          {/* 图片/视频缩略图区域 */}
          {mediaFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {files.map((file, index) => {
                const isImg = file.type.startsWith("image/");
                const isVid = file.type.startsWith("video/");
                if (!isImg && !isVid) return null;
                const previewUrl = imagePreviews.get(index);
                return (
                  <div
                    key={`${file.name}-${index}`}
                    className={cn(
                      "relative group rounded-lg overflow-hidden border-2 shrink-0",
                      activeTheme
                        ? "border-primary/70 ring-1 ring-primary/30"
                        : "border-primary/60 ring-1 ring-primary/20",
                    )}
                    style={{ width: 72, height: 72 }}
                    title={file.name}
                  >
                    {previewUrl ? (
                      isVid ? (
                        <video src={previewUrl} className="w-full h-full object-cover" muted preload="metadata" />
                      ) : (
                        <img src={previewUrl} alt={file.name} className="w-full h-full object-cover" />
                      )
                    ) : (
                      <div
                        className={cn(
                          "w-full h-full flex items-center justify-center",
                          activeTheme ? "bg-white/[0.08]" : "bg-muted/50",
                        )}
                      >
                        {isVid
                          ? <Film className={cn("h-5 w-5", activeTheme ? "text-white/55" : "text-muted-foreground")} />
                          : <FileImage className={cn("h-5 w-5", activeTheme ? "text-white/55" : "text-muted-foreground")} />
                        }
                      </div>
                    )}
                    <button
                      type="button"
                      className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5"
                      onClick={() => onRemove(index)}
                      aria-label={`移除 ${file.name}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* 非媒体文件列表 */}
          {nonMediaFiles.length > 0 && (
            <div className="flex flex-col gap-1">
              {files.map((file, index) => {
                if (file.type.startsWith("image/") || file.type.startsWith("video/")) return null;
                return (
                  <div key={`${file.name}-${index}`} className="flex items-center gap-2">
                    <Paperclip
                      className={cn("h-3 w-3 shrink-0", activeTheme ? "text-white/40" : "text-muted-foreground")}
                    />
                    <span
                      className={cn(
                        "flex-1 truncate text-[11.5px]",
                        activeTheme ? "text-white/80" : "text-foreground/80",
                      )}
                    >
                      {file.name}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[10.5px]",
                        activeTheme ? "text-white/30" : "text-muted-foreground/60",
                      )}
                    >
                      {(file.size / 1024).toFixed(0)}KB
                    </span>
                    <button
                      type="button"
                      className={cn(
                        "shrink-0 text-[11px] transition",
                        activeTheme ? "text-white/30 hover:text-red-400" : "text-muted-foreground hover:text-red-500",
                      )}
                      onClick={() => onRemove(index)}
                      aria-label={`移除 ${file.name}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

async function downloadAttachment(url: string, fileName: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const ext = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName.includes(".") ? fileName : `${fileName}.${ext}`;
    a.click();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank");
  }
}

function parseSignedUrlDate(value: string | null): number | null {
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

function getSignedUrlExpiryTime(url: string | undefined): number | null {
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

function isSignedUrlExpired(url: string | undefined): boolean {
  const expiresAt = getSignedUrlExpiryTime(url);
  return Boolean(expiresAt && Date.now() >= expiresAt);
}

function getVideoLoadErrorMessage(url: string | undefined, localMissing = false): string {
  if (localMissing) {
    return "本地视频文件不存在，可能已被删除或移动，请重新生成视频。";
  }
  const expiresAt = getSignedUrlExpiryTime(url);
  if (expiresAt && Date.now() >= expiresAt) {
    return "视频临时链接已过期或无权限访问，请重新生成视频。";
  }
  return "视频链接加载失败，请重新生成视频或检查网络。";
}

function getImageLoadErrorMessage(url: string | undefined, localMissing = false): string {
  if (localMissing) {
    return "本地图片文件不存在，可能已被删除或移动，请重新生成图片。";
  }
  const expiresAt = getSignedUrlExpiryTime(url);
  if (expiresAt && Date.now() >= expiresAt) {
    return "图片临时链接已过期或无权限访问，请重新生成图片。";
  }
  return "图片链接加载失败，请重新生成图片或检查网络。";
}

function AttachmentUnavailableState({
  kind,
  message,
  activeTheme,
}: {
  kind: "image" | "video";
  message: string;
  activeTheme?: boolean;
}) {
  const Icon = kind === "video" ? Film : FileImage;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-black/25">
        <Icon className={cn("h-6 w-6", activeTheme ? "text-white/60" : "text-muted-foreground")} />
      </div>
      <span className={cn("max-w-[24rem] text-[12px] leading-5", activeTheme ? "text-white/78" : "text-foreground/70")}>
        {message}
      </span>
    </div>
  );
}

type AddToAssetsPayload = {
  url: string;
  fileName: string;
  localPath?: string | null;
  kind?: "image" | "video";
  target?: ChatAttachment["generationContext"];
  isHistoricalVersion?: boolean;
};

function dispatchAddToAssets(payload: AddToAssetsPayload) {
  window.dispatchEvent(new CustomEvent("agent:add-to-assets", { detail: payload }));
}

function isLocalAttachmentPath(value: string | undefined): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return value.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function normalizeLocalAttachmentPath(value: string): string {
  if (!value.startsWith("file://")) return value;

  let normalized = decodeURIComponent(value.replace(/^file:\/\/+/, ""));
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\//g, "\\");
}

function resolveAttachmentLocalPath(
  attachment: Pick<ChatAttachment, "localPath" | "previewUrl">,
): string | null {
  if (isLocalAttachmentPath(attachment.localPath)) {
    return normalizeLocalAttachmentPath(attachment.localPath!);
  }
  if (isLocalAttachmentPath(attachment.previewUrl)) {
    return normalizeLocalAttachmentPath(attachment.previewUrl!);
  }
  return null;
}

function doesAttachmentLocalFileExist(
  attachment: Pick<ChatAttachment, "localPath" | "previewUrl">,
): boolean {
  const targetPath = resolveAttachmentLocalPath(attachment);
  if (!targetPath) return true;
  const exists = window.electronAPI?.storage?.exists;
  if (typeof exists !== "function") return true;
  try {
    return exists(targetPath);
  } catch {
    return false;
  }
}

function isAttachmentLocallyMissing(
  attachment: Pick<ChatAttachment, "localPath" | "previewUrl">,
): boolean {
  return Boolean(resolveAttachmentLocalPath(attachment)) && !doesAttachmentLocalFileExist(attachment);
}

async function revealAttachmentInFolder(
  attachment: Pick<ChatAttachment, "localPath" | "previewUrl">,
): Promise<void> {
  const targetPath = resolveAttachmentLocalPath(attachment);
  if (!targetPath) return;

  const storage = window.electronAPI?.storage;
  if (storage?.openPath) {
    await storage.openPath(targetPath);
    return;
  }

  const folderPath = targetPath.replace(/[\\/][^\\/]+$/, "");
  if (storage?.openFolder) {
    await storage.openFolder(folderPath || targetPath);
  }
}

function getAttachmentVersions(attachment: ChatAttachment) {
  if (attachment.history?.length) return attachment.history;
  if (!attachment.previewUrl && !attachment.localPath) return [];
  return [
    {
      id: `${attachment.id}-current`,
      fileName: attachment.fileName,
      label: attachment.label,
      localPath: attachment.localPath,
      previewUrl: attachment.previewUrl,
      createdAt: "",
    },
  ];
}

function getResolvedAttachmentVersionIndex(
  attachment: ChatAttachment,
  selectedVersionIndex?: number,
): number {
  const versions = getAttachmentVersions(attachment);
  if (!versions.length) return -1;
  if (typeof selectedVersionIndex !== "number" || !Number.isFinite(selectedVersionIndex)) {
    return versions.length - 1;
  }
  return Math.max(0, Math.min(versions.length - 1, selectedVersionIndex));
}

function getAttachmentViewModel(
  attachment: ChatAttachment,
  selectedVersionIndex?: number,
): ChatAttachment & {
  versionCount: number;
  activeVersionIndex: number;
  activeVersionLabel?: string;
  isLatestVersion: boolean;
} {
  const versions = getAttachmentVersions(attachment);
  if (!versions.length) {
    return {
      ...attachment,
      versionCount: 0,
      activeVersionIndex: -1,
      activeVersionLabel: undefined,
      isLatestVersion: true,
    };
  }

  const activeVersionIndex = getResolvedAttachmentVersionIndex(attachment, selectedVersionIndex);
  const activeVersion = versions[activeVersionIndex] ?? versions[versions.length - 1];

  return {
    ...attachment,
    fileName: activeVersion.fileName || attachment.fileName,
    label: activeVersion.label ?? attachment.label,
    localPath: activeVersion.localPath ?? attachment.localPath,
    previewUrl: activeVersion.previewUrl ?? attachment.previewUrl,
    versionCount: versions.length,
    activeVersionIndex,
    activeVersionLabel:
      versions.length > 1 ? `${activeVersionIndex + 1} / ${versions.length}` : undefined,
    isLatestVersion: activeVersionIndex === versions.length - 1,
  };
}

function getAttachmentAspectRatio(attachment: Pick<ChatAttachment, "aspectRatio">) {
  const value = attachment.aspectRatio?.trim();
  return (value || "16:9").replace(":", " / ");
}

function getMediaAspectStyle(attachment: Pick<ChatAttachment, "aspectRatio">) {
  const aspectRatio = getAttachmentAspectRatio(attachment);
  return {
    "--media-aspect-ratio": aspectRatio,
    aspectRatio,
  } as React.CSSProperties;
}

function getMediaCardWidthClass(compact: boolean) {
  return compact ? "w-[min(200px,100%)] max-w-full" : "w-[min(520px,100%)] max-w-full";
}

function getMediaCardFooterClass(compact: boolean) {
  return compact ? "h-9 px-2 py-1.5" : "h-10 px-2.5 py-2";
}

function useNearViewport<T extends HTMLElement>(enabled: boolean, rootMargin = "360px") {
  const ref = React.useRef<T | null>(null);
  const [nearViewport, setNearViewport] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setNearViewport(false);
      return;
    }

    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return [ref, nearViewport] as const;
}

const VIDEO_POSTER_CACHE_LIMIT = 120;
const videoPosterCache = new Map<string, string>();

function rememberVideoPoster(url: string, poster: string): void {
  if (videoPosterCache.has(url)) videoPosterCache.delete(url);
  videoPosterCache.set(url, poster);
  if (videoPosterCache.size <= VIDEO_POSTER_CACHE_LIMIT) return;
  const oldestKey = videoPosterCache.keys().next().value;
  if (oldestKey) videoPosterCache.delete(oldestKey);
}

function getVideoPosterCacheKey(url: string): string {
  return `v2:${url}`;
}

function getVideoPosterTargetTimes(video: HTMLVideoElement): number[] {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0.2) return [0];
  const latestSafeTime = Math.max(0, duration - 0.05);
  const fixedCandidates = [0.5, 1].map((time) => Math.min(time, latestSafeTime));
  const ratioCandidates = [0.15, 0.3, 0.5].map((ratio) => Math.min(duration * ratio, latestSafeTime));
  const candidates = [...fixedCandidates, ...ratioCandidates];
  return Array.from(new Set(candidates.map((time) => Number(time.toFixed(3)))));
}

function isMostlyDarkFrame(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  let luminanceTotal = 0;
  let brightPixels = 0;
  const pixelCount = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
    luminanceTotal += luminance;
    if (luminance > 32) brightPixels += 1;
  }
  return luminanceTotal / pixelCount < 14 && brightPixels / pixelCount < 0.015;
}

function useVideoPosterCache(url?: string | null) {
  const cacheKey = url ? getVideoPosterCacheKey(url) : "";
  const posterAttemptRef = React.useRef({ key: "", index: 0 });
  const [poster, setPoster] = React.useState<string | null>(() =>
    cacheKey ? videoPosterCache.get(cacheKey) ?? null : null,
  );

  React.useEffect(() => {
    posterAttemptRef.current = { key: "", index: 0 };
    setPoster(cacheKey ? videoPosterCache.get(cacheKey) ?? null : null);
  }, [cacheKey]);

  const capturePosterFromVideo = React.useCallback((video: HTMLVideoElement) => {
    if (!cacheKey || videoPosterCache.has(cacheKey)) return false;
    if (!video.videoWidth || !video.videoHeight) return false;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      if (isMostlyDarkFrame(ctx, canvas.width, canvas.height)) return false;
      const nextPoster = canvas.toDataURL("image/jpeg", 0.72);
      rememberVideoPoster(cacheKey, nextPoster);
      setPoster(nextPoster);
      return true;
    } catch {
      // Remote videos without CORS can taint the canvas; keep the native video preview.
      return false;
    }
  }, [cacheKey]);

  const capturePoster = React.useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (capturePosterFromVideo(video)) return;
    if (!cacheKey || videoPosterCache.has(cacheKey)) return;
    const times = getVideoPosterTargetTimes(video);
    const attempt = posterAttemptRef.current.key === cacheKey
      ? posterAttemptRef.current
      : { key: cacheKey, index: 0 };
    const nextIndex = attempt.index + 1;
    if (nextIndex >= times.length) return;
    posterAttemptRef.current = { key: cacheKey, index: nextIndex };
    try {
      video.currentTime = times[nextIndex];
    } catch {
      // Some remote videos disallow seeking before enough data is buffered.
    }
  }, [cacheKey, capturePosterFromVideo]);

  const primePosterFrame = React.useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!cacheKey || videoPosterCache.has(cacheKey)) return;
    const video = event.currentTarget;
    const targetTime = getVideoPosterTargetTimes(video)[0] ?? 0;
    if (Math.abs(video.currentTime - targetTime) <= 0.05) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        capturePosterFromVideo(video);
      }
      return;
    }
    if (posterAttemptRef.current.key === cacheKey) return;
    posterAttemptRef.current = { key: cacheKey, index: 0 };
    try {
      video.currentTime = targetTime;
    } catch {
      // Some remote videos disallow seeking before enough data is buffered.
    }
  }, [cacheKey, capturePosterFromVideo]);

  return { poster, capturePoster, primePosterFrame };
}

/**
 * 聊天消息中图片灯箱（支持多图轮播 + 跨消息全局导航）
 *
 * - images: 当前消息的图片列表（用于缩略图条）
 * - allImages: 整个会话中所有图片（用于跨消息导航）
 * - initialGlobalIndex: 点击的图片在 allImages 中的全局索引
 */
function ChatImageLightbox({
  allImages,
  initialGlobalIndex,
  onClose,
}: {
  allImages: ChatAttachment[];
  initialGlobalIndex: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = React.useState(initialGlobalIndex);
  const total = allImages.length;
  const img = allImages[current];

  const prev = React.useCallback(() => setCurrent((i) => (i - 1 + total) % total), [total]);
  const next = React.useCallback(() => setCurrent((i) => (i + 1) % total), [total]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onClose]);

  // 鼠标滚轮切换
  React.useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) next();
      else if (e.deltaY < 0) prev();
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [prev, next]);

  if (!img) return null;

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/85 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-[60] w-[min(96vw,1200px)] max-w-[min(96vw,1200px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">图片预览</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">聊天消息图片大图预览</DialogPrimitive.Description>

          {/* 标题栏 */}
          <div className="flex items-center justify-between border-b border-border px-5 py-3 pr-12">
            <span className="text-[13px] font-medium text-foreground truncate">{img.label || img.fileName}</span>
            <div className="ml-3 flex shrink-0 items-center gap-2">
              {total > 1 && (
                <span className="text-[11px] text-muted-foreground">{current + 1} / {total}</span>
              )}
              {img.previewUrl && (
                <button
                  type="button"
                  onClick={() => void downloadAttachment(img.previewUrl!, img.fileName)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/70 transition hover:bg-muted hover:text-foreground"
                  title="下载图片"
                >
                  <Download className="h-3 w-3" />
                  下载
                </button>
              )}
            </div>
          </div>

          {/* 图片区域 */}
          <div className="relative flex max-h-[min(85vh,840px)] items-center justify-center overflow-auto bg-muted/30 p-4">
            <img
              key={img.id}
              src={img.previewUrl}
              alt={img.fileName}
              className="max-h-[min(80vh,800px)] max-w-full rounded-xl object-contain shadow-lg"
            />

            {total > 1 && (
              <>
                <button
                  type="button"
                  onClick={prev}
                  className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus:outline-none"
                  aria-label="上一张"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={next}
                  className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus:outline-none"
                  aria-label="下一张"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
          </div>

          {/* 多图缩略图条 */}
          {total > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-border px-4 py-2.5 scrollbar-none">
              {allImages.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCurrent(idx)}
                  className={cn(
                    "h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition",
                    idx === current ? "border-primary" : "border-transparent opacity-60 hover:opacity-90",
                  )}
                >
                  <img src={item.previewUrl} alt={item.fileName} className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <DialogPrimitive.Close
            type="button"
            aria-label="关闭"
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 视频灯箱：点击卡片后打开，内嵌播放器自动播放 */
function ChatVideoLightbox({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  const view = attachment;
  const signedUrlExpired = isSignedUrlExpired(view.previewUrl);
  const localFileMissing = isAttachmentLocallyMissing(view);
  const [loadError, setLoadError] = React.useState(signedUrlExpired || localFileMissing);
  const hasLocalSource = Boolean(resolveAttachmentLocalPath(view));

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  React.useEffect(() => {
    setLoadError(signedUrlExpired || localFileMissing);
  }, [localFileMissing, signedUrlExpired, view.previewUrl]);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-[60] w-[min(96vw,960px)] max-w-[min(96vw,960px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">视频预览</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">聊天消息视频预览</DialogPrimitive.Description>

          <div className="flex items-center justify-between border-b border-border px-5 py-3 pr-12">
            <span className="text-[13px] font-medium text-foreground truncate">{view.label || view.fileName}</span>
            <div className="ml-3 flex shrink-0 items-center gap-2">
              {hasLocalSource ? (
                <button
                  type="button"
                  onClick={() => void revealAttachmentInFolder(view)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/70 transition hover:bg-muted hover:text-foreground"
                  title="定位本地文件"
                >
                  <FolderOpen className="h-3 w-3" />
                  定位文件
                </button>
              ) : null}
              {view.previewUrl ? (
                <button
                  type="button"
                  onClick={() => void downloadAttachment(view.previewUrl!, view.fileName)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] text-foreground/70 transition hover:bg-muted hover:text-foreground"
                  title="下载视频"
                >
                  <Download className="h-3 w-3" />
                  下载
                </button>
              ) : null}
            </div>
          </div>

          <div className="relative flex items-center justify-center bg-black p-0">
            <video
              key={view.previewUrl}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onError={() => setLoadError(true)}
              className="max-h-[min(80vh,720px)] w-full rounded-b-2xl object-contain"
              aria-label={`播放视频：${attachment.fileName}`}
            >
              {!signedUrlExpired && !localFileMissing && view.previewUrl ? (
                <source src={view.previewUrl} type={view.mimeType || "video/mp4"} />
              ) : null}
            </video>
            {loadError ? (
              <div className="absolute inset-x-4 top-4 rounded-lg bg-black/75 px-3 py-2 text-center text-[12px] text-white shadow-lg">
                {getVideoLoadErrorMessage(view.previewUrl, localFileMissing)}
              </div>
            ) : null}
          </div>

          <DialogPrimitive.Close
            type="button"
            aria-label="关闭"
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 视频附件卡片，支持预览和定位本地文件。 */
function VideoAttachmentCard({
  attachment,
  compact,
  activeTheme,
  onOpenLightbox,
  onRegenerateAttachment,
  selectedVersionIndex,
  onSelectVersion,
}: {
  attachment: ChatAttachment;
  compact: boolean;
  activeTheme: boolean;
  onOpenLightbox: () => void;
  onRegenerateAttachment?: (attachmentId: string) => void;
  selectedVersionIndex?: number;
  onSelectVersion?: (attachmentId: string, nextIndex: number) => void;
}) {
  const isDraggingRef = React.useRef(false);
  const pointerStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const view = getAttachmentViewModel(attachment, selectedVersionIndex);
  const signedUrlExpired = isSignedUrlExpired(view.previewUrl);
  const localFileMissing = isAttachmentLocallyMissing(view);
  const hasLocalSource = Boolean(resolveAttachmentLocalPath(view));
  const canPreviewVideo = !!view.previewUrl && !signedUrlExpired && !localFileMissing;
  const canAddVideoToAssets =
    !attachment.pending && !!view.previewUrl && !signedUrlExpired && !localFileMissing;
  const [previewRef, nearViewport] = useNearViewport<HTMLDivElement>(canPreviewVideo && !attachment.pending);
  const {
    poster: cachedPoster,
    capturePoster,
    primePosterFrame,
  } = useVideoPosterCache(canPreviewVideo ? view.previewUrl : null);
  const shouldLoadPoster = canPreviewVideo && !cachedPoster && nearViewport;

  const handleDragStart = (e: React.DragEvent) => {
    if (!canAddVideoToAssets) return;
    isDraggingRef.current = true;
    const payload = {
      url: view.previewUrl,
      localPath: resolveAttachmentLocalPath(view),
      fileName: view.fileName,
      kind: "video" as const,
      target: attachment.generationContext,
      isHistoricalVersion: !view.isLatestVersion,
    };
    e.dataTransfer.setData(
      "application/x-infinio-image",
      JSON.stringify(payload),
    );
    e.dataTransfer.setData(
      "application/x-infinio-sidebar-image",
      JSON.stringify({ url: view.previewUrl, label: view.fileName }),
    );
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDragEnd = () => {
    setTimeout(() => { isDraggingRef.current = false; }, 50);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleOpenClick = (e: React.MouseEvent) => {
    if (!canPreviewVideo) return;
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (start) {
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (moved > 6) return;
    }
    onOpenLightbox();
  };

  return (
    <div
      draggable={canAddVideoToAssets}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      className={cn(
        "group relative shrink-0 overflow-hidden rounded-2xl border border-border/50 bg-muted/10 shadow-sm",
        canAddVideoToAssets && "cursor-grab active:cursor-grabbing",
        getMediaCardWidthClass(compact),
      )}
    >
      <div
        className="relative aspect-[var(--media-aspect-ratio)] overflow-hidden bg-black/80"
        style={getMediaAspectStyle(attachment)}
      >
        {attachment.pending ? (
          <div className="relative h-full w-full overflow-hidden">
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 w-full animate-shimmer-sweep"
                style={{ background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.09) 50%, transparent 100%)" }}
              />
            </div>
            <div className="flex h-full w-full flex-col items-center justify-center gap-2.5">
              <div className="relative h-10 w-10">
                <div className="absolute inset-0 rounded-full border-2 border-primary/15" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary/50" />
              </div>
              <span className="text-[12px] font-medium text-foreground/50">正在生成视频</span>
            </div>
          </div>
        ) : view.previewUrl ? (
          <div
            ref={previewRef}
            role={canPreviewVideo ? "button" : undefined}
            tabIndex={canPreviewVideo ? 0 : undefined}
            onPointerDown={handlePointerDown}
            onClick={handleOpenClick}
            onKeyDown={(e) => {
              if (canPreviewVideo && (e.key === "Enter" || e.key === " ")) onOpenLightbox();
            }}
            className={cn("relative h-full w-full", canPreviewVideo ? "cursor-pointer" : "cursor-default")}
            aria-label={`播放视频：${attachment.fileName}`}
          >
            {cachedPoster ? (
              <img
                src={cachedPoster}
                alt={view.fileName}
                className="h-full w-full object-contain"
                loading="lazy"
                decoding="async"
              />
            ) : shouldLoadPoster ? (
              <video
                src={view.previewUrl}
                preload="metadata"
                muted
                playsInline
                onLoadedMetadata={primePosterFrame}
                onLoadedData={capturePoster}
                onSeeked={capturePoster}
                className="h-full w-full object-contain"
              />
            ) : null}
            {canPreviewVideo ? (
              <>
                <div className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors hover:bg-black/40">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/90 shadow-lg transition-transform group-hover:scale-105">
                <Play className="ml-1 h-6 w-6 text-black" />
              </div>
            </div>
                <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/40 px-1.5 py-0.5 text-[9px] text-white/70 opacity-0 transition-opacity group-hover:opacity-100">
                  可拖拽
                </div>
              </>
            ) : (
              <div className="absolute inset-0 bg-black/65">
                <AttachmentUnavailableState
                  kind="video"
                  message={getVideoLoadErrorMessage(view.previewUrl, localFileMissing)}
                  activeTheme={activeTheme}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted/30">
            <Film className={cn("h-7 w-7", activeTheme ? "text-white/55" : "text-muted-foreground")} />
          </div>
        )}
      </div>
      {!attachment.pending && view.versionCount > 1 ? (
        <div className="pointer-events-none absolute right-2 top-[calc(50%-18px)] z-10 flex -translate-y-1/2 flex-col gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectVersion?.(attachment.id, view.activeVersionIndex - 1);
            }}
            disabled={view.activeVersionIndex <= 0}
            className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="查看上一个版本"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelectVersion?.(attachment.id, view.activeVersionIndex + 1);
            }}
            disabled={view.activeVersionIndex >= view.versionCount - 1}
            className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="查看下一个版本"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {!attachment.pending && view.activeVersionLabel ? (
        <div className="pointer-events-none absolute bottom-11 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/80">
          {view.activeVersionLabel}
        </div>
      ) : null}
      <div className={cn("flex items-center gap-1.5", getMediaCardFooterClass(compact))}>
        <div className="min-w-0 flex-1 truncate text-[11px] text-foreground/60">
          {view.label ?? view.fileName.replace(/\.[^.]+$/, "")}
        </div>
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onRegenerateAttachment && !attachment.pending ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRegenerateAttachment(attachment.id);
              }}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full transition",
                activeTheme
                  ? "bg-white/[0.08] text-white/70 hover:bg-white/[0.14] hover:text-white"
                  : "bg-muted/80 text-foreground/60 hover:bg-muted hover:text-foreground",
              )}
              title="重新生成"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          ) : null}
          {view.previewUrl && !attachment.pending ? (
            <button
              type="button"
              onClick={() => {
                if (!canPreviewVideo) return;
                void downloadAttachment(view.previewUrl!, view.fileName);
              }}
              disabled={!canPreviewVideo}
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40",
                activeTheme
                  ? "bg-white/[0.08] text-white/70 hover:bg-white/[0.14] hover:text-white"
                  : "bg-muted/80 text-foreground/60 hover:bg-muted hover:text-foreground",
              )}
              title="下载视频"
            >
              <Download className="h-3 w-3" />
            </button>
          ) : null}
          {hasLocalSource && !attachment.pending ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void revealAttachmentInFolder(view);
              }}
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition",
                activeTheme
                  ? "bg-white/[0.08] text-white/70 hover:bg-white/[0.14] hover:text-white"
                  : "bg-muted/80 text-foreground/60 hover:bg-muted hover:text-foreground",
              )}
              title="定位本地文件"
            >
              <FolderOpen className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}


export function MessageAttachmentList({
  attachments,
  activeTheme = true,
  compact = false,
  allConversationImages,
  onRegenerateAttachment,
}: {
  attachments?: ChatAttachment[];
  activeTheme?: boolean;
  compact?: boolean;
  /** 整个会话中所有已生成图片（用于跨消息灯箱导航） */
  allConversationImages?: ChatAttachment[];
  onRegenerateAttachment?: (attachmentId: string) => void;
}) {
  const [lightboxGlobalIndex, setLightboxGlobalIndex] = React.useState<number | null>(null);
  const [videoLightboxAttachment, setVideoLightboxAttachment] = React.useState<ChatAttachment | null>(null);
  const [selectedVersionIndices, setSelectedVersionIndices] = React.useState<Record<string, number>>({});
  const latestVersionIndicesRef = React.useRef<Record<string, number>>({});

  React.useEffect(() => {
    setSelectedVersionIndices((prev) => {
      const next = { ...prev };
      const latestById: Record<string, number> = {};
      let changed = false;
      for (const attachment of attachments ?? []) {
        const latestIndex = getAttachmentVersions(attachment).length - 1;
        if (latestIndex < 0) continue;
        latestById[attachment.id] = latestIndex;
        const previousLatestIndex = latestVersionIndicesRef.current[attachment.id];
        const selectedIndex = next[attachment.id];
        const shouldResetToLatest =
          typeof selectedIndex !== "number" ||
          !Number.isFinite(selectedIndex) ||
          selectedIndex > latestIndex ||
          previousLatestIndex === undefined ||
          latestIndex > previousLatestIndex;
        if (shouldResetToLatest && next[attachment.id] !== latestIndex) {
          next[attachment.id] = latestIndex;
          changed = true;
        }
      }
      latestVersionIndicesRef.current = latestById;
      return changed ? next : prev;
    });
  }, [attachments]);

  const handleSelectVersion = React.useCallback((attachmentId: string, nextIndex: number) => {
    const attachment = attachments?.find((item) => item.id === attachmentId);
    if (!attachment) return;
    const resolvedIndex = getResolvedAttachmentVersionIndex(attachment, nextIndex);
    setSelectedVersionIndices((prev) => ({
      ...prev,
      [attachmentId]: resolvedIndex,
    }));
  }, [attachments]);

  if (!attachments?.length) return null;

  const imageAttachments = attachments.filter((a) => a.kind === "image");
  const videoAttachments = attachments.filter((a) => a.kind === "video");
  const nonMediaAttachments = attachments.filter((a) => a.kind !== "image" && a.kind !== "video");
  const globalImages = (allConversationImages ?? imageAttachments)
    .map((attachment) => getAttachmentViewModel(attachment, selectedVersionIndices[attachment.id]))
    .filter((attachment) =>
      attachment.previewUrl &&
      !isSignedUrlExpired(attachment.previewUrl) &&
      !isAttachmentLocallyMissing(attachment),
    );

  return (
    <>
      {imageAttachments.length > 0 && (
        <div className={cn("mt-2 flex w-full max-w-full min-w-0 flex-wrap overflow-x-hidden scrollbar-none", compact ? "gap-2" : "gap-3")}>
          {imageAttachments.map((attachment) => {
            if (attachment.pending) {
              return (
                <div
                  key={attachment.id}
                  className={cn(
                    "relative shrink-0 overflow-hidden rounded-2xl border border-border/30 bg-muted/30",
                    getMediaCardWidthClass(compact),
                  )}
                >
                  <div
                    className="relative aspect-[var(--media-aspect-ratio)] overflow-hidden"
                    style={getMediaAspectStyle(attachment)}
                  >
                    {/* translateX 扫光层 */}
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 w-full animate-shimmer-sweep"
                        style={{
                          background:
                            "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.11) 50%, transparent 100%)",
                        }}
                      />
                    </div>
                    {/* 中心内容 */}
                    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
                      <div className="relative h-12 w-12">
                        <div className="absolute inset-0 rounded-full border-2 border-primary/15" />
                        <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary/55" />
                      </div>
                      <div className="flex flex-col items-center gap-2.5">
                        <span className="text-[13px] font-medium text-foreground/55">正在生成图片</span>
                        <div className="flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/45 animate-dot-pulse-0" />
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/45 animate-dot-pulse-1" />
                          <span className="h-1.5 w-1.5 rounded-full bg-primary/45 animate-dot-pulse-2" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={cn("flex items-center gap-1.5", getMediaCardFooterClass(compact))}>
                    <div className="min-w-0 flex-1 truncate text-[11px] text-foreground/60">
                      {attachment.label ?? attachment.fileName.replace(/\.[^.]+$/, "")}
                    </div>
                  </div>
                </div>
              );
            }

            if (attachment.failed) {
              return (
                <div
                  key={attachment.id}
                  className={cn(
                    "relative shrink-0 overflow-hidden rounded-2xl border border-destructive/30 bg-destructive/5",
                    getMediaCardWidthClass(compact),
                  )}
                >
                  <div
                    className="relative aspect-[var(--media-aspect-ratio)] overflow-hidden"
                    style={getMediaAspectStyle(attachment)}
                  >
                    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
                      <AlertCircle className="h-8 w-8 text-destructive/60" />
                      <span className="text-[12px] leading-5 text-destructive/70">
                        {attachment.failureReason || "生成失败"}
                      </span>
                    </div>
                  </div>
                  <div className={cn("flex items-center gap-1.5", getMediaCardFooterClass(compact))}>
                    <div className="min-w-0 flex-1 truncate text-[11px] text-foreground/50">
                      {attachment.label ?? attachment.fileName.replace(/\.[^.]+$/, "")}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {onRegenerateAttachment ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRegenerateAttachment(attachment.id);
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground/60 transition hover:bg-muted hover:text-foreground"
                          title="重新生成"
                        >
                          <RefreshCw className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            }

            const view = getAttachmentViewModel(attachment, selectedVersionIndices[attachment.id]);

            const globalIndex = globalImages.findIndex((a) => a.id === attachment.id);
            const signedUrlExpired = isSignedUrlExpired(view.previewUrl);
            const localFileMissing = isAttachmentLocallyMissing(view);
            const canPreviewImage = !!view.previewUrl && !signedUrlExpired && !localFileMissing && globalIndex >= 0;
            const canAddImageToAssets = !signedUrlExpired && !localFileMissing && !!view.previewUrl;

            return (
              <div
                key={attachment.id}
                className={cn(
                  "group relative shrink-0 overflow-hidden rounded-2xl border border-border/50 bg-muted/10 shadow-sm",
                  canAddImageToAssets && "cursor-grab active:cursor-grabbing",
                  getMediaCardWidthClass(compact),
                )}
                draggable={canAddImageToAssets}
                onDragStart={(e) => {
                  if (!canAddImageToAssets) return;
                  e.dataTransfer.setData(
                    "application/x-infinio-image",
                    JSON.stringify({
                      url: view.previewUrl,
                      localPath: view.localPath,
                      fileName: view.fileName,
                      kind: "image" as const,
                      target: attachment.generationContext,
                    }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                }}
              >
                <div
                  role={canPreviewImage ? "button" : undefined}
                  tabIndex={canPreviewImage ? 0 : undefined}
                  onClick={() => canPreviewImage && setLightboxGlobalIndex(globalIndex)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && canPreviewImage) setLightboxGlobalIndex(globalIndex);
                  }}
                  className={cn(
                    "relative aspect-[var(--media-aspect-ratio)] overflow-hidden bg-muted/20",
                    canPreviewImage ? "cursor-pointer" : "cursor-default",
                  )}
                  style={getMediaAspectStyle(attachment)}
                  aria-label={`查看大图：${attachment.fileName}`}
                >
                  {canPreviewImage ? (
                    <img
                      src={view.previewUrl}
                      alt={view.fileName}
                      className="h-full w-full object-contain transition duration-200 hover:brightness-105"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <AttachmentUnavailableState
                        kind="image"
                        message={getImageLoadErrorMessage(view.previewUrl, localFileMissing)}
                        activeTheme={activeTheme}
                      />
                    </div>
                  )}
                  {view.versionCount > 1 ? (
                    <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectVersion(attachment.id, view.activeVersionIndex - 1);
                        }}
                        disabled={view.activeVersionIndex <= 0}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="查看上一个版本"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectVersion(attachment.id, view.activeVersionIndex + 1);
                        }}
                        disabled={view.activeVersionIndex >= view.versionCount - 1}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="查看下一个版本"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  ) : null}
                  {view.activeVersionLabel ? (
                    <div className="pointer-events-none absolute bottom-11 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/80">
                      {view.activeVersionLabel}
                    </div>
                  ) : null}
                </div>
                <div className={cn("flex items-center gap-1.5", getMediaCardFooterClass(compact))}>
                  <div className="min-w-0 flex-1 truncate text-[11px] text-foreground/60">
                    {view.label ?? view.fileName.replace(/\.[^.]+$/, "")}
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {onRegenerateAttachment ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRegenerateAttachment(attachment.id);
                        }}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground/60 transition hover:bg-muted hover:text-foreground"
                        title="重新生成"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!canAddImageToAssets) return;
                        void downloadAttachment(view.previewUrl!, view.fileName);
                      }}
                      disabled={!canAddImageToAssets}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground/60 transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      title="下载图片"
                    >
                      <Download className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!canAddImageToAssets) return;
                        dispatchAddToAssets({
                          url: view.previewUrl!,
                          localPath: view.localPath,
                          fileName: view.fileName,
                          kind: "image",
                          target: attachment.generationContext,
                        });
                      }}
                      disabled={!canAddImageToAssets}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted/80 text-foreground/60 transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      title="传入素材库"
                    >
                      <FolderInput className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-8 flex items-center justify-center transition-opacity",
                    canAddImageToAssets ? "opacity-0 group-hover:opacity-100" : "opacity-0",
                  )}
                >
                  <span className="rounded-full bg-black/50 px-2 py-0.5 text-[9px] text-white/70 backdrop-blur-sm">
                    拖拽到素材库
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {videoAttachments.length > 0 && (
        <div className={cn("mt-2 flex w-full max-w-full min-w-0 flex-wrap overflow-x-hidden scrollbar-none", compact ? "gap-2" : "gap-3")}>
          {videoAttachments.map((attachment) => {
            if (attachment.cancelled) return null;
            const selectedVersionIndex = selectedVersionIndices[attachment.id];
            const lightboxAttachment = getAttachmentViewModel(attachment, selectedVersionIndex);
            return (
              <VideoAttachmentCard
                key={attachment.id}
                attachment={attachment}
                compact={compact}
                activeTheme={activeTheme}
                onOpenLightbox={() => setVideoLightboxAttachment(lightboxAttachment)}
                onRegenerateAttachment={onRegenerateAttachment}
                selectedVersionIndex={selectedVersionIndex}
                onSelectVersion={handleSelectVersion}
              />
            );
          })}
        </div>
      )}

      {nonMediaAttachments.length > 0 && (
        <div className={cn("mt-2 flex flex-wrap gap-2")}>
          {nonMediaAttachments.map((attachment) => {
            return (
              <div
                key={attachment.id}
                className={cn(
                  "inline-flex min-w-[120px] max-w-[220px] items-center gap-2 rounded-2xl border px-2.5 py-2",
                  activeTheme
                    ? "border-white/[0.1] bg-white/[0.06] text-white/72"
                    : "border-border bg-muted/30 text-foreground/80",
                  compact && "max-w-[180px] rounded-xl px-2 py-1.5",
                )}
              >
                <div
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                    activeTheme ? "bg-white/[0.08]" : "bg-muted/50",
                    compact && "h-8 w-8 rounded-lg",
                  )}
                >
                  <AttachmentKindIcon
                    kind={attachment.kind}
                    className={cn("h-4 w-4", activeTheme ? "text-white/55" : "text-muted-foreground")}
                  />
                </div>
                <div className="min-w-0">
                  <div className={cn("truncate text-[11.5px] font-medium", compact && "text-[10.5px]")}>
                    {attachment.fileName}
                  </div>
                  <div className={cn("truncate text-[10px] opacity-70", compact && "text-[9.5px]")}>
                    {attachment.kind} · {(attachment.size / 1024).toFixed(0)}KB
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {lightboxGlobalIndex !== null && globalImages.length > 0 && (
        <ChatImageLightbox
          allImages={globalImages}
          initialGlobalIndex={lightboxGlobalIndex}
          onClose={() => setLightboxGlobalIndex(null)}
        />
      )}

      {videoLightboxAttachment && (
        <ChatVideoLightbox
          attachment={videoLightboxAttachment}
          onClose={() => setVideoLightboxAttachment(null)}
        />
      )}
    </>
  );
}
