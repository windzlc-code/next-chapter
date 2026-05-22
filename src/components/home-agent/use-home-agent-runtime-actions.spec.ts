import { describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ConversationProjectSnapshot, FullAutoRunPlan, FullAutoRunStep } from "@/lib/home-agent/types";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import {
  applyFullAutoWorkflowFollowupQuestion,
  applyVideoKickoffFollowupQuestion,
  applyWorkflowMediaFollowupQuestion,
  buildFullAutoExecutionUserMessage,
  buildFullAutoProxyUserMessage,
  buildFullAutoRetryAssistantMessage,
  buildFullAutoRetryUserMessage,
  buildFullAutoCollectionPlaceholderSnapshot,
  buildLlmConversationOverlay,
  buildScriptWorkflowBlockedMediaActionReplyPrompt,
  buildScriptWorkflowSkipAheadReply,
  buildFullAutoBatchExecutionUserMessage,
  buildFreeConversationProjectSnapshot,
  buildHomepageConversationSnapshotFromMessages,
  buildFullAutoVideoExportPathConfirmQuestion,
  isStalledFullAutoReferenceAssetBatch,
  isStalledFullAutoVideoGenerationBatch,
  isBridgeableVideoWorkflowSourceSnapshot,
  isBlockedScriptWorkflowMediaAction,
  isHomepageConversationPlaceholderSnapshot,
  normalizeFullAutoRunStateForRestore,
  replacePlaceholderRecentProject,
  resolveFullAutoRuntimeProjectId,
  resolveFullAutoBatchExecutionState,
  shouldContinueFullAutoBatchExecution,
  shouldResetForFullAutoTemplateLaunch,
  shouldIgnoreFullAutoExecutionUpdate,
  shouldAutoRetryRecoverableFullAutoStep,
  throwIfAborted,
  waitForAbortableDelay,
} from "./use-home-agent-runtime-actions";
import type { HomeAgentMessage } from "@/lib/home-agent/types";

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

function createVideoRuntime(
  overrides: Partial<PersistedVideoProject> = {},
): {
  currentProjectSnapshot: ConversationProjectSnapshot;
  currentVideoProject: PersistedVideoProject;
} {
  const currentVideoProject = createVideoProject(overrides);
  return {
    currentProjectSnapshot: createVideoSnapshot(currentVideoProject),
    currentVideoProject,
  };
}

function createFullAutoStep(overrides: Partial<FullAutoRunStep> = {}): FullAutoRunStep {
  return {
    id: "video-analyze",
    label: "执行剧本拆解",
    status: "running",
    workflowAction: "analyze_script_for_video",
    ...overrides,
  };
}

function createFullAutoPlan(overrides: Partial<FullAutoRunPlan> = {}): FullAutoRunPlan {
  const step = createFullAutoStep();
  return {
    id: "full-auto-plan-1",
    projectKind: "video",
    entryTemplateId: "video-workflow",
    mode: "video-workflow-v1",
    createdAt: "2026-05-13T00:00:00.000Z",
    setupInput: {},
    answers: {},
    displayAnswers: {},
    steps: [step],
    plannedSteps: [step],
    currentStepIndex: 0,
    retryCounts: {},
    ...overrides,
  };
}

