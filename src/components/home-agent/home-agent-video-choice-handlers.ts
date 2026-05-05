import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
} from "@/lib/home-agent/types";
import {
  buildImagePrefsPatchFromRecognition,
  type HomeAgentImageStyleRecognitionResult,
} from "@/lib/home-agent/image-style-analysis";
import {
  buildVideoImageStyleSummary,
  getHomeAgentImageStylePresetOption,
  listHomeAgentImageStyleCategories,
  listHomeAgentImageStylePresets,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  normalizeVideoGenerationMode,
  normalizeVideoGenerationPrefs,
} from "@/lib/home-agent/video-models";
import type {
  VideoGenerationMode,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageStylePreset,
} from "@/types/project";
import {
  buildVideoBridgeQuestion,
  listFailedSegmentVideoLabels,
  listGeneratableSegmentVideoLabels,
  listGeneratableStoryboardSceneIdsForSegment,
  listRunningSegmentVideoLabels,
  listSelectableVideoSceneIdsForSegment,
  listVideoReferenceAssetTargetIds,
} from "./home-agent-project-questions";

type WorkflowShortcutRunner = (
  action: string,
  input: Record<string, unknown>,
  label: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
  },
) => void | Promise<void>;

type WorkflowShortcutChainRunner = (
  steps: Array<{ action: string; input: Record<string, unknown> }>,
  label: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
  },
) => void | Promise<void>;

type BackgroundVideoBridgeResearchRunner = (
  label: string,
  mode?: "all" | "targetPlatform" | "shotStyle" | "outputGoal",
) => void | Promise<void>;
type MediaPrefsCommitter<TPrefs> = (prefs: Partial<TPrefs>) => void | Promise<void>;
type ImageStyleRecognizer = () => Promise<HomeAgentImageStyleRecognitionResult | null>;

type SceneLike = {
  id: string;
  enhancedVideoPrompt?: string;
};

type VideoChoiceHandler = (
  snapshot: ConversationProjectSnapshot,
  value: string,
  label: string,
) => boolean;

type ShowChoicePopover = (
  label: string,
  assistantMessage: string,
  nextQuestion: ComposerQuestion,
) => void;

type ShowChoiceNotice = (
  label: string,
  assistantMessage: string,
  nextSuggestion?: ComposerQuestion | null,
) => void;

type VideoProjectChoiceDeps = {
  getCurrentVideoProject: () => PersistedVideoProject | null | undefined;
  runBackgroundVideoBridgeResearch: BackgroundVideoBridgeResearchRunner;
  commitImageGenerationPrefs?: MediaPrefsCommitter<VideoImageGenerationPrefs>;
  commitVideoGenerationPrefs?: MediaPrefsCommitter<VideoGenerationPrefs>;
  getImageGenerationPrefs?: () => VideoImageGenerationPrefs;
  getVideoGenerationPrefs?: () => VideoGenerationPrefs;
  getAttachedImageCount?: () => number;
  recognizeImageStyle?: ImageStyleRecognizer;
  awaitImageStyleReferenceUpload?: (label: string) => void | Promise<void>;
  clearAwaitImageStyleReferenceUpload?: () => void;
  runWorkflowActionShortcut: WorkflowShortcutRunner;
  switchVideoStep?: (projectId: string, targetStep: number, statusText: string) => void;
  send: (prompt: string, label: string) => void | Promise<void>;
  showChoicePopover: ShowChoicePopover;
  showChoiceNotice: ShowChoiceNotice;
  buildVideoGenerationQuestion: (
    snapshot: ConversationProjectSnapshot,
    project: PersistedVideoProject | null | undefined,
  ) => ComposerQuestion | null;
  listGeneratableVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  buildVideoRefreshQuestion?: unknown;
  buildReviewQuestion?: unknown;
  buildReviewListQuestion?: unknown;
  buildVideoRepairQuestion?: unknown;
  listRunningVideoScenes?: unknown;
};

type VideoAssetChoiceDeps = {
  getCurrentVideoProject: () => PersistedVideoProject | null | undefined;
  runWorkflowActionShortcut: WorkflowShortcutRunner;
  runWorkflowActionShortcutChain: WorkflowShortcutChainRunner;
  showChoicePopover: ShowChoicePopover;
  buildVideoGenerationSceneListQuestion: (
    snapshot: ConversationProjectSnapshot,
    project: PersistedVideoProject | null | undefined,
  ) => ComposerQuestion | null;
  listFailedVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  listGeneratableVideoScenes: (project: PersistedVideoProject | null | undefined) => SceneLike[];
  buildVideoRefreshSceneListQuestion?: unknown;
  buildVideoRepairListQuestion?: unknown;
  listRedoReviewItems?: unknown;
  findReviewItem?: unknown;
};

