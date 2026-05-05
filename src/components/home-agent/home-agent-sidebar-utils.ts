import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import {
  buildCharacterAssetLabel,
  buildSceneAssetLabel,
  buildSegmentVideoLabel,
  buildStoryboardAssetLabel,
  buildVideoAssetLabel,
} from "@/lib/home-agent/asset-naming";
import { isExpiredRemoteSignedMediaUrl } from "@/lib/home-agent/media-url";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import type { ProductionAssetKind, ProductionAssetRecord } from "@/types/project";
import { readCachedThumbnailDataUrl } from "@/lib/upload-base64-to-storage";

type SidebarAssetBase = {
  id: string;
  label: string;
  meta: string;
  origin?: "derived" | "manual";
  subKind?: "segment";
};

export type SidebarAssetItem =
  | (SidebarAssetBase & {
      kind: "image" | "video";
      url: string;
    })
  | (SidebarAssetBase & {
      kind: "bundle";
      path: string;
    });

const IMAGE_TAB_PREFIXES = [
  "\u89d2\u8272",
  "\u573a\u666f",
  "\u5206\u955c",
  "\u5176\u4ed6",
] as const;
const VIDEO_TAB_PREFIX = "\u89c6\u9891";
const MANIFEST_LABEL_SEPARATOR = " \u00b7 ";
export const SEGMENT_VIDEO_LABEL_PREFIX = "\u7247\u6bb5 \u00b7 ";

export function isLocalSidebarAssetUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  return url.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(url) || /^\\\\/.test(url);
}

export function getSidebarVideoSrc(url: string): string {
  if (!isLocalSidebarAssetUrl(url)) return url;
  if (url.startsWith("file://")) return url;
  return `file:///${url.replace(/\\/g, "/")}`;
}

export function normalizeSidebarAssetPath(url: string): string {
  if (!isLocalSidebarAssetUrl(url)) return url;
  if (!url.startsWith("file://")) return url;

  let normalized = decodeURIComponent(url.replace(/^file:\/\/+/, ""));
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\//g, "\\");
}

let cachedFilesRoot: string | null | undefined = undefined;

