import { describe, expect, it, vi } from "vitest";
import { createScriptProjectChoiceHandler } from "./home-agent-script-choice-handlers";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { createEmptyComplianceWorkspace } from "@/types/drama";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Test Project",
    currentObjective: "Keep going",
    derivedStage: "剧本撰写",
    agentSummary: "Summary",
    recommendedActions: ["生成创作方案"],
    artifacts: [],
    ...overrides,
  };
}

function createDeps() {
  return {
    runWorkflowActionShortcut: vi.fn(),
    runWorkflowActionShortcutChain: vi.fn(),
    send: vi.fn(),
    showChoicePopover: vi.fn(),
    setPopoverOverride: vi.fn(),
    buildOutlinesWorkflowQuestion: () => null,
    buildEpisodeDurationGateQuestion: () => null,
    buildEpisodeWorkflowQuestion: () => null,
    listUnlockedCharacterCards: () => [],
    buildCharacterCardListQuestion: () => null,
    findCharacterCard: () => undefined,
    buildCharacterCardDecisionQuestion: () => null,
    listPendingCompliancePackets: () => [],
    buildComplianceListQuestion: () => null,
    findCompliancePacket: () => undefined,
    buildComplianceDecisionQuestion: () => null,
    listUnlockedBeatPackets: () => [],
    buildBeatPacketListQuestion: () => null,
    findBeatPacket: () => undefined,
    buildBeatPacketDecisionQuestion: () => null,
    onVideoKickoff: undefined as (() => void) | undefined,
  };
}

