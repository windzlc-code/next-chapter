import {
  getVideoImageGenerationBatchLimit,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  buildMediaContentSummary,
  buildWorkflowMediaTargetLabels,
} from "@/lib/home-agent/media-generation-copy";
import type { StudioRuntimeState } from "@/lib/home-agent/types";
import { getHomeAgentVideoGenerationBatchLimit } from "@/lib/home-agent/video-models";
import { buildVideoGenerationRouteHint } from "@/lib/home-agent/video-generation-route-hint";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import {
  listFailedSegmentVideoLabels,
  listGeneratableSegmentVideoLabels,
  listSmartStoryboardFrameTargetIds,
  listVideoReferenceAssetTargetIds,
} from "./home-agent-project-questions";

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function resolveVideoGenerationBatchLimit(input?: Record<string, unknown> | null): number {
  const requestedPrefs =
    typeof input?.videoGenerationPrefs === "object" && input.videoGenerationPrefs
      ? (input.videoGenerationPrefs as Partial<VideoGenerationPrefs>)
      : null;
  const modelKey =
    typeof input?.selectedVideoModelKey === "string"
      ? input.selectedVideoModelKey
      : typeof input?.videoModelKey === "string"
        ? input.videoModelKey
        : null;
  return getHomeAgentVideoGenerationBatchLimit({
    ...(requestedPrefs ?? {}),
    ...(modelKey ? { modelKey } : {}),
  });
}

function resolveVideoGenerationBatchSize(input?: Record<string, unknown> | null): number {
  const batchLimit = resolveVideoGenerationBatchLimit(input);
  const requestedBatchSize =
    typeof input?.batchSize === "number" && Number.isFinite(input.batchSize)
      ? Math.floor(input.batchSize)
      : batchLimit;
  return Math.max(1, Math.min(batchLimit, requestedBatchSize));
}

export function resolveWorkflowImageStartTargets(params: {
  action: string;
  input: Record<string, unknown>;
  runtime?: StudioRuntimeState;
}): { count: number; targetIds?: string[] } {
  const requestedTargetIds = normalizeStringList(params.input.targetIds);
  let targetIds = requestedTargetIds;

  if (
    (params.action === "generate_video_reference_assets" ||
      params.action === "generate_storyboard_frames") &&
    params.input.smartBatch === true
  ) {
    const normalizedPrefs = normalizeVideoImageGenerationPrefs({
      ...(typeof params.input.imageGenerationPrefs === "object" && params.input.imageGenerationPrefs
        ? (params.input.imageGenerationPrefs as Partial<VideoImageGenerationPrefs>)
        : {}),
      ...(typeof params.input.selectedImageModelFamily === "string"
        ? { familyKey: params.input.selectedImageModelFamily }
        : typeof params.input.modelFamily === "string"
          ? { familyKey: params.input.modelFamily }
          : {}),
      ...(typeof params.input.resolution === "string" ? { resolution: params.input.resolution } : {}),
      ...(typeof params.input.aspectRatio === "string" ? { aspectRatio: params.input.aspectRatio } : {}),
    });
    const modelLimit = getVideoImageGenerationBatchLimit(normalizedPrefs);
    const requestedLimit = Number(
      params.input.maxImageCount ?? params.input.maxImagesPerRun ?? params.input.batchLimit,
    );
    const batchLimit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.max(1, Math.min(modelLimit, Math.floor(requestedLimit)))
        : modelLimit;
    if (requestedTargetIds.length) {
      targetIds = requestedTargetIds.slice(0, batchLimit);
    } else if (params.action === "generate_video_reference_assets" && params.runtime?.currentVideoProject) {
      targetIds = listVideoReferenceAssetTargetIds(params.runtime.currentVideoProject).slice(0, batchLimit);
    } else if (params.action === "generate_storyboard_frames" && params.runtime?.currentVideoProject) {
      targetIds = listSmartStoryboardFrameTargetIds(params.runtime.currentVideoProject).slice(0, batchLimit);
    }
    if (!targetIds.length) {
      return { count: 0 };
    }
  }

  if (targetIds.length) {
    return { count: targetIds.length, targetIds };
  }

  const fallbackCount =
    params.action === "generate_project_image"
      ? 1
      : params.action === "generate_video_reference_assets"
        ? (params.runtime?.currentVideoProject?.characters.length ?? 0) +
          (params.runtime?.currentVideoProject?.sceneSettings.length ?? 0)
        : params.runtime?.currentVideoProject?.scenes.length ?? 1;

  return { count: Math.max(1, fallbackCount || 1) };
}

