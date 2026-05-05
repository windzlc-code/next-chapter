import * as React from "react";
import type { MessageInput } from "@/lib/agent/types";
import { readStudioProjectSession, readProjectSessionFromFile, readSessionResetMarker } from "@/lib/home-agent/session-store";
import { buildOpenProjectSessionState } from "./home-agent-conversation-state";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  AutomationMode,
  CreationMode,
  HomeAgentMessage,
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

const { useCallback, useEffect, useRef, startTransition } = React;

type DreaminaCapabilityState = {
  ready: boolean;
  available: boolean;
  message?: string;
};

type RestoredTaskFollowupSuppression = {
  sessionId: string;
  restoredAt: number;
};

function hasPendingInteraction(session: StudioSessionState | null | undefined): boolean {
  return Boolean(session?.qState || session?.deferredQuestionState || session?.pendingChoiceQuestion);
}

function getPendingInteractionPriority(session: StudioSessionState | null | undefined): number {
  if (session?.qState || session?.deferredQuestionState) return 2;
  if (session?.pendingChoiceQuestion) return 1;
  return 0;
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
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setMode: React.Dispatch<React.SetStateAction<"idle" | "active" | "recovering" | "maintenance-review">>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setCompactedMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setMetaReady: React.Dispatch<React.SetStateAction<boolean>>;
  resetComposerDraft: (value?: string) => void;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  previousQuestionStepRef: React.MutableRefObject<string | null>;
  clearSurfacedTasks: () => void;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  restoredTaskFollowupSuppressionRef: React.MutableRefObject<RestoredTaskFollowupSuppression | null>;
  surfacedProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  restoredProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  dreaminaCapability: DreaminaCapabilityState;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  surfacedDreaminaHintRef: React.MutableRefObject<boolean>;
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
    setPopoverOverride,
    setSuggested,
    setSelectedValues,
    setDeferredSelectedValues,
    setStreaming,
    setMode,
    setMessages,
    setCompactedMessageCount,
    setRuntime,
    setMetaReady,
    resetComposerDraft,
    setDeferredDraft,
    previousQuestionStepRef,
    clearSurfacedTasks,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    restoredTaskFollowupSuppressionRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    dreaminaCapability,
    flashMaintenanceHint,
    surfacedDreaminaHintRef,
    send,
    createQuestionState,
    mk,
    mergeRecentProjects,
  } = params;
  const openProjectVersionRef = useRef(0);
  const cancelPendingProjectOpen = useCallback(() => {
    openProjectVersionRef.current += 1;
  }, []);

  const openProject = useCallback(
    async (projectId: string) => {
      const openVersion = openProjectVersionRef.current + 1;
      openProjectVersionRef.current = openVersion;
      // 切换前先同步保存当前项目状态，防止防抖保存被取消导致状态丢失
      flushSessionRef.current();

      beforeProjectOpen?.(projectId);
      engineRef.current?.interrupt?.();
      engineRef.current = null;
      clearSurfacedTasks();

      startTransition(() => {
        setStreaming(false);
        setQState(null);
        setDeferredQuestionState(null);
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setDeferredSelectedValues([]);
        setDeferredDraft("");
      });

      // 优先从 localStorage 读取（同步，无延迟）
      const isReset = readSessionResetMarker() === projectId;
      const localSession = readStudioProjectSession(projectId);
      const cachedSnapshot = localSession?.currentProjectSnapshot ?? null;

      // 并行启动文件系统读取，不阻塞 UI 渲染
      const fileSessionPromise = isReset ? Promise.resolve(null) : readProjectSessionFromFile(projectId);

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
          setPopoverOverride(nextState.popoverOverride);
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

      const snapshot = source.snapshot ?? cachedSnapshot;
      if (!snapshot) return;

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
          setPopoverOverride(nextState.popoverOverride);
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
              currentProjectSnapshot: snapshot,
              currentDramaProject: source.dramaProject,
              currentVideoProject: source.videoProject,
            };
          });
        });
      }

      // 后台等待文件系统数据，仅在有更多消息时静默补充（localStorage 被清除的恢复场景）
      void fileSessionPromise.then((fileSession) => {
        if (openProjectVersionRef.current !== openVersion) return;
        if (!fileSession) return;
        const savedSession = selectRecoveredProjectSession(localSession, fileSession);
        if (!savedSession || savedSession === localSession) return;
        startTransition(() => {
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
          setRuntime((prev) => ({
            ...prev,
            recentMessageSummary: savedSession.recentMessageSummary ?? prev.recentMessageSummary,
            fullAutoRun: nextState.fullAutoRun,
          }));
        });
      }).catch(() => {});

      // 切换项目后异步刷新完整项目列表，确保工作流中途创建的项目不会从侧边栏消失
      void store.listRecentConversationSnapshots(20, { fast: true }).then((items) => {
        if (openProjectVersionRef.current !== openVersion) return;
        startTransition(() => {
          setRuntime((prev) => ({ ...prev, recentProjects: items }));
        });
      }).catch(() => {});

      if (dreaminaCapability.available && snapshot.projectKind === "video") {
        flashMaintenanceHint("已接入 Dreamina CLI，可直接使用 Seedance 2.0", 2400);
        surfacedDreaminaHintRef.current = true;
      }
      setMetaReady(false);
    },
    [
      clearSurfacedTasks,
      dreaminaCapability.available,
      engineRef,
      flashMaintenanceHint,
      loadProjectStore,
      mergeRecentProjects,
      mk,
      previousQuestionStepRef,
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
      setMessages,
      setMetaReady,
      setMode,
      setPopoverOverride,
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
      surfacedDreaminaHintRef,
      beforeProjectOpen,
      flushSessionRef,
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

      // 将问题内容同步写入聊天流，弹窗和文本同时出现
      const fallbackText = formatAskUserQuestionFallback(detail);
      if (fallbackText.trim()) {
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
      }

      startTransition(() => {
        setPopoverOverride(null);
        setSuggested(null);
        setQState(createQuestionState(detail));
        setSelectedValues([]);
        resetComposerDraft("");
        setMode("active");
      });
    };

    window.addEventListener("agent:ask-user-question", onAsk);
    return () => window.removeEventListener("agent:ask-user-question", onAsk);
  }, [createQuestionState, resetComposerDraft, setMessages, setMode, setPopoverOverride, setQState, setSelectedValues, setSuggested]);

  return { openProject, cancelPendingProjectOpen };
}
