import { describe, expect, it } from "vitest";

import { buildMediaContentSummary } from "./media-generation-copy";
import type { StudioRuntimeState } from "./types";

describe("buildMediaContentSummary", () => {
  it("derives richer character details from runtime descriptions when the prompt only contains the name", () => {
    const runtime = {
      currentVideoProject: {
        id: "video-project-1",
        title: "测试项目",
        scenes: [],
        characters: [
          {
            id: "char-1",
            name: "叶灵汐",
            description: "雨夜 close-up portrait，黑色风衣，电影感人物参考。",
            isAIGenerated: false,
            source: "manual",
          },
        ],
        sceneSettings: [],
      },
    } as StudioRuntimeState;

    const summary = buildMediaContentSummary({
      action: "generate_video_reference_assets",
      promptText: "叶灵汐",
      runtime,
    });

    expect(summary).toContain("角色 叶灵汐");
    expect(summary).toContain("视图 特写");
    expect(summary).toContain("变体 雨夜");
  });
});
