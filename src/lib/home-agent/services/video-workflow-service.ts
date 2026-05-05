import {
  createStoredVideoProject,
  loadStoredVideoProjectById,
  type PersistedVideoProject,
  upsertStoredVideoProject,
} from "@/hooks/use-local-persistence";
import { invokeFunction } from "@/lib/invoke-with-key";
import {
  getApiConfig,
  isArkJimengEndpoint,
  prefersJimengCli,
  resolveJimengApiKey,
} from "@/lib/api-config";
import { dreaminaCliGetStatus } from "@/lib/dreamina-cli";
import {
  buildCharacterAssetFileStem,
  buildCharacterAssetLabel,
  buildSceneAssetFileStem,
  buildSceneAssetLabel,
  buildSegmentVideoFileStem,
  buildSegmentVideoLabel,
  buildStoryboardAssetFileStem,
  buildStoryboardAssetLabel,
  buildVideoAssetFileStem,
  resolveNextAssetVersion,
} from "@/lib/home-agent/asset-naming";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import { buildStoryboardBreakdownMessage } from "@/lib/home-agent/storyboard-breakdown";
import { cacheProjectVideoSource } from "@/lib/home-agent/video-cache";
import {
  getVideoImageGenerationBatchLimit,
  normalizeVideoImageGenerationPrefs,
  resolveVideoImageProjectArtStyle,
  resolveVideoImagePromptStyle,
  resolveVideoImageRequestPrefs,
} from "@/lib/home-agent/image-models";
import {
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
  getVideoModelMaxDuration,
  VIDEO_SEGMENT_DESIGN_DURATION,
} from "@/lib/home-agent/video-models";
import {
  canSwitchToVideoWorkflowStep,
  deriveNaturalVideoStep,
} from "@/lib/home-agent/video-workflow-step-gates";
import type { WorkflowActionResult, StudioRuntimeState, WorkflowActionProgressCallback } from "@/lib/home-agent/types";
import {
  deriveVideoStyleLock,
  deriveVideoShotPackets,
  synchronizeVideoProductionState,
} from "@/lib/home-agent/video-production-memory";
import type {
  ArtStyle,
  CostumeSetting,
  CharacterSetting,
  Scene,
  SceneSetting,
  TimeVariantSetting,
  VideoImageGenerationPrefs,
  SegmentVideoPrompt,
  SegmentVideoStatus,
  VideoShotPacket,
} from "@/types/project";

interface VideoEnhanceResult {
  enhanced: string;
  duration?: number;
  durationReason?: string;
}

interface ExtractedVariantResult {
  label?: string;
  description?: string;
}

interface ExtractEntitiesResult {
  characters?: Array<{ name?: string; description?: string; costumes?: ExtractedVariantResult[] }>;
  sceneSettings?: Array<{ name?: string; description?: string; timeVariants?: ExtractedVariantResult[] }>;
}

interface DecomposeResult {
  scenes?: Array<Partial<Scene>>;
}

type DecomposeProgressPayload = {
  scenes?: Array<Partial<Scene>>;
  chunkIndex?: number;
  totalChunks?: number;
  status?: "init" | "processing" | "done" | "failed" | "cancelled";
  failedChunks?: number[];
  retryAttempt?: number;
};

interface VideoGenerationResult {
  task_id: string;
  status: string;
  provider?: string;
}

interface VideoGenerationStatusResult {
  status: string;
  video_url?: string;
  state?: string;
}

const EXACT_DIALOGUE_LOCK_HEADING = "【精确台词锁定】";
const NO_DIALOGUE_LOCK_HEADING = "【无台词锁定】";

const VIDEO_WORKFLOW_GENERATION_ABORT_KEY = "video-workflow-generation";
const activeVideoAbortControllers = new Map<string, AbortController>();

