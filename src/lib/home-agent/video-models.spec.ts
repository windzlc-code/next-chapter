import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  getHomeAgentVideoGenerationBatchLimit,
  getHomeAgentVideoGenerationConcurrencyLimit,
  getVideoModelMinDuration,
  getVideoModelMaxDuration,
  listHomeAgentVideoModels,
  listHomeAgentVideoAspectRatios,
  listHomeAgentVideoResolutions,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationAspectRatio,
  normalizeVideoGenerationPrefs,
  normalizeVideoGenerationResolution,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
  videoModelSupportsAspectRatio,
  videoModelSupportsDirectReferenceImage,
  videoModelSupportsMultiReferenceImages,
  videoModelSupportsRunningHubFallback,
  videoModelRequiresRunningHubTransport,
  videoModelSupportsResolution,
} from "./video-models";

describe("home-agent video models", () => {
  it("uses Seedance 1.5 Pro 720p text-to-video as the default video preference", () => {
    expect(DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
      mode: "text-to-video",
    });
  });

  it("exposes Seedance and HappyHorse in the same homepage model list while keeping one visible HappyHorse entry", () => {
    expect(listHomeAgentVideoModels()).toEqual([
      expect.objectContaining({
        key: "doubao-seedance-1-5-pro",
        label: "seedance-1-5-pro",
        provider: "jimeng",
        maxVideosPerRun: 3,
        maxConcurrentGenerations: 3,
      }),
      expect.objectContaining({
        key: "doubao-seedance-2-0-260128",
        label: "seedance-2.0",
        provider: "jimeng",
        maxVideosPerRun: 3,
        maxConcurrentGenerations: 3,
      }),
      expect.objectContaining({
        key: "doubao-seedance-2-0-fast-260128",
        label: "seedance-2.0-fast",
        provider: "jimeng",
        maxVideosPerRun: 3,
        maxConcurrentGenerations: 3,
      }),
      expect.objectContaining({
        key: "happyhorse-1.0",
        label: "HappyHorse-1.0",
        provider: "aliyun",
        maxVideosPerRun: 3,
        maxConcurrentGenerations: 3,
      }),
    ]);
  });

  it("derives the video smart-batch and concurrency limits from the selected model while keeping the global cap at 3", () => {
    expect(getHomeAgentVideoGenerationBatchLimit()).toBe(3);
    expect(getHomeAgentVideoGenerationConcurrencyLimit()).toBe(3);
    expect(
      getHomeAgentVideoGenerationBatchLimit({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "1080p",
        mode: "text-to-video",
      }),
    ).toBe(3);
    expect(
      getHomeAgentVideoGenerationConcurrencyLimit({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "1080p",
        mode: "text-to-video",
      }),
    ).toBe(3);
    expect(
      getHomeAgentVideoGenerationBatchLimit({
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        mode: "image-to-video",
      }),
    ).toBe(3);
    expect(
      getHomeAgentVideoGenerationConcurrencyLimit({
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        mode: "image-to-video",
      }),
    ).toBe(3);
    expect(
      getHomeAgentVideoGenerationBatchLimit({
        modelKey: "happyhorse-1.0",
        resolution: "1080p",
        mode: "text-to-video",
      }),
    ).toBe(3);
    expect(
      getHomeAgentVideoGenerationConcurrencyLimit({
        modelKey: "happyhorse-1.0",
        resolution: "1080p",
        mode: "text-to-video",
      }),
    ).toBe(3);
  });

  it("normalizes invalid model and resolution values back to defaults", () => {
    expect(normalizeHomeAgentVideoModelKey("unknown-model")).toBe("doubao-seedance-1-5-pro");
    expect(normalizeVideoGenerationResolution("8k")).toBe("720p");
    expect(normalizeVideoGenerationPrefs({ modelKey: "unknown-model" as never, resolution: "8k" as never })).toEqual({
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "720p",
      mode: "text-to-video",
    });
  });

  it("normalizes legacy Seedance 2.0 aliases into the official Ark model ids", () => {
    expect(normalizeHomeAgentVideoModelKey("seedance2.0")).toBe("doubao-seedance-2-0-260128");
    expect(normalizeHomeAgentVideoModelKey("seedance-2.0")).toBe("doubao-seedance-2-0-260128");
    expect(normalizeHomeAgentVideoModelKey("seedance2.0fast")).toBe("doubao-seedance-2-0-fast-260128");
    expect(normalizeHomeAgentVideoModelKey("seedance-2.0-fast")).toBe("doubao-seedance-2-0-fast-260128");
  });

  it("normalizes HappyHorse hidden model ids back to the single visible homepage model key", () => {
    expect(normalizeHomeAgentVideoModelKey("happyhorse-1.0")).toBe("happyhorse-1.0");
    expect(normalizeHomeAgentVideoModelKey("happyhorse_1_0")).toBe("happyhorse-1.0");
    expect(normalizeHomeAgentVideoModelKey("happyhorse-1.0-t2v")).toBe("happyhorse-1.0");
    expect(normalizeHomeAgentVideoModelKey("happyhorse-1.0-i2v")).toBe("happyhorse-1.0");
    expect(normalizeHomeAgentVideoModelKey("happyhorse-1.0-r2v")).toBe("happyhorse-1.0");
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
      resolution: "720p",
      mode: "text-to-video",
    });
  });

  it("matches the official Seedance 2.0 resolution matrix and blocks 1080p on Seedance 2.0 Fast", () => {
    expect(videoModelSupportsResolution("doubao-seedance-2-0-260128", "480p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-260128", "720p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-260128", "1080p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-260128", "2k")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-260128", "4k")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-fast-260128", "480p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-fast-260128", "720p")).toBe(true);
    expect(videoModelSupportsResolution("doubao-seedance-2-0-fast-260128", "1080p")).toBe(false);
    expect(
      normalizeVideoGenerationPrefs({
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "1080p",
      }),
    ).toEqual({
      modelKey: "doubao-seedance-2-0-fast-260128",
      resolution: "720p",
      mode: "text-to-video",
    });
  });

  it("marks which visible models can use the RunningHub fallback and when direct RunningHub transport is required", () => {
    expect(videoModelSupportsRunningHubFallback("doubao-seedance-1-5-pro")).toBe(false);
    expect(videoModelSupportsRunningHubFallback("doubao-seedance-2-0-260128")).toBe(true);
    expect(videoModelSupportsRunningHubFallback("doubao-seedance-2-0-fast-260128")).toBe(true);
    expect(videoModelSupportsRunningHubFallback("happyhorse-1.0")).toBe(true);

    expect(
      videoModelRequiresRunningHubTransport({
        modelKey: "doubao-seedance-2-0-260128",
        resolution: "2k",
        mode: "text-to-video",
      }),
    ).toBe(true);
    expect(
      videoModelRequiresRunningHubTransport({
        modelKey: "doubao-seedance-2-0-260128",
        resolution: "4k",
        mode: "image-to-video",
      }),
    ).toBe(true);
    expect(
      videoModelRequiresRunningHubTransport({
        modelKey: "doubao-seedance-2-0-260128",
        resolution: "1080p",
        mode: "text-to-video",
      }),
    ).toBe(false);
    expect(
      videoModelRequiresRunningHubTransport({
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        mode: "text-to-video",
      }),
    ).toBe(false);
  });

  it("limits HappyHorse to the documented 720p and 1080p output tiers", () => {
    expect(videoModelSupportsResolution("happyhorse-1.0", "720p")).toBe(true);
    expect(videoModelSupportsResolution("happyhorse-1.0", "1080p")).toBe(true);
    expect(videoModelSupportsResolution("happyhorse-1.0", "480p")).toBe(false);
    expect(
      normalizeVideoGenerationPrefs({
        modelKey: "happyhorse-1.0",
        resolution: "480p",
      }),
    ).toEqual({
      modelKey: "happyhorse-1.0",
      resolution: "720p",
      mode: "text-to-video",
    });
  });

  it("exposes only the shared panel aspect ratios and normalizes them per video model", () => {
    expect(listHomeAgentVideoAspectRatios()).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "4:5",
      "5:4",
      "21:9",
    ]);
    expect(normalizeVideoGenerationAspectRatio("21:9")).toBe("21:9");
    expect(videoModelSupportsAspectRatio("doubao-seedance-1-5-pro", "4:3")).toBe(true);
    expect(videoModelSupportsAspectRatio("doubao-seedance-1-5-pro", "21:9")).toBe(true);
    expect(videoModelSupportsAspectRatio("doubao-seedance-1-5-pro", "5:4")).toBe(false);
    expect(videoModelSupportsAspectRatio("happyhorse-1.0", "5:4")).toBe(true);
    expect(
      normalizeVideoGenerationPrefs({
        modelKey: "happyhorse-1.0",
        aspectRatio: "5:4",
      }),
    ).toEqual({
      modelKey: "happyhorse-1.0",
      resolution: "720p",
      mode: "text-to-video",
      aspectRatio: "5:4",
    });
    expect(
      normalizeVideoGenerationPrefs({
        modelKey: "doubao-seedance-2-0-260128",
        aspectRatio: "5:4",
      }),
    ).toEqual({
      modelKey: "doubao-seedance-2-0-260128",
      resolution: "720p",
      mode: "text-to-video",
      aspectRatio: "16:9",
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

  it("submits Seedance 2.0 family models as their official Ark model ids", () => {
    expect(
      resolveVideoGenerationModelName({
        modelKey: "doubao-seedance-2-0-260128",
        resolution: "1080p",
      }),
    ).toBe("doubao-seedance-2-0-260128");
    expect(
      resolveVideoGenerationModelName({
        modelKey: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
      }),
    ).toBe("doubao-seedance-2-0-fast-260128");
  });

  it("routes the default video model through the Jimeng Seedance provider", () => {
    expect(resolveVideoGenerationProvider(DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS)).toBe("jimeng");
  });

  it("routes HappyHorse through the Aliyun provider while keeping one frontend model alias", () => {
    expect(
      resolveVideoGenerationProvider({
        modelKey: "happyhorse-1.0",
        resolution: "720p",
        mode: "image-to-video",
      }),
    ).toBe("aliyun");
    expect(
      resolveVideoGenerationModelName({
        modelKey: "happyhorse-1.0",
        resolution: "1080p",
        mode: "image-to-video",
      }),
    ).toBe("happyhorse-1.0");
  });

  it("allows Seedance 1.5 Pro to accept a direct reference image when image-to-video is selected", () => {
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-1-5-pro")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-1-5-pro_1080p")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("seedance-1-5-pro")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-2-0-260128")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("doubao-seedance-2-0-fast-260128")).toBe(true);
    expect(videoModelSupportsDirectReferenceImage("happyhorse-1.0")).toBe(true);
  });

  it("limits multi-reference video routing to Seedance 2.0 family and HappyHorse", () => {
    expect(videoModelSupportsMultiReferenceImages("doubao-seedance-1-5-pro")).toBe(false);
    expect(videoModelSupportsMultiReferenceImages("doubao-seedance-1-5-pro_1080p")).toBe(false);
    expect(videoModelSupportsMultiReferenceImages("doubao-seedance-2-0-260128")).toBe(true);
    expect(videoModelSupportsMultiReferenceImages("doubao-seedance-2-0-fast-260128")).toBe(true);
    expect(videoModelSupportsMultiReferenceImages("happyhorse-1.0")).toBe(true);
  });

  it("treats 5 seconds as the supported minimum duration for Seedance 1.5 Pro", () => {
    expect(getVideoModelMinDuration("doubao-seedance-1-5-pro")).toBe(5);
    expect(getVideoModelMinDuration("doubao-seedance-1-5-pro_480p")).toBe(5);
  });

  it("uses the official 4 to 15 second duration window for Seedance 2.0 family models", () => {
    expect(getVideoModelMinDuration("doubao-seedance-2-0-260128")).toBe(4);
    expect(getVideoModelMaxDuration("doubao-seedance-2-0-260128")).toBe(15);
    expect(getVideoModelMinDuration("doubao-seedance-2-0-fast-260128")).toBe(4);
    expect(getVideoModelMaxDuration("doubao-seedance-2-0-fast-260128")).toBe(15);
  });

  it("uses the official 3 to 15 second duration window for HappyHorse", () => {
    expect(getVideoModelMinDuration("happyhorse-1.0")).toBe(3);
    expect(getVideoModelMaxDuration("happyhorse-1.0")).toBe(15);
  });
});
