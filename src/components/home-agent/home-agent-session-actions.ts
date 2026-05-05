import { clearStudioSession } from "@/lib/home-agent/session-store";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { MessageInput } from "@/lib/agent/types";
import {
  advanceOriginalScriptKickoff,
  buildOriginalScriptKickoffPrompt,
  isOriginalScriptKickoffRequest,
  type OriginalScriptKickoffCompletion,
  isOriginalScriptKickoffGenreQuestion,
} from "@/lib/home-agent/original-script-kickoff";
import {
  advanceAdaptationWorkflowKickoff,
  buildAdaptationWorkflowStartPrompt,
  isAdaptationWorkflowKickoffRequest,
  type AdaptationWorkflowKickoffCompletion,
} from "@/lib/home-agent/adaptation-workflow-kickoff";
import {
  advanceVideoWorkflowKickoff,
  buildVideoWorkflowStartPrompt,
  isVideoWorkflowKickoffRequest,
  type VideoWorkflowKickoffCompletion,
} from "@/lib/home-agent/video-workflow-kickoff";
import { advanceStructuredAnswer, buildResetRuntimeState } from "./home-agent-conversation-state";
import { serializeQuestionAnswers } from "./home-agent-session-utils";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";

type PushMessage = (role: HomeAgentMessage["role"], content: string) => void;

export function resetHomeAgentConversation(params: {
  activeProjectId?: string;
  qState: StudioQuestionState | null;
  rejectQuestion: (requestId: string) => void;
  interruptEngine: () => void;
  clearSurfacedTasks: () => void;
  setQState: (value: StudioQuestionState | null) => void;
  setDeferredQuestionState: (value: StudioQuestionState | null) => void;
  setPopoverOverride: (value: ComposerQuestion | null) => void;
  setSuggested: (value: ComposerQuestion | null) => void;
  setSelectedValues: (value: string[]) => void;
  setDeferredSelectedValues: (value: string[]) => void;
  setMode: (value: "idle") => void;
  setMessages: (value: HomeAgentMessage[]) => void;
  resetComposerDraft: (value?: string) => void;
  setDeferredDraft: (value: string) => void;
  setCompactedMessageCount: (value: number) => void;
  setActiveProjectId: (value: string | undefined) => void;
  resetRuntime: () => void;
  setMetaReady: (value: boolean) => void;
}) {
  const {
    activeProjectId,
    qState,
    rejectQuestion,
    interruptEngine,
    clearSurfacedTasks,
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
    resetRuntime,
    setMetaReady,
  } = params;

  if (qState) {
    rejectQuestion(qState.request.id);
  }

  interruptEngine();
  clearSurfacedTasks();
  setQState(null);
  setDeferredQuestionState(null);
  setPopoverOverride(null);
  setSuggested(null);
  setSelectedValues([]);
  setDeferredSelectedValues([]);
  setMode("idle");
  setMessages([]);
  resetComposerDraft("");
  setDeferredDraft("");
  setCompactedMessageCount(0);
  setActiveProjectId(undefined);
  resetRuntime();
  setMetaReady(false);
  // 注意：此处只清除全局会话缓存，不删除项目级别的持久化会话。
  // removeProjectStudioSession 语义是"用户主动清除历史"，新建项目时不应调用，
  // 否则切回旧项目时历史记录和媒体文件路径会丢失，只剩"已恢复项目"欢迎语。
  clearStudioSession();
}

