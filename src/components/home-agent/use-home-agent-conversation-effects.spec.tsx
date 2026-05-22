import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeAgentConversationEffects } from "./use-home-agent-conversation-effects";
import * as sessionStore from "@/lib/home-agent/session-store";
import type { BackgroundResearchGroup } from "./home-agent-task-utils";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import type { Task } from "@/lib/agent/tools/task-tools";

function createVideoSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "bridge test project",
    currentObjective: "fill bridge preferences",
    derivedStage: "script-analysis",
    agentSummary: "prepare bridge context",
    recommendedActions: ["continue"],
    artifacts: [],
    ...overrides,
  };
}

function createRuntime(snapshot: ConversationProjectSnapshot | Partial<ConversationProjectSnapshot> = createVideoSnapshot()): StudioRuntimeState {
  const resolvedSnapshot = "projectId" in snapshot ? snapshot as ConversationProjectSnapshot : createVideoSnapshot(snapshot);
  return {
    sessionId: "session-current",
    currentProjectSnapshot: resolvedSnapshot,
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [resolvedSnapshot],
    recentMessageSummary: "",
  };
}

function createVideoProject(overrides?: Partial<NonNullable<StudioRuntimeState["currentVideoProject"]>>) {
  return {
    id: "video-project-1",
    title: "bridge test project",
    script: "女主在雨夜冲出街口。",
    targetPlatform: "抖音",
    shotStyle: "电影感短预告",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action" as const,
    currentStep: 1,
    systemPrompt: "",
    analysisSummary: "视频桥接已建立。",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

function createQuestion(id: string): ComposerQuestion {
  return {
    id,
    title: id,
    description: id,
    options: [],
    answerKey: id,
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
  };
}

describe("useHomeAgentConversationEffects", () => {
  it("flushes the latest session snapshot on pagehide before the debounce window elapses", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const message: HomeAgentMessage = {
      id: "assistant-fresh",
      role: "assistant",
      content: "Fresh cloud response",
      createdAt: "2026-05-18T08:00:00.000Z",
    };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const writeStudioSessionSpy = vi
      .spyOn(sessionStore, "writeStudioSession")
      .mockImplementation(() => {});

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [message],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "stale draft",
        deferredDraft: "",
        recentSessionSummary: "recent summary",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [message],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "latest draft" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => {
      expect(writeStudioSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-current",
          projectId: "video-project-1",
          messages: [message],
          draft: "latest draft",
        }),
        { persistFullBackup: false },
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
    writeStudioSessionSpy.mockRestore();
  });

  it("persists a pending choice question in the background session snapshot", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const popoverOverride = createQuestion("pending-choice");

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          pendingChoiceQuestion: expect.objectContaining({
            id: "pending-choice",
          }),
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("does not crash while persisting a homepage kickoff popup before any project snapshot exists", async () => {
    const runtime: StudioRuntimeState = {
      sessionId: "session-fresh",
      currentProjectSnapshot: null,
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const popoverOverride = createQuestion("homepage-kickoff");

    expect(() =>
      renderHook(() =>
        useHomeAgentConversationEffects({
          idle: false,
          streaming: false,
          messages: [] as HomeAgentMessage[],
          runtime,
          compactedMessageCount: 0,
          activeProjectId: null,
          creationMode: "creative",
          automationMode: "manual",
          devMode: false,
          mode: "active",
          setMode: vi.fn(),
          qState: null,
          deferredQuestionState: null,
          popoverOverride,
          interruptedChoiceQuestion: null,
          suggested: null,
          draftPresence: false,
          persistedDraft: "",
          deferredDraft: "",
          recentSessionSummary: "",
          selectedValues: [],
          deferredSelectedValues: [],
          selectedTextModelKey: "default",
          selectedImageModelFamily: "jimeng-3.0" as never,
          imageGenerationPrefs: {
            familyKey: "jimeng-3.0" as never,
          } as never,
          selectedVideoModelKey: "kling-v2_1" as never,
          videoGenerationPrefs: {
            modelKey: "kling-v2_1" as never,
          } as never,
          deferredMessages: [],
          deferredProjectSnapshot: null,
          visibleTasks: [],
          endRef: { current: null },
          engineRef: { current: null },
          runtimeRef,
          draftRef: { current: "" },
          previousQuestionStepRef: { current: null },
          surfacedTaskIdsRef: { current: new Set<string>() },
          surfacedTaskFollowupIdsRef: { current: new Set<string>() },
          restoredTaskFollowupSuppressionRef: { current: null },
          backgroundResearchGroupsRef: { current: [] },
          surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
          restoredProjectSuggestionKeysRef: { current: new Set<string>() },
          compactionJobVersionRef: { current: 0 },
          setRuntime: vi.fn(),
          setActiveProjectId: vi.fn(),
          setCompactedMessageCount: vi.fn(),
          setStreaming: vi.fn(),
          setSuggested: vi.fn(),
          setPopoverOverride: vi.fn(),
          setSelectedValues: vi.fn(),
          resetComposerDraft: vi.fn(),
          send: vi.fn(async () => {}),
          push: vi.fn(),
          flashMaintenanceHint: vi.fn(),
          loadApiConfigModule: vi.fn(async () => ({} as never)),
          loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
          loadProjectStore: vi.fn(async () => ({} as never)),
          loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
          scheduleBackgroundTask: vi.fn((task: () => void) => {
            task();
            return () => {};
          }),
          mergeRecentProjects: vi.fn((projects) => projects),
          buildTaskResultMessage: vi.fn(() => "background research completed"),
          buildProjectSuggestionKey: vi.fn(() => null),
          parseTaskHeading: vi.fn(() => "bridge"),
        }),
      ),
    ).not.toThrow();

    expect(queueStudioSessionWriteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentProjectSnapshot: null,
        pendingChoiceQuestion: expect.objectContaining({
          id: "homepage-kickoff",
        }),
      }),
      120,
      expect.any(Object),
    );

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("queues kickoff persistence immediately when a full-auto conversation has no project snapshot yet", async () => {
    const runtime: StudioRuntimeState = {
      sessionId: "session-full-auto-kickoff",
      currentProjectSnapshot: null,
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const qState: StudioQuestionState = {
      source: "restored",
      request: {
        id: "full-auto-kickoff",
        title: "原创剧本立项",
        questions: [
          {
            id: "setup-mode",
            header: "创作方式",
            question: "这次想从哪种方式开始原创剧本？",
            options: [],
          },
        ],
      },
      currentIndex: 0,
      answers: {},
      displayAnswers: {},
    };
    const scheduleBackgroundTask = vi.fn((task: () => void, delay?: number) => {
      task();
      return () => {};
    });

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [
          {
            id: "user-full-auto-template",
            role: "user",
            content: "原创剧本",
            createdAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "assistant-full-auto-template",
            role: "assistant",
            content: "已切换为全自动原创剧本。",
            createdAt: "2026-04-01T00:00:01.000Z",
          },
        ] satisfies HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: null,
        creationMode: "creative",
        automationMode: "full-auto",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [
          {
            id: "user-full-auto-template",
            role: "user",
            content: "原创剧本",
            createdAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "assistant-full-auto-template",
            role: "assistant",
            content: "已切换为全自动原创剧本。",
            createdAt: "2026-04-01T00:00:01.000Z",
          },
        ] satisfies HomeAgentMessage[],
        deferredProjectSnapshot: null,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask,
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(scheduleBackgroundTask).toHaveBeenCalledWith(expect.any(Function), 0);
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          automationMode: "full-auto",
          qState: expect.objectContaining({
            request: expect.objectContaining({
              id: "full-auto-kickoff",
            }),
          }),
          projectId: null,
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("waits for the next project snapshot before persisting a switched project session", async () => {
    const runtime = createRuntime(
      createVideoSnapshot({
        projectId: "video-project-old",
        title: "old project",
      }),
    );
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: "video-project-next",
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        projectHydrationInFlightRef: { current: "video-project-next" },
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).not.toHaveBeenCalled();
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("persists the currently rendered question before a newer suggested follow-up", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const visibleQuestion = createQuestion("video-analyze-pace");
    const nextSuggestedQuestion = createQuestion("video-bridge-prefix");

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        question: visibleQuestion,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: nextSuggestedQuestion,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [] as HomeAgentMessage[],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] as BackgroundResearchGroup[] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          pendingChoiceQuestion: expect.objectContaining({
            answerKey: "video-analyze-pace",
          }),
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("does not persist a recovering project placeholder after the target snapshot is already visible", async () => {
    const runtime = createRuntime(
      createVideoSnapshot({
        projectId: "video-project-next",
        automationMode: "manual",
      }),
    );
    const runtimeRef = {
      current: {
        ...runtime,
        fullAutoRun: {
          status: "running" as const,
          plan: null,
          currentStepIndex: 1,
        },
      },
    };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: "video-project-next",
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "recovering",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [] as HomeAgentMessage[],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        projectHydrationInFlightRef: { current: "video-project-next" },
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).not.toHaveBeenCalled();
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("persists the live project snapshot immediately when reopening a project before the deferred snapshot catches up", async () => {
    const snapshot = createVideoSnapshot({
      projectId: "video-project-reopen",
      title: "reopen target",
      automationMode: "manual",
    });
    const runtime = createRuntime(snapshot);
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [
          {
            id: "assistant-reopen-1",
            role: "assistant",
            content: "restored project conversation",
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ] satisfies HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: snapshot.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [
          {
            id: "assistant-reopen-1",
            role: "assistant",
            content: "restored project conversation",
            createdAt: "2026-05-12T00:00:00.000Z",
          },
        ] satisfies HomeAgentMessage[],
        deferredProjectSnapshot: null,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] as BackgroundResearchGroup[] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          projectId: "video-project-reopen",
          currentProjectSnapshot: expect.objectContaining({
            projectId: "video-project-reopen",
            title: "reopen target",
          }),
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("does not queue duplicate session writes when only recent project metadata refreshes", async () => {
    const snapshot = createVideoSnapshot();
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const runtimeRef = {
      current: {
        ...createRuntime(snapshot),
        fullAutoRun: null,
      },
    };
    const baseProps = {
      idle: false,
      streaming: false,
      messages: [] as HomeAgentMessage[],
      compactedMessageCount: 0,
      activeProjectId: snapshot.projectId,
      creationMode: "creative" as const,
      automationMode: "manual" as const,
      devMode: false,
      mode: "active" as const,
      setMode: vi.fn(),
      qState: null,
      deferredQuestionState: null,
      popoverOverride: null,
      interruptedChoiceQuestion: null,
      suggested: null,
      draftPresence: false,
      persistedDraft: "",
      deferredDraft: "",
      recentSessionSummary: "",
      selectedValues: [] as string[],
      deferredSelectedValues: [] as string[],
      selectedTextModelKey: "default",
      selectedImageModelFamily: "jimeng-3.0" as never,
      imageGenerationPrefs: {
        familyKey: "jimeng-3.0" as never,
      } as never,
      selectedVideoModelKey: "kling-v2_1" as never,
      videoGenerationPrefs: {
        modelKey: "kling-v2_1" as never,
      } as never,
      deferredMessages: [] as HomeAgentMessage[],
      deferredProjectSnapshot: snapshot,
      visibleTasks: [] as Task[],
      endRef: { current: null },
      engineRef: { current: null },
      runtimeRef,
      draftRef: { current: "" },
      previousQuestionStepRef: { current: null },
      surfacedTaskIdsRef: { current: new Set<string>() },
      surfacedTaskFollowupIdsRef: { current: new Set<string>() },
      restoredTaskFollowupSuppressionRef: { current: null },
      backgroundResearchGroupsRef: { current: [] as BackgroundResearchGroup[] },
      surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
      restoredProjectSuggestionKeysRef: { current: new Set<string>() },
      compactionJobVersionRef: { current: 0 },
      setRuntime: vi.fn(),
      setActiveProjectId: vi.fn(),
      setCompactedMessageCount: vi.fn(),
      setStreaming: vi.fn(),
      setSuggested: vi.fn(),
      setPopoverOverride: vi.fn(),
      setSelectedValues: vi.fn(),
      resetComposerDraft: vi.fn(),
      send: vi.fn(async () => {}),
      push: vi.fn(),
      flashMaintenanceHint: vi.fn(),
      loadApiConfigModule: vi.fn(async () => ({} as never)),
      loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
      loadProjectStore: vi.fn(async () => ({} as never)),
      loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
      scheduleBackgroundTask: vi.fn((task: () => void) => {
        task();
        return () => {};
      }),
      mergeRecentProjects: vi.fn((projects) => projects),
      buildTaskResultMessage: vi.fn(() => "background research completed"),
      buildProjectSuggestionKey: vi.fn(() => null),
      parseTaskHeading: vi.fn(() => "bridge"),
    };

    const { rerender } = renderHook(
      (props: typeof baseProps & { runtime: StudioRuntimeState }) =>
        useHomeAgentConversationEffects(props),
      {
        initialProps: {
          ...baseProps,
          runtime: createRuntime(snapshot),
        },
      },
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalledTimes(1);
    });

    rerender({
      ...baseProps,
      runtime: {
        ...createRuntime(snapshot),
        recentProjects: [{ ...snapshot }],
      },
    });

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalledTimes(1);
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("does not persist the video refresh panel while scenes are still processing", async () => {
    const runtime = createRuntime();
    runtime.currentVideoProject = createVideoProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          storyboardUrl: "https://example.com/storyboard-1.jpg",
          videoTaskId: "task-1",
          videoStatus: "processing",
        },
      ],
    });
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});
    const refreshQuestion = createQuestion("video-refresh-panel-video-project-1");
    refreshQuestion.answerKey = "video-refresh-panel";

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: refreshQuestion,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          pendingChoiceQuestion: null,
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("prefers the live cleared draft over a stale persisted draft snapshot", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const queueStudioSessionWriteSpy = vi
      .spyOn(sessionStore, "queueStudioSessionWrite")
      .mockImplementation(() => {});

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "stale draft",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn((task: () => void) => {
          task();
          return () => {};
        }),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(queueStudioSessionWriteSpy).toHaveBeenCalled();
      expect(queueStudioSessionWriteSpy.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          draft: "",
        }),
      );
    });

    queueStudioSessionWriteSpy.mockRestore();
  });

  it("skips the fallback project-source load while recovery hydration is already in flight", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const loadConversationSourceById = vi.fn(async () => ({
      snapshot: runtime.currentProjectSnapshot,
      dramaProject: null,
      videoProject: createVideoProject(),
    }));
    const loadProjectStore = vi.fn(async () => ({
      loadConversationSourceById,
    }));

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        projectHydrationInFlightRef: {
          current: runtime.currentProjectSnapshot?.projectId ?? null,
        },
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore,
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(loadProjectStore).not.toHaveBeenCalled();
      expect(loadConversationSourceById).not.toHaveBeenCalled();
    });
  });

  it("shows an integrated bridge research message and restores the next bridge popover", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const nextSnapshot = createVideoSnapshot({
      derivedStage: "角色与场景",
      currentObjective: "完善角色与场景资产，为分镜生成做准备。",
      recommendedActions: ["提取角色与场景", "先补齐基础参考图", "补充额外镜头要求"],
    });
    const groupedTask: Task = {
      id: "task-bridge-1",
      prompt: "并行研究 平台包装: fill bridge preferences",
      status: "completed",
      output: "适合抖音竖版强钩子节奏，首屏三秒要直接建立冲突。",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const finishGroup = vi.fn();
    const surfacedTaskIdsRef = { current: new Set<string>() };
    const push = vi.fn();
    const setPopoverOverride = vi.fn();
    const backgroundResearchGroupsRef = {
      current: [
        {
          id: "group-1",
          kind: "video-bridge-platform",
          projectId: runtime.currentProjectSnapshot?.projectId,
          taskIds: [groupedTask.id],
          status: "pending",
          onFinish: finishGroup,
        },
      ] satisfies BackgroundResearchGroup[],
    };
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "bridge saved",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: {
            id: "video-project-1",
            title: "bridge test project",
            script: "script",
            targetPlatform: "抖音",
            shotStyle: "电影感近景",
            outputGoal: "预告片",
            productionNotes: "notes",
            scenes: [
              {
                id: "scene-1",
                sceneNumber: 1,
                sceneName: "Scene 1",
                description: "desc",
                characters: [],
                dialogue: "",
                cameraDirection: "近景",
                duration: 5,
              },
            ],
            characters: [],
            sceneSettings: [],
            artStyle: "live-action",
            currentStep: 2,
            systemPrompt: "",
            analysisSummary: "",
            storyboardPlan: "",
            videoPromptBatch: "",
            sourceProjectId: "",
            createdAt: "2026-04-25T00:00:00.000Z",
            updatedAt: "2026-04-25T00:00:00.000Z",
          },
          projectSnapshot: nextSnapshot,
        },
      })),
    }));

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: true,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [groupedTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef,
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride,
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push,
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule,
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "平台包装"),
      }),
    );

    await waitFor(() => {
      expect(finishGroup).toHaveBeenCalledWith("completed");
      expect(setPopoverOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          answerKey: "video-bridge-panel",
        } satisfies Partial<ComposerQuestion>),
      );
    });

    const nextPopover = setPopoverOverride.mock.calls.at(-1)?.[0] as ComposerQuestion | undefined;
    expect(nextPopover?.options.some((group) =>
      group.value === "video:bridge:next-step" ||
      group.children?.some((option) => option.value === "video:bridge:entities"),
    )).toBe(true);

    expect(loadWorkflowActionsModule).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("进入视频工作流"),
    );
    expect(surfacedTaskIdsRef.current.has(groupedTask.id)).toBe(true);
    expect(backgroundResearchGroupsRef.current).toHaveLength(0);
  });

  it("replaces a stale bridge popover after background bridge research completes", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const nextSnapshot = createVideoSnapshot({
      derivedStage: "角色与场景",
      currentObjective: "完善角色与场景资产，为分镜生成做准备。",
      recommendedActions: ["提取角色与场景", "先补齐基础参考图", "补充额外镜头要求"],
    });
    const groupedTask: Task = {
      id: "task-bridge-stale-popover",
      prompt: "并行研究 平台包装: fill bridge preferences",
      status: "completed",
      output: "适合抖音竖版强钩子节奏，首屏三秒要直接建立冲突。",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const finishGroup = vi.fn();
    const setPopoverOverride = vi.fn();
    const backgroundResearchGroupsRef = {
      current: [
        {
          id: "group-stale-popover",
          kind: "video-bridge-platform",
          projectId: runtime.currentProjectSnapshot?.projectId,
          taskIds: [groupedTask.id],
          status: "pending",
          onFinish: finishGroup,
        },
      ] satisfies BackgroundResearchGroup[],
    };
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "bridge saved",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: {
            id: "video-project-1",
            title: "bridge test project",
            script: "script",
            targetPlatform: "抖音",
            shotStyle: "电影感近景",
            outputGoal: "预告片",
            productionNotes: "notes",
            scenes: [
              {
                id: "scene-1",
                sceneNumber: 1,
                sceneName: "Scene 1",
                description: "desc",
                characters: [],
                dialogue: "",
                cameraDirection: "近景",
                duration: 5,
              },
            ],
            characters: [],
            sceneSettings: [],
            artStyle: "live-action",
            currentStep: 2,
            systemPrompt: "",
            analysisSummary: "",
            storyboardPlan: "",
            videoPromptBatch: "",
            sourceProjectId: "",
            createdAt: "2026-04-25T00:00:00.000Z",
            updatedAt: "2026-04-25T00:00:00.000Z",
          },
          projectSnapshot: nextSnapshot,
        },
      })),
    }));

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: true,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: createQuestion("video-bridge-prefix"),
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [groupedTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride,
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule,
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "平台包装"),
      }),
    );

    await waitFor(() => {
      expect(finishGroup).toHaveBeenCalledWith("completed");
      expect(setPopoverOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          answerKey: "video-bridge-panel",
          title: expect.stringContaining("脚本拆解"),
        } satisfies Partial<ComposerQuestion>),
      );
    });

    expect(backgroundResearchGroupsRef.current).toHaveLength(0);
  });

  it("surfaces a retry bridge panel when background bridge research has no usable result", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const failedTask: Task = {
      id: "task-bridge-failed",
      prompt: "parallel research fill bridge preferences",
      status: "failed",
      output: "",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const finishGroup = vi.fn();
    const push = vi.fn();
    const setPopoverOverride = vi.fn();
    const backgroundResearchGroupsRef = {
      current: [
        {
          id: "group-1",
          kind: "video-bridge-platform",
          projectId: runtime.currentProjectSnapshot?.projectId,
          taskIds: [failedTask.id],
          status: "pending",
          onFinish: finishGroup,
        },
      ] satisfies BackgroundResearchGroup[],
    };

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: true,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [failedTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride,
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push,
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(finishGroup).toHaveBeenCalledWith("cancelled");
      expect(setPopoverOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          answerKey: "video-bridge-retry",
        } satisfies Partial<ComposerQuestion>),
      );
    });

    expect(push).toHaveBeenCalledWith(
      "assistant",
      "自动补齐平台与镜头偏好没有成功完成，你可以手动再试一次。",
    );
    expect(backgroundResearchGroupsRef.current).toHaveLength(0);
  });

  it("surfaces a retry bridge panel when bridge writeback fails", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const groupedTask: Task = {
      id: "task-bridge-1",
      prompt: "parallel research fill bridge preferences",
      status: "completed",
      output: "target platform: 抖音",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const finishGroup = vi.fn();
    const push = vi.fn();
    const setPopoverOverride = vi.fn();
    const backgroundResearchGroupsRef = {
      current: [
        {
          id: "group-1",
          kind: "video-bridge-platform",
          projectId: runtime.currentProjectSnapshot?.projectId,
          taskIds: [groupedTask.id],
          status: "pending",
          onFinish: finishGroup,
        },
      ] satisfies BackgroundResearchGroup[],
    };
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => {
        throw new Error("writeback failed");
      }),
    }));

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: true,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [groupedTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride,
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push,
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule,
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(finishGroup).toHaveBeenCalledWith("completed");
      expect(setPopoverOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          answerKey: "video-bridge-retry",
        } satisfies Partial<ComposerQuestion>),
      );
    });

    expect(push).toHaveBeenCalledWith(
      "assistant",
      "平台与镜头偏好的自动写入失败了，你可以重新发起一次补齐。",
    );
    expect(push).not.toHaveBeenCalledWith(
      "assistant",
      "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002",
    );
    expect(backgroundResearchGroupsRef.current).toHaveLength(0);
  });

  it("hides background research tasks instead of pushing a raw chat bubble", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const completedResearchTask: Task = {
      id: "task-research-1",
      prompt: "并行研究 平台偏好: fill bridge preferences",
      status: "completed",
      output: "short summary",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const surfacedTaskIdsRef = { current: new Set<string>() };
    const push = vi.fn();
    const buildTaskResultMessage = vi.fn(() => "background research completed");

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: createQuestion("existing"),
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [completedResearchTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef,
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push,
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage,
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(surfacedTaskIdsRef.current.has(completedResearchTask.id)).toBe(true);
    });

    expect(push).not.toHaveBeenCalled();
    expect(buildTaskResultMessage).not.toHaveBeenCalled();
  });

  it("also hides failed background research tasks instead of pushing a raw chat bubble", async () => {
    const runtime = createRuntime();
    const runtimeRef = { current: runtime };
    const failedResearchTask: Task = {
      id: "task-research-failed-1",
      prompt: "并行研究 平台偏好: fill bridge preferences",
      status: "failed",
      output: "network timeout",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const surfacedTaskIdsRef = { current: new Set<string>() };
    const push = vi.fn();
    const buildTaskResultMessage = vi.fn(() => "background research failed");

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: createQuestion("existing"),
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [failedResearchTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef,
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push,
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage,
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(surfacedTaskIdsRef.current.has(failedResearchTask.id)).toBe(true);
    });

    expect(push).not.toHaveBeenCalled();
    expect(buildTaskResultMessage).not.toHaveBeenCalled();
  });

  it("does not reopen a restored research followup popover for historical completed tasks", async () => {
    const runtime = createRuntime({
      updatedAt: "2026-04-25T00:00:00.000Z",
    });
    const runtimeRef = { current: runtime };
    const restoredAt = Date.now();
    const completedResearchTask: Task = {
      id: "task-restored-research-1",
      prompt: "骞惰鐮旂┒ 骞冲彴鍋忓ソ: fill bridge preferences",
      status: "completed",
      output: "historical summary",
      sessionId: runtime.sessionId,
      projectId: runtime.currentProjectSnapshot?.projectId,
      createdAt: restoredAt - 10_000,
      updatedAt: restoredAt - 5_000,
    };
    const surfacedTaskFollowupIdsRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [completedResearchTask],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef,
        restoredTaskFollowupSuppressionRef: {
          current: {
            sessionId: runtime.sessionId,
            restoredAt,
          },
        },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride,
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(surfacedTaskFollowupIdsRef.current.has(completedResearchTask.id)).toBe(true);
    });

    expect(setPopoverOverride).not.toHaveBeenCalled();
  });

  it("surfaces the current video workflow question in creative mode without relying on dev fallback", async () => {
    const runtime = createRuntime(
      createVideoSnapshot({
        derivedStage: "脚本拆解",
        currentObjective: "先完成第一轮镜头拆解。",
        recommendedActions: ["先完成第一轮镜头拆解", "继续提取角色与场景"],
      }),
    );
    runtime.currentVideoProject = createVideoProject();
    const runtimeRef = { current: runtime };
    let suggestedState: ComposerQuestion | null = null;

    const setSuggested = vi.fn((updater: ComposerQuestion | null | ((previous: ComposerQuestion | null) => ComposerQuestion | null)) => {
      suggestedState = typeof updater === "function"
        ? (updater as (previous: ComposerQuestion | null) => ComposerQuestion | null)(suggestedState)
        : updater;
    });

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: null,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        dismissedProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested,
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(suggestedState).toEqual(
        expect.objectContaining({
          answerKey: "video-bridge-panel",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "video:bridge:entities" }),
          ]),
        } satisfies Partial<ComposerQuestion>),
      );
    });
  });

  it("suppresses creative-mode video workflow suggestions while waiting for a kickoff reference image upload", async () => {
    const runtime = createRuntime(createVideoSnapshot());
    runtime.currentVideoProject = createVideoProject();
    const runtimeRef = { current: runtime };
    let suggestedState: ComposerQuestion | null = createQuestion("existing");

    const setSuggested = vi.fn((updater: ComposerQuestion | null | ((previous: ComposerQuestion | null) => ComposerQuestion | null)) => {
      suggestedState = typeof updater === "function"
        ? (updater as (previous: ComposerQuestion | null) => ComposerQuestion | null)(suggestedState)
        : updater;
    });

    renderHook(() =>
      useHomeAgentConversationEffects({
        idle: false,
        streaming: false,
        messages: [] as HomeAgentMessage[],
        runtime,
        compactedMessageCount: 0,
        activeProjectId: runtime.currentProjectSnapshot?.projectId,
        creationMode: "creative",
        automationMode: "manual",
        devMode: false,
        mode: "active",
        setMode: vi.fn(),
        qState: null,
        deferredQuestionState: null,
        popoverOverride: null,
        interruptedChoiceQuestion: null,
        suggested: suggestedState,
        suppressVideoWorkflowSuggestions: true,
        draftPresence: false,
        persistedDraft: "",
        deferredDraft: "",
        recentSessionSummary: "",
        selectedValues: [],
        deferredSelectedValues: [],
        selectedTextModelKey: "default",
        selectedImageModelFamily: "jimeng-3.0" as never,
        imageGenerationPrefs: {
          familyKey: "jimeng-3.0" as never,
        } as never,
        selectedVideoModelKey: "kling-v2_1" as never,
        videoGenerationPrefs: {
          modelKey: "kling-v2_1" as never,
        } as never,
        deferredMessages: [],
        deferredProjectSnapshot: runtime.currentProjectSnapshot,
        visibleTasks: [],
        endRef: { current: null },
        engineRef: { current: null },
        runtimeRef,
        draftRef: { current: "" },
        previousQuestionStepRef: { current: null },
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        backgroundResearchGroupsRef: { current: [] },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        dismissedProjectSuggestionKeysRef: { current: new Set<string>() },
        compactionJobVersionRef: { current: 0 },
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setCompactedMessageCount: vi.fn(),
        setStreaming: vi.fn(),
        setSuggested,
        setPopoverOverride: vi.fn(),
        setSelectedValues: vi.fn(),
        resetComposerDraft: vi.fn(),
        send: vi.fn(async () => {}),
        push: vi.fn(),
        flashMaintenanceHint: vi.fn(),
        loadApiConfigModule: vi.fn(async () => ({} as never)),
        loadSemanticSummaryModule: vi.fn(async () => ({} as never)),
        loadProjectStore: vi.fn(async () => ({} as never)),
        loadWorkflowActionsModule: vi.fn(async () => ({} as never)),
        scheduleBackgroundTask: vi.fn(() => () => {}),
        mergeRecentProjects: vi.fn((projects) => projects),
        buildTaskResultMessage: vi.fn(() => "background research completed"),
        buildProjectSuggestionKey: vi.fn(() => null),
        parseTaskHeading: vi.fn(() => "bridge"),
      }),
    );

    await waitFor(() => {
      expect(setSuggested).toHaveBeenCalledWith(null);
      expect(suggestedState).toBeNull();
    });
  });
});