export function abortVideoWorkflowGeneration(): void {
  const controller = activeVideoAbortControllers.get(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
  if (controller) {
    controller.abort();
    activeVideoAbortControllers.delete(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
  }
}

function summarizeVideoGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "视频生成失败，请检查当前运行通道与提示词后重试。";
  return truncate(normalized, 120);
}

function logVideoWorkflowSceneEvent(
  stage: "submit" | "status" | "result" | "warning",
  detail: Record<string, unknown>,
): void {
  const entries = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  const message = `[video-workflow] ${stage}${entries.length ? ` ${entries.join(" ")}` : ""}`;
  if (stage === "warning") {
    console.warn(message);
    return;
  }
  console.log(message);
}

function splitExactDialogueLines(dialogue: string | null | undefined): string[] {
  return String(dialogue || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildExactDialogueLockBlock(dialogue: string | null | undefined): string {
  const lines = splitExactDialogueLines(dialogue);
  if (!lines.length) {
    return [
      NO_DIALOGUE_LOCK_HEADING,
      "本镜头没有剧本台词。成片不得新增任何角色对白、旁白、画外音、心声或其他可听语言内容。",
    ].join("\n");
  }

  return [
    EXACT_DIALOGUE_LOCK_HEADING,
    "以下台词来自剧本拆解，必须在成片音频、口型或旁白中逐字出现。不得改写、增删、同义替换、换序或遗漏；不得新增未列出的台词。",
    ...lines.map((line, index) => `${index + 1}. ${line}`),
    "执行说明：角色名前缀用于指定说话人；“旁白：”用于画外音/旁白。可以调整语气、停顿和情绪，但文字内容必须完全一致。",
  ].join("\n");
}

function appendExactDialogueLock(prompt: string, dialogue: string | null | undefined): string {
  const rawPrompt = String(prompt || "").trim();
  const lockIndexes = [
    rawPrompt.indexOf(EXACT_DIALOGUE_LOCK_HEADING),
    rawPrompt.indexOf(NO_DIALOGUE_LOCK_HEADING),
  ].filter((index) => index >= 0);
  const basePrompt = lockIndexes.length ? rawPrompt.slice(0, Math.min(...lockIndexes)).trim() : rawPrompt;
  const lockBlock = buildExactDialogueLockBlock(dialogue);
  return [basePrompt, lockBlock].filter(Boolean).join("\n\n");
}

function stripExactDialogueLockBlock(prompt: string | null | undefined): string {
  const rawPrompt = String(prompt || "").trim();
  const lockIndexes = [
    rawPrompt.indexOf(EXACT_DIALOGUE_LOCK_HEADING),
    rawPrompt.indexOf(NO_DIALOGUE_LOCK_HEADING),
  ].filter((index) => index >= 0);
  return lockIndexes.length ? rawPrompt.slice(0, Math.min(...lockIndexes)).trim() : rawPrompt;
}

function collectSegmentDialogueLock(scenes: Scene[]): string {
  const lines = scenes.flatMap((scene) => splitExactDialogueLines(scene.dialogue));
  return lines.join("\n");
}

function withExactDialogueLock(
  result: VideoEnhanceResult,
  dialogue: string | null | undefined,
): VideoEnhanceResult {
  return {
    ...result,
    enhanced: appendExactDialogueLock(result.enhanced, dialogue),
  };
}

export interface VideoWorkflowContinuationPlan {
  actionKind:
    | "analyze_script_for_video"
    | "extract_video_entities"
    | "generate_video_reference_assets"
    | "prepare_storyboard_batch"
    | "generate_storyboard_frames"
    | "compile_video_shot_packets"
    | "prepare_video_prompt_batch"
    | "generate_video_assets"
    | "export_storyboard_xlsx"
    | "create_video_bridge_artifact";
  policy:
    | "bootstrap-analysis"
    | "bootstrap-entities"
    | "bootstrap-reference-assets"
    | "bootstrap-storyboard-text"
    | "bootstrap-storyboard-frames"
    | "bootstrap-shot-packets"
    | "bootstrap-prompt-batch"
    | "refresh-running"
    | "repair-failed"
    | "generate-next-batch"
    | "bridge-summary";
  input: Record<string, unknown>;
  reason: string;
  targetCount?: number;
  totalTargetCount?: number;
  remainingTargetCount?: number;
}

const VIDEO_ROUND_TERMINAL_POLICIES = new Set<VideoWorkflowContinuationPlan["policy"]>([
  "bootstrap-analysis",
  "bootstrap-entities",
  "bootstrap-reference-assets",
  "bootstrap-storyboard-text",
  "bootstrap-storyboard-frames",
  "bootstrap-shot-packets",
  "bootstrap-prompt-batch",
  "refresh-running",
  "repair-failed",
  "generate-next-batch",
  "bridge-summary",
]);

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function appendImageHistory(
  currentUrl: string | undefined,
  nextUrl: string | undefined,
  description: string,
  previousHistory: Array<{ imageUrl: string; description: string; createdAt: string }> | undefined,
) {
  if (!currentUrl || currentUrl === nextUrl) return previousHistory || [];
  if (previousHistory?.some((entry) => entry.imageUrl === currentUrl)) {
    return previousHistory;
  }

  return [
    ...(previousHistory || []),
    {
      imageUrl: currentUrl,
      description,
      createdAt: new Date().toISOString(),
    },
  ];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeName(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

type EntityVariantKind = "costume" | "scene-time";

type EntityVariantLike = {
  id: string;
  label: string;
  description: string;
  imageUrl?: string;
  isAIGenerated: boolean;
  imageHistory?: Array<{ imageUrl: string; description: string; createdAt: string }>;
};

const COSTUME_CORE_TERMS = [
  "日常装",
  "便服",
  "常服",
  "校服",
  "制服",
  "婚纱",
  "礼服",
  "旗袍",
  "睡衣",
  "浴袍",
  "长裙",
  "短裙",
  "红衣",
  "白衣",
  "黑衣",
  "青衣",
  "战甲",
  "铠甲",
  "盔甲",
  "披风",
  "斗篷",
  "官服",
  "军装",
  "西装",
].sort((a, b) => b.length - a.length);

const COSTUME_STATE_TERMS = [
  "战损",
  "破损",
  "染血",
  "血污",
  "受伤",
  "伪装",
  "男装",
  "女装",
  "少年",
  "成年",
  "老年",
  "病弱",
].sort((a, b) => b.length - a.length);

function normalizeVariantLabel(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[【】「」『』《》()（）[\]{}"'“”‘’、，,。.!！?？:：;；\s_-]+/g, "")
    .replace(/颜色/g, "色")
    .replace(/暗红色/g, "暗红")
    .replace(/绛红色/g, "绛红")
    .replace(/深红色/g, "深红");
}

function resolveCostumeVariantKey(label: string): string {
  const normalized = normalizeVariantLabel(label);
  if (!normalized) return "";

  const core = COSTUME_CORE_TERMS.find((term) => normalized.includes(term));
  if (!core) return normalized;

  const state = COSTUME_STATE_TERMS.find((term) => normalized.includes(term));
  return state ? `${state}:${core}` : core;
}

function resolveSceneTimeVariantKey(label: string): string {
  const normalized = normalizeVariantLabel(label);
  if (!normalized) return "";

  const time =
    /(?:夜|夜晚|夜间|夜景|雨夜|雷雨夜|深夜)/.test(normalized) ? "夜间" :
    /(?:清晨|晨间|早晨|黎明|拂晓)/.test(normalized) ? "清晨" :
    /(?:黄昏|傍晚|夕阳|日落)/.test(normalized) ? "黄昏" :
    /(?:正午|中午|午间)/.test(normalized) ? "正午" :
    /(?:日间|白天|白昼|日景|晴天|上午|下午)/.test(normalized) ? "日间" :
    "";
  const weather =
    /(?:雷雨|暴雨|大雨|雨夜|雨天|雨中|下雨|雨)/.test(normalized) ? "雨" :
    /(?:暴雪|大雪|雪夜|雪天|雪中|下雪|雪)/.test(normalized) ? "雪" :
    /(?:浓雾|雾天|雾中|雾)/.test(normalized) ? "雾" :
    /(?:阴天|阴沉|阴云)/.test(normalized) ? "阴" :
    /(?:晴天|晴朗)/.test(normalized) ? "晴" :
    "";
  const state =
    /(?:断电|停电|熄灯)/.test(normalized) ? "断电" :
    /(?:火灾后|火灾|火场|火后)/.test(normalized) ? "火灾" :
    /(?:废墟|战后|毁坏|坍塌)/.test(normalized) ? "毁坏" :
    "";

  return [weather, time, state].filter(Boolean).join(":") || normalized;
}

function resolveVariantKey(label: string, kind: EntityVariantKind): string {
  return kind === "costume"
    ? resolveCostumeVariantKey(label)
    : resolveSceneTimeVariantKey(label);
}

function areVariantLabelsEquivalent(
  leftLabel: string,
  rightLabel: string,
  kind: EntityVariantKind,
): boolean {
  const left = normalizeVariantLabel(leftLabel);
  const right = normalizeVariantLabel(rightLabel);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftKey = resolveVariantKey(leftLabel, kind);
  const rightKey = resolveVariantKey(rightLabel, kind);
  if (leftKey && rightKey && leftKey === rightKey) return true;

  return false;
}

function chooseMergedVariantLabel(
  currentLabel: string,
  nextLabel: string,
  hasCurrentImage: boolean,
): string {
  if (hasCurrentImage) return currentLabel;
  const current = normalizeVariantLabel(currentLabel);
  const next = normalizeVariantLabel(nextLabel);
  if (!current) return nextLabel;
  if (!next) return currentLabel;
  if (next.includes(current) && next.length > current.length) return nextLabel;
  return currentLabel;
}

function chooseMergedVariantDescription(currentDescription: string, nextDescription: string): string {
  const current = currentDescription.trim();
  const next = nextDescription.trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function mergeEntityVariant<T extends EntityVariantLike>(current: T, next: T): T {
  return {
    ...current,
    label: chooseMergedVariantLabel(current.label, next.label, Boolean(current.imageUrl?.trim())),
    description: chooseMergedVariantDescription(current.description, next.description),
    imageUrl: current.imageUrl || next.imageUrl,
    isAIGenerated: current.isAIGenerated || next.isAIGenerated,
    imageHistory: current.imageHistory || next.imageHistory,
  };
}

function findMatchedVariantIndex<T extends { label: string }>(
  items: T[],
  label: string,
  kind: EntityVariantKind,
  usedIndexes?: Set<number>,
): number {
  return items.findIndex(
    (item, candidateIndex) =>
      !usedIndexes?.has(candidateIndex) &&
      areVariantLabelsEquivalent(item.label, label, kind),
  );
}

function dedupeEntityVariants<T extends EntityVariantLike>(
  variants: T[],
  kind: EntityVariantKind,
): T[] {
  const deduped: T[] = [];
  for (const variant of variants) {
    const existingIndex = findMatchedVariantIndex(deduped, variant.label, kind);
    if (existingIndex < 0) {
      deduped.push(variant);
      continue;
    }

    const existing = deduped[existingIndex]!;
    if (existing.imageUrl?.trim() && variant.imageUrl?.trim() && existing.imageUrl !== variant.imageUrl) {
      deduped.push(variant);
      continue;
    }

    deduped[existingIndex] = mergeEntityVariant(existing, variant);
  }
  return deduped;
}

function buildVideoTitle(runtime: StudioRuntimeState, input: Record<string, unknown>): string {
  if (typeof input.title === "string" && input.title.trim()) {
    return input.title.trim();
  }
  if (runtime.currentVideoProject?.title?.trim()) {
    return runtime.currentVideoProject.title.trim();
  }
  if (runtime.currentDramaProject?.dramaTitle?.trim()) {
    return runtime.currentDramaProject.dramaTitle.trim();
  }
  if (runtime.currentProjectSnapshot?.title?.trim()) {
    return runtime.currentProjectSnapshot.title.trim();
  }
  return "未命名视频项目";
}

function buildScriptFromDrama(runtime: StudioRuntimeState): string {
  const drama = runtime.currentDramaProject;
  if (!drama) return "";
  if (drama.exportDocument.trim()) return drama.exportDocument;
  if (drama.episodes.length > 0) {
    return drama.episodes
      .map((episode) => `第${episode.number}集：${episode.title}\n${episode.content}`)
      .join("\n\n---\n\n");
  }
  if (drama.creativePlan.trim()) return drama.creativePlan;
  if (drama.structureTransform.trim()) return drama.structureTransform;
  return "";
}

function resolveWorkingScript(
  runtime: StudioRuntimeState,
  project: PersistedVideoProject | null,
  input: Record<string, unknown>,
): string {
  if (typeof input.script === "string" && input.script.trim()) {
    return input.script.trim();
  }
  if (project?.script?.trim()) return project.script.trim();
  const dramaScript = buildScriptFromDrama(runtime);
  if (dramaScript.trim()) return dramaScript.trim();
  if (runtime.currentProjectSnapshot?.artifacts?.length) {
    const artifactWithContent = runtime.currentProjectSnapshot.artifacts.find((artifact) => artifact.content?.trim());
    if (artifactWithContent?.content?.trim()) {
      return artifactWithContent.content.trim();
    }
  }
  return "";
}

function readTextInput(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" && String(input[key]).trim()
    ? String(input[key]).trim()
    : undefined;
}

function buildVideoContextSummary(project: PersistedVideoProject): string {
  return [
    project.targetPlatform?.trim()
      ? `目标平台：${project.targetPlatform.trim()}`
      : null,
    project.shotStyle?.trim() ? `镜头风格：${project.shotStyle.trim()}` : null,
    project.outputGoal?.trim() ? `出片目标：${project.outputGoal.trim()}` : null,
    project.productionNotes?.trim()
      ? `补充说明：${truncate(project.productionNotes.trim(), 160)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeVideoInputContext(
  project: PersistedVideoProject,
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): PersistedVideoProject {
  const requestedImageGenerationPrefs =
    typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
      ? normalizeVideoImageGenerationPrefs({
          ...(project.imageGenerationPrefs ?? {}),
          ...(input.imageGenerationPrefs as Partial<VideoImageGenerationPrefs>),
        })
      : project.imageGenerationPrefs;
  const fallbackArtStyle =
    typeof input.artStyle === "string"
      ? (input.artStyle as ArtStyle)
      : project.artStyle || "live-action";
  const artStyle = requestedImageGenerationPrefs
    ? resolveVideoImageProjectArtStyle(requestedImageGenerationPrefs, fallbackArtStyle)
    : fallbackArtStyle;
  const mergedProject = {
    ...project,
    title: buildVideoTitle(runtime, input),
    script: resolveWorkingScript(runtime, project, input),
    artStyle,
    ...(requestedImageGenerationPrefs ? { imageGenerationPrefs: requestedImageGenerationPrefs } : {}),
    systemPrompt: readTextInput(input, "systemPrompt") || project.systemPrompt || "",
    targetPlatform: readTextInput(input, "targetPlatform") || project.targetPlatform || "",
    shotStyle: readTextInput(input, "shotStyle") || project.shotStyle || "",
    outputGoal: readTextInput(input, "outputGoal") || project.outputGoal || "",
    productionNotes:
      readTextInput(input, "productionNotes") ||
      readTextInput(input, "customInstruction") ||
      project.productionNotes ||
      "",
    sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
  };
  return {
    ...mergedProject,
    styleLock: deriveVideoStyleLock(mergedProject),
  };
}

function resolveProjectImagePromptStyle(
  project: Pick<PersistedVideoProject, "artStyle" | "imageGenerationPrefs">,
): string {
  return resolveVideoImagePromptStyle(
    project.imageGenerationPrefs,
    project.artStyle || "live-action",
  );
}

function buildScopedImageGenerationInput(
  input: Record<string, unknown>,
  options?: { allowStoryboardMode?: boolean; allowReferenceImage?: boolean; allowViewMode?: boolean },
): Record<string, unknown> {
  const nextInput: Record<string, unknown> = {};
  const imageGenerationPrefs =
    typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
      ? (input.imageGenerationPrefs as Record<string, unknown>)
      : null;
  const modelFamily =
    typeof input.modelFamily === "string" && input.modelFamily.trim()
      ? input.modelFamily.trim()
      : typeof input.selectedImageModelFamily === "string" && input.selectedImageModelFamily.trim()
        ? input.selectedImageModelFamily.trim()
        : "";

  if (typeof input.model === "string" && input.model.trim()) {
    nextInput.model = input.model.trim();
  }
  if (modelFamily) {
    nextInput.modelFamily = modelFamily;
    nextInput.selectedImageModelFamily = modelFamily;
  }
  if (typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs) {
    nextInput.imageGenerationPrefs = input.imageGenerationPrefs;
  }
  if (typeof input.aspectRatio === "string" && input.aspectRatio.trim()) {
    nextInput.aspectRatio = input.aspectRatio.trim();
  }
  if (typeof input.resolution === "string" && input.resolution.trim()) {
    nextInput.resolution = input.resolution.trim();
  }
  if (options?.allowStoryboardMode && input.mode === "panorama") {
    nextInput.mode = "panorama";
  }
  if (options?.allowReferenceImage && typeof input.referenceImageUrl === "string" && input.referenceImageUrl.trim()) {
    nextInput.referenceImageUrl = input.referenceImageUrl.trim();
  }
  const requestedViewMode =
    typeof input.viewMode === "string" && input.viewMode.trim()
      ? input.viewMode.trim()
      : imageGenerationPrefs && typeof imageGenerationPrefs.viewMode === "string"
        ? imageGenerationPrefs.viewMode.trim()
        : "";
  if (options?.allowViewMode && requestedViewMode) {
    nextInput.viewMode = requestedViewMode;
  }

  return nextInput;
}

function resolveSmartReferenceAssetBatchLimit(input: Record<string, unknown>): number {
  const resolved = resolveVideoImageRequestPrefs({
    imageGenerationPrefs:
      typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
        ? input.imageGenerationPrefs as never
        : null,
    modelFamily:
      typeof input.modelFamily === "string" && input.modelFamily.trim()
        ? input.modelFamily
        : typeof input.selectedImageModelFamily === "string" && input.selectedImageModelFamily.trim()
          ? input.selectedImageModelFamily
          : undefined,
    resolution: typeof input.resolution === "string" ? input.resolution : undefined,
    aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : undefined,
  });
  const modelLimit = getVideoImageGenerationBatchLimit(resolved.prefs);
  const requestedLimit = Number(input.maxImageCount ?? input.maxImagesPerRun ?? input.batchLimit);

  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) return modelLimit;
  return Math.max(1, Math.min(modelLimit, Math.floor(requestedLimit)));
}

function inferProjectImageKind(imagePrompt: string): "character" | "scene" {
  if (
    /(?:角色|人物|人像|肖像|头像|半身像|全身像|立绘|主角|女主|男主|portrait|character|person|people|face|hero|heroine|man|woman|girl|boy)/i.test(
      imagePrompt,
    )
  ) {
    return "character";
  }

  return "scene";
}

function resolveRequestedProjectImageKind(
  input: Record<string, unknown>,
  imagePrompt: string,
): "character" | "scene" {
  return input.imageKind === "character" || input.imageKind === "scene"
    ? input.imageKind
    : inferProjectImageKind(imagePrompt);
}

function withVideoProject(
  runtime: StudioRuntimeState,
  project: PersistedVideoProject,
): StudioRuntimeState {
  return {
    ...runtime,
    currentVideoProject: project,
    currentProjectSnapshot: createVideoSnapshot(project),
  };
}

function batchSceneRange(
  scenes: Scene[],
  size: number,
): { sceneStart: number; sceneEnd: number } {
  const start = scenes[0]?.sceneNumber ?? 1;
  const end = Math.min(start + size - 1, scenes.at(-1)?.sceneNumber ?? start);
  return { sceneStart: start, sceneEnd: end };
}

function resolveEpisodeDuration(
  input: Record<string, unknown>,
  project: PersistedVideoProject,
): number | null {
  const candidate =
    typeof input.episodeDuration === "number" && Number.isFinite(input.episodeDuration)
      ? input.episodeDuration
      : typeof project.preferredEpisodeDurationSeconds === "number" &&
          Number.isFinite(project.preferredEpisodeDurationSeconds)
        ? project.preferredEpisodeDurationSeconds
        : null;

  return candidate ? Math.max(1, Math.round(candidate)) : null;
}

function deriveSegmentsPerEpisode(durationSeconds: number | null): number {
  if (!durationSeconds) return 5;
  return Math.max(1, Math.round(durationSeconds / 15));
}

function listFailedSceneIds(project: PersistedVideoProject): string[] {
  return project.scenes
    .filter((scene) => normalizeSceneStatus(scene.videoStatus) === "failed")
    .map((scene) => scene.id);
}

function listRunningSceneIds(project: PersistedVideoProject): string[] {
  return project.scenes
    .filter(
      (scene) =>
        !!scene.videoTaskId &&
        ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus)),
    )
    .map((scene) => scene.id);
}

function listGeneratableSceneIds(project: PersistedVideoProject, limit = 3): string[] {
  return project.scenes
    .filter((scene) => {
      const status = normalizeSceneStatus(scene.videoStatus);
      if (["queued", "processing"].includes(status)) return false;
      return !scene.videoUrl;
    })
    .slice(0, limit)
    .map((scene) => scene.id);
}

function buildVideoContinuationBatchHint(plan: VideoWorkflowContinuationPlan): string {
  const targetCount = plan.targetCount ?? 0;
  const remainingTargetCount = plan.remainingTargetCount ?? 0;
  if (!targetCount) {
    return "";
  }

  switch (plan.policy) {
    case "generate-next-batch":
    case "repair-failed":
      return remainingTargetCount > 0
        ? `当前按批次推进：本轮先处理 ${targetCount} 条镜头，剩余 ${remainingTargetCount} 条可继续让 Agent 自动推进。`
        : `当前批次会直接处理这 ${targetCount} 条镜头，处理完成后就会自然衔接到下一轮轮询。`;
    case "refresh-running":
      return remainingTargetCount > 0
        ? `本轮先刷新 ${targetCount} 条进行中镜头，剩余 ${remainingTargetCount} 条任务稍后也能继续自动回收。`
        : `本轮会先刷新这 ${targetCount} 条进行中镜头，再根据结果决定继续补发。`;
    default:
      return "";
  }
}

function getVideoManifestItems(project: PersistedVideoProject) {
  return project.assetManifest?.items ?? [];
}

function findManifestReferenceImageUrl(
  project: PersistedVideoProject,
  kind: "character-reference" | "scene-reference",
  sourceEntityId: string,
): string | undefined {
  const matchedItem = getVideoManifestItems(project).find(
    (item) =>
      item.kind === kind &&
      item.status === "ready" &&
      item.sourceEntityId === sourceEntityId &&
      item.url.trim(),
  );
  return matchedItem?.url.trim() || undefined;
}

function findCharacterPrimaryReferenceImage(
  project: PersistedVideoProject,
  character: CharacterSetting,
): string | undefined {
  if (character.imageUrl?.trim()) return character.imageUrl.trim();
  return findManifestReferenceImageUrl(project, "character-reference", character.id);
}

function findScenePrimaryReferenceImage(
  project: PersistedVideoProject,
  sceneSetting: SceneSetting,
): string | undefined {
  if (sceneSetting.imageUrl?.trim()) return sceneSetting.imageUrl.trim();
  return findManifestReferenceImageUrl(project, "scene-reference", sceneSetting.id);
}

function hasExtractedVideoEntities(project: PersistedVideoProject): boolean {
  return project.characters.length > 0 && project.sceneSettings.length > 0;
}

function countMissingReferenceAssets(project: PersistedVideoProject): number {
  const items = getVideoManifestItems(project);
  const readyCharacterIds = new Set(
    items
      .filter((item) => item.kind === "character-reference" && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );
  const readySceneIds = new Set(
    items
      .filter((item) => item.kind === "scene-reference" && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );

  return (
    project.characters.filter((character) => !readyCharacterIds.has(character.id)).length +
    project.sceneSettings.filter((scene) => !readySceneIds.has(scene.id)).length
  );
}

function hasMinimumReferenceAssets(project: PersistedVideoProject): boolean {
  if (!hasExtractedVideoEntities(project)) return false;

  const items = getVideoManifestItems(project);
  const readyCharacterCount = items.filter(
    (item) => item.kind === "character-reference" && item.sourceEntityId,
  ).length;
  const readySceneCount = items.filter(
    (item) => item.kind === "scene-reference" && item.sourceEntityId,
  ).length;

  const characterRequirementMet =
    project.characters.length === 0 || readyCharacterCount > 0;
  const sceneRequirementMet =
    project.sceneSettings.length === 0 || readySceneCount > 0;

  return characterRequirementMet && sceneRequirementMet;
}

function hasStoryboardText(project: PersistedVideoProject): boolean {
  return Boolean(project.storyboardPlan?.trim());
}

function countMissingStoryboardFrames(project: PersistedVideoProject): number {
  const readyStoryboardSceneIds = new Set(
    getVideoManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.sceneId)
      .map((item) => item.sceneId!),
  );

  return project.scenes.filter((scene) => !readyStoryboardSceneIds.has(scene.id)).length;
}

function countReadyStoryboardFrames(project: PersistedVideoProject): number {
  return Math.max(project.scenes.length - countMissingStoryboardFrames(project), 0);
}

function hasMinimumStoryboardFrames(project: PersistedVideoProject): boolean {
  return project.scenes.length > 0 && countMissingStoryboardFrames(project) === 0;
}

function hasReviewableVideoOutputs(project: PersistedVideoProject): boolean {
  return Boolean(
    project.productionStateBundle?.directoryPath ||
      project.scenes.some(
        (scene) => !!scene.videoUrl || String(scene.videoStatus || "").toLowerCase() === "failed",
      ),
  );
}

function hasVideoBootstrapContext(project: PersistedVideoProject): boolean {
  return Boolean(
    project.targetPlatform?.trim() &&
      project.shotStyle?.trim() &&
      project.outputGoal?.trim(),
  );
}

function deriveVisibleVideoStep(project: PersistedVideoProject): number {
  return deriveNaturalVideoStep(project);
}

function assertReferenceAssetsReady(project: PersistedVideoProject): void {
  if (!hasExtractedVideoEntities(project)) {
    throw new Error("当前还没有完成角色与场景提取，先整理实体信息再继续生成分镜。");
  }

  if (!hasMinimumReferenceAssets(project)) {
    throw new Error("当前至少需要 1 个角色主参考图和 1 个场景主参考图，满足分镜下限后再继续。");
  }
}

function assertStoryboardAssetsReady(project: PersistedVideoProject, mode?: string): void {
  // 文生视频模式或没有分镜图时，跳过分镜检查（自动降级为文生视频）
  if (mode === "text-to-video") return;
  if (!hasStoryboardText(project) && !hasMinimumStoryboardFrames(project)) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续推进视频生成。");
  }

  const missingStoryboardCount = countMissingStoryboardFrames(project);
  if (missingStoryboardCount > 0) {
    throw new Error(`当前还有 ${missingStoryboardCount} 个镜头缺少分镜图，补齐后再进入视频生成会更稳。`);
  }
}

function assertStoryboardCompileReady(project: PersistedVideoProject, mode?: string): void {
  // 文生视频模式或没有分镜图时，跳过分镜检查（自动降级为文生视频）
  if (mode === "text-to-video") return;
  if (!hasStoryboardText(project) && countReadyStoryboardFrames(project) <= 0) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续编译镜头指令包。");
  }

  if (countReadyStoryboardFrames(project) <= 0) {
    throw new Error("当前还没有可用的分镜图，至少生成 1 张分镜图后再编译镜头指令包。");
  }
}

function parseChineseEpisodeNumber(value: string): number {
  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digitMap[value[tenIndex - 1]] ?? 0;
    const ones = tenIndex === value.length - 1 ? 0 : digitMap[value[tenIndex + 1]] ?? 0;
    return tens * 10 + ones;
  }
  return value.split("").reduce((acc, char) => acc * 10 + (digitMap[char] ?? 0), 0);
}

function listScriptEpisodeNumbers(script: string): number[] {
  const episodeNumbers = new Set<number>();
  const markerPattern =
    /(?:^|\n)\s*(?:EP\s*(\d+)|第\s*([零一二三四五六七八九十\d]+)\s*[集话期章]|Episode\s+(\d+))/gim;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(script)) !== null) {
    const raw = match[1] || match[2] || match[3] || "";
    const episodeNumber = parseChineseEpisodeNumber(raw);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

function listSceneEpisodeNumbers(scenes: Scene[]): number[] {
  const episodeNumbers = new Set<number>();
  for (const scene of scenes) {
    const match = String(scene.segmentLabel || "").trim().match(/^(\d+)-/);
    if (!match) continue;
    const episodeNumber = Number(match[1]);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

function hasIncompleteSceneEpisodeCoverage(project: PersistedVideoProject): boolean {
  if (!project.scenes.length) return false;
  const scriptEpisodes = listScriptEpisodeNumbers(project.script || "");
  if (scriptEpisodes.length <= 1) return false;
  const sceneEpisodes = new Set(listSceneEpisodeNumbers(project.scenes || []));
  return scriptEpisodes.some((episodeNumber) => !sceneEpisodes.has(episodeNumber));
}

function createScriptDecomposeProgressFormatter(): (partial: DecomposeProgressPayload) => string {
  let marks: string[] = [];
  let totalChunks = 0;

  const ensureMarks = (nextTotal: number) => {
    if (nextTotal <= 0 || nextTotal === totalChunks) return;
    const nextMarks = Array.from({ length: nextTotal }, (_, index) => marks[index] || ".");
    marks = nextMarks;
    totalChunks = nextTotal;
  };

  return (partial: DecomposeProgressPayload) => {
    const nextTotal =
      typeof partial.totalChunks === "number" && Number.isFinite(partial.totalChunks)
        ? Math.max(0, Math.floor(partial.totalChunks))
        : totalChunks;
    ensureMarks(nextTotal);

    if (partial.status === "init" && Array.isArray(partial.scenes) && partial.scenes.length > 0) {
      for (const episodeNumber of listSceneEpisodeNumbers(partial.scenes.map((scene, index) => mapScene(scene, index)))) {
        const markIndex = episodeNumber - 1;
        if (markIndex >= 0 && markIndex < marks.length) {
          marks[markIndex] = "#";
        }
      }
    }

    const chunkIndex =
      typeof partial.chunkIndex === "number" && Number.isFinite(partial.chunkIndex)
        ? Math.floor(partial.chunkIndex)
        : -1;
    if (chunkIndex >= 0 && chunkIndex < marks.length) {
      if (partial.status === "done") marks[chunkIndex] = "#";
      if (partial.status === "failed") marks[chunkIndex] = "x";
      if (partial.status === "cancelled") marks[chunkIndex] = "!";
      if (partial.status === "processing" && marks[chunkIndex] !== "#") marks[chunkIndex] = ">";
    }

    for (const failedIndex of partial.failedChunks || []) {
      if (failedIndex >= 0 && failedIndex < marks.length) {
        marks[failedIndex] = "x";
      }
    }

    const sceneCount = Array.isArray(partial.scenes) ? partial.scenes.length : 0;
    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const activeIndexes = marks
      .map((mark, index) => (mark === ">" ? index + 1 : 0))
      .filter(Boolean);
    const totalLabel = Math.max(totalChunks, 1);
    const bar = marks.length ? `[${marks.join("")}]` : "[.]";
    const retryLabel =
      typeof partial.retryAttempt === "number" && partial.retryAttempt > 0
        ? ` · 重试 ${partial.retryAttempt}`
        : "";

    if (partial.status === "init") {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 初始化分集任务 · 已出 ${sceneCount} 镜头`;
    }
    if (activeIndexes.length > 0) {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 正在拆第 ${activeIndexes.join("、")} 集${retryLabel} · 已出 ${sceneCount} 镜头`;
    }
    if (failedCount > 0) {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · ${failedCount} 集失败 · 已出 ${sceneCount} 镜头`;
    }
    if (partial.status === "cancelled") {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 已停止 · 已出 ${sceneCount} 镜头`;
    }
    return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 已出 ${sceneCount} 镜头`;
  };
}

type ProgressMark = "." | "#" | ">" | "x" | "!";

function buildCompactProgressBar(marks: ProgressMark[]): string {
  if (!marks.length) return "[.]";
  if (marks.length <= 48) return `[${marks.join("")}]`;
  return `[${marks.slice(0, 22).join("")}...${marks.slice(-22).join("")}]`;
}

function createSegmentPromptProgressFormatter(
  segmentOrder: string[],
  readySegments: Set<string>,
): (params: { segmentLabel?: string; status: "init" | "processing" | "done" | "failed" | "cancelled" }) => string {
  const marks: ProgressMark[] = segmentOrder.map((segmentLabel): ProgressMark =>
    readySegments.has(segmentLabel) ? "#" : ".",
  );

  return ({ segmentLabel, status }) => {
    const index = segmentLabel ? segmentOrder.indexOf(segmentLabel) : -1;
    if (index >= 0) {
      if (status === "processing" && marks[index] !== "#") marks[index] = ">";
      if (status === "done") marks[index] = "#";
      if (status === "failed") marks[index] = "x";
      if (status === "cancelled") marks[index] = "!";
    }

    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const bar = buildCompactProgressBar(marks);
    const total = Math.max(segmentOrder.length, 1);

    if (status === "init") {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 初始化片段任务`;
    }
    if (status === "processing" && segmentLabel) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 正在生成片段 ${segmentLabel}`;
    }
    if (status === "failed" && segmentLabel) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 片段 ${segmentLabel} 失败`;
    }
    if (status === "cancelled") {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 已停止`;
    }
    if (failedCount > 0) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · ${failedCount} 个片段失败`;
    }
    return `片段提示词 ${bar} ${doneCount}/${total} 片段`;
  };
}

export function planVideoWorkflowContinuation(
  project: PersistedVideoProject,
  input: Record<string, unknown> = {},
): VideoWorkflowContinuationPlan {
  const syncedProject = synchronizeVideoProductionState(project);

  if (!syncedProject.script?.trim()) {
    throw new Error("当前没有可用于视频生产的脚本，请先提供脚本或挂载剧本项目。");
  }

  // 用户通过步骤切换手动跳到了更靠后的步骤，且自然进度尚未追上，不自动推进
  const naturalStep = deriveVisibleVideoStep(syncedProject);
  const manualOverride = syncedProject.manualStepOverride ?? null;
  if (manualOverride !== null && manualOverride > naturalStep) {
    return {
      actionKind: "create_video_bridge_artifact",
      policy: "bridge-summary",
      input,
      reason: "当前处于手动切换的步骤，请先回到原步骤完成所有条件后再推进。",
    };
  }

  if (!syncedProject.scenes.length) {
    return {
      actionKind: "analyze_script_for_video",
      policy: "bootstrap-analysis",
      input,
      reason: "先把当前脚本拆成镜头，首页会话才能继续推进视频生产。",
    };
  }

  if (hasIncompleteSceneEpisodeCoverage(syncedProject)) {
    return {
      actionKind: "analyze_script_for_video",
      policy: "bootstrap-analysis",
      input,
      reason: "当前脚本包含多集，但已保存的镜头拆解没有覆盖全部集数，需要重新完整拆解后再继续。",
    };
  }

  if (!hasExtractedVideoEntities(syncedProject)) {
    return {
      actionKind: "extract_video_entities",
      policy: "bootstrap-entities",
      input,
      reason: "镜头已经拆完，下一步先整理角色和场景资产。",
    };
  }

  // 图生视频模式：实体提取完成后，必须先补齐参考图才能推进到分镜/视频阶段
  const videoMode = syncedProject.videoGenerationPrefs?.mode ?? "image-to-video";
  if (videoMode !== "text-to-video" && !hasMinimumReferenceAssets(syncedProject)) {
    return {
      actionKind: "create_video_bridge_artifact",
      policy: "bridge-summary",
      input,
      reason: "角色与场景实体已整理完毕，请先补齐参考图（至少各 1 张）后再继续推进。",
    };
  }

  if (!syncedProject.shotPackets?.length) {
    return {
      actionKind: "compile_video_shot_packets",
      policy: "bootstrap-shot-packets",
      input,
      reason: "分镜说明已经就绪，下一步先把镜头压成可复用的 shot packet。",
    };
  }

  if (videoMode === "text-to-video") {
    // 文生视频：片段提示词或镜头提示词必须全部生成完毕才能推进到视频生成阶段
    const allSegmentLabels = [
      ...new Set(
        syncedProject.scenes
          .map((s) => s.segmentLabel?.trim())
          .filter((label): label is string => !!label),
      ),
    ];
    const segmentPromptsComplete =
      allSegmentLabels.length > 0 &&
      allSegmentLabels.every((label) => !!syncedProject.segmentVideoPrompts?.[label]?.prompt?.trim());
    const shotPromptsComplete = !!syncedProject.videoPromptBatch?.trim();
    if (!segmentPromptsComplete && !shotPromptsComplete) {
      return {
        actionKind: "create_video_bridge_artifact",
        policy: "bridge-summary",
        input,
        reason: "文生视频模式：片段提示词或镜头提示词必须全部生成完毕才能推进到视频生成阶段。",
      };
    }
  } else if (!syncedProject.videoPromptBatch?.trim()) {
    return {
      actionKind: "prepare_video_prompt_batch",
      policy: "bootstrap-prompt-batch",
      input: { ...batchSceneRange(syncedProject.scenes, 4), ...input },
      reason: "分镜批次已经完成，下一步生成对应的视频提示词。",
    };
  }

  const failedSceneIds = listFailedSceneIds(syncedProject);
  if (failedSceneIds.length) {
    const targetIds = failedSceneIds.slice(0, 3);
    return {
      actionKind: "generate_video_assets",
      policy: "repair-failed",
      input: {
        ...input,
        targetIds,
        forceRegenerate: true,
      },
      reason:
        targetIds.length === 1
          ? "当前有 1 条镜头出片失败，先直接补发这条失败镜头。"
          : `当前有 ${failedSceneIds.length} 条镜头出片失败，先统一补发失败镜头。`,
      targetCount: targetIds.length,
      totalTargetCount: failedSceneIds.length,
      remainingTargetCount: Math.max(failedSceneIds.length - targetIds.length, 0),
    };
  }

  const generatableSceneIds = listGeneratableSceneIds(syncedProject, 3);
  if (generatableSceneIds.length) {
    const totalGeneratableSceneIds = listGeneratableSceneIds(syncedProject, Number.MAX_SAFE_INTEGER);
    return {
      actionKind: "generate_video_assets",
      policy: "generate-next-batch",
      input: {
        ...input,
        targetIds: generatableSceneIds,
      },
      reason:
        generatableSceneIds.length === 1
          ? "视频提示词已经就绪，下一步先提交这一条镜头出片。"
          : `视频提示词已经就绪，下一步先提交前 ${generatableSceneIds.length} 条镜头出片。`,
      targetCount: generatableSceneIds.length,
      totalTargetCount: totalGeneratableSceneIds.length,
      remainingTargetCount: Math.max(totalGeneratableSceneIds.length - generatableSceneIds.length, 0),
    };
  }

  return {
    actionKind: "create_video_bridge_artifact",
    policy: "bridge-summary",
    input,
    reason: "当前视频项目已经具备首页继续出片所需的桥接摘要。",
  };
}

async function ensureVideoProject(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): Promise<PersistedVideoProject> {
  if (
    typeof input.projectId === "string" &&
    input.projectId.trim() &&
    runtime.currentVideoProject?.id === input.projectId.trim()
  ) {
    return { ...runtime.currentVideoProject };
  }

  if (typeof input.projectId === "string" && input.projectId.trim()) {
    const restored = await loadStoredVideoProjectById(input.projectId.trim());
    if (restored) return restored;
  }

  if (runtime.currentVideoProject) {
    return { ...runtime.currentVideoProject };
  }

  const script = resolveWorkingScript(runtime, null, input);
  const created = await createStoredVideoProject({
    title: buildVideoTitle(runtime, input),
    script,
    targetPlatform: readTextInput(input, "targetPlatform"),
    shotStyle: readTextInput(input, "shotStyle"),
    outputGoal: readTextInput(input, "outputGoal"),
    productionNotes:
      readTextInput(input, "productionNotes") ||
      readTextInput(input, "customInstruction"),
    artStyle:
      typeof input.artStyle === "string"
        ? (input.artStyle as ArtStyle)
        : "live-action",
    currentStep: 1,
    sourceProjectId: runtime.currentDramaProject?.id,
    analysisSummary: script
      ? "已从当前首页会话接入脚本，可继续做镜头拆解、资产梳理和出片准备。"
      : "已建立视频会话项目，等待脚本或镜头需求进入生产。",
  });
  return mergeVideoInputContext(created, runtime, input);
}

async function saveVideoProject(
  project: PersistedVideoProject,
  summary: string,
): Promise<WorkflowActionResult> {
  const saved = await upsertStoredVideoProject(synchronizeVideoProductionState(project));
  const snapshot = createVideoSnapshot(saved);
  return {
    summary,
    projectSnapshot: snapshot,
    recommendedActions: snapshot.recommendedActions,
    data: {
      videoProject: saved,
      projectSnapshot: snapshot,
    },
  };
}

async function runWithVideoAbortSignal<T>(
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  activeVideoAbortControllers.set(VIDEO_WORKFLOW_GENERATION_ABORT_KEY, controller);
  try {
    return await task(controller.signal);
  } finally {
    if (activeVideoAbortControllers.get(VIDEO_WORKFLOW_GENERATION_ABORT_KEY) === controller) {
      activeVideoAbortControllers.delete(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
    }
  }
}

function resolveGenerationScenes(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
): Scene[] {
  const targetIds = collectTargetIds(input);
  if (targetIds.length) {
    return project.scenes.filter((scene) => sceneTargetMatches(scene, project.id, targetIds));
  }

  const start = typeof input.sceneStart === "number" ? input.sceneStart : null;
  const end = typeof input.sceneEnd === "number" ? input.sceneEnd : null;
  if (start !== null || end !== null) {
    const lower = start ?? project.scenes[0]?.sceneNumber ?? 1;
    const upper = end ?? lower;
    return project.scenes.filter((scene) => scene.sceneNumber >= lower && scene.sceneNumber <= upper);
  }

  const forceRegenerate = input.forceRegenerate === true;
  const batchSize =
    typeof input.batchSize === "number" && Number.isFinite(input.batchSize)
      ? Math.max(1, Math.min(8, Math.floor(input.batchSize)))
      : 3;

  return project.scenes
    .filter((scene) => {
      if (forceRegenerate) return true;
      if (["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus))) return false;
      return !scene.videoUrl;
    })
    .slice(0, batchSize);
}

async function buildSceneVideoPrompt(
  project: PersistedVideoProject,
  scene: Scene,
  context?: { prevDescription?: string; nextDescription?: string; excludeStoryboard?: boolean },
): Promise<VideoEnhanceResult> {
  if (scene.enhancedVideoPrompt?.trim()) {
    return {
      enhanced: appendExactDialogueLock(scene.enhancedVideoPrompt.trim(), scene.dialogue),
      duration: scene.recommendedDuration,
    };
  }

  const characterDetails = findCharacterDetails(scene, project.characters || []);
  const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
  const referenceImageUrl = findSceneReferenceImage(scene, project.sceneSettings || [], {
    excludeStoryboard: context?.excludeStoryboard,
  });
  const { data, error } = await invokeFunction<VideoEnhanceResult>(
    "enhance-video-prompt",
    {
      description: scene.description,
      characters: scene.characters,
      cameraDirection: scene.cameraDirection,
      sceneName: scene.sceneName,
      dialogue: scene.dialogue,
      style: resolveProjectImagePromptStyle(project),
      characterDescriptions: characterDetails,
      sceneDescription: matchedSetting?.description || scene.sceneName,
      referenceImageUrl,
      hasRefImage: Boolean(referenceImageUrl),
      characterImages: characterDetails
        .filter((c) => c.imageUrl)
        .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
      prevDescription: context?.prevDescription,
      nextDescription: context?.nextDescription,
    },
  );

  if (error) throw error;
  return withExactDialogueLock(
    data || { enhanced: scene.description || scene.sceneName || "继续生成当前镜头", duration: scene.duration || 5 },
    scene.dialogue,
  );
}

function appendVideoHistory(scene: Scene, nextUrl?: string) {
  if (!scene.videoUrl || scene.videoUrl === nextUrl) return scene.videoHistory || [];

  const previous = scene.videoHistory || [];
  if (previous.some((entry) => entry.videoUrl === scene.videoUrl)) {
    return previous;
  }

  return [
    ...previous,
    {
      videoUrl: scene.videoUrl,
      createdAt: new Date().toISOString(),
    },
  ];
}

function decodeVideoFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mapScene(raw: Partial<Scene>, index: number): Scene {
  return {
    id: raw.id || crypto.randomUUID(),
    sceneNumber: typeof raw.sceneNumber === "number" ? raw.sceneNumber : index + 1,
    sceneName: raw.sceneName?.trim() || `镜头 ${index + 1}`,
    description: raw.description?.trim() || "",
    characters: Array.isArray(raw.characters)
      ? raw.characters.filter((item): item is string => typeof item === "string")
      : [],
    dialogue: raw.dialogue?.trim() || "",
    cameraDirection: raw.cameraDirection?.trim() || "",
    segmentLabel: raw.segmentLabel,
    duration: typeof raw.duration === "number" ? raw.duration : 5,
    storyboardUrl: raw.storyboardUrl,
    storyboardHistory: raw.storyboardHistory,
    panoramaUrl: raw.panoramaUrl,
    videoUrl: raw.videoUrl,
    videoTaskId: raw.videoTaskId,
    videoProvider: raw.videoProvider,
    videoStatus: raw.videoStatus,
    videoHistory: raw.videoHistory,
    recommendedDuration: raw.recommendedDuration,
    isManualDuration: raw.isManualDuration,
    characterCostumes: raw.characterCostumes,
    sceneTimeVariantId: raw.sceneTimeVariantId,
    enhancedVideoPrompt: raw.enhancedVideoPrompt,
  };
}

function mapCharacters(
  rawCharacters: ExtractEntitiesResult["characters"],
  existingCharacters: CharacterSetting[] = [],
  options?: { replaceExisting?: boolean },
): CharacterSetting[] {
  const usedExistingIndexes = new Set<number>();

  const mappedCharacters = (rawCharacters || []).map((character, index) => {
    const name = character?.name?.trim() || `角色 ${index + 1}`;
    const existing = takeMatchedEntity(existingCharacters, name, usedExistingIndexes);
    const costumes = mapCostumeVariants(character?.costumes, existing?.costumes, options);
    const activeCostumeId = resolvePreservedVariantId(
      existing?.activeCostumeId,
      existing?.costumes,
      costumes,
    );

    return {
      id: existing?.id || crypto.randomUUID(),
      name,
      description: character?.description?.trim() || existing?.description || "",
      imageUrl: existing?.imageUrl,
      audioUrl: existing?.audioUrl,
      audioFileName: existing?.audioFileName,
      threeViewUrls: existing?.threeViewUrls,
      isAIGenerated: existing?.isAIGenerated ?? false,
      isGenerating: false,
      source: existing?.source || "auto",
      imageHistory: existing?.imageHistory,
      costumes,
      activeCostumeId,
    };
  });

  if (options?.replaceExisting) return mappedCharacters;

  const preservedCharacters = existingCharacters.filter((_, index) => !usedExistingIndexes.has(index));
  return [...mappedCharacters, ...preservedCharacters];
}

function mapSceneSettings(
  rawSceneSettings: ExtractEntitiesResult["sceneSettings"],
  existingSceneSettings: SceneSetting[] = [],
  options?: { replaceExisting?: boolean },
): SceneSetting[] {
  const usedExistingIndexes = new Set<number>();

  const mappedSceneSettings = (rawSceneSettings || []).map((sceneSetting, index) => {
    const name = sceneSetting?.name?.trim() || `场景 ${index + 1}`;
    const existing = takeMatchedEntity(existingSceneSettings, name, usedExistingIndexes);
    const timeVariants = mapSceneTimeVariants(sceneSetting?.timeVariants, existing?.timeVariants, options);
    const activeTimeVariantId = resolvePreservedVariantId(
      existing?.activeTimeVariantId,
      existing?.timeVariants,
      timeVariants,
    );

    return {
      id: existing?.id || crypto.randomUUID(),
      name,
      description: sceneSetting?.description?.trim() || existing?.description || "",
      imageUrl: existing?.imageUrl,
      isAIGenerated: existing?.isAIGenerated ?? false,
      isGenerating: false,
      source: existing?.source || "auto",
      imageHistory: existing?.imageHistory,
      timeVariants,
      activeTimeVariantId,
    };
  });

  if (options?.replaceExisting) return mappedSceneSettings;

  const preservedSceneSettings = existingSceneSettings.filter((_, index) => !usedExistingIndexes.has(index));
  return [...mappedSceneSettings, ...preservedSceneSettings];
}

function mapCostumeVariants(
  rawVariants: ExtractedVariantResult[] | undefined,
  existingVariants: CostumeSetting[] = [],
  options?: { replaceExisting?: boolean },
): CostumeSetting[] | undefined {
  const usedExistingIndexes = new Set<number>();
  const variants: CostumeSetting[] = [];

  (rawVariants || []).forEach((variant, index) => {
    const label = variant?.label?.trim() || `角色变体 ${index + 1}`;
    if (!label) return;

    const existing = takeMatchedVariant(existingVariants, label, usedExistingIndexes, "costume");
    const nextVariant: CostumeSetting = {
        id: existing?.id || crypto.randomUUID(),
        label: existing ? chooseMergedVariantLabel(existing.label, label, Boolean(existing.imageUrl?.trim())) : label,
        description: variant?.description?.trim() || existing?.description || "",
        imageUrl: existing?.imageUrl,
        isAIGenerated: existing?.isAIGenerated ?? false,
        imageHistory: existing?.imageHistory,
    };

    const duplicateIndex = findMatchedVariantIndex(variants, nextVariant.label, "costume");
    if (duplicateIndex >= 0) {
      variants[duplicateIndex] = mergeEntityVariant(variants[duplicateIndex]!, nextVariant);
    } else {
      variants.push(nextVariant);
    }
  });

  const preservedVariants = options?.replaceExisting
    ? []
    : existingVariants.filter((_, index) => !usedExistingIndexes.has(index));
  const mergedVariants = dedupeEntityVariants([...variants, ...preservedVariants], "costume");

  return mergedVariants.length ? mergedVariants : undefined;
}

function mapSceneTimeVariants(
  rawVariants: ExtractedVariantResult[] | undefined,
  existingVariants: TimeVariantSetting[] = [],
  options?: { replaceExisting?: boolean },
): TimeVariantSetting[] | undefined {
  const usedExistingIndexes = new Set<number>();
  const variants: TimeVariantSetting[] = [];

  (rawVariants || []).forEach((variant, index) => {
    const label = variant?.label?.trim() || `场景变体 ${index + 1}`;
    if (!label) return;

    const existing = takeMatchedVariant(existingVariants, label, usedExistingIndexes, "scene-time");
    const nextVariant: TimeVariantSetting = {
        id: existing?.id || crypto.randomUUID(),
        label: existing ? chooseMergedVariantLabel(existing.label, label, Boolean(existing.imageUrl?.trim())) : label,
        description: variant?.description?.trim() || existing?.description || "",
        imageUrl: existing?.imageUrl,
        isAIGenerated: existing?.isAIGenerated ?? false,
        imageHistory: existing?.imageHistory,
    };

    const duplicateIndex = findMatchedVariantIndex(variants, nextVariant.label, "scene-time");
    if (duplicateIndex >= 0) {
      variants[duplicateIndex] = mergeEntityVariant(variants[duplicateIndex]!, nextVariant);
    } else {
      variants.push(nextVariant);
    }
  });

  const preservedVariants = options?.replaceExisting
    ? []
    : existingVariants.filter((_, index) => !usedExistingIndexes.has(index));
  const mergedVariants = dedupeEntityVariants([...variants, ...preservedVariants], "scene-time");

  return mergedVariants.length ? mergedVariants : undefined;
}

function takeMatchedEntity<T extends { name: string }>(
  items: T[],
  name: string,
  usedIndexes: Set<number>,
): T | undefined {
  const normalizedName = normalizeName(name);
  const index = items.findIndex(
    (item, candidateIndex) =>
      !usedIndexes.has(candidateIndex) && normalizeName(item.name) === normalizedName,
  );
  if (index < 0) return undefined;
  usedIndexes.add(index);
  return items[index];
}

function takeMatchedVariant<T extends { label: string }>(
  items: T[],
  label: string,
  usedIndexes: Set<number>,
  kind: EntityVariantKind,
): T | undefined {
  const index = findMatchedVariantIndex(items, label, kind, usedIndexes);
  if (index < 0) return undefined;
  usedIndexes.add(index);
  return items[index];
}

function resolvePreservedVariantId<T extends { id: string; label: string }>(
  previousActiveId: string | undefined,
  previousVariants: T[] | undefined,
  nextVariants: T[] | undefined,
): string | undefined {
  if (!previousActiveId || !nextVariants?.length) return undefined;
  if (nextVariants.some((variant) => variant.id === previousActiveId)) return previousActiveId;

  const previousActive = previousVariants?.find((variant) => variant.id === previousActiveId);
  if (!previousActive) return undefined;
  return nextVariants.find((variant) => normalizeName(variant.label) === normalizeName(previousActive.label))?.id;
}

function clearInvalidCostumeSelections(
  characterCostumes: Scene["characterCostumes"],
  characters: CharacterSetting[],
): Scene["characterCostumes"] {
  if (!characterCostumes) return undefined;
  const nextEntries = Object.entries(characterCostumes).filter(([characterName, costumeId]) => {
    const character = characters.find((item) => normalizeName(item.name) === normalizeName(characterName));
    return Boolean(character?.costumes?.some((costume) => costume.id === costumeId));
  });
  return nextEntries.length ? Object.fromEntries(nextEntries) : undefined;
}

function clearInvalidSceneTimeVariant(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string | undefined {
  if (!scene.sceneTimeVariantId) return undefined;
  const matchedSetting = findSceneSetting(scene, sceneSettings);
  return matchedSetting?.timeVariants?.some((variant) => variant.id === scene.sceneTimeVariantId)
    ? scene.sceneTimeVariantId
    : undefined;
}

function invalidateEntityDependentSceneState(
  scenes: Scene[],
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): Scene[] {
  return scenes.map((scene) => ({
    ...scene,
    characterCostumes: clearInvalidCostumeSelections(scene.characterCostumes, characters),
    sceneTimeVariantId: clearInvalidSceneTimeVariant(scene, sceneSettings),
    enhancedVideoPrompt: undefined,
    recommendedDuration: scene.isManualDuration ? scene.recommendedDuration : undefined,
  }));
}

function buildEntityExtractionSection(
  title: string,
  items: Array<{ name?: string; description?: string; costumes?: CostumeSetting[]; timeVariants?: TimeVariantSetting[] }>,
  emptyLabel: string,
): string {
  if (!items.length) {
    return `${title}：\n- ${emptyLabel}`;
  }

  return [
    `${title}：`,
    ...items.map((item, index) => {
      const name = item.name?.trim() || `${title === "角色" ? "角色" : "场景"} ${index + 1}`;
      const description = item.description?.trim() || "暂无描述";
      const variants = title === "角色" ? item.costumes ?? [] : item.timeVariants ?? [];
      const variantLabel = title === "角色" ? "角色变体" : "场景变体";
      const variantLines = variants.length
        ? [
            `   ${variantLabel}：`,
            ...variants.map((variant) => `   - ${variant.label}${variant.description ? `：${variant.description}` : ""}`),
          ]
        : [];
      return [
        `${index + 1}. ${name}`,
        `   ${description}`,
        ...variantLines,
      ].join("\n");
    }),
  ].join("\n");
}

function buildEntityExtractionSummary(
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): string {
  const characterVariantCount = characters.reduce((sum, character) => sum + (character.costumes?.length ?? 0), 0);
  const sceneVariantCount = sceneSettings.reduce((sum, sceneSetting) => sum + (sceneSetting.timeVariants?.length ?? 0), 0);
  return [
    `已从脚本中提取 ${characters.length} 个角色与 ${sceneSettings.length} 个场景设定。` +
      (characterVariantCount || sceneVariantCount
        ? `另外识别出 ${characterVariantCount} 个角色变体与 ${sceneVariantCount} 个场景变体。`
        : ""),
    buildEntityExtractionSection("角色", characters, "未识别到明确角色"),
    buildEntityExtractionSection("场景", sceneSettings, "未识别到明确场景"),
  ].join("\n\n");
}

function buildStoryboardBatchSummary(params: {
  generatableCount: number;
  generatedCount: number;
  blockedCount: number;
  totalCount: number;
  storyboardPlan: string;
}): string {
  const { generatableCount, generatedCount, blockedCount, totalCount, storyboardPlan } = params;
  return [
    "已更新分镜摘要。",
    `镜头总数：${totalCount}`,
    `已生成分镜图：${generatedCount} / ${totalCount}`,
    `当前可生成分镜图：${generatableCount} / ${totalCount}`,
    `缺素材镜头：${blockedCount} / ${totalCount}`,
    storyboardPlan.trim() || "本次没有生成新的分镜摘要。",
  ].join("\n\n");
}

function escapeSummaryTableCell(value: string, maxLength = 28): string {
  const normalized = String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "｜")
    .trim();

  if (!normalized) return "待补充";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function buildShotPacketOutline(project: PersistedVideoProject, shotPackets: VideoShotPacket[]): string {
  if (!shotPackets.length) {
    return "当前没有可展示的镜头指令包摘要。";
  }

  const episodeSegmentRe = /^(\d+)-(\d+)$/;
  const sortedPackets = [...shotPackets].sort((left, right) => left.sceneNumber - right.sceneNumber);
  const hasEpisodeSegments = sortedPackets.some((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    return episodeSegmentRe.test(scene?.segmentLabel?.trim() || "");
  });
  const groupedPackets = new Map<string, VideoShotPacket[]>();
  const groupOrder: string[] = [];

  sortedPackets.forEach((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const segmentLabel = scene?.segmentLabel?.trim() || "未分组";
    const groupKey =
      hasEpisodeSegments
        ? episodeSegmentRe.exec(segmentLabel)?.[1] || "1"
        : "__single__";

    if (!groupedPackets.has(groupKey)) {
      groupedPackets.set(groupKey, []);
      groupOrder.push(groupKey);
    }
    groupedPackets.get(groupKey)?.push(packet);
  });

  const sections = groupOrder.map((groupKey) => {
    const groupPackets = groupedPackets.get(groupKey) || [];
    const firstSceneNumber = groupPackets[0]?.sceneNumber ?? 0;
    const lastSceneNumber = groupPackets.at(-1)?.sceneNumber ?? firstSceneNumber;

    const sceneNames: string[] = [];
    const seenNames = new Set<string>();
    for (const packet of groupPackets) {
      const scene = project.scenes.find((item) => item.id === packet.sceneId);
      const name =
        packet.backgroundRef?.name?.trim() ||
        (scene && findSceneSetting(scene, project.sceneSettings || [])?.name?.trim()) ||
        packet.title?.trim() ||
        scene?.sceneName?.trim() ||
        "";
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        sceneNames.push(name);
      }
    }
    const sceneLabel = sceneNames.length ? sceneNames.join("、") : project.title || "未命名分组";

    return (
      groupKey === "__single__"
        ? `${sceneLabel}：镜头 ${firstSceneNumber}-${lastSceneNumber}，共 ${groupPackets.length} 个`
        : `第 ${groupKey} 集｜${sceneLabel}：镜头 ${firstSceneNumber}-${lastSceneNumber}，共 ${groupPackets.length} 个`
    );
  });

  const totalStart = sortedPackets[0]?.sceneNumber ?? 0;
  const totalEnd = sortedPackets.at(-1)?.sceneNumber ?? totalStart;
  return [
    `已收口 ${shotPackets.length} 个镜头指令包，覆盖镜头 ${totalStart}-${totalEnd}。`,
    "",
    ...sections,
  ].join("\n\n");
}

function findCharacterDetails(
  scene: Scene,
  characters: CharacterSetting[],
): Array<{ name: string; description: string; imageUrl?: string }> {
  const knownNames = new Set(scene.characters.map((name) => normalizeName(name)));
  return characters
    .filter((character) => knownNames.has(normalizeName(character.name)))
    .map((character) => {
      const sceneCostumeId = scene.characterCostumes?.[character.name];
      const costume = sceneCostumeId
        ? (character.costumes || []).find((c) => c.id === sceneCostumeId)
        : (character.costumes || []).find((c) => c.id === character.activeCostumeId);
      return {
        name: character.name,
        description: costume
          ? `${character.description} [服装：${costume.description}]`
          : character.description,
        imageUrl: costume?.imageUrl?.trim() || character.imageUrl,
      };
    });
}

function findSceneSetting(scene: Scene, sceneSettings: SceneSetting[]): SceneSetting | undefined {
  const normalizedSceneName = normalizeName(scene.sceneName);
  const exact = sceneSettings.find((s) => normalizeName(s.name) === normalizedSceneName);
  if (exact) return exact;
  const fuzzy = sceneSettings.filter((s) => {
    const n = normalizeName(s.name);
    return normalizedSceneName.includes(n) || n.includes(normalizedSceneName);
  });
  if (!fuzzy.length) return undefined;
  return fuzzy.reduce((best, cur) =>
    normalizeName(cur.name).length > normalizeName(best.name).length ? cur : best,
  );
}

function findSceneReferenceImage(
  scene: Scene,
  sceneSettings: SceneSetting[],
  options?: { excludeStoryboard?: boolean },
): string | undefined {
  if (!options?.excludeStoryboard) {
    if (scene.storyboardUrl?.trim()) return scene.storyboardUrl.trim();
    if (scene.panoramaUrl?.trim()) return scene.panoramaUrl.trim();
  }

  const matchedSetting = findSceneSetting(scene, sceneSettings);
  const matchedVariant = matchedSetting?.timeVariants?.find(
    (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
  );

  if (matchedVariant?.imageUrl?.trim()) return matchedVariant.imageUrl.trim();
  if (matchedSetting?.imageUrl?.trim()) return matchedSetting.imageUrl.trim();
  return undefined;
}

function countMissingStoryboardFramesForScenes(
  project: PersistedVideoProject,
  scenes: Scene[],
): number {
  const readyStoryboardSceneIds = new Set(
    getVideoManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.sceneId)
      .map((item) => item.sceneId!),
  );

  return scenes.filter((scene) => {
    if (readyStoryboardSceneIds.has(scene.id)) return false;
    return !findSceneReferenceImage(scene, project.sceneSettings || []);
  }).length;
}

function assertStoryboardAssetsReadyForScenes(
  project: PersistedVideoProject,
  scenes: Scene[],
  mode?: string,
): void {
  if (mode === "text-to-video") return;
  if (!scenes.length) return;
  if (!hasStoryboardText(project) && !hasMinimumStoryboardFrames(project)) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续推进视频生成。");
  }

  const missingStoryboardCount = countMissingStoryboardFramesForScenes(project, scenes);
  if (missingStoryboardCount > 0) {
    throw new Error(`当前选中的 ${missingStoryboardCount} 个镜头缺少参考图，补齐后再进入视频生成会更稳。`);
  }
}

function shouldPreferLocalDreamina(input: Record<string, unknown>): boolean {
  if (typeof input.provider === "string" && input.provider.trim()) {
    return input.provider.trim() === "dreamina-cli";
  }

  return prefersJimengCli(getApiConfig());
}

function resolveRequestedVideoGenerationPrefs(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
) {
  return normalizeVideoGenerationPrefs({
    ...project.videoGenerationPrefs,
    ...(typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs
      ? input.videoGenerationPrefs
      : {}),
    ...(typeof input.videoModelKey === "string" && input.videoModelKey.trim()
      ? { modelKey: input.videoModelKey.trim() as never }
      : typeof input.selectedVideoModelKey === "string" && input.selectedVideoModelKey.trim()
        ? { modelKey: input.selectedVideoModelKey.trim() as never }
        : typeof input.modelKey === "string" && input.modelKey.trim()
          ? { modelKey: input.modelKey.trim() as never }
          : {}),
    ...(typeof input.resolution === "string" && input.resolution.trim()
      ? { resolution: input.resolution.trim() as never }
      : {}),
    ...(typeof input.mode === "string" && input.mode.trim()
      ? { mode: input.mode.trim() as never }
      : {}),
  });
}

type VideoGenerationTransport = {
  mode: "api" | "cli";
  provider?: string;
  providerLabel: string;
};

async function ensureVideoGenerationTransport(
  input: Record<string, unknown>,
): Promise<VideoGenerationTransport> {
  const config = getApiConfig();
  const usesArkSeedanceApi = isArkJimengEndpoint(config.jimengEndpoint);
  const provider =
    typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : undefined;

  if (shouldPreferLocalDreamina(input)) {
    if (!window.electronAPI?.dreaminaCli?.exec) {
      throw new Error("当前已锁定 CLI，但 Dreamina CLI 未安装或当前环境不支持，无法发起出片。");
    }

    const status = await dreaminaCliGetStatus();
    if (!status.loggedIn) {
      throw new Error(
        status.installed
          ? "当前已锁定 CLI，但 Dreamina CLI 尚未登录，无法发起出片。请先完成登录，或切回 API。"
          : "当前已锁定 CLI，但 Dreamina CLI 未安装或不可用，无法发起出片。请先安装并登录，或切回 API。",
      );
    }

    return {
      mode: "cli",
      provider: "dreamina-cli",
      providerLabel: "Dreamina CLI / Seedance 2.0",
    };
  }

  if (provider === "tuzi") {
    if (!config.tuziKey?.trim()) {
      throw new Error("当前指定了 Tuzi / Sora 2，但缺少可用 API Key，无法发起出片。");
    }

    return {
      mode: "api",
      provider: "tuzi",
      providerLabel: "Tuzi API / Sora 2",
    };
  }

  if (!resolveJimengApiKey(config)) {
    throw new Error(
      usesArkSeedanceApi
        ? "当前已锁定 API，但缺少 Seedance / Ark 专用 Key，无法发起出片。"
        : "当前已锁定 API，但缺少 Seedance / Gemini 可用 Key，无法发起出片。",
    );
  }

  return {
    mode: "api",
    provider: provider || "jimeng",
    providerLabel: usesArkSeedanceApi ? "Ark / Seedance API" : "Seedance API",
  };
}

function normalizeSceneStatus(value: string | undefined): string {
  if (!value?.trim()) return "";
  const lowered = String(value || "").toLowerCase();
  if (/(succeeded|success|completed|done)/.test(lowered)) return "completed";
  if (/(queued|pending|submitted)/.test(lowered)) return "queued";
  if (/(failed|error|cancel)/.test(lowered)) return "failed";
  return "processing";
}

function isSameRefreshSceneState(previous: Scene, next: Scene): boolean {
  return (
    normalizeSceneStatus(previous.videoStatus) === normalizeSceneStatus(next.videoStatus) &&
    (previous.videoTaskId || "") === (next.videoTaskId || "") &&
    (previous.videoUrl || "") === (next.videoUrl || "") &&
    (previous.videoFailure?.message || "") === (next.videoFailure?.message || "") &&
    (previous.videoFailure?.provider || "") === (next.videoFailure?.provider || "") &&
    (previous.videoFailure?.stage || "") === (next.videoFailure?.stage || "")
  );
}

function characterReferenceTargetMatches(
  character: CharacterSetting,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === character.id ||
      normalized === `character:${character.id}` ||
      normalized === `reference-character:${character.id}`
    );
  });
}

function sceneReferenceTargetMatches(
  sceneSetting: SceneSetting,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === sceneSetting.id ||
      normalized === `scene:${sceneSetting.id}` ||
      normalized === `scene-setting:${sceneSetting.id}` ||
      normalized === `reference-scene:${sceneSetting.id}`
    );
  });
}

function characterVariantTargetMatches(
  characterId: string,
  costumeId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === costumeId ||
      normalized === `costume:${costumeId}` ||
      normalized === `reference-character-variant:${characterId}:${costumeId}`
    );
  });
}

function hasExplicitCharacterVariantTarget(
  characterId: string,
  costumeId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return normalized === `reference-character-variant:${characterId}:${costumeId}`;
  });
}

function sceneVariantTargetMatches(
  sceneSettingId: string,
  variantId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === variantId ||
      normalized === `time-variant:${variantId}` ||
      normalized === `reference-scene-variant:${sceneSettingId}:${variantId}`
    );
  });
}

function hasExplicitSceneVariantTarget(
  sceneSettingId: string,
  variantId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return normalized === `reference-scene-variant:${sceneSettingId}:${variantId}`;
  });
}

function buildReferenceAssetGenerationSummary(params: {
  characterPrimaryCount: number;
  characterVariantCount: number;
  scenePrimaryCount: number;
  sceneVariantCount: number;
}): string {
  const parts = [
    params.characterPrimaryCount ? `${params.characterPrimaryCount} 个角色主参考图` : "",
    params.characterVariantCount ? `${params.characterVariantCount} 个角色变体` : "",
    params.scenePrimaryCount ? `${params.scenePrimaryCount} 个场景主参考图` : "",
    params.sceneVariantCount ? `${params.sceneVariantCount} 个场景变体` : "",
  ].filter(Boolean);

  return parts.length ? `已生成 ${parts.join("、")}。` : "";
}

function sceneTargetMatches(scene: Scene, projectId: string, targetIds: string[]): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === scene.id ||
      normalized === `packet:${projectId}:${scene.id}` ||
      normalized === `review:packet:${projectId}:${scene.id}` ||
      normalized === `shot:${scene.id}:video` ||
      normalized === `shot:${scene.id}:storyboard` ||
      normalized.endsWith(`:${scene.id}`) ||
      normalized.includes(`:${scene.id}:`)
    );
  });
}

type StoryboardSceneStatus =
  | "已生成"
  | "可生成"
  | "缺角色参考"
  | "缺场景参考"
  | "缺角色/场景参考";

function collectStoryboardReadyIds(project: PersistedVideoProject) {
  const readyCharacterIds = new Set<string>();
  const readySceneIds = new Set<string>();
  const readyStoryboardSceneIds = new Set<string>();

  (project.characters || []).forEach((character) => {
    const activeCostume = character.costumes?.find((costume) => costume.id === character.activeCostumeId);
    if (character.imageUrl?.trim() || activeCostume?.imageUrl?.trim()) {
      readyCharacterIds.add(character.id);
    }
  });

  (project.sceneSettings || []).forEach((sceneSetting) => {
    const activeTimeVariant = sceneSetting.timeVariants?.find((variant) => variant.id === sceneSetting.activeTimeVariantId);
    if (sceneSetting.imageUrl?.trim() || activeTimeVariant?.imageUrl?.trim()) {
      readySceneIds.add(sceneSetting.id);
    }
  });

  project.scenes.forEach((scene) => {
    if (scene.storyboardUrl?.trim()) {
      readyStoryboardSceneIds.add(scene.id);
    }
  });

  (project.assetManifest?.items ?? []).forEach((item) => {
    if (
      (item.kind === "character-reference" || item.kind === "costume-reference") &&
      item.status === "ready" &&
      item.sourceEntityId
    ) {
      readyCharacterIds.add(item.sourceEntityId);
    }

    if (
      (item.kind === "scene-reference" || item.kind === "time-variant") &&
      item.status === "ready" &&
      item.sourceEntityId
    ) {
      readySceneIds.add(item.sourceEntityId);
    }

    if (item.kind === "storyboard-frame" && item.status === "ready" && item.sceneId) {
      readyStoryboardSceneIds.add(item.sceneId);
    }
  });

  return { readyCharacterIds, readySceneIds, readyStoryboardSceneIds };
}

function resolveStoryboardSceneStatus(
  scene: Scene,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
  readyIds: ReturnType<typeof collectStoryboardReadyIds>,
): StoryboardSceneStatus {
  if (readyIds.readyStoryboardSceneIds.has(scene.id)) {
    return "已生成";
  }

  const characterMap = new Map(
    characters.map((character) => [normalizeName(character.name), character]),
  );
  const missingCharacterRefs = (scene.characters ?? []).filter((name) => {
    const matchedCharacter = characterMap.get(normalizeName(name));
    return !matchedCharacter || !readyIds.readyCharacterIds.has(matchedCharacter.id);
  });

  const matchedSetting = findSceneSetting(scene, sceneSettings);
  const sceneReferenceReady =
    Boolean(scene.panoramaUrl?.trim()) ||
    Boolean(matchedSetting && readyIds.readySceneIds.has(matchedSetting.id));

  if (missingCharacterRefs.length === 0 && sceneReferenceReady) {
    return "可生成";
  }

  if (missingCharacterRefs.length > 0 && !sceneReferenceReady) {
    return "缺角色/场景参考";
  }

  if (missingCharacterRefs.length > 0) {
    return "缺角色参考";
  }

  return "缺场景参考";
}

function resolveStoryboardSceneReferenceLabel(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string {
  const matchedSetting = findSceneSetting(scene, sceneSettings);
  if (matchedSetting?.name?.trim()) {
    return matchedSetting.name.trim();
  }
  if (scene.panoramaUrl?.trim()) {
    return "镜头全景";
  }
  return "待匹配";
}

function buildStoryboardBatch(project: PersistedVideoProject): string {
  const scenes = project.scenes;
  const characters = project.characters || [];
  const sceneSettings = project.sceneSettings || [];

  if (!scenes.length) {
    return "暂无可整理的分镜摘要。";
  }

  const readyIds = collectStoryboardReadyIds(project);
  const segmentEntries: Array<{ segmentLabel: string; segmentScenes: Scene[] }> = [];
  const segmentMap = new Map<string, Scene[]>();

  [...scenes]
    .sort((left, right) => left.sceneNumber - right.sceneNumber)
    .forEach((scene) => {
      const segmentLabel = scene.segmentLabel?.trim() || "未分组";
      const existing = segmentMap.get(segmentLabel);
      if (existing) {
        existing.push(scene);
        return;
      }
      const nextGroup = [scene];
      segmentMap.set(segmentLabel, nextGroup);
      segmentEntries.push({ segmentLabel, segmentScenes: nextGroup });
    });

  const buildRoleReference = (scene: Scene) => {
    const characterMap = new Map(
      characters.map((character) => [normalizeName(character.name), character]),
    );
    const names = [...new Set(
      (scene.characters || [])
        .map((characterName) => {
          const matchedCharacter = characterMap.get(normalizeName(characterName));
          return matchedCharacter?.name?.trim() || String(characterName || "").trim();
        })
        .filter(Boolean),
    )];

    return escapeSummaryTableCell(names.join("、") || "暂无", 22);
  };

  const buildSceneReference = (scene: Scene, segmentScenes: Scene[]) => {
    return escapeSummaryTableCell(resolveStoryboardSceneReferenceLabel(scene, sceneSettings), 24);
  };

  return segmentEntries
    .map(({ segmentLabel, segmentScenes }) => {
      const statuses = segmentScenes.map((scene) =>
        resolveStoryboardSceneStatus(scene, characters, sceneSettings, readyIds),
      );
      const generatedCount = statuses.filter((status) => status === "已生成").length;
      const generatableCount = statuses.filter((status) => status === "可生成").length;
      const blockedCount = statuses.length - generatedCount - generatableCount;
      const segmentTitle =
        findSceneSetting(segmentScenes[0]!, sceneSettings)?.name?.trim() ||
        segmentScenes[0]?.sceneName?.trim() ||
        "未命名片段";
      const heading =
        `## 片段 ${segmentLabel}｜${segmentTitle}（已生成 ${generatedCount} / 可生成 ${generatableCount} / 缺素材 ${blockedCount}）`;

      const table = [
        "| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |",
        "| --- | --- | --- | --- | --- |",
        ...segmentScenes.map((scene) => [
          `| ${escapeSummaryTableCell(`镜头 ${scene.sceneNumber}`, 12)}`,
          `${escapeSummaryTableCell(scene.sceneName || `镜头 ${scene.sceneNumber}`, 18)}`,
          `${escapeSummaryTableCell(resolveStoryboardSceneStatus(scene, characters, sceneSettings, readyIds), 18)}`,
          `${buildRoleReference(scene)}`,
          `${buildSceneReference(scene, segmentScenes)} |`,
        ].join(" | ")),
      ].join("\n");

      return [heading, table].join("\n\n");
    })
    .join("\n\n");
}

function buildRealtimeStoryboardSummary(
  project: PersistedVideoProject,
): {
  storyboardPlan: string;
  generatedCount: number;
  generatableCount: number;
  blockedCount: number;
  totalCount: number;
} {
  const syncedProject = synchronizeVideoProductionState(project);
  const readyIds = collectStoryboardReadyIds(syncedProject);
  const totalCount = syncedProject.scenes.length;
  const statuses = syncedProject.scenes.map((scene) =>
    resolveStoryboardSceneStatus(
      scene,
      syncedProject.characters || [],
      syncedProject.sceneSettings || [],
      readyIds,
    ),
  );
  const generatedCount = statuses.filter((status) => status === "已生成").length;
  const generatableCount = statuses.filter((status) => status === "可生成").length;
  const blockedCount = statuses.length - generatedCount - generatableCount;

  return {
    storyboardPlan: buildStoryboardBatch(syncedProject),
    generatedCount,
    generatableCount,
    blockedCount,
    totalCount,
  };
}

function buildPromptBatchSummary(
  scenes: Scene[],
  results: Array<{ scene: Scene; prompt: VideoEnhanceResult }>,
): string {
  return results
    .map(({ scene, prompt }, index) => [
      `批次 ${index + 1} / 镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""}`,
      `场景：${scene.sceneName}`,
      `推荐时长：${prompt.duration ?? scene.duration ?? 5}s`,
      `时长依据：${prompt.durationReason || "按镜头复杂度自动估算"}`,
      "",
      prompt.enhanced,
    ].join("\n"))
    .join("\n\n====================\n\n");
}

function buildPromptBatchSummaryOutline(
  project: PersistedVideoProject,
  selectedScenes: Scene[],
): string {
  if (!selectedScenes.length) {
    return "当前没有可展示的视频提示词批次摘要。";
  }

  const episodeSegmentRe = /^(\d+)-(\d+)$/;
  const selectedIds = new Set(selectedScenes.map((s) => s.id));

  // 全量镜头按集数分组
  const allScenesSorted = [...project.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const hasEpisodeSegments = allScenesSorted.some((scene) =>
    episodeSegmentRe.test(scene.segmentLabel?.trim() || ""),
  );

  // 按集数 → 片段 两级分组（全量）
  const episodeMap = new Map<string, Map<string, Scene[]>>();
  const episodeOrder: string[] = [];

  for (const scene of allScenesSorted) {
    const segLabel = scene.segmentLabel?.trim() || "";
    const episodeKey = hasEpisodeSegments
      ? episodeSegmentRe.exec(segLabel)?.[1] || "1"
      : "__single__";
    const segmentKey = hasEpisodeSegments ? segLabel || "未分组" : "__single__";

    if (!episodeMap.has(episodeKey)) {
      episodeMap.set(episodeKey, new Map());
      episodeOrder.push(episodeKey);
    }
    const segMap = episodeMap.get(episodeKey)!;
    if (!segMap.has(segmentKey)) {
      segMap.set(segmentKey, []);
    }
    segMap.get(segmentKey)!.push(scene);
  }

  const totalStart = selectedScenes[0]?.sceneNumber ?? 0;
  const totalEnd = selectedScenes.at(-1)?.sceneNumber ?? totalStart;
  const header = `已收口 ${selectedScenes.length} 个镜头的视频提示词批次，覆盖镜头 ${totalStart}-${totalEnd}。`;

  const outputParts: string[] = [header];

  for (const episodeKey of episodeOrder) {
    const segMap = episodeMap.get(episodeKey)!;
    const segmentOrder = [...segMap.keys()];

    // 只保留包含至少一个已覆盖镜头的片段
    const visibleSegments = segmentOrder.filter((segKey) => {
      const segScenes = segMap.get(segKey)!;
      return segScenes.some((scene) => selectedIds.has(scene.id));
    });

    if (!visibleSegments.length) continue;

    if (hasEpisodeSegments) {
      outputParts.push(`\n## 第 ${episodeKey} 集`);
    }

    for (const segKey of visibleSegments) {
      const segScenes = segMap.get(segKey)!;
      const coveredCount = segScenes.filter((s) => selectedIds.has(s.id)).length;
      const pendingCount = segScenes.length - coveredCount;
      const totalCount = segScenes.length;

      const firstScene = segScenes[0];
      const sceneName =
        findSceneSetting(firstScene, project.sceneSettings || [])?.name?.trim() ||
        firstScene?.sceneName?.trim() ||
        "未命名场景";

      const segLabel = segKey === "__single__" ? "" : segKey;
      const segmentDuration = segScenes.reduce(
        (sum, scene) => sum + (scene.recommendedDuration ?? scene.duration ?? 5),
        0,
      );
      const segTitle = segLabel
        ? `**片段 ${segLabel}（${segmentDuration}s）｜${sceneName}（已覆盖 ${coveredCount} / 待生成 ${pendingCount} / 总数 ${totalCount}）**`
        : `**${sceneName}（已覆盖 ${coveredCount} / 待生成 ${pendingCount} / 总数 ${totalCount}）**`;

      const shotLines = segScenes.map((scene) => {
        const duration = scene.recommendedDuration ?? scene.duration ?? 5;
        const status = selectedIds.has(scene.id) ? "已覆盖" : "待生成";
        return `  镜头 ${scene.sceneNumber} — ${duration}s（${status}）`;
      });

      outputParts.push(`\n${segTitle}\n${shotLines.join("\n")}`);
    }
  }

  return outputParts.join("\n");
}

function buildVideoAssetStatusReport(
  project: PersistedVideoProject,
  selectedScenes: Scene[],
  mode: string,
): string {
  const isImageToVideo = mode !== "text-to-video";
  const characters = project.characters || [];
  const sceneSettings = project.sceneSettings || [];

  const involvedCharacterNames = new Set<string>();
  selectedScenes.forEach((scene) => {
    (scene.characters || []).forEach((name) => involvedCharacterNames.add(name));
  });

  const involvedSceneNames = new Set<string>();
  selectedScenes.forEach((scene) => involvedSceneNames.add(scene.sceneName));

  const lines: string[] = [];
  lines.push("---");
  lines.push(isImageToVideo ? "## 当前批次资产状态（图生视频模式）" : "## 当前批次资产状态（文生视频模式）");
  lines.push("");

  if (isImageToVideo) {
    lines.push("分镜图（首帧参考）：");
    selectedScenes.forEach((scene) => {
      if (scene.storyboardUrl?.trim()) {
        lines.push(`  镜头 ${scene.sceneNumber} — [就绪]`);
      } else {
        lines.push(`  镜头 ${scene.sceneNumber} — [缺失]（已跳过）`);
      }
    });
    lines.push("");
    lines.push("角色参考（提示词增强用）：");
  } else {
    lines.push("角色参考：");
  }

  if (involvedCharacterNames.size === 0) {
    lines.push("  （本批次镜头无角色）");
  } else {
    involvedCharacterNames.forEach((name) => {
      const character = characters.find((c) => normalizeName(c.name) === normalizeName(name));
      if (!character) {
        lines.push(`  ${name} — [缺失]（提示词将仅使用文字描述）`);
        return;
      }
      const costumeIds = new Set(
        selectedScenes
          .map((scene) => scene.characterCostumes?.[character.name])
          .filter((id): id is string => Boolean(id)),
      );
      if (costumeIds.size > 0) {
        const costumeId = [...costumeIds][0];
        const costume = (character.costumes || []).find((c) => c.id === costumeId);
        if (costume) {
          const hasImage = !!(costume.imageUrl?.trim() || character.imageUrl?.trim());
          lines.push(
            hasImage
              ? `  ${character.name} — 服装变体「${costume.label}」[就绪]`
              : `  ${character.name} — 服装变体「${costume.label}」[缺失]（提示词将仅使用文字描述）`,
          );
          return;
        }
      }
      lines.push(
        character.imageUrl?.trim()
          ? `  ${character.name} — 主参考图 [就绪]`
          : `  ${character.name} — [缺失]（提示词将仅使用文字描述）`,
      );
    });
  }

  lines.push("");
  lines.push(isImageToVideo ? "场景参考（提示词增强用）：" : "场景参考：");

  if (involvedSceneNames.size === 0) {
    lines.push("  （本批次镜头无场景信息）");
  } else {
    involvedSceneNames.forEach((sceneName) => {
      const normalizedName = normalizeName(sceneName);
      const matchedSetting =
        sceneSettings.find((s) => normalizeName(s.name) === normalizedName) ||
        sceneSettings
          .filter((s) => {
            const n = normalizeName(s.name);
            return normalizedName.includes(n) || n.includes(normalizedName);
          })
          .reduce<SceneSetting | undefined>((best, cur) => {
            if (!best) return cur;
            return normalizeName(cur.name).length > normalizeName(best.name).length ? cur : best;
          }, undefined);
      lines.push(
        matchedSetting?.imageUrl?.trim()
          ? `  ${sceneName} — 场景参考图 [就绪]`
          : `  ${sceneName} — [缺失]（提示词将仅使用文字描述）`,
      );
    });
  }

  lines.push("");
  lines.push(
    isImageToVideo
      ? "温馨提示：图生视频模式下，分镜图质量直接决定视频首帧效果，建议先补齐所有分镜图，角色和场景参考图补齐后提示词增强效果也会更好。"
      : "温馨提示：补齐角色和场景参考图后，视频生成效果会更好。",
  );

  return lines.join("\n");
}

export async function prepareVideoGenerationAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const nextProject: PersistedVideoProject = {
    ...project,
    title: buildVideoTitle(runtime, input),
    script: resolveWorkingScript(runtime, project, input),
    analysisSummary:
      project.analysisSummary ||
      "首页会话已经接管视频生产，你可以继续做镜头拆解、资产梳理和提示词批处理。",
    currentStep: deriveVisibleVideoStep(synchronizeVideoProductionState(project)),
    sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
  };
  return saveVideoProject(
    nextProject,
    `已接管视频项目《${nextProject.title}》的首页会话上下文。`,
  );
}

function resolveInputAbortSignal(input: Record<string, unknown>): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  return input.abortSignal instanceof AbortSignal ? input.abortSignal : undefined;
}

/** 将用户中止信号与单次图片生成超时（默认 4 分钟）合并 */
function buildPerImageAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs = 4 * 60_000,
): AbortSignal {
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : (() => {
          const controller = new AbortController();
          globalThis.setTimeout(() => controller.abort(), timeoutMs);
          return controller.signal;
        })();

  if (!parentSignal) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parentSignal, timeout]);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted || timeout.aborted) {
    abort();
    return controller.signal;
  }
  parentSignal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function throwIfInputAborted(input: Record<string, unknown>): void {
  if (resolveInputAbortSignal(input)?.aborted) {
    throw new Error("Aborted");
  }
}

type ActiveVideoTaskRef = {
  taskId: string;
  provider?: string;
};

async function cancelVideoGenerationTasks(tasks: ActiveVideoTaskRef[]): Promise<void> {
  const dedupedTasks = Array.from(
    new Map(
      tasks
        .filter((task) => task.taskId.trim())
        .map((task) => [`${task.provider || "jimeng"}:${task.taskId}`, task]),
    ).values(),
  );

  if (!dedupedTasks.length) return;

  await Promise.allSettled(
    dedupedTasks.map(async (task) => {
      const { error } = await invokeFunction("generate-video", {
        action: "cancel",
        taskId: task.taskId,
        provider: task.provider,
      });
      if (error) throw error;
    }),
  );
}

function attachAbortDrivenVideoCancellation(
  input: Record<string, unknown>,
  getTasks: () => ActiveVideoTaskRef[],
): () => void {
  const abortSignal = resolveInputAbortSignal(input);
  if (!abortSignal) return () => undefined;

  const onAbort = () => {
    void cancelVideoGenerationTasks(getTasks());
  };

  abortSignal.addEventListener("abort", onAbort, { once: true });
  return () => abortSignal.removeEventListener("abort", onAbort);
}

export async function analyzeScriptForVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  if (!script) {
    throw new Error("当前没有可用于视频拆解的脚本内容。");
  }

  const episodeDuration = resolveEpisodeDuration(input, project);
  const segmentsPerEpisode =
    typeof input.segmentsPerEpisode === "number" && Number.isFinite(input.segmentsPerEpisode)
      ? input.segmentsPerEpisode
      : deriveSegmentsPerEpisode(episodeDuration);
  const abortSignal = resolveInputAbortSignal(input);
  const retryMissingEpisodes = input.retryMissingEpisodes === true;

  let latestPartialScenes: Scene[] = [];
  const formatProgress = createScriptDecomposeProgressFormatter();
  const { data, error } = await invokeFunction<DecomposeResult>("script-decompose", {
    script,
    videoPace: typeof input.videoPace === "string" ? input.videoPace : "medium",
    episodeDuration,
    segmentsPerEpisode,
    retryMissingEpisodes,
    existingScenes: retryMissingEpisodes ? project.scenes : undefined,
    systemPrompt:
      typeof input.systemPrompt === "string" ? input.systemPrompt : project.systemPrompt,
    model: typeof input.model === "string" ? input.model : undefined,
  }, {
    abortSignal,
    onProgress: (partial) => {
      if (Array.isArray(partial?.scenes) && partial.scenes.length > 0) {
        latestPartialScenes = partial.scenes.map((scene: Partial<Scene>, index: number) => mapScene(scene, index));
      }
      onProgress?.({
        summary: formatProgress({
          scenes: Array.isArray(partial?.scenes) ? partial.scenes : latestPartialScenes,
          chunkIndex: typeof partial?.chunkIndex === "number" ? partial.chunkIndex : undefined,
          totalChunks: typeof partial?.totalChunks === "number" ? partial.totalChunks : undefined,
          status: partial?.status,
          failedChunks: Array.isArray(partial?.failedChunks) ? partial.failedChunks : undefined,
          retryAttempt: typeof partial?.retryAttempt === "number" ? partial.retryAttempt : undefined,
        }),
      });
    },
  });

  if (error) {
    const message = error.message || "";
    if (message.includes("剧本拆解未完成") && latestPartialScenes.length > 0) {
      const partialSegmentCount = new Set(
        latestPartialScenes.map((scene) => scene.segmentLabel).filter(Boolean),
      ).size;
      const nextTitle = buildVideoTitle(runtime, input) || project.title;
      return saveVideoProject(
        {
          ...project,
          title: nextTitle,
          script,
          scenes: latestPartialScenes,
          currentStep: 1,
          analysisSummary: `${message} 已保留当前成功拆出的 ${latestPartialScenes.length} 个镜头${partialSegmentCount ? `，覆盖 ${partialSegmentCount} 个片段` : ""}，可点击继续补拆缺失集。`,
          preferredEpisodeDurationSeconds: episodeDuration,
          sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
        },
        `${message}\n\n已保留当前成功拆出的 ${latestPartialScenes.length} 个镜头，可在下方点击“继续补拆缺失集”。`,
      );
    }
    throw error;
  }

  const scenes = (data?.scenes || []).map((scene, index) => mapScene(scene, index));
  const segmentCount = new Set(
    scenes.map((scene) => scene.segmentLabel).filter(Boolean),
  ).size;
  const nextTitle = buildVideoTitle(runtime, input) || project.title;
  const breakdownMessage = buildStoryboardBreakdownMessage({
    title: nextTitle,
    scenes,
    characters: project.characters,
    sceneSettings: project.sceneSettings,
  });

  return saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      title: nextTitle,
      script,
      scenes,
      currentStep: 1,
      analysisSummary: retryMissingEpisodes
        ? `已在现有结果基础上补齐剧本拆解，共整理 ${scenes.length} 个镜头${segmentCount ? `，覆盖 ${segmentCount} 个片段` : ""}。`
        : `已完成镜头拆解，共整理 ${scenes.length} 个镜头${segmentCount ? `，覆盖 ${segmentCount} 个片段` : ""}。`,
      preferredEpisodeDurationSeconds: episodeDuration,
      sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
      };
      return nextProject;
    })(),
    [
      retryMissingEpisodes
        ? `已在现有结果基础上继续拆解《${nextTitle}》，当前共 ${scenes.length} 个镜头。`
        : `已完成《${nextTitle}》的视频镜头拆解，共 ${scenes.length} 个镜头。`,
      breakdownMessage,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

export async function extractVideoEntitiesAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  if (!script) {
    throw new Error("当前没有可用于识别角色和场景的脚本内容。");
  }

  const { data, error } = await invokeFunction<ExtractEntitiesResult>(
    "extract-characters-scenes",
    {
      script,
      model: typeof input.model === "string" ? input.model : undefined,
    },
  );

  if (error) throw error;

  const replaceExistingEntities =
    input.replaceExistingEntities === true ||
    input.overwriteEntities === true ||
    input.resetEntities === true;
  const characters = mapCharacters(data?.characters, project.characters || [], {
    replaceExisting: replaceExistingEntities,
  });
  const sceneSettings = mapSceneSettings(data?.sceneSettings, project.sceneSettings || [], {
    replaceExisting: replaceExistingEntities,
  });
  const scenes = invalidateEntityDependentSceneState(project.scenes || [], characters, sceneSettings);
  const extractionSummary = buildEntityExtractionSummary(characters, sceneSettings);

  return saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      title: buildVideoTitle(runtime, input),
      script,
      scenes,
      characters,
      sceneSettings,
      shotPackets: [],
      videoPromptBatch: "",
      segmentVideoPrompts: {},
      reviewQueue: [],
      currentStep: 2,
      analysisSummary: `已整理 ${characters.length} 个角色和 ${sceneSettings.length} 个场景设定，并已让旧镜头包与视频提示词失效，后续会基于最新设定重新生成。`,
      sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
      };
      return nextProject;
    })(),
    extractionSummary,
  );
}

