import * as React from "react";
import { useReducedMotion } from "framer-motion";
import { useTheme } from "next-themes";
import type { ComposerQuestion, ConversationProjectSnapshot, HomeAgentMessage, StudioRuntimeState } from "@/lib/home-agent/types";
import type { Task } from "@/lib/agent/tools/task-tools";
import { collectConversationAssets } from "./home-agent-sidebar-utils";
import { mergeRecentProjectsWithSessionSnapshots } from "./home-agent-session-utils";

const { useCallback, useDeferredValue, useMemo } = React;

export interface HomeAgentMaintenanceHintNotice {
  id: string;
  message: string;
  tone: "success" | "warning" | "error";
}

function classifyMaintenanceHintTone(message: string): HomeAgentMaintenanceHintNotice["tone"] {
  if (/失败|失效|无效|错误|异常|不支持|无法|缺少|未找到/.test(message)) {
    return "error";
  }
  return "warning";
}

export function useHomeAgentSurfaceState(params: {
  mode: "idle" | "active" | "recovering" | "maintenance-review";
  messages: HomeAgentMessage[];
  currentProject: ConversationProjectSnapshot | null;
  question: ComposerQuestion | null;
  utilityPanel: "settings" | undefined;
  desktopSidebarCollapsed: boolean;
  mobileNavOpen: boolean;
  runtime: StudioRuntimeState;
  tasks: Task[];
  activeProjectId?: string;
  maintenanceHintTimerRef: React.MutableRefObject<Map<string, number>>;
  draftPersistTimerRef: React.MutableRefObject<number | null>;
  draftRef: React.MutableRefObject<string>;
  setMaintenanceHints: React.Dispatch<React.SetStateAction<HomeAgentMaintenanceHintNotice[]>>;
  setDraftPresence: React.Dispatch<React.SetStateAction<boolean>>;
  setPersistedDraft: React.Dispatch<React.SetStateAction<string>>;
  setDraftInitialValue: React.Dispatch<React.SetStateAction<string>>;
  setDraftResetVersion: React.Dispatch<React.SetStateAction<number>>;
  truncateCopy: (value: string, max?: number) => string;
  isTaskVisibleForSession: (task: Task, sessionId: string) => boolean;
  idlePlaceholder: string;
  activePlaceholder: string;
  customPlaceholder: string;
  desktopSidebarOffsetExpanded: number;
  desktopSidebarOffsetCollapsed: number;
}) {
  const {
    mode,
    messages,
    currentProject,
    question,
    utilityPanel,
    desktopSidebarCollapsed,
    mobileNavOpen,
    runtime,
    tasks,
    activeProjectId,
    maintenanceHintTimerRef,
    draftPersistTimerRef,
    draftRef,
    setMaintenanceHints,
    setDraftPresence,
    setPersistedDraft,
    setDraftInitialValue,
    setDraftResetVersion,
    truncateCopy,
    isTaskVisibleForSession,
    idlePlaceholder,
    activePlaceholder,
    customPlaceholder,
    desktopSidebarOffsetExpanded,
    desktopSidebarOffsetCollapsed,
  } = params;

  const idle = mode === "idle" && messages.length === 0 && !currentProject;
  const { resolvedTheme } = useTheme();
  const activeTheme = resolvedTheme !== "light";
  const placeholder = question?.allowCustomInput ? customPlaceholder : idle ? idlePlaceholder : activePlaceholder;
  const deferredMessages = useDeferredValue(messages);
  const deferredProjectSnapshot = useDeferredValue(runtime.currentProjectSnapshot);
  const deferredCurrentVideoProject = useDeferredValue(runtime.currentVideoProject);
  // History mutations like delete should disappear immediately; deferring the list
  // can leave a stale, non-interactive "ghost" project row in the sidebar.
  // Also merge runtime session snapshots so freshly-created full-auto conversations
  // stay visible before the persisted recent-project index fully catches up.
  const deferredRecentProjects = useMemo(
    () =>
      mergeRecentProjectsWithSessionSnapshots({
        recentProjects: runtime.recentProjects,
        recentProjectSessions: runtime.recentProjectSessions,
        currentProjectSnapshot: runtime.currentProjectSnapshot,
        currentSessionProjectId: activeProjectId,
      }),
    [activeProjectId, runtime.currentProjectSnapshot, runtime.recentProjectSessions, runtime.recentProjects],
  );
  const reduceMotion = useReducedMotion();
  const settingsOpen = utilityPanel === "settings";
  const desktopSidebarOffset = desktopSidebarCollapsed
    ? desktopSidebarOffsetCollapsed
    : desktopSidebarOffsetExpanded;

  const recentSessionSummary = useMemo(
    () =>
      deferredMessages
        .slice(-6)
        .map((message) => `${message.role}: ${truncateCopy(message.content, 120)}`)
        .join(" | "),
    [deferredMessages, truncateCopy],
  );

  const dismissMaintenanceHint = useCallback(
    (hintId?: string) => {
      if (hintId) {
        setMaintenanceHints((current) => current.filter((hint) => hint.id !== hintId));
        if (typeof window !== "undefined") {
          const timer = maintenanceHintTimerRef.current.get(hintId);
          if (timer) {
            window.clearTimeout(timer);
            maintenanceHintTimerRef.current.delete(hintId);
          }
        } else {
          maintenanceHintTimerRef.current.delete(hintId);
        }
        return;
      }

      setMaintenanceHints([]);
      if (typeof window !== "undefined") {
        for (const timer of maintenanceHintTimerRef.current.values()) {
          window.clearTimeout(timer);
        }
      }
      maintenanceHintTimerRef.current.clear();
    },
    [maintenanceHintTimerRef, setMaintenanceHints],
  );

  const flashMaintenanceHint = useCallback(
    (message: string, duration = 2200) => {
      const normalizedMessage = message.trim();
      if (!normalizedMessage || duration <= 0) {
        dismissMaintenanceHint();
        return;
      }

      const hintId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `maintenance-hint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setMaintenanceHints((current) => {
        const next = [
          ...current,
          {
            id: hintId,
            message: normalizedMessage,
            tone: classifyMaintenanceHintTone(normalizedMessage),
          },
        ];
        if (next.length <= 4) return next;
        const overflow = next.slice(0, next.length - 4);
        if (typeof window !== "undefined") {
          for (const hint of overflow) {
            const timer = maintenanceHintTimerRef.current.get(hint.id);
            if (timer) {
              window.clearTimeout(timer);
              maintenanceHintTimerRef.current.delete(hint.id);
            }
          }
        } else {
          for (const hint of overflow) {
            maintenanceHintTimerRef.current.delete(hint.id);
          }
        }
        return next.slice(-4);
      });

      if (typeof window === "undefined") return;
      const timer = window.setTimeout(() => {
        setMaintenanceHints((current) => current.filter((hint) => hint.id !== hintId));
        maintenanceHintTimerRef.current.delete(hintId);
      }, duration);
      maintenanceHintTimerRef.current.set(hintId, timer);
    },
    [dismissMaintenanceHint, maintenanceHintTimerRef, setMaintenanceHints],
  );

  const syncComposerDraft = useCallback(
    (value: string) => {
      draftRef.current = value;
      const hasText = Boolean(value.trim());
      setDraftPresence((current) => (current === hasText ? current : hasText));

      if (typeof window === "undefined") {
        setPersistedDraft((current) => (current === value ? current : value));
        return;
      }

      if (draftPersistTimerRef.current) {
        window.clearTimeout(draftPersistTimerRef.current);
      }

      draftPersistTimerRef.current = window.setTimeout(() => {
        setPersistedDraft((current) => (current === draftRef.current ? current : draftRef.current));
        draftPersistTimerRef.current = null;
      }, 180);
    },
    [draftPersistTimerRef, draftRef, setDraftPresence, setPersistedDraft],
  );

  const resetComposerDraft = useCallback(
    (value = "") => {
      if (typeof window !== "undefined" && draftPersistTimerRef.current) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      draftRef.current = value;
      setDraftInitialValue(value);
      setPersistedDraft(value);
      setDraftPresence(Boolean(value.trim()));
      setDraftResetVersion((current) => current + 1);
    },
    [draftPersistTimerRef, draftRef, setDraftInitialValue, setDraftPresence, setDraftResetVersion, setPersistedDraft],
  );

  const composerShellClass = idle
    ? "composer-shell-idle"
    : "composer-shell-active";

  const shouldCollectSidebarAssets = !idle && (!desktopSidebarCollapsed || mobileNavOpen);
  const sidebarAssets = useMemo(() => {
    if (!shouldCollectSidebarAssets) return [];
    return collectConversationAssets(deferredCurrentVideoProject, deferredProjectSnapshot);
  }, [deferredCurrentVideoProject, deferredProjectSnapshot, shouldCollectSidebarAssets]);

  const deferredSidebarAssets = useDeferredValue(sidebarAssets);
  const visibleTasks = useMemo(
    () => tasks.filter((task) => isTaskVisibleForSession(task, runtime.sessionId)),
    [isTaskVisibleForSession, runtime.sessionId, tasks],
  );
  const deferredVisibleTasks = useDeferredValue(visibleTasks);

  return {
    idle,
    activeTheme,
    placeholder,
    deferredMessages,
    deferredProjectSnapshot,
    deferredRecentProjects,
    reduceMotion,
    settingsOpen,
    desktopSidebarOffset,
    recentSessionSummary,
    flashMaintenanceHint,
    dismissMaintenanceHint,
    syncComposerDraft,
    resetComposerDraft,
    composerShellClass,
    deferredSidebarAssets,
    visibleTasks,
    deferredVisibleTasks,
  };
}