export async function remapToCurrentFilesRoot(localPath: string): Promise<string> {
  const projMatch = localPath.match(/[/\\]projects[/\\]/);
  if (!projMatch) return localPath;

  if (cachedFilesRoot === undefined) {
    cachedFilesRoot = await getResolvedFilesStoragePath();
  }
  if (!cachedFilesRoot) return localPath;

  const projIdx = localPath.search(/[/\\]projects[/\\]/);
  const relPart = localPath.substring(projIdx).replace(/\\/g, "/");
  const newPath = cachedFilesRoot.replace(/[\\/]+$/, "") + relPart;
  return newPath.replace(/\//g, "\\");
}

export async function resolveSidebarAssetPreviewUrl(
  asset: Pick<SidebarAssetItem, "kind"> & { url?: string },
  projectId?: string,
): Promise<string | null> {
  if (asset.kind !== "image") return null;
  if (!asset.url) return null;
  if (!isLocalSidebarAssetUrl(asset.url)) return asset.url;
  if (!window.electronAPI?.storage?.readBase64) return null;

  const rawPath = normalizeSidebarAssetPath(asset.url);
  const normalizedPath = await remapToCurrentFilesRoot(rawPath);
  const cachedThumbnail = await readCachedThumbnailDataUrl(normalizedPath, projectId);
  if (cachedThumbnail) return cachedThumbnail;

  const result = await window.electronAPI.storage.readBase64(normalizedPath);
  if (!result?.ok || !result?.base64) return null;
  return `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
}

function getManifestAssetPrefix(kind: ProductionAssetKind): string {
  switch (kind) {
    case "scene-reference":
    case "time-variant":
      return IMAGE_TAB_PREFIXES[1];
    case "storyboard-frame":
      return IMAGE_TAB_PREFIXES[2];
    case "video-segment":
      return "";
    case "character-reference":
    case "costume-reference":
    default:
      return IMAGE_TAB_PREFIXES[0];
  }
}

function normalizeManifestAssetLabel(item: ProductionAssetRecord): string {
  const label = item.label.trim();
  if (item.kind === "video-segment") {
    return label || "\u672a\u547d\u540d";
  }
  const knownPrefixes = [...IMAGE_TAB_PREFIXES, VIDEO_TAB_PREFIX];
  if (knownPrefixes.some((prefix) => label.startsWith(prefix))) {
    return label;
  }
  if (item.origin === "manual") {
    return label;
  }
  const prefix = getManifestAssetPrefix(item.kind);
  if (!label) {
    return prefix ? `${prefix}${MANIFEST_LABEL_SEPARATOR}\u672a\u547d\u540d` : "\u672a\u547d\u540d";
  }
  return prefix ? `${prefix}${MANIFEST_LABEL_SEPARATOR}${label}` : label;
}

function formatBundleMeta(videoProject: PersistedVideoProject): string {
  const bundle = videoProject.productionStateBundle;
  if (!bundle) return "\u53ef\u7eed\u63a5\u72b6\u6001\u5305";

  const segments = [`${bundle.exportedCount} \u4e2a\u6587\u4ef6`];
  if (bundle.overviewPath) {
    segments.push("\u542b\u7d22\u5f15\u6458\u8981");
  }
  segments.push("\u53ef\u7eed\u63a5\u72b6\u6001\u5305");
  return segments.join(MANIFEST_LABEL_SEPARATOR);
}

export function collectConversationAssets(
  videoProject: PersistedVideoProject | null | undefined,
  projectSnapshot?: ConversationProjectSnapshot | null,
): SidebarAssetItem[] {
  const items: SidebarAssetItem[] = [];
  const seen = new Set<string>();
  const manifest = projectSnapshot?.memory?.assetManifest;

  if (videoProject?.productionStateBundle?.directoryPath) {
    items.push({
      id: `bundle-${videoProject.id}`,
      kind: "bundle",
      label: "\u751f\u4ea7\u72b6\u6001\u5305",
      path: videoProject.productionStateBundle.directoryPath,
      meta: formatBundleMeta(videoProject),
    });
  }

  if (manifest?.items.length) {
    manifest.items.forEach((item) => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      items.push({
        id: item.id,
        kind: item.kind === "video-segment" ? "video" : "image",
        label: normalizeManifestAssetLabel(item),
        url: item.url,
        origin: item.origin,
        meta: [
          item.meta,
          item.reusable ? "\u53ef\u590d\u7528" : "\u5f53\u524d\u955c\u5934",
          item.status === "failed" ? "\u5f85\u4fee\u590d" : "",
        ]
          .filter(Boolean)
          .join(MANIFEST_LABEL_SEPARATOR),
      });
    });
    pushSegmentVideos(videoProject, items, seen);
    return items;
  }

  if (!videoProject) return items;

  const pushAsset = (kind: "image" | "video", label: string, url?: string, meta = "") => {
    if (!url || isExpiredRemoteSignedMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    items.push({
      id: `${kind}-${items.length}-${label}`,
      kind,
      label,
      url,
      origin: "derived",
      meta,
    });
  };

  videoProject.characters.forEach((character) => {
    pushAsset("image", buildCharacterAssetLabel(character.name), character.imageUrl, "\u89d2\u8272");
    Object.entries(character.threeViewUrls ?? {}).forEach(([view, url]) =>
      pushAsset("image", buildCharacterAssetLabel(character.name, { view }), url, "\u4e09\u89c6\u56fe"),
    );
    character.costumes?.forEach((costume) => {
      const label = buildCharacterAssetLabel(character.name, { variantLabel: costume.label });
      pushAsset("image", label, costume.imageUrl, "\u89d2\u8272\u53d8\u4f53");
    });
  });

  videoProject.sceneSettings.forEach((scene) => {
    pushAsset("image", buildSceneAssetLabel(scene.name), scene.imageUrl, "\u573a\u666f");
    scene.timeVariants?.forEach((variant) => {
      const label = buildSceneAssetLabel(scene.name, { variantLabel: variant.label });
      pushAsset("image", label, variant.imageUrl, "\u573a\u666f\u53d8\u4f53");
    });
  });

  videoProject.scenes.forEach((scene) => {
    pushAsset("image", buildStoryboardAssetLabel(scene), scene.storyboardUrl, "\u5206\u955c");
    pushAsset("video", buildVideoAssetLabel(scene), scene.videoUrl, "\u89c6\u9891");
  });

  pushSegmentVideos(videoProject, items, seen);
  return items;
}

function pushSegmentVideos(
  videoProject: PersistedVideoProject | null | undefined,
  items: SidebarAssetItem[],
  seen: Set<string>,
): void {
  if (!videoProject?.segmentVideos) return;
  Object.entries(videoProject.segmentVideos).forEach(([segmentLabel, url]) => {
    if (!url || isExpiredRemoteSignedMediaUrl(url) || seen.has(url)) return;
    seen.add(url);
    items.push({
      id: `video-segment-${segmentLabel}`,
      kind: "video",
      label: buildSegmentVideoLabel(segmentLabel),
      url,
      origin: "derived",
      subKind: "segment",
      meta: "\u7247\u6bb5",
    });
  });
}
