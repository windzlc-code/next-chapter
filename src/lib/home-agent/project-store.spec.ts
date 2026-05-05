import { beforeEach, describe, expect, it } from "vitest";
import {
  createDramaSnapshot,
  createVideoSnapshot,
  deleteConversationProject,
  listRecentConversationSnapshots,
  loadStoredDramaProjectById,
  listStoredDramaProjects,
  renameConversationProject,
} from "./project-store";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { readStudioProjectSession } from "./session-store";
import {
  createEmptyComplianceWorkspace,
  createEmptyDramaProject,
  type DramaProject,
} from "@/types/drama";

const DRAMA_PROJECTS_KEY = "storyforge_drama_projects";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";

function writeDramaProjects(projects: unknown[]): void {
  localStorage.setItem(DRAMA_PROJECTS_KEY, JSON.stringify(projects));
}

function createDirectoryEntry(
  number: number,
  overrides: Partial<DramaProject["directory"][number]> = {},
): DramaProject["directory"][number] {
  return {
    number,
    title: `Episode ${number}`,
    summary: `summary ${number}`,
    hookType: "hook",
    isKey: false,
    isClimax: false,
    isPaywall: false,
    outline: `outline ${number}`,
    ...overrides,
  };
}

function createEpisodeEntry(
  number: number,
  overrides: Partial<DramaProject["episodes"][number]> = {},
): DramaProject["episodes"][number] {
  return {
    number,
    title: `Episode ${number}`,
    content: `Episode body ${number}`,
    wordCount: 1000 + number,
    ...overrides,
  };
}

function createDramaFixture(overrides: Partial<DramaProject> = {}): DramaProject {
  const base = createEmptyDramaProject("traditional");
  return {
    ...base,
    id: overrides.id ?? "drama-fixture",
    dramaTitle: overrides.dramaTitle ?? "Fixture Story",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    currentStep: overrides.currentStep ?? "creative-plan",
    setup:
      overrides.setup === undefined
        ? {
            genres: ["urban romance"],
            audience: "female",
            tone: "sweet",
            ending: "HE",
            totalEpisodes: 3,
            targetMarket: "cn",
            creativeInput: "A contract-marriage romance with a hidden revenge thread.",
          }
        : overrides.setup,
    ...overrides,
  };
}

