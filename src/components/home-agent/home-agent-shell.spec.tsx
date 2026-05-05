import { createRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationProjectSnapshot,
  HomeAgentMessage,
} from "@/lib/home-agent/types";
import { ActiveConversationShell } from "./home-agent-shell";

vi.mock("./ScriptArtifactPanel", () => ({
  ScriptArtifactPanel: ({
    snapshot,
    directBatchReviewTrigger,
    directSingleReviewTrigger,
    reviewWorkspaceOnly,
  }: {
    snapshot: ConversationProjectSnapshot;
    directBatchReviewTrigger?: { count: number };
    directSingleReviewTrigger?: { count: number; epNum: number };
    reviewWorkspaceOnly?: boolean;
  }) => (
    <div>
      <div data-testid={`direct-review-${snapshot.artifacts.map((artifact) => artifact.id).join("-")}`}>
        {`batch:${directBatchReviewTrigger?.count ?? "none"};single:${directSingleReviewTrigger?.count ?? "none"};workspace:${reviewWorkspaceOnly ? "only" : "normal"}`}
      </div>
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
        content: "已将单集时长设为 90 秒。现在可以继续选择要生成的集数或直接批量生成。",
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

  it("shows the desktop floating task dock when tasks exist", () => {
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

    expect(screen.getByText(/项处理中|项任务/)).toBeInTheDocument();
  });
});
