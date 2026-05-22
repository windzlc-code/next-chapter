import { describe, expect, it, vi } from "vitest";
const { exportScenesToXlsx } = vi.hoisted(() => ({
  exportScenesToXlsx: vi.fn(async () => undefined),
}));
vi.mock("@/lib/export-xlsx", () => ({
  exportScenesToXlsx,
}));
import { runWorkflowAction } from "./workflow-actions";
import {
  FULL_AUTO_ADAPTATION_SMOKE_SCENARIO,
  FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO,
  FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO,
  WORKFLOW_TEST_SCENARIO_KEY,
  WORKFLOW_TEST_TRACE_KEY,
} from "./workflow-test-overrides";
import type { StudioRuntimeState } from "./types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { createEmptyDramaProject, type DramaProject } from "@/types/drama";

const SKILL_DRAFTS_KEY = "storyforge-skill-drafts-v1";

function createRuntime(): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: {
      projectId: "project-1",
      projectKind: "script",
      title: "契约婚姻反转录",
      currentObjective: "继续完善创意方案。",
      derivedStage: "创意方案",
      agentSummary: "已整理创意方案和角色设定，建议优先进入分集目录。",
      recommendedActions: ["生成分集目录", "强化角色冲突", "补充人物口吻要求"],
      artifacts: [
        {
          id: "artifact-1",
          kind: "plan",
          label: "创意方案",
          summary: "女主与继承人的契约婚姻进入反转阶段。",
          updatedAt: "2026-04-03T00:00:00.000Z",
        },
      ],
      memory: {
        styleLock: null,
        worldModel: null,
        assetManifest: null,
        shotPackets: [],
        reviewQueue: [],
        characterStateCards: [
          {
            id: "drama-action-1-character-card-0",
            name: "沈昭",
            role: "女主",
            coreConflict: "在自保与信任之间摇摆。",
            desire: "查清旧案。",
            riskNote: "一旦失手会失去全部筹码。",
            relationshipAxis: ["顾承砚：先婚后爱"],
            stageFocus: "继续强化人物拉扯",
            status: "locked",
          },
        ],
        storyBeatPackets: [
          {
            id: "beat-1",
            episodeNumber: 1,
            title: "签下契约",
            beatSummary: "女主被迫签下婚姻契约。",
            hook: "契约签订",
            payoff: "发现男主另有目的。",
            status: "drafted",
          },
        ],
        complianceRevisionPackets: [
          {
            id: "compliance-1",
            issueTitle: "胁迫描写过重",
            riskLevel: "high",
            recommendation: "改成双方交换条件。",
            status: "pending",
          },
        ],
      },
    },
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "assistant: 继续保留第 2 集的张力。",
  };
}

