import { useCallback, useRef } from "react";
import type {
  Scene,
  CharacterSetting,
  SceneSetting,
  ArtStyle,
  ProductionAssetManifest,
  VideoAuditPacket,
  VideoAutomationState,
  VideoAutomationReferenceTargetState,
  VideoRepairTask,
  VideoShotPacket,
  VideoProductionBundleMeta,
  VideoStyleLock,
  VideoWorldModel,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  SegmentContinuityGridImage,
  ArchivedSegmentVideoCandidate,
  SegmentVideoPrompt,
  SegmentVideoStatus,
} from "@/types/project";
import { getProjectsFilePath, readJsonFile, writeJsonFile, scanProjectDirectoryIds, readProjectManifest, remapLocalPathToCurrentRoot } from "@/lib/file-cache";
import { writeConversationArchiveProject } from "@/lib/home-agent/conversation-archive";
import {
  buildLegacyVideoImageStylePrefs,
  normalizeVideoImageGenerationPrefs,
  resolveVideoImageProjectArtStyle,
} from "@/lib/home-agent/image-models";
import { isExpiredRemoteSignedMediaUrl, isKnownPlaceholderMediaUrl } from "@/lib/home-agent/media-url";
import { normalizeVideoGenerationPrefs } from "@/lib/home-agent/video-models";