export async function prepareStoryboardBatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，先运行脚本拆解更稳妥。");
  }
  const syncedProject = synchronizeVideoProductionState(project);
  assertReferenceAssetsReady(syncedProject);

  const storyboardPlan = buildStoryboardBatch(syncedProject);
  const nextProject = {
    ...syncedProject,
    storyboardPlan,
    currentStep: 3,
    analysisSummary: "分镜摘要已同步更新，可继续逐镜生成分镜图。",
  };
  const realtimeSummary = buildRealtimeStoryboardSummary(nextProject);
  const storyboardSummary = buildStoryboardBatchSummary({
    generatableCount: realtimeSummary.generatableCount,
    generatedCount: realtimeSummary.generatedCount,
    blockedCount: realtimeSummary.blockedCount,
    totalCount: realtimeSummary.totalCount,
    storyboardPlan: realtimeSummary.storyboardPlan,
  });

  return saveVideoProject(
    {
      ...nextProject,
      storyboardPlan: realtimeSummary.storyboardPlan,
    },
    storyboardSummary,
  );
}

export async function compileVideoShotPacketsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法编译镜头指令包。");
  }

  const synced = synchronizeVideoProductionState(project);
  const compileShotMode = resolveRequestedVideoGenerationPrefs(project, input).mode;
  assertStoryboardCompileReady(synced, compileShotMode);
  const shotPackets = deriveVideoShotPackets({
    ...synced,
    assetManifest: synced.assetManifest,
  });

  const img2videoCount = shotPackets.filter((p) => p.renderMode === "img2video").length;
  const text2videoCount = shotPackets.length - img2videoCount;
  const modeNote = img2videoCount > 0 && text2videoCount > 0
    ? `（图生视频 ${img2videoCount} 个，文生视频 ${text2videoCount} 个）`
    : img2videoCount > 0
      ? "（全部图生视频模式）"
      : "（全部文生视频模式，可先补充参考图提升画面一致性）";

  return saveVideoProject(
    {
      ...synced,
      shotPackets,
      // 文生视频：编译完镜头包后停留在第2步（角色与场景），让桥接面板再次弹出"准备视频提示词批次"
      // 图生视频：进入第3步（分镜图生成）
      currentStep: compileShotMode === "text-to-video" ? 2 : 3,
      analysisSummary: `已编译 ${shotPackets.length} 个镜头指令包${modeNote}，可继续准备视频提示词批次。`,
    },
    [
      `已为《${project.title}》编译 ${shotPackets.length} 个镜头指令包${modeNote}。`,
      buildShotPacketOutline(synced, shotPackets),
    ].join("\n\n"),
  );
}

