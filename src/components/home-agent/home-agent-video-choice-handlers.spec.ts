import { describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot } from "@/lib/home-agent/types";
import {
  buildScriptAnalyzeDurationQuestion,
  buildVideoUploadScriptFollowupQuestion,
  createVideoAssetChoiceHandler,
  createVideoProjectChoiceHandler,
} from "./home-agent-video-choice-handlers";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "\u6d4b\u8bd5\u89c6\u9891\u9879\u76ee",
    currentObjective: "\u5b8c\u6210\u811a\u672c\u62c6\u89e3",
    derivedStage: "\u811a\u672c\u62c6\u89e3",
    agentSummary: "summary",
    recommendedActions: ["Complete first-pass breakdown"],
    artifacts: [],
    ...overrides,
  };
}

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "\u6d4b\u8bd5\u89c6\u9891\u9879\u76ee",
    script: "script body",
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 1,
    systemPrompt: "",
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

type QuestionTreeNode = {
  value?: string;
  label?: string;
  children?: QuestionTreeNode[];
};

function listQuestionValues(question: { options?: QuestionTreeNode[] } | null | undefined): string[] {
  if (!question) return [];
  const values: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    if (typeof option.value === "string") {
      values.push(option.value);
    }
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return values;
}

function listQuestionLabels(question: { options?: QuestionTreeNode[] } | null | undefined): string[] {
  if (!question) return [];
  const labels: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    if (typeof option.label === "string") {
      labels.push(option.label);
    }
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return labels;
}

