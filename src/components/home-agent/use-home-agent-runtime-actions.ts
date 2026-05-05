import { startTransition, useCallback, useRef } from "react";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { Message, MessageInput } from "@/lib/agent/types";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import { readStudioProjectSession, writeProjectStudioSession } from "@/lib/home-agent/session-store";
import {
  buildOriginalScriptKickoffIntro,
  buildOriginalScriptKickoffRequest,
  ORIGINAL_SCRIPT_TEMPLATE_ID,
  type OriginalScriptKickoffCompletion,
} from "@/lib/home-agent/original-script-kickoff";
import {
  buildAdaptationUploadExtractionSummary,
  buildAdaptationWorkflowKickoffIntro,
  buildAdaptationWorkflowKickoffRequest,
  buildAdaptationWorkflowStartPrompt,
  extractAdaptationReferenceUpload,
} from "@/lib/home-agent/adaptation-workflow-kickoff";
import {
  VIDEO_WORKFLOW_TEMPLATE_ID,
  buildVideoUploadExtractionSummary,
  buildVideoWorkflowKickoffIntro,
  buildVideoWorkflowKickoffRequest,
  buildVideoWorkflowStartPrompt,
  extractVideoWorkflowUploadScript,
  hasEpisodeScriptBody,
  recognizeVideoWorkflowUploadScript,
} from "@/lib/home-agent/video-workflow-kickoff";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  AutomationMode,
  FullAutoRunPlan,
  FullAutoRunState,
  FullAutoRunStep,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { AutoResearchPlan } from "@/lib/home-agent/auto-research";
import {
  buildAutoResearchChoiceQuestion,
  buildAutoResearchPlan,
  buildAutoResearchStepQuestion,
} from "@/lib/home-agent/auto-research";
import {
  applyAllOverlaysParallel,
  appendTextOverlayToInput,
  beginSendFlow,
  collectChangedArtifactsFromSdkUserMessage,
  createArtifactSignatureMap,
  handleSendEngineEvent,
  resolveDirectProjectImageIntent,
  resolveDirectStoryboardGenerationIntent,
  resolveDirectVideoGenerationIntent,
} from "./home-agent-send-flow";
import { createWorkflowShortcutUiBridge } from "./home-agent-workflow-ui";
import {
  getOrCreateHomeAgentEngine,
  launchHomeAgentAutoResearchTasks,
  type HomeAgentApiConfigModule,
  type HomeAgentEngineDeps,
} from "./home-agent-engine-runtime";
import { answerHomeAgentQuestion, launchTemplateConversation, resetHomeAgentConversation, resetRuntimeState } from "./home-agent-session-actions";
import {
  buildWorkflowContinuationPrompt,
  mergeRuntimeWithWorkflowDelta,
  runWorkflowShortcut,
  runWorkflowShortcutChain,
} from "@/lib/home-agent/workflow-shortcut-runner";
import {
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
} from "@/lib/home-agent/video-models";
import {
  applyFullAutoStrategyAnswer,
  buildFullAutoExecutionSteps,
  createFullAutoOriginalScriptRunPlan,
  getFullAutoEpisodeDurationSeconds,
  getFullAutoPromptBatchMode,
  getFullAutoStrategyValue,
  getFullAutoVideoAnalyzePrefs,
  getFullAutoVideoMode,
  getFullAutoVideoResolution,
  getNextFullAutoStrategyQuestion,
  isFullAutoStrategyQuestion,
  markFullAutoSteps,
  syncFullAutoPlanSteps,
  updateFullAutoStepStrategy,
} from "@/lib/home-agent/full-auto-run-plan";
import {
  buildMediaContentSummary,
  buildWorkflowMediaTargetLabels,
  localizeMediaSettingValue,
} from "@/lib/home-agent/media-generation-copy";
import {
  buildDreaminaCapabilityOverlay,
  buildEpisodeWorkflowQuestion,
  buildOutlinesWorkflowQuestion,
  buildVideoBridgeRetryQuestion,
  buildVideoContinuationQuestion,
  isVideoIntentPrompt,
  recQuestion,
} from "./home-agent-project-questions";
import {
  buildVideoKickoffModeQuestion,
  buildVideoUploadScriptFollowupQuestion,
} from "./home-agent-video-choice-handlers";
import type {
  AskUserQuestionModule,
  ConversationMemoryModule,
  DreaminaCliModule,
  ProjectStoreModule,
  StructuredQuestionParserModule,
} from "./use-home-agent-module-loaders";
import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
} from "@/types/project";
import { invokeFunction } from "@/lib/invoke-with-key";
import { resolveArtifactSnapshots } from "@/lib/home-agent/message-artifact-snapshots";
import { buildVideoBridgeResearchPlan } from "./use-home-agent-workflow-shortcuts";

type DreaminaCapabilityState = {
  ready: boolean;
  available: boolean;
  message?: string;
};

type DirectVideoGenerationTaskResult = {
  task_id?: string;
  status?: string;
  provider?: string;
};

type DirectVideoGenerationStatusResult = {
  status?: string;
  video_url?: string;
};

type ActiveRemoteVideoTask = {
  taskId: string;
  provider?: string;
};

type StopActiveExecutionResult = {
  hadActiveExecution: boolean;
  cancelledRemoteVideoTaskCount: number;
};

function createAbortError(message = "请求已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function waitForAbortableDelay(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "请求已取消" ||
    error.message === "任务已取消"
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|超时/i.test(message);
}

function truncateOverlayLine(value: string | undefined, max = 200): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

export function applyVideoKickoffFollowupQuestion(params: {
  workflowCompletion?: {
    projectSnapshot?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[0];
    data?: { videoProject?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[1] } | null;
    runtime?: { currentVideoProject?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[1] } | null;
  } | null;
  setSuggested: (question: ComposerQuestion | null) => void;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
  push?: (role: HomeAgentMessage["role"], content: string) => void;
}): boolean {
  const videoProject =
    params.workflowCompletion?.data?.videoProject ?? params.workflowCompletion?.runtime?.currentVideoProject;
  const followupQuestion = buildVideoUploadScriptFollowupQuestion(
    params.workflowCompletion?.projectSnapshot,
    videoProject,
  );
  if (!followupQuestion) return false;
  params.setSuggested(null);
  if (
    videoProject?.targetPlatform?.trim() &&
    videoProject?.shotStyle?.trim() &&
    videoProject?.outputGoal?.trim()
  ) {
    params.push?.(
      "assistant",
      "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002",
    );
  }
  params.setPopoverOverride(followupQuestion);
  return true;
}

export function applyWorkflowMediaFollowupQuestion(params: {
  projectSnapshot?: ConversationProjectSnapshot | null;
  runtime?: Pick<StudioRuntimeState, "currentVideoProject"> | null;
  preferredQuestion?: ComposerQuestion | null;
  setSuggested: (question: ComposerQuestion | null) => void;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
}): boolean {
  const hasRunningVideoScenes = hasRunningVideoGenerationTasks(params.runtime?.currentVideoProject);
  if (hasRunningVideoScenes) return false;

  const nextQuestion =
    params.preferredQuestion ??
    (params.projectSnapshot ? recQuestion(params.projectSnapshot, params.runtime?.currentVideoProject ?? null) : null);

  if (!nextQuestion) return false;

  params.setSuggested(null);
  params.setPopoverOverride(nextQuestion);
  return true;
}

function hasRunningVideoGenerationTasks(
  videoProject: Pick<StudioRuntimeState, "currentVideoProject">["currentVideoProject"] | null | undefined,
): boolean {
  return Boolean(
    videoProject?.scenes?.some((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return Boolean(scene.videoTaskId) && (status === "queued" || status === "processing");
    }),
  );
}

function shouldSuppressRunningVideoRefreshPanel(
  question: ComposerQuestion | null | undefined,
  runtime: Pick<StudioRuntimeState, "currentVideoProject"> | null | undefined,
): boolean {
  return (
    question?.answerKey === "video-refresh-panel" &&
    hasRunningVideoGenerationTasks(runtime?.currentVideoProject)
  );
}

function formatQuestionOptionLines(
  options: ComposerQuestion["options"],
  remaining: { count: number },
  depth = 0,
): string[] {
  const lines: string[] = [];

  for (const option of options) {
    if (remaining.count <= 0) break;

    const prefix = `${"  ".repeat(depth)}- `;
    const rationale = truncateOverlayLine(option.rationale, 120);
    const inputHint = option.childInput ? ` [input:${option.childInput.type}]` : "";
    const disabledHint = option.disabled ? " [disabled]" : "";
    lines.push(
      `${prefix}${truncateOverlayLine(option.label, 120)} -> ${option.value}${inputHint}${disabledHint}${rationale ? ` (${rationale})` : ""}`,
    );
    remaining.count -= 1;

    if (option.children?.length && remaining.count > 0) {
      lines.push(...formatQuestionOptionLines(option.children, remaining, depth + 1));
    }
  }

  return lines;
}