export async function prepareVideoPromptBatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法准备视频提示词批次。");
  }
  const syncedProject = synchronizeVideoProductionState(project);
  const promptBatchMode = resolveRequestedVideoGenerationPrefs(project, input).mode;
  const isImageToVideo = promptBatchMode !== "text-to-video";

  // 图生视频模式：放宽条件，自动识别可用分镜图，至少需要1张
  if (isImageToVideo) {
    const readyFrameCount = countReadyStoryboardFrames(syncedProject);
    if (readyFrameCount < 1) {
      assertStoryboardAssetsReady(syncedProject, promptBatchMode);
    }
  } else {
    assertStoryboardAssetsReady(syncedProject, promptBatchMode);
  }

  if (!syncedProject.shotPackets?.length) {
    throw new Error("当前还没有镜头指令包，先编译镜头指令包再准备视频提示词批次。");
  }

  const batchMode = typeof input.batchMode === "string" ? input.batchMode : null;
  const targetIds = collectTargetIds(input);
  const hasExplicitSceneRange =
    typeof input.sceneStart === "number" || typeof input.sceneEnd === "number";
  let selectedScenes: Scene[] = [];
  let selectedBatchSegmentLabel: string | null = null;
  let nextBatchSegmentLabel: string | null = null;
  const batchCoveredBefore = syncedProject.scenes.filter((scene) => scene.enhancedVideoPrompt?.trim()).length;

  if (targetIds.length) {
    selectedScenes = syncedProject.scenes.filter((scene) =>
      sceneTargetMatches(scene, syncedProject.id, targetIds),
    );
  } else if (hasExplicitSceneRange) {
    const start =
      typeof input.sceneStart === "number"
        ? input.sceneStart
        : syncedProject.scenes[0]?.sceneNumber ?? 1;
    const end =
      typeof input.sceneEnd === "number"
        ? input.sceneEnd
        : syncedProject.scenes.at(-1)?.sceneNumber ?? start;
    selectedScenes = syncedProject.scenes.filter(
      (scene) => scene.sceneNumber >= start && scene.sceneNumber <= end,
    );
  } else if (batchMode === "all") {
    // 全部生成：生成当前集内所有没有提示词的镜头，后续点击补齐下一集
    const scenesWithoutPrompt = syncedProject.scenes.filter((s) => !s.enhancedVideoPrompt?.trim());
    if (scenesWithoutPrompt.length === 0) {
      selectedScenes = syncedProject.scenes;
    } else {
      // 找到第一个没有提示词的镜头所在集数
      const firstScene = [...scenesWithoutPrompt].sort((a, b) => a.sceneNumber - b.sceneNumber)[0];
      const episodeNum = firstScene?.segmentLabel?.split("-")[0] ?? "1";
      selectedScenes = scenesWithoutPrompt.filter(
        (s) => (s.segmentLabel?.split("-")[0] ?? "1") === episodeNum,
      );
    }
  } else if (batchMode === "batch") {
    // 单批生成：按顺序找到第一个未完整覆盖的片段，生成该片段内所有分镜（已有的叠加更新）
    const allSorted = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
    // 按 segmentLabel 分组，保持片段顺序
    const segmentOrder: string[] = [];
    const segmentMap = new Map<string, Scene[]>();
    for (const s of allSorted) {
      const seg = s.segmentLabel ?? "__no_segment__";
      if (!segmentMap.has(seg)) {
        segmentOrder.push(seg);
        segmentMap.set(seg, []);
      }
      segmentMap.get(seg)!.push(s);
    }
    // 找第一个还有未生成提示词的片段
    const targetSeg = segmentOrder.find((seg) =>
      (segmentMap.get(seg) ?? []).some((s) => !s.enhancedVideoPrompt?.trim()),
    );
    if (targetSeg) {
      selectedBatchSegmentLabel = targetSeg === "__no_segment__" ? "未分组片段" : targetSeg;
      // 只选该片段内还没有提示词的镜头，已有的保留不动
      selectedScenes = (segmentMap.get(targetSeg) ?? []).filter((s) => !s.enhancedVideoPrompt?.trim());
      nextBatchSegmentLabel =
        segmentOrder
          .slice(segmentOrder.indexOf(targetSeg) + 1)
          .find((seg) => (segmentMap.get(seg) ?? []).some((s) => !s.enhancedVideoPrompt?.trim())) ?? null;
      if (nextBatchSegmentLabel === "__no_segment__") {
        nextBatchSegmentLabel = "未分组片段";
      }
    } else {
      // 所有片段已全部覆盖，无需再生成
      selectedScenes = [];
    }
  } else {
    const selectedSceneIds = new Set((syncedProject.shotPackets || []).map((packet) => packet.sceneId));
    selectedScenes = syncedProject.scenes.filter((scene) => selectedSceneIds.has(scene.id));
  }

  if (batchMode === "batch" && selectedScenes.length === 0) {
    const coveredScenes = syncedProject.scenes
      .filter((scene) => scene.enhancedVideoPrompt?.trim())
      .sort((left, right) => left.sceneNumber - right.sceneNumber);
    const videoPromptBatch = buildPromptBatchSummary(
      coveredScenes,
      coveredScenes.map((scene) => ({
        scene,
        prompt: {
          enhanced: scene.enhancedVideoPrompt || scene.description,
          duration: scene.recommendedDuration ?? scene.duration,
        },
      })),
    );

    return saveVideoProject(
      {
        ...syncedProject,
        videoPromptBatch,
        currentStep: 4,
        analysisSummary: "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
      },
      [
        "单批生成已完成：当前没有未覆盖的片段镜头。",
        `已覆盖 ${batchCoveredBefore} / ${syncedProject.scenes.length} 个镜头的视频提示词。`,
        "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
        buildPromptBatchSummaryOutline(syncedProject, coveredScenes),
        buildVideoAssetStatusReport(syncedProject, coveredScenes, promptBatchMode),
      ].join("\n\n"),
    );
  }

  // 图生视频模式：只对有分镜图的镜头生成提示词
  if (isImageToVideo) {
    selectedScenes = selectedScenes.filter((scene) => !!scene.storyboardUrl?.trim());
    if (selectedScenes.length === 0) {
      throw new Error("当前选中的镜头中没有可用的分镜图，请先生成分镜图再准备视频提示词。");
    }
  }

  selectedScenes = [...selectedScenes].sort((left, right) => left.sceneNumber - right.sceneNumber);
  const start = selectedScenes[0]?.sceneNumber ?? syncedProject.scenes[0]?.sceneNumber ?? 1;
  const end = selectedScenes.at(-1)?.sceneNumber ?? start;

  const promptResults: Array<{ scene: Scene; prompt: VideoEnhanceResult }> = [];
  const nextScenes = [...syncedProject.scenes];
  const allScenesSorted = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);

  for (const scene of selectedScenes) {
    const characterDetails = findCharacterDetails(scene, project.characters || []);
    const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
    const referenceImageUrl = findSceneReferenceImage(scene, syncedProject.sceneSettings || [], {
      excludeStoryboard: promptBatchMode === "text-to-video",
    });
    const sceneIdx = allScenesSorted.findIndex((s) => s.id === scene.id);
    const prevScene = sceneIdx > 0 ? allScenesSorted[sceneIdx - 1] : undefined;
    const nextScene = sceneIdx < allScenesSorted.length - 1 ? allScenesSorted[sceneIdx + 1] : undefined;
    const { data, error } = await invokeFunction<VideoEnhanceResult>(
      "enhance-video-prompt",
      {
        description: scene.description,
        characters: scene.characters,
        cameraDirection: scene.cameraDirection,
        sceneName: scene.sceneName,
        dialogue: scene.dialogue,
        style: resolveProjectImagePromptStyle(syncedProject),
        characterDescriptions: characterDetails,
        sceneDescription: matchedSetting?.description || scene.sceneName,
        prevDescription: prevScene?.description,
        nextDescription: nextScene?.description,
        referenceImageUrl,
        hasRefImage: Boolean(referenceImageUrl),
        characterImages: characterDetails
          .filter((c) => c.imageUrl)
          .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
      },
    );

    if (error) throw error;

    const result = withExactDialogueLock(data || { enhanced: scene.description }, scene.dialogue);
    promptResults.push({ scene, prompt: result });

    const index = nextScenes.findIndex((item) => item.id === scene.id);
    if (index >= 0) {
      nextScenes[index] = {
        ...nextScenes[index],
        enhancedVideoPrompt: result.enhanced || nextScenes[index].enhancedVideoPrompt,
        recommendedDuration: result.duration ?? nextScenes[index].recommendedDuration,
      };
    }
  }

  const coveredScenesAfter = nextScenes
    .filter((scene) => scene.enhancedVideoPrompt?.trim())
    .sort((left, right) => left.sceneNumber - right.sceneNumber);
  const videoPromptBatch = batchMode === "batch"
    ? buildPromptBatchSummary(
        coveredScenesAfter,
        coveredScenesAfter.map((scene) => ({
          scene,
          prompt: {
            enhanced: scene.enhancedVideoPrompt || scene.description,
            duration: scene.recommendedDuration ?? scene.duration,
          },
        })),
      )
    : buildPromptBatchSummary(selectedScenes, promptResults);
  const batchCoveredAfter = coveredScenesAfter.length;
  const batchProgressNotice = batchMode === "batch"
    ? [
        selectedBatchSegmentLabel
          ? `单批生成已完成：本次处理片段 ${selectedBatchSegmentLabel}，新增 ${promptResults.length} 个镜头提示词。`
          : `单批生成已完成：新增 ${promptResults.length} 个镜头提示词。`,
        `累计已覆盖 ${batchCoveredAfter} / ${syncedProject.scenes.length} 个镜头的视频提示词。`,
        nextBatchSegmentLabel
          ? `下次点击“单批生成”会继续处理片段 ${nextBatchSegmentLabel}。`
          : "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
      ]
    : [];

  return saveVideoProject(
    {
      ...syncedProject,
      scenes: nextScenes,
      videoPromptBatch,
      currentStep: 4,
      analysisSummary: batchMode === "batch"
        ? batchProgressNotice.join(" ")
        : `已生成镜头 ${start}-${end} 的视频提示词批次，可继续接到生成工具。`,
    },
    [
      ...batchProgressNotice,
      `已生成镜头 ${start}-${end} 的视频提示词批次。`,
      buildPromptBatchSummaryOutline(
        { ...syncedProject, scenes: nextScenes },
        batchMode === "batch" ? coveredScenesAfter : selectedScenes,
      ),
      buildVideoAssetStatusReport(
        { ...syncedProject, scenes: nextScenes },
        batchMode === "batch" ? coveredScenesAfter : selectedScenes,
        promptBatchMode,
      ),
    ].join("\n\n"),
  );
}

