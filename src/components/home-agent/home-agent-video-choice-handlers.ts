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
  getHomeAgentVideoGenerationBatchLimit,
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
  buildVideoBridgePrefixQuestion,
  buildVideoContinuationQuestion,
  formatVideoStepLabelWithCount,
  listFailedSegmentVideoLabels,
  listGeneratableSegmentVideoLabels,
  listGeneratableStoryboardSceneIdsForSegment,
  listRunningSegmentVideoLabels,
  listSmartStoryboardFrameTargetIds,
  listSelectableVideoSceneIdsForSegment,
  listVideoReferenceAssetTargetIds,
} from "./home-agent-project-questions";
import {
  parseCharacterAudioPresetBindValue,
  parseCharacterAudioPresetPickerValue,
  type CharacterAudioPresetBindSelection,
} from "@/lib/home-agent/character-audio-preset-library";

type WorkflowShortcutRunner = (
  action: string,
  input: Record<string, unknown>,
  label: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
    restoreQuestionOnError?: ComposerQuestion | null;
    restoreQuestionAfterRun?: ComposerQuestion | null;
    skipUserBubble?: boolean;
  },
) => void | Promise<void>;

type WorkflowShortcutChainRunner = (
  steps: Array<{ action: string; input: Record<string, unknown> }>,
  label: string,
  options?: {
    restoreQuestionOnInterrupt?: ComposerQuestion | null;
    restoreQuestionOnCancel?: ComposerQuestion | null;
    restoreQuestionOnError?: ComposerQuestion | null;
    restoreQuestionAfterRun?: ComposerQuestion | null;
    skipUserBubble?: boolean;
  },
) => void | Promise<void>;

type BackgroundVideoBridgeResearchRunner = (
  label: string,
  mode?: "all" | "targetPlatform" | "shotStyle" | "outputGoal",
) => void | Promise<void>;
type MediaPrefsCommitter<TPrefs> = (prefs: Partial<TPrefs>) => void | Promise<unknown>;
type VideoProjectPatcher = (patch: Partial<PersistedVideoProject>) => void | Promise<void>;
type ImageStyleRecognizer = () => Promise<HomeAgentImageStyleRecognitionResult | null>;
type SubmittedStyleReferenceResult =
  HomeAgentImageStyleRecognitionResult & { handledLocally?: boolean };
type CharacterAudioReferenceUploadAwaiter = (
  label: string,
  characterId: string,
  characterName?: string,
) => void | Promise<void>;
type CharacterAudioReferencePresetPickerOpener = (
  label: string,
  characterId: string,
  characterName?: string,
) => void | Promise<void>;
type CharacterAudioReferencePresetBinder = (
  selection: CharacterAudioPresetBindSelection & {
    label: string;
    characterName?: string;
  },
) => void | Promise<void>;

type SceneLike = {
  id: string;
  enhancedVideoPrompt?: string;
};

const EPISODE_SEGMENT_VALUE_RE = /^\d+-\d+$/;

function inferCharacterNameFromAudioReferenceLabel(label: string): string | undefined {
  const normalized = label.trim();
  if (!normalized) return undefined;
  const match = normalized.match(/^(?:上传|更新)\s*(.+?)\s*音频参考$/);
  const candidate = match?.[1]?.trim();
  if (!candidate || candidate === "角色") return undefined;
  return candidate;
}

