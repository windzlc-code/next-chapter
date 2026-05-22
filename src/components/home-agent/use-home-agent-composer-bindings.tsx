import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { MessageInput } from "@/lib/agent/types";
import type {
  AutomationMode,
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
  CreationMode,
  FullAutoRunState,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { HomeAgentTextModelGroup } from "@/lib/home-agent/text-models";
import type { HomeAgentImageModelFamilyOption } from "@/lib/home-agent/image-models";
import type { HomeAgentVideoModelOption } from "@/lib/home-agent/video-models";
import type { HomeAgentImageStyleRecognitionResult } from "@/lib/home-agent/image-style-analysis";
import { CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY } from "@/lib/home-agent/character-audio-preset-library";
import {
  buildImagePrefsPatchFromRecognition,
  isSupportedImageFile,
} from "@/lib/home-agent/image-style-analysis";
import { buildVideoImageStyleSummary } from "@/lib/home-agent/image-models";
import type {
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
} from "@/types/project";
import { cn } from "@/lib/utils";
import {
  HomeComposer,
  type HomeComposerLaunchNotice,
  type HomeComposerProps,
  type HomeComposerVideoTransportHint,
} from "./home-agent-shell";
import { DEV_GLOBAL_ACTIONS } from "./composer-choice-panel";
import type { ComposerWorkflowProgress } from "./ComposerChoiceModal";
import {
  buildConfirmedStructuredAnswer,
  handleHomeAgentChoiceSelection,
  submitHomeAgentComposer,
} from "./home-agent-session-actions";
import {
  buildVideoContinuationQuestion,
  buildVideoWorkflowTaskBoard,
  recQuestion,
} from "./home-agent-project-questions";
import {
  getComposerCustomCaptureDescriptor,
  resolveComposerCustomCaptureChoice,
} from "./composer-custom-capture";
import {
  canRewindOriginalScriptKickoff,
  buildOriginalScriptKickoffIntro,
  buildOriginalScriptKickoffRequest,
  isOriginalScriptKickoffRequest,
  rewindOriginalScriptKickoff,
  rewindOriginalScriptKickoffMessages,
  shouldTreatOriginalScriptKickoffInputAsAnswer,
} from "@/lib/home-agent/original-script-kickoff";
import { canRewindFullAutoStrategyPlan } from "@/lib/home-agent/full-auto-run-plan";
import {
  buildAdaptationWorkflowKickoffIntro,
  buildAdaptationWorkflowKickoffRequest,
} from "@/lib/home-agent/adaptation-workflow-kickoff";
import {
  buildVideoWorkflowKickoffIntro,
  buildVideoWorkflowKickoffRequest,
} from "@/lib/home-agent/video-workflow-kickoff";
import { createQuestionState } from "./home-agent-protocol-utils";
import { TARGET_MARKETS } from "@/types/drama";
import { isQuestionCompatibleWithCurrentRuntime } from "./use-home-agent-question-view";

type ChoiceHandler = (
  snapshot: ConversationProjectSnapshot,
  value: string,
  label: string,
  input?: Record<string, unknown>,
) => boolean;
type AutoResearchChoiceHandler = (
  value: string,
  label: string,
) => boolean | Promise<boolean>;

type WorkflowProgressEventState = {
  id: string;
  status: string;
  content: string;
};

type StyleRecognitionProgressState = {
  progress: number;
  label: string;
};

const WORKFLOW_PROGRESS_TERMINAL_GRACE_MS = 1800;
const CMD_WORKFLOW_ACTIONS = new Set([
  "analyze_script_for_video",
  "prepare_video_prompt_batch",
  "prepare_segment_video_prompt",
]);
const LEGACY_WORKFLOW_PROGRESS_TEXT_REPLACEMENTS: ReadonlyArray<
  readonly [pattern: RegExp, replacement: string]
> = [
  [/鍓ф湰鎷嗚В/g, "剧本拆解"],
  [/鍗曢泦缁嗙翰/g, "单集细纲"],
  [/鍒嗛泦鎾板啓/g, "分集撰写"],
  [/缂栬瘧闀滃ご鎸囦护鍖[?？]?/g, "编译镜头指令包"],
  [/闀滃ご鎻愮ず璇[?？]?/g, "镜头提示词 "],
  [/鐗囨鎻愮ず璇[?？]?/g, "片段提示词 "],
  [/闀滃ご瑙嗛/g, "镜头视频"],
  [/鐢熸垚鐗囨瑙嗛/g, "生成片段视频"],
  [/鍒锋柊鐗囨瑙嗛/g, "刷新片段视频"],
  [/鍒濆鍖[?？]?/g, "初始化"],
  [/姝ｅ湪/g, "正在"],
  [/鐢熸垚/g, "生成"],
  [/鍒锋柊/g, "刷新"],
  [/鐗囨/g, "片段"],
  [/闀滃ご/g, "镜头"],
  [/\s路\s/g, " · "],
];

function isCmdWorkflowAction(
  action: string | null | undefined,
): action is string {
  return Boolean(action && CMD_WORKFLOW_ACTIONS.has(action));
}

function buildCmdProgressBar(marks: string[]): string {
  if (!marks.length) return "[.]";
  if (marks.length <= 48) return `[${marks.join("")}]`;
  return `[${marks.slice(0, 22).join("")}...${marks.slice(-22).join("")}]`;
}

function getCmdProgressMark(
  status: string | undefined,
  hasContent = false,
): string {
  if (hasContent || status === "done") return "#";
  if (status === "processing") return ">";
  if (status === "failed") return "x";
  return ".";
}

function ensureCmdProgressStatusLabel(
  action: string | null,
  headline: string,
): string {
  if (headline.includes("[") && headline.includes("]")) return headline;
  if (action === "analyze_script_for_video") return "剧本拆解 [>] 初始化";
  if (action === "prepare_video_prompt_batch") return "镜头提示词 [>] 初始化";
  if (action === "prepare_segment_video_prompt") return "片段提示词 [>] 初始化";
  return headline;
}

function repairLegacyWorkflowProgressCopy(content: string): string {
  return LEGACY_WORKFLOW_PROGRESS_TEXT_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    content,
  );
}

function findOptionByValue(
  question: ComposerQuestion | null,
  value: string,
): ComposerQuestion["options"][number] | null {
  if (!question) return null;
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    if (option.value === value) return option;
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return null;
}

function buildAdaptationTargetMarketBackQuestion(
  snapshot: ConversationProjectSnapshot | null | undefined,
  currentQuestion: ComposerQuestion | null,
): ComposerQuestion | null {
  if (
    !snapshot ||
    snapshot.projectKind !== "adaptation" ||
    currentQuestion?.answerKey !== "题材选择"
  ) {
    return null;
  }

  const setupPayload = snapshot.artifacts.find(
    (artifact) =>
      artifact.kind === "setup" && artifact.payload?.type === "setup",
  )?.payload;
  const currentMarket =
    setupPayload?.type === "setup" ? setupPayload.targetMarket : undefined;

  return {
    id: `script-adaptation-target-market-${snapshot.projectId}`,
    title: "请选择目标市场",
    description:
      "目标市场会写入结构转换提示词，影响语言、节奏、审美和后续分集生成约束。",
    options: TARGET_MARKETS.map((market) => ({
      id: `${snapshot.projectId}-adaptation-target-market-${market.value}`,
      label:
        currentMarket === market.value
          ? `AI 推荐：${market.label}`
          : market.label,
      value: `script:adaptation-target-market:${market.value}`,
      rationale: market.desc,
      selected: currentMarket === market.value,
    })),
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: Math.max((currentQuestion?.stepIndex ?? 1) - 1, 0),
    totalSteps: currentQuestion?.totalSteps ?? 1,
    answerKey: "script-adaptation-target-market",
  };
}

function rewindAdaptationTargetMarketRuntime(
  runtime: StudioRuntimeState,
): StudioRuntimeState {
  const snapshot = runtime.currentProjectSnapshot;
  if (!snapshot || snapshot.projectKind !== "adaptation") return runtime;

  let touchedSetupArtifact = false;
  const nextArtifacts = snapshot.artifacts.map((artifact) => {
    if (artifact.kind !== "setup" || artifact.payload?.type !== "setup") {
      return artifact;
    }
    touchedSetupArtifact = true;
    return {
      ...artifact,
      payload: {
        ...artifact.payload,
        genres: [],
        adaptationTargetMarketConfirmed: false,
        adaptationGenresConfirmed: false,
      },
    };
  });

  const nextSnapshot = touchedSetupArtifact
    ? { ...snapshot, artifacts: nextArtifacts }
    : snapshot;
  const currentDramaProject =
    runtime.currentDramaProject?.id === snapshot.projectId
      ? {
          ...runtime.currentDramaProject,
          setup: runtime.currentDramaProject.setup
            ? { ...runtime.currentDramaProject.setup, genres: [] }
            : runtime.currentDramaProject.setup,
          adaptationTargetMarketConfirmed: false,
          adaptationGenresConfirmed: false,
          currentStep: "structure-transform" as const,
        }
      : runtime.currentDramaProject;

  return {
    ...runtime,
    currentProjectSnapshot: nextSnapshot,
    currentDramaProject,
    recentProjects: runtime.recentProjects.map((project) =>
      project.projectId === snapshot.projectId ? nextSnapshot : project,
    ),
  };
}

