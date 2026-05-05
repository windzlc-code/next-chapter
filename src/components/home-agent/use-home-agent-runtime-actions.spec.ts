import { describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import {
  applyVideoKickoffFollowupQuestion,
  applyWorkflowMediaFollowupQuestion,
  throwIfAborted,
  waitForAbortableDelay,
} from "./use-home-agent-runtime-actions";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "测试视频项目",
    currentObjective: "完成脚本拆解",
    derivedStage: "脚本拆解",
    agentSummary: "summary",
    recommendedActions: ["先完成第一轮镜头拆解"],
    artifacts: [],
    ...overrides,
  };
}

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "测试视频项目",
    script: "script body",
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 1,
    systemPrompt: "",
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

describe("applyVideoKickoffFollowupQuestion", () => {
  it("opens the workflow bridge panel when the bridged video project lands in script analysis", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();
    const projectSnapshot = createSnapshot();
    const videoProject = createVideoProject();

    const handled = applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot,
        data: { videoProject },
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(push).not.toHaveBeenCalled();
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
      }),
    );
  });

  it("pushes a completion message before opening the real workflow question once all fields are written", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();
    const projectSnapshot = createSnapshot();
    const videoProject = createVideoProject({
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
    });

    applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot,
        data: { videoProject },
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(push).toHaveBeenCalledWith(
      "assistant",
      "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002",
    );
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
      }),
    );
  });

  it("does nothing once the bridged project has already moved past script analysis", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();

    const handled = applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot: createSnapshot({ derivedStage: "角色与场景" }),
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("applyWorkflowMediaFollowupQuestion", () => {
  it("re-opens the preferred followup popup after media generation completes", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const preferredQuestion = {
      id: "media-followup",
      title: "继续下一步",
      options: [{ id: "next", label: "继续", value: "continue" }],
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "media-followup",
    };

    const handled = applyWorkflowMediaFollowupQuestion({
      preferredQuestion,
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(preferredQuestion);
  });

  it("falls back to the workflow question derived from runtime when no preferred popup is provided", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot(),
      runtime: {
        currentVideoProject: createVideoProject(),
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
      }),
    );
  });

  it("does not open a followup popup while video generation is still running", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot(),
      runtime: {
        currentVideoProject: createVideoProject({
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "雨夜追击",
              description: "desc",
              characters: [],
              dialogue: "",
              cameraDirection: "",
              duration: 5,
              videoTaskId: "task-1",
              videoStatus: "processing",
            },
          ],
        }),
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
  });

  it("does nothing when the current runtime cannot produce a next-step popup", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot({
        projectKind: "script",
        derivedStage: "未知阶段",
        recommendedActions: [],
      }),
      runtime: {
        currentVideoProject: null,
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
  });
});

describe("abort helpers", () => {
  it("throws an AbortError when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();

    try {
      throwIfAborted(controller.signal);
      throw new Error("expected throwIfAborted to throw");
    } catch (error) {
      expect(error).toMatchObject({
        message: "请求已取消",
        name: "AbortError",
      });
    }
  });

  it("resolves the delay when no abort happens", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForAbortableDelay(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the delay with an AbortError when the signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = waitForAbortableDelay(100, controller.signal);
      const rejection = expect(pending).rejects.toMatchObject({
        message: "请求已取消",
        name: "AbortError",
      });

      controller.abort();
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
