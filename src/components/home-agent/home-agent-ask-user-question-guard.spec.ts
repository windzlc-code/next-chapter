import { describe, expect, it } from "vitest";
import type { ComposerQuestion, StudioRuntimeState } from "@/lib/home-agent/types";
import { buildVideoContinuationQuestion } from "./home-agent-project-questions";
import {
  normalizeWorkflowBoundAskUserQuestionRequest,
  resolveWorkflowBoundComposerQuestion,
} from "./home-agent-ask-user-question-guard";

function createRuntime(
  overrides: Partial<StudioRuntimeState> = {},
): StudioRuntimeState {
  return {
    sessionId: "session-1",
    suppressHistoricalMemory: false,
    currentProjectSnapshot: null,
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentProjectSessions: [],
    recentMessageSummary: "",
    fullAutoRun: null,
    ...overrides,
  };
}

function flattenQuestionValues(question: ComposerQuestion | null | undefined): string[] {
  if (!question) return [];
  const values: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    values.push(option.value);
    if (option.children?.length) queue.push(...option.children);
  }
  return values;
}

describe("normalizeWorkflowBoundAskUserQuestionRequest", () => {
  it("normalizes fresh video kickoff popups back to the workflow-owned kickoff schema", () => {
    const request = normalizeWorkflowBoundAskUserQuestionRequest(
      {
        id: "ask-video-1",
        title: "下一步方向",
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "方向",
            question: "接下来怎么进入视频流程？",
            multiSelect: false,
            options: [
              { label: "上传剧本文档", value: "upload-document" },
            ],
          },
        ],
      },
      createRuntime(),
    );

    expect(request.id.startsWith("video-workflow-kickoff:")).toBe(true);
    expect(request.title).toContain("视频");
    expect(request.questions[0]?.question).toContain("剧本");
    expect(request.questions[0]?.options.map((option) => option.value)).toEqual([
      "upload-document",
    ]);
  });

  it("does not re-introduce the current-project bridge option on a fresh homepage video kickoff", () => {
    const request = normalizeWorkflowBoundAskUserQuestionRequest(
      {
        id: "ask-video-bridge-1",
        title: "视频工作流入口",
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "剧本来源",
            question: "你的剧本来源是什么？",
            multiSelect: false,
            options: [
              { label: "使用当前剧本项目", value: "use-current-project" },
              { label: "上传剧本文档", value: "upload-document" },
            ],
          },
        ],
      },
      createRuntime({
        currentDramaProject: {
          id: "drama-project-1",
          mode: "original",
          dramaTitle: "旧剧本项目",
          setup: null,
          outline: null,
          episodes: [],
          createdAt: "2026-05-12T00:00:00.000Z",
          updatedAt: "2026-05-12T00:00:00.000Z",
        } as NonNullable<StudioRuntimeState["currentDramaProject"]>,
      }),
    );

    expect(request.questions[0]?.options.map((option) => option.value)).toEqual([
      "upload-document",
    ]);
  });

  it("normalizes fresh script kickoff popups back to the original-script kickoff schema", () => {
    const request = normalizeWorkflowBoundAskUserQuestionRequest(
      {
        id: "ask-script-1",
        title: "创作方式",
        allowCustomInput: false,
        submissionMode: "immediate",
        questions: [
          {
            header: "创作方式",
            question: "这次想从哪种方式开始原创剧本？",
            multiSelect: false,
            options: [
              { label: "自由发挥", value: "freeform" },
              { label: "我先给你一个故事想法", value: "idea-first" },
            ],
          },
        ],
      },
      createRuntime(),
    );

    expect(request.id.startsWith("original-script-kickoff:")).toBe(true);
    expect(request.title).toContain("原创剧本");
    expect(request.questions[0]?.question).toContain("原创剧本");
    expect(request.questions[0]?.options.map((option) => option.value)).toEqual(["topic", "creative"]);
  });

  it("filters active-workflow popup options back into the current workflow scope", () => {
    const snapshot = {
      projectId: "video-project-1",
      projectKind: "video" as const,
      title: "Video Project",
      currentObjective: "Continue video workflow",
      derivedStage: "角色与场景",
      agentSummary: "summary",
      recommendedActions: [],
      artifacts: [],
    };
    const videoProject = {
      id: "video-project-1",
      title: "Video Project",
      script: "script",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
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
    } as StudioRuntimeState["currentVideoProject"];

    const workflowQuestion = buildVideoContinuationQuestion(snapshot, videoProject);
    const allowedValues = flattenQuestionValues(workflowQuestion);
    expect(allowedValues.length).toBeGreaterThan(0);

    const request = normalizeWorkflowBoundAskUserQuestionRequest(
      {
        id: "ask-video-2",
        title: "乱写的标题",
        allowCustomInput: true,
        submissionMode: "confirm",
        questions: [
          {
            header: "乱写",
            question: "乱写的问题",
            multiSelect: false,
            options: [
              {
                label: workflowQuestion?.options[0]?.label || "fallback",
                value: workflowQuestion?.options[0]?.value || "fallback",
              },
              {
                label: "流程外问题",
                value: "outside-scope",
              },
            ],
          },
        ],
      },
      createRuntime({
        currentProjectSnapshot: snapshot,
        currentVideoProject: videoProject,
      }),
    );

    expect(request.id).toBe("ask-video-2");
    expect(request.title).toBe(workflowQuestion?.title);
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0]?.options.every((option) => allowedValues.includes(option.value || ""))).toBe(true);
    expect(request.questions[0]?.options.some((option) => option.value === "outside-scope")).toBe(false);
  });

  it("resolves active-workflow ask requests back to the exact workflow-owned composer popup", () => {
    const snapshot = {
      projectId: "video-project-1",
      projectKind: "video" as const,
      title: "Video Project",
      currentObjective: "Continue video workflow",
      derivedStage: "角色与场景",
      agentSummary: "summary",
      recommendedActions: [],
      artifacts: [],
    };
    const videoProject = {
      id: "video-project-1",
      title: "Video Project",
      script: "script",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
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
    } as StudioRuntimeState["currentVideoProject"];

    const workflowQuestion = buildVideoContinuationQuestion(snapshot, videoProject);
    expect(workflowQuestion).not.toBeNull();

    const resolvedQuestion = resolveWorkflowBoundComposerQuestion(
      {
        id: "ask-video-3",
        title: "随便写的标题",
        allowCustomInput: true,
        submissionMode: "immediate",
        questions: [
          {
            header: "方向",
            question: "接下来继续哪一步？",
            multiSelect: false,
            options: [
              {
                label: workflowQuestion?.options[0]?.label || "fallback",
                value: workflowQuestion?.options[0]?.value || "fallback",
              },
            ],
          },
        ],
      },
      createRuntime({
        currentProjectSnapshot: snapshot,
        currentVideoProject: videoProject,
      }),
    );

    expect(resolvedQuestion).toEqual(workflowQuestion);
  });
});
