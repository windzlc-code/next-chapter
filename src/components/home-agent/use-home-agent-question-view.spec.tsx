import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComposerQuestion, StudioRuntimeState } from "@/lib/home-agent/types";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import { buildProjectSuggestionKey } from "./home-agent-session-utils";
import {
  buildVideoBridgeQuestion,
  buildVideoContinuationQuestion,
  recQuestion,
} from "./home-agent-project-questions";
import { useHomeAgentQuestionView } from "./use-home-agent-question-view";

function createRuntime(derivedStage: string): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: {
      projectId: "script-project-1",
      projectKind: "script",
      title: "Question View Project",
      currentObjective: "Keep going",
      derivedStage,
      agentSummary: "Summary",
      recommendedActions: [],
      artifacts: [],
    },
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "",
  };
}

function createVideoRuntime(
  overrides?: Partial<NonNullable<StudioRuntimeState["currentVideoProject"]>>,
): StudioRuntimeState {
  const currentVideoProject = {
    id: "video-project-1",
    title: "Video Question View Project",
    script: "女主在雨夜冲出街口。",
    targetPlatform: "抖音",
    shotStyle: "电影感短预告",
    outputGoal: "预告片",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action" as const,
    currentStep: 1,
    systemPrompt: "",
    analysisSummary: "视频桥接已建立。",
    storyboardPlan: "",
    videoPromptBatch: "",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:10:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };

  return {
    sessionId: "session-video-1",
    currentProjectSnapshot: createVideoSnapshot(currentVideoProject),
    currentDramaProject: null,
    currentVideoProject,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "",
  };
}

