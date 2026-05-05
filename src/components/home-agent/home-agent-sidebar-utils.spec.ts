import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import {
  collectConversationAssets,
  isLocalSidebarAssetUrl,
  normalizeSidebarAssetPath,
} from "./home-agent-sidebar-utils";

function createVideoProject(): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "\u96e8\u591c\u8ffd\u51fb\u9884\u544a\u7247",
    script: "\u5973\u4e3b\u5728\u96e8\u591c\u8ffd\u9010\u523a\u5ba2\u3002",
    targetPlatform: "\u6296\u97f3",
    shotStyle: "\u7535\u5f71\u611f",
    outputGoal: "\u9884\u544a\u7247",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 5,
    systemPrompt: "",
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "script-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T01:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    productionStateBundle: {
      directoryPath: "D:/StoryForgeFiles/home-agent/production-state/video-project-1",
      overviewPath: "D:/StoryForgeFiles/home-agent/production-state/video-project-1/README.md",
      filePaths: [
        "D:/StoryForgeFiles/home-agent/production-state/video-project-1/README.md",
        "D:/StoryForgeFiles/home-agent/production-state/video-project-1/project.json",
      ],
      exportedCount: 2,
      exportedAt: "2026-04-03T01:00:00.000Z",
    },
  };
}

function createSnapshot(): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "\u96e8\u591c\u8ffd\u51fb\u9884\u544a\u7247",
    derivedStage: "\u89c6\u9891\u751f\u6210",
    currentObjective: "\u7ee7\u7eed\u8f6e\u8be2\u5f53\u524d\u955c\u5934\u7ed3\u679c\u3002",
    agentSummary: "\u53ef\u4ee5\u7ee7\u7eed\u8f6e\u8be2\u6216\u5ba1\u9605\u5f53\u524d\u8d44\u4ea7\u3002",
    recommendedActions: [],
    artifacts: [],
    memory: {
      styleLock: null,
      worldModel: null,
      shotPackets: [],
      reviewQueue: [],
      assetManifest: {
        version: "1",
        summary: "test",
        items: [
          {
            id: "asset-video-1",
            kind: "video-segment",
            label: "\u89c6\u9891 \u8def \u955c\u593401 \u8def \u96e8\u591c\u5954\u8dd1",
            url: "https://example.com/video-1.mp4",
            meta: "\u5df2\u5b8c\u6210",
            reusable: false,
            status: "ready",
            version: 1,
            createdAt: "2026-04-03T01:00:00.000Z",
          },
          {
            id: "asset-image-1",
            kind: "character-reference",
            label: "\u89d2\u8272 \u8def \u6c88\u66e6",
            url: "https://example.com/char-1.jpg",
            meta: "\u89d2\u8272\u4e3b\u53c2\u8003",
            reusable: true,
            status: "ready",
            version: 1,
            createdAt: "2026-04-03T01:00:00.000Z",
          },
        ],
      },
      characterStateCards: [],
      storyBeatPackets: [],
      complianceRevisionPackets: [],
    },
  };
}

