import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "./use-local-persistence";
import {
  normalizeStoredVideoProject,
  pruneExpiredVideoReferencesFromProject,
} from "./use-local-persistence";

function createProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "Video Project",
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
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  } as PersistedVideoProject;
}

describe("normalizeStoredVideoProject", () => {
  it("repairs missing and duplicate nested variant ids while preserving order", () => {
    const project = createProject({
      characters: [
        {
          id: "char-1",
          name: "Hero",
          description: "desc",
          isAIGenerated: false,
          source: "manual",
          activeCostumeId: "missing-costume",
          costumes: [
            { id: "", label: "校服", description: "蓝白校服", isAIGenerated: false },
            { id: "dup-id", label: "战损版", description: "衣角破损", isAIGenerated: false },
            { id: "dup-id", label: "礼服版", description: "黑金礼服", isAIGenerated: false },
          ],
        },
      ],
      sceneSettings: [
        {
          id: "scene-setting-1",
          name: "Warehouse",
          description: "desc",
          isAIGenerated: false,
          source: "manual",
          activeTimeVariantId: "dup-time",
          timeVariants: [
            { id: "dup-time", label: "雨夜", description: "冷蓝夜光", isAIGenerated: false },
            { id: "dup-time", label: "清晨", description: "薄雾晨光", isAIGenerated: false },
            { id: "", label: "正午", description: "顶光强烈", isAIGenerated: false },
          ],
        },
      ],
    });

    const normalized = normalizeStoredVideoProject(project);
    const costumes = normalized.characters[0].costumes ?? [];
    const timeVariants = normalized.sceneSettings[0].timeVariants ?? [];

    expect(costumes.map((item) => item.label)).toEqual(["校服", "战损版", "礼服版"]);
    expect(timeVariants.map((item) => item.label)).toEqual(["雨夜", "清晨", "正午"]);

    expect(costumes.every((item) => item.id.trim().length > 0)).toBe(true);
    expect(new Set(costumes.map((item) => item.id)).size).toBe(costumes.length);
    expect(normalized.characters[0].activeCostumeId).toBeUndefined();

    expect(timeVariants.every((item) => item.id.trim().length > 0)).toBe(true);
    expect(new Set(timeVariants.map((item) => item.id)).size).toBe(timeVariants.length);
    expect(normalized.sceneSettings[0].activeTimeVariantId).toBe("dup-time");
  });
  it("drops empty and expired asset-manifest entries even when they are not video segments", () => {
    const project = createProject({
      assetManifest: {
        version: "manifest-1",
        summary: "summary",
        items: [
          {
            id: "manual:image-ok",
            kind: "character-reference",
            label: "Other image",
            url: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\images\\manual\\other.jpg",
            meta: "manual",
            reusable: true,
            status: "ready",
            origin: "manual",
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
          {
            id: "manual:image-empty",
            kind: "character-reference",
            label: "Broken image",
            url: "   ",
            meta: "manual",
            reusable: true,
            status: "ready",
            origin: "manual",
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
          {
            id: "manual:image-expired",
            kind: "character-reference",
            label: "Expired image",
            url: "https://example.com/image.jpg?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
            meta: "manual",
            reusable: true,
            status: "ready",
            origin: "manual",
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
        ],
      },
    });

    const pruned = pruneExpiredVideoReferencesFromProject(
      project,
      Date.parse("2026-04-28T00:00:00.000Z"),
    );

    expect(pruned.assetManifest?.items.map((item) => item.id)).toEqual(["manual:image-ok"]);
  });
});

describe("pruneExpiredVideoReferencesFromProject", () => {
  it("removes expired remote signed video urls from scenes and asset manifests", () => {
    const project = createProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Opening",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          videoUrl:
            "https://example.com/video-1.mp4?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
          videoStatus: "completed",
          videoTaskId: "task-1",
          videoProvider: "seedance",
          videoFailure: {
            message: "old failure",
            updatedAt: "2026-04-25T16:17:53.000Z",
          },
          videoHistory: [
            {
              videoUrl:
                "https://example.com/video-old.mp4?X-Tos-Date=20260424T161753Z&X-Tos-Expires=86400",
              createdAt: "2026-04-24T16:17:53.000Z",
            },
            {
              videoUrl: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
              createdAt: "2026-04-25T17:00:00.000Z",
            },
          ],
        },
      ],
      assetManifest: {
        version: "manifest-1",
        summary: "summary",
        items: [
          {
            id: "shot:scene-1:video",
            kind: "video-segment",
            label: "Shot 1",
            url: "https://example.com/video-1.mp4?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
            meta: "completed",
            reusable: false,
            status: "needs-review",
            sceneId: "scene-1",
            sceneNumber: 1,
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
          {
            id: "shot:scene-1:storyboard",
            kind: "storyboard-frame",
            label: "Storyboard 1",
            url: "https://example.com/storyboard-1.jpg",
            meta: "storyboard",
            reusable: false,
            status: "ready",
            sceneId: "scene-1",
            sceneNumber: 1,
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
        ],
      },
    });

    const pruned = pruneExpiredVideoReferencesFromProject(
      project,
      Date.parse("2026-04-28T00:00:00.000Z"),
    );
    const scene = pruned.scenes[0];

    expect(scene.videoUrl).toBeUndefined();
    expect(scene.videoStatus).toBeUndefined();
    expect(scene.videoTaskId).toBeUndefined();
    expect(scene.videoProvider).toBeUndefined();
    expect(scene.videoFailure).toBeUndefined();
    expect(scene.videoHistory).toEqual([
      {
        videoUrl: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
        createdAt: "2026-04-25T17:00:00.000Z",
      },
    ]);
    expect(pruned.assetManifest?.items.map((item) => item.id)).toEqual(["shot:scene-1:storyboard"]);
  });

  it("keeps local videos and unsigned remote urls intact", () => {
    const project = createProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Opening",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          videoUrl: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1.mp4",
          videoHistory: [
            {
              videoUrl: "https://example.com/video-unsigned.mp4",
              createdAt: "2026-04-25T16:17:53.000Z",
            },
          ],
        },
      ],
    });

    const pruned = pruneExpiredVideoReferencesFromProject(
      project,
      Date.parse("2026-04-28T00:00:00.000Z"),
    );

    expect(pruned).toEqual(project);
  });

  it("removes manual manifest videos that only point at historical scene versions", () => {
    const historicalUrl =
      "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1-old.mp4";
    const currentUrl =
      "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\videos\\generated\\scene-1-current.mp4";
    const project = createProject({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Opening",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          videoUrl: currentUrl,
          videoHistory: [
            {
              videoUrl: historicalUrl,
              createdAt: "2026-04-25T16:17:53.000Z",
            },
          ],
        },
      ],
      assetManifest: {
        version: "manifest-1",
        summary: "summary",
        items: [
          {
            id: "manual:video-history",
            kind: "video-segment",
            label: "Historical shot",
            url: historicalUrl,
            meta: "manual",
            reusable: false,
            status: "ready",
            origin: "manual",
            version: 1,
            createdAt: "2026-04-25T16:17:53.000Z",
          },
          {
            id: "manual:video-current",
            kind: "video-segment",
            label: "Current shot",
            url: currentUrl,
            meta: "manual",
            reusable: false,
            status: "ready",
            origin: "manual",
            version: 1,
            createdAt: "2026-04-25T16:18:53.000Z",
          },
        ],
      },
    });

    const pruned = pruneExpiredVideoReferencesFromProject(project);

    expect(pruned.assetManifest?.items.map((item) => item.id)).toEqual(["manual:video-current"]);
  });
});
