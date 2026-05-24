import * as React from "react";
import { flushSync } from "react-dom";
import type { MessageInput } from "@/lib/agent/types";
import {
  hasSessionResetMarkerForProject,
  readStudioProjectSession,
  readProjectSessionFromFile,
} from "@/lib/home-agent/session-store";
import { buildOpenProjectSessionState, hasStaleSavedReviewQuestion } from "./home-agent-conversation-state";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  AutomationMode,
  CreationMode,
  HomeAgentMessage,
  PendingWorkflowUploadKind,
  StudioSessionState,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
} from "@/types/project";
import { brief, recQuestion } from "./home-agent-project-questions";
import { normalizeHomeAgentTextModelKey } from "@/lib/home-agent/text-models";
import {
  normalizeHomeAgentImageModelFamilyKey,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
} from "@/lib/home-agent/video-models";
import { formatAskUserQuestionFallback } from "./home-agent-send-flow";
import {
  normalizeWorkflowBoundAskUserQuestionRequest,
  resolveWorkflowBoundComposerQuestion,
} from "./home-agent-ask-user-question-guard";
import {
  HOME_AGENT_HISTORY_DISPLAY_LIMIT,
  resolvePendingWorkflowUploadKind,
} from "./home-agent-session-utils";

const { useCallback, useEffect, useRef, startTransition } = React;

type RestoredTaskFollowupSuppression = {
  sessionId: string;
  restoredAt: number;
};

function hasPendingInteraction(session: StudioSessionState | null | undefined): boolean {
  return Boolean(
    session?.qState ||
      session?.deferredQuestionState ||
      resolvePendingWorkflowUploadKind(session) ||
      session?.pendingChoiceQuestion ||
      session?.interruptedChoiceQuestion,
  );
}

function getPendingInteractionPriority(session: StudioSessionState | null | undefined): number {
  if (resolvePendingWorkflowUploadKind(session)) return 2;
  if (session?.qState || session?.deferredQuestionState) return 2;
  if (session?.interruptedChoiceQuestion) return 1;
  if (session?.pendingChoiceQuestion) return 1;
  return 0;
}

function shouldHydrateProjectSessionFromFile(
  session: StudioSessionState | null | undefined,
): boolean {
  if (!session) return true;
  if (hasPendingInteraction(session)) return true;

  const messageCount = Array.isArray(session.messages) ? session.messages.length : 0;
  const artifactCount = Array.isArray(session.currentProjectSnapshot?.artifacts)
    ? session.currentProjectSnapshot.artifacts.length
    : 0;

  return messageCount >= 100 || artifactCount >= 10 || (session.compactedMessageCount ?? 0) > 0;
}

export function selectRecoveredProjectSession(
  localSession: StudioSessionState | null,
  fileSession: StudioSessionState | null,
): StudioSessionState | null {
  if (localSession && !fileSession) return localSession;
  if (fileSession && !localSession) return fileSession;
  if (!localSession && !fileSession) return null;

  const localHasPendingInteraction = hasPendingInteraction(localSession);
  const fileHasPendingInteraction = hasPendingInteraction(fileSession);
  if (localHasPendingInteraction !== fileHasPendingInteraction) {
    return localHasPendingInteraction ? localSession : fileSession;
  }

  const localPendingPriority = getPendingInteractionPriority(localSession);
  const filePendingPriority = getPendingInteractionPriority(fileSession);
  if (localPendingPriority !== filePendingPriority) {
    return localPendingPriority > filePendingPriority ? localSession : fileSession;
  }

  return fileSession && localSession && fileSession.messages.length >= localSession.messages.length
    ? fileSession
    : (localSession ?? fileSession);
}

