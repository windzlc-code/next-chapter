import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@/lib/agent/types";
import {
  applyAllOverlaysParallel,
  applyConversationMemoryOverlay,
  collectChangedArtifactsFromSdkUserMessage,
  createArtifactSignatureMap,
  formatSendError,
  handleSendEngineEvent,
  resolveBlockedWorkflowMediaAction,
  resolveDirectProjectImageIntent,
  resolveDirectStoryboardGenerationIntent,
  resolveDirectVideoGenerationIntent,
  sanitizeAssistantReplyText,
} from "./home-agent-send-flow";

function buildAssistantEvent(text: string): SDKMessage {
  return {
    type: "assistant",
    uuid: "sdk-assistant",
    sessionId: "session-1",
    message: {
      type: "assistant",
      uuid: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
}

function buildWorkflowUserEvent(snapshot: unknown): SDKMessage {
  return {
    type: "user",
    uuid: "sdk-user",
    sessionId: "session-1",
    message: {
      type: "user",
      uuid: "user-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: JSON.stringify({
              summary: "workflow complete",
              projectSnapshot: snapshot,
            }),
          },
        ],
      },
    },
  };
}

function createRuntime(
  overrides: Partial<import("@/lib/home-agent/types").StudioRuntimeState> = {},
): import("@/lib/home-agent/types").StudioRuntimeState {
  return {
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
    ...overrides,
  };
}

describe("handleSendEngineEvent", () => {
  it("preserves parsed assistant text as-is when finalizing", async () => {
    const finalizeStreamingMessage = vi.fn();
    const parsedText = [
      "完美！女性重生复仇线，30集燃向快节奏。",
      "",
      "现在我为你设计完整的创作方案。请稍等，我会给你：",
      "",
      "项目框架（人物关系、复仇线索、节奏设计）",
      "核心角色档案",
      "分集大纲结构",
      "",
      "正在生成...",
    ].join("\n");

    await handleSendEngineEvent({
      event: buildAssistantEvent(parsedText),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: parsedText,
          request: null,
          workflowCall: null,
        }),
      }),
      textOf: (content) =>
        Array.isArray(content) ? String(content[0]?.text || "") : String(content || ""),
      push: vi.fn(),
      appendStreamingDelta: vi.fn(),
      updateStreamingLabel: vi.fn(),
      finalizeStreamingMessage,
    });

    expect(finalizeStreamingMessage).toHaveBeenCalledWith(parsedText);
  });

  it("surfaces the structured question request separately from the assistant text", async () => {
    const finalizeStreamingMessage = vi.fn();
    const setQuestionRequest = vi.fn();
    const request = {
      id: "request-1",
      allowCustomInput: true,
      submissionMode: "immediate" as const,
      questions: [
        {
          header: "role",
          question: "How should we proceed?",
          multiSelect: false,
          options: [{ label: "contrast", value: "contrast" }],
        },
      ],
    };

    await handleSendEngineEvent({
      event: buildAssistantEvent("raw tool payload"),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: "",
          request,
          workflowCall: null,
        }),
      }),
      textOf: (content) =>
        Array.isArray(content) ? String(content[0]?.text || "") : String(content || ""),
      push: vi.fn(),
      appendStreamingDelta: vi.fn(),
      updateStreamingLabel: vi.fn(),
      finalizeStreamingMessage,
      setQuestionRequest,
    });

    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      expect.stringContaining("How should we proceed?"),
    );
    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      expect.stringContaining("contrast"),
    );
    expect(setQuestionRequest).toHaveBeenCalledWith(request);
  });

  it("preserves free text while surfacing a fallback workflow question", async () => {
    const finalizeStreamingMessage = vi.fn();
    const setQuestionRequest = vi.fn();
    const fallbackRequest = {
      id: "fallback-request-1",
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      questions: [
        {
          header: "创作方式",
          question: "这次想从哪种方式开始原创剧本？",
          multiSelect: false,
          options: [{ label: "选题创作", value: "topic" }],
        },
      ],
    };
    const leadIn = "为了给你最合适的创作方案，我需要先了解几个关键信息：";

    await handleSendEngineEvent({
      event: buildAssistantEvent(leadIn),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: leadIn,
          request: null,
          workflowCall: null,
        }),
      }),
      textOf: (content) =>
        Array.isArray(content) ? String(content[0]?.text || "") : String(content || ""),
      push: vi.fn(),
      appendStreamingDelta: vi.fn(),
      updateStreamingLabel: vi.fn(),
      finalizeStreamingMessage,
      setQuestionRequest,
      getFallbackQuestionRequest: () => fallbackRequest,
    });

    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      expect.stringContaining(leadIn),
    );
    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      expect.stringContaining("这次想从哪种方式开始原创剧本？"),
    );
    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      expect.stringContaining("选题创作"),
    );
    expect(setQuestionRequest).toHaveBeenCalledWith(fallbackRequest);
  });

  it("attaches workflow-created artifact snapshots to the finalized assistant message", async () => {
    const previousSnapshot = {
      projectId: "script-project-1",
      projectKind: "script" as const,
      title: "Test",
      currentObjective: "Continue",
      derivedStage: "Characters",
      agentSummary: "summary",
      recommendedActions: [],
      artifacts: [
        {
          id: "setup",
          kind: "setup" as const,
          label: "Setup",
          summary: "setup summary",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextSnapshot = {
      ...previousSnapshot,
      derivedStage: "Directory",
      artifacts: [
        ...previousSnapshot.artifacts,
        {
          id: "directory",
          kind: "directory" as const,
          label: "Directory",
          summary: "directory summary",
          updatedAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    };
    const finalizeStreamingMessage = vi.fn();
    const artifactSignatures = createArtifactSignatureMap(previousSnapshot);
    let pendingArtifacts = collectChangedArtifactsFromSdkUserMessage(
      buildWorkflowUserEvent(nextSnapshot),
      artifactSignatures,
    );

    await handleSendEngineEvent({
      event: buildAssistantEvent("directory ready"),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: "directory ready",
          request: null,
          workflowCall: null,
        }),
      }),
      textOf: (content) =>
        Array.isArray(content) ? String(content[0]?.text || "") : String(content || ""),
      push: vi.fn(),
      appendStreamingDelta: vi.fn(),
      updateStreamingLabel: vi.fn(),
      finalizeStreamingMessage,
      consumePendingArtifacts: () => {
        if (!pendingArtifacts.length) return undefined;
        const nextArtifacts = [...pendingArtifacts];
        pendingArtifacts = [];
        return nextArtifacts;
      },
    });

    expect(finalizeStreamingMessage).toHaveBeenCalledWith(
      "directory ready",
      ["directory"],
      [
        expect.objectContaining({
          id: "directory",
          label: "Directory",
        }),
      ],
    );
  });
});