describe("applyVideoKickoffFollowupQuestion", () => {
  it("opens the duration gate when the bridged video project lands in script analysis", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();
    const projectSnapshot = createSnapshot();
    const videoProject = createVideoProject();

    const handled = applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot,
        data: { videoProject },
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(push).not.toHaveBeenCalled();
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "video:bridge:entities" }),
        ]),
      }),
    );
  });

  it("pushes a completion message before opening the duration gate once all fields are written", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();
    const projectSnapshot = createSnapshot();
    const videoProject = createVideoProject({
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
    });

    applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot,
        data: { videoProject },
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(push).toHaveBeenCalledWith(
      "assistant",
      "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002",
    );
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "video:bridge:entities" }),
        ]),
      }),
    );
  });

  it("does nothing once the bridged project has already moved past script analysis", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const push = vi.fn();

    const handled = applyVideoKickoffFollowupQuestion({
      workflowCompletion: {
        projectSnapshot: createSnapshot({ derivedStage: "角色与场景" }),
      },
      setSuggested,
      setPopoverOverride,
      push,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("buildFullAutoVideoExportPathConfirmQuestion", () => {
  it("turns a picked export folder into a final confirmation question", () => {
    const question = {
      id: "full-auto-video-export-path",
      title: "视频导出目录",
      description: "先选择导出目录，确认后再写入当前预采集策略。",
      options: [{ id: "pick", label: "选择导出目录", value: "video:export:path:pick" }],
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 9,
      totalSteps: 10,
      answerKey: "full-auto-preflight:videoExportPath",
    };

    const confirmQuestion = buildFullAutoVideoExportPathConfirmQuestion(question, "E:/Exports");

    expect(confirmQuestion.id).toContain(":confirm-path");
    expect(confirmQuestion.answerKey).toBe("full-auto-preflight:videoExportPath");
    expect(confirmQuestion.description).toContain("确认后");
    expect(confirmQuestion.options).toEqual([
      expect.objectContaining({
        label: "确认使用该导出目录",
        value: "video:export:path:E%3A%2FExports",
        rationale: "E:/Exports",
      }),
    ]);
  });
});

describe("full-auto recoverable retry helpers", () => {
  it("labels retry user bubbles with the next attempt number", () => {
    expect(
      buildFullAutoRetryUserMessage({
        baseMessage: "执行剧本拆解：中节奏",
        attempt: 2,
      }),
    ).toBe("执行剧本拆解：中节奏（第 2 次尝试）");
  });

  it("formats assistant retry copy for an internal attempt", () => {
    expect(
      buildFullAutoRetryAssistantMessage({
        stepLabel: "执行剧本拆解",
        error: new Error("拆解结果对白字数超限：1-4 中“台词”超过 22 字。"),
        nextAttempt: 2,
        stage: "attempt",
      }),
    ).toContain("AI 代理会继续发起第 2 次尝试");
  });

  it("keeps retrying recoverable full-auto video analyze failures within the retry budget", () => {
    const plan = createFullAutoPlan();
    const step = createFullAutoStep();

    expect(
      shouldAutoRetryRecoverableFullAutoStep({
        plan,
        step,
        error: new Error("剧本拆解多次重试仍未成功：拆解结果对白字数超限：1-4 中“台词”超过 22 字。"),
      }),
    ).toBe(true);
  });

  it("stops automatic reruns for fatal quota/configuration failures", () => {
    const plan = createFullAutoPlan();
    const step = createFullAutoStep();

    expect(
      shouldAutoRetryRecoverableFullAutoStep({
        plan,
        step,
        error: new Error("模型调用失败 (403): insufficient_user_quota"),
      }),
    ).toBe(false);
  });

  it("stops automatic reruns once the configured round budget is exhausted", () => {
    const step = createFullAutoStep();
    const plan = createFullAutoPlan({
      retryCounts: {
        [step.id]: 8,
      },
    });

    expect(
      shouldAutoRetryRecoverableFullAutoStep({
        plan,
        step,
        error: new Error("剧本拆解多次重试仍未成功：拆解结果对白字数超限。"),
      }),
    ).toBe(false);
  });

  it("retries a stalled reference-asset step within the recoverable round budget", () => {
    const step = createFullAutoStep({
      id: "video-reference-assets",
      label: "角色与场景资产补齐",
      workflowAction: "generate_video_reference_assets",
    });
    const plan = createFullAutoPlan({
      steps: [step],
      plannedSteps: [step],
    });

    expect(
      shouldAutoRetryRecoverableFullAutoStep({
        plan,
        step,
        error: new Error("参考资产自动补齐未取得进展，当前还有 3 个待补齐目标。"),
      }),
    ).toBe(true);
  });

  it("retries a stalled video-generation step within the recoverable round budget", () => {
    const step = createFullAutoStep({
      id: "video-generate",
      label: "视频生成",
      workflowAction: "generate_segment_video",
    });
    const plan = createFullAutoPlan({
      steps: [step],
      plannedSteps: [step],
    });

    expect(
      shouldAutoRetryRecoverableFullAutoStep({
        plan,
        step,
        error: new Error("视频批次自动续跑未取得进展，当前还有 2 个待处理目标。"),
      }),
    ).toBe(true);
  });
});

describe("shouldResetForFullAutoTemplateLaunch", () => {
  it("forces a fresh full-auto surface when the user is still on a manual conversation", () => {
    expect(
      shouldResetForFullAutoTemplateLaunch({
        automationMode: "full-auto",
        currentProjectSnapshot: createSnapshot({ automationMode: "manual" }),
        activeProjectId: "video-project-1",
        messages: [
          {
            id: "manual-msg-1",
            role: "assistant",
            content: "manual history",
            createdAt: "2026-05-12T00:00:00.000Z",
            status: "complete",
          },
        ],
      }),
    ).toBe(true);
  });

  it("keeps the current surface when the user is already inside a full-auto conversation", () => {
    expect(
      shouldResetForFullAutoTemplateLaunch({
        automationMode: "full-auto",
        currentProjectSnapshot: createSnapshot({ automationMode: "full-auto" }),
        activeProjectId: "video-project-1",
        messages: [
          {
            id: "auto-msg-1",
            role: "assistant",
            content: "full-auto history",
            createdAt: "2026-05-12T00:00:00.000Z",
            status: "complete",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("applyWorkflowMediaFollowupQuestion", () => {
  it("re-opens the preferred followup popup after media generation completes", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const preferredQuestion = {
      id: "media-followup",
      title: "继续下一步",
      options: [{ id: "next", label: "继续", value: "continue" }],
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "media-followup",
    };

    const handled = applyWorkflowMediaFollowupQuestion({
      preferredQuestion,
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(preferredQuestion);
  });

  it("falls back to the workflow question derived from runtime when no preferred popup is provided", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot(),
      runtime: {
        currentVideoProject: createVideoProject(),
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "video:bridge:entities" }),
        ]),
      }),
    );
  });

  it("does not open a followup popup while video generation is still running", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot(),
      runtime: {
        currentVideoProject: createVideoProject({
          scenes: [
            {
              id: "scene-1",
              sceneNumber: 1,
              sceneName: "雨夜追击",
              description: "desc",
              characters: [],
              dialogue: "",
              cameraDirection: "",
              duration: 5,
              videoTaskId: "task-1",
              videoStatus: "processing",
            },
          ],
        }),
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
  });

  it("does nothing when the current runtime cannot produce a next-step popup", () => {
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyWorkflowMediaFollowupQuestion({
      projectSnapshot: createSnapshot({
        projectKind: "script",
        derivedStage: "未知阶段",
        recommendedActions: [],
      }),
      runtime: {
        currentVideoProject: null,
      },
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(false);
    expect(setSuggested).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
  });
});

describe("applyFullAutoWorkflowFollowupQuestion", () => {
  it("normalizes a stale running full-auto session into a resumable stopped state after restore", () => {
    const runtime = createVideoRuntime();
    const run = {
      status: "running" as const,
      plan: createFullAutoPlan({
        resumeFromStepId: "video-analyze",
      }),
      currentStepIndex: 0,
      currentStepLabel: "脚本拆解",
    };

    const normalized = normalizeFullAutoRunStateForRestore({
      run,
      runtime,
      hasActiveExecution: false,
    });

    expect(normalized).toEqual(
      expect.objectContaining({
        status: "stopped",
        currentStepIndex: 1,
        plan: expect.objectContaining({
          resumeFromStepId: "video-analyze",
          stoppedStepId: "video-analyze",
        }),
      }),
    );
  });

  it("surfaces the current-step question as a homepage suggestion after a full-auto step completes", () => {
    const runtime = createVideoRuntime();
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();

    const handled = applyFullAutoWorkflowFollowupQuestion({
      runtime,
      setSuggested,
      setPopoverOverride,
    });

    expect(handled).toBe(true);
    expect(setPopoverOverride).toHaveBeenCalledWith(null);
    expect(setSuggested).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-panel",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "video:bridge:entities" }),
        ]),
      }),
    );
  });

  it("restores the current-step popover when full-auto stops", () => {
    const runtime = createVideoRuntime();
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const run = {
      status: "stopped" as const,
      plan: createFullAutoPlan({
        resumeFromStepId: "video-analyze",
      }),
      currentStepIndex: 0,
    };

    const handled = applyFullAutoWorkflowFollowupQuestion({
      run,
      runtime,
      setSuggested,
      setPopoverOverride,
      forcePopover: true,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "full-auto-resume",
        options: [
          expect.objectContaining({
            value: "full-auto:resume-current-task",
          }),
        ],
      }),
    );
  });

  it("surfaces only the full-auto resume option when export is reached but pending video work remains", () => {
    const runtime = {
      currentProjectSnapshot: createSnapshot({
        derivedStage: "预览与导出",
      }),
      currentVideoProject: createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "镜头 1",
            storyboardUrl: "board-1.png",
            enhancedVideoPrompt: "prompt 1",
          },
        ] as PersistedVideoProject["scenes"],
      }),
    };
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const steps = [
      createFullAutoStep({
        id: "video-prompts",
        label: "准备视频提示词",
        status: "completed",
        workflowAction: "prepare_video_prompt_batch",
      }),
      createFullAutoStep({
        id: "video-generate",
        label: "视频生成",
        status: "completed",
        workflowAction: "generate_video_assets",
      }),
      createFullAutoStep({
        id: "video-export",
        label: "预览导出",
        status: "completed",
        workflowAction: "export_video_assets",
      }),
    ];
    const run = {
      status: "completed" as const,
      plan: createFullAutoPlan({
        steps,
        plannedSteps: steps,
        currentStepIndex: 2,
      }),
      currentStepIndex: 2,
    };

    const handled = applyFullAutoWorkflowFollowupQuestion({
      run,
      runtime,
      setSuggested,
      setPopoverOverride,
      forcePopover: true,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "full-auto-resume",
        options: [
          expect.objectContaining({
            value: "full-auto:resume-current-task",
          }),
        ],
      }),
    );
  });

  it("shows a disabled completion panel when all full-auto tasks are truly finished", () => {
    const runtime = {
      currentProjectSnapshot: createSnapshot({
        derivedStage: "预览与导出",
      }),
      currentVideoProject: createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "镜头 1",
            storyboardUrl: "board-1.png",
            enhancedVideoPrompt: "prompt 1",
            videoUrl: "https://example.com/scene-1.mp4",
            videoStatus: "completed",
          },
        ] as PersistedVideoProject["scenes"],
      }),
    };
    const setSuggested = vi.fn();
    const setPopoverOverride = vi.fn();
    const steps = [
      createFullAutoStep({
        id: "video-generate",
        label: "视频生成",
        status: "completed",
        workflowAction: "generate_video_assets",
      }),
      createFullAutoStep({
        id: "video-export",
        label: "预览导出",
        status: "completed",
        workflowAction: "export_video_assets",
      }),
    ];
    const run = {
      status: "completed" as const,
      plan: createFullAutoPlan({
        steps,
        plannedSteps: steps,
        currentStepIndex: 1,
      }),
      currentStepIndex: 1,
    };

    const handled = applyFullAutoWorkflowFollowupQuestion({
      run,
      runtime,
      setSuggested,
      setPopoverOverride,
      forcePopover: true,
    });

    expect(handled).toBe(true);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "full-auto-completed",
        options: [
          expect.objectContaining({
            disabled: true,
          }),
        ],
      }),
    );
  });
});