export function answerHomeAgentQuestion(params: {
  qState: StudioQuestionState | null;
  value: string;
  label?: string;
  qStepKey: (index: number, question: { header?: string }) => string;
  setSuggested: (value: ComposerQuestion | null) => void;
  send: (
    value: MessageInput,
    shown?: string,
    opts?: {
      skipUserBubble?: boolean;
      attachments?: ChatAttachment[];
      disableAutoResearch?: boolean;
    },
  ) => Promise<void>;
  push: PushMessage;
  resolveQuestion: (requestId: string, output: string) => boolean | Promise<boolean>;
  completeOriginalScriptKickoff?: (completion: OriginalScriptKickoffCompletion) => void | Promise<void>;
  completeAdaptationWorkflowKickoff?: (completion: AdaptationWorkflowKickoffCompletion) => void | Promise<void>;
  completeVideoWorkflowKickoff?: (completion: VideoWorkflowKickoffCompletion) => void | Promise<void>;
  setQState: (value: StudioQuestionState | null) => void;
  setSelectedValues: (value: string[]) => void;
  resetComposerDraft: (value?: string) => void;
}) {
  const {
    qState,
    value,
    label,
    qStepKey,
    setSuggested,
    send,
    push,
    resolveQuestion,
    completeOriginalScriptKickoff,
    completeAdaptationWorkflowKickoff,
    completeVideoWorkflowKickoff,
    setQState,
    setSelectedValues,
    resetComposerDraft,
  } = params;

  if (!qState) {
    setSuggested(null);
    void send(value, label);
    return;
  }

  const activeQuestion = qState.request.questions[qState.currentIndex];
  if (!activeQuestion) {
    setQState(null);
    setSelectedValues([]);
    resetComposerDraft("");
    return;
  }

  if (isVideoWorkflowKickoffRequest(qState.request)) {
    const completion = advanceVideoWorkflowKickoff({ value, label });
    if (!completion) return;
    setQState(null);
    setSelectedValues([]);
    resetComposerDraft("");
    void Promise.resolve(completeVideoWorkflowKickoff?.(completion)).catch(() => {
      void send(buildVideoWorkflowStartPrompt(completion.source), completion.userBubble);
    });
    return;
  }

  if (isAdaptationWorkflowKickoffRequest(qState.request)) {
    const completion = advanceAdaptationWorkflowKickoff({ value, label });
    if (!completion) return;
    setQState(null);
    setSelectedValues([]);
    resetComposerDraft("");
    void Promise.resolve(completeAdaptationWorkflowKickoff?.(completion)).catch(() => {
      void send(buildAdaptationWorkflowStartPrompt(), completion.userBubble);
    });
    return;
  }

  if (isOriginalScriptKickoffRequest(qState.request)) {
    const transition = advanceOriginalScriptKickoff({
      qState,
      value,
      label,
    });
    if (!transition) return;

    if (transition.completion) {
      setQState(null);
      setSelectedValues([]);
      resetComposerDraft("");
      void Promise.resolve(completeOriginalScriptKickoff?.(transition.completion)).catch(() => {
        void send(buildOriginalScriptKickoffPrompt(transition.completion.structuredSummary), transition.userBubble);
      });
      return;
    }

    push("user", transition.userBubble);
    if (transition.nextQState) {
      const nextQuestion = transition.nextQState.request.questions[0];
      if (nextQuestion?.question) {
        push("assistant", nextQuestion.question);
      }
    }
    setQState(transition.nextQState);
    setSelectedValues([]);
    resetComposerDraft("");
    return;
  }

  const transition = advanceStructuredAnswer({
    qState,
    value,
    label,
    qStepKey,
  });
  if (!transition) return;

  if (transition.isLastStep) {
    const output = serializeQuestionAnswers(qState.request, transition.nextAnswers);
    const promptForSend = isOriginalScriptKickoffRequest(qState.request)
      ? buildOriginalScriptKickoffPrompt(output)
      : output;
    setQState(null);
    setSelectedValues([]);
    resetComposerDraft("");

    if (qState.source === "restored" || qState.source === "deferred") {
      void send(promptForSend, transition.userBubble);
      return;
    }

    void Promise.resolve(resolveQuestion(qState.request.id, output))
      .catch(() => false)
      .then((resolved) => {
        if (resolved) {
          push("user", transition.userBubble);
          return;
        }

        void send(promptForSend, transition.userBubble);
      });
    return;
  } else {
    push("user", transition.userBubble);
    setQState(transition.nextQState);
    setSelectedValues([]);
    resetComposerDraft("");
  }
}

export function buildConfirmedStructuredAnswer(params: {
  qState: StudioQuestionState | null;
  question: ComposerQuestion | null;
  selectedValues: string[];
  draft: string;
}): { submittedValue: string; displayValue: string } | null {
  const { qState, question, selectedValues, draft } = params;
  if (!qState || !question) return null;

  const selectedLabels = question.options
    .filter((option) => selectedValues.includes(option.value))
    .map((option) => option.label);
  const custom = draft.trim();
  const hasSelection = selectedValues.length > 0;
  const submittedValue = [
    hasSelection ? selectedValues.join(" / ") : "",
    custom ? (hasSelection ? `补充：${custom}` : custom) : "",
  ]
    .filter(Boolean)
    .join("\n");
  const displayValue = [
    hasSelection ? selectedLabels.join(" / ") : "",
    custom ? (hasSelection ? `补充：${custom}` : custom) : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!submittedValue.trim()) return null;
  return { submittedValue, displayValue };
}

