import { describe, expect, it } from "vitest";

import { buildStoryboardBreakdownRoot } from "@/lib/home-agent/storyboard-breakdown";
import type { CharacterSetting, Scene, SceneSetting } from "@/types/project";

describe("buildStoryboardBreakdownRoot", () => {
  it("surfaces matched costume and scene time variants in segment asset tags", () => {
    const scenes: Scene[] = [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "天台",
        description: "林霄穿着战损黑衣站在暴雨夜的天台边缘。",
        characters: ["林霄"],
        dialogue: "",
        cameraDirection: "广角推进",
        duration: 5,
        segmentLabel: "1-1",
        characterCostumes: { 林霄: "战损黑衣" },
        sceneTimeVariantId: "暴雨夜",
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "天台",
        description: "林霄抬眼看向远处霓虹，雨水顺着衣角滴落。",
        characters: ["林霄"],
        dialogue: "",
        cameraDirection: "中近景转近景",
        duration: 5,
        segmentLabel: "1-1",
        characterCostumes: { 林霄: "战损黑衣" },
        sceneTimeVariantId: "暴雨夜",
      },
    ];

    const characters: CharacterSetting[] = [
      {
        id: "character-1",
        name: "林霄",
        description: "男主角",
        isAIGenerated: true,
        source: "auto",
        costumes: [
          {
            id: "costume-1",
            label: "战损黑衣",
            description: "破损黑衣，肩部带血迹",
            isAIGenerated: true,
          },
        ],
        activeCostumeId: "costume-1",
      },
    ];

    const sceneSettings: SceneSetting[] = [
      {
        id: "scene-setting-1",
        name: "天台",
        description: "高楼天台",
        isAIGenerated: true,
        source: "auto",
        timeVariants: [
          {
            id: "variant-1",
            label: "暴雨夜",
            description: "暴雨与冷色霓虹交织的夜晚",
            isAIGenerated: true,
          },
        ],
        activeTimeVariantId: "variant-1",
      },
    ];

    const breakdown = buildStoryboardBreakdownRoot({
      title: "测试项目",
      scenes,
      characters,
      sceneSettings,
    });

    expect(breakdown).not.toBeNull();
    expect(breakdown?.episodes[0]?.clips[0]?.tags).toEqual(
      expect.arrayContaining(["天台 暴雨夜", "林霄 战损黑衣"]),
    );
  });
});