interface ProjectData {
  title: string;
  script: string;
  targetPlatform?: string;
  shotStyle?: string;
  outputGoal?: string;
  productionNotes?: string;
  referenceStyleSummary?: string;
  kickoffModeConfirmed?: boolean;
  kickoffStyleConfirmed?: boolean;
  scenes: Scene[];
  characters: CharacterSetting[];
  sceneSettings: SceneSetting[];
  artStyle: ArtStyle;
  currentStep: number;
  systemPrompt: string;
  analysisSummary?: string;
  scriptBreakdownPassed?: boolean;
  storyboardPlan?: string;
  videoPromptBatch?: string;
  segmentVideoPrompts?: Record<string, SegmentVideoPrompt>;
  segmentPromptRefreshCursor?: string | null;
  segmentVideos?: Record<string, string>; // segmentLabel → localPath/url
  segmentContinuityFrames?: Record<string, string>;
  segmentContinuityFrameSets?: Record<string, string[]>;
  segmentContinuityGridImages?: Record<string, SegmentContinuityGridImage>;
  archivedSegmentVideos?: Record<string, ArchivedSegmentVideoCandidate[]>;
  segmentVideoStatuses?: Record<string, SegmentVideoStatus>;
  videoAuditPackets?: VideoAuditPacket[];
  videoRepairTasks?: VideoRepairTask[];
  automationState?: VideoAutomationState | null;
  sourceProjectId?: string;
  styleLock?: VideoStyleLock | null;
  worldModel?: VideoWorldModel | null;
  assetManifest?: ProductionAssetManifest | null;
  shotPackets?: VideoShotPacket[];
  reviewQueue?: Array<{
    id: string;
    title: string;
    summary: string;
    targetIds: string[];
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  productionStateBundle?: VideoProductionBundleMeta | null;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  videoGenerationPrefs?: VideoGenerationPrefs;
  videoGenerationModeNotice?: {
    message: string;
    activeMode: VideoGenerationPrefs["mode"];
    reason: string;
    updatedAt: string;
  } | null;
  preferredEpisodeDurationSeconds?: number | null;
  preferredScriptBreakdownPace?: "slow" | "medium" | "fast" | null;
  /** 用户通过步骤切换手动跳到的目标步骤（>自然进度步骤时生效），用于阻止自动推进 */
  manualStepOverride?: number | null;
}

const STORAGE_KEY = "storyforge_projects";
const CURRENT_PROJECT_KEY = "storyforge_current_project";

// getProjects() 结果缓存，saveProjects() 时失效，避免每次切换项目都重复扫描文件系统
let projectsCachePromise: Promise<StoredProject[]> | null = null;
let projectsFastCachePromise: Promise<StoredProject[]> | null = null;
export function invalidateProjectsCache(): void {
  projectsCachePromise = null;
  projectsFastCachePromise = null;
}

interface StoredProject extends ProjectData {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type PersistedVideoProject = StoredProject;

function normalizeStoredScriptBreakdownPace(
  value: unknown,
): ProjectData["preferredScriptBreakdownPace"] {
  return value === "slow" || value === "medium" || value === "fast" ? value : null;
}

function normalizeReferenceTargetAutomationState(
  value: unknown,
): Record<string, VideoAutomationReferenceTargetState> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(
    entries.map(([targetId, rawValue]) => {
      const state = (rawValue && typeof rawValue === "object" ? rawValue : {}) as Partial<VideoAutomationReferenceTargetState>;
      return [
        targetId,
        {
          targetId,
          targetType:
            state.targetType === "character-primary" ||
            state.targetType === "character-variant" ||
            state.targetType === "scene-primary" ||
            state.targetType === "scene-variant"
              ? state.targetType
              : "character-primary",
          entityId: typeof state.entityId === "string" ? state.entityId : "",
          variantId: typeof state.variantId === "string" ? state.variantId : undefined,
          status:
            state.status === "ready" ||
            state.status === "retryable" ||
            state.status === "blocked" ||
            state.status === "exhausted"
              ? state.status
              : "pending",
          attemptCount: Number.isFinite(state.attemptCount) ? Number(state.attemptCount) : 0,
          retryBudget: Number.isFinite(state.retryBudget) ? Number(state.retryBudget) : 0,
          dependencyTargetIds: Array.isArray(state.dependencyTargetIds)
            ? state.dependencyTargetIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : undefined,
          lastError: typeof state.lastError === "string" ? state.lastError : undefined,
          lastTriedAt: typeof state.lastTriedAt === "string" ? state.lastTriedAt : undefined,
          lastSucceededAt: typeof state.lastSucceededAt === "string" ? state.lastSucceededAt : undefined,
          generatedUrl: typeof state.generatedUrl === "string" ? state.generatedUrl : undefined,
          qualityScore: Number.isFinite(state.qualityScore) ? Number(state.qualityScore) : undefined,
          sourceRefs: Array.isArray(state.sourceRefs)
            ? state.sourceRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : undefined,
          lastQaSummary: typeof state.lastQaSummary === "string" ? state.lastQaSummary : undefined,
          lastQaScore: Number.isFinite(state.lastQaScore) ? Number(state.lastQaScore) : undefined,
          lastQaPassed: typeof state.lastQaPassed === "boolean" ? state.lastQaPassed : undefined,
          lastQaIssues: Array.isArray(state.lastQaIssues)
            ? state.lastQaIssues.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : undefined,
          lastQaAt: typeof state.lastQaAt === "string" ? state.lastQaAt : undefined,
        } satisfies VideoAutomationReferenceTargetState,
      ];
    }),
  );
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function collectMediaUrlKeys(value: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (typeof value !== "string") return keys;
  const trimmed = value.trim();
  if (!trimmed) return keys;
  keys.add(trimmed.toLowerCase());
  const withoutQuery = trimmed.split("?")[0] || trimmed;
  keys.add(withoutQuery.toLowerCase());
  const withoutFileScheme = withoutQuery.replace(/^file:\/*/i, "");
  keys.add(withoutFileScheme.toLowerCase());
  const baseName = decodeURIComponent(withoutFileScheme.split(/[\\/]/).pop() || "").trim();
  if (baseName) {
    keys.add(baseName.toLowerCase());
  }
  return keys;
}

function matchesHistoricalVideoUrl(historyUrls: Set<string>, candidateUrl: string | undefined): boolean {
  for (const key of collectMediaUrlKeys(candidateUrl)) {
    if (historyUrls.has(key)) return true;
  }
  return false;
}

function stripKnownPlaceholderMediaFromProject(project: StoredProject): StoredProject {
  const sanitizeUrl = (url?: string | null): string | undefined => {
    if (typeof url !== "string") return undefined;
    const trimmed = url.trim();
    if (!trimmed || isKnownPlaceholderMediaUrl(trimmed)) return undefined;
    return url;
  };
  const sanitizeImageHistory = (
    history?: Array<{ imageUrl: string; description: string; createdAt: string }>,
  ) => {
    if (!history?.length) return history;
    const nextHistory = history.filter((entry) => !isKnownPlaceholderMediaUrl(entry.imageUrl?.trim()));
    return nextHistory.length ? nextHistory : undefined;
  };
  const sanitizeVideoHistory = (history?: Array<{ videoUrl: string; createdAt: string }>) => {
    if (!history?.length) return history;
    const nextHistory = history.filter((entry) => !isKnownPlaceholderMediaUrl(entry.videoUrl?.trim()));
    return nextHistory.length ? nextHistory : undefined;
  };

  const characters = (project.characters ?? []).map((character) => {
    const nextThreeViewUrls = character.threeViewUrls
      ? Object.fromEntries(
          Object.entries(character.threeViewUrls).filter(([, url]) => !isKnownPlaceholderMediaUrl(url?.trim())),
        )
      : undefined;
    return {
      ...character,
      imageUrl: sanitizeUrl(character.imageUrl),
      audioUrl: sanitizeUrl(character.audioUrl),
      imageHistory: sanitizeImageHistory(character.imageHistory),
      ...(nextThreeViewUrls && Object.keys(nextThreeViewUrls).length
        ? { threeViewUrls: nextThreeViewUrls }
        : character.threeViewUrls
          ? { threeViewUrls: undefined }
          : {}),
      ...(character.costumes
        ? {
            costumes: character.costumes.map((costume) => ({
              ...costume,
              imageUrl: sanitizeUrl(costume.imageUrl),
              imageHistory: sanitizeImageHistory(costume.imageHistory),
            })),
          }
        : {}),
    };
  });

  const sceneSettings = (project.sceneSettings ?? []).map((sceneSetting) => ({
    ...sceneSetting,
    imageUrl: sanitizeUrl(sceneSetting.imageUrl),
    imageHistory: sanitizeImageHistory(sceneSetting.imageHistory),
    ...(sceneSetting.timeVariants
      ? {
          timeVariants: sceneSetting.timeVariants.map((variant) => ({
            ...variant,
            imageUrl: sanitizeUrl(variant.imageUrl),
            imageHistory: sanitizeImageHistory(variant.imageHistory),
          })),
        }
      : {}),
  }));

  const scenes = (project.scenes ?? []).map((scene) => ({
    ...scene,
    storyboardUrl: sanitizeUrl(scene.storyboardUrl),
    storyboardHistory: scene.storyboardHistory?.filter((url) => !isKnownPlaceholderMediaUrl(url?.trim())),
    videoUrl: sanitizeUrl(scene.videoUrl),
    videoHistory: sanitizeVideoHistory(scene.videoHistory),
  }));

  const segmentVideos = project.segmentVideos
    ? Object.fromEntries(
        Object.entries(project.segmentVideos).filter(([, url]) => !isKnownPlaceholderMediaUrl(url?.trim())),
      )
    : project.segmentVideos;
  const segmentContinuityFrames = project.segmentContinuityFrames
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityFrames).filter(
          ([, url]) => !isKnownPlaceholderMediaUrl(url?.trim()),
        ),
      )
    : project.segmentContinuityFrames;
  const segmentContinuityFrameSets = project.segmentContinuityFrameSets
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityFrameSets)
          .map(([label, urls]) => [
            label,
            Array.isArray(urls)
              ? urls
                  .map((url) => String(url || "").trim())
                  .filter((url) => url && !isKnownPlaceholderMediaUrl(url))
              : [],
          ])
          .filter(([, urls]) => urls.length > 0),
      )
    : project.segmentContinuityFrameSets;
  const segmentContinuityGridImages = project.segmentContinuityGridImages
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityGridImages)
          .map(([label, value]) => {
            const imageUrl = sanitizeUrl(value?.imageUrl);
            const recapText = typeof value?.recapText === "string" ? value.recapText.trim() : "";
            const frameUrls = Array.isArray(value?.frameUrls)
              ? value.frameUrls
                  .map((url) => String(url || "").trim())
                  .filter((url) => url && !isKnownPlaceholderMediaUrl(url))
              : undefined;
            if (!imageUrl) return null;
            return [
              label,
              {
                imageUrl,
                ...(recapText ? { recapText } : {}),
                ...(frameUrls?.length ? { frameUrls } : {}),
                createdAt:
                  typeof value?.createdAt === "string" && value.createdAt.trim()
                    ? value.createdAt
                    : new Date().toISOString(),
                ...(typeof value?.updatedAt === "string" && value.updatedAt.trim()
                  ? { updatedAt: value.updatedAt }
                  : {}),
              } satisfies SegmentContinuityGridImage,
            ] as const;
          })
          .filter((entry): entry is readonly [string, SegmentContinuityGridImage] => Boolean(entry)),
      )
    : project.segmentContinuityGridImages;
  const archivedSegmentVideos = project.archivedSegmentVideos
    ? Object.fromEntries(
        Object.entries(project.archivedSegmentVideos)
          .map(([segmentLabel, entries]) => [
            segmentLabel,
            (Array.isArray(entries) ? entries : [])
              .map((entry, index) => {
                const videoUrl = sanitizeUrl(entry?.videoUrl);
                if (!videoUrl) return null;
                const failureReason = typeof entry?.failureReason === "string"
                  ? entry.failureReason.trim()
                  : "";
                return {
                  id:
                    typeof entry?.id === "string" && entry.id.trim()
                      ? entry.id.trim()
                      : `archived-segment-video:${segmentLabel}:${index + 1}`,
                  segmentLabel,
                  videoUrl,
                  failureReason: failureReason || "自动 QA 拦截了这条历史候选视频。",
                  ...(typeof entry?.provider === "string" && entry.provider.trim()
                    ? { provider: entry.provider.trim() }
                    : {}),
                  ...(typeof entry?.taskId === "string" && entry.taskId.trim()
                    ? { taskId: entry.taskId.trim() }
                    : {}),
                  ...(typeof entry?.submittedPrompt === "string" && entry.submittedPrompt.trim()
                    ? { submittedPrompt: entry.submittedPrompt.trim() }
                    : {}),
                  ...(Array.isArray(entry?.referenceImageUrls) && entry.referenceImageUrls.length
                    ? {
                        referenceImageUrls: entry.referenceImageUrls
                          .map((url) => sanitizeUrl(String(url || "")))
                          .filter((url): url is string => Boolean(url)),
                      }
                    : {}),
                  ...(typeof entry?.usedContinuityFrame === "boolean"
                    ? { usedContinuityFrame: entry.usedContinuityFrame }
                    : {}),
                  ...(typeof entry?.usedRelayVideo === "boolean"
                    ? { usedRelayVideo: entry.usedRelayVideo }
                    : {}),
                  ...(entry?.route ? { route: entry.route } : {}),
                  ...(typeof entry?.auditId === "string" && entry.auditId.trim()
                    ? { auditId: entry.auditId.trim() }
                    : {}),
                  ...(typeof entry?.qaSummary === "string" && entry.qaSummary.trim()
                    ? { qaSummary: entry.qaSummary.trim() }
                    : {}),
                  ...(Array.isArray(entry?.issues) && entry.issues.length
                    ? {
                        issues: entry.issues
                          .map((issue) => String(issue || "").trim())
                          .filter(Boolean),
                      }
                    : {}),
                  ...(entry?.qualityTier ? { qualityTier: entry.qualityTier } : {}),
                  archivedAt:
                    typeof entry?.archivedAt === "string" && entry.archivedAt.trim()
                      ? entry.archivedAt
                      : new Date().toISOString(),
                  ...(typeof entry?.promotedAt === "string" && entry.promotedAt.trim()
                    ? { promotedAt: entry.promotedAt }
                    : {}),
                } satisfies ArchivedSegmentVideoCandidate;
              })
              .filter((entry): entry is ArchivedSegmentVideoCandidate => Boolean(entry)),
          ])
          .filter(([, entries]) => entries.length > 0),
      )
    : project.archivedSegmentVideos;

  return {
    ...project,
    characters,
    sceneSettings,
    scenes,
    assetManifest: project.assetManifest
      ? {
          ...project.assetManifest,
          items: project.assetManifest.items.filter((item) => !isKnownPlaceholderMediaUrl(item.url?.trim())),
        }
      : project.assetManifest,
    segmentVideos:
      segmentVideos && Object.keys(segmentVideos).length
        ? segmentVideos
        : project.segmentVideos
          ? undefined
          : project.segmentVideos,
    segmentContinuityFrames:
      segmentContinuityFrames && Object.keys(segmentContinuityFrames).length
        ? segmentContinuityFrames
        : project.segmentContinuityFrames
          ? undefined
          : project.segmentContinuityFrames,
    segmentContinuityFrameSets:
      segmentContinuityFrameSets && Object.keys(segmentContinuityFrameSets).length
        ? segmentContinuityFrameSets
        : project.segmentContinuityFrameSets
          ? undefined
          : project.segmentContinuityFrameSets,
    segmentContinuityGridImages:
      segmentContinuityGridImages && Object.keys(segmentContinuityGridImages).length
        ? segmentContinuityGridImages
        : project.segmentContinuityGridImages
          ? undefined
          : project.segmentContinuityGridImages,
    archivedSegmentVideos:
      archivedSegmentVideos && Object.keys(archivedSegmentVideos).length
        ? archivedSegmentVideos
        : project.archivedSegmentVideos
          ? undefined
          : project.archivedSegmentVideos,
  };
}

function normalizeNestedVariantIds<T extends { id: string }>(
  variants: T[] | undefined,
  ownerId: string,
  kind: "costume" | "time-variant",
): T[] | undefined {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;

  const seenIds = new Set<string>();
  let changed = false;

  const normalized = variants.map((variant, index) => {
    const currentId = typeof variant.id === "string" ? variant.id.trim() : "";
    let nextId = currentId;

    if (!nextId || seenIds.has(nextId)) {
      nextId = `${kind}-${ownerId}-${index + 1}-${generateId()}`;
    }

    if (nextId !== currentId) {
      changed = true;
    }

    seenIds.add(nextId);
    return nextId === variant.id ? variant : { ...variant, id: nextId };
  });

  return changed ? normalized : variants;
}

export function pruneExpiredVideoReferencesFromProject(
  project: StoredProject,
  now: number = Date.now(),
): StoredProject {
  let changed = false;

  const scenes = (project.scenes ?? []).map((scene) => {
    const currentVideoExpired = isExpiredRemoteSignedMediaUrl(scene.videoUrl, now);
    const nextHistory = (scene.videoHistory ?? []).filter(
      (entry) => !isExpiredRemoteSignedMediaUrl(entry.videoUrl, now),
    );
    const historyChanged = nextHistory.length !== (scene.videoHistory ?? []).length;

    if (!currentVideoExpired && !historyChanged) {
      return scene;
    }

    changed = true;
    return {
      ...scene,
      ...(currentVideoExpired
        ? {
            videoUrl: undefined,
            videoTaskId: undefined,
            videoProvider: undefined,
            videoStatus: undefined,
            videoFailure: undefined,
          }
        : {}),
      ...(historyChanged
        ? {
            videoHistory: nextHistory.length ? nextHistory : undefined,
          }
        : {}),
    };
  });

  const historicalVideoUrls = new Set<string>();
  scenes.forEach((scene) => {
    (scene.videoHistory ?? []).forEach((entry) => {
      collectMediaUrlKeys(entry.videoUrl).forEach((key) => historicalVideoUrls.add(key));
    });
  });

  const nextAssetManifest = project.assetManifest
    ? {
        ...project.assetManifest,
        items: project.assetManifest.items.filter(
          (item) =>
            Boolean(item.url?.trim()) &&
            !isExpiredRemoteSignedMediaUrl(item.url, now) &&
            !(
              item.kind === "video-segment" &&
              item.origin === "manual" &&
              matchesHistoricalVideoUrl(historicalVideoUrls, item.url)
            ),
        ),
      }
    : project.assetManifest;

  if (
    nextAssetManifest &&
    project.assetManifest &&
    nextAssetManifest.items.length !== project.assetManifest.items.length
  ) {
    changed = true;
  }

  const nextSegmentContinuityFrames = project.segmentContinuityFrames
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityFrames).filter(
          ([, url]) => !isExpiredRemoteSignedMediaUrl(url, now),
        ),
      )
    : project.segmentContinuityFrames;
  const nextSegmentContinuityFrameSets = project.segmentContinuityFrameSets
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityFrameSets)
          .map(([label, urls]) => [
            label,
            Array.isArray(urls)
              ? urls.filter((url) => !isExpiredRemoteSignedMediaUrl(url, now))
              : [],
          ])
          .filter(([, urls]) => urls.length > 0),
      )
    : project.segmentContinuityFrameSets;
  const nextSegmentContinuityGridImages = project.segmentContinuityGridImages
    ? Object.fromEntries(
        Object.entries(project.segmentContinuityGridImages)
          .map(([label, value]) => {
            if (!value?.imageUrl || isExpiredRemoteSignedMediaUrl(value.imageUrl, now)) return null;
            const frameUrls = Array.isArray(value.frameUrls)
              ? value.frameUrls.filter((url) => !isExpiredRemoteSignedMediaUrl(url, now))
              : undefined;
            return [
              label,
              {
                ...value,
                ...(frameUrls?.length ? { frameUrls } : {}),
              } satisfies SegmentContinuityGridImage,
            ] as const;
          })
          .filter((entry): entry is readonly [string, SegmentContinuityGridImage] => Boolean(entry)),
      )
    : project.segmentContinuityGridImages;
  const nextArchivedSegmentVideos = project.archivedSegmentVideos
    ? Object.fromEntries(
        Object.entries(project.archivedSegmentVideos)
          .map(([segmentLabel, entries]) => [
            segmentLabel,
            (Array.isArray(entries) ? entries : []).filter(
              (entry) => !isExpiredRemoteSignedMediaUrl(entry?.videoUrl, now),
            ),
          ])
          .filter(([, entries]) => entries.length > 0),
      )
    : project.archivedSegmentVideos;
  if (
    nextSegmentContinuityFrames &&
    project.segmentContinuityFrames &&
    Object.keys(nextSegmentContinuityFrames).length !== Object.keys(project.segmentContinuityFrames).length
  ) {
    changed = true;
  }
  if (
    nextSegmentContinuityFrameSets &&
    project.segmentContinuityFrameSets &&
    Object.keys(nextSegmentContinuityFrameSets).length !== Object.keys(project.segmentContinuityFrameSets).length
  ) {
    changed = true;
  }
  if (
    nextSegmentContinuityGridImages &&
    project.segmentContinuityGridImages &&
    Object.keys(nextSegmentContinuityGridImages).length !== Object.keys(project.segmentContinuityGridImages).length
  ) {
    changed = true;
  }
  if (
    nextArchivedSegmentVideos &&
    project.archivedSegmentVideos &&
    Object.keys(nextArchivedSegmentVideos).length !== Object.keys(project.archivedSegmentVideos).length
  ) {
    changed = true;
  } else if (project.archivedSegmentVideos) {
    for (const [segmentLabel, entries] of Object.entries(project.archivedSegmentVideos)) {
      if ((nextArchivedSegmentVideos?.[segmentLabel]?.length ?? 0) !== (entries?.length ?? 0)) {
        changed = true;
        break;
      }
    }
  }

  return changed
    ? {
        ...project,
        scenes,
        assetManifest: nextAssetManifest,
        segmentContinuityFrames: nextSegmentContinuityFrames,
        segmentContinuityFrameSets: nextSegmentContinuityFrameSets,
        segmentContinuityGridImages: nextSegmentContinuityGridImages,
        archivedSegmentVideos: nextArchivedSegmentVideos,
      }
    : project;
}

export function normalizeStoredVideoProject(project: StoredProject): StoredProject {
  const sanitizedProject = stripKnownPlaceholderMediaFromProject(project);
  const artStyle = sanitizedProject.artStyle || "live-action";
  const imageGenerationPrefs = normalizeVideoImageGenerationPrefs({
    ...buildLegacyVideoImageStylePrefs(artStyle),
    ...sanitizedProject.imageGenerationPrefs,
  });
  const referenceStyleSummary =
    typeof sanitizedProject.referenceStyleSummary === "string" &&
      sanitizedProject.referenceStyleSummary.trim()
      ? sanitizedProject.referenceStyleSummary.trim()
      : undefined;
  const videoGenerationPrefs = normalizeVideoGenerationPrefs(sanitizedProject.videoGenerationPrefs);
  const preferredScriptBreakdownPace = normalizeStoredScriptBreakdownPace(
    sanitizedProject.preferredScriptBreakdownPace,
  );
  const automationState = sanitizedProject.automationState
    ? {
        ...sanitizedProject.automationState,
        referenceTargets: normalizeReferenceTargetAutomationState(
          sanitizedProject.automationState.referenceTargets,
        ),
      }
    : sanitizedProject.automationState;
  const characters = (sanitizedProject.characters ?? []).map((character, index) => {
    const characterId = typeof character.id === "string" && character.id.trim()
      ? character.id.trim()
      : `character-${index + 1}`;
    const costumes = normalizeNestedVariantIds(character.costumes, characterId, "costume");
    const activeCostumeId = costumes?.some((costume) => costume.id === character.activeCostumeId)
      ? character.activeCostumeId
      : undefined;

    return {
      ...character,
      ...(costumes ? { costumes } : character.costumes ? { costumes: undefined } : {}),
      ...(activeCostumeId
        ? { activeCostumeId }
        : character.activeCostumeId
          ? { activeCostumeId: undefined }
          : {}),
    };
  });
  const sceneSettings = (sanitizedProject.sceneSettings ?? []).map((sceneSetting, index) => {
    const sceneSettingId = typeof sceneSetting.id === "string" && sceneSetting.id.trim()
      ? sceneSetting.id.trim()
      : `scene-setting-${index + 1}`;
    const timeVariants = normalizeNestedVariantIds(
      sceneSetting.timeVariants,
      sceneSettingId,
      "time-variant",
    );
    const activeTimeVariantId = timeVariants?.some((variant) => variant.id === sceneSetting.activeTimeVariantId)
      ? sceneSetting.activeTimeVariantId
      : undefined;

    return {
      ...sceneSetting,
      ...(timeVariants ? { timeVariants } : sceneSetting.timeVariants ? { timeVariants: undefined } : {}),
      ...(activeTimeVariantId
        ? { activeTimeVariantId }
        : sceneSetting.activeTimeVariantId
          ? { activeTimeVariantId: undefined }
          : {}),
    };
  });

  return {
    ...sanitizedProject,
    characters,
    sceneSettings,
    artStyle: resolveVideoImageProjectArtStyle(imageGenerationPrefs, artStyle),
    imageGenerationPrefs,
    referenceStyleSummary,
    kickoffModeConfirmed: sanitizedProject.kickoffModeConfirmed === true,
    kickoffStyleConfirmed: sanitizedProject.kickoffStyleConfirmed === true,
    videoGenerationPrefs,
    preferredScriptBreakdownPace,
    automationState,
  };
}

function getProjectsFromLocalStorage(): StoredProject[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data
      ? (JSON.parse(data) as StoredProject[]).map((project) =>
          normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
        )
      : [];
  } catch {
    return [];
  }
}

function saveProjectsToLocalStorage(projects: StoredProject[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    return true;
  } catch {
    return false;
  }
}

/** 将项目内所有本地路径重映射到当前 files 根目录 */
async function remapProjectPaths(project: StoredProject): Promise<StoredProject> {
  const remap = remapLocalPathToCurrentRoot;
  const remapUrl = async (url?: string | null) => {
    if (!url || url.startsWith("data:") || url.startsWith("http") || url.startsWith("file://")) return url;
    if (!/^[A-Za-z]:[\\/]/.test(url)) return url;
    return remap(url);
  };
  const latestImageHistoryUrl = (history?: Array<{ imageUrl: string }>) =>
    [...(history ?? [])]
      .map((entry) => entry.imageUrl?.trim())
      .filter((value): value is string => Boolean(value))
      .at(-1);
  const latestStoryboardHistoryUrl = (history?: string[]) =>
    [...(history ?? [])]
      .map((entry) => entry?.trim())
      .filter((value): value is string => Boolean(value))
      .at(-1);

  const characters = await Promise.all(
    (project.characters || []).map(async (c) => ({
      ...c,
      imageUrl: await remapUrl(c.imageUrl || latestImageHistoryUrl(c.imageHistory)) ?? c.imageUrl,
      audioUrl: await remapUrl(c.audioUrl) ?? c.audioUrl,
      costumes: c.costumes
        ? await Promise.all(
            c.costumes.map(async (costume) => ({
              ...costume,
              imageUrl: await remapUrl(costume.imageUrl || latestImageHistoryUrl(costume.imageHistory)) ?? costume.imageUrl,
            })),
          )
        : c.costumes,
    })),
  );
  const sceneSettings = await Promise.all(
    (project.sceneSettings || []).map(async (s) => ({
      ...s,
      imageUrl: await remapUrl(s.imageUrl || latestImageHistoryUrl(s.imageHistory)) ?? s.imageUrl,
      timeVariants: s.timeVariants
        ? await Promise.all(
            s.timeVariants.map(async (variant) => ({
              ...variant,
              imageUrl: await remapUrl(variant.imageUrl || latestImageHistoryUrl(variant.imageHistory)) ?? variant.imageUrl,
            })),
          )
        : s.timeVariants,
    })),
  );
  const scenes = await Promise.all(
    (project.scenes || []).map(async (s) => ({
      ...s,
      storyboardUrl: await remapUrl(s.storyboardUrl || latestStoryboardHistoryUrl(s.storyboardHistory)) ?? s.storyboardUrl,
      videoUrl: await remapUrl(s.videoUrl) ?? s.videoUrl,
    })),
  );
  const segmentVideos = project.segmentVideos
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.segmentVideos).map(async ([label, url]) => [
            label,
            await remapUrl(url) ?? url,
          ]),
        ),
      )
    : project.segmentVideos;
  const segmentContinuityFrames = project.segmentContinuityFrames
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.segmentContinuityFrames).map(async ([label, url]) => [
            label,
            await remapUrl(url) ?? url,
          ]),
        ),
      )
    : project.segmentContinuityFrames;
  const segmentContinuityFrameSets = project.segmentContinuityFrameSets
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.segmentContinuityFrameSets).map(async ([label, urls]) => [
            label,
            (
              await Promise.all(
                (Array.isArray(urls) ? urls : []).map(async (url) => (await remapUrl(url)) ?? url),
              )
            ).filter((url) => String(url || "").trim()),
          ]),
        ),
      )
    : project.segmentContinuityFrameSets;
  const segmentContinuityGridImages = project.segmentContinuityGridImages
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.segmentContinuityGridImages).map(async ([label, value]) => {
            const imageUrl = (await remapUrl(value?.imageUrl)) ?? value?.imageUrl;
            const frameUrls = (
              await Promise.all(
                (Array.isArray(value?.frameUrls) ? value.frameUrls : []).map(
                  async (url) => (await remapUrl(url)) ?? url,
                ),
              )
            ).filter((url) => String(url || "").trim());
            return [
              label,
              {
                imageUrl,
                ...(typeof value?.recapText === "string" && value.recapText.trim()
                  ? { recapText: value.recapText.trim() }
                  : {}),
                ...(frameUrls.length ? { frameUrls } : {}),
                createdAt:
                  typeof value?.createdAt === "string" && value.createdAt.trim()
                    ? value.createdAt
                    : new Date().toISOString(),
                ...(typeof value?.updatedAt === "string" && value.updatedAt.trim()
                  ? { updatedAt: value.updatedAt }
                  : {}),
              } satisfies SegmentContinuityGridImage,
            ] as const;
          }),
        ),
      )
    : project.segmentContinuityGridImages;
  const archivedSegmentVideos = project.archivedSegmentVideos
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.archivedSegmentVideos).map(async ([segmentLabel, entries]) => [
            segmentLabel,
            (
              await Promise.all(
                (Array.isArray(entries) ? entries : []).map(async (entry) => ({
                  ...entry,
                  segmentLabel,
                  videoUrl: (await remapUrl(entry?.videoUrl)) ?? entry?.videoUrl,
                  referenceImageUrls: Array.isArray(entry?.referenceImageUrls)
                    ? (
                        await Promise.all(
                          entry.referenceImageUrls.map(
                            async (url) => (await remapUrl(url)) ?? url,
                          ),
                        )
                      ).filter((url) => String(url || "").trim())
                    : entry?.referenceImageUrls,
                })),
              )
            ).filter((entry) => String(entry.videoUrl || "").trim()),
          ]),
        ),
      )
    : project.archivedSegmentVideos;
  return {
    ...project,
    characters,
    sceneSettings,
    scenes,
    segmentVideos,
    segmentContinuityFrames,
    segmentContinuityFrameSets,
    segmentContinuityGridImages,
    archivedSegmentVideos,
  };
}