describe("buildFullAutoProxyUserMessage", () => {
  it("uses ordinary workflow-style action copy for the creative-plan step", () => {
    expect(
      buildFullAutoProxyUserMessage({
        label: "创意方案",
        workflowAction: "generate_creative_plan",
      }),
    ).toBe("生成创作方案");
  });

  it("falls back to the original step label for unmapped actions", () => {
    expect(
      buildFullAutoProxyUserMessage({
        label: "自定义步骤",
        workflowAction: "custom_workflow_action",
      }),
    ).toBe("自定义步骤");
  });
});

describe("buildFullAutoExecutionUserMessage", () => {
  it("reuses the collected strategy label once execution reaches the matching step", () => {
    expect(
      buildFullAutoExecutionUserMessage(
        {
          stageStrategies: {
            episodeWriting: {
              key: "episodeWriting",
              phase: "正文撰写",
              value: "script:episode-generate-batch",
              label: "按集分批生成",
            },
          },
          displayAnswers: {},
        } as never,
        {
          label: "正文撰写",
          workflowAction: "generate_episode_batch",
          strategyKey: "episodeWriting",
        },
      ),
    ).toBe("按集分批生成");
  });

  it("falls back to the original proxy copy when the step has no collected strategy label", () => {
    expect(
      buildFullAutoExecutionUserMessage(
        {
          stageStrategies: {},
          displayAnswers: {},
        } as never,
        {
          label: "创作方案",
          workflowAction: "generate_creative_plan",
        },
      ),
    ).toBe("生成创作方案");
  });
});

