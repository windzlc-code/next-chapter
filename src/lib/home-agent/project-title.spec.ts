import { describe, expect, it } from "vitest";
import { buildAutoSessionProjectTitle, extractAssistantProjectTitle } from "./project-title";

describe("buildAutoSessionProjectTitle", () => {
  it("derives a concise initial title from a fresh request", () => {
    const result = buildAutoSessionProjectTitle("帮我起草一个新故事");

    expect(result).toBe("新故事");
  });

  it("keeps the actual subject phrase instead of the request verb", () => {
    const result = buildAutoSessionProjectTitle("我想做一个都市悬疑短剧，节奏要更快一点");

    expect(result).toBe("都市悬疑短剧");
  });

  it("falls back when the input is only a vague control command", () => {
    const result = buildAutoSessionProjectTitle("继续执行");

    expect(result).toBe("新会话项目");
  });
});

describe("extractAssistantProjectTitle", () => {
  it("extracts a tentative title on the next line", () => {
    const result = extractAssistantProjectTitle(`
- 暂定项目名称：
  《食光深处的告白》
`);

    expect(result).toBe("食光深处的告白");
  });

  it("extracts a renamed title from an inline sentence", () => {
    const result = extractAssistantProjectTitle(
      "这一版我建议把项目名更新为《雾港来信》，更贴近悬疑和情绪拉扯。",
    );

    expect(result).toBe("雾港来信");
  });

  it("returns null when no explicit naming cue exists", () => {
    const result = extractAssistantProjectTitle("当前阶段先继续完善角色关系和冲突，不急着定标题。");
    expect(result).toBeNull();
  });
});
