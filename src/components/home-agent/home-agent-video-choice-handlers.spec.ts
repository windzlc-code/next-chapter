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
    title: "测试视频项目",
    currentObjective: "完成脚本拆解",
    derivedStage: "脚本拆解",
    agentSummary: "summary",
    recommendedActions: ["先完成第一轮镜头拆解"],
    artifacts: [],
    ...overrides,
  };
}

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "测试视频项目",
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

function listQuestionValues(question: ReturnType<typeof buildVideoUploadScriptFollowupQuestion>): string[] {
  if (!question) return [];
  const values: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    values.push(option.value);
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return values;
}

describe("buildVideoUploadScriptFollowupQuestion", () => {
  it("returns the workflow bridge panel when an uploaded script lands in the analyze stage", () => {
    const snapshot = createSnapshot();

    expect(buildVideoUploadScriptFollowupQuestion(snapshot)?.answerKey).toBe("video-bridge-panel");
  });

  it("no longer surfaces legacy prefix actions once any bridge field is written", () => {
    const snapshot = createSnapshot();
    const question = buildVideoUploadScriptFollowupQuestion(
      snapshot,
      createVideoProject({ targetPlatform: "抖音" }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:target-platform");
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:shot-style");
    expect(listQuestionValues(question)).not.toContain("video:bridge:prefix:output-goal");
    expect(listQuestionValues(question)).not.toContain("video:bridge:platform");
  });

  it("returns the script-analysis panel after all three bridge fields are written", () => {
    const snapshot = createSnapshot();
    const question = buildVideoUploadScriptFollowupQuestion(
      snapshot,
      createVideoProject({
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "预告片",
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:analyze");
    expect(listQuestionValues(question)).not.toContain("video:bridge:analyze:dur:90");
  });

  it("does not override the popover once the video workflow has already moved past script analysis", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });

    expect(buildVideoUploadScriptFollowupQuestion(snapshot)).toBeNull();
  });
  it("routes the separate character asset branch into targeted reference generation", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
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
    })(snapshot, "video:bridge:reference-assets:characters", "单独整理角色资产");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-character:char-1"] },
      "单独整理角色资产",
    );
  });

  it("routes a single scene asset child into targeted reference generation", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
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
    })(snapshot, "video:bridge:reference-assets:scene:setting-1", "生成 Warehouse");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-scene:setting-1"] },
      "生成 Warehouse",
    );
  });

  it("routes a single character variant child into targeted variant generation", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [{
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "hero-main.jpg",
            costumes: [{ id: "cost-1", label: "校服", description: "蓝白校服", imageUrl: "" }],
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
    })(snapshot, "video:bridge:reference-assets:character-variant:char-1:cost-1", "校服");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_reference_assets",
      { projectId: snapshot.projectId, targetIds: ["reference-character-variant:char-1:cost-1"] },
      "校服",
    );
  });

  it("routes full reference asset batches with main references before variants", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
    const runWorkflowActionShortcut = vi.fn();

    const handled = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () =>
        createVideoProject({
          characters: [{
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
            costumes: [{ id: "cost-1", label: "校服", description: "蓝白校服", imageUrl: "" }],
          }] as PersistedVideoProject["characters"],
          sceneSettings: [{
            id: "setting-1",
            name: "Warehouse",
            description: "desc",
            imageUrl: "",
            timeVariants: [{ id: "time-1", label: "雨夜", description: "冷蓝夜光", imageUrl: "" }],
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
    })(snapshot, "video:bridge:reference-assets:full", "批量补齐角色/场景资产（含变体）");

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
      "批量补齐角色/场景资产（含变体）",
    );
  });

  it("routes a single storyboard scene child into targeted storyboard generation", () => {
    const snapshot = createSnapshot({ derivedStage: "分镜图生成" });
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
    })(snapshot, "video:bridge:storyboard-frame:scene:scene-1", "重生成 Shot 1");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_storyboard_frames",
      { projectId: snapshot.projectId, targetIds: ["scene-1"], forceRegenerate: true },
      "重生成 Shot 1",
    );
  });

  it("routes segment prompt batch and remaining actions into scoped workflow shortcuts", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
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

    expect(handler(snapshot, "video:bridge:prompts:segment:batch", "分批生成片段")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "batch" },
      "分批生成片段",
    );

    expect(handler(snapshot, "video:bridge:prompts:segment:remaining", "补齐剩余片段")).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenLastCalledWith(
      "prepare_segment_video_prompt",
      { projectId: snapshot.projectId, batchMode: "remaining" },
      "补齐剩余片段",
    );
  });

  it("routes a segment batch storyboard option into only the enabled scenes in that segment", () => {
    const snapshot = createSnapshot({ derivedStage: "分镜图生成" });
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
    })(snapshot, "video:bridge:storyboard-frames:segment:A", "生成本片段全部可选分镜");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_storyboard_frames",
      { projectId: snapshot.projectId, targetIds: ["scene-ready"] },
      "生成本片段全部可选分镜",
    );
  });

  it("routes storyboard step switching through continue_video_step", () => {
    const snapshot = createSnapshot({ derivedStage: "角色与场景" });
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
    })(snapshot, "video:step:storyboard", "切到《生成分镜图》");

    expect(handled).toBe(true);
    expect(switchVideoStep).toHaveBeenCalledWith(
      snapshot.projectId,
      3,
      "切到《生成分镜图》",
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("routes video and preview step switching through continue_video_step", () => {
    const snapshot = createSnapshot({ derivedStage: "分镜图生成" });
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

    expect(createVideoProjectChoiceHandler(deps)(snapshot, "video:step:video", "切到《视频生成》")).toBe(true);
    expect(createVideoProjectChoiceHandler(deps)(snapshot, "video:step:preview", "切到《预览与导出》")).toBe(true);

    expect(deps.switchVideoStep).toHaveBeenNthCalledWith(
      1,
      snapshot.projectId,
      4,
      "切到《视频生成》",
    );
    expect(deps.switchVideoStep).toHaveBeenNthCalledWith(
      2,
      snapshot.projectId,
      5,
      "切到《预览与导出》",
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("routes full asset export through the workflow shortcut without rebuilding the popup locally", () => {
    const snapshot = createSnapshot({
      derivedStage: "????????",
      recommendedActions: ["???????????"],
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
    const snapshot = createSnapshot({ derivedStage: "棰勮涓庡鍑?" });
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
    })(snapshot, "video:export:nle-placeholder", "导入到剪辑软件");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(showChoiceNotice).toHaveBeenCalledWith(
      "导入到剪辑软件",
      "“导入到剪辑软件”后续实现，当前可先使用“全部导出”。",
    );
  });
});

describe("createVideoAssetChoiceHandler", () => {
  it("routes a grouped segment generate option into targeted video generation", () => {
    const snapshot = createSnapshot({ derivedStage: "\u89c6\u9891\u63d0\u793a\u8bcd" });
    const runWorkflowActionShortcut = vi.fn();

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
    const snapshot = createSnapshot({ derivedStage: "视频生成" });
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
    })(snapshot, "video:generate:segment:A", "出片本片段全部可选镜头");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_video_assets",
      { projectId: snapshot.projectId, targetIds: ["scene-ready", "scene-done"] },
      "出片本片段全部可选镜头",
    );
  });

  it("routes first segment-video batch into chained segment generation", () => {
    const snapshot = createSnapshot({ derivedStage: "视频生成" });
    const runWorkflowActionShortcutChain = vi.fn();

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
    })(snapshot, "video:generate:segments:first", "批量生成前 3 个片段");

    expect(handled).toBe(true);
    expect(runWorkflowActionShortcutChain).toHaveBeenCalledWith(
      [
        { action: "generate_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-1" } },
        { action: "generate_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-2" } },
        { action: "generate_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-3" } },
      ],
      "批量生成前 3 个片段",
    );
  });

  it("routes failed and running segment-video batches into their recovery actions", () => {
    const snapshot = createSnapshot({ derivedStage: "视频生成" });
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

    expect(createHandler()(snapshot, "video:generate:segments:failed", "批量补发失败片段")).toBe(true);
    expect(runWorkflowActionShortcutChain).toHaveBeenLastCalledWith(
      [{ action: "generate_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-1" } }],
      "批量补发失败片段",
    );

    expect(createHandler()(snapshot, "video:generate:segments:refresh", "批量刷新进行中片段")).toBe(true);
    expect(runWorkflowActionShortcutChain).toHaveBeenLastCalledWith(
      [{ action: "refresh_segment_video", input: { projectId: snapshot.projectId, segmentLabel: "1-2" } }],
      "批量刷新进行中片段",
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
    })(snapshot, "video:bridge:analyze", "剧本拆解");

    expect(handled).toBe(true);
    expect(showChoicePopover).toHaveBeenCalledWith(
      "剧本拆解",
      expect.any(String),
      buildScriptAnalyzeDurationQuestion(snapshot),
    );
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
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
    })(snapshot, "video:bridge:platform", "补充平台和镜头偏好");

    expect(handled).toBe(true);
    expect(runBackgroundVideoBridgeResearch).toHaveBeenCalledWith("补充平台和镜头偏好", "all");
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
    })(snapshot, "video:bridge:prefix:target-platform", "补齐目标平台");

    expect(handled).toBe(true);
    expect(runBackgroundVideoBridgeResearch).toHaveBeenCalledWith("补齐目标平台", "targetPlatform");
    expect(showChoicePopover).not.toHaveBeenCalled();
    expect(runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("writes kickoff-selected mode and style preset before continuing bridge research", async () => {
    const snapshot = createSnapshot();
    const runBackgroundVideoBridgeResearch = vi.fn();
    const commitVideoGenerationPrefs = vi.fn();
    const commitImageGenerationPrefs = vi.fn();
    const showChoicePopover = vi.fn();
    const showChoiceNotice = vi.fn();
    const handler = createVideoProjectChoiceHandler({
      getCurrentVideoProject: () => createVideoProject(),
      runBackgroundVideoBridgeResearch,
      commitVideoGenerationPrefs,
      commitImageGenerationPrefs,
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

    expect(handler(snapshot, "video:kickoff:prefs:mode:image-to-video", "图生视频")).toBe(true);
    await Promise.resolve();

    expect(commitVideoGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "image-to-video" }),
    );
    expect(showChoicePopover).toHaveBeenCalledWith(
      "图生视频",
      expect.stringContaining("图生视频"),
      expect.objectContaining({ answerKey: "video-kickoff-prefs-style" }),
    );

    expect(handler(snapshot, "video:kickoff:prefs:style-preset:retro-comic", "美式复古漫画风")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commitImageGenerationPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        styleCategory: "animation-2d",
        stylePreset: "retro-comic",
      }),
    );
    expect(showChoiceNotice).toHaveBeenCalledWith(
      "美式复古漫画风",
      expect.stringContaining("画面风格"),
    );
    expect(runBackgroundVideoBridgeResearch).toHaveBeenCalledWith("继续补齐平台与镜头偏好", "all");
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
    })(snapshot, "video:kickoff:prefs:style-reference", "识别已上传参考图");

    expect(handled).toBe(true);
    expect(awaitImageStyleReferenceUpload).toHaveBeenCalledWith("识别已上传参考图");
    expect(showChoicePopover).not.toHaveBeenCalled();
  });
});
