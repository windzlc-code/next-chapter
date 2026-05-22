import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationProjectSnapshot, HomeAgentMessage, StudioQuestionState } from "@/lib/home-agent/types";
import type { StudioSessionState } from "@/lib/home-agent/types";
import * as sessionStore from "@/lib/home-agent/session-store";
import { selectRecoveredProjectSession, useHomeAgentRecoveryFlow } from "./use-home-agent-recovery-flow";

function createSession(overrides: Partial<StudioSessionState> = {}): StudioSessionState {
  return {
    sessionId: "session-1",
    mode: "active",
    creationMode: "creative",
    devMode: false,
    messages: [],
    currentProjectSnapshot: null,
    recentMessageSummary: "",
    draft: "",
    selectedValues: [],
    deferredSelectedValues: [],
    deferredDraft: "",
    surfacedTaskIds: [],
    surfacedTaskFollowupKeys: [],
    surfacedProjectSuggestionKeys: [],
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "Video project",
    currentObjective: "Bridge platform and shot preferences",
    derivedStage: "Script analysis",
    agentSummary: "summary",
    recommendedActions: [],
    artifacts: [],
    ...overrides,
  };
}

function createQuestionState(): StudioQuestionState {
  return {
    source: "live",
    request: {
      id: "question-1",
      questions: [
        {
          header: "topic",
          question: "Pick one",
          multiSelect: false,
          options: [{ label: "A" }],
        },
      ],
    },
    currentIndex: 0,
    answers: {},
    displayAnswers: {},
  };
}

describe("selectRecoveredProjectSession", () => {
  it("prefers a local structured question over a file-backed choice popup", () => {
    const localSession = createSession({
      qState: {
        source: "live",
        request: {
          id: "ask-1",
          questions: [
            {
              header: "topic",
              question: "Pick a topic",
              multiSelect: false,
              options: [{ label: "Drama" }],
            },
          ],
        },
        currentIndex: 0,
        answers: {},
        displayAnswers: {},
      },
    });
    const fileSession = createSession({
      messages: [{ id: "file-older", role: "assistant", content: "older but longer file snapshot", createdAt: "2026-04-01T00:00:00.000Z" }],
      pendingChoiceQuestion: {
        id: "choice-1",
        title: "Continue",
        description: "Continue the flow",
        options: [],
        answerKey: "continue",
        allowCustomInput: false,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
      },
    });

    expect(selectRecoveredProjectSession(localSession, fileSession)).toBe(localSession);
  });

  it("prefers a local deferred structured question over a file-backed choice popup", () => {
    const localSession = createSession({
      deferredQuestionState: {
        source: "deferred",
        request: {
          id: "ask-2",
          questions: [
            {
              header: "format",
              question: "Pick a format",
              multiSelect: false,
              options: [{ label: "Series" }],
            },
          ],
        },
        currentIndex: 0,
        answers: {},
        displayAnswers: {},
      },
    });
    const fileSession = createSession({
      messages: [{ id: "file-older-2", role: "assistant", content: "older file snapshot", createdAt: "2026-04-01T00:00:00.000Z" }],
      pendingChoiceQuestion: {
        id: "choice-2",
        title: "Keep going",
        description: "Resume later",
        options: [],
        answerKey: "resume",
        allowCustomInput: false,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
      },
    });

    expect(selectRecoveredProjectSession(localSession, fileSession)).toBe(localSession);
  });

  it("prefers the local session when only it still has a pending choice question", () => {
    const localSession = createSession({
      pendingChoiceQuestion: {
        id: "choice-1",
        title: "Continue",
        description: "Continue the flow",
        options: [],
        answerKey: "continue",
        allowCustomInput: false,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
      },
    });
    const fileSession = createSession({
      messages: [{ id: "file-stale", role: "assistant", content: "stale file snapshot", createdAt: "2026-04-01T00:00:00.000Z" }],
    });

    expect(selectRecoveredProjectSession(localSession, fileSession)).toBe(localSession);
  });

  it("falls back to the longer file session when pending ui state is equivalent", () => {
    const localSession = createSession({
      messages: [{ id: "local-1", role: "assistant", content: "local", createdAt: "2026-04-01T00:00:00.000Z" }],
    });
    const fileSession = createSession({
      messages: [
        { id: "file-1", role: "assistant", content: "file-1", createdAt: "2026-04-01T00:00:00.000Z" },
        { id: "file-2", role: "assistant", content: "file-2", createdAt: "2026-04-01T00:00:01.000Z" },
      ],
    });

    expect(selectRecoveredProjectSession(localSession, fileSession)).toBe(fileSession);
  });
});

