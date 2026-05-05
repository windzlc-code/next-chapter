import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationProjectSnapshot, HomeAgentMessage, StudioQuestionState } from "@/lib/home-agent/types";
import type { StudioSessionState } from "@/lib/home-agent/types";
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
        loadProjectStore: loadProjectStore as never,
        flushSessionRef: {
          current: () => {
            order.push("flush");
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
        setPopoverOverride: vi.fn(),
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
        setDeferredDraft: vi.fn(),
        previousQuestionStepRef: { current: null },
        clearSurfacedTasks: vi.fn(),
        surfacedTaskIdsRef: { current: new Set<string>() },
        surfacedTaskFollowupIdsRef: { current: new Set<string>() },
        restoredTaskFollowupSuppressionRef: { current: null },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        restoredProjectSuggestionKeysRef: { current: new Set<string>() },
        dreaminaCapability: { ready: true, available: false },
        flashMaintenanceHint: vi.fn(),
        surfacedDreaminaHintRef: { current: false },
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
});
