import { describe, expect, it } from "vitest";
import {
  buildVideoBridgePrefixQuestion,
  buildVideoBridgeQuestion,
  buildVideoBridgeRetryQuestion,
  buildVideoContinuationQuestion,
  buildVideoGenerationQuestion,
  buildVideoGenerationSceneListQuestion,
  buildScriptPacketQuestion,
  buildComplianceQuestion,
  buildEpisodeDurationGateQuestion,
  buildEpisodeWorkflowQuestion,
  ensureUniqueOptionIds,
  buildExportWorkflowQuestion,
  buildVideoRefreshSceneListQuestion,
  listVideoReferenceAssetTargetIds,
  recQuestion,
} from "./home-agent-project-questions";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { createDramaSnapshot, createVideoSnapshot as createProjectVideoSnapshot } from "@/lib/home-agent/project-store";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { createEmptyComplianceWorkspace, createEmptyDramaProject } from "@/types/drama";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "project-1",
    projectKind: "script",
    title: "Question Project",
    currentObjective: "Advance the workflow",
    derivedStage: "剧本撰写",
    agentSummary: "Summary",
    recommendedActions: [],
    artifacts: [],
    ...overrides,
  };
}

function createVideoSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "Video Question Project",
    currentObjective: "Advance the video workflow",
    derivedStage: "脚本拆解",
    agentSummary: "Summary",
    recommendedActions: [],
    artifacts: [],
    ...overrides,
  };
}

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "Video Question Project",
    script: "script body",
    scenes: [],
    characters: [],
    sceneSettings: [],
    shotPackets: [],
    ...overrides,
  } as PersistedVideoProject;
}

