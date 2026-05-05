import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { deriveVideoAssetManifest } from "./video-production-memory";

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
        storyboardUrl: "https://example.com/storyboard-1.jpg",
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
        storyboardUrl: "https://example.com/storyboard-2.jpg",
        videoUrl: "https://example.com/video-2.mp4",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "沈昭",
        description: "红衣剑客",
        imageUrl: "https://example.com/char-main.jpg",
        isAIGenerated: true,
        source: "auto",
      },
      {
        id: "char-2",
        name: "沈昭",
        description: "黑衣分身",
        imageUrl: "https://example.com/char-alt.jpg",
        isAIGenerated: true,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "仙界",
        description: "夜色下的仙宫",
        imageUrl: "https://example.com/scene.jpg",
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
});
