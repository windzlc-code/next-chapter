import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  buildLegacyVideoImageStylePrefs,
  listHomeAgentImageAspectRatios,
  listHomeAgentImageModelFamilies,
  normalizeHomeAgentImageModelFamilyKey,
  resolveVideoImagePromptStyle,
  resolveLegacyVideoImageModelPrefs,
  resolveVideoImageGenerationPrefs,
  resolveVideoImageRequestPrefs,
} from "./image-models";

describe("home-agent image models", () => {
  it("uses gpt-image-2 1K wide as the default video image preference", () => {
    expect(DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS).toEqual({
      familyKey: "gpt-image-2",
      resolution: "default",
      aspectRatio: "16:9",
      styleCategory: "realistic",
      stylePreset: "live-action",
      viewMode: "three",
    });
  });

  it("normalizes the legacy ano banana typo to nano banana", () => {
    expect(normalizeHomeAgentImageModelFamilyKey("ano-banana-pro")).toBe("nano-banana-pro");
    expect(resolveLegacyVideoImageModelPrefs("ano-banana-pro")).toEqual({
      familyKey: "nano-banana-pro",
    });
  });

  it("exposes production and async nano banana 2 as separate frontend options", () => {
    expect(listHomeAgentImageModelFamilies().map((option) => option.label)).toEqual([
      "nano-banana-pro",
      "nano-banana 2",
      "nano-banana 2-async",
      "gpt-image-2",
    ]);
  });

  it("maps nano banana 2 production prefs to the sync image generation endpoint model", () => {
    const resolved = resolveVideoImageGenerationPrefs({
      familyKey: "nano-banana-2",
      resolution: "4k",
      aspectRatio: "3:2",
    });

    expect(resolved.resolvedModel).toBe("gemini-3-pro-image-preview-4k");
    expect(resolved.transportModel).toBe("gemini-3-pro-image-preview-4k");
    expect(resolved.fallbackModel).toBe("gemini-3-pro-image-preview-4k");
    expect(resolved.successFamily).toBe("nano-banana-2");
    expect(resolved.providerAspectRatio).toBe("3:2");
    expect(resolved.providerImageSize).toBe("4K");
    expect(resolved.usesAsyncTransport).toBe(false);
    expect(resolved.usesImageGenerationsEndpoint).toBe(true);
  });

  it("maps nano banana 2 async prefs to the async transport sibling", () => {
    const resolved = resolveVideoImageGenerationPrefs({
      familyKey: "nano-banana-2-async",
      resolution: "2k",
      aspectRatio: "2:3",
    });

    expect(resolved.resolvedModel).toBe("gemini-3-pro-image-preview-2k");
    expect(resolved.transportModel).toBe("gemini-3-pro-image-preview-2k-async");
    expect(resolved.fallbackModel).toBe("gemini-3-pro-image-preview-2k");
    expect(resolved.successFamily).toBe("nano-banana-2-async");
    expect(resolved.usesAsyncTransport).toBe(true);
    expect(resolved.usesImageGenerationsEndpoint).toBe(true);
  });

  it("maps gpt-image-2 prefs to the sync image generation endpoint model", () => {
    const resolved = resolveVideoImageGenerationPrefs({
      familyKey: "gpt-image-2",
      resolution: "4k",
      aspectRatio: "1:1",
    });

    expect(resolved.resolvedModel).toBe("gpt-image-2");
    expect(resolved.transportModel).toBe("gpt-image-2");
    expect(resolved.fallbackModel).toBe("gpt-image-2");
    expect(resolved.successFamily).toBe("gpt-image-2");
    expect(resolved.providerAspectRatio).toBe("1:1");
    expect(resolved.providerImageSize).toBe("4K");
    expect(resolved.usesAsyncTransport).toBe(false);
    expect(resolved.usesImageGenerationsEndpoint).toBe(true);
  });

  it("resolves request prefs from legacy model keys while preserving explicit overrides", () => {
    const resolved = resolveVideoImageRequestPrefs({
      model: "gemini-3-pro-image-preview-2k-async",
      aspectRatio: "2:3",
    });

    expect(resolved.prefs).toEqual({
      familyKey: "nano-banana-2-async",
      resolution: "2k",
      aspectRatio: "2:3",
      styleCategory: "realistic",
      stylePreset: "live-action",
      viewMode: "three",
    });
    expect(resolved.resolvedModel).toBe("gemini-3-pro-image-preview-2k");
    expect(resolved.transportModel).toBe("gemini-3-pro-image-preview-2k-async");
  });

  it("supports the added 2:3 and 3:2 aspect ratios for the shared home-agent picker", () => {
    expect(listHomeAgentImageAspectRatios()).toEqual(
      expect.arrayContaining(["16:9", "9:16", "1:1", "2:3", "3:2"]),
    );
  });

  it("maps legacy art styles into the new style preference shape", () => {
    expect(buildLegacyVideoImageStylePrefs("retro-comic")).toEqual({
      styleCategory: "animation-2d",
      stylePreset: "retro-comic",
    });
  });

  it("resolves custom style prompts into the generation style token", () => {
    expect(
      resolveVideoImagePromptStyle({
        styleCategory: "custom",
        stylePreset: "custom",
        customStylePrompt: "low saturation filmic realism with rainy neon reflections",
      }),
    ).toBe("custom:low saturation filmic realism with rainy neon reflections");
  });
});