export function resolveWorkflowVideoAssetStartTargets(params: {
  input: Record<string, unknown>;
  runtime?: StudioRuntimeState;
}): { count: number; targetIds?: string[]; targetLabels?: string[] } {
  const requestedTargetIds = normalizeStringList(params.input.targetIds);
  const project = params.runtime?.currentVideoProject;

  let targetIds: string[] = [];
  if (requestedTargetIds.length) {
    targetIds = requestedTargetIds;
  } else if (project) {
    const start = typeof params.input.sceneStart === "number" ? params.input.sceneStart : null;
    const end = typeof params.input.sceneEnd === "number" ? params.input.sceneEnd : null;
    if (start !== null || end !== null) {
      const lower = start ?? project.scenes[0]?.sceneNumber ?? 1;
      const upper = end ?? lower;
      targetIds = project.scenes
        .filter((scene) => scene.sceneNumber >= lower && scene.sceneNumber <= upper)
        .map((scene) => scene.id);
    } else {
      const forceRegenerate = params.input.forceRegenerate === true;
      const batchSize = resolveVideoGenerationBatchSize(params.input);
      targetIds = project.scenes
        .filter((scene) => {
          if (forceRegenerate) return true;
          const status = String(scene.videoStatus || "").trim().toLowerCase();
          if (status === "queued" || status === "processing") return false;
          return !scene.videoUrl;
        })
        .slice(0, batchSize)
        .map((scene) => scene.id);
    }
  }

  const targetLabels = targetIds.length
    ? buildWorkflowMediaTargetLabels({
        action: "generate_video_assets",
        runtime: params.runtime,
        targetIds,
      })
    : undefined;

  return {
    count: Math.max(1, targetIds.length || 1),
    ...(targetIds.length ? { targetIds } : {}),
    ...(targetLabels?.length ? { targetLabels } : {}),
  };
}

export function resolveWorkflowSegmentVideoStartTargets(params: {
  input: Record<string, unknown>;
  runtime?: StudioRuntimeState;
}): { count: number; segmentLabels?: string[]; targetLabels?: string[] } {
  const requestedSegmentLabels = Array.from(new Set(normalizeStringList(params.input.targetSegmentLabels)));
  const project = params.runtime?.currentVideoProject;
  const fallbackBatchLabels = project
    ? params.input.retryFailed === true
      ? listFailedSegmentVideoLabels(project)
      : params.input.batchMode === "first"
        ? listGeneratableSegmentVideoLabels(project)
        : []
    : [];
  const singleSegmentLabel =
    typeof params.input.segmentLabel === "string" ? params.input.segmentLabel.trim() : "";
  const batchLimit = resolveVideoGenerationBatchLimit(params.input);
  const segmentLabels = (
    requestedSegmentLabels.length
      ? requestedSegmentLabels
      : fallbackBatchLabels.length
        ? fallbackBatchLabels
        : singleSegmentLabel
          ? [singleSegmentLabel]
          : []
  ).slice(0, batchLimit);
  const targetLabels = segmentLabels.length
    ? buildWorkflowMediaTargetLabels({
        action: "generate_segment_video",
        runtime: params.runtime,
        targetIds: segmentLabels,
      })
    : undefined;

  return {
    count: Math.max(1, segmentLabels.length || 1),
    ...(segmentLabels.length ? { segmentLabels } : {}),
    ...(targetLabels?.length ? { targetLabels } : {}),
  };
}

export function dispatchWorkflowMediaEvents(params: {
  imageUrls?: string[];
  videoUrls?: string[];
  mediaEventId?: string;
  actionLabel?: string;
  imageDetail?: {
    action?: string;
    count?: number;
    modelFamily?: string;
    resolution?: string;
    aspectRatio?: string;
    contentSummary?: string;
    imageLabels?: string[];
  };
  videoDetail?: {
    action?: string;
    count?: number;
    model?: string;
    resolution?: string;
    aspectRatio?: string;
    provider?: string;
    mode?: string;
    contentSummary?: string;
  };
}) {
  if (typeof window === "undefined") return;

  const { imageUrls, videoUrls, mediaEventId, actionLabel, imageDetail, videoDetail } = params;
  if (
    (imageDetail?.action &&
      (imageDetail.action === "generate_project_image" ||
        imageDetail.action === "generate_video_reference_assets" ||
        imageDetail.action === "generate_storyboard_frames")) ||
    imageUrls?.length
  ) {
    window.dispatchEvent(
      new CustomEvent("agent:image-generated", {
        detail: {
          imageUrls,
          ...(mediaEventId ? { mediaEventId } : {}),
          ...(actionLabel ? { actionLabel } : {}),
          ...(imageDetail ? imageDetail : {}),
        },
      }),
    );
  }

  if (videoUrls?.length) {
    window.dispatchEvent(
      new CustomEvent("agent:video-generated", {
        detail: {
          videoUrls,
          ...(mediaEventId ? { mediaEventId } : {}),
          ...(videoDetail ? videoDetail : {}),
        },
      }),
    );
  }
}

