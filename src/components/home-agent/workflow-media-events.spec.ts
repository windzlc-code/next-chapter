import { describe, expect, it, vi } from "vitest";
import type { StudioRuntimeState } from "@/lib/home-agent/types";
import {
  dispatchWorkflowMediaEvents,
  dispatchWorkflowMediaStartEvent,
} from "./workflow-media-events";

function createRuntime(): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: null,
    currentDramaProject: null,
    currentVideoProject: {
      id: "video-project-1",
      title: "Video Project",
      script: "script",
      targetPlatform: "",
      shotStyle: "",
      outputGoal: "",
      productionNotes: "",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          description: "Scene 1 desc",
          characters: [],
          setting: "",
          beat: "",
          cameraDirection: "",
          dialogue: "",
        },
      ],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 4,
      systemPrompt: "",
      analysisSummary: "",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: null,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
      productionStateBundle: null,
      videoGenerationPrefs: {
        modelKey: "seedance-1-5-pro",
        mode: "text-to-video",
        provider: "replicate",
        resolution: "720p",
      },
    },
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "",
  };
}

describe("workflow media video events", () => {
  it("includes mediaEventId on batch video completion events", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    dispatchWorkflowMediaEvents({
      videoUrls: ["https://example.com/video-1.mp4"],
      mediaEventId: "media:video-batch-1",
      videoDetail: {
        action: "generate_video_assets",
        count: 1,
      },
    });

    const event = dispatchEventSpy.mock.calls
      .map(([nextEvent]) => nextEvent)
      .find((nextEvent) => nextEvent?.type === "agent:video-generated") as CustomEvent | undefined;

    expect(event?.detail?.mediaEventId).toBe("media:video-batch-1");

    dispatchEventSpy.mockRestore();
  });

  it("includes mediaEventId on video start events", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    dispatchWorkflowMediaStartEvent({
      action: "generate_video_assets",
      input: {
        mediaEventId: "media:video-batch-2",
        targetIds: ["scene-1"],
        selectedVideoModelKey: "seedance-1-5-pro",
        videoGenerationPrefs: {
          modelKey: "seedance-1-5-pro",
          mode: "text-to-video",
          provider: "replicate",
          resolution: "720p",
        },
      },
      runtime: createRuntime(),
    });

    const event = dispatchEventSpy.mock.calls
      .map(([nextEvent]) => nextEvent)
      .find((nextEvent) => nextEvent?.type === "agent:video-generating-start") as CustomEvent | undefined;

    expect(event?.detail?.mediaEventId).toBe("media:video-batch-2");

    dispatchEventSpy.mockRestore();
  });

  it("includes mediaEventId on segment-video start events", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    dispatchWorkflowMediaStartEvent({
      action: "generate_segment_video",
      input: {
        mediaEventId: "media:segment-batch-1",
        targetSegmentLabels: ["1-1", "1-2"],
        selectedVideoModelKey: "seedance-1-5-pro",
        videoGenerationPrefs: {
          modelKey: "seedance-1-5-pro",
          mode: "text-to-video",
          provider: "replicate",
          resolution: "720p",
        },
      },
      runtime: createRuntime(),
    });

    const event = dispatchEventSpy.mock.calls
      .map(([nextEvent]) => nextEvent)
      .find((nextEvent) => nextEvent?.type === "agent:video-generating-start") as CustomEvent | undefined;

    expect(event?.detail?.mediaEventId).toBe("media:segment-batch-1");

    dispatchEventSpy.mockRestore();
  });

  it("adds the current multi-reference image-to-video route hint to video start events", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");
    const runtime = createRuntime();
    runtime.currentVideoProject!.scenes[0].storyboardUrl = "https://media.storyforge.test/storyboard-seed-1.jpg";
    runtime.currentVideoProject!.characters = [
      {
        id: "char-1",
        name: "Hero",
        description: "lead",
        imageUrl: "https://media.storyforge.test/hero-seed-1.jpg",
        isAIGenerated: false,
        source: "manual",
      },
    ];

    dispatchWorkflowMediaStartEvent({
      action: "generate_video_assets",
      input: {
        targetIds: ["scene-1"],
        selectedVideoModelKey: "doubao-seedance-2-0-fast-260128",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-fast-260128",
          mode: "image-to-video",
          provider: "jimeng",
          resolution: "720p",
        },
      },
      runtime,
    });

    const event = dispatchEventSpy.mock.calls
      .map(([nextEvent]) => nextEvent)
      .find((nextEvent) => nextEvent?.type === "agent:video-generating-start") as CustomEvent | undefined;

    expect(event?.detail?.routeHint).toBe("多图参考图生");

    dispatchEventSpy.mockRestore();
  });

  it("adds the current multi-reference text-to-video route hint to segment-video start events", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");
    const runtime = createRuntime();
    runtime.currentVideoProject!.scenes[0].segmentLabel = "1-1";
    runtime.currentVideoProject!.characters = [
      {
        id: "char-1",
        name: "Hero",
        description: "lead",
        imageUrl: "https://example.com/hero.jpg",
        isAIGenerated: false,
        source: "manual",
      },
    ];
    runtime.currentVideoProject!.sceneSettings = [
      {
        id: "scene-setting-1",
        name: "Warehouse",
        description: "night",
        imageUrl: "https://example.com/warehouse.jpg",
        isAIGenerated: false,
        source: "manual",
      },
    ];

    dispatchWorkflowMediaStartEvent({
      action: "generate_segment_video",
      input: {
        targetSegmentLabels: ["1-1"],
        selectedVideoModelKey: "doubao-seedance-2-0-260128",
        videoGenerationPrefs: {
          modelKey: "doubao-seedance-2-0-260128",
          mode: "text-to-video",
          provider: "jimeng",
          resolution: "720p",
        },
      },
      runtime,
    });

    const event = dispatchEventSpy.mock.calls
      .map(([nextEvent]) => nextEvent)
      .find((nextEvent) => nextEvent?.type === "agent:video-generating-start") as CustomEvent | undefined;

    expect(event?.detail?.routeHint).toBe("多图参考文生");

    dispatchEventSpy.mockRestore();
  });
});