function normalizeChoiceLabel(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[：:，,。.!！?？]/g, "")
    .trim();
}

function findOptionByLabel(
  question: ComposerQuestion | null,
  label: string,
): ComposerQuestion["options"][number] | null {
  if (!question) return null;
  const normalizedLabel = normalizeChoiceLabel(label);
  if (!normalizedLabel) return null;

  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    if (normalizeChoiceLabel(option.label) === normalizedLabel) return option;
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return null;
}

function resolveFreeformQuestionChoice(
  question: ComposerQuestion | null,
  draft: string,
): { value: string; label: string } | null {
  const matched =
    findOptionByValue(question, draft) ?? findOptionByLabel(question, draft);
  if (!matched) return null;
  return {
    value: matched.value,
    label: matched.label,
  };
}

type HomepageKickoffIntent = "script" | "adaptation" | "video";

function normalizeHomepageKickoffText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function resolveHomepageKickoffIntent(
  draft: string,
): HomepageKickoffIntent | null {
  const normalized = normalizeHomepageKickoffText(draft);
  if (!normalized) return null;

  if (
    normalized.includes("原创剧本") ||
    normalized.includes("开启一个原创剧本项目") ||
    (normalized.includes("原创") && normalized.includes("剧本"))
  ) {
    return "script";
  }

  if (
    normalized.includes("参考改编") ||
    normalized.includes("改编方向") ||
    normalized.includes("参考内容")
  ) {
    return "adaptation";
  }

  if (
    normalized.includes("视频工作流") ||
    normalized.includes("视频创作") ||
    (normalized.includes("分镜") && normalized.includes("视频")) ||
    (normalized.includes("剧本") && normalized.includes("视频"))
  ) {
    return "video";
  }

  return null;
}

function isHomepageConversationPlaceholderSnapshot(
  snapshot: ConversationProjectSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  return (
    snapshot.currentObjective === "继续当前对话" &&
    snapshot.derivedStage === "历史对话" &&
    snapshot.recommendedActions.length === 0 &&
    snapshot.artifacts.length === 0
  );
}

function isVideoKickoffStyleQuestion(
  question: ComposerQuestion | null | undefined,
): boolean {
  return question?.answerKey === "video-kickoff-prefs-style";
}

function shouldShowImmediateVideoModeBadge(
  question: ComposerQuestion | null | undefined,
): boolean {
  if (!question?.answerKey.startsWith("video-kickoff-prefs-")) return false;
  return question.answerKey !== "video-kickoff-prefs-mode";
}

function isFullAutoVideoStyleQuestion(
  question: ComposerQuestion | null | undefined,
): boolean {
  return question?.answerKey === "full-auto-preflight:videoStyle";
}

function buildRecognizedVideoStyleChoice(
  recognition: HomeAgentImageStyleRecognitionResult,
): { value: string; label: string } | null {
  const imagePrefs = buildImagePrefsPatchFromRecognition(recognition);
  const styleSummary = buildVideoImageStyleSummary(imagePrefs);
  if (
    imagePrefs.stylePreset === "custom" &&
    imagePrefs.customStylePrompt?.trim()
  ) {
    return {
      value: `video:kickoff:prefs:custom-style:${encodeURIComponent(imagePrefs.customStylePrompt.trim())}`,
      label: styleSummary,
    };
  }
  if (!imagePrefs.stylePreset) return null;
  return {
    value: `video:kickoff:prefs:style-preset:${imagePrefs.stylePreset}`,
    label: styleSummary,
  };
}

function resolveVideoKickoffStyleCaptureChoice(params: {
  question: ComposerQuestion | null;
  draft: string;
  attachedFiles?: File[];
}): { value: string; label: string } | null {
  const { question, draft, attachedFiles } = params;
  if (!isVideoKickoffStyleQuestion(question)) return null;

  const normalizedDraft = draft.trim();
  if (normalizedDraft) {
    return {
      value: `video:kickoff:prefs:custom-style:${encodeURIComponent(normalizedDraft)}`,
      label: normalizedDraft,
    };
  }

  const imageFiles = (attachedFiles ?? []).filter((file) =>
    isSupportedImageFile(file),
  );
  if (!imageFiles.length) return null;

  return {
    value: "video:kickoff:prefs:style-reference",
    label: "识别已上传参考图",
  };
}

function resolveFreeformVideoChoice(
  snapshot: ConversationProjectSnapshot | null,
  runtime: StudioRuntimeState,
  draft: string,
  question: ComposerQuestion | null,
  lastSuggested: ComposerQuestion | null,
): { value: string; label: string } | null {
  if (!snapshot || snapshot.projectKind !== "video") return null;
  const normalizedDraft = normalizeChoiceLabel(draft);
  if (!normalizedDraft) return null;

  const aliasMap: Record<string, { value: string; label: string }> = {
    [normalizeChoiceLabel("补充平台和镜头偏好")]: {
      value: "video:bridge:platform",
      label: "补充平台和镜头偏好",
    },
    [normalizeChoiceLabel("补平台和镜头偏好")]: {
      value: "video:bridge:platform",
      label: "补充平台和镜头偏好",
    },
    [normalizeChoiceLabel("补平台与镜头偏好")]: {
      value: "video:bridge:platform",
      label: "补平台与镜头偏好",
    },
    [normalizeChoiceLabel("补充平台与镜头偏好")]: {
      value: "video:bridge:platform",
      label: "补充平台与镜头偏好",
    },
    [normalizeChoiceLabel("补充镜头风格偏好")]: {
      value: "video:bridge:platform",
      label: "补充平台和镜头偏好",
    },
  };
  const aliasMatch = aliasMap[normalizedDraft];
  if (aliasMatch) return aliasMatch;

  const candidateQuestions = [
    question,
    lastSuggested,
    recQuestion(snapshot, runtime.currentVideoProject),
    buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject),
  ];

  for (const candidate of candidateQuestions) {
    const matched = findOptionByLabel(candidate ?? null, draft);
    if (matched) {
      return {
        value: matched.value,
        label: matched.label,
      };
    }
  }

  return null;
}

function normalizeWorkflowAdvanceIntentText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isInternalChoicePayloadText(value: string): boolean {
  return /^(?:video|script|maintenance|auto-research|review):[a-z0-9_-]+(?::|$)/i.test(
    value,
  );
}

function isNaturalLanguageWorkflowAdvanceRequest(value: string): boolean {
  const normalized = normalizeWorkflowAdvanceIntentText(value);
  if (!normalized || isInternalChoicePayloadText(normalized)) return false;
  if (
    /^(?:继续|下一步|下1步|恢复|接着来|接着继续|继续当前步骤|继续当前流程|恢复当前步骤|恢复当前流程|恢复刚才那一步|恢复刚才那个选项|重新打开上一步|重新打开刚才的选项|重新打开当前选项|继续刚才中断的步骤)$/.test(
      normalized,
    )
  ) {
    return true;
  }

  return (
    /(?:进入|继续|推进|切到|切换到|打开|调出|唤起|来到)?下一(?:步|阶段|环节|页|个阶段)/.test(
      normalized,
    ) ||
    /(?:继续|推进).*(?:工作流|流程|步骤)/.test(normalized) ||
    /(?:nextstep|nextstage|continuetoworkflow|proceedtonext|whatnext)/.test(
      normalized,
    )
  );
}

function listPrimaryQuestionOptions(
  question: ComposerQuestion | null,
): ComposerQuestionOption[] {
  return question?.options.filter((option) => !option.devOnly) ?? [];
}

function findWorkflowAdvanceOption(
  question: ComposerQuestion | null,
): ComposerQuestionOption | null {
  const primaryOptions = listPrimaryQuestionOptions(question);
  if (!primaryOptions.length) return null;

  const explicitAdvanceOption = primaryOptions.find(
    (option) =>
      option.value === "video:advance" ||
      option.value === "video:advance-round",
  );
  if (explicitAdvanceOption) return explicitAdvanceOption;

  if (primaryOptions.length === 1) return primaryOptions[0] ?? null;

  const title = question?.title?.trim() ?? "";
  if (
    question?.answerKey === "recovery" ||
    /^下一步[:：]/.test(title) ||
    title.includes("选择下一步")
  ) {
    return primaryOptions[0] ?? null;
  }

  return null;
}