describe("workflow-actions get_context", () => {
  it("can drive the full-auto original-script smoke override from localStorage", async () => {
    localStorage.setItem(WORKFLOW_TEST_SCENARIO_KEY, FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);

    const saveSetupResult = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "script",
        projectId: "session-full-auto-smoke-1",
        automationMode: "full-auto",
        setupMode: "creative",
        creativeInput: "雨夜重逢后，女主和冷面投资人联手追查旧案。",
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 40,
        targetMarket: "cn",
      },
      createRuntime(),
    );

    expect(saveSetupResult.projectSnapshot?.projectKind).toBe("script");
    expect(saveSetupResult.projectSnapshot?.projectId).toBe("session-full-auto-smoke-1");
    expect(saveSetupResult.projectSnapshot?.derivedStage).toBe("创意方案");

    const trace = JSON.parse(localStorage.getItem(WORKFLOW_TEST_TRACE_KEY) || "[]");
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenario: FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO,
          actionKind: "save_setup",
        }),
      ]),
    );

    localStorage.removeItem(WORKFLOW_TEST_SCENARIO_KEY);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);
  });

  it("can drive the full-auto adaptation smoke override from localStorage", async () => {
    localStorage.setItem(WORKFLOW_TEST_SCENARIO_KEY, FULL_AUTO_ADAPTATION_SMOKE_SCENARIO);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);

    const saveSetupResult = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "adaptation",
        projectId: "session-full-auto-adaptation-smoke-1",
        automationMode: "full-auto",
        referenceScript: "参考剧本正文",
        title: "Adaptation Smoke",
        totalEpisodes: 60,
        targetMarket: "cn",
      },
      createRuntime(),
    );

    expect(saveSetupResult.projectSnapshot?.projectKind).toBe("adaptation");
    expect(saveSetupResult.projectSnapshot?.projectId).toBe("session-full-auto-adaptation-smoke-1");

    const trace = JSON.parse(localStorage.getItem(WORKFLOW_TEST_TRACE_KEY) || "[]");
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenario: FULL_AUTO_ADAPTATION_SMOKE_SCENARIO,
          actionKind: "save_setup",
        }),
      ]),
    );

    localStorage.removeItem(WORKFLOW_TEST_SCENARIO_KEY);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);
  });

  it("can drive the full-auto video-workflow smoke override from localStorage", async () => {
    localStorage.setItem(WORKFLOW_TEST_SCENARIO_KEY, FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);

    const analyzeResult = await runWorkflowAction(
      "analyze_script_for_video",
      {
        projectId: "drama-project-video-entry",
        sourceProjectId: "drama-project-video-entry",
        automationMode: "full-auto",
      },
      createRuntime(),
    );

    expect(analyzeResult.projectSnapshot?.projectKind).toBe("video");
    expect(analyzeResult.projectSnapshot?.sourceProjectId).toBeTruthy();

    const trace = JSON.parse(localStorage.getItem(WORKFLOW_TEST_TRACE_KEY) || "[]");
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scenario: FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO,
          actionKind: "analyze_script_for_video",
        }),
      ]),
    );

    localStorage.removeItem(WORKFLOW_TEST_SCENARIO_KEY);
    localStorage.removeItem(WORKFLOW_TEST_TRACE_KEY);
  });

  it("creates an untitled adaptation project from minimal setup input", async () => {
    const result = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "adaptation",
        forceNewProject: true,
      },
      createRuntime(),
    );

    expect(result.projectSnapshot?.projectKind).toBe("adaptation");
    expect(result.projectSnapshot?.title).toBe("未命名改编项目");
    expect(result.data?.dramaProject?.mode).toBe("adaptation");
    expect(result.data?.dramaProject?.setup?.customTopic).toBe("");
    expect(result.data?.dramaProject?.setup?.creativeInput).toBe("");
  });

  it("writes structured original-script setup data and lands the project in the characters stage", async () => {
    const result = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "script",
        setupMode: "creative",
        genres: ["理财专家", "旅行博主"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 500,
        targetMarket: "west",
        customTopic: "强调身份反转和情绪拉扯",
        creativeInput: "替父还债的女孩签下契约婚姻后，发现继承人也在借她布局身份反转。",
      },
      createRuntime(),
    );

    expect(result.data?.dramaProject?.setup).toMatchObject({
      setupMode: "creative",
      genres: ["理财专家", "旅行博主"],
      audience: "女频",
      tone: "甜虐",
      ending: "HE",
      totalEpisodes: 500,
      targetMarket: "west",
      customTopic: "强调身份反转和情绪拉扯",
      creativeInput: "替父还债的女孩签下契约婚姻后，发现继承人也在借她布局身份反转。",
    });
    expect(result.data?.dramaProject?.currentStep).toBe("creative-plan");
    expect(result.projectSnapshot?.derivedStage).toBe("创意方案");
    expect(result.projectSnapshot?.currentObjective).toContain("角色开发");
  });

  it("does not complete original-script setup from a title-only first-turn save", async () => {
    const result = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "script",
        forceNewProject: true,
        title: "会话项目：你好",
      },
      {
        ...createRuntime(),
        currentProjectSnapshot: null,
        currentDramaProject: null,
      },
    );

    expect(result.data?.dramaProject?.setup).toBeNull();
    expect(result.data?.dramaProject?.currentStep).toBe("setup");
    expect(result.projectSnapshot?.derivedStage).toBe("立项设定");
    expect(result.summary).toContain("先确认原创立项方向");
  });

  it("reuses the current conversation project id when full-auto setup execution starts", async () => {
    const result = await runWorkflowAction(
      "save_setup",
      {
        projectKind: "script",
        projectId: "session-full-auto-1",
        automationMode: "full-auto",
        setupMode: "creative",
        genres: ["缇庨", "閮藉競"],
        audience: "濂抽",
        tone: "鐢滆檺",
        ending: "HE",
        totalEpisodes: 24,
        targetMarket: "cn",
        creativeInput: "缇庨鎽婁富涓庡喎闈㈡姇璧勪汉鍦ㄥ煄甯傚甯傜浉閬囷紝涓€璧锋墦閫犲搧鐗屻€?",
      },
      {
        ...createRuntime(),
        currentProjectSnapshot: {
          projectId: "session-full-auto-1",
          projectKind: "script",
          title: "浣犲ソ",
          currentObjective: "缁х画褰撳墠瀵硅瘽",
          derivedStage: "鍘嗗彶瀵硅瘽",
          agentSummary: "placeholder",
          recommendedActions: [],
          artifacts: [],
          automationMode: "full-auto",
        },
        currentDramaProject: null,
      },
    );

    expect(result.data?.dramaProject?.id).toBe("session-full-auto-1");
    expect(result.projectSnapshot?.projectId).toBe("session-full-auto-1");
    expect(result.projectSnapshot?.projectKind).toBe("script");
    expect(result.data?.dramaProject?.currentStep).toBe("creative-plan");
  });

  it("returns an agent-readable structured summary instead of raw JSON", async () => {
    const result = await runWorkflowAction("get_context", {}, createRuntime());

    expect(result.summary).toContain("当前项目：契约婚姻反转录 / script / 创意方案");
    expect(result.summary).toContain("推荐动作：");
    expect(result.summary).toContain("创意方案: 女主与继承人的契约婚姻进入反转阶段。");
    expect(result.summary).toContain("最近会话摘要：assistant: 继续保留第 2 集的张力。");
    expect(result.summary).toContain("角色状态卡：1 张");
    expect(result.summary).toContain("剧情 beat 包：1 条");
    expect(result.summary).toContain("合规修订包：1 条");
  });

  it("compiles shot packets and review memory for video projects", async () => {
    const videoProject: PersistedVideoProject = {
      id: "video-1",
      title: "古风追击短片",
      script: "女主在雨夜奔跑，回头看见追兵。",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
      productionNotes: "保留主角红衣和夜雨气氛。",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "雨夜追击",
          description: "女主在雨夜奔跑，回头看见追兵。",
          characters: ["沈昭"],
          dialogue: "",
          cameraDirection: "中景，跟拍",
          duration: 5,
          storyboardUrl: "https://cdn.storyforge.test/storyboard-1.jpg",
          videoUrl: "https://cdn.storyforge.test/video-1.mp4",
          videoStatus: "completed",
        },
      ],
      characters: [
        {
          id: "char-1",
          name: "沈昭",
          description: "红衣、清冷、警觉",
          imageUrl: "https://cdn.storyforge.test/char-1.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      sceneSettings: [
        {
          id: "setting-1",
          name: "雨夜长街",
          description: "冷色夜雨中的长街",
          imageUrl: "https://cdn.storyforge.test/scene-1.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      artStyle: "live-action",
      currentStep: 3,
      systemPrompt: "",
      analysisSummary: "已拆镜并整理角色场景。",
      storyboardPlan: "镜头 1：雨夜追击",
      videoPromptBatch: "",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const runtime: StudioRuntimeState = {
      ...createRuntime(),
      currentProjectSnapshot: null,
      currentVideoProject: videoProject,
    };

    const compiled = await runWorkflowAction("compile_video_shot_packets", {}, runtime);
    expect(compiled.projectSnapshot?.memory?.shotPackets?.length).toBe(1);
    expect(compiled.projectSnapshot?.memory?.assetManifest?.items.length).toBeGreaterThan(0);

    const reviewed = await runWorkflowAction(
      "redo_video_assets",
      { targetIds: [compiled.projectSnapshot?.memory?.shotPackets?.[0]?.id], reason: "夜雨颗粒感不够强" },
      {
        ...runtime,
        currentVideoProject: compiled.data?.videoProject ?? null,
        currentProjectSnapshot: compiled.projectSnapshot ?? null,
      },
    );

    expect(reviewed.projectSnapshot?.memory?.reviewQueue?.some((item) => item.status === "redo")).toBe(true);
    expect(reviewed.summary).toContain("重做");
  });

  it("routes storyboard xlsx export through the workflow registry", async () => {
    const videoProject: PersistedVideoProject = {
      id: "video-export-1",
      title: "Storyboard Export",
      script: "A heroine walks into the corridor.",
      targetPlatform: "抖音",
      shotStyle: "cinematic",
      outputGoal: "trailer",
      productionNotes: "",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Opening",
          description: "A heroine walks into the corridor.",
          characters: ["Hero"],
          dialogue: "",
          cameraDirection: "medium shot",
          duration: 5,
        },
      ],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction(
      "export_storyboard_xlsx",
      {},
      {
        ...createRuntime(),
        currentProjectSnapshot: null,
        currentVideoProject: videoProject,
      },
    );

    expect(exportScenesToXlsx).toHaveBeenCalledWith(
      videoProject.scenes,
      "Storyboard Export",
      videoProject.characters,
      videoProject.sceneSettings,
    );
    expect(result.projectSnapshot?.projectKind).toBe("video");
  });

  it("persists bridge platform fields onto the video project when creating the bridge artifact", async () => {
    const videoProject: PersistedVideoProject = {
      id: "video-bridge-fields-1",
      title: "Bridge Fields",
      script: "A heroine walks into the corridor.",
      targetPlatform: "",
      shotStyle: "",
      outputGoal: "",
      productionNotes: "",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Opening",
          description: "A heroine walks into the corridor.",
          characters: ["Hero"],
          dialogue: "",
          cameraDirection: "medium shot",
          duration: 5,
        },
      ],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction(
      "create_video_bridge_artifact",
      {
        projectId: videoProject.id,
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "预告片",
        productionNotes: "保留夜雨与追逐节奏",
      },
      {
        ...createRuntime(),
        currentProjectSnapshot: null,
        currentVideoProject: videoProject,
      },
    );

    expect(result.data?.videoProject).toMatchObject({
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
    });
    expect(result.projectSnapshot?.currentObjective).toContain("参考资产入口");
  });

  it("preserves existing bridge fields when only one field is written", async () => {
    const videoProject: PersistedVideoProject = {
      id: "video-bridge-fields-2",
      title: "Bridge Fields Partial",
      script: "A heroine walks into the corridor.",
      targetPlatform: "",
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
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction(
      "create_video_bridge_artifact",
      {
        projectId: videoProject.id,
        targetPlatform: "抖音",
      },
      {
        ...createRuntime(),
        currentProjectSnapshot: null,
        currentVideoProject: videoProject,
      },
    );

    expect(result.data?.videoProject).toMatchObject({
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
    });
  });

  it("locks script beat packets and resolves compliance revision packets", async () => {
    const dramaProject: DramaProject = {
      id: "drama-action-1",
      mode: "traditional",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 40,
        targetMarket: "cn",
      },
      creativePlan: "契约婚姻里的双向试探。",
      characters: "沈昭\n身份：女主\n核心冲突：在自保与信任之间摇摆",
      directory: [
        {
          number: 1,
          title: "签下契约",
          summary: "女主签下契约婚姻。",
          hookType: "强钩子",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "签约后发现男主另有目的。",
        },
      ],
      directoryRaw: "第1集：签下契约 - 女主签下契约婚姻。",
      episodes: [],
      complianceReport: "1. 高风险：契约胁迫感过重，建议改成双方交换条件。",
      currentStep: "compliance",
      dramaTitle: "契约婚姻反转录",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      referenceScript: "",
      referenceStructure: "",
      frameworkStyle: "",
      structureTransform: "",
      characterTransform: "",
      exportDocument: "",
      styleLock: null,
      worldModel: null,
      characterStateCards: [
        {
          id: "drama-action-1-character-card-0",
          name: "沈昭",
          role: "女主",
          coreConflict: "在自保与信任之间摇摆。",
          desire: "查清旧案。",
          riskNote: "失去最后筹码。",
          relationshipAxis: ["顾承砚：先婚后爱"],
          stageFocus: "继续强化人物拉扯",
          status: "pending",
        },
      ],
      storyBeatPackets: [
        {
          id: "drama-action-1-beat-1",
          episodeNumber: 1,
          title: "签下契约",
          beatSummary: "女主签下契约婚姻。",
          hook: "契约签订",
          payoff: "男主另有目的。",
          status: "drafted",
        },
      ],
      complianceRevisionPackets: [
        {
          id: "drama-action-1-compliance-0",
          issueTitle: "契约胁迫感过重",
          riskLevel: "high",
          recommendation: "改成双方交换条件。",
          status: "pending",
        },
      ],
    };

    const runtime: StudioRuntimeState = {
      ...createRuntime(),
      currentDramaProject: dramaProject,
      currentProjectSnapshot: null,
    };

    const locked = await runWorkflowAction(
      "lock_character_cards",
      { targetIds: ["drama-action-1-character-card-0"] },
      runtime,
    );
    expect(locked.projectSnapshot?.memory?.characterStateCards?.[0]?.status).toBe("locked");

    const beatLocked = await runWorkflowAction(
      "lock_story_beats",
      { targetIds: ["drama-action-1-beat-1"] },
      {
        ...runtime,
        currentDramaProject: locked.data?.dramaProject ?? null,
        currentProjectSnapshot: locked.projectSnapshot ?? null,
      },
    );
    expect(beatLocked.projectSnapshot?.memory?.storyBeatPackets?.[0]?.status).toBe("locked");

    const resolved = await runWorkflowAction(
      "resolve_compliance_revisions",
      { targetIds: ["drama-action-1-compliance-0"] },
      {
        ...runtime,
        currentDramaProject: beatLocked.data?.dramaProject ?? null,
        currentProjectSnapshot: beatLocked.projectSnapshot ?? null,
      },
    );
    expect(resolved.projectSnapshot?.memory?.complianceRevisionPackets?.[0]?.status).toBe("resolved");
  });

  it("approves and rejects pending skill drafts through workflow actions", async () => {
    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "先检查角色一致性，再检查镜头运动和情绪强度。",
          reason: "多次视频修复都重复了相同判断。",
          status: "pending",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
        {
          id: "skill-draft-2",
          sourceConversationIds: ["session-b"],
          proposedSkillName: "长对话静默压缩",
          proposedContent: "在消息超阈值时做静默摘要整理。",
          reason: "长会话需要减轻上下文噪音。",
          status: "pending",
          createdAt: "2026-04-03T00:10:00.000Z",
        },
      ]),
    );

    const approved = await runWorkflowAction("approve_skill_draft", { draftId: "skill-draft-1" }, createRuntime());
    expect(approved.summary).toContain("已批准技能草案");
    expect(approved.summary).toContain("已批准候选队列");
    expect(approved.data?.skillDrafts?.find((draft) => draft.id === "skill-draft-1")?.status).toBe("approved");
    expect(approved.data?.maintenanceReports?.[0]?.summary).toContain("已批准技能候选");

    const rejected = await runWorkflowAction("reject_skill_draft", { draftId: "skill-draft-2" }, createRuntime());
    expect(rejected.summary).toContain("已驳回技能草案");
    expect(rejected.data?.skillDrafts?.find((draft) => draft.id === "skill-draft-2")?.status).toBe("rejected");
    expect(rejected.data?.maintenanceReports?.[0]?.summary).toContain("驳回");

    const stored = JSON.parse(localStorage.getItem(SKILL_DRAFTS_KEY) || "[]");
    expect(stored.find((draft: { id: string }) => draft.id === "skill-draft-1")?.status).toBe("approved");
    expect(stored.find((draft: { id: string }) => draft.id === "skill-draft-2")?.status).toBe("rejected");
    const reports = JSON.parse(localStorage.getItem("storyforge-maintenance-reports-v1") || "[]");
    expect(reports[0]?.summary).toContain("驳回");
  });

  it("exposes skip-compliance-review through the workflow action registry", async () => {
    const dramaProject = {
      ...createEmptyDramaProject("traditional"),
      id: "drama-skip-review",
      dramaTitle: "跳过审核项目",
      currentStep: "episodes",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 1,
        targetMarket: "cn",
        customTopic: "",
      },
      creativePlan: "Creative plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    };

    const result = await runWorkflowAction("skip_compliance_review", {}, {
      ...createRuntime(),
      currentDramaProject: dramaProject,
      currentProjectSnapshot: null,
    });

    expect(result.data?.dramaProject?.currentStep).toBe("export");
    expect(result.projectSnapshot?.derivedStage).toBe("导出与出片");
  });

  it("exports approved skill drafts into the local candidate directory", async () => {
    const writeText = vi.fn(async (_filePath: string, _content: string) => ({ ok: true }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder: vi.fn(async () => undefined),
        writeText,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "先检查角色一致性，再检查镜头运动和情绪强度。",
          reason: "多次视频修复都重复了相同判断。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    const result = await runWorkflowAction("export_approved_skill_drafts", {}, createRuntime());

    expect(result.summary).toContain("已将 1 份已批准技能草案导出到本地候选目录");
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-drafts/approved/2026-04-03-镜头修复策略.md"),
      expect.stringContaining("# 镜头修复策略"),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-drafts/approved/README.md"),
      expect.stringContaining("Approved Skill Drafts"),
    );
    expect(result.data?.maintenanceReports?.[0]?.notes[0]).toContain("导出目录");
  });

  it("exports an approved skill bundle preview into the local candidate directory", async () => {
    const writeText = vi.fn(async (_filePath: string, _content: string) => ({ ok: true }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder: vi.fn(async () => undefined),
        writeText,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "先检查角色一致性，再检查镜头运动和情绪强度。",
          reason: "多次视频修复都重复了相同判断。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    const result = await runWorkflowAction("export_approved_skill_draft_bundle", {}, createRuntime());

    expect(result.summary).toContain("bundle 预览");
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-drafts/approved/bundle-preview.md"),
      expect.stringContaining("# InFinio Approved Skill Bundle Preview"),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-drafts/approved/bundle-preview.json"),
      expect.stringContaining("\"drafts\""),
    );
    expect(result.data?.maintenanceReports?.[0]?.notes[0]).toContain("Markdown");
  });

  it("packages approved skill drafts into controlled install candidates without auto-enabling them", async () => {
    const writeText = vi.fn(async (_filePath: string, _content: string) => ({ ok: true }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder: vi.fn(async () => undefined),
        writeText,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    localStorage.setItem(
      SKILL_DRAFTS_KEY,
      JSON.stringify([
        {
          id: "skill-draft-1",
          sourceConversationIds: ["session-a"],
          proposedSkillName: "镜头修复策略",
          proposedContent: "先检查角色一致性，再检查镜头运动和情绪强度。",
          reason: "多次视频修复都重复了相同判断。",
          status: "approved",
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ]),
    );

    const result = await runWorkflowAction("export_approved_skill_install_candidates", {}, createRuntime());

    expect(result.summary).toContain("正式 Skill 安装候选文件");
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-candidates/pending-install/镜头修复策略.md"),
      expect.any(String),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/skills-candidates/pending-install/INSTALL-REVIEW.md"),
      expect.any(String),
    );
    const candidateWrite = writeText.mock.calls.find((call) =>
      String(call[0]).includes("home-agent/skills-candidates/pending-install/镜头修复策略.md"),
    );
    expect(candidateWrite?.[1]).toContain("Candidate only. Review manually before moving into .claude/skills.");
    expect(candidateWrite?.[1]).toContain("Review Checklist");
    expect(result.data?.maintenanceReports?.[0]?.notes[2]).toContain("不会自动生效");
  });

  it("exports the current video production state bundle into a local audit directory", async () => {
    const writeText = vi.fn(async (_filePath: string, _content: string) => ({ ok: true }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder: vi.fn(async () => undefined),
        writeText,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    const videoProject: PersistedVideoProject = {
      id: "video-project-export",
      title: "雨夜追击预告片",
      script: "女主在雨夜奔跑，回头看见追兵。",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
      productionNotes: "保留主角红衣和夜雨气氛。",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "雨夜追击",
          description: "女主在雨夜奔跑，回头看见追兵。",
          characters: ["沈昭"],
          dialogue: "",
          cameraDirection: "中景，跟拍",
          duration: 5,
          storyboardUrl: "https://example.com/storyboard-1.jpg",
          videoUrl: "https://example.com/video-1.mp4",
          videoStatus: "completed",
        },
      ],
      characters: [
        {
          id: "char-1",
          name: "沈昭",
          description: "红衣、清冷、警觉",
          imageUrl: "https://example.com/char-1.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      sceneSettings: [
        {
          id: "setting-1",
          name: "雨夜长街",
          description: "冷色夜雨中的长街",
          imageUrl: "https://example.com/scene-1.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      artStyle: "live-action",
      currentStep: 4,
      systemPrompt: "",
      analysisSummary: "已拆镜并整理角色场景。",
      storyboardPlan: "镜头 1：雨夜追击",
      videoPromptBatch: "镜头 1 prompt",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction("export_video_production_bundle", {}, {
      ...createRuntime(),
      currentProjectSnapshot: {
        projectId: "video-project-export",
        projectKind: "video",
        title: "雨夜追击预告片",
        currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
        derivedStage: "镜头指令包",
        agentSummary: "当前已经具备资产清单、镜头指令包和待审阅状态。",
        recommendedActions: ["导出生产状态包", "视频提示词生成方式"],
        artifacts: [],
      },
      currentVideoProject: videoProject,
    });

    expect(result.summary).toContain("生产状态包");
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/production-state/雨夜追击预告片-video-project-export/overview.json"),
      expect.stringContaining("\"projectId\": \"video-project-export\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/production-state/雨夜追击预告片-video-project-export/world-model.json"),
      expect.any(String),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("home-agent/production-state/雨夜追击预告片-video-project-export/README.md"),
      expect.stringContaining("Video Production State Bundle"),
    );
    expect(result.data?.projectSnapshot?.recommendedActions).toEqual(
      expect.arrayContaining(["预览生产状态摘要", "打开生产状态目录", "导出生产状态包"]),
    );
    expect(result.data?.projectSnapshot?.artifacts[0]).toMatchObject({
      kind: "report",
      label: "生产状态包",
    });
    expect(result.data?.videoProject?.productionStateBundle).toMatchObject({
      directoryPath: "D:/StoryForgeFiles/home-agent/production-state/雨夜追击预告片-video-project-export",
      overviewPath:
        "D:/StoryForgeFiles/home-agent/production-state/雨夜追击预告片-video-project-export/README.md",
    });
  });

  it("exports the current asset manifest into a local media archive", async () => {
    const copyFile = vi.fn(async () => ({ ok: true }));
    const selectFolder = vi.fn(async () => "E:/Exports");
    const readBase64 = vi.fn(async () => ({ ok: true, exists: true, base64: "", mimeType: "image/jpeg" }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder,
        openFolder: vi.fn(async () => undefined),
        writeText: vi.fn(async () => ({ ok: true })),
        copyFile,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64,
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    const videoProject: PersistedVideoProject = {
      id: "video-project-export",
      title: "雨夜追击预告片",
      script: "script",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
      productionNotes: "",
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 3,
          sceneName: "天台追逐",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-2",
        },
      ],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 5,
      systemPrompt: "",
      analysisSummary: "",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: {
        version: "manifest-1",
        summary: "summary",
        items: [
          {
            id: "image-1",
            kind: "character-reference",
            label: "主角参考01",
            url: "C:/assets/hero.jpg",
            meta: "角色主参考",
            reusable: true,
            status: "ready",
            version: 1,
            createdAt: "2026-04-03T00:00:00.000Z",
          },
          {
            id: "video-1",
            kind: "video-segment",
            label: "镜头03片段1-2成片01",
            url: "C:/assets/shot-1.mp4",
            meta: "completed",
            reusable: false,
            status: "needs-review",
            sceneId: "scene-1",
            sceneNumber: 3,
            version: 1,
            createdAt: "2026-04-03T00:00:00.000Z",
          },
        ],
      },
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction("export_video_asset_bundle", {}, {
      ...createRuntime(),
      currentProjectSnapshot: {
        projectId: "video-project-export",
        projectKind: "video",
        title: "雨夜追击预告片",
        currentObjective: "整理素材并导出",
        derivedStage: "预览与导出",
        agentSummary: "当前可直接导出素材库。",
        recommendedActions: ["导出生产状态包"],
        artifacts: [],
        memory: {
          styleLock: null,
          worldModel: null,
          assetManifest: videoProject.assetManifest,
          shotPackets: [],
          reviewQueue: [],
        },
      },
      currentVideoProject: videoProject,
    });

    expect(selectFolder).toHaveBeenCalledTimes(1);
    expect(copyFile).toHaveBeenNthCalledWith(
      1,
      "C:/assets/hero.jpg",
      "E:/Exports/雨夜追击预告片/图片/角色/主角参考01.jpg",
    );
    expect(copyFile).toHaveBeenNthCalledWith(
      2,
      "C:/assets/shot-1.mp4",
      "E:/Exports/雨夜追击预告片/视频/第01集/片段1_2/镜头03片段1_2成片01.mp4",
    );
    expect(result.summary).toContain("已导出《雨夜追击预告片》的素材库归档");
    expect(result.summary).toContain("图片：1 项");
    expect(result.summary).toContain("视频：1 项");
  });

  it("previews the current video production state bundle without writing files", async () => {
    const writeText = vi.fn(async (_filePath: string, _content: string) => ({ ok: true }));
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder: vi.fn(async () => undefined),
        writeText,
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    const videoProject: PersistedVideoProject = {
      id: "video-project-export",
      title: "雨夜追击预告片",
      script: "女主在雨夜奔跑，回头看见追兵。",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
      productionNotes: "保留主角红衣和夜雨气氛。",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 4,
      systemPrompt: "",
      analysisSummary: "已拆镜并整理角色场景。",
      storyboardPlan: "镜头 1：雨夜追击",
      videoPromptBatch: "镜头 1 prompt",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction("preview_video_production_bundle", {}, {
      ...createRuntime(),
      currentProjectSnapshot: {
        projectId: "video-project-export",
        projectKind: "video",
        title: "雨夜追击预告片",
        currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
        derivedStage: "镜头指令包",
        agentSummary: "当前已经具备资产清单、镜头指令包和待审阅状态。",
        recommendedActions: ["导出生产状态包"],
        artifacts: [],
      },
      currentVideoProject: videoProject,
    });

    expect(result.summary).toContain("生产状态包摘要如下");
    expect(result.summary).toContain("场景数：0");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("opens the current video production state directory from workflow actions", async () => {
    const openFolder = vi.fn(async () => undefined);
    window.electronAPI = {
      dreaminaCli: {
        exec: vi.fn(),
      },
      jimeng: {
        writeFile: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        getDefaultPath: vi.fn(async () => ({ files: "D:/StoryForgeFiles", db: "D:/StoryForgeDb" })),
        selectFolder: vi.fn(async () => null),
        openFolder,
        writeText: vi.fn(async () => ({ ok: true })),
        readText: vi.fn(async () => ({ ok: true, exists: false, content: "" })),
        readBase64: vi.fn(async () => ({ ok: true, exists: false, base64: "" })),
      },
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: vi.fn(async () => true),
      },
    } as unknown as Window["electronAPI"];

    const videoProject: PersistedVideoProject = {
      id: "video-project-export",
      title: "雨夜追击预告片",
      script: "女主在雨夜奔跑，回头看见追兵。",
      targetPlatform: "抖音",
      shotStyle: "电影感近景",
      outputGoal: "预告片",
      productionNotes: "保留主角红衣和夜雨气氛。",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 4,
      systemPrompt: "",
      analysisSummary: "已拆镜并整理角色场景。",
      storyboardPlan: "镜头 1：雨夜追击",
      videoPromptBatch: "镜头 1 prompt",
      sourceProjectId: "drama-1",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:30:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
    };

    const result = await runWorkflowAction("open_video_production_bundle_directory", {}, {
      ...createRuntime(),
      currentProjectSnapshot: {
        projectId: "video-project-export",
        projectKind: "video",
        title: "雨夜追击预告片",
        currentObjective: "继续复核镜头指令包，并衔接提示词与生成。",
        derivedStage: "镜头指令包",
        agentSummary: "当前已经具备资产清单、镜头指令包和待审阅状态。",
        recommendedActions: ["导出生产状态包"],
        artifacts: [],
      },
      currentVideoProject: videoProject,
    });

    expect(openFolder).toHaveBeenCalledWith(
      "D:/StoryForgeFiles/home-agent/production-state/雨夜追击预告片-video-project-export",
    );
    expect(result.summary).toContain("已为你打开生产状态目录");
  });
});
