import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type {
  ComposerQuestion,
  ConversationArtifact,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioRuntimeState,
} from "@/lib/home-agent/types";

type PushMessage = (
  role: HomeAgentMessage["role"],
  content: string,
  artifactIds?: string[],
  attachments?: ChatAttachment[],
  artifactSnapshots?: ConversationArtifact[],
) => void;

export function createWorkflowShortcutUiBridge(params: {
  activateConversation: () => void;
  clearChoiceUi: () => void;
  commitRuntime: (runtime: StudioRuntimeState, projectId?: string) => void;
  getSuggestedQuestion: (
    snapshot: ConversationProjectSnapshot | null,
    runtime: StudioRuntimeState,
  ) => ComposerQuestion | null;
  push: PushMessage;
  resetComposerDraft: (value?: string) => void;
  setPopoverQuestion: (
    question: ComposerQuestion | null,
    snapshot?: ConversationProjectSnapshot | null,
  ) => void;
  setStreaming: (streaming: boolean) => void;
  setSuggested: (question: ComposerQuestion | null) => void;
}) {
  const {
    activateConversation,
    clearChoiceUi,
    commitRuntime,
    getSuggestedQuestion,
    push,
    resetComposerDraft,
    setPopoverQuestion,
    setStreaming,
    setSuggested,
  } = params;

  return {
    activateConversation,
    clearChoiceUi,
    commitRuntime,
    getSuggestedQuestion,
    pushAssistant: (content: string, artifactIds?: string[], artifactSnapshots?: ConversationArtifact[]) =>
      push("assistant", content, artifactIds, undefined, artifactSnapshots),
    pushUser: (content: string) => push("user", content),
    resetComposerDraft: () => resetComposerDraft(""),
    setPopoverQuestion,
    setStreaming,
    setSuggested,
  };
}

export function showChoicePopoverMessage(params: {
  label: string;
  assistantMessage: string;
  nextQuestion: ComposerQuestion;
  push: PushMessage;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
  setSuggested: (question: ComposerQuestion | null) => void;
  setMode: (mode: "active") => void;
  resetComposerDraft: (value?: string) => void;
}) {
  const { label, assistantMessage, nextQuestion, push, setPopoverOverride, setSuggested, setMode, resetComposerDraft } =
    params;

  push("user", label);
  push("assistant", assistantMessage);
  setPopoverOverride(nextQuestion);
  setSuggested(null);
  setMode("active");
  resetComposerDraft("");
}

export function showChoiceNoticeMessage(params: {
  label: string;
  assistantMessage: string;
  nextSuggestion?: ComposerQuestion | null;
  push: PushMessage;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
  setSuggested: (question: ComposerQuestion | null) => void;
  setMode: (mode: "active") => void;
  resetComposerDraft: (value?: string) => void;
}) {
  const {
    label,
    assistantMessage,
    nextSuggestion = null,
    push,
    setPopoverOverride,
    setSuggested,
    setMode,
    resetComposerDraft,
  } = params;

  push("user", label);
  push("assistant", assistantMessage);
  setPopoverOverride(null);
  setSuggested(nextSuggestion);
  setMode("active");
  resetComposerDraft("");
}