export async function generateVideoReferenceAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  localStorage.setItem("storyforge_current_project", project.id);

  return runWithVideoAbortSignal(async (abortSignal) => {
    const imageGenerationInput = buildScopedImageGenerationInput(input);
    const nextCharacters = [...(project.characters || [])];
    const nextSceneSettings = [...(project.sceneSettings || [])];
    const requestedTargetIds = collectTargetIds(input);
    const smartBatch = input.smartBatch === true;
    const smartBatchLimit = resolveSmartReferenceAssetBatchLimit(input);
    const targetIds = smartBatch && requestedTargetIds.length > smartBatchLimit
      ? requestedTargetIds.slice(0, smartBatchLimit)
      : requestedTargetIds;
    const remainingSmartTargetCount = smartBatch
      ? Math.max(requestedTargetIds.length - targetIds.length, 0)
      : 0;
    const forceRegenerate = input.forceRegenerate === true;
    let matchedCharacterVariantTargetCount = 0;
    let matchedSceneVariantTargetCount = 0;
    let failedReferenceAssetCount = 0;
    let skippedDependencyCount = 0;
    console.info("[video-reference-assets] start", {
      projectId: project.id,
      targetIds,
      requestedTargetCount: requestedTargetIds.length,
      smartBatch,
      smartBatchLimit,
      forceRegenerate,
    });
    const selectedCharacterIds = new Set(
      nextCharacters
        .filter((character) => !targetIds.length || characterReferenceTargetMatches(character, targetIds))
        .map((character) => character.id),
    );
    const selectedSceneSettingIds = new Set(
      nextSceneSettings
        .filter((sceneSetting) => !targetIds.length || sceneReferenceTargetMatches(sceneSetting, targetIds))
        .map((sceneSetting) => sceneSetting.id),
    );
    const generatedImageUrls: string[] = [];
    const generatedImageLabels: string[] = [];
    let generatedCharacterPrimaryCount = 0;
    let generatedCharacterVariantCount = 0;
    let generatedScenePrimaryCount = 0;
    let generatedSceneVariantCount = 0;
    let generatedImageSlotIndex = 0;

    for (let index = 0; index < nextCharacters.length; index += 1) {
      const character = nextCharacters[index];
      if (!character) continue;

      if (selectedCharacterIds.has(character.id) && (forceRegenerate || !character.imageUrl?.trim())) {
        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const { data, error } = await invokeFunction<{ imageUrl?: string }>(
          "generate-character",
          {
            ...imageGenerationInput,
            name: character.name,
            description: character.description,
            style: resolveProjectImagePromptStyle(project),
            assetFileNameStem: buildCharacterAssetFileStem(character.name, {
              version: resolveNextAssetVersion(character.imageUrl, character.imageHistory),
            }),
          },
          { abortSignal: buildPerImageAbortSignal(abortSignal) },
        );
        if (error) {
          if (abortSignal?.aborted) throw error;
          failedReferenceAssetCount += 1;
          if (smartBatch) {
            skippedDependencyCount += (character.costumes ?? []).filter((costume) =>
              characterVariantTargetMatches(character.id, costume.id, targetIds),
            ).length;
          }
          console.warn(`[reference] 角色《${character.name}》主图生成失败，已跳过:`, error);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
              detail: { index: slotIndex, label: character.name, reason: error instanceof Error ? error.message : String(error) },
            }));
          }
          continue;
        }

        const imageUrl = data?.imageUrl?.trim();
        if (imageUrl) {
          nextCharacters[index] = {
            ...character,
            imageUrl,
            isAIGenerated: true,
            isGenerating: false,
            imageHistory: appendImageHistory(
              character.imageUrl,
              imageUrl,
              character.description || character.name,
              character.imageHistory,
            ),
          };
          generatedImageUrls.push(imageUrl);
          const charPrimaryLabel = buildCharacterAssetLabel(character.name, {
            version: resolveNextAssetVersion(character.imageUrl, character.imageHistory),
          });
          generatedImageLabels.push(charPrimaryLabel);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
              detail: { url: imageUrl, label: charPrimaryLabel, index: slotIndex },
            }));
          }
          generatedCharacterPrimaryCount += 1;
          if (onProgress) {
            const partialProject = { ...project, characters: nextCharacters };
            const partialResult = await saveVideoProject(partialProject, "");
            onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [charPrimaryLabel] });
          }
        }
      }

      const refreshedCharacter = nextCharacters[index];
      if (!refreshedCharacter?.costumes?.length) continue;

      for (let costumeIndex = 0; costumeIndex < refreshedCharacter.costumes.length; costumeIndex += 1) {
        const costume = refreshedCharacter.costumes[costumeIndex];
        if (!costume || !characterVariantTargetMatches(refreshedCharacter.id, costume.id, targetIds)) continue;
        matchedCharacterVariantTargetCount += 1;
        const hasExplicitTarget = hasExplicitCharacterVariantTarget(
          refreshedCharacter.id,
          costume.id,
          targetIds,
        );

        const primaryReferenceImageUrl = findCharacterPrimaryReferenceImage(project, refreshedCharacter);
        if (!primaryReferenceImageUrl) {
          const message = `角色《${refreshedCharacter.name}》还没有主参考图，先生成主参考图后才能生成变体。`;
          if (!smartBatch) throw new Error(message);
          skippedDependencyCount += 1;
          console.warn(`[reference] ${message}`);
          continue;
        }
        if (!forceRegenerate && !hasExplicitTarget && costume.imageUrl?.trim()) continue;
        console.info("[video-reference-assets] generate character variant", {
          projectId: project.id,
          characterId: refreshedCharacter.id,
          variantId: costume.id,
          hasExplicitTarget,
          forceRegenerate,
          referenceImageUrl: primaryReferenceImageUrl,
        });

        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const { data, error } = await invokeFunction<{ imageUrl?: string }>(
          "generate-character",
          {
            ...imageGenerationInput,
            name: refreshedCharacter.name,
            description: costume.description?.trim()
              ? `${refreshedCharacter.description}\n角色变体：${costume.label}。${costume.description}`
              : `${refreshedCharacter.description}\n角色变体：${costume.label}`,
            style: resolveProjectImagePromptStyle(project),
            referenceImageUrl: primaryReferenceImageUrl,
            assetFileNameStem: buildCharacterAssetFileStem(refreshedCharacter.name, {
              variantLabel: costume.label,
              version: resolveNextAssetVersion(costume.imageUrl, costume.imageHistory),
            }),
          },
          { abortSignal: buildPerImageAbortSignal(abortSignal) },
        );
        if (error) {
          if (abortSignal?.aborted) throw error;
          failedReferenceAssetCount += 1;
          console.warn(`[reference] 角色《${refreshedCharacter.name}》变体《${costume.label}》生成失败，已跳过:`, error);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
              detail: { index: slotIndex, label: `${refreshedCharacter.name} · ${costume.label}`, reason: error instanceof Error ? error.message : String(error) },
            }));
          }
          continue;
        }

        const imageUrl = data?.imageUrl?.trim();
        if (!imageUrl) continue;

        const nextCostumes = [...refreshedCharacter.costumes];
        nextCostumes[costumeIndex] = {
          ...costume,
          imageUrl,
          isAIGenerated: true,
          imageHistory: appendImageHistory(
            costume.imageUrl,
            imageUrl,
            costume.description || costume.label,
            costume.imageHistory,
          ),
        };
        nextCharacters[index] = {
          ...refreshedCharacter,
          costumes: nextCostumes,
        };
        generatedImageUrls.push(imageUrl);
        const charVariantLabel = buildCharacterAssetLabel(refreshedCharacter.name, {
          variantLabel: costume.label,
          version: resolveNextAssetVersion(costume.imageUrl, costume.imageHistory),
        });
        generatedImageLabels.push(charVariantLabel);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
            detail: { url: imageUrl, label: charVariantLabel, index: slotIndex },
          }));
        }
        generatedCharacterVariantCount += 1;
        if (onProgress) {
          const partialProject = { ...project, characters: nextCharacters };
          const partialResult = await saveVideoProject(partialProject, "");
          onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [charVariantLabel] });
        }
      }
    }

    for (let index = 0; index < nextSceneSettings.length; index += 1) {
      const sceneSetting = nextSceneSettings[index];
      if (!sceneSetting) continue;

      if (selectedSceneSettingIds.has(sceneSetting.id) && (forceRegenerate || !sceneSetting.imageUrl?.trim())) {
        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const { data, error } = await invokeFunction<{ imageUrl?: string }>(
          "generate-scene",
          {
            ...imageGenerationInput,
            name: sceneSetting.name,
            description: sceneSetting.description,
            style: resolveProjectImagePromptStyle(project),
            assetFileNameStem: buildSceneAssetFileStem(sceneSetting.name, {
              version: resolveNextAssetVersion(sceneSetting.imageUrl, sceneSetting.imageHistory),
            }),
          },
          { abortSignal: buildPerImageAbortSignal(abortSignal) },
        );
        if (error) {
          if (abortSignal?.aborted) throw error;
          failedReferenceAssetCount += 1;
          if (smartBatch) {
            skippedDependencyCount += (sceneSetting.timeVariants ?? []).filter((variant) =>
              sceneVariantTargetMatches(sceneSetting.id, variant.id, targetIds),
            ).length;
          }
          console.warn(`[reference] 场景《${sceneSetting.name}》主图生成失败，已跳过:`, error);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
              detail: { index: slotIndex, label: sceneSetting.name, reason: error instanceof Error ? error.message : String(error) },
            }));
          }
          continue;
        }

        const imageUrl = data?.imageUrl?.trim();
        if (imageUrl) {
          nextSceneSettings[index] = {
            ...sceneSetting,
            imageUrl,
            isAIGenerated: true,
            isGenerating: false,
            imageHistory: appendImageHistory(
              sceneSetting.imageUrl,
              imageUrl,
              sceneSetting.description || sceneSetting.name,
              sceneSetting.imageHistory,
            ),
          };
          generatedImageUrls.push(imageUrl);
          const scenePrimaryLabel = buildSceneAssetLabel(sceneSetting.name, {
            version: resolveNextAssetVersion(sceneSetting.imageUrl, sceneSetting.imageHistory),
          });
          generatedImageLabels.push(scenePrimaryLabel);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
              detail: { url: imageUrl, label: scenePrimaryLabel, index: slotIndex },
            }));
          }
          generatedScenePrimaryCount += 1;
          if (onProgress) {
            const partialProject = { ...project, sceneSettings: nextSceneSettings };
            const partialResult = await saveVideoProject(partialProject, "");
            onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [scenePrimaryLabel] });
          }
        }
      }

      const refreshedSceneSetting = nextSceneSettings[index];
      if (!refreshedSceneSetting?.timeVariants?.length) continue;

      for (let variantIndex = 0; variantIndex < refreshedSceneSetting.timeVariants.length; variantIndex += 1) {
        const variant = refreshedSceneSetting.timeVariants[variantIndex];
        if (!variant || !sceneVariantTargetMatches(refreshedSceneSetting.id, variant.id, targetIds)) continue;
        matchedSceneVariantTargetCount += 1;
        const hasExplicitTarget = hasExplicitSceneVariantTarget(
          refreshedSceneSetting.id,
          variant.id,
          targetIds,
        );

        const primaryReferenceImageUrl = findScenePrimaryReferenceImage(project, refreshedSceneSetting);
        if (!primaryReferenceImageUrl) {
          const message = `场景《${refreshedSceneSetting.name}》还没有主参考图，先生成主参考图后才能生成变体。`;
          if (!smartBatch) throw new Error(message);
          skippedDependencyCount += 1;
          console.warn(`[reference] ${message}`);
          continue;
        }
        if (!forceRegenerate && !hasExplicitTarget && variant.imageUrl?.trim()) continue;
        console.info("[video-reference-assets] generate scene variant", {
          projectId: project.id,
          sceneSettingId: refreshedSceneSetting.id,
          variantId: variant.id,
          hasExplicitTarget,
          forceRegenerate,
          referenceImageUrl: primaryReferenceImageUrl,
        });

        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const { data, error } = await invokeFunction<{ imageUrl?: string }>(
          "generate-scene",
          {
            ...imageGenerationInput,
            name: refreshedSceneSetting.name,
            description: variant.description?.trim()
              ? `${refreshedSceneSetting.description}\n场景变体：${variant.label}。${variant.description}`
              : `${refreshedSceneSetting.description}\n场景变体：${variant.label}`,
            style: resolveProjectImagePromptStyle(project),
            referenceImageUrl: primaryReferenceImageUrl,
            assetFileNameStem: buildSceneAssetFileStem(refreshedSceneSetting.name, {
              variantLabel: variant.label,
              version: resolveNextAssetVersion(variant.imageUrl, variant.imageHistory),
            }),
          },
          { abortSignal: buildPerImageAbortSignal(abortSignal) },
        );
        if (error) {
          if (abortSignal?.aborted) throw error;
          failedReferenceAssetCount += 1;
          console.warn(`[reference] 场景《${refreshedSceneSetting.name}》变体《${variant.label}》生成失败，已跳过:`, error);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
              detail: { index: slotIndex, label: `${refreshedSceneSetting.name} · ${variant.label}`, reason: error instanceof Error ? error.message : String(error) },
            }));
          }
          continue;
        }

        const imageUrl = data?.imageUrl?.trim();
        if (!imageUrl) continue;

        const nextTimeVariants = [...refreshedSceneSetting.timeVariants];
        nextTimeVariants[variantIndex] = {
          ...variant,
          imageUrl,
          isAIGenerated: true,
          imageHistory: appendImageHistory(
            variant.imageUrl,
            imageUrl,
            variant.description || variant.label,
            variant.imageHistory,
          ),
        };
        nextSceneSettings[index] = {
          ...refreshedSceneSetting,
          timeVariants: nextTimeVariants,
        };
        generatedImageUrls.push(imageUrl);
        const sceneVariantLabel = buildSceneAssetLabel(refreshedSceneSetting.name, {
          variantLabel: variant.label,
          version: resolveNextAssetVersion(variant.imageUrl, variant.imageHistory),
        });
        generatedImageLabels.push(sceneVariantLabel);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
            detail: { url: imageUrl, label: sceneVariantLabel, index: slotIndex },
          }));
        }
        generatedSceneVariantCount += 1;
        if (onProgress) {
          const partialProject = { ...project, sceneSettings: nextSceneSettings };
          const partialResult = await saveVideoProject(partialProject, "");
          onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [sceneVariantLabel] });
        }
      }
    }

    const generationSummary = buildReferenceAssetGenerationSummary({
      characterPrimaryCount: generatedCharacterPrimaryCount,
      characterVariantCount: generatedCharacterVariantCount,
      scenePrimaryCount: generatedScenePrimaryCount,
      sceneVariantCount: generatedSceneVariantCount,
    });
    const smartBatchHint = smartBatch
      ? [
          `本轮按当前生图模型上限处理 ${targetIds.length}/${requestedTargetIds.length || targetIds.length} 个资产目标。`,
          remainingSmartTargetCount > 0 ? `还剩 ${remainingSmartTargetCount} 个，继续点击同一个按钮会补下一批。` : "",
          failedReferenceAssetCount > 0 ? `${failedReferenceAssetCount} 个生成失败，仍会保留为待补齐目标供下次重试。` : "",
          skippedDependencyCount > 0 ? `${skippedDependencyCount} 个变体因主参考图缺失已跳过，主图成功后会自动进入后续批次。` : "",
        ].filter(Boolean).join(" ")
      : "";
    const fallbackSummary = targetIds.length
      ? "当前选中的角色、场景或变体素材已齐备。"
      : "当前角色与场景参考图已齐备，可继续生成分镜图。";
    const resultSummary = [generationSummary || fallbackSummary, smartBatchHint].filter(Boolean).join("\n\n");
    if (!generationSummary && targetIds.length) {
      console.info("[video-reference-assets] skipped", {
        projectId: project.id,
        targetIds,
        forceRegenerate,
        matchedCharacterVariantTargetCount,
        matchedSceneVariantTargetCount,
      });
    }

    const result = await saveVideoProject(
      {
        ...project,
        characters: nextCharacters,
        sceneSettings: nextSceneSettings,
        currentStep: deriveVisibleVideoStep(
          synchronizeVideoProductionState({
            ...project,
            characters: nextCharacters,
            sceneSettings: nextSceneSettings,
          }),
        ),
        analysisSummary: resultSummary,
      },
      resultSummary,
    );
    return generatedImageUrls.length
      ? {
          ...result,
          imageUrls: generatedImageUrls,
          // 多张时去掉版本后缀，避免 UI 显示冗余的"版本01"等
          imageLabels: generatedImageUrls.length > 1
            ? generatedImageLabels.map((l) => l.replace(/\s*·\s*版本\d+$/, ""))
            : generatedImageLabels,
        }
      : result;
  });
}

