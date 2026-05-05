import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { MessageInput } from "@/lib/agent/types";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
  CreationMode,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { HomeAgentTextModelGroup } from "@/lib/home-agent/text-models";
import type { HomeAgentImageModelFamilyOption } from "@/lib/home-agent/image-models";
import type { HomeAgentVideoModelOption } from "@/lib/home-agent/video-models";
import type { HomeAgentImageStyleRecognitionResult } from "@/lib/home-agent/image-style-analysis";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import { cn } from "@/lib/utils";
import {
  HomeComposer,
  type HomeComposerLaunchNotice,
  type HomeComposerProps,
  type HomeComposerVideoTransportHint,
} from "./home-agent-shell";
import { DEV_GLOBAL_ACTIONS } from "./composer-choice-panel";
import type { ComposerWorkflowProgress } from "./ComposerChoiceModal";
import { buildConfirmedStructuredAnswer, handleHomeAgentChoiceSelection, submitHomeAgentComposer } from "./home-agent-session-actions";
import { buildVideoContinuationQuestion, recQuestion } from "./home-agent-project-questions";
import {
  canRewindOriginalScriptKickoff,
  isOriginalScriptKickoffRequest,
  rewindOriginalScriptKickoff,
  rewindOriginalScriptKickoffMessages,
} from "@/lib/home-agent/original-script-kickoff";
import { TARGET_MARKETS } from "@/types/drama";

type ChoiceHandler = (
  snapshot: ConversationProjectSnapshot,
  value: string,
  label: string,
  input?: Record<string, unknown>,
) => boolean;
type AutoResearchChoiceHandler = (value: string, label: string) => boolean | Promise<boolean>;

type WorkflowProgressEventState = {
  id: string;
  status: string;
  content: string;
};

function buildCmdProgressBar(marks: string[]): string {
  if (!marks.length) return "[.]";
  if (marks.length <= 48) return `[${marks.join("")}]`;
  return `[${marks.slice(0, 22).join("")}...${marks.slice(-22).join("")}]`;
}

function getCmdProgressMark(status: string | undefined, hasContent = false): string {
  if (hasContent || status === "done") return "#";
  if (status === "processing") return ">";
  if (status === "failed") return "x";
  return ".";
}