function listCharacterReferenceTargetIds(
  project: PersistedVideoProject | null | undefined,
  options?: { includeReady?: boolean },
): string[] {
  const includeReady = options?.includeReady === true;
  return (project?.characters ?? [])
    .filter((character) => includeReady || !character.imageUrl?.trim())
    .map((character) => `reference-character:${character.id}`);
}

function listSceneReferenceTargetIds(
  project: PersistedVideoProject | null | undefined,
  options?: { includeReady?: boolean },
): string[] {
  const includeReady = options?.includeReady === true;
  return (project?.sceneSettings ?? [])
    .filter((sceneSetting) => includeReady || !sceneSetting.imageUrl?.trim())
    .map((sceneSetting) => `reference-scene:${sceneSetting.id}`);
}

function listCharacterVariantTargetIds(
  project: PersistedVideoProject | null | undefined,
  characterId: string,
  options?: { includeReady?: boolean },
): string[] {
  const includeReady = options?.includeReady === true;
  const character = project?.characters?.find((item) => item.id === characterId);
  return (character?.costumes ?? [])
    .filter((variant) => includeReady || !variant.imageUrl?.trim())
    .map((variant) => `reference-character-variant:${characterId}:${variant.id}`);
}

function listSceneVariantTargetIds(
  project: PersistedVideoProject | null | undefined,
  sceneSettingId: string,
  options?: { includeReady?: boolean },
): string[] {
  const includeReady = options?.includeReady === true;
  const sceneSetting = project?.sceneSettings?.find((item) => item.id === sceneSettingId);
  return (sceneSetting?.timeVariants ?? [])
    .filter((variant) => includeReady || !variant.imageUrl?.trim())
    .map((variant) => `reference-scene-variant:${sceneSettingId}:${variant.id}`);
}

function localizeVideoGenerationMode(mode: VideoGenerationMode): string {
  return mode === "image-to-video" ? "图生视频" : "文生视频";
}

export function buildVideoKickoffModeQuestion(
  snapshot: ConversationProjectSnapshot,
  currentPrefs?: VideoGenerationPrefs,
): ComposerQuestion {
  const normalized = normalizeVideoGenerationPrefs(currentPrefs);
  const optionFor = (mode: VideoGenerationMode): ComposerQuestionOption => ({
    id: `${snapshot.projectId}-video-kickoff-prefs-mode-${mode}`,
    label: localizeVideoGenerationMode(mode),
    value: `video:kickoff:prefs:mode:${mode}`,
    selected: normalized.mode === mode,
    rationale:
      mode === "image-to-video"
        ? "使用当前参考图或后续分镜图作为视频生成起点。"
        : "直接用镜头描述和提示词生成视频。",
  });

  return {
    id: `video-kickoff-prefs-mode-${snapshot.projectId}`,
    title: "先选择视频生成模式",
    description: "确认后会写入当前视频生成参数，然后继续让你选择画面风格。",
    options: [optionFor("text-to-video"), optionFor("image-to-video")],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 2,
    answerKey: "video-kickoff-prefs-mode",
  };
}

function buildVideoKickoffStyleQuestion(
  snapshot: ConversationProjectSnapshot,
  currentPrefs?: VideoImageGenerationPrefs,
  attachedImageCount = 0,
): ComposerQuestion {
  const normalized = normalizeVideoImageGenerationPrefs(currentPrefs);

  const options = listHomeAgentImageStyleCategories().map((category) => {
    if (category.key === "custom") {
      return {
        id: `${snapshot.projectId}-video-kickoff-style-category-${category.key}`,
        label: category.label,
        value: `video:kickoff:prefs:style-category:${category.key}`,
        selected: normalized.styleCategory === category.key,
        rationale: category.description,
        children: [
          {
            id: `${snapshot.projectId}-video-kickoff-style-custom-input`,
            label: "输入自定义风格说明",
            value: "video:kickoff:prefs:custom-style-open",
            rationale: "发送后会先生成摘要，再自动继续补平台与镜头偏好。",
            childInput: {
              type: "text",
              actionPrefix: "video:kickoff:prefs:custom-style:",
              minLength: 2,
              maxLength: 600,
              placeholder: "例如：电影级低饱和胶片质感，雨夜霓虹反射，真实皮肤纹理。",
              buttonLabel: "写入并继续",
              labelTemplate: "自定义风格：{value}",
            },
          },
          {
            id: `${snapshot.projectId}-video-kickoff-style-reference`,
            label: "识别已上传参考图",
            value: "video:kickoff:prefs:style-reference",
            rationale:
              attachedImageCount > 0
                ? `识别当前已上传的 ${attachedImageCount} 张参考图，并自动给出摘要。`
                : "先上传参考图，再从这里直接识别。",
          },
        ],
      } satisfies ComposerQuestionOption;
    }

    return {
      id: `${snapshot.projectId}-video-kickoff-style-category-${category.key}`,
      label: category.label,
      value: `video:kickoff:prefs:style-category:${category.key}`,
      selected: normalized.styleCategory === category.key,
      rationale: category.description,
      children: listHomeAgentImageStylePresets(category.key).map((preset) => ({
        id: `${snapshot.projectId}-video-kickoff-style-preset-${preset.key}`,
        label: preset.label,
        value: `video:kickoff:prefs:style-preset:${preset.key}`,
        selected: normalized.stylePreset === preset.key,
        rationale: preset.description,
      })),
    } satisfies ComposerQuestionOption;
  });

  return {
    id: `video-kickoff-prefs-style-${snapshot.projectId}`,
    title: "选择画面风格类型",
    description: "在这一层直接展开二级风格子项。选好后会先给摘要，再自动继续补平台与镜头偏好。",
    options,
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 1,
    totalSteps: 2,
    answerKey: "video-kickoff-prefs-style",
  };
}