export async function generateStoryboardFramesAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法生成分镜图。");
  }
  assertReferenceAssetsReady(synchronizeVideoProductionState(project));

  const selectedScenes = resolveGenerationScenes(
    {
      ...project,
      scenes: project.scenes.filter((scene) => !scene.storyboardUrl || input.forceRegenerate === true),
    },
    input,
  );
  if (!selectedScenes.length) {
    throw new Error("当前没有需要生成分镜图的镜头。");
  }

  localStorage.setItem("storyforge_current_project", project.id);

  return runWithVideoAbortSignal(async (abortSignal) => {
    const imageGenerationInput = buildScopedImageGenerationInput(input, { allowStoryboardMode: true });
    const nextScenes = [...project.scenes];
    const generatedImageUrls: string[] = [];
    const generatedImageLabels: string[] = [];
    let generatedCount = 0;

    for (const [sceneLoopIndex, scene] of selectedScenes.entries()) {
      const characterDetails = findCharacterDetails(scene, project.characters || []);
      const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
      const { data, error } = await invokeFunction<{ imageUrl?: string }>(
        "generate-storyboard",
        {
          ...imageGenerationInput,
          description: scene.description,
          characters: scene.characters,
          cameraDirection: scene.cameraDirection,
          sceneName: scene.sceneName,
          dialogue: scene.dialogue,
          style: resolveProjectImagePromptStyle(project),
          characterDescriptions: characterDetails,
          characterImages: characterDetails
            .filter((character) => character.imageUrl)
            .map((character) => ({ name: character.name, imageUrl: character.imageUrl! })),
          sceneDescription: matchedSetting?.description || scene.sceneName,
          sceneImageUrl: findSceneReferenceImage(scene, project.sceneSettings || []),
          assetFileNameStem: buildStoryboardAssetFileStem(scene, {
            variantLabel: matchedSetting?.timeVariants?.find(
              (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
            )?.label,
            version: resolveNextAssetVersion(scene.storyboardUrl, scene.storyboardHistory),
          }),
        },
        { abortSignal: buildPerImageAbortSignal(abortSignal) },
      );
      // 用户手动中止时向上抛出；单张超时则跳过该镜头继续生成其余镜头
      if (error) {
        if (abortSignal?.aborted) throw error;
        console.warn(`[storyboard] 镜头《${scene.sceneName}》生成失败，已跳过:`, error);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
            detail: { index: sceneLoopIndex, label: scene.sceneName, reason: error instanceof Error ? error.message : String(error) },
          }));
        }
        continue;
      }

      const imageUrl = data?.imageUrl?.trim();
      if (!imageUrl) continue;

      const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
      if (sceneIndex < 0) continue;

      nextScenes[sceneIndex] = {
        ...nextScenes[sceneIndex],
        storyboardUrl: imageUrl,
        storyboardHistory: [
          ...(nextScenes[sceneIndex].storyboardHistory || []),
          ...(
            nextScenes[sceneIndex].storyboardUrl &&
            nextScenes[sceneIndex].storyboardUrl !== imageUrl &&
            !(nextScenes[sceneIndex].storyboardHistory || []).includes(nextScenes[sceneIndex].storyboardUrl!)
              ? [nextScenes[sceneIndex].storyboardUrl!]
              : []
          ),
        ],
      };
      generatedImageUrls.push(imageUrl);
      const storyboardLabel = buildStoryboardAssetLabel(scene, {
        variantLabel: matchedSetting?.timeVariants?.find(
          (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting?.activeTimeVariantId,
        )?.label,
        version: resolveNextAssetVersion(scene.storyboardUrl, scene.storyboardHistory),
      });
      generatedImageLabels.push(storyboardLabel);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
          detail: { url: imageUrl, label: storyboardLabel, index: sceneLoopIndex },
        }));
      }
      generatedCount += 1;
      if (onProgress) {
        const partialProject = { ...project, scenes: nextScenes };
        const partialResult = await saveVideoProject(partialProject, "");
        onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [storyboardLabel] });
      }
    }

    const nextProject = synchronizeVideoProductionState({
      ...project,
      scenes: nextScenes,
      shotPackets: [],
      videoPromptBatch: "",
    });
    const realtimeSummary = buildRealtimeStoryboardSummary(nextProject);
    const result = await saveVideoProject(
      {
        ...nextProject,
        storyboardPlan: realtimeSummary.storyboardPlan,
        currentStep:
          generatedCount > 0 &&
          realtimeSummary.generatableCount === 0 &&
          realtimeSummary.blockedCount === 0
            ? 4
            : 3,
        analysisSummary:
          generatedCount > 0
            ? `已生成 ${generatedCount} 张分镜图，分镜摘要已实时更新。`
            : "当前没有新的分镜图生成结果。",
      },
      generatedCount > 0
        ? `已生成 ${generatedCount} 张分镜图。`
        : "当前没有新的分镜图生成结果。",
    );
    return generatedImageUrls.length
      ? { ...result, imageUrls: generatedImageUrls, imageLabels: generatedImageLabels }
      : result;
  });
}

export async function generateProjectImageAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const imagePrompt =
    (typeof input.imagePrompt === "string" && input.imagePrompt.trim()) ||
    (typeof input.prompt === "string" && input.prompt.trim()) ||
    "";
  if (!imagePrompt) {
    throw new Error("缺少 imagePrompt，无法生成图片。");
  }

  const title = buildVideoTitle(runtime, input);
  const normalizedImagePrefs = resolveVideoImageRequestPrefs({
    model: typeof input.model === "string" ? input.model : undefined,
    modelFamily:
      typeof input.modelFamily === "string"
        ? input.modelFamily
        : typeof input.selectedImageModelFamily === "string"
          ? input.selectedImageModelFamily
          : undefined,
    resolution: typeof input.resolution === "string" ? input.resolution : undefined,
    aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : undefined,
    imageGenerationPrefs:
      typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
        ? (input.imageGenerationPrefs as Partial<VideoImageGenerationPrefs>)
        : null,
  }).prefs;
  const style = resolveVideoImagePromptStyle(
    normalizedImagePrefs,
    (typeof input.artStyle === "string"
      ? input.artStyle
      : runtime.currentVideoProject?.artStyle || "live-action") as ArtStyle,
  );

  const isCharacter = resolveRequestedProjectImageKind(input, imagePrompt) === "character";
  const functionName = isCharacter ? "generate-character" : "generate-scene";
  const imageGenerationInput = buildScopedImageGenerationInput(input, {
    allowReferenceImage: true,
    allowViewMode: true,
  });
  const abortSignal = resolveInputAbortSignal(input);

  const { data, error } = await invokeFunction<{ imageUrl?: string }>(functionName, {
    ...imageGenerationInput,
    name: title || (isCharacter ? "角色" : "Project image"),
    description: imagePrompt,
    style,
  }, { abortSignal });
  if (error) throw error;

  const imageUrl = data?.imageUrl?.trim();
  if (!imageUrl) {
    throw new Error("图片生成未返回可用的 imageUrl。");
  }

  return {
    summary: "已生成图片。",
    imageUrls: [imageUrl],
  };
}

export async function generateVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: import("../types").WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法直接发起出片。");
  }
  const syncedProject = synchronizeVideoProductionState(project);
  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const selectedScenes = resolveGenerationScenes(syncedProject, input);
  if (!selectedScenes.length) {
    throw new Error("当前没有可提交出片的镜头，先轮询结果或指定新的镜头范围。");
  }
  assertStoryboardAssetsReadyForScenes(syncedProject, selectedScenes, videoGenerationPrefs.mode);


  const transport = await ensureVideoGenerationTransport(input);
  const nextScenes = [...syncedProject.scenes];
  let submittedCount = 0;
  const failedScenes: string[] = [];
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);
  const submittedTasks: ActiveVideoTaskRef[] = [];
  const detachAbortCancellation = attachAbortDrivenVideoCancellation(
    input,
    () => submittedTasks,
  );
  const allScenesSortedForGen = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);

  try {
    for (const scene of selectedScenes) {
      throwIfInputAborted(input);
      try {
        const genSceneIdx = allScenesSortedForGen.findIndex((s) => s.id === scene.id);
        const prevScene = genSceneIdx > 0 ? allScenesSortedForGen[genSceneIdx - 1] : undefined;
        const nextScene = genSceneIdx < allScenesSortedForGen.length - 1 ? allScenesSortedForGen[genSceneIdx + 1] : undefined;
        const prompt = await buildSceneVideoPrompt(syncedProject, scene, {
          prevDescription: prevScene?.description,
          nextDescription: nextScene?.description,
          excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
        });
        const referenceImageUrl = findSceneReferenceImage(scene, syncedProject.sceneSettings || [], {
          excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
        });
        const shouldUseReferenceImage = videoGenerationPrefs.mode === "image-to-video";
        if (shouldUseReferenceImage && !referenceImageUrl) {
          throw new Error(`镜头《${scene.sceneName}》缺少参考图，暂时不能走图生视频。`);
        }
        const { data, error } = await invokeFunction<VideoGenerationResult>(
          "generate-video",
          {
            prompt: prompt.enhanced,
            duration: prompt.duration ?? scene.recommendedDuration ?? scene.duration ?? 5,
            aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : "16:9",
            resolution: videoGenerationPrefs.resolution,
            model: resolvedModel,
            provider: transport.provider || resolveVideoGenerationProvider(videoGenerationPrefs),
            ...(shouldUseReferenceImage && referenceImageUrl ? { imageUrl: referenceImageUrl } : {}),
          },
          { abortSignal: resolveInputAbortSignal(input) },
        );

        if (error) throw error;

        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex < 0) continue;

        const taskId = String(data?.task_id || nextScenes[sceneIndex].videoTaskId || "").trim();
        const taskProvider =
          data?.provider || transport.provider || nextScenes[sceneIndex].videoProvider;
        if (!taskId) {
          throw new Error("视频任务已提交但未返回 task_id，无法继续轮询结果。");
        }
        if (taskId) {
          submittedTasks.push({
            taskId,
            provider: taskProvider,
          });
        }

        nextScenes[sceneIndex] = {
          ...nextScenes[sceneIndex],
          videoHistory: appendVideoHistory(nextScenes[sceneIndex]),
          videoUrl: undefined,
          videoTaskId: taskId || nextScenes[sceneIndex].videoTaskId,
          videoProvider: taskProvider,
          videoStatus: normalizeSceneStatus(data?.status),
          videoFailure: undefined,
          recommendedDuration: prompt.duration ?? nextScenes[sceneIndex].recommendedDuration,
        };
        submittedCount += 1;
        logVideoWorkflowSceneEvent("submit", {
          sceneId: nextScenes[sceneIndex].id,
          scene: nextScenes[sceneIndex].sceneName,
          taskId,
          provider: taskProvider,
          status: normalizeSceneStatus(data?.status) || data?.status || "queued",
          mode: videoGenerationPrefs.mode,
        });
      } catch (error) {
        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex >= 0) {
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: summarizeVideoGenerationError(error),
              provider: transport.provider,
              stage: "submit",
              updatedAt: new Date().toISOString(),
            },
          };
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            provider: transport.provider,
            message: nextScenes[sceneIndex].videoFailure?.message,
          });
        }
        failedScenes.push(scene.sceneName);
      }
    }
  } finally {
    detachAbortCancellation();
  }

  // 自动轮询：提交后持续查询任务状态，直到全部完成/失败或超时
  const completedVideoUrls: string[] = [];
  if (submittedCount > 0) {
    const MAX_POLL_ROUNDS = 24;   // 最多轮询 24 次
    const POLL_INTERVAL_MS = 10_000; // 每次间隔 10 秒
    for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
      throwIfInputAborted(input);
      const pendingScenes = nextScenes.filter(
        (s) => s.videoTaskId?.trim() && ["queued", "processing"].includes(normalizeSceneStatus(s.videoStatus)),
      );
      if (!pendingScenes.length) break;

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      throwIfInputAborted(input);

      for (const scene of pendingScenes) {
        throwIfInputAborted(input);
        const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
          "generate-video",
          { action: "status", taskId: scene.videoTaskId, provider: scene.videoProvider },
          { abortSignal: resolveInputAbortSignal(input) },
        );
        const sceneIndex = nextScenes.findIndex((s) => s.id === scene.id);
        if (sceneIndex < 0) continue;

        if (error) {
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: summarizeVideoGenerationError(error),
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          continue;
        }

        const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
        if (normalizedStatus === "completed" && data?.video_url) {
          const remoteVideoUrl = data.video_url;
          const fileName = `${buildVideoAssetFileStem(nextScenes[sceneIndex])}.mp4`;
          const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, syncedProject.id);
          const persistedVideoUrl = cachedVideo?.localPath ?? remoteVideoUrl;
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoHistory: appendVideoHistory(nextScenes[sceneIndex], persistedVideoUrl),
            videoUrl: persistedVideoUrl,
            videoStatus: "completed",
            videoFailure: undefined,
          };
          completedVideoUrls.push(persistedVideoUrl);
          logVideoWorkflowSceneEvent("result", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: "completed",
            video: persistedVideoUrl,
          });

          // 完成一条即刻保存并通知调用方，素材库可立即归档
          if (onProgress) {
            const partialProject = { ...syncedProject, scenes: nextScenes };
            const partialResult = await saveVideoProject(partialProject, "");
            onProgress({ ...partialResult, videoUrls: [persistedVideoUrl] });
            // 逐条替换聊天框中的占位符
            const sceneIndexInSelected = selectedScenes.findIndex((s) => s.id === scene.id);
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("agent:video-generated-one", {
                detail: {
                  url: persistedVideoUrl,
                  label: nextScenes[sceneIndex].sceneName,
                  index: sceneIndexInSelected >= 0 ? sceneIndexInSelected : completedVideoUrls.length - 1,
                  sceneId: nextScenes[sceneIndex].id,
                  projectId: syncedProject.id,
                },
              }));
            }
          }
        } else if (normalizedStatus === "completed") {
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: data?.status || data?.state || "completed",
            message: "状态已完成但未返回 video_url",
          });
        } else if (normalizedStatus === "failed") {
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: "视频生成失败，建议调整提示词后重新提交。",
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: "failed",
            message: nextScenes[sceneIndex].videoFailure?.message,
          });
        } else {
          nextScenes[sceneIndex] = { ...nextScenes[sceneIndex], videoStatus: normalizedStatus };
          logVideoWorkflowSceneEvent("status", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: normalizedStatus,
          });
        }
      }
    }

    // 轮询结束后仍处于 queued/processing 的镜头视为超时失败
    for (const scene of nextScenes) {
      if (
        scene.videoTaskId?.trim() &&
        ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus))
      ) {
        const sceneIndex = nextScenes.findIndex((s) => s.id === scene.id);
        if (sceneIndex >= 0) {
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: "生成超时，请重新生成。",
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          failedScenes.push(scene.sceneName);
        }
      }
    }
  }

  const completedCount = completedVideoUrls.length;

  // 收集本次完成的镜头名称（videoUrl 在 completedVideoUrls 中）
  const completedSceneNames = nextScenes
    .filter((s) => s.videoStatus === "completed" && s.videoUrl && completedVideoUrls.includes(s.videoUrl))
    .map((s) => s.sceneName);

  // 收集所有失败镜头及原因（含提交失败 + 轮询失败 + 超时失败）
  const failedScenesWithReasons = nextScenes
    .filter((s) => normalizeSceneStatus(s.videoStatus) === "failed" && s.videoFailure?.message)
    .map((s) => `${s.sceneName}（${s.videoFailure!.message}）`);

  const summaryParts: string[] = [];
  if (!submittedCount) {
    summaryParts.push("当前没有镜头成功提交出片任务。");
  } else {
    if (completedSceneNames.length) {
      summaryParts.push(`已完成出片（${completedSceneNames.length} 条）：${completedSceneNames.join("、")}`);
    }
    if (failedScenesWithReasons.length) {
      summaryParts.push(`生成失败（${failedScenesWithReasons.length} 条）：${failedScenesWithReasons.join("、")}`);
    }
    if (!completedSceneNames.length && !failedScenesWithReasons.length) {
      summaryParts.push(`已提交 ${submittedCount} 条镜头出片任务，当前优先走 ${transport.providerLabel}。`);
    }
  }
  const summary = summaryParts.filter(Boolean).join("\n");

  const result = await saveVideoProject(
    (() => {
      const nextProject = {
      ...syncedProject,
      scenes: nextScenes,
      currentStep: deriveVisibleVideoStep(
        synchronizeVideoProductionState({
          ...syncedProject,
          scenes: nextScenes,
          videoGenerationPrefs,
        }),
      ),
      videoGenerationPrefs,
      analysisSummary: completedCount
        ? `已完成 ${completedCount} 条镜头出片，可继续审阅或补发剩余镜头。`
        : submittedCount
          ? `已发起 ${submittedCount} 条镜头出片任务，可继续补发剩余镜头或进入审阅。`
          : "当前没有成功提交新的出片任务，建议检查镜头素材和提示词。",
      };
      return nextProject;
    })(),
    summary,
  );
  return completedVideoUrls.length ? { ...result, videoUrls: completedVideoUrls } : result;
}