function isWorkflowSkipAheadRequest(value: string): boolean {
  const normalized = normalizeWorkflowAdvanceIntentText(value);
  if (!normalized || isInternalChoicePayloadText(normalized)) return false;

  return (
    /(?:跳过|跳步|跨阶段|越过|略过|绕过)/.test(normalized) ||
    /(?:直接|先不|不用).*(?:去|到|进|进入|开始|做|生成|出片|导出|后面|下一阶段|下个阶段)/.test(
      normalized,
    ) ||
    /(?:不要|别).*(?:当前|这一步|这个阶段).*(?:直接|去|到|进|进入)/.test(
      normalized,
    )
  );
}

function buildWorkflowAdvanceReply(
  snapshot: ConversationProjectSnapshot,
  nextQuestion: ComposerQuestion | null,
): string {
  const stage = snapshot.derivedStage?.trim() || "当前阶段";
  const title = nextQuestion?.title?.trim();
  return title
    ? `当前在「${stage}」。我先不直接替你执行，先把对应的预置面板打开，你按这个阶段完成选择后我再继续。\n\n可继续项：${title}`
    : `当前在「${stage}」。我先把这个阶段对应的预置面板打开，你选好后我再继续往下推进。`;
}

function buildWorkflowSkipAheadReply(
  snapshot: ConversationProjectSnapshot,
  nextQuestion: ComposerQuestion | null,
): string {
  const stage = snapshot.derivedStage?.trim() || "当前阶段";
  const title = nextQuestion?.title?.trim();
  return title
    ? `当前在「${stage}」，现在不能跳步到后面的阶段。请先完成这一阶段，再继续下一步。\n\n我先把你当前该做的面板打开：${title}`
    : `当前在「${stage}」，现在不能跳步到后面的阶段。请先完成这一阶段，再继续下一步。`;
}

function buildWorkflowAssistantReplyPrompt(params: {
  snapshot: ConversationProjectSnapshot;
  nextQuestion: ComposerQuestion;
  kind: "advance" | "skip-ahead";
}): string {
  const { snapshot, nextQuestion, kind } = params;
  const stage = snapshot.derivedStage?.trim() || "当前阶段";
  const title = nextQuestion.title?.trim() || "当前步骤";

  return [
    "你正在首页工作流里回复用户，先回复一句话，系统会在你的回复后自动打开当前步骤的预置选择面板。",
    `当前项目《${snapshot.title}》正处于「${stage}」阶段。`,
    `本轮准备打开的预置面板标题是「${title}」。`,
    kind === "skip-ahead"
      ? "用户想跳步去后面的阶段。请明确说明现在不能跳步，必须先完成当前阶段，再继续下一步。"
      : "用户想继续下一步。请说明你会先引导用户完成当前阶段的选择，再继续推进。",
    "只用 1 到 2 句自然中文回复。",
    "不要代替用户执行。",
    "不要输出列表、JSON、AskUserQuestion、Markdown 选项块或伪弹窗。",
  ].join("\n");
}

