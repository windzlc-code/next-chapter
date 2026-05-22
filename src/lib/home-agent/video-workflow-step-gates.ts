import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { hasUsableMediaUrl } from "@/lib/home-agent/media-url";

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

function parseVideoEpisodeNumber(raw: string): number {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return Number.NaN;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (trimmed === "十") return 10;
  if (trimmed.startsWith("十")) {
    return 10 + (digitMap[trimmed.slice(1)] ?? 0);
  }
  if (trimmed.endsWith("十")) {
    return (digitMap[trimmed[0]] ?? 0) * 10;
  }
  const tenIndex = trimmed.indexOf("十");
  if (tenIndex > 0) {
    const tens = digitMap[trimmed.slice(0, tenIndex)] ?? 0;
    const ones = digitMap[trimmed.slice(tenIndex + 1)] ?? 0;
    return tens * 10 + ones;
  }

  return trimmed.split("").reduce((acc, char) => acc * 10 + (digitMap[char] ?? 0), 0);
}

function listVideoScriptEpisodeNumbers(script: string): number[] {
  const episodeNumbers = new Set<number>();
  const pattern = /(?:^|\n)\s*(?:EP\s*(\d+)|第\s*([零一二三四五六七八九十\d]+)\s*[集话期章]|Episode\s+(\d+))/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    const raw = match[1] || match[2] || match[3] || "";
    const episodeNumber = parseVideoEpisodeNumber(raw);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

function listVideoSceneEpisodeNumbers(scenes: PersistedVideoProject["scenes"]): number[] {
  const episodeNumbers = new Set<number>();
  for (const scene of scenes ?? []) {
    const match = String(scene.segmentLabel || "").trim().match(/^(\d+)-/);
    if (!match) continue;
    const episodeNumber = Number(match[1]);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

export function hasIncompleteVideoEpisodeCoverage(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  const scriptEpisodes = listVideoScriptEpisodeNumbers(project.script || "");
  if (scriptEpisodes.length <= 1) return false;
  const sceneEpisodes = new Set(listVideoSceneEpisodeNumbers(project.scenes));
  return scriptEpisodes.some((episodeNumber) => !sceneEpisodes.has(episodeNumber));
}

export function hasPassedVideoScriptBreakdown(project: PersistedVideoProject | null | undefined): boolean {
  if (!project) return false;
  if (typeof project.scriptBreakdownPassed === "boolean") {
    return project.scriptBreakdownPassed && (!project.scenes.length || !hasIncompleteVideoEpisodeCoverage(project));
  }
  if (!project.scenes.length) {
    return Boolean(
      project.characters.length ||
      project.sceneSettings.length ||
      project.storyboardPlan?.trim() ||
      project.shotPackets?.length ||
      project.videoPromptBatch?.trim() ||
      project.productionStateBundle?.directoryPath,
    );
  }
  if (hasIncompleteVideoEpisodeCoverage(project)) return false;
  return true;
}

function getManifestItems(project: PersistedVideoProject | null | undefined) {
  return project?.assetManifest?.items ?? [];
}

export function hasVideoEntities(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project && project.characters.length > 0 && project.sceneSettings.length > 0);
}

function hasReadyCharacterReference(project: PersistedVideoProject, characterId: string): boolean {
  const character = project.characters.find((item) => item.id === characterId);
  if (hasUsableMediaUrl(character?.imageUrl)) return true;
  if (character?.costumes?.some((item) => hasUsableMediaUrl(item.imageUrl))) return true;
  return getManifestItems(project).some((item) =>
    (item.kind === "character-reference" || item.kind === "costume-reference") &&
    item.status === "ready" &&
    hasUsableMediaUrl(item.url) &&
    item.sourceEntityId === characterId,
  );
}

function hasReadySceneReference(project: PersistedVideoProject, sceneSettingId: string): boolean {
  const sceneSetting = project.sceneSettings.find((item) => item.id === sceneSettingId);
  if (hasUsableMediaUrl(sceneSetting?.imageUrl)) return true;
  if (sceneSetting?.timeVariants?.some((item) => hasUsableMediaUrl(item.imageUrl))) return true;
  return getManifestItems(project).some((item) =>
    (item.kind === "scene-reference" || item.kind === "time-variant") &&
    item.status === "ready" &&
    hasUsableMediaUrl(item.url) &&
    item.sourceEntityId === sceneSettingId,
  );
}

function hasPrimaryCharacterReference(project: PersistedVideoProject, characterId: string): boolean {
  const character = project.characters.find((item) => item.id === characterId);
  if (hasUsableMediaUrl(character?.imageUrl)) return true;
  return getManifestItems(project).some((item) =>
    item.kind === "character-reference" &&
    item.status === "ready" &&
    hasUsableMediaUrl(item.url) &&
    item.sourceEntityId === characterId,
  );
}

function hasPrimarySceneReference(project: PersistedVideoProject, sceneSettingId: string): boolean {
  const sceneSetting = project.sceneSettings.find((item) => item.id === sceneSettingId);
  if (hasUsableMediaUrl(sceneSetting?.imageUrl)) return true;
  return getManifestItems(project).some((item) =>
    item.kind === "scene-reference" &&
    item.status === "ready" &&
    hasUsableMediaUrl(item.url) &&
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

export function hasCompleteVideoReferenceAssets(project: PersistedVideoProject | null | undefined): boolean {
  if (!project || !hasVideoEntities(project)) return false;
  return (
    project.characters.every((character) =>
      hasPrimaryCharacterReference(project, character.id) &&
      (character.costumes ?? []).every((variant) => hasUsableMediaUrl(variant.imageUrl)),
    ) &&
    project.sceneSettings.every((sceneSetting) =>
      hasPrimarySceneReference(project, sceneSetting.id) &&
      (sceneSetting.timeVariants ?? []).every((variant) => hasUsableMediaUrl(variant.imageUrl)),
    )
  );
}

export function hasVideoStoryboardText(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project?.storyboardPlan?.trim());
}

export function countMissingVideoStoryboardFrames(project: PersistedVideoProject | null | undefined): number {
  if (!project?.scenes.length) return 0;
  const manifestSceneIds = new Set(
    getManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.status === "ready" && hasUsableMediaUrl(item.url) && item.sceneId)
      .map((item) => item.sceneId!),
  );
  return project.scenes.filter((scene) => !hasUsableMediaUrl(scene.storyboardUrl) && !manifestSceneIds.has(scene.id)).length;
}

function hasAnyVideoStoryboardFrame(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(
    project?.scenes.some((scene) => hasUsableMediaUrl(scene.storyboardUrl)) ||
      getManifestItems(project).some((item) => item.kind === "storyboard-frame" && item.status === "ready" && hasUsableMediaUrl(item.url)),
  );
}

export function hasMinimumVideoStoryboardFrames(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(project?.scenes.length) && countMissingVideoStoryboardFrames(project) === 0;
}

export function hasReviewableVideoOutputs(project: PersistedVideoProject | null | undefined): boolean {
  const hasSegmentOutputs = listReadySegmentVideoLabels(project).length > 0;
  const hasSegmentFailures = hasFailedSegmentVideoOutputs(project);
  return Boolean(
    project?.productionStateBundle?.directoryPath ||
      project?.scenes.some((scene) =>
        Boolean(scene.videoUrl?.trim()) || normalizeVideoStatus(scene.videoStatus) === "failed",
      ) ||
      hasSegmentOutputs ||
      hasSegmentFailures,
  );
}

export function hasCompleteTextToVideoSegmentPrompts(
  project: PersistedVideoProject | null | undefined,
): boolean {
  if (!project?.scenes.length) return false;
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

export function hasCompleteTextToVideoShotPrompts(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  if (project.videoPromptBatch?.trim()) return true;
  return project.scenes.every((scene) => Boolean(scene.enhancedVideoPrompt?.trim()));
}

export function hasCompleteTextToVideoPrompts(project: PersistedVideoProject | null | undefined): boolean {
  return hasCompleteTextToVideoSegmentPrompts(project) || hasCompleteTextToVideoShotPrompts(project);
}

function listOrderedSegmentLabels(project: PersistedVideoProject | null | undefined): string[] {
  if (!project?.scenes.length) return [];
  const labels: string[] = [];
  [...project.scenes]
    .sort((left, right) => left.sceneNumber - right.sceneNumber)
    .forEach((scene) => {
      const label = scene.segmentLabel?.trim();
      if (label && !labels.includes(label)) {
        labels.push(label);
      }
    });
  return labels;
}

function listReadySegmentVideoLabels(project: PersistedVideoProject | null | undefined): string[] {
  if (!project) return [];
  const segmentVideos = project.segmentVideos ?? {};
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  return listOrderedSegmentLabels(project).filter((label) => {
    if (!segmentVideos[label]?.trim()) return false;
    return normalizeVideoStatus(segmentStatuses[label]?.status) !== "failed";
  });
}

function hasFailedSegmentVideoOutputs(project: PersistedVideoProject | null | undefined): boolean {
  if (!project) return false;
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  return listOrderedSegmentLabels(project).some(
    (label) =>
      normalizeVideoStatus(segmentStatuses[label]?.status) === "failed" &&
      !project.segmentVideos?.[label]?.trim(),
  );
}

export function hasAutoExportableVideoSegments(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  if ((project.videoGenerationPrefs?.mode ?? "image-to-video") === "text-to-video") {
    return listReadySegmentVideoLabels(project).length > 0;
  }
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

export function hasCompleteVideoOutputs(project: PersistedVideoProject | null | undefined): boolean {
  if (project?.productionStateBundle?.directoryPath) return true;
  if (!project?.scenes.length) return false;
  if ((project.videoGenerationPrefs?.mode ?? "image-to-video") === "text-to-video") {
    const labels = listOrderedSegmentLabels(project);
    if (!labels.length) return false;
    const segmentVideos = project.segmentVideos ?? {};
    const segmentStatuses = project.segmentVideoStatuses ?? {};
    return labels.every(
      (label) =>
        Boolean(segmentVideos[label]?.trim()) &&
        normalizeVideoStatus(segmentStatuses[label]?.status) !== "failed",
    );
  }
  return project.scenes.every(
    (scene) => Boolean(scene.videoUrl?.trim()) && normalizeVideoStatus(scene.videoStatus) !== "failed",
  );
}

export function deriveNaturalVideoStep(project: PersistedVideoProject | null | undefined): number {
  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
  if (!hasPassedVideoScriptBreakdown(project)) return 1;
  if (hasCompleteVideoOutputs(project)) return 5;
  if (!hasVideoEntities(project)) return 1;
  if (mode === "text-to-video") {
    return hasCompleteVideoReferenceAssets(project) &&
      Boolean(project.shotPackets?.length) &&
      hasCompleteTextToVideoPrompts(project)
      ? 4
      : 2;
  }
  if (!hasCompleteVideoReferenceAssets(project)) {
    return hasVideoStoryboardText(project) || hasAnyVideoStoryboardFrame(project) ? 3 : 2;
  }
  if (
    !hasVideoStoryboardText(project) ||
    !hasMinimumVideoStoryboardFrames(project) ||
    !project?.videoPromptBatch?.trim()
  ) {
    return 3;
  }
  return 4;
}

export function canSwitchToVideoWorkflowStep(
  project: PersistedVideoProject | null | undefined,
  targetStep: number,
  mode: string = project?.videoGenerationPrefs?.mode ?? "image-to-video",
): VideoStepGateResult {
  if (targetStep <= 1) return { allowed: true };
  if (!hasPassedVideoScriptBreakdown(project)) {
    return { allowed: false, reason: "当前剧本拆解还没通过内部检查，不能切换到后续视频步骤。" };
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
      return project?.shotPackets?.length
        ? { allowed: true }
        : { allowed: false, reason: "文生视频需要先编译镜头包，才能进入视频生成。" };
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