export async function refreshVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  const targetIds = collectTargetIds(input);
  const candidates = project.scenes.filter((scene) => {
    if (!scene.videoTaskId?.trim()) return false;
    if (targetIds.length) return sceneTargetMatches(scene, project.id, targetIds);
    return ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus));
  });

  if (!candidates.length) {
    throw new Error("当前没有可轮询的出片任务。");
  }

  const nextScenes = [...project.scenes];
  let completedCount = 0;
  let processingCount = 0;
  let failedCount = 0;
  let hasSceneChanges = false;
  const completedVideoUrls: string[] = [];
  const detachAbortCancellation = attachAbortDrivenVideoCancellation(
    input,
    () =>
      candidates.map((scene) => ({
        taskId: scene.videoTaskId || "",
        provider: scene.videoProvider,
      })),
  );

  try {
    for (const scene of candidates) {
      throwIfInputAborted(input);
      const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
        "generate-video",
        {
          action: "status",
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
        },
        { abortSignal: resolveInputAbortSignal(input) },
      );

      if (error) {
        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex >= 0) {
          const nextScene = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: summarizeVideoGenerationError(error),
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
          nextScenes[sceneIndex] = nextScene;
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScene.id,
            scene: nextScene.sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            message: nextScene.videoFailure?.message,
          });
        }
        failedCount += 1;
        continue;
      }

      const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
      if (sceneIndex < 0) continue;

      const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
      if (normalizedStatus === "completed" && data?.video_url) {
        const remoteVideoUrl = data.video_url;
        const fileName = `${buildVideoAssetFileStem(nextScenes[sceneIndex])}.mp4`;
        const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, project.id);
        const persistedVideoUrl = cachedVideo?.localPath ?? remoteVideoUrl;
        const nextScene = {
          ...nextScenes[sceneIndex],
          videoHistory: appendVideoHistory(nextScenes[sceneIndex], persistedVideoUrl),
          videoUrl: persistedVideoUrl,
          videoStatus: "completed",
          videoFailure: undefined,
        };
        hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
        nextScenes[sceneIndex] = nextScene;
        completedVideoUrls.push(persistedVideoUrl);
        completedCount += 1;
        logVideoWorkflowSceneEvent("result", {
          sceneId: nextScene.id,
          scene: nextScene.sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: "completed",
          video: persistedVideoUrl,
        });
        continue;
      }

      if (normalizedStatus === "completed") {
        logVideoWorkflowSceneEvent("warning", {
          sceneId: nextScenes[sceneIndex].id,
          scene: nextScenes[sceneIndex].sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: data?.status || data?.state || "completed",
          message: "状态已完成但未返回 video_url",
        });
      }

      if (normalizedStatus === "failed") {
        const nextScene = {
          ...nextScenes[sceneIndex],
          videoStatus: "failed",
          videoFailure: {
            message: "轮询结果显示当前镜头生成失败，建议直接重做或调整提示词后补发。",
            provider: scene.videoProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        };
        hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
        nextScenes[sceneIndex] = nextScene;
        failedCount += 1;
        logVideoWorkflowSceneEvent("warning", {
          sceneId: nextScene.id,
          scene: nextScene.sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: "failed",
          message: nextScene.videoFailure?.message,
        });
        continue;
      }

      const nextScene = {
        ...nextScenes[sceneIndex],
        videoStatus: normalizedStatus,
        videoFailure: undefined,
      };
      hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
      nextScenes[sceneIndex] = nextScene;
      processingCount += 1;
      logVideoWorkflowSceneEvent("status", {
        sceneId: nextScene.id,
        scene: nextScene.sceneName,
        taskId: scene.videoTaskId,
        provider: scene.videoProvider,
        status: normalizedStatus,
      });
    }
  } finally {
    detachAbortCancellation();
  }

  const summary = [
    completedCount ? `已完成 ${completedCount} 条镜头出片。` : "",
    processingCount ? `仍有 ${processingCount} 条镜头在后台处理中。` : "",
    failedCount ? `${failedCount} 条镜头出片失败，建议直接发起重做。` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!hasSceneChanges) {
    return {
      summary: summary || "当前出片任务状态未变化。",
    };
  }

  const result = await saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      scenes: nextScenes,
      currentStep: deriveVisibleVideoStep(
        synchronizeVideoProductionState({
          ...project,
          scenes: nextScenes,
        }),
      ),
      analysisSummary: completedCount
        ? `已回收 ${completedCount} 条镜头结果，可继续审阅或重做。`
        : processingCount
          ? `当前仍有 ${processingCount} 条镜头在出片中，稍后可继续轮询。`
          : "当前轮询已完成，可继续处理失败项或补发新镜头。",
      };
      return nextProject;
    })(),
    summary || "已刷新当前出片任务状态。",
  );
  return completedVideoUrls.length ? { ...result, videoUrls: completedVideoUrls } : result;
}

type VideoReviewQueueItem = NonNullable<PersistedVideoProject["reviewQueue"]>[number];

function videoReviewItemMatches(item: VideoReviewQueueItem, targetIds: string[]): boolean {
  if (!targetIds.length) return true;
  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === item.id ||
      item.targetIds.includes(normalized) ||
      item.targetIds.some((itemTargetId) => normalized.endsWith(`:${itemTargetId}`))
    );
  });
}

function resolveVideoReviewTargets(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
): {
  targetIds: string[];
  selectedReviewIds: Set<string>;
  selectedTargetIds: Set<string>;
  reviewQueue: VideoReviewQueueItem[];
} {
  const targetIds = collectTargetIds(input);
  const reviewQueue = project.reviewQueue ?? [];
  const selectedItems = reviewQueue.filter((item) => videoReviewItemMatches(item, targetIds));
  const selectedReviewIds = new Set(selectedItems.map((item) => item.id));
  const selectedTargetIds = new Set<string>([
    ...targetIds,
    ...selectedItems.flatMap((item) => item.targetIds),
  ]);

  if (!selectedTargetIds.size && project.shotPackets?.length) {
    for (const packet of project.shotPackets) {
      selectedTargetIds.add(packet.id);
    }
  }

  return {
    targetIds,
    selectedReviewIds,
    selectedTargetIds,
    reviewQueue,
  };
}

function ensureReviewItemForPacket(
  project: PersistedVideoProject,
  packet: VideoShotPacket,
  status: string,
  reason: string,
  timestamp: string,
): VideoReviewQueueItem {
  const scene = project.scenes.find((item) => item.id === packet.sceneId);
  return {
    id: `review:${packet.id}`,
    title: packet.title || scene?.sceneName || `镜头 ${packet.sceneNumber}`,
    summary: reason || "镜头已有可审阅素材，确认是否通过或需要重做。",
    targetIds: [packet.id],
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function reviewVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const syncedProject = synchronizeVideoProductionState(project);
  const reviewCount = syncedProject.reviewQueue?.length ?? 0;
  return saveVideoProject(
    {
      ...syncedProject,
      currentStep: deriveVisibleVideoStep(syncedProject),
      analysisSummary: reviewCount
        ? `已整理 ${reviewCount} 条待审阅视频素材。`
        : "当前没有需要审阅的视频素材。",
    },
    reviewCount ? `已整理 ${reviewCount} 条待审阅视频素材。` : "当前没有需要审阅的视频素材。",
  );
}

export async function approveVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = synchronizeVideoProductionState(
    mergeVideoInputContext(await ensureVideoProject(runtime, input), runtime, input),
  );
  const timestamp = new Date().toISOString();
  const { selectedReviewIds, selectedTargetIds, reviewQueue } = resolveVideoReviewTargets(project, input);

  const nextReviewQueue = reviewQueue.map((item) =>
    selectedReviewIds.has(item.id) || item.targetIds.some((targetId) => selectedTargetIds.has(targetId))
      ? { ...item, status: "approved", updatedAt: timestamp }
      : item,
  );
  const nextShotPackets = (project.shotPackets ?? []).map((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const selected =
      selectedTargetIds.has(packet.id) ||
      (scene ? sceneTargetMatches(scene, project.id, [...selectedTargetIds]) : false);
    return selected ? { ...packet, reviewStatus: "approved" } : packet;
  });
  const approvedCount = nextShotPackets.filter((packet) => packet.reviewStatus === "approved").length;

  return saveVideoProject(
    {
      ...project,
      shotPackets: nextShotPackets,
      reviewQueue: nextReviewQueue,
      currentStep: deriveVisibleVideoStep(project),
      analysisSummary: approvedCount
        ? `已通过 ${approvedCount} 条视频审阅项。`
        : "当前没有匹配到可通过的视频审阅项。",
    },
    approvedCount ? `已通过 ${approvedCount} 条视频审阅项。` : "当前没有匹配到可通过的视频审阅项。",
  );
}

export async function redoVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = synchronizeVideoProductionState(
    mergeVideoInputContext(await ensureVideoProject(runtime, input), runtime, input),
  );
  const timestamp = new Date().toISOString();
  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim()
    : "用户标记需要重做。";
  const { selectedReviewIds, selectedTargetIds, reviewQueue } = resolveVideoReviewTargets(project, input);

  const nextShotPackets = (project.shotPackets ?? []).map((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const selected =
      selectedTargetIds.has(packet.id) ||
      (scene ? sceneTargetMatches(scene, project.id, [...selectedTargetIds]) : false);
    return selected ? { ...packet, reviewStatus: "redo" } : packet;
  });

  const nextReviewById = new Map(
    reviewQueue.map((item) => {
      const selected =
        selectedReviewIds.has(item.id) ||
        item.targetIds.some((targetId) => selectedTargetIds.has(targetId));
      return [
        item.id,
        selected
          ? {
              ...item,
              status: "redo",
              summary: reason,
              updatedAt: timestamp,
            }
          : item,
      ] as const;
    }),
  );

  for (const packet of nextShotPackets) {
    if (packet.reviewStatus !== "redo") continue;
    const reviewId = `review:${packet.id}`;
    if (!nextReviewById.has(reviewId)) {
      nextReviewById.set(reviewId, ensureReviewItemForPacket(project, packet, "redo", reason, timestamp));
    }
  }

  const redoCount = nextShotPackets.filter((packet) => packet.reviewStatus === "redo").length;

  return saveVideoProject(
    {
      ...project,
      shotPackets: nextShotPackets,
      reviewQueue: [...nextReviewById.values()],
      currentStep: deriveVisibleVideoStep(project),
      analysisSummary: redoCount
        ? `已有 ${redoCount} 条镜头被标记为重做。`
        : "当前没有匹配到需要重做的视频审阅项。",
    },
    redoCount ? `已将 ${redoCount} 条审阅项标记为重做。` : "当前没有匹配到需要重做的视频审阅项。",
  );
}

function collectTargetIds(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.targetIds)
    ? input.targetIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];

  if (list.length > 0) return list;
  if (typeof input.targetId === "string" && input.targetId.trim()) {
    return [input.targetId.trim()];
  }
  return [];
}

export async function compileSegmentVideosAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有可合并的分镜视频，先完成出片再执行 AI 自动处理导出。");
  }

  const completedCount = project.scenes.filter((s) => s.videoStatus === "completed" && s.videoUrl).length;
  if (completedCount === 0) {
    throw new Error("当前没有已完成的分镜视频，请先完成出片。");
  }

  const { compileSegmentVideos } = await import("@/lib/home-agent/ffmpeg-segment-service");
  const addSubtitles = input.addSubtitles === true;

  const report = await compileSegmentVideos(project, { addSubtitles });

  if (report.compiled.length === 0) {
    const skipReasons = report.skipped.map((s) => `• 片段 ${s.segmentLabel}：${s.reason}`).join("\n");
    throw new Error(`所有片段均未能合并。\n${skipReasons}`);
  }

  // 将合并结果写入 segmentVideos 字段
  const nextSegmentVideos: Record<string, string> = { ...(project.segmentVideos ?? {}) };
  for (const result of report.compiled) {
    nextSegmentVideos[result.segmentLabel] = result.outputPath;
  }

  const summaryLines = [
    `已合并 ${report.compiled.length} 个片段视频${addSubtitles ? "（含字幕）" : ""}：`,
    ...report.compiled.map((r) => `• 片段 ${r.segmentLabel}（${r.sceneCount} 个分镜）→ ${r.outputPath}`),
  ];
  if (report.skipped.length) {
    summaryLines.push("", `跳过 ${report.skipped.length} 个片段：`);
    summaryLines.push(...report.skipped.map((s) => `• 片段 ${s.segmentLabel}：${s.reason}`));
  }

  return saveVideoProject(
    {
      ...project,
      segmentVideos: nextSegmentVideos,
    },
    summaryLines.join("\n"),
  );
}

export async function exportStoryboardXlsxAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有可导出的拆镜结果，先完成剧本拆解再导出 xlsx。");
  }

  const { exportScenesToXlsx } = await import("@/lib/export-xlsx");
  await exportScenesToXlsx(
    project.scenes,
    buildVideoTitle(runtime, input),
    project.characters || [],
    project.sceneSettings || [],
  );

  const snapshot = createVideoSnapshot(synchronizeVideoProductionState(project));
  return {
    summary: `已导出《${project.title}》的 storyboard xlsx。`,
    projectSnapshot: snapshot,
    recommendedActions: snapshot.recommendedActions,
    data: {
      videoProject: project,
      projectSnapshot: snapshot,
    },
  };
}

export async function continueVideoStepAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const derivedStep =
    typeof input.targetStep === "number"
      ? Math.min(Math.max(input.targetStep, 1), 5)
      : deriveVisibleVideoStep(synchronizeVideoProductionState(project));

  const stageLabels: Record<number, string> = {
    1: "脚本拆解",
    2: "角色与场景",
    3: "分镜图生成",
    4: "视频生成",
    5: "预览与导出",
  };

  // 计算自然进度步骤（基于已完成数据推导，不受 currentStep 影响）
  const naturalStep = deriveVisibleVideoStep(synchronizeVideoProductionState(project));
  const stepGate = canSwitchToVideoWorkflowStep(
    synchronizeVideoProductionState(project),
    derivedStep,
    project.videoGenerationPrefs?.mode,
  );
  if (!stepGate.allowed) {
    throw new Error(stepGate.reason || "当前项目还没有满足切换到该视频步骤的基础条件。");
  }
  // 用户跳到比自然进度更靠后的步骤时，记录 manualStepOverride 以阻止自动推进；
  // 切回自然进度或更早的步骤时，清除该标记。
  const nextManualStepOverride = derivedStep > naturalStep ? derivedStep : null;

  return saveVideoProject(
    {
      ...project,
      currentStep: derivedStep,
      manualStepOverride: nextManualStepOverride,
      analysisSummary:
        project.analysisSummary ||
        `已把视频项目收口到「${stageLabels[derivedStep]}」阶段，可直接继续推进。`,
    },
    `已将《${project.title}》定位到「${stageLabels[derivedStep]}」阶段。`,
  );
}

async function runVideoContinuationPlan(
  plan: VideoWorkflowContinuationPlan,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  switch (plan.actionKind) {
    case "analyze_script_for_video":
      return analyzeScriptForVideoAction(plan.input, runtime);
    case "extract_video_entities":
      return extractVideoEntitiesAction(plan.input, runtime);
    case "generate_video_reference_assets":
      return generateVideoReferenceAssetsAction(plan.input, runtime);
    case "prepare_storyboard_batch":
      return prepareStoryboardBatchAction(plan.input, runtime);
    case "generate_storyboard_frames":
      return generateStoryboardFramesAction(plan.input, runtime);
    case "compile_video_shot_packets":
      return compileVideoShotPacketsAction(plan.input, runtime);
    case "prepare_video_prompt_batch":
      return prepareVideoPromptBatchAction(plan.input, runtime);
    case "generate_video_assets":
      return generateVideoAssetsAction(plan.input, runtime);
    case "export_storyboard_xlsx":
      return exportStoryboardXlsxAction(plan.input, runtime);
    case "create_video_bridge_artifact":
      return createVideoBridgeArtifactAction(plan.input, runtime);
    default:
      throw new Error(`Unsupported video continuation action: ${plan.actionKind}`);
  }
}

function buildRoundStepLabel(plan: VideoWorkflowContinuationPlan): string {
  const labels: Record<VideoWorkflowContinuationPlan["policy"], string> = {
    "bootstrap-analysis": "完成脚本拆镜",
    "bootstrap-entities": "整理角色与场景",
    "bootstrap-reference-assets": "补齐角色与场景参考图",
    "bootstrap-storyboard-text": "整理分镜文本",
    "bootstrap-storyboard-frames": "补齐分镜图",
    "bootstrap-shot-packets": "编译镜头指令包",
    "bootstrap-prompt-batch": "生成视频提示词批次",
    "refresh-running": "刷新进行中镜头",
    "repair-failed": "补发失败镜头",
    "generate-next-batch": "提交下一批镜头出片",
    "bridge-summary": "整理桥接摘要",
  };

  return labels[plan.policy];
}

export async function advanceVideoWorkflowAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const prepared = await prepareVideoGenerationAction(input, runtime);
  const preparedProject = prepared.data?.videoProject;
  if (!preparedProject) {
    return prepared;
  }

  const preparedRuntime = withVideoProject(runtime, preparedProject);
  const contextSummary = buildVideoContextSummary(preparedProject);

  if (!preparedProject.script?.trim()) {
    return {
      ...prepared,
      summary: [
        prepared.summary,
        contextSummary ? `已记录当前视频意图：\n${contextSummary}` : null,
        "接下来只要把脚本、分集正文或现有项目内容发给我，我就会继续拆镜和出片准备。",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const plan = planVideoWorkflowContinuation(preparedProject, input);
  const result = await runVideoContinuationPlan(
    plan,
    withVideoProject(preparedRuntime, preparedProject),
  );
  const batchHint = buildVideoContinuationBatchHint(plan);

  return {
    ...result,
    summary: [plan.reason, result.summary, batchHint].filter(Boolean).join("\n\n"),
  };
}

export async function advanceVideoWorkflowRoundAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const prepared = await prepareVideoGenerationAction(input, runtime);
  const preparedProject = prepared.data?.videoProject;
  if (!preparedProject) {
    return prepared;
  }

  if (!preparedProject.script?.trim()) {
    return advanceVideoWorkflowAction(input, runtime);
  }

  let workingRuntime = withVideoProject(runtime, preparedProject);
  let latestResult: WorkflowActionResult = prepared;
  const executedPlans: VideoWorkflowContinuationPlan[] = [];
  const maxSteps =
    typeof input.maxSteps === "number" && Number.isFinite(input.maxSteps)
      ? Math.max(1, Math.min(8, Math.floor(input.maxSteps)))
      : 6;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const currentProject = workingRuntime.currentVideoProject;
    if (!currentProject?.script?.trim()) break;

    const plan = planVideoWorkflowContinuation(currentProject, input);
    executedPlans.push(plan);
    latestResult = await runVideoContinuationPlan(plan, workingRuntime);

    const nextProject = latestResult.data?.videoProject ?? workingRuntime.currentVideoProject;
    if (nextProject) {
      workingRuntime = withVideoProject(
        {
          ...workingRuntime,
          currentVideoProject: nextProject,
          currentProjectSnapshot: latestResult.data?.projectSnapshot ?? createVideoSnapshot(nextProject),
        },
        nextProject,
      );
    } else if (latestResult.data?.projectSnapshot) {
      workingRuntime = {
        ...workingRuntime,
        currentProjectSnapshot: latestResult.data.projectSnapshot,
      };
    }

    if (VIDEO_ROUND_TERMINAL_POLICIES.has(plan.policy)) {
      break;
    }
  }

  const roundSummary = executedPlans.length
    ? `本轮连续推进了 ${executedPlans.length} 步：${executedPlans.map(buildRoundStepLabel).join(" -> ")}。`
    : "";
  const finalPlan = executedPlans.at(-1);
  const batchHint = finalPlan ? buildVideoContinuationBatchHint(finalPlan) : "";

  return {
    ...latestResult,
    summary: [roundSummary, latestResult.summary, batchHint].filter(Boolean).join("\n\n"),
  };
}

export async function createVideoBridgeArtifactAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  const bridge = [
    `项目：${buildVideoTitle(runtime, input)}`,
    `脚本长度：${script.length} 字`,
    `镜头数：${project.scenes.length}`,
    `角色数：${project.characters.length}`,
    `场景数：${project.sceneSettings.length}`,
    `当前阶段：${project.currentStep}`,
    "",
    project.analysisSummary || "视频工作流已接管，等待进一步分析。",
  ].join("\n");

  const nextProject = {
    ...project,
    targetPlatform: project.targetPlatform,
    shotStyle: project.shotStyle,
    outputGoal: project.outputGoal,
    analysisSummary: bridge,
    currentStep: deriveVisibleVideoStep(synchronizeVideoProductionState(project)),
  };

  return saveVideoProject(
    nextProject,
    `已为《${project.title}》整理视频桥接摘要。`,
  );
}

// ---- 片段提示词生成 ----

function buildFallbackSegmentPrompt(
  orderedScenes: Scene[],
  project: PersistedVideoProject,
  effectiveDuration: number,
): string {
  const stylePrefix = [
    project.styleLock?.visualStyle ? `Cinematic ${project.styleLock.visualStyle}.` : "Cinematic live-action drama.",
    project.styleLock?.tone ? `Tone: ${project.styleLock.tone}.` : "",
  ].filter(Boolean).join(" ");

  const involvedCharacterNames = new Set(orderedScenes.flatMap((s) => s.characters));
  const characterLines = (project.characters ?? [])
    .filter((c) => involvedCharacterNames.has(c.name))
    .map((c) => `${c.name}：${c.description}`)
    .filter(Boolean);
  const characterBlock = characterLines.length ? `角色设定：${characterLines.join("；")}` : "";

  const continuityRule =
    "严格保持所有分镜的视觉连贯性：同一角色在每个镜头中必须保持完全相同的外貌、服装和面部特征。镜头之间无缝衔接，不得出现角色外观、服装或场景环境的突变。";

  let elapsed = 0;
  const shotLines = orderedScenes.map((scene, idx) => {
    const dur = scene.recommendedDuration ?? scene.duration ?? Math.round(effectiveDuration / orderedScenes.length);
    const start = elapsed;
    elapsed += dur;
    const prompt = buildSegmentShotCorePrompt(scene);
    const dialogueLine = scene.dialogue?.trim() ? ` Exact dialogue: ${scene.dialogue.trim()}` : "";
    return `Shot ${idx + 1} (${start}-${Math.min(elapsed, effectiveDuration)}s): ${prompt}${dialogueLine}`;
  });

  return appendExactDialogueLock(
    [stylePrefix, characterBlock, continuityRule, ...shotLines].filter(Boolean).join("\n"),
    collectSegmentDialogueLock(orderedScenes),
  );
}

function buildSegmentShotRawPrompt(scene: Scene): string {
  return scene.description?.trim() || scene.sceneName?.trim() || "继续当前镜头动作";
}

function buildSegmentShotCorePrompt(scene: Scene): string {
  const enhancedPrompt = stripExactDialogueLockBlock(scene.enhancedVideoPrompt);
  return enhancedPrompt ? truncate(enhancedPrompt, 900) : buildSegmentShotRawPrompt(scene);
}

function getSegmentShotPromptSource(scene: Scene): "enhanced" | "raw" {
  return stripExactDialogueLockBlock(scene.enhancedVideoPrompt) ? "enhanced" : "raw";
}

function buildRequiredSegmentCoverageBlock(
  orderedScenes: Scene[],
  targetDuration: number,
): string {
  let elapsed = 0;
  const shotLines = orderedScenes.flatMap((scene, idx) => {
    const duration = scene.recommendedDuration ?? scene.duration ?? Math.round(targetDuration / orderedScenes.length);
    const start = elapsed;
    elapsed += duration;
    const end = Math.min(elapsed, targetDuration);
    return [
      `分镜 ${idx + 1} / 镜头 ${scene.sceneNumber} / ${start}-${end}s：${scene.sceneName}。核心画面：${buildSegmentShotRawPrompt(scene)}`,
      scene.cameraDirection?.trim() ? `镜头指令：${scene.cameraDirection.trim()}` : "",
      scene.dialogue?.trim() ? `台词：${scene.dialogue.trim()}` : "台词：无",
    ].filter(Boolean);
  });

  return [
    "【硬性分镜保留清单】",
    `目标总时长：${targetDuration}s。以下 ${orderedScenes.length} 个分镜必须按顺序全部出现在成片中。`,
    "这是最终执行校验清单，不要展开复述；只用于保证不漏镜头、不改剧情因果、不新增台词。",
    ...shotLines,
  ].join("\n");
}

function appendRequiredSegmentCoverage(
  prompt: string,
  orderedScenes: Scene[],
  targetDuration: number,
): string {
  return [
    prompt.trim(),
    buildRequiredSegmentCoverageBlock(orderedScenes, targetDuration),
  ].filter(Boolean).join("\n\n");
}

function hasReadySegmentVideoPrompt(
  prompts: Record<string, SegmentVideoPrompt> | undefined,
  segmentLabel: string,
): boolean {
  return Boolean(prompts?.[segmentLabel]?.prompt?.trim());
}