function listQuestionResumeOptionLabels(
  question: ComposerQuestion | null,
  limit = 4,
): string[] {
  return listPrimaryQuestionOptions(question)
    .map((option) => option.label.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function buildStructuredQuestionResumeReply(
  question: ComposerQuestion,
): string {
  const title =
    question.title?.trim() || question.answerKey?.trim() || "当前步骤";
  const optionLabels = listQuestionResumeOptionLabels(question);
  const optionLine = optionLabels.length
    ? `你可以直接选择：${optionLabels.join(" / ")}。`
    : "你可以继续完成这一步的选择。";
  const customLine = question.allowCustomInput
    ? "如果这些都不完全合适，也可以直接补充你的偏好。"
    : "";

  return [`当前先继续「${title}」这一步。`, optionLine, customLine]
    .filter(Boolean)
    .join("\n\n");
}

function resolveWorkflowResumeQuestion(params: {
  currentQuestion: ComposerQuestion | null;
  interruptedQuestion: ComposerQuestion | null;
  lastSuggestedQuestion: ComposerQuestion | null;
  snapshot: ConversationProjectSnapshot | null;
  runtime: StudioRuntimeState;
}): ComposerQuestion | null {
  const {
    currentQuestion,
    interruptedQuestion,
    lastSuggestedQuestion,
    snapshot,
    runtime,
  } = params;
  const candidates = [
    currentQuestion,
    interruptedQuestion,
    lastSuggestedQuestion,
    snapshot ? recQuestion(snapshot, runtime.currentVideoProject) : null,
  ];

  for (const candidate of candidates) {
    if (isQuestionCompatibleWithCurrentRuntime(candidate, runtime)) {
      return candidate;
    }
  }

  return null;
}

function isDevSelection(
  question: ComposerQuestion | null,
  value: string,
): boolean {
  if (DEV_GLOBAL_ACTIONS.some((action) => action.value === value)) return true;
  return Boolean(findOptionByValue(question, value)?.devOnly);
}

function isComplianceChoiceValue(value: string): boolean {
  return (
    value.startsWith("script:compliance-") ||
    value === "script:skip-compliance-review"
  );
}

function shouldPreserveHandledQuestion(
  question: ComposerQuestion | null,
  value: string,
): boolean {
  if (!question) return false;
  return (
    (question.answerKey === "script-episode" &&
      value.startsWith("script:episode-duration:")) ||
    (question.answerKey.startsWith("script-compliance") &&
      isComplianceChoiceValue(value)) ||
    value === "script:step-enter-episodes" ||
    question.answerKey === "video-bridge-prefix" ||
    question.answerKey.startsWith("video-kickoff-prefs-") ||
    question.answerKey === "video-analyze-duration" ||
    question.answerKey === "video-analyze-pace" ||
    question.answerKey === "video-analyze-resume" ||
    (question.answerKey === "video-bridge-panel" &&
      value === "video:bridge:platform") ||
    (question.answerKey === "video-bridge-panel" &&
      value === "video:bridge:next-step") ||
    (question.answerKey === "video-bridge-panel" &&
      value === "video:bridge:analyze") ||
    (question.answerKey === "video-bridge-panel" &&
      value.startsWith("video:bridge:reference-audio:character:")) ||
    (question.answerKey === "video-bridge-panel" &&
      value.startsWith("video:bridge:reference-audio:preset-picker:character:")) ||
    (question.answerKey === CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY &&
      value.startsWith("video:bridge:reference-audio:preset-bind:character:")) ||
    (question.answerKey === "review-stage-panel" &&
      value === "video:export:all") ||
    (question.answerKey === "review-stage-panel" &&
      value === "video:export:ai-auto") ||
    question.answerKey === "script-adaptation-target-market" ||
    value.startsWith("video:step:")
  );
}

function parsePendingEpisodeDurationSelection(
  selectedValues: string[],
): number | undefined {
  const value = [...selectedValues]
    .reverse()
    .find((item) => item.startsWith("script:episode-duration:"));
  if (!value) return undefined;
  const rawDuration = value.replace(
    /^script:episode-duration:(?:custom:)?/,
    "",
  );
  const durationSeconds = Number(rawDuration);
  return Number.isFinite(durationSeconds)
    ? Math.max(1, Math.round(durationSeconds))
    : undefined;
}

function isEpisodeWritingChoice(value: string): boolean {
  return (
    value.startsWith("script:episode-generate:") ||
    value.startsWith("script:episode-generate-range:") ||
    value === "script:episode-generate-batch" ||
    value === "script:episode-fill-missing"
  );
}

function markSelectedQuestionOptions(
  question: ComposerQuestion | null,
  selectedValues: string[],
): ComposerQuestion | null {
  if (!question || selectedValues.length === 0) return question;
  const selectedSet = new Set(selectedValues);
  const markOption = (
    option: ComposerQuestionOption,
  ): ComposerQuestionOption => {
    const children = option.children?.map(markOption);
    return {
      ...option,
      selected: selectedSet.has(option.value) || option.selected,
      ...(children ? { children } : {}),
    };
  };
  return {
    ...question,
    options: question.options.map(markOption),
  };
}

function buildCreativeDevPrompt(params: {
  snapshot: ConversationProjectSnapshot | null;
  value: string;
  label: string;
}): string {
  const { snapshot, value, label } = params;
  const projectLine = snapshot
    ? `当前项目：${snapshot.title} / ${snapshot.projectKind} / ${snapshot.derivedStage}`
    : "当前没有绑定项目。";

  return [
    "这是一次 DEV 快捷入口点击，请把它当成用户输入的快捷文本，而不是预置代码执行。",
    "当前处于创意模式，禁止直接触发任何 workflow shortcut、chain、runtime 改写或预置代码。",
    projectLine,
    `快捷入口标签：${label}`,
    `快捷入口值：${value}`,
    "请先结合当前项目状态理解用户意图，再通过自然语言和 AskUserQuestion 继续推进正确的下一步。",
  ].join("\n");
}

export function useHomeAgentComposerBindings(params: {
  idle: boolean;
  currentProject: ConversationProjectSnapshot | null;
  maintenanceHint?: string | null;
  videoTransportHint?: HomeComposerVideoTransportHint | null;
  launchNotice?: HomeComposerLaunchNotice | null;
  suppressFloatingTaskBoard?: boolean;
  draftInitialValue: string;
  draftResetVersion: number;
  draftPresence: boolean;
  syncComposerDraft: (value: string) => void;
  placeholder: string;
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  question: ComposerQuestion | null;
  qState: StudioQuestionState | null;
  selectedValues: string[];
  streaming: boolean;
  fullAutoRun?: FullAutoRunState | null;
  isMediaGenerating?: boolean;
  isAwaitingWorkflowDocumentUpload?: boolean;
  reduceMotion: boolean;
  composerShellClass: string;
  activeTheme: boolean;
  activeWorkflowAction: string | null;
  selectedTextModelKey: string;
  selectedTextModelLabel: string;
  textModelGroups: HomeAgentTextModelGroup[];
  onSelectTextModel: (key: string) => void;
  selectedImageModelKey: string;
  selectedImageModelLabel: string;
  imageModelOptions: HomeAgentImageModelFamilyOption[];
  imageGenerationPrefs: VideoImageGenerationPrefs;
  onSelectImageModel: (key: string) => void;
  onConfirmImageSettings: (prefs: VideoImageGenerationPrefs) => void;
  onRecognizeImageStyle?: () => Promise<HomeAgentImageStyleRecognitionResult | null>;
  selectedVideoModelKey: string;
  selectedVideoModelLabel: string;
  videoModelOptions: HomeAgentVideoModelOption[];
  videoGenerationPrefs: VideoGenerationPrefs;
  onSelectVideoModel: (key: string) => void;
  onConfirmVideoResolution: (prefs: VideoGenerationPrefs) => void;
  onDevVideoGenerationModeChange?: (mode: VideoGenerationPrefs["mode"]) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
  creationMode: CreationMode;
  onCreationModeChange: (mode: CreationMode) => void;
  devMode: boolean;
  onDevModeChange: (enabled: boolean) => void;
  automationMode?: AutomationMode;
  draftRef: React.MutableRefObject<string>;
  engineRef: React.MutableRefObject<{ interrupt: () => void } | null>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  answer: (value: string, label?: string) => void;
  send: (
    value: MessageInput,
    shown?: string,
    opts?: {
      skipUserBubble?: boolean;
      attachments?: ChatAttachment[];
      disableAutoResearch?: boolean;
    },
  ) => Promise<void>;
  setDeferredQuestionState: React.Dispatch<
    React.SetStateAction<StudioQuestionState | null>
  >;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  setRuntime?: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setQState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setPopoverOverride: React.Dispatch<
    React.SetStateAction<ComposerQuestion | null>
  >;
  dismissCurrentChoiceQuestion: (question: ComposerQuestion | null) => void;
  deferDismissedQuestion?: (
    questionState: StudioQuestionState,
    selectedValues: string[],
    draft: string,
  ) => void;
  resetComposerDraft: (value?: string) => void;
  videoProjectChoiceHandler: ChoiceHandler;
  videoAssetChoiceHandler: ChoiceHandler;
  scriptProjectChoiceHandler: ChoiceHandler;
  autoResearchChoiceHandler: AutoResearchChoiceHandler;
  onBeforeChoiceSelect?: (
    value: string,
    label: string,
    question: ComposerQuestion | null,
  ) => boolean;
  canHandleQuestionBack?: (question: ComposerQuestion | null) => boolean;
  onBeforeQuestionBack?: (question: ComposerQuestion | null) => boolean;
  handleFullAutoChoiceSelect?: (
    value: string,
    label: string,
    question: ComposerQuestion | null,
  ) => boolean;
  handleFullAutoQuestionBack?: () => boolean;
  handleFullAutoQuestionReset?: () => boolean;
  onLaunchAction?: (actionId: string) => void;
  onStopFullAuto?: () => void;
  activeTrackClassName: string;
  idleTrackClassName: string;
  lastSuggestedRef: React.MutableRefObject<ComposerQuestion | null>;
  interruptWorkflowShortcut: () => void;
  onGlobalInterrupt: () => void;
  clearInterruptRestoreQuestion: () => void;
  rememberInterruptRestoreQuestion: (question: ComposerQuestion | null) => void;
  getInterruptedChoiceQuestion?: () => ComposerQuestion | null;
  attachedFiles?: File[];
  onAttachedFilesChange?: (files: File[]) => void;
  setMode: React.Dispatch<
    React.SetStateAction<
      "idle" | "active" | "recovering" | "maintenance-review"
    >
  >;
  queueWorkflowPopoverAfterAssistantReply?: (
    question: ComposerQuestion | null,
  ) => void;
}) {
  const {
    idle,
    currentProject,
    maintenanceHint,
    videoTransportHint,
    launchNotice,
    suppressFloatingTaskBoard = false,
    draftInitialValue,
    draftResetVersion,
    draftPresence,
    syncComposerDraft,
    placeholder,
    runtimeRef,
    question,
    qState,
    selectedValues,
    streaming,
    fullAutoRun = null,
    isMediaGenerating = false,
    isAwaitingWorkflowDocumentUpload = false,
    reduceMotion,
    composerShellClass,
    activeTheme,
    activeWorkflowAction,
    selectedTextModelKey,
    selectedTextModelLabel,
    textModelGroups,
    onSelectTextModel,
    selectedImageModelKey,
    selectedImageModelLabel,
    imageModelOptions,
    imageGenerationPrefs,
    onSelectImageModel,
    onConfirmImageSettings,
    onRecognizeImageStyle,
    selectedVideoModelKey,
    selectedVideoModelLabel,
    videoModelOptions,
    videoGenerationPrefs,
    onSelectVideoModel,
    onConfirmVideoResolution,
    onDevVideoGenerationModeChange,
    onDevImageViewModeChange,
    creationMode,
    onCreationModeChange,
    devMode,
    onDevModeChange,
    automationMode = "manual",
    draftRef,
    engineRef,
    setStreaming,
    answer,
    send,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setDeferredDraft,
    setRuntime,
    setSelectedValues,
    setQState,
    setMessages,
    setSuggested,
    setPopoverOverride,
    dismissCurrentChoiceQuestion,
    deferDismissedQuestion,
    resetComposerDraft,
    videoProjectChoiceHandler,
    videoAssetChoiceHandler,
    scriptProjectChoiceHandler,
    autoResearchChoiceHandler,
    onBeforeChoiceSelect,
    canHandleQuestionBack,
    onBeforeQuestionBack,
    handleFullAutoChoiceSelect,
    handleFullAutoQuestionBack,
    handleFullAutoQuestionReset,
    onLaunchAction,
    onStopFullAuto,
    activeTrackClassName,
    idleTrackClassName,
    lastSuggestedRef,
    interruptWorkflowShortcut,
    onGlobalInterrupt,
    clearInterruptRestoreQuestion,
    rememberInterruptRestoreQuestion,
    getInterruptedChoiceQuestion,
    attachedFiles,
    onAttachedFilesChange,
    setMode,
    queueWorkflowPopoverAfterAssistantReply,
  } = params;

  const [workflowEventProgress, setWorkflowEventProgress] =
    useState<WorkflowProgressEventState | null>(null);
  const [retainedWorkflowProgressAction, setRetainedWorkflowProgressAction] =
    useState<string | null>(null);
  const [styleRecognitionProgress, setStyleRecognitionProgress] =
    useState<StyleRecognitionProgressState | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowProgressEventState>).detail;
      if (!detail?.id) return;
      const normalizedContent = repairLegacyWorkflowProgressCopy(
        typeof detail.content === "string" ? detail.content : "",
      );
      if (
        detail.status === "start" ||
        detail.status === "progress" ||
        detail.status === "update"
      ) {
        setWorkflowEventProgress({
          ...detail,
          content: normalizedContent,
        });
        return;
      }
      if (detail.status === "complete") {
        setWorkflowEventProgress((current) =>
          current?.id === detail.id
            ? {
                ...current,
                status: detail.status,
                content: current.content || normalizedContent,
              }
            : current,
        );
        return;
      }
      if (detail.status === "error") {
        setWorkflowEventProgress((current) =>
          current?.id === detail.id
            ? {
                ...current,
                status: detail.status,
                content: normalizedContent || current.content,
              }
            : current,
        );
      }
    };
    window.addEventListener("agent:workflow-progress", handler);
    return () => window.removeEventListener("agent:workflow-progress", handler);
  }, []);

  useEffect(() => {
    if (isCmdWorkflowAction(activeWorkflowAction)) {
      setRetainedWorkflowProgressAction(activeWorkflowAction);
      return;
    }

    const isTerminalWorkflowProgress =
      workflowEventProgress?.status === "complete" ||
      workflowEventProgress?.status === "error";
    if (
      !activeWorkflowAction &&
      retainedWorkflowProgressAction &&
      workflowEventProgress &&
      isTerminalWorkflowProgress
    ) {
      const progressId = workflowEventProgress.id;
      const retainedAction = retainedWorkflowProgressAction;
      const timer = window.setTimeout(() => {
        setWorkflowEventProgress((current) =>
          current?.id === progressId ? null : current,
        );
        setRetainedWorkflowProgressAction((current) =>
          current === retainedAction ? null : current,
        );
      }, WORKFLOW_PROGRESS_TERMINAL_GRACE_MS);
      return () => window.clearTimeout(timer);
    }

    if (!activeWorkflowAction) {
      setWorkflowEventProgress(null);
      setRetainedWorkflowProgressAction(null);
    }
  }, [
    activeWorkflowAction,
    retainedWorkflowProgressAction,
    workflowEventProgress,
  ]);

  const effectiveWorkflowProgressAction =
    activeWorkflowAction ?? retainedWorkflowProgressAction;

  useEffect(() => {
    if (!styleRecognitionProgress) return;
    const timer = window.setInterval(() => {
      setStyleRecognitionProgress((current) => {
        if (!current || current.progress >= 92) return current;
        const increment =
          current.progress < 28 ? 12 : current.progress < 64 ? 7 : 3;
        return {
          ...current,
          progress: Math.min(92, current.progress + increment),
        };
      });
    }, 220);
    return () => window.clearInterval(timer);
  }, [Boolean(styleRecognitionProgress)]);

  const handleChoiceSelect = useCallback(
    (value: string, label: string) => {
      if (onBeforeChoiceSelect?.(value, label, question)) {
        return;
      }
      if (question && !value.startsWith("video:step:")) {
        rememberInterruptRestoreQuestion(question);
      }
      if (handleFullAutoChoiceSelect?.(value, label, question)) {
        return;
      }
      if (
        devMode &&
        creationMode === "creative" &&
        isDevSelection(question, value)
      ) {
        const shouldDismissCurrentQuestion =
          !qState &&
          !!question &&
          !question.multiSelect &&
          (question.submissionMode !== "confirm" ||
            question.options.length === 1);

        void send(
          buildCreativeDevPrompt({
            snapshot: runtimeRef.current.currentProjectSnapshot,
            value,
            label,
          }),
          label,
        );
        if (shouldDismissCurrentQuestion && !activeWorkflowAction) {
          dismissCurrentChoiceQuestion(question);
        }
        return;
      }

      const shouldDismissCurrentQuestion =
        !qState &&
        !!question &&
        !question.multiSelect &&
        (question.submissionMode !== "confirm" ||
          question.options.length === 1);

      const snapshot = runtimeRef.current.currentProjectSnapshot;
      if (
        question?.answerKey === "script-episode" &&
        snapshot &&
        (snapshot.projectKind === "script" ||
          snapshot.projectKind === "adaptation") &&
        isEpisodeWritingChoice(value)
      ) {
        const durationSeconds =
          parsePendingEpisodeDurationSelection(selectedValues);
        if (
          scriptProjectChoiceHandler(
            snapshot,
            value,
            label,
            durationSeconds ? { durationSeconds } : undefined,
          )
        ) {
          if (
            shouldDismissCurrentQuestion &&
            !activeWorkflowAction &&
            !shouldPreserveHandledQuestion(question, value)
          ) {
            dismissCurrentChoiceQuestion(question);
          }
          return;
        }
      }

      const handled = handleHomeAgentChoiceSelection({
        snapshot,
        value,
        label,
        question,
        qState,
        answer,
        setSelectedValues,
        videoProjectChoiceHandler,
        videoAssetChoiceHandler,
        scriptProjectChoiceHandler,
        autoResearchChoiceHandler,
      });
      if (
        handled &&
        shouldDismissCurrentQuestion &&
        !activeWorkflowAction &&
        !shouldPreserveHandledQuestion(question, value)
      ) {
        dismissCurrentChoiceQuestion(question);
      }
    },
    [
      answer,
      dismissCurrentChoiceQuestion,
      qState,
      question,
      runtimeRef,
      creationMode,
      devMode,
      scriptProjectChoiceHandler,
      setSelectedValues,
      selectedValues,
      videoAssetChoiceHandler,
      videoProjectChoiceHandler,
      autoResearchChoiceHandler,
      onBeforeChoiceSelect,
      openHomepageWorkflowKickoff,
      handleFullAutoChoiceSelect,
      activeWorkflowAction,
      rememberInterruptRestoreQuestion,
      send,
    ],
  );

  const confirmStructuredAnswer = useCallback(() => {
    // When qState is null (e.g. recovery question), directly answer with the selected value
    if (!qState) {
      const pickedValues = question?.multiSelect
        ? selectedValues
        : selectedValues.slice(0, 1);
      if (pickedValues.length) {
        rememberInterruptRestoreQuestion(question);
        const labels = pickedValues.map(
          (value) =>
            question?.options.find((o) => o.value === value)?.label || value,
        );
        const submittedValue = pickedValues.join(" / ");
        const displayValue = labels.join(" / ");
        const snapshot = runtimeRef.current.currentProjectSnapshot;
        if (
          question?.answerKey === "题材选择" &&
          (snapshot?.projectKind === "script" ||
            snapshot?.projectKind === "adaptation") &&
          scriptProjectChoiceHandler(snapshot, submittedValue, displayValue)
        ) {
          setSelectedValues([]);
          return;
        }
        answer(submittedValue, displayValue);
        if (question?.answerKey === "recovery") setSuggested(null);
      }
      return;
    }
    const nextAnswer = buildConfirmedStructuredAnswer({
      qState,
      question,
      selectedValues,
      draft: draftRef.current,
    });
    if (!nextAnswer) return;
    rememberInterruptRestoreQuestion(question);
    answer(
      nextAnswer.submittedValue,
      nextAnswer.displayValue || nextAnswer.submittedValue,
    );
  }, [
    answer,
    draftRef,
    qState,
    question,
    rememberInterruptRestoreQuestion,
    runtimeRef,
    scriptProjectChoiceHandler,
    selectedValues,
    setSelectedValues,
    setSuggested,
  ]);

  const handleOriginalScriptBack = useCallback(() => {
    if (!qState || !isOriginalScriptKickoffRequest(qState.request)) return;
    const prevQState = rewindOriginalScriptKickoff(qState);
    if (!prevQState) return;
    setMessages((prev) => rewindOriginalScriptKickoffMessages(prev));
    setQState(prevQState);
    setSelectedValues([]);
    resetComposerDraft("");
  }, [qState, resetComposerDraft, setMessages, setQState, setSelectedValues]);

  const handleQuestionBack = useCallback(() => {
    if (onBeforeQuestionBack?.(question)) {
      return;
    }

    if (
      fullAutoRun?.status === "collecting" &&
      handleFullAutoQuestionBack?.()
    ) {
      return;
    }

    const targetMarketQuestion = buildAdaptationTargetMarketBackQuestion(
      currentProject,
      question,
    );
    if (targetMarketQuestion) {
      setRuntime?.((prev) => rewindAdaptationTargetMarketRuntime(prev));
      setMessages((prev) => rewindOriginalScriptKickoffMessages(prev));
      setSelectedValues([]);
      resetComposerDraft("");
      setSuggested(null);
      setPopoverOverride(targetMarketQuestion);
      return;
    }

    handleOriginalScriptBack();
  }, [
    currentProject,
    fullAutoRun,
    handleFullAutoQuestionBack,
    handleOriginalScriptBack,
    onBeforeQuestionBack,
    question,
    resetComposerDraft,
    setMessages,
    setPopoverOverride,
    setRuntime,
    setSelectedValues,
    setSuggested,
  ]);

  const handleQuestionReset = useCallback(() => {
    if (
      fullAutoRun?.status === "collecting" &&
      handleFullAutoQuestionReset?.()
    ) {
      return;
    }
  }, [fullAutoRun, handleFullAutoQuestionReset]);

  const appendStructuredQuestionReminder = useCallback(
    (
      activeQuestion: ComposerQuestion,
      draft: string,
      replyOverride?: string,
    ) => {
      const createdAt = new Date().toISOString();
      setMode("active");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: draft,
          createdAt,
          status: "complete",
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content:
            replyOverride?.trim() ||
            buildStructuredQuestionResumeReply(activeQuestion),
          createdAt,
          status: "complete",
        },
      ]);
      resetComposerDraft("");
    },
    [resetComposerDraft, setMessages, setMode],
  );

  function openHomepageWorkflowKickoff(
    intent: HomepageKickoffIntent,
    userContent: string,
  ) {
    const createdAt = new Date().toISOString();
    const assistantContent =
      intent === "script"
        ? automationMode === "full-auto"
          ? "已切换为全自动原创剧本。请先一次性确认立项参数；确认完毕后我会代替用户连续发送指令并自动执行到视频导出。"
          : buildOriginalScriptKickoffIntro()
        : intent === "adaptation"
          ? buildAdaptationWorkflowKickoffIntro()
          : buildVideoWorkflowKickoffIntro();
    const nextQuestionState =
      intent === "script"
        ? createQuestionState(buildOriginalScriptKickoffRequest(), "restored")
        : intent === "adaptation"
          ? createQuestionState(
              buildAdaptationWorkflowKickoffRequest(),
              "restored",
            )
          : createQuestionState(
              buildVideoWorkflowKickoffRequest(false),
              "restored",
            );

    setMode("active");
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: userContent,
        createdAt,
        status: "complete",
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantContent,
        createdAt,
        status: "complete",
      },
    ]);
    setPopoverOverride(null);
    setSuggested(null);
    setSelectedValues([]);
    setQState(nextQuestionState);
    resetComposerDraft("");
  }

  const submitComposer = useCallback(() => {
    if (!question) {
      clearInterruptRestoreQuestion();
    }

    const rawComposerDraft = draftRef.current;
    const freeformDraft = rawComposerDraft.trim();
    const snapshot = runtimeRef.current.currentProjectSnapshot;
    const shouldTreatCurrentSnapshotAsProjectlessForHomepageKickoff =
      isHomepageConversationPlaceholderSnapshot(snapshot);
    const homepageKickoffIntent =
      !qState &&
      !question &&
      !attachedFiles?.length &&
      (!snapshot || shouldTreatCurrentSnapshotAsProjectlessForHomepageKickoff)
        ? resolveHomepageKickoffIntent(freeformDraft)
        : null;
    if (homepageKickoffIntent) {
      openHomepageWorkflowKickoff(homepageKickoffIntent, freeformDraft);
      return;
    }
    const shouldResumeStructuredQuestion =
      !!qState &&
      !!question &&
      !attachedFiles?.length &&
      isNaturalLanguageWorkflowAdvanceRequest(freeformDraft);
    if (shouldResumeStructuredQuestion && question) {
      appendStructuredQuestionReminder(question, freeformDraft);
      return;
    }
    const freeformQuestionChoice =
      question && freeformDraft && !attachedFiles?.length
        ? resolveFreeformQuestionChoice(question, freeformDraft)
        : null;
    if (freeformQuestionChoice) {
      if (qState) {
        answer(freeformQuestionChoice.value, freeformQuestionChoice.label);
      } else {
        handleChoiceSelect(
          freeformQuestionChoice.value,
          freeformQuestionChoice.label,
        );
      }
      return;
    }
    const composerCustomCaptureDescriptor = question
      ? getComposerCustomCaptureDescriptor(question)
      : null;
    const composerCustomCaptureChoice = question
      ? resolveComposerCustomCaptureChoice({
          question,
          draft: freeformDraft,
          attachedFiles,
        })
      : null;
    const videoKickoffStyleCaptureChoice = question
      ? resolveVideoKickoffStyleCaptureChoice({
          question,
          draft: freeformDraft,
          attachedFiles,
        })
      : null;
    const handledCustomCaptureChoice =
      composerCustomCaptureChoice ?? videoKickoffStyleCaptureChoice;
    const shouldHandleFullAutoStyleReferenceCapture =
      question != null &&
      isFullAutoVideoStyleQuestion(question) &&
      handledCustomCaptureChoice?.value ===
        "video:kickoff:prefs:style-reference";
    if (shouldHandleFullAutoStyleReferenceCapture && question) {
      if (!onRecognizeImageStyle) {
        appendStructuredQuestionReminder(
          question,
          freeformDraft || "[attachment]",
          "当前暂时无法识别参考图风格，请改用自定义风格说明。",
        );
        return;
      }

      setStyleRecognitionProgress({
        progress: 14,
        label: "正在识别参考图风格",
      });
      void Promise.resolve(onRecognizeImageStyle())
        .then((recognition) => {
          setStyleRecognitionProgress((current) =>
            current
              ? {
                  ...current,
                  progress: 100,
                  label: "参考图风格识别完成",
                }
              : current,
          );
          if (!recognition) {
            appendStructuredQuestionReminder(
              question,
              freeformDraft || "[attachment]",
              "参考图暂时没有识别出稳定风格，请重新上传参考图，或改用自定义风格说明。",
            );
            return;
          }

          const nextChoice = buildRecognizedVideoStyleChoice(recognition);
          if (!nextChoice) {
            appendStructuredQuestionReminder(
              question,
              freeformDraft || "[attachment]",
              "参考图风格暂时无法写入预采集，请改用自定义风格说明。",
            );
            return;
          }

          onAttachedFilesChange?.([]);
          handleChoiceSelect(nextChoice.value, nextChoice.label);
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : "参考图风格识别失败。";
          appendStructuredQuestionReminder(
            question,
            freeformDraft || "[attachment]",
            `${message}请重新上传参考图，或改用自定义风格说明。`,
          );
        })
        .finally(() => {
          setStyleRecognitionProgress(null);
        });
      return;
    }
    if (handledCustomCaptureChoice) {
      handleChoiceSelect(
        handledCustomCaptureChoice.value,
        handledCustomCaptureChoice.label,
      );
      return;
    }
    if (
      question &&
      composerCustomCaptureDescriptor &&
      (Boolean(freeformDraft) || Boolean(attachedFiles?.length))
    ) {
      appendStructuredQuestionReminder(
        question,
        freeformDraft || "[attachment]",
        composerCustomCaptureDescriptor.reminder,
      );
      return;
    }
    const interruptedQuestion = getInterruptedChoiceQuestion?.() ?? null;
    const inferredWorkflowQuestion = resolveWorkflowResumeQuestion({
      currentQuestion: question,
      interruptedQuestion,
      lastSuggestedQuestion: lastSuggestedRef.current,
      snapshot,
      runtime: runtimeRef.current,
    });
    const shouldBlockSkipAhead =
      !qState &&
      !attachedFiles?.length &&
      Boolean(snapshot) &&
      isWorkflowSkipAheadRequest(freeformDraft);
    const shouldOpenWorkflowPanel =
      !qState &&
      !attachedFiles?.length &&
      Boolean(snapshot) &&
      isNaturalLanguageWorkflowAdvanceRequest(freeformDraft);
    if ((shouldBlockSkipAhead || shouldOpenWorkflowPanel) && snapshot) {
      const workflowQuestion = question ?? inferredWorkflowQuestion;
      if (workflowQuestion) {
        queueWorkflowPopoverAfterAssistantReply?.(workflowQuestion);
        void send(
          buildWorkflowAssistantReplyPrompt({
            snapshot,
            nextQuestion: workflowQuestion,
            kind: shouldBlockSkipAhead ? "skip-ahead" : "advance",
          }),
          freeformDraft,
          { disableAutoResearch: true },
        );
        return;
      }
    }

    const freeformVideoChoice =
      !qState && !question
        ? resolveFreeformVideoChoice(
            snapshot,
            runtimeRef.current,
            freeformDraft,
            question,
            lastSuggestedRef.current,
          )
        : null;
    if (freeformVideoChoice && snapshot?.projectKind === "video") {
      videoProjectChoiceHandler(
        snapshot,
        freeformVideoChoice.value,
        freeformVideoChoice.label,
      );
      resetComposerDraft("");
      return;
    }

    const shouldHideCurrentQuestionDuringFreeformSend =
      !qState &&
      !!question &&
      (Boolean(freeformDraft) || Boolean(attachedFiles?.length));
    if (shouldHideCurrentQuestionDuringFreeformSend) {
      rememberInterruptRestoreQuestion(question);
      dismissCurrentChoiceQuestion(question);
      setSelectedValues([]);
    }
    const sendWithCurrentQuestionDetourGuard = shouldHideCurrentQuestionDuringFreeformSend
      ? (
          value: MessageInput,
          shown?: string,
          opts?: {
            skipUserBubble?: boolean;
            attachments?: ChatAttachment[];
            disableAutoResearch?: boolean;
          },
        ) =>
          send(value, shown, {
            ...opts,
            disableAutoResearch: true,
          })
      : send;

    submitHomeAgentComposer({
      qState,
      question,
      draft: rawComposerDraft,
      attachmentsPresent: Boolean(attachedFiles?.length),
      confirmStructuredAnswer,
      deferQuestionToChat:
        qState && (Boolean(attachedFiles?.length) || question?.options.length > 0)
          ? () => {
              // 必须在 resetComposerDraft 清空 draftRef.current 之前保存草稿
              const draftToSend = rawComposerDraft;
              if (question) {
                rememberInterruptRestoreQuestion(question);
              }
              if (deferDismissedQuestion) {
                deferDismissedQuestion(qState, selectedValues, "");
              } else {
                setDeferredQuestionState(qState);
                setDeferredSelectedValues(selectedValues);
                setDeferredDraft("");
              }
              setQState(null);
              setSelectedValues([]);
              resetComposerDraft("");
              // 若引擎正阻塞在 AskUserQuestion 工具调用上（source === "live"），
              // 需先 reject 挂起的请求，再中断引擎，否则 send 无法执行
              if (qState.source === "live") {
                void import("@/lib/agent/tools/ask-user-question").then(
                  (mod) => {
                    mod.rejectAskUserQuestion(
                      qState.request.id,
                      "User skipped question",
                    );
                  },
                );
                engineRef.current?.interrupt();
                engineRef.current = null;
              }
              void send(draftToSend, undefined, { disableAutoResearch: true });
            }
          : undefined,
      answer,
      send: sendWithCurrentQuestionDetourGuard,
    });
  }, [
    answer,
    attachedFiles,
    appendStructuredQuestionReminder,
    automationMode,
    clearInterruptRestoreQuestion,
    confirmStructuredAnswer,
    draftRef,
    dismissCurrentChoiceQuestion,
    engineRef,
    handleChoiceSelect,
    isAwaitingWorkflowDocumentUpload,
    lastSuggestedRef,
    onAttachedFilesChange,
    onRecognizeImageStyle,
    openHomepageWorkflowKickoff,
    qState,
    question,
    rememberInterruptRestoreQuestion,
    resetComposerDraft,
    selectedValues,
    send,
    deferDismissedQuestion,
    setDeferredDraft,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setMessages,
    setMode,
    setPopoverOverride,
    setQState,
    setSelectedValues,
    setSuggested,
    queueWorkflowPopoverAfterAssistantReply,
    videoProjectChoiceHandler,
    runtimeRef,
    getInterruptedChoiceQuestion,
  ]);

  const handleInterrupt = useCallback(() => {
    onGlobalInterrupt();
  }, [onGlobalInterrupt]);

  // 用户点击弹窗 X 关闭：若引擎正阻塞在工具调用上，先 reject 再中断
  const dismissQuestion = useCallback(() => {
    if (qState) {
      if (qState.source === "live") {
        void import("@/lib/agent/tools/ask-user-question").then((mod) => {
          mod.rejectAskUserQuestion(
            qState.request.id,
            "User dismissed question",
          );
        });
        engineRef.current?.interrupt();
        engineRef.current = null;
        setStreaming(false);
        clearInterruptRestoreQuestion();
      }
      deferDismissedQuestion?.(qState, selectedValues, draftRef.current);
      setQState(null);
      setSelectedValues([]);
      resetComposerDraft("");
      return;
    }

    if (question) {
      dismissCurrentChoiceQuestion(question);
      setSelectedValues([]);
      resetComposerDraft("");
    }
  }, [
    clearInterruptRestoreQuestion,
    deferDismissedQuestion,
    draftRef,
    dismissCurrentChoiceQuestion,
    engineRef,
    qState,
    question,
    resetComposerDraft,
    setQState,
    setSelectedValues,
    setStreaming,
    selectedValues,
  ]);

  const workflowProgress = useMemo<ComposerWorkflowProgress | null>(() => {
    if (
      workflowEventProgress?.content &&
      isCmdWorkflowAction(effectiveWorkflowProgressAction)
    ) {
      const parts = workflowEventProgress.content
        .split(" · ")
        .map((part) => part.trim())
        .filter(Boolean);
      const headline = parts[0] || workflowEventProgress.content;
      const progressMatch = headline.match(/(\d+)\/(\d+)/);
      const completed = progressMatch ? Number(progressMatch[1]) : 0;
      const total = progressMatch ? Math.max(Number(progressMatch[2]), 1) : 1;
      const isTerminalWorkflowEvent =
        workflowEventProgress.status === "complete" ||
        workflowEventProgress.status === "error";
      const effectiveHasProcessingFromStatus = !isTerminalWorkflowEvent;
      const hasProcessing =
        workflowEventProgress.content.includes("正在拆") ||
        workflowEventProgress.content.includes("正在生成");
      const failed = workflowEventProgress.content.includes("失败");
      const floorPercent = Math.round((completed / total) * 100);
      const ceilPercent = Math.round(
        ((completed +
          (hasProcessing && effectiveHasProcessingFromStatus ? 1 : 0)) /
          total) *
          100,
      );
      const title =
        effectiveWorkflowProgressAction === "prepare_segment_video_prompt"
          ? "正在生成片段提示词"
          : effectiveWorkflowProgressAction === "prepare_video_prompt_batch"
            ? "正在生成镜头提示词"
            : effectiveWorkflowProgressAction === "generate_segment_video"
              ? "正在生成片段视频"
              : effectiveWorkflowProgressAction === "refresh_segment_video"
                ? "正在刷新片段视频"
                : effectiveWorkflowProgressAction === "generate_video_assets"
                  ? "正在生成镜头视频"
                  : effectiveWorkflowProgressAction === "refresh_video_assets"
                    ? "正在刷新镜头视频"
                    : "正在拆解剧本分镜";

      return {
        title,
        description: "底层任务状态会实时刷新。",
        floorPercent,
        ceilPercent: Math.min(100, Math.max(floorPercent, ceilPercent)),
        hasProcessing: hasProcessing && effectiveHasProcessingFromStatus,
        statusLabel: ensureCmdProgressStatusLabel(
          effectiveWorkflowProgressAction,
          headline,
        ),
        detailLabel: parts[1] || (failed ? "有分集失败" : `${floorPercent}%`),
        currentBatchLabel: parts.slice(2).join(" · ") || undefined,
        onStop:
          hasProcessing && effectiveHasProcessingFromStatus
            ? onGlobalInterrupt
            : undefined,
      };
    }

    if (!currentProject) {
      return null;
    }

    if (
      activeWorkflowAction === "generate_episode" ||
      activeWorkflowAction === "generate_episode_batch"
    ) {
      const episodeArtifact = currentProject.artifacts.find(
        (artifact) =>
          artifact.kind === "episode" &&
          artifact.payload?.type === "episodes+batchProgress",
      );

      if (episodeArtifact?.payload?.type !== "episodes+batchProgress") {
        return null;
      }

      const payload = episodeArtifact.payload;
      const processingEntry = payload.entries.find(
        (entry) => entry.status === "processing",
      );
      const completedEpisodes = payload.entries.filter(
        (entry) => entry.status === "done",
      ).length;
      const failedEpisodes = payload.entries.filter(
        (entry) => entry.status === "failed",
      ).length;
      const totalEpisodes = Math.max(
        payload.batchProgress.total || payload.totalEpisodes,
        1,
      );
      const isProcessing = payload.batchProgress.processing > 0;
      const nextPendingEntry =
        processingEntry ??
        payload.entries.find(
          (entry) => entry.status === "failed" || entry.status === "pending",
        );
      const floorPercent = Math.round(
        (completedEpisodes / totalEpisodes) * 100,
      );
      const ceilPercent = Math.round(
        ((completedEpisodes + (isProcessing ? 1 : 0)) / totalEpisodes) * 100,
      );
      const entryStatusByNumber = new Map(
        payload.entries.map((entry) => [entry.number, entry.status] as const),
      );
      const cmdProgress = buildCmdProgressBar(
        Array.from({ length: totalEpisodes }, (_, index) =>
          getCmdProgressMark(entryStatusByNumber.get(index + 1)),
        ),
      );

      return {
        title: processingEntry
          ? completedEpisodes > 0
            ? `从第 ${processingEntry.number} 集继续撰写`
            : `第 ${processingEntry.number} 集正在撰写`
          : completedEpisodes > 0
            ? "继续撰写分集正文"
            : "正在撰写分集正文",
        description:
          completedEpisodes > 0 && nextPendingEntry
            ? `已完成的 ${completedEpisodes} 集正文会保留在项目里；若中途超时或失败，重试会从第 ${nextPendingEntry.number} 集继续。`
            : "已完成的正文会实时写回分集撰写卡片，进度符号会按集刷新。",
        floorPercent,
        ceilPercent,
        hasProcessing: isProcessing,
        detailLabel: failedEpisodes
          ? `${floorPercent}% · ${failedEpisodes} 集失败`
          : `${floorPercent}%`,
        currentBatchLabel: processingEntry
          ? `第 ${processingEntry.number} 集 · ${processingEntry.title}`
          : undefined,
        statusLabel: `${cmdProgress} ${completedEpisodes}/${totalEpisodes} 集正文`,
        onStop: isProcessing ? onGlobalInterrupt : undefined,
      };
    }

    if (activeWorkflowAction !== "generate_outlines") {
      return null;
    }

    const outlineArtifact = currentProject.artifacts.find(
      (artifact) =>
        artifact.kind === "outline" &&
        artifact.payload?.type === "outlines+batchProgress",
    );

    if (outlineArtifact?.payload?.type !== "outlines+batchProgress") {
      return null;
    }

    const payload = outlineArtifact.payload;
    const currentBatch =
      payload.batchProgress.batches.find(
        (batch) => batch.status === "processing",
      ) ??
      payload.batchProgress.batches.find((batch) => batch.status !== "done");
    const completedEpisodes = payload.entries.filter((entry) =>
      entry.outline?.trim(),
    ).length;
    const isProcessing = payload.batchProgress.batches.some(
      (b) => b.status === "processing",
    );
    const doneBatches = payload.batchProgress.done;
    const totalBatches = Math.max(payload.batchProgress.total, 1);
    const floorPercent = Math.round((doneBatches / totalBatches) * 100);
    const ceilPercent = Math.round(
      ((doneBatches + (isProcessing ? 1 : 0)) / totalBatches) * 100,
    );
    const totalEpisodes = Math.max(
      payload.totalEpisodes,
      payload.entries.length,
      1,
    );
    const outlineByNumber = new Map(
      payload.entries.map(
        (entry) => [entry.number, Boolean(entry.outline?.trim())] as const,
      ),
    );
    const batchByEpisodeNumber = new Map<number, string>();
    for (const batch of payload.batchProgress.batches) {
      for (
        let episodeNumber = batch.startEp;
        episodeNumber <= batch.endEp;
        episodeNumber += 1
      ) {
        batchByEpisodeNumber.set(episodeNumber, batch.status);
      }
    }
    const cmdProgress = buildCmdProgressBar(
      Array.from({ length: totalEpisodes }, (_, index) => {
        const episodeNumber = index + 1;
        return getCmdProgressMark(
          batchByEpisodeNumber.get(episodeNumber),
          outlineByNumber.get(episodeNumber),
        );
      }),
    );

    return {
      title: currentBatch
        ? `${currentBatch.label} 正在生成`
        : "正在生成单集细纲",
      description: "已生成的细纲会立即写回预览卡，进度符号会按集刷新。",
      floorPercent,
      ceilPercent,
      hasProcessing: isProcessing,
      detailLabel: `${doneBatches}/${totalBatches} 批次 · ${floorPercent}%`,
      currentBatchLabel: currentBatch?.label,
      statusLabel: `${cmdProgress} ${completedEpisodes}/${totalEpisodes} 集细纲`,
      onStop: isProcessing ? onGlobalInterrupt : undefined,
      onRegenerate: !isProcessing
        ? () =>
            handleChoiceSelect(
              "script:outline-regenerate-all",
              "重新生成全部细纲",
            )
        : undefined,
    };
  }, [
    currentProject,
    effectiveWorkflowProgressAction,
    handleChoiceSelect,
    onGlobalInterrupt,
    workflowEventProgress,
  ]);

  const shouldShowConfirmQuestion =
    Boolean(qState) ||
    Boolean(
      question?.answerKey === "题材选择" &&
      question.multiSelect &&
      question.submissionMode === "confirm",
    );
  const shouldShowBackQuestion =
    Boolean(question && canHandleQuestionBack?.(question)) ||
    Boolean(
      fullAutoRun?.status === "collecting" &&
      fullAutoRun.plan &&
      canRewindFullAutoStrategyPlan(fullAutoRun.plan),
    ) ||
    Boolean(
      qState &&
      isOriginalScriptKickoffRequest(qState.request) &&
      canRewindOriginalScriptKickoff(qState),
    ) ||
    Boolean(buildAdaptationTargetMarketBackQuestion(currentProject, question));
  const shouldShowResetQuestion = Boolean(
    fullAutoRun?.status === "collecting" &&
    fullAutoRun.plan &&
    canRewindFullAutoStrategyPlan(fullAutoRun.plan),
  );
  const visibleQuestion = useMemo(
    () => markSelectedQuestionOptions(question, selectedValues),
    [question, selectedValues],
  );
  const videoWorkflowTaskBoard =
    currentProject?.projectKind === "video"
      ? buildVideoWorkflowTaskBoard(
          currentProject,
          runtimeRef.current.currentVideoProject,
        )
      : null;
  const activeVideoGenerationMode =
    runtimeRef.current.currentVideoProject?.videoGenerationPrefs?.mode ??
    videoGenerationPrefs.mode;
  const showVideoModeBadge = Boolean(
    runtimeRef.current.currentVideoProject?.kickoffModeConfirmed ||
      (activeVideoGenerationMode &&
        shouldShowImmediateVideoModeBadge(visibleQuestion)),
  );

  const composerProps = useMemo<HomeComposerProps>(
    () => ({
      idle,
      currentProjectTitle: currentProject?.title,
      currentProjectStage: currentProject?.derivedStage,
      maintenanceHint,
      videoTransportHint,
      launchNotice,
      suppressFloatingTaskBoard,
      initialDraft: draftInitialValue,
      draftResetVersion,
      draftPresence,
      onDraftChange: syncComposerDraft,
      placeholder,
      question: visibleQuestion,
      workflowProgress,
      videoWorkflowTaskBoard,
      qState,
      selectedValues,
      streaming,
      isMediaGenerating,
      isAwaitingWorkflowDocumentUpload,
      reduceMotion,
      composerShellClass,
      activeTheme,
      selectedTextModelKey,
      selectedTextModelLabel,
      textModelGroups,
      onSelectTextModel,
      selectedImageModelKey,
      selectedImageModelLabel,
      imageModelOptions,
      imageGenerationPrefs,
      onSelectImageModel,
      onConfirmImageSettings,
      onRecognizeImageStyle,
      selectedVideoModelKey,
      selectedVideoModelLabel,
      videoModelOptions,
      videoGenerationPrefs,
      showVideoModeBadge,
      devVideoGenerationMode: activeVideoGenerationMode,
      onSelectVideoModel,
      onConfirmVideoResolution,
      onDevVideoGenerationModeChange,
      onDevImageViewModeChange,
      creationMode,
      onCreationModeChange,
      devMode,
      onDevModeChange,
      onSelectChoice: handleChoiceSelect,
      onConfirmQuestion: shouldShowConfirmQuestion
        ? confirmStructuredAnswer
        : undefined,
      onBackQuestion: shouldShowBackQuestion ? handleQuestionBack : undefined,
      onResetQuestion: shouldShowResetQuestion
        ? handleQuestionReset
        : undefined,
      onDismissQuestion: qState || question ? dismissQuestion : undefined,
      styleRecognitionProgress,
      onLaunchAction,
      onSubmit: submitComposer,
      onInterrupt: handleInterrupt,
      fullAutoRun,
      onStopFullAuto,
      attachedFiles,
      onAttachedFilesChange,
    }),
    [
      activeTheme,
      composerShellClass,
      confirmStructuredAnswer,
      currentProject,
      draftInitialValue,
      draftPresence,
      draftResetVersion,
      handleQuestionBack,
      handleQuestionReset,
      handleChoiceSelect,
      handleInterrupt,
      dismissQuestion,
      fullAutoRun,
      idle,
      maintenanceHint,
      launchNotice,
      suppressFloatingTaskBoard,
      placeholder,
      qState,
      question,
      visibleQuestion,
      videoWorkflowTaskBoard,
      reduceMotion,
      workflowProgress,
      selectedTextModelKey,
      selectedTextModelLabel,
      selectedImageModelKey,
      selectedImageModelLabel,
      selectedVideoModelKey,
      selectedVideoModelLabel,
      selectedValues,
      shouldShowConfirmQuestion,
      shouldShowBackQuestion,
      shouldShowResetQuestion,
      streaming,
      styleRecognitionProgress,
      isMediaGenerating,
      isAwaitingWorkflowDocumentUpload,
      submitComposer,
      syncComposerDraft,
      textModelGroups,
      imageModelOptions,
      imageGenerationPrefs,
      videoModelOptions,
      videoGenerationPrefs,
      activeVideoGenerationMode,
      showVideoModeBadge,
      videoTransportHint,
      onSelectTextModel,
      onSelectImageModel,
      onConfirmImageSettings,
      onRecognizeImageStyle,
      onSelectVideoModel,
      onConfirmVideoResolution,
      onDevVideoGenerationModeChange,
      onDevImageViewModeChange,
      creationMode,
      onCreationModeChange,
      devMode,
      onDevModeChange,
      onLaunchAction,
      onStopFullAuto,
      attachedFiles,
      onAttachedFilesChange,
    ],
  );

  const idleComposer = useMemo(
    () => (
      <div className={cn("mx-auto w-full", idleTrackClassName)}>
        <HomeComposer {...composerProps} />
      </div>
    ),
    [composerProps, idleTrackClassName],
  );

  const activeComposer = useMemo(
    () => (
      <div
        className={cn("mx-auto w-full overflow-visible", activeTrackClassName)}
      >
        <HomeComposer {...composerProps} />
      </div>
    ),
    [activeTrackClassName, composerProps],
  );

  return {
    composerProps,
    handleChoiceSelect,
    confirmStructuredAnswer,
    submitComposer,
    idleComposer,
    activeComposer,
    workflowProgress,
  };
}