describe("resolveFullAutoBatchExecutionState", () => {
  it("splits full-auto segment video generation into 3-item batches", () => {
    const runtime = createVideoRuntime({
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "镜头一",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-1",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "镜头二",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
        {
          id: "scene-3",
          sceneNumber: 3,
          sceneName: "镜头三",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-3",
        },
        {
          id: "scene-4",
          sceneNumber: 4,
          sceneName: "镜头四",
          description: "desc",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-4",
        },
      ],
      segmentVideoPrompts: {
        "1-1": { segmentLabel: "1-1", prompt: "p1", duration: 5, sceneIds: ["scene-1"], generatedAt: "2026-05-13T00:00:00.000Z" },
        "1-2": { segmentLabel: "1-2", prompt: "p2", duration: 5, sceneIds: ["scene-2"], generatedAt: "2026-05-13T00:00:00.000Z" },
        "1-3": { segmentLabel: "1-3", prompt: "p3", duration: 5, sceneIds: ["scene-3"], generatedAt: "2026-05-13T00:00:00.000Z" },
        "1-4": { segmentLabel: "1-4", prompt: "p4", duration: 5, sceneIds: ["scene-4"], generatedAt: "2026-05-13T00:00:00.000Z" },
      },
    });

    const batchState = resolveFullAutoBatchExecutionState({
      action: "generate_segment_video",
      input: {
        projectId: runtime.currentVideoProject.id,
        batchMode: "first",
      },
      runtime: {
        currentProjectSnapshot: runtime.currentProjectSnapshot,
        currentVideoProject: runtime.currentVideoProject,
      } as never,
    });

    expect(batchState.batchable).toBe(true);
    expect(batchState.selectedCount).toBe(3);
    expect(batchState.remainingCount).toBe(1);
    expect(batchState.targetIds).toEqual(["1-1", "1-2", "1-3"]);
  });

  it("treats smart-batch reference assets as batched media work", () => {
    const runtime = createVideoRuntime({
      characters: [
        { id: "c1", name: "角色一", description: "desc", costumes: [] },
        { id: "c2", name: "角色二", description: "desc", costumes: [] },
      ],
      sceneSettings: [
        { id: "s1", name: "场景一", description: "desc", timeVariants: [] },
        { id: "s2", name: "场景二", description: "desc", timeVariants: [] },
      ],
    });

    const batchState = resolveFullAutoBatchExecutionState({
      action: "generate_video_reference_assets",
      input: {
        projectId: runtime.currentVideoProject.id,
        smartBatch: true,
        batchLimit: 3,
        targetIds: [
          "reference-character:c1",
          "reference-character:c2",
          "reference-scene:s1",
          "reference-scene:s2",
        ],
      },
      runtime: {
        currentProjectSnapshot: runtime.currentProjectSnapshot,
        currentVideoProject: runtime.currentVideoProject,
      } as never,
    });

    expect(batchState.batchable).toBe(true);
    expect(batchState.selectedCount).toBe(3);
    expect(batchState.remainingCount).toBe(1);
  });

  it("continues into a final short batch when the next signature changes", () => {
    expect(
      shouldContinueFullAutoBatchExecution({
        currentBatchState: {
          signature: "image:reference-character:c1|reference-character:c2|reference-scene:s1",
        },
        nextBatchState: {
          selectedCount: 1,
          signature: "image:reference-scene:s2",
        },
      }),
    ).toBe(true);
  });

  it("detects a stalled reference-asset batch when the next selection repeats", () => {
    expect(
      isStalledFullAutoReferenceAssetBatch({
        action: "generate_video_reference_assets",
        currentBatchState: {
          signature: "image:reference-character:c1|reference-scene:s1",
        },
        nextBatchState: {
          selectedCount: 2,
          signature: "image:reference-character:c1|reference-scene:s1",
        },
      }),
    ).toBe(true);
  });

  it("detects a stalled video batch when the next selection repeats the same targets", () => {
    expect(
      isStalledFullAutoVideoGenerationBatch({
        action: "generate_video_assets",
        currentBatchState: {
          signature: "video:scene-1|scene-2|scene-3",
        },
        nextBatchState: {
          selectedCount: 3,
          signature: "video:scene-1|scene-2|scene-3",
        },
      }),
    ).toBe(true);
  });

  it("detects a stalled video batch when the next remaining selection repeats", () => {
    expect(
      isStalledFullAutoVideoGenerationBatch({
        action: "generate_video_assets",
        currentBatchState: {
          signature: "video:scene-1|scene-2|scene-3",
        },
        nextBatchState: {
          selectedCount: 3,
          signature: "video:scene-1|scene-2|scene-3",
        },
      }),
    ).toBe(true);
  });
});

