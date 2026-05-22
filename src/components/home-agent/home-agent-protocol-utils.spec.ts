import { stripHiddenThoughtBlocks, textOf } from "./home-agent-protocol-utils";

describe("home-agent protocol text sanitization", () => {
  it("removes think blocks from assistant text", () => {
    expect(
      stripHiddenThoughtBlocks([
        "<think>",
        "Initiating Plan Generation",
        "Internal reasoning",
        "</think>",
        "",
        "创作方案：豪门婚恋（40集）",
      ].join("\n")),
    ).toBe("创作方案：豪门婚恋（40集）");
  });

  it("sanitizes visible text when extracting text blocks", () => {
    const content = [
      {
        type: "text",
        text: "<think>\nHidden chain\n</think>\n\n可见结论",
      },
      {
        type: "thinking",
        thinking: "Should already be ignored",
      },
    ];

    expect(textOf(content)).toBe("可见结论");
  });

  it("removes unterminated tool-call payloads before they leak parameter text", () => {
    expect(
      stripHiddenThoughtBlocks([
        "好的，继续处理。",
        "<function_calls>",
        "<invoke name=\"HomeStudioWorkflow\">",
        "<parameter name=\"imagePrompt\">A 25-year-old female office worker, gentle and kind personality, professional business att",
      ].join("\n")),
    ).toBe("好的，继续处理。");
  });
});
