import type { PersistedVideoProject } from "@/hooks/use-local-persistence";

type VideoStepGateResult = {
  allowed: boolean;
  reason?: string;
};

function normalizeVideoStatus(status: string | undefined): string {
  const value = String(status || "").trim().toLowerCase();
  if (!value) return "";
  if (/(queued|pending|submitted)/.test(value)) return "queued";
  if (/(completed|success|succeeded|done)/.test(value)) return "completed";
  if (/(failed|error|cancel)/.test(value)) return "failed";
  return "processing";
}

function getManifestItems(project: PersistedVideoProject | null | undefined) {
  return project?.assetManifest?.items ?? [];
}

export function hasVideoEntities(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project && project.characters.length > 0 && project.sceneSettings.length > 0);
}

function hasReadyCharacterReference(project: PersistedVideoProject, characterId: string): boolean {
  const character = project.characters.find((item) => item.id === characterId);
  if (character?.imageUrl?.trim()) return true;
  if (character?.costumes?.some((item) => item.imageUrl?.trim())) return true;
  return getManifestItems(project).some((item) =>
    (item.kind === "character-reference" || item.kind === "costume-reference") &&
    item.status === "ready" &&
    item.sourceEntityId === characterId,
  );
}

function hasReadySceneReference(project: PersistedVideoProject, sceneSettingId: string): boolean {
  const sceneSetting = project.sceneSettings.find((item) => item.id === sceneSettingId);
  if (sceneSetting?.imageUrl?.trim()) return true;
  if (sceneSetting?.timeVariants?.some((item) => item.imageUrl?.trim())) return true;
  return getManifestItems(project).some((item) =>
    (item.kind === "scene-reference" || item.kind === "time-variant") &&
    item.status === "ready" &&
    item.sourceEntityId === sceneSettingId,
  );
}

export function hasMinimumVideoReferenceAssets(project: PersistedVideoProject | null | undefined): boolean {
  if (!project || !hasVideoEntities(project)) return false;
  return (
    project.characters.some((character) => hasReadyCharacterReference(project, character.id)) &&
    project.sceneSettings.some((sceneSetting) => hasReadySceneReference(project, sceneSetting.id))
  );
}

export function hasVideoStoryboardText(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project?.storyboardPlan?.trim());
}

export function countMissingVideoStoryboardFrames(project: PersistedVideoProject | null | undefined): number {
  if (!project?.scenes.length) return 0;
  const manifestSceneIds = new Set(
    getManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.status === "ready" && item.sceneId)
      .map((item) => item.sceneId!),
  );
  return project.scenes.filter((scene) => !scene.storyboardUrl?.trim() && !manifestSceneIds.has(scene.id)).length;
}

function hasAnyVideoStoryboardFrame(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(
    project?.scenes.some((scene) => scene.storyboardUrl?.trim()) ||
      getManifestItems(project).some((item) => item.kind === "storyboard-frame" && item.status === "ready"),
  );
}

export function hasMinimumVideoStoryboardFrames(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project?.scenes.length) && countMissingVideoStoryboardFrames(project) === 0;
}

export function hasReviewableVideoOutputs(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(
    project?.productionStateBundle?.directoryPath ||
      project?.scenes.some((scene) =>
        Boolean(scene.videoUrl?.trim()) || normalizeVideoStatus(scene.videoStatus) === "failed",
      ),
  );
}

export function hasCompleteTextToVideoPrompts(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  if (project.videoPromptBatch?.trim()) return true;
  const segmentLabels = [
    ...new Set(
      project.scenes
        .map((scene) => scene.segmentLabel?.trim())
        .filter((label): label is string => Boolean(label)),
    ),
  ];
  return (
    segmentLabels.length > 0 &&
    segmentLabels.every((label) => Boolean(project.segmentVideoPrompts?.[label]?.prompt?.trim()))
  );
}

export function hasAutoExportableVideoSegments(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  const groups = new Map<string, typeof project.scenes>();
  for (const scene of project.scenes) {
    const key = scene.segmentLabel?.trim() || "__single__";
    const group = groups.get(key) ?? [];
    group.push(scene);
    groups.set(key, group);
  }
  return [...groups.values()].some((scenes) =>
    scenes.length > 1 &&
    scenes.every((scene) => Boolean(scene.videoUrl?.trim()) && normalizeVideoStatus(scene.videoStatus) !== "failed"),
  );
}

export function deriveNaturalVideoStep(project: PersistedVideoProject | null | undefined): number {
  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
  if (hasReviewableVideoOutputs(project)) return 5;
  if (project?.videoPromptBatch?.trim()) return 4;
  if (!project?.scenes.length) return 1;
  if (mode !== "text-to-video" && (hasVideoStoryboardText(project) || hasAnyVideoStoryboardFrame(project))) {
    return hasMinimumVideoReferenceAssets(project) &&
      hasVideoStoryboardText(project) &&
      hasMinimumVideoStoryboardFrames(project)
      ? 4
      : 3;
  }
  if (!hasVideoEntities(project)) return 1;
  if (mode === "text-to-video") {
    return hasCompleteTextToVideoPrompts(project) ? 4 : 2;
  }
  if (!hasMinimumVideoReferenceAssets(project)) {
    return hasVideoStoryboardText(project) || hasAnyVideoStoryboardFrame(project) ? 3 : 2;
  }
  if (!hasVideoStoryboardText(project) || !hasMinimumVideoStoryboardFrames(project)) return 3;
  return 4;
}

export function canSwitchToVideoWorkflowStep(
  project: PersistedVideoProject | null | undefined,
  targetStep: number,
  mode: string = project?.videoGenerationPrefs?.mode ?? "image-to-video",
): VideoStepGateResult {
  if (targetStep <= 1) return { allowed: true };
  if (!project?.scenes.length) {
    return { allowed: false, reason: "当前还没有完成剧本拆解，不能切换到后续视频步骤。" };
  }
  if (targetStep === 2) return { allowed: true };

  const isTextToVideo = mode === "text-to-video";
  if (hasReviewableVideoOutputs(project)) {
    if (isTextToVideo && targetStep === 3) {
      return { allowed: false, reason: "文生视频模式没有分镜图生成步骤。" };
    }
    return { allowed: true };
  }

  if (targetStep === 3) {
    if (isTextToVideo) {
      return { allowed: false, reason: "文生视频模式会跳过分镜图生成步骤。" };
    }
    return hasMinimumVideoReferenceAssets(project)
      ? { allowed: true }
      : { allowed: false, reason: "至少需要角色和场景参考图各 1 张，才能进入分镜图生成。" };
  }

  if (targetStep === 4) {
    if (isTextToVideo) {
      return hasCompleteTextToVideoPrompts(project)
        ? { allowed: true }
        : { allowed: false, reason: "文生视频需要先补齐片段提示词或镜头提示词，才能进入视频生成。" };
    }
    return hasVideoStoryboardText(project) && hasMinimumVideoStoryboardFrames(project)
      ? { allowed: true }
      : { allowed: false, reason: "需要先完成分镜文本并补齐全部分镜图，才能进入视频生成。" };
  }

  if (targetStep === 5) {
    return hasReviewableVideoOutputs(project)
      ? { allowed: true }
      : { allowed: false, reason: "当前还没有可预览、失败待处理或已导出的生产结果。" };
  }

  return { allowed: false, reason: "不支持的视频工作流步骤。" };
}