describe("buildFullAutoBatchExecutionUserMessage", () => {
  it("annotates later full-auto batches with their batch size and remainder", () => {
    expect(
      buildFullAutoBatchExecutionUserMessage({
        baseMessage: "视频生成",
        action: "generate_segment_video",
        batchIndex: 2,
        selectedCount: 3,
        remainingCount: 1,
      }),
    ).toContain("第 2 批");
  });
});

describe("buildFreeConversationProjectSnapshot", () => {
  it("creates a lightweight recoverable snapshot for a free homepage conversation", () => {
    const snapshot = buildFreeConversationProjectSnapshot({
      projectId: "session-free-chat-1",
      userPrompt: "我想做一个都市悬疑短剧，节奏更快一点",
      latestAssistantText: "我先帮你把都市悬疑的核心冲突和人物关系理一下，再继续往下展开。",
      automationMode: "manual",
      updatedAt: "2026-05-07T12:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      projectId: "session-free-chat-1",
      projectKind: "script",
      title: "都市悬疑短剧",
      currentObjective: "继续当前对话",
      derivedStage: "历史对话",
      recommendedActions: [],
      automationMode: "manual",
      updatedAt: "2026-05-07T12:00:00.000Z",
    });
    expect(snapshot.agentSummary).toContain("都市悬疑");
  });

  it("prefers an explicit assistant-provided project title when available", () => {
    const snapshot = buildFreeConversationProjectSnapshot({
      projectId: "session-free-chat-2",
      userPrompt: "帮我搭一个新的故事项目",
      latestAssistantText: "建议项目名称：《雾港来信》\n我先把人物关系和悬疑线索整理出来。",
      automationMode: "full-auto",
    });

    expect(snapshot.title).toBe("雾港来信");
    expect(snapshot.automationMode).toBe("full-auto");
  });
});

describe("buildFullAutoCollectionPlaceholderSnapshot", () => {
  it("creates a full-auto placeholder snapshot as soon as setup is confirmed", () => {
    const snapshot = buildFullAutoCollectionPlaceholderSnapshot({
      sessionId: "session-full-auto-1",
      userPrompt: "项目设定：美食治愈 / 职场现实 / 24 集",
    });

    expect(snapshot).toMatchObject({
      projectId: "session-full-auto-1",
      projectKind: "script",
      currentObjective: "继续当前对话",
      derivedStage: "历史对话",
      automationMode: "full-auto",
    });
  });
});

describe("shouldIgnoreFullAutoExecutionUpdate", () => {
  it("ignores stale full-auto updates after a stop or restart invalidates the old execution epoch", () => {
    expect(
      shouldIgnoreFullAutoExecutionUpdate({
        executionEpoch: 2,
        currentExecutionEpoch: 3,
      }),
    ).toBe(true);
  });

  it("ignores updates once the captured abort signal has been cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      shouldIgnoreFullAutoExecutionUpdate({
        executionEpoch: 4,
        currentExecutionEpoch: 4,
        signal: controller.signal,
      }),
    ).toBe(true);
  });

  it("keeps current-step updates when the execution is still the active one", () => {
    expect(
      shouldIgnoreFullAutoExecutionUpdate({
        executionEpoch: 5,
        currentExecutionEpoch: 5,
      }),
    ).toBe(false);
  });
});