export function useHomeAgentRecoveryFlow(params: {
  handoffRef: React.MutableRefObject<boolean>;
  engineRef: React.MutableRefObject<{ interrupt?: () => void } | null>;
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  projectHydrationInFlightRef?: React.MutableRefObject<string | null>;
  loadProjectStore: () => Promise<typeof import("@/lib/home-agent/project-store")>;
  flushSessionRef: React.MutableRefObject<() => void>;
  beforeProjectOpen?: (projectId: string) => void;
  setCreationMode: React.Dispatch<React.SetStateAction<CreationMode>>;
  setAutomationMode: React.Dispatch<React.SetStateAction<AutomationMode>>;
  setDevMode: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTextModelKey: React.Dispatch<React.SetStateAction<string>>;
  setSelectedImageModelFamily: React.Dispatch<React.SetStateAction<VideoImageModelFamilyKey>>;
  setImageGenerationPrefs: React.Dispatch<React.SetStateAction<VideoImageGenerationPrefs>>;
  setSelectedVideoModelKey: React.Dispatch<React.SetStateAction<VideoGenerationModelKey>>;
  setVideoGenerationPrefs: React.Dispatch<React.SetStateAction<VideoGenerationPrefs>>;
  setQState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setDeferredQuestionState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setPendingWorkflowUploadKind: React.Dispatch<React.SetStateAction<PendingWorkflowUploadKind | null>>;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setInterruptedChoiceQuestion: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setFullAutoChecklistCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setMode: React.Dispatch<React.SetStateAction<"idle" | "active" | "recovering" | "maintenance-review">>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setCompactedMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setMetaReady: React.Dispatch<React.SetStateAction<boolean>>;
  resetComposerDraft: (value?: string) => void;
  getComposerDraftSnapshot: () => string;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  previousQuestionStepRef: React.MutableRefObject<string | null>;
  clearSurfacedTasks: () => void;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  restoredTaskFollowupSuppressionRef: React.MutableRefObject<RestoredTaskFollowupSuppression | null>;
  surfacedProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  restoredProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  send: (prompt: MessageInput, shown?: string) => Promise<void>;
  createQuestionState: (request: AskUserQuestionRequest) => StudioQuestionState;
  mk: (role: HomeAgentMessage["role"], content: string) => HomeAgentMessage;
  mergeRecentProjects: (
    currentProjects: ConversationProjectSnapshot[],
    nextProject: ConversationProjectSnapshot,
    limit?: number,
  ) => ConversationProjectSnapshot[];
}) {
  const {
    handoffRef,
    engineRef,
    runtimeRef,
    projectHydrationInFlightRef,
    loadProjectStore,
    flushSessionRef,
    beforeProjectOpen,
    setCreationMode,
    setAutomationMode,
    setDevMode,
    setActiveProjectId,
    setSelectedTextModelKey,
    setSelectedImageModelFamily,
    setImageGenerationPrefs,
    setSelectedVideoModelKey,
    setVideoGenerationPrefs,
    setQState,
    setDeferredQuestionState,
    setPendingWorkflowUploadKind,
    setPopoverOverride,
    setInterruptedChoiceQuestion,
    setSuggested,
    setSelectedValues,
    setDeferredSelectedValues,
    setFullAutoChecklistCollapsed,
    setStreaming,
    setMode,
    setMessages,
    setCompactedMessageCount,
    setRuntime,
    setMetaReady,
    resetComposerDraft,
    getComposerDraftSnapshot,
    setDeferredDraft,
    previousQuestionStepRef,
    clearSurfacedTasks,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    restoredTaskFollowupSuppressionRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,    send,
    createQuestionState,
    mk,
    mergeRecentProjects,
  } = params;
  const openProjectVersionRef = useRef(0);
  const clearProjectHydrationInFlight = useCallback(
    (projectId: string) => {
      if (projectHydrationInFlightRef?.current === projectId) {
        projectHydrationInFlightRef.current = null;
      }
    },
    [projectHydrationInFlightRef],
  );
  const cancelPendingProjectOpen = useCallback(() => {
    openProjectVersionRef.current += 1;
    if (projectHydrationInFlightRef) {
      projectHydrationInFlightRef.current = null;
    }
  }, [projectHydrationInFlightRef]);

  const openProject = useCallback(
    async (projectId: string) => {
      const openVersion = openProjectVersionRef.current + 1;
      openProjectVersionRef.current = openVersion;
      const runtimeState = runtimeRef?.current;
      const hadCurrentProjectBeforeOpen = Boolean(runtimeState?.currentProjectSnapshot?.projectId);
      // 切换前先同步保存当前项目状态，防止防抖保存被取消导致状态丢失
      flushSessionRef.current();
      if (projectHydrationInFlightRef) {
        projectHydrationInFlightRef.current = projectId;
      }

      beforeProjectOpen?.(projectId);
      engineRef.current?.interrupt?.();
      engineRef.current = null;
      clearSurfacedTasks();

      startTransition(() => {
        setStreaming(false);
        setQState(null);
        setDeferredQuestionState(null);
        setPendingWorkflowUploadKind(null);
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setDeferredSelectedValues([]);
        setDeferredDraft("");
      });

      // 优先从 localStorage 读取（同步，无延迟）
      const isReset = hasSessionResetMarkerForProject(projectId);
      const localSession = readStudioProjectSession(projectId);
      const cachedSnapshot = localSession?.currentProjectSnapshot ?? null;
      const recentSnapshot =
        runtimeState?.recentProjects.find((snapshot) => snapshot.projectId === projectId) ?? null;

      if (!cachedSnapshot && recentSnapshot) {
        startTransition(() => {
          setAutomationMode(recentSnapshot.automationMode === "full-auto" ? "full-auto" : "manual");
          setActiveProjectId(projectId);
          setMode("recovering");
          setPendingWorkflowUploadKind(resolvePendingWorkflowUploadKind(localSession));
          setRuntime((prev) => ({
            ...prev,
            suppressHistoricalMemory: true,
            currentProjectSnapshot: recentSnapshot,
            currentDramaProject: null,
            currentVideoProject: null,
            recentProjects: mergeRecentProjects(prev.recentProjects, recentSnapshot),
            fullAutoRun: null,
          }));
        });
      }

      // 并行启动文件系统读取，不阻塞 UI 渲染
      const fileSessionPromise = (() => {
        if (isReset || !shouldHydrateProjectSessionFromFile(localSession)) {
          return Promise.resolve(null);
        }
        if (typeof window === "undefined") {
          return readProjectSessionFromFile(projectId);
        }
        return new Promise<StudioSessionState | null>((resolve) => {
          window.setTimeout(() => {
            void readProjectSessionFromFile(projectId).then(resolve).catch(() => resolve(null));
          }, localSession ? 900 : 0);
        });
      })();

      // 快速路径：localStorage 有快照时立即渲染，无需等待任何 async 操作
      if (cachedSnapshot) {
        startTransition(() => {
          const nextState = buildOpenProjectSessionState({
            savedSession: localSession,
            snapshot: cachedSnapshot,
            videoProject: null, // drama/video project 后台补充
            buildBrief: brief,
            createAssistantMessage: (content) => mk("assistant", content),
            getSuggestedQuestion: recQuestion,
          });
          restoredProjectSuggestionKeysRef.current = new Set(nextState.surfacedProjectSuggestionKeys);

          setCreationMode(nextState.creationMode);
          setAutomationMode(nextState.automationMode);
          setDevMode(nextState.devMode);
          setActiveProjectId(projectId);
          if (nextState.selectedTextModelKey) {
            setSelectedTextModelKey(normalizeHomeAgentTextModelKey(nextState.selectedTextModelKey));
          }
          setSelectedImageModelFamily(
            normalizeHomeAgentImageModelFamilyKey(
              nextState.selectedImageModelFamily ?? nextState.imageGenerationPrefs?.familyKey,
            ),
          );
          setImageGenerationPrefs(normalizeVideoImageGenerationPrefs(nextState.imageGenerationPrefs));
          const nextVideoPrefs = normalizeVideoGenerationPrefs(nextState.videoGenerationPrefs);
          setSelectedVideoModelKey(
            normalizeHomeAgentVideoModelKey(nextState.selectedVideoModelKey ?? nextVideoPrefs.modelKey),
          );
          setVideoGenerationPrefs(nextVideoPrefs);
          setQState(nextState.qState);
          setDeferredQuestionState(nextState.deferredQuestionState);
          setPendingWorkflowUploadKind(nextState.pendingWorkflowUploadKind ?? null);
          setPopoverOverride(nextState.popoverOverride);
          setInterruptedChoiceQuestion(
            nextState.pendingWorkflowUploadKind ? null : (localSession?.interruptedChoiceQuestion ?? null),
          );
          setSuggested(nextState.suggested);
          setSelectedValues(nextState.selectedValues);
          setDeferredSelectedValues(nextState.deferredSelectedValues);
          setFullAutoChecklistCollapsed(nextState.fullAutoChecklistCollapsed);
          setMode(nextState.mode);
          setMessages(nextState.messages);
          resetComposerDraft(nextState.draft);
          setDeferredDraft(nextState.deferredDraft);
          setCompactedMessageCount(nextState.compactedMessageCount);
          previousQuestionStepRef.current = nextState.previousQuestionStep;
          surfacedTaskIdsRef.current = new Set(nextState.surfacedTaskIds);
          surfacedTaskFollowupIdsRef.current = new Set(nextState.surfacedTaskFollowupKeys);
          restoredTaskFollowupSuppressionRef.current = {
            sessionId: nextState.sessionId,
            restoredAt: Date.now(),
          };
          surfacedProjectSuggestionKeysRef.current = new Set(nextState.surfacedProjectSuggestionKeys);

          setRuntime((prev) => ({
            ...prev,
            sessionId: nextState.sessionId,
            suppressHistoricalMemory: true,
            currentProjectSnapshot: cachedSnapshot,
            currentDramaProject: null, // use-home-agent-conversation-effects 会后台补充
            currentVideoProject: null, // use-home-agent-conversation-effects 会后台补充
            recentProjects: mergeRecentProjects(prev.recentProjects, cachedSnapshot),
            recentMessageSummary: localSession?.recentMessageSummary ?? "",
            fullAutoRun: nextState.fullAutoRun,
          }));
        });
      }

      // 后台加载完整项目数据（drama/video project + 权威快照）
      const store = await loadProjectStore();
      if (openProjectVersionRef.current !== openVersion) return;

      const source = await store.loadConversationSourceById(projectId, {
        includeSnapshot: !cachedSnapshot,
        fastVideoLoad: !!cachedSnapshot,
      });
      if (openProjectVersionRef.current !== openVersion) return;

      const snapshot =
        source.snapshot ??
        (source.videoProject?.id === projectId
          ? store.createVideoSnapshot(source.videoProject)
          : source.dramaProject?.id === projectId
            ? store.createDramaSnapshot(source.dramaProject)
            : cachedSnapshot);
      if (!snapshot) {
        clearProjectHydrationInFlight(projectId);
        if (!hadCurrentProjectBeforeOpen) {
          startTransition(() => {
            setActiveProjectId(undefined);
            setMode("idle");
            setPendingWorkflowUploadKind(null);
            setRuntime((prev) => ({
              ...prev,
              currentProjectSnapshot: null,
              currentDramaProject: null,
              currentVideoProject: null,
            }));
          });
        }
        return;
      }

      clearProjectHydrationInFlight(projectId);

      if (!cachedSnapshot) {
        // 慢速路径：没有缓存快照，现在才渲染 UI
        startTransition(() => {
          const nextState = buildOpenProjectSessionState({
            savedSession: localSession,
            snapshot,
            videoProject: source.videoProject,
            buildBrief: brief,
            createAssistantMessage: (content) => mk("assistant", content),
            getSuggestedQuestion: recQuestion,
          });
          restoredProjectSuggestionKeysRef.current = new Set(nextState.surfacedProjectSuggestionKeys);

          setCreationMode(nextState.creationMode);
          setAutomationMode(nextState.automationMode);
          setDevMode(nextState.devMode);
          setActiveProjectId(projectId);
          if (nextState.selectedTextModelKey) {
            setSelectedTextModelKey(normalizeHomeAgentTextModelKey(nextState.selectedTextModelKey));
          }
          setSelectedImageModelFamily(
            normalizeHomeAgentImageModelFamilyKey(
              nextState.selectedImageModelFamily ??
                nextState.imageGenerationPrefs?.familyKey ??
                source.videoProject?.imageGenerationPrefs?.familyKey,
            ),
          );
          setImageGenerationPrefs(
            normalizeVideoImageGenerationPrefs(
              nextState.imageGenerationPrefs ?? source.videoProject?.imageGenerationPrefs,
            ),
          );
          const nextVideoPrefs = normalizeVideoGenerationPrefs(
            nextState.videoGenerationPrefs ?? source.videoProject?.videoGenerationPrefs,
          );
          setSelectedVideoModelKey(
            normalizeHomeAgentVideoModelKey(
              nextState.selectedVideoModelKey ??
                nextVideoPrefs.modelKey ??
                source.videoProject?.videoGenerationPrefs?.modelKey,
            ),
          );
          setVideoGenerationPrefs(nextVideoPrefs);
          setQState(nextState.qState);
          setDeferredQuestionState(nextState.deferredQuestionState);
          setPendingWorkflowUploadKind(nextState.pendingWorkflowUploadKind ?? null);
          setPopoverOverride(nextState.popoverOverride);
          setInterruptedChoiceQuestion(
            nextState.pendingWorkflowUploadKind ? null : (localSession?.interruptedChoiceQuestion ?? null),
          );
          setSuggested(nextState.suggested);
          setSelectedValues(nextState.selectedValues);
          setDeferredSelectedValues(nextState.deferredSelectedValues);
          setMode(nextState.mode);
          setMessages(nextState.messages);
          resetComposerDraft(nextState.draft);
          setDeferredDraft(nextState.deferredDraft);
          setCompactedMessageCount(nextState.compactedMessageCount);
          previousQuestionStepRef.current = nextState.previousQuestionStep;
          surfacedTaskIdsRef.current = new Set(nextState.surfacedTaskIds);
          surfacedTaskFollowupIdsRef.current = new Set(nextState.surfacedTaskFollowupKeys);
          restoredTaskFollowupSuppressionRef.current = {
            sessionId: nextState.sessionId,
            restoredAt: Date.now(),
          };
          surfacedProjectSuggestionKeysRef.current = new Set(nextState.surfacedProjectSuggestionKeys);

          setRuntime((prev) => ({
            ...prev,
            sessionId: nextState.sessionId,
            suppressHistoricalMemory: true,
            currentProjectSnapshot: snapshot,
            currentDramaProject: source.dramaProject,
            currentVideoProject: source.videoProject,
            recentProjects: mergeRecentProjects(prev.recentProjects, snapshot),
            recentMessageSummary: localSession?.recentMessageSummary ?? "",
            fullAutoRun: nextState.fullAutoRun,
          }));
        });
      } else {
        // 快速路径已渲染，补充 drama/video project 数据
        startTransition(() => {
          setRuntime((prev) => {
            if (prev.currentProjectSnapshot?.projectId !== projectId) return prev;
            return {
              ...prev,
              suppressHistoricalMemory: true,
              currentProjectSnapshot: snapshot,
              currentDramaProject: source.dramaProject,
              currentVideoProject: source.videoProject,
            };
          });
        });
      }

      // 后台等待文件系统数据，仅在有更多消息时静默补充（localStorage 被清除的恢复场景）
      if (localSession && source.videoProject && hasStaleSavedReviewQuestion(localSession)) {
        startTransition(() => {
          const nextState = buildOpenProjectSessionState({
            savedSession: localSession,
            snapshot,
            videoProject: source.videoProject,
            buildBrief: brief,
            createAssistantMessage: (content) => mk("assistant", content),
            getSuggestedQuestion: recQuestion,
          });
          setPendingWorkflowUploadKind(nextState.pendingWorkflowUploadKind ?? null);
          setPopoverOverride(nextState.popoverOverride);
          setSuggested(nextState.suggested);
        });
      }

      void fileSessionPromise.then((fileSession) => {
        if (openProjectVersionRef.current !== openVersion) return;
        if (!fileSession) return;
        const savedSession = selectRecoveredProjectSession(localSession, fileSession);
        if (!savedSession || savedSession === localSession) return;
        const shouldPreserveLiveDraft = getComposerDraftSnapshot() !== (localSession?.draft ?? "");
        flushSync(() => {
          const nextState = buildOpenProjectSessionState({
            savedSession,
            snapshot,
            videoProject: source.videoProject,
            buildBrief: brief,
            createAssistantMessage: (content) => mk("assistant", content),
            getSuggestedQuestion: recQuestion,
          });
          setMessages(nextState.messages);
          setCompactedMessageCount(nextState.compactedMessageCount);
          setAutomationMode(nextState.automationMode);
          setFullAutoChecklistCollapsed(nextState.fullAutoChecklistCollapsed);
          if (!shouldPreserveLiveDraft) {
            setQState(nextState.qState);
            setDeferredQuestionState(nextState.deferredQuestionState);
            setPendingWorkflowUploadKind(nextState.pendingWorkflowUploadKind ?? null);
            setPopoverOverride(nextState.popoverOverride);
            resetComposerDraft(nextState.draft);
            setDeferredDraft(nextState.deferredDraft);
            setSelectedValues(nextState.selectedValues);
            setDeferredSelectedValues(nextState.deferredSelectedValues);
            setSuggested(nextState.suggested);
            setInterruptedChoiceQuestion(
              nextState.pendingWorkflowUploadKind ? null : (savedSession.interruptedChoiceQuestion ?? null),
            );
          }
          setRuntime((prev) => ({
            ...prev,
            recentMessageSummary: savedSession.recentMessageSummary ?? prev.recentMessageSummary,
            fullAutoRun: nextState.fullAutoRun,
          }));
        });
      }).catch(() => {});

      // 切换项目后异步刷新完整项目列表，确保工作流中途创建的项目不会从侧边栏消失
      const shouldRefreshRecentProjects = !runtimeState?.recentProjects.some(
        (item) => item.projectId === projectId,
      );
      if (shouldRefreshRecentProjects) {
        void store.listRecentConversationSnapshots(HOME_AGENT_HISTORY_DISPLAY_LIMIT, { fast: true }).then((items) => {
          if (openProjectVersionRef.current !== openVersion) return;
          const filteredItems = items.filter(
            (item) => item.projectId && !hasSessionResetMarkerForProject(item.projectId),
          );
          startTransition(() => {
            setRuntime((prev) => {
              const shouldPreserveRicherList =
                filteredItems.length > 0 &&
                prev.recentProjects.length > filteredItems.length &&
                filteredItems.every((item) => prev.recentProjects.some((project) => project.projectId === item.projectId));
              if (shouldPreserveRicherList) {
                return prev;
              }
              return { ...prev, recentProjects: filteredItems };
            });
          });
        }).catch(() => {});
      }
      setMetaReady(false);
    },
    [
      clearProjectHydrationInFlight,
      clearSurfacedTasks,
      engineRef,
      loadProjectStore,
      mergeRecentProjects,
      mk,
      previousQuestionStepRef,
      getComposerDraftSnapshot,
      resetComposerDraft,
      setActiveProjectId,
      setAutomationMode,
      setCreationMode,
      setDevMode,
      setSelectedTextModelKey,
      setSelectedImageModelFamily,
      setImageGenerationPrefs,
      setSelectedVideoModelKey,
      setVideoGenerationPrefs,
      setCompactedMessageCount,
      setDeferredDraft,
      setDeferredQuestionState,
      setDeferredSelectedValues,
      setFullAutoChecklistCollapsed,
      setMessages,
      setMetaReady,
      setMode,
      setPendingWorkflowUploadKind,
      setPopoverOverride,
      setInterruptedChoiceQuestion,
      setQState,
      setRuntime,
      setSelectedValues,
      setSuggested,
      setStreaming,
      surfacedTaskFollowupIdsRef,
      restoredTaskFollowupSuppressionRef,
      surfacedTaskIdsRef,
      surfacedProjectSuggestionKeysRef,
      restoredProjectSuggestionKeysRef,
      beforeProjectOpen,
      flushSessionRef,
      runtimeRef,
      projectHydrationInFlightRef,
    ],
  );

  useEffect(() => {
    if (handoffRef.current) return;
    handoffRef.current = true;

    void import("@/lib/agent-intake").then((mod) => {
      const handoff = mod.consumeAgentHandoff("script-creator");
      if (!handoff) return;
      if (handoff.resumeProjectId) {
        void openProject(handoff.resumeProjectId);
        return;
      }
      if (handoff.prompt.trim()) void send(handoff.prompt, handoff.title);
    });
  }, [handoffRef, openProject, send]);

  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<AskUserQuestionRequest>).detail;
      if (!detail?.questions?.length) return;

      // 先将完整问题文本写入聊天流，再弹出结构化选择窗。
      const normalizedRequest = normalizeWorkflowBoundAskUserQuestionRequest(detail, runtimeRef.current);
      const workflowQuestion = resolveWorkflowBoundComposerQuestion(
        normalizedRequest,
        runtimeRef.current,
      );
      const fallbackText = formatAskUserQuestionFallback(normalizedRequest);
      if (fallbackText.trim()) {
        flushSync(() => {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: fallbackText,
              createdAt: new Date().toISOString(),
              status: "complete",
            },
          ]);
        });
      }

      window.setTimeout(() => {
        startTransition(() => {
          setSuggested(null);
          setSelectedValues([]);
          resetComposerDraft("");
          setMode("active");
          setInterruptedChoiceQuestion(null);
          if (workflowQuestion) {
            setQState(null);
            setPopoverOverride(workflowQuestion);
            return;
          }
          setPopoverOverride(null);
          setQState(createQuestionState(normalizedRequest));
        });
      }, 0);
    };

    window.addEventListener("agent:ask-user-question", onAsk);
    return () => window.removeEventListener("agent:ask-user-question", onAsk);
  }, [createQuestionState, resetComposerDraft, runtimeRef, setInterruptedChoiceQuestion, setMessages, setMode, setPopoverOverride, setQState, setSelectedValues, setSuggested]);

  return { openProject, cancelPendingProjectOpen };
}