async function getProjects(): Promise<StoredProject[]> {
  if (!projectsCachePromise) {
    projectsCachePromise = loadProjectsFromDisk();
  }
  return (await projectsCachePromise).slice();
}

async function getProjectsFast(): Promise<StoredProject[]> {
  if (!projectsFastCachePromise) {
    projectsFastCachePromise = loadProjectsFromDisk({ skipRepair: true });
  }
  return (await projectsFastCachePromise).slice();
}

async function loadProjectsFromDisk(options?: { skipRepair?: boolean }): Promise<StoredProject[]> {
  const skipRepair = options?.skipRepair === true;
  const filePath = await getProjectsFilePath();
  let fileProjects: StoredProject[] = [];
  let rawFileProjects: StoredProject[] | null = null;

  if (filePath) {
    const fromFile = await readJsonFile<StoredProject[]>(filePath);
    if (fromFile) {
      rawFileProjects = fromFile;
      fileProjects = fromFile.map((project) =>
        normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
      );
      // 合并 localStorage 中存在但文件里没有的项目（兼容旧数据）
      const localProjects = getProjectsFromLocalStorage();
      const fileIds = new Set(fileProjects.map((p) => p.id));
      const localOnly = localProjects.filter((p) => !fileIds.has(p.id));
      if (localOnly.length > 0) {
        fileProjects = [...fileProjects, ...localOnly];
      }
    } else {
      fileProjects = getProjectsFromLocalStorage();
    }
  } else {
    fileProjects = getProjectsFromLocalStorage();
  }

  if (skipRepair) {
    return fileProjects;
  }

  // 扫描文件系统目录，补全孤立项目（有目录但不在 projects.json 里的）
  try {
    const dirIds = await scanProjectDirectoryIds();
    const knownIds = new Set(fileProjects.map((p) => p.id));
    const orphanIds = dirIds.filter((id) => !knownIds.has(id));
    if (orphanIds.length > 0) {
      const orphanProjects = await Promise.all(
        orphanIds.map(async (id) => {
          const manifest = await readProjectManifest(id);
          if (!manifest) return null;
          const stub: StoredProject = {
            id,
            title: manifest.title || "未命名项目",
            script: "",
            scenes: [],
            characters: [],
            sceneSettings: [],
            artStyle: "live-action",
            currentStep: 0,
            systemPrompt: "",
            createdAt: manifest.updatedAt,
            updatedAt: manifest.updatedAt,
          };
          return normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(stub));
        }),
      );
      const validOrphans = orphanProjects.filter((p): p is StoredProject => p !== null);
      if (validOrphans.length > 0) {
        fileProjects = [...fileProjects, ...validOrphans];
      }
    }
  } catch {
    // 目录扫描失败时静默忽略，不影响正常加载
  }

  // 路径重映射：修正因项目目录迁移导致的本地路径失效
  const remapped = await Promise.all(fileProjects.map(remapProjectPaths));

  // 如果有路径变化，回写到 projects.json 保持同步
  if (filePath) {
    const rawSerialized = rawFileProjects ? JSON.stringify(rawFileProjects) : null;
    const sanitizedSerialized = JSON.stringify(fileProjects);
    const remappedSerialized = JSON.stringify(remapped);
    const sanitizedFileChanged = rawSerialized !== null && rawSerialized !== sanitizedSerialized;
    const remappedChanged = remappedSerialized !== sanitizedSerialized;
    const persistedCount = (await readJsonFile<StoredProject[]>(filePath))?.length;
    if (sanitizedFileChanged || remappedChanged || remapped.length !== persistedCount) {
      await writeJsonFile(filePath, remapped).catch(() => {});
    }
  }

  return remapped;
}