export function launchTemplateConversation(params: {
  prompt: string;
  title: string;
  dreaminaAvailable: boolean;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  markDreaminaSurfaced: () => void;
  send: (prompt: string, shown?: string) => Promise<void>;
}) {
  const { prompt, title, dreaminaAvailable, flashMaintenanceHint, markDreaminaSurfaced, send } = params;

  if (dreaminaAvailable && title.includes("视频")) {
    flashMaintenanceHint("已接入 Dreamina CLI，可直接使用 Seedance 2.0", 2400);
    markDreaminaSurfaced();
  }
  void send(prompt, title);
}

export function resetRuntimeState(setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>) {
  setRuntime((prev) => buildResetRuntimeState(prev));
}

function isVideoWorkflowChoice(question: ComposerQuestion | null, value: string): boolean {
  return value.startsWith("video:") || Boolean(question?.answerKey?.startsWith("video-"));
}

export function handleHomeAgentChoiceSelection(params: {
  snapshot: ConversationProjectSnapshot | null;
  value: string;
  label: string;
  question: ComposerQuestion | null;
  qState: StudioQuestionState | null;
  answer: (value: string, label?: string) => void;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  videoProjectChoiceHandler: (snapshot: ConversationProjectSnapshot, value: string, label: string) => boolean;
  videoAssetChoiceHandler: (snapshot: ConversationProjectSnapshot, value: string, label: string) => boolean;
  scriptProjectChoiceHandler: (snapshot: ConversationProjectSnapshot, value: string, label: string) => boolean;
  autoResearchChoiceHandler: (value: string, label: string) => boolean | Promise<boolean>;
}): boolean {
  const {
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
  } = params;

  if (question?.id.startsWith("auto-research:")) {
    void Promise.resolve(autoResearchChoiceHandler(value, label));
    return true;
  }

  if (question?.multiSelect && question.answerKey === "题材选择") {
    setSelectedValues((prev) => {
      if (!prev.includes(value) && isOriginalScriptKickoffGenreQuestion(question) && prev.length >= 2) {
        return prev;
      }
      return prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value];
    });
    return false;
  }

  if (
    question?.answerKey === "script-episode" &&
    value.startsWith("script:episode-duration:")
  ) {
    setSelectedValues([value]);
    return true;
  }

  const isVideoChoice = isVideoWorkflowChoice(question, value);

  if (snapshot && (snapshot.projectKind === "video" || isVideoChoice) && videoProjectChoiceHandler(snapshot, value, label)) {
    return true;
  }

  if (snapshot && (snapshot.projectKind === "video" || isVideoChoice) && videoAssetChoiceHandler(snapshot, value, label)) {
    return true;
  }

  if (isVideoChoice) {
    return true;
  }

  if (
    (snapshot?.projectKind === "script" || snapshot?.projectKind === "adaptation") &&
    scriptProjectChoiceHandler(snapshot, value, label)
  ) {
    return true;
  }

  if (!question?.multiSelect && question?.submissionMode !== "confirm") {
    answer(value, label);
    return true;
  }

  if (!question?.multiSelect && question?.submissionMode === "confirm" && question?.options.length === 1) {
    answer(value, label);
    return true;
  }

  setSelectedValues((prev) => {
    if (question.multiSelect) {
      if (!prev.includes(value) && isOriginalScriptKickoffGenreQuestion(question) && prev.length >= 2) {
        return prev;
      }
      return prev.includes(value) ? prev.filter((item) => item !== value) : [...prev, value];
    }
    return [value];
  });
  return false;
}

export function submitHomeAgentComposer(params: {
  qState: StudioQuestionState | null;
  question: ComposerQuestion | null;
  draft: string;
  attachmentsPresent?: boolean;
  confirmStructuredAnswer: () => void;
  deferQuestionToChat?: () => void;
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
}) {
  const { qState, question, draft, attachmentsPresent, confirmStructuredAnswer, deferQuestionToChat, answer, send } = params;

  if (qState && (question?.submissionMode === "confirm" || question?.multiSelect)) {
    confirmStructuredAnswer();
    return;
  }

  if (qState) {
    if ((draft.trim() || attachmentsPresent) && deferQuestionToChat) {
      deferQuestionToChat();
      return;
    }
    answer(draft);
    return;
  }

  void send(draft);
}
