import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  listHomeAgentVideoModels,
  listHomeAgentVideoResolutions,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
  normalizeVideoGenerationResolution,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
  videoModelSupportsDirectReferenceImage,
  videoModelSupportsResolution,
} from "./video-models";

describe("home-agent video models", () => {
  it("uses Seedance 1.5 Pro 480p text-to-video as the default video preference", () => {
    expect(DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "480p",
      mode: "text-to-video",
    });
  });

  it("exposes the frontend Seedance label while keeping the Tuzi model key", () => {
    expect(listHomeAgentVideoModels()).toEqual([
      expect.objectContaining({
        key: "doubao-seedance-1-5-pro",
        label: "seedance-1-5-pro",
        provider: "jimeng",
      }),
    ]);
  });

  it("normalizes invalid model and resolution values back to defaults", () => {
    expect(normalizeHomeAgentVideoModelKey("unknown-model")).toBe("doubao-seedance-1-5-pro");
    expect(normalizeVideoGenerationResolution("8k")).toBe("480p");
    expect(normalizeVideoGenerationPrefs({ modelKey: "unknown-model" as never, resolution: "8k" as never })).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "480p",
      mode: "text-to-video",
    });
  });

  it("exposes 2K and 4K video placeholders while keeping them unsupported for Seedance 1.5 Pro", () => {
    expect(listHomeAgentVideoResolutions().map((option) => option.value)).toEqual([
      "480p",
      "720p",
      "1080p",
      "2k",
      "4k",
    ]);
    expect(normalizeVideoGenerationResolution("4k")).toBe("4k");
    expect(videoModelSupportsResolution("doubao-seedance-1-5-pro", "1080p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-1-5-pro", "2k")).toBe(false);
    expect(videoModelSupportsResolution("doubao-seedance-1-5-pro", "4k")).toBe(false);
    expect(
      normalizeVideoGenerationPrefs({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "4k",
      }),
    ).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "480p",
      mode: "text-to-video",
    });
  });

  it("resolves doubao-seedance-1-5-pro plus 720p into the submitted model name", () => {
    expect(
      resolveVideoGenerationModelName({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
      }),
    ).toBe("doubao-seedance-1-5-pro_720p");
  });

  it("routes the default video model through the Jimeng Seedance provider", () => {
    expect(resolveVideoGenerationProvider(DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS)).toBe("jimeng");
  });

  it("allows Seedance 1.5 Pro to accept a direct reference image when image-to-video is selected", () => {
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-1-5-pro")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-1-5-pro_1080p")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("seedance-1-5-pro")).toBe(true);
  });
});