export function dispatchWorkflowMediaStartEvent(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  promptText?: string;
}) {
  if (typeof window === "undefined") return;

  const { action, input, runtime, promptText } = params;
  const mediaEventId =
    typeof input.mediaEventId === "string" && input.mediaEventId.trim()
      ? input.mediaEventId.trim()
      : undefined;

  if (
    action === "generate_project_image" ||
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames"
  ) {
    const { count, targetIds } = resolveWorkflowImageStartTargets({ action, input, runtime });

    window.dispatchEvent(
      new CustomEvent("agent:image-generating-start", {
        detail: {
          count,
          action,
          ...(mediaEventId ? { mediaEventId } : {}),
          modelFamily: String(input.selectedImageModelFamily || input.modelFamily || ""),
          resolution:
            typeof input.resolution === "string"
              ? input.resolution
              : typeof input.imageGenerationPrefs === "object" &&
                  input.imageGenerationPrefs &&
                  "resolution" in input.imageGenerationPrefs
                ? String(input.imageGenerationPrefs.resolution || "")
                : "",
          aspectRatio:
            typeof input.aspectRatio === "string"
              ? input.aspectRatio
              : typeof input.imageGenerationPrefs === "object" &&
                  input.imageGenerationPrefs &&
                  "aspectRatio" in input.imageGenerationPrefs
                ? String(input.imageGenerationPrefs.aspectRatio || "")
                : "",
          contentSummary: buildMediaContentSummary({
            action,
            promptText: String(input.imagePrompt || input.prompt || promptText || ""),
            imageKind: String(input.imageKind || ""),
            runtime,
            targetIds,
          }),
          targetLabels: buildWorkflowMediaTargetLabels({
            action,
            runtime,
            targetIds,
          }),
        },
      }),
    );
    return;
  }

  if (action === "generate_video_assets") {
    const { count, targetIds, targetLabels } = resolveWorkflowVideoAssetStartTargets({
      input,
      runtime,
    });
    const model =
      typeof input.selectedVideoModelKey === "string"
        ? input.selectedVideoModelKey
        : typeof input.videoModelKey === "string"
          ? input.videoModelKey
          : typeof input.videoGenerationPrefs === "object" &&
              input.videoGenerationPrefs &&
              "modelKey" in input.videoGenerationPrefs
            ? String(input.videoGenerationPrefs.modelKey || "")
            : "";
    const mode =
      typeof input.videoGenerationPrefs === "object" &&
      input.videoGenerationPrefs &&
      "mode" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.mode || "")
        : "";
    window.dispatchEvent(
      new CustomEvent("agent:video-generating-start", {
        detail: {
          count,
          sceneCount: count,
          action,
          ...(mediaEventId ? { mediaEventId } : {}),
          model,
          resolution:
            typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "resolution" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.resolution || "")
              : "",
          aspectRatio:
            typeof input.aspectRatio === "string"
              ? input.aspectRatio
              : typeof input.videoGenerationPrefs === "object" &&
                  input.videoGenerationPrefs &&
                  "aspectRatio" in input.videoGenerationPrefs
                ? String((input.videoGenerationPrefs as { aspectRatio?: string }).aspectRatio || "")
                : "",
          mode,
          provider:
            typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "provider" in input.videoGenerationPrefs
              ? String((input.videoGenerationPrefs as { provider?: string }).provider || "")
              : "",
          routeHint: buildVideoGenerationRouteHint({
            project: runtime?.currentVideoProject,
            modelKey: model,
            mode,
            sceneIds: targetIds,
          }),
          contentSummary: buildMediaContentSummary({
            action,
            promptText: String(input.prompt || promptText || ""),
            runtime,
            targetIds,
          }),
          targetLabels,
        },
      }),
    );
    return;
  }

  if (action === "generate_segment_video") {
    const { count, segmentLabels, targetLabels } = resolveWorkflowSegmentVideoStartTargets({
      input,
      runtime,
    });
    const model =
      typeof input.selectedVideoModelKey === "string"
        ? input.selectedVideoModelKey
        : typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "modelKey" in input.videoGenerationPrefs
          ? String(input.videoGenerationPrefs.modelKey || "")
          : "";
    const mode =
      typeof input.videoGenerationPrefs === "object" &&
      input.videoGenerationPrefs &&
      "mode" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.mode || "")
        : "";
    const contentSummary =
      targetLabels?.length
        ? targetLabels.slice(0, 3).join(" · ")
        : segmentLabels?.length
          ? segmentLabels.slice(0, 3).join(" · ")
          : undefined;
    window.dispatchEvent(
      new CustomEvent("agent:video-generating-start", {
        detail: {
          count,
          sceneCount: count,
          action,
          ...(mediaEventId ? { mediaEventId } : {}),
          model,
          resolution:
            typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "resolution" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.resolution || "")
              : "",
          aspectRatio:
            typeof input.aspectRatio === "string"
              ? input.aspectRatio
              : typeof input.videoGenerationPrefs === "object" &&
                  input.videoGenerationPrefs &&
                  "aspectRatio" in input.videoGenerationPrefs
                ? String((input.videoGenerationPrefs as { aspectRatio?: string }).aspectRatio || "")
                : "",
          mode,
          routeHint: buildVideoGenerationRouteHint({
            project: runtime?.currentVideoProject,
            modelKey: model,
            mode,
            segmentLabels,
          }),
          contentSummary,
          targetLabels,
        },
      }),
    );
  }
}