function buildSegmentContinuitySummary(
  segmentLabel: string,
  scenes: Scene[] | undefined,
): string {
  if (!scenes?.length) return "";
  const orderedScenes = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const firstScene = orderedScenes[0];
  const lastScene = orderedScenes.at(-1);
  return [
    `片段 ${segmentLabel}`,
    firstScene?.sceneName || lastScene?.sceneName
      ? `场景：${[firstScene?.sceneName, lastScene?.sceneName].filter(Boolean).join(" -> ")}`
      : "",
    `镜头：${orderedScenes.map((scene) => `${scene.sceneNumber}.${scene.sceneName}`).join(" / ")}`,
    `内容：${orderedScenes
      .map((scene) => scene.description?.trim())
      .filter(Boolean)
      .join("；")}`,
  ].filter(Boolean).join("\n");
}

function buildSegmentPromptContinuityContext(params: {
  segmentLabel: string;
  segmentOrder: string[];
  segmentMap: Map<string, Scene[]>;
  segmentPrompts: Record<string, SegmentVideoPrompt>;
}): {
  previousSegmentSummary: string;
  nextSegmentSummary: string;
  previousSegmentPrompt: string;
  continuityRules: string;
} {
  const currentIndex = params.segmentOrder.indexOf(params.segmentLabel);
  const previousLabel = currentIndex > 0 ? params.segmentOrder[currentIndex - 1] : "";
  const nextLabel =
    currentIndex >= 0 && currentIndex < params.segmentOrder.length - 1
      ? params.segmentOrder[currentIndex + 1]
      : "";
  const previousPrompt = previousLabel
    ? stripExactDialogueLockBlock(params.segmentPrompts[previousLabel]?.prompt ?? "").slice(-800)
    : "";

  return {
    previousSegmentSummary: previousLabel
      ? buildSegmentContinuitySummary(previousLabel, params.segmentMap.get(previousLabel))
      : "",
    nextSegmentSummary: nextLabel
      ? buildSegmentContinuitySummary(nextLabel, params.segmentMap.get(nextLabel))
      : "",
    previousSegmentPrompt: previousPrompt,
    continuityRules: [
      "严格保持所有分镜的视觉连贯性：同一角色在每个镜头中必须保持完全相同的外貌、服装和面部特征。",
      "镜头之间无缝衔接，不得出现角色外观、服装或场景环境的突变。",
      "若存在上一片段结尾或前后片段摘要，当前片段开头必须承接上一片段的动作结果、情绪状态、视线方向、空间方位和叙事因果，并自然引向下一片段。",
    ].join(""),
  };
}

export async function prepareSegmentVideoPromptAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法生成片段提示词。");
  }

  const syncedProject = synchronizeVideoProductionState(project);
  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const maxDuration = getVideoModelMaxDuration(videoGenerationPrefs.modelKey);
  const effectiveDuration = Math.min(VIDEO_SEGMENT_DESIGN_DURATION, maxDuration);

  const batchMode = typeof input.batchMode === "string" ? input.batchMode : "all";
  const targetEpisode = typeof input.targetEpisode === "string" ? input.targetEpisode.trim() : null;
  const targetSegmentLabel = typeof input.targetSegmentLabel === "string" ? input.targetSegmentLabel.trim() : null;

  const episodeSegmentRe = /^(\d+)-(\d+)$/;

  // 按 segmentLabel 分组
  const segmentMap = new Map<string, Scene[]>();
  const segmentOrder: string[] = [];
  for (const scene of [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    const key = scene.segmentLabel?.trim();
    if (!key || !episodeSegmentRe.test(key)) continue;
    if (!segmentMap.has(key)) {
      segmentMap.set(key, []);
      segmentOrder.push(key);
    }
    segmentMap.get(key)!.push(scene);
  }

  const existingSegmentVideoPrompts = syncedProject.segmentVideoPrompts ?? {};
  const missingSegmentKeys = segmentOrder.filter(
    (segmentLabel) => !hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel),
  );
  const formatSegmentProgress = createSegmentPromptProgressFormatter(
    segmentOrder,
    new Set(segmentOrder.filter((segmentLabel) => hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel))),
  );

  // 过滤目标片段
  let targetKeys: string[];
  if (batchMode === "single" && targetSegmentLabel) {
    targetKeys = segmentOrder.filter((k) => k === targetSegmentLabel);
  } else if (batchMode === "episode" && targetEpisode) {
    targetKeys = segmentOrder.filter((k) => episodeSegmentRe.exec(k)?.[1] === targetEpisode);
  } else if (batchMode === "remaining") {
    targetKeys = missingSegmentKeys;
  } else if (batchMode === "batch") {
    targetKeys = missingSegmentKeys.slice(0, 1);
  } else {
    targetKeys = segmentOrder;
  }

  if (!targetKeys.length) {
    if (batchMode === "remaining" || batchMode === "batch") {
      const coveredScenes = segmentOrder
        .filter((segmentLabel) => hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel))
        .flatMap((segmentLabel) => segmentMap.get(segmentLabel) ?? []);
      return saveVideoProject(
        {
          ...syncedProject,
          currentStep: 4,
        },
        [
          batchMode === "remaining"
            ? "补齐剩余片段已完成：当前没有缺失的片段提示词。"
            : "分批生成片段已完成：当前没有缺失的片段提示词。",
          `已覆盖 ${segmentOrder.length - missingSegmentKeys.length} / ${segmentOrder.length} 个片段。`,
          buildPromptBatchSummaryOutline(syncedProject, coveredScenes),
          buildVideoAssetStatusReport(syncedProject, coveredScenes, videoGenerationPrefs.mode),
        ].filter(Boolean).join("\n\n"),
      );
    }
    throw new Error("当前没有可处理的片段，请先完成镜头拆解并确认 segmentLabel 格式正确。");
  }

  onProgress?.({ summary: formatSegmentProgress({ status: "init" }) });

  const nextSegmentVideoPrompts: Record<string, SegmentVideoPrompt> = {
    ...existingSegmentVideoPrompts,
  };

  const processedLabels: string[] = [];
  const processedScenes: Scene[] = [];
  const nextScenes = [...syncedProject.scenes];
  const allScenesSorted = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);

  for (const segmentLabel of targetKeys) {
    throwIfInputAborted(input);
    onProgress?.({ summary: formatSegmentProgress({ segmentLabel, status: "processing" }) });
    try {
      const segmentScenes = segmentMap.get(segmentLabel)!;
      const orderedScenes = [...segmentScenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
      const enrichedOrderedScenes = orderedScenes.map(
        (scene) => nextScenes.find((item) => item.id === scene.id) ?? scene,
      );

      const shotDescriptions = enrichedOrderedScenes.map((scene, idx) => {
        const sceneIdx = allScenesSorted.findIndex((item) => item.id === scene.id);
        const prevScene = sceneIdx > 0 ? allScenesSorted[sceneIdx - 1] : undefined;
        const nextScene = sceneIdx < allScenesSorted.length - 1 ? allScenesSorted[sceneIdx + 1] : undefined;
        return {
          index: idx + 1,
          prompt: buildSegmentShotCorePrompt(scene),
          rawDescription: buildSegmentShotRawPrompt(scene),
          promptSource: getSegmentShotPromptSource(scene),
          prevDescription: prevScene?.description?.trim() || "",
          nextDescription: nextScene?.description?.trim() || "",
          duration: scene.recommendedDuration ?? scene.duration ?? 5,
          sceneName: scene.sceneName,
          cameraDirection: scene.cameraDirection?.trim() || "",
          dialogue: scene.dialogue?.trim() || "",
        };
      });

      const characterDescriptions = (() => {
        const allCharacterNames = new Set(enrichedOrderedScenes.flatMap((s) => s.characters));
        return (syncedProject.characters ?? [])
          .filter((c) => allCharacterNames.has(c.name))
          .map((c) => {
            // 优先使用片段内第一个出现该角色的镜头的场景级服装，回退到角色全局激活服装
            const firstScene = enrichedOrderedScenes.find((s) => s.characters.includes(c.name));
            const sceneCostumeId = firstScene?.characterCostumes?.[c.name];
            const activeCostume = sceneCostumeId
              ? c.costumes?.find((cos) => cos.id === sceneCostumeId)
              : c.costumes?.find((cos) => cos.id === c.activeCostumeId);
            return {
              name: c.name,
              description: activeCostume
                ? `${c.description} [服装：${activeCostume.description}]`
                : c.description,
              imageUrl: activeCostume?.imageUrl?.trim() || c.imageUrl,
            };
          });
      })();

      const sceneRefUrls = enrichedOrderedScenes
        .map((s) => findSceneReferenceImage(s, syncedProject.sceneSettings || [], { excludeStoryboard: true }))
        .filter((url): url is string => !!url);
      const uniqueSceneRefUrls = [...new Set(sceneRefUrls)];
      const segmentReferenceImageUrl = uniqueSceneRefUrls[0] || "";

      const sceneSettingDescriptions = enrichedOrderedScenes
        .map((s) => {
          const setting = findSceneSetting(s, syncedProject.sceneSettings || []);
          return setting ? { name: setting.name, description: setting.description, imageUrl: setting.imageUrl } : null;
        })
        .filter((s): s is NonNullable<typeof s> => !!s)
        .filter((s, idx, arr) => arr.findIndex((x) => x.name === s.name) === idx);
      const continuityContext = buildSegmentPromptContinuityContext({
        segmentLabel,
        segmentOrder,
        segmentMap,
        segmentPrompts: nextSegmentVideoPrompts,
      });

      let finalPrompt: string;
      let finalDuration = effectiveDuration;

      try {
        const { data, error } = await invokeFunction<{ prompt?: string; duration?: number }>(
          "enhance-video-prompt",
          {
            mode: "segment",
            segmentLabel,
            shots: shotDescriptions,
            style: resolveProjectImagePromptStyle(syncedProject),
            targetDuration: effectiveDuration,
            maxDuration,
            designDuration: VIDEO_SEGMENT_DESIGN_DURATION,
            characterDescriptions,
            visualStyle: syncedProject.styleLock?.visualStyle || "",
            tone: syncedProject.styleLock?.tone || "",
            characterImages: characterDescriptions
              .filter((c) => c.imageUrl)
              .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
            referenceImageUrl: segmentReferenceImageUrl,
            hasRefImage: Boolean(segmentReferenceImageUrl),
            sceneImages: uniqueSceneRefUrls.map((url) => ({ imageUrl: url })),
            sceneDescriptions: sceneSettingDescriptions,
            previousSegmentSummary: continuityContext.previousSegmentSummary,
            nextSegmentSummary: continuityContext.nextSegmentSummary,
            previousSegmentPrompt: continuityContext.previousSegmentPrompt,
            continuityRules: continuityContext.continuityRules,
          },
        );
        if (error || !data?.prompt?.trim()) {
          finalPrompt = buildFallbackSegmentPrompt(enrichedOrderedScenes, syncedProject, effectiveDuration);
        } else {
          finalPrompt = data.prompt.trim();
          finalDuration = Math.min(data.duration ?? effectiveDuration, maxDuration);
        }
      } catch {
        finalPrompt = buildFallbackSegmentPrompt(enrichedOrderedScenes, syncedProject, effectiveDuration);
      }

      finalPrompt = appendRequiredSegmentCoverage(stripExactDialogueLockBlock(finalPrompt), enrichedOrderedScenes, finalDuration);
      finalPrompt = appendExactDialogueLock(finalPrompt, collectSegmentDialogueLock(enrichedOrderedScenes));

      nextSegmentVideoPrompts[segmentLabel] = {
        segmentLabel,
        prompt: finalPrompt,
        duration: finalDuration,
        targetDuration: VIDEO_SEGMENT_DESIGN_DURATION,
        modelKey: videoGenerationPrefs.modelKey,
        maxDurationForModel: maxDuration,
        sceneIds: enrichedOrderedScenes.map((s) => s.id),
        generatedAt: new Date().toISOString(),
      };

      processedLabels.push(segmentLabel);
      processedScenes.push(...enrichedOrderedScenes);
      onProgress?.({ summary: formatSegmentProgress({ segmentLabel, status: "done" }) });
    } catch (error) {
      onProgress?.({ summary: formatSegmentProgress({ segmentLabel, status: "failed" }) });
      throw error;
    }
  }

  const remainingAfter = segmentOrder.filter(
    (segmentLabel) => !hasReadySegmentVideoPrompt(nextSegmentVideoPrompts, segmentLabel),
  );
  const primarySummary =
    batchMode === "remaining"
      ? `已按顺序补齐 ${processedLabels.length} 个剩余片段的合并视频提示词。`
      : batchMode === "batch"
        ? `已分批生成 ${processedLabels.length} 个片段的合并视频提示词。`
        : `已生成 ${processedLabels.length} 个片段的合并视频提示词。`;
  const summary = [
    primarySummary,
    `片段列表：${processedLabels.join("、")}`,
    batchMode === "batch" && remainingAfter.length > 0
      ? `下次点击“分批生成片段”会继续处理片段 ${remainingAfter[0]}。`
      : "",
    batchMode === "remaining" || batchMode === "batch"
      ? `片段覆盖进度：${segmentOrder.length - remainingAfter.length} / ${segmentOrder.length}。`
      : "",
    `当前模型最大时长：${maxDuration}s（设计规格 ${VIDEO_SEGMENT_DESIGN_DURATION}s）`,
    maxDuration < VIDEO_SEGMENT_DESIGN_DURATION
      ? `注意：当前模型（${videoGenerationPrefs.modelKey}）最大支持 ${maxDuration}s，提示词已按 ${maxDuration}s 适配。`
      : "",
    buildPromptBatchSummaryOutline(syncedProject, processedScenes),
    buildVideoAssetStatusReport(syncedProject, processedScenes, videoGenerationPrefs.mode),
  ].filter(Boolean).join("\n");

  return saveVideoProject(
    {
      ...syncedProject,
      scenes: nextScenes,
      segmentVideoPrompts: nextSegmentVideoPrompts,
      currentStep: 4,
    },
    summary,
  );
}

// ---- 片段视频生成 ----

function buildSegmentVideoStatus(
  segmentLabel: string,
  status: string,
  options?: {
    taskId?: string;
    provider?: string;
    failure?: SegmentVideoStatus["failure"];
  },
): SegmentVideoStatus {
  return {
    segmentLabel,
    status: normalizeSceneStatus(status) || status || "processing",
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.failure ? { failure: options.failure } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function withSegmentVideoStatus(
  project: PersistedVideoProject,
  segmentLabel: string,
  status: SegmentVideoStatus,
): PersistedVideoProject {
  return {
    ...project,
    segmentVideoStatuses: {
      ...(project.segmentVideoStatuses ?? {}),
      [segmentLabel]: status,
    },
  };
}

async function cacheSegmentVideoUrl(
  projectId: string,
  segmentLabel: string,
  remoteVideoUrl: string,
): Promise<string> {
  const rawFileName =
    remoteVideoUrl.split(/[\\/]/).pop()?.split("?")[0] ||
    `segment-${segmentLabel}.mp4`;
  const segmentFileStem = buildSegmentVideoFileStem(segmentLabel);
  const fileName = segmentFileStem ? `${segmentFileStem}.mp4` : decodeVideoFileName(rawFileName);
  const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, projectId);
  return cachedVideo?.localPath ?? remoteVideoUrl;
}

function dispatchSegmentVideoGenerated(params: {
  videoUrl: string;
  segmentLabel: string;
  projectId: string;
  model: string;
  resolution: string;
  provider?: string;
  mode: string;
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("agent:video-generated-one", {
      detail: {
        url: params.videoUrl,
        index: 0,
        label: buildSegmentVideoLabel(params.segmentLabel),
        segmentLabel: params.segmentLabel,
        projectId: params.projectId,
        contentSummary: buildSegmentVideoLabel(params.segmentLabel),
        model: params.model,
        resolution: params.resolution,
        provider: params.provider,
        mode: params.mode,
      },
    }),
  );
}

export async function generateSegmentVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  const segmentLabel = typeof input.segmentLabel === "string" ? input.segmentLabel.trim() : "";
  if (!segmentLabel) {
    throw new Error("缺少 segmentLabel，无法生成片段视频。");
  }

  let syncedProject = synchronizeVideoProductionState(project);
  const segmentPrompt = syncedProject.segmentVideoPrompts?.[segmentLabel];

  if (!segmentPrompt?.prompt?.trim()) {
    throw new Error(
      `片段 ${segmentLabel} 还没有生成片段提示词，请先在"准备视频提示词"中运行"片段提示词生成"。`,
    );
  }

  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const transport = await ensureVideoGenerationTransport(input);
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);
  const maxDuration = getVideoModelMaxDuration(videoGenerationPrefs.modelKey);
  const effectiveDuration = Math.min(segmentPrompt.duration, maxDuration);

  const segmentScenes = syncedProject.scenes.filter((s) => segmentPrompt.sceneIds.includes(s.id));
  const segmentReferenceImageUrl = segmentScenes
    .map((s) => findSceneReferenceImage(s, syncedProject.sceneSettings || [], { excludeStoryboard: true }))
    .find((url): url is string => !!url);
  const shouldUseReferenceImage = videoGenerationPrefs.mode === "image-to-video";

  let data: VideoGenerationResult | undefined;
  let taskId = "";
  let taskProvider = transport.provider || resolveVideoGenerationProvider(videoGenerationPrefs);
  let videoUrl: string | undefined;
  let failedStatus: SegmentVideoStatus | null = null;

  try {
    const response = await invokeFunction<VideoGenerationResult>(
      "generate-video",
      {
        prompt: appendExactDialogueLock(segmentPrompt.prompt, collectSegmentDialogueLock(segmentScenes)),
        duration: effectiveDuration,
        aspectRatio: typeof input.aspectRatio === "string" ? input.aspectRatio : "16:9",
        resolution: videoGenerationPrefs.resolution,
        model: resolvedModel,
        provider: taskProvider,
        ...(shouldUseReferenceImage && segmentReferenceImageUrl ? { imageUrl: segmentReferenceImageUrl } : {}),
      },
      { abortSignal: resolveInputAbortSignal(input) },
    );
    if (response.error) throw response.error;
    data = response.data;
    taskId = String(data?.task_id || "").trim();
    taskProvider = data?.provider || taskProvider;
  } catch (error) {
    failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
      provider: taskProvider,
      failure: {
        message: summarizeVideoGenerationError(error),
        provider: taskProvider,
        stage: "submit",
        updatedAt: new Date().toISOString(),
      },
    });
  }

  if (taskId) {
    syncedProject = withSegmentVideoStatus(
      syncedProject,
      segmentLabel,
      buildSegmentVideoStatus(segmentLabel, normalizeSceneStatus(data?.status) || "queued", {
        taskId,
        provider: taskProvider,
      }),
    );
    const MAX_POLL_ROUNDS = 24;
    const POLL_INTERVAL_MS = 10_000;
    for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
      throwIfInputAborted(input);
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      throwIfInputAborted(input);

      const { data: statusData, error: statusError } = await invokeFunction<VideoGenerationStatusResult>(
        "generate-video",
        { action: "status", taskId, provider: taskProvider },
        { abortSignal: resolveInputAbortSignal(input) },
      );

      if (statusError) {
        failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
          taskId,
          provider: taskProvider,
          failure: {
            message: summarizeVideoGenerationError(statusError),
            provider: taskProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        });
        break;
      }

      const normalizedStatus = normalizeSceneStatus(statusData?.status || statusData?.state) || "processing";
      if (normalizedStatus === "completed" && statusData?.video_url) {
        videoUrl = await cacheSegmentVideoUrl(syncedProject.id, segmentLabel, statusData.video_url);
        break;
      } else if (normalizedStatus === "failed") {
        failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
          taskId,
          provider: taskProvider,
          failure: {
            message: "片段视频生成失败，建议调整片段提示词后重新提交。",
            provider: taskProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        });
        break;
      } else {
        syncedProject = withSegmentVideoStatus(
          syncedProject,
          segmentLabel,
          buildSegmentVideoStatus(segmentLabel, normalizedStatus, { taskId, provider: taskProvider }),
        );
      }
    }

    if (!videoUrl && !failedStatus) {
      failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
        taskId,
        provider: taskProvider,
        failure: {
          message: "片段视频生成超时，请重新生成。",
          provider: taskProvider,
          stage: "status",
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (videoUrl) {
    syncedProject = {
      ...syncedProject,
      segmentVideos: {
        ...(syncedProject.segmentVideos ?? {}),
        [segmentLabel]: videoUrl,
      },
      segmentVideoStatuses: {
        ...(syncedProject.segmentVideoStatuses ?? {}),
        [segmentLabel]: buildSegmentVideoStatus(segmentLabel, "completed", {
          taskId,
          provider: taskProvider,
        }),
      },
    };
    dispatchSegmentVideoGenerated({
      videoUrl,
      segmentLabel,
      projectId: syncedProject.id,
      model: resolvedModel,
      resolution: videoGenerationPrefs.resolution,
      provider: taskProvider,
      mode: videoGenerationPrefs.mode,
    });
  } else if (failedStatus) {
    syncedProject = withSegmentVideoStatus(syncedProject, segmentLabel, failedStatus);
  }

  const summary = videoUrl
    ? `片段 ${segmentLabel} 视频已生成完成（${effectiveDuration}s）。`
    : failedStatus
      ? `片段 ${segmentLabel} 视频生成失败：${failedStatus.failure?.message || "请检查提示词和通道配置后重试。"}`
      : taskId
        ? `片段 ${segmentLabel} 视频任务已提交（${transport.providerLabel}），可稍后查看结果。`
      : "片段视频提交失败，请检查提示词和通道配置。";

  const result = await saveVideoProject(syncedProject, summary);
  return videoUrl ? { ...result, videoUrls: [videoUrl] } : result;
}

export async function refreshSegmentVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const segmentLabel = typeof input.segmentLabel === "string" ? input.segmentLabel.trim() : "";
  if (!segmentLabel) {
    throw new Error("缺少 segmentLabel，无法刷新片段视频任务。");
  }

  let syncedProject = synchronizeVideoProductionState(project);
  const currentStatus = syncedProject.segmentVideoStatuses?.[segmentLabel];
  const taskId = currentStatus?.taskId?.trim();
  if (!taskId) {
    throw new Error(`片段 ${segmentLabel} 没有可刷新的生成任务。`);
  }

  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const provider = currentStatus?.provider || resolveVideoGenerationProvider(videoGenerationPrefs);
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);

  const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
    "generate-video",
    { action: "status", taskId, provider },
    { abortSignal: resolveInputAbortSignal(input) },
  );

  let videoUrl: string | undefined;
  let nextStatus: SegmentVideoStatus;
  if (error) {
    nextStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
      taskId,
      provider,
      failure: {
        message: summarizeVideoGenerationError(error),
        provider,
        stage: "status",
        updatedAt: new Date().toISOString(),
      },
    });
  } else {
    const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
    if (normalizedStatus === "completed" && data?.video_url) {
      videoUrl = await cacheSegmentVideoUrl(syncedProject.id, segmentLabel, data.video_url);
      nextStatus = buildSegmentVideoStatus(segmentLabel, "completed", { taskId, provider });
    } else if (normalizedStatus === "failed") {
      nextStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
        taskId,
        provider,
        failure: {
          message: "片段视频生成失败，建议调整片段提示词后重新提交。",
          provider,
          stage: "status",
          updatedAt: new Date().toISOString(),
        },
      });
    } else {
      nextStatus = buildSegmentVideoStatus(segmentLabel, normalizedStatus, { taskId, provider });
    }
  }

  syncedProject = {
    ...syncedProject,
    ...(videoUrl
      ? {
          segmentVideos: {
            ...(syncedProject.segmentVideos ?? {}),
            [segmentLabel]: videoUrl,
          },
        }
      : {}),
    segmentVideoStatuses: {
      ...(syncedProject.segmentVideoStatuses ?? {}),
      [segmentLabel]: nextStatus,
    },
  };

  if (videoUrl) {
    dispatchSegmentVideoGenerated({
      videoUrl,
      segmentLabel,
      projectId: syncedProject.id,
      model: resolvedModel,
      resolution: videoGenerationPrefs.resolution,
      provider,
      mode: videoGenerationPrefs.mode,
    });
  }

  const summary =
    nextStatus.status === "completed"
      ? `片段 ${segmentLabel} 视频已刷新完成。`
      : nextStatus.status === "failed"
        ? `片段 ${segmentLabel} 视频刷新失败：${nextStatus.failure?.message || "请稍后重试。"}`
        : `片段 ${segmentLabel} 仍在生成中（${nextStatus.status}）。`;
  const result = await saveVideoProject(syncedProject, summary);
  return videoUrl ? { ...result, videoUrls: [videoUrl] } : result;
}
