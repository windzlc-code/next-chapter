import { describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@/lib/agent/types";
import {
  collectChangedArtifactsFromSdkUserMessage,
  createArtifactSignatureMap,
  handleSendEngineEvent,
  resolveDirectProjectImageIntent,
  resolveDirectStoryboardGenerationIntent,
  resolveDirectVideoGenerationIntent,
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
        content: [
          {
            type: "text",
            text,
          },
        ],
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

describe("handleSendEngineEvent", () => {
  it("clears the streaming bubble when structured payloads consume the whole assistant message", async () => {
    const finalizeStreamingMessage = vi.fn();
    const setQuestionRequest = vi.fn();

    await handleSendEngineEvent({
      event: buildAssistantEvent("raw tool payload"),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: "",
          request: {
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
          },
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

    expect(finalizeStreamingMessage).toHaveBeenCalledWith("");
    expect(setQuestionRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy fallback behavior for empty plain assistant text without structured payloads", async () => {
    const finalizeStreamingMessage = vi.fn();

    await handleSendEngineEvent({
      event: buildAssistantEvent(""),
      loadStructuredQuestionParser: async () => ({
        extractStructuredQuestion: () => ({
          cleanedText: "",
          request: null,
          workflowCall: null,
        }),
      }),
      textOf: () => "",
      push: vi.fn(),
      appendStreamingDelta: vi.fn(),
      updateStreamingLabel: vi.fn(),
      finalizeStreamingMessage,
      setQuestionRequest: vi.fn(),
    });

    expect(finalizeStreamingMessage).toHaveBeenCalledWith(undefined);
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

    expect(pendingArtifacts.map((artifact) => artifact.id)).toEqual(["directory"]);

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
      setQuestionRequest: vi.fn(),
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

describe("resolveDirectProjectImageIntent", () => {
  it("routes explicit image prompts directly", () => {
    expect(resolveDirectProjectImageIntent("generate an image of a small blue paper boat on a lake")).toEqual({
      imagePrompt: "generate an image of a small blue paper boat on a lake",
      imageKind: "scene",
    });
  });

  it("does not route vague image requests", () => {
    expect(resolveDirectProjectImageIntent("generate image")).toBeNull();
  });
});

describe("resolveDirectVideoGenerationIntent", () => {
  it("routes direct video generation requests for active video projects", () => {
    expect(
      resolveDirectVideoGenerationIntent("generate video for shot 3", {
        hasActiveVideoProject: true,
        snapshot: {
          projectId: "video-project",
          projectKind: "video",
          title: "Video Project",
          currentObjective: "Generate video",
          derivedStage: "Video",
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
      mode: "image-to-video",
      targetIds: ["scene-3"],
    });
  });

  it("still honors an explicit text-to-video request", () => {
    expect(resolveDirectVideoGenerationIntent("generate a text-to-video trailer")).toEqual({
      mode: "text-to-video",
    });
  });

  it("does not treat internal video choice payloads as direct generation prompts", () => {
    expect(
      resolveDirectVideoGenerationIntent("video:kickoff:prefs:mode:text-to-video", {
        hasActiveVideoProject: true,
      }),
    ).toBeNull();
  });

  it("does not hijack troubleshooting conversations", () => {
    expect(resolveDirectVideoGenerationIntent("how do I fix generate video 404")).toBeNull();
  });
});

describe("resolveDirectStoryboardGenerationIntent", () => {
  it("routes storyboard generation requests for active video projects", () => {
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

  it("does not route storyboard requests without an active video project", () => {
    expect(resolveDirectStoryboardGenerationIntent("generate storyboard")).toBeNull();
  });
});