describe("useHomeAgentRecoveryFlow", () => {
  it("runs beforeProjectOpen after flushing the current session and before interrupting the engine", async () => {
    const order: string[] = [];
    const snapshot = createSnapshot({ projectId: "video-project-2" });
    const projectHydrationInFlightRef = { current: null as string | null };
    const engineInterrupt = vi.fn(() => {
      order.push("interrupt");
    });
    const loadProjectStore = vi.fn(async () => ({
      loadConversationSourceById: async () => ({
        snapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots: async () => [],
    }));

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: { interrupt: engineInterrupt } },
        runtimeRef: {
          current: {
            sessionId: "session-1",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: null,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: null,
          },
        },
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: {
          current: () => {
            order.push("flush");
            expect(projectHydrationInFlightRef.current).toBeNull();
          },
        },
        beforeProjectOpen: (projectId) => {
          order.push(`before:${projectId}`);
        },
        setCreationMode: vi.fn(),
        setAutomationMode: vi.fn(),
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime: vi.fn(),
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [snapshot],
      }),
    );

    await act(async () => {
      await result.current.openProject("video-project-2");
    });

    expect(order.slice(0, 3)).toEqual([
      "flush",
      "before:video-project-2",
      "interrupt",
    ]);
    expect(engineInterrupt).toHaveBeenCalledTimes(1);
  });

  it("leaves the idle homepage immediately while a project is still loading", async () => {
    const snapshot = createSnapshot({ projectId: "video-project-3" });
    const setMode = vi.fn();
    const setActiveProjectId = vi.fn();
    const setRuntime = vi.fn();
    let resolveStore: ((value: {
      loadConversationSourceById: () => Promise<{
        snapshot: ConversationProjectSnapshot;
        dramaProject: null;
        videoProject: null;
      }>;
      listRecentConversationSnapshots: () => Promise<ConversationProjectSnapshot[]>;
    }) => void) | null = null;
    const loadProjectStore = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveStore = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: {
          current: {
            sessionId: "session-1",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: null,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [snapshot],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: null,
          },
        },
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode: vi.fn(),
        setDevMode: vi.fn(),
        setActiveProjectId,
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode,
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime,
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [snapshot],
      }),
    );

    await act(async () => {
      void result.current.openProject("video-project-3");
      await Promise.resolve();
    });

    expect(setActiveProjectId).toHaveBeenCalledWith("video-project-3");
    expect(setMode).toHaveBeenCalledWith("recovering");
    expect(setRuntime).toHaveBeenCalled();

    resolveStore?.({
      loadConversationSourceById: async () => ({
        snapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots: async () => [snapshot],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("replaces the previous project snapshot immediately when a recent target has no cached session snapshot", async () => {
    const previousSnapshot = createSnapshot({
      projectId: "video-project-old",
      title: "Old project",
    });
    const targetSnapshot = createSnapshot({
      projectId: "video-project-target",
      title: "Target project",
    });
    const setRuntime = vi.fn();
    let resolveStore: ((value: {
      loadConversationSourceById: () => Promise<{
        snapshot: ConversationProjectSnapshot;
        dramaProject: null;
        videoProject: null;
      }>;
      listRecentConversationSnapshots: () => Promise<ConversationProjectSnapshot[]>;
    }) => void) | null = null;
    const loadProjectStore = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveStore = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: {
          current: {
            sessionId: "session-1",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: previousSnapshot,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [targetSnapshot],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: null,
          },
        },
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode: vi.fn(),
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime,
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [targetSnapshot],
      }),
    );

    await act(async () => {
      void result.current.openProject("video-project-target");
      await Promise.resolve();
    });

    expect(setRuntime).toHaveBeenCalledWith(expect.any(Function));
    const nextRuntime = setRuntime.mock.calls[0]?.[0]?.({
      currentProjectSnapshot: previousSnapshot,
      recentProjects: [targetSnapshot],
    });
    expect(nextRuntime.currentProjectSnapshot).toEqual(targetSnapshot);

    resolveStore?.({
      loadConversationSourceById: async () => ({
        snapshot: targetSnapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots: async () => [targetSnapshot],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("clears stale full-auto runtime state when a recent manual project is opened through the recovering placeholder", async () => {
    const previousSnapshot = createSnapshot({
      projectId: "full-auto-project",
      title: "Full auto project",
      automationMode: "full-auto",
    });
    const targetSnapshot = createSnapshot({
      projectId: "manual-project-target",
      title: "Manual target project",
      automationMode: "manual",
    });
    const setRuntime = vi.fn();
    const setAutomationMode = vi.fn();
    let resolveStore: ((value: {
      loadConversationSourceById: () => Promise<{
        snapshot: ConversationProjectSnapshot;
        dramaProject: null;
        videoProject: null;
      }>;
      listRecentConversationSnapshots: () => Promise<ConversationProjectSnapshot[]>;
    }) => void) | null = null;
    const loadProjectStore = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveStore = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: {
          current: {
            sessionId: "session-full-auto",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: previousSnapshot,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [targetSnapshot],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: {
              status: "running",
              plan: null,
              currentStepIndex: 2,
            },
          },
        },
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode,
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime,
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [targetSnapshot],
      }),
    );

    await act(async () => {
      void result.current.openProject("manual-project-target");
      await Promise.resolve();
    });

    expect(setAutomationMode).toHaveBeenCalledWith("manual");
    const nextRuntime = setRuntime.mock.calls[0]?.[0]?.({
      currentProjectSnapshot: previousSnapshot,
      recentProjects: [targetSnapshot],
      fullAutoRun: {
        status: "running",
        plan: null,
        currentStepIndex: 2,
      },
    });
    expect(nextRuntime.currentProjectSnapshot).toEqual(targetSnapshot);
    expect(nextRuntime.fullAutoRun).toBeNull();

    resolveStore?.({
      loadConversationSourceById: async () => ({
        snapshot: targetSnapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots: async () => [targetSnapshot],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("does not crash if runtimeRef is missing at runtime", async () => {
    const snapshot = createSnapshot({ projectId: "video-project-4" });
    const loadProjectStore = vi.fn(async () => ({
      loadConversationSourceById: async () => ({
        snapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots: async () => [snapshot],
    }));

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: undefined as never,
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode: vi.fn(),
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime: vi.fn(),
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [snapshot],
      }),
    );

    await expect(result.current.openProject("video-project-4")).resolves.toBeUndefined();
  });

  it("does not refresh recent projects again when the target project is already present", async () => {
    const snapshot = createSnapshot({ projectId: "video-project-5" });
    const listRecentConversationSnapshots = vi.fn(async () => [snapshot]);
    const projectHydrationInFlightRef = { current: null as string | null };
    const loadProjectStore = vi.fn(async () => ({
      loadConversationSourceById: async () => ({
        snapshot,
        dramaProject: null,
        videoProject: null,
      }),
      listRecentConversationSnapshots,
    }));

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: {
          current: {
            sessionId: "session-1",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: null,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [snapshot],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: null,
          },
        },
        projectHydrationInFlightRef,
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode: vi.fn(),
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState: vi.fn(),
        setDeferredQuestionState: vi.fn(),
        setPendingWorkflowUploadKind: vi.fn(),
        setPopoverOverride: vi.fn(),
        setInterruptedChoiceQuestion: vi.fn(),
        setSuggested: vi.fn(),
        setSelectedValues: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setRuntime: vi.fn(),
        setMetaReady: vi.fn(),
        resetComposerDraft: vi.fn(),
        getComposerDraftSnapshot: () => "",
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [snapshot],
      }),
    );

    await act(async () => {
      await result.current.openProject("video-project-5");
    });

    expect(listRecentConversationSnapshots).not.toHaveBeenCalled();
    expect(projectHydrationInFlightRef.current).toBeNull();
  });

  it("does not overwrite a live composer draft when delayed file hydration finishes after typing resumes", async () => {
    vi.useFakeTimers();

    const snapshot = createSnapshot({ projectId: "video-project-live-draft" });
    const localSession = createSession({
      currentProjectSnapshot: snapshot,
      draft: "",
      compactedMessageCount: 1,
      messages: [
        {
          id: "local-assistant",
          role: "assistant",
          content: "local",
          createdAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    });
    const fileQuestion = createQuestionState();
    const fileSession = createSession({
      currentProjectSnapshot: snapshot,
      draft: "stale file draft",
      qState: fileQuestion,
      selectedValues: ["file-value"],
      deferredSelectedValues: ["deferred-file-value"],
      deferredDraft: "file deferred draft",
      messages: [
        {
          id: "file-assistant-1",
          role: "assistant",
          content: "file-1",
          createdAt: "2026-05-17T00:00:00.000Z",
        },
        {
          id: "file-assistant-2",
          role: "assistant",
          content: "file-2",
          createdAt: "2026-05-17T00:00:01.000Z",
        },
      ],
      recentMessageSummary: "file summary",
    });
    const readStudioProjectSessionSpy = vi
      .spyOn(sessionStore, "readStudioProjectSession")
      .mockReturnValue(localSession);
    const readProjectSessionFromFileSpy = vi
      .spyOn(sessionStore, "readProjectSessionFromFile")
      .mockResolvedValue(fileSession);
    const resetComposerDraft = vi.fn();
    const setQState = vi.fn();
    const setDeferredQuestionState = vi.fn();
    const setPendingWorkflowUploadKind = vi.fn();
    const setPopoverOverride = vi.fn();
    const setSelectedValues = vi.fn();
    const setDeferredSelectedValues = vi.fn();
    const setSuggested = vi.fn();
    const setInterruptedChoiceQuestion = vi.fn();
    const setMessages = vi.fn();
    const setCompactedMessageCount = vi.fn();
    const setAutomationMode = vi.fn();
    const setFullAutoChecklistCollapsed = vi.fn();
    const setDeferredDraft = vi.fn();
    const setRuntime = vi.fn();
    const liveDraftRef = { current: "" };

    const { result } = renderHook(() =>
      useHomeAgentRecoveryFlow({
        handoffRef: { current: true },
        engineRef: { current: null },
        runtimeRef: {
          current: {
            sessionId: "session-1",
            suppressHistoricalMemory: false,
            currentProjectSnapshot: null,
            currentDramaProject: null,
            currentVideoProject: null,
            currentSetupDraft: null,
            skillDrafts: [],
            maintenanceReports: [],
            recentProjects: [snapshot],
            recentProjectSessions: [],
            recentMessageSummary: "",
            fullAutoRun: null,
          },
        },
        projectHydrationInFlightRef: { current: null },
        loadProjectStore: (async () => ({
          loadConversationSourceById: async () => ({
            snapshot,
            dramaProject: null,
            videoProject: null,
          }),
          listRecentConversationSnapshots: async () => [snapshot],
        })) as never,
        flushSessionRef: { current: vi.fn() },
        setCreationMode: vi.fn(),
        setAutomationMode,
        setDevMode: vi.fn(),
        setActiveProjectId: vi.fn(),
        setSelectedTextModelKey: vi.fn(),
        setSelectedImageModelFamily: vi.fn(),
        setImageGenerationPrefs: vi.fn(),
        setSelectedVideoModelKey: vi.fn(),
        setVideoGenerationPrefs: vi.fn(),
        setQState,
        setDeferredQuestionState,
        setPendingWorkflowUploadKind,
        setPopoverOverride,
        setInterruptedChoiceQuestion,
        setSuggested,
        setSelectedValues,
        setDeferredSelectedValues,
        setFullAutoChecklistCollapsed,
        setStreaming: vi.fn(),
        setMode: vi.fn(),
        setMessages,
        setCompactedMessageCount,
        setRuntime,
        setMetaReady: vi.fn(),
        resetComposerDraft,
        getComposerDraftSnapshot: () => liveDraftRef.current,
        setDeferredDraft,
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        send: async () => {},
        createQuestionState,
        mk: (role: HomeAgentMessage["role"], content: string) => ({
          id: crypto.randomUUID(),
          role,
          content,
          createdAt: new Date().toISOString(),
        }),
        mergeRecentProjects: () => [snapshot],
      }),
    );

    await act(async () => {
      await result.current.openProject(snapshot.projectId);
      liveDraftRef.current = "user started typing";
      await vi.advanceTimersByTimeAsync(950);
      await Promise.resolve();
    });

    expect(readStudioProjectSessionSpy).toHaveBeenCalledWith(snapshot.projectId);
    expect(readProjectSessionFromFileSpy).toHaveBeenCalledWith(snapshot.projectId);
    expect(resetComposerDraft).not.toHaveBeenCalledWith(fileSession.draft);
    expect(setQState).not.toHaveBeenCalledWith(fileQuestion);
    expect(setDeferredQuestionState).not.toHaveBeenCalledWith(fileQuestion);
    expect(setPendingWorkflowUploadKind).not.toHaveBeenCalledWith(expect.anything());
    expect(setPopoverOverride).not.toHaveBeenCalledWith(expect.anything());
    expect(setSelectedValues).not.toHaveBeenCalledWith(fileSession.selectedValues);
    expect(setDeferredSelectedValues).not.toHaveBeenCalledWith(fileSession.deferredSelectedValues);
    expect(setMessages).toHaveBeenCalled();
    expect(setCompactedMessageCount).toHaveBeenCalled();
    expect(setAutomationMode).toHaveBeenCalled();
    expect(setFullAutoChecklistCollapsed).toHaveBeenCalled();
    expect(setDeferredDraft).not.toHaveBeenCalledWith(fileSession.deferredDraft);
    expect(setRuntime).toHaveBeenCalled();

    readStudioProjectSessionSpy.mockRestore();
    readProjectSessionFromFileSpy.mockRestore();
    vi.useRealTimers();
  });
});
