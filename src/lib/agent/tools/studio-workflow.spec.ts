import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolUseContext } from "../tool";
import { StudioWorkflowTool } from "./studio-workflow";

const runWorkflowActionMock = vi.fn();

vi.mock("@/lib/home-agent/workflow-actions", () => ({
  runWorkflowAction: (...args: unknown[]) => runWorkflowActionMock(...args),
}));

const parentMessage = {
  type: "assistant",
  uuid: "assistant-parent",
  message: {
    role: "assistant",
    content: "parent",
  },
} as const;

describe("StudioWorkflowTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns videoUrls, dispatches the completion event, and reports progress for video generation", async () => {
    runWorkflowActionMock.mockResolvedValue({
      summary: "已完成 1 条镜头出片。",
      recommendedActions: [],
      projectSnapshot: {
        projectId: "video-project-1",
        projectKind: "video",
        title: "测试视频项目",
      },
      data: {
        currentVideoProject: {
          id: "video-project-1",
          title: "测试视频项目",
        },
        projectSnapshot: {
          projectId: "video-project-1",
          projectKind: "video",
          title: "测试视频项目",
        },
        recentMessageSummary: "已完成 1 条镜头出片。",
      },
      videoUrls: ["https://example.com/generated-video.mp4"],
    });

    const tool = new StudioWorkflowTool();
    let appState = {
      currentDramaProject: null,
      currentVideoProject: null,
      currentProjectSnapshot: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState) as typeof appState;
    });
    const progress = vi.fn();
    const eventHandler = vi.fn();
    window.addEventListener("agent:video-generated", eventHandler as EventListener);

    const context = new ToolUseContext({
      options: {
        model: "claude-sonnet-4-6",
        tools: [],
        apiKey: "test-key",
        baseUrl: "https://example.test",
      },
      getAppState: () => appState,
      setAppState,
    });

    const result = await tool.call(
      {
        action: "generate_video_assets",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "1080p",
        },
      },
      context,
      vi.fn(),
      parentMessage,
      progress,
    );

    expect(runWorkflowActionMock).toHaveBeenCalledWith(
      "generate_video_assets",
      expect.objectContaining({
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "1080p",
        },
      }),
      expect.objectContaining({
        currentProjectSnapshot: null,
      }),
    );

    expect(progress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "start",
        content: "Agent 正在执行：提交视频出片",
      }),
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "complete",
        content: "已完成：已完成 1 条镜头出片。",
      }),
    );

    expect(eventHandler).toHaveBeenCalledTimes(1);
    expect(eventHandler.mock.calls[0]?.[0]?.detail).toEqual(
      expect.objectContaining({
        videoUrls: ["https://example.com/generated-video.mp4"],
        action: "generate_video_assets",
        count: 1,
        model: "doubao-seedance-1-5-pro",
        resolution: "1080p",
      }),
    );

    expect(setAppState).toHaveBeenCalledTimes(1);
    expect(appState.currentProjectSnapshot).toEqual({
      projectId: "video-project-1",
      projectKind: "video",
      title: "测试视频项目",
    });

    expect(JSON.parse(String(result.data))).toEqual({
      summary: "已完成 1 条镜头出片。",
      recommendedActions: [],
      projectSnapshot: {
        projectId: "video-project-1",
        projectKind: "video",
        title: "测试视频项目",
      },
      videoUrls: ["https://example.com/generated-video.mp4"],
    });

    window.removeEventListener("agent:video-generated", eventHandler as EventListener);
  });
});
