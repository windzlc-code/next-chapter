import * as React from "react";
import type { MessageInput } from "@/lib/agent/types";
import { clearStudioSession, queueStudioSessionWrite, writeStudioSession } from "@/lib/home-agent/session-store";
import { planConversationCompaction } from "@/lib/home-agent/conversation-compact";
import {
  mergeRuntimeWithWorkflowDelta,
  resolveAutoWorkflowFollowupAction,
  runWorkflowShortcut,
} from "@/lib/home-agent/workflow-shortcut-runner";
import { buildMediaContentSummary } from "@/lib/home-agent/media-generation-copy";
import { resolveHomeAgentTextModelRuntime } from "@/lib/home-agent/text-models";
import { extractAssistantProjectTitle } from "@/lib/home-agent/project-title";
import { isServerProxyEndpoint } from "@/lib/server-proxy";
import type {
  AgentConversationMode,
  AutomationMode,
  CreationMode,
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  MaintenanceReport,
  PendingWorkflowUploadKind,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { Task } from "@/lib/agent/tools/task-tools";
import { createWorkflowShortcutUiBridge } from "./home-agent-workflow-ui";
import { buildVideoBridgeRetryQuestion, recQuestion } from "./home-agent-project-questions";
import {
  resolveComposerDraftSnapshot,
  shouldKeepSessionProjectIdForBridgedVideo,
} from "./home-agent-session-utils";
import {
  type BackgroundResearchGroup,
  isBackgroundResearchTask,
} from "./home-agent-task-utils";
import { isScriptPopoverCompatibleWithCurrentStage } from "./use-home-agent-question-view";
import {
  buildVideoBridgeResearchInput,
  buildVideoBridgeResearchMessage,
} from "./video-bridge-research-utils";

const { useCallback, useEffect, useRef, useState, startTransition } = React;

type AutoCharacterGenerationPlan = {
  action: "generate_characters" | "generate_character_transform";
  key: string;
  projectId: string;
};

type RestoredTaskFollowupSuppression = {
  sessionId: string;
  restoredAt: number;
};

type QueuedSessionArchiveSignature = {
  projectId: string;
  messages: HomeAgentMessage[];
  snapshot: ConversationProjectSnapshot | null;
  recentMessageSummary: string;
  compactedMessageCount: number;
  fullAutoRun: StudioRuntimeState["fullAutoRun"] | null;
};

type QueuedSessionWriteSignature = {
  sessionId: string;
  mode: AgentConversationMode;
  creationMode: CreationMode;
  automationMode: AutomationMode;
  devMode: boolean;
  suppressHistoricalMemory: boolean;
  messages: HomeAgentMessage[];
  snapshot: ConversationProjectSnapshot | null;
  recentMessageSummary: string;
  projectId: string | null;
  selectedTextModelKey: string;
  selectedImageModelFamily: string;
  imageGenerationPrefs: unknown;
  selectedVideoModelKey: string;
  videoGenerationPrefs: unknown;
  compactedMessageCount: number;
  draft: string;
  qState: StudioQuestionState | null;
  deferredQuestionState: StudioQuestionState | null;
  pendingWorkflowUploadKind: PendingWorkflowUploadKind | null;
  pendingChoiceQuestion: ComposerQuestion | null;
  interruptedChoiceQuestion: ComposerQuestion | null;
  selectedValues: string[];
  deferredSelectedValues: string[];
  deferredDraft: string;
  surfacedTaskIdsKey: string;
  surfacedTaskFollowupKeysKey: string;
  surfacedProjectSuggestionKeysKey: string;
  fullAutoRun: StudioRuntimeState["fullAutoRun"] | null;
  fullAutoChecklistCollapsed: boolean;
};

const DUPLICATE_PROJECT_TITLE_SUFFIX_RE = /\s*-\s*副本\d*\s*$/u;

function stripDuplicateProjectTitleSuffix(title: string): string {
  return title.trim().replace(DUPLICATE_PROJECT_TITLE_SUFFIX_RE, "").trim();
}

function shouldPreserveDuplicateProjectTitle(currentTitle: string, nextTitle: string): boolean {
  if (!DUPLICATE_PROJECT_TITLE_SUFFIX_RE.test(currentTitle)) return false;
  return stripDuplicateProjectTitleSuffix(currentTitle) === nextTitle.trim();
}

function areQueuedSessionWriteSignaturesEqual(
  previous: QueuedSessionWriteSignature | null,
  next: QueuedSessionWriteSignature,
): boolean {
  if (!previous) return false;
  return (
    previous.sessionId === next.sessionId &&
    previous.mode === next.mode &&
    previous.creationMode === next.creationMode &&
    previous.automationMode === next.automationMode &&
    previous.devMode === next.devMode &&
    previous.suppressHistoricalMemory === next.suppressHistoricalMemory &&
    previous.messages === next.messages &&
    previous.snapshot === next.snapshot &&
    previous.recentMessageSummary === next.recentMessageSummary &&
    previous.projectId === next.projectId &&
    previous.selectedTextModelKey === next.selectedTextModelKey &&
    previous.selectedImageModelFamily === next.selectedImageModelFamily &&
    previous.imageGenerationPrefs === next.imageGenerationPrefs &&
    previous.selectedVideoModelKey === next.selectedVideoModelKey &&
    previous.videoGenerationPrefs === next.videoGenerationPrefs &&
    previous.compactedMessageCount === next.compactedMessageCount &&
    previous.draft === next.draft &&
    previous.qState === next.qState &&
    previous.deferredQuestionState === next.deferredQuestionState &&
    previous.pendingWorkflowUploadKind === next.pendingWorkflowUploadKind &&
    previous.pendingChoiceQuestion === next.pendingChoiceQuestion &&
    previous.interruptedChoiceQuestion === next.interruptedChoiceQuestion &&
    previous.selectedValues === next.selectedValues &&
    previous.deferredSelectedValues === next.deferredSelectedValues &&
    previous.deferredDraft === next.deferredDraft &&
    previous.surfacedTaskIdsKey === next.surfacedTaskIdsKey &&
    previous.surfacedTaskFollowupKeysKey === next.surfacedTaskFollowupKeysKey &&
    previous.surfacedProjectSuggestionKeysKey === next.surfacedProjectSuggestionKeysKey &&
    previous.fullAutoRun === next.fullAutoRun &&
    previous.fullAutoChecklistCollapsed === next.fullAutoChecklistCollapsed
  );
}

function hasRunningVideoGenerationTasks(
  videoProject: StudioRuntimeState["currentVideoProject"] | null | undefined,
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
  runtime: Pick<StudioRuntimeState, "currentVideoProject">,
): boolean {
  return (
    question?.answerKey === "video-refresh-panel" &&
    hasRunningVideoGenerationTasks(runtime.currentVideoProject)
  );
}

function canBackgroundResearchReplacePopover(
  group: BackgroundResearchGroup,
  popoverOverride: ComposerQuestion | null | undefined,
): boolean {
  if (!popoverOverride) return true;
  if (group.kind !== "video-bridge-platform") return false;
  const answerKey = popoverOverride.answerKey;
  return (
    answerKey === "video-bridge-prefix" ||
    answerKey === "video-bridge-retry" ||
    answerKey.startsWith("video-kickoff-prefs-")
  );
}

function getAutoCharacterGenerationPlan(params: {
  activeProjectId?: string;
  endRef?: React.RefObject<HTMLElement | null>;
  snapshot: ConversationProjectSnapshot | null;
  dramaProject: StudioRuntimeState["currentDramaProject"];
}): AutoCharacterGenerationPlan | null {
  // Character generation now starts from the explicit "enter role step" action.
  // Once the user clicks into that step, the workflow shortcut runs immediately and
  // the next directory panel is surfaced after generation completes.
  return null;
}

export function useHomeAgentConversationEffects(params: {
  idle: boolean;
  streaming: boolean;
  messages: HomeAgentMessage[];
  runtime: StudioRuntimeState;
  compactedMessageCount: number;
  activeProjectId?: string;
  endRef?: React.RefObject<HTMLElement | null>;
  creationMode: CreationMode;
  automationMode: AutomationMode;
  devMode: boolean;
  mode: AgentConversationMode;
  setMode: React.Dispatch<React.SetStateAction<AgentConversationMode>>;
  qState: StudioQuestionState | null;
  deferredQuestionState: StudioQuestionState | null;
  pendingWorkflowUploadKind?: PendingWorkflowUploadKind | null;
  question?: ComposerQuestion | null;
  popoverOverride: ComposerQuestion | null;
  interruptedChoiceQuestion: ComposerQuestion | null;
  suggested: ComposerQuestion | null;
  suppressVideoWorkflowSuggestions?: boolean;
  draftPresence: boolean;
  persistedDraft: string;
  deferredDraft: string;
  recentSessionSummary: string;
  fullAutoChecklistCollapsed: boolean;
  selectedValues: string[];
  deferredSelectedValues: string[];
  selectedTextModelKey: string;
  selectedImageModelFamily: import("@/types/project").VideoImageModelFamilyKey;
  imageGenerationPrefs: import("@/types/project").VideoImageGenerationPrefs;
  selectedVideoModelKey: import("@/types/project").VideoGenerationModelKey;
  videoGenerationPrefs: import("@/types/project").VideoGenerationPrefs;
  deferredMessages: HomeAgentMessage[];
  deferredProjectSnapshot: ConversationProjectSnapshot | null;
  visibleTasks: Task[];
  engineRef: React.MutableRefObject<{ interrupt?: () => void } | null>;
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  projectHydrationInFlightRef?: React.MutableRefObject<string | null>;
  draftRef: React.MutableRefObject<string>;
  previousQuestionStepRef: React.MutableRefObject<string | null>;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  restoredTaskFollowupSuppressionRef?: React.MutableRefObject<RestoredTaskFollowupSuppression | null>;
  backgroundResearchGroupsRef: React.MutableRefObject<BackgroundResearchGroup[]>;
  surfacedProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  restoredProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  dismissedProjectSuggestionKeysRef?: React.MutableRefObject<Set<string>>;
  compactionJobVersionRef: React.MutableRefObject<number>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setCompactedMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  resetComposerDraft: (value?: string) => void;
  send?: (
    value: MessageInput,
    shown?: string,
    opts?: { skipUserBubble?: boolean; disableAutoResearch?: boolean },
  ) => Promise<void>;
  push: (role: HomeAgentMessage["role"], content: string) => void;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  loadApiConfigModule: () => Promise<typeof import("@/lib/api-config")>;
  loadSemanticSummaryModule: () => Promise<typeof import("@/lib/home-agent/conversation-semantic-summary")>;
  loadProjectStore: () => Promise<typeof import("@/lib/home-agent/project-store")>;
  loadWorkflowActionsModule: () => Promise<typeof import("@/lib/home-agent/workflow-actions")>;
  scheduleBackgroundTask: (task: () => void, timeout?: number) => () => void;
  mergeRecentProjects: (
    currentProjects: ConversationProjectSnapshot[],
    nextProject: ConversationProjectSnapshot,
    limit?: number,
  ) => ConversationProjectSnapshot[];
  buildTaskResultMessage: (task: Task) => string;
  buildProjectSuggestionKey: (
    snapshot: ConversationProjectSnapshot | null | undefined,
    question: ComposerQuestion | null | undefined,
  ) => string | null;
  parseTaskHeading: (prompt: string) => string | null;
}) {
  const previousProjectStageKeyRef = useRef<string | null>(null);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const {
    idle,
    streaming,
    messages,
    runtime,
    compactedMessageCount,
    activeProjectId,
    creationMode,
    automationMode,
    devMode,
    mode,
    setMode,
    qState,
    deferredQuestionState,
    pendingWorkflowUploadKind = null,
    question = null,
    popoverOverride,
    interruptedChoiceQuestion,
    suggested,
    suppressVideoWorkflowSuggestions = false,
    draftPresence,
    persistedDraft,
    deferredDraft,
    recentSessionSummary,
    fullAutoChecklistCollapsed,
    selectedValues,
    deferredSelectedValues,
    selectedTextModelKey,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    deferredMessages,
    deferredProjectSnapshot,
    visibleTasks,
    engineRef,
    runtimeRef,
    projectHydrationInFlightRef,
    draftRef,
    previousQuestionStepRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    restoredTaskFollowupSuppressionRef,
    backgroundResearchGroupsRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    dismissedProjectSuggestionKeysRef,
    compactionJobVersionRef,
    setRuntime,
    setActiveProjectId,
    setCompactedMessageCount,
    setStreaming,
    setSuggested,
    setPopoverOverride,
    setSelectedValues,
    resetComposerDraft,
    push,
    flashMaintenanceHint,
    loadApiConfigModule,
    loadSemanticSummaryModule,
    loadProjectStore,
    loadWorkflowActionsModule,
    scheduleBackgroundTask,
    mergeRecentProjects,
    buildTaskResultMessage,
    buildProjectSuggestionKey,
    parseTaskHeading,
  } = params;
  const videoRefreshInFlightKeyRef = useRef<string | null>(null);
  const appliedProjectTitleKeyRef = useRef<string | null>(null);
  const attemptedAutoWorkflowKeysRef = useRef<Set<string>>(new Set());
  const autoCharacterGenerationAttemptedKeysRef = useRef<Set<string>>(new Set());
  const autoCharacterGenerationInFlightKeyRef = useRef<string | null>(null);
  const lastQueuedArchiveSignatureRef = useRef<QueuedSessionArchiveSignature | null>(null);
  const lastQueuedSessionWriteSignatureRef = useRef<QueuedSessionWriteSignature | null>(null);
  const lastImmediateSessionWriteSignatureRef = useRef<QueuedSessionWriteSignature | null>(null);
  const currentSnapshotProjectId = runtime.currentProjectSnapshot?.projectId ?? null;
  const isCurrentProjectTrackedInRecentProjects = Boolean(
    currentSnapshotProjectId &&
      runtime.recentProjects.some((project) => project.projectId === currentSnapshotProjectId),
  );

  useEffect(() => {
    if (pendingWorkflowUploadKind || qState || streaming || popoverOverride || draftPresence) return;

    const plan = getAutoCharacterGenerationPlan({
      activeProjectId,
      snapshot: runtime.currentProjectSnapshot,
      dramaProject: runtime.currentDramaProject,
    });
    if (!plan) return;
    if (autoCharacterGenerationAttemptedKeysRef.current.has(plan.key)) return;

    autoCharacterGenerationAttemptedKeysRef.current.add(plan.key);
    autoCharacterGenerationInFlightKeyRef.current = plan.key;
    setSuggested(null);
    setPopoverOverride(null);
    setSelectedValues([]);
    resetComposerDraft("");
    setStreaming(true);

    let cancelled = false;

    void loadWorkflowActionsModule()
      .then((workflow) => workflow.runWorkflowAction(plan.action, { projectId: plan.projectId }, runtimeRef.current))
      .then((result) => {
        if (cancelled) return;

        const currentRuntime = runtimeRef.current;
        const nextProjectSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
        const nextRuntime = result.data
          ? mergeRuntimeWithWorkflowDelta(currentRuntime, result.data, {
              deferRecentProjectUpsert: true,
            })
          : currentRuntime;

        if (result.data) {
          startTransition(() => {
            setRuntime(nextRuntime);
          });
        }

        if (result.summary.trim()) {
          push("assistant", result.summary.trim());
        }

        const nextSuggestion = nextProjectSnapshot
          ? recQuestion(nextProjectSnapshot, nextRuntime.currentVideoProject)
          : null;

        startTransition(() => {
          if (nextSuggestion && !shouldSuppressRunningVideoRefreshPanel(nextSuggestion, nextRuntime)) {
            setPopoverOverride(nextSuggestion);
            setSuggested(null);
            return;
          }
          setPopoverOverride(null);
          setSuggested(null);
        });
      })
      .catch((error) => {
        if (cancelled) return;
        push("assistant", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
        if (autoCharacterGenerationInFlightKeyRef.current === plan.key) {
          autoCharacterGenerationInFlightKeyRef.current = null;
        }
        setStreaming(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    draftPresence,
    loadWorkflowActionsModule,
    popoverOverride,
    push,
    qState,
    resetComposerDraft,
    runtime.currentDramaProject,
    runtime.currentProjectSnapshot,
    runtimeRef,
    pendingWorkflowUploadKind,
    setPopoverOverride,
    setRuntime,
    setSelectedValues,
    setStreaming,
    setSuggested,
    streaming,
  ]);

  useEffect(() => {
    const snapshot = runtime.currentProjectSnapshot;
    const nextStageKey = snapshot ? `${snapshot.projectId}:${snapshot.derivedStage}` : null;

    if (previousProjectStageKeyRef.current === nextStageKey) return;

    const previousStageKey = previousProjectStageKeyRef.current;
    previousProjectStageKeyRef.current = nextStageKey;

    if (!previousStageKey || !popoverOverride) return;

    // 若新 stage 与当前 popover 兼容（如从导出步骤返回合规步骤），不清除面板
    if (isScriptPopoverCompatibleWithCurrentStage(snapshot as ConversationProjectSnapshot | null, popoverOverride)) return;

    setPopoverOverride(null);
    setSelectedValues([]);
    resetComposerDraft("");
  }, [
    popoverOverride,
    resetComposerDraft,
    runtime.currentProjectSnapshot,
    setPopoverOverride,
    setSelectedValues,
  ]);

  useEffect(() => {
    if (pendingWorkflowUploadKind) {
      setPopoverOverride(null);
      setSuggested(null);
      return;
    }
    if (qState || streaming || popoverOverride) return;
    if (draftPresence) return;
    if (suppressVideoWorkflowSuggestions) {
      setSuggested(null);
      return;
    }
    const nextSuggestion = (() => {
      if (!runtime.currentProjectSnapshot) return null;
      try {
        return recQuestion(runtime.currentProjectSnapshot, runtime.currentVideoProject);
      } catch {
        return null;
      }
    })();
    const suggestionKey = buildProjectSuggestionKey(runtime.currentProjectSnapshot, nextSuggestion);
    if (creationMode === "creative") {
      setSuggested((prev) => {
        if (runtime.currentProjectSnapshot?.projectKind !== "video") return null;
        const restoredSuggestion =
          suggestionKey && restoredProjectSuggestionKeysRef.current.has(suggestionKey);
        if (restoredSuggestion) {
          restoredProjectSuggestionKeysRef.current.delete(suggestionKey);
        }
        if (!nextSuggestion) return null;
        if (suggestionKey && dismissedProjectSuggestionKeysRef?.current.has(suggestionKey) && !prev) {
          return null;
        }
        if (prev?.id === nextSuggestion.id) return prev;
        if (suggestionKey) {
          surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
        }
        return nextSuggestion;
      });
      return;
    }
    if (!runtime.currentProjectSnapshot) {
      setSuggested((previous) =>
        previous?.id && !previous.id.startsWith("auto-research:")
          ? null
          : previous,
      );
      return;
    }

    const pendingAutoCharacterGeneration = getAutoCharacterGenerationPlan({
      activeProjectId,
      snapshot: runtime.currentProjectSnapshot,
      dramaProject: runtime.currentDramaProject,
    });
    if (
      pendingAutoCharacterGeneration &&
      autoCharacterGenerationInFlightKeyRef.current === pendingAutoCharacterGeneration.key
    ) {
      return;
    }

    const autoFollowup = resolveAutoWorkflowFollowupAction(runtime.currentProjectSnapshot, nextSuggestion);
    const autoFollowupKey =
      autoFollowup && runtime.currentProjectSnapshot
        ? `${runtime.sessionId}:${runtime.currentProjectSnapshot.projectId}:${runtime.currentProjectSnapshot.updatedAt ?? ""}:${autoFollowup.action}`
        : null;
    setSuggested((previous) => {
      if (suggestionKey && restoredProjectSuggestionKeysRef.current.has(suggestionKey)) {
        restoredProjectSuggestionKeysRef.current.delete(suggestionKey);
        return previous ?? nextSuggestion;
      }
      if (autoFollowupKey && !attemptedAutoWorkflowKeysRef.current.has(autoFollowupKey)) {
        return null;
      }
      if (suggestionKey && dismissedProjectSuggestionKeysRef?.current.has(suggestionKey) && !previous) {
        return null;
      }
      // If this suggestion was already surfaced and dismissed (previous is null), don't re-show it
      if (suggestionKey && surfacedProjectSuggestionKeysRef.current.has(suggestionKey) && !previous) {
        return null;
      }
      const previousId = previous?.id ?? null;
      const nextId = nextSuggestion?.id ?? null;
      if (previousId === nextId) return previous;
      if (suggestionKey && nextSuggestion) {
        surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
      }
      return nextSuggestion;
    });
  }, [
    activeProjectId,
    creationMode,
    buildProjectSuggestionKey,
    dismissedProjectSuggestionKeysRef,
    draftPresence,
    popoverOverride,
    projectHydrationInFlightRef,
    qState,
    runtime.currentDramaProject,
    runtime.currentProjectSnapshot,
    runtime.maintenanceReports,
    runtime.currentVideoProject,
    runtime.sessionId,
    runtime.skillDrafts,
    pendingWorkflowUploadKind,
    suppressVideoWorkflowSuggestions,
    streaming,
    suggested,
    setSuggested,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    attemptedAutoWorkflowKeysRef,
  ]);

  useEffect(() => {
    if (creationMode !== "fast") return;
    if (suppressVideoWorkflowSuggestions) return;
    if (pendingWorkflowUploadKind || idle || streaming || qState || popoverOverride || draftPresence) return;

    const snapshot = runtime.currentProjectSnapshot;
    if (!snapshot) return;

    const nextSuggestion = recQuestion(snapshot, runtime.currentVideoProject);
    const autoFollowup = resolveAutoWorkflowFollowupAction(snapshot, nextSuggestion);
    if (!autoFollowup) return;

    const autoFollowupKey = `${runtime.sessionId}:${snapshot.projectId}:${snapshot.updatedAt ?? ""}:${autoFollowup.action}`;
    if (attemptedAutoWorkflowKeysRef.current.has(autoFollowupKey)) return;
    attemptedAutoWorkflowKeysRef.current.add(autoFollowupKey);

    const ui = createWorkflowShortcutUiBridge({
      activateConversation: () => setMode("active"),
      clearChoiceUi: () => {
        setPopoverOverride(null);
        setSuggested(null);
      },
      commitRuntime: (nextRuntime, projectId) => {
        startTransition(() => {
          setRuntime(nextRuntime);
          const shouldKeepSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
            currentSessionProjectId: activeProjectId,
            snapshot: nextRuntime.currentProjectSnapshot,
          });
          if (projectId && !shouldKeepSessionProjectId) {
            setActiveProjectId(projectId);
          }
        });
      },
      getSuggestedQuestion: (nextSnapshot, nextRuntime) =>
        nextSnapshot ? recQuestion(nextSnapshot, nextRuntime.currentVideoProject) : null,
      push,
      resetComposerDraft,
      setPopoverQuestion: (question) => {
        if (shouldSuppressRunningVideoRefreshPanel(question, runtimeRef.current)) {
          return;
        }
        setPopoverOverride(question);
      },
      setStreaming,
      setSuggested,
    });

    void loadWorkflowActionsModule()
      .then((workflow) =>
        runWorkflowShortcut({
          action: autoFollowup.action,
          input: autoFollowup.input,
          runtime: runtimeRef.current,
          deferRecentProjectUpsert: true,
          runAction: (action, input, nextRuntime) => workflow.runWorkflowAction(action, input, nextRuntime),
          ui,
          userBubble: "",
        }),
      )
      .catch(() => {});
  }, [
    draftPresence,
    idle,
    loadWorkflowActionsModule,
    mode,
    popoverOverride,
    push,
    qState,
    resetComposerDraft,
    runtime.currentProjectSnapshot,
    runtime.currentVideoProject,
    runtime.sessionId,
    runtimeRef,
    pendingWorkflowUploadKind,
    suppressVideoWorkflowSuggestions,
    setActiveProjectId,
    setMode,
    setPopoverOverride,
    setRuntime,
    setStreaming,
    setSuggested,
    streaming,
    creationMode,
  ]);

  useEffect(() => {
    const snapshot = runtime.currentProjectSnapshot;
    if (!snapshot?.projectId) return;

    const latestAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim());
    if (!latestAssistantMessage) return;

    const nextTitle = extractAssistantProjectTitle(latestAssistantMessage.content);
    if (!nextTitle || nextTitle === snapshot.title) return;
    if (shouldPreserveDuplicateProjectTitle(snapshot.title, nextTitle)) return;

    const applyKey = `${snapshot.projectId}:${nextTitle}`;
    if (appliedProjectTitleKeyRef.current === applyKey) return;
    appliedProjectTitleKeyRef.current = applyKey;

    startTransition(() => {
      setRuntime((prev) => {
        if (prev.currentProjectSnapshot?.projectId !== snapshot.projectId) {
          return prev;
        }

        const nextProjects = prev.recentProjects.map((project) =>
          project.projectId === snapshot.projectId ? { ...project, title: nextTitle } : project,
        );

        return {
          ...prev,
          currentProjectSnapshot: prev.currentProjectSnapshot
            ? { ...prev.currentProjectSnapshot, title: nextTitle }
            : prev.currentProjectSnapshot,
          currentDramaProject: prev.currentDramaProject
            ? { ...prev.currentDramaProject, dramaTitle: nextTitle }
            : prev.currentDramaProject,
          currentVideoProject: prev.currentVideoProject
            ? { ...prev.currentVideoProject, title: nextTitle }
            : prev.currentVideoProject,
          recentProjects: nextProjects,
        };
      });
    });

    void loadProjectStore()
      .then((store) => store.renameConversationProject(snapshot.projectId, nextTitle))
      .catch(() => {
        flashMaintenanceHint("项目名称回写失败，请稍后重试。", 2400);
      });
  }, [
    flashMaintenanceHint,
    loadProjectStore,
    messages,
    runtime.currentProjectSnapshot,
    setRuntime,
  ]);

  useEffect(() => {
    const stepKey = qState ? `${qState.request.id}:${qState.currentIndex}` : null;
    if (stepKey === previousQuestionStepRef.current) return;
    previousQuestionStepRef.current = stepKey;
    if (!stepKey) return;
    setPopoverOverride(null);
    setSelectedValues([]);
    resetComposerDraft("");
  }, [previousQuestionStepRef, qState, resetComposerDraft, setPopoverOverride, setSelectedValues]);

  useEffect(() => {
    if (idle || streaming) return;

    const plan = planConversationCompaction(messages, compactedMessageCount, runtime.recentMessageSummary);
    if (!plan.shouldCompact) return;

    engineRef.current?.interrupt?.();
    engineRef.current = null;
    const maintenanceReport: MaintenanceReport = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      summary: "已静默压缩首页长会话，保留最近上下文与项目摘要。",
      compressedConversationCount: 1,
      archivedProjectCount: 0,
      clearedCacheKeys: [],
      mergedDraftCount: 0,
      notes: [
        runtime.currentProjectSnapshot
          ? `当前项目：${runtime.currentProjectSnapshot.title} / ${runtime.currentProjectSnapshot.derivedStage}`
          : "当前没有绑定项目。",
        `本次整理压缩了 ${plan.compactedMessages.length} 条较早消息。`,
      ],
    };
    setCompactedMessageCount(plan.nextCompactedMessageCount);
    setRuntime((prev) => ({
      ...prev,
      maintenanceReports: [maintenanceReport, ...prev.maintenanceReports].slice(0, 20),
      recentMessageSummary: plan.nextSummary,
    }));
    flashMaintenanceHint("较早对话已静默整理");

    void loadProjectStore()
      .then((store) => {
        const nextReports = [maintenanceReport, ...store.readMaintenanceReports()].slice(0, 20);
        store.writeMaintenanceReports(nextReports);
      })
      .catch(() => {
        // Keep the in-memory report even if persistence fails.
      });

    const jobVersion = compactionJobVersionRef.current + 1;
    compactionJobVersionRef.current = jobVersion;
    const baseSummary = runtime.recentMessageSummary;
    const jobSessionId = runtimeRef.current.sessionId;

    void (async () => {
      try {
        const [semanticSummary, apiConfig] = await Promise.all([
          loadSemanticSummaryModule(),
          loadApiConfigModule(),
        ]);
        const resolvedRuntime = resolveHomeAgentTextModelRuntime(apiConfig, selectedTextModelKey);
        if (!resolvedRuntime.apiKey && !isServerProxyEndpoint(resolvedRuntime.baseUrl)) return;
        const refinedSummary = await semanticSummary.refineCompactedConversationSummary({
          existingSummary: baseSummary,
          compactedMessages: plan.compactedMessages,
          projectSnapshot: runtimeRef.current.currentProjectSnapshot,
          apiKey: resolvedRuntime.apiKey,
          baseUrl: resolvedRuntime.baseUrl,
          model: resolvedRuntime.model,
        });

        if (!refinedSummary.trim()) return;
        if (compactionJobVersionRef.current !== jobVersion) return;
        if (runtimeRef.current.sessionId !== jobSessionId) return;
        if (refinedSummary.trim() === plan.nextSummary.trim()) return;

        startTransition(() => {
          setRuntime((prev) => ({
            ...prev,
            recentMessageSummary: refinedSummary,
          }));
        });
      } catch {
        // Keep the deterministic summary on failure.
      }
    })();

  }, [
    compactedMessageCount,
    compactionJobVersionRef,
    engineRef,
    flashMaintenanceHint,
    idle,
    loadApiConfigModule,
    loadProjectStore,
    loadSemanticSummaryModule,
    messages,
    runtime.currentProjectSnapshot,
    runtime.recentMessageSummary,
    runtimeRef,
    selectedTextModelKey,
    setCompactedMessageCount,
    setRuntime,
    streaming,
  ]);

  const persistSessionImmediately = useCallback((force = false) => {
    if (idle) {
      lastImmediateSessionWriteSignatureRef.current = null;
      lastQueuedSessionWriteSignatureRef.current = null;
      lastQueuedArchiveSignatureRef.current = null;
      clearStudioSession();
      return;
    }

    const persistedProjectId =
      projectHydrationInFlightRef?.current ??
      activeProjectId ??
      deferredProjectSnapshot?.projectId ??
      currentSnapshotProjectId;
    const shouldKeepLiveSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: persistedProjectId,
      snapshot: runtime.currentProjectSnapshot,
    });
    const livePersistedProjectSnapshot =
      runtime.currentProjectSnapshot &&
      (
        runtime.currentProjectSnapshot.projectId === persistedProjectId ||
        shouldKeepLiveSessionProjectId
      )
        ? {
            ...runtime.currentProjectSnapshot,
            automationMode: runtime.currentProjectSnapshot.automationMode ?? automationMode,
          }
        : null;
    const shouldKeepDeferredSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: persistedProjectId,
      snapshot: deferredProjectSnapshot,
    });
    const persistedProjectSnapshot =
      deferredProjectSnapshot &&
      (
        deferredProjectSnapshot.projectId === persistedProjectId ||
        shouldKeepDeferredSessionProjectId
      )
        ? {
            ...deferredProjectSnapshot,
            automationMode: deferredProjectSnapshot.automationMode ?? automationMode,
          }
        : livePersistedProjectSnapshot;
    const hasDeferredSnapshotProjectMismatch = Boolean(
      persistedProjectId &&
        deferredProjectSnapshot?.projectId &&
        deferredProjectSnapshot.projectId !== persistedProjectId &&
        !shouldKeepDeferredSessionProjectId,
    );
    const hasLiveSnapshotProjectMismatch = Boolean(
      persistedProjectId &&
        currentSnapshotProjectId &&
        currentSnapshotProjectId !== persistedProjectId &&
        !shouldKeepLiveSessionProjectId,
    );
    if (hasDeferredSnapshotProjectMismatch || (hasLiveSnapshotProjectMismatch && !persistedProjectSnapshot)) {
      return;
    }

    const hydrationProjectId = projectHydrationInFlightRef?.current ?? null;
    if (mode === "recovering" && persistedProjectId && hydrationProjectId === persistedProjectId) {
      return;
    }

    const shouldDelayProjectSessionWrite =
      streaming &&
      Boolean(
        persistedProjectId &&
          currentSnapshotProjectId &&
          !isCurrentProjectTrackedInRecentProjects,
      );
    if (shouldDelayProjectSessionWrite) {
      return;
    }

    const recentMessageSummaryForPersistence =
      compactedMessageCount > 0 ? runtime.recentMessageSummary : recentSessionSummary;
    const pendingChoiceQuestion =
      pendingWorkflowUploadKind || qState || deferredQuestionState
        ? null
        : (() => {
            const candidate = question ?? popoverOverride ?? suggested ?? interruptedChoiceQuestion ?? null;
            return shouldSuppressRunningVideoRefreshPanel(candidate, runtimeRef.current) ? null : candidate;
          })();
    const resolvedDraft = resolveComposerDraftSnapshot(draftRef.current, persistedDraft);
    const fullAutoRun = runtimeRef.current.fullAutoRun ?? null;
    const nextSessionWriteSignature: QueuedSessionWriteSignature = {
      sessionId: runtimeRef.current.sessionId,
      mode,
      creationMode,
      automationMode,
      devMode,
      suppressHistoricalMemory: runtimeRef.current.suppressHistoricalMemory,
      messages: deferredMessages,
      snapshot: persistedProjectSnapshot,
      recentMessageSummary: recentMessageSummaryForPersistence,
      projectId: persistedProjectId ?? null,
      selectedTextModelKey,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      compactedMessageCount,
      draft: resolvedDraft,
      qState,
      deferredQuestionState,
      pendingWorkflowUploadKind,
      pendingChoiceQuestion,
      interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
      selectedValues,
      deferredSelectedValues,
      deferredDraft,
      surfacedTaskIdsKey: [...surfacedTaskIdsRef.current].join("\u0001"),
      surfacedTaskFollowupKeysKey: [...surfacedTaskFollowupIdsRef.current].join("\u0001"),
      surfacedProjectSuggestionKeysKey: [...surfacedProjectSuggestionKeysRef.current].join("\u0001"),
      fullAutoRun,
      fullAutoChecklistCollapsed,
    };
    if (
      !force &&
      areQueuedSessionWriteSignaturesEqual(
        lastImmediateSessionWriteSignatureRef.current,
        nextSessionWriteSignature,
      )
    ) {
      return;
    }
    lastImmediateSessionWriteSignatureRef.current = nextSessionWriteSignature;

    writeStudioSession({
      sessionId: nextSessionWriteSignature.sessionId,
      mode,
      creationMode,
      automationMode,
      devMode,
      suppressHistoricalMemory: runtimeRef.current.suppressHistoricalMemory,
      messages: deferredMessages,
      currentProjectSnapshot: persistedProjectSnapshot,
      recentMessageSummary: recentMessageSummaryForPersistence,
      projectId: persistedProjectId,
      selectedTextModelKey,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      compactedMessageCount,
      draft: resolvedDraft,
      qState,
      deferredQuestionState,
      pendingWorkflowUploadKind,
      pendingChoiceQuestion,
      interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
      selectedValues,
      deferredSelectedValues,
      deferredDraft,
      surfacedTaskIds: [...surfacedTaskIdsRef.current],
      surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
      surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
      fullAutoRun: nextSessionWriteSignature.fullAutoRun,
      fullAutoChecklistCollapsed: nextSessionWriteSignature.fullAutoChecklistCollapsed,
    }, { persistFullBackup: false });
  }, [
    activeProjectId,
    automationMode,
    compactedMessageCount,
    creationMode,
    currentSnapshotProjectId,
    deferredDraft,
    deferredMessages,
    deferredProjectSnapshot,
    deferredQuestionState,
    deferredSelectedValues,
    devMode,
    draftRef,
    fullAutoChecklistCollapsed,
    idle,
    imageGenerationPrefs,
    interruptedChoiceQuestion,
    isCurrentProjectTrackedInRecentProjects,
    mode,
    pendingWorkflowUploadKind,
    persistedDraft,
    popoverOverride,
    projectHydrationInFlightRef,
    qState,
    question,
    recentSessionSummary,
    runtime.currentProjectSnapshot,
    runtime.recentMessageSummary,
    runtimeRef,
    selectedImageModelFamily,
    selectedTextModelKey,
    selectedValues,
    selectedVideoModelKey,
    streaming,
    suggested,
    surfacedProjectSuggestionKeysRef,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
    videoGenerationPrefs,
    lastImmediateSessionWriteSignatureRef,
  ]);

  useEffect(() => {
    if (idle) {
      lastQueuedSessionWriteSignatureRef.current = null;
      lastQueuedArchiveSignatureRef.current = null;
      lastImmediateSessionWriteSignatureRef.current = null;
      clearStudioSession();
      return;
    }

    const persistedProjectId =
      projectHydrationInFlightRef?.current ??
      activeProjectId ??
      deferredProjectSnapshot?.projectId ??
      currentSnapshotProjectId;
    const shouldKeepLiveSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: persistedProjectId,
      snapshot: runtime.currentProjectSnapshot,
    });
    const livePersistedProjectSnapshot =
      runtime.currentProjectSnapshot &&
      (
        runtime.currentProjectSnapshot.projectId === persistedProjectId ||
        shouldKeepLiveSessionProjectId
      )
        ? {
            ...runtime.currentProjectSnapshot,
            automationMode: runtime.currentProjectSnapshot.automationMode ?? automationMode,
          }
        : null;
    const shouldKeepDeferredSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: persistedProjectId,
      snapshot: deferredProjectSnapshot,
    });
    const persistedProjectSnapshot =
      deferredProjectSnapshot &&
      (
        deferredProjectSnapshot.projectId === persistedProjectId ||
        shouldKeepDeferredSessionProjectId
      )
        ? {
            ...deferredProjectSnapshot,
            automationMode: deferredProjectSnapshot.automationMode ?? automationMode,
          }
        : livePersistedProjectSnapshot;
    const hasDeferredSnapshotProjectMismatch = Boolean(
      persistedProjectId &&
        deferredProjectSnapshot?.projectId &&
        deferredProjectSnapshot.projectId !== persistedProjectId &&
        !shouldKeepDeferredSessionProjectId,
    );
    const hasLiveSnapshotProjectMismatch = Boolean(
      persistedProjectId &&
        currentSnapshotProjectId &&
        currentSnapshotProjectId !== persistedProjectId &&
        !shouldKeepLiveSessionProjectId,
    );
    if (hasDeferredSnapshotProjectMismatch || (hasLiveSnapshotProjectMismatch && !persistedProjectSnapshot)) {
      return;
    }
    const hydrationProjectId = projectHydrationInFlightRef?.current ?? null;
    if (mode === "recovering" && persistedProjectId && hydrationProjectId === persistedProjectId) {
      return;
    }
    const shouldDelayProjectSessionWrite =
      streaming &&
      Boolean(
        persistedProjectId &&
          currentSnapshotProjectId &&
          !isCurrentProjectTrackedInRecentProjects,
      );
    if (shouldDelayProjectSessionWrite) {
      return;
    }
    const recentMessageSummaryForPersistence =
      compactedMessageCount > 0 ? runtime.recentMessageSummary : recentSessionSummary;
    const nextArchiveSignature: QueuedSessionArchiveSignature | null = persistedProjectId
      ? {
          projectId: persistedProjectId,
          messages: deferredMessages,
          snapshot: persistedProjectSnapshot,
          recentMessageSummary: recentMessageSummaryForPersistence,
          compactedMessageCount,
          fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
        }
      : null;
    const shouldPersistFullBackup =
      !nextArchiveSignature ||
      !lastQueuedArchiveSignatureRef.current ||
      lastQueuedArchiveSignatureRef.current.projectId !== nextArchiveSignature.projectId ||
      lastQueuedArchiveSignatureRef.current.messages !== nextArchiveSignature.messages ||
      lastQueuedArchiveSignatureRef.current.snapshot !== nextArchiveSignature.snapshot ||
      lastQueuedArchiveSignatureRef.current.recentMessageSummary !== nextArchiveSignature.recentMessageSummary ||
      lastQueuedArchiveSignatureRef.current.compactedMessageCount !== nextArchiveSignature.compactedMessageCount ||
      lastQueuedArchiveSignatureRef.current.fullAutoRun !== nextArchiveSignature.fullAutoRun;

    if (shouldPersistFullBackup && nextArchiveSignature) {
      lastQueuedArchiveSignatureRef.current = nextArchiveSignature;
    }
    const shouldPersistKickoffSessionImmediately =
      !persistedProjectId &&
      !persistedProjectSnapshot &&
      Boolean(
        qState ||
          deferredQuestionState ||
          pendingWorkflowUploadKind ||
          popoverOverride ||
          interruptedChoiceQuestion ||
          suggested,
      );
    const persistenceDelayMs = shouldPersistKickoffSessionImmediately ? 0 : 720;
    const pendingChoiceQuestion =
      pendingWorkflowUploadKind || qState || deferredQuestionState
        ? null
        : (() => {
            const candidate = question ?? popoverOverride ?? suggested ?? interruptedChoiceQuestion ?? null;
            return shouldSuppressRunningVideoRefreshPanel(candidate, runtimeRef.current) ? null : candidate;
          })();
    const resolvedDraft = resolveComposerDraftSnapshot(draftRef.current, persistedDraft);
    const fullAutoRun = runtimeRef.current.fullAutoRun ?? null;
    const nextSessionWriteSignature: QueuedSessionWriteSignature = {
      sessionId: runtimeRef.current.sessionId,
      mode,
      creationMode,
      automationMode,
      devMode,
      suppressHistoricalMemory: runtimeRef.current.suppressHistoricalMemory,
      messages: deferredMessages,
      snapshot: persistedProjectSnapshot,
      recentMessageSummary: recentMessageSummaryForPersistence,
      projectId: persistedProjectId ?? null,
      selectedTextModelKey,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      compactedMessageCount,
      draft: resolvedDraft,
      qState,
      deferredQuestionState,
      pendingWorkflowUploadKind,
      pendingChoiceQuestion,
      interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
      selectedValues,
      deferredSelectedValues,
      deferredDraft,
      surfacedTaskIdsKey: [...surfacedTaskIdsRef.current].join("\u0001"),
      surfacedTaskFollowupKeysKey: [...surfacedTaskFollowupIdsRef.current].join("\u0001"),
      surfacedProjectSuggestionKeysKey: [...surfacedProjectSuggestionKeysRef.current].join("\u0001"),
      fullAutoRun,
      fullAutoChecklistCollapsed,
    };
    if (
      !shouldPersistFullBackup &&
      areQueuedSessionWriteSignaturesEqual(
        lastQueuedSessionWriteSignatureRef.current,
        nextSessionWriteSignature,
      )
    ) {
      return;
    }
    lastQueuedSessionWriteSignatureRef.current = nextSessionWriteSignature;
    const cancelTask = scheduleBackgroundTask(() => {
      queueStudioSessionWrite({
        sessionId: nextSessionWriteSignature.sessionId,
        mode,
        creationMode,
        automationMode,
        devMode,
        suppressHistoricalMemory: nextSessionWriteSignature.suppressHistoricalMemory,
        messages: deferredMessages,
        currentProjectSnapshot: persistedProjectSnapshot,
        recentMessageSummary: recentMessageSummaryForPersistence,
        projectId: persistedProjectId,
        selectedTextModelKey,
        selectedImageModelFamily,
        imageGenerationPrefs,
        selectedVideoModelKey,
        videoGenerationPrefs,
        compactedMessageCount,
        draft: resolvedDraft,
        qState,
        deferredQuestionState,
        pendingWorkflowUploadKind,
        pendingChoiceQuestion,
        interruptedChoiceQuestion: pendingWorkflowUploadKind ? null : interruptedChoiceQuestion,
        selectedValues,
        deferredSelectedValues,
        deferredDraft,
        surfacedTaskIds: [...surfacedTaskIdsRef.current],
        surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
        surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
        fullAutoRun,
        fullAutoChecklistCollapsed,
      }, 120, { persistFullBackup: shouldPersistFullBackup });
    }, persistenceDelayMs);

    return cancelTask;
  }, [
    activeProjectId,
    automationMode,
    creationMode,
    compactedMessageCount,
    deferredMessages,
    deferredDraft,
    deferredProjectSnapshot,
    deferredQuestionState,
    deferredSelectedValues,
    draftRef,
    fullAutoChecklistCollapsed,
    idle,
    interruptedChoiceQuestion,
    mode,
    pendingWorkflowUploadKind,
    persistedDraft,
    question,
    popoverOverride,
    projectHydrationInFlightRef,
    qState,
    recentSessionSummary,
    runtime.recentMessageSummary,
    runtimeRef,
    devMode,
    scheduleBackgroundTask,
    selectedValues,
    selectedTextModelKey,
    selectedImageModelFamily,
    imageGenerationPrefs,
    selectedVideoModelKey,
    videoGenerationPrefs,
    surfacedProjectSuggestionKeysRef,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
    suggested,
    currentSnapshotProjectId,
    isCurrentProjectTrackedInRecentProjects,
    streaming,
  ]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const flushOnPageExit = () => {
      persistSessionImmediately();
    };
    const flushOnVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushOnPageExit();
      }
    };

    document.addEventListener("visibilitychange", flushOnVisibilityChange);
    window.addEventListener("pagehide", flushOnPageExit);
    window.addEventListener("beforeunload", flushOnPageExit);
    return () => {
      document.removeEventListener("visibilitychange", flushOnVisibilityChange);
      window.removeEventListener("pagehide", flushOnPageExit);
      window.removeEventListener("beforeunload", flushOnPageExit);
    };
  }, [persistSessionImmediately]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const updateVisibility = () => {
      setPageVisible(document.visibilityState === "visible");
    };

    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", updateVisibility);
    window.addEventListener("blur", updateVisibility);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateVisibility);
      window.removeEventListener("blur", updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    const activeSnapshot = runtime.currentProjectSnapshot;
    const isBridgedVideoSnapshot = shouldKeepSessionProjectIdForBridgedVideo({
      currentSessionProjectId: activeProjectId,
      snapshot: activeSnapshot,
    });
    const hasResolvedActiveProjectData = isBridgedVideoSnapshot
      ? Boolean(runtime.currentDramaProject && runtime.currentVideoProject)
      : Boolean(runtime.currentDramaProject || runtime.currentVideoProject);
    if (hasResolvedActiveProjectData) return;
    if (projectHydrationInFlightRef?.current === activeProjectId) return;

    let cancelled = false;
    const bridgedVideoProjectId = isBridgedVideoSnapshot ? activeSnapshot?.projectId ?? null : null;

    void loadProjectStore()
      .then((store) =>
        Promise.all([
          store.loadConversationSourceById(activeProjectId, {
            includeSnapshot: false,
            fastVideoLoad: true,
          }),
          bridgedVideoProjectId
            ? store.loadConversationSourceById(bridgedVideoProjectId, {
                includeSnapshot: false,
                fastVideoLoad: true,
              })
            : Promise.resolve(null),
        ])
      )
      .then(([source, bridgedVideoSource]) => {
        if (
          cancelled ||
          (!source.dramaProject && !source.videoProject && !bridgedVideoSource?.videoProject)
        ) {
          return;
        }

        const refreshedSnapshot =
          source.snapshot ??
          (source.videoProject && activeSnapshot?.projectId === source.videoProject.id
            ? store.createVideoSnapshot(source.videoProject)
            : source.dramaProject && activeSnapshot?.projectId === source.dramaProject.id
              ? store.createDramaSnapshot(source.dramaProject)
              : activeSnapshot);

        startTransition(() => {
          setRuntime((prev) => {
            const stillBridgedVideoSnapshot = shouldKeepSessionProjectIdForBridgedVideo({
              currentSessionProjectId: activeProjectId,
              snapshot: prev.currentProjectSnapshot,
            });
            const matchesActiveHistorySession =
              prev.currentProjectSnapshot?.projectId === activeProjectId ||
              stillBridgedVideoSnapshot;
            if (!matchesActiveHistorySession) return prev;
            return {
              ...prev,
              currentProjectSnapshot: refreshedSnapshot ?? prev.currentProjectSnapshot,
              currentDramaProject: source.dramaProject ?? prev.currentDramaProject,
              currentVideoProject: stillBridgedVideoSnapshot
                ? (bridgedVideoSource?.videoProject ?? prev.currentVideoProject)
                : (source.videoProject ?? prev.currentVideoProject),
            };
          });
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId,
    loadProjectStore,
    projectHydrationInFlightRef,
    runtime.currentProjectSnapshot,
    runtime.currentDramaProject,
    runtime.currentVideoProject,
    setRuntime,
  ]);

  useEffect(() => {
    const groupedTaskIds = new Set(
      backgroundResearchGroupsRef.current.flatMap((group) => group.taskIds),
    );
    const taskMap = new Map(visibleTasks.map((task) => [task.id, task]));
    const readyGroups = backgroundResearchGroupsRef.current.filter((group) => {
      const activeProjectId = runtimeRef.current.currentProjectSnapshot?.projectId;
      const groupTasks = group.taskIds.map((taskId) => taskMap.get(taskId)).filter(Boolean);
      return (
        (group.status === "pending" || group.status === "cancelled") &&
        (!group.projectId || !activeProjectId || group.projectId === activeProjectId) &&
        groupTasks.length === group.taskIds.length &&
        groupTasks.every((task) => task && ["completed", "failed", "cancelled"].includes(task.status))
      );
    });

    if (!pendingWorkflowUploadKind && !qState && !draftPresence && readyGroups.length) {
      for (const group of readyGroups) {
        if (!canBackgroundResearchReplacePopover(group, popoverOverride)) {
          continue;
        }
        const groupTasks = group.taskIds
          .map((taskId) => taskMap.get(taskId))
          .filter((task): task is Task => Boolean(task));
        if (!groupTasks.length) continue;

        const hasUsableResult = groupTasks.some((task) => task.status === "completed");
        if (group.status === "cancelled" || !hasUsableResult) {
          const retryQuestion =
            group.kind === "video-bridge-platform"
              ? buildVideoBridgeRetryQuestion(runtimeRef.current.currentProjectSnapshot)
              : null;
          if (retryQuestion) {
            startTransition(() => {
              push("assistant", "自动补齐平台与镜头偏好没有成功完成，你可以手动再试一次。");
              setPopoverOverride(retryQuestion);
            });
          }
          group.onFinish?.("cancelled");
          backgroundResearchGroupsRef.current = backgroundResearchGroupsRef.current.filter(
            (item) => item.id !== group.id,
          );
          continue;
        }

        group.status = "forwarding";
        group.taskIds.forEach((taskId) => surfacedTaskIdsRef.current.add(taskId));

        if (group.kind === "video-bridge-platform") {
          const bridgeInput = buildVideoBridgeResearchInput({
            tasks: groupTasks,
            parseTaskHeading,
          });
          const bridgeMessage = buildVideoBridgeResearchMessage(bridgeInput);

          void loadWorkflowActionsModule()
            .then((workflow) =>
              workflow.runWorkflowAction(
                "create_video_bridge_artifact",
                {
                  projectId: runtimeRef.current.currentProjectSnapshot?.projectId,
                  ...bridgeInput,
                },
                runtimeRef.current,
              ),
            )
            .then((result) => {
              const nextProjectSnapshot =
                result.projectSnapshot ?? result.data?.projectSnapshot ?? runtimeRef.current.currentProjectSnapshot;
              const nextRuntime = result.data
                ? mergeRuntimeWithWorkflowDelta(runtimeRef.current, result.data, {
                    deferRecentProjectUpsert: streaming,
                  })
                : runtimeRef.current;

              startTransition(() => {
                push("assistant", bridgeMessage);
                if (result.data) {
                  setRuntime((previous) =>
                    mergeRuntimeWithWorkflowDelta(previous, result.data, {
                      deferRecentProjectUpsert: streaming,
                    }),
                  );
                  const nextProjectId = nextProjectSnapshot?.projectId;
                  const shouldKeepSessionProjectId = shouldKeepSessionProjectIdForBridgedVideo({
                    currentSessionProjectId: activeProjectId,
                    snapshot: nextProjectSnapshot,
                  });
                  if (nextProjectId && !shouldKeepSessionProjectId) {
                    setActiveProjectId(nextProjectId);
                  }
                }

                const nextSuggestion = recQuestion(nextProjectSnapshot, nextRuntime.currentVideoProject);
                if (!shouldSuppressRunningVideoRefreshPanel(nextSuggestion, nextRuntime)) {
                  setPopoverOverride(nextSuggestion);
                }
              });
            })
            .catch(() => {
              const retryQuestion = buildVideoBridgeRetryQuestion(
                runtimeRef.current.currentProjectSnapshot,
              );

              if (retryQuestion) {
                startTransition(() => {
                  push("assistant", "平台与镜头偏好的自动写入失败了，你可以重新发起一次补齐。");
                  setPopoverOverride(retryQuestion);
                });
              }
            })
            .finally(() => {
              group.onFinish?.("completed");
              backgroundResearchGroupsRef.current = backgroundResearchGroupsRef.current.filter(
                (item) => item.id !== group.id,
              );
            });
          continue;
        }
      }
    }

    const newlySurfacedTasks: Task[] = [];

    for (const task of visibleTasks) {
      if (!["completed", "failed"].includes(task.status)) continue;
      if (surfacedTaskIdsRef.current.has(task.id)) continue;
      if (groupedTaskIds.has(task.id)) continue;

      if (isBackgroundResearchTask(task)) {
        surfacedTaskIdsRef.current.add(task.id);
        newlySurfacedTasks.push(task);
        continue;
      }

      const nextMessage = buildTaskResultMessage(task);
      if (nextMessage) {
        surfacedTaskIdsRef.current.add(task.id);
        newlySurfacedTasks.push(task);
        push("assistant", nextMessage);
      }
    }

    if (!newlySurfacedTasks.length) return;
    if (pendingWorkflowUploadKind || qState || streaming || draftPresence || popoverOverride) return;

    const pendingTaskCount = visibleTasks.filter(
      (task) => task.status === "running" || task.status === "pending",
    ).length;
    if (pendingTaskCount > 0) return;

    const readyTasks = visibleTasks.filter(
      (task) => ["completed", "failed"].includes(task.status) && !groupedTaskIds.has(task.id),
    );
    const followupKey = readyTasks.map((task) => task.id).sort().join(",");
    if (!followupKey || surfacedTaskFollowupIdsRef.current.has(followupKey)) return;

    const restoredTaskFollowupSuppression = restoredTaskFollowupSuppressionRef?.current ?? null;
    if (
      restoredTaskFollowupSuppression &&
      restoredTaskFollowupSuppression.sessionId === runtimeRef.current.sessionId
    ) {
      const shouldSuppressRestoredFollowup = readyTasks.every(
        (task) => Number(task.updatedAt ?? task.createdAt ?? 0) <= restoredTaskFollowupSuppression.restoredAt,
      );
      if (shouldSuppressRestoredFollowup) {
        surfacedTaskFollowupIdsRef.current.add(followupKey);
        if (restoredTaskFollowupSuppressionRef) restoredTaskFollowupSuppressionRef.current = null;
        return;
      }
      if (restoredTaskFollowupSuppressionRef) restoredTaskFollowupSuppressionRef.current = null;
    }

    surfacedTaskFollowupIdsRef.current.add(followupKey);
    return;
  }, [
    backgroundResearchGroupsRef,
    buildTaskResultMessage,
    draftPresence,
    loadWorkflowActionsModule,
    parseTaskHeading,
    pendingWorkflowUploadKind,
    popoverOverride,
    push,
    qState,
    runtimeRef,
    restoredTaskFollowupSuppressionRef,
    setActiveProjectId,
    setPopoverOverride,
    setRuntime,
    streaming,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
    visibleTasks,
  ]);
}