describe("buildVideoUploadScriptFollowupQuestion", () => {
  it("returns the entity extraction card when an uploaded script lands in the analyze stage", () => {
    const snapshot = createSnapshot();

    const question = buildVideoUploadScriptFollowupQuestion(snapshot);

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toEqual(["video:bridge:entities"]);
  });

  it("still keeps the flow on entity extraction even after bridge fields are written", () => {
    const snapshot = createSnapshot();
    const question = buildVideoUploadScriptFollowupQuestion(
      snapshot,
      createVideoProject({ targetPlatform: "\u6296\u97f3" }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toEqual(["video:bridge:entities"]);
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:target-platform");
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:shot-style");
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:output-goal");
    expect(listQuestionValues(question)).not.toContain("video:bridge:platform");
  });

  it("shows the duration gate only after entities have already been extracted", () => {
    const snapshot = createSnapshot();
    const question = buildVideoUploadScriptFollowupQuestion(
      snapshot,
      createVideoProject({
        currentStep: 2,
        targetPlatform: "\u6296\u97f3",
        shotStyle: "cinematic close-up",
        outputGoal: "teaser",
        characters: [{ id: "char-1", name: "Hero", description: "desc" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Street", description: "desc" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.answerKey).toBe("video-analyze-duration");
    expect(listQuestionValues(question)).toContain("video:bridge:analyze:dur:90");
    expect(listQuestionValues(question)).not.toContain("video:bridge:analyze");
  });

  it("does not override the popover once the video workflow has already moved past script analysis", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });

    expect(buildVideoUploadScriptFollowupQuestion(snapshot)).toBeNull();
  });
  it("routes the separate character asset branch into targeted reference generation", () => {
    const snapshot = createSnapshot({ derivedStage: "bridge-stage" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "" }] as PersistedVideoProject["characters"],
          sceneSettings: [],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-assets:characters", "single-character-assets");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-character:char-1"] },
      "single-character-assets",
    );
  });

  it("routes a single scene asset child into targeted reference generation", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [],
          sceneSettings: [{ id: "setting-1", name: "Warehouse", description: "desc", imageUrl: "" }] as PersistedVideoProject["sceneSettings"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-assets:scene:setting-1", "闂傚倷鐒﹂惇褰掑垂婵犳艾绐楅柟鐗堟緲閸?Warehouse");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-scene:setting-1"] },
      "闂傚倷鐒﹂惇褰掑垂婵犳艾绐楅柟鐗堟緲閸?Warehouse",
    );
  });

  it("routes a single character variant child into targeted variant generation", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [{
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "hero-main.jpg",
            costumes: [{ id: "cost-1", label: "\u6821\u670d", description: "\u84dd\u767d\u6821\u670d", imageUrl: "" }],
          }] as PersistedVideoProject["characters"],
          sceneSettings: [],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-assets:character-variant:char-1:cost-1", "\u6821\u670d");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-character-variant:char-1:cost-1"] },
      "\u6821\u670d",
    );
  });

  it("routes full reference asset batches with main references before variants", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [{
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
            costumes: [{ id: "cost-1", label: "\u6821\u670d", description: "\u84dd\u767d\u6821\u670d", imageUrl: "" }],
          }] as PersistedVideoProject["characters"],
          sceneSettings: [{
            id: "setting-1",
            name: "Warehouse",
            description: "desc",
            imageUrl: "",
            timeVariants: [{ id: "time-1", label: "\u96e8\u591c", description: "\u51b7\u84dd\u591c\u5149", imageUrl: "" }],
          }] as PersistedVideoProject["sceneSettings"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-assets:full", "Batch fill character and scene assets");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      {
        projectId: snapshot.projectId,
        smartBatch: true,
        targetIds: [
          "reference-character:char-1",
          "reference-character-variant:char-1:cost-1",
          "reference-scene:setting-1",
          "reference-scene-variant:setting-1:time-1",
        ],
      },
      "Batch fill character and scene assets",
    );
  });

  it("routes a single storyboard scene child into targeted storyboard generation", () => {
    const snapshot = createSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", storyboardUrl: "done.png" }] as PersistedVideoProject["scenes"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:storyboard-frame:scene:scene-1", "闂傚倸鍊烽悞锕併亹閸愵亞鐭撻柛顐ｆ礀閺嬩線鏌熼幑鎰靛殭缂?Shot 1");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_storyboard_frames",
      { projectId: snapshot.projectId, targetIds: ["scene-1"], forceRegenerate: true },
      "闂傚倸鍊烽悞锕併亹閸愵亞鐭撻柛顐ｆ礀閺嬩線鏌熼幑鎰靛殭缂?Shot 1",
    );
  });

  it("routes storyboard smart-fill into model-aligned smart batches", () => {
    const snapshot = createSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            { id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", characters: ["Hero"], storyboardUrl: "" },
            { id: "scene-2", sceneNumber: 2, sceneName: "Shot 2", characters: ["Hero"], storyboardUrl: "" },
            { id: "scene-3", sceneNumber: 3, sceneName: "Shot 3", characters: ["Hero"], storyboardUrl: "" },
            { id: "scene-4", sceneNumber: 4, sceneName: "Shot 4", characters: ["Hero"], storyboardUrl: "" },
          ] as PersistedVideoProject["scenes"],
          characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
          sceneSettings: [
            { id: "setting-1", name: "Shot 1", description: "desc", imageUrl: "scene-1.png" },
            { id: "setting-2", name: "Shot 2", description: "desc", imageUrl: "scene-2.png" },
            { id: "setting-3", name: "Shot 3", description: "desc", imageUrl: "scene-3.png" },
            { id: "setting-4", name: "Shot 4", description: "desc", imageUrl: "scene-4.png" },
          ] as PersistedVideoProject["sceneSettings"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:storyboard-frames", "闂傚倷绀侀幖顐﹀箠濡偐纾芥慨妯挎硾缁€鍌涗繆椤栨艾鎮戦柛瀣耿閺屾洘寰勯崼婵嗗缂?4/12");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_storyboard_frames",
      {
        projectId: snapshot.projectId,
        smartBatch: true,
        targetIds: ["scene-1", "scene-2", "scene-3", "scene-4"],
      },
      "闂傚倷绀侀幖顐﹀箠濡偐纾芥慨妯挎硾缁€鍌涗繆椤栨艾鎮戦柛瀣耿閺屾洘寰勯崼婵嗗缂?4/12",
    );
  });

  it("routes segment prompt batch and remaining actions into scoped workflow shortcuts", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();
    const handler = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      switchVideoStep: vi.fn(),
    });

    expect(handler(snapshot, "video:bridge:prompts:segment", "Generate segment prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "all" },
      "Generate segment prompts",
    );

    expect(handler(snapshot, "video:bridge:prompts:segment:batch", "Batch segment prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "batch" },
      "Batch segment prompts",
    );

    expect(handler(snapshot, "video:bridge:prompts:segment:all", "Generate all segment prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "all" },
      "Generate all segment prompts",
    );

    expect(handler(snapshot, "video:bridge:prompts:segment:remaining", "闂備浇宕甸崑鐐电矙韫囨稑纾块柣銏㈡暩缁€濠囨煕椤愮姴鍔氱紒鈧崼銉︾厓閻炴稈鈧厖澹曠紓鍌氬€哥粔鐢稿垂閸ф绠栫憸鏂跨暦閸洍鈧箓骞嬪┑鍥ㄦ緫")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "remaining" },
      "闂備浇宕甸崑鐐电矙韫囨稑纾块柣銏㈡暩缁€濠囨煕椤愮姴鍔氱紒鈧崼銉︾厓閻炴稈鈧厖澹曠紓鍌氬€哥粔鐢稿垂閸ф绠栫憸鏂跨暦閸洍鈧箓骞嬪┑鍥ㄦ緫",
    );
    expect(handler(snapshot, "video:bridge:prompts:segment:episode:1", "Episode 1 segment prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "episode", targetEpisode: "1" },
      "Episode 1 segment prompts",
    );
    expect(handler(snapshot, "video:bridge:prompts:segment:label:1-1", "Segment 1-1 prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "single", targetSegmentLabel: "1-1" },
      "Segment 1-1 prompts",
    );
  });

  it("routes the segment batch action into refresh mode after all segment prompts are ready", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();
    const handler = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1" },
            { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2" },
          ] as PersistedVideoProject["scenes"],
          segmentVideoPrompts: {
            "1-1": {
              segmentLabel: "1-1",
              prompt: "prompt 1",
              duration: 15,
              targetDuration: 15,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 15,
              sceneIds: ["scene-1"],
              generatedAt: "2026-01-01T00:00:00.000Z",
            },
            "1-2": {
              segmentLabel: "1-2",
              prompt: "prompt 2",
              duration: 15,
              targetDuration: 15,
              modelKey: "doubao-seedance-1-5-pro",
              maxDurationForModel: 15,
              sceneIds: ["scene-2"],
              generatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      switchVideoStep: vi.fn(),
    });

    expect(handler(snapshot, "video:bridge:prompts:segment:batch", "重新分批生成片段")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "batch-refresh" },
      "重新分批生成片段",
    );
  });

  it("routes shot prompt generation mode children into video prompt batch shortcuts", () => {
    const snapshot = createSnapshot();
    const runWorkflowActionShortcut = vi.fn();
    const handler = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      switchVideoStep: vi.fn(),
    });

    expect(handler(snapshot, "video:bridge:prompts:all", "Batch episode prompts")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_video_prompt_batch",
      { projectId: snapshot.projectId, batchMode: "all" },
      "Batch episode prompts",
    );

    expect(handler(snapshot, "video:bridge:prompts:batch", "Generate segment prompt batch")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_video_prompt_batch",
      { projectId: snapshot.projectId, batchMode: "batch" },
      "Generate segment prompt batch",
    );
  });

  it("routes a segment batch storyboard option into only the enabled scenes in that segment", () => {
    const snapshot = createSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            {
              id: "scene-ready",
              sceneNumber: 1,
              sceneName: "Shot 1",
              segmentLabel: "A",
              characters: ["Hero"],
              storyboardUrl: "",
            },
            {
              id: "scene-blocked",
              sceneNumber: 2,
              sceneName: "Shot 2",
              segmentLabel: "A",
              characters: ["Villain"],
              storyboardUrl: "",
            },
          ] as PersistedVideoProject["scenes"],
          characters: [
            { id: "char-hero", name: "Hero", description: "desc", imageUrl: "hero.png" },
            { id: "char-villain", name: "Villain", description: "desc", imageUrl: "" },
          ] as PersistedVideoProject["characters"],
          sceneSettings: [
            { id: "setting-a", name: "Shot 1", description: "desc", imageUrl: "scene.png" },
            { id: "setting-b", name: "Shot 2", description: "desc", imageUrl: "scene-2.png" },
          ] as PersistedVideoProject["sceneSettings"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:storyboard-frames:segment:A", "Generate segment storyboards");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_storyboard_frames",
      { projectId: snapshot.projectId, targetIds: ["scene-ready"] },
      "Generate segment storyboards",
    );
  });

  it("routes storyboard step switching through continue_video_step", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" });
    const runWorkflowActionShortcut = vi.fn();
    const switchVideoStep = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
      switchVideoStep,
    })(snapshot, "video:step:storyboard", "\u5207\u5230\u300a\u751f\u6210\u5206\u955c\u56fe\u300b\uff08\u7b2c 3/5 \u6b65\uff09");

    expect(handled).toBe(true);
    expect(switchVideoStep).toHaveBeenCalledWith(
      snapshot.projectId,
      3,
      "\u5207\u5230\u300a\u751f\u6210\u5206\u955c\u56fe\u300b\uff08\u7b2c 3/5 \u6b65\uff09",
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("routes video and preview step switching through continue_video_step", () => {
    const snapshot = createSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" });
    const runWorkflowActionShortcut = vi.fn();

    const deps = {
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
      switchVideoStep: vi.fn(),
    };

    expect(createVideoProjectChoiceHandler(deps)(snapshot, "video:step:video", "\u5207\u5230\u300a\u89c6\u9891\u751f\u6210\u300b\uff08\u7b2c 4/5 \u6b65\uff09")).toBe(true);
    expect(createVideoProjectChoiceHandler(deps)(snapshot, "video:step:preview", "\u5207\u5230\u300a\u9884\u89c8\u4e0e\u5bfc\u51fa\u300b\uff08\u7b2c 5/5 \u6b65\uff09")).toBe(true);

    expect(deps.switchVideoStep).toHaveBeenNthCalledWith(
      1,
      snapshot.projectId,
      4,
      "\u5207\u5230\u300a\u89c6\u9891\u751f\u6210\u300b\uff08\u7b2c 4/5 \u6b65\uff09",
    );
    expect(deps.switchVideoStep).toHaveBeenNthCalledWith(
      2,
      snapshot.projectId,
      5,
      "\u5207\u5230\u300a\u9884\u89c8\u4e0e\u5bfc\u51fa\u300b\uff08\u7b2c 5/5 \u6b65\uff09",
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("routes full asset export through the workflow shortcut without rebuilding the popup locally", () => {
    const snapshot = createSnapshot({
      derivedStage: "????????",
      recommendedActions: ["Complete first-pass breakdown"],
    });
    const runWorkflowActionShortcut = vi.fn();
    const videoProject = createVideoProject({
      targetPlatform: "???",
      shotStyle: "????????",
      outputGoal: "?????",
      storyboardPlan: "batch ready",
      scenes: [
        {
          id: "scene-done",
          sceneNumber: 1,
          sceneName: "Done",
          storyboardUrl: "done",
          videoUrl: "done.mp4",
          videoStatus: "completed",
        },
      ] as PersistedVideoProject["scenes"],
    });

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => videoProject,
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:export:all", "??????");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "export_video_asset_bundle",
      { projectId: snapshot.projectId },
      "??????",
    );
  });

  it("shows a placeholder notice for NLE import instead of running workflow", () => {
    const snapshot = createSnapshot({ derivedStage: "濠电姷顣藉Σ鍛村磻閸涱収鐔嗘俊顖氱毞閸嬫挸顫濋悡搴ｄ桓闂佹寧绻勯崑娑㈩敇婵傜骞㈡繛鍡楁湰閻忓啴姊虹涵鍛汗閻炴稏鍎卞嵄闁告稒娼欓崥褰掓煏閸繍妲归柣?" });
    const runWorkflowActionShortcut = vi.fn();
    const showChoiceNotice = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice,
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:export:nle-placeholder", "Import to editor");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(showChoiceNotice).toHaveBeenCalledWith(
      "Import to editor",
      "\u201c\u5bfc\u5165\u5230\u526a\u8f91\u8f6f\u4ef6\u201d\u540e\u7eed\u5b9e\u73b0\uff0c\u5f53\u524d\u53ef\u5148\u4f7f\u7528\u201c\u5168\u90e8\u5bfc\u51fa\u201d\u3002",
    );
  });

});

