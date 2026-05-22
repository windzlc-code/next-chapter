import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGemini, extractText, fetchImageAsBase64 } from "@/lib/gemini-client";
import { analyzeReferenceImageQuality } from "./image-reference-quality-analysis";

vi.mock("@/lib/gemini-client", () => ({
  callGemini: vi.fn(),
  extractText: vi.fn(),
  fetchImageAsBase64: vi.fn(),
}));

describe("reference image quality analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchImageAsBase64).mockResolvedValue({
      data: "IMAGE_BASE64",
      mimeType: "image/jpeg",
    });
    vi.mocked(callGemini).mockResolvedValue({ mocked: true });
  });

  it("adds the accidental duplicate-people rejection rule to character reference QA prompts", async () => {
    vi.mocked(extractText).mockReturnValue(
      JSON.stringify({
        summary: "通过",
        overallScore: 90,
        identityScore: 90,
        visualScore: 90,
        consistencyScore: 90,
        unintendedDuplicatePeopleVisible: false,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        qualityTier: "usable",
        strengths: [],
        goldenSignals: [],
        fixPriorities: [],
        issues: [],
      }),
    );

    await analyzeReferenceImageQuality({
      imageUrl: "https://media.storyforge.test/duo.jpg",
      mode: "character",
      name: "执法双人组",
      description: "双人角色设定，同框站立，两个角色都要可区分。",
    });

    const prompt = String((vi.mocked(callGemini).mock.calls[0]?.[1]?.[0] as any)?.parts?.[0]?.text || "");
    expect(prompt).toContain('"unintendedDuplicatePeopleVisible": false');
    expect(prompt).toContain("two-person or multi-person composition");
    expect(prompt).toContain("accidental cloned copies of the same character");
  });

  it("adds the explicit-request exception for twins or clones to the reference-image QA prompt", async () => {
    vi.mocked(extractText).mockReturnValue(
      JSON.stringify({
        summary: "通过",
        overallScore: 90,
        identityScore: 90,
        visualScore: 90,
        consistencyScore: 90,
        unintendedDuplicatePeopleVisible: false,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        qualityTier: "usable",
        strengths: [],
        goldenSignals: [],
        fixPriorities: [],
        issues: [],
      }),
    );

    await analyzeReferenceImageQuality({
      imageUrl: "https://media.storyforge.test/twins.jpg",
      mode: "character",
      name: "双胞胎护卫",
      description: "一对双胞胎护卫，需要同脸同装地同框出现。",
    });

    const prompt = String((vi.mocked(callGemini).mock.calls[0]?.[1]?.[0] as any)?.parts?.[0]?.text || "");
    expect(prompt).toContain("explicitly allows identical-looking people");
    expect(prompt).not.toContain("two-person or multi-person composition");
  });

  it("parses unintended duplicate people as a blocking QA result", async () => {
    vi.mocked(extractText).mockReturnValue(
      JSON.stringify({
        summary: "双人角色被画成了复制体。",
        overallScore: 92,
        identityScore: 91,
        visualScore: 89,
        consistencyScore: 90,
        unintendedDuplicatePeopleVisible: true,
        textPollutionVisible: false,
        watermarkVisible: false,
        deliverableReady: true,
        qualityTier: "golden",
        strengths: ["构图完整"],
        goldenSignals: ["角色主体完整入镜"],
        fixPriorities: ["区分两个人的面部和服装细节"],
        issues: [],
      }),
    );

    const report = await analyzeReferenceImageQuality({
      imageUrl: "https://media.storyforge.test/clone-duo.jpg",
      mode: "character",
      name: "执法双人组",
      description: "双人角色设定，同框站立。",
    });

    expect(report).toMatchObject({
      unintendedDuplicatePeopleVisible: true,
      deliverableReady: false,
      qualityTier: "fail",
    });
    expect(report?.issues).toContain("图中出现未被需求明确允许的重复同脸人物。");
  });
});