function createSegmentPrompt(segmentLabel: string) {
  return {
    segmentLabel,
    prompt: `prompt for ${segmentLabel}`,
    duration: 15,
    targetDuration: 15,
    modelKey: "doubao-seedance-1-5-pro",
    maxDurationForModel: 15,
    sceneIds: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function listQuestionValues(question: ComposerQuestion | null | undefined): string[] {
  if (!question) return [];
  const values: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    values.push(option.value);
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return values;
}

function listQuestionLabels(question: ComposerQuestion | null | undefined): string[] {
  if (!question) return [];
  const labels: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    labels.push(option.label);
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return labels;
}

function listQuestionOptionIds(question: ComposerQuestion | null | undefined): string[] {
  if (!question) return [];
  const ids: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    ids.push(option.id);
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return ids;
}

function findQuestionOption(
  question: ComposerQuestion | null | undefined,
  value: string,
): ComposerQuestion["options"][number] | null {
  if (!question) return null;
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    if (option.value === value) return option;
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return null;
}

describe("home agent project questions", () => {
  it("offers both compliance review modes from the compliance question", () => {
    const question = buildComplianceQuestion(
      createSnapshot({
        derivedStage: "合规审查",
        recommendedActions: ["重新跑剧情审核", "重新跑文字审核"],
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
              report: "report",
              packets: [],
              counts: {
                redLine: 0,
                highRisk: 1,
                suggestion: 2,
                pendingPackets: 0,
              },
            },
          },
        ],
      }),
    );

    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["script:compliance-mode:text", "script:compliance-mode:script"]),
    );
  });

  it("shows only one compliance exit action based on review state", () => {
    const pendingQuestion = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "合规审查",
      }),
    );
    expect(listQuestionValues(pendingQuestion)).toContain("script:skip-compliance-review");
    expect(listQuestionValues(pendingQuestion)).not.toContain("script:step-enter-export");
    expect(listQuestionValues(pendingQuestion)).not.toContain("script:compliance-auto-adjust");

    const reviewedQuestion = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "合规审查",
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
              mode: "text",
              report: "report",
              packets: [],
              workspace: {
                ...createEmptyComplianceWorkspace(),
                sourceText: "source",
                latestReview: {
                  reviewedAt: "2026-04-02T00:00:00.000Z",
                  segmentCount: 1,
                  sourceLength: 6,
                  reportLength: 6,
                },
              },
              counts: {
                redLine: 0,
                highRisk: 0,
                suggestion: 0,
                pendingPackets: 0,
              },
            },
          },
        ],
      }),
    );
    expect(listQuestionValues(reviewedQuestion)).toContain("script:step-enter-export");
    expect(listQuestionValues(reviewedQuestion)).not.toContain("script:skip-compliance-review");
  });

  it("builds episode-stage shortcuts for next episode and review from lightweight snapshots", () => {
    const snapshot = createSnapshot({
      derivedStage: "剧本撰写",
      recommendedActions: ["继续生成第 2 集", "做一轮已完成 1 集的批量质检", "准备合规审查"],
    });

    const question = buildEpisodeWorkflowQuestion(snapshot);

    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "script:episode-generate:2",
        "script:episode-review",
      ]),
    );
    expect(question?.options.some((option) => option.value === "script:step-enter-compliance")).toBe(false);
    expect(question?.options.some((option) => option.value === "script:episode-skip-compliance")).toBe(false);
  });

  it("builds structured episode workflow options from the batch-progress payload", () => {
    const base = createEmptyDramaProject("traditional");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "episode-payload-project",
      dramaTitle: "Episode Payload Project",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      currentStep: "episodes",
      preferredEpisodeDurationSeconds: 90,
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 3,
        targetMarket: "cn",
      },
      creativePlan: "Plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "反转",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "outline 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
          outline: "outline 2",
        },
        {
          number: 3,
          title: "Episode 3",
          summary: "summary 3",
          hookType: "悬念",
          isKey: false,
          isClimax: false,
          isPaywall: true,
          outline: "outline 3",
        },
      ],
      episodes: [{ number: 1, title: "Episode 1", content: "episode body 1", wordCount: 1200 }],
    });

    const question = buildEpisodeWorkflowQuestion(snapshot);
    const durationOption = question?.options.find((option) => option.value === "script:episode-duration");
    const writeOption = question?.options.find((option) => option.value === "script:episode-write");
    const reviewGroupOption = question?.options.find((option) => option.value === "script:episode-review-group");

    expect(question?.description).toContain("当前规格：场景");
    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "script:episode-duration",
        "script:episode-write",
        "script:episode-review-group",
        "script:step-enter-compliance",
        "script:episode-skip-compliance",
      ]),
    );
    expect(writeOption?.children?.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "script:episode-generate:2",
        "script:episode-generate-batch",
        "script:episode-fill-missing",
      ]),
    );
    expect(writeOption?.children?.find((option) => option.value === "script:episode-fill-missing")?.label).toBe(
      "批量自动撰写补齐",
    );
    expect(writeOption?.children?.some((option) => option.value === "script:episode-generate-range")).toBe(false);
    expect(reviewGroupOption?.children?.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "script:episode-review",
        "script:episode-review:single",
      ]),
    );
    const batchReviewOption = reviewGroupOption?.children?.find(
      (option) => option.value === "script:episode-review",
    );
    const singleReviewOption = reviewGroupOption?.children?.find(
      (option) => option.value === "script:episode-review:single",
    );
    expect(batchReviewOption?.children).toBeUndefined();
    expect(singleReviewOption?.children?.[0]).toMatchObject({
      label: "第 1 集",
      value: "script:episode-review:single-group:1",
    });
    expect(singleReviewOption?.children?.[0]?.children?.map((option) => option.value)).toEqual([
      "script:episode-review:single:1",
    ]);
    expect(reviewGroupOption?.children?.some((option) => option.value === "script:episode-review:count")).toBe(false);
    expect(reviewGroupOption?.children?.some((option) => option.value === "script:episode-review:episodes")).toBe(false);
    expect(durationOption?.children?.map((child) => child.value)).toEqual([
      "script:episode-duration:60",
      "script:episode-duration:90",
      "script:episode-duration:120",
    ]);
    expect(durationOption?.childInput).toMatchObject({
      type: "number",
      min: 30,
      max: 600,
      actionPrefix: "script:episode-duration:custom:",
    });
  });

  it("hides the fill-missing episode writing action before any body has been drafted", () => {
    const base = createEmptyDramaProject("traditional");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "episode-empty-project",
      dramaTitle: "Episode Empty Project",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      currentStep: "episodes",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 2,
        targetMarket: "cn",
      },
      creativePlan: "Plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      directory: [
        { number: 1, title: "Episode 1", summary: "summary 1", hookType: "反转", isKey: true, isClimax: false, isPaywall: false, outline: "outline 1" },
        { number: 2, title: "Episode 2", summary: "summary 2", hookType: "升级", isKey: false, isClimax: false, isPaywall: false, outline: "outline 2" },
      ],
    });

    const question = buildEpisodeWorkflowQuestion(snapshot);
    const writeOption = question?.options.find((option) => option.value === "script:episode-write");

    expect(writeOption?.children?.map((option) => option.value)).toEqual([
      "script:episode-generate:1",
      "script:episode-generate-batch",
    ]);
  });

  it("shows quality repair actions only after matching episode review packets exist", () => {
    const base = createEmptyDramaProject("traditional");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "reviewed-episode-project",
      dramaTitle: "Reviewed Episode Project",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      currentStep: "episodes",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 2,
        targetMarket: "cn",
      },
      creativePlan: "Plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      directory: [
        { number: 1, title: "Episode 1", summary: "summary 1", hookType: "反转", isKey: true, isClimax: false, isPaywall: false, outline: "outline 1" },
        { number: 2, title: "Episode 2", summary: "summary 2", hookType: "升级", isKey: false, isClimax: true, isPaywall: false, outline: "outline 2" },
      ],
      episodes: [
        { number: 1, title: "Episode 1", content: "episode body 1", wordCount: 1200 },
        { number: 2, title: "Episode 2", content: "episode body 2", wordCount: 1200 },
      ],
      episodeQualityReviewPackets: [
        {
          id: "review-1",
          episodeNumber: 1,
          title: "Episode 1",
          reviewedAt: "2026-04-02T00:00:00.000Z",
          rewriteInstruction: "修复第 1 集",
          result: {
            scores: {
              rhythm: { score: 6, comment: "节奏偏慢" },
              satisfaction: { score: 8, comment: "爽点清晰" },
              dialogue: { score: 7, comment: "台词可用" },
              format: { score: 9, comment: "格式正确" },
              continuity: { score: 8, comment: "连贯" },
            },
            total: 38,
            grade: "合格",
            highlights: [],
            issues: [{ level: "警告", description: "节奏偏慢" }],
            suggestions: ["压缩铺垫"],
          },
        },
      ],
    });

    const question = buildEpisodeWorkflowQuestion(snapshot);
    const reviewGroupOption = question?.options.find((option) => option.value === "script:episode-review-group");
    const batchReviewOption = reviewGroupOption?.children?.find((option) => option.value === "script:episode-review:batch-group");
    const singleReviewOption = reviewGroupOption?.children?.find((option) => option.value === "script:episode-review:single");
    const episodeOneOption = singleReviewOption?.children?.find((option) => option.value === "script:episode-review:single-group:1");
    const episodeTwoOption = singleReviewOption?.children?.find((option) => option.value === "script:episode-review:single-group:2");

    expect(reviewGroupOption?.children?.map((option) => option.value)).toEqual([
      "script:episode-review:batch-group",
      "script:episode-review:single",
      "script:episode-review:repair-all",
    ]);
    expect(batchReviewOption?.children?.map((option) => option.value)).toEqual([
      "script:episode-review",
      "script:episode-review:remaining",
      "script:episode-review:repair-worst",
    ]);
    expect(episodeOneOption?.children?.map((option) => option.value)).toEqual([
      "script:episode-review:single:1",
      "script:episode-review:repair:1",
    ]);
    expect(episodeTwoOption?.children?.map((option) => option.value)).toEqual([
      "script:episode-review:single:2",
    ]);
    expect(batchReviewOption?.children?.some((option) => option.rationale)).toBe(false);
    expect(episodeOneOption?.children?.some((option) => option.rationale)).toBe(false);
  });

  it("builds a pre-entry duration gate before episode writing", () => {
    const snapshot = createSnapshot({
      projectKind: "script",
      title: "Duration Gate Project",
      agentSummary: "强情绪复仇短剧",
      derivedStage: "单集细纲",
    });

    const question = buildEpisodeDurationGateQuestion(snapshot);

    expect(question?.answerKey).toBe("script-episode-duration-gate");
    expect(question?.description).toContain("进入分集撰写前");
    expect(question?.options.map((option) => option.value)).toEqual([
      "script:episode-duration-gate:60",
      "script:episode-duration-gate:90",
      "script:episode-duration-gate:120",
      "script:episode-duration-gate:custom",
    ]);
    expect(question?.options.find((option) => option.value === "script:episode-duration-gate:60")?.label).toContain("默认");
    expect(question?.options.some((option) => option.selected)).toBe(false);
    expect(question?.options.some((option) => option.label.includes("AI"))).toBe(false);
    expect(question?.options.find((option) => option.value === "script:episode-duration-gate:custom")?.childInput).toMatchObject({
      type: "number",
      min: 30,
      max: 600,
      actionPrefix: "script:episode-duration-gate:custom:",
    });
  });

  it("does not offer reference analysis before an adaptation document is uploaded", () => {
    const base = createEmptyDramaProject("adaptation");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "adaptation-empty-reference",
      dramaTitle: "Empty Adaptation",
      setup: {
        genres: [],
        audience: "全龄",
        tone: "爽",
        ending: "OE",
        totalEpisodes: 60,
        targetMarket: "cn",
        customTopic: "",
        creativeInput: "",
      },
      referenceScript: "",
      currentStep: "reference-script",
    });

    expect(buildScriptPacketQuestion(snapshot)).toBeNull();
  });

  it("front-loads adaptation episode count and target market before structure transform", () => {
    const base = createEmptyDramaProject("adaptation");
    const common = {
      ...base,
      id: "adaptation-config-flow",
      dramaTitle: "Adaptation Config Flow",
      setup: {
        genres: [],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 80,
        targetMarket: "west",
        customTopic: "",
        creativeInput: "",
      },
      referenceScript: "参考剧本文本",
      referenceStructure: "故事主线：参考结构分析",
      currentStep: "structure-transform" as const,
    };

    const episodeQuestion = buildScriptPacketQuestion(createDramaSnapshot(common));
    expect(episodeQuestion?.answerKey).toBe("script-adaptation-episode-count");
    expect(episodeQuestion?.options[0]?.label).toBe("AI 推荐（80集）");
    expect(listQuestionValues(episodeQuestion)).toContain("script:adaptation-total-episodes:80");

    const targetMarketQuestion = buildScriptPacketQuestion(createDramaSnapshot({
      ...common,
      adaptationEpisodeCountConfirmed: true,
    }));
    expect(targetMarketQuestion?.answerKey).toBe("script-adaptation-target-market");
    expect(listQuestionValues(targetMarketQuestion)).toContain("script:adaptation-target-market:west");

    const genreQuestion = buildScriptPacketQuestion(createDramaSnapshot({
      ...common,
      adaptationEpisodeCountConfirmed: true,
      adaptationTargetMarketConfirmed: true,
    }));
    expect(genreQuestion?.answerKey).toBe("题材选择");
    expect(listQuestionValues(genreQuestion)).toContain("犯罪惊悚");

    const structureQuestion = buildScriptPacketQuestion(createDramaSnapshot({
      ...common,
      adaptationEpisodeCountConfirmed: true,
      adaptationTargetMarketConfirmed: true,
      adaptationGenresConfirmed: true,
    }));
    expect(structureQuestion?.answerKey).toBe("script-structure-transform-v2");
    expect(listQuestionValues(structureQuestion)).toContain("script:generate-structure-transform");
  });

  it("shows only the character transform artifact for adaptation character output", () => {
    const base = createEmptyDramaProject("adaptation");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "adaptation-character-transform",
      dramaTitle: "Adaptation Character Transform",
      setup: {
        genres: ["犯罪惊悚"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 80,
        targetMarket: "west",
        customTopic: "",
        creativeInput: "",
      },
      currentStep: "character-transform",
      referenceScript: "参考文本",
      referenceStructure: "参考结构",
      structureTransform: "结构转译内容",
      characters: "角色转译内容",
      characterTransform: "角色转译内容",
    });

    const characterArtifacts = snapshot.artifacts.filter((artifact) => artifact.kind === "characters");

    expect(characterArtifacts.map((artifact) => artifact.label)).toEqual(["角色转译"]);
  });

  it("builds export-stage shortcuts for refine, video bridge, and patch planning", () => {
    const question = buildExportWorkflowQuestion(
      createSnapshot({
        derivedStage: "导出与出片",
        recommendedActions: ["修改导出稿", "接入视频工作流", "回头补写缺失章节或集数"],
        artifacts: [
          {
            id: "export",
            kind: "export",
            label: "Export",
            summary: "Export summary",
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["script:export-refine", "script:export-video", "script:export-patch"]),
    );
  });

  it("does not let character-card prompts override later script stages", () => {
    const base = createEmptyDramaProject("traditional");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "episode-question-project",
      dramaTitle: "Episode Question Project",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      currentStep: "episodes",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 2,
        targetMarket: "cn",
      },
      creativePlan: "Plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "反转",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "outline 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
          outline: "outline 2",
        },
      ],
      episodes: [{ number: 1, title: "Episode 1", content: "episode body 1", wordCount: 1200 }],
      characterStateCards: [
        {
          id: "episode-question-project-character-card-0",
          name: "沈昭",
          role: "女主",
          coreConflict: "在自保与信任之间摇摆。",
          desire: "查清旧案。",
          riskNote: "一旦失手会失去全部筹码。",
          relationshipAxis: ["顾承砚：先婚后爱"],
          stageFocus: "继续强化人物拉扯",
          status: "pending",
        },
      ],
    });

    const question = buildScriptPacketQuestion(snapshot);

    expect(question?.answerKey).toBe("script-episode");
  });

  it("keeps the role stage focused on the role workflow card", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "角色设定",
        recommendedActions: ["生成分集目录"],
        artifacts: [
          {
            id: "characters",
            kind: "characters",
            label: "角色设定",
            summary: "主角设定已完成",
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
        memory: {
          characterStateCards: [
            {
              id: "role-card-1",
              name: "沈昭",
              role: "女主",
              coreConflict: "在自保与信任之间摇摆。",
              desire: "查清旧案。",
              riskNote: "一旦失手会失去全部筹码。",
              relationshipAxis: ["顾承砚：先婚后爱"],
              stageFocus: "继续强化人物拉扯",
              status: "pending",
            },
          ],
        },
      }),
    );

    expect(question?.answerKey).toBe("script-characters");
  });

  it("keeps the role-entry panel available right after creative-plan completion", () => {
    const base = createEmptyDramaProject("traditional");
    const snapshot = createDramaSnapshot({
      ...base,
      id: "role-entry-project",
      dramaTitle: "Role Entry Project",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
      currentStep: "characters",
      setup: {
        genres: ["都市言情"],
        audience: "女频",
        tone: "甜虐",
        ending: "HE",
        totalEpisodes: 2,
        targetMarket: "cn",
      },
      creativePlan: "A locked creative plan.",
      characters: "",
      directory: [],
      episodes: [],
    });

    const question = recQuestion(snapshot);

    expect(question?.answerKey).toBe("script-characters");
    expect(question?.options.map((option) => option.value)).toContain("进入角色开发");
  });

  it("keeps legacy role-stage actions on the role workflow card", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "角色设定",
        recommendedActions: ["继续角色设定"],
      }),
    );

    expect(question?.answerKey).toBe("script-characters");
  });

  it("keeps the directory stage focused on the directory workflow card", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "分集目录",
        recommendedActions: ["生成全部细纲", "重新生成细纲"],
        artifacts: [
          {
            id: "directory",
            kind: "directory",
            label: "分集目录",
            summary: "目录已完成",
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
        memory: {
          storyBeatPackets: [
            {
              id: "beat-1",
              episodeNumber: 1,
              title: "签下契约",
              beatSummary: "女主被迫签下婚姻契约。",
              hook: "契约签订",
              payoff: "男主暴露隐藏目的。",
              status: "drafted",
            },
          ],
        },
      }),
    );

    expect(question?.answerKey).toBe("script-directory");
    expect(question?.submissionMode).toBe("confirm");
    expect(question?.options.map((option) => option.value)).toEqual([
      "script:step-enter-outlines",
    ]);
  });

  it("keeps the outline stage focused on the outline workflow card", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "单集细纲",
        recommendedActions: ["继续生成第 2 集正文"],
        artifacts: [
          {
            id: "outline",
            kind: "outline",
            label: "第 1 集细纲",
            summary: "细纲已完成",
            updatedAt: "2026-04-02T00:00:00.000Z",
          },
        ],
        memory: {
          complianceRevisionPackets: [
            {
              id: "compliance-1",
              issueTitle: "高风险台词",
              riskLevel: "high",
              recommendation: "改写台词",
              affectedEpisodeNumbers: [1],
              status: "pending",
            },
          ],
          storyBeatPackets: [
            {
              id: "beat-1",
              episodeNumber: 1,
              title: "签下契约",
              beatSummary: "女主被迫签下婚姻契约。",
              hook: "契约签订",
              payoff: "男主暴露隐藏目的。",
              status: "drafted",
            },
          ],
        },
      }),
    );

    expect(question?.answerKey).toBe("script-outlines");
  });

  it("shows outline batch options after the directory artifact enters the outlines stage", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: "单集细纲",
        recommendedActions: ["生成全部细纲", "重新生成细纲"],
        artifacts: [
          {
            id: "directory",
            kind: "directory",
            label: "分集目录",
            summary: "目录已完成",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "directory+stats",
              entries: [
                {
                  number: 1,
                  title: "第 1 集",
                  summary: "summary 1",
                  hookType: "反转",
                  isKey: true,
                  isClimax: false,
                  isPaywall: false,
                  emotionLevel: 3,
                },
                {
                  number: 2,
                  title: "第 2 集",
                  summary: "summary 2",
                  hookType: "升级",
                  isKey: false,
                  isClimax: true,
                  isPaywall: false,
                  emotionLevel: 4,
                },
              ],
              stats: {
                totalEpisodes: 2,
                outlinedEpisodes: 0,
                writtenEpisodes: 0,
                keyEpisodes: 1,
                climaxEpisodes: 1,
                paywallEpisodes: 0,
              },
            },
          },
          {
            id: "outline-preview",
            kind: "outline",
            label: "细纲预览",
            summary: "细纲批次尚未完成，继续按批次推进。",
            updatedAt: "2026-04-02T00:00:00.000Z",
            presentation: "script-rich",
            payload: {
              type: "outlines+batchProgress",
              totalEpisodes: 2,
              entries: [],
              batchProgress: {
                total: 1,
                done: 0,
                failed: 0,
                processing: 0,
                percent: 0,
                batches: [
                  {
                    index: 0,
                    label: "第1-2集",
                    startEp: 1,
                    endEp: 2,
                    status: "pending",
                  },
                ],
              },
            },
          },
        ],
      }),
    );

    expect(question?.answerKey).toBe("script-outlines");
    expect(question?.options.map((option) => option.value)).toEqual([
      "script:outline-generate-batch:1:2",
      "script:outline-generate-all",
      "script:outline-generate-single:1",
    ]);
    expect(question?.options[0]?.label).toContain("批次细纲");
  });

  it("does not fall back to generic recovery cards for strict script stages", () => {
    const question = recQuestion(
      createSnapshot({
        derivedStage: "单集细纲",
        currentObjective: "先锁定剧情 beat。",
        recommendedActions: ["锁定剧情 beat", "继续写第 1 集"],
        memory: {
          storyBeatPackets: [
            {
              id: "beat-1",
              episodeNumber: 1,
              title: "签下契约",
              beatSummary: "女主被迫签下婚姻契约。",
              hook: "契约签订",
              payoff: "男主暴露隐藏目的。",
              status: "drafted",
            },
          ],
        },
      }),
    );

    expect(question).toBeNull();
  });

  it("hides entity extraction in the video bridge panel before any storyboard scenes exist", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "脚本拆解" }),
      createVideoProject(),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:analyze");
    expect(values).not.toContain("video:bridge:entities");
  });

  it("adds a clickable retry option when script episodes are not fully covered by scenes", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "脚本拆解" }),
      createVideoProject({
        script: "第1集：开端\n正文\n\n第2集：推进\n正文\n\n第3集：转折\n正文",
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "1-1" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", description: "", characters: [], dialogue: "", cameraDirection: "", duration: 5, segmentLabel: "2-1" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:analyze:retry-missing");
  });

  it("does not surface the dedicated bridge prefix panel from recQuestion before the video script workflow begins", () => {
    const question = recQuestion(
      createVideoSnapshot({ derivedStage: "鑴氭湰鎷嗚В" }),
      createVideoProject(),
    );

    expect(question?.answerKey).not.toBe("video-bridge-prefix");
  });

  it("removes the dedicated bridge prefix panel once all three fields are written", () => {
    const question = buildVideoBridgePrefixQuestion(
      createVideoSnapshot({ derivedStage: "鑴氭湰鎷嗚В" }),
      createVideoProject({
        targetPlatform: "鎶栭煶",
        shotStyle: "鐢靛奖鎰熻繎鏅?",
        outputGoal: "棰勫憡鐗?",
      }),
    );

    expect(question).toBeNull();
  });

  it("returns the script-analysis panel first after all three bridge fields are written", () => {
    const question = recQuestion(
      createVideoSnapshot({ derivedStage: "脚本拆解" }),
      createVideoProject({
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "预告片",
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:analyze");
    expect(listQuestionValues(question)).not.toContain("video:bridge:analyze:dur:90");
  });

  it("builds a dedicated retry panel for failed platform and shot preference autofill", () => {
    const question = buildVideoBridgeRetryQuestion(
      createVideoSnapshot({ derivedStage: "鑴氭湰鎷嗚В" }),
    );

    expect(question?.answerKey).toBe("video-bridge-retry");
    expect(listQuestionValues(question)).toEqual(["video:bridge:platform"]);
  });

  it("keeps entity extraction hidden in step 1 until platform and shot style are both ready", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "脚本拆解" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        targetPlatform: "",
        shotStyle: "",
        outputGoal: "预告片",
      }),
    );

    expect(listQuestionValues(question)).not.toContain("video:bridge:entities");
  });

  it("unlocks entity extraction after platform and shot style are filled even if output goal is still empty", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "脚本拆解" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "",
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:entities");
  });

  it("hides storyboard actions in the role-and-scene stage until reference assets are ready", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:entities");
    expect(values).not.toContain("video:bridge:storyboard");
  });

  it("adds separate character and scene asset branches in the role-and-scene panel", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Warehouse", description: "desc", imageUrl: "" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:reference-assets:characters");
    expect(values).toContain("video:bridge:reference-assets:character:char-1");
    expect(values).toContain("video:bridge:reference-assets:scenes");
    expect(values).toContain("video:bridge:reference-assets:scene:setting-1");
    expect(findQuestionOption(question, "video:bridge:reference-assets:character:char-1")?.label).toBe("Hero");
    expect(findQuestionOption(question, "video:bridge:reference-assets:scene:setting-1")?.label).toBe("Warehouse");
  });

  it("adds variant submenus and keeps generated items visible in the role-and-scene panel", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
            costumes: [{ id: "cost-1", label: "校服", description: "蓝白校服", isAIGenerated: false }],
          },
          {
            id: "char-2",
            name: "Veteran",
            description: "ready",
            imageUrl: "ready.png",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "desc",
            imageUrl: "",
            timeVariants: [{ id: "time-1", label: "雨夜", description: "屋顶漏雨，冷蓝夜光", isAIGenerated: false }],
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:reference-assets:character:char-1");
    expect(values).toContain("video:bridge:reference-assets:character:char-2");
    expect(values).toContain("video:bridge:reference-assets:character-main:char-1");
    expect(values).toContain("video:bridge:reference-assets:character-variants:char-1");
    expect(values).toContain("video:bridge:reference-assets:character-variant:char-1:cost-1");
    expect(values).toContain("video:bridge:reference-assets:scene-main:setting-1");
    expect(values).toContain("video:bridge:reference-assets:scene-variant:setting-1:time-1");
    expect(findQuestionOption(question, "video:bridge:reference-assets:character-variant:char-1:cost-1")?.disabled).toBe(true);
    expect(findQuestionOption(question, "video:bridge:reference-assets:character-variant:char-1:cost-1")?.rationale).toContain("缺少角色主参考图");
    expect(findQuestionOption(question, "video:bridge:reference-assets:scene-variant:setting-1:time-1")?.disabled).toBe(true);
    expect(findQuestionOption(question, "video:bridge:reference-assets:scene-variant:setting-1:time-1")?.rationale).toContain("缺少场景主参考图");
  });

  it("offers a text-to-video batch asset action that includes main references and variants", () => {
    const project = createVideoProject({
      currentStep: 2,
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
      scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1" }] as PersistedVideoProject["scenes"],
      characters: [{
        id: "char-1",
        name: "Hero",
        description: "desc",
        imageUrl: "",
        costumes: [{ id: "cost-1", label: "校服", description: "蓝白校服", imageUrl: "" }],
      }] as PersistedVideoProject["characters"],
      sceneSettings: [{
        id: "setting-1",
        name: "Warehouse",
        description: "desc",
        imageUrl: "",
        timeVariants: [{ id: "time-1", label: "雨夜", description: "冷蓝夜光", imageUrl: "" }],
      }] as PersistedVideoProject["sceneSettings"],
    });
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      project,
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:reference-assets:full");
    expect(findQuestionOption(question, "video:bridge:reference-assets:full")?.label).toBe("智能补图 4/4");
    const recommendedValues = findQuestionOption(question, "video:panel:video-bridge-panel-recommended")
      ?.children?.map((option) => option.value) ?? [];
    expect(recommendedValues).toContain("video:bridge:reference-assets:full");
    expect(recommendedValues).toContain("video:bridge:shots");
    expect(recommendedValues).not.toContain("video:bridge:prompts");
    const bulkValues = findQuestionOption(question, "video:panel:video-bridge-panel-bulk")
      ?.children?.map((option) => option.value) ?? [];
    expect(bulkValues).not.toContain("video:bridge:shots");
    expect(listVideoReferenceAssetTargetIds(project)).toEqual([
      "reference-character:char-1",
      "reference-character-variant:char-1:cost-1",
      "reference-scene:setting-1",
      "reference-scene-variant:setting-1:time-1",
    ]);
  });

  it("keeps bridge followup focused on entity extraction when the role-and-scene stage has no entities yet", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        targetPlatform: "抖音",
        shotStyle: "电影感近景",
        outputGoal: "预告片",
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
        characters: [],
        sceneSettings: [],
      }),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:entities");
    expect(values).not.toContain("video:bridge:reference-assets");
    expect(values).not.toContain("video:bridge:storyboard");
  });

  it("adds storyboard-targeting and step-switch options in the storyboard stage", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        scenes: [
          {
            id: "scene-ready",
            sceneNumber: 1,
            sceneName: "Warehouse",
            segmentLabel: "A",
            characters: ["Hero"],
            storyboardUrl: "",
            description: "ready shot",
          },
          {
            id: "scene-blocked",
            sceneNumber: 2,
            sceneName: "Street",
            segmentLabel: "A",
            characters: ["Villain"],
            storyboardUrl: "",
            description: "blocked shot",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          { id: "char-ready", name: "Hero", description: "desc", imageUrl: "hero.png" },
          { id: "char-blocked", name: "Villain", description: "desc", imageUrl: "" },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          { id: "setting-ready", name: "Warehouse", description: "desc", imageUrl: "warehouse.png" },
          { id: "setting-blocked", name: "Street", description: "desc", imageUrl: "street.png" },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:storyboard-frames:list");
    expect(listQuestionValues(question)).toContain("video:bridge:storyboard-frames:group:A");
    expect(listQuestionValues(question)).toContain("video:bridge:storyboard-frames:segment:A");
    expect(listQuestionValues(question)).toContain("video:bridge:storyboard-frame:scene:scene-ready");
    expect(listQuestionValues(question)).toContain("video:bridge:storyboard-frame:scene:scene-blocked");
    expect(listQuestionValues(question)).toContain("video:step:entities");

    const segmentOption = findQuestionOption(question, "video:bridge:storyboard-frames:group:A");
    expect(segmentOption?.children?.some((child) => child.value === "video:bridge:storyboard-frames:segment:A")).toBe(true);

    const segmentBulkOption = findQuestionOption(question, "video:bridge:storyboard-frames:segment:A");
    expect(segmentBulkOption?.disabled).toBe(false);
    expect(segmentBulkOption?.label).toContain("全部可选分镜");

    const blockedSceneOption = findQuestionOption(question, "video:bridge:storyboard-frame:scene:scene-blocked");
    expect(blockedSceneOption?.disabled).toBe(true);
    expect(blockedSceneOption?.rationale).toContain("缺失必要素材");
    expect(blockedSceneOption?.rationale).toContain("Villain");
  });

  it("adds grouped targeted video actions in the generation stage and keeps them on the video step", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "\u89c6\u9891\u63d0\u793a\u8bcd" }),
      createVideoProject({
        scenes: [
          { id: "scene-g1", sceneNumber: 1, sceneName: "Warehouse", segmentLabel: "A" },
          { id: "scene-g2", sceneNumber: 2, sceneName: "Street", segmentLabel: "A", videoStatus: "failed" },
          { id: "scene-r1", sceneNumber: 3, sceneName: "Rooftop", segmentLabel: "B", videoTaskId: "task-1", videoStatus: "processing" },
          { id: "scene-r2", sceneNumber: 4, sceneName: "Tunnel", segmentLabel: "B", videoTaskId: "task-2", videoStatus: "queued" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(question?.stepIndex).toBe(3);
    expect(question?.totalSteps).toBe(5);
    expect(listQuestionValues(question)).toContain("video:generate:list");
    expect(listQuestionValues(question)).toContain("video:generate:group:A");
    expect(listQuestionValues(question)).toContain("video:generate:segment:A");
    expect(listQuestionValues(question)).toContain("video:generate:scene:scene-g1");
    expect(listQuestionValues(question)).not.toContain("video:refresh:list");
    expect(listQuestionValues(question)).not.toContain("video:refresh:group:B");
    expect(listQuestionValues(question)).not.toContain("video:refresh:segment:B");
    expect(listQuestionValues(question)).not.toContain("video:refresh:scene:scene-r1");

    const generateGroupOption = findQuestionOption(question, "video:generate:group:A");
    expect(generateGroupOption?.children?.some((child) => child.value === "video:generate:segment:A")).toBe(true);

    expect(findQuestionOption(question, "video:refresh:group:B")).toBeNull();
  });

  it("prioritizes segment video actions after segment prompts unlock text-to-video generation", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2" },
          { id: "scene-3", sceneNumber: 3, sceneName: "Scene 3", segmentLabel: "1-3" },
          { id: "scene-4", sceneNumber: 4, sceneName: "Scene 4", segmentLabel: "1-4" },
        ] as PersistedVideoProject["scenes"],
        segmentVideoPrompts: {
          "1-1": createSegmentPrompt("1-1"),
          "1-2": createSegmentPrompt("1-2"),
          "1-3": createSegmentPrompt("1-3"),
          "1-4": createSegmentPrompt("1-4"),
        },
      }),
    );
    const labels = listQuestionLabels(question);
    const values = listQuestionValues(question);

    expect(labels).toContain("先生成前 3 个片段");
    expect(labels).toContain("批量生成前 3 个片段");
    expect(labels).not.toContain("先生成前 3 个镜头");
    expect(labels).not.toContain("批量生成前 3 个镜头");
    expect(values).toContain("video:generate:segments:first");
    expect(values).not.toContain("video:generate:first");
  });

  it("keeps the original first-shot actions when shot prompts unlock text-to-video generation", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1", enhancedVideoPrompt: "shot prompt 1" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2", enhancedVideoPrompt: "shot prompt 2" },
          { id: "scene-3", sceneNumber: 3, sceneName: "Scene 3", segmentLabel: "1-3", enhancedVideoPrompt: "shot prompt 3" },
          { id: "scene-4", sceneNumber: 4, sceneName: "Scene 4", segmentLabel: "1-4", enhancedVideoPrompt: "shot prompt 4" },
        ] as PersistedVideoProject["scenes"],
        videoPromptBatch: "shot prompts ready",
      }),
    );
    const labels = listQuestionLabels(question);

    expect(labels).toContain("先生成前 3 个镜头");
    expect(labels).toContain("批量生成前 3 个镜头");
    expect(labels).not.toContain("先生成前 3 个片段");
    expect(labels).not.toContain("批量生成前 3 个片段");
  });

  it("shows both segment and shot actions when both text-to-video prompt paths are ready", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1", enhancedVideoPrompt: "shot prompt 1" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2", enhancedVideoPrompt: "shot prompt 2" },
          { id: "scene-3", sceneNumber: 3, sceneName: "Scene 3", segmentLabel: "1-3", enhancedVideoPrompt: "shot prompt 3" },
        ] as PersistedVideoProject["scenes"],
        videoPromptBatch: "shot prompts ready",
        segmentVideoPrompts: {
          "1-1": createSegmentPrompt("1-1"),
          "1-2": createSegmentPrompt("1-2"),
          "1-3": createSegmentPrompt("1-3"),
        },
      }),
    );
    const labels = listQuestionLabels(question);

    expect(labels).toContain("先生成前 3 个片段");
    expect(labels).toContain("先生成前 3 个镜头");
    expect(labels).toContain("批量生成前 3 个片段");
    expect(labels).toContain("批量生成前 3 个镜头");
  });

  it("offers failed and running segment recovery actions in text-to-video generation", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2" },
          { id: "scene-3", sceneNumber: 3, sceneName: "Scene 3", segmentLabel: "1-3" },
        ] as PersistedVideoProject["scenes"],
        segmentVideoPrompts: {
          "1-1": createSegmentPrompt("1-1"),
          "1-2": createSegmentPrompt("1-2"),
          "1-3": createSegmentPrompt("1-3"),
        },
        segmentVideoStatuses: {
          "1-1": {
            segmentLabel: "1-1",
            status: "failed",
            failure: { message: "failed", stage: "status", updatedAt: "2026-01-01T00:00:00.000Z" },
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          "1-2": {
            segmentLabel: "1-2",
            status: "processing",
            taskId: "task-2",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const labels = listQuestionLabels(question);
    const values = listQuestionValues(question);

    expect(labels).toContain("刷新 1 个进行中片段");
    expect(labels).toContain("补发 1 个失败片段");
    expect(labels).toContain("先生成前 2 个片段");
    expect(values).toContain("video:generate:segments:refresh");
    expect(values).toContain("video:generate:segments:failed");
    expect(values).toContain("video:generate:segments:first");
  });

  it("keeps generated shots visible in targeted output menus and disables missing-material shots with hints", () => {
    const question = buildVideoGenerationSceneListQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        scenes: [
          { id: "scene-ready", sceneNumber: 1, sceneName: "Warehouse", segmentLabel: "A", storyboardUrl: "ready-board.png", description: "ready shot" },
          { id: "scene-done", sceneNumber: 2, sceneName: "Street", segmentLabel: "A", storyboardUrl: "done-board.png", videoUrl: "done.mp4", videoStatus: "completed", description: "done shot" },
          { id: "scene-running", sceneNumber: 3, sceneName: "Tunnel", segmentLabel: "A", storyboardUrl: "run-board.png", videoTaskId: "task-1", videoStatus: "processing", description: "running shot" },
          { id: "scene-blocked", sceneNumber: 4, sceneName: "Rooftop", segmentLabel: "A", storyboardUrl: "", description: "blocked shot" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:generate:group:A");
    expect(listQuestionValues(question)).toContain("video:generate:segment:A");
    expect(listQuestionValues(question)).toContain("video:generate:scene:scene-ready");
    expect(listQuestionValues(question)).toContain("video:generate:scene:scene-done");
    expect(listQuestionValues(question)).toContain("video:generate:scene:scene-running");
    expect(listQuestionValues(question)).toContain("video:generate:scene:scene-blocked");

    const doneOption = findQuestionOption(question, "video:generate:scene:scene-done");
    expect(doneOption?.disabled).toBeFalsy();
    expect(doneOption?.label).toContain("重新生成");
    expect(doneOption?.rationale ?? "").toBe("");

    const runningOption = findQuestionOption(question, "video:generate:scene:scene-running");
    expect(runningOption?.disabled).toBe(true);
    expect(runningOption?.rationale).toContain("正在生成中");

    const blockedOption = findQuestionOption(question, "video:generate:scene:scene-blocked");
    expect(blockedOption?.disabled).toBe(true);
    expect(blockedOption?.rationale).toContain("缺失必要素材");

    const segmentOption = findQuestionOption(question, "video:generate:segment:A");
    expect(segmentOption?.disabled).toBe(false);
    expect(segmentOption?.label).toContain("全部可选镜头（2）");
  });

  it("keeps 'continue selected shots' under preview/export and preserves the preview step index", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u9884\u89c8\u4e0e\u5bfc\u51fa" }),
      createVideoProject({
        scenes: [
          { id: "scene-done", sceneNumber: 1, sceneName: "Lobby", segmentLabel: "A", videoUrl: "done.mp4", videoStatus: "completed" },
          { id: "scene-g1", sceneNumber: 2, sceneName: "Warehouse", segmentLabel: "A" },
          { id: "scene-g2", sceneNumber: 3, sceneName: "Street", segmentLabel: "A", videoStatus: "failed" },
          { id: "scene-r1", sceneNumber: 4, sceneName: "Rooftop", segmentLabel: "B", videoTaskId: "task-1", videoStatus: "processing" },
          { id: "scene-r2", sceneNumber: 5, sceneName: "Tunnel", segmentLabel: "B", videoTaskId: "task-2", videoStatus: "queued" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(question?.stepIndex).toBe(4);
    expect(question?.totalSteps).toBe(5);
    expect(listQuestionValues(question)).toContain("video:generate:list");
    expect(listQuestionValues(question)).toContain("video:generate:group:A");
    expect(listQuestionValues(question)).not.toContain("video:refresh:list");
    expect(listQuestionValues(question)).not.toContain("video:refresh:group:B");
  });

  it("keeps the targeted refresh popover on the current workflow step", () => {
    const question = buildVideoRefreshSceneListQuestion(
      createVideoSnapshot({ derivedStage: "\u9884\u89c8\u4e0e\u5bfc\u51fa" }),
      createVideoProject({
        scenes: [
          { id: "scene-r1", sceneNumber: 1, sceneName: "Rooftop", segmentLabel: "B", videoTaskId: "task-1", videoStatus: "processing" },
          { id: "scene-r2", sceneNumber: 2, sceneName: "Tunnel", segmentLabel: "B", videoTaskId: "task-2", videoStatus: "queued" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(question?.stepIndex).toBe(4);
    expect(question?.totalSteps).toBe(5);
    expect(listQuestionValues(question)).toContain("video:generate:group:B");
    expect(listQuestionValues(question)).toContain("video:generate:segment:B");
    expect(listQuestionValues(question)).not.toContain("video:refresh:group:B");
  });

  it("aligns storyboard readiness with manifest-backed image assets", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        scenes: [
          {
            id: "scene-manifest-ready",
            sceneNumber: 1,
            sceneName: "Warehouse",
            segmentLabel: "A",
            characters: ["Hero"],
            storyboardUrl: "",
            description: "ready from manifest",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          { id: "char-ready", name: "Hero", description: "desc", imageUrl: "" },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          { id: "setting-ready", name: "Warehouse", description: "desc", imageUrl: "" },
        ] as PersistedVideoProject["sceneSettings"],
        assetManifest: {
          version: "1",
          summary: "assets",
          items: [
            {
              id: "asset-char-1",
              kind: "character-reference",
              label: "Hero",
              url: "hero.png",
              meta: "",
              reusable: true,
              status: "ready",
              sourceEntityId: "char-ready",
              version: 1,
              createdAt: "2026-04-25T00:00:00.000Z",
            },
            {
              id: "asset-scene-1",
              kind: "scene-reference",
              label: "Warehouse",
              url: "warehouse.png",
              meta: "",
              reusable: true,
              status: "ready",
              sourceEntityId: "setting-ready",
              version: 1,
              createdAt: "2026-04-25T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    const readySceneOption = findQuestionOption(question, "video:bridge:storyboard-frame:scene:scene-manifest-ready");
    expect(readySceneOption?.disabled).toBe(false);
    expect(readySceneOption?.rationale).toBe("");
  });

  it("hides the direct step switch from role-and-scene to storyboard without minimum materials", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).not.toContain("video:step:storyboard");
  });

  it("shows the direct step switch to storyboard once one scene has minimum materials", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "角色与场景" }),
      createVideoProject({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Warehouse",
            characters: ["Hero"],
            storyboardUrl: "",
            description: "ready shot",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Warehouse", description: "desc", imageUrl: "warehouse.png" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:step:storyboard");
  });

  it("keeps storyboard-frame generation visible until all storyboard images are ready and then unlocks video-step switching", () => {
    const partialQuestion = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(partialQuestion)).toContain("video:bridge:storyboard-frames");
    expect(listQuestionValues(partialQuestion)).not.toContain("video:step:video");

    const completeQuestion = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(completeQuestion)).not.toContain("video:bridge:storyboard-frames");
    expect(listQuestionValues(completeQuestion)).toContain("video:step:video");
  });

  it("shows preview/export step switching only after reviewable video outputs exist", () => {
    const videoStageQuestion = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: "视频生成" }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1" }] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(videoStageQuestion)).not.toContain("video:step:preview");

    const previewStageQuestion = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "预览与导出" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-done", sceneNumber: 1, sceneName: "Done", storyboardUrl: "done", videoUrl: "done.mp4", videoStatus: "completed" },
          { id: "scene-next", sceneNumber: 2, sceneName: "Next", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const previewValues = listQuestionValues(previewStageQuestion);
    expect(previewValues).toContain("video:step:storyboard");
    expect(previewValues).toContain("video:step:video");
  });

  it.skip("adds a dedicated export group to the preview/export panel", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "棰勮涓庡鍑?" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-done", sceneNumber: 1, sceneName: "Done", storyboardUrl: "done", videoUrl: "done.mp4", videoStatus: "completed" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(findQuestionOption(question, "video:export:all")?.label).toBe("全部导出");
    expect(findQuestionOption(question, "video:export:nle-placeholder")?.label).toBe("导入到剪辑软件");
  });

  it("lists the dedicated export group in the preview/export panel", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u9884\u89c8\u4e0e\u5bfc\u51fa" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-done", sceneNumber: 1, sceneName: "Done", storyboardUrl: "done", videoUrl: "done.mp4", videoStatus: "completed" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining([
        "video:panel:review-stage-panel-export",
        "video:export:all",
        "video:export:nle-placeholder",
      ]),
    );
    expect(listQuestionValues(question)).not.toContain("video:advance");
    expect(listQuestionValues(question)).not.toContain("video:advance-round");

    const exportGroup = findQuestionOption(question, "video:panel:review-stage-panel-export");
    expect(exportGroup?.children?.map((option) => option.value)).toEqual([
      "video:export:all",
      "video:export:nle-placeholder",
    ]);
  });

  it("hides storyboard-frame generation once there are no missing storyboard images", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜批次" }),
      createVideoProject({
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const values = listQuestionValues(question);
    expect(values).toContain("video:bridge:shots");
    expect(values).not.toContain("video:bridge:prompts");
  });

  it("shows shot-packet compilation whenever scenes exist, regardless of storyboard frame status", () => {
    const partialQuestion = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );
    const emptyQuestion = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        storyboardPlan: "batch ready",
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(partialQuestion)).toContain("video:bridge:shots");
    expect(listQuestionValues(emptyQuestion)).toContain("video:bridge:shots");
  });

  it("hides prompt-batch preparation until shot packets exist, then shows it regardless of storyboard frame status", () => {
    const baseProject = createVideoProject({
      scenes: [
        { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
        { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "" },
      ] as PersistedVideoProject["scenes"],
      characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
    });

    const withoutPackets = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "镜头指令包" }),
      baseProject,
    );
    const withPacketsButMissingFrames = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "镜头指令包" }),
      createVideoProject({
        ...baseProject,
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );
    /* const withPacketsAndAllFrames = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "闀滃ご鎸囦护鍖? }),
      createVideoProject({
        ...baseProject,
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    ); */
    /* const withPacketsReady = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "闀滃ご鎸囦护鍖? }),
      createVideoProject({
        ...baseProject,
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    ); */
    const withPacketsReadyProject = createVideoProject({
      ...baseProject,
      currentStep: 3,
      scenes: [
        { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
        { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
      ] as PersistedVideoProject["scenes"],
      shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
    });
    const withPacketsReady = buildVideoBridgeQuestion(
      createProjectVideoSnapshot(withPacketsReadyProject),
      withPacketsReadyProject,
    );

    expect(listQuestionValues(withoutPackets)).not.toContain("video:bridge:prompts");
    expect(listQuestionValues(withPacketsButMissingFrames)).toContain("video:bridge:prompts");
    expect(listQuestionValues(withPacketsReady)).toContain("video:bridge:prompts");
  });

  it("keeps prompt-batch preparation available when shot packets are ready but the visible stage stays on step three", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "分镜图生成" }),
      createVideoProject({
        scenes: [
          { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" },
          { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", storyboardUrl: "done-2" },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:prompts");
    expect(listQuestionValues(question)).not.toContain("video:step:video");
  });

  it.skip("keeps prompt-batch projects on the generation panel instead of regressing to shot compilation", () => {
    const project = createVideoProject({
      currentStep: 1,
      scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" }] as PersistedVideoProject["scenes"],
      videoPromptBatch: "batch ready",
    });
    const snapshot = createProjectVideoSnapshot(project);
    const question = recQuestion(snapshot, project);

    expect(snapshot.derivedStage).toBe("瑙嗛鐢熸垚");
    expect(listQuestionValues(question)).toContain("video:generate:first");
    expect(listQuestionValues(question)).not.toContain("video:bridge:shots");
  });

  it("keeps prompt-batch snapshots on the generation panel", () => {
    const project = createVideoProject({
      currentStep: 1,
      scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "done" }] as PersistedVideoProject["scenes"],
      videoPromptBatch: "batch ready",
    });
    const snapshot = createProjectVideoSnapshot(project);
    const question = recQuestion(snapshot, project);

    expect(snapshot.derivedStage).toBe("视频生成");
    expect(listQuestionValues(question)).toContain("video:generate:first");
    expect(listQuestionValues(question)).not.toContain("video:bridge:shots");
  });

  it("keeps the text-to-video bridge panel renderable after switching back from prompt-batch generation", () => {
    const project = createVideoProject({
      currentStep: 2,
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          segmentLabel: "1-1",
          enhancedVideoPrompt: "prompt one",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "Scene 2",
          segmentLabel: "1-1",
          enhancedVideoPrompt: "prompt two",
        },
      ] as PersistedVideoProject["scenes"],
      characters: [{ id: "char-1", name: "A", description: "desc" }] as PersistedVideoProject["characters"],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc" }] as PersistedVideoProject["sceneSettings"],
      shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      videoPromptBatch: "batch ready",
    });
    const snapshot = createProjectVideoSnapshot(project);
    const question = recQuestion(snapshot, project);

    expect(snapshot.derivedStage).toBe("角色与场景");
    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:prompts:batch");
    expect(listQuestionValues(question)).toContain("video:step:video");
  });

  it("offers remaining and batch segment prompt actions for text-to-video gaps", () => {
    const project = createVideoProject({
      currentStep: 2,
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
      scenes: [
        {
          id: "scene-1",
          sceneNumber: 1,
          sceneName: "Scene 1",
          segmentLabel: "1-1",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "Scene 2",
          segmentLabel: "1-2",
        },
      ] as PersistedVideoProject["scenes"],
      characters: [{ id: "char-1", name: "A", description: "desc" }] as PersistedVideoProject["characters"],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc" }] as PersistedVideoProject["sceneSettings"],
      shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      segmentVideoPrompts: {
        "1-1": {
          segmentLabel: "1-1",
          prompt: "existing segment prompt",
          duration: 15,
          targetDuration: 15,
          modelKey: "doubao-seedance-1-5-pro",
          maxDurationForModel: 15,
          sceneIds: ["scene-1"],
          generatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const snapshot = createProjectVideoSnapshot(project);
    const question = recQuestion(snapshot, project);
    const values = listQuestionValues(question);
    const labels = listQuestionLabels(question);

    expect(values).toContain("video:bridge:prompts:segment:remaining");
    expect(values).toContain("video:bridge:prompts:segment:batch");
    expect(values).not.toContain("video:bridge:prompts:segment:all");
    expect(labels).toContain("补齐剩余片段（1）");
    expect(labels).toContain("分批生成片段");
    expect(labels).toContain("按集分批生成");
    expect(labels).toContain("按片段分批生成");
  });

  it("stabilizes duplicate variant option ids so nested bridge pickers never render duplicate keys", () => {
    const optionIds = ensureUniqueOptionIds([
      {
        id: "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant",
        label: "校服",
        value: "video:bridge:reference-assets:character-variant:char-1:dup-variant",
        rationale: "first",
      },
      {
        id: "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant",
        label: "战损版",
        value: "video:bridge:reference-assets:character-variant:char-1:dup-variant",
        rationale: "second",
      },
    ]).map((option) => option.id);

    expect(optionIds).toEqual([
      "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant",
      "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant--dup-2",
    ]);
    expect(new Set(optionIds).size).toBe(optionIds.length);
  });
});
