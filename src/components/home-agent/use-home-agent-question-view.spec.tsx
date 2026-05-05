import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComposerQuestion, StudioRuntimeState } from "@/lib/home-agent/types";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import { buildProjectSuggestionKey } from "./home-agent-session-utils";
import { recQuestion } from "./home-agent-project-questions";
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

  it("filters the legacy video bridge prefix popup even if it is restored from session state", () => {
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
    const refreshQuestion = recQuestion(runtime.currentProjectSnapshot, runtime.currentVideoProject);

    expect(refreshQuestion?.answerKey).toBe("video-refresh-panel");

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
});