describe("createScriptProjectChoiceHandler", () => {
  it("routes creative-plan generation through the dedicated workflow shortcut", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot(), "生成创作方案", "生成创作方案");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_creative_plan",
      { projectId: "script-project-1" },
      "生成创作方案",
    );
    expect(deps.runWorkflowActionShortcutChain).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("routes role-development actions based on project kind", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot({ projectKind: "script" }), "进入角色开发", "进入角色开发");
    handler(createSnapshot({ projectId: "script-project-2", projectKind: "script" }), "推进角色设计", "推进角色设计");
    handler(createSnapshot({ projectId: "script-project-3", projectKind: "script" }), "进入角色开发步骤", "进入角色开发步骤");
    handler(
      createSnapshot({ projectId: "adaptation-project", projectKind: "adaptation" }),
      "补充人物冲突",
      "补充人物冲突",
    );

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "generate_characters",
      { projectId: "script-project-1" },
      "进入角色开发",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "generate_characters",
      { projectId: "script-project-2" },
      "推进角色设计",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "generate_characters",
      { projectId: "script-project-3" },
      "进入角色开发步骤",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      4,
      "generate_character_transform",
      { projectId: "adaptation-project" },
      "补充人物冲突",
    );
  });

  it("treats entering the traditional characters step as character generation", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ projectKind: "script" }),
      "script:step-enter-characters",
      "Enter characters",
    );

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_characters",
      { projectId: "script-project-1" },
      "Enter characters",
    );
  });

  it("opens the episode duration gate before entering episode writing", () => {
    const deps = createDeps();
    const durationQuestion: ComposerQuestion = {
      id: "duration-gate",
      title: "先确认单集目标时长",
      options: [
        { id: "duration-90", label: "90 秒", value: "script:episode-duration-gate:90" },
      ],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-episode-duration-gate",
    };
    deps.buildEpisodeDurationGateQuestion = vi.fn(() => durationQuestion);
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot({ derivedStage: "单集细纲" }), "script:step-enter-episodes", "进入分集撰写");

    expect(handled).toBe(true);
    expect(deps.setPopoverOverride).toHaveBeenCalledWith(durationQuestion);
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("enters episode writing only after confirming duration", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot({ derivedStage: "单集细纲" }), "script:episode-duration-gate:90", "90 秒");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "enter_drama_step",
      { projectId: "script-project-1", step: "episodes", durationSeconds: 90 },
      "90 秒",
    );
  });

  it("enters episode writing after confirming a custom duration", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot({ derivedStage: "单集细纲" }), "script:episode-duration-gate:custom:150", "自定义 150 秒");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "enter_drama_step",
      { projectId: "script-project-1", step: "episodes", durationSeconds: 150 },
      "自定义 150 秒",
    );
  });

  it("routes reference analysis and structure transform labels into workflow actions", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot({ projectKind: "adaptation" }), "分析参考内容", "分析参考内容");
    handler(createSnapshot({ projectKind: "adaptation" }), "结构转译", "结构转译");

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "analyze_reference_script",
      { projectId: "script-project-1" },
      "分析参考内容",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "generate_structure_transform",
      { projectId: "script-project-1" },
      "结构转译",
    );
  });

  it("routes adaptation preflight episode count and target market choices into workflow actions", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);
    const snapshot = createSnapshot({ projectKind: "adaptation" });

    handler(snapshot, "script:adaptation-total-episodes:custom:80", "AI 推荐（80集）");
    handler(snapshot, "script:adaptation-target-market:west", "欧美（英文）");
    handler(
      createSnapshot({ projectKind: "adaptation", derivedStage: "结构转译" }),
      "犯罪惊悚 / 浪漫喜剧",
      "犯罪惊悚 / 浪漫喜剧",
    );

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "confirm_adaptation_episode_count",
      { projectId: "script-project-1", totalEpisodes: 80 },
      "AI 推荐（80集）",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "confirm_adaptation_target_market",
      { projectId: "script-project-1", targetMarket: "west" },
      "欧美（英文）",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "confirm_adaptation_genres",
      { projectId: "script-project-1", genres: "犯罪惊悚 / 浪漫喜剧" },
      "犯罪惊悚 / 浪漫喜剧",
    );
  });

  it("routes directory outline batch options into the outline workflow action", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(
      createSnapshot({ derivedStage: "分集目录" }),
      "script:outline-generate-batch:1:30",
      "生成第一批次细纲",
    );
    handler(createSnapshot({ derivedStage: "分集目录" }), "script:outline-generate-all", "生成全部细纲");
    handler(createSnapshot({ derivedStage: "分集目录" }), "script:outline-fill-missing", "fill missing outlines");
    handler(createSnapshot({ derivedStage: "分集目录" }), "script:outline-regenerate-all", "重新生成细纲");

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "generate_outlines",
      { projectId: "script-project-1", rangeStart: 1, rangeEnd: 30, keepCurrentStep: true },
      "生成第一批次细纲",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "generate_outlines",
      { projectId: "script-project-1", keepCurrentStep: true },
      "生成全部细纲",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "generate_outlines",
      { projectId: "script-project-1", fillMissingOutlines: true, keepCurrentStep: true },
      "fill missing outlines",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      4,
      "generate_outlines",
      { projectId: "script-project-1", regenerateAll: true, keepCurrentStep: true },
      "重新生成细纲",
    );
  });

  it("routes single-outline regeneration with an optional adjustment instruction", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(
      createSnapshot({ derivedStage: "单集细纲" }),
      "script:outline-regenerate:7",
      "重新生成第 7 集细纲",
      {
        episodeNumber: 7,
        keepCurrentStep: true,
        customInstruction: "加强冲突，结尾钩子更狠",
      },
    );

    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "generate_outlines",
      {
        projectId: "script-project-1",
        episodeNumbers: [7],
        keepCurrentStep: true,
        customInstruction: "加强冲突，结尾钩子更狠",
      },
      "重新生成第 7 集细纲",
    );
  });

  it("routes episode review shortcuts without falling back to free-text send", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot(), "script:episode-review", "批量质检");
    handler(createSnapshot(), "script:episode-review:remaining", "补齐剩余批量审查");
    handler(createSnapshot(), "script:episode-review:repair-worst", "一键修复最差集");
    handler(createSnapshot(), "script:episode-review:repair:7", "修复第 7 集");
    handler(createSnapshot(), "script:episode-review:repair-all", "一键修复全部");

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "review_episode_quality",
      { projectId: "script-project-1", defaultReviewCount: 10 },
      "批量质检",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "review_episode_quality",
      { projectId: "script-project-1", reviewRemaining: true, defaultReviewCount: 10 },
      "补齐剩余批量审查",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "rewrite_episode_from_review",
      { projectId: "script-project-1" },
      "一键修复最差集",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      4,
      "rewrite_episode_from_review",
      { projectId: "script-project-1", episodeNumber: 7 },
      "修复第 7 集",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      5,
      "rewrite_episode_from_review",
      { projectId: "script-project-1", repairAll: true, repairLimit: 10 },
      "一键修复全部",
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("routes episode range generation and structured review selections into workflow input", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot(), "script:episode-generate-range:1-3%2C5", "按范围生成");
    handler(createSnapshot(), "script:episode-review:count:custom:7", "审查 7 集");
    handler(createSnapshot(), "script:episode-review:episodes:5-3%2C8", "按集号审查");
    handler(createSnapshot(), "script:episode-fill-missing", "自动批量补齐", { durationSeconds: 90 });

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "generate_episode_batch",
      { projectId: "script-project-1", episodeNumbers: [1, 2, 3, 5] },
      "按范围生成",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "review_episode_quality",
      { projectId: "script-project-1", reviewCount: 7 },
      "审查 7 集",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "review_episode_quality",
      { projectId: "script-project-1", episodeNumbers: [3, 4, 5, 8] },
      "按集号审查",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      4,
      "generate_episode_batch",
      { projectId: "script-project-1", fillMissingEpisodes: true, durationSeconds: 90 },
      "自动批量补齐",
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("routes both compliance modes as structured workflow input", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot({ derivedStage: "合规审查" }), "script:compliance-mode:text", "文字审查");
    handler(createSnapshot({ derivedStage: "合规审查" }), "script:compliance-mode:script", "剧情审查");

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "run_compliance_review",
      { projectId: "script-project-1", sourceStrategy: "project-script", reviewMode: "text" },
      "文字审查",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "run_compliance_review",
      { projectId: "script-project-1", sourceStrategy: "project-script", reviewMode: "script" },
      "剧情审查",
    );
  });

  it.skip("passes the current compliance settings explicitly when rerunning from the compliance stage", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(
      createSnapshot({
        derivedStage: "鍚堣瀹℃煡",
        artifacts: [
          {
            id: "compliance",
            kind: "compliance",
            label: "Compliance",
            summary: "Compliance summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "complianceSummary",
              mode: "script",
              strictness: "strict",
              report: "report",
              packets: [],
              workspace: {
                ...createEmptyComplianceWorkspace(),
                model: "gemini-3-pro-preview",
                dialogueReviewEnabled: true,
              },
              counts: { redLine: 0, highRisk: 0, suggestion: 0, pendingPackets: 0 },
            },
          },
        ],
      }),
      "script:compliance-rerun",
      "重新完整审查",
    );

    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "run_compliance_review",
      {
        projectId: "script-project-1",
        sourceStrategy: "project-script",
        reviewMode: "script",
        strictness: "strict",
        model: "gemini-3-pro-preview",
        dialogueReviewEnabled: true,
        smartRerun: true,
      },
      "重新完整审查",
    );
  });

  it("passes explicit compliance settings on rerun from a compliance snapshot", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({
        derivedStage: "\u5408\u89c4\u5ba1\u67e5",
        artifacts: [
          {
            id: "compliance",
            kind: "compliance",
            label: "Compliance",
            summary: "Compliance summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "complianceSummary",
              mode: "script",
              strictness: "strict",
              report: "report",
              packets: [],
              workspace: {
                ...createEmptyComplianceWorkspace(),
                model: "gemini-3-pro-preview",
                dialogueReviewEnabled: true,
              },
              counts: { redLine: 0, highRisk: 0, suggestion: 0, pendingPackets: 0 },
            },
          },
        ],
      }),
      "script:compliance-rerun",
      "重新完整审查",
    );

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "run_compliance_review",
      {
        projectId: "script-project-1",
        sourceStrategy: "project-script",
        reviewMode: "script",
        strictness: "strict",
        model: "gemini-3-pro-preview",
        dialogueReviewEnabled: true,
        smartRerun: true,
      },
      "重新完整审查",
    );
  });

  it("routes episode-stage compliance submenu choices and skip-review shortcut", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    handler(createSnapshot(), "script:episode-compliance:text", "文字审核");
    handler(createSnapshot(), "script:episode-compliance:script", "情节审核");
    handler(createSnapshot(), "script:episode-skip-compliance", "直接跳过审核");

    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      1,
      "run_compliance_review",
      { projectId: "script-project-1", sourceStrategy: "project-script", reviewMode: "text" },
      "文字审核",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      2,
      "run_compliance_review",
      { projectId: "script-project-1", sourceStrategy: "project-script", reviewMode: "script" },
      "情节审核",
    );
    expect(deps.runWorkflowActionShortcut).toHaveBeenNthCalledWith(
      3,
      "skip_compliance_review",
      { projectId: "script-project-1" },
      "直接跳过审核",
    );
  });

  it("toggles dialogue review as a silent shortcut without homepage messages", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "合规审查" }),
      "script:compliance-toggle-dialogue:on",
      "开启对话审查",
    );

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "update_compliance_workspace",
      {
        projectId: "script-project-1",
        dialogueReviewEnabled: true,
      },
      "开启对话审查",
      { skipUserBubble: true, skipAssistantSummary: true },
    );
  });

  it("exports the compliance palette as a silent shortcut without homepage messages", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "合规审查" }),
      "script:compliance-export:xlsx",
      "导出调色盘",
    );

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "export_compliance_palette",
      {
        projectId: "script-project-1",
        format: "xlsx",
      },
      "导出调色盘",
      { skipUserBubble: true, skipAssistantSummary: true },
    );
  });

  it("routes compliance auto-adjust with the project script source strategy", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "合规审查" }),
      "script:compliance-auto-adjust",
      "批量自动改写",
    );

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "auto_adjust_compliance",
      {
        projectId: "script-project-1",
        sourceStrategy: "project-script",
      },
      "批量自动改写",
    );
  });

  it("routes export refinement into the dedicated workflow action", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot(), "script:export-refine", "修改导出稿");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "refine_export_document",
      { projectId: "script-project-1" },
      "修改导出稿",
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("routes export patch analysis into the dedicated workflow action", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot(), "script:export-patch", "回头补写缺失章节或集数");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "analyze_export_patch",
      { projectId: "script-project-1" },
      "回头补写缺失章节或集数",
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("routes script export into video preparation without local bridge autofill", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot(), "script:export-video", "video export");

    expect(handled).toBe(true);
    expect(deps.runWorkflowActionShortcut).toHaveBeenCalledWith(
      "prepare_video_generation",
      {
        projectId: "script-project-1",
        sourceProjectId: "script-project-1",
        title: "Test Project",
      },
      "video export",
    );
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("prefers the dedicated video kickoff when it is available", () => {
    const deps = createDeps();
    deps.onVideoKickoff = vi.fn();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(createSnapshot(), "script:export-video", "video export");

    expect(handled).toBe(true);
    expect(deps.onVideoKickoff).toHaveBeenCalledTimes(1);
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
  });

  it("ignores character-card popovers outside the character stage", () => {
    const deps = createDeps();
    deps.buildCharacterCardListQuestion = () => ({
      id: "script-character-list-script-project-1",
      title: "角色卡列表",
      description: "desc",
      options: [],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-character-list",
    });
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "单集细纲" }),
      "script:character-list",
      "逐张检查角色卡",
    );

    expect(handled).toBe(true);
    expect(deps.showChoicePopover).not.toHaveBeenCalled();
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("ignores compliance popovers outside the compliance stage", () => {
    const deps = createDeps();
    deps.buildComplianceListQuestion = () => ({
      id: "script-compliance-list-script-project-1",
      title: "修订包列表",
      description: "desc",
      options: [],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-compliance-list",
    });
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "剧本撰写" }),
      "script:compliance-list",
      "逐条处理修订包",
    );

    expect(handled).toBe(true);
    expect(deps.showChoicePopover).not.toHaveBeenCalled();
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("ignores compliance workspace actions outside the compliance stage", () => {
    const deps = createDeps();
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "剧本撰写" }),
      "script:compliance-run:text",
      "文字审查",
    );

    expect(handled).toBe(true);
    expect(deps.showChoicePopover).not.toHaveBeenCalled();
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("ignores beat popovers outside the outline stage", () => {
    const deps = createDeps();
    deps.buildBeatPacketListQuestion = () => ({
      id: "script-beat-list-script-project-1",
      title: "beat 列表",
      description: "desc",
      options: [],
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-beat-list",
    });
    const handler = createScriptProjectChoiceHandler(deps);

    const handled = handler(
      createSnapshot({ derivedStage: "导出与出片" }),
      "script:beat-list",
      "逐条检查剧情 beat",
    );

    expect(handled).toBe(true);
    expect(deps.showChoicePopover).not.toHaveBeenCalled();
    expect(deps.runWorkflowActionShortcut).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });
});
