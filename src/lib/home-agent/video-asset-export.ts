import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ProductionAssetManifest, ProductionAssetRecord, Scene } from "@/types/project";
import { buildSegmentVideoLabel } from "./asset-naming";

export type VideoAssetExportSkipReason =
  | "empty-url"
  | "data-url"
  | "blob-url"
  | "remote-url"
  | "missing-file"
  | "copy-failed";

export interface VideoAssetExportSkipEntry {
  assetId: string;
  label: string;
  reason: VideoAssetExportSkipReason;
  sourcePath?: string;
}

export interface VideoAssetBundleExportResult {
  status: "success" | "cancelled" | "no-assets";
  directoryPath: string | null;
  exportedImageCount: number;
  exportedVideoCount: number;
  totalAssetCount: number;
  skipped: VideoAssetExportSkipEntry[];
}

function safeSegment(value: string | null | undefined, fallback: string): string {
  const normalized = String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function sanitizeWindowsFolderName(value: string): string {
  const replacementMap: Record<string, string> = {
    "<": "＜",
    ">": "＞",
    ":": "：",
    "\"": "”",
    "/": "／",
    "\\": "＼",
    "|": "｜",
    "?": "？",
    "*": "＊",
  };

  return value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*]/g, (char) => replacementMap[char] || "_")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
}

function buildProjectDirectoryName(project: PersistedVideoProject): string {
  const rawTitle = String(project.title || project.id || "").trim();
  const withoutLeadingDecorations = rawTitle.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const sanitized = sanitizeWindowsFolderName(withoutLeadingDecorations || rawTitle);
  return sanitized || "project";
}

function joinPath(base: string, ...segments: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/g, "");
  const trimmedSegments = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [trimmedBase, ...trimmedSegments].join("/");
}

function normalizeFileSchemePath(fileUrl: string): string {
  const withoutScheme = fileUrl.replace(/^file:\/+/i, "");
  const decoded = decodeURIComponent(withoutScheme);
  return decoded.replace(/^\/([A-Za-z]:[\\/])/, "$1");
}

function resolveLocalSourcePath(
  url: string | null | undefined,
): { kind: "local"; path: string } | { kind: "skip"; reason: VideoAssetExportSkipReason } {
  const normalized = String(url || "").trim();
  if (!normalized) return { kind: "skip", reason: "empty-url" };
  if (normalized.startsWith("data:")) return { kind: "skip", reason: "data-url" };
  if (normalized.startsWith("blob:")) return { kind: "skip", reason: "blob-url" };
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return { kind: "skip", reason: "remote-url" };
  }
  if (normalized.startsWith("file://")) {
    return { kind: "local", path: normalizeFileSchemePath(normalized) };
  }
  return { kind: "local", path: normalized };
}