function buildPrefsSummary(params: {
  videoMode?: VideoGenerationMode;
  imagePrefs?: Partial<VideoImageGenerationPrefs>;
  recognitionSummary?: string;
}): string {
  const lines = ["已确认前置生成偏好，接下来自动补齐平台和镜头偏好。"];
  if (params.videoMode) {
    lines.push(`视频模式：${localizeVideoGenerationMode(params.videoMode)}`);
  }
  if (params.imagePrefs) {
    lines.push(`画面风格：${buildVideoImageStyleSummary(params.imagePrefs)}`);
  }
  if (params.recognitionSummary?.trim()) {
    lines.push(`参考图摘要：${params.recognitionSummary.trim()}`);
  }
  return lines.join("\n");
}

async function commitAndContinueBridgeResearch(params: {
  deps: VideoProjectChoiceDeps;
  label: string;
  imagePrefs: Partial<VideoImageGenerationPrefs>;
  recognitionSummary?: string;
}) {
  const { deps, label, imagePrefs, recognitionSummary } = params;
  deps.clearAwaitImageStyleReferenceUpload?.();
  const currentImagePrefs = normalizeVideoImageGenerationPrefs({
    ...(deps.getImageGenerationPrefs?.() ?? {}),
    ...imagePrefs,
  });
  await deps.commitImageGenerationPrefs?.(currentImagePrefs);
  deps.showChoiceNotice(
    label,
    buildPrefsSummary({
      videoMode: normalizeVideoGenerationPrefs(deps.getVideoGenerationPrefs?.()).mode,
      imagePrefs: currentImagePrefs,
      recognitionSummary,
    }),
  );
  void deps.runBackgroundVideoBridgeResearch("继续补齐平台与镜头偏好", "all");
}

export function buildScriptAnalyzeDurationQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion {
  return {
    id: `video-analyze-duration-${snapshot.projectId}`,
    title: "请选择单集时长",
    description: "时长将影响镜头拆解的颗粒度和时长分配",
    options: [
      { id: "dur-60", label: "60 秒", value: "video:bridge:analyze:dur:60", rationale: "快节奏短剧，每集约 60 秒" },
      { id: "dur-90", label: "90 秒", value: "video:bridge:analyze:dur:90", rationale: "标准时长，适合大多数短剧类型" },
      { id: "dur-120", label: "120 秒", value: "video:bridge:analyze:dur:120", rationale: "较长时长，适合情感戏或复杂剧情" },
      {
        id: "dur-custom",
        label: "自定义",
        value: "video:bridge:analyze:dur:custom",
        rationale: "手动输入自定义时长",
        childInput: {
          type: "number",
          actionPrefix: "video:bridge:analyze:dur:n:",
          min: 15,
          max: 600,
          placeholder: "输入时长（秒）",
          suffix: "秒",
          buttonLabel: "确认",
        },
      },
    ],
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 2,
    answerKey: "video-analyze-duration",
  };
}

function buildScriptAnalyzePaceQuestion(snapshot: ConversationProjectSnapshot, duration: string): ComposerQuestion {
  return {
    id: `video-analyze-pace-${snapshot.projectId}`,
    title: "请选择视频节奏",
    description: "节奏决定每个片段的分镜数量和台词字数上限",
    options: [
      {
        id: "pace-slow",
        label: "慢速",
        value: `video:bridge:analyze:pace:slow:${duration}`,
        rationale: "每片段 2~4 个分镜，单条台词 15~22 字，适合情感戏、慢节奏剧情",
      },
      {
        id: "pace-medium",
        label: "中等",
        value: `video:bridge:analyze:pace:medium:${duration}`,
        rationale: "每片段 3~5 个分镜，单条台词 15~27 字，适合大多数短剧类型",
      },
      {
        id: "pace-fast",
        label: "快速",
        value: `video:bridge:analyze:pace:fast:${duration}`,
        rationale: "每片段 4~6 个分镜，单条台词 15~32 字，适合动作、悬疑、爽剧",
      },
    ],
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 1,
    totalSteps: 2,
    answerKey: "video-analyze-pace",
  };
}

