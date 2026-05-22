import { describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import {
  collectConversationAssets,
  isLocalSidebarAssetUrl,
  normalizeSidebarAssetPath,
  resolveSidebarAssetPreviewUrl,
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
            url: "https://example.com/video-preview-1.mp4",
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
            url: "https://example.com/char-preview-1.jpg",
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
  it("restores manifest-backed assets even before the full video project rehydrates", () => {
    const assets = collectConversationAssets(null, createSnapshot());

    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      kind: "video",
      label: "\u89c6\u9891 \u8def \u955c\u593401 \u8def \u96e8\u591c\u5954\u8dd1",
      url: "https://example.com/video-preview-1.mp4",
    });
    expect(assets[1]).toMatchObject({
      kind: "image",
      label: "\u89d2\u8272 \u8def \u6c88\u66e6",
      url: "https://example.com/char-preview-1.jpg",
    });
  });

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
      url: "https://example.com/video-preview-1.mp4",
    });
    expect(assets[2]).toMatchObject({
      kind: "image",
      label: "\u89d2\u8272 \u8def \u6c88\u66e6",
      url: "https://example.com/char-preview-1.jpg",
    });
  });

  it("attaches character audio upload metadata to character image assets", () => {
    const snapshot = createSnapshot();
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "character manifest",
      items: [
        {
          id: "asset-character-manifest",
          kind: "character-reference",
          label: "\u6c88\u662d",
          url: "https://example.com/char-manifest.jpg",
          meta: "\u89d2\u8272\u4e3b\u53c2\u8003",
          reusable: true,
          status: "ready",
          sourceEntityId: "char-1",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
      ],
    };

    const project = createVideoProject();
    project.characters = [
      {
        id: "char-1",
        name: "\u6c88\u662d",
        description: "Lead",
        imageUrl: "https://example.com/char-derived.jpg",
        audioUrl: "file:///assets/shenzhao-reference.wav",
        audioFileName: "shenzhao-reference.wav",
        threeViewUrls: {
          front: "https://example.com/char-front.jpg",
        },
        isAIGenerated: true,
        source: "manual",
        costumes: [
          {
            id: "costume-1",
            label: "\u6218\u635f",
            description: "battle damage",
            imageUrl: "https://example.com/char-costume.jpg",
            isAIGenerated: true,
          },
        ],
      },
    ];

    const assets = collectConversationAssets(project, snapshot);
    const manifestAsset = assets.find((asset) => asset.id === "asset-character-manifest");
    const derivedMainAsset = assets.find(
      (asset) => asset.kind === "image" && "url" in asset && asset.url === "https://example.com/char-derived.jpg",
    );
    const derivedThreeViewAsset = assets.find(
      (asset) => asset.kind === "image" && "url" in asset && asset.url === "https://example.com/char-front.jpg",
    );
    const derivedCostumeAsset = assets.find(
      (asset) => asset.kind === "image" && "url" in asset && asset.url === "https://example.com/char-costume.jpg",
    );

    expect(manifestAsset).toMatchObject({
      characterAudioTargetId: "char-1",
      characterAudioTargetName: "\u6c88\u662d",
      characterAudioUrl: "file:///assets/shenzhao-reference.wav",
      characterAudioFileName: "shenzhao-reference.wav",
      characterAudioReferenceReady: true,
    });
    expect(derivedMainAsset).toMatchObject({
      characterAudioTargetId: "char-1",
      characterAudioTargetName: "\u6c88\u662d",
      characterAudioUrl: "file:///assets/shenzhao-reference.wav",
      characterAudioFileName: "shenzhao-reference.wav",
      characterAudioReferenceReady: true,
    });
    expect(derivedThreeViewAsset).toMatchObject({
      characterAudioTargetId: "char-1",
      characterAudioTargetName: "\u6c88\u662d",
    });
    expect(derivedCostumeAsset).toMatchObject({
      characterAudioTargetId: "char-1",
      characterAudioTargetName: "\u6c88\u662d",
    });
  });

  it("merges hydrated project assets after manifest restore without duplicating manifest-backed videos", () => {
    const snapshot = createSnapshot();
    const project = createVideoProject();
    project.characters = [
      {
        id: "char-2",
        name: "\u9648\u661f",
        description: "Support lead",
        imageUrl: "https://example.com/char-current-2.jpg",
        isAIGenerated: true,
        source: "manual",
        costumes: [],
      },
    ];
    project.sceneSettings = [
      {
        id: "scene-1",
        name: "\u96e8\u591c\u8857\u9053",
        description: "Night exterior",
        imageUrl: "https://example.com/scene-current.jpg",
        isAIGenerated: true,
        source: "manual",
        timeVariants: [],
      },
    ];
    project.scenes = [
      {
        id: "shot-1",
        sceneNumber: 1,
        sceneName: "\u96e8\u591c\u8857\u9053",
        description: "Storyboard",
        characters: ["\u9648\u661f"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "https://example.com/storyboard-current.jpg",
        videoUrl: "https://example.com/video-preview-1.mp4",
      },
    ];

    const assets = collectConversationAssets(project, snapshot);
    const urls = assets.flatMap((asset) => ("url" in asset ? [asset.url] : []));

    expect(urls.filter((url) => url === "https://example.com/video-preview-1.mp4")).toHaveLength(1);
    expect(urls).toContain("https://example.com/storyboard-current.jpg");
    expect(urls).toContain("https://example.com/scene-current.jpg");
    expect(urls).toContain("https://example.com/char-current-2.jpg");
  });

  it("skips known smoke placeholder urls from manifest-backed assets", () => {
    const snapshot = createSnapshot();
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "placeholder assets",
      items: [
        {
          id: "asset-placeholder-storyboard",
          kind: "storyboard-frame",
          label: "\u5206\u955c",
          url: "https://example.com/storyboard-1.jpg",
          meta: "placeholder",
          reusable: false,
          status: "ready",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
          updatedAt: "2026-04-03T02:00:00.000Z",
        },
        {
          id: "asset-real-image",
          kind: "character-reference",
          label: "\u89d2\u8272",
          url: "https://example.com/char-preview-2.jpg",
          meta: "usable",
          reusable: true,
          status: "ready",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(createVideoProject(), snapshot);

    expect(assets.some((asset) => "url" in asset && asset.url === "https://example.com/storyboard-1.jpg")).toBe(false);
    expect(assets.some((asset) => "url" in asset && asset.url === "https://example.com/char-preview-2.jpg")).toBe(true);
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
      label: "\u573a\u666f \u00b7 \u96e8\u591c\u8857\u9053",
      origin: "derived",
    });
  });

  it("keeps distinct manifest assets even when they point to the same media url", () => {
    const snapshot = createSnapshot();
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "same-url assets",
      items: [
        {
          id: "asset-image-char-1",
          kind: "character-reference",
          label: "\u89d2\u8272 \u00b7 \u6797\u6653\u6653",
          url: "https://example.com/shared-reference.jpg",
          meta: "\u89d2\u8272\u4e3b\u53c2\u8003",
          reusable: true,
          status: "ready",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
        {
          id: "asset-image-char-2",
          kind: "costume-reference",
          label: "\u89d2\u8272 \u00b7 \u6797\u6653\u6653 \u00b7 \u53d8\u4f53-\u767d\u88d9\u5165\u5b85",
          url: "https://example.com/shared-reference.jpg",
          meta: "\u89d2\u8272\u53d8\u4f53",
          reusable: true,
          status: "ready",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:01.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(createVideoProject(), snapshot);

    expect(assets.filter((asset) => asset.kind === "image")).toHaveLength(2);
    expect(assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining(["asset-image-char-1", "asset-image-char-2"]),
    );
  });

  it("maps manifest-backed segment videos into the segment sub-tab metadata", () => {
    const snapshot = createSnapshot();
    const project = createVideoProject();
    project.segmentContinuityGridImages = {
      "1-2": {
        imageUrl: "E:\\library\\segment-1-2-grid.jpg",
        recapText: "前情六宫格",
        frameUrls: [
          "E:\\library\\segment-1-2-kf-1.jpg",
          "E:\\library\\segment-1-2-kf-2.jpg",
        ],
      },
    };
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "segment videos",
      items: [
        {
          id: "segment:1-2:video",
          kind: "video-segment",
          label: "第1集 · 片段1-2",
          url: "E:\\library\\segment-1-2.mp4",
          meta: "片段视频",
          reusable: false,
          status: "ready",
          source: "segment-video",
          sourceEntityId: "1-2",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
          updatedAt: "2026-04-03T02:00:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(project, snapshot);

    expect(assets.find((asset) => asset.id === "segment:1-2:video")).toMatchObject({
      kind: "video",
      subKind: "segment",
      segmentLabel: "1-2",
      continuityGridReady: true,
      url: "E:\\library\\segment-1-2.mp4",
    });
  });

  it("routes archived QA-failed segment videos into the history-video panel metadata", () => {
    const snapshot = createSnapshot();
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "archived failed segment videos",
      items: [
        {
          id: "manual:segment-1-2:qa-failed",
          kind: "video-segment",
          label: "绗?闆?路 鐗囨1-2 路 QA failed",
          url: "E:\\library\\segment-1-2-qa-failed.mp4",
          meta: "QA failed / archived",
          reusable: false,
          status: "failed",
          sourceEntityId: "1-2",
          origin: "manual",
          version: 1,
          createdAt: "2026-04-03T01:05:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(createVideoProject(), snapshot);

    expect(assets.find((asset) => asset.id === "manual:segment-1-2:qa-failed")).toMatchObject({
      kind: "video",
      subKind: "history-video",
      status: "failed",
      segmentLabel: "1-2",
      url: "E:\\library\\segment-1-2-qa-failed.mp4",
    });
  });

  it("collects persisted archived segment candidates into the history-video panel metadata", () => {
    const project = createVideoProject();
    project.archivedSegmentVideos = {
      "1-2": [
        {
          id: "history-entry-1",
          segmentLabel: "1-2",
          videoUrl: "E:\\library\\segment-1-2-archived.mp4",
          failureReason: "自动 QA 要求整段重生：角色身份和连续性漂移。",
          route: "regenerate",
          archivedAt: "2026-04-03T01:10:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(project, createSnapshot());

    expect(assets.find((asset) => asset.id === "segment-history:1-2:history-entry-1")).toMatchObject({
      kind: "video",
      subKind: "history-video",
      status: "failed",
      segmentLabel: "1-2",
      historyEntryId: "history-entry-1",
      failureReason: "自动 QA 要求整段重生：角色身份和连续性漂移。",
      url: "E:\\library\\segment-1-2-archived.mp4",
    });
  });

  it("maps manifest-backed continuity grids into the dedicated continuity panel metadata", () => {
    const snapshot = createSnapshot();
    const project = createVideoProject();
    project.segmentContinuityGridImages = {
      "1-2": {
        imageUrl: "E:\\library\\segment-1-2-grid.jpg",
        recapText: "苏辰倒在深坑中，嘲笑声不断逼近。随着镜头持续推进，他握紧裂纹木剑，危险气息开始蔓延。最终，苏辰缓慢抬头，力量即将觉醒。",
        frameUrls: [
          "E:\\library\\segment-1-2-kf-1.jpg",
          "E:\\library\\segment-1-2-kf-2.jpg",
        ],
      },
    };
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "segment continuity grids",
      items: [
        {
          id: "segment:1-2:continuity-grid",
          kind: "segment-continuity-grid",
          label: "片段 · 1-2",
          url: "E:\\library\\segment-1-2-grid.jpg",
          meta: "前情六宫格",
          reusable: true,
          status: "ready",
          source: "segment-continuity-grid",
          sourceEntityId: "1-2",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
          updatedAt: "2026-04-03T02:00:00.000Z",
        },
      ],
    };

    const assets = collectConversationAssets(project, snapshot);

    expect(assets.find((asset) => asset.id === "segment:1-2:continuity-grid")).toMatchObject({
      kind: "image",
      subKind: "continuity-grid",
      segmentLabel: "1-2",
      label: "片段 · 1-2",
      meta: expect.stringContaining("前情六宫格"),
      url: "E:\\library\\segment-1-2-grid.jpg",
      previewVersion: "2026-04-03T02:00:00.000Z",
    });
  });

  it("keeps the continuity recap text on mapped continuity-grid assets", () => {
    const snapshot = createSnapshot();
    const project = createVideoProject();
    project.segmentContinuityGridImages = {
      "1-2": {
        imageUrl: "E:\\library\\segment-1-2-grid.jpg",
        recapText: "苏辰倒在深坑中，嘲笑声不断逼近。随着镜头持续推进，他握紧裂纹木剑，危险气息开始蔓延。最终，苏辰缓慢抬头，力量即将觉醒。",
        frameUrls: [
          "E:\\library\\segment-1-2-kf-1.jpg",
          "E:\\library\\segment-1-2-kf-2.jpg",
        ],
      },
    };
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "segment continuity grids",
      items: [
        {
          id: "segment:1-2:continuity-grid",
          kind: "segment-continuity-grid",
          label: "鐗囨 路 1-2",
          url: "E:\\library\\segment-1-2-grid.jpg",
          meta: "鍓嶆儏鍏鏍?",
          reusable: true,
          status: "ready",
          source: "segment-continuity-grid",
          sourceEntityId: "1-2",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
          updatedAt: "2026-04-03T02:00:00.000Z",
        },
      ],
    };

    const asset = collectConversationAssets(project, snapshot).find(
      (entry) => entry.id === "segment:1-2:continuity-grid",
    );

    expect(asset?.recapText).toContain("前情提要：");
    expect(asset?.recapText).not.toContain("人物状态：");
    expect(asset?.recapText).not.toContain("场景描述：");
    expect(asset?.recapText).not.toContain("人物动作：");
    expect(asset?.recapText).not.toContain("发生事件：");
    expect(asset?.recapText).toContain("苏辰倒在深坑中");
    expect(asset?.recapText).toContain("握紧裂纹木剑");
  });

  it("upgrades legacy short continuity recap text to the canonical multi-sentence recap", () => {
    const snapshot = createSnapshot();
    const project = createVideoProject();
    project.scenes = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "演武场重创",
        description: "苏辰染血倒在演武场深坑边缘，围观压力持续逼近。",
        characters: ["苏辰", "叶昊"],
        dialogue: "",
        cameraDirection: "wide push-in",
        duration: 6,
        segmentLabel: "1-2",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "觉醒前兆",
        description: "苏辰握紧裂纹木剑缓慢抬头，空气中的灵气开始异常波动。",
        characters: ["苏辰", "叶昊"],
        dialogue: "",
        cameraDirection: "tight dramatic rise",
        duration: 6,
        segmentLabel: "1-2",
      },
    ];
    project.segmentContinuityGridImages = {
      "1-2": {
        imageUrl: "E:\\library\\segment-1-2-grid.jpg",
        recapText: "烈日如火，[陆家演武场]中央的青石处刑台上，粗壮的玄铁锁链死死钉在铜柱上，散发着冰冷的光芒。",
        frameUrls: [
          "E:\\library\\segment-1-2-kf-1.jpg",
          "E:\\library\\segment-1-2-kf-2.jpg",
        ],
      },
    };
    snapshot.memory.assetManifest = {
      version: "1",
      summary: "segment continuity grids",
      items: [
        {
          id: "segment:1-2:continuity-grid",
          kind: "segment-continuity-grid",
          label: "片段 · 1-2",
          url: "E:\\library\\segment-1-2-grid.jpg",
          meta: "前情六宫格",
          reusable: true,
          status: "ready",
          source: "segment-continuity-grid",
          sourceEntityId: "1-2",
          origin: "derived",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
          updatedAt: "2026-04-03T02:00:00.000Z",
        },
      ],
    };

    const asset = collectConversationAssets(project, snapshot).find(
      (entry) => entry.id === "segment:1-2:continuity-grid",
    );

    expect(asset?.recapText).toContain("前情提要：");
    expect(asset?.recapText).not.toContain("人物状态：");
    expect(asset?.recapText).not.toContain("场景描述：");
    expect(asset?.recapText).not.toContain("人物动作：");
    expect(asset?.recapText).not.toContain("发生事件：");
    expect(asset?.recapText).toContain("演武场重创");
    expect(asset?.recapText).toContain("握紧裂纹木剑");
    expect(asset?.recapText).not.toBe(
      "烈日如火，[陆家演武场]中央的青石处刑台上，粗壮的玄铁锁链死死钉在铜柱上，散发着冰冷的光芒。",
    );
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

  it("falls back to the original local path when the remapped project path has not been migrated yet", async () => {
    window.electronAPI = {
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/CurrentFiles", db: "D:/CurrentDb" })),
        readBase64: vi.fn(async (filePath: string) => {
          const normalized = filePath.replace(/\//g, "\\");
          if (normalized.includes("hero-original.jpg")) {
            return {
              ok: true,
              exists: true,
              base64: "IMAGE_BASE64",
              mimeType: "image/jpeg",
            };
          }
          return {
            ok: true,
            exists: false,
            base64: "",
          };
        }),
      },
    } as unknown as typeof window.electronAPI;

    await expect(
      resolveSidebarAssetPreviewUrl(
        {
          kind: "image",
          url: "D:/OldFiles/projects/video-project-1/images/generated/hero-original.jpg",
        },
        "video-project-1",
      ),
    ).resolves.toBe("data:image/jpeg;base64,IMAGE_BASE64");
  });
});