async function saveProjects(projects: StoredProject[]): Promise<boolean> {
  projectsCachePromise = null;
  projectsFastCachePromise = null;
  const sanitizedProjects = projects.map((project) =>
    normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
  );
  let fileSaved = false;
  const filePath = await getProjectsFilePath();
  if (filePath) {
    fileSaved = await writeJsonFile(filePath, sanitizedProjects);
  }
  const localSaved = saveProjectsToLocalStorage(sanitizedProjects);
  return fileSaved || localSaved;
}

export async function loadStoredVideoProjectById(
  id: string,
  options?: { fast?: boolean },
): Promise<PersistedVideoProject | null> {
  const projects = options?.fast ? await getProjectsFast() : await getProjects();
  return projects.find((project) => project.id === id) || null;
}

export async function listStoredVideoProjects(options?: { fast?: boolean }): Promise<PersistedVideoProject[]> {
  const projects = options?.fast ? await getProjectsFast() : await getProjects();
  return [...projects].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function deleteStoredVideoProjectById(id: string): Promise<boolean> {
  const projects = await getProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;
  const ok = await saveProjects(filtered);
  if (ok && typeof window !== "undefined") {
    try {
      const current = localStorage.getItem(CURRENT_PROJECT_KEY);
      if (current === id) {
        localStorage.removeItem(CURRENT_PROJECT_KEY);
      }
    } catch {
      /* ignore */
    }
  }
  return ok;
}

export async function createStoredVideoProject(data: Partial<ProjectData>): Promise<PersistedVideoProject> {
  const projects = await getProjects();
  const now = new Date().toISOString();
  const project: StoredProject = pruneExpiredVideoReferencesFromProject({
    id: generateId(),
    title: data.title || "未命名视频项目",
    script: data.script || "",
    targetPlatform: data.targetPlatform || "",
    shotStyle: data.shotStyle || "",
    outputGoal: data.outputGoal || "",
    productionNotes: data.productionNotes || "",
    referenceStyleSummary:
      typeof data.referenceStyleSummary === "string" ? data.referenceStyleSummary : undefined,
    kickoffModeConfirmed: data.kickoffModeConfirmed === true,
    kickoffStyleConfirmed: data.kickoffStyleConfirmed === true,
    scenes: data.scenes || [],
    characters: data.characters || [],
    sceneSettings: data.sceneSettings || [],
    artStyle: data.artStyle || "live-action",
    currentStep: data.currentStep || 1,
    systemPrompt: data.systemPrompt || "",
    analysisSummary: data.analysisSummary || "",
    storyboardPlan: data.storyboardPlan || "",
    videoPromptBatch: data.videoPromptBatch || "",
    segmentVideoPrompts: data.segmentVideoPrompts,
    segmentPromptRefreshCursor:
      typeof data.segmentPromptRefreshCursor === "string"
        ? data.segmentPromptRefreshCursor
        : data.segmentPromptRefreshCursor === null
          ? null
          : undefined,
    segmentVideos: data.segmentVideos,
    segmentContinuityFrames: data.segmentContinuityFrames,
    segmentContinuityFrameSets: data.segmentContinuityFrameSets,
    segmentContinuityGridImages: data.segmentContinuityGridImages,
    archivedSegmentVideos: data.archivedSegmentVideos,
    segmentVideoStatuses: data.segmentVideoStatuses,
    videoAuditPackets: data.videoAuditPackets || [],
    videoRepairTasks: data.videoRepairTasks || [],
    automationState: data.automationState || null,
    sourceProjectId: data.sourceProjectId,
    styleLock: data.styleLock || null,
    worldModel: data.worldModel || null,
    assetManifest: data.assetManifest || null,
    shotPackets: data.shotPackets || [],
    reviewQueue: data.reviewQueue || [],
    productionStateBundle: data.productionStateBundle || null,
    imageGenerationPrefs: normalizeVideoImageGenerationPrefs({
      ...buildLegacyVideoImageStylePrefs(data.artStyle || "live-action"),
      ...data.imageGenerationPrefs,
    }),
    videoGenerationPrefs: normalizeVideoGenerationPrefs(data.videoGenerationPrefs),
    preferredScriptBreakdownPace: normalizeStoredScriptBreakdownPace(
      data.preferredScriptBreakdownPace,
    ),
    createdAt: now,
    updatedAt: now,
  });
  const normalizedProject = normalizeStoredVideoProject(project);
  projects.unshift(normalizedProject);
  await saveProjects(projects);
  void writeConversationArchiveProject(normalizedProject.id, normalizedProject.title, "video", normalizedProject);
  return normalizedProject;
}

export async function upsertStoredVideoProject(project: PersistedVideoProject): Promise<PersistedVideoProject> {
  const projects = await getProjects();
  const nextProject: StoredProject = normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject({
    ...project,
    script: project.script || "",
    targetPlatform: project.targetPlatform || "",
    shotStyle: project.shotStyle || "",
    outputGoal: project.outputGoal || "",
    productionNotes: project.productionNotes || "",
    referenceStyleSummary:
      typeof project.referenceStyleSummary === "string" ? project.referenceStyleSummary : undefined,
    analysisSummary: project.analysisSummary || "",
    storyboardPlan: project.storyboardPlan || "",
    videoPromptBatch: project.videoPromptBatch || "",
    segmentVideoPrompts: project.segmentVideoPrompts,
    segmentPromptRefreshCursor:
      typeof project.segmentPromptRefreshCursor === "string"
        ? project.segmentPromptRefreshCursor
        : project.segmentPromptRefreshCursor === null
          ? null
          : undefined,
    segmentVideos: project.segmentVideos,
    segmentContinuityFrames: project.segmentContinuityFrames,
    segmentContinuityFrameSets: project.segmentContinuityFrameSets,
    segmentContinuityGridImages: project.segmentContinuityGridImages,
    archivedSegmentVideos: project.archivedSegmentVideos,
    segmentVideoStatuses: project.segmentVideoStatuses,
    videoAuditPackets: project.videoAuditPackets || [],
    videoRepairTasks: project.videoRepairTasks || [],
    automationState: project.automationState || null,
    styleLock: project.styleLock || null,
    worldModel: project.worldModel || null,
    assetManifest: project.assetManifest || null,
    shotPackets: project.shotPackets || [],
    reviewQueue: project.reviewQueue || [],
    productionStateBundle: project.productionStateBundle || null,
    updatedAt: new Date().toISOString(),
  }));
  const index = projects.findIndex((item) => item.id === project.id);
  if (index >= 0) {
    projects[index] = nextProject;
  } else {
    projects.unshift(nextProject);
  }
  await saveProjects(projects);
  void writeConversationArchiveProject(nextProject.id, nextProject.title, "video", nextProject);
  return nextProject;
}