describe("collectConversationAssets", () => {
  it("prepends the persisted production bundle before manifest-backed assets", () => {
    const assets = collectConversationAssets(createVideoProject(), createSnapshot());

    expect(assets[0]).toMatchObject({
      kind: "bundle",
      label: "\u751f\u4ea7\u72b6\u6001\u5305",
      path: "D:/StoryForgeFiles/home-agent/production-state/video-project-1",
    });
    expect(assets[1]).toMatchObject({
      kind: "video",
      label: "\u89c6\u9891 \u8def \u955c\u593401 \u8def \u96e8\u591c\u5954\u8dd1",
      url: "https://example.com/video-1.mp4",
    });
    expect(assets[2]).toMatchObject({
      kind: "image",
      label: "\u89d2\u8272 \u8def \u6c88\u66e6",
      url: "https://example.com/char-1.jpg",
    });
  });

  it("preserves manual other-image labels and prefixes derived unlabeled assets by kind", () => {
    const snapshot = createSnapshot();
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "manual assets",
      items: [
        {
          id: "asset-manual-image-1",
          kind: "character-reference",
          label: "\u5176\u4ed6 \u8def moodboard.jpg",
          url: "https://example.com/manual-image.jpg",
          meta: "\u624b\u52a8\u52a0\u5165 / \u5176\u4ed6\u56fe\u7247",
          reusable: true,
          status: "ready",
          origin: "manual",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
        {
          id: "asset-scene-image-1",
          kind: "scene-reference",
          label: "\u96e8\u591c\u8857\u9053",
          url: "https://example.com/scene-image.jpg",
          meta: "\u573a\u666f\u53c2\u8003",
          reusable: true,
          status: "ready",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(createVideoProject(), snapshot);

    expect(assets.find((asset) => asset.id === "asset-manual-image-1")).toMatchObject({
      kind: "image",
      label: "\u5176\u4ed6 \u8def moodboard.jpg",
      origin: "manual",
    });
    expect(assets.find((asset) => asset.id === "asset-scene-image-1")).toMatchObject({
      kind: "image",
      label: "\u573a\u666f \u8def \u96e8\u591c\u8857\u9053",
      origin: "derived",
    });
  });

  it("only shows the latest fallback image assets and hides historical images", () => {
    const project = createVideoProject();
    project.productionStateBundle = null;
    project.characters = [
      {
        id: "char-1",
        name: "Ava",
        description: "Lead character",
        imageUrl: "https://example.com/char-current.jpg",
        isAIGenerated: true,
        source: "manual",
        imageHistory: [
          {
            imageUrl: "https://example.com/char-history.jpg",
            description: "old",
            createdAt: "2026-04-03T00:30:00.000Z",
          },
        ],
        costumes: [
          {
            id: "costume-1",
            label: "School Uniform",
            description: "Variant",
            imageUrl: "https://example.com/costume-current.jpg",
            isAIGenerated: true,
            imageHistory: [
              {
                imageUrl: "https://example.com/costume-history.jpg",
                description: "old",
                createdAt: "2026-04-03T00:40:00.000Z",
              },
            ],
          },
        ],
      },
    ];
    project.sceneSettings = [
      {
        id: "scene-1",
        name: "Rooftop",
        description: "Night",
        imageUrl: "https://example.com/scene-current.jpg",
        isAIGenerated: true,
        source: "manual",
        imageHistory: [
          {
            imageUrl: "https://example.com/scene-history.jpg",
            description: "old",
            createdAt: "2026-04-03T00:50:00.000Z",
          },
        ],
        timeVariants: [
          {
            id: "variant-1",
            label: "Dusk",
            description: "Variant",
            imageUrl: "https://example.com/variant-current.jpg",
            isAIGenerated: true,
            imageHistory: [
              {
                imageUrl: "https://example.com/variant-history.jpg",
                description: "old",
                createdAt: "2026-04-03T00:55:00.000Z",
              },
            ],
          },
        ],
      },
    ];
    project.scenes = [
      {
        id: "shot-1",
        sceneNumber: 1,
        sceneName: "Rooftop",
        description: "Storyboard",
        characters: ["Ava"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "https://example.com/storyboard-current.jpg",
        storyboardHistory: ["https://example.com/storyboard-history.jpg"],
      },
    ];

    const assets = collectConversationAssets(project);
    const urls = assets.flatMap((asset) => ("url" in asset ? [asset.url] : []));

    expect(urls).toContain("https://example.com/char-current.jpg");
    expect(urls).toContain("https://example.com/costume-current.jpg");
    expect(urls).toContain("https://example.com/scene-current.jpg");
    expect(urls).toContain("https://example.com/variant-current.jpg");
    expect(urls).toContain("https://example.com/storyboard-current.jpg");
    expect(urls).not.toContain("https://example.com/char-history.jpg");
    expect(urls).not.toContain("https://example.com/costume-history.jpg");
    expect(urls).not.toContain("https://example.com/scene-history.jpg");
    expect(urls).not.toContain("https://example.com/variant-history.jpg");
    expect(urls).not.toContain("https://example.com/storyboard-history.jpg");
  });

  it("does not re-add historical videos from fallback scene video history", () => {
    const project = createVideoProject();
    project.productionStateBundle = null;
    project.scenes = [
      {
        id: "shot-1",
        sceneNumber: 1,
        sceneName: "Rooftop",
        description: "Video",
        characters: ["Ava"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        videoUrl: "https://example.com/video-current.mp4",
        videoHistory: [
          {
            videoUrl: "https://example.com/video-history.mp4",
            createdAt: "2026-04-03T00:40:00.000Z",
          },
        ],
      },
    ];

    const assets = collectConversationAssets(project);
    const urls = assets.flatMap((asset) => ("url" in asset ? [asset.url] : []));

    expect(urls).toContain("https://example.com/video-current.mp4");
    expect(urls).not.toContain("https://example.com/video-history.mp4");
  });
});

describe("sidebar asset path helpers", () => {
  it("detects local filesystem asset urls", () => {
    expect(isLocalSidebarAssetUrl("file:///C:/Users/demo/image.jpg")).toBe(true);
    expect(isLocalSidebarAssetUrl("C:\\Users\\demo\\image.jpg")).toBe(true);
    expect(isLocalSidebarAssetUrl("https://example.com/image.jpg")).toBe(false);
    expect(isLocalSidebarAssetUrl("data:image/png;base64,abc")).toBe(false);
  });

  it("normalizes file urls into local filesystem paths", () => {
    expect(normalizeSidebarAssetPath("file:///C:/Users/demo/image%201.jpg")).toBe(
      "C:\\Users\\demo\\image 1.jpg",
    );
    expect(normalizeSidebarAssetPath("D:\\assets\\clip.mp4")).toBe("D:\\assets\\clip.mp4");
  });
});