function createVideoFixture(overrides: Partial<PersistedVideoProject> = {}): PersistedVideoProject {
  return {
    id: "video-fixture",
    title: "Video Fixture",
    script: "A heroine turns in the corridor and sees danger approaching.",
    targetPlatform: "Douyin",
    shotStyle: "Cinematic medium close-up",
    outputGoal: "Trailer",
    productionNotes: "Keep the red costume and rainy night atmosphere.",
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
    updatedAt: "2026-04-03T01:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  };
}

describe("project-store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes legacy drama projects with missing workflow arrays and compliance workspace", () => {
    writeDramaProjects([
      {
        id: "legacy-drama-1",
        dramaTitle: "Legacy Contract Story",
        currentStep: "creative-plan",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 40,
          targetMarket: "cn",
        },
      },
    ]);

    const [project] = listStoredDramaProjects();

    expect(project.directory).toEqual([]);
    expect(project.episodes).toEqual([]);
    expect(project.creativePlan).toBe("");
    expect(project.characters).toBe("");
    expect(project.directoryRaw).toBe("");
    expect(project.complianceWorkspace).toMatchObject(createEmptyComplianceWorkspace());
    expect(project.complianceSkippedAt).toBeNull();
  });

  it("creates recent conversation snapshots from partial legacy drama projects", async () => {
    writeDramaProjects([
      {
        id: "legacy-drama-2",
        dramaTitle: "Legacy Contract Story",
        currentStep: "creative-plan",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 40,
          targetMarket: "cn",
          creativeInput: "The heroine enters a contract marriage to repay a family debt.",
        },
      },
    ]);

    const [snapshot] = await listRecentConversationSnapshots();

    expect(snapshot?.title).toBe("Legacy Contract Story");
    expect(snapshot?.projectKind).toBe("script");
    expect(snapshot?.recommendedActions).toContain("生成创作方案");
    expect(snapshot?.artifacts.length).toBeGreaterThan(0);
    expect(snapshot?.memory?.styleLock?.genre[0]).toBe("urban romance");
    expect(snapshot?.currentObjective).toBe("确认创作方案后进入角色开发，并保持首页单链路推进。");
  });

  it("repairs legacy directory markers from raw text before building snapshot stats", () => {
    writeDramaProjects([
      {
        id: "legacy-drama-3",
        dramaTitle: "Directory Repair",
        currentStep: "outlines",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 3,
          targetMarket: "cn",
        },
        directoryRaw: [
          "第1集：签下合约 - 女主被迫签字 [关键剧情] [情绪:3] 🔥",
          "第2集：真相炸裂 - 众人当场失控 [高潮] [情绪:5] ⚡",
          "第3集：门后身份揭晓 - 付费卡点 [付费点] [情绪:4] 💰",
        ].join("\n"),
        directory: [
          createDirectoryEntry(1, { title: "签下合约", summary: "女主被迫签字", outline: "" }),
          createDirectoryEntry(2, { title: "真相炸裂", summary: "众人当场失控", outline: "" }),
          createDirectoryEntry(3, { title: "门后身份揭晓", summary: "付费卡点", outline: "" }),
        ],
      },
    ]);

    const [project] = listStoredDramaProjects();
    const snapshot = createDramaSnapshot(project);
    const directoryArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "directory");

    expect(project.directory.map((entry) => [entry.isKey, entry.isClimax, entry.isPaywall])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    expect(directoryArtifact?.payload?.type).toBe("directory+stats");
    if (directoryArtifact?.payload?.type === "directory+stats") {
      expect(directoryArtifact.payload.stats.keyEpisodes).toBe(1);
      expect(directoryArtifact.payload.stats.climaxEpisodes).toBe(1);
      expect(directoryArtifact.payload.stats.paywallEpisodes).toBe(1);
    }
  });

  it("keeps early setup snapshots mapped to the homepage workflow", async () => {
    writeDramaProjects([
      {
        id: "drama-missing-setup",
        dramaTitle: "Missing Setup",
        currentStep: "setup",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: [],
          audience: "",
          tone: "",
          ending: "HE",
          totalEpisodes: 0,
          targetMarket: "",
        },
      },
    ]);

    const [snapshot] = await listRecentConversationSnapshots();

    expect(snapshot?.derivedStage).toBe("立项设定");
    expect(snapshot?.recommendedActions).toEqual(["生成创作方案"]);
    expect(snapshot?.currentObjective).toBe("补齐立项信息后，通过首页面板进入下一步创作。");
  });

  it("builds hidden script production memory into drama snapshots", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-memory-1",
        dramaTitle: "Contract Reversal",
        currentStep: "compliance",
        creativePlan: "女主与冷面继承人在契约婚姻中逐步揭开旧案真相。",
        characters: [
          "沈昭",
          "身份：女主",
          "核心冲突：需要在自保与信任之间做选择",
          "动机：查清父亲旧案",
          "关系：与顾承砚先婚后爱",
        ].join("\n"),
        directory: [
          createDirectoryEntry(1, {
            title: "签下合约",
            summary: "女主被迫签下婚姻合约。",
            hookType: "强钩子",
            isKey: true,
            outline: "女主在债务压力下签下契约婚姻，却发现男主另有目的。",
          }),
        ],
        directoryRaw: "第1集：签下合约 - 女主被迫签下婚姻合约。 [关键剧情] 🔥",
        complianceReport:
          "1. 高风险：胁迫描写过重，建议改为双方交换条件。\n2. 中风险：复仇台词过激，建议弱化违法指向。",
      }),
    );

    expect(snapshot.memory?.characterStateCards?.length).toBeGreaterThan(0);
    expect(snapshot.memory?.storyBeatPackets?.[0]?.episodeNumber).toBe(1);
    expect(snapshot.memory?.complianceRevisionPackets?.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.some((artifact) => artifact.kind === "character-card")).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.kind === "beat-packet")).toBe(true);
  });

  it("routes creative-plan completion into the character-development stage on the homepage", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-creative-plan-next",
        dramaTitle: "Character Next",
        currentStep: "characters",
        creativePlan: "一段契约婚姻逐渐反转为双向救赎。",
        characters: "",
        directory: [],
        episodes: [],
      }),
    );

    expect(snapshot.derivedStage).toBe("角色开发");
    expect(snapshot.recommendedActions).toEqual(["进入角色开发"]);
    expect(snapshot.currentObjective).toBe("完善角色关系与人设弧光，再进入分集目录。");
  });

  it("builds rich script payloads and quick-export fallback artifacts", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-rich-payloads",
        dramaTitle: "Rich Payload Project",
        currentStep: "export",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 2,
          targetMarket: "cn",
        },
        creativePlan: "A compact creative plan.",
        characters: "角色 A\n```mermaid\ngraph TD\nA-->B\n```",
        directoryRaw: "目录原文",
        directory: [
          createDirectoryEntry(1, {
            title: "Episode 1",
            summary: "summary 1",
            hookType: "reversal",
            isKey: true,
            outline: "outline 1",
          }),
          createDirectoryEntry(2, {
            title: "Episode 2",
            summary: "summary 2",
            hookType: "upgrade",
            isClimax: true,
            isPaywall: true,
            outline: "outline 2",
          }),
        ],
        outlineBatchStatuses: [{ index: 0, label: "Episodes 1-2", startEp: 1, endEp: 2, status: "done" }],
        episodes: [createEpisodeEntry(1, { title: "Episode 1", content: "episode body 1", wordCount: 1200 })],
        episodeQualityReviewPackets: [
          {
            id: "review-1",
            episodeNumber: 1,
            title: "Episode 1",
            reviewedAt: "2026-04-02T00:00:00.000Z",
            rewriteInstruction: "Fix rhythm",
            result: {
              scores: {
                rhythm: { score: 6, comment: "slow" },
                satisfaction: { score: 8, comment: "solid" },
                dialogue: { score: 7, comment: "okay" },
                format: { score: 9, comment: "clean" },
                continuity: { score: 8, comment: "stable" },
              },
              total: 38,
              grade: "B",
              highlights: ["hook works"],
              issues: [{ level: "warning", description: "scene two is slow" }],
              suggestions: ["tighten scene two"],
            },
          },
        ],
        complianceReport: "red line\nhigh risk\nsuggestion",
        complianceReviewMode: "script",
      }),
    );

    const setupArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "setup");
    const directoryArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "directory");
    const outlineArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "outline");
    const reviewArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "episode-review");
    const complianceArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "compliance");
    const exportArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "export");

    expect(setupArtifact?.presentation).toBe("script-rich");
    expect(setupArtifact?.payload?.type).toBe("setup");
    expect(directoryArtifact?.payload?.type).toBe("directory+stats");
    expect(outlineArtifact?.payload?.type).toBe("outlines+batchProgress");
    expect(reviewArtifact?.payload?.type).toBe("episodeReview");
    expect(complianceArtifact?.payload?.type).toBe("complianceSummary");
    expect(exportArtifact?.payload?.type).toBe("exportSummary");
    expect(exportArtifact?.payload?.patchPlan?.entries.length).toBeGreaterThanOrEqual(0);
    expect(exportArtifact?.payload?.complianceStatus).toBe("reviewed");
    expect(complianceArtifact?.actions?.map((action) => action.value)).toContain("script:step-enter-compliance");
    expect(exportArtifact?.actions?.map((action) => action.value)).toEqual(["script:step-enter-export"]);
  });

  it("marks in-flight episode generation in the episode artifact progress payload", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-episode-progress",
        dramaTitle: "Episode Progress",
        currentStep: "episodes",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 3,
          targetMarket: "cn",
        },
        directory: [createDirectoryEntry(1), createDirectoryEntry(2), createDirectoryEntry(3)],
        episodes: [createEpisodeEntry(1)],
        episodeGenerationStatuses: [
          {
            episodeNumber: 2,
            title: "Episode 2",
            status: "processing",
          },
        ],
      }),
    );

    const episodeArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "episode");

    expect(episodeArtifact?.payload?.type).toBe("episodes+batchProgress");
    if (episodeArtifact?.payload?.type !== "episodes+batchProgress") {
      throw new Error("Expected episode progress payload");
    }

    expect(episodeArtifact.payload.entries.map((entry) => [entry.number, entry.status])).toEqual([
      [1, "done"],
      [2, "processing"],
      [3, "pending"],
    ]);
    expect(episodeArtifact.payload.batchProgress).toMatchObject({
      total: 3,
      done: 1,
      failed: 0,
      processing: 1,
      percent: 50,
    });
  });

  it("creates a full compliance workspace artifact even before a final report exists", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-compliance-workspace",
        dramaTitle: "Compliance Workspace",
        currentStep: "compliance",
        creativePlan: "Plan",
        characters: "Characters",
        directory: [createDirectoryEntry(1)],
        episodes: [createEpisodeEntry(1)],
        complianceReport: "",
        complianceWorkspace: {
          ...createEmptyComplianceWorkspace(),
          sourceText: "待审文本",
          paletteText: "调色盘",
          reviewMode: "script",
          strictness: "strict",
        },
      }),
    );

    const complianceArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "compliance");

    expect(complianceArtifact?.payload?.type).toBe("complianceSummary");
    if (complianceArtifact?.payload?.type === "complianceSummary") {
      expect(complianceArtifact.payload.workspace.sourceText).toBe("待审文本");
      expect(complianceArtifact.payload.workspace.paletteText).toBe("调色盘");
      expect(complianceArtifact.payload.strictness).toBe("strict");
    }
    expect(complianceArtifact?.actions?.map((action) => action.value)).toContain("script:step-enter-compliance");
  });

  it("surfaces structured episode-stage actions and the skip-compliance recommendation", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-episode-actions",
        dramaTitle: "Episode Actions",
        currentStep: "episodes",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 40,
          targetMarket: "cn",
        },
        creativePlan: "Plan",
        characters: "Characters",
        directory: [createDirectoryEntry(1), createDirectoryEntry(2), createDirectoryEntry(3)],
        episodes: [createEpisodeEntry(1), createEpisodeEntry(2)],
      }),
    );

    const episodeArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "episode");

    expect(snapshot.recommendedActions).toEqual([
      "批量生成剩余正文",
      "生成第 3 集正文",
      "进入合规审查",
      "跳过合规，直接进入导出",
    ]);
    expect(snapshot.currentObjective).toBe(
      "正文阶段优先展示批量、范围和单集写作路径，并可直接衔接质检与合规。",
    );
    expect(episodeArtifact?.actions?.map((action) => action.value)).toEqual(["script:step-enter-episodes"]);
  });

  it("renders episode review artifacts from the latest review batch by default", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-review-batch",
        dramaTitle: "Review Batch Story",
        currentStep: "episodes",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 4,
          targetMarket: "cn",
        },
        creativePlan: "Plan",
        characters: "Characters",
        directory: Array.from({ length: 4 }, (_, index) => createDirectoryEntry(index + 1)),
        episodes: Array.from({ length: 4 }, (_, index) => createEpisodeEntry(index + 1)),
        episodeQualityReviewPackets: Array.from({ length: 4 }, (_, index) => ({
          id: `review-${index + 1}`,
          episodeNumber: index + 1,
          title: `Episode ${index + 1}`,
          reviewedAt: "2026-04-02T00:00:00.000Z",
          rewriteInstruction: `Repair episode ${index + 1}`,
          result: {
            scores: {
              rhythm: { score: 6 + index, comment: "pace" },
              satisfaction: { score: 6 + index, comment: "payoff" },
              dialogue: { score: 6 + index, comment: "dialogue" },
              format: { score: 8, comment: "format" },
              continuity: { score: 7, comment: "continuity" },
            },
            total: 32 + index,
            grade: "B",
            highlights: ["hook works"],
            issues: [{ level: "warning", description: `issue ${index + 1}` }],
            suggestions: [`suggestion ${index + 1}`],
          },
        })),
        lastEpisodeQualityReviewBatch: {
          mode: "episodes",
          episodeNumbers: [2, 3],
          reviewedAt: "2026-04-03T00:00:00.000Z",
          requestedCount: 2,
        },
      }),
    );

    const reviewArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "episode-review");

    expect(reviewArtifact?.payload).toMatchObject({
      type: "episodeReview",
      batch: {
        mode: "episodes",
        episodeNumbers: [2, 3],
        requestedCount: 2,
      },
      allPacketsCount: 4,
      summary: {
        reviewedCount: 2,
      },
    });
    if (reviewArtifact?.payload?.type === "episodeReview") {
      expect(reviewArtifact.payload.packets.map((packet) => packet.episodeNumber)).toEqual([2, 3]);
    }
  });

  it("falls back to the full episode review history when the stored last batch is no longer valid", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-review-batch-fallback",
        dramaTitle: "Review Batch Fallback",
        currentStep: "episodes",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 3,
          targetMarket: "cn",
        },
        creativePlan: "Plan",
        characters: "Characters",
        directory: Array.from({ length: 3 }, (_, index) => createDirectoryEntry(index + 1)),
        episodes: Array.from({ length: 3 }, (_, index) => createEpisodeEntry(index + 1)),
        episodeQualityReviewPackets: Array.from({ length: 3 }, (_, index) => ({
          id: `review-${index + 1}`,
          episodeNumber: index + 1,
          title: `Episode ${index + 1}`,
          reviewedAt: "2026-04-02T00:00:00.000Z",
          rewriteInstruction: `Repair episode ${index + 1}`,
          result: {
            scores: {
              rhythm: { score: 6, comment: "pace" },
              satisfaction: { score: 6, comment: "payoff" },
              dialogue: { score: 6, comment: "dialogue" },
              format: { score: 8, comment: "format" },
              continuity: { score: 7, comment: "continuity" },
            },
            total: 33 + index,
            grade: "B",
            highlights: ["hook works"],
            issues: [{ level: "warning", description: `issue ${index + 1}` }],
            suggestions: [`suggestion ${index + 1}`],
          },
        })),
        lastEpisodeQualityReviewBatch: {
          mode: "episodes",
          episodeNumbers: [2, 4],
          reviewedAt: "2026-04-03T00:00:00.000Z",
          requestedCount: 2,
        },
      }),
    );

    const reviewArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "episode-review");

    if (reviewArtifact?.payload?.type === "episodeReview") {
      expect(reviewArtifact.payload.batch).toBeNull();
      expect(reviewArtifact.payload.summary.reviewedCount).toBe(3);
      expect(reviewArtifact.payload.packets.map((packet) => packet.episodeNumber)).toEqual([1, 2, 3]);
    }
  });

  it("marks skipped compliance as export-ready while preserving a return path to compliance", () => {
    const snapshot = createDramaSnapshot(
      createDramaFixture({
        id: "drama-skip-export",
        dramaTitle: "Skip Export",
        currentStep: "export",
        setup: {
          genres: ["urban romance"],
          audience: "female",
          tone: "sweet",
          ending: "HE",
          totalEpisodes: 2,
          targetMarket: "cn",
        },
        creativePlan: "Plan",
        characters: "Characters",
        directory: [createDirectoryEntry(1), createDirectoryEntry(2)],
        episodes: [createEpisodeEntry(1), createEpisodeEntry(2)],
        exportDocument: "Integrated export",
        complianceSkippedAt: "2026-04-02T00:00:00.000Z",
      }),
    );

    const exportArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "export");

    expect(snapshot.recommendedActions).toContain("重新进入合规审查");
    expect(snapshot.currentObjective).toBe(
      "导出区会明确显示“已跳过合规审查”，并保留重新进入合规的入口。",
    );
    expect(exportArtifact?.payload?.type).toBe("exportSummary");
    if (exportArtifact?.payload?.type === "exportSummary") {
      expect(exportArtifact.payload.complianceStatus).toBe("skipped");
      expect(exportArtifact.payload.skippedAt).toBe("2026-04-02T00:00:00.000Z");
      expect(exportArtifact.payload.patchPlan?.readyForExport).toBe(true);
      expect(exportArtifact.payload.patchPlan?.summary).toContain("已按用户选择跳过合规审查");
    }
  });

  it("builds video production memory into homepage snapshots", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        id: "video-project-1",
        title: "Ancient Reversal Trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Corridor Turn",
            description: "The heroine turns in the corridor and spots an assassin.",
            characters: ["沈昭", "刺客"],
            dialogue: "",
            cameraDirection: "medium close-up, slow push",
            duration: 6,
            storyboardUrl: "https://example.com/storyboard-1.jpg",
            videoUrl: "https://example.com/video-1.mp4",
            videoStatus: "completed",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "沈昭",
            description: "Red costume, calm, alert.",
            imageUrl: "https://example.com/char-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Long Corridor",
            description: "A moonlit ancient corridor at night.",
            imageUrl: "https://example.com/setting-1.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        currentStep: 3,
        analysisSummary: "First-pass shot breakdown is complete.",
        storyboardPlan: "Shot 1: corridor turn",
        shotPackets: [
          {
            id: "packet:video-project-1:scene-1",
            sceneId: "scene-1",
            sceneNumber: 1,
            title: "Corridor Turn",
            durationSec: 6,
            camera: {
              shotSize: "standard shot",
              movement: "medium close-up, slow push",
            },
            characterRefs: [
              {
                characterId: "char-1",
                name: "沈昭",
                assetIds: ["char:char-1:primary"],
                mustPreserve: ["沈昭", "Red costume, calm, alert."],
              },
            ],
            sourceAssetIds: ["char:char-1:primary", "shot:scene-1:storyboard"],
            promptSeed: "The heroine turns and spots the assassin approaching.",
            forbiddenChanges: ["Do not change the lead's costume or recognition cues."],
            renderMode: "img2video",
            reviewStatus: "pending",
          },
        ],
        reviewQueue: [
          {
            id: "review:packet:video-project-1:scene-1",
            title: "Review shot 1 / Corridor Turn",
            summary: "The shot is ready for review.",
            targetIds: ["packet:video-project-1:scene-1"],
            status: "pending",
            createdAt: "2026-04-03T01:00:00.000Z",
            updatedAt: "2026-04-03T01:00:00.000Z",
          },
        ],
      }),
    );

    expect(snapshot.memory?.assetManifest?.items.length).toBeGreaterThan(0);
    expect(snapshot.memory?.shotPackets?.length).toBe(1);
    expect(snapshot.artifacts.some((artifact) => artifact.kind === "shot-packet")).toBe(true);
  });

  it("keeps the full decomposed scene list in the video snapshot artifact", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        id: "video-project-scenes",
        scenes: Array.from({ length: 7 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          segmentLabel: `1-${index + 1}`,
          description: `Description ${index + 1}`,
          characters: [`角色${index + 1}`],
          dialogue: `对白${index + 1}`,
          cameraDirection: `镜头${index + 1}`,
          duration: 5,
        })),
      }),
    );

    const scenesArtifact = snapshot.artifacts.find((artifact) => artifact.id === "video-project-scenes-scenes");

    expect(scenesArtifact?.content).toContain("1. Scene 1 / 1-1");
    expect(scenesArtifact?.content).toContain("对白：对白1");
    expect(scenesArtifact?.content).toContain("角色：角色1");
    expect(scenesArtifact?.content).toContain("镜头：镜头1");
    expect(scenesArtifact?.content).toContain("7. Scene 7 / 1-7");
    expect(scenesArtifact?.content).toContain("对白：对白7");
  });

  it("keeps video entity artifacts to name prefixes only", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        characters: [
          {
            id: "char-1",
            name: "苏念",
            description: "昔日天才厨师，现阶段情绪紧绷。",
            isAIGenerated: false,
            source: "auto",
            costumes: [
              {
                id: "costume-1",
                label: "厨师服",
                description: "白色厨师服",
                isAIGenerated: false,
              },
            ],
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "家庭厨房",
            description: "空间凌乱，灯光昏黄。",
            isAIGenerated: false,
            source: "auto",
            timeVariants: [
              {
                id: "variant-1",
                label: "暴雨夜",
                description: "窗外暴雨",
                isAIGenerated: false,
              },
            ],
          },
        ],
      }),
    );

    const charactersArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "characters");
    const sceneSettingsArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "scene-settings");

    expect(charactersArtifact?.content).toBe("1. 苏念\n   角色变体：\n   - 厨师服");
    expect(sceneSettingsArtifact?.content).toBe("1. 家庭厨房\n   场景变体：\n   - 暴雨夜");
  });

  it("derives only the five visible video stages with stricter material gates", () => {
    const stage1 = createVideoSnapshot(
      createVideoFixture({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
          },
        ],
        characters: [],
        sceneSettings: [],
      }),
    );

    const stage2 = createVideoSnapshot(
      createVideoFixture({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Corridor",
            description: "Night corridor",
            isAIGenerated: false,
            source: "auto",
          },
        ],
      }),
    );

    const stage3 = createVideoSnapshot(
      createVideoFixture({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero", "Support"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: false,
            source: "auto",
          },
          {
            id: "char-2",
            name: "Support",
            description: "Support character",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Corridor",
            description: "Night corridor",
            imageUrl: "https://example.com/corridor.jpg",
            isAIGenerated: false,
            source: "auto",
          },
          {
            id: "setting-2",
            name: "Lobby",
            description: "Hotel lobby",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        storyboardPlan: "",
      }),
    );

    const stage4 = createVideoSnapshot(
      createVideoFixture({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-1.jpg",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Corridor",
            description: "Night corridor",
            imageUrl: "https://example.com/corridor.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        storyboardPlan: "Shot 1: the heroine steps into the corridor.",
        shotPackets: [],
        reviewQueue: [],
      }),
    );

    const stage5 = createVideoSnapshot(
      createVideoFixture({
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
            storyboardUrl: "https://example.com/storyboard-1.jpg",
            videoUrl: "https://example.com/video-1.mp4",
            videoStatus: "completed",
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Corridor",
            description: "Night corridor",
            imageUrl: "https://example.com/corridor.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        storyboardPlan: "Shot 1: the heroine steps into the corridor.",
      }),
    );

    expect(stage1.derivedStage).toBe("脚本拆解");
    expect(stage2.derivedStage).toBe("角色与场景");
    expect(stage3.derivedStage).toBe("分镜图生成");
    expect(stage4.derivedStage).toBe("视频生成");
    expect(stage5.derivedStage).toBe("预览与导出");
  });

  it("prefers the manually selected numeric video step for visible stage snapshots", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        currentStep: 3,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
          },
        ],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "Lead character",
            imageUrl: "https://example.com/hero.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Corridor",
            description: "Night corridor",
            imageUrl: "https://example.com/corridor.jpg",
            isAIGenerated: false,
            source: "auto",
          },
        ],
      }),
    );

    expect(snapshot.derivedStage).toBe("分镜图生成");
  });

  it.skip("keeps prompt-batch projects in the visible video generation stage even if earlier assets are incomplete", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        currentStep: 1,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
            storyboardUrl: "",
          },
        ],
        videoPromptBatch: "Prompt batch ready",
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(snapshot.derivedStage).toBe("瑙嗛鐢熸垚");
    expect(snapshot.recommendedActions[0]).toBe("鎻愪氦绗竴鎵硅棰戠敓鎴?");
  });

  it("keeps prompt-batch projects on the visible video-generation stage", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        currentStep: 1,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Opening",
            description: "The heroine enters the corridor.",
            characters: ["Hero"],
            dialogue: "",
            cameraDirection: "medium shot",
            duration: 5,
            storyboardUrl: "",
          },
        ],
        videoPromptBatch: "Prompt batch ready",
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(snapshot.derivedStage).toBe("视频生成");
    expect(snapshot.recommendedActions[0]).toBe("提交第一批视频生成");
  });

  it("includes failed video reasons in homepage recovery snapshots", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        id: "video-project-failed",
        title: "Failed Shot Recovery",
        outputGoal: "Recover failed shots",
        scenes: [
          {
            id: "scene-failed-1",
            sceneNumber: 1,
            sceneName: "Rain Alley Turn",
            description: "The heroine turns and checks how close the pursuers are.",
            characters: ["沈昭"],
            dialogue: "",
            cameraDirection: "handheld push-in",
            duration: 5,
            videoTaskId: "task-failed-1",
            videoStatus: "failed",
            videoFailure: {
              message: "Seedance rate limit exceeded",
              provider: "jimeng",
              stage: "submit",
              updatedAt: "2026-04-03T01:00:00.000Z",
            },
          },
        ],
        analysisSummary: "A failed shot is waiting for recovery.",
        storyboardPlan: "Shot 1: rain alley turn",
        videoPromptBatch: "Batch 1: rain alley turn",
        shotPackets: [
          {
            id: "packet:video-project-failed:scene-failed-1",
            sceneId: "scene-failed-1",
            sceneNumber: 1,
            title: "Rain Alley Turn",
            durationSec: 5,
            camera: {
              shotSize: "standard shot",
              movement: "handheld push-in",
            },
            characterRefs: [],
            sourceAssetIds: [],
            promptSeed: "The heroine turns and checks the distance to the pursuers.",
            forbiddenChanges: [],
            renderMode: "text2video",
            reviewStatus: "redo",
          },
        ],
      }),
    );

    expect(snapshot.agentSummary).toContain("Seedance rate limit exceeded");
    expect(snapshot.memory?.reviewQueue ?? []).toEqual(expect.any(Array));
  });

  it("restores exported production bundle metadata into homepage video snapshots", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        id: "video-project-bundle",
        title: "Rain Trailer",
        analysisSummary: "Shot packets are ready.",
        storyboardPlan: "Shot 1: rainy chase",
        videoPromptBatch: "Batch 1: rainy chase",
        productionStateBundle: {
          directoryPath: "D:/StoryForgeFiles/home-agent/production-state/Rain Trailer/video-project-bundle",
          overviewPath:
            "D:/StoryForgeFiles/home-agent/production-state/Rain Trailer/video-project-bundle/README.md",
          filePaths: [
            "D:/StoryForgeFiles/home-agent/production-state/Rain Trailer/video-project-bundle/overview.json",
          ],
          exportedCount: 7,
          exportedAt: "2026-04-03T01:20:00.000Z",
        },
      }),
    );

    expect(snapshot.artifacts.some((artifact) => artifact.label === "生产状态包")).toBe(true);
    expect(snapshot.recommendedActions.join(" ")).toContain("生产状态");
  });

  it("renames the underlying stored drama project and recent snapshot together", async () => {
    writeDramaProjects([
      {
        id: "drama-rename-1",
        dramaTitle: "Untitled Script Project",
        currentStep: "creative-plan",
        updatedAt: "2026-04-02T00:00:00.000Z",
        createdAt: "2026-04-01T00:00:00.000Z",
        setup: {
          genres: ["healing food"],
          audience: "all ages",
          tone: "warm",
          ending: "HE",
          totalEpisodes: 40,
          targetMarket: "cn",
        },
      },
    ]);

    await renameConversationProject("drama-rename-1", "The Confession Inside the Kitchen Light");

    const [project] = listStoredDramaProjects();
    const [snapshot] = await listRecentConversationSnapshots();

    expect(project?.dramaTitle).toBe("The Confession Inside the Kitchen Light");
    expect(snapshot?.title).toBe("The Confession Inside the Kitchen Light");
  });

  it("keeps the video snapshot in step 1 while bootstrap context is still missing", () => {
    const snapshot = createVideoSnapshot(
      createVideoFixture({
        targetPlatform: "",
        shotStyle: "",
        outputGoal: "",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Corridor Alert",
            description: "The heroine notices danger ahead.",
            characters: ["Ava"],
            dialogue: "",
            cameraDirection: "push in",
            duration: 5,
          },
        ],
      }),
    );

    expect(snapshot.derivedStage).toBe("脚本拆解");
  });
  it("materializes a dropped archive folder into a stored drama project during recent scan", async () => {
    const archiveProject = createDramaFixture({
      id: "archive-drama-1",
      dramaTitle: "Archive Auto Import",
      updatedAt: "2026-04-04T00:00:00.000Z",
    });
    const archiveSession = {
      projectId: "archive-drama-1",
      mode: "active",
      creationMode: "fast",
      automationMode: "manual",
      devMode: false,
      messages: [{ id: "m1", role: "assistant", content: "restore me", createdAt: "2026-04-04T00:00:00.000Z" }],
      currentProjectSnapshot: createDramaSnapshot(archiveProject),
      recentMessageSummary: "restore me",
      draft: "",
      compactedMessageCount: 0,
      qState: null,
      pendingChoiceQuestion: null,
      fullAutoRun: null,
      selectedValues: [],
      deferredQuestionState: null,
      deferredSelectedValues: [],
      deferredDraft: "",
      surfacedTaskIds: [],
      surfacedTaskFollowupKeys: [],
      surfacedProjectSuggestionKeys: [],
    };

    const archiveFiles = new Map<string, string>([
      [
        "C:/Storyforge/files/conversations/Archive-Auto-Import--archive-drama-1/chat-history.full.json",
        JSON.stringify(archiveSession),
      ],
      [
        "C:/Storyforge/files/conversations/Archive-Auto-Import--archive-drama-1/project.json",
        JSON.stringify(archiveProject),
      ],
    ]);

    const storage = {
      getDefaultPath: async () => ({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" }),
      listDir: async (dirPath: string) => {
        if (dirPath === "C:/Storyforge/files/conversations") {
          return {
            ok: true,
            entries: [{ name: "Archive-Auto-Import--archive-drama-1", isDirectory: true }],
          };
        }
        return { ok: true, entries: [] };
      },
      readText: async (filePath: string) =>
        archiveFiles.has(filePath)
          ? { ok: true, exists: true, content: archiveFiles.get(filePath) }
          : { ok: true, exists: false, content: "" },
      writeText: async (filePath: string, content: string) => {
        archiveFiles.set(filePath, content);
        return { ok: true };
      },
      importChatHistory: async ({ filePath, targetProjectDir }: { filePath: string; targetProjectDir?: string }) => ({
        ok: true,
        content: archiveFiles.get(filePath),
        importedMediaDir: targetProjectDir,
      }),
    };

    Object.defineProperty(window, "electronAPI", {
      value: { storage },
      writable: true,
      configurable: true,
    });

    const snapshots = await listRecentConversationSnapshots();

    expect(loadStoredDramaProjectById("archive-drama-1")?.dramaTitle).toBe("Archive Auto Import");
    expect(readStudioProjectSession("archive-drama-1")?.projectId).toBe("archive-drama-1");
    expect(snapshots.some((snapshot) => snapshot.projectId === "archive-drama-1")).toBe(true);
  });

  it("does not re-materialize the last deleted project when its archive folder still exists", async () => {
    const archiveProject = createDramaFixture({
      id: "archive-drama-deleted",
      dramaTitle: "Deleted Archive Should Stay Gone",
      updatedAt: "2026-04-05T00:00:00.000Z",
    });
    const archiveSession = {
      projectId: "archive-drama-deleted",
      mode: "active",
      creationMode: "fast",
      automationMode: "manual",
      devMode: false,
      messages: [{ id: "m1", role: "assistant", content: "delete me", createdAt: "2026-04-05T00:00:00.000Z" }],
      currentProjectSnapshot: createDramaSnapshot(archiveProject),
      recentMessageSummary: "delete me",
      draft: "",
      compactedMessageCount: 0,
      qState: null,
      pendingChoiceQuestion: null,
      fullAutoRun: null,
      selectedValues: [],
      deferredQuestionState: null,
      deferredSelectedValues: [],
      deferredDraft: "",
      surfacedTaskIds: [],
      surfacedTaskFollowupKeys: [],
      surfacedProjectSuggestionKeys: [],
    };

    writeDramaProjects([archiveProject]);
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        "archive-drama-deleted": archiveSession,
      }),
    );

    const archiveFiles = new Map<string, string>([
      [
        "C:/Storyforge/files/conversations/Deleted-Archive-Should-Stay-Gone--archive-drama-deleted/chat-history.full.json",
        JSON.stringify(archiveSession),
      ],
      [
        "C:/Storyforge/files/conversations/Deleted-Archive-Should-Stay-Gone--archive-drama-deleted/project.json",
        JSON.stringify(archiveProject),
      ],
    ]);

    const storage = {
      getDefaultPath: async () => ({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" }),
      listDir: async (dirPath: string) => {
        if (dirPath === "C:/Storyforge/files/conversations") {
          return {
            ok: true,
            entries: [{ name: "Deleted-Archive-Should-Stay-Gone--archive-drama-deleted", isDirectory: true }],
          };
        }
        return { ok: true, entries: [] };
      },
      readText: async (filePath: string) =>
        archiveFiles.has(filePath)
          ? { ok: true, exists: true, content: archiveFiles.get(filePath) }
          : { ok: true, exists: false, content: "" },
      writeText: async (filePath: string, content: string) => {
        archiveFiles.set(filePath, content);
        return { ok: true };
      },
      deleteDir: async () => ({ ok: false }),
      importChatHistory: async ({ filePath, targetProjectDir }: { filePath: string; targetProjectDir?: string }) => ({
        ok: true,
        content: archiveFiles.get(filePath),
        importedMediaDir: targetProjectDir,
      }),
    };

    Object.defineProperty(window, "electronAPI", {
      value: { storage },
      writable: true,
      configurable: true,
    });

    await deleteConversationProject({ projectId: "archive-drama-deleted", projectKind: "script" });

    expect(loadStoredDramaProjectById("archive-drama-deleted")).toBeNull();
    expect(readStudioProjectSession("archive-drama-deleted")).toBeNull();

    const snapshots = await listRecentConversationSnapshots();

    expect(loadStoredDramaProjectById("archive-drama-deleted")).toBeNull();
    expect(readStudioProjectSession("archive-drama-deleted")).toBeNull();
    expect(snapshots.some((snapshot) => snapshot.projectId === "archive-drama-deleted")).toBe(false);
  });
});