function createQuestion(
  id: string,
  answerKey: string,
  label: string,
): ComposerQuestion {
  return {
    id,
    title: label,
    description: label,
    options: [
      {
        id: `${id}-option`,
        label,
        value: label,
        rationale: label,
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey,
  };
}

function findQuestionOptionLabel(
  question: ComposerQuestion | null | undefined,
  value: string,
): string | null {
  const visit = (options: ComposerQuestion["options"]): string | null => {
    for (const option of options) {
      if (option.value === value) return option.label;
      if (option.children?.length) {
        const childMatch = visit(option.children);
        if (childMatch) return childMatch;
      }
    }
    return null;
  };

  return question ? visit(question.options) : null;
}

function findQuestionOption(
  question: ComposerQuestion | null | undefined,
  value: string,
): ComposerQuestion["options"][number] | null {
  const visit = (options: ComposerQuestion["options"]): ComposerQuestion["options"][number] | null => {
    for (const option of options) {
      if (option.value === value) return option;
      if (option.children?.length) {
        const childMatch = visit(option.children);
        if (childMatch) return childMatch;
      }
    }
    return null;
  };

  return question ? visit(question.options) : null;
}

describe("useHomeAgentQuestionView", () => {
  it("drops stale script popovers when they no longer match the current workflow stage", () => {
    const popoverOverride = createQuestion(
      "script-compliance-list-script-project-1",
      "script-compliance-list",
      "逐条处理修订包",
    );
    const suggested = createQuestion(
      "script-export-script-project-1",
      "script-export",
      "回头补写缺失章节或集数",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime: createRuntime("导出与出片"),
        qState: null,
        popoverOverride,
        suggested,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("script-export");
  });

  it("keeps current-stage script popovers when they still belong to the active workflow step", () => {
    const popoverOverride = createQuestion(
      "script-compliance-list-script-project-1",
      "script-compliance-list",
      "逐条处理修订包",
    );
    const suggested = createQuestion(
      "script-compliance-script-project-1",
      "script-compliance",
      "先处理高风险项",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime: createRuntime("合规审查"),
        qState: null,
        popoverOverride,
        suggested,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("script-compliance-list");
  });

  it("keeps the episode workflow popover when the current stage is script writing", () => {
    const popoverOverride = createQuestion(
      "script-episode-script-project-1",
      "script-episode",
      "继续生成第 1 集正文",
    );
    const suggested = createQuestion(
      "script-export-script-project-1",
      "script-export",
      "先看导出",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime: createRuntime("剧本撰写"),
        qState: null,
        popoverOverride,
        suggested,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("script-episode");
  });

  it("keeps the episode duration gate while still on the outline stage", () => {
    const popoverOverride = createQuestion(
      "script-episode-duration-gate-script-project-1",
      "script-episode-duration-gate",
      "先确认单集目标时长",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime: createRuntime("单集细纲"),
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("script-episode-duration-gate");
  });

  it("re-filters dismissed project suggestions even when the same Set instance is mutated", () => {
    const popoverOverride = createQuestion(
      "script-creative-plan-script-project-1",
      "script-creative-plan",
      "继续推进角色设定",
    );
    const dismissedProjectSuggestionKeys = new Set<string>();

    const { result, rerender } = renderHook(
      ({ selectedValues }) =>
        useHomeAgentQuestionView({
          runtime: createRuntime("创意方案"),
          qState: null,
          popoverOverride,
          suggested: null,
          selectedValues,
          dismissedProjectSuggestionKeys,
        }),
      {
        initialProps: {
          selectedValues: [],
        },
      },
    );

    expect(result.current.question?.answerKey).toBe("script-creative-plan");

    const suggestionKey = buildProjectSuggestionKey(createRuntime("创意方案").currentProjectSnapshot, popoverOverride);
    expect(suggestionKey).toBeTruthy();
    dismissedProjectSuggestionKeys.add(suggestionKey!);

    rerender({
      selectedValues: ["继续推进角色设定"],
    });

    expect(result.current.question).toBeNull();
  });

  it("keeps an explicitly restored adaptation target-market popover even if it was previously dismissed", () => {
    const runtime = createRuntime("结构转换");
    runtime.currentProjectSnapshot = {
      ...runtime.currentProjectSnapshot!,
      projectKind: "adaptation",
      derivedStage: "结构转换",
    };
    const popoverOverride = createQuestion(
      "script-adaptation-target-market-script-project-1",
      "script-adaptation-target-market",
      "请选择目标市场",
    );
    const dismissedProjectSuggestionKeys = new Set<string>();
    const suggestionKey = buildProjectSuggestionKey(runtime.currentProjectSnapshot, popoverOverride);
    dismissedProjectSuggestionKeys.add(suggestionKey!);

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
        dismissedProjectSuggestionKeys,
      }),
    );

    expect(result.current.question?.answerKey).toBe("script-adaptation-target-market");
  });

  it("filters a stale video bridge prefix popup when the current workflow no longer needs it", () => {
    const runtime = createVideoRuntime();
    const popoverOverride = createQuestion(
      "video-bridge-prefix-video-project-1",
      "video-bridge-prefix",
      "一键补齐平台与镜头偏好",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question).toBeNull();
  });

  it("keeps the current video bridge prefix popup when the workflow still needs platform prefs", () => {
    const runtime = createVideoRuntime({
      targetPlatform: "",
      shotStyle: "",
      outputGoal: "",
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
    });
    const popoverOverride = createQuestion(
      "video-bridge-prefix-video-project-1",
      "video-bridge-prefix",
      "一键补齐平台与镜头偏好",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("video-bridge-prefix");
  });

  it("restores an interrupted video bridge prefix question when no live popover is visible", () => {
    const runtime = createVideoRuntime({
      targetPlatform: "",
      shotStyle: "",
      outputGoal: "",
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
    });
    const interruptedChoiceQuestion = createQuestion(
      "video-bridge-prefix-video-project-1",
      "video-bridge-prefix",
      "一键补齐平台与镜头偏好",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: null,
        interruptedChoiceQuestion,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("video-bridge-prefix");
    expect(result.current.question?.id).toBe(interruptedChoiceQuestion.id);
  });

  it("prefers the more advanced interrupted video bridge panel over a stale stored popover", () => {
    const runtime = createVideoRuntime();
    runtime.currentProjectSnapshot = null;
    runtime.currentVideoProject = null;
    runtime.recentProjects = [];

    const popoverOverride: ComposerQuestion = {
      id: "video-bridge-panel-video-project-1",
      title: "《未命名视频项目》正在完成脚本拆解",
      description: "先把脚本拆成可执行的镜头序列。",
      options: [
        {
          id: "stale-entities",
          label: "提取角色与场景",
          value: "video:bridge:entities",
          rationale: "先把角色和场景实体提出来。",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };
    const interruptedChoiceQuestion: ComposerQuestion = {
      id: "video-bridge-panel-video-project-1",
      title: "《未命名视频项目》正在补角色与场景",
      description: "角色和场景实体已就绪，可以继续生成参考图和分镜图。",
      options: [
        {
          id: "bulk",
          label: "批量执行",
          value: "video:panel:video-bridge-panel-bulk",
          rationale: "适合一口气推进一批素材或状态刷新。",
          children: [
            {
              id: "full",
              label: "智能补图 剩余3（本轮3）",
              value: "video:bridge:reference-assets:full",
              rationale: "按当前生图模型上限分批补齐。",
            },
          ],
        },
      ],
      statusBadges: [
        { label: "角色", value: "2", tone: "default" },
        { label: "场景", value: "1", tone: "default" },
        { label: "缺参考图", value: "3", tone: "warning" },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        interruptedChoiceQuestion,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.title).toBe(interruptedChoiceQuestion.title);
    expect(findQuestionOptionLabel(result.current.question, "video:bridge:reference-assets:full")).toBe(
      "智能补图 剩余3（本轮3）",
    );
  });

  it("keeps a more advanced stored video bridge panel when the rebuilt snapshot lags behind", () => {
    const runtime = createVideoRuntime({
      currentStep: 1,
      characters: [],
      sceneSettings: [],
      scenes: [],
    });

    const storedQuestion: ComposerQuestion = {
      id: "video-bridge-panel-video-project-1",
      title: "《未命名视频项目》正在补角色与场景",
      description: "平台和镜头偏好已经写回，下一步先把角色与场景实体整理出来，再继续后面的镜头包和出片。",
      options: [
        {
          id: "bulk",
          label: "批量执行",
          value: "video:panel:video-bridge-panel-bulk",
          rationale: "适合一口气推进一批素材或状态刷新。",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: storedQuestion,
        interruptedChoiceQuestion: storedQuestion,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.title).toBe(storedQuestion.title);
    expect(findQuestionOptionLabel(result.current.question, "video:panel:video-bridge-panel-bulk")).toBe(
      "批量执行",
    );
  });

  it("uses the current video workflow question as the dev fallback when no popup is visible", () => {
    const runtime = createVideoRuntime();
    const expectedQuestion = recQuestion(runtime.currentProjectSnapshot, runtime.currentVideoProject);

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: null,
        suggested: null,
        selectedValues: [],
        devMode: true,
        buildDevFallbackQuestion: (snapshot, currentRuntime) =>
          recQuestion(snapshot, currentRuntime.currentVideoProject),
      }),
    );

    expect(expectedQuestion).not.toBeNull();
    expect(result.current.question?.answerKey).toBe(expectedQuestion?.answerKey);
    expect(result.current.question?.id).toBe(expectedQuestion?.id);
  });

  it("hides dev-only segment prompt single-list entries when dev mode is off", () => {
    const runtime = createVideoRuntime({
      currentStep: 2,
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
      videoGenerationPrefs: {
        mode: "text-to-video" as const,
        modelKey: "doubao-seedance-1-5-pro" as const,
        resolution: "720p" as const,
      },
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          description: "scene 1",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-1",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "Scene 2",
          description: "scene 2",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
      ],
      characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "loc.png" }],
      shotPackets: [{ id: "packet-1" }],
      segmentVideoPrompts: {
        "1-1": {
          segmentLabel: "1-1",
          prompt: "existing prompt",
          duration: 15,
          targetDuration: 15,
          modelKey: "doubao-seedance-1-5-pro",
          maxDurationForModel: 15,
          sceneIds: ["scene-1"],
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const popoverOverride = buildVideoBridgeQuestion(
      runtime.currentProjectSnapshot!,
      runtime.currentVideoProject,
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
        devMode: false,
      }),
    );

    expect(findQuestionOption(result.current.question, "video:panel:bridge:prompts:segment:ep-group:1")).toBeNull();
    expect(findQuestionOption(result.current.question, "video:bridge:prompts:segment:episode:1")).toBeNull();
    expect(findQuestionOption(result.current.question, "video:bridge:prompts:segment:label:1-1")).toBeNull();
  });

  it("shows dev-only segment prompt single-list entries when dev mode is on", () => {
    const runtime = createVideoRuntime({
      currentStep: 2,
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
      videoGenerationPrefs: {
        mode: "text-to-video" as const,
        modelKey: "doubao-seedance-1-5-pro" as const,
        resolution: "720p" as const,
      },
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          description: "scene 1",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-1",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "Scene 2",
          description: "scene 2",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
      ],
      characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "loc.png" }],
      shotPackets: [{ id: "packet-1" }],
      segmentVideoPrompts: {
        "1-1": {
          segmentLabel: "1-1",
          prompt: "existing prompt",
          duration: 15,
          targetDuration: 15,
          modelKey: "doubao-seedance-1-5-pro",
          maxDurationForModel: 15,
          sceneIds: ["scene-1"],
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const popoverOverride = buildVideoBridgeQuestion(
      runtime.currentProjectSnapshot!,
      runtime.currentVideoProject,
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
        devMode: true,
      }),
    );

    expect(findQuestionOption(result.current.question, "video:panel:bridge:prompts:segment:ep-group:1")).toMatchObject({
      label: "第 1 集（待补 1/2）",
      devOnly: true,
    });
    expect(findQuestionOptionLabel(result.current.question, "video:bridge:prompts:segment:episode:1")).toBe(
      "重建第 1 集片段提示词（2）",
    );
    expect(findQuestionOptionLabel(result.current.question, "video:bridge:prompts:segment:label:1-1")).toBe(
      "重生成 片段 1-1",
    );
  });

  it("falls back to the recent video snapshot when the live project snapshot has not reattached yet", () => {
    const runtime = createVideoRuntime();
    const snapshot = runtime.currentProjectSnapshot!;
    const expectedQuestion = recQuestion(snapshot, runtime.currentVideoProject);
    runtime.currentProjectSnapshot = null;
    runtime.recentProjects = [snapshot];

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: null,
        suggested: null,
        selectedValues: [],
        devMode: true,
        buildDevFallbackQuestion: (currentSnapshot, currentRuntime) =>
          recQuestion(currentSnapshot, currentRuntime.currentVideoProject),
      }),
    );

    expect(expectedQuestion).not.toBeNull();
    expect(result.current.question?.answerKey).toBe(expectedQuestion?.answerKey);
    expect(result.current.question?.id).toBe(expectedQuestion?.id);
  });

  it("hides the video refresh panel while video generation is still running", () => {
    const runtime = createVideoRuntime({
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
          storyboardUrl: "https://example.com/storyboard-1.jpg",
          videoTaskId: "task-1",
          videoStatus: "processing",
        },
      ],
      currentStep: 4,
      analysisSummary: "Video tasks are still running.",
    });
    const refreshQuestion = createQuestion(
      "video-refresh-panel-video-project-1",
      "video-refresh-panel",
      "刷新当前视频进度",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: refreshQuestion,
        suggested: refreshQuestion,
        selectedValues: [],
      }),
    );

    expect(result.current.question).toBeNull();
  });

  it("hides ordinary workflow cards while full-auto is actively running", () => {
    const runtime = createVideoRuntime();
    runtime.fullAutoRun = {
      status: "running",
      plan: {
        id: "full-auto-1",
        projectKind: "script",
        entryTemplateId: "script",
        mode: "original-script-v1",
        createdAt: "2026-05-10T00:00:00.000Z",
        answers: {},
        displayAnswers: {},
        steps: [],
        currentStepIndex: 0,
        retryCounts: {},
      },
      currentStepIndex: 0,
      currentStepLabel: "创意方案",
    };
    const suggested = createQuestion(
      "script-creative-plan-script-project-1",
      "script-creative-plan",
      "生成创作方案",
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride: null,
        suggested,
        selectedValues: [],
      }),
    );

    expect(result.current.question).toBeNull();
  });

  it("rebuilds the open video preview panel when preview candidates change", () => {
    const buildScenes = (count: number) => [
      {
        id: "scene-complete",
        sceneNumber: 1,
        sceneName: "Completed Scene",
        description: "completed scene",
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "scene-complete.png",
        videoUrl: "scene-complete.mp4",
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `scene-${index + 2}`,
        sceneNumber: index + 2,
        sceneName: `Scene ${index + 2}`,
        description: `scene ${index + 2}`,
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: `scene-${index + 2}.png`,
      })),
    ];
    const baseProject = {
      currentStep: 5,
      kickoffModeConfirmed: true,
      videoGenerationPrefs: {
        mode: "image-to-video" as const,
        modelKey: "doubao-seedance-1-5-pro" as const,
        resolution: "720p" as const,
      },
      scenes: buildScenes(4),
    };
    const runtime = createVideoRuntime(baseProject);
    const popoverOverride = buildVideoContinuationQuestion(
      runtime.currentProjectSnapshot!,
      runtime.currentVideoProject,
    );

    const { result, rerender } = renderHook(
      ({ nextRuntime }) =>
        useHomeAgentQuestionView({
          runtime: nextRuntime,
          qState: null,
          popoverOverride,
          suggested: null,
          selectedValues: [],
        }),
      {
        initialProps: {
          nextRuntime: runtime,
        },
      },
    );

    expect(result.current.question?.answerKey).toBe("review-stage-panel");
    expect(findQuestionOptionLabel(result.current.question, "video:generate:first")).toBe(
      "智能生成镜头 3/4",
    );

    const nextRuntime = createVideoRuntime({
      ...baseProject,
      scenes: buildScenes(12),
    });

    rerender({ nextRuntime });

    expect(findQuestionOptionLabel(result.current.question, "video:generate:first")).toBe(
      "智能生成镜头 3/12",
    );
  });

  it("keeps the post-breakdown handoff on the script-breakdown panel while rebuilding an open video bridge panel", () => {
    const runtime = createVideoRuntime({
      currentStep: 2,
      scriptBreakdownPassed: true,
      kickoffModeConfirmed: false,
      targetPlatform: "douyin",
      shotStyle: "cinematic close-up",
      outputGoal: "trailer",
      scenes: Array.from({ length: 6 }, (_, index) => ({
        id: `scene-${index + 1}`,
        sceneNumber: index + 1,
        sceneName: `Scene ${index + 1}`,
        description: `scene ${index + 1}`,
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "",
      })),
    });
    const popoverOverride = buildVideoContinuationQuestion(
      runtime.currentProjectSnapshot!,
      runtime.currentVideoProject,
    );

    const { result } = renderHook(() =>
      useHomeAgentQuestionView({
        runtime,
        qState: null,
        popoverOverride,
        suggested: null,
        selectedValues: [],
      }),
    );

    expect(result.current.question?.answerKey).toBe("video-bridge-panel");
    expect(findQuestionOptionLabel(result.current.question, "video:bridge:next-step")).toBe(
      "下一步",
    );
    expect(findQuestionOptionLabel(result.current.question, "video:bridge:entities")).toBeNull();
  });

  it("rebuilds the open video bridge panel when image-model batch prefs change", () => {
    const baseProject = {
      currentStep: 3,
      kickoffModeConfirmed: true,
      scenes: Array.from({ length: 12 }, (_, index) => ({
        id: `scene-${index + 1}`,
        sceneNumber: index + 1,
        sceneName: `Scene ${index + 1}`,
        description: `scene ${index + 1}`,
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "",
      })),
      characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }],
      sceneSettings: Array.from({ length: 12 }, (_, index) => ({
        id: `setting-${index + 1}`,
        name: `Scene ${index + 1}`,
        description: "desc",
        imageUrl: `scene-${index + 1}.png`,
      })),
    };
    const runtime = createVideoRuntime(baseProject);
    const popoverOverride = buildVideoBridgeQuestion(
      runtime.currentProjectSnapshot!,
      runtime.currentVideoProject,
    );

    const { result, rerender } = renderHook(
      ({ nextRuntime }) =>
        useHomeAgentQuestionView({
          runtime: nextRuntime,
          qState: null,
          popoverOverride,
          suggested: null,
          selectedValues: [],
        }),
      {
        initialProps: {
          nextRuntime: runtime,
        },
      },
    );

    expect(findQuestionOptionLabel(result.current.question, "video:bridge:storyboard-frames")).toBe("智能补图 剩余12（本轮8）");

    const nextRuntime = createVideoRuntime({
      ...baseProject,
      imageGenerationPrefs: {
        familyKey: "gpt-image-2",
        resolution: "4k",
        aspectRatio: "16:9",
        styleCategory: "realistic",
        stylePreset: "live-action",
        viewMode: "three",
      },
    });

    rerender({ nextRuntime });

    expect(findQuestionOptionLabel(result.current.question, "video:bridge:storyboard-frames")).toBe("智能补图 剩余12（本轮2）");
  });
});
