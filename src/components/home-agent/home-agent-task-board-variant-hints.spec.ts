import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { buildVideoWorkflowTaskBoard } from "./home-agent-project-questions";

function createVideoSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "Variant Task Board",
    currentObjective: "补齐角色与场景资产",
    derivedStage: "角色与场景",
    agentSummary: "ready",
    recommendedActions: [],
    artifacts: [],
    updatedAt: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
}

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
    title: "Variant Task Board",
    script: "",
    characters: [],
    sceneSettings: [],
    scenes: [],
    shotPackets: [],
    segmentVideoPrompts: {},
    videoGenerationPrefs: {
      mode: "image-to-video",
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
    },
    ...overrides,
  } as PersistedVideoProject;
}

describe("buildVideoWorkflowTaskBoard variant hints", () => {
  it("adds variant hints to character and scene asset rows", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot(),
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "lead",
            isAIGenerated: false,
            source: "manual",
            costumes: [
              { id: "cost-1", label: "校服", description: "blue", isAIGenerated: false },
              { id: "cost-2", label: "战损", description: "red", isAIGenerated: false },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "scene-1",
            name: "Warehouse",
            description: "night",
            isAIGenerated: false,
            source: "manual",
            timeVariants: [{ id: "time-1", label: "夜景", description: "night", isAIGenerated: false }],
          },
        ],
      }),
    );

    expect(board?.items.find((item) => item.id === "characters")?.detail).toContain("含 2 个变体");
    expect(board?.items.find((item) => item.id === "scene-settings")?.detail).toContain("含 1 个变体");
  });
});