describe("replacePlaceholderRecentProject", () => {
  it("replaces the lightweight placeholder card once the real project snapshot arrives", () => {
    const placeholder = buildFullAutoCollectionPlaceholderSnapshot({
      sessionId: "session-full-auto-1",
      userPrompt: "项目设定：美食治愈 / 职场现实 / 24 集",
    });
    const realSnapshot = createSnapshot({
      projectId: "script-project-1",
      projectKind: "script",
      title: "美食治愈职场短剧",
      currentObjective: "继续创意方案",
      derivedStage: "创意方案",
      automationMode: "full-auto",
    });

    const merged = replacePlaceholderRecentProject({
      recentProjects: [placeholder],
      previousSnapshot: placeholder,
      nextSnapshot: realSnapshot,
    });

    expect(merged).toEqual([realSnapshot]);
  });

  it("prunes a stale full-auto placeholder even when the latest sync only has the real snapshot", () => {
    const placeholder = buildFullAutoCollectionPlaceholderSnapshot({
      sessionId: "session-full-auto-2",
      userPrompt: "项目设定：美食治愈 / 职场现实 / 24 集",
    });
    const realSnapshot = createSnapshot({
      projectId: "script-project-2",
      projectKind: "script",
      title: "美食治愈职场短剧",
      currentObjective: "继续创意方案",
      derivedStage: "创意方案",
      automationMode: "full-auto",
    });

    const merged = replacePlaceholderRecentProject({
      recentProjects: [placeholder, realSnapshot],
      previousSnapshot: null,
      nextSnapshot: realSnapshot,
    });

    expect(merged).toEqual([realSnapshot]);
  });

  it("can preserve older full-auto placeholder histories during sidebar sync", () => {
    const placeholder = buildFullAutoCollectionPlaceholderSnapshot({
      sessionId: "session-full-auto-history",
      userPrompt: "椤圭洰璁惧畾锛氬彜瑁?/ 鍥藉唴锛堜腑鏂囷級 / 瀹枟",
    });
    const realSnapshot = createSnapshot({
      projectId: "script-project-history",
      projectKind: "script",
      title: "瀹枟鍘嗗彶浼氳瘽",
      currentObjective: "缁х画瑙掕壊寮€鍙?",
      derivedStage: "瑙掕壊寮€鍙?",
      automationMode: "full-auto",
    });

    const merged = replacePlaceholderRecentProject({
      recentProjects: [placeholder, realSnapshot],
      previousSnapshot: null,
      nextSnapshot: realSnapshot,
      pruneStaleFullAutoPlaceholders: false,
    });

    expect(merged).toEqual([placeholder, realSnapshot]);
  });

  it("reuses the current array when no placeholder needs pruning and the snapshot is unchanged", () => {
    const realSnapshot = createSnapshot({
      projectId: "script-project-3",
      projectKind: "script",
      title: "稳定项目",
      currentObjective: "继续创意方案",
      derivedStage: "创意方案",
      automationMode: "full-auto",
    });

    const recentProjects = [realSnapshot];
    const merged = replacePlaceholderRecentProject({
      recentProjects,
      previousSnapshot: null,
      nextSnapshot: realSnapshot,
    });

    expect(merged).toBe(recentProjects);
  });
});

describe("isBlockedScriptWorkflowMediaAction", () => {
  it("blocks media actions for active script workflow stages", () => {
    expect(
      isBlockedScriptWorkflowMediaAction(
        createSnapshot({
          projectKind: "script",
          derivedStage: "创作方案",
        }),
      ),
    ).toBe(true);
  });

  it("does not block free homepage placeholder snapshots", () => {
    expect(
      isBlockedScriptWorkflowMediaAction(
        buildFreeConversationProjectSnapshot({
          projectId: "free-1",
          userPrompt: "我想聊一个新故事",
          automationMode: "manual",
        }),
      ),
    ).toBe(false);
  });

  it("does not block active video projects", () => {
    expect(
      isBlockedScriptWorkflowMediaAction(
        createSnapshot({
          projectKind: "video",
          derivedStage: "脚本拆解",
        }),
      ),
    ).toBe(false);
  });
});

describe("buildScriptWorkflowSkipAheadReply", () => {
  it("includes stage context, summary, and concrete current-step guidance", () => {
    const reply = buildScriptWorkflowSkipAheadReply({
      snapshot: createSnapshot({
        projectKind: "script",
        derivedStage: "创作方案",
        currentObjective: "先确认人物关系和核心冲突",
        agentSummary: "已经整理出主角、反派和主要冲突方向。",
        recommendedActions: ["继续完善人物设定", "补齐故事走向"],
      }),
      mediaAction: "video",
      question: {
        id: "creative-plan",
        title: "下一步：进入角色开发",
        description: "先把主要角色的人设和关系轴补完整。",
        options: [
          { id: "1", label: "进入角色开发", value: "go-character", rationale: "" },
          { id: "2", label: "调整创作方案", value: "revise-plan", rationale: "" },
        ],
        allowCustomInput: true,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
        answerKey: "creative-plan",
      },
    });

    expect(reply).toContain("我先不直接执行视频生成");
    expect(reply).toContain("当前阶段目标：先确认人物关系和核心冲突");
    expect(reply).toContain("前面已经整理出的内容：已经整理出主角、反派和主要冲突方向");
    expect(reply).toContain("当前最该完成的是「下一步：进入角色开发」");
    expect(reply).toContain("你可以直接选择 进入角色开发 / 调整创作方案");
    expect(reply).toContain("下一步建议：");
  });
});

