import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import {
  hasAutoExportableVideoSegments,
  hasCompleteVideoOutputs,
  hasCompleteVideoReferenceAssets,
  hasMinimumVideoReferenceAssets,
  hasReviewableVideoOutputs,
} from "./video-workflow-step-gates";

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "烟火人间不及你",
    script: "第1集",
    targetPlatform: "抖音",
    shotStyle: "电影感",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "雨夜追击",
        description: "女主在雨夜回头看见追兵。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "中景跟拍",
        duration: 6,
        storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
        segmentLabel: "1-1",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "巷口转身",
        description: "她在巷口急停转身。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "近景推近",
        duration: 5,
        storyboardUrl: "https://media.storyforge.test/storyboard-2.jpg",
        segmentLabel: "1-1",
      },
    ],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "script-project-1",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

describe("video-workflow-step-gates", () => {
  it("treats completed text-to-video segment outputs as exportable and reviewable", () => {
    const project = createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      },
      segmentVideos: {
        "1-1": "E:/videos/segment-1-1.mp4",
      },
      segmentVideoStatuses: {
        "1-1": {
          segmentLabel: "1-1",
          status: "completed",
          taskId: "task-1",
          provider: "jimeng",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
      },
    });

    expect(hasAutoExportableVideoSegments(project)).toBe(true);
    expect(hasReviewableVideoOutputs(project)).toBe(true);
    expect(hasCompleteVideoOutputs(project)).toBe(true);
  });

  it("treats failed text-to-video segment outputs as reviewable but not complete", () => {
    const project = createVideoProject({
      videoGenerationPrefs: {
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      },
      segmentVideos: {},
      segmentVideoStatuses: {
        "1-1": {
          segmentLabel: "1-1",
          status: "failed",
          taskId: "task-1",
          provider: "jimeng",
          updatedAt: "2026-05-13T00:00:00.000Z",
        },
      },
    });

    expect(hasAutoExportableVideoSegments(project)).toBe(false);
    expect(hasReviewableVideoOutputs(project)).toBe(true);
    expect(hasCompleteVideoOutputs(project)).toBe(false);
  });

  it("does not count placeholder or expired reference urls as complete reference assets", () => {
    const project = createVideoProject({
      characters: [
        {
          id: "char-1",
          name: "沈昭",
          description: "主角",
          imageUrl: "https://example.com/char-1.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      sceneSettings: [
        {
          id: "setting-1",
          name: "雨夜长街",
          description: "冷色夜雨",
          imageUrl: "https://example.com/scene-1.jpg?X-Amz-Date=20250101T000000Z&X-Amz-Expires=60",
          isAIGenerated: false,
          source: "auto",
        },
      ],
    });

    expect(hasMinimumVideoReferenceAssets(project)).toBe(false);
    expect(hasCompleteVideoReferenceAssets(project)).toBe(false);
  });
});