function extractFileExtension(sourcePath: string, fallback: string): string {
  const cleanPath = sourcePath.split(/[?#]/)[0] || "";
  const match = cleanPath.match(/(\.[A-Za-z0-9]{1,10})$/);
  return match?.[1]?.toLowerCase() || fallback;
}

function appendSuffixToPath(filePath: string, suffix: number): string {
  if (suffix <= 1) return filePath;
  const extensionMatch = filePath.match(/(\.[A-Za-z0-9]{1,10})$/);
  const extension = extensionMatch?.[1] || "";
  const basePath = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${basePath}_${suffix}${extension}`;
}

function reserveUniquePath(filePath: string, seenPaths: Map<string, number>): string {
  const key = filePath.toLowerCase();
  const count = (seenPaths.get(key) || 0) + 1;
  seenPaths.set(key, count);
  return appendSuffixToPath(filePath, count);
}

function padEpisodeNumber(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

function resolveScene(project: PersistedVideoProject, item: ProductionAssetRecord): Scene | undefined {
  if (!item.sceneId) return undefined;
  return project.scenes.find((scene) => scene.id === item.sceneId);
}

function buildEpisodeFolder(scene: Scene | undefined): string {
  const segmentLabel = scene?.segmentLabel?.trim() || "";
  const match = segmentLabel.match(/^(\d+)-(\d+)(?:-.+)?$/);
  if (!match?.[1]) return "未分集";
  return `第${padEpisodeNumber(Number(match[1]))}集`;
}

function buildSegmentFolder(scene: Scene | undefined): string {
  const segmentLabel = scene?.segmentLabel?.trim() || "";
  return segmentLabel ? `片段${safeSegment(segmentLabel, "未分段")}` : "未分段";
}

function parseEpisodeNumber(segmentLabel: string | undefined): number | null {
  const match = String(segmentLabel || "").trim().match(/^(\d+)-/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSegmentVideoFolder(segmentLabel: string | undefined): string {
  const episodeNumber = parseEpisodeNumber(segmentLabel);
  return episodeNumber ? `第${episodeNumber}集_片段` : "未分集_片段";
}

function resolveSegmentVideoLabel(item: ProductionAssetRecord): string | undefined {
  if (item.source === "segment-video" && item.sourceEntityId) return item.sourceEntityId;
  const match = item.id.match(/^segment:(.+):video$/);
  return match?.[1];
}

function isSegmentVideoAsset(item: ProductionAssetRecord): boolean {
  return item.kind === "video-segment" && Boolean(resolveSegmentVideoLabel(item));
}

function isCharacterImageAsset(item: ProductionAssetRecord): boolean {
  return item.kind === "character-reference" || item.kind === "costume-reference";
}

function isSceneImageAsset(item: ProductionAssetRecord): boolean {
  return item.kind === "scene-reference" || item.kind === "time-variant";
}

function buildImageTargetPath(
  projectDir: string,
  item: ProductionAssetRecord,
  scene: Scene | undefined,
  extension: string,
): string {
  const safeAssetLabel = safeSegment(item.label, `图片_${item.id}`);
  if (isCharacterImageAsset(item)) {
    return joinPath(projectDir, "图片", "角色", `${safeAssetLabel}${extension}`);
  }
  if (isSceneImageAsset(item)) {
    return joinPath(projectDir, "图片", "场景", `${safeAssetLabel}${extension}`);
  }
  if (item.kind === "storyboard-frame") {
    return joinPath(projectDir, "图片", buildEpisodeFolder(scene), `${safeAssetLabel}${extension}`);
  }
  return joinPath(projectDir, "图片", "其他", `${safeAssetLabel}${extension}`);
}

function buildTargetPath(
  rootDir: string,
  project: PersistedVideoProject,
  item: ProductionAssetRecord,
  sourcePath: string,
  seenPaths: Map<string, number>,
): string {
  const projectDir = joinPath(rootDir, buildProjectDirectoryName(project));
  const scene = resolveScene(project, item);
  const extension = extractFileExtension(sourcePath, item.kind === "video-segment" ? ".mp4" : ".jpg");

  if (item.kind !== "video-segment") {
    return reserveUniquePath(
      buildImageTargetPath(projectDir, item, scene, extension),
      seenPaths,
    );
  }

  const safeAssetLabel = safeSegment(item.label, `视频_${item.sceneNumber ?? item.id}`);
  if (isSegmentVideoAsset(item)) {
    const segmentLabel = resolveSegmentVideoLabel(item);
    const episodeNumber = parseEpisodeNumber(segmentLabel);
    return reserveUniquePath(
      joinPath(
        projectDir,
        "视频",
        episodeNumber ? `第${padEpisodeNumber(episodeNumber)}集` : "未分集",
        buildSegmentVideoFolder(segmentLabel),
        `${safeAssetLabel}${extension}`,
      ),
      seenPaths,
    );
  }

  return reserveUniquePath(
    joinPath(
      projectDir,
      "视频",
      buildEpisodeFolder(scene),
      buildSegmentFolder(scene),
      `${safeAssetLabel}${extension}`,
    ),
    seenPaths,
  );
}

function buildSegmentVideoExportItems(project: PersistedVideoProject): ProductionAssetRecord[] {
  const createdAt = project.updatedAt || new Date().toISOString();
  return Object.entries(project.segmentVideos ?? {})
    .filter(([, url]) => Boolean(url?.trim()))
    .map(([segmentLabel, url]) => ({
      id: `segment:${segmentLabel}:video`,
      kind: "video-segment" as const,
      label: buildSegmentVideoLabel(segmentLabel),
      url,
      meta: "片段视频",
      reusable: false,
      status: "ready" as const,
      source: "segment-video",
      sourceEntityId: segmentLabel,
      version: 1,
      createdAt,
    }));
}

function collectExportItems(
  project: PersistedVideoProject,
  manifest: ProductionAssetManifest | null | undefined,
): ProductionAssetRecord[] {
  const byId = new Map<string, ProductionAssetRecord>();
  for (const item of manifest?.items ?? []) {
    byId.set(item.id, item);
  }
  for (const item of buildSegmentVideoExportItems(project)) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function summarizeSkipReasons(skipped: VideoAssetExportSkipEntry[]): string {
  if (!skipped.length) return "无";
  const labels: Record<VideoAssetExportSkipReason, string> = {
    "empty-url": "空路径",
    "data-url": "内嵌数据 URL",
    "blob-url": "临时 Blob URL",
    "remote-url": "远程 URL",
    "missing-file": "本地文件不存在",
    "copy-failed": "复制失败",
  };
  const counts = new Map<string, number>();
  skipped.forEach((entry) => {
    const label = labels[entry.reason];
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([label, count]) => `${label} ${count} 项`)
    .join("，");
}

export function buildVideoAssetBundleExportSummary(
  projectTitle: string,
  result: VideoAssetBundleExportResult,
): string {
  if (result.status === "cancelled") {
    return "已取消导出。";
  }

  if (result.status === "no-assets") {
    return "当前素材库为空，暂无可导出的图片或视频。";
  }

  return [
    `已导出《${projectTitle}》的素材库归档。`,
    `目录：${result.directoryPath || ""}`,
    `图片：${result.exportedImageCount} 项`,
    `视频：${result.exportedVideoCount} 项`,
    `跳过：${result.skipped.length} 项`,
    result.skipped.length ? `跳过原因：${summarizeSkipReasons(result.skipped)}` : "跳过原因：无",
  ].join("\n");
}

export function isVideoAssetBundleExportCancelledSummary(summary: string): boolean {
  return summary.trim() === buildVideoAssetBundleExportSummary("", {
    status: "cancelled",
    directoryPath: null,
    exportedImageCount: 0,
    exportedVideoCount: 0,
    totalAssetCount: 0,
    skipped: [],
  });
}

export async function exportVideoAssetBundle(
  project: PersistedVideoProject,
  manifest: ProductionAssetManifest | null | undefined,
  preferredDirectory?: string | null,
): Promise<VideoAssetBundleExportResult> {
  const storage = window.electronAPI?.storage;
  if (!storage?.selectFolder) {
    throw new Error("当前环境不支持选择本地导出目录。");
  }
  if (!storage.copyFile) {
    throw new Error("当前环境不支持导出图片和视频文件。");
  }

  const items = collectExportItems(project, manifest);
  if (!items.length) {
    return {
      status: "no-assets",
      directoryPath: null,
      exportedImageCount: 0,
      exportedVideoCount: 0,
      totalAssetCount: 0,
      skipped: [],
    };
  }

  const destRoot = preferredDirectory?.trim() ? preferredDirectory.trim() : await storage.selectFolder();
  if (!destRoot) {
    return {
      status: "cancelled",
      directoryPath: null,
      exportedImageCount: 0,
      exportedVideoCount: 0,
      totalAssetCount: items.length,
      skipped: [],
    };
  }

  let exportedImageCount = 0;
  let exportedVideoCount = 0;
  const skipped: VideoAssetExportSkipEntry[] = [];
  const targetDirectory = joinPath(destRoot, buildProjectDirectoryName(project));
  const seenPaths = new Map<string, number>();

  for (const item of items) {
    const source = resolveLocalSourcePath(item.url);
    if (source.kind === "skip") {
      skipped.push({ assetId: item.id, label: item.label, reason: source.reason });
      continue;
    }

    if (storage.readBase64) {
      const existsResult = await storage.readBase64(source.path);
      if (!existsResult.ok || !existsResult.exists) {
        skipped.push({
          assetId: item.id,
          label: item.label,
          reason: "missing-file",
          sourcePath: source.path,
        });
        continue;
      }
    }

    const targetPath = buildTargetPath(destRoot, project, item, source.path, seenPaths);
    const copyResult = await storage.copyFile(source.path, targetPath);
    if (!copyResult.ok) {
      skipped.push({
        assetId: item.id,
        label: item.label,
        reason: "copy-failed",
        sourcePath: source.path,
      });
      continue;
    }

    if (item.kind === "video-segment") {
      exportedVideoCount += 1;
    } else {
      exportedImageCount += 1;
    }
  }

  return {
    status: "success",
    directoryPath: targetDirectory,
    exportedImageCount,
    exportedVideoCount,
    totalAssetCount: items.length,
    skipped,
  };
}