function hasAllReadySegmentPrompts(
  project: PersistedVideoProject | null | undefined,
): boolean {
  const segmentLabels = [
    ...new Set(
      (project?.scenes ?? [])
        .map((scene) => scene.segmentLabel?.trim())
        .filter((label): label is string => !!label && EPISODE_SEGMENT_VALUE_RE.test(label)),
    ),
  ];
  return (
    segmentLabels.length > 0 &&
    segmentLabels.every((label) => Boolean(project?.segmentVideoPrompts?.[label]?.prompt?.trim()))
  );
}

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
  commitVideoProjectPatch?: VideoProjectPatcher;
  commitImageGenerationPrefs?: MediaPrefsCommitter<VideoImageGenerationPrefs>;
  commitVideoGenerationPrefs?: MediaPrefsCommitter<VideoGenerationPrefs>;
  getImageGenerationPrefs?: () => VideoImageGenerationPrefs;
  getVideoGenerationPrefs?: () => VideoGenerationPrefs;
  getAttachedImageCount?: () => number;
  clearAttachedFiles?: () => void;
  recognizeImageStyle?: ImageStyleRecognizer;
  submitAttachedStyleReference?: (label: string) => Promise<SubmittedStyleReferenceResult | null>;
  awaitImageStyleReferenceUpload?: (label: string) => void | Promise<void>;
  awaitCharacterAudioReferenceUpload?: CharacterAudioReferenceUploadAwaiter;
  openCharacterAudioReferencePresetPicker?: CharacterAudioReferencePresetPickerOpener;
  bindCharacterAudioReferencePreset?: CharacterAudioReferencePresetBinder;
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
  return mode === "image-to-video" ? "\u56fe\u751f\u89c6\u9891" : "\u6587\u751f\u89c6\u9891";
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
        ? "\u4f7f\u7528\u5f53\u524d\u53c2\u8003\u56fe\u6216\u540e\u7eed\u5206\u955c\u56fe\u4f5c\u4e3a\u89c6\u9891\u751f\u6210\u8d77\u70b9\u3002"
        : "\u76f4\u63a5\u7528\u955c\u5934\u63cf\u8ff0\u548c\u63d0\u793a\u8bcd\u751f\u6210\u89c6\u9891\u3002",
  });

  return {
    id: `video-kickoff-prefs-mode-${snapshot.projectId}`,
    title: "\u5148\u9009\u62e9\u89c6\u9891\u751f\u6210\u6a21\u5f0f",
    description: "\u786e\u8ba4\u540e\u4f1a\u5199\u5165\u5f53\u524d\u89c6\u9891\u751f\u6210\u53c2\u6570\uff0c\u7136\u540e\u7ee7\u7eed\u9009\u62e9\u753b\u9762\u98ce\u683c\u3002",
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

function buildVideoPostAnalyzeModeQuestion(
  snapshot: ConversationProjectSnapshot,
  currentPrefs?: VideoGenerationPrefs,
): ComposerQuestion {
  const kickoffQuestion = buildVideoKickoffModeQuestion(snapshot, currentPrefs);
  return {
    ...kickoffQuestion,
    id: `video-post-analyze-mode-${snapshot.projectId}`,
    title: "选择视频生成模式",
    description: "先确认这次视频是走文生还是图生，再继续后续视频工作流。",
    answerKey: "video-post-analyze-mode",
    options: kickoffQuestion.options.map((option) => ({
      ...option,
      selected: false,
    })),
  };
}

function buildVideoKickoffStyleQuestion(
  snapshot: ConversationProjectSnapshot,
  currentPrefs?: VideoImageGenerationPrefs,
  attachedImageCount = 0,
): ComposerQuestion {
  const normalized = normalizeVideoImageGenerationPrefs(currentPrefs);

  const options = listHomeAgentImageStyleCategories()
    .filter((category) => category.key !== "custom")
    .map((category) => {
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
    title: "\u9009\u62e9\u753b\u9762\u98ce\u683c\u7c7b\u578b",
    description:
      attachedImageCount > 0
        ? `\u76f4\u63a5\u9009\u62e9\u9884\u8bbe\u98ce\u683c\uff0c\u6216\u5728\u5e95\u90e8\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\uff1b\u4e5f\u53ef\u4ee5\u4e0a\u4f20 ${attachedImageCount} \u5f20\u53c2\u8003\u56fe\u540e\u53d1\u9001\uff0c\u6211\u4f1a\u81ea\u52a8\u8bc6\u522b\u5e76\u7ee7\u7eed\u4e0b\u4e00\u6b65\u3002`
        : "\u76f4\u63a5\u9009\u62e9\u9884\u8bbe\u98ce\u683c\uff0c\u6216\u5728\u5e95\u90e8\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\uff1b\u4e5f\u53ef\u4ee5\u4e0a\u4f20\u53c2\u8003\u56fe\u540e\u53d1\u9001\uff0c\u6211\u4f1a\u81ea\u52a8\u8bc6\u522b\u5e76\u7ee7\u7eed\u4e0b\u4e00\u6b65\u3002",
    options,
    presentation: "card",
    allowCustomInput: true,
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
  const lines = ["\u5df2\u786e\u8ba4\u524d\u7f6e\u751f\u6210\u504f\u597d\uff0c\u63a5\u4e0b\u6765\u81ea\u52a8\u8865\u9f50\u5e73\u53f0\u548c\u955c\u5934\u504f\u597d\u3002"];
  if (params.videoMode) {
    lines.push(`\u89c6\u9891\u6a21\u5f0f\uff1a${localizeVideoGenerationMode(params.videoMode)}`);
  }
  if (params.imagePrefs) {
    lines.push(`\u753b\u9762\u98ce\u683c\uff1a${buildVideoImageStyleSummary(params.imagePrefs)}`);
  }
  if (params.recognitionSummary?.trim()) {
    lines.push(`\u53c2\u8003\u56fe\u6458\u8981\uff1a${params.recognitionSummary.trim()}`);
  }
  return lines.join("\n");
}

async function commitKickoffStyleAndPause(params: {
  deps: VideoProjectChoiceDeps;
  snapshot: ConversationProjectSnapshot;
  label: string;
  imagePrefs: Partial<VideoImageGenerationPrefs>;
  recognitionSummary?: string;
}) {
  const { deps, snapshot, label, imagePrefs, recognitionSummary } = params;
  deps.clearAwaitImageStyleReferenceUpload?.();
  deps.clearAttachedFiles?.();
  const currentImagePrefs = normalizeVideoImageGenerationPrefs({
    ...(deps.getImageGenerationPrefs?.() ?? {}),
    ...imagePrefs,
  });
  await deps.commitImageGenerationPrefs?.(currentImagePrefs);
  await deps.commitVideoProjectPatch?.({
    kickoffModeConfirmed: true,
    kickoffStyleConfirmed: true,
  });
  const prefixQuestion = buildVideoBridgePrefixQuestion(
    snapshot,
    deps.getCurrentVideoProject(),
  );
  const nextQuestion =
    prefixQuestion ??
    buildVideoContinuationQuestion(snapshot, deps.getCurrentVideoProject());
  const summary = buildPrefsSummary({
    videoMode: normalizeVideoGenerationPrefs(deps.getVideoGenerationPrefs?.()).mode,
    imagePrefs: currentImagePrefs,
    recognitionSummary,
  });

  if (prefixQuestion) {
    deps.showChoicePopover(
      label,
      `${summary}\n\n\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\u3002\u4e0b\u4e00\u6b65\u8bf7\u5148\u70b9\u201c\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d\u201d\u3002`,
      prefixQuestion,
    );
    return;
  }

  if (nextQuestion) {
    deps.showChoicePopover(label, summary, nextQuestion);
    return;
  }

  deps.showChoiceNotice(label, summary);
}

function buildPostEntityKickoffQuestion(
  snapshot: ConversationProjectSnapshot,
): ComposerQuestion | null {
  return buildScriptAnalyzeDurationQuestion(snapshot);
}

export function buildScriptAnalyzeDurationQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion {
  return {
    id: `video-analyze-duration-${snapshot.projectId}`,
    title: "\u8bf7\u9009\u62e9\u5355\u96c6\u65f6\u957f",
    description: "\u65f6\u957f\u4f1a\u5f71\u54cd\u955c\u5934\u62c6\u89e3\u7684\u9897\u7c92\u5ea6\u548c\u65f6\u957f\u5206\u914d",
    options: [
      { id: "dur-60", label: "60 \u79d2", value: "video:bridge:analyze:dur:60", rationale: "\u5feb\u8282\u594f\u77ed\u5267\uff0c\u6bcf\u96c6\u7ea6 60 \u79d2" },
      { id: "dur-90", label: "90 \u79d2", value: "video:bridge:analyze:dur:90", rationale: "\u6807\u51c6\u65f6\u957f\uff0c\u9002\u5408\u5927\u591a\u6570\u77ed\u5267\u7c7b\u578b" },
      { id: "dur-120", label: "120 \u79d2", value: "video:bridge:analyze:dur:120", rationale: "\u8f83\u957f\u65f6\u957f\uff0c\u9002\u5408\u60c5\u611f\u620f\u6216\u590d\u6742\u5267\u60c5" },
      {
        id: "dur-custom",
        label: "\u81ea\u5b9a\u4e49",
        value: "video:bridge:analyze:dur:custom",
        rationale: "\u624b\u52a8\u8f93\u5165\u81ea\u5b9a\u4e49\u65f6\u957f",
        childInput: {
          type: "number",
          actionPrefix: "video:bridge:analyze:dur:n:",
          min: 15,
          max: 600,
          placeholder: "\u8f93\u5165\u65f6\u957f\uff08\u79d2\uff09",
          suffix: "\u79d2",
          buttonLabel: "\u786e\u8ba4",
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
    title: "\u8bf7\u9009\u62e9\u89c6\u9891\u8282\u594f",
    description: "\u8282\u594f\u51b3\u5b9a\u6bcf\u4e2a\u7247\u6bb5\u7684\u5206\u955c\u6570\u91cf\u548c\u53f0\u8bcd\u5b57\u6570\u4e0a\u9650",
    options: [
      {
        id: "pace-slow",
        label: "\u6162\u8282\u594f",
        value: `video:bridge:analyze:pace:slow:${duration}`,
        rationale: "\u6bcf\u7247\u6bb5 2 \u5230 4 \u4e2a\u5206\u955c\uff0c\u9002\u5408\u60c5\u611f\u620f\u548c\u6162\u8282\u594f\u5267\u60c5",
      },
      {
        id: "pace-medium",
        label: "\u4e2d\u7b49",
        value: `video:bridge:analyze:pace:medium:${duration}`,
        rationale: "\u6bcf\u7247\u6bb5 3 \u5230 5 \u4e2a\u5206\u955c\uff0c\u9002\u5408\u5927\u591a\u6570\u77ed\u5267\u7c7b\u578b",
      },
      {
        id: "pace-fast",
        label: "\u5feb\u8282\u594f",
        value: `video:bridge:analyze:pace:fast:${duration}`,
        rationale: "\u6bcf\u7247\u6bb5 4 \u5230 6 \u4e2a\u5206\u955c\uff0c\u9002\u5408\u52a8\u4f5c\u3001\u60ac\u7591\u3001\u723d\u5267",
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
  if (snapshot.derivedStage !== "\u811a\u672c\u62c6\u89e3") return null;
  return buildVideoContinuationQuestion(snapshot, project ?? null);
}

function buildAnalyzeInterruptRestoreQuestion(
  snapshot: ConversationProjectSnapshot,
  duration: string,
  pace: string,
  options?: { retryMissingEpisodes?: boolean },
): ComposerQuestion {
  const normalizedPace =
    pace === "slow" || pace === "medium" || pace === "fast" ? pace : "medium";
  const paceLabel =
    normalizedPace === "slow" ? "\u6162\u8282\u594f" : normalizedPace === "fast" ? "\u5feb\u8282\u594f" : "\u4e2d\u7b49";
  const retryMissingEpisodes = options?.retryMissingEpisodes === true;
  const actionLabel = retryMissingEpisodes ? "\u7ee7\u7eed\u8865\u9f50\u7f3a\u5931\u96c6\u6570" : "\u7ee7\u7eed\u5267\u672c\u62c6\u89e3";
  const actionValue = retryMissingEpisodes
    ? `video:bridge:analyze:resume:${normalizedPace}:${duration}:retry-missing`
    : `video:bridge:analyze:resume:${normalizedPace}:${duration}`;

  return {
    id: `video-analyze-restore-${snapshot.projectId}-${normalizedPace}-${duration}${retryMissingEpisodes ? "-retry-missing" : ""}`,
    title: actionLabel,
    description: retryMissingEpisodes
      ? `\u5df2\u8bb0\u5f55\u5355\u96c6\u65f6\u957f ${duration} \u79d2\u548c ${paceLabel} \u8282\u594f\u3002\u70b9\u51fb\u540e\u7ee7\u7eed\u8865\u9f50\u5f53\u524d\u7f3a\u5931\u96c6\u6570\u3002`
      : `\u5df2\u8bb0\u5f55\u5355\u96c6\u65f6\u957f ${duration} \u79d2\u548c ${paceLabel} \u8282\u594f\u3002\u70b9\u51fb\u540e\u7ee7\u7eed\u6267\u884c\u5f53\u524d\u5267\u672c\u62c6\u89e3\u3002`,
    options: [
      {
        id: `${snapshot.projectId}-video-analyze-restore`,
        label: actionLabel,
        value: actionValue,
        rationale: retryMissingEpisodes
          ? "\u6cbf\u7528\u5f53\u524d\u62c6\u89e3\u53c2\u6570\uff0c\u53ea\u7ee7\u7eed\u8865\u9f50\u8fd8\u672a\u8986\u76d6\u5230\u7684\u7f3a\u5931\u96c6\u6570\u3002"
          : "\u6cbf\u7528\u5f53\u524d\u62c6\u89e3\u53c2\u6570\uff0c\u7ee7\u7eed\u5b8c\u6210\u5f53\u524d\u5267\u672c\u62c6\u89e3\u3002",
      },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: retryMissingEpisodes ? "video-analyze-retry-missing" : "video-analyze-resume",
    statusBadges: [
      { label: "\u5df2\u8bb0\u5f55\u53c2\u6570", value: `${duration} \u79d2 / ${paceLabel}`, tone: "default" },
    ],
  };
}

function buildAnalyzeExecuteQuestion(
  snapshot: ConversationProjectSnapshot,
  duration: string,
  pace: string,
): ComposerQuestion {
  const normalizedPace =
    pace === "slow" || pace === "medium" || pace === "fast" ? pace : "medium";
  const paceLabel =
    normalizedPace === "slow" ? "\u6162\u8282\u594f" : normalizedPace === "fast" ? "\u5feb\u8282\u594f" : "\u4e2d\u7b49";

  return {
    id: `video-analyze-execute-${snapshot.projectId}-${normalizedPace}-${duration}`,
    title: "\u5b8c\u6210\u5267\u672c\u62c6\u89e3",
    description: `\u5df2\u8bb0\u5f55\u5355\u96c6\u65f6\u957f ${duration} \u79d2\u548c ${paceLabel} \u8282\u594f\u3002\u70b9\u51fb\u540e\u5f00\u59cb\u6267\u884c\u5f53\u524d\u5267\u672c\u62c6\u89e3\u3002`,
    options: [
      {
        id: `${snapshot.projectId}-video-analyze-execute`,
        label: "\u5b8c\u6210\u5267\u672c\u62c6\u89e3",
        value: `video:bridge:analyze:execute:${normalizedPace}:${duration}`,
        rationale: "\u786e\u8ba4\u5f53\u524d\u62c6\u89e3\u53c2\u6570\u540e\uff0c\u6b63\u5f0f\u5f00\u59cb\u6267\u884c\u5267\u672c\u62c6\u89e3\u3002",
      },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "video-analyze-execute",
    statusBadges: [
      { label: "\u5df2\u8bb0\u5f55\u53c2\u6570", value: `${duration} \u79d2 / ${paceLabel}`, tone: "default" },
    ],
  };
}

export function createVideoProjectChoiceHandler(deps: VideoProjectChoiceDeps): VideoChoiceHandler {
  return (snapshot, value, label) => {
    const videoProject = deps.getCurrentVideoProject();
    const storedPace = videoProject?.preferredScriptBreakdownPace ?? "medium";
    const storedDuration =
      typeof videoProject?.preferredEpisodeDurationSeconds === "number" &&
      Number.isFinite(videoProject.preferredEpisodeDurationSeconds) &&
      videoProject.preferredEpisodeDurationSeconds > 0
        ? String(videoProject.preferredEpisodeDurationSeconds)
        : null;
    const hasExistingBreakdownScenes = (videoProject?.scenes.length ?? 0) > 0;
    const runScriptAnalyzeShortcut = (params: {
      pace: string;
      duration: string;
      retryMissingEpisodes?: boolean;
      restoreQuestionOverride?: ComposerQuestion;
    }) => {
      const restoreQuestion =
        params.restoreQuestionOverride ??
        buildAnalyzeInterruptRestoreQuestion(
          snapshot,
          params.duration,
          params.pace,
          { retryMissingEpisodes: params.retryMissingEpisodes },
        );

      void deps.runWorkflowActionShortcut(
        "analyze_script_for_video",
        {
          projectId: snapshot.projectId,
          videoPace: params.pace,
          episodeDuration: parseInt(params.duration, 10),
          ...(params.retryMissingEpisodes ? { retryMissingEpisodes: true } : {}),
        },
        label,
        {
          restoreQuestionOnInterrupt: restoreQuestion,
          restoreQuestionOnCancel: restoreQuestion,
          restoreQuestionOnError: restoreQuestion,
        },
      );
    };

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
      ).then(async () => {
        const syncedVideoPrefs = normalizeVideoGenerationPrefs({
          ...(deps.getVideoGenerationPrefs?.() ?? {}),
          mode: normalizeVideoGenerationMode(resolvedMode),
        });
        await deps.commitVideoProjectPatch?.({
          kickoffModeConfirmed: true,
          videoGenerationPrefs: syncedVideoPrefs,
        });
        deps.showChoicePopover(
          label,
          `\u89c6\u9891\u751f\u6210\u6a21\u5f0f\u5df2\u8bbe\u4e3a ${localizeVideoGenerationMode(resolvedMode)}\u3002\u73b0\u5728\u9009\u62e9\u753b\u9762\u98ce\u683c\u7c7b\u578b\u3002`,
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

      void commitKickoffStyleAndPause({
        deps,
        snapshot,
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
          "\u8fd8\u6ca1\u6709\u6536\u5230\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\uff0c\u8bf7\u91cd\u65b0\u8f93\u5165\u3002",
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
        return true;
      }

      void commitKickoffStyleAndPause({
        deps,
        snapshot,
        label,
        imagePrefs: {
          styleCategory: "custom",
          stylePreset: "custom",
          customStylePrompt,
        },
        recognitionSummary: `自定义风格说明已写入：${customStylePrompt}`,
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
          "\u8fd8\u6ca1\u6709\u53ef\u8bc6\u522b\u7684\u53c2\u8003\u56fe\u3002\u8bf7\u5148\u4e0a\u4f20\u53c2\u8003\u56fe\uff0c\u6216\u76f4\u63a5\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\u3002",
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
          "\u5f53\u524d\u6682\u65f6\u65e0\u6cd5\u8bc6\u522b\u53c2\u8003\u56fe\u98ce\u683c\uff0c\u8bf7\u6539\u4e3a\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\u3002",
          buildVideoKickoffStyleQuestion(
            snapshot,
            deps.getImageGenerationPrefs?.(),
            deps.getAttachedImageCount?.() ?? 0,
          ),
        );
        return true;
      }

      deps.clearAwaitImageStyleReferenceUpload?.();
      const runRecognition =
        deps.submitAttachedStyleReference
          ? deps.submitAttachedStyleReference(label)
          : deps.recognizeImageStyle();
      void Promise.resolve(runRecognition)
        .then((result) => {
          if (!result) {
            deps.showChoicePopover(
              label,
              "\u53c2\u8003\u56fe\u6682\u65f6\u6ca1\u6709\u8bc6\u522b\u51fa\u7a33\u5b9a\u98ce\u683c\uff0c\u8bf7\u6539\u4e3a\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\u3002",
              buildVideoKickoffStyleQuestion(
                snapshot,
                deps.getImageGenerationPrefs?.(),
                deps.getAttachedImageCount?.() ?? 0,
              ),
            );
            return;
          }
          if (result.handledLocally) {
            return;
          }
          return commitKickoffStyleAndPause({
            deps,
            snapshot,
            label,
            imagePrefs: buildImagePrefsPatchFromRecognition(result),
            recognitionSummary: result.summary,
          });
        })
        .catch((error) => {
          deps.showChoicePopover(
            label,
            error instanceof Error ? error.message : "\u53c2\u8003\u56fe\u98ce\u683c\u8bc6\u522b\u5931\u8d25\uff0c\u8bf7\u6539\u4e3a\u8f93\u5165\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\u3002",
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

    if (value === "video:bridge:next-step") {
      deps.showChoicePopover(
        label,
        "脚本拆解已经完成，先确认视频生成模式，再继续后续视频工作流。",
        buildVideoPostAnalyzeModeQuestion(snapshot, deps.getVideoGenerationPrefs?.()),
      );
      return true;
    }

    if (value === "video:bridge:analyze") {
      if (
        hasExistingBreakdownScenes &&
        storedDuration &&
        (storedPace === "slow" || storedPace === "medium" || storedPace === "fast")
      ) {
        runScriptAnalyzeShortcut({
          pace: storedPace,
          duration: storedDuration,
        });
        return true;
      }

      deps.showChoicePopover(label, "\u5728\u62c6\u89e3\u5267\u672c\u524d\uff0c\u9700\u8981\u5148\u786e\u8ba4\u4e24\u9879\u5173\u952e\u53c2\u6570\u3002", buildScriptAnalyzeDurationQuestion(snapshot));
      return true;
    }

    if (value === "video:bridge:analyze:retry-missing") {
      runScriptAnalyzeShortcut({
        pace: storedPace,
        duration: storedDuration ?? "90",
        retryMissingEpisodes: true,
      });
      return true;
    }

    if (value.startsWith("video:bridge:analyze:resume:")) {
      const parts = value.split(":");
      const pace = parts[4] ?? "medium";
      const duration = parts[5] ?? "90";
      const retryMissingEpisodes = parts[6] === "retry-missing";
      runScriptAnalyzeShortcut({ pace, duration, retryMissingEpisodes });
      return true;
    }

    if (value.startsWith("video:bridge:analyze:execute:")) {
      const parts = value.split(":");
      const pace = parts[4] ?? "medium";
      const duration = parts[5] ?? "90";
      runScriptAnalyzeShortcut({ pace, duration });
      return true;
    }

    if (
      value === "video:bridge:analyze:dur:60" ||
      value === "video:bridge:analyze:dur:90" ||
      value === "video:bridge:analyze:dur:120"
    ) {
      const duration = value.split(":").pop()!;
      deps.showChoicePopover(label, `\u5355\u96c6\u65f6\u957f\u5df2\u8bbe\u4e3a ${duration} \u79d2\uff0c\u8bf7\u9009\u62e9\u89c6\u9891\u8282\u594f\u3002`, buildScriptAnalyzePaceQuestion(snapshot, duration));
      return true;
    }

    // 闂傚倷绀侀幖顐﹀疮椤愶附鍋夊┑鍌滎焾濮规煡姊洪鈧粔鐢告倿鐠囧樊鐔嗛悹杞拌閸庡繑銇勮箛瀣姦闁哄被鍔岄埥澶娢熼悡搴樺彚闂備焦鎮堕崐鏍垝鎼淬劌鐒垫い鎺戝枤濞兼劙鏌ｉ褍鏋ょ紒?childInput 闂傚倷绀佸﹢杈╁垝椤栫偛绀夐柟鐑樺焾濞尖晠鏌ㄩ弴鐐测偓褰掑疾?
    if (value.startsWith("video:bridge:analyze:dur:n:")) {
      const duration = value.replace("video:bridge:analyze:dur:n:", "").trim();
      if (!duration || isNaN(Number(duration))) {
        deps.showChoicePopover(label, "\u65f6\u957f\u8f93\u5165\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u3002", buildScriptAnalyzeDurationQuestion(snapshot));
        return true;
      }
      deps.showChoicePopover(label, `\u5355\u96c6\u65f6\u957f\u5df2\u8bbe\u4e3a ${duration} \u79d2\uff0c\u8bf7\u9009\u62e9\u89c6\u9891\u8282\u594f\u3002`, buildScriptAnalyzePaceQuestion(snapshot, duration));
      return true;
    }

    // 闂傚倷鑳堕崢褔骞栭锕€纾归柟闂撮檷閳ь剙鍟村顕€宕奸悢鍝勫Х濠电姰鍨煎▔娑㈩敄閸涙惌鏁傞柕澶嗘櫆閸婄敻鏌ｉ悢鍝勵暭婵犫偓娴煎瓨鐓?闂?闂傚倷绀佸﹢閬嶆偡閹惰棄骞㈤柍鍝勫€归弶鎼佹⒒娴ｇ儤鍤€闁搞垺褰冭灋婵犲﹤妫弳?
    if (value.startsWith("video:bridge:analyze:pace:")) {
      const parts = value.split(":");
      const pace = parts[4] ?? "medium";
      const duration = parts[5] ?? "90";
      const normalizedPace = pace === "slow" || pace === "medium" || pace === "fast" ? pace : "medium";
      const numericDuration = Number(duration);

      void Promise.resolve(
        Number.isFinite(numericDuration) && numericDuration > 0
          ? deps.commitVideoProjectPatch?.({
              preferredEpisodeDurationSeconds: numericDuration,
              preferredScriptBreakdownPace: normalizedPace,
            })
          : undefined,
      ).then(() => {
        deps.showChoicePopover(
          label,
          `\u5355\u96c6\u65f6\u957f\u548c\u89c6\u9891\u8282\u594f\u5df2\u8bb0\u5f55\uff0c\u70b9\u51fb\u540e\u7ee7\u7eed\u5b8c\u6210\u5267\u672c\u62c6\u89e3\u3002`,
          buildAnalyzeExecuteQuestion(snapshot, duration, normalizedPace),
        );
      });
      return true;
    }

    if (value === "video:bridge:entities") {
      const restoreQuestionAfterRun =
        snapshot.derivedStage === "\u811a\u672c\u62c6\u89e3"
          ? buildPostEntityKickoffQuestion(snapshot)
          : null;
      void deps.runWorkflowActionShortcut(
        "extract_video_entities",
        { projectId: snapshot.projectId },
        label,
        restoreQuestionAfterRun
          ? { restoreQuestionAfterRun }
          : undefined,
      );
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

    const presetPickerCharacterId = parseCharacterAudioPresetPickerValue(value);
    if (presetPickerCharacterId) {
      const characterName =
        videoProject?.characters.find((character) => character.id === presetPickerCharacterId)?.name?.trim() ||
        inferCharacterNameFromAudioReferenceLabel(label);
      if (deps.openCharacterAudioReferencePresetPicker) {
        void Promise.resolve(
          deps.openCharacterAudioReferencePresetPicker(
            label,
            presetPickerCharacterId,
            characterName,
          ),
        );
      } else {
        deps.showChoiceNotice(
          label,
          characterName
            ? `当前还不能打开角色《${characterName}》的预设参考音频面板，请稍后再试。`
            : "当前还不能打开预设参考音频面板，请稍后再试。",
        );
      }
      return true;
    }

    const presetBindSelection = parseCharacterAudioPresetBindValue(value);
    if (presetBindSelection) {
      const characterName =
        videoProject?.characters.find((character) => character.id === presetBindSelection.characterId)?.name?.trim() ||
        inferCharacterNameFromAudioReferenceLabel(label);
      if (deps.bindCharacterAudioReferencePreset) {
        void Promise.resolve(
          deps.bindCharacterAudioReferencePreset({
            ...presetBindSelection,
            label,
            characterName,
          }),
        );
      } else {
        deps.showChoiceNotice(
          label,
          characterName
            ? `当前还不能把预设参考音频绑定到角色《${characterName}》，请稍后再试。`
            : "当前还不能绑定预设参考音频，请稍后再试。",
        );
      }
      return true;
    }

    if (value.startsWith("video:bridge:reference-audio:character:")) {
      const characterId = value.replace("video:bridge:reference-audio:character:", "");
      const characterName =
        videoProject?.characters.find((character) => character.id === characterId)?.name?.trim() ||
        inferCharacterNameFromAudioReferenceLabel(label);
      if (deps.awaitCharacterAudioReferenceUpload) {
        void Promise.resolve(
          deps.awaitCharacterAudioReferenceUpload(label, characterId, characterName),
        );
      } else {
        deps.showChoiceNotice(
          label,
          characterName
            ? `当前还不能接收《${characterName}》的音频参考上传，请稍后再试。`
            : "当前还不能接收角色音频参考上传，请稍后再试。",
        );
      }
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
      const targetIds = listSmartStoryboardFrameTargetIds(videoProject);
      if (!targetIds.length) return true;

      void deps.runWorkflowActionShortcut(
        "generate_storyboard_frames",
        { projectId: snapshot.projectId, smartBatch: true, targetIds },
        label,
      );
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

    if (value === "video:bridge:prompts:segment") {
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode: "all" },
        label,
      );
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
      const batchMode = hasAllReadySegmentPrompts(videoProject) ? "batch-refresh" : "batch";
      void deps.runWorkflowActionShortcut(
        "prepare_segment_video_prompt",
        { projectId: snapshot.projectId, batchMode },
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

    if (value === "\u5f00\u59cb\u7b2c\u4e00\u8f6e\u51fa\u7247") {
      const nextQuestion = deps.buildVideoGenerationQuestion(snapshot, videoProject);
      if (nextQuestion && deps.listGeneratableVideoScenes(videoProject).length > 1) {
        deps.showChoicePopover(label, "\u5148\u9009\u8fd9\u4e00\u8f6e\u8981\u53d1\u7684\u955c\u5934\u3002", nextQuestion);
        return true;
      }

      void deps.runWorkflowActionShortcut("generate_video_assets", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "\u5bfc\u51fa\u751f\u4ea7\u72b6\u6001\u5305") {
      void deps.runWorkflowActionShortcut("export_video_production_bundle", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "\u9884\u89c8\u751f\u4ea7\u72b6\u6001\u6458\u8981") {
      void deps.runWorkflowActionShortcut("preview_video_production_bundle", { projectId: snapshot.projectId }, label);
      return true;
    }

    if (value === "\u6253\u5f00\u751f\u4ea7\u72b6\u6001\u76ee\u5f55") {
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
      deps.showChoiceNotice(label, "\u201c\u5bfc\u5165\u5230\u526a\u8f91\u8f6f\u4ef6\u201d\u540e\u7eed\u5b9e\u73b0\uff0c\u5f53\u524d\u53ef\u5148\u4f7f\u7528\u201c\u5168\u90e8\u5bfc\u51fa\u201d\u3002");
      return true;
    }

    if (value === "video:export:ai-auto") {
      deps.showChoicePopover(label, "AI \u81ea\u52a8\u5904\u7406\u5bfc\u51fa\uff1a\u662f\u5426\u4e3a\u5408\u5e76\u89c6\u9891\u6dfb\u52a0\u5b57\u5e55\uff1f", {
        id: `${snapshot.projectId}-ai-auto-subtitle`,
        title: "\u662f\u5426\u6dfb\u52a0\u5b57\u5e55\uff1f",
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
            label: "\u6dfb\u52a0\u5b57\u5e55\uff08\u70e7\u5f55\u5bf9\u767d\uff09",
          },
          {
            id: `${snapshot.projectId}-ai-auto-subtitle-no`,
            value: "video:export:ai-auto:subtitle:no",
            label: "\u4e0d\u6dfb\u52a0\u5b57\u5e55",
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
          deps.showChoiceNotice(label, "\u5f53\u524d\u6ca1\u6709\u53ef\u5904\u7406\u7684\u89c6\u9891\u9879\u76ee\u3002");
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
            err instanceof Error ? err.message : "\u89c6\u9891\u5408\u5e76\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5206\u955c\u89c6\u9891\u72b6\u6001\u540e\u91cd\u8bd5\u3002",
          );
          return;
        }

        if (report.compiled.length === 0) {
          const skipReasons = report.skipped.map((s) => `闁?\u7247\u6bb5 ${s.segmentLabel}\uff1a${s.reason}`).join("\n");
          deps.showChoiceNotice(label, `\u6240\u6709\u7247\u6bb5\u5747\u672a\u80fd\u5408\u5e76\u3002\n${skipReasons}`);
          return;
        }

        const destFolder = await window.electronAPI?.storage?.selectFolder?.();
        if (!destFolder) return;

        const exportResult = await exportSegmentVideosToFolder(report.compiled, destFolder);

        const subtitleWarnings = report.compiled
          .filter((r) => r.subtitleWarning)
          .map((r) => `闁?${r.segmentLabel}\uff1a${r.subtitleWarning}`)
          .join("\n");
        const warningNote = subtitleWarnings ? `\n闁宠法濯寸粭?\u5b57\u5e55\u8bc6\u522b\u95ee\u9898\uff1a\n${subtitleWarnings}` : "";

        deps.showChoiceNotice(
          label,
          `\u5df2\u5bfc\u51fa ${exportResult.exportedCount} \u4e2a\u7247\u6bb5\u89c6\u9891\u5230\uff1a${destFolder}${exportResult.failedCount > 0 ? `\n\uff08${exportResult.failedCount} \u4e2a\u6587\u4ef6\u590d\u5236\u5931\u8d25\uff09` : ""}${warningNote}`,
          {
            id: `${snapshot.projectId}-ai-auto-export-done`,
            title: "\u5bfc\u51fa\u5b8c\u6210\uff0c\u4e0b\u4e00\u6b65\uff1f",
            answerKey: "video-export-ai-auto-done",
            allowCustomInput: false,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 1,
            totalSteps: 1,
            options: [
              {
                id: `${snapshot.projectId}-ai-auto-done-preview`,
                value: "video:step:preview",
                label: formatVideoStepLabelWithCount(
                  "\u8fd4\u56de\u9884\u89c8\u4e0e\u5bfc\u51fa",
                  "\u9884\u89c8\u4e0e\u5bfc\u51fa",
                  normalizeVideoGenerationMode(project.videoGenerationPrefs?.mode),
                ),
              },
              { id: `${snapshot.projectId}-ai-auto-done-open`, value: "storage:open:" + destFolder, label: "\u6253\u5f00\u5bfc\u51fa\u76ee\u5f55" },
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
      const batchLimit = getHomeAgentVideoGenerationBatchLimit(videoProject?.videoGenerationPrefs);
      const targetIds = deps.listGeneratableVideoScenes(videoProject)
        .filter((scene) => !isTextToVideo || Boolean(scene.enhancedVideoPrompt?.trim()))
        .slice(0, batchLimit)
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
      const segmentLabels = listGeneratableSegmentVideoLabels(videoProject)
        .slice(0, getHomeAgentVideoGenerationBatchLimit(videoProject?.videoGenerationPrefs));
      if (!segmentLabels.length) return true;

      void deps.runWorkflowActionShortcut(
        "generate_segment_video",
        { projectId: snapshot.projectId, targetSegmentLabels: segmentLabels },
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
          deps.showChoicePopover(label, "\u5f53\u524d\u6ca1\u6709\u5931\u8d25\u955c\u5934\uff0c\u5148\u4ece\u53ef\u751f\u6210\u955c\u5934\u91cc\u9009\u4e00\u6761\u3002", nextQuestion);
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
        deps.showChoicePopover(label, "\u9009\u4e00\u6761\u955c\u5934\u5f00\u59cb\u51fa\u7247\u3002", nextQuestion);
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