describe("historical memory overlays", () => {
  it("skips conversation memory when historical isolation is enabled", async () => {
    const loadConversationMemoryModule = vi.fn(async () => ({
      buildConversationMemoryCorpus: vi.fn(() => []),
      isProjectInternalMemoryQuery: vi.fn(() => false),
      searchConversationMemory: vi.fn(() => []),
      buildConversationMemoryPrompt: vi.fn(() => ""),
      buildConversationMemoryHint: vi.fn(() => ""),
    }));
    const loadProjectStore = vi.fn(async () => ({
      listRecentConversationSnapshots: vi.fn(async () => []),
    }));
    const flashMaintenanceHint = vi.fn();

    const prompt = await applyConversationMemoryOverlay({
      cleaned: "帮我想一个新故事",
      promptForEngine: "帮我想一个新故事",
      runtime: createRuntime({ suppressHistoricalMemory: true }),
      loadConversationMemoryModule: loadConversationMemoryModule as never,
      loadProjectStore: loadProjectStore as never,
      readProjectSession: vi.fn(),
      flashMaintenanceHint,
    });

    expect(prompt).toBe("帮我想一个新故事");
    expect(loadConversationMemoryModule).not.toHaveBeenCalled();
    expect(loadProjectStore).not.toHaveBeenCalled();
    expect(flashMaintenanceHint).not.toHaveBeenCalled();
  });

  it("skips conversation and learning overlays when historical isolation is enabled", async () => {
    const loadConversationMemoryModule = vi.fn(async () => ({
      buildConversationMemoryCorpus: vi.fn(() => []),
      isProjectInternalMemoryQuery: vi.fn(() => false),
      searchConversationMemory: vi.fn(() => []),
      buildConversationMemoryPrompt: vi.fn(() => ""),
      buildConversationMemoryHint: vi.fn(() => ""),
    }));
    const loadProjectStore = vi.fn(async () => ({
      listRecentConversationSnapshots: vi.fn(async () => []),
    }));
    const loadLearningOverlayModule = vi.fn(async () => ({
      buildLearningMemoryOverlay: vi.fn(() => null),
    }));
    const flashMaintenanceHint = vi.fn();
    const push = vi.fn();

    const result = await applyAllOverlaysParallel({
      cleaned: "继续创作",
      launchAutoResearchTasks: vi.fn(async () => null),
      push,
      buildResearchPromptOverlay: vi.fn(),
      runtime: createRuntime({ suppressHistoricalMemory: true }),
      loadConversationMemoryModule: loadConversationMemoryModule as never,
      loadProjectStore: loadProjectStore as never,
      readProjectSession: vi.fn(),
      flashMaintenanceHint,
      currentProjectSnapshot: {
        projectId: "project-1",
        projectKind: "script",
        title: "Fresh Project",
        currentObjective: "Continue",
        derivedStage: "Outline",
        agentSummary: "summary",
        recommendedActions: [],
        artifacts: [],
      },
      loadLearningOverlayModule: loadLearningOverlayModule as never,
    });

    expect(result.promptForEngine).toBe("继续创作");
    expect(loadConversationMemoryModule).not.toHaveBeenCalled();
    expect(loadProjectStore).not.toHaveBeenCalled();
    expect(loadLearningOverlayModule).not.toHaveBeenCalled();
    expect(flashMaintenanceHint).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("keeps standalone sanitation utility behavior available", () => {
    const result = sanitizeAssistantReplyText(`现在我为你整理答案，请稍等。

核心冲突：
她重生后决定借前世证据反杀对手。`);

    expect(result).toBe("核心冲突：\n她重生后决定借前世证据反杀对手。");
  });

  it("formats model errors into user-friendly text", () => {
    expect(formatSendError(new Error("Request timed out"))).toBe("分析超时，请稍后重试。");
    expect(formatSendError(new Error("network error"))).toBe("网络连接异常，请检查网络后重试。");
    expect(formatSendError("unknown")).toBe("分析出错，请稍后重试。");
  });

  it("routes explicit direct intents", () => {
    expect(resolveDirectProjectImageIntent("generate an image of a small blue paper boat on a lake")).toEqual({
      imagePrompt: "generate an image of a small blue paper boat on a lake",
      imageKind: "scene",
    });

    expect(
      resolveDirectVideoGenerationIntent("generate a text-to-video trailer"),
    ).toEqual({
      mode: "text-to-video",
    });

    expect(
      resolveDirectStoryboardGenerationIntent("generate storyboard for shot 3", {
        hasActiveVideoProject: true,
        snapshot: {
          projectId: "video-project",
          projectKind: "video",
          title: "Video Project",
          currentObjective: "Generate storyboard",
          derivedStage: "Storyboard",
          agentSummary: "Ready",
          recommendedActions: [],
          artifacts: [],
        },
        videoProject: {
          scenes: [
            {
              id: "scene-3",
              sceneNumber: 3,
              sceneName: "Shot 3",
            },
          ],
        },
      }),
    ).toEqual({
      action: "generate_storyboard_frames",
      targetIds: ["scene-3"],
    });
  });

  it("keeps vague media shortcuts available for blocked workflow interception", () => {
    expect(resolveDirectProjectImageIntent("给我个图片")).toBeNull();
    expect(resolveBlockedWorkflowMediaAction("给我个图片")).toBe("image");
    expect(resolveBlockedWorkflowMediaAction("给我出个视频")).toBe("video");
    expect(resolveBlockedWorkflowMediaAction("给我来一组分镜")).toBe("storyboard");
  });

  it("does not classify media how-to questions as blocked execution shortcuts", () => {
    expect(resolveBlockedWorkflowMediaAction("图片应该怎么选尺寸")).toBeNull();
    expect(resolveBlockedWorkflowMediaAction("为什么现在不能直接生成视频")).toBeNull();
  });
});
