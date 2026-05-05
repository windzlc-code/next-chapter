import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
  StudioSessionState,
} from "@/lib/home-agent/types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";

export function buildResetRuntimeState(previous: StudioRuntimeState): StudioRuntimeState {
  return {
    ...previous,
    sessionId: crypto.randomUUID(),
    currentProjectSnapshot: null,
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentMessageSummary: "",
    fullAutoRun: null,
  };
}

function isStaleReviewQuestion(q: ComposerQuestion | null | undefined): boolean {
  if (!q) return false;
  return (
    q.id.startsWith("review-") ||
    q.answerKey === "review-stage-panel" ||
    q.answerKey?.startsWith("review-")
  );
}

export function buildOpenProjectSessionState(params: {
  savedSession: StudioSessionState | null;
  snapshot: ConversationProjectSnapshot;
  videoProject: PersistedVideoProject | null;
  buildBrief: (snapshot: ConversationProjectSnapshot) => string;
  createAssistantMessage: (content: string) => HomeAgentMessage;
  getSuggestedQuestion: (
    snapshot: ConversationProjectSnapshot,
    videoProject: PersistedVideoProject | null,
  ) => ComposerQuestion | null;
}) {
  const { savedSession, snapshot, videoProject, buildBrief, createAssistantMessage, getSuggestedQuestion } = params;

  if (savedSession) {
    return {
      creationMode: "fast" as const,
      automationMode: savedSession.automationMode ?? snapshot.automationMode ?? "manual",
      devMode: savedSession.devMode ?? false,
      qState: savedSession.qState ?? null,
      deferredQuestionState: savedSession.deferredQuestionState ?? null,
      popoverOverride: isStaleReviewQuestion(savedSession.pendingChoiceQuestion) ? null : (savedSession.pendingChoiceQuestion ?? null),
      suggested: null,
      selectedValues: savedSession.selectedValues ?? [],
      deferredSelectedValues: savedSession.deferredSelectedValues ?? [],
      selectedTextModelKey: savedSession.selectedTextModelKey,
      selectedImageModelFamily: savedSession.selectedImageModelFamily,
      imageGenerationPrefs:
        savedSession.imageGenerationPrefs ?? videoProject?.imageGenerationPrefs,
      selectedVideoModelKey: savedSession.selectedVideoModelKey,
      videoGenerationPrefs:
        savedSession.videoGenerationPrefs ?? videoProject?.videoGenerationPrefs,
      mode:
        savedSession.mode === "recovering" || savedSession.mode === "maintenance-review"
          ? savedSession.mode
          : ("active" as const),
      messages: savedSession.messages.length ? savedSession.messages : [createAssistantMessage(buildBrief(snapshot))],
      draft: savedSession.draft ?? "",
      deferredDraft: savedSession.deferredDraft ?? "",
      compactedMessageCount: savedSession.compactedMessageCount ?? 0,
      surfacedTaskIds: savedSession.surfacedTaskIds ?? [],
      surfacedTaskFollowupKeys: savedSession.surfacedTaskFollowupKeys ?? [],
      surfacedProjectSuggestionKeys: savedSession.surfacedProjectSuggestionKeys ?? [],
      previousQuestionStep: savedSession.qState
        ? `${savedSession.qState.request.id}:${savedSession.qState.currentIndex}`
        : null,
      sessionId: savedSession.sessionId ?? crypto.randomUUID(),
      fullAutoRun: savedSession.fullAutoRun ?? null,
    };
  }

  return {
    creationMode: "fast" as const,
    automationMode: snapshot.automationMode ?? "manual",
    devMode: false,
    qState: null,
    deferredQuestionState: null,
    popoverOverride: null,
    suggested: getSuggestedQuestion(snapshot, videoProject),
    selectedValues: [],
    deferredSelectedValues: [],
    selectedTextModelKey: undefined,
    selectedImageModelFamily: videoProject?.imageGenerationPrefs?.familyKey,
    imageGenerationPrefs: videoProject?.imageGenerationPrefs,
    selectedVideoModelKey: videoProject?.videoGenerationPrefs?.modelKey,
    videoGenerationPrefs: videoProject?.videoGenerationPrefs,
    mode: "active" as const,
    messages: [createAssistantMessage(buildBrief(snapshot))],
    draft: "",
    deferredDraft: "",
    compactedMessageCount: 0,
    surfacedTaskIds: [],
    surfacedTaskFollowupKeys: [],
    surfacedProjectSuggestionKeys: [],
    previousQuestionStep: null,
    sessionId: crypto.randomUUID(),
    fullAutoRun: null,
  };
}

export function advanceStructuredAnswer(params: {
  qState: StudioQuestionState;
  value: string;
  label?: string;
  qStepKey: (index: number, question: { header?: string }) => string;
}) {
  const { qState, value, label, qStepKey } = params;
  const activeQuestion = qState.request.questions[qState.currentIndex];
  if (!activeQuestion) return null;

  const submittedValue = value.trim();
  const displayValue = (label || value).trim();
  if (!submittedValue) return null;

  const stepKey = qStepKey(qState.currentIndex, activeQuestion);
  const nextAnswers = {
    ...qState.answers,
    [stepKey]: submittedValue,
  };
  const nextDisplayAnswers = {
    ...qState.displayAnswers,
    [stepKey]: displayValue || submittedValue,
  };
  const userBubble = activeQuestion.header
    ? `${activeQuestion.header}：${nextDisplayAnswers[stepKey]}`
    : nextDisplayAnswers[stepKey];
  const isLastStep = qState.currentIndex >= qState.request.questions.length - 1;

  return {
    activeQuestion,
    submittedValue,
    displayValue,
    nextAnswers,
    nextDisplayAnswers,
    userBubble,
    isLastStep,
    nextQState: isLastStep
      ? null
      : {
          source: qState.source,
          request: qState.request,
          currentIndex: qState.currentIndex + 1,
          answers: nextAnswers,
          displayAnswers: nextDisplayAnswers,
        },
  };
}
