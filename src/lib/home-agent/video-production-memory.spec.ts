import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import {
  deriveVideoAssetManifest,
  deriveVideoShotPackets,
  deriveVideoWorldModel,
  synchronizeVideoProductionState,
} from "./video-production-memory";

function createProject(): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "仙界试炼",
    script: "群仙在夜色中对峙。",
    targetPlatform: "抖音",
    shotStyle: "电影感",
    outputGoal: "角色群像短片",
    productionNotes: "",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        segmentLabel: "1-1",
        sceneName: "仙界·群雄",
        description: "众人第一次对峙。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "wide shot",
        duration: 5,
        storyboardUrl: "https://cdn.storyforge.test/storyboard-1.jpg",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        segmentLabel: "1-2",
        sceneName: "仙界·群雄",
        description: "第二个对峙镜头。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "close shot",
        duration: 5,
        storyboardUrl: "https://cdn.storyforge.test/storyboard-2.jpg",
        videoUrl: "https://cdn.storyforge.test/video-2.mp4",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "沈昭",
        description: "红衣剑客",
        imageUrl: "https://cdn.storyforge.test/char-main.jpg",
        isAIGenerated: true,
        source: "auto",
      },
      {
        id: "char-2",
        name: "沈昭",
        description: "黑衣分身",
        imageUrl: "https://cdn.storyforge.test/char-alt.jpg",
        isAIGenerated: true,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "仙界",
        description: "夜色下的仙宫",
        imageUrl: "https://cdn.storyforge.test/scene.jpg",
        isAIGenerated: true,
        source: "auto",
      },
    ],
    artStyle: "live-action",
    currentStep: 4,
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
    productionStateBundle: null,
  };
}

describe("deriveVideoAssetManifest", () => {
  it("adds shot numbers and duplicate suffixes into asset labels", () => {
    const manifest = deriveVideoAssetManifest(createProject());

    expect(manifest.items.find((item) => item.id === "shot:scene-1:storyboard")?.label).toBe(
      "分镜 · 镜头01 · 片段1-1 · 仙界·群雄",
    );
    expect(manifest.items.find((item) => item.id === "shot:scene-2:video")).toMatchObject({
      kind: "video-segment",
      label: "镜头02 · 片段1-2 · 仙界·群雄",
    });

    const shenZhaoLabels = manifest.items
      .filter((item) => item.kind === "character-reference" && item.label.startsWith("角色 · 沈昭"))
      .map((item) => item.label);

    expect(shenZhaoLabels).toEqual([
      "角色 · 沈昭 · 01",
      "角色 · 沈昭 · 02",
    ]);
  });
  it("preserves manual library assets while filtering expired manual entries", () => {
    const project = createProject();
    project.assetManifest = {
      version: "1",
      summary: "manual assets",
      items: [
        {
          id: "manual:other-image",
          kind: "character-reference",
          label: "manual image",
          url: "D:\\StoryForgeFiles\\projects\\video-project-1\\media\\images\\manual\\other.jpg",
          meta: "manual",
          reusable: true,
          status: "ready",
          origin: "manual",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
        {
          id: "manual:expired-video",
          kind: "video-segment",
          label: "expired video",
          url: "https://example.com/expired.mp4?X-Tos-Date=20260425T161753Z&X-Tos-Expires=86400",
          meta: "manual",
          reusable: true,
          status: "ready",
          origin: "manual",
          version: 1,
          createdAt: "2026-04-03T01:00:00.000Z",
        },
      ],
    };

    const manifest = deriveVideoAssetManifest(project);

    expect(manifest.items.some((item) => item.id === "manual:other-image")).toBe(true);
    expect(manifest.items.some((item) => item.id === "manual:expired-video")).toBe(false);
  });

  it("preserves derived asset timestamps when only workflow step metadata changes", () => {
    const project = createProject();
    const firstManifest = deriveVideoAssetManifest(project);
    const firstStoryboard = firstManifest.items.find((item) => item.id === "shot:scene-1:storyboard");

    project.assetManifest = firstManifest;
    project.currentStep = 4;
    project.analysisSummary = "已切换到视频生成阶段。";
    project.updatedAt = "2026-04-03T05:00:00.000Z";

    const nextManifest = deriveVideoAssetManifest(project);
    const nextStoryboard = nextManifest.items.find((item) => item.id === "shot:scene-1:storyboard");

    expect(nextStoryboard?.url).toBe(firstStoryboard?.url);
    expect(nextStoryboard?.createdAt).toBe(firstStoryboard?.createdAt);
    expect(nextStoryboard?.updatedAt).toBe(firstStoryboard?.updatedAt);
  });
});

describe("video production memory derivation", () => {
  it("builds an executable world model with relationships, props, and timeline snapshots", () => {
    const worldModel = deriveVideoWorldModel(createProject());

    expect(Array.isArray(worldModel.relationships)).toBe(true);
    expect(Array.isArray(worldModel.props)).toBe(true);
    expect(worldModel.stateTimeline?.map((snapshot) => snapshot.segmentLabel)).toEqual(["1-1", "1-2"]);
    expect(worldModel.stateTimeline?.[0]?.characterStates.length).toBeGreaterThan(0);
    expect(worldModel.narrativeConstraints?.length).toBeGreaterThan(0);
    expect(worldModel.continuityInvariants?.length).toBeGreaterThan(0);
  });

  it("derives shot packets with reference plans and QA policies", () => {
    const shotPackets = deriveVideoShotPackets(createProject());

    expect(shotPackets).toHaveLength(2);
    expect(shotPackets[0]).toMatchObject({
      startState: expect.any(String),
      endState: expect.any(String),
      referencePlan: {
        orderedAssetIds: expect.any(Array),
        continuityFrameFirst: true,
        relayVideoPreferred: true,
      },
      generationPolicy: {
        preferSegmentChain: true,
      },
      qaSpec: {
        minTotalScore: 85,
        minContinuityScore: 85,
      },
    });
    expect(shotPackets[1]?.requiredEntities?.length).toBeGreaterThan(0);
  });

  it("materializes reference-target automation state for primary and dependent assets", () => {
    const project = synchronizeVideoProductionState({
      ...createProject(),
      characters: [
        {
          id: "char-1",
          name: "Hero",
          description: "Lead",
          imageUrl: "",
          isAIGenerated: false,
          source: "auto",
          costumes: [
            {
              id: "cost-1",
              label: "战损",
              description: "外套破损",
              isAIGenerated: false,
            },
          ],
        },
      ],
      sceneSettings: [],
    });

    expect(project.automationState?.referenceTargets).toEqual(
      expect.objectContaining({
        "reference-character:char-1": expect.objectContaining({
          status: "pending",
          retryBudget: 3,
        }),
        "reference-character-variant:char-1:cost-1": expect.objectContaining({
          status: "blocked",
          dependencyTargetIds: ["reference-character:char-1"],
          retryBudget: 2,
        }),
      }),
    );
  });
});