describe("createVideoAssetChoiceHandler", () => {
  it("routes a grouped segment generate option into targeted video generation", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89c6\u9891\u63d0\u793a\u8bcd" });
    const runWorkflowActionShortcut = vi.fn();
    const runWorkflowActionShortcutChain = vi.fn();

    const handled = createVideoAssetChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            { id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", segmentLabel: "A", storyboardUrl: "shot-1-board.png" },
            { id: "scene-2", sceneNumber: 2, sceneName: "Shot 2", segmentLabel: "A", storyboardUrl: "shot-2-board.png", videoStatus: "failed" },
            { id: "scene-3", sceneNumber: 3, sceneName: "Shot 3", segmentLabel: "B", storyboardUrl: "shot-3-board.png", videoTaskId: "task-1", videoStatus: "processing" },
          ] as PersistedVideoProject["scenes"],
        }),
      runWorkflowActionShortcut,
      runWorkflowActionShortcutChain: vi.fn(),
      showChoicePopover: vi.fn(),
      buildVideoGenerationSceneListQuestion: () => null,
      buildVideoRefreshSceneListQuestion: () => null,
      buildVideoRepairListQuestion: () => null,
      listFailedVideoScenes: () => [],
      listGeneratableVideoScenes: () => [],
      listRedoReviewItems: () => [],
      findReviewItem: () => undefined,
    })(snapshot, "video:generate:segment:A", "\u51fa\u7247\u672c\u7247\u6bb5\u5168\u90e8\u53ef\u9009\u955c\u5934");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_assets",
      { projectId: snapshot.projectId, targetIds: ["scene-1", "scene-2"] },
      "\u51fa\u7247\u672c\u7247\u6bb5\u5168\u90e8\u53ef\u9009\u955c\u5934",
    );
  });

  it("includes completed shots but skips blocked and running shots for grouped regenerate actions", () => {
    const snapshot = createSnapshot({ derivedStage: "video-generation" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoAssetChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            { id: "scene-ready", sceneNumber: 1, sceneName: "Shot 1", segmentLabel: "A", storyboardUrl: "ready-board.png" },
            { id: "scene-done", sceneNumber: 2, sceneName: "Shot 2", segmentLabel: "A", storyboardUrl: "done-board.png", videoUrl: "done.mp4", videoStatus: "completed" },
            { id: "scene-running", sceneNumber: 3, sceneName: "Shot 3", segmentLabel: "A", storyboardUrl: "run-board.png", videoTaskId: "task-1", videoStatus: "processing" },
            { id: "scene-blocked", sceneNumber: 4, sceneName: "Shot 4", segmentLabel: "A", storyboardUrl: "" },
          ] as PersistedVideoProject["scenes"],
        }),
      runWorkflowActionShortcut,
      runWorkflowActionShortcutChain: vi.fn(),
      showChoicePopover: vi.fn(),
      buildVideoGenerationSceneListQuestion: () => null,
      buildVideoRefreshSceneListQuestion: () => null,
      buildVideoRepairListQuestion: () => null,
      listFailedVideoScenes: () => [],
      listGeneratableVideoScenes: () => [],
      listRedoReviewItems: () => [],
      findReviewItem: () => undefined,
    })(snapshot, "video:generate:segment:A", "generate-segment-A");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_assets",
      { projectId: snapshot.projectId, targetIds: ["scene-ready", "scene-done"] },
      "generate-segment-A",
    );
  });

  it("routes first segment-video batch into capped shortcut generation", () => {
    const snapshot = createSnapshot({ derivedStage: "video-generation" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoAssetChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
          scenes: [
            { id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", segmentLabel: "1-1" },
            { id: "scene-2", sceneNumber: 2, sceneName: "Shot 2", segmentLabel: "1-2" },
            { id: "scene-3", sceneNumber: 3, sceneName: "Shot 3", segmentLabel: "1-3" },
            { id: "scene-4", sceneNumber: 4, sceneName: "Shot 4", segmentLabel: "1-4" },
          ] as PersistedVideoProject["scenes"],
          segmentVideoPrompts: {
            "1-1": { segmentLabel: "1-1", prompt: "prompt 1", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-1"], generatedAt: "2026-01-01T00:00:00.000Z" },
            "1-2": { segmentLabel: "1-2", prompt: "prompt 2", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-2"], generatedAt: "2026-01-01T00:00:00.000Z" },
            "1-3": { segmentLabel: "1-3", prompt: "prompt 3", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-3"], generatedAt: "2026-01-01T00:00:00.000Z" },
            "1-4": { segmentLabel: "1-4", prompt: "prompt 4", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-4"], generatedAt: "2026-01-01T00:00:00.000Z" },
          },
        }),
      runWorkflowActionShortcut,
      runWorkflowActionShortcutChain: vi.fn(),
      showChoicePopover: vi.fn(),
      buildVideoGenerationSceneListQuestion: () => null,
      buildVideoRefreshSceneListQuestion: () => null,
      buildVideoRepairListQuestion: () => null,
      listFailedVideoScenes: () => [],
      listGeneratableVideoScenes: () => [],
      listRedoReviewItems: () => [],
      findReviewItem: () => undefined,
    })(snapshot, "video:generate:segments:first", "batch-generate-first-segments");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_segment_video",
      {
        projectId: snapshot.projectId,
        targetSegmentLabels: ["1-1", "1-2", "1-3"],
      },
      "batch-generate-first-segments",
    );
  });

  it("routes failed and running segment-video batches into their recovery actions", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89c6\u9891\u751f\u6210" });
    const runWorkflowActionShortcutChain = vi.fn();
    const project = createVideoProject({
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
      scenes: [
        { id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", segmentLabel: "1-1" },
        { id: "scene-2", sceneNumber: 2, sceneName: "Shot 2", segmentLabel: "1-2" },
      ] as PersistedVideoProject["scenes"],
      segmentVideoPrompts: {
        "1-1": { segmentLabel: "1-1", prompt: "prompt 1", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-1"], generatedAt: "2026-01-01T00:00:00.000Z" },
        "1-2": { segmentLabel: "1-2", prompt: "prompt 2", duration: 15, targetDuration: 15, modelKey: "model", maxDurationForModel: 15, sceneIds: ["scene-2"], generatedAt: "2026-01-01T00:00:00.000Z" },
      },
      segmentVideoStatuses: {
        "1-1": {
          segmentLabel: "1-1",
          status: "failed",
          failure: { message: "failed", stage: "status", updatedAt: "2026-01-01T00:00:00.000Z" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        "1-2": {
          segmentLabel: "1-2",
          status: "processing",
          taskId: "task-2",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const createHandler = () => createVideoAssetChoiceHandler({
      getCurrentVideoProject: () => project,
      runWorkflowActionShortcut: vi.fn(),
      runWorkflowActionShortcutChain,
      showChoicePopover: vi.fn(),
      buildVideoGenerationSceneListQuestion: () => null,
      buildVideoRefreshSceneListQuestion: () => null,
      buildVideoRepairListQuestion: () => null,
      listFailedVideoScenes: () => [],
      listGeneratableVideoScenes: () => [],
      listRedoReviewItems: () => [],
      findReviewItem: () => undefined,
    });

    expect(createHandler()(snapshot, "video:generate:segments:failed", "Retry failed segments")).toBe(true);
    expect(runWorkflowActionShortcutChain).toHaveBeenLastCalledWith(
      [{ action: "generate_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-1" } }],
      "Retry failed segments",
    );

    expect(createHandler()(snapshot, "video:generate:segments:refresh", "Refresh running segments")).toBe(true);
    expect(runWorkflowActionShortcutChain).toHaveBeenLastCalledWith(
      [{ action: "refresh_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-2" } }],
      "Refresh running segments",
    );
  });

  it("ignores legacy grouped segment refresh options after refresh menus are folded into generation lists", () => {
    const snapshot = createSnapshot({ derivedStage: "\u751f\u6210\u4e2d" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoAssetChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            { id: "scene-1", sceneNumber: 1, sceneName: "Shot 1", segmentLabel: "A", videoTaskId: "task-1", videoStatus: "processing" },
            { id: "scene-2", sceneNumber: 2, sceneName: "Shot 2", segmentLabel: "A", videoTaskId: "task-2", videoStatus: "queued" },
            { id: "scene-3", sceneNumber: 3, sceneName: "Shot 3", segmentLabel: "B", videoTaskId: "task-3", videoStatus: "processing" },
          ] as PersistedVideoProject["scenes"],
        }),
      runWorkflowActionShortcut,
      runWorkflowActionShortcutChain: vi.fn(),
      showChoicePopover: vi.fn(),
      buildVideoGenerationSceneListQuestion: () => null,
      buildVideoRefreshSceneListQuestion: () => null,
      buildVideoRepairListQuestion: () => null,
      listFailedVideoScenes: () => [],
      listGeneratableVideoScenes: () => [],
      listRedoReviewItems: () => [],
      findReviewItem: () => undefined,
    })(snapshot, "video:refresh:segment:A", "\u67e5\u770b\u672c\u7247\u6bb5\u5168\u90e8\u8fdb\u884c\u4e2d\u955c\u5934");

    expect(handled).toBe(false);
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });
});

describe("createVideoProjectChoiceHandler", () => {
  it("opens the duration question after choosing script analysis from the first-step panel", () => {
    const snapshot = createSnapshot();
    const showChoicePopover = vi.fn();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => null,
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze", "\u5267\u672c\u62c6\u89e3");

    expect(handled).toBe(true);
    expect(showChoicePopover).toHaveBeenCalledWith(
      "\u5267\u672c\u62c6\u89e3",
      expect.any(String),
      buildScriptAnalyzeDurationQuestion(snapshot),
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("reuses saved script-analysis params and immediately refreshes an approved breakdown", () => {
    const snapshot = createSnapshot();
    const showChoicePopover = vi.fn();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "Scene 1",
              description: "",
              characters: [],
              dialogue: "",
              cameraDirection: "",
              duration: 5,
              segmentLabel: "1-1",
              storyboardUrl: "",
            },
          ],
          preferredEpisodeDurationSeconds: 120,
          preferredScriptBreakdownPace: "slow",
          scriptBreakdownPassed: true,
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze", "刷新拆解结果");

    expect(handled).toBe(true);
    expect(showChoicePopover).not.toHaveBeenCalled();
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "analyze_script_for_video",
      {
        projectId: snapshot.projectId,
        videoPace: "slow",
        episodeDuration: 120,
      },
      "刷新拆解结果",
      expect.objectContaining({
        restoreQuestionOnInterrupt: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnCancel: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnError: expect.objectContaining({ answerKey: "video-analyze-resume" }),
      }),
    );
  });

  it("opens a completion question after choosing pace and does not run script analysis yet", async () => {
    const snapshot = createSnapshot();
    const showChoicePopover = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      commitVideoProjectPatch,
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze:pace:medium:60", "\u4e2d\u7b49");

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commitVideoProjectPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredEpisodeDurationSeconds: 60,
        preferredScriptBreakdownPace: "medium",
      }),
    );
    expect(showChoicePopover).toHaveBeenCalledWith(
      "\u4e2d\u7b49",
      expect.any(String),
      expect.objectContaining({
        answerKey: "video-analyze-execute",
        options: expect.arrayContaining([
          expect.objectContaining({
            label: "\u5b8c\u6210\u5267\u672c\u62c6\u89e3",
            value: "video:bridge:analyze:execute:medium:60",
          }),
        ]),
        statusBadges: expect.arrayContaining([
          expect.objectContaining({ value: "60 \u79d2 / \u4e2d\u7b49" }),
        ]),
      }),
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("runs script analysis from the completion question and restores the continue card on interruption", () => {
    const snapshot = createSnapshot();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze:execute:medium:60", "\u5b8c\u6210\u5267\u672c\u62c6\u89e3");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "analyze_script_for_video",
      {
        projectId: snapshot.projectId,
        videoPace: "medium",
        episodeDuration: 60,
      },
      "\u5b8c\u6210\u5267\u672c\u62c6\u89e3",
      expect.objectContaining({
        restoreQuestionOnInterrupt: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnCancel: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnError: expect.objectContaining({ answerKey: "video-analyze-resume" }),
      }),
    );
    expect(runWorkflowActionShortcut.mock.calls.at(-1)?.[3]?.restoreQuestionAfterRun).toBeUndefined();
  });

    it("resumes script analysis with saved params without forcing the kickoff popup yet", () => {
    const snapshot = createSnapshot();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "image-to-video",
      }),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze:resume:fast:90", "\u7ee7\u7eed\u5267\u672c\u62c6\u89e3");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "analyze_script_for_video",
      {
        projectId: snapshot.projectId,
        videoPace: "fast",
        episodeDuration: 90,
      },
      "\u7ee7\u7eed\u5267\u672c\u62c6\u89e3",
      expect.objectContaining({
        restoreQuestionOnInterrupt: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnCancel: expect.objectContaining({ answerKey: "video-analyze-resume" }),
        restoreQuestionOnError: expect.objectContaining({ answerKey: "video-analyze-resume" }),
      }),
    );
    expect(runWorkflowActionShortcut.mock.calls.at(-1)?.[3]?.restoreQuestionAfterRun).toBeUndefined();
  });

  it("reuses the continue-missing-episodes recovery question when retrying missing script episodes", () => {
    const snapshot = createSnapshot();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          preferredEpisodeDurationSeconds: 120,
          preferredScriptBreakdownPace: "slow",
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "image-to-video",
      }),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:analyze:retry-missing", "Retry missing episodes");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "analyze_script_for_video",
      {
        projectId: snapshot.projectId,
        videoPace: "slow",
        episodeDuration: 120,
        retryMissingEpisodes: true,
      },
      "Retry missing episodes",
      expect.objectContaining({
        restoreQuestionOnInterrupt: expect.objectContaining({ answerKey: "video-analyze-retry-missing" }),
        restoreQuestionOnCancel: expect.objectContaining({ answerKey: "video-analyze-retry-missing" }),
        restoreQuestionOnError: expect.objectContaining({ answerKey: "video-analyze-retry-missing" }),
      }),
    );
    expect(runWorkflowActionShortcut.mock.calls.at(-1)?.[3]?.restoreQuestionAfterRun).toBeUndefined();
  });

  it("opens the video mode kickoff only after entity extraction finishes from the script-breakdown stage", () => {
    const snapshot = createSnapshot();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:entities", "\u63d0\u53d6\u89d2\u8272\u4e0e\u573a\u666f");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "extract_video_entities",
      { projectId: snapshot.projectId },
      "\u63d0\u53d6\u89d2\u8272\u4e0e\u573a\u666f",
      expect.objectContaining({
        restoreQuestionAfterRun: expect.objectContaining({ answerKey: "video-analyze-duration" }),
      }),
    );
  });

  it("routes platform preference into background research without extra kickoff popups", () => {
    const snapshot = createSnapshot();
    const runBackgroundVideoBridgeResearch = vi.fn();
    const showChoicePopover = vi.fn();
    const send = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => null,
      runBackgroundVideoBridgeResearch,
      runWorkflowActionShortcut: vi.fn(),
      send,
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:platform", "\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d");

    expect(handled).toBe(true);
    expect(runBackgroundVideoBridgeResearch).toHaveBeenCalledWith("\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d", "all");
    expect(showChoicePopover).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("runs single-field bridge completion in background without kickoff popups", () => {
    const snapshot = createSnapshot();
    const runBackgroundVideoBridgeResearch = vi.fn();
    const runWorkflowActionShortcut = vi.fn();
    const showChoicePopover = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch,
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:prefix:target-platform", "\u8865\u5145\u5e73\u53f0");

    expect(handled).toBe(true);
    expect(runBackgroundVideoBridgeResearch).toHaveBeenCalledWith("\u8865\u5145\u5e73\u53f0", "targetPlatform");
    expect(showChoicePopover).not.toHaveBeenCalled();
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("opens the post-breakdown mode chooser from the next-step handoff", () => {
    const snapshot = createSnapshot();
    const showChoicePopover = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:next-step", "\u4e0b\u4e00\u6b65");

    expect(handled).toBe(true);
    expect(showChoicePopover).toHaveBeenCalledWith(
      "\u4e0b\u4e00\u6b65",
      expect.any(String),
      expect.objectContaining({
        answerKey: "video-post-analyze-mode",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "video:kickoff:prefs:mode:text-to-video",
            selected: false,
          }),
          expect.objectContaining({
            value: "video:kickoff:prefs:mode:image-to-video",
            selected: false,
          }),
        ]),
      }),
    );
  });

  it("writes kickoff-selected mode and style preset, then pauses for explicit bridge completion", async () => {
    const snapshot = createSnapshot();
    const runBackgroundVideoBridgeResearch = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const commitVideoGenerationPrefs = vi.fn();
    const commitImageGenerationPrefs = vi.fn();
    const clearAttachedFiles = vi.fn();
    const showChoicePopover = vi.fn();
    const showChoiceNotice = vi.fn();
    const handler = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch,
      commitVideoProjectPatch,
      commitVideoGenerationPrefs,
      commitImageGenerationPrefs,
      clearAttachedFiles,
      getVideoGenerationPrefs: () => ({
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
        mode: "text-to-video",
      }),
      getImageGenerationPrefs: () => ({
        familyKey: "nano-banana-pro",
        resolution: "2k",
        aspectRatio: "16:9",
        styleCategory: "realistic",
        stylePreset: "live-action",
      }),
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice,
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    });

    expect(handler(snapshot, "video:kickoff:prefs:mode:image-to-video", "\u56fe\u751f\u89c6\u9891")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitVideoGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "image-to-video" }),
    );
    expect(commitVideoProjectPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kickoffModeConfirmed: true,
        videoGenerationPrefs: expect.objectContaining({ mode: "image-to-video" }),
      }),
    );
    expect(showChoicePopover).toHaveBeenCalledWith(
      "\u56fe\u751f\u89c6\u9891",
      expect.stringContaining("\u56fe\u751f\u89c6\u9891"),
      expect.objectContaining({ answerKey: "video-kickoff-prefs-style" }),
    );

    expect(handler(snapshot, "video:kickoff:prefs:style-preset:retro-comic", "\u7f8e\u5f0f\u590d\u53e4\u6f2b\u753b\u98ce")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitImageGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        styleCategory: "animation-2d",
        stylePreset: "retro-comic",
      }),
    );
    expect(clearAttachedFiles).toHaveBeenCalled();
    expect(commitVideoProjectPatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
      }),
    );
    expect(showChoiceNotice).not.toHaveBeenCalled();
    const followupQuestion = showChoicePopover.mock.calls.at(-1)?.[2];
    expect(showChoicePopover).toHaveBeenLastCalledWith(
      "\u7f8e\u5f0f\u590d\u53e4\u6f2b\u753b\u98ce",
      expect.stringContaining("\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d"),
      expect.objectContaining({ answerKey: "video-bridge-prefix" }),
    );
    expect(runBackgroundVideoBridgeResearch).not.toHaveBeenCalled();
    expect(followupQuestion?.answerKey).toBe("video-bridge-prefix");
    expect(listQuestionLabels(followupQuestion)).toContain("\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d");
    expect(listQuestionValues(followupQuestion)).not.toContain(
      "video:kickoff:prefs:style-category:custom",
    );
    expect(listQuestionLabels(followupQuestion)).not.toContain("\u81ea\u5b9a\u4e49");
  });

  it("closes the style popup and waits for upload when no reference image is attached", () => {
    const snapshot = createSnapshot();
    const awaitImageStyleReferenceUpload = vi.fn();
    const showChoicePopover = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getAttachedImageCount: () => 0,
      awaitImageStyleReferenceUpload,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:kickoff:prefs:style-reference", "\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");

    expect(handled).toBe(true);
    expect(awaitImageStyleReferenceUpload).toHaveBeenCalledWith("\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");
    expect(showChoicePopover).not.toHaveBeenCalled();
  });

  it("surfaces a readable summary after custom style text is captured", async () => {
    const snapshot = createSnapshot();
    const commitImageGenerationPrefs = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const showChoicePopover = vi.fn();
    const customStylePrompt = "\u7535\u5f71\u7ea7\u4f4e\u9971\u548c\u80f6\u7247\u8d28\u611f\uff0c\u96e8\u591c\u9739\u8679\u53cd\u5dee\u5f3a";

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      commitImageGenerationPrefs,
      commitVideoProjectPatch,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(
      snapshot,
      `video:kickoff:prefs:custom-style:${encodeURIComponent(customStylePrompt)}`,
      customStylePrompt,
    );

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitImageGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        styleCategory: "custom",
        stylePreset: "custom",
        customStylePrompt,
      }),
    );
    expect(showChoicePopover).toHaveBeenLastCalledWith(
      customStylePrompt,
      expect.stringContaining(`\u81ea\u5b9a\u4e49\u98ce\u683c\u8bf4\u660e\u5df2\u5199\u5165\uff1a${customStylePrompt}`),
      expect.objectContaining({ answerKey: "video-bridge-prefix" }),
    );
    expect(commitVideoProjectPatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
      }),
    );
  });

  it("clears attached files after recognizing an already uploaded style reference", async () => {
    const snapshot = createSnapshot();
    const clearAttachedFiles = vi.fn();
    const commitImageGenerationPrefs = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const showChoicePopover = vi.fn();
    const recognizeImageStyle = vi.fn(async () => ({
      summary: "\u53c2\u8003\u56fe\u8bc6\u522b\u7ed3\u679c\u504f 3D \u98ce\u683c\uff0c\u9002\u5408\u7ee7\u7eed\u751f\u6210",
      styleCategory: "realistic",
      stylePreset: "live-action",
      customStylePrompt: "",
    }));

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getAttachedImageCount: () => 1,
      clearAttachedFiles,
      recognizeImageStyle,
      commitImageGenerationPrefs,
      commitVideoProjectPatch,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:kickoff:prefs:style-reference", "\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recognizeImageStyle).toHaveBeenCalled();
    expect(clearAttachedFiles).toHaveBeenCalled();
    expect(commitImageGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        styleCategory: "realistic",
        stylePreset: "live-action",
      }),
    );
    expect(commitVideoProjectPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
      }),
    );
    expect(showChoicePopover).toHaveBeenCalledWith(
      "\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe",
      expect.stringContaining("\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d"),
      expect.objectContaining({ answerKey: "video-bridge-prefix" }),
    );
  });
  it("prefers the submitted style-reference send path when an uploaded image is already attached", async () => {
    const snapshot = createSnapshot();
    const clearAttachedFiles = vi.fn();
    const commitImageGenerationPrefs = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const showChoicePopover = vi.fn();
    const submitAttachedStyleReference = vi.fn(async () => ({
      summary: "\u53c2\u8003\u56fe\u8bc6\u522b\u7ed3\u679c\u5df2\u7ecf\u56de\u5199\u5230\u5f53\u524d\u504f\u597d",
      styleCategory: "realistic" as const,
      stylePreset: "live-action" as const,
      customStylePrompt: "",
    }));
    const recognizeImageStyle = vi.fn(async () => ({
      summary: "\u672c\u5730\u94fe\u8def\u5df2\u5b8c\u6210\u56de\u586b",
      styleCategory: "animation" as const,
      stylePreset: "anime" as const,
      customStylePrompt: "",
    }));

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getAttachedImageCount: () => 1,
      clearAttachedFiles,
      recognizeImageStyle,
      submitAttachedStyleReference,
      commitImageGenerationPrefs,
      commitVideoProjectPatch,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:kickoff:prefs:style-reference", "\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitAttachedStyleReference).toHaveBeenCalledWith("\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");
    expect(recognizeImageStyle).not.toHaveBeenCalled();
    expect(clearAttachedFiles).toHaveBeenCalled();
    expect(commitImageGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        styleCategory: "realistic",
        stylePreset: "live-action",
      }),
    );
    expect(commitVideoProjectPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
      }),
    );
    const latestPopoverCall = showChoicePopover.mock.calls.at(-1);
    expect(latestPopoverCall).toBeTruthy();
    expect(typeof latestPopoverCall?.[1]).toBe("string");
    expect(latestPopoverCall?.[2]).toEqual(expect.objectContaining({ answerKey: "video-bridge-prefix" }));
  });

  it("skips reopening the choice popover when submitted style-reference handling already completed locally", async () => {
    const snapshot = createSnapshot();
    const clearAttachedFiles = vi.fn();
    const commitImageGenerationPrefs = vi.fn();
    const commitVideoProjectPatch = vi.fn();
    const showChoicePopover = vi.fn();
    const submitAttachedStyleReference = vi.fn(async () => ({
      summary: "\u672c\u5730\u94fe\u8def\u5df2\u7ecf\u5b8c\u6210\u8bc6\u522b\u548c\u56de\u586b",
      styleCategory: "realistic" as const,
      stylePreset: "live-action" as const,
      customStylePrompt: "",
      handledLocally: true,
    }));

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch: vi.fn(),
      getAttachedImageCount: () => 1,
      clearAttachedFiles,
      recognizeImageStyle: vi.fn(),
      submitAttachedStyleReference,
      commitImageGenerationPrefs,
      commitVideoProjectPatch,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover,
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:kickoff:prefs:style-reference", "\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");

    expect(handled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitAttachedStyleReference).toHaveBeenCalledWith("\u8bc6\u522b\u5df2\u4e0a\u4f20\u53c2\u8003\u56fe");
    expect(commitImageGenerationPrefs).not.toHaveBeenCalled();
    expect(commitVideoProjectPatch).not.toHaveBeenCalled();
    expect(showChoicePopover).not.toHaveBeenCalled();
    expect(clearAttachedFiles).not.toHaveBeenCalled();
  });

  it("waits for a character audio upload when the role audio-reference option is selected", () => {
    const snapshot = createSnapshot();
    const awaitCharacterAudioReferenceUpload = vi.fn();
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [
            {
              id: "char-1",
              name: "Hero",
              description: "desc",
            },
          ] as PersistedVideoProject["characters"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      awaitCharacterAudioReferenceUpload,
      runWorkflowActionShortcut,
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-audio:character:char-1", "上传 Hero 音频参考");

    expect(handled).toBe(true);
    expect(awaitCharacterAudioReferenceUpload).toHaveBeenCalledWith(
      "上传 Hero 音频参考",
      "char-1",
      "Hero",
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("falls back to the sidebar label when the current video project has not hydrated the character name yet", () => {
    const snapshot = createSnapshot();
    const awaitCharacterAudioReferenceUpload = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => null,
      runBackgroundVideoBridgeResearch: vi.fn(),
      awaitCharacterAudioReferenceUpload,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(snapshot, "video:bridge:reference-audio:character:char-2", "上传 林萧 音频参考");

    expect(handled).toBe(true);
    expect(awaitCharacterAudioReferenceUpload).toHaveBeenCalledWith(
      "上传 林萧 音频参考",
      "char-2",
      "林萧",
    );
  });


  it("opens the preset reference-audio picker for the selected role", () => {
    const snapshot = createSnapshot();
    const openCharacterAudioReferencePresetPicker = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [
            {
              id: "char-1",
              name: "Hero",
              description: "desc",
            },
          ] as PersistedVideoProject["characters"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      openCharacterAudioReferencePresetPicker,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(
      snapshot,
      "video:bridge:reference-audio:preset-picker:character:char-1",
      "Use preset reference audio",
    );

    expect(handled).toBe(true);
    expect(openCharacterAudioReferencePresetPicker).toHaveBeenCalledWith(
      "Use preset reference audio",
      "char-1",
      "Hero",
    );
  });

  it("binds a preset reference-audio file to the selected role", () => {
    const snapshot = createSnapshot();
    const bindCharacterAudioReferencePreset = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [
            {
              id: "char-1",
              name: "Hero",
              description: "desc",
            },
          ] as PersistedVideoProject["characters"],
        }),
      runBackgroundVideoBridgeResearch: vi.fn(),
      bindCharacterAudioReferencePreset,
      runWorkflowActionShortcut: vi.fn(),
      send: vi.fn(),
      showChoicePopover: vi.fn(),
      showChoiceNotice: vi.fn(),
      buildVideoGenerationQuestion: () => null,
      buildVideoRefreshQuestion: () => null,
      buildReviewQuestion: () => null,
      buildReviewListQuestion: () => null,
      buildVideoRepairQuestion: () => null,
      listGeneratableVideoScenes: () => [],
      listRunningVideoScenes: () => [],
    })(
      snapshot,
      "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Ctest%5Chero.wav&name=hero.wav&category=basic%20%2F%20female",
      "01. Hero 5.2s",
    );

    expect(handled).toBe(true);
    expect(bindCharacterAudioReferencePreset).toHaveBeenCalledWith({
      audioPath: "E:\\test\\hero.wav",
      categoryLabel: "basic / female",
      characterId: "char-1",
      characterName: "Hero",
      fileName: "hero.wav",
      label: "01. Hero 5.2s",
    });
  });
});