function formatComposerQuestionBlueprint(
  label: string,
  question: ComposerQuestion | null | undefined,
): string | null {
  if (!question?.options?.length) return null;

  const remaining = { count: 12 };
  const optionLines = formatQuestionOptionLines(question.options, remaining);
  if (!optionLines.length) return null;

  return [
    `[${label}]`,
    `Prompt: ${truncateOverlayLine(question.title, 220)}`,
    question.description ? `Context: ${truncateOverlayLine(question.description, 240)}` : "",
    `Submission: ${question.submissionMode}; custom_input=${question.allowCustomInput ? "yes" : "no"}`,
    "Suggested options:",
    ...optionLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAskUserRequestBlueprint(
  label: string,
  request: AskUserQuestionRequest | null | undefined,
): string | null {
  if (!request?.questions?.length) return null;

  const lines = request.questions.slice(0, 2).flatMap((question, index) => {
    const options = (question.options ?? []).slice(0, index === 0 ? 8 : 4).map((option) => {
      const rationale = truncateOverlayLine(option.rationale ?? option.description, 120);
      return `- ${option.label} -> ${option.value}${rationale ? ` (${rationale})` : ""}`;
    });

    return [
      `Question ${index + 1}: ${truncateOverlayLine(question.question, 220)}`,
      ...options,
    ];
  });

  return [
    `[${label}]`,
    request.title ? `Prompt: ${truncateOverlayLine(request.title, 220)}` : "",
    request.description ? `Context: ${truncateOverlayLine(request.description, 240)}` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

function questionHasOptionValue(
  question: ComposerQuestion | null | undefined,
  targetValue: string,
): boolean {
  if (!question) return false;

  const stack = [...question.options];
  while (stack.length) {
    const option = stack.shift();
    if (!option) continue;
    if (option.value === targetValue) return true;
    if (option.children?.length) {
      stack.push(...option.children);
    }
  }

  return false;
}

function buildStageQuestionBlueprints(runtime: StudioRuntimeState): string[] {
  const snapshot = runtime.currentProjectSnapshot;
  if (!snapshot) {
    const kickoffBlueprint = formatAskUserRequestBlueprint(
      "Original script kickoff popup schema",
      buildOriginalScriptKickoffRequest(),
    );
    return kickoffBlueprint ? [kickoffBlueprint] : [];
  }

  const primaryQuestion = recQuestion(snapshot, runtime.currentVideoProject);
  const candidates = [
    formatComposerQuestionBlueprint("Primary next-step popup schema", primaryQuestion),
    snapshot.projectKind !== "video"
      ? formatComposerQuestionBlueprint(
          "Script outline detail schema",
          buildOutlinesWorkflowQuestion(snapshot),
        )
      : null,
    snapshot.projectKind !== "video"
      ? formatComposerQuestionBlueprint(
          "Script episode detail schema",
          buildEpisodeWorkflowQuestion(snapshot),
        )
      : null,
    snapshot.projectKind === "video"
      ? formatComposerQuestionBlueprint(
          "Video continuation schema",
          buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject),
        )
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (questionHasOptionValue(primaryQuestion, "script:export-video")) {
    candidates.push(
      [
        "[Script to Video Bridge Guidance]",
        "If the user is ready to leave script export, include the bridge-to-video choice in AskUserQuestion instead of leaving it as plain text.",
        "After the bridge is chosen, keep guiding inside the same conversation through video analysis -> entity extraction -> storyboard -> prompt batch -> generation -> review.",
      ].join("\n"),
    );
  }

  if (snapshot.projectKind === "video") {
    candidates.push(
      [
        "[Video Workflow Guidance]",
        "Ask missing video details step by step through AskUserQuestion, especially platform goal, shot/style lock, prompt batch scope, generation batch, refresh, and review.",
        "Do not collapse script-to-video continuation into a single broad question when a finer popup already exists.",
      ].join("\n"),
    );
  }

  return candidates;
}

function buildAdaptationResearchLlmOverlay(plan: AutoResearchPlan): string {
  return [
    "[Adaptation Research Guidance]",
    `用户正在启动改编研究，涉及 ${plan.tasks.map((t) => t.title).join("、")} 三个方向。`,
    "请依次通过 AskUserQuestion 工具询问用户对每个方向的偏好，每次只问一个方向，等用户回答后再问下一个。",
    "改编路线：询问用户想保留原内容的哪些部分、重做哪些部分（建议选项：保留原结构重做人物 / 保留人物重做结构 / 全面本地化改写 / 暂不确定先给建议）。",
    "受众适配：询问用户目标受众和市场方向（建议选项：中文市场 / 海外英文市场 / 日韩市场 / 全球多语 / 暂不确定先给建议）。",
    "角色重塑：询问用户想如何重塑人物关系（建议选项：保留原角色关系 / 重塑主角设定 / 全面重设人物关系 / 暂不确定先给建议）。",
    "收集完三个方向的偏好后，整合用户选择并给出改编研究方向总结。",
  ].join("\n");
}

function buildLlmConversationOverlay(params: {
  runtime: StudioRuntimeState;
  deferredQuestionState: StudioQuestionState | null;
}): string {
  const { runtime, deferredQuestionState } = params;
  const snapshot = runtime.currentProjectSnapshot;

  const lines = [
    "[Workflow Context Overlay]",
    snapshot
      ? `当前项目: ${snapshot.title} / ${snapshot.projectKind} / ${snapshot.derivedStage}`
      : "当前项目: 暂无",
    snapshot?.currentObjective
      ? `当前目标: ${truncateOverlayLine(snapshot.currentObjective, 240)}`
      : "当前目标: 暂无",
  ];

  if (deferredQuestionState?.request?.questions?.length) {
    const activeQuestion =
      deferredQuestionState.request.questions[deferredQuestionState.currentIndex] ??
      deferredQuestionState.request.questions[0];
    lines.push(
      `挂起问题: ${truncateOverlayLine(activeQuestion?.header || activeQuestion?.question, 200) || "未命名问题"}`,
    );
  } else {
    lines.push("挂起问题: 无");
  }

  lines.push(
    "规则: 如果用户这次输入与挂起问题或当前流程无关，先正常回答用户当前问题，不要把自由输入或附件隐式当成步骤答案。",
  );
  lines.push(
    "规则: 若回答后仍适合继续流程，再通过 AskUserQuestion 轻柔恢复，不要强行拉回，也不要自动执行下一步。",
  );

  const questionBlueprints = buildStageQuestionBlueprints(runtime);
  if (questionBlueprints.length) {
    lines.splice(3, 0, ...questionBlueprints);
  }

  lines.push(
    "Rule: NEVER ask questions or list options in plain text. Whenever you need to collect information from the user, call AskUserQuestion immediately - do NOT write '需要确认' / '请选择' / '有以下几个方向' in plain text and then stop. If you find yourself about to write a question or option list in plain text, stop and call AskUserQuestion instead.",
  );
  lines.push(
    "Rule: At every major fork or explicit tradeoff, briefly explain the context in text and ALWAYS call AskUserQuestion in the same turn so the UI shows a popup with the options.",
  );
  lines.push(
    "Rule: Proactively collect the next missing structured details from the popup schemas above instead of asking only broad open-ended questions.",
  );
  const candidate = snapshot?.recommendedActions?.[0];
  if (candidate) {
    lines.push(`下一步：${truncateOverlayLine(candidate, 240)}`);
  }
  lines.push(
    "Rule: Never expose internal reasoning or chain-of-thought in the reply. Output conclusions and actions only.",
  );
  lines.push(
    "Rule: If the user's input is vague or says '随便'/'都行'/'你决定', call AskUserQuestion with 2-4 concrete options immediately instead of guessing.",
  );

  return lines.join("\n");
}

export function useHomeAgentRuntimeActions(params: {
  systemPrompt: string;
  creationMode: import("@/lib/home-agent/types").CreationMode;
  automationMode: AutomationMode;
  qState: StudioQuestionState | null;
  deferredQuestionState: StudioQuestionState | null;
  engineRef: React.MutableRefObject<Awaited<ReturnType<typeof getOrCreateHomeAgentEngine>> | null>;
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  messagesRef: React.MutableRefObject<HomeAgentMessage[]>;
  compactedMessageCountRef: React.MutableRefObject<number>;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  surfacedDreaminaHintRef: React.MutableRefObject<boolean>;
  loadEngineDeps: () => Promise<HomeAgentEngineDeps>;
  loadApiConfigModule: () => Promise<HomeAgentApiConfigModule>;
  loadStructuredQuestionParser: () => Promise<StructuredQuestionParserModule>;
  loadConversationMemoryModule: () => Promise<ConversationMemoryModule>;
  loadProjectStore: () => Promise<ProjectStoreModule>;
  loadAskUserQuestionModule: () => Promise<AskUserQuestionModule>;
  loadDreaminaCliModule: () => Promise<DreaminaCliModule>;
  loadWorkflowActionsModule: () => Promise<{
    runWorkflowAction: (
      action: string,
      input: Record<string, unknown>,
      runtime: StudioRuntimeState,
      onProgress?: import("@/lib/home-agent/types").WorkflowActionProgressCallback,
    ) => Promise<import("@/lib/home-agent/types").WorkflowActionResult>;
  }>;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  resetComposerDraft: (value?: string) => void;
  dreaminaCapability: DreaminaCapabilityState;
  setDreaminaCapability: React.Dispatch<React.SetStateAction<DreaminaCapabilityState>>;
  buildResearchPromptOverlay: (plan: AutoResearchPlan, taskIds: string[]) => string;
  createQuestionState: (
    request: AskUserQuestionRequest,
    source?: StudioQuestionState["source"],
  ) => StudioQuestionState;
  toQuery: (messages: HomeAgentMessage[]) => Message[];
  textOf: (value: unknown) => string;
  qStepKey: (index: number, question: { header?: string }) => string;
  push: (
    role: HomeAgentMessage["role"],
    content: string,
    artifactIds?: string[],
    attachments?: ChatAttachment[],
  ) => void;
  selectedTextModelKey: string;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setMode: React.Dispatch<React.SetStateAction<"idle" | "active" | "recovering" | "maintenance-review">>;
  setQState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setDeferredQuestionState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setCompactedMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setMetaReady: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveWorkflowAction: React.Dispatch<React.SetStateAction<string | null>>;
  activeProjectId?: string;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  lastSuggestedRef: React.MutableRefObject<ComposerQuestion | null>;
  backgroundResearchGroupsRef: React.MutableRefObject<import("./home-agent-task-utils").BackgroundResearchGroup[]>;
  selectedImageModelFamily?: VideoImageModelFamilyKey;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  selectedVideoModelKey?: VideoGenerationModelKey;
  videoGenerationPrefs?: VideoGenerationPrefs;
  restoreInterruptedChoiceQuestion?: (question: ComposerQuestion | null) => boolean;
}) {
  const {
    systemPrompt,
    creationMode,
    automationMode,
    qState,
    deferredQuestionState,
    engineRef,
    runtimeRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    surfacedDreaminaHintRef,
    loadEngineDeps,
    loadApiConfigModule,
    loadStructuredQuestionParser,
    loadConversationMemoryModule,
    loadProjectStore,
    loadAskUserQuestionModule,
    loadDreaminaCliModule,
    loadWorkflowActionsModule,
    flashMaintenanceHint,
    resetComposerDraft,
    dreaminaCapability,
    setDreaminaCapability,
    buildResearchPromptOverlay,
    createQuestionState,
    toQuery,
    textOf,
    qStepKey,
    push,
    selectedTextModelKey,
    setPopoverOverride,
    setSuggested,
    setMode,
    setQState,
    setDeferredQuestionState,
    setSelectedValues,
    setDeferredSelectedValues,
    setStreaming,
    setRuntime,
    setCompactedMessageCount,
    setMessages,
    setMetaReady,
    setActiveProjectId,
    setActiveWorkflowAction,
    activeProjectId,
    setDeferredDraft,
    lastSuggestedRef,
    backgroundResearchGroupsRef,
    selectedImageModelFamily = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
    imageGenerationPrefs = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    selectedVideoModelKey = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
    videoGenerationPrefs = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    restoreInterruptedChoiceQuestion,
  } = params;
  const sendRunIdRef = useRef(0);
  const pendingAutoResearchPlanRef = useRef<AutoResearchPlan | null>(null);
  const pendingAutoResearchSelectionsRef = useRef<Record<string, string>>({});
  const streamingMessageIdRef = useRef<string | null>(null);
  const pendingAdaptationUploadRef = useRef(false);
  const pendingVideoUploadRef = useRef(false);
  const activeExecutionAbortRef = useRef<AbortController | null>(null);
  const activeRemoteVideoTasksRef = useRef<Map<string, ActiveRemoteVideoTask>>(new Map());

  const openVideoKickoffPrefQuestion = useCallback(
    (snapshot: ConversationProjectSnapshot | null) => {
      if (!snapshot || snapshot.projectKind !== "video") {
        return false;
      }
      push("assistant", `先确认视频生成模式和画面风格，随后我会自动继续原来的"补平台与镜头偏好"后台流程。`);
      setPopoverOverride(buildVideoKickoffModeQuestion(snapshot, videoGenerationPrefs));
      setSuggested(null);
      setMode("active");
      resetComposerDraft("");
      setStreaming(false);
      setActiveWorkflowAction(null);
      return true;
    },
    [
      push,
      resetComposerDraft,
      setActiveWorkflowAction,
      setMode,
      setPopoverOverride,
      setStreaming,
      setSuggested,
      videoGenerationPrefs,
    ],
  );

  const launchAutomaticVideoBridgeResearch = useCallback(
    async (params: {
      workflowRuntime: StudioRuntimeState;
      projectSnapshot: ConversationProjectSnapshot | null;
    }) => {
      const snapshot = params.projectSnapshot;
      const planOverride = buildVideoBridgeResearchPlan(snapshot, "all");

      setPopoverOverride(null);
      setSuggested(null);
      setMode("active");
      resetComposerDraft("");
      setActiveWorkflowAction("video:bridge:platform");
      setStreaming(true);

      let launchedGroup = false;
      try {
        const launched = await launchHomeAgentAutoResearchTasks({
          prompt: planOverride.kickoff,
          runtime: params.workflowRuntime,
          loadApiConfigModule,
          selectedTextModelKey,
          planOverride,
        });

        if (!launched?.taskIds.length) {
          push("assistant", "当前没能启动后台整理，请先检查文本模型配置后再试。");
          setPopoverOverride(buildVideoBridgeRetryQuestion(snapshot));
          return false;
        }

        launchedGroup = true;
        let settled = false;
        const finishGroup = () => {
          if (settled) return;
          settled = true;
          setActiveWorkflowAction(null);
          setStreaming(false);
        };

        backgroundResearchGroupsRef.current = [
          ...backgroundResearchGroupsRef.current.filter(
            (group) =>
              !(group.kind === "video-bridge-platform" && group.projectId === snapshot?.projectId),
          ),
          {
            id: crypto.randomUUID(),
            kind: "video-bridge-platform",
            projectId: snapshot?.projectId,
            taskIds: launched.taskIds,
            status: "pending",
            onFinish: finishGroup,
          },
        ];
        return true;
      } catch (error) {
        push("assistant", error instanceof Error ? error.message : "后台整理启动失败，请稍后重试。");
        setPopoverOverride(buildVideoBridgeRetryQuestion(params.projectSnapshot));
        return false;
      } finally {
        if (!launchedGroup) {
          setActiveWorkflowAction(null);
          setStreaming(false);
        }
      }
    },
    [
      backgroundResearchGroupsRef,
      loadApiConfigModule,
      push,
      resetComposerDraft,
      selectedTextModelKey,
      setActiveWorkflowAction,
      setMode,
      setPopoverOverride,
      setStreaming,
      setSuggested,
    ],
  );

  const trackActiveRemoteVideoTask = useCallback((task: ActiveRemoteVideoTask) => {
    const taskId = task.taskId.trim();
    if (!taskId) return;
    const provider = task.provider?.trim() || "jimeng";
    activeRemoteVideoTasksRef.current.set(`${provider}:${taskId}`, {
      taskId,
      provider,
    });
  }, []);

  const untrackActiveRemoteVideoTask = useCallback((taskId: string, provider?: string) => {
    const trimmedTaskId = taskId.trim();
    if (!trimmedTaskId) return;
    const trimmedProvider = provider?.trim();
    if (trimmedProvider) {
      activeRemoteVideoTasksRef.current.delete(`${trimmedProvider}:${trimmedTaskId}`);
      return;
    }

    for (const [key, task] of activeRemoteVideoTasksRef.current.entries()) {
      if (task.taskId === trimmedTaskId) {
        activeRemoteVideoTasksRef.current.delete(key);
      }
    }
  }, []);

  const syncTrackedRemoteVideoTasksFromRuntime = useCallback((runtime: StudioRuntimeState) => {
    const nextTasks = new Map<string, ActiveRemoteVideoTask>();
    for (const scene of runtime.currentVideoProject?.scenes || []) {
      const taskId = String(scene.videoTaskId || "").trim();
      const status = String(scene.videoStatus || "").trim().toLowerCase();
      if (!taskId || (status !== "queued" && status !== "processing")) continue;
      const provider = String(scene.videoProvider || "jimeng").trim() || "jimeng";
      nextTasks.set(`${provider}:${taskId}`, {
        taskId,
        provider,
      });
    }
    activeRemoteVideoTasksRef.current = nextTasks;
  }, []);

  const cancelTrackedRemoteVideoTasks = useCallback((): number => {
    const tasks = [...activeRemoteVideoTasksRef.current.values()];
    activeRemoteVideoTasksRef.current.clear();

    for (const task of tasks) {
      void invokeFunction("generate-video", {
        action: "cancel",
        taskId: task.taskId,
        provider: task.provider,
      });
    }

    return tasks.length;
  }, []);

  const getRuntimeWithGenerationPrefs = useCallback((): StudioRuntimeState => {
    const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
      ...videoGenerationPrefs,
      modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
    });
    const runtime = runtimeRef.current;
    if (!runtime.currentVideoProject) {
      return runtime;
    }

    return {
      ...runtime,
      currentVideoProject: {
        ...runtime.currentVideoProject,
        videoGenerationPrefs: normalizedVideoPrefs,
      },
    };
  }, [runtimeRef, selectedVideoModelKey, videoGenerationPrefs]);

  const setWorkflowPopoverQuestion = useCallback(
    (question: ComposerQuestion | null) => {
      if (shouldSuppressRunningVideoRefreshPanel(question, runtimeRef.current)) {
        return;
      }
      setPopoverOverride(question);
    },
    [runtimeRef, setPopoverOverride],
  );

  const decorateFullAutoWorkflowInput = useCallback(
    (input: Record<string, unknown>, abortSignal?: AbortSignal) => {
      const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
        ...imageGenerationPrefs,
        familyKey: selectedImageModelFamily,
      });
      const inputVideoPrefs =
        typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs
          ? input.videoGenerationPrefs
          : {};
      const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
        ...videoGenerationPrefs,
        modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
        ...inputVideoPrefs,
      });

      return {
        ...input,
        selectedImageModelFamily: normalizedImagePrefs.familyKey,
        modelFamily: normalizedImagePrefs.familyKey,
        imageGenerationPrefs: normalizedImagePrefs,
        selectedVideoModelKey: normalizedVideoPrefs.modelKey,
        videoModelKey: normalizedVideoPrefs.modelKey,
        videoGenerationPrefs: normalizedVideoPrefs,
        ...(abortSignal ? { abortSignal } : {}),
      };
    },
    [imageGenerationPrefs, selectedImageModelFamily, selectedVideoModelKey, videoGenerationPrefs],
  );

  const commitFullAutoRunState = useCallback(
    (state: FullAutoRunState) => {
      setRuntime((prev) => {
        const nextSnapshot = prev.currentProjectSnapshot
          ? { ...prev.currentProjectSnapshot, automationMode: "full-auto" as const }
          : prev.currentProjectSnapshot;
        const nextRuntime = {
          ...prev,
          currentProjectSnapshot: nextSnapshot,
          fullAutoRun: state,
        };
        runtimeRef.current = nextRuntime;
        return nextRuntime;
      });
    },
    [runtimeRef, setRuntime],
  );

  const pushFullAutoUserMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const message: HomeAgentMessage = {
        id: globalThis.crypto?.randomUUID?.() ?? `full-auto-user-${Date.now()}`,
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
        automationOrigin: "full-auto",
      };
      setMessages((prev) => [...prev, message]);
    },
    [setMessages],
  );

  const runFullAutoOriginalScriptPlan = useCallback(
    async (initialPlan: FullAutoRunPlan, options?: { startIndex?: number }) => {
      let runPlan = syncFullAutoPlanSteps(initialPlan);
      const runId = runPlan.id;
      const abortController = new AbortController();
      activeExecutionAbortRef.current?.abort();
      activeExecutionAbortRef.current = abortController;
      pendingAdaptationUploadRef.current = false;
      pendingVideoUploadRef.current = false;

      const steps = buildFullAutoExecutionSteps(runPlan);
      const startIndex = Math.max(0, Math.min(options?.startIndex ?? runPlan.currentStepIndex ?? 0, steps.length - 1));

      const makeRunState = (
        status: FullAutoRunState["status"],
        currentStepIndex: number,
        extra?: Partial<FullAutoRunState>,
      ): FullAutoRunState => ({
        status,
        plan: markFullAutoSteps(
          runPlan,
          currentStepIndex,
          status === "completed"
            ? "completed"
            : status === "retrying"
              ? "retrying"
              : status === "stopped"
                ? "stopped"
                : status === "failed"
                  ? "failed"
                  : "running",
        ),
        currentStepIndex,
        currentStepLabel: steps[currentStepIndex]?.label,
        ...extra,
      });

      const commitFullAutoState = (state: FullAutoRunState) => {
        if (state.plan) runPlan = state.plan;
        commitFullAutoRunState(state);
      };

      const setStep = (index: number, status: FullAutoRunState["status"] = "running") => {
        const next = makeRunState(status, index);
        commitFullAutoState(next);
        setActiveWorkflowAction(steps[index]?.workflowAction ?? "full-auto");
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:workflow-progress", {
              detail: {
                id: `full-auto-${runId}`,
                status: status === "completed" ? "complete" : status === "retrying" ? "progress" : "start",
                content: steps[index]?.label ?? "全自动执行",
              },
            }),
          );
        }
      };

      const projectIdFromRuntime = (runtime: StudioRuntimeState): string | undefined =>
        runtime.currentProjectSnapshot?.projectId ||
        runtime.currentDramaProject?.id ||
        runtime.currentVideoProject?.id;

      const inputForStep = (
        step: FullAutoRunStep,
        runtime: StudioRuntimeState,
      ): Record<string, unknown> => {
        const action = step.workflowAction;
        const projectId = projectIdFromRuntime(runtime);
        if (action === "save_setup") {
          return {
            ...(runPlan.setupInput ?? {}),
            automationMode: "full-auto",
            forceNewProject: true,
          };
        }
        if (!projectId) return { ...(runPlan.setupInput ?? {}), automationMode: "full-auto" };
        if (action === "generate_creative_plan") {
          return { projectId, automationMode: "full-auto" };
        }
        if (action === "generate_outlines") {
          const value = getFullAutoStrategyValue(runPlan, "outlineGeneration");
          const batch = value?.match(/^script:outline-generate-batch:(\d+):(\d+)$/);
          return {
            projectId,
            keepCurrentStep: true,
            ...(value === "script:outline-fill-missing" ? { fillMissingOutlines: true } : {}),
            ...(value === "script:outline-regenerate-all" ? { regenerateAll: true } : {}),
            ...(batch ? { rangeStart: Number(batch[1]), rangeEnd: Number(batch[2]) } : {}),
          };
        }
        if (action === "generate_episode_batch") {
          const value = getFullAutoStrategyValue(runPlan, "episodeWriting");
          return {
            projectId,
            durationSeconds: getFullAutoEpisodeDurationSeconds(runPlan),
            ...(value === "script:episode-fill-missing" ? { fillMissingEpisodes: true } : {}),
          };
        }
        if (action === "review_episode_quality") {
          const value = getFullAutoStrategyValue(runPlan, "episodeReview");
          return {
            projectId,
            defaultReviewCount: 10,
            ...(value === "script:episode-review:remaining" ? { reviewRemaining: true } : {}),
          };
        }
        if (action === "run_compliance_review") {
          const value = getFullAutoStrategyValue(runPlan, "complianceReview");
          return {
            projectId,
            reviewMode: value?.endsWith(":script") ? "script" : "text",
          };
        }
        if (action === "prepare_video_generation") {
          return {
            projectId,
            automationMode: "full-auto",
            videoGenerationPrefs: {
              mode: getFullAutoVideoMode(runPlan),
              resolution: getFullAutoVideoResolution(runPlan),
            },
          };
        }
        if (action === "analyze_script_for_video") {
          return { projectId, ...getFullAutoVideoAnalyzePrefs(runPlan) };
        }
        if (action === "generate_video_reference_assets") {
          const value = getFullAutoStrategyValue(runPlan, "referenceAssets");
          return {
            projectId,
            smartBatch: true,
            ...(value === "video:bridge:reference-assets:characters" ? { targetScope: "characters" } : {}),
            ...(value === "video:bridge:reference-assets:scenes" ? { targetScope: "scenes" } : {}),
          };
        }
        if (action === "prepare_segment_video_prompt") {
          return { projectId, batchMode: getFullAutoPromptBatchMode(runPlan) };
        }
        if (action === "prepare_video_prompt_batch") {
          return { projectId, batchMode: getFullAutoPromptBatchMode(runPlan) };
        }
        if (action === "generate_segment_video") {
          const value = getFullAutoStrategyValue(runPlan, "videoGeneration");
          return {
            projectId,
            ...(value === "video:generate:segments:failed" ? { retryFailed: true } : {}),
            ...(value === "video:generate:segments:refresh" ? { refreshRunning: true } : {}),
            ...(value === "video:generate:segments:first" ? { batchMode: "first" } : {}),
          };
        }
        return {
          projectId,
          ...(action === "compile_video_shot_packets" ? { videoMode: getFullAutoVideoMode(runPlan) } : {}),
        };
      };

      const workflow = await loadWorkflowActionsModule();
      setMode("active");
      setPopoverOverride(null);
      setSuggested(null);
      setSelectedValues([]);
      resetComposerDraft("");
      setStreaming(true);
      push(
        "assistant",
        startIndex > 0
          ? `继续全自动链路，将从“${steps[startIndex]?.label ?? "当前步骤"}”接上执行。`
          : "策略已收集完毕。接下来我会以 AI 代理身份按顺序执行原创剧本到视频导出链路；你可以随时点击停止。",
      );
      commitFullAutoState(makeRunState("running", startIndex));

      let nextRuntime = {
        ...runtimeRef.current,
        fullAutoRun: makeRunState("running", startIndex),
      };

      try {
        for (let index = startIndex; index < steps.length; index += 1) {
          const step = steps[index];
          if (abortController.signal.aborted) {
            commitFullAutoState(makeRunState("stopped", index, {
              stoppedByUser: true,
              plan: {
                ...markFullAutoSteps(runPlan, index, "stopped"),
                stoppedStepId: step.id,
                resumeFromStepId: step.id,
              },
            }));
            push("assistant", "全自动执行已停止。当前步骤会恢复为普通工作流选项，你可以选择后继续。");
            const restoreQuestion = nextRuntime.currentProjectSnapshot
              ? recQuestion(nextRuntime.currentProjectSnapshot, nextRuntime.currentVideoProject)
              : null;
            if (restoreQuestion) {
              setPopoverOverride(restoreQuestion);
              setSuggested(null);
            }
            return;
          }

          setStep(index);
          pushFullAutoUserMessage(step.label);

          let attempt = 0;
          let result: Awaited<ReturnType<typeof workflow.runWorkflowAction>> | null = null;
          while (!result && attempt < 3) {
            attempt += 1;
            try {
              if (attempt > 1) {
                commitFullAutoState(makeRunState("retrying", index, {
                  currentStepLabel: `${step.label}（第 ${attempt} 次尝试）`,
                }));
              }
              result = await workflow.runWorkflowAction(
                step.workflowAction ?? "",
                decorateFullAutoWorkflowInput(inputForStep(step, nextRuntime), abortController.signal),
                nextRuntime,
                (partial) => {
                  if (partial.data) {
                    const partialRuntime = mergeRuntimeWithWorkflowDelta(nextRuntime, partial.data);
                    nextRuntime = {
                      ...partialRuntime,
                      fullAutoRun: makeRunState("running", index),
                    };
                    runtimeRef.current = nextRuntime;
                    setRuntime(nextRuntime);
                    if (partial.data.projectSnapshot?.projectId) {
                      setActiveProjectId(partial.data.projectSnapshot.projectId);
                    }
                  }
                },
              );
            } catch (error) {
              if (abortController.signal.aborted) throw error;
              if (attempt >= 3) throw error;
            }
          }

          if (!result) continue;
          const nextSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
          nextRuntime = result.data ? mergeRuntimeWithWorkflowDelta(nextRuntime, result.data) : nextRuntime;
          if (nextSnapshot) {
            nextRuntime = {
              ...nextRuntime,
              currentProjectSnapshot: {
                ...nextSnapshot,
                automationMode: "full-auto",
              },
            };
          }
          nextRuntime = {
            ...nextRuntime,
            fullAutoRun: makeRunState("running", index),
          };
          runtimeRef.current = nextRuntime;
          setRuntime(nextRuntime);
          const nextProjectId = projectIdFromRuntime(nextRuntime);
          if (nextProjectId) {
            setActiveProjectId(nextProjectId);
            void loadProjectStore()
              .then((store) => store.setConversationProjectAutomationMode?.(nextProjectId, "full-auto"))
              .catch(() => undefined);
          }
          if (result.summary?.trim()) {
            push("assistant", result.summary.trim());
          }
        }

        commitFullAutoState(makeRunState("completed", steps.length - 1));
        setPopoverOverride(null);
        setSuggested(
          nextRuntime.currentProjectSnapshot
            ? recQuestion(nextRuntime.currentProjectSnapshot, nextRuntime.currentVideoProject)
            : null,
        );
        push("assistant", "全自动链路已完成。历史记录已标记为全自动模式。");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "全自动执行失败，请稍后重试。";
        const stoppedByUser = abortController.signal.aborted;
        const failedIndex = Math.max(0, Math.min(runPlan.currentStepIndex ?? startIndex, steps.length - 1));
        commitFullAutoState(
          makeRunState(stoppedByUser ? "stopped" : "failed", failedIndex, {
            stoppedByUser,
            lastError: message,
            plan: {
              ...markFullAutoSteps(runPlan, failedIndex, stoppedByUser ? "stopped" : "failed"),
              stoppedStepId: stoppedByUser ? steps[failedIndex]?.id : runPlan.stoppedStepId,
              resumeFromStepId: steps[failedIndex]?.id,
            },
          }),
        );
        const restoreQuestion = nextRuntime.currentProjectSnapshot
          ? recQuestion(nextRuntime.currentProjectSnapshot, nextRuntime.currentVideoProject)
          : null;
        if (restoreQuestion) {
          setPopoverOverride(restoreQuestion);
          setSuggested(null);
        }
        push(
          "assistant",
          stoppedByUser
            ? "全自动执行已停止。当前步骤已恢复为普通工作流选项。"
            : `全自动执行遇到问题：${message}`,
        );
      } finally {
        if (activeExecutionAbortRef.current === abortController) {
          activeExecutionAbortRef.current = null;
        }
        setActiveWorkflowAction(null);
        setStreaming(false);
      }
    },
    [
      commitFullAutoRunState,
      decorateFullAutoWorkflowInput,
      loadProjectStore,
      loadWorkflowActionsModule,
      push,
      pushFullAutoUserMessage,
      resetComposerDraft,
      runtimeRef,
      setActiveProjectId,
      setActiveWorkflowAction,
      setMode,
      setPopoverOverride,
      setRuntime,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const beginFullAutoOriginalScriptCollection = useCallback(
    async (completion: OriginalScriptKickoffCompletion) => {
      const plan = createFullAutoOriginalScriptRunPlan(completion, videoGenerationPrefs);
      const firstQuestion = getNextFullAutoStrategyQuestion(plan);
      const collectingState: FullAutoRunState = {
        status: "collecting",
        plan,
        currentStepIndex: 0,
        currentStepLabel: firstQuestion?.title ?? "全自动策略预采集",
      };

      commitFullAutoRunState(collectingState);
      setMode("active");
      setSuggested(null);
      setSelectedValues([]);
      resetComposerDraft("");
      push("assistant", "项目设定已确认。全自动模式会先一次性收集后续批量生成、质检、视频和导出策略，全部确认后再开始连续执行。");
      if (firstQuestion) {
        setPopoverOverride(firstQuestion);
      } else {
        await runFullAutoOriginalScriptPlan(plan, { startIndex: 0 });
      }
    },
    [
      commitFullAutoRunState,
      push,
      resetComposerDraft,
      runFullAutoOriginalScriptPlan,
      setMode,
      setPopoverOverride,
      setSelectedValues,
      setSuggested,
      videoGenerationPrefs,
    ],
  );

  const handleFullAutoChoiceSelect = useCallback(
    (value: string, label: string, question?: ComposerQuestion | null): boolean => {
      const run = runtimeRef.current.fullAutoRun;
      if (!run?.plan) return false;

      if (run.status === "collecting" && isFullAutoStrategyQuestion(question)) {
        const nextPlan = applyFullAutoStrategyAnswer(run.plan, value, label, question);
        if (!nextPlan) return false;
        const nextQuestion = getNextFullAutoStrategyQuestion(nextPlan);
        const nextState: FullAutoRunState = {
          status: nextQuestion ? "collecting" : "running",
          plan: nextPlan,
          currentStepIndex: 0,
          currentStepLabel: nextQuestion?.title ?? "准备执行",
        };
        commitFullAutoRunState(nextState);
        setSelectedValues([]);
        if (nextQuestion) {
          setPopoverOverride(nextQuestion);
          setSuggested(null);
        } else {
          setPopoverOverride(null);
          setSuggested(null);
          void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: 0 });
        }
        return true;
      }

      if (run.status === "stopped" || run.status === "paused" || run.status === "failed") {
        const steps = buildFullAutoExecutionSteps(run.plan);
        const currentStepIndex = Math.max(0, Math.min(run.currentStepIndex, steps.length - 1));
        const nextPlan = updateFullAutoStepStrategy(run.plan, steps[currentStepIndex], value, label);
        setSelectedValues([]);
        setPopoverOverride(null);
        setSuggested(null);
        void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: currentStepIndex });
        return true;
      }

      return false;
    },
    [
      commitFullAutoRunState,
      runFullAutoOriginalScriptPlan,
      runtimeRef,
      setPopoverOverride,
      setSelectedValues,
      setSuggested,
    ],
  );

  const stopFullAutoExecution = useCallback(
    (): StopActiveExecutionResult => {
      const run = runtimeRef.current.fullAutoRun;
      const cancelledRemoteVideoTaskCount = cancelTrackedRemoteVideoTasks();
      const hadActiveExecution =
        Boolean(activeExecutionAbortRef.current) ||
        run?.status === "collecting" ||
        run?.status === "running" ||
        run?.status === "retrying";

      activeExecutionAbortRef.current?.abort();
      engineRef.current?.interrupt();
      engineRef.current = null;
      streamingMessageIdRef.current = null;
      setStreaming(false);

      if (run?.plan) {
        const currentStepIndex = Math.max(0, Math.min(run.currentStepIndex, run.plan.steps.length - 1));
        const step = run.plan.steps[currentStepIndex];
        const stoppedPlan = {
          ...markFullAutoSteps(run.plan, currentStepIndex, "stopped"),
          stoppedStepId: step?.id,
          resumeFromStepId: step?.id,
        };
        commitFullAutoRunState({
          status: "stopped",
          plan: stoppedPlan,
          currentStepIndex,
          currentStepLabel: step?.label,
          stoppedByUser: true,
        });
        const restoreQuestion = runtimeRef.current.currentProjectSnapshot
          ? recQuestion(runtimeRef.current.currentProjectSnapshot, runtimeRef.current.currentVideoProject)
          : null;
        if (restoreQuestion) {
          setMode("active");
          setPopoverOverride(restoreQuestion);
          setSuggested(null);
        }
        push(
          "assistant",
          cancelledRemoteVideoTaskCount > 0
            ? `全自动执行已停止，并已向视频生成服务发起 ${cancelledRemoteVideoTaskCount} 条撤销请求。选择当前步骤选项后会继续自动链路。`
            : "全自动执行已停止。选择当前步骤选项后会继续自动链路，模式仍保持全自动。",
        );
      }

      return {
        hadActiveExecution,
        cancelledRemoteVideoTaskCount,
      };
    },
    [
      commitFullAutoRunState,
      engineRef,
      push,
      runtimeRef,
      setMode,
      setPopoverOverride,
      setStreaming,
      setSuggested,
    ],
  );

  const updateStreamingMessage = useCallback((updater: (message: HomeAgentMessage | null) => HomeAgentMessage) => {
    setMessages((prev) => {
      const sid = streamingMessageIdRef.current;
      if (!sid) {
        const next = updater(null);
        streamingMessageIdRef.current = next.id;
        return [...prev, next];
      }

      const index = prev.findIndex((message) => message.id === sid);
      if (index === -1) {
        const next = updater(null);
        streamingMessageIdRef.current = next.id;
        return [...prev, next];
      }

      const current = prev[index] ?? null;
      const next = updater(current);
      if (next.id !== sid) {
        streamingMessageIdRef.current = next.id;
      }
      return [...prev.slice(0, index), next, ...prev.slice(index + 1)];
    });
  }, [setMessages]);

  const appendStreamingDelta = useCallback((delta: string) => {
    updateStreamingMessage((message) => {
      if (message) {
        return {
          ...message,
          content: message.content + delta,
          status: "pending",
          streamLabel: "继续分析中",
        };
      }

      return {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: delta,
        createdAt: new Date().toISOString(),
        status: "pending",
        streamLabel: "继续分析中",
      };
    });
  }, [updateStreamingMessage]);

  const updateStreamingLabel = useCallback((label?: string) => {
    if (!streamingMessageIdRef.current) return;
    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      status: "pending",
      streamLabel: label || "继续分析中",
    }));
  }, [updateStreamingMessage]);

  const finalizeStreamingMessage = useCallback((
    finalText?: string,
    artifactIds?: string[],
    artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
  ) => {
    const resolvedArtifactSnapshots =
      artifactSnapshots?.length
        ? artifactSnapshots
        : resolveArtifactSnapshots(runtimeRef.current.currentProjectSnapshot, artifactIds);

    if (!streamingMessageIdRef.current) {
      if ((typeof finalText === "string" && finalText.trim()) || artifactIds?.length) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant" as const,
            content: typeof finalText === "string" ? finalText.trim() : "",
            createdAt: new Date().toISOString(),
            status: "complete",
            ...(artifactIds?.length ? { artifactIds } : {}),
            ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
          },
        ]);
      }
      return;
    }

    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      content:
        typeof finalText === "string"
          ? finalText.trim()
          : message?.content ?? "",
      status: "complete",
      streamLabel: undefined,
      ...(artifactIds?.length ? { artifactIds } : {}),
      ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
    }));
    streamingMessageIdRef.current = null;
  }, [runtimeRef, setMessages, updateStreamingMessage]);

  const ensureStreamingMessage = useCallback((label = "正在分析") => {
    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      status: "pending",
      streamLabel: message?.streamLabel || label,
    }));
  }, [updateStreamingMessage]);

  const resolveDreaminaCapability = useCallback(async (): Promise<DreaminaCapabilityState> => {
    if (dreaminaCapability.ready) return dreaminaCapability;
    if (!window.electronAPI?.dreaminaCli?.exec) {
      const fallback = { ready: true, available: false } satisfies DreaminaCapabilityState;
      setDreaminaCapability(fallback);
      return fallback;
    }

    try {
      const mod = await loadDreaminaCliModule();
      const status = await mod.dreaminaCliGetStatus();
      const next = {
        ready: true,
        available: status.loggedIn,
        message: status.message,
      } satisfies DreaminaCapabilityState;
      startTransition(() => {
        setDreaminaCapability(next);
      });
      return next;
    } catch {
      const fallback = { ready: true, available: false } satisfies DreaminaCapabilityState;
      setDreaminaCapability(fallback);
      return fallback;
    }
  }, [dreaminaCapability, loadDreaminaCliModule, setDreaminaCapability]);

  const getEngine = useCallback(async () => {
    engineRef.current = await getOrCreateHomeAgentEngine({
      existingEngine: engineRef.current,
      loadEngineDeps,
      loadApiConfigModule,
      messages: messagesRef.current,
      compactedMessageCount: compactedMessageCountRef.current,
      recentMessageSummary: runtimeRef.current.recentMessageSummary,
      systemPrompt,
      toQuery,
      getAppState: getRuntimeWithGenerationPrefs,
      setRuntime,
      setCompactedMessageCount: (count) => {
        compactedMessageCountRef.current = count;
        setCompactedMessageCount(count);
      },
      selectedTextModelKey,
    });
    return engineRef.current;
  }, [
    compactedMessageCountRef,
    engineRef,
    loadApiConfigModule,
    loadEngineDeps,
    messagesRef,
    systemPrompt,
    runtimeRef,
    selectedTextModelKey,
    getRuntimeWithGenerationPrefs,
    setCompactedMessageCount,
    setRuntime,
    toQuery,
  ]);

  const launchAutoResearchTasks = useCallback(
    async (nextPrompt: string) =>
      launchHomeAgentAutoResearchTasks({
        prompt: nextPrompt,
        runtime: runtimeRef.current,
        loadApiConfigModule,
        selectedTextModelKey,
      }),
    [loadApiConfigModule, runtimeRef, selectedTextModelKey],
  );

  const runDirectProjectImageGeneration = useCallback(
    async (
      imagePrompt: string,
      userBubble: string,
      batchCount = 1,
      imageKind: "character" | "scene" = "scene",
      abortSignal?: AbortSignal,
    ) => {
      try {
        throwIfAborted(abortSignal);
        const workflow = await loadWorkflowActionsModule();
        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const baseUi = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              if (projectId) {
                setActiveProjectId(projectId);
              }
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];
        const totalImageCount = Math.max(1, Math.min(8, Math.floor(batchCount)));
        let lastCompletion: Awaited<ReturnType<typeof runWorkflowShortcut>> | null = null;

        // 根据项目阶段生成简洁动态回复
        {
          const snapshot = runtimeRef.current.currentProjectSnapshot;
          const batchSuffix = totalImageCount > 1 ? ` ×${totalImageCount}` : "";
          const contentSummary = buildMediaContentSummary({
            action: "generate_project_image",
            promptText: imagePrompt,
            imageKind,
            runtime: runtimeRef.current,
          });
          let reply: string;
          if (snapshot) {
            const stage = snapshot.derivedStage ?? "";
            const actionLabel =
              stage.includes("分镜") || stage.includes("storyboard") ? "分镜图" :
              stage.includes("角色") || stage.includes("character") ? "角色图" :
              stage.includes("场景") || stage.includes("scene") ? "场景图" :
              stage.includes("概念") || stage.includes("concept") ? "概念图" : "图片";
            reply = `${actionLabel}生成中${batchSuffix}：《${snapshot.title}》${contentSummary ? `\n内容 ${contentSummary}` : ""}`;
          } else {
            reply = `图片生成中${batchSuffix}${contentSummary ? `\n内容 ${contentSummary}` : ""}`;
          }
          push("assistant", reply);
        }

        // 触发生成中 pending 状态（shimmer 动画 + 文本提示）
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generating-start", {
              detail: {
                count: totalImageCount,
                action: "generate_project_image",
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary: buildMediaContentSummary({
                  action: "generate_project_image",
                  promptText: imagePrompt,
                  imageKind,
                  runtime: runtimeRef.current,
                }),
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_project_image",
                  runtime: runtimeRef.current,
                }),
              },
            }),
          );
        }

        for (let index = 0; index < totalImageCount; index += 1) {
          throwIfAborted(abortSignal);
          const completion = await runWorkflowShortcut({
            action: "generate_project_image",
            input: {
              imagePrompt,
              prompt: imagePrompt,
              imageKind,
              selectedImageModelFamily,
              modelFamily: selectedImageModelFamily,
              imageGenerationPrefs: normalizedImagePrefs,
              aspectRatio: normalizedImagePrefs.aspectRatio,
              resolution: normalizedImagePrefs.resolution,
              batchIndex: index + 1,
              batchCount: totalImageCount,
              abortSignal,
            },
            runtime: runtimeRef.current,
            runAction: async (nextAction, nextInput, nextRuntime) => {
              const result = await workflow.runWorkflowAction(nextAction, nextInput, nextRuntime);
              if (result.imageUrls?.length) {
                generatedImageUrls.push(...result.imageUrls);
                if (result.imageLabels?.length) {
                  generatedImageLabels.push(...result.imageLabels);
                }
                return { ...result, summary: "" };
              }
              return result;
            },
            ui: {
              ...baseUi,
              pushUser: () => undefined,
            },
            userBubble,
            allowAutoFollowup: false,
            surfaceNextSuggestion: false,
            onErrorMessage: () => {
              restoreInterruptedChoiceQuestion?.(null);
            },
          });
          lastCompletion = completion;
          if (!completion) {
            break;
          }
        }

        if (generatedImageUrls.length && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generated", {
              detail: {
                imageUrls: generatedImageUrls,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
                action: "generate_project_image",
                count: generatedImageUrls.length,
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary: buildMediaContentSummary({
                  action: "generate_project_image",
                  promptText: imagePrompt,
                  imageKind,
                  runtime: runtimeRef.current,
                }),
              },
            }),
          );
        }
        if (generatedImageUrls.length) {
          applyWorkflowMediaFollowupQuestion({
            projectSnapshot: lastCompletion?.projectSnapshot,
            runtime: lastCompletion?.runtime,
            preferredQuestion: lastCompletion?.nextSuggestion,
            setSuggested,
            setPopoverOverride,
          });
        }
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) return;
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        setStreaming(false);
        push("assistant", error instanceof Error ? error.message : String(error));
      }
    },
    [
      imageGenerationPrefs,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      selectedImageModelFamily,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setRuntime,
      setStreaming,
      setSuggested,
      restoreInterruptedChoiceQuestion,
    ],
  );

  const runDirectVideoGeneration = useCallback(
    async (
      userBubble: string,
      promptText: string,
      mode: VideoGenerationPrefs["mode"],
      targetIds?: string[],
      abortSignal?: AbortSignal,
    ) => {
      let hasPendingVideoPlaceholder = false;
      try {
        throwIfAborted(abortSignal);
        setStreaming(true);

        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
          ...videoGenerationPrefs,
          modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
          mode,
        });
        const projectId =
          runtimeRef.current.currentProjectSnapshot?.projectKind === "video"
            ? runtimeRef.current.currentProjectSnapshot.projectId
            : runtimeRef.current.currentVideoProject?.id;

        if (!projectId) {
          if (mode === "image-to-video") {
            push("assistant", "当前这条请求缺少参考图，暂时不能直接走图生视频。请上传参考图，或改成文生视频。");
            return;
          }

          const directPrompt = String(promptText || "").trim();
          if (!directPrompt) {
            push("assistant", "这条视频请求还缺少明确的画面描述。请直接告诉我要生成什么视频。");
            return;
          }

          const resolvedModel = resolveVideoGenerationModelName(normalizedVideoPrefs);
          const provider = resolveVideoGenerationProvider(normalizedVideoPrefs);
          const submitResult = await invokeFunction<DirectVideoGenerationTaskResult>(
            "generate-video",
            {
              prompt: directPrompt,
              duration: 4,
              aspectRatio: "16:9",
              resolution: normalizedVideoPrefs.resolution,
              model: resolvedModel,
              provider,
            },
            { abortSignal },
          );
          if (submitResult.error) throw submitResult.error;
          throwIfAborted(abortSignal);

          const taskId = String(submitResult.data?.task_id || "").trim();
          const resolvedProvider = submitResult.data?.provider || provider;
          if (!taskId) {
            throw new Error("视频任务已提交，但没有返回任务 ID。");
          }

          trackActiveRemoteVideoTask({
            taskId,
            provider: resolvedProvider,
          });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:video-generating-start", {
              detail: {
                action: "generate-video",
                  model: resolvedModel,
                  resolution: normalizedVideoPrefs.resolution,
                  mode,
                  provider: resolvedProvider,
                  sceneCount: 1,
                  count: 1,
                  contentSummary: buildMediaContentSummary({
                    action: "generate_video_assets",
                    promptText: promptText,
                    runtime: runtimeRef.current,
                    targetIds,
                  }),
                  targetLabels: buildWorkflowMediaTargetLabels({
                    action: "generate_video_assets",
                    runtime: runtimeRef.current,
                    targetIds,
                  }),
                },
              }),
            );
            hasPendingVideoPlaceholder = true;
          }

          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (attempt > 0) {
              await waitForAbortableDelay(10_000, abortSignal);
            }
            throwIfAborted(abortSignal);

            const statusResult = await invokeFunction<DirectVideoGenerationStatusResult>(
              "generate-video",
              {
                action: "status",
                taskId,
                provider: resolvedProvider,
              },
              { abortSignal },
            );
            if (statusResult.error) throw statusResult.error;
            throwIfAborted(abortSignal);

            const normalizedStatus = String(statusResult.data?.status || "").trim().toLowerCase();
            const videoUrl = String(statusResult.data?.video_url || "").trim();

            if ((normalizedStatus === "succeeded" || normalizedStatus === "completed") && videoUrl) {
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("agent:video-generated", {
                    detail: {
                      videoUrls: [videoUrl],
                      action: "generate-video",
                      count: 1,
                      model: resolvedModel,
                      resolution: normalizedVideoPrefs.resolution,
                      provider: resolvedProvider,
                      mode,
                      contentSummary: buildMediaContentSummary({
                        action: "generate_video_assets",
                        promptText: promptText,
                        runtime: runtimeRef.current,
                        targetIds,
                      }),
                    },
                  }),
                );
              }
              untrackActiveRemoteVideoTask(taskId, resolvedProvider);
              return;
            }

            if (
              normalizedStatus === "failed" ||
              normalizedStatus === "error" ||
              normalizedStatus === "cancelled"
            ) {
              untrackActiveRemoteVideoTask(taskId, resolvedProvider);
              throw new Error("视频生成失败，请换一个描述或稍后重试。");
            }
          }

          return;
        }

        const workflow = await loadWorkflowActionsModule();
        const workflowInput = {
          projectId,
          ...(targetIds?.length ? { targetIds } : {}),
          selectedImageModelFamily,
          imageGenerationPrefs: normalizedImagePrefs,
          selectedVideoModelKey: normalizedVideoPrefs.modelKey,
          videoModelKey: normalizedVideoPrefs.modelKey,
          videoGenerationPrefs: normalizedVideoPrefs,
        };

        let nextRuntime = runtimeRef.current;
        const applyWorkflowResult = (
          result: Awaited<ReturnType<typeof workflow.runWorkflowAction>>,
          pushSummary = true,
        ) => {
          if (result.data) {
            nextRuntime = mergeRuntimeWithWorkflowDelta(nextRuntime, result.data);
            syncTrackedRemoteVideoTasksFromRuntime(nextRuntime);
            startTransition(() => {
              setRuntime(nextRuntime);
              if (nextRuntime.currentProjectSnapshot?.projectId) {
                setActiveProjectId(nextRuntime.currentProjectSnapshot.projectId);
              }
            });
          }

          if (pushSummary && result.summary.trim()) {
            push("assistant", result.summary.trim());
          }

          if (result.videoUrls?.length && typeof window !== "undefined") {
            const matchingSceneIds = (nextRuntime.currentVideoProject?.scenes ?? [])
              .filter((s) => result.videoUrls!.includes(s.videoUrl ?? ""))
              .map((s) => s.id);
            const contentSummary = buildMediaContentSummary({
              action: "generate_video_assets",
              runtime: nextRuntime,
              targetIds: matchingSceneIds.length ? matchingSceneIds : undefined,
            });
            window.dispatchEvent(
              new CustomEvent("agent:video-generated", {
                detail: { videoUrls: result.videoUrls, ...(contentSummary ? { contentSummary } : {}) },
              }),
            );
          }

          return result;
        };

        const assetStatus = await workflow.runWorkflowAction(
          "query_asset_status",
          { ...workflowInput, abortSignal },
          nextRuntime,
        );
        applyWorkflowResult(assetStatus, false);
        throwIfAborted(abortSignal);

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:video-generating-start", {
              detail: {
                action: "generate_video_assets",
                model: normalizedVideoPrefs.modelKey,
                resolution: normalizedVideoPrefs.resolution,
                mode,
                provider: normalizedVideoPrefs.provider,
                sceneCount: Math.max(1, targetIds?.length ?? 1),
                count: Math.max(1, targetIds?.length ?? 1),
                aspectRatio: normalizedVideoPrefs.aspectRatio,
                contentSummary: buildMediaContentSummary({
                  action: "generate_video_assets",
                  promptText: promptText,
                  runtime: runtimeRef.current,
                  targetIds,
                }),
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_video_assets",
                  runtime: runtimeRef.current,
                  targetIds,
                }),
              },
            }),
          );
          hasPendingVideoPlaceholder = true;
        }

        const generateResult = await workflow.runWorkflowAction(
          "generate_video_assets",
          { ...workflowInput, abortSignal },
          nextRuntime,
          (partial) => applyWorkflowResult(partial, false),
        );
        applyWorkflowResult(generateResult, false);
        throwIfAborted(abortSignal);

        applyWorkflowMediaFollowupQuestion({
          projectSnapshot: nextRuntime.currentProjectSnapshot,
          runtime: nextRuntime,
          setSuggested,
          setPopoverOverride,
        });

      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) return;
        if (hasPendingVideoPlaceholder && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:video-generating-cancelled"));
        }
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        push("assistant", error instanceof Error ? error.message : String(error));
      } finally {
        setStreaming(false);
      }
    },
    [
      imageGenerationPrefs,
      invokeFunction,
      loadWorkflowActionsModule,
      push,
      runtimeRef,
      syncTrackedRemoteVideoTasksFromRuntime,
      selectedImageModelFamily,
      selectedVideoModelKey,
      setActiveProjectId,
      setPopoverOverride,
      restoreInterruptedChoiceQuestion,
      setRuntime,
      setStreaming,
      setSuggested,
      trackActiveRemoteVideoTask,
      untrackActiveRemoteVideoTask,
      videoGenerationPrefs,
    ],
  );

  const runDirectStoryboardGeneration = useCallback(
    async (
      userBubble: string,
      targetIds?: string[],
      abortSignal?: AbortSignal,
    ) => {
      try {
        throwIfAborted(abortSignal);
        const workflow = await loadWorkflowActionsModule();
        const projectId =
          runtimeRef.current.currentProjectSnapshot?.projectKind === "video"
            ? runtimeRef.current.currentProjectSnapshot.projectId
            : runtimeRef.current.currentVideoProject?.id;

        if (!projectId) {
          push("assistant", "当前还没有可用的视频项目，暂时不能直接生成分镜图。");
          return;
        }

        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const baseUi = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, nextProjectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              if (nextProjectId) {
                setActiveProjectId(nextProjectId);
              }
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generating-start", {
              detail: {
                count: 1,
                action: "generate_storyboard_frames",
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary: buildMediaContentSummary({
                  action: "generate_storyboard_frames",
                  promptText: userBubble,
                  runtime: runtimeRef.current,
                  targetIds,
                }),
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_storyboard_frames",
                  runtime: runtimeRef.current,
                  targetIds,
                }),
              },
            }),
          );
        }

        const completion = await runWorkflowShortcut({
          action: "generate_storyboard_frames",
          input: {
            projectId,
            ...(targetIds?.length ? { targetIds } : {}),
            selectedImageModelFamily,
            modelFamily: selectedImageModelFamily,
            imageGenerationPrefs: normalizedImagePrefs,
            aspectRatio: normalizedImagePrefs.aspectRatio,
            resolution: normalizedImagePrefs.resolution,
            abortSignal,
          },
          runtime: runtimeRef.current,
          runAction: async (nextAction, nextInput, nextRuntime) => {
            const result = await workflow.runWorkflowAction(nextAction, nextInput, nextRuntime);
            if (result.imageUrls?.length) {
              generatedImageUrls.push(...result.imageUrls);
            }
            if (result.imageLabels?.length) {
              generatedImageLabels.push(...result.imageLabels);
            }
            return result;
          },
          ui: {
            ...baseUi,
            pushUser: () => undefined,
          },
          userBubble,
          allowAutoFollowup: false,
          surfaceNextSuggestion: false,
          onErrorMessage: () => {
            restoreInterruptedChoiceQuestion?.(null);
          },
        });

        if (generatedImageUrls.length && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generated", {
              detail: {
                imageUrls: generatedImageUrls,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
                action: "generate_storyboard_frames",
                count: generatedImageUrls.length,
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary: buildMediaContentSummary({
                  action: "generate_storyboard_frames",
                  promptText: userBubble,
                  runtime: runtimeRef.current,
                  targetIds,
                }),
              },
            }),
          );
        }

        if (generatedImageUrls.length) {
          applyWorkflowMediaFollowupQuestion({
            projectSnapshot: completion?.projectSnapshot,
            runtime: completion?.runtime,
            preferredQuestion: completion?.nextSuggestion,
            setSuggested,
            setPopoverOverride,
          });
        }
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) return;
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        setStreaming(false);
        push("assistant", error instanceof Error ? error.message : String(error));
      }
    },
    [
      imageGenerationPrefs,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      selectedImageModelFamily,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setRuntime,
      setStreaming,
      setSuggested,
      restoreInterruptedChoiceQuestion,
    ],
  );

  const send = useCallback(
    async (
      rawPrompt: MessageInput,
      shown?: string,
      sendOpts?: {
        skipUserBubble?: boolean;
        attachments?: ChatAttachment[];
        workflowAttachments?: ChatAttachment[];
        disableAutoResearch?: boolean;
      },
    ) => {
      const runId = sendRunIdRef.current + 1;
      sendRunIdRef.current = runId;
      const executionController = new AbortController();
      activeExecutionAbortRef.current = executionController;
      const prepared = beginSendFlow({
        prompt: rawPrompt,
        shown,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        attachments: sendOpts?.attachments,
        skipUserBubble: sendOpts?.skipUserBubble,
      });
      if (!prepared) {
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }
      const cleaned = prepared.cleanedText;

      const directImageIntent = resolveDirectProjectImageIntent(cleaned);
      if (directImageIntent && !sendOpts?.skipUserBubble && !sendOpts?.attachments?.length) {
        await runDirectProjectImageGeneration(
          directImageIntent.imagePrompt,
          (shown || cleaned).trim(),
          directImageIntent.batchCount,
          directImageIntent.imageKind,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const directStoryboardIntent = resolveDirectStoryboardGenerationIntent(cleaned, {
        hasActiveVideoProject: Boolean(runtimeRef.current.currentVideoProject),
        snapshot: runtimeRef.current.currentProjectSnapshot,
        videoProject: runtimeRef.current.currentVideoProject,
      });
      if (directStoryboardIntent && !sendOpts?.skipUserBubble && !sendOpts?.attachments?.length) {
        await runDirectStoryboardGeneration(
          (shown || cleaned).trim(),
          directStoryboardIntent.targetIds,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const directVideoIntent = resolveDirectVideoGenerationIntent(cleaned, {
        hasActiveVideoProject: Boolean(runtimeRef.current.currentVideoProject),
        snapshot: runtimeRef.current.currentProjectSnapshot,
        videoProject: runtimeRef.current.currentVideoProject,
      });
      if (directVideoIntent && !sendOpts?.skipUserBubble && !sendOpts?.attachments?.length) {
        await runDirectVideoGeneration(
          (shown || cleaned).trim(),
          cleaned,
          directVideoIntent.mode,
          directVideoIntent.targetIds,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      if (pendingAdaptationUploadRef.current && sendOpts?.attachments?.length) {
        pendingAdaptationUploadRef.current = false;
        const uploadReference = extractAdaptationReferenceUpload(sendOpts.attachments);

        if (!uploadReference?.referenceScript.trim()) {
          push(
            "assistant",
            "已收到文档，但暂时没有提取到可用的参考文本。请改传可解析正文的 txt、docx 或 pdf，或先把参考文本粘贴到输入框后再继续参考改编。",
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        push("assistant", buildAdaptationUploadExtractionSummary(uploadReference));
        const workflow = await loadWorkflowActionsModule();
        const ui = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              if (projectId) {
                setActiveProjectId(projectId);
              }
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });

        const workflowCompletion = await runWorkflowShortcut({
          action: "save_setup",
          input: {
            projectKind: "adaptation",
            referenceScript: uploadReference.referenceScript,
            ...(uploadReference.title ? { title: uploadReference.title } : {}),
          },
          runtime: runtimeRef.current,
          runAction: (nextAction, nextInput, nextRuntime) =>
            workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
          ui: {
            ...ui,
            pushUser: () => undefined,
          },
          userBubble: "",
          allowAutoFollowup: false,
          surfaceNextSuggestion: true,
        });

        if (workflowCompletion?.nextSuggestion) {
          setPopoverOverride(workflowCompletion.nextSuggestion);
          setSuggested(null);
        }

        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const workflowAttachments =
        sendOpts?.workflowAttachments?.length ? sendOpts.workflowAttachments : sendOpts?.attachments;

      if (pendingVideoUploadRef.current && !workflowAttachments?.length) {
        push("assistant", "我还在等你上传剧本文档。请通过回形针上传 txt、docx 或 pdf 后直接发送。");
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      if (pendingVideoUploadRef.current && workflowAttachments?.length) {
        const rawUploadScript = extractVideoWorkflowUploadScript(workflowAttachments);

        if (!rawUploadScript?.script.trim()) {
          push(
            "assistant",
            "已收到文档，但暂时没有提取到可用的剧本文本。请改传可解析正文的 txt、docx 或 pdf，或先把脚本文本粘贴到输入框后再继续视频工作流。",
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        let uploadScript = rawUploadScript;
        push("assistant", "已收到文档，正在识别可用于视频拆解的剧本正文...");
        try {
          uploadScript = await recognizeVideoWorkflowUploadScript(rawUploadScript, {
            abortSignal: executionController.signal,
          });
        } catch (error) {
          if (hasEpisodeScriptBody(rawUploadScript.script)) {
            uploadScript = rawUploadScript;
          } else {
            push(
              "assistant",
              `已收到文档，但暂时没有识别到可用于拆解的剧本正文：${error instanceof Error ? error.message : String(error)}。请改传包含正文的 txt、docx 或 pdf，或把正文粘贴到输入框后继续。`,
            );
            if (activeExecutionAbortRef.current === executionController) {
              activeExecutionAbortRef.current = null;
            }
            return;
          }
        }

        if (!hasEpisodeScriptBody(uploadScript.script)) {
          push(
            "assistant",
            `已收到文档，但其中没有识别到可继续拆解的分集正文。目前只支持按入口 A 的正文剧本链路推进视频工作流；如果你上传的是创意方案、结构转译或分集简介，请改传包含"1-1"这类分场编号正文的剧本格式后再继续。`,
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        pendingVideoUploadRef.current = false;

        push(
          "assistant",
          [buildVideoUploadExtractionSummary(uploadScript), uploadScript.extractionSummary?.trim()]
            .filter(Boolean)
            .join("；"),
        );

        const workflow = await loadWorkflowActionsModule();
        const ui = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              if (projectId) {
                setActiveProjectId(projectId);
              }
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });

        const workflowCompletion = await runWorkflowShortcut({
          action: "prepare_video_generation",
          input: {
            projectKind: "video",
            script: uploadScript.script,
            ...(uploadScript.title ? { title: uploadScript.title } : {}),
            abortSignal: executionController.signal,
          },
          runtime: runtimeRef.current,
          runAction: (nextAction, nextInput, nextRuntime) =>
            workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
          ui: {
            ...ui,
            pushUser: () => undefined,
          },
          userBubble: "",
          allowAutoFollowup: creationMode === "fast",
          surfaceNextSuggestion: true,
          onError: () => {
            if (qState) {
              setQState(qState);
            }
          },
        });

        const preparedVideoProject =
          workflowCompletion?.data?.videoProject ?? workflowCompletion?.runtime?.currentVideoProject;
        const needsBridgeResearch = Boolean(
          workflowCompletion?.projectSnapshot?.projectKind === "video" &&
            !(
              preparedVideoProject?.targetPlatform?.trim() &&
              preparedVideoProject?.shotStyle?.trim() &&
              preparedVideoProject?.outputGoal?.trim()
            ),
        );

        if (workflowCompletion && needsBridgeResearch) {
          if (!openVideoKickoffPrefQuestion(workflowCompletion.projectSnapshot)) {
            await launchAutomaticVideoBridgeResearch({
              workflowRuntime: workflowCompletion.runtime,
              projectSnapshot: workflowCompletion.projectSnapshot,
            });
          }
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        if (creationMode === "creative" && workflowCompletion && !workflowCompletion.nextSuggestion) {
          await send(
            buildWorkflowContinuationPrompt({
              action: workflowCompletion.action,
              summary: workflowCompletion.summary,
              projectSnapshot: workflowCompletion.projectSnapshot,
            }),
            undefined,
            { skipUserBubble: true },
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        if (applyVideoKickoffFollowupQuestion({
          workflowCompletion,
          setSuggested,
          setPopoverOverride,
          push,
        })) {
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const autoResearchPlan = sendOpts?.disableAutoResearch
        ? null
        : buildAutoResearchPlan(cleaned, runtimeRef.current.currentProjectSnapshot);
      const canOfferQuickResearchChoice =
        !runtimeRef.current.currentProjectSnapshot && messagesRef.current.length <= 1;
      const hasTrackKeyword = /市场|风格|卖点|路线|平台|受众|改编|角色|出片/.test(cleaned);
      // 改编研究（改编路线 / 受众适配 / 角色重塑）暂时隐藏，不触发气泡框也不走 LLM overlay
      // 发附件时也不触发，避免附件内容被误判为研究意图
      if (autoResearchPlan && autoResearchPlan.reason !== "adaptation-research" && canOfferQuickResearchChoice && hasTrackKeyword && !sendOpts?.attachments?.length) {
        pendingAutoResearchPlanRef.current = autoResearchPlan;
        pendingAutoResearchSelectionsRef.current = {};
        push(
          "assistant",
          `我已整理出 3 个快捷研究任务：${autoResearchPlan.tasks.map((t) => t.title).join("、")}。现在按顺序确认：${autoResearchPlan.tasks.map((t) => t.title).join(" → ")}。`,
        );
        setPopoverOverride(null);
        setSuggested(buildAutoResearchChoiceQuestion(autoResearchPlan));
        setMode("active");
        return;
      }

      // engine 创建前把 overlay 数据获取并行执行
      const enginePromise = getEngine();

      // 有附件时不触发任何研究任务，避免附件内容被误判为研究意图
      const effectiveLaunchAutoResearchTasks = sendOpts?.attachments?.length || sendOpts?.disableAutoResearch
        ? async () => null
        : launchAutoResearchTasks;
      const overlayResult = await applyAllOverlaysParallel({
        cleaned,
        launchAutoResearchTasks: effectiveLaunchAutoResearchTasks,
        push,
        buildResearchPromptOverlay,
        runtime: runtimeRef.current,
        loadConversationMemoryModule,
        loadProjectStore,
        readProjectSession: readStudioProjectSession,
        flashMaintenanceHint,
        currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot,
        dreaminaCapability,
        resolveDreaminaCapability,
        isVideoIntentPrompt,
        buildDreaminaCapabilityOverlay,
        hasSurfacedHint: surfacedDreaminaHintRef.current,
        loadLearningOverlayModule: () => import("@/lib/home-agent/agent-learning-overlay"),
      });
      let promptForEngine =
        typeof prepared.promptForEngine === "string"
          ? overlayResult.promptForEngine
          : appendTextOverlayToInput(
              prepared.promptForEngine,
              overlayResult.promptForEngine.startsWith(cleaned)
                ? overlayResult.promptForEngine.slice(cleaned.length).trim()
                : overlayResult.promptForEngine.trim(),
            );
      if (creationMode === "creative") {
        promptForEngine = appendTextOverlayToInput(
          promptForEngine,
          buildLlmConversationOverlay({
            runtime: runtimeRef.current,
            deferredQuestionState,
          }),
        );
      }
      surfacedDreaminaHintRef.current = overlayResult.surfacedHint;

      setStreaming(true);
      streamingMessageIdRef.current = null;
      ensureStreamingMessage();
      const workflowArtifactSignatures = createArtifactSignatureMap(
        runtimeRef.current.currentProjectSnapshot,
      );
      let pendingArtifacts: import("@/lib/home-agent/types").ConversationArtifact[] = [];

      try {
        const activeEngine = await enginePromise;
        throwIfAborted(executionController.signal);
        const sendSessionId = runtimeRef.current.sessionId;
        for await (const event of activeEngine.submitMessage(promptForEngine)) {
          if (sendRunIdRef.current !== runId) break;
          if (engineRef.current !== activeEngine) break;
          if (runtimeRef.current.sessionId !== sendSessionId) break;

          const changedArtifacts = collectChangedArtifactsFromSdkUserMessage(
            event,
            workflowArtifactSignatures,
          );
          if (changedArtifacts.length) {
            const pendingArtifactMap = new Map(
              pendingArtifacts.map((artifact) => [artifact.id, artifact]),
            );
            changedArtifacts.forEach((artifact) => {
              pendingArtifactMap.set(artifact.id, artifact);
            });
            pendingArtifacts = [...pendingArtifactMap.values()];
          }

          await handleSendEngineEvent({
            event,
            loadStructuredQuestionParser,
            textOf,
            push,
            appendStreamingDelta,
            updateStreamingLabel,
            finalizeStreamingMessage,
            setQuestionRequest: (request) => setQState(createQuestionState(request)),
            consumePendingArtifacts: () => {
              if (!pendingArtifacts.length) return undefined;
              const nextArtifacts = [...pendingArtifacts];
              pendingArtifacts = [];
              return nextArtifacts;
            },
          });
        }
      } catch (error) {
        if (sendRunIdRef.current === runId) {
          if (isAbortLikeError(error) || executionController.signal.aborted) {
            return;
          }
          streamingMessageIdRef.current = null;
          if (isTimeoutLikeError(error)) {
            restoreInterruptedChoiceQuestion?.(null);
          }
          push("assistant", error instanceof Error ? error.message : String(error));
          if (lastSuggestedRef.current) {
            setSuggested(lastSuggestedRef.current);
          }
        }
      } finally {
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        if (sendRunIdRef.current === runId) {
          setStreaming(false);
        }
      }
    },
    [
      appendStreamingDelta,
      buildResearchPromptOverlay,
      createQuestionState,
      dreaminaCapability,
      engineRef,
      ensureStreamingMessage,
      finalizeStreamingMessage,
      flashMaintenanceHint,
      getEngine,
      launchAutoResearchTasks,
      loadConversationMemoryModule,
      loadProjectStore,
      loadStructuredQuestionParser,
      loadWorkflowActionsModule,
      push,
      qState,
      resetComposerDraft,
      resolveDreaminaCapability,
      runDirectProjectImageGeneration,
      runDirectStoryboardGeneration,
      runDirectVideoGeneration,
      messagesRef,
      runtimeRef,
      creationMode,
      deferredQuestionState,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setStreaming,
      setSuggested,
      sendRunIdRef,
      surfacedDreaminaHintRef,
      textOf,
      updateStreamingLabel,
      lastSuggestedRef,
      restoreInterruptedChoiceQuestion,
    ],
  );

  const reset = useCallback(() => {
    resetHomeAgentConversation({
      activeProjectId,
      qState,
      rejectQuestion: (requestId) => {
        void loadAskUserQuestionModule().then((mod) => {
          mod.rejectAskUserQuestion(requestId, "User reset conversation");
        });
      },
      interruptEngine: () => {
        engineRef.current?.interrupt();
        engineRef.current = null;
      },
      clearSurfacedTasks: () => {
        surfacedTaskIdsRef.current.clear();
        surfacedTaskFollowupIdsRef.current.clear();
      },
      setQState,
      setDeferredQuestionState,
      setPopoverOverride,
      setSuggested,
      setSelectedValues,
      setDeferredSelectedValues,
      setMode,
      setMessages,
      resetComposerDraft,
      setDeferredDraft,
      setCompactedMessageCount,
      setActiveProjectId,
      resetRuntime: () => resetRuntimeState(setRuntime),
      setMetaReady,
    });
  }, [
    activeProjectId,
    engineRef,
    loadAskUserQuestionModule,
    qState,
    resetComposerDraft,
    setActiveProjectId,
    setCompactedMessageCount,
    setDeferredDraft,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setMessages,
    setMetaReady,
    setMode,
    setPopoverOverride,
    setQState,
    setRuntime,
    setSelectedValues,
    setSuggested,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
  ]);

  const answer = useCallback(
    (value: string, label?: string) => {
      answerHomeAgentQuestion({
        qState,
        value,
        label,
        qStepKey,
        setSuggested,
        send,
        push,
        resolveQuestion: async (requestId, output) => {
          try {
            const mod = await loadAskUserQuestionModule();
            return mod.resolveAskUserQuestion(requestId, output);
          } catch {
            return false;
          }
        },
        completeOriginalScriptKickoff: async (completion) => {
          if (automationMode === "full-auto") {
            await beginFullAutoOriginalScriptCollection(completion);
            return;
          }

          const workflow = await loadWorkflowActionsModule();
          const ui = createWorkflowShortcutUiBridge({
            activateConversation: () => setMode("active"),
            clearChoiceUi: () => {
              setPopoverOverride(null);
              setSuggested(null);
            },
            commitRuntime: (nextRuntime, projectId) => {
              startTransition(() => {
                setRuntime(nextRuntime);
                if (projectId) {
                  setActiveProjectId(projectId);
                }
              });
            },
            getSuggestedQuestion: (snapshot, nextRuntime) =>
              snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          });

          const workflowCompletion = await runWorkflowShortcutChain({
            runtime: runtimeRef.current,
            runAction: (nextAction, nextInput, nextRuntime) =>
              workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
            steps: [
              {
                action: "save_setup",
                input: completion.setupInput,
              },
              {
                action: "generate_creative_plan",
                input: completion.setupInput,
              },
            ],
            ui,
            userBubble: completion.userBubble,
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: creationMode === "fast",
            onError: () => {
              if (qState) {
                setQState(qState);
              }
            },
          });
          if (creationMode === "creative" && workflowCompletion) {
            await send(
              buildWorkflowContinuationPrompt({
                action: workflowCompletion.action,
                summary: workflowCompletion.summary,
                projectSnapshot: workflowCompletion.projectSnapshot,
              }),
              undefined,
              { skipUserBubble: true },
            );
          }
        },
        completeAdaptationWorkflowKickoff: async (completion) => {
          if (completion.source === "upload-document") {
            push("user", completion.userBubble);
            push(
              "assistant",
              "好的，请通过下方的回形针按钮上传参考剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。我会先写入参考文本，再打开当前步骤原有的选择面板。",
            );
            pendingAdaptationUploadRef.current = true;
            return;
          }

          pendingAdaptationUploadRef.current = false;
          launchTemplateConversation({
            prompt: buildAdaptationWorkflowStartPrompt(),
            title: completion.userBubble,
            dreaminaAvailable: dreaminaCapability.available,
            flashMaintenanceHint,
            markDreaminaSurfaced: () => {
              surfacedDreaminaHintRef.current = true;
            },
            send,
          });
        },
        completeVideoWorkflowKickoff: async (completion) => {
          if (completion.source === "upload-document") {
            push("user", completion.userBubble);
            push(
              "assistant",
              "好的，请通过下方的回形针按钮上传你的剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。",
            );
            pendingVideoUploadRef.current = true;
            return;
          }

          const workflow = await loadWorkflowActionsModule();
          const ui = createWorkflowShortcutUiBridge({
            activateConversation: () => setMode("active"),
            clearChoiceUi: () => {
              setPopoverOverride(null);
              setSuggested(null);
            },
            commitRuntime: (nextRuntime, projectId) => {
              startTransition(() => {
                setRuntime(nextRuntime);
                if (projectId) {
                  setActiveProjectId(projectId);
                }
              });
            },
            getSuggestedQuestion: (snapshot, nextRuntime) =>
              snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          });

          const workflowCompletion = await runWorkflowShortcut({
            action: "prepare_video_generation",
            input: {
              projectKind: "video",
            },
            runtime: runtimeRef.current,
            runAction: (nextAction, nextInput, nextRuntime) =>
              workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
            ui,
            userBubble: completion.userBubble,
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: true,
            onError: () => {
              if (qState) {
                setQState(qState);
              }
            },
          });

          const preparedVideoProject =
            workflowCompletion?.data?.videoProject ?? workflowCompletion?.runtime?.currentVideoProject;
          const needsBridgeResearch = Boolean(
            workflowCompletion?.projectSnapshot?.projectKind === "video" &&
              !(
                preparedVideoProject?.targetPlatform?.trim() &&
                preparedVideoProject?.shotStyle?.trim() &&
                preparedVideoProject?.outputGoal?.trim()
              ),
          );

          if (workflowCompletion && needsBridgeResearch) {
            if (!openVideoKickoffPrefQuestion(workflowCompletion.projectSnapshot)) {
              await launchAutomaticVideoBridgeResearch({
                workflowRuntime: workflowCompletion.runtime,
                projectSnapshot: workflowCompletion.projectSnapshot,
              });
            }
            return;
          }

          if (applyVideoKickoffFollowupQuestion({
            workflowCompletion,
            setSuggested,
            setPopoverOverride,
            push,
          })) {
            return;
          }

          if (creationMode === "creative" && workflowCompletion && !workflowCompletion.nextSuggestion) {
            const scriptTitle = runtimeRef.current.currentProjectSnapshot?.title;
            const prompt = buildVideoWorkflowStartPrompt(completion.source, scriptTitle);
            await send(prompt, undefined, { skipUserBubble: true });
          }
        },
        setQState,
        setSelectedValues,
        resetComposerDraft,
      });
    },
    [
      dreaminaCapability.available,
      flashMaintenanceHint,
      loadAskUserQuestionModule,
      loadWorkflowActionsModule,
      launchAutomaticVideoBridgeResearch,
      openVideoKickoffPrefQuestion,
      automationMode,
      push,
      qState,
      qStepKey,
      resetComposerDraft,
      runtimeRef,
      send,
      creationMode,
      beginFullAutoOriginalScriptCollection,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const handleTemplateLaunch = useCallback(
    (templateId: string, templatePrompt: string, title: string) => {
      if (templateId === ORIGINAL_SCRIPT_TEMPLATE_ID) {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched original script quick task");
          });
        }
        pendingAdaptationUploadRef.current = false;
        push("user", title);
        push(
          "assistant",
          automationMode === "full-auto"
            ? "已切换为全自动原创剧本。请先一次性确认立项参数；确认完毕后我会代替用户连续发送指令并自动执行到视频导出。"
            : buildOriginalScriptKickoffIntro(),
        );
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        setQState(createQuestionState(buildOriginalScriptKickoffRequest(), "restored"));
        return;
      }

      if (templateId === VIDEO_WORKFLOW_TEMPLATE_ID) {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched video workflow quick task");
          });
        }
        pendingAdaptationUploadRef.current = false;
        const hasDramaProject = Boolean(runtimeRef.current.currentDramaProject?.id);
        push("user", title);
        push("assistant", buildVideoWorkflowKickoffIntro());
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        setQState(createQuestionState(buildVideoWorkflowKickoffRequest(hasDramaProject), "restored"));
        return;
      }

      if (templateId === "adaptation") {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched adaptation quick task");
          });
        }

        pendingAdaptationUploadRef.current = false;
        push("user", title);
        push("assistant", buildAdaptationWorkflowKickoffIntro());
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        setQState(createQuestionState(buildAdaptationWorkflowKickoffRequest(), "restored"));

        void (async () => {
          try {
            const workflow = await loadWorkflowActionsModule();
            const bootstrapRuntime = runtimeRef.current;
            const result = await workflow.runWorkflowAction(
              "save_setup",
              { projectKind: "adaptation", forceNewProject: true },
              bootstrapRuntime,
            );
            const nextProjectSnapshot =
              result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
            const nextRuntime = result.data
              ? mergeRuntimeWithWorkflowDelta(bootstrapRuntime, result.data)
              : bootstrapRuntime;

            if (nextProjectSnapshot?.projectId) {
              await writeProjectStudioSession({
                sessionId: nextRuntime.sessionId,
                mode: "active",
                creationMode,
                messages: [],
                currentProjectSnapshot: nextProjectSnapshot,
                recentMessageSummary: nextRuntime.recentMessageSummary,
                projectId: nextProjectSnapshot.projectId,
                selectedTextModelKey,
                selectedImageModelFamily,
                imageGenerationPrefs,
                selectedVideoModelKey,
                videoGenerationPrefs,
                selectedValues: [],
                deferredSelectedValues: [],
                draft: "",
                deferredDraft: "",
              });
            }

            runtimeRef.current = nextRuntime;
            if (result.data) {
              setRuntime(nextRuntime);
            }
            if (nextProjectSnapshot?.projectId) {
              setActiveProjectId(nextProjectSnapshot.projectId);
            }
          } catch {
            // Keep the template launch flowing even if placeholder project bootstrap fails.
          }
        })();
        return;
      }

      launchTemplateConversation({
        prompt: templatePrompt,
        title,
        dreaminaAvailable: dreaminaCapability.available,
        flashMaintenanceHint,
        markDreaminaSurfaced: () => {
          surfacedDreaminaHintRef.current = true;
        },
        send,
      });
    },
    [
      createQuestionState,
      dreaminaCapability.available,
      flashMaintenanceHint,
      loadAskUserQuestionModule,
      loadWorkflowActionsModule,
      push,
      qState,
      resetComposerDraft,
      runtimeRef,
      send,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setSelectedValues,
      setSuggested,
      surfacedDreaminaHintRef,
      automationMode,
    ],
  );

  const autoResearchChoiceHandler = useCallback(
    async (value: string, _label: string): Promise<boolean> => {
      if (!value.startsWith("auto-research:")) return false;
      const plan = pendingAutoResearchPlanRef.current;
      if (!plan) return true;
      const stepMatch = value.match(/^auto-research:step:(\d+):pick:(.+)$/);
      if (!stepMatch) return true;
      const [, stepIndexRaw] = stepMatch;
      const stepIndex = Number.parseInt(stepIndexRaw, 10);
      if (!Number.isFinite(stepIndex)) return true;
      const currentTask = plan.tasks[stepIndex];
      if (!currentTask) return true;

      pendingAutoResearchSelectionsRef.current[currentTask.id] = _label;

      const nextStepIndex = stepIndex + 1;
      const nextQuestion = buildAutoResearchStepQuestion(plan, nextStepIndex);
      if (nextQuestion) {
        setSuggested(nextQuestion);
        return true;
      }

      const selectedSummary = plan.tasks.map((task) => {
        const chosen = pendingAutoResearchSelectionsRef.current[task.id] ?? "暂不确定（默认建议）";
        return `${task.title}：${chosen}`;
      });
      const planOverride: AutoResearchPlan = {
        ...plan,
        tasks: plan.tasks.map((task) => {
          const chosen = pendingAutoResearchSelectionsRef.current[task.id] ?? "暂不确定（请先给默认建议）";
          return {
            ...task,
            prompt: `${task.prompt}\n\n用户已完成前置选择：${selectedSummary.join("；")}。\n当前任务重点选择：${task.title}=${chosen}。请严格围绕该选择给结论。`,
          };
        }),
      };
      const taskIdFilter = plan.tasks.map((task) => task.id);
      const selectedTitles = plan.tasks.map((task) => task.title);

      try {
        const launched = await launchHomeAgentAutoResearchTasks({
          prompt: "",
          runtime: runtimeRef.current,
          loadApiConfigModule,
          selectedTextModelKey,
          planOverride,
          taskIdFilter,
          sequential: true,
        });
        if (!launched) {
          push("assistant", "未能启动研究任务，请稍后重试。");
          return true;
        }
        push(
          "assistant",
          `已按顺序启动：${selectedTitles.join("、")}。你可以继续补充要求，结果会自动回流到当前会话。`,
        );
      } catch (error) {
        push("assistant", error instanceof Error ? error.message : "启动研究任务失败。");
      } finally {
        pendingAutoResearchPlanRef.current = null;
        pendingAutoResearchSelectionsRef.current = {};
        setSuggested(null);
        setPopoverOverride(null);
      }

      return true;
    },
    [loadApiConfigModule, push, runtimeRef, selectedTextModelKey, setPopoverOverride, setSuggested],
  );

  return {
    resolveDreaminaCapability,
    send,
    reset,
    answer,
    handleTemplateLaunch,
    autoResearchChoiceHandler,
    handleFullAutoChoiceSelect,
    stopFullAutoExecution,
    stopActiveExecution: (): StopActiveExecutionResult => {
      const hadActiveExecution =
        Boolean(activeExecutionAbortRef.current) ||
        Boolean(engineRef.current) ||
        pendingAdaptationUploadRef.current ||
        pendingVideoUploadRef.current;
      const cancelledRemoteVideoTaskCount = cancelTrackedRemoteVideoTasks();
      sendRunIdRef.current += 1;
      pendingAdaptationUploadRef.current = false;
      pendingVideoUploadRef.current = false;
      activeExecutionAbortRef.current?.abort();
      activeExecutionAbortRef.current = null;
      engineRef.current?.interrupt();
      engineRef.current = null;
      streamingMessageIdRef.current = null;
      setStreaming(false);
      return {
        hadActiveExecution,
        cancelledRemoteVideoTaskCount,
      };
    },
  };
}
