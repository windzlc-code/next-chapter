import { describe, expect, it } from "vitest";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  StudioRuntimeState,
} from "./types";
import {
  buildWorkflowAssistantMessagePayload,
  buildWorkflowContinuationPrompt,
  getWorkflowShortcutProgressLabel,
  mergeRuntimeWithWorkflowDelta,
  resolveAutoWorkflowFollowupAction,
  runWorkflowShortcut,
  runWorkflowShortcutChain,
} from "./workflow-shortcut-runner";

function createSnapshot(): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Workflow Shortcut Project",
    currentObjective: "Generate the next deliverable",
    derivedStage: "directory",
    agentSummary: "summary",
    recommendedActions: ["Generate directory"],
    artifacts: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

function createQuestion(): ComposerQuestion {
  return {
    id: "script-directory-script-project-1",
    title: "Generate the directory next?",
    options: [
      {
        id: "generate-directory",
        label: "Generate directory",
        value: "Generate directory",
      },
    ],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-directory",
  };
}

function createRuntime(snapshot: ConversationProjectSnapshot): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: snapshot,
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [snapshot],
    recentMessageSummary: "",
  };
}

describe("runWorkflowShortcut", () => {
  it("exposes readable workflow progress labels for video script breakdown steps", () => {
    expect(getWorkflowShortcutProgressLabel("analyze_script_for_video")).toBe(
      "剧本拆解 [>] 初始化",
    );
    expect(getWorkflowShortcutProgressLabel("prepare_video_prompt_batch")).toBe(
      "镜头提示词 [>] 初始化",
    );
    expect(getWorkflowShortcutProgressLabel("prepare_segment_video_prompt")).toBe(
      "片段提示词 [>] 初始化",
    );
  });

  it("builds assistant payloads with the current step artifact label for creative-plan style replies", () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "setup",
      artifacts: [
        {
          id: "setup",
          kind: "setup",
          label: "项目设定",
          summary: "已确认项目设定",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "creative-plan",
      artifacts: [
        ...previousSnapshot.artifacts,
        {
          id: "plan",
          kind: "plan",
          label: "创意方案",
          summary: "已生成创意方案",
          updatedAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    };

    expect(
      buildWorkflowAssistantMessagePayload({
        action: "generate_creative_plan",
        input: { projectId: nextSnapshot.projectId },
        previousSnapshot,
        nextSnapshot,
        summary: "Generated creative plan.",
      }),
    ).toEqual({
      content: "Generated creative plan.",
      artifactIds: ["plan"],
      artifactSnapshots: [
        {
          id: "plan",
          kind: "plan",
          label: "创意方案",
          summary: "已生成创意方案",
          updatedAt: "2026-04-08T00:01:00.000Z",
        },
      ],
    });
  });

  it("hides generated segment prompt details from the homepage chat summary", () => {
    const previousSnapshot = createSnapshot();
    const nextSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectKind: "video",
      derivedStage: "片段提示词",
      artifacts: [
        {
          id: "segment-report",
          kind: "report",
          label: "片段提示词报告",
          summary: "已生成片段提示词",
          updatedAt: "2026-04-08T00:02:00.000Z",
        },
      ],
    };

    expect(
      buildWorkflowAssistantMessagePayload({
        action: "prepare_segment_video_prompt",
        input: { projectId: nextSnapshot.projectId },
        previousSnapshot,
        nextSnapshot,
        summary: [
          "已生成 1 个片段的合并视频提示词。",
          "片段列表：1-2",
          "已收口 2 个镜头的视频提示词批次。",
          "## 当前批次资产状态（文生视频模式）",
          "片段 1-2：待生成",
          "最终提示词稳定性：稳定。",
          "最终提示词日志：",
          "### 片段 1-2 最终提示词",
          "Scene 1",
          "Scene 2",
        ].join("\n"),
      }),
    ).toEqual({
      content: [
        "已生成 1 个片段的合并视频提示词。",
        "片段列表：1-2",
        "已收口 2 个镜头的视频提示词批次。",
        "## 当前批次资产状态（文生视频模式）",
        "片段 1-2：待生成",
      ].join("\n"),
      artifactIds: ["segment-report"],
      artifactSnapshots: [
        {
          id: "segment-report",
          kind: "report",
          label: "片段提示词报告",
          summary: "已生成片段提示词",
          updatedAt: "2026-04-08T00:02:00.000Z",
        },
      ],
    });
  });

  it("can defer the first recent-project insertion until streaming finishes", () => {
    const snapshot = createSnapshot();
    const runtime: StudioRuntimeState = {
      ...createRuntime(snapshot),
      currentProjectSnapshot: null,
      recentProjects: [],
    };

    const deferredRuntime = mergeRuntimeWithWorkflowDelta(
      runtime,
      {
        projectSnapshot: snapshot,
      },
      { deferRecentProjectUpsert: true },
    );

    expect(deferredRuntime.currentProjectSnapshot).toEqual(snapshot);
    expect(deferredRuntime.recentProjects).toEqual([]);

    const promotedRuntime = mergeRuntimeWithWorkflowDelta(deferredRuntime, {
      projectSnapshot: snapshot,
    });

    expect(promotedRuntime.recentProjects).toEqual([snapshot]);
  });

  it("publishes the assistant summary before auto-opening the follow-up popover after character generation", async () => {
    const snapshot = createSnapshot();
    const nextQuestion = createQuestion();
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_characters",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Generated characters.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "Enter character development",
    });

    expect(events).toContain("assistant:Generated characters.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Generated characters.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("keeps reference-image QA feedback out of chat when images are shown inline", async () => {
    const snapshot = createSnapshot();
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_video_reference_assets",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "已补齐 1 个参考资产。\n\n参考图 QA：通过 1 张，拦截并重试 1 张候选图。",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
        imageUrls: ["https://media.storyforge.test/hero-ref.jpg"],
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: () => events.push("suggest"),
      },
      userBubble: "补齐参考图",
    });

    expect(events.some((event) => event.startsWith("assistant:"))).toBe(false);
  });

  it("keeps segment QA feedback out of chat when videos are shown inline", async () => {
    const snapshot = createSnapshot();
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_segment_video",
      input: { projectId: snapshot.projectId, segmentLabel: "segment-1" },
      runtime,
      runAction: async () => ({
        summary: "Generated segment 1 video.\n\nQA: total 90, continuity 91, identity 89, semantic 90, visual 88, route pass.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
        videoUrls: ["https://media.storyforge.test/segment-1.mp4"],
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: () => events.push("suggest"),
      },
      userBubble: "Generate segment video",
    });

    expect(events.some((event) => event.startsWith("assistant:"))).toBe(false);
  });

  it("keeps refreshed segment QA feedback out of chat for chained shortcuts with inline videos", async () => {
    const snapshot = createSnapshot();
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcutChain({
      runtime,
      runAction: async (action) => ({
        summary:
          action === "refresh_segment_video"
            ? "Refreshed segment 1.\n\nQA: total 86, continuity 85, identity 87, semantic 84, visual 86, route local repair."
            : "noop",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
        videoUrls:
          action === "refresh_segment_video"
            ? ["https://media.storyforge.test/segment-1-refresh.mp4"]
            : [],
      }),
      steps: [
        {
          action: "refresh_segment_video",
          input: { projectId: snapshot.projectId, segmentLabel: "segment-1" },
        },
      ],
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: () => events.push("suggest"),
      },
      userBubble: "Refresh segment video",
    });

    expect(events.some((event) => event.startsWith("assistant:"))).toBe(false);
  });

  it("auto-opens the follow-up popover after episode batch writing completes", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "episodes",
      recommendedActions: ["Continue writing"],
      artifacts: [],
    };
    const snapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      derivedStage: "episodes",
      recommendedActions: ["质量审查", "合规审查"],
      artifacts: [
        {
          id: "episode-progress",
          kind: "episode",
          label: "分集撰写",
          summary: "正文已完成",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextQuestion: ComposerQuestion = {
      ...createQuestion(),
      id: "script-episode-script-project-1",
      title: "正文已完成，选择下一步",
      answerKey: "script-episode",
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_episode_batch",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Generated episode scripts.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "自动批量续写/补齐",
    });

    expect(events).toContain("popover");
    expect(events).toContain("assistant-artifacts:episode-progress");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the follow-up popover after episode quality review completes", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "episodes",
      recommendedActions: ["质量审查"],
      artifacts: [],
    };
    const snapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      recommendedActions: ["继续质检", "合规审查"],
      artifacts: [
        {
          id: "episode-review",
          kind: "episode-review",
          label: "本轮质检",
          summary: "质检完成",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextQuestion: ComposerQuestion = {
      ...createQuestion(),
      id: "script-episode-script-project-1",
      title: "质检完成，选择下一步",
      answerKey: "script-episode",
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "review_episode_quality",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Review completed.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "批量质量审查",
    });

    expect(events).toContain("popover");
    expect(events).toContain("assistant-artifacts:episode-review");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the follow-up popover after episode review repair completes", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "episodes",
      recommendedActions: ["质量审查"],
      artifacts: [],
    };
    const snapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      recommendedActions: ["继续质检", "合规审查"],
      artifacts: [
        {
          id: "episode-progress",
          kind: "episode",
          label: "分集撰写",
          summary: "修复完成",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextQuestion: ComposerQuestion = {
      ...createQuestion(),
      id: "script-episode-script-project-1",
      title: "修复完成，选择下一步",
      answerKey: "script-episode",
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "rewrite_episode_from_review",
      input: { projectId: snapshot.projectId, repairAll: true },
      runtime,
      runAction: async () => ({
        summary: "Repair completed.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "一键修复全部",
    });

    expect(events).toContain("popover");
    expect(events).toContain("assistant-artifacts:episode-progress");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the follow-up popover after video script breakdown completes", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
      derivedStage: "脚本拆解",
      currentObjective: "继续提取角色与场景",
      recommendedActions: ["继续提取角色与场景"],
    };
    const nextQuestion: ComposerQuestion = {
      id: "video-bridge-panel-video-project-1",
      title: "继续视频工作流",
      description: "继续提取角色与场景。",
      options: [
        {
          id: "video-bridge-entities",
          label: "提取角色与场景",
          value: "video:bridge:entities",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "analyze_script_for_video",
      input: { projectId: snapshot.projectId, episodeDuration: 90, videoPace: "medium" },
      runtime,
      runAction: async () => ({
        summary: "已完成剧本拆解。",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "完成剧本拆解",
    });

    expect(events).toContain("assistant:已完成剧本拆解。");
    expect(events).toContain("popover");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("scopes enter-drama-step assistant artifacts to the target step", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "单集细纲",
      artifacts: [
        { id: "setup", kind: "setup", label: "项目设定", summary: "setup", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "plan", kind: "plan", label: "创意方案", summary: "plan", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "characters", kind: "characters", label: "角色设定", summary: "characters", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "directory", kind: "directory", label: "分集目录", summary: "directory", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "outline", kind: "outline", label: "单集细纲", summary: "outline", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      derivedStage: "分集撰写",
      artifacts: [
        ...previousSnapshot.artifacts.map((artifact) => ({
          ...artifact,
          summary: `${artifact.summary} refreshed`,
        })),
        {
          id: "episode-progress",
          kind: "episode" as const,
          label: "分集撰写",
          summary: "episode preview",
          updatedAt: "2026-04-08T00:00:01.000Z",
        },
      ],
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "enter_drama_step",
      input: { projectId: nextSnapshot.projectId, step: "episodes" },
      runtime,
      runAction: async () => ({
        summary: "已进入分集撰写步骤，预览卡已经就绪。",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "进入分集撰写",
    });

    expect(events).toContain("assistant-artifacts:episode-progress");
  });

  it("keeps episode-duration updates scoped to the episode artifact", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "分集撰写",
      artifacts: [
        { id: "plan", kind: "plan", label: "创意方案", summary: "plan", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "characters", kind: "characters", label: "角色设定", summary: "characters", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "directory", kind: "directory", label: "分集目录", summary: "directory", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "outline", kind: "outline", label: "单集细纲", summary: "outline", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "episode-progress", kind: "episode", label: "分集撰写", summary: "60秒", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      artifacts: previousSnapshot.artifacts.map((artifact) => ({
        ...artifact,
        summary: artifact.id === "episode-progress" ? "90秒" : `${artifact.summary} refreshed`,
      })),
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "set_episode_duration_preference",
      input: { projectId: nextSnapshot.projectId, durationSeconds: 90 },
      runtime,
      runAction: async () => ({
        summary: "已将单集时长设为 90 秒。现在可以继续选择要生成的集数或直接自动批量续写。",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "90秒",
    });

    expect(events).toContain("assistant-artifacts:episode-progress");
  });

  it("uses the target-step artifact even when only older artifacts changed", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "分集目录",
      artifacts: [
        { id: "plan", kind: "plan", label: "创意方案", summary: "plan", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "outline", kind: "outline", label: "单集细纲", summary: "outline", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      derivedStage: "单集细纲",
      artifacts: [
        { ...previousSnapshot.artifacts[0], summary: "plan refreshed" },
        previousSnapshot.artifacts[1],
      ],
    };
    const runtime = createRuntime(previousSnapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "enter_drama_step",
      input: { projectId: nextSnapshot.projectId, step: "outlines" },
      runtime,
      runAction: async () => ({
        summary: "已进入单集细纲步骤，预览卡已经就绪。",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => events.push(`assistant-artifacts:${artifactIds?.join(",") ?? ""}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "进入单集细纲",
    });

    expect(events).toContain("assistant-artifacts:outline");
  });

  it("auto-opens the script follow-up popover after entering the outlines step", async () => {
    const nextQuestion: ComposerQuestion = {
      id: "script-outlines-script-project-1",
      title: "单集细纲预览已创建，选择生成方式",
      options: [
        {
          id: "outline-all",
          label: "生成全部细纲",
          value: "script:outline-generate-all",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-outlines",
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "单集细纲",
      artifacts: [
        { id: "directory", kind: "directory", label: "分集目录", summary: "directory", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "outline", kind: "outline", label: "单集细纲", summary: "0% preview", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
    };
    const runtime = createRuntime({
      ...nextSnapshot,
      derivedStage: "分集目录",
      artifacts: [nextSnapshot.artifacts[0]],
    });
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "enter_drama_step",
      input: { projectId: nextSnapshot.projectId, step: "outlines" },
      runtime,
      runAction: async () => ({
        summary: "已进入单集细纲步骤，预览卡已经就绪。",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "进入单集细纲",
    });

    expect(events).toContain("assistant:已进入单集细纲步骤，预览卡已经就绪。");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:已进入单集细纲步骤，预览卡已经就绪。")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the next video workflow popover after preparing a storyboard batch", async () => {
    const nextQuestion: ComposerQuestion = {
      id: "video-storyboard-frames-video-project-1",
      title: "继续生成分镜图",
      options: [
        {
          id: "generate-storyboard-frames",
          label: "继续生成分镜图",
          value: "video:bridge:storyboard-frames",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-storyboard-frames",
    };
    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-1",
      projectKind: "video",
      title: "Video Workflow Shortcut Project",
      currentObjective: "Prepare storyboard batch",
      derivedStage: "分镜批次",
      agentSummary: "summary",
      recommendedActions: ["继续生成分镜图"],
      artifacts: [],
      updatedAt: "2026-04-08T00:00:00.000Z",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "prepare_storyboard_batch",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Prepared storyboard batch.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "准备分镜批次",
    });

    expect(events).toContain("assistant:Prepared storyboard batch.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Prepared storyboard batch.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the next video workflow popover after compiling shot packets", async () => {
    const nextQuestion: ComposerQuestion = {
      id: "video-prompt-batch-video-project-1",
      title: "继续推进视频生成？",
      options: [
        {
          id: "prepare-video-prompt-batch",
          label: "视频提示词生成方式",
          value: "video:bridge:prompts",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-prompt-batch",
    };
    const snapshot: ConversationProjectSnapshot = {
      projectId: "video-project-1",
      projectKind: "video",
      title: "Video Workflow Shortcut Project",
      currentObjective: "Compile shot packets",
      derivedStage: "视频生成",
      agentSummary: "summary",
      recommendedActions: ["视频提示词生成方式"],
      artifacts: [],
      updatedAt: "2026-04-08T00:00:00.000Z",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    const completion = await runWorkflowShortcut({
      action: "compile_video_shot_packets",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Shot packets compiled.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "编译镜头指令包",
    });

    expect(completion?.pendingFollowup).toBeNull();
    expect(events).toContain("assistant:Shot packets compiled.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Shot packets compiled.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("only attaches artifacts whose content actually changed", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      artifacts: [
        {
          id: "setup-1",
          kind: "setup",
          label: "Project Setup",
          summary: "Setup stays the same",
          content: "Setup stays the same",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      updatedAt: "2026-04-08T00:05:00.000Z",
      artifacts: [
        {
          ...previousSnapshot.artifacts[0],
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
        {
          id: "plan-1",
          kind: "plan",
          label: "Creative Plan",
          summary: "New plan",
          content: "New plan",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
      ],
    };
    const runtime = createRuntime(previousSnapshot);
    const artifactPayloads: Array<string[] | undefined> = [];

    await runWorkflowShortcut({
      action: "generate_creative_plan",
      input: { projectId: previousSnapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Generated creative plan.",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => undefined,
        clearChoiceUi: () => undefined,
        commitRuntime: () => undefined,
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => artifactPayloads.push(artifactIds),
        pushUser: () => undefined,
        resetComposerDraft: () => undefined,
        setPopoverQuestion: () => undefined,
        setStreaming: () => undefined,
        setSuggested: () => undefined,
      },
      userBubble: "Generate creative plan",
    });

    expect(artifactPayloads).toEqual([["plan-1"]]);
  });

  it("keeps later workflow summaries scoped to the artifact kinds produced by that action", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "characters",
      artifacts: [
        {
          id: "characters-1",
          kind: "characters",
          label: "Character Setup",
          summary: "Original character summary",
          content: "Original character summary",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      derivedStage: "directory",
      updatedAt: "2026-04-08T00:05:00.000Z",
      artifacts: [
        {
          ...previousSnapshot.artifacts[0],
          summary: "Character summary with refreshed actions",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
        {
          id: "directory-1",
          kind: "directory",
          label: "Episode Directory",
          summary: "New directory",
          content: "New directory",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
      ],
    };
    const runtime = createRuntime(previousSnapshot);
    const artifactPayloads: Array<string[] | undefined> = [];

    await runWorkflowShortcut({
      action: "generate_directory",
      input: { projectId: previousSnapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Generated directory.",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => undefined,
        clearChoiceUi: () => undefined,
        commitRuntime: () => undefined,
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => artifactPayloads.push(artifactIds),
        pushUser: () => undefined,
        resetComposerDraft: () => undefined,
        setPopoverQuestion: () => undefined,
        setStreaming: () => undefined,
        setSuggested: () => undefined,
      },
      userBubble: "Generate directory",
    });

    expect(artifactPayloads).toEqual([["directory-1"]]);
  });

  it("keeps auto-adjust compliance summaries scoped to the compliance artifact", async () => {
    const previousSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "compliance",
      artifacts: [
        {
          id: "episode-1",
          kind: "episode",
          label: "Episode 1",
          summary: "Original episode",
          content: "Original episode",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        {
          id: "compliance-1",
          kind: "compliance",
          label: "Compliance Workspace",
          summary: "Original compliance",
          content: "Original compliance",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextSnapshot: ConversationProjectSnapshot = {
      ...previousSnapshot,
      updatedAt: "2026-04-08T00:05:00.000Z",
      artifacts: [
        {
          ...previousSnapshot.artifacts[0],
          summary: "Updated episode",
          content: "Updated episode",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
        {
          ...previousSnapshot.artifacts[1],
          summary: "Updated compliance",
          content: "Updated compliance",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
      ],
    };
    const runtime = createRuntime(previousSnapshot);
    const artifactPayloads: Array<string[] | undefined> = [];

    await runWorkflowShortcut({
      action: "auto_adjust_compliance",
      input: { projectId: previousSnapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Auto adjusted compliance.",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => undefined,
        clearChoiceUi: () => undefined,
        commitRuntime: () => undefined,
        getSuggestedQuestion: () => null,
        pushAssistant: (_content, artifactIds) => artifactPayloads.push(artifactIds),
        pushUser: () => undefined,
        resetComposerDraft: () => undefined,
        setPopoverQuestion: () => undefined,
        setStreaming: () => undefined,
        setSuggested: () => undefined,
      },
      userBubble: "Auto adjust compliance",
    });

    expect(artifactPayloads).toEqual([["compliance-1"]]);
  });

  it("preserves the full entity extraction summary when pushing the chat message", async () => {
    const runtime = createRuntime(createSnapshot());
    const nextSnapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectKind: "video",
      derivedStage: "角色与场景",
      artifacts: [
        {
          id: "video-characters",
          kind: "characters",
          label: "已整理 2 个角色",
          summary: "角色摘要",
          content: "1. 苏念\n   角色变体：\n   - 厨师服\n   - 职场装\n2. 高利贷头目",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
        {
          id: "video-scene-settings",
          kind: "scene-settings",
          label: "已整理 2 个场景",
          summary: "场景摘要",
          content: "1. 家庭厨房\n   场景变体：\n   - 暴雨夜\n2. CBD 写字楼",
          updatedAt: "2026-04-08T00:05:00.000Z",
        },
      ],
    };
    const assistantPayloads: string[] = [];

    await runWorkflowShortcut({
      action: "extract_video_entities",
      input: { projectId: "video-project-1" },
      runtime,
      runAction: async () => ({
        summary:
          "已从脚本中提取 2 个角色与 2 个场景设定。另外识别出 1 个角色变体与 1 个场景变体。\n\n角色：\n1. 苏念\n   昔日天才厨师，现阶段情绪紧绷。\n\n场景：\n1. 家庭厨房\n   空间凌乱，灯光昏黄。",
        projectSnapshot: nextSnapshot,
        data: {
          projectSnapshot: nextSnapshot,
        },
      }),
      ui: {
        activateConversation: () => undefined,
        clearChoiceUi: () => undefined,
        commitRuntime: () => undefined,
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => assistantPayloads.push(content),
        pushUser: () => undefined,
        resetComposerDraft: () => undefined,
        setPopoverQuestion: () => undefined,
        setStreaming: () => undefined,
        setSuggested: () => undefined,
      },
      userBubble: "继续提取角色与场景",
    });

    expect(assistantPayloads).toEqual([
      "已从脚本中提取 2 个角色与 2 个场景设定。另外识别出 1 个角色变体与 1 个场景变体。\n\n角色：\n1. 苏念\n   昔日天才厨师，现阶段情绪紧绷。\n\n场景：\n1. 家庭厨房\n   空间凌乱，灯光昏黄。",
    ]);
  });

  it("auto-opens the role-development follow-up after creative-plan generation", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "角色开发",
      recommendedActions: ["进入角色开发"],
    };
    const nextQuestion: ComposerQuestion = {
      id: "script-characters-script-project-1",
      title: "下一步：进入角色开发",
      options: [
        {
          id: "enter-characters",
          label: "进入角色开发",
          value: "进入角色开发",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-characters",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];
    let runCount = 0;

    await runWorkflowShortcut({
      action: "generate_creative_plan",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => {
        runCount += 1;
        return {
          summary: "Generated creative plan.",
          projectSnapshot: snapshot,
          data: {
            projectSnapshot: snapshot,
          },
        };
      },
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "Generate creative plan",
    });

    expect(runCount).toBe(1);
    expect(events).toContain("assistant:Generated creative plan.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Generated creative plan.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the generate-creative-plan follow-up after setup is saved", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "创作方案",
      recommendedActions: ["生成创作方案"],
      artifacts: [
        {
          id: "setup",
          kind: "setup",
          label: "项目设定",
          summary: "已确认项目设定",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
      ],
    };
    const nextQuestion: ComposerQuestion = {
      id: "script-creative-plan-script-project-1",
      title: "下一步：生成创作方案",
      options: [
        {
          id: "generate-plan",
          label: "生成创作方案",
          value: "script:generate-creative-plan",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-creative-plan",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "save_setup",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Saved setup.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "确认项目设定",
    });

    expect(events).toContain("assistant:Saved setup.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Saved setup.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the follow-up popover after outline generation finishes", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      derivedStage: "单集细纲",
      recommendedActions: ["继续生成第 1 集正文"],
    };
    const nextQuestion: ComposerQuestion = {
      id: "script-outlines-script-project-1",
      title: "细纲已完成，开始撰写正文？",
      options: [
        {
          id: "write-episode-1",
          label: "继续生成第 1 集正文",
          value: "script:episode-generate:1",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-outlines",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_outlines",
      input: { projectId: snapshot.projectId, keepCurrentStep: true },
      runtime,
      runAction: async () => ({
        summary: "Generated outlines.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "Generate outlines",
    });

    expect(events).toContain("assistant:Generated outlines.");
    expect(events).toContain("popover");
    expect(events.indexOf("assistant:Generated outlines.")).toBeLessThan(
      events.indexOf("popover"),
    );
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("suppresses assistant summaries for pending video generation actions", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-quiet",
      projectKind: "video",
      derivedStage: "视频生成",
      recommendedActions: ["继续轮询视频结果"],
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    await runWorkflowShortcut({
      action: "generate_video_assets",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "已提交 1 条镜头出片任务，当前优先走 Ark / Seedance API。",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "继续生成镜头 7",
    });

    expect(events).not.toContain("assistant:已提交 1 条镜头出片任务，当前优先走 Ark / Seedance API。");
  });

  it("adds script-to-video bridge instructions to the continuation prompt after export", () => {
    const prompt = buildWorkflowContinuationPrompt({
      action: "export_project",
      summary: "导出稿已准备完成，可继续接入视频工作流。",
      projectSnapshot: createSnapshot(),
    });

    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("video workflow");
  });

  it("adds video step guidance to the continuation prompt for video projects", () => {
    const prompt = buildWorkflowContinuationPrompt({
      action: "generate_video_assets",
      summary: "已提交第一批镜头生成。",
      projectSnapshot: {
        ...createSnapshot(),
        projectKind: "video",
        derivedStage: "视频生成",
      },
    });

    expect(prompt).toContain("step-by-step");
    expect(prompt).toContain("video");
  });

  it("auto-opens the next video workflow popover in fast mode instead of silently auto-following", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
      derivedStage: "角色与场景",
      recommendedActions: ["补齐角色与场景参考图"],
    };
    const nextQuestion: ComposerQuestion = {
      id: "video-bridge-panel",
      title: "继续角色与场景",
      options: [
        {
          id: "video-reference-assets",
          label: "补齐角色/场景参考图",
          value: "video:bridge:reference-assets",
        },
        {
          id: "video-advance-round",
          label: "让 Agent 连续推进一轮",
          value: "video:advance-round",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    const completion = await runWorkflowShortcut({
      action: "prepare_video_generation",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Video project prepared.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "进入视频工作流",
      allowAutoFollowup: true,
    });

    expect(completion?.pendingFollowup).toBeNull();
    expect(events).toContain("assistant:Video project prepared.");
    expect(events).toContain("popover");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("suppresses abort-like shortcut errors instead of rendering them as assistant failures", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];
    let errorCount = 0;

    const completion = await runWorkflowShortcut({
      action: "prepare_segment_video_prompt",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => {
        throw new Error("Aborted");
      },
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => null,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "补齐剩余片段",
      onError: () => {
        errorCount += 1;
      },
    });

    expect(completion).toBeNull();
    expect(errorCount).toBe(1);
    expect(events).not.toContain("assistant:Aborted");
    expect(events).not.toContain("popover");
    expect(events).not.toContain("suggest:null");
    expect(events.at(-1)).toBe("stream:false");
  });

  it("auto-opens the follow-up popover after media generation in creative mode", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
      derivedStage: "分镜图生成",
      recommendedActions: ["继续生成分镜图"],
    };
    const nextQuestion: ComposerQuestion = {
      id: "video-storyboard-panel",
      title: "继续推进分镜图？",
      options: [
        {
          id: "video-storyboard-continue",
          label: "继续推进",
          value: "video:bridge:storyboard-frames",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 2,
      totalSteps: 5,
      answerKey: "video-storyboard-panel",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    const completion = await runWorkflowShortcut({
      action: "generate_storyboard_frames",
      input: { projectId: snapshot.projectId },
      runtime,
      runAction: async () => ({
        summary: "Storyboard frames generated.",
        projectSnapshot: snapshot,
        data: {
          projectSnapshot: snapshot,
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "生成分镜图",
    });

    expect(completion?.pendingFollowup).toBeNull();
    expect(events).toContain("assistant:Storyboard frames generated.");
    expect(events).toContain("popover");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("auto-opens the follow-up popover after manually switching the video step", async () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
      derivedStage: "角色与场景",
    };
    const nextQuestion: ComposerQuestion = {
      id: "video-bridge-panel",
      title: "继续生成分镜图",
      options: [
        {
          id: "video-storyboard-frames",
          label: "补齐分镜图",
          value: "video:bridge:storyboard-frames",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 2,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };
    const runtime = createRuntime(snapshot);
    const events: string[] = [];

    const completion = await runWorkflowShortcut({
      action: "continue_video_step",
      input: { projectId: snapshot.projectId, targetStep: 3 },
      runtime,
      runAction: async () => ({
        summary: "Switched to storyboard step.",
        projectSnapshot: {
          ...snapshot,
          derivedStage: "分镜图生成",
        },
        data: {
          projectSnapshot: {
            ...snapshot,
            derivedStage: "分镜图生成",
          },
        },
      }),
      ui: {
        activateConversation: () => events.push("activate"),
        clearChoiceUi: () => events.push("clear"),
        commitRuntime: () => events.push("commit"),
        getSuggestedQuestion: () => nextQuestion,
        pushAssistant: (content) => events.push(`assistant:${content}`),
        pushUser: (content) => events.push(`user:${content}`),
        resetComposerDraft: () => events.push("reset"),
        setPopoverQuestion: () => events.push("popover"),
        setStreaming: (value) => events.push(`stream:${String(value)}`),
        setSuggested: (question) => events.push(`suggest:${question?.id ?? "null"}`),
      },
      userBubble: "切到《生成分镜图》",
    });

    expect(completion?.pendingFollowup).toBeNull();
    expect(events).toContain("assistant:Switched to storyboard step.");
    expect(events).toContain("popover");
    expect(events).not.toContain(`suggest:${nextQuestion.id}`);
  });

  it("never auto-follows video workflow panels just because they expose the advance-round shortcut", () => {
    const snapshot: ConversationProjectSnapshot = {
      ...createSnapshot(),
      projectId: "video-project-1",
      projectKind: "video",
      derivedStage: "角色与场景",
    };
    const nextQuestion: ComposerQuestion = {
      id: "video-bridge-panel",
      title: "继续角色与场景",
      options: [
        {
          id: "video-reference-assets",
          label: "补齐角色/场景参考图",
          value: "video:bridge:reference-assets",
        },
        {
          id: "video-advance-round",
          label: "让 Agent 连续推进一轮",
          value: "video:advance-round",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 5,
      answerKey: "video-bridge-panel",
    };

    expect(resolveAutoWorkflowFollowupAction(snapshot, nextQuestion)).toBeNull();
  });
});
