import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGemini, extractText } from "@/lib/gemini-client";
import {
  analyzeHomeAgentImageStyleFiles,
  buildHomeAgentImageAnalysisContext,
  buildImagePrefsPatchFromRecognition,
  isSupportedImageFile,
} from "./image-style-analysis";

vi.mock("@/lib/gemini-client", () => ({
  callGemini: vi.fn(),
  extractText: vi.fn(),
}));

vi.mock("@/lib/image-compress", () => ({
  compressImage: vi.fn(async (value: string) => value),
}));

describe("image style analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects supported image files from mime types and file extensions", () => {
    expect(isSupportedImageFile(new File(["a"], "reference.png", { type: "image/png" }))).toBe(true);
    expect(isSupportedImageFile(new File(["a"], "reference.jpg", { type: "" }))).toBe(true);
    expect(isSupportedImageFile(new File(["a"], "notes.txt", { type: "text/plain" }))).toBe(false);
  });

  it("parses multimodal recognition results into normalized style prefs", async () => {
    vi.mocked(callGemini).mockResolvedValue({ mocked: true });
    vi.mocked(extractText).mockReturnValue(
      JSON.stringify({
        styleCategory: "animation-3d",
        stylePreset: "anime-3d",
        customStylePrompt: "",
        summary: "整体是三渲二动漫镜头语言，角色和材质都偏动画电影渲染。",
        confidence: 0.91,
        reasons: ["角色轮廓线明显", "材质和光影保持动漫化处理"],
        imageSummaries: [
          {
            fileName: "reference.png",
            summary: "人物面部和材质都呈现明显三渲二特征。",
            stylePreset: "anime-3d",
            confidence: 0.91,
          },
        ],
      }),
    );

    const result = await analyzeHomeAgentImageStyleFiles(
      [new File(["image"], "reference.png", { type: "image/png" })],
      { userPrompt: "请识别这张参考图的风格。" },
    );

    expect(callGemini).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      styleCategory: "animation-3d",
      stylePreset: "anime-3d",
      confidence: 0.91,
    });
    expect(buildImagePrefsPatchFromRecognition(result)).toEqual({
      styleCategory: "animation-3d",
      stylePreset: "anime-3d",
    });
    expect(buildHomeAgentImageAnalysisContext(result)).toContain("三维动画类");
    expect(buildHomeAgentImageAnalysisContext(result)).toContain("三渲二动漫");
  });
});
