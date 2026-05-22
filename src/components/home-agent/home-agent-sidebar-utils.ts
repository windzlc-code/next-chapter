import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import {
  buildCharacterAssetLabel,
  buildSceneAssetLabel,
  buildSegmentVideoLabel,
  buildStoryboardAssetLabel,
  buildVideoAssetLabel,
} from "@/lib/home-agent/asset-naming";
import { isExpiredRemoteSignedMediaUrl, isKnownPlaceholderMediaUrl } from "@/lib/home-agent/media-url";
import {
  formatSegmentContinuityRecapDisplayText,
  resolveSegmentContinuityRecapText,
} from "@/lib/home-agent/segment-continuity-recap";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import type { ProductionAssetKind, ProductionAssetRecord, ProductionAssetStatus } from "@/types/project";
import { readCachedThumbnailDataUrl } from "@/lib/upload-base64-to-storage";

type SidebarAssetBase = {
  id: string;
  label: string;
  meta: string;
  recapText?: string;
  origin?: "derived" | "manual";
  status?: ProductionAssetStatus;
  subKind?: "segment" | "continuity-grid" | "history-video";
  segmentLabel?: string;
  continuityGridReady?: boolean;
  historyEntryId?: string;
  failureReason?: string;
  archivedAt?: string;
  promotedAt?: string;
  previewVersion?: string;
  characterAudioTargetId?: string;
  characterAudioTargetName?: string;
  characterAudioUrl?: string;
  characterAudioFileName?: string;
  characterAudioReferenceReady?: boolean;
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
const SEGMENT_ORDER_PATTERN = /^(\d+)-(\d+)$/;
const SEGMENT_ORDER_IN_LABEL_PATTERN = /\u7247\u6bb5\s*(\d+)-(\d+)/;
const EPISODE_ORDER_IN_LABEL_PATTERN = /\u7b2c\s*(\d+)\s*\u96c6/;
const SHOT_ORDER_IN_LABEL_PATTERN = /\u955c\u5934\s*(\d+)/;
const TRAILING_SEQUENCE_PATTERN = /(?:[\u00b7\u8def-]\s*|\s)(\d{2,})$/;

export function isLocalSidebarAssetUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  return url.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(url) || /^\\\\/.test(url);
}

export function getSidebarMediaSrc(url: string): string {
  if (!isLocalSidebarAssetUrl(url)) return url;
  if (url.startsWith("file://")) return url;
  return `file:///${url.replace(/\\/g, "/")}`;
}

export function getSidebarVideoSrc(url: string): string {
  return getSidebarMediaSrc(url);
}

