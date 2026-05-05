import { describe, expect, it } from "vitest";
import {
  appendDuplicateLabelSequence,
  buildCharacterAssetFileStem,
  buildCharacterAssetLabel,
  buildSceneAssetLabel,
  buildStoryboardAssetFileStem,
  buildStoryboardAssetLabel,
  buildVideoAssetLabel,
  resolveNextAssetVersion,
} from "./asset-naming";

describe("asset naming", () => {
  it("builds readable labels for character and scene variants", () => {
    expect(buildCharacterAssetLabel("沈昭")).toBe("角色 · 沈昭");
    expect(buildCharacterAssetLabel("沈昭", { variantLabel: "战损红衣" })).toBe("角色 · 沈昭 · 变体-战损红衣");
    expect(buildSceneAssetLabel("天宫长阶", { variantLabel: "黄昏" })).toBe("场景 · 天宫长阶 · 变体-黄昏");
  });

  it("includes shot numbers in storyboard and video labels", () => {
    const scene = { sceneNumber: 3, segmentLabel: "3-2", sceneName: "仙界·群雄" };
    expect(buildStoryboardAssetLabel(scene)).toBe("分镜 · 镜头03 · 片段3-2 · 仙界·群雄");
    expect(buildVideoAssetLabel(scene)).toBe("镜头03 · 片段3-2 · 仙界·群雄");
  });

  it("builds semantic file stems for generated images", () => {
    expect(buildCharacterAssetFileStem("沈昭", { version: 2 })).toBe("角色_沈昭_v02");
    expect(buildStoryboardAssetFileStem({ sceneNumber: 8, sceneName: "雨夜走廊" }, { version: 4 })).toBe(
      "分镜_镜头08_雨夜走廊_v04",
    );
  });

  it("appends sequence suffixes when labels collide", () => {
    const items = appendDuplicateLabelSequence([
      { label: "角色 · 沈昭", id: "1" },
      { label: "角色 · 沈昭", id: "2" },
      { label: "分镜 · 镜头01 · 雨夜走廊", id: "3" },
    ]);

    expect(items[0]?.label).toBe("角色 · 沈昭 · 01");
    expect(items[1]?.label).toBe("角色 · 沈昭 · 02");
    expect(items[2]?.label).toBe("分镜 · 镜头01 · 雨夜走廊");
  });

  it("increments asset version from current item and history", () => {
    expect(resolveNextAssetVersion(undefined, [])).toBe(1);
    expect(resolveNextAssetVersion("current.png", [])).toBe(2);
    expect(resolveNextAssetVersion("current.png", ["old-1.png", "old-2.png"])).toBe(4);
  });
});
