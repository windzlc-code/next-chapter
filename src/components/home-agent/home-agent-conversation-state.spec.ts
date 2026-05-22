import { describe, expect, it } from "vitest";
import type { ConversationProjectSnapshot, HomeAgentMessage, StudioSessionState } from "@/lib/home-agent/types";
import { buildOpenProjectSessionState, buildResetRuntimeState } from "./home-agent-conversation-state";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "Video project",
    currentObjective: "Continue breakdown",
    derivedStage: "脚本拆解",
    agentSummary: "summary",
    recommendedActions: [],
    artifacts: [],
    ...overrides,
  };
}

function createSession(overrides: Partial<StudioSessionState> = {}): StudioSessionState {
  return {
    sessionId: "session-1",
    mode: "active",
    messages: [],
    currentProjectSnapshot: null,
    recentMessageSummary: "",
    ...overrides,
  };
}

describe("buildOpenProjectSessionState", () => {
  it("restores interrupted choice questions into the popover when no pending choice question exists", () => {
    const interruptedChoiceQuestion = {
      id: "video-analyze-resume-video-project-1-medium-90",
      title: "继续剧本拆解",
      description: "已记录参数。",
      options: [
        {
          id: "resume-breakdown",
          label: "继续剧本拆解",
          value: "video:bridge:analyze:resume:medium:90",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-analyze-resume",
    };

    const state = buildOpenProjectSessionState({
      savedSession: createSession({
        interruptedChoiceQuestion,
      }),
      snapshot: createSnapshot(),
      videoProject: null,
      buildBrief: () => "brief",
      createAssistantMessage: (content: string): HomeAgentMessage => ({
        id: "message-1",
        role: "assistant",
        content,
        createdAt: "2026-05-08T00:00:00.000Z",
      }),
      getSuggestedQuestion: () => null,
    });

    expect(state.popoverOverride).toEqual(interruptedChoiceQuestion);
  });

  it("restores the persisted full-auto checklist collapsed state from the saved session", () => {
    const state = buildOpenProjectSessionState({
      savedSession: createSession({
        automationMode: "full-auto",
        fullAutoChecklistCollapsed: false,
      }),
      snapshot: createSnapshot(),
      videoProject: null,
      buildBrief: () => "brief",
      createAssistantMessage: (content: string): HomeAgentMessage => ({
        id: "message-1",
        role: "assistant",
        content,
        createdAt: "2026-05-08T00:00:00.000Z",
      }),
      getSuggestedQuestion: () => null,
    });

    expect(state.fullAutoChecklistCollapsed).toBe(false);
  });

  it("suppresses restored choice panels when the session should resume a pending upload wait", () => {
    const uploadSuggestion = {
      id: "adaptation-workflow-upload-suggestion:session-1:action",
      title: "需要时可以直接从这里上传参考剧本。",
      description: "你可以先继续和 Agent 对话；如果已经准备好参考剧本，也可以随时上传参考文档。",
      options: [
        {
          id: "upload-reference-document",
          label: "上传参考文档",
          value: "upload-document",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "快捷入口",
    };

    const state = buildOpenProjectSessionState({
      savedSession: createSession({
        pendingChoiceQuestion: uploadSuggestion,
        interruptedChoiceQuestion: uploadSuggestion,
        messages: [
          {
            id: "assistant-upload-instruction",
            role: "assistant",
            content:
              "好的，请通过下方的回形针按钮上传参考剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。我会先写入参考文本，再打开当前步骤原有的选择面板。",
            createdAt: "2026-05-10T00:00:00.000Z",
          },
        ],
      }),
      snapshot: createSnapshot({ projectKind: "adaptation" }),
      videoProject: null,
      buildBrief: () => "brief",
      createAssistantMessage: (content: string): HomeAgentMessage => ({
        id: "message-1",
        role: "assistant",
        content,
        createdAt: "2026-05-08T00:00:00.000Z",
      }),
      getSuggestedQuestion: () => null,
    });

    expect(state.pendingWorkflowUploadKind).toBe("adaptation");
    expect(state.popoverOverride).toBeNull();
  });

  it("promotes recovered video workflow questions into the standard popup when no saved session exists", () => {
    const recoveredQuestion = {
      id: "review-stage-panel-video-project-1",
      title: "《Video project》进入预览与导出阶段",
      description: "继续推进出片或导出。",
      options: [
        {
          id: "continue-video-export",
          label: "继续补生成剩余镜头",
          value: "video:generate:first",
        },
      ],
      presentation: "card" as const,
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "review-stage-panel",
    };

    const state = buildOpenProjectSessionState({
      savedSession: null,
      snapshot: createSnapshot({ derivedStage: "棰勮涓庡鍑?" }),
      videoProject: null,
      buildBrief: () => "brief",
      createAssistantMessage: (content: string): HomeAgentMessage => ({
        id: "message-1",
        role: "assistant",
        content,
        createdAt: "2026-05-08T00:00:00.000Z",
      }),
      getSuggestedQuestion: () => recoveredQuestion,
    });

    expect(state.popoverOverride).toEqual(recoveredQuestion);
    expect(state.suggested).toBeNull();
  });

  it("rebuilds stale saved review popups from the current video snapshot", () => {
    const staleReviewQuestion = {
      id: "review-stage-panel-video-project-1",
      title: "Old review stage",
      description: "stale",
      options: [
        {
          id: "old-review-action",
          label: "Continue",
          value: "video:generate:first",
        },
      ],
      presentation: "card" as const,
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "review-stage-panel",
    };
    const recoveredQuestion = {
      ...staleReviewQuestion,
      title: "《Video project》进入预览与导出阶段",
      description: "继续推进出片或导出。",
    };

    const state = buildOpenProjectSessionState({
      savedSession: createSession({
        pendingChoiceQuestion: staleReviewQuestion,
      }),
      snapshot: createSnapshot({ derivedStage: "预览与导出" }),
      videoProject: null,
      buildBrief: () => "brief",
      createAssistantMessage: (content: string): HomeAgentMessage => ({
        id: "message-1",
        role: "assistant",
        content,
        createdAt: "2026-05-08T00:00:00.000Z",
      }),
      getSuggestedQuestion: () => recoveredQuestion,
    });

    expect(state.popoverOverride).toEqual(recoveredQuestion);
    expect(state.suggested).toBeNull();
  });
});

describe("buildResetRuntimeState", () => {
  it("keeps recent project session caches while clearing the active conversation", () => {
    const cachedSession = createSession({
      sessionId: "cached-session-1",
      projectId: "project-2",
      automationMode: "full-auto",
      currentProjectSnapshot: createSnapshot({
        projectId: "project-2",
        automationMode: "full-auto",
      }),
    });

    const next = buildResetRuntimeState({
      sessionId: "active-session",
      suppressHistoricalMemory: false,
      currentProjectSnapshot: createSnapshot(),
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [createSnapshot()],
      recentProjectSessions: [cachedSession],
      recentMessageSummary: "summary",
      fullAutoRun: null,
    });

    expect(next.currentProjectSnapshot).toBeNull();
    expect(next.recentProjectSessions).toEqual([cachedSession]);
    expect(next.recentProjects).toHaveLength(1);
  });
});