export function getSidebarAudioSrc(url: string): string {
  return getSidebarMediaSrc(url);
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

async function buildSidebarAssetCandidatePaths(url: string): Promise<string[]> {
  const rawPath = normalizeSidebarAssetPath(url);
  const remappedPath = await remapToCurrentFilesRoot(rawPath);
  return Array.from(
    new Set(
      [rawPath, normalizeSidebarAssetPath(remappedPath)]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export async function resolveSidebarAssetPreviewUrl(
  asset: Pick<SidebarAssetItem, "kind"> & { url?: string; previewVersion?: string },
  projectId?: string,
): Promise<string | null> {
  if (asset.kind !== "image") return null;
  if (!asset.url) return null;
  if (!isLocalSidebarAssetUrl(asset.url)) return asset.url;
  if (!window.electronAPI?.storage?.readBase64) return null;

  const candidates = await buildSidebarAssetCandidatePaths(asset.url);
  for (const candidate of candidates) {
    const thumbnailCacheKey = asset.previewVersion
      ? `${candidate}::${asset.previewVersion}`
      : candidate;
    const cachedThumbnail = await readCachedThumbnailDataUrl(thumbnailCacheKey, projectId);
    if (cachedThumbnail) return cachedThumbnail;

    try {
      const result = await window.electronAPI.storage.readBase64(candidate);
      if (!result?.ok || !result?.base64) continue;
      return `data:${result.mimeType || "image/jpeg"};base64,${result.base64}`;
    } catch {
      continue;
    }
  }

  return null;
}

function parseSegmentOrderParts(value: string | undefined): { episode: number; segment: number } | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const match = normalized.match(SEGMENT_ORDER_PATTERN);
  if (!match) return null;
  return {
    episode: Number.parseInt(match[1] || "0", 10),
    segment: Number.parseInt(match[2] || "0", 10),
  };
}

function parseSegmentOrderFromAsset(asset: SidebarAssetItem): { episode: number; segment: number } | null {
  const fromSegmentLabel = parseSegmentOrderParts(asset.segmentLabel);
  if (fromSegmentLabel) return fromSegmentLabel;
  const match = asset.label.match(SEGMENT_ORDER_IN_LABEL_PATTERN);
  if (!match) return null;
  return {
    episode: Number.parseInt(match[1] || "0", 10),
    segment: Number.parseInt(match[2] || "0", 10),
  };
}

function parseEpisodeOrderFromAsset(asset: SidebarAssetItem): number | null {
  const fromSegment = parseSegmentOrderFromAsset(asset);
  if (fromSegment) return fromSegment.episode;
  const match = asset.label.match(EPISODE_ORDER_IN_LABEL_PATTERN);
  if (!match) return null;
  return Number.parseInt(match[1] || "0", 10);
}

function parseShotOrderFromAsset(asset: SidebarAssetItem): number | null {
  const match = asset.label.match(SHOT_ORDER_IN_LABEL_PATTERN);
  if (!match) return null;
  return Number.parseInt(match[1] || "0", 10);
}

function parseTrailingSequenceFromAsset(asset: SidebarAssetItem): number | null {
  const match = asset.label.match(TRAILING_SEQUENCE_PATTERN);
  if (!match) return null;
  return Number.parseInt(match[1] || "0", 10);
}

function getSidebarAssetSubKindRank(asset: SidebarAssetItem): number {
  switch (asset.subKind) {
    case "segment":
      return 0;
    case "history-video":
      return 1;
    case "continuity-grid":
      return 2;
    default:
      return 3;
  }
}

export function compareSidebarAssetDisplayOrder(
  left: SidebarAssetItem,
  right: SidebarAssetItem,
): number {
  const leftSegment = parseSegmentOrderFromAsset(left);
  const rightSegment = parseSegmentOrderFromAsset(right);
  if (leftSegment && rightSegment) {
    if (leftSegment.episode !== rightSegment.episode) {
      return leftSegment.episode - rightSegment.episode;
    }
    if (leftSegment.segment !== rightSegment.segment) {
      return leftSegment.segment - rightSegment.segment;
    }
  } else {
    const leftEpisode = parseEpisodeOrderFromAsset(left);
    const rightEpisode = parseEpisodeOrderFromAsset(right);
    if (leftEpisode !== null && rightEpisode !== null && leftEpisode !== rightEpisode) {
      return leftEpisode - rightEpisode;
    }
  }

  const leftShot = parseShotOrderFromAsset(left);
  const rightShot = parseShotOrderFromAsset(right);
  if (leftShot !== null && rightShot !== null && leftShot !== rightShot) {
    return leftShot - rightShot;
  }

  const subKindRankDiff = getSidebarAssetSubKindRank(left) - getSidebarAssetSubKindRank(right);
  if (subKindRankDiff !== 0) return subKindRankDiff;

  const leftSequence = parseTrailingSequenceFromAsset(left);
  const rightSequence = parseTrailingSequenceFromAsset(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  if (leftSequence === null && rightSequence !== null) return 1;
  if (leftSequence !== null && rightSequence === null) return -1;

  const leftArchivedAt = left.archivedAt ? new Date(left.archivedAt).getTime() : 0;
  const rightArchivedAt = right.archivedAt ? new Date(right.archivedAt).getTime() : 0;
  if (leftArchivedAt !== rightArchivedAt) {
    return rightArchivedAt - leftArchivedAt;
  }

  const labelDiff = left.label.localeCompare(right.label, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
  if (labelDiff !== 0) return labelDiff;

  return left.id.localeCompare(right.id, "en", { numeric: true, sensitivity: "base" });
}

function getManifestAssetPrefix(kind: ProductionAssetKind): string {
  switch (kind) {
    case "scene-reference":
    case "time-variant":
      return IMAGE_TAB_PREFIXES[1];
    case "storyboard-frame":
      return IMAGE_TAB_PREFIXES[2];
    case "segment-continuity-grid":
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
  if (item.kind === "video-segment" || item.kind === "segment-continuity-grid") {
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

function parseSegmentLabelFromManifestVideo(item: ProductionAssetRecord): string | undefined {
  if (item.kind !== "video-segment") return undefined;
  const explicit = String(item.sourceEntityId || "").trim();
  if (explicit) return explicit;
  const idMatch = String(item.id || "").trim().match(/^segment:([^:]+):video$/i);
  return idMatch?.[1]?.trim() || undefined;
}

function parseSegmentLabelFromManifestContinuityGrid(
  item: ProductionAssetRecord,
): string | undefined {
  if (item.kind !== "segment-continuity-grid") return undefined;
  const explicit = String(item.sourceEntityId || "").trim();
  if (explicit) return explicit;
  const idMatch = String(item.id || "").trim().match(/^segment:([^:]+):continuity-grid$/i);
  return idMatch?.[1]?.trim() || undefined;
}

function isManifestSegmentVideoItem(item: ProductionAssetRecord): boolean {
  if (item.kind !== "video-segment") return false;
  if (item.source === "segment-video") return true;
  return Boolean(parseSegmentLabelFromManifestVideo(item));
}

function isManifestSegmentHistoryVideoItem(item: ProductionAssetRecord): boolean {
  if (item.kind !== "video-segment") return false;
  if (item.status !== "failed") return false;
  const segmentLabel = parseSegmentLabelFromManifestVideo(item);
  if (!segmentLabel) return false;
  const normalizedId = String(item.id || "").trim();
  return normalizedId !== `segment:${segmentLabel}:video` && item.source !== "segment-video";
}

function isManifestSegmentContinuityGridItem(item: ProductionAssetRecord): boolean {
  if (item.kind !== "segment-continuity-grid") return false;
  if (item.source === "segment-continuity-grid") return true;
  return Boolean(parseSegmentLabelFromManifestContinuityGrid(item));
}

function hasSegmentContinuityGridImage(
  videoProject: PersistedVideoProject | null | undefined,
  segmentLabel: string | undefined,
) : boolean {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  if (!videoProject || !normalizedSegmentLabel) return false;
  return Boolean(String(videoProject.segmentContinuityGridImages?.[normalizedSegmentLabel]?.imageUrl || "").trim());
}

function getSegmentContinuityGridRecapText(
  videoProject: PersistedVideoProject | null | undefined,
  segmentLabel: string | undefined,
): string | undefined {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  if (!videoProject || !normalizedSegmentLabel) return undefined;
  const recapText = String(
    videoProject.segmentContinuityGridImages?.[normalizedSegmentLabel]?.recapText || "",
  ).trim();
  const resolvedRecapText = resolveSegmentContinuityRecapText(videoProject, normalizedSegmentLabel, recapText);
  return formatSegmentContinuityRecapDisplayText(resolvedRecapText) || undefined;
}

function inferCharacterNameFromAssetLabel(label: string): string | undefined {
  const parts = label
    .split(MANIFEST_LABEL_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  if (parts[0] === IMAGE_TAB_PREFIXES[0]) {
    return parts[1];
  }
  return parts[0];
}

function buildCharacterAudioAssetMeta(
  videoProject: PersistedVideoProject | null | undefined,
  characterId: string | undefined,
  fallbackName?: string,
): Pick<
  SidebarAssetBase,
  | "characterAudioTargetId"
  | "characterAudioTargetName"
  | "characterAudioUrl"
  | "characterAudioFileName"
  | "characterAudioReferenceReady"
> {
  const normalizedCharacterId = String(characterId || "").trim();
  if (!normalizedCharacterId) return {};
  const matchedCharacter = videoProject?.characters.find(
    (character) => character.id === normalizedCharacterId,
  );
  const normalizedFallbackName = fallbackName?.trim();
  const audioUrl = matchedCharacter?.audioUrl?.trim() || undefined;
  const audioFileName = matchedCharacter?.audioFileName?.trim() || undefined;
  const hasAudioReference = Boolean(
    audioUrl || audioFileName,
  );
  return {
    characterAudioTargetId: normalizedCharacterId,
    ...(matchedCharacter?.name?.trim() || normalizedFallbackName
      ? {
          characterAudioTargetName:
            matchedCharacter?.name?.trim() || normalizedFallbackName,
        }
      : {}),
    ...(audioUrl ? { characterAudioUrl: audioUrl } : {}),
    ...(audioFileName ? { characterAudioFileName: audioFileName } : {}),
    ...(hasAudioReference ? { characterAudioReferenceReady: true } : {}),
  };
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
  const seenAssetKeys = new Set<string>();
  const seenSegmentVideoUrls = new Set<string>();
  const seenDerivedMediaUrls = new Set<string>();
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
      if (
        !item.url?.trim() ||
        isExpiredRemoteSignedMediaUrl(item.url) ||
        isKnownPlaceholderMediaUrl(item.url)
      ) return;
      const normalizedLabel = normalizeManifestAssetLabel(item);
      const assetKey = item.id?.trim()
        ? `manifest:${item.id.trim()}`
        : `manifest:${item.kind}:${normalizedLabel}:${item.url}`;
      if (seenAssetKeys.has(assetKey)) return;
      seenAssetKeys.add(assetKey);
      seenDerivedMediaUrls.add(item.url);
      if (item.kind === "video-segment") {
        seenSegmentVideoUrls.add(item.url);
      }
      const segmentLabel =
        parseSegmentLabelFromManifestVideo(item) ??
        parseSegmentLabelFromManifestContinuityGrid(item);
      const continuityGridReady = hasSegmentContinuityGridImage(videoProject, segmentLabel);
      const continuityGridRecapText = getSegmentContinuityGridRecapText(videoProject, segmentLabel);
      const characterAudioMeta =
        item.kind === "character-reference" ||
        item.kind === "costume-reference" ||
        item.kind === "character-sheet"
          ? buildCharacterAudioAssetMeta(
              videoProject,
              item.sourceEntityId,
              inferCharacterNameFromAssetLabel(normalizedLabel),
            )
          : {};
      const normalizedPreviewVersion =
        typeof item.updatedAt === "string" && item.updatedAt.trim()
          ? item.updatedAt.trim()
          : typeof item.version === "number" && Number.isFinite(item.version)
            ? `v${item.version}`
            : typeof item.createdAt === "string" && item.createdAt.trim()
              ? item.createdAt.trim()
              : undefined;
      items.push({
        id: item.id,
        kind: item.kind === "video-segment" ? "video" : "image",
        label: normalizedLabel,
        url: item.url,
        origin: item.origin,
        status: item.status,
        ...(isManifestSegmentHistoryVideoItem(item)
          ? { subKind: "history-video" as const }
          : isManifestSegmentVideoItem(item)
            ? { subKind: "segment" as const }
            : {}),
        ...(isManifestSegmentContinuityGridItem(item)
          ? { subKind: "continuity-grid" as const }
          : {}),
        ...(segmentLabel
          ? { segmentLabel }
          : {}),
        ...(continuityGridRecapText && isManifestSegmentContinuityGridItem(item)
          ? { recapText: continuityGridRecapText }
          : {}),
        ...(continuityGridReady
          ? { continuityGridReady: true }
          : {}),
        ...(normalizedPreviewVersion
          ? { previewVersion: normalizedPreviewVersion }
          : {}),
        ...characterAudioMeta,
        meta: [
          item.meta,
          item.reusable ? "\u53ef\u590d\u7528" : "\u5f53\u524d\u955c\u5934",
          item.status === "failed" ? "\u5f85\u4fee\u590d" : "",
        ]
          .filter(Boolean)
          .join(MANIFEST_LABEL_SEPARATOR),
      });
    });
  }

  if (!videoProject) {
    pushSegmentVideos(videoProject, items, seenAssetKeys, seenSegmentVideoUrls);
    return items;
  }

  const pushAsset = (
    kind: "image" | "video",
    label: string,
    url?: string,
    meta = "",
    extras?: Partial<SidebarAssetBase>,
  ) => {
    if (!url || isExpiredRemoteSignedMediaUrl(url) || isKnownPlaceholderMediaUrl(url)) return;
    if (kind === "video" && seenSegmentVideoUrls.has(url)) return;
    if (seenDerivedMediaUrls.has(url)) return;
    const assetKey = `derived:${kind}:${label}:${url}`;
    if (seenAssetKeys.has(assetKey)) return;
    seenAssetKeys.add(assetKey);
    seenDerivedMediaUrls.add(url);
    if (kind === "video") {
      seenSegmentVideoUrls.add(url);
    }
    items.push({
      id: `${kind}-${items.length}-${label}`,
      kind,
      label,
      url,
      origin: "derived",
      ...extras,
      meta,
    });
  };

  videoProject.characters.forEach((character) => {
    const characterAudioMeta = buildCharacterAudioAssetMeta(
      videoProject,
      character.id,
      character.name,
    );
    pushAsset(
      "image",
      buildCharacterAssetLabel(character.name),
      character.imageUrl,
      "\u89d2\u8272",
      characterAudioMeta,
    );
    Object.entries(character.threeViewUrls ?? {}).forEach(([view, url]) =>
      pushAsset(
        "image",
        buildCharacterAssetLabel(character.name, { view }),
        url,
        "\u4e09\u89c6\u56fe",
        characterAudioMeta,
      ),
    );
    character.costumes?.forEach((costume) => {
      const label = buildCharacterAssetLabel(character.name, { variantLabel: costume.label });
      pushAsset("image", label, costume.imageUrl, "\u89d2\u8272\u53d8\u4f53", characterAudioMeta);
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

  pushSegmentVideos(videoProject, items, seenAssetKeys, seenSegmentVideoUrls);
  pushArchivedSegmentVideoHistory(videoProject, items, seenAssetKeys);
  return items;
}

function pushSegmentVideos(
  videoProject: PersistedVideoProject | null | undefined,
  items: SidebarAssetItem[],
  seenAssetKeys: Set<string>,
  seenSegmentVideoUrls: Set<string>,
): void {
  if (!videoProject?.segmentVideos) return;
  Object.entries(videoProject.segmentVideos).forEach(([segmentLabel, url]) => {
    if (
      !url ||
      isExpiredRemoteSignedMediaUrl(url) ||
      isKnownPlaceholderMediaUrl(url) ||
      seenSegmentVideoUrls.has(url)
    ) return;
    const assetKey = `segment:${segmentLabel}:${url}`;
    if (seenAssetKeys.has(assetKey)) return;
    seenAssetKeys.add(assetKey);
    seenSegmentVideoUrls.add(url);
    const continuityGridReady = hasSegmentContinuityGridImage(videoProject, segmentLabel);
    items.push({
      id: `video-segment-${segmentLabel}`,
      kind: "video",
      label: buildSegmentVideoLabel(segmentLabel),
      url,
      origin: "derived",
      subKind: "segment",
      segmentLabel,
      ...(continuityGridReady
        ? { continuityGridReady: true }
        : {}),
      meta: "\u7247\u6bb5",
    });
  });
}

function pushArchivedSegmentVideoHistory(
  videoProject: PersistedVideoProject | null | undefined,
  items: SidebarAssetItem[],
  seenAssetKeys: Set<string>,
): void {
  if (!videoProject?.archivedSegmentVideos) return;
  Object.entries(videoProject.archivedSegmentVideos)
    .flatMap(([segmentLabel, entries]) =>
      (Array.isArray(entries) ? entries : []).map((entry) => ({
        segmentLabel,
        entry,
      })),
    )
    .sort(
      (left, right) =>
        new Date(right.entry.archivedAt || 0).getTime() - new Date(left.entry.archivedAt || 0).getTime(),
    )
    .forEach(({ segmentLabel, entry }) => {
      const url = String(entry.videoUrl || "").trim();
      if (!url || isExpiredRemoteSignedMediaUrl(url) || isKnownPlaceholderMediaUrl(url)) return;
      const assetKey = `segment-history:${segmentLabel}:${entry.id}`;
      if (seenAssetKeys.has(assetKey)) return;
      seenAssetKeys.add(assetKey);
      items.push({
        id: assetKey,
        kind: "video",
        label: buildSegmentVideoLabel(segmentLabel),
        url,
        origin: "derived",
        status: "failed",
        subKind: "history-video",
        segmentLabel,
        historyEntryId: entry.id,
        failureReason: entry.failureReason,
        archivedAt: entry.archivedAt,
        promotedAt: entry.promotedAt,
        meta: [
          entry.promotedAt ? "\u5df2\u4f20\u9012" : "\u5f85\u4f20\u9012",
          entry.route,
          entry.failureReason,
        ]
          .filter(Boolean)
          .join(MANIFEST_LABEL_SEPARATOR),
      });
    });
}
