import * as React from "react";
import { getAllTasks, type Task } from "@/lib/agent/tools/task-tools";
import type { ConversationProjectSnapshot, StudioRuntimeState, StudioSessionState } from "@/lib/home-agent/types";
import { hasSessionResetMarkerForProject } from "@/lib/home-agent/session-store";
import { resolveSessionProjectIdForSnapshot } from "./home-agent-session-utils";

const { useEffect, useRef } = React;
const INITIAL_RECENT_PROJECTS_LIMIT = 24;
const FULL_RECENT_PROJECTS_LIMIT = 160;

export function useHomeAgentBootstrapEffects(params: {
  runtime: StudioRuntimeState;
  mode: string;
  metaReady: boolean;
  messages: Array<{ id: string; role: string; content: string; createdAt: string; status?: string; streamLabel?: string }>;
  compactedMessageCount: number;
  desktopSidebarCollapsed: boolean;
  maintenanceHintTimerRef: React.MutableRefObject<Map<string, number>>;
  draftPersistTimerRef: React.MutableRefObject<number | null>;
  messagesRef: React.MutableRefObject<Array<{ id: string; role: string; content: string; createdAt: string; status?: string; streamLabel?: string }>>;
  compactedMessageCountRef: React.MutableRefObject<number>;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  surfacedProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  restoredProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setRecentProjectsReady: React.Dispatch<React.SetStateAction<boolean>>;
  setMetaReady: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  activeProjectId?: string;
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  loadProjectStore: () => Promise<{
    listRecentConversationSnapshots(limit?: number, options?: { fast?: boolean }): Promise<ConversationProjectSnapshot[]>;
    readSkillDrafts(): StudioRuntimeState["skillDrafts"];
    readMaintenanceReports(): StudioRuntimeState["maintenanceReports"];
  }>;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  scheduleBackgroundTask: (task: () => void, timeout?: number) => () => void;
  areProjectSnapshotsEquivalent: (
    nextProjects: ConversationProjectSnapshot[],
    prevProjects: ConversationProjectSnapshot[],
  ) => boolean;
  areRecentSessionsEquivalent: (
    nextSessions: StudioSessionState[],
    prevSessions: StudioSessionState[] | undefined,
  ) => boolean;
  areTaskListsEquivalent: (nextTasks: Task[], prevTasks: Task[]) => boolean;
  writeDesktopSidebarCollapsed: (collapsed: boolean) => void;
}) {
  const {
    runtime,
    metaReady,
    messages,
    compactedMessageCount,
    desktopSidebarCollapsed,
    maintenanceHintTimerRef,
    draftPersistTimerRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    surfacedProjectSuggestionKeysRef,
    restoredProjectSuggestionKeysRef,
    setRuntime,
    setRecentProjectsReady,
    setMetaReady,
    setActiveProjectId,
    activeProjectId,
    setTasks,
    loadProjectStore,
    scheduleBackgroundTask,
    areProjectSnapshotsEquivalent,
    areRecentSessionsEquivalent,
    areTaskListsEquivalent,
    writeDesktopSidebarCollapsed,
  } = params;
  const previousSessionIdRef = useRef(runtime.sessionId);
  const hasWrittenDesktopSidebarRef = useRef(false);

  useEffect(
    () => () => {
      if (typeof window !== "undefined") {
        for (const timer of maintenanceHintTimerRef.current.values()) {
          window.clearTimeout(timer);
        }
      }
      maintenanceHintTimerRef.current.clear();
      if (draftPersistTimerRef.current && typeof window !== "undefined") {
        window.clearTimeout(draftPersistTimerRef.current);
      }
    },
    [draftPersistTimerRef, maintenanceHintTimerRef],
  );

  useEffect(() => {
    if (previousSessionIdRef.current === runtime.sessionId) return;
    previousSessionIdRef.current = runtime.sessionId;
    surfacedTaskIdsRef.current.clear();
    surfacedTaskFollowupIdsRef.current.clear();
    surfacedProjectSuggestionKeysRef.current.clear();
    restoredProjectSuggestionKeysRef.current.clear();
  }, [
    runtime.sessionId,
    restoredProjectSuggestionKeysRef,
    surfacedProjectSuggestionKeysRef,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
  ]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages, messagesRef]);

  useEffect(() => {
    compactedMessageCountRef.current = compactedMessageCount;
  }, [compactedMessageCount, compactedMessageCountRef]);

  useEffect(() => {
    if (!hasWrittenDesktopSidebarRef.current) {
      hasWrittenDesktopSidebarRef.current = true;
      return;
    }
    writeDesktopSidebarCollapsed(desktopSidebarCollapsed);
  }, [desktopSidebarCollapsed, writeDesktopSidebarCollapsed]);

  useEffect(() => {
    let cancelled = false;
    let cancelFollowupTask = () => {};

    const commitRecentProjects = (items: ConversationProjectSnapshot[], markReady: boolean) => {
      if (cancelled) return;
      React.startTransition(() => {
        setRuntime((prev) => {
          const shouldPreserveRicherList =
            prev.recentProjects.length > items.length &&
            items.every((item) => prev.recentProjects.some((project) => project.projectId === item.projectId));
          if (shouldPreserveRicherList) {
            return prev;
          }
          if (areProjectSnapshotsEquivalent(items, prev.recentProjects)) {
            return prev;
          }

          return { ...prev, recentProjects: items };
        });
        if (markReady) {
          setRecentProjectsReady(true);
        }
      });
    };

    const hydrateRecentProjects = async (
      store: Awaited<ReturnType<typeof loadProjectStore>>,
      limit: number,
      markReady: boolean,
    ) => {
      try {
        const items = (await store.listRecentConversationSnapshots(limit, { fast: true })).filter(
          (item) => item.projectId && !hasSessionResetMarkerForProject(item.projectId),
        );
        commitRecentProjects(items, markReady);
        return items.length;
      } catch {
        if (cancelled) return;
        if (markReady) {
          setRecentProjectsReady(true);
        }
        return 0;
      }
    };

    const cancelTask = scheduleBackgroundTask(() => {
      void loadProjectStore().then(async (store) => {
        const initialCount = await hydrateRecentProjects(store, INITIAL_RECENT_PROJECTS_LIMIT, true);
        if (cancelled || initialCount < INITIAL_RECENT_PROJECTS_LIMIT) return;
        cancelFollowupTask = scheduleBackgroundTask(() => {
          void hydrateRecentProjects(store, FULL_RECENT_PROJECTS_LIMIT, false);
        }, 1600);
      });
    });

    return () => {
      cancelled = true;
      cancelTask();
      cancelFollowupTask();
    };
  }, [
    areProjectSnapshotsEquivalent,
    areRecentSessionsEquivalent,
    loadProjectStore,
    scheduleBackgroundTask,
    setRecentProjectsReady,
    setRuntime,
  ]);

  useEffect(() => {
    if (metaReady) return;

    let cancelled = false;
    const cancelTask = scheduleBackgroundTask(() => {
      void loadProjectStore()
        .then((store) => {
          if (cancelled) return;
          React.startTransition(() => {
            setRuntime((prev) => ({
              ...prev,
              skillDrafts: store.readSkillDrafts(),
              maintenanceReports: store.readMaintenanceReports(),
            }));
            setMetaReady(true);
          });
        })
        .catch(() => {
          if (cancelled) return;
          setMetaReady(true);
        });
    }, 700);

    return () => {
      cancelled = true;
      cancelTask();
    };
  }, [loadProjectStore, metaReady, scheduleBackgroundTask, setMetaReady, setRuntime]);

  useEffect(() => {
    const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
      currentSessionProjectId: activeProjectId,
      snapshot: runtime.currentProjectSnapshot,
      fallbackProjectId: runtime.currentProjectSnapshot?.projectId,
    });
    if (nextSessionProjectId) {
      setActiveProjectId(nextSessionProjectId);
    }
  }, [
    activeProjectId,
    runtime.currentProjectSnapshot?.projectId,
    runtime.currentProjectSnapshot?.projectKind,
    runtime.currentProjectSnapshot?.sourceProjectId,
    setActiveProjectId,
  ]);

  useEffect(() => {
    const syncTasks = () => {
      const nextTasks = getAllTasks();
      React.startTransition(() => {
        setTasks((prev) => (areTaskListsEquivalent(nextTasks, prev) ? prev : nextTasks));
      });
    };

    const cancelInitialSync = scheduleBackgroundTask(() => {
      syncTasks();
    }, 900);
    window.addEventListener("agent:tasks-updated", syncTasks);
    return () => {
      cancelInitialSync();
      window.removeEventListener("agent:tasks-updated", syncTasks);
    };
  }, [areTaskListsEquivalent, scheduleBackgroundTask, setTasks]);
}
