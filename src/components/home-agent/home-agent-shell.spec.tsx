import { createRef, useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationProjectSnapshot,
  FullAutoRunState,
  HomeAgentMessage,
} from "@/lib/home-agent/types";
import {
  applyFullAutoStrategyAnswer,
  createFullAutoOriginalScriptRunPlan,
  getNextFullAutoStrategyQuestion,
  markFullAutoSteps,
} from "@/lib/home-agent/full-auto-run-plan";
import { ActiveConversationShell } from "./home-agent-shell";

vi.mock("./ScriptArtifactPanel", () => ({
  ScriptArtifactPanel: ({
    snapshot,
    onArtifactAction,
    directBatchReviewTrigger,
    directSingleReviewTrigger,
    reviewWorkspaceOnly,
  }: {
    snapshot: ConversationProjectSnapshot;
    onArtifactAction?: (
      value: string,
      label: string,
      input?: Record<string, unknown>,
    ) => void;
    directBatchReviewTrigger?: { count: number };
    directSingleReviewTrigger?: { count: number; epNum: number };
    reviewWorkspaceOnly?: boolean;
  }) => (
    <div>
      <div data-testid={`artifact-shell-kind-${snapshot.artifacts.map((artifact) => artifact.id).join("-")}`}>
        {snapshot.projectKind}
      </div>
      <div data-testid={`direct-review-${snapshot.artifacts.map((artifact) => artifact.id).join("-")}`}>
        {`batch:${directBatchReviewTrigger?.count ?? "none"};single:${directSingleReviewTrigger?.count ?? "none"};workspace:${reviewWorkspaceOnly ? "only" : "normal"}`}
      </div>
      <button
        type="button"
        data-testid={`artifact-action-${snapshot.artifacts.map((artifact) => artifact.id).join("-")}`}
        onClick={() => onArtifactAction?.("script:skip-compliance-review", "跳过审查")}
      >
        触发产物动作
      </button>
      {snapshot.artifacts.map((artifact) => (
        <div key={artifact.id}>
          <div>{artifact.label}</div>
          {artifact.payload?.type === "outlines+batchProgress"
            ? artifact.payload.entries.map((entry) => (
                <div key={entry.number}>{entry.outline || entry.summary}</div>
              ))
            : null}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

describe("ActiveConversationShell", () => {
  function buildFullAutoRunForChecklist(): FullAutoRunState {
    const plan = createFullAutoOriginalScriptRunPlan({
      setupInput: { totalEpisodes: 24, title: "Checklist test" },
      userBubble: "Original script: checklist test",
      structuredSummary: "24-episode original drama",
    });
    const outlineQuestion = getNextFullAutoStrategyQuestion(plan);
    if (!outlineQuestion) throw new Error("Missing outline question");
    const outlineOption = outlineQuestion.options.find((option) => option.value === "script:outline-generate-batch:1:10");
    if (!outlineOption) throw new Error("Missing outline option");
    const outlinePlan = applyFullAutoStrategyAnswer(plan, outlineOption.value, outlineOption.label, outlineQuestion);
    if (!outlinePlan) throw new Error("Failed to answer outline question");

    const durationQuestion = getNextFullAutoStrategyQuestion(outlinePlan);
    if (!durationQuestion) throw new Error("Missing episode duration question");
    const durationOption = durationQuestion.options.find((option) => option.value === "script:episode-duration-gate:90");
    if (!durationOption) throw new Error("Missing duration option");
    const durationPlan = applyFullAutoStrategyAnswer(
      outlinePlan,
      durationOption.value,
      durationOption.label,
      durationQuestion,
    );
    if (!durationPlan) throw new Error("Failed to answer duration question");

    const runningPlan = markFullAutoSteps(durationPlan, 1, "running");
    return {
      status: "running",
      plan: runningPlan,
      currentStepIndex: 1,
      currentStepLabel: runningPlan.steps[1]?.label,
    };
  }

  it("renders the unread composer line as a dedicated dock indicator", () => {
    const { container } = render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        hasUnreadMessage
        trackClassName="max-w-[820px]"
      />,
    );

    expect(container.querySelector(".home-agent-unread-composer-line")).not.toBeNull();
  });

  it("shows an assistant-side generating hint while workflow work is in flight", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "进入角色开发",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
      />,
    );

    expect(screen.getByText("正在生成，请稍候…")).toBeInTheDocument();
    expect(screen.getByText(/Agent 正在处理/)).toBeInTheDocument();
  });

  it("can suppress the synthetic generating placeholder for silent workflow shortcuts", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "导出调色盘",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        suppressSyntheticStreamingMessage
        trackClassName="max-w-[820px]"
      />,
    );

    expect(screen.queryByText("正在生成，请稍候…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-streaming-label")).not.toBeInTheDocument();
  });

  it("adds a shimmering treatment to the pending stream label", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-pending",
        role: "assistant",
        content: "",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        streamLabel: "正在分析",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
      />,
    );

    const label = screen.getByTestId("agent-streaming-label");
    expect(label).toHaveTextContent("正在分析");
    expect(label).toHaveClass("agent-status-shimmer-text");
  });

  it("keeps showing the workflow placeholder when an older pending assistant message exists", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-old-pending",
        role: "assistant",
        content: "",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        streamLabel: "旧任务仍在处理中",
      },
      {
        id: "user-1",
        role: "user",
        content: "重新生成全部片段",
        createdAt: "2026-04-08T00:00:01.000Z",
        status: "complete",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        workflowProgress={{
          title: "正在生成片段提示词",
          description: "底层任务状态会实时刷新。",
          floorPercent: 0,
          ceilPercent: 12,
          hasProcessing: true,
          statusLabel: "片段提示词 [>] 初始化",
          detailLabel: "正在生成片段 1-1",
        }}
        trackClassName="max-w-[820px]"
      />,
    );

    expect(screen.getByText("正在生成，请稍候…")).toBeInTheDocument();
    expect(screen.getByTestId("agent-progress-status")).toHaveTextContent("片段提示词 [>] 初始化");
  });

  it("renders pending assistant text with the lightweight fallback body during streaming", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-streaming-markdown",
        role: "assistant",
        content: "## 当前感受\n\n先轻松聊两句，再继续下一步。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        streamLabel: "继续分析中",
      },
    ];

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
      />,
    );

    const body = container.querySelector('[data-home-agent-assistant-body="true"]');
    expect(body?.textContent).toContain("## 当前感受");
    expect(screen.getByTestId("agent-streaming-label")).toHaveTextContent("继续分析中");
  });

  it("keeps only the progress status text on the synchronized shimmer track", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-progress",
        role: "assistant",
        content: "",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        streamLabel: "正在分析",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
        workflowProgress={{
          title: "第11-20集 正在生成",
          description: "生成中",
          floorPercent: 25,
          ceilPercent: 50,
          hasProcessing: true,
          statusLabel: "[####>>>>......] 10/40 集细纲",
          detailLabel: "1/4 批次 · 25%",
        }}
      />,
    );

    const streamLabel = screen.getByTestId("agent-streaming-label");
    const progressTitle = screen.getByTestId("agent-progress-title");
    const progressStatus = screen.getByTestId("agent-progress-status");

    expect(progressTitle).not.toHaveClass("agent-status-shimmer-text");
    expect(progressStatus).toHaveClass("agent-status-shimmer-text");
    expect(streamLabel.getAttribute("style")).toContain("--agent-shimmer-sync-delay");
    expect(progressTitle.getAttribute("style")).toBeNull();
    expect(progressStatus.getAttribute("style")).toBe(streamLabel.getAttribute("style"));
  });

  it("only animates the currently executing assistant row", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-old-pending",
        role: "assistant",
        content: "",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        streamLabel: "正在分析",
      },
      {
        id: "assistant-live-pending",
        role: "assistant",
        content: "",
        createdAt: "2026-04-08T00:00:01.000Z",
        status: "pending",
        streamLabel: "正在分析",
      },
    ];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
      />,
    );

    const labels = screen.getAllByTestId("agent-streaming-label");
    expect(labels).toHaveLength(2);
    expect(labels[0]).not.toHaveClass("agent-status-shimmer-text");
    expect(labels[1]).toHaveClass("agent-status-shimmer-text");
    expect(labels[0].getAttribute("style")).toBeNull();
    expect(labels[1].getAttribute("style")).toContain("--agent-shimmer-sync-delay");
  });

  it("keeps artifact panel slots attached to each assistant message position", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Role stage update",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["outline-preview"],
        artifactSnapshots: [
          {
            id: "outline-preview",
            kind: "outline",
            label: "Outline Preview V1",
            summary: "Outline summary v1",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "Directory stage update",
        createdAt: "2026-04-08T00:00:01.000Z",
        status: "complete",
        artifactIds: ["outline-preview"],
        artifactSnapshots: [
          {
            id: "outline-preview",
            kind: "outline",
            label: "Outline Preview V2",
            summary: "Outline summary v2",
            updatedAt: "2026-04-08T00:00:01.000Z",
          },
        ],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-1",
      projectKind: "script",
      title: "Test Project",
      currentObjective: "Continue outlines",
      derivedStage: "Outline",
      agentSummary: "Artifacts ready",
      recommendedActions: ["Generate next outline"],
      updatedAt: "2026-04-08T00:00:01.000Z",
      artifacts: [
        {
          id: "outline-preview",
          kind: "outline",
          label: "Live Outline Preview",
          summary: "This newer live snapshot should not replace the frozen message panels.",
          updatedAt: "2026-04-08T00:00:01.000Z",
        },
      ],
      memory: {
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
        characterStateCards: [],
        storyBeatPackets: [],
        complianceRevisionPackets: [],
      },
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText("Role stage update")).toBeInTheDocument();
    expect(screen.getByText("Directory stage update")).toBeInTheDocument();
    expect(screen.getAllByText("正在加载步骤面板…")).toHaveLength(2);
    expect(screen.queryByText("Live Outline Preview")).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("renders frozen script artifact snapshots with a script shell even after the active project switches to video", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-script-export",
        role: "assistant",
        content: "导出稿已准备完成。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["script-export"],
        artifactSnapshots: [
          {
            id: "script-export",
            kind: "export",
            label: "导出稿",
            summary: "已生成导出稿",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-1",
      projectKind: "video",
      title: "视频项目",
      currentObjective: "继续分镜",
      derivedStage: "角色与场景",
      agentSummary: "video summary",
      recommendedActions: [],
      artifacts: [],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(await screen.findByText("导出稿")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-shell-kind-script-export")).toHaveTextContent("script");
  });

  it("hides historical video script cards once the live video project has moved past script breakdown", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-video-assets",
        role: "assistant",
        content: "当前批次资产状态已更新。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["video-assets", "video-script"],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-stage-2",
      projectKind: "video",
      title: "视频项目",
      currentObjective: "继续角色与场景",
      derivedStage: "角色与场景",
      agentSummary: "video summary",
      recommendedActions: [],
      artifacts: [
        {
          id: "video-assets",
          kind: "video-brief",
          label: "当前批次资产状态（文生视频模式）",
          summary: "资产状态",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        {
          id: "video-script",
          kind: "plan",
          label: "视频脚本",
          summary: "历史脚本卡片",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(await screen.findByText("当前批次资产状态（文生视频模式）")).toBeInTheDocument();
    expect(screen.queryByText("视频脚本")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-shell-kind-video-assets")).toHaveTextContent("video");
  });

  it("keeps the video script card visible during the script breakdown stage", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-video-script",
        role: "assistant",
        content: "脚本拆解结果已准备好。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["video-script"],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-stage-1",
      projectKind: "video",
      title: "视频项目",
      currentObjective: "继续脚本拆解",
      derivedStage: "脚本拆解",
      agentSummary: "video summary",
      recommendedActions: [],
      artifacts: [
        {
          id: "video-script",
          kind: "plan",
          label: "视频脚本",
          summary: "脚本拆解内容",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(await screen.findByText("视频脚本")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-shell-kind-video-script")).toHaveTextContent("video");
  });

  it("routes historical artifact actions with the original script snapshot instead of the live video project", async () => {
    const onArtifactAction = vi.fn();
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-compliance-history",
        role: "assistant",
        content: "合规审查已完成，可继续处理。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["compliance-history"],
        artifactSnapshots: [
          {
            id: "compliance-history",
            kind: "compliance",
            label: "合规工作台",
            summary: "可继续跳过审查或修复",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        workflowRefresh: {
          mode: "shortcut",
          action: "skip_compliance_review",
          input: { projectId: "script-project-history" },
          userBubble: "跳过审查",
          projectId: "script-project-history",
        },
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-live",
      projectKind: "video",
      title: "视频项目",
      currentObjective: "继续分镜",
      derivedStage: "角色与场景",
      agentSummary: "video summary",
      recommendedActions: [],
      artifacts: [],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
        onArtifactAction={onArtifactAction}
      />,
    );

    fireEvent.click(await screen.findByTestId("artifact-action-compliance-history"));

    expect(onArtifactAction).toHaveBeenCalledWith(
      "script:skip-compliance-review",
      "跳过审查",
      undefined,
      expect.objectContaining({
        projectId: "script-project-history",
        projectKind: "script",
      }),
    );
  });

  it("renders assistant artifact tabs above the feedback controls", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-with-artifact",
        role: "assistant",
        content: "已进入分集撰写步骤，预览卡已经就绪。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["episode-preview"],
        artifactSnapshots: [
          {
            id: "episode-preview",
            kind: "episode",
            label: "分集撰写",
            summary: "Episode preview",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      },
    ];
    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-tabs",
      projectKind: "script",
      title: "Artifact Tab Order",
      currentObjective: "Continue episodes",
      derivedStage: "Episodes",
      agentSummary: "Episode preview ready",
      recommendedActions: [],
      artifacts: [],
    };

    const { container } = render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
        onAssistantFeedback={vi.fn()}
      />,
    );

    const messageBody = screen.getByText("已进入分集撰写步骤，预览卡已经就绪。");
    const artifactTab = await screen.findByText("分集撰写");
    const feedbackButton = container.querySelector('button[aria-pressed="false"]');

    expect(feedbackButton).not.toBeNull();
    expect(messageBody.compareDocumentPosition(artifactTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(artifactTab.compareDocumentPosition(feedbackButton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("scopes stacked script artifact snapshots to the step mentioned by the assistant message", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-duration",
        role: "assistant",
        content: "已将单集时长设为 90 秒。现在可以继续选择要生成的集数或直接自动批量续写。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["plan", "characters", "directory", "outline", "episode-progress"],
        artifactSnapshots: [
          { id: "plan", kind: "plan", label: "创意方案", summary: "plan", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "characters", kind: "characters", label: "角色设定", summary: "characters", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "directory", kind: "directory", label: "分集目录", summary: "directory", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "outline", kind: "outline", label: "单集细纲", summary: "outline", updatedAt: "2026-04-08T00:00:00.000Z" },
          { id: "episode-progress", kind: "episode", label: "分集撰写", summary: "episode", updatedAt: "2026-04-08T00:00:00.000Z" },
        ],
      },
    ];
    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-scoped-tabs",
      projectKind: "script",
      title: "Scoped Tabs",
      currentObjective: "Continue episodes",
      derivedStage: "分集撰写",
      agentSummary: "Episode preview ready",
      recommendedActions: [],
      artifacts: [],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(await screen.findByText("分集撰写")).toBeInTheDocument();
    expect(screen.queryByText("创意方案")).not.toBeInTheDocument();
    expect(screen.queryByText("角色设定")).not.toBeInTheDocument();
    expect(screen.queryByText("分集目录")).not.toBeInTheDocument();
    expect(screen.queryByText("单集细纲")).not.toBeInTheDocument();
  });

  it("sends direct review triggers only to the latest assistant artifact panel", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-old",
        role: "assistant",
        content: "已开启第 1 集质量自检，结果会在这条最新消息下方更新。",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["episode-old"],
        artifactSnapshots: [
          {
            id: "episode-old",
            kind: "episode",
            label: "历史正文",
            summary: "old episode",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      },
      {
        id: "assistant-latest",
        role: "assistant",
        content: "已开启批量质量审查，结果会在这条最新消息下方更新。",
        createdAt: "2026-04-08T00:01:00.000Z",
        status: "complete",
        artifactIds: ["episode-latest"],
        artifactSnapshots: [
          {
            id: "episode-latest",
            kind: "episode",
            label: "当前正文",
            summary: "latest episode",
            updatedAt: "2026-04-08T00:01:00.000Z",
          },
        ],
      },
    ];
    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-direct-review",
      projectKind: "script",
      title: "Direct Review",
      currentObjective: "Review latest episode",
      derivedStage: "分集撰写",
      agentSummary: "Review in progress",
      recommendedActions: [],
      artifacts: [],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
        directBatchReviewTrigger={{ count: 4, targetMessageId: "assistant-latest" }}
        directSingleReviewTrigger={{ count: 7, epNum: 1, targetMessageId: "assistant-old" }}
      />,
    );

    expect(await screen.findByTestId("direct-review-episode-old")).toHaveTextContent("batch:none;single:none;workspace:only");
    expect(screen.getByTestId("direct-review-episode-latest")).toHaveTextContent("batch:4;single:none;workspace:only");
  });

  it("uses the live outline artifact for the latest assistant message while outline generation is running", async () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "正在生成细纲",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "pending",
        artifactIds: ["outline-preview"],
        artifactSnapshots: [
          {
            id: "outline-preview",
            kind: "outline",
            label: "单集细纲",
            summary: "旧细纲快照",
            updatedAt: "2026-04-08T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "outlines+batchProgress",
              totalEpisodes: 1,
              entries: [
                {
                  number: 1,
                  title: "旧标题",
                  summary: "旧摘要",
                  outline: "旧细纲内容",
                  hookType: "悬念",
                  isKey: false,
                  isClimax: false,
                  isPaywall: false,
                },
              ],
              batchProgress: {
                total: 1,
                done: 0,
                failed: 0,
                processing: 1,
                percent: 0,
                batches: [{ index: 0, label: "第1集", startEp: 1, endEp: 1, status: "processing" }],
              },
            },
          },
        ],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-live-outline",
      projectKind: "script",
      title: "Live Outline",
      currentObjective: "生成细纲",
      derivedStage: "单集细纲",
      agentSummary: "生成中",
      recommendedActions: [],
      updatedAt: "2026-04-08T00:00:02.000Z",
      artifacts: [
        {
          id: "outline-preview",
          kind: "outline",
          label: "单集细纲",
          summary: "实时细纲",
          updatedAt: "2026-04-08T00:00:02.000Z",
          presentation: "script-rich",
          payload: {
            type: "outlines+batchProgress",
            totalEpisodes: 1,
            entries: [
              {
                number: 1,
                title: "新标题",
                summary: "新摘要",
                outline: "实时更新细纲内容",
                hookType: "悬念",
                isKey: false,
                isClimax: false,
                isPaywall: false,
              },
            ],
            batchProgress: {
              total: 1,
              done: 0,
              failed: 0,
              processing: 1,
              percent: 0,
              batches: [{ index: 0, label: "第1集", startEp: 1, endEp: 1, status: "processing" }],
            },
          },
        },
      ],
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
        workflowProgress={{
          title: "第1集正在生成",
          description: "第1集正在生成",
          floorPercent: 0,
          ceilPercent: 100,
          hasProcessing: true,
          statusLabel: "生成中",
          detailLabel: "0/1 批次",
        }}
      />,
    );

    expect(await screen.findByText("实时更新细纲内容")).toBeInTheDocument();
    expect(screen.queryByText("旧细纲内容")).not.toBeInTheDocument();
  });

  it("attaches the live outline artifact to the synthetic streaming message", async () => {
    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-synthetic-outline",
      projectKind: "script",
      title: "Synthetic Outline",
      currentObjective: "生成细纲",
      derivedStage: "单集细纲",
      agentSummary: "生成中",
      recommendedActions: [],
      updatedAt: "2026-04-08T00:00:02.000Z",
      artifacts: [
        {
          id: "outline-preview",
          kind: "outline",
          label: "单集细纲",
          summary: "实时细纲",
          updatedAt: "2026-04-08T00:00:02.000Z",
          presentation: "script-rich",
          payload: {
            type: "outlines+batchProgress",
            totalEpisodes: 1,
            entries: [
              {
                number: 1,
                title: "第一集",
                summary: "摘要",
                outline: "占位消息里的实时细纲",
                hookType: "悬念",
                isKey: false,
                isClimax: false,
                isPaywall: false,
              },
            ],
            batchProgress: {
              total: 1,
              done: 0,
              failed: 0,
              processing: 1,
              percent: 0,
              batches: [{ index: 0, label: "第1集", startEp: 1, endEp: 1, status: "processing" }],
            },
          },
        },
      ],
    };

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
        workflowProgress={{
          title: "第1集正在生成",
          description: "第1集正在生成",
          floorPercent: 0,
          ceilPercent: 100,
          hasProcessing: true,
          statusLabel: "生成中",
          detailLabel: "0/1 批次",
        }}
      />,
    );

    expect(await screen.findByText("占位消息里的实时细纲")).toBeInTheDocument();
  });

  it("falls back to the live snapshot for legacy messages without frozen artifact snapshots", () => {
    const messages: HomeAgentMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "First summary",
        createdAt: "2026-04-08T00:00:00.000Z",
        status: "complete",
        artifactIds: ["outline-preview"],
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "Second summary",
        createdAt: "2026-04-08T00:00:01.000Z",
        status: "complete",
        artifactIds: ["outline-preview"],
      },
    ];

    const snapshot: ConversationProjectSnapshot = {
      projectId: "script-project-2",
      projectKind: "script",
      title: "Artifact fallback",
      currentObjective: "Continue",
      derivedStage: "Outline",
      agentSummary: "Artifacts ready",
      recommendedActions: [],
      updatedAt: "2026-04-08T00:00:01.000Z",
      artifacts: [
        {
          id: "outline-preview",
          kind: "plan",
          label: "Outline Preview",
          summary: "Legacy messages still resolve against the live snapshot.",
          updatedAt: "2026-04-08T00:00:01.000Z",
        },
      ],
      memory: {
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
        characterStateCards: [],
        storyBeatPackets: [],
        complianceRevisionPackets: [],
      },
    };

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(screen.getByText("First summary")).toBeInTheDocument();
    expect(screen.getByText("Second summary")).toBeInTheDocument();
    expect(screen.getAllByText("Outline Preview")).toHaveLength(2);
  });

  it("auto-loads older history while scrolling upward and keeps the scroll host anchored", async () => {
    const messages: HomeAgentMessage[] = Array.from({ length: 2025 }, (_, index) => ({
      id: `assistant-${index}`,
      role: "assistant",
      content: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 3, 8, 0, 0, index)).toISOString(),
      status: "complete",
    }));

    function ShellWithScrollHost() {
      const scrollRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={scrollRef} data-testid="scroll-host">
          <ActiveConversationShell
            conversationId="history-scroll-test"
            messages={messages}
            tasks={[]}
            onStopTask={() => undefined}
            endRef={createRef<HTMLDivElement>()}
            scrollContainerRef={scrollRef}
            composer={<div>composer</div>}
            streaming={false}
            trackClassName="max-w-[820px]"
          />
        </div>
      );
    }

    render(<ShellWithScrollHost />);

    const scrollHost = screen.getByTestId("scroll-host");
    let scrollTop = 0;
    Object.defineProperty(scrollHost, "clientHeight", {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(scrollHost, "scrollHeight", {
      configurable: true,
      get: () => scrollHost.querySelectorAll("[data-home-agent-message-row]").length * 100,
    });
    Object.defineProperty(scrollHost, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    expect(screen.queryByText("message 0")).not.toBeInTheDocument();
    expect(screen.getByText("message 2024")).toBeInTheDocument();

    await act(async () => {
      scrollTop = 0;
      fireEvent.scroll(scrollHost);
    });

    expect(screen.getByText("message 0")).toBeInTheDocument();
    expect(scrollTop).toBeGreaterThan(0);
  });

  it("asks for older persisted history when the visible timeline has reached its local limit", async () => {
    const onRequestOlderHistory = vi.fn().mockResolvedValue(false);
    const messages: HomeAgentMessage[] = Array.from({ length: 12 }, (_, index) => ({
      id: `assistant-${index}`,
      role: "assistant",
      content: `message ${index}`,
      createdAt: `2026-04-08T00:00:${String(index).padStart(2, "0")}.000Z`,
      status: "complete",
    }));

    function ShellWithScrollHost() {
      const scrollRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={scrollRef} data-testid="scroll-host-persisted">
          <ActiveConversationShell
            conversationId="history-hydration-test"
            messages={messages}
            tasks={[]}
            onStopTask={() => undefined}
            endRef={createRef<HTMLDivElement>()}
            scrollContainerRef={scrollRef}
            onRequestOlderHistory={onRequestOlderHistory}
            composer={<div>composer</div>}
            streaming={false}
            trackClassName="max-w-[820px]"
          />
        </div>
      );
    }

    render(<ShellWithScrollHost />);

    const scrollHost = screen.getByTestId("scroll-host-persisted");
    let scrollTop = 0;
    Object.defineProperty(scrollHost, "clientHeight", {
      configurable: true,
      value: 640,
    });
    Object.defineProperty(scrollHost, "scrollHeight", {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(scrollHost, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    await act(async () => {
      fireEvent.scroll(scrollHost);
    });

    await waitFor(() => {
      expect(onRequestOlderHistory).toHaveBeenCalledTimes(1);
    });
  });

  it("does not show the deprecated desktop floating task dock while it is disabled", () => {
    const messages: HomeAgentMessage[] = [];

    render(
      <ActiveConversationShell
        messages={messages}
        tasks={[
          {
            id: "task-running-1",
            prompt: "并行研究 平台偏好: fill bridge preferences",
            status: "running",
            output: "",
            sessionId: "session-1",
            projectId: "project-1",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming
        trackClassName="max-w-[820px]"
      />,
    );

    expect(screen.queryByText(/项处理中|项任务/)).not.toBeInTheDocument();
    expect(screen.queryByText("并行研究 平台偏好: fill bridge preferences")).not.toBeInTheDocument();
  });

  it("renders the left-side full-auto message checklist and supports collapsing it", () => {
    const scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        fullAutoRun={buildFullAutoRunForChecklist()}
      />,
    );

    expect(screen.getByText("执行清单")).toBeInTheDocument();
    expect(screen.getByText(/共 \d+ 条 · 已完成 \d+ 条/)).toBeInTheDocument();
    expect(screen.getByTestId("full-auto-message-checklist-panel")).toHaveClass("bg-[#101522]");
    expect(screen.queryByTestId("full-auto-message-checklist")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开待发消息清单" })).toHaveClass("w-full", "justify-between");
    expect(screen.getByRole("button", { name: "展开待发消息清单" })).not.toHaveClass("rounded-full", "h-7", "w-7");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "展开待发消息清单" }));

    expect(screen.getByTestId("full-auto-message-checklist").className).toContain("scrollbar-none");
    expect(screen.getByText("生成创作方案")).toBeInTheDocument();
    expect(screen.getByTestId("full-auto-checklist-item-step:setup")).toHaveAttribute(
      "data-full-auto-checklist-status",
      "completed",
    );
    expect(screen.getByTestId("full-auto-checklist-item-step:creative-plan")).toHaveAttribute(
      "data-full-auto-checklist-status",
      "running",
    );
    const outlineChoice = screen.getByTestId("full-auto-checklist-item-choice:outlineGeneration");
    const outlinesStep = screen.getByTestId("full-auto-checklist-item-step:outlines");
    const durationChoice = screen.getByTestId("full-auto-checklist-item-choice:episodeDuration");
    const episodeStep = screen.getByTestId("full-auto-checklist-item-step:episodes");

    expect(outlineChoice.compareDocumentPosition(outlinesStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(durationChoice.compareDocumentPosition(episodeStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scrollIntoViewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        block: "center",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "收起待发消息清单" }));

    expect(screen.queryByTestId("full-auto-message-checklist")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开待发消息清单" })).toBeInTheDocument();
    requestAnimationFrameSpy.mockRestore();
    scrollIntoViewSpy.mockRestore();
  });

  it("renders the right-side video QA feedback rail from snapshot memory", () => {
    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-qa-rail",
      projectKind: "video",
      title: "Video QA",
      currentObjective: "Review the latest segment",
      derivedStage: "视频生成",
      agentSummary: "QA completed",
      recommendedActions: [],
      artifacts: [],
      memory: {
        automationState: {
          strategy: "quality-first",
          segmentPassBudget: 5,
          localRepairBudget: 2,
          regenerateBudget: 2,
          assetPrimaryRetryBudget: 3,
          assetVariantRetryBudget: 2,
          segments: {},
          referenceTargets: {
            "reference-character:hero": {
              targetId: "reference-character:hero",
              targetType: "character-primary",
              entityId: "hero",
              status: "retryable",
              attemptCount: 2,
              retryBudget: 3,
              lastQaSummary: "主体完整，但脸部稳定性还不够。",
              lastQaScore: 78,
              lastQaPassed: false,
              lastQaQualityTier: "borderline",
              lastQaGoldenSignals: ["主体完整入镜"],
              lastQaFixPriorities: ["稳定脸部识别点"],
              lastQaIssues: ["脸部识别不稳定"],
              lastQaAt: "2026-04-08T00:02:00.000Z",
            },
          },
          updatedAt: "2026-04-08T00:02:00.000Z",
        },
        videoAuditPackets: [
          {
            id: "audit-segment-1",
            targetType: "segment",
            targetId: "segment:1-1",
            segmentLabel: "1-1",
            sceneIds: ["scene-1"],
            submittedPrompt: "prompt",
            referenceImageUrls: ["https://media.storyforge.test/hero-ref.jpg"],
            usedContinuityFrame: true,
            usedRelayVideo: false,
            symbolicPassed: true,
            totalScore: 89,
            status: "local_repair",
            scores: {
              continuity: { score: 88, passed: true, reason: "ok" },
              identity: { score: 90, passed: true, reason: "ok" },
              semantic: { score: 87, passed: true, reason: "ok" },
              visual: { score: 91, passed: true, reason: "ok" },
            },
            visualInspection: {
              inspected: true,
              frameCount: 3,
              summary: "连续性基本成立，但结尾 handoff 仍然偏弱。",
              subtitleVisible: false,
              watermarkVisible: false,
              deliverableReady: false,
              qualityTier: "borderline",
              goldenSignals: ["开场第一拍承接上一段动作"],
              fixPriorities: ["强化最后一拍的视线 handoff"],
              issues: ["结尾承接偏弱"],
            },
            issues: ["结尾承接偏弱"],
            createdAt: "2026-04-08T00:03:00.000Z",
            updatedAt: "2026-04-08T00:03:00.000Z",
          },
        ],
        videoRepairTasks: [
          {
            id: "repair-segment-1",
            targetType: "segment",
            targetId: "segment:1-1",
            segmentLabel: "1-1",
            route: "local_repair",
            status: "pending",
            reason: "结尾承接偏弱",
            attempts: 1,
            createdAt: "2026-04-08T00:03:00.000Z",
            updatedAt: "2026-04-08T00:03:00.000Z",
          },
        ],
        reviewQueue: [
          {
            id: "review-reference-hero",
            title: "角色参考图 · Hero",
            summary: "等待再次补图",
            targetIds: ["reference-character:hero"],
            status: "pending",
            createdAt: "2026-04-08T00:02:00.000Z",
            updatedAt: "2026-04-08T00:02:00.000Z",
          },
        ],
      },
    };

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    expect(screen.getByTestId("video-qa-feedback-rail")).toBeInTheDocument();
    expect(screen.getByTestId("video-qa-feedback-segment")).toHaveTextContent("片段 1-1");
    expect(screen.getByTestId("video-qa-feedback-segment")).toHaveTextContent("强化最后一拍的视线 handoff");
    expect(screen.getByTestId("video-qa-feedback-reference")).toHaveTextContent("角色参考图 · Hero");
    expect(screen.getByTestId("video-qa-feedback-reference")).toHaveTextContent("稳定脸部识别点");
    expect(screen.getByText("待复核 1")).toBeInTheDocument();
    expect(screen.getByText("待修复 1")).toBeInTheDocument();
  });

  it("collapses and expands the right-side video QA feedback rail vertically", () => {
    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-qa-rail-collapse",
      projectKind: "video",
      title: "Video QA",
      currentObjective: "Review the latest segment",
      derivedStage: "视频生成",
      agentSummary: "QA completed",
      recommendedActions: [],
      artifacts: [],
      memory: {
        automationState: {
          strategy: "quality-first",
          segmentPassBudget: 5,
          localRepairBudget: 2,
          regenerateBudget: 2,
          assetPrimaryRetryBudget: 3,
          assetVariantRetryBudget: 2,
          segments: {},
          referenceTargets: {},
          updatedAt: "2026-04-08T00:02:00.000Z",
        },
        videoAuditPackets: [
          {
            id: "audit-segment-collapse",
            targetType: "segment",
            targetId: "segment:1-4",
            segmentLabel: "1-4",
            sceneIds: ["scene-1"],
            submittedPrompt: "prompt",
            referenceImageUrls: ["https://media.storyforge.test/hero-ref.jpg"],
            usedContinuityFrame: true,
            usedRelayVideo: false,
            symbolicPassed: true,
            totalScore: 88,
            status: "pass",
            scores: {
              continuity: { score: 89, passed: true, reason: "ok" },
              identity: { score: 94, passed: true, reason: "ok" },
              semantic: { score: 86, passed: true, reason: "ok" },
              visual: { score: 90, passed: true, reason: "ok" },
            },
            visualInspection: {
              inspected: true,
              frameCount: 3,
              summary: "最终提交 prompt 缺少结尾钩子。",
              subtitleVisible: false,
              watermarkVisible: false,
              deliverableReady: true,
              qualityTier: "approved",
              goldenSignals: [],
              fixPriorities: ["补结尾钩子"],
              issues: ["最终提交 prompt 缺少结尾钩子。"],
            },
            issues: ["最终提交 prompt 缺少结尾钩子。"],
            createdAt: "2026-04-08T00:03:00.000Z",
            updatedAt: "2026-04-08T00:03:00.000Z",
          },
        ],
        videoRepairTasks: [
          {
            id: "repair-segment-collapse",
            targetType: "segment",
            targetId: "segment:1-4",
            segmentLabel: "1-4",
            route: "pass",
            status: "pending",
            reason: "补结尾钩子",
            attempts: 1,
            createdAt: "2026-04-08T00:03:00.000Z",
            updatedAt: "2026-04-08T00:03:00.000Z",
          },
        ],
        reviewQueue: [
          {
            id: "review-segment-collapse",
            title: "片段 1-4",
            summary: "等待 review",
            targetIds: ["segment:1-4"],
            status: "pending",
            createdAt: "2026-04-08T00:02:00.000Z",
            updatedAt: "2026-04-08T00:02:00.000Z",
          },
        ],
      },
    };

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    const toggle = screen.getByTestId("video-qa-feedback-rail-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("video-qa-feedback-segment")).toBeInTheDocument();
    expect(screen.getByText("最终提交 提示词 缺少结尾钩子。")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("video-qa-feedback-segment")).not.toBeInTheDocument();
    expect(screen.getByText("片段 1-4 · 通过")).toBeInTheDocument();
    expect(screen.getByText("待复核 1 · 待修复 1")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("video-qa-feedback-segment")).toBeInTheDocument();
  });

  it("aligns the video QA rail to the shared desktop utility column when the task board publishes a layout", () => {
    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-qa-rail-aligned",
      projectKind: "video",
      title: "Video QA",
      currentObjective: "Review the latest segment",
      derivedStage: "视频生成",
      agentSummary: "QA completed",
      recommendedActions: [],
      artifacts: [],
      memory: {
        automationState: {
          strategy: "quality-first",
          segmentPassBudget: 5,
          localRepairBudget: 2,
          regenerateBudget: 2,
          assetPrimaryRetryBudget: 3,
          assetVariantRetryBudget: 2,
          segments: {},
          referenceTargets: {},
          updatedAt: "2026-04-08T00:02:00.000Z",
        },
        videoAuditPackets: [
          {
            id: "audit-segment-align",
            targetType: "segment",
            targetId: "segment:1-4",
            segmentLabel: "1-4",
            sceneIds: ["scene-1"],
            submittedPrompt: "prompt",
            referenceImageUrls: [],
            usedContinuityFrame: false,
            usedRelayVideo: false,
            symbolicPassed: true,
            totalScore: 88,
            status: "pass",
            scores: {
              continuity: { score: 89, passed: true, reason: "ok" },
              identity: { score: 94, passed: true, reason: "ok" },
              semantic: { score: 86, passed: true, reason: "ok" },
              visual: { score: 90, passed: true, reason: "ok" },
            },
            visualInspection: {
              inspected: true,
              frameCount: 3,
              summary: "最终提交 prompt 缺少结尾钩子。",
              subtitleVisible: false,
              watermarkVisible: false,
              deliverableReady: true,
              qualityTier: "approved",
              goldenSignals: [],
              fixPriorities: [],
              issues: [],
            },
            issues: [],
            createdAt: "2026-04-08T00:03:00.000Z",
            updatedAt: "2026-04-08T00:03:00.000Z",
          },
        ],
        videoRepairTasks: [],
        reviewQueue: [],
      },
    };

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={() => undefined}
        endRef={createRef<HTMLDivElement>()}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName="max-w-[820px]"
        snapshot={snapshot}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("home-agent:desktop-utility-column-layout", {
          detail: { left: 112, width: 318 },
        }),
      );
    });

    const rail = screen.getByTestId("conversation-utility-rail");
    expect(rail).toHaveStyle({
      left: "112px",
      width: "318px",
    });
  });
});