export function useProjectPersistence() {
  const projectIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ProjectData>>({});

  const setProjectId = (id: string | null) => {
    projectIdRef.current = id;
    if (id) {
      localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_PROJECT_KEY);
    }
  };

  const getProjectId = () => projectIdRef.current;

  const createProject = useCallback(async (data: Partial<ProjectData>) => {
    const newProject = await createStoredVideoProject(data);
    setProjectId(newProject.id);
    return newProject.id;
  }, []);

  const saveProject = useCallback(async (data: Partial<ProjectData>) => {
    const id = projectIdRef.current;
    if (!id) return;
    Object.assign(pendingRef.current, data);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const projects = await getProjects();
      const index = projects.findIndex((p) => p.id === id);
      if (index === -1) return;
      const update = { ...pendingRef.current };
      pendingRef.current = {};
      projects[index] = normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject({
        ...projects[index],
        ...update,
        updatedAt: new Date().toISOString(),
      }));
      await saveProjects(projects);
    }, 500);
  }, []);

  const loadProject = useCallback(async (id: string) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === id);
    if (!project) return null;
    setProjectId(id);
    return {
      title: project.title,
      script: project.script,
      targetPlatform: project.targetPlatform,
      shotStyle: project.shotStyle,
      outputGoal: project.outputGoal,
      productionNotes: project.productionNotes,
      referenceStyleSummary: project.referenceStyleSummary,
      kickoffModeConfirmed: project.kickoffModeConfirmed === true,
      kickoffStyleConfirmed: project.kickoffStyleConfirmed === true,
      scenes: project.scenes,
      characters: project.characters,
      sceneSettings: project.sceneSettings,
      artStyle: project.artStyle,
      currentStep: project.currentStep,
      systemPrompt: project.systemPrompt,
      analysisSummary: project.analysisSummary,
      storyboardPlan: project.storyboardPlan,
      videoPromptBatch: project.videoPromptBatch,
      segmentVideoPrompts: project.segmentVideoPrompts,
      segmentPromptRefreshCursor:
        typeof project.segmentPromptRefreshCursor === "string"
          ? project.segmentPromptRefreshCursor
          : project.segmentPromptRefreshCursor === null
            ? null
            : undefined,
      segmentVideos: project.segmentVideos,
      segmentContinuityFrames: project.segmentContinuityFrames,
      segmentContinuityFrameSets: project.segmentContinuityFrameSets,
      segmentContinuityGridImages: project.segmentContinuityGridImages,
      archivedSegmentVideos: project.archivedSegmentVideos,
      segmentVideoStatuses: project.segmentVideoStatuses,
      videoAuditPackets: project.videoAuditPackets,
      videoRepairTasks: project.videoRepairTasks,
      automationState: project.automationState,
      sourceProjectId: project.sourceProjectId,
      styleLock: project.styleLock,
      worldModel: project.worldModel,
      assetManifest: project.assetManifest,
      shotPackets: project.shotPackets,
      reviewQueue: project.reviewQueue,
      productionStateBundle: project.productionStateBundle,
      imageGenerationPrefs: normalizeVideoImageGenerationPrefs(project.imageGenerationPrefs),
      videoGenerationPrefs: normalizeVideoGenerationPrefs(project.videoGenerationPrefs),
      preferredEpisodeDurationSeconds: project.preferredEpisodeDurationSeconds ?? null,
      preferredScriptBreakdownPace: normalizeStoredScriptBreakdownPace(
        project.preferredScriptBreakdownPace,
      ),
    };
  }, []);

  const listProjects = useCallback(async () => {
    const projects = await getProjects();
    return projects
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, 20)
      .map((p) => ({
        id: p.id,
        title: p.title,
        current_step: p.currentStep,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      }));
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    const projects = await getProjects();
    const filtered = projects.filter((p) => p.id !== id);
    await saveProjects(filtered);
    if (projectIdRef.current === id) {
      setProjectId(null);
    }
    return true;
  }, []);

  useCallback(async () => {
    const lastId = localStorage.getItem(CURRENT_PROJECT_KEY);
    if (!lastId) return;
    const projects = await getProjects();
    if (projects.some((p) => p.id === lastId)) {
      projectIdRef.current = lastId;
    }
  }, []);

  return {
    createProject,
    saveProject,
    loadProject,
    listProjects,
    deleteProject,
    setProjectId,
    getProjectId,
  };
}