export function buildVideoUploadScriptFollowupQuestion(
  snapshot: ConversationProjectSnapshot | null | undefined,
  project?: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (!snapshot || snapshot.projectKind !== "video") return null;
  if (snapshot.derivedStage !== "脚本拆解") return null;
  return (
    buildVideoBridgeQuestion(snapshot, project ?? null)
  );
}

function buildAnalyzeInterruptRestoreQuestion(
  snapshot: ConversationProjectSnapshot,
  duration: string,
): ComposerQuestion {
  return buildScriptAnalyzePaceQuestion(snapshot, duration);
}

export function createVideoProjectChoiceHandler(deps: VideoProjectChoiceDeps): VideoChoiceHandler {
  return (snapshot, value, label) => {
    const videoProject = deps.getCurrentVideoProject();

    if (value.startsWith("video:kickoff:prefs:mode:")) {
      const match = value.match(/^video:kickoff:prefs:mode:(text-to-video|image-to-video)$/);
      const resolvedMode = (match?.[1] ?? "") as VideoGenerationMode;
      if (!resolvedMode) return true;

      void Promise.resolve(
        deps.commitVideoGenerationPrefs?.(
          normalizeVideoGenerationPrefs({
            ...(deps.getVideoGenerationPrefs?.() ?? {}),
            mode: normalizeVideoGenerationMode(resolvedMode),
          }),
        ),
      ).then(() => {
        deps.showChoicePopover(
          label,
          `视频生成模式已设为${localizeVideoGenerationMode(resolvedMode)}。现在选择画面风格类型。`,
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
      });
      return true;
    }

    if (value.startsWith("video:kickoff:prefs:style-preset:")) {
      const preset = value.replace("video:kickoff:prefs:style-preset:", "") as VideoImageStylePreset;
      if (!preset) return true;
      const presetOption = getHomeAgentImageStylePresetOption(preset);

      void commitAndContinueBridgeResearch({
        deps,
        label,
        imagePrefs: {
          styleCategory: presetOption.category,
          stylePreset: presetOption.key,
        },
      });
      return true;
    }

    if (value.startsWith("video:kickoff:prefs:custom-style:")) {
      const encodedPrompt = value.replace("video:kickoff:prefs:custom-style:", "");
      const customStylePrompt = decodeURIComponent(encodedPrompt).trim();
      if (!customStylePrompt) {
        deps.showChoicePopover(
          label,
          "还没有收到自定义风格说明，请重新输入。",
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
        return true;
      }

      void commitAndContinueBridgeResearch({
        deps,
        label,
        imagePrefs: {
          styleCategory: "custom",
          stylePreset: "custom",
          customStylePrompt,
        },
        recognitionSummary: `自定义说明已写入：${customStylePrompt}`,
      });
      return true;
    }

    if (value === "video:kickoff:prefs:style-reference") {
      if ((deps.getAttachedImageCount?.() ?? 0) <= 0) {
        if (deps.awaitImageStyleReferenceUpload) {
          void Promise.resolve(deps.awaitImageStyleReferenceUpload(label));
          return true;
        }
        deps.showChoicePopover(
          label,
          "还没有可识别的参考图。请先上传参考图，或直接输入自定义风格说明。",
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
        return true;
      }

      if (!deps.recognizeImageStyle) {
        deps.showChoicePopover(
          label,
          "当前暂时无法识别参考图风格，请改为输入自定义风格说明。",
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
        return true;
      }

      deps.clearAwaitImageStyleReferenceUpload?.();
      void Promise.resolve(deps.recognizeImageStyle())
        .then((result) => {
          if (!result) {
            deps.showChoicePopover(
              label,
              "参考图暂时没有识别出稳定风格，请改为输入自定义风格说明。",
              buildVideoKickoffStyleQuestion(
                snapshot,
                deps.getImageGenerationPrefs?.(),
                deps.getAttachedImageCount?.() ?? 0,
              ),
            );
            return;
          }
          return commitAndContinueBridgeResearch({
            deps,
            label,
            imagePrefs: buildImagePrefsPatchFromRecognition(result),
            recognitionSummary: result.summary,
          });
        })
        .catch((error) => {
          deps.showChoicePopover(
            label,
            error instanceof Error ? error.message : "参考图风格识别失败，请改为输入自定义风格说明。",
            buildVideoKickoffStyleQuestion(
              snapshot,
              deps.getImageGenerationPrefs?.(),
              deps.getAttachedImageCount?.() ?? 0,
            ),
          );
        });
      return true;
    }

    if (value === "video:bridge:prefix:target-platform") {
      void deps.runBackgroundVideoBridgeResearch(label, "targetPlatform");
      return true;
    }

    if (value === "video:bridge:prefix:shot-style") {
      void deps.runBackgroundVideoBridgeResearch(label, "shotStyle");
      return true;
    }

    if (value === "video:bridge:prefix:output-goal") {
      void deps.runBackgroundVideoBridgeResearch(label, "outputGoal");
      return true;
    }

    if (value === "video:bridge:analyze") {
      deps.showChoicePopover(label, "在拆解脚本前，需要先确认两项关键参数。", buildScriptAnalyzeDurationQuestion(snapshot));
      return true;
    }

    if (value === "video:bridge:analyze:retry-missing") {
      void deps.runWorkflowActionShortcut(
        "analyze_script_for_video",
        {
          projectId: snapshot.projectId,
          retryMissingEpisodes: true,
        },
        label,
      );
      return true;
    }

    // 时长选择（预设：60 / 90 / 120 秒）
    if (
      value === "video:bridge:analyze:dur:60" ||
      value === "video:bridge:analyze:dur:90" ||
      value === "video:bridge:analyze:dur:120"
    ) {
      const duration = value.split(":").pop()!;
      deps.showChoicePopover(label, `单集时长已设为 ${duration} 秒，请选择视频节奏。`, buildScriptAnalyzePaceQuestion(snapshot, duration));
      return true;
    }

    // 时长选择（自定义 childInput 提交）
    if (value.startsWith("video:bridge:analyze:dur:n:")) {
      const duration = value.replace("video:bridge:analyze:dur:n:", "").trim();
      if (!duration || isNaN(Number(duration))) {
        deps.showChoicePopover(label, "时长输入无效，请重新选择。", buildScriptAnalyzeDurationQuestion(snapshot));
        return true;
      }
      deps.showChoicePopover(label, `单集时长已设为 ${duration} 秒，请选择视频节奏。`, buildScriptAnalyzePaceQuestion(snapshot, duration));
      return true;
    }

    // 节奏选择完成 → 执行拆解
    if (value.startsWith("video:bridge:analyze:pace:")) {
      const parts = value.split(":");
      // 格式：video:bridge:analyze:pace:{pace}:{duration}
      const pace = parts[4] ?? "medium";
      const duration = parts[5] ?? "90";
      void deps.runWorkflowActionShortcut(
        "analyze_script_for_video",
        {
          projectId: snapshot.projectId,
          videoPace: pace,
          episodeDuration: parseInt(duration, 10),
        },
        label,
        {
          restoreQuestionOnInterrupt: buildAnalyzeInterruptRestoreQuestion(snapshot, duration),
        },
      );
      return true;
    }

    if (value === "video:bridge:entities") {
      void deps.runWorkflowActionShortcut("extract_video_entities", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:reference-assets") {
      void deps.runWorkflowActionShortcut("generate_video_reference_assets", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:reference-assets:full") {
      const targetIds = listVideoReferenceAssetTargetIds(videoProject);
      const includeReady = targetIds.length === 0;
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          smartBatch: true,
          targetIds: includeReady
            ? listVideoReferenceAssetTargetIds(videoProject, { includeReady: true })
            : targetIds,
          ...(includeReady ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value === "video:bridge:reference-assets:characters") {
      const targetIds = listCharacterReferenceTargetIds(videoProject);
      const includeReady = targetIds.length === 0;
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: includeReady ? listCharacterReferenceTargetIds(videoProject, { includeReady: true }) : targetIds,
          ...(includeReady ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value === "video:bridge:reference-assets:scenes") {
      const targetIds = listSceneReferenceTargetIds(videoProject);
      const includeReady = targetIds.length === 0;
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: includeReady ? listSceneReferenceTargetIds(videoProject, { includeReady: true }) : targetIds,
          ...(includeReady ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:character:")) {
      const characterId = value.replace("video:bridge:reference-assets:character:", "");
      const shouldRefresh = Boolean(videoProject?.characters.find((character) => character.id === characterId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-character:${characterId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:character-main:")) {
      const characterId = value.replace("video:bridge:reference-assets:character-main:", "");
      const shouldRefresh = Boolean(videoProject?.characters.find((character) => character.id === characterId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-character:${characterId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:character-variants:")) {
      const characterId = value.replace("video:bridge:reference-assets:character-variants:", "");
      const targetIds = listCharacterVariantTargetIds(videoProject, characterId);
      const includeReady = targetIds.length === 0;
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: includeReady
            ? listCharacterVariantTargetIds(videoProject, characterId, { includeReady: true })
            : targetIds,
          ...(includeReady ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:character-variant:")) {
      const [, , , , characterId = "", variantId = ""] = value.split(":");
      const character = videoProject?.characters.find((item) => item.id === characterId);
      const shouldRefresh = Boolean(character?.costumes?.find((item) => item.id === variantId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-character-variant:${characterId}:${variantId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:scene:")) {
      const sceneSettingId = value.replace("video:bridge:reference-assets:scene:", "");
      const shouldRefresh = Boolean(videoProject?.sceneSettings.find((sceneSetting) => sceneSetting.id === sceneSettingId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-scene:${sceneSettingId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:scene-main:")) {
      const sceneSettingId = value.replace("video:bridge:reference-assets:scene-main:", "");
      const shouldRefresh = Boolean(videoProject?.sceneSettings.find((sceneSetting) => sceneSetting.id === sceneSettingId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-scene:${sceneSettingId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:scene-variants:")) {
      const sceneSettingId = value.replace("video:bridge:reference-assets:scene-variants:", "");
      const targetIds = listSceneVariantTargetIds(videoProject, sceneSettingId);
      const includeReady = targetIds.length === 0;
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: includeReady
            ? listSceneVariantTargetIds(videoProject, sceneSettingId, { includeReady: true })
            : targetIds,
          ...(includeReady ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:reference-assets:scene-variant:")) {
      const [, , , , sceneSettingId = "", variantId = ""] = value.split(":");
      const sceneSetting = videoProject?.sceneSettings.find((item) => item.id === sceneSettingId);
      const shouldRefresh = Boolean(sceneSetting?.timeVariants?.find((item) => item.id === variantId)?.imageUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        {
          projectId: snapshot.projectId,
          targetIds: [`reference-scene-variant:${sceneSettingId}:${variantId}`],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value === "video:bridge:export-xlsx") {
      void deps.runWorkflowActionShortcut("export_storyboard_xlsx", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:storyboard") {
      void deps.runWorkflowActionShortcut("prepare_storyboard_batch", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:storyboard-frames") {
      void deps.runWorkflowActionShortcut("generate_storyboard_frames", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value.startsWith("video:bridge:storyboard-frames:segment:")) {
      const segmentKey = decodeURIComponent(value.replace("video:bridge:storyboard-frames:segment:", ""));
      const targetIds = listGeneratableStoryboardSceneIdsForSegment(videoProject, segmentKey);
      if (!targetIds.length) return true;

      const shouldRefresh = (videoProject?.scenes ?? []).some(
        (scene) => targetIds.includes(scene.id) && Boolean(scene.storyboardUrl?.trim()),
      );

      void deps.runWorkflowActionShortcut(
        "generate_storyboard_frames",
        {
          projectId: snapshot.projectId,
          targetIds,
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:storyboard-frame:scene:")) {
      const sceneId = value.replace("video:bridge:storyboard-frame:scene:", "");
      const shouldRefresh = Boolean(videoProject?.scenes.find((scene) => scene.id === sceneId)?.storyboardUrl?.trim());
      void deps.runWorkflowActionShortcut(
        "generate_storyboard_frames",
        {
          projectId: snapshot.projectId,
          targetIds: [sceneId],
          ...(shouldRefresh ? { forceRegenerate: true } : {}),
        },
        label,
      );
      return true;
    }

    if (value === "video:bridge:shots") {
      void deps.runWorkflowActionShortcut("compile_video_shot_packets", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:prompts") {
      void deps.runWorkflowActionShortcut("prepare_video_prompt_batch", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:bridge:prompts:all") {
      void deps.runWorkflowActionShortcut(
        "prepare_video_prompt_batch",
        { projectId: snapshot.projectId, batchMode: "all" },
        label,
      );
      return true;
    }

    if (value === "video:bridge:prompts:batch") {
      void deps.runWorkflowActionShortcut(
        "prepare_video_prompt_batch",
        { projectId: snapshot.projectId, batchMode: "batch" },
        label,
      );
      return true;
    }

    if (value === "video:bridge:prompts:segment:all") {
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "all" },
        label,
      );
      return true;
    }

    if (value === "video:bridge:prompts:segment:batch") {
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "batch" },
        label,
      );
      return true;
    }

    if (value === "video:bridge:prompts:segment:remaining") {
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "remaining" },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:prompts:segment:episode:")) {
      const episodeKey = decodeURIComponent(
        value.replace("video:bridge:prompts:segment:episode:", ""),
      );
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "episode", targetEpisode: episodeKey },
        label,
      );
      return true;
    }

    if (value.startsWith("video:bridge:prompts:segment:label:")) {
      const segmentLabel = decodeURIComponent(
        value.replace("video:bridge:prompts:segment:label:", ""),
      );
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "single", targetSegmentLabel: segmentLabel },
        label,
      );
      return true;
    }

    if (value === "video:bridge:platform") {
      void deps.runBackgroundVideoBridgeResearch(label, "all");
      return true;
    }

    if (value === "video:step:entities") {
      if (deps.switchVideoStep) {
        deps.switchVideoStep(snapshot.projectId, 2, label);
      } else {
        void deps.runWorkflowActionShortcut("continue_video_step", { projectId: snapshot.projectId, targetStep: 2 }, label);
      }
      return true;
    }

    if (value === "video:step:storyboard") {
      if (deps.switchVideoStep) {
        deps.switchVideoStep(snapshot.projectId, 3, label);
      } else {
        void deps.runWorkflowActionShortcut("continue_video_step", { projectId: snapshot.projectId, targetStep: 3 }, label);
      }
      return true;
    }

    if (value === "video:step:video") {
      if (deps.switchVideoStep) {
        deps.switchVideoStep(snapshot.projectId, 4, label);
      } else {
        void deps.runWorkflowActionShortcut("continue_video_step", { projectId: snapshot.projectId, targetStep: 4 }, label);
      }
      return true;
    }

    if (value === "video:step:preview") {
      if (deps.switchVideoStep) {
        deps.switchVideoStep(snapshot.projectId, 5, label);
      } else {
        void deps.runWorkflowActionShortcut("continue_video_step", { projectId: snapshot.projectId, targetStep: 5 }, label);
      }
      return true;
    }

    if (value === "video:advance") {
      void deps.runWorkflowActionShortcut("advance_video_workflow", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:advance-round") {
      void deps.runWorkflowActionShortcut("advance_video_workflow_round", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "开始第一轮出片") {
      const nextQuestion = deps.buildVideoGenerationQuestion(snapshot, videoProject);
      if (nextQuestion && deps.listGeneratableVideoScenes(videoProject).length > 1) {
        deps.showChoicePopover(label, "先选这一轮要发的镜头。", nextQuestion);
        return true;
      }

      void deps.runWorkflowActionShortcut("generate_video_assets", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "导出生产状态包") {
      void deps.runWorkflowActionShortcut("export_video_production_bundle", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "预览生产状态摘要") {
      void deps.runWorkflowActionShortcut("preview_video_production_bundle", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "打开生产状态目录") {
      void deps.runWorkflowActionShortcut("open_video_production_bundle_directory", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:export:all") {
      void deps.runWorkflowActionShortcut(
        "export_video_asset_bundle",
        { projectId: snapshot.projectId },
        label,
      );
      return true;
    }

    if (value === "video:export:nle-placeholder") {
      deps.showChoiceNotice(label, "“导入到剪辑软件”后续实现，当前可先使用“全部导出”。");
      return true;
    }

    if (value === "video:export:ai-auto") {
      deps.showChoicePopover(label, "AI 自动处理导出：是否为合并视频添加字幕？", {
        id: `${snapshot.projectId}-ai-auto-subtitle`,
        title: "是否添加字幕？",
        answerKey: "video-export-ai-auto-subtitle",
        allowCustomInput: false,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 1,
        totalSteps: 1,
        options: [
          {
            id: `${snapshot.projectId}-ai-auto-subtitle-yes`,
            value: "video:export:ai-auto:subtitle:yes",
            label: "添加字幕（烧录对白）",
          },
          {
            id: `${snapshot.projectId}-ai-auto-subtitle-no`,
            value: "video:export:ai-auto:subtitle:no",
            label: "不添加字幕",
          },
        ],
      });
      return true;
    }

    if (
      value === "video:export:ai-auto:subtitle:yes" ||
      value === "video:export:ai-auto:subtitle:no"
    ) {
      const addSubtitles = value === "video:export:ai-auto:subtitle:yes";
      void (async () => {
        const project = deps.getCurrentVideoProject();
        if (!project) {
          deps.showChoiceNotice(label, "当前没有可处理的视频项目。");
          return;
        }

        const { compileSegmentVideos, exportSegmentVideosToFolder } = await import(
          "@/lib/home-agent/ffmpeg-segment-service"
        );

        let report: Awaited<ReturnType<typeof compileSegmentVideos>>;
        try {
          report = await compileSegmentVideos(project, { addSubtitles });
        } catch (err) {
          deps.showChoiceNotice(
            label,
            err instanceof Error ? err.message : "视频合并失败，请检查分镜视频状态后重试。",
          );
          return;
        }

        if (report.compiled.length === 0) {
          const skipReasons = report.skipped.map((s) => `• 片段 ${s.segmentLabel}：${s.reason}`).join("\n");
          deps.showChoiceNotice(label, `所有片段均未能合并。\n${skipReasons}`);
          return;
        }

        const destFolder = await window.electronAPI?.storage?.selectFolder?.();
        if (!destFolder) return;

        const exportResult = await exportSegmentVideosToFolder(report.compiled, destFolder);

        const subtitleWarnings = report.compiled
          .filter((r) => r.subtitleWarning)
          .map((r) => `• ${r.segmentLabel}：${r.subtitleWarning}`)
          .join("\n");
        const warningNote = subtitleWarnings ? `\n⚠️ 字幕识别问题：\n${subtitleWarnings}` : "";

        deps.showChoiceNotice(
          label,
          `已导出 ${exportResult.exportedCount} 个片段视频到：${destFolder}${exportResult.failedCount > 0 ? `\n（${exportResult.failedCount} 个文件复制失败）` : ""}${warningNote}`,
          {
            id: `${snapshot.projectId}-ai-auto-export-done`,
            title: "导出完成，下一步？",
            answerKey: "video-export-ai-auto-done",
            allowCustomInput: false,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 1,
            totalSteps: 1,
            options: [
              { id: `${snapshot.projectId}-ai-auto-done-preview`, value: "video:step:preview", label: "返回预览与导出" },
              { id: `${snapshot.projectId}-ai-auto-done-open`, value: "storage:open:" + destFolder, label: "打开导出目录" },
            ],
          },
        );
      })();
      return true;
    }

    if (value.startsWith("storage:open:")) {
      const targetPath = value.slice("storage:open:".length);
      void window.electronAPI?.storage?.openPath(targetPath);
      return true;
    }

    return false;
  };
}

export function createVideoAssetChoiceHandler(deps: VideoAssetChoiceDeps): VideoChoiceHandler {
  return (snapshot, value, label) => {
    if (snapshot.projectKind !== "video") {
      return false;
    }

    const videoProject = deps.getCurrentVideoProject();

    if (value === "video:advance") {
      void deps.runWorkflowActionShortcut("advance_video_workflow", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:advance-round") {
      void deps.runWorkflowActionShortcut("advance_video_workflow_round", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "video:generate:first") {
      const isTextToVideo = videoProject?.videoGenerationPrefs?.mode === "text-to-video";
      const targetIds = deps.listGeneratableVideoScenes(videoProject)
        .filter((scene) => !isTextToVideo || Boolean(scene.enhancedVideoPrompt?.trim()))
        .slice(0, 3)
        .map((scene) => scene.id);
      if (!targetIds.length) return true;

      void deps.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: snapshot.projectId, targetIds },
        label,
      );
      return true;
    }

    if (value === "video:generate:segments:first") {
      const segmentLabels = listGeneratableSegmentVideoLabels(videoProject).slice(0, 3);
      if (!segmentLabels.length) return true;

      void deps.runWorkflowActionShortcutChain(
        segmentLabels.map((segmentLabel) => ({
          action: "generate_segment_video",
          input: { projectId: snapshot.projectId, segmentLabel },
        })),
        label,
      );
      return true;
    }

    if (value === "video:generate:segments:failed") {
      const segmentLabels = listFailedSegmentVideoLabels(videoProject);
      if (!segmentLabels.length) return true;

      void deps.runWorkflowActionShortcutChain(
        segmentLabels.map((segmentLabel) => ({
          action: "generate_segment_video",
          input: { projectId: snapshot.projectId, segmentLabel },
        })),
        label,
      );
      return true;
    }

    if (value === "video:generate:segments:refresh") {
      const segmentLabels = listRunningSegmentVideoLabels(videoProject);
      if (!segmentLabels.length) return true;

      void deps.runWorkflowActionShortcutChain(
        segmentLabels.map((segmentLabel) => ({
          action: "refresh_segment_video",
          input: { projectId: snapshot.projectId, segmentLabel },
        })),
        label,
      );
      return true;
    }

    if (value === "video:generate:failed") {
      const targetIds = deps.listFailedVideoScenes(videoProject).map((scene) => scene.id);
      if (!targetIds.length) {
        const nextQuestion = deps.buildVideoGenerationSceneListQuestion(snapshot, videoProject);
        if (nextQuestion) {
          deps.showChoicePopover(label, "当前没有失败镜头，先从可生成镜头里选一条。", nextQuestion);
        }
        return true;
      }

      void deps.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: snapshot.projectId, targetIds, forceRegenerate: true },
        label,
      );
      return true;
    }

    if (value === "video:generate:list") {
      const nextQuestion = deps.buildVideoGenerationSceneListQuestion(snapshot, videoProject);
      if (nextQuestion) {
        deps.showChoicePopover(label, "选一条镜头开始出片。", nextQuestion);
      }
      return true;
    }

    if (value.startsWith("video:generate:segment:")) {
      const segmentKey = decodeURIComponent(value.replace("video:generate:segment:", ""));
      const targetIds = listSelectableVideoSceneIdsForSegment(videoProject, segmentKey);
      if (!targetIds.length) return true;

      void deps.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: snapshot.projectId, targetIds },
        label,
      );
      return true;
    }

    if (value.startsWith("video:generate:segment-video:")) {
      const segmentKey = decodeURIComponent(value.replace("video:generate:segment-video:", ""));
      void deps.runWorkflowActionShortcut(
        "generate_segment_video",
        { projectId: snapshot.projectId, segmentLabel: segmentKey },
        label,
      );
      return true;
    }

    if (value.startsWith("video:generate:scene:")) {
      const sceneId = value.replace("video:generate:scene:", "");
      void deps.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: snapshot.projectId, targetIds: [sceneId] },
        label,
      );
      return true;
    }

    return false;
  };
}
