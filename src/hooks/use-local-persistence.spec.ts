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

  it("trims a persisted reference style summary and clears empty values", () => {
    const normalized = normalizeStoredVideoProject(
      createProject({
        referenceStyleSummary: "  具有电影质感的写实风格，街头场景，光影对比强烈。  ",
      }),
    );
    const cleared = normalizeStoredVideoProject(
      createProject({
        referenceStyleSummary: "   ",
      }),
    );

    expect(normalized.referenceStyleSummary).toBe("具有电影质感的写实风格，街头场景，光影对比强烈。");
    expect(cleared.referenceStyleSummary).toBeUndefined();
  });

  it("preserves character audio reference fields during normalization", () => {
    const normalized = normalizeStoredVideoProject(
      createProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            audioUrl: "E:\\audio\\hero-reference.wav",
            audioFileName: "hero-reference.wav",
            isAIGenerated: false,
            source: "manual",
          },
        ],
      }),
    );

    expect(normalized.characters[0]?.audioUrl).toBe("E:\\audio\\hero-reference.wav");
    expect(normalized.characters[0]?.audioFileName).toBe("hero-reference.wav");
  });

  it("strips known smoke placeholder media urls from persisted video projects", () => {
    const normalized = normalizeStoredVideoProject(
      createProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "https://example.com/char-1.jpg",
            isAIGenerated: true,
            source: "manual",
            imageHistory: [
              {
                imageUrl: "https://example.com/char-1.jpg",
                description: "old",
                createdAt: "2026-04-03T00:00:00.000Z",
              },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Street",
            description: "desc",
            imageUrl: "https://example.com/scene-1.jpg",
            isAIGenerated: true,
            source: "manual",
          },
        ],
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Shot 1",
            description: "desc",
            characters: [],
            dialogue: "",
            cameraDirection: "",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-1.jpg",
            videoUrl: "https://example.com/video-1.mp4",
            storyboardHistory: ["https://example.com/storyboard-1.jpg"],
            videoHistory: [
              {
                videoUrl: "https://example.com/video-1.mp4",
                createdAt: "2026-04-03T00:00:00.000Z",
              },
            ],
          },
        ],
        assetManifest: {
          version: "manifest-1",
          summary: "summary",
          items: [
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
        segmentVideos: {
          "1-1": "https://example.com/video-1.mp4",
        },
      }),
    );

    expect(normalized.characters[0]?.imageUrl).toBeUndefined();
    expect(normalized.characters[0]?.imageHistory).toBeUndefined();
    expect(normalized.sceneSettings[0]?.imageUrl).toBeUndefined();
    expect(normalized.scenes[0]?.storyboardUrl).toBeUndefined();
    expect(normalized.scenes[0]?.videoUrl).toBeUndefined();
    expect(normalized.scenes[0]?.storyboardHistory).toEqual([]);
    expect(normalized.scenes[0]?.videoHistory).toBeUndefined();
    expect(normalized.assetManifest?.items).toEqual([]);
    expect(normalized.segmentVideos).toBeUndefined();
  });

  it("preserves archived segment candidate metadata while sanitizing empty preview refs", () => {
    const normalized = normalizeStoredVideoProject(
      createProject({
        archivedSegmentVideos: {
          "1-2": [
            {
              id: "archived-1",
              segmentLabel: "1-2",
              videoUrl: "https://example.com/segment-1-2-failed.mp4",
              failureReason: "自动 QA 拦截：连续性不足",
              provider: "jimeng",
              taskId: "task-1-2",
              submittedPrompt: "片段提示词",
              referenceImageUrls: ["https://example.com/ref-1.jpg", "   "],
              usedContinuityFrame: true,
              usedRelayVideo: false,
              route: "escalate",
              auditId: "audit-1-2",
              qaSummary: "总分 74，连续性不足",
              issues: ["连续性不足"],
              qualityTier: "borderline",
              archivedAt: "2026-04-03T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(normalized.archivedSegmentVideos?.["1-2"]).toEqual([
      expect.objectContaining({
        id: "archived-1",
        provider: "jimeng",
        taskId: "task-1-2",
        submittedPrompt: "片段提示词",
        referenceImageUrls: ["https://example.com/ref-1.jpg"],
        usedContinuityFrame: true,
        usedRelayVideo: false,
        route: "escalate",
        auditId: "audit-1-2",
      }),
    ]);
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

  it("preserves continuity grid updatedAt so refreshed previews can bust stale caches", () => {
    const normalized = normalizeStoredVideoProject(
      createProject({
        segmentContinuityGridImages: {
          "1-2": {
            imageUrl: "E:\\media\\segment-1-2_continuity_grid.jpg",
            recapText: "前情提要",
            frameUrls: [
              "E:\\media\\segment-1-2_f1.jpg",
              "E:\\media\\segment-1-2_f2.jpg",
            ],
            createdAt: "2026-05-19T15:00:00.000Z",
            updatedAt: "2026-05-19T16:00:00.000Z",
          },
        },
      }),
    );

    expect(normalized.segmentContinuityGridImages?.["1-2"]).toEqual(
      expect.objectContaining({
        imageUrl: "E:\\media\\segment-1-2_continuity_grid.jpg",
        createdAt: "2026-05-19T15:00:00.000Z",
        updatedAt: "2026-05-19T16:00:00.000Z",
      }),
    );
  });
});