describe("buildScriptWorkflowBlockedMediaActionReplyPrompt", () => {
  it("asks the llm to analyze the input but stay on the current unfinished step", () => {
    const prompt = buildScriptWorkflowBlockedMediaActionReplyPrompt({
      snapshot: createSnapshot({
        projectKind: "script",
        derivedStage: "创作方案",
        currentObjective: "先确认人物关系和核心冲突",
        agentSummary: "已整理出主角、反派和主要冲突方向。",
      }),
      userInput: "直接生成图片，我想要月光下的白月光感海报",
      mediaAction: "image",
      question: {
        id: "creative-plan",
        title: "下一步：进入角色开发",
        description: "先把主要角色的人设和关系补完整。",
        options: [
          { id: "1", label: "进入角色开发", value: "go-character", rationale: "" },
        ],
        allowCustomInput: true,
        submissionMode: "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
        answerKey: "creative-plan",
      },
    });

    expect(prompt).toContain("用户提到了图片生成或后续制作意图");
    expect(prompt).toContain("如果里面有对当前步骤有用的信息，就吸收并明确说明会按当前步骤使用");
    expect(prompt).toContain("不要建议跳过、绕过、提前进入后续阶段");
    expect(prompt).toContain("不要回顾一大串已完成步骤");
    expect(prompt).toContain("下一步建议");
  });
});

describe("buildLlmConversationOverlay", () => {
  it("keeps the llm in guide mode while still allowing HomeStudioWorkflow for the current step", () => {
    const overlay = buildLlmConversationOverlay({
      runtime: {
        currentProjectSnapshot: createSnapshot({
          projectKind: "script",
          derivedStage: "创作方案",
          recommendedActions: ["继续完善人物设定"],
        }),
        currentDramaProject: null,
        currentVideoProject: null,
        recentProjects: [],
        recentMessageSummary: "",
        skillDrafts: [],
        maintenanceReports: [],
      },
      deferredQuestionState: null,
    });

    expect(overlay).toContain(
      "Natural-language explanation, brainstorming, comparison, and concise examples are allowed",
    );
    expect(overlay).toContain("Do not repeat outputs or details from already-completed steps");
    expect(overlay).toContain("If the user asks for something you cannot truly complete in the current workflow state");
    expect(overlay).toContain("HomeStudioWorkflow is allowed, but only for real executable actions inside the current unfinished step");
    expect(overlay).toContain(
      "Do not pretend that workflow-only artifacts, downstream media, or later-stage execution already happened in plain text.",
    );
    expect(overlay).toContain("Do not recap already-completed step content unless the user explicitly asks for review.");
    expect(overlay).toContain("If the user gives off-step information while asking for a later media step");
    expect(overlay).toContain("Keep blocked later-step replies concise.");
  });

  it("keeps a fresh homepage conversation in natural guidance mode before any structured kickoff", () => {
    const overlay = buildLlmConversationOverlay({
      runtime: {
        currentProjectSnapshot: null,
        currentDramaProject: null,
        currentVideoProject: null,
        recentProjects: [],
        recentMessageSummary: "",
        skillDrafts: [],
        maintenanceReports: [],
      },
      deferredQuestionState: null,
      automationMode: "manual",
    });

    expect(overlay).toContain("先用自然语言理解用户要做什么");
    expect(overlay).toContain("首页空白对话可以先自然聊天和缩小范围");
    expect(overlay).toContain("不要一上来就弹结构化问题");
    expect(overlay).toContain("answer from the InFinio product role first");
    expect(overlay).toContain("restore that same popup");
  });

  it("includes the suspended question schema and forbids rewriting greetings into workflow answers", () => {
    const overlay = buildLlmConversationOverlay({
      runtime: {
        currentProjectSnapshot: createSnapshot({
          projectKind: "script",
          derivedStage: "创作立项",
          recommendedActions: ["先确认目标受众"],
        }),
        currentDramaProject: null,
        currentVideoProject: null,
        recentProjects: [],
        recentMessageSummary: "",
        skillDrafts: [],
        maintenanceReports: [],
      },
      deferredQuestionState: {
        source: "deferred",
        request: {
          id: "original-script-kickoff:test-flow:audience",
          title: "目标受众",
          description: "默认女频",
          allowCustomInput: true,
          submissionMode: "immediate",
          questions: [
            {
              header: "目标受众",
              question: "这次更希望主打哪类受众？",
              multiSelect: false,
              options: [
                { label: "女频", value: "女频" },
                { label: "男频", value: "男频" },
              ],
            },
          ],
        },
        currentIndex: 0,
        answers: {},
        displayAnswers: {},
      },
    });

    expect(overlay).toContain("Suspended workflow question schema");
    expect(overlay).toContain("这次更希望主打哪类受众？");
    expect(overlay).toContain("绝不要把这类句子改写成步骤答案");
    expect(overlay).toContain("Do not rewrite them into step values");
    expect(overlay).toContain("不要新建任何 AskUserQuestion");
    expect(overlay).toContain("restore the suspended popup unchanged");
  });
});

