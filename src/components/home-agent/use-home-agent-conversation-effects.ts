import * as React from "react";
import type { MessageInput } from "@/lib/agent/types";
import { clearStudioSession, queueStudioSessionWrite } from "@/lib/home-agent/session-store";
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
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { Task } from "@/lib/agent/tools/task-tools";
import { createWorkflowShortcutUiBridge } from "./home-agent-workflow-ui";
import { buildVideoBridgeRetryQuestion, recQuestion } from "./home-agent-project-questions";
import {
  type BackgroundResearchGroup,
  isBackgroundResearchTask,
} from "./home-agent-task-utils";
import { isScriptPopoverCompatibleWithCurrentStage } from "./use-home-agent-question-view";

const { useEffect, useRef, useState, startTransition } = React;

type AutoCharacterGenerationPlan = {
  action: "generate_characters" | "generate_character_transform";
  key: string;
  projectId: string;
};

type RestoredTaskFollowupSuppression = {
  sessionId: string;
  restoredAt: number;
};

function summarizeBridgeResearchValue(output: string): string {
  const normalized = output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^[-*•\d.\s]+/, "").trim())
    .find(Boolean);

  if (!normalized) return "";

  const matched =
    normalized.match(/(?:目标平台|发布平台|平台|镜头风格|风格|视觉方向|出片目标|产出目标|目标)[:：]\s*(.+)$/) ??
    normalized.match(/^建议[:：]\s*(.+)$/);

  return matched?.[1]?.trim() ?? normalized;
}


function buildVideoBridgeResearchInput(params: {
  tasks: Array<Pick<Task, "prompt" | "output">>;
  parseTaskHeading: (prompt: string) => string | null;
}): {
  targetPlatform: string;
  shotStyle: string;
  outputGoal: string;
  productionNotes: string;
} {
  const { tasks, parseTaskHeading } = params;
  let targetPlatform = "";
  let shotStyle = "";
  let outputGoal = "";

  const notes = tasks
    .map((task) => {
      const heading = parseTaskHeading(task.prompt) || "研究结论";
      const output = (task.output ?? "").trim();
      if (!output) return null;

      if (!targetPlatform && /平台/.test(heading)) {
        targetPlatform = summarizeBridgeResearchValue(output);
      } else if (!shotStyle && /(视觉|风格|镜头)/.test(heading)) {
        shotStyle = summarizeBridgeResearchValue(output);
      } else if (!outputGoal && /(出片|策略|目标)/.test(heading)) {
        outputGoal = summarizeBridgeResearchValue(output);
      }

      return `【${heading}】\n${output}`;
    })
    .filter((value): value is string => Boolean(value));

  return {
    targetPlatform,
    shotStyle,
    outputGoal,
    productionNotes: notes.join("\n\n"),
  };
}

function buildVideoBridgeResearchMessage(params: {
  targetPlatform: string;
  shotStyle: string;
  outputGoal: string;
  productionNotes: string;
}): string {
  const hasAnyBridgeValue = Boolean(
    params.targetPlatform || params.shotStyle || params.outputGoal || params.productionNotes,
  );
  return hasAnyBridgeValue
    ? "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002"
    : "\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002";
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
  popoverOverride: ComposerQuestion | null;
  suggested: ComposerQuestion | null;
  suppressVideoWorkflowSuggestions?: boolean;
  draftPresence: boolean;
  persistedDraft: string;
  deferredDraft: string;
  recentSessionSummary: string;
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
    popoverOverride,
    suggested,
    suppressVideoWorkflowSuggestions = false,
    draftPresence,
    persistedDraft,
    deferredDraft,
    recentSessionSummary,
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

  useEffect(() => {
    if (qState || streaming || popoverOverride || draftPresence) return;

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
          ? mergeRuntimeWithWorkflowDelta(currentRuntime, result.data)
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
    qState,
    runtime.currentDramaProject,
    runtime.currentProjectSnapshot,
    runtime.maintenanceReports,
    runtime.currentVideoProject,
    runtime.skillDrafts,
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
    if (idle || streaming || qState || popoverOverride || draftPresence) return;

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
          if (projectId) {
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

  useEffect(() => {
    if (idle) {
      clearStudioSession();
      return;
    }

    const persistedProjectId = runtime.currentProjectSnapshot?.projectId ?? activeProjectId;
    const cancelTask = scheduleBackgroundTask(() => {
      const pendingChoiceQuestion =
        qState || deferredQuestionState
          ? null
          : (() => {
              const candidate = popoverOverride ?? suggested ?? null;
              return shouldSuppressRunningVideoRefreshPanel(candidate, runtimeRef.current) ? null : candidate;
            })();
      queueStudioSessionWrite({
        sessionId: runtimeRef.current.sessionId,
        mode,
        creationMode,
        automationMode,
        devMode,
        messages: deferredMessages,
        currentProjectSnapshot: deferredProjectSnapshot
          ? {
              ...deferredProjectSnapshot,
              automationMode: deferredProjectSnapshot.automationMode ?? automationMode,
            }
          : null,
        recentMessageSummary: compactedMessageCount > 0 ? runtime.recentMessageSummary : recentSessionSummary,
        projectId: persistedProjectId,
        selectedTextModelKey,
        selectedImageModelFamily,
        imageGenerationPrefs,
        selectedVideoModelKey,
        videoGenerationPrefs,
        compactedMessageCount,
        draft: draftRef.current || persistedDraft,
        qState,
        deferredQuestionState,
        pendingChoiceQuestion,
        selectedValues,
        deferredSelectedValues,
        deferredDraft,
        surfacedTaskIds: [...surfacedTaskIdsRef.current],
        surfacedTaskFollowupKeys: [...surfacedTaskFollowupIdsRef.current],
        surfacedProjectSuggestionKeys: [...surfacedProjectSuggestionKeysRef.current],
        fullAutoRun: runtimeRef.current.fullAutoRun ?? null,
      });
    }, 720);

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
    idle,
    mode,
    persistedDraft,
    popoverOverride,
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
    runtime.currentProjectSnapshot?.projectId,
  ]);

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
    if (runtime.currentDramaProject || runtime.currentVideoProject) return;

    let cancelled = false;

    void loadProjectStore()
      .then((store) =>
        store.loadConversationSourceById(activeProjectId, {
          includeSnapshot: false,
          fastVideoLoad: true,
        })
      )
      .then((source) => {
        if (cancelled || (!source.dramaProject && !source.videoProject)) return;

        startTransition(() => {
          setRuntime((prev) => {
            if (prev.currentProjectSnapshot?.projectId !== activeProjectId) return prev;
            return {
              ...prev,
              currentDramaProject: source.dramaProject,
              currentVideoProject: source.videoProject,
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

    if (!qState && !draftPresence && !popoverOverride && readyGroups.length) {
      for (const group of readyGroups) {
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
                ? mergeRuntimeWithWorkflowDelta(runtimeRef.current, result.data)
                : runtimeRef.current;

              startTransition(() => {
                push("assistant", bridgeMessage);
                if (result.data) {
                  setRuntime((previous) => mergeRuntimeWithWorkflowDelta(previous, result.data));
                  const nextProjectId = nextProjectSnapshot?.projectId;
                  if (nextProjectId) {
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
    if (qState || streaming || draftPresence || popoverOverride) return;

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
