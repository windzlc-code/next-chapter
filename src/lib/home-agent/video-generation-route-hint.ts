import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { hasUsableMediaUrl } from "@/lib/home-agent/media-url";
import { videoModelSupportsMultiReferenceImages } from "@/lib/home-agent/video-models";

function pushUniqueVideoRouteReferenceUrl(target: string[], value?: string | null) {
  const normalized = String(value || "").trim();
  if (!hasUsableMediaUrl(normalized) || target.includes(normalized)) return;
  target.push(normalized);
}

function collectVideoRouteReferenceUrls(params: {
  project?: PersistedVideoProject | null;
  mode?: string;
  sceneIds?: string[];
  segmentLabels?: string[];
}): string[] {
  const project = params.project;
  const collected: string[] = [];
  const allScenes = project?.scenes ?? [];
  const scopedScenes = params.sceneIds?.length
    ? allScenes.filter((scene) => params.sceneIds!.includes(scene.id))
    : params.segmentLabels?.length
      ? allScenes.filter((scene) => {
          const segmentLabel = String(scene.segmentLabel || "").trim();
          return !!segmentLabel && params.segmentLabels!.includes(segmentLabel);
        })
      : allScenes;

  if (params.mode !== "text-to-video") {
    scopedScenes.forEach((scene) => {
      pushUniqueVideoRouteReferenceUrl(collected, scene.storyboardUrl);
      pushUniqueVideoRouteReferenceUrl(collected, scene.panoramaUrl);
    });
  }

  (project?.sceneSettings ?? []).forEach((setting) => {
    pushUniqueVideoRouteReferenceUrl(collected, setting.imageUrl);
    (setting.timeVariants ?? []).forEach((variant) =>
      pushUniqueVideoRouteReferenceUrl(collected, variant.imageUrl),
    );
  });

  (project?.characters ?? []).forEach((character) => {
    pushUniqueVideoRouteReferenceUrl(collected, character.imageUrl);
  });

  return collected;
}

export function buildVideoGenerationRouteHint(params: {
  project?: PersistedVideoProject | null;
  modelKey?: string | null;
  mode?: string;
  sceneIds?: string[];
  segmentLabels?: string[];
}): string {
  const mode = params.mode === "text-to-video" ? "text-to-video" : "image-to-video";
  const referenceCount = collectVideoRouteReferenceUrls({
    project: params.project,
    mode,
    sceneIds: params.sceneIds,
    segmentLabels: params.segmentLabels,
  }).length;
  const supportsMultiReference = videoModelSupportsMultiReferenceImages(params.modelKey);

  if (mode === "text-to-video") {
    return supportsMultiReference && referenceCount > 1
      ? "多图参考文生"
      : "纯文本文生";
  }

  if (supportsMultiReference && referenceCount > 1) {
    return "多图参考图生";
  }

  if (referenceCount > 0) {
    return "首帧图生";
  }

  return "图生视频";
}
