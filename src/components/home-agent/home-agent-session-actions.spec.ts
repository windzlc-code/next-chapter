import { describe, expect, it, vi } from "vitest";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import {
  handleHomeAgentChoiceSelection,
  resetRuntimeState,
} from "./home-agent-session-actions";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Session Actions Project",
    currentObjective: "继续完善角色弧光",
    derivedStage: "角色开发",
    agentSummary: "summary",
    recommendedActions: ["进入角色开发"],
    artifacts: [],
    ...overrides,
  };
}

function createQuestion(
  overrides: Partial<ComposerQuestion> = {},
): ComposerQuestion {
  return {
    id: "script-characters-script-project-1",
    title: "下一步：进入角色开发",
    options: [
      {
        id: "enter-characters",
        label: "进入角色开发",
        value: "进入角色开发",
      },
    ],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-characters",
    ...overrides,
  };
}

function createRuntime(overrides: Partial<StudioRuntimeState> = {}): StudioRuntimeState {
  return {
    sessionId: "session-1",
    suppressHistoricalMemory: false,
    currentProjectSnapshot: {
      projectId: "project-1",
      projectKind: "video",
      title: "Project 1",
      currentObjective: "Continue workflow",
      derivedStage: "角色与场景",
      agentSummary: "summary",
      recommendedActions: [],
      artifacts: [],
      automationMode: "full-auto",
    },
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentProjectSessions: [],
    recentMessageSummary: "recent",
    fullAutoRun: {
      status: "running",
      currentStepIndex: 2,
      currentStepLabel: "角色转译",
      plan: {
        id: "plan-1",
        mode: "adaptation-v1",
        steps: [],
        currentStepIndex: 2,
      },
    },
    ...overrides,
  } as StudioRuntimeState;
}

describe("handleHomeAgentChoiceSelection", () => {
  it("returns handled when a script workflow shortcut consumes the selection", () => {
    const answer = vi.fn();
    const setSelectedValues = vi.fn();

    const handled = handleHomeAgentChoiceSelection({
      snapshot: createSnapshot(),
      value: "进入角色开发",
      label: "进入角色开发",
      question: createQuestion(),
      qState: null,
      answer,
      setSelectedValues,
      videoProjectChoiceHandler: vi.fn(() => false),
      videoAssetChoiceHandler: vi.fn(() => false),
      scriptProjectChoiceHandler: vi.fn(() => true),
      autoResearchChoiceHandler: vi.fn(() => false),
    });

    expect(handled).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(setSelectedValues).not.toHaveBeenCalled();
  });

  it("still routes script workflow choices from non-script-prefixed question ids", () => {
    const answer = vi.fn();
    const setSelectedValues = vi.fn();
    const scriptProjectChoiceHandler = vi.fn(() => true);

    const handled = handleHomeAgentChoiceSelection({
      snapshot: createSnapshot(),
      value: "进入角色开发",
      label: "进入角色开发",
      question: createQuestion({
        id: "recovery-script-project-1",
        answerKey: "recovery",
      }),
      qState: null,
      answer,
      setSelectedValues,
      videoProjectChoiceHandler: vi.fn(() => false),
      videoAssetChoiceHandler: vi.fn(() => false),
      scriptProjectChoiceHandler,
      autoResearchChoiceHandler: vi.fn(() => false),
    });

    expect(handled).toBe(true);
    expect(scriptProjectChoiceHandler).toHaveBeenCalledWith(
      createSnapshot(),
      "进入角色开发",
      "进入角色开发",
    );
    expect(answer).not.toHaveBeenCalled();
    expect(setSelectedValues).not.toHaveBeenCalled();
  });

  it("returns false when it only updates the local pending selection state", () => {
    const answer = vi.fn();
    const setSelectedValues = vi.fn();

    const handled = handleHomeAgentChoiceSelection({
      snapshot: createSnapshot(),
      value: "生成分集目录",
      label: "生成分集目录",
      question: createQuestion({
        id: "script-directory-script-project-1",
        title: "角色设定完成后，你想怎么继续？",
        options: [
          { id: "directory", label: "生成分集目录", value: "生成分集目录" },
          { id: "revise", label: "再补充角色关系", value: "再补充角色关系" },
        ],
        submissionMode: "confirm",
      }),
      qState: null,
      answer,
      setSelectedValues,
      videoProjectChoiceHandler: vi.fn(() => false),
      videoAssetChoiceHandler: vi.fn(() => false),
      scriptProjectChoiceHandler: vi.fn(() => false),
      autoResearchChoiceHandler: vi.fn(() => false),
    });

    expect(handled).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(setSelectedValues).toHaveBeenCalledOnce();
  });

  it("routes video kickoff choices even when the current snapshot is stale", () => {
    const answer = vi.fn();
    const setSelectedValues = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);
    const question = createQuestion({
      id: "video-kickoff-prefs-mode-video-project-1",
      answerKey: "video-kickoff-prefs-mode",
      submissionMode: "immediate",
      options: [
        {
          id: "mode-text",
          label: "文生视频",
          value: "video:kickoff:prefs:mode:text-to-video",
        },
      ],
    });

    const handled = handleHomeAgentChoiceSelection({
      snapshot: createSnapshot(),
      value: "video:kickoff:prefs:mode:text-to-video",
      label: "文生视频",
      question,
      qState: null,
      answer,
      setSelectedValues,
      videoProjectChoiceHandler,
      videoAssetChoiceHandler: vi.fn(() => false),
      scriptProjectChoiceHandler: vi.fn(() => false),
      autoResearchChoiceHandler: vi.fn(() => false),
    });

    expect(handled).toBe(true);
    expect(videoProjectChoiceHandler).toHaveBeenCalledWith(
      createSnapshot(),
      "video:kickoff:prefs:mode:text-to-video",
      "文生视频",
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it("never submits raw video choice payloads as normal answers", () => {
    const answer = vi.fn();
    const setSelectedValues = vi.fn();

    const handled = handleHomeAgentChoiceSelection({
      snapshot: null,
      value: "video:kickoff:prefs:mode:text-to-video",
      label: "文生视频",
      question: createQuestion({
        id: "video-kickoff-prefs-mode-video-project-1",
        answerKey: "video-kickoff-prefs-mode",
        submissionMode: "immediate",
      }),
      qState: null,
      answer,
      setSelectedValues,
      videoProjectChoiceHandler: vi.fn(() => false),
      videoAssetChoiceHandler: vi.fn(() => false),
      scriptProjectChoiceHandler: vi.fn(() => false),
      autoResearchChoiceHandler: vi.fn(() => false),
    });

    expect(handled).toBe(true);
    expect(answer).not.toHaveBeenCalledWith("video:kickoff:prefs:mode:text-to-video", "文生视频");
    expect(setSelectedValues).not.toHaveBeenCalled();
  });
});

describe("resetRuntimeState", () => {
  it("clears the runtime ref synchronously while resetting state", () => {
    const setRuntime = vi.fn();
    const runtimeRef = { current: createRuntime() };

    resetRuntimeState(setRuntime, runtimeRef);

    expect(runtimeRef.current.currentProjectSnapshot).toBeNull();
    expect(runtimeRef.current.fullAutoRun).toBeNull();
    expect(runtimeRef.current.currentDramaProject).toBeNull();
    expect(runtimeRef.current.currentVideoProject).toBeNull();
    expect(setRuntime).toHaveBeenCalledWith(expect.any(Function));

    const updater = setRuntime.mock.calls[0][0] as () => StudioRuntimeState;
    expect(updater()).toBe(runtimeRef.current);
  });
});