describe("isHomepageConversationPlaceholderSnapshot", () => {
  it("recognizes the lightweight first-turn homepage snapshot", () => {
    const snapshot = buildFreeConversationProjectSnapshot({
      projectId: "session-free-chat-1",
      userPrompt: "你好",
      latestAssistantText: "你好！我是 Claude，很高兴见到你。",
      automationMode: "manual",
    });

    expect(isHomepageConversationPlaceholderSnapshot(snapshot)).toBe(true);
  });

  it("does not treat a real workflow snapshot as placeholder", () => {
    expect(
      isHomepageConversationPlaceholderSnapshot(
        createSnapshot({
          projectId: "video-project-1",
          projectKind: "video",
          currentObjective: "完成脚本拆解",
          derivedStage: "脚本拆解",
          recommendedActions: ["继续下一步"],
        }),
      ),
    ).toBe(false);
  });
});

describe("isBridgeableVideoWorkflowSourceSnapshot", () => {
  it("does not treat a lightweight homepage session placeholder as a reusable script source", () => {
    const snapshot = buildFreeConversationProjectSnapshot({
      projectId: "session-full-auto-1",
      userPrompt: "继续刚才的想法",
      latestAssistantText: "我先帮你把思路收口。",
      automationMode: "full-auto",
    });

    expect(isBridgeableVideoWorkflowSourceSnapshot(snapshot)).toBe(false);
  });

  it("still allows real script workflow snapshots to bridge into video kickoff", () => {
    expect(
      isBridgeableVideoWorkflowSourceSnapshot(
        createSnapshot({
          projectId: "script-project-1",
          projectKind: "script",
          currentObjective: "继续剧本工作流",
          derivedStage: "分集细纲",
          recommendedActions: ["继续生成分集细纲"],
        }),
      ),
    ).toBe(true);
  });
});

describe("resolveFullAutoRuntimeProjectId", () => {
  it("ignores a lightweight placeholder session id when the full-auto setup already carries uploaded script text", () => {
    const placeholder = buildFullAutoCollectionPlaceholderSnapshot({
      sessionId: "session-full-auto-upload",
      userPrompt: "上传文档并开始视频工作流",
    });

    expect(
      resolveFullAutoRuntimeProjectId({
        runtime: {
          currentProjectSnapshot: placeholder,
          currentDramaProject: null,
          currentVideoProject: null,
        } as never,
        setupInput: {
          script: "第1集\n女主在雨夜回到旧宅。",
        },
      }),
    ).toBeUndefined();
  });

  it("prefers the active video project once video kickoff has created one", () => {
    const currentVideoProject = createVideoProject({ id: "video-project-live" });

    expect(
      resolveFullAutoRuntimeProjectId({
        runtime: {
          currentProjectSnapshot: createVideoSnapshot(currentVideoProject),
          currentDramaProject: { id: "drama-project-1" },
          currentVideoProject,
        } as never,
        setupInput: {
          projectId: "script-project-1",
          sourceProjectId: "drama-project-1",
          script: "第1集\n雨夜回家。",
        },
      }),
    ).toBe("video-project-live");
  });
});

describe("buildHomepageConversationSnapshotFromMessages", () => {
  function createAssistantMessage(
    overrides: Partial<HomeAgentMessage> = {},
  ): HomeAgentMessage {
    return {
      id: "assistant-1",
      role: "assistant",
      content: "我先帮你把都市悬疑的核心冲突整理一下。",
      createdAt: "2026-05-07T12:00:00.000Z",
      status: "complete",
      ...overrides,
    };
  }

  it("creates a lightweight homepage project snapshot from the first completed assistant reply", () => {
    const snapshot = buildHomepageConversationSnapshotFromMessages({
      currentProjectSnapshot: null,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "给我剧本",
          createdAt: "2026-05-07T11:59:00.000Z",
          status: "complete",
        },
        createAssistantMessage(),
      ],
      projectId: "session-1",
      userPrompt: "给我剧本",
      automationMode: "manual",
    });

    expect(snapshot).toMatchObject({
      projectId: "session-1",
      projectKind: "script",
      currentObjective: "继续当前对话",
      derivedStage: "历史对话",
      automationMode: "manual",
      updatedAt: "2026-05-07T12:00:00.000Z",
    });
    expect(snapshot?.agentSummary).toContain("都市悬疑");
  });

  it("does not replace an existing project snapshot", () => {
    const snapshot = buildHomepageConversationSnapshotFromMessages({
      currentProjectSnapshot: createSnapshot({
        projectId: "existing-project",
        projectKind: "script",
      }),
      messages: [createAssistantMessage()],
      projectId: "session-1",
      userPrompt: "给我剧本",
      automationMode: "manual",
    });

    expect(snapshot).toBeNull();
  });
});

describe("abort helpers", () => {
  it("throws an AbortError when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();

    try {
      throwIfAborted(controller.signal);
      throw new Error("expected throwIfAborted to throw");
    } catch (error) {
      expect(error).toMatchObject({
        message: "请求已取消",
        name: "AbortError",
      });
    }
  });

  it("resolves the delay when no abort happens", async () => {
    vi.useFakeTimers();
    try {
      const pending = waitForAbortableDelay(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the delay with an AbortError when the signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = waitForAbortableDelay(100, controller.signal);
      const rejection = expect(pending).rejects.toMatchObject({
        message: "请求已取消",
        name: "AbortError",
      });

      controller.abort();
      await vi.runAllTimersAsync();
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