function ensureCmdProgressStatusLabel(action: string | null, headline: string): string {
  if (headline.includes("[") && headline.includes("]")) return headline;
  if (action === "analyze_script_for_video") return "剧本拆解 [>] 初始化";
  if (action === "prepare_segment_video_prompt") return "片段提示词 [>] 初始化";
  return headline;
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
    (artifact) => artifact.kind === "setup" && artifact.payload?.type === "setup",
  )?.payload;
  const currentMarket = setupPayload?.type === "setup" ? setupPayload.targetMarket : undefined;

  return {
    id: `script-adaptation-target-market-${snapshot.projectId}`,
    title: "请选择目标市场",
    description:
      "目标市场会写入结构转换提示词，影响语言、节奏、审美和后续分集生成约束。",
    options: TARGET_MARKETS.map((market) => ({
      id: `${snapshot.projectId}-adaptation-target-market-${market.value}`,
      label: currentMarket === market.value ? `AI 推荐：${market.label}` : market.label,
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
  return value.replace(/\s+/g, "").replace(/[：:，,。.!！?？]/g, "").trim();
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

function isDevSelection(question: ComposerQuestion | null, value: string): boolean {
  if (DEV_GLOBAL_ACTIONS.some((action) => action.value === value)) return true;
  return Boolean(findOptionByValue(question, value)?.devOnly);
}

function isComplianceChoiceValue(value: string): boolean {
  return (
    value.startsWith("script:compliance-") ||
    value === "script:skip-compliance-review"
  );
}

function shouldPreserveHandledQuestion(question: ComposerQuestion | null, value: string): boolean {
  if (!question) return false;
  return (
    (question.answerKey === "script-episode" && value.startsWith("script:episode-duration:")) ||
    (question.answerKey.startsWith("script-compliance") && isComplianceChoiceValue(value)) ||
    value === "script:step-enter-episodes" ||
    question.answerKey === "video-bridge-prefix" ||
    question.answerKey.startsWith("video-kickoff-prefs-") ||
    question.answerKey === "video-analyze-duration" ||
    question.answerKey === "video-analyze-pace" ||
    (question.answerKey === "video-bridge-panel" && value === "video:bridge:platform") ||
    (question.answerKey === "video-bridge-panel" && value === "video:bridge:analyze") ||
    (question.answerKey === "review-stage-panel" && value === "video:export:all") ||
    (question.answerKey === "review-stage-panel" && value === "video:export:ai-auto") ||
    question.answerKey === "script-adaptation-target-market" ||
    value.startsWith("video:step:")
  );
}

function parsePendingEpisodeDurationSelection(selectedValues: string[]): number | undefined {
  const value = [...selectedValues].reverse().find((item) =>
    item.startsWith("script:episode-duration:"),
  );
  if (!value) return undefined;
  const rawDuration = value.replace(/^script:episode-duration:(?:custom:)?/, "");
  const durationSeconds = Number(rawDuration);
  return Number.isFinite(durationSeconds) ? Math.max(1, Math.round(durationSeconds)) : undefined;
}

function isEpisodeWritingChoice(value: string): boolean {
  return (
    value.startsWith("script:episode-generate:") ||
    value.startsWith("script:episode-generate-range:") ||
    value === "script:episode-generate-batch"
  );
}

function markSelectedQuestionOptions(
  question: ComposerQuestion | null,
  selectedValues: string[],
): ComposerQuestion | null {
  if (!question || selectedValues.length === 0) return question;
  const selectedSet = new Set(selectedValues);
  const markOption = (option: ComposerQuestionOption): ComposerQuestionOption => {
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
  setDeferredQuestionState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  setRuntime?: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setQState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
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
  handleFullAutoChoiceSelect?: (
    value: string,
    label: string,
    question: ComposerQuestion | null,
  ) => boolean;
  onLaunchAction?: (actionId: string) => void;
  activeTrackClassName: string;
  idleTrackClassName: string;
  lastSuggestedRef: React.MutableRefObject<ComposerQuestion | null>;
  interruptWorkflowShortcut: () => void;
  onGlobalInterrupt: () => void;
  clearInterruptRestoreQuestion: () => void;
  rememberInterruptRestoreQuestion: (question: ComposerQuestion | null) => void;
  attachedFiles?: File[];
  onAttachedFilesChange?: (files: File[]) => void;
  conversationMediaItems?: import("@/lib/agent/chat-attachments").ChatAttachment[];
}) {
  const {
    idle,
    currentProject,
    maintenanceHint,
    videoTransportHint,
    launchNotice,
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
    handleFullAutoChoiceSelect,
    onLaunchAction,
    activeTrackClassName,
    idleTrackClassName,
    lastSuggestedRef,
    interruptWorkflowShortcut,
    onGlobalInterrupt,
    clearInterruptRestoreQuestion,
    rememberInterruptRestoreQuestion,
    attachedFiles,
    onAttachedFilesChange,
    conversationMediaItems,
  } = params;

  const [workflowEventProgress, setWorkflowEventProgress] = useState<WorkflowProgressEventState | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowProgressEventState>).detail;
      if (!detail?.id) return;
      if (detail.status === "start" || detail.status === "progress" || detail.status === "update") {
        setWorkflowEventProgress(detail);
        return;
      }
      if (detail.status === "complete" || detail.status === "error") {
        setWorkflowEventProgress((current) => (current?.id === detail.id ? null : current));
      }
    };
    window.addEventListener("agent:workflow-progress", handler);
    return () => window.removeEventListener("agent:workflow-progress", handler);
  }, []);

  useEffect(() => {
    if (!activeWorkflowAction) {
      setWorkflowEventProgress(null);
    }
  }, [activeWorkflowAction]);

  const handleChoiceSelect = useCallback(
    (value: string, label: string) => {
      if (question) {
        rememberInterruptRestoreQuestion(question);
      }
      if (handleFullAutoChoiceSelect?.(value, label, question)) {
        return;
      }
      if (devMode && creationMode === "creative" && isDevSelection(question, value)) {
        const shouldDismissCurrentQuestion =
          !qState &&
          !!question &&
          !question.multiSelect &&
          (question.submissionMode !== "confirm" || question.options.length === 1);

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
        (question.submissionMode !== "confirm" || question.options.length === 1);

      const snapshot = runtimeRef.current.currentProjectSnapshot;
      if (
        question?.answerKey === "script-episode" &&
        snapshot &&
        (snapshot.projectKind === "script" || snapshot.projectKind === "adaptation") &&
        isEpisodeWritingChoice(value)
      ) {
        const durationSeconds = parsePendingEpisodeDurationSelection(selectedValues);
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
      handleFullAutoChoiceSelect,
      activeWorkflowAction,
      rememberInterruptRestoreQuestion,
      send,
    ],
  );

  const confirmStructuredAnswer = useCallback(() => {
    // When qState is null (e.g. recovery question), directly answer with the selected value
    if (!qState) {
      const pickedValues = question?.multiSelect ? selectedValues : selectedValues.slice(0, 1);
      if (pickedValues.length) {
        rememberInterruptRestoreQuestion(question);
        const labels = pickedValues.map((value) => question?.options.find((o) => o.value === value)?.label || value);
        const submittedValue = pickedValues.join(" / ");
        const displayValue = labels.join(" / ");
        const snapshot = runtimeRef.current.currentProjectSnapshot;
        if (
          question?.answerKey === "题材选择" &&
          (snapshot?.projectKind === "script" || snapshot?.projectKind === "adaptation") &&
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
    answer(nextAnswer.submittedValue, nextAnswer.displayValue || nextAnswer.submittedValue);
  }, [answer, draftRef, qState, question, rememberInterruptRestoreQuestion, runtimeRef, scriptProjectChoiceHandler, selectedValues, setSelectedValues, setSuggested]);

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
    const targetMarketQuestion = buildAdaptationTargetMarketBackQuestion(currentProject, question);
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
    handleOriginalScriptBack,
    question,
    resetComposerDraft,
    setMessages,
    setPopoverOverride,
    setRuntime,
    setSelectedValues,
    setSuggested,
  ]);

  const submitComposer = useCallback(() => {
    if (!question) {
      clearInterruptRestoreQuestion();
    }

    const freeformDraft = draftRef.current.trim();
    const snapshot = runtimeRef.current.currentProjectSnapshot;
    const freeformVideoChoice = !qState && !question
      ? resolveFreeformVideoChoice(
          snapshot,
          runtimeRef.current,
          freeformDraft,
          question,
          lastSuggestedRef.current,
        )
      : null;
    if (freeformVideoChoice && snapshot?.projectKind === "video") {
      videoProjectChoiceHandler(snapshot, freeformVideoChoice.value, freeformVideoChoice.label);
      resetComposerDraft("");
      return;
    }

    submitHomeAgentComposer({
      qState,
      question,
      draft: draftRef.current,
      attachmentsPresent: Boolean(attachedFiles?.length),
      confirmStructuredAnswer,
      deferQuestionToChat: qState
        ? () => {
            // 必须在 resetComposerDraft 清空 draftRef.current 之前保存草稿
            const draftToSend = draftRef.current;
            setDeferredQuestionState(qState);
            setDeferredSelectedValues(selectedValues);
            setDeferredDraft("");
            setQState(null);
            setSelectedValues([]);
            resetComposerDraft("");
            // 若引擎正阻塞在 AskUserQuestion 工具调用上（source === "live"），
            // 需先 reject 挂起的请求，再中断引擎，否则 send 无法执行
            if (qState.source === "live") {
              void import("@/lib/agent/tools/ask-user-question").then((mod) => {
                mod.rejectAskUserQuestion(qState.request.id, "User skipped question");
              });
              engineRef.current?.interrupt();
              engineRef.current = null;
            }
            void send(draftToSend);
          }
        : undefined,
      answer,
      send,
    });
  }, [
    answer,
    attachedFiles,
    clearInterruptRestoreQuestion,
    confirmStructuredAnswer,
    draftRef,
    engineRef,
    lastSuggestedRef,
    qState,
    question,
    resetComposerDraft,
    selectedValues,
    send,
    setDeferredDraft,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setQState,
    setSelectedValues,
    videoProjectChoiceHandler,
    runtimeRef,
  ]);

  const handleInterrupt = useCallback(() => {
    onGlobalInterrupt();
  }, [onGlobalInterrupt]);

  // 用户点击弹窗 X 关闭：若引擎正阻塞在工具调用上，先 reject 再中断
  const dismissQuestion = useCallback(() => {
    if (qState) {
      if (qState.source === "live") {
        void import("@/lib/agent/tools/ask-user-question").then((mod) => {
          mod.rejectAskUserQuestion(qState.request.id, "User dismissed question");
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
    if (!currentProject) {
      return null;
    }

    if (
      workflowEventProgress?.content &&
      (
        activeWorkflowAction === "analyze_script_for_video" ||
        activeWorkflowAction === "prepare_segment_video_prompt"
      )
    ) {
      const parts = workflowEventProgress.content.split(" · ").map((part) => part.trim()).filter(Boolean);
      const headline = parts[0] || workflowEventProgress.content;
      const progressMatch = headline.match(/(\d+)\/(\d+)/);
      const completed = progressMatch ? Number(progressMatch[1]) : 0;
      const total = progressMatch ? Math.max(Number(progressMatch[2]), 1) : 1;
      const hasProcessing = workflowEventProgress.content.includes("正在拆") || workflowEventProgress.content.includes("正在生成");
      const failed = workflowEventProgress.content.includes("失败");
      const floorPercent = Math.round((completed / total) * 100);
      const ceilPercent = Math.round(((completed + (hasProcessing ? 1 : 0)) / total) * 100);
      const title =
        activeWorkflowAction === "prepare_segment_video_prompt"
          ? "正在生成片段提示词"
          : "正在拆解剧本分镜";

      return {
        title,
        description: "底层任务状态会实时刷新。",
        floorPercent,
        ceilPercent: Math.min(100, Math.max(floorPercent, ceilPercent)),
        hasProcessing,
        statusLabel: ensureCmdProgressStatusLabel(activeWorkflowAction, headline),
        detailLabel: parts[1] || (failed ? "有分集失败" : `${floorPercent}%`),
        currentBatchLabel: parts.slice(2).join(" · ") || undefined,
        onStop: hasProcessing ? onGlobalInterrupt : undefined,
      };
    }

    if (activeWorkflowAction === "generate_episode" || activeWorkflowAction === "generate_episode_batch") {
      const episodeArtifact = currentProject.artifacts.find(
        (artifact) =>
          artifact.kind === "episode" &&
          artifact.payload?.type === "episodes+batchProgress",
      );

      if (episodeArtifact?.payload?.type !== "episodes+batchProgress") {
        return null;
      }

      const payload = episodeArtifact.payload;
      const processingEntry = payload.entries.find((entry) => entry.status === "processing");
      const completedEpisodes = payload.entries.filter((entry) => entry.status === "done").length;
      const failedEpisodes = payload.entries.filter((entry) => entry.status === "failed").length;
      const totalEpisodes = Math.max(payload.batchProgress.total || payload.totalEpisodes, 1);
      const isProcessing = payload.batchProgress.processing > 0;
      const floorPercent = Math.round((completedEpisodes / totalEpisodes) * 100);
      const ceilPercent = Math.round(((completedEpisodes + (isProcessing ? 1 : 0)) / totalEpisodes) * 100);
      const entryStatusByNumber = new Map(payload.entries.map((entry) => [entry.number, entry.status] as const));
      const cmdProgress = buildCmdProgressBar(
        Array.from({ length: totalEpisodes }, (_, index) =>
          getCmdProgressMark(entryStatusByNumber.get(index + 1)),
        ),
      );

      return {
        title: processingEntry
          ? `第 ${processingEntry.number} 集正在撰写`
          : "正在撰写分集正文",
        description: "已完成的正文会实时写回分集撰写卡片，进度符号会按集刷新。",
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
      payload.batchProgress.batches.find((batch) => batch.status === "processing") ??
      payload.batchProgress.batches.find((batch) => batch.status !== "done");
    const completedEpisodes = payload.entries.filter((entry) => entry.outline?.trim()).length;
    const isProcessing = payload.batchProgress.batches.some((b) => b.status === "processing");
    const doneBatches = payload.batchProgress.done;
    const totalBatches = Math.max(payload.batchProgress.total, 1);
    const floorPercent = Math.round((doneBatches / totalBatches) * 100);
    const ceilPercent = Math.round(((doneBatches + (isProcessing ? 1 : 0)) / totalBatches) * 100);
    const totalEpisodes = Math.max(payload.totalEpisodes, payload.entries.length, 1);
    const outlineByNumber = new Map(payload.entries.map((entry) => [entry.number, Boolean(entry.outline?.trim())] as const));
    const batchByEpisodeNumber = new Map<number, string>();
    for (const batch of payload.batchProgress.batches) {
      for (let episodeNumber = batch.startEp; episodeNumber <= batch.endEp; episodeNumber += 1) {
        batchByEpisodeNumber.set(episodeNumber, batch.status);
      }
    }
    const cmdProgress = buildCmdProgressBar(
      Array.from({ length: totalEpisodes }, (_, index) => {
        const episodeNumber = index + 1;
        return getCmdProgressMark(batchByEpisodeNumber.get(episodeNumber), outlineByNumber.get(episodeNumber));
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
      onRegenerate: !isProcessing ? () => handleChoiceSelect("script:outline-regenerate-all", "重新生成全部细纲") : undefined,
    };
  }, [activeWorkflowAction, currentProject, handleChoiceSelect, onGlobalInterrupt, workflowEventProgress]);

  const shouldShowConfirmQuestion =
    Boolean(qState) ||
    Boolean(
      question?.answerKey === "题材选择" &&
        question.multiSelect &&
        question.submissionMode === "confirm",
    );
  const shouldShowBackQuestion =
    Boolean(qState && isOriginalScriptKickoffRequest(qState.request) && canRewindOriginalScriptKickoff(qState)) ||
    Boolean(buildAdaptationTargetMarketBackQuestion(currentProject, question));
  const visibleQuestion = useMemo(
    () => markSelectedQuestionOptions(question, selectedValues),
    [question, selectedValues],
  );

  const composerProps = useMemo<HomeComposerProps>(
    () => ({
      idle,
      currentProjectTitle: currentProject?.title,
      currentProjectStage: currentProject?.derivedStage,
      maintenanceHint,
      videoTransportHint,
      launchNotice,
      initialDraft: draftInitialValue,
      draftResetVersion,
      draftPresence,
      onDraftChange: syncComposerDraft,
      placeholder,
      question: visibleQuestion,
      workflowProgress,
      qState,
      selectedValues,
      streaming,
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
      onSelectVideoModel,
      onConfirmVideoResolution,
      onDevVideoGenerationModeChange,
      onDevImageViewModeChange,
      creationMode,
      onCreationModeChange,
      devMode,
      onDevModeChange,
      onSelectChoice: handleChoiceSelect,
      onConfirmQuestion: shouldShowConfirmQuestion ? confirmStructuredAnswer : undefined,
      onBackQuestion: shouldShowBackQuestion ? handleQuestionBack : undefined,
      onDismissQuestion: qState || question ? dismissQuestion : undefined,
      onLaunchAction,
      onSubmit: submitComposer,
      onInterrupt: handleInterrupt,
      attachedFiles,
      onAttachedFilesChange,
      conversationMediaItems,
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
      handleChoiceSelect,
      handleInterrupt,
      dismissQuestion,
      idle,
      maintenanceHint,
      launchNotice,
      placeholder,
      qState,
      question,
      visibleQuestion,
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
      streaming,
      submitComposer,
      syncComposerDraft,
      textModelGroups,
      imageModelOptions,
      imageGenerationPrefs,
      videoModelOptions,
      videoGenerationPrefs,
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
      attachedFiles,
      onAttachedFilesChange,
      conversationMediaItems,
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
      <div className={cn("mx-auto w-full", activeTrackClassName)}>
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
