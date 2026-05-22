import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/gemini-client", () => ({
  callGeminiStream: vi.fn(),
}));

vi.mock("@/lib/gemini-text-models", () => ({
  readStoredDecomposeModel: vi.fn(() => "test-model"),
}));

import { callGeminiStream } from "@/lib/gemini-client";
import type { StudioRuntimeState } from "@/lib/home-agent/types";
import {
  createDramaSnapshot,
  loadStoredDramaProjectById,
  upsertStoredDramaProject,
} from "@/lib/home-agent/project-store";
import {
  analyzeExportPatchAction,
  autoAdjustComplianceAction,
  analyzeReferenceScriptAction,
  enterDramaStepAction,
  generateDirectoryAction,
  generateEpisodeAction,
  generateEpisodeBatchAction,
  generateOutlinesAction,
  reviewEpisodeQualityAction,
  rewriteEpisodeFromReviewAction,
  runComplianceReviewAction,
  skipComplianceReviewAction,
  updateComplianceWorkspaceAction,
  updateDramaArtifactTextAction,
} from "./drama-workflow-service";
import {
  createEmptyComplianceWorkspace,
  createEmptyDramaProject,
  type DramaProject,
  type DramaSetup,
} from "@/types/drama";

const mockedCallGeminiStream = vi.mocked(callGeminiStream);

function createSetup(): DramaSetup {
  return {
    genres: ["都市言情"],
    audience: "女频",
    tone: "甜虐",
    ending: "HE",
    totalEpisodes: 2,
    targetMarket: "cn",
    setupMode: "creative",
    creativeInput: "A short-form serialized romance.",
  };
}

function createProject(
  overrides: Partial<DramaProject> = {},
  mode: DramaProject["mode"] = "traditional",
): DramaProject {
  const base = createEmptyDramaProject(mode);
  return {
    ...base,
    id: overrides.id ?? `project-${mode}`,
    mode,
    dramaTitle: overrides.dramaTitle ?? "Test Project",
    setup: createSetup(),
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    ...overrides,
  };
}

function createRuntime(project: DramaProject): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: null,
    currentDramaProject: project,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [],
    recentMessageSummary: "",
  };
}

function createReviewResult(total = 38) {
  return {
    scores: {
      rhythm: { score: 6, comment: "needs tighter pacing" },
      satisfaction: { score: 8, comment: "good payoff" },
      dialogue: { score: 7, comment: "serviceable" },
      format: { score: 9, comment: "clean formatting" },
      continuity: { score: 8, comment: "consistent" },
    },
    total,
    grade: "B",
    highlights: ["strong cold open"],
    issues: [{ level: "warning", description: "scene two drags" }],
    suggestions: ["trim scene two"],
  };
}

function visibleLength(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

describe("drama workflow service actions", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedCallGeminiStream.mockReset();
  });

  it("analyzes reference scripts and persists detected setup fields", async () => {
    const project = createProject(
      {
        currentStep: "reference-script",
        referenceScript: "A reference script with enough material to analyze.",
      },
      "adaptation",
    );

    mockedCallGeminiStream
      .mockResolvedValueOnce(
        JSON.stringify({
          targetMarket: "jp",
          audience: "女频",
          tone: "治愈",
          ending: "OE",
          suggestedEpisodes: 24,
        }),
      )
      .mockResolvedValueOnce("## 故事主线\n- 相遇\n- 冲突升级");

    const result = await analyzeReferenceScriptAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.referenceStructure).toContain("故事主线");
    expect(nextProject.setup?.targetMarket).toBe("jp");
    expect(nextProject.setup?.audience).toBe("女频");
    expect(nextProject.setup?.tone).toBe("治愈");
    expect(nextProject.setup?.ending).toBe("OE");
    expect(nextProject.setup?.totalEpisodes).toBe(24);
    expect(nextProject.currentStep).toBe("structure-transform");
  });

  it("fills missing outlines with single-episode compensation retries", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
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
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "第1-2集", startEp: 1, endEp: 2, status: "pending" },
      ],
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce("【第1集细纲】\n第一集细纲")
      .mockResolvedValueOnce("【第2集细纲】\n第二集细纲");

    const result = await generateOutlinesAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("第一集细纲");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("第二集细纲");
    expect(nextProject.outlineBatchStatuses?.[0]?.status).toBe("done");
    expect(nextProject.currentStep).toBe("episodes");
    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(2);
    expect(String(mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "")).toContain(
      "已生成细纲：第一集细纲",
    );
    expect(String(mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "")).toContain(
      "单集补写",
    );
  });

  it("keeps the workflow on the directory step after generating a directory", async () => {
    const project = createProject({
      currentStep: "characters",
      creativePlan: "Creative plan",
      characters: "Characters",
    });

    mockedCallGeminiStream.mockResolvedValueOnce(
      "1. Episode 1 - summary 1\n2. Episode 2 - summary 2",
    );

    const result = await generateDirectoryAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.currentStep).toBe("directory");
    expect(nextProject.directory.map((entry) => entry.number)).toEqual([1, 2]);
    expect(nextProject.outlineBatchStatuses).toHaveLength(1);
  });

  it("reloads the stored drama project from the snapshot before continuing after refresh", async () => {
    const project = createProject({
      currentStep: "characters",
      creativePlan: "Creative plan before refresh",
      characters: "Characters before refresh",
    });
    upsertStoredDramaProject(project);
    const runtimeAfterRefresh: StudioRuntimeState = {
      ...createRuntime(project),
      currentDramaProject: null,
      currentProjectSnapshot: createDramaSnapshot(project),
    };

    mockedCallGeminiStream.mockResolvedValueOnce(
      "1. Episode 1 - summary 1\n2. Episode 2 - summary 2",
    );

    const result = await generateDirectoryAction(
      { projectId: project.id },
      runtimeAfterRefresh,
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.id).toBe(project.id);
    expect(nextProject.creativePlan).toBe("Creative plan before refresh");
    expect(nextProject.characters).toBe("Characters before refresh");
    expect(nextProject.currentStep).toBe("directory");
  });

  it("stores the confirmed duration when entering episode writing", async () => {
    const project = createProject({
      currentStep: "outlines",
      preferredEpisodeDurationSeconds: null,
    });

    const result = await enterDramaStepAction(
      { step: "episodes", durationSeconds: 120 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.currentStep).toBe("episodes");
    expect(nextProject.preferredEpisodeDurationSeconds).toBe(120);
  });

  it("can keep the workflow on the outlines step after batch generation", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "directory",
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
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "第1-2集", startEp: 1, endEp: 2, status: "pending" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("【第1集细纲】\n第一集细纲\n\n---\n\n【第2集细纲】\n第二集细纲");

    const result = await generateOutlinesAction({ keepCurrentStep: true }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.currentStep).toBe("outlines");
    expect(nextProject.directory.every((entry) => entry.outline?.trim())).toBe(true);
  });

  it("generates requested outline ranges as one continuity batch", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
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
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
        },
        {
          number: 3,
          title: "Episode 3",
          summary: "summary 3",
          hookType: "悬念",
          isKey: false,
          isClimax: false,
          isPaywall: true,
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "第1-3集", startEp: 1, endEp: 3, status: "pending" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("【第1集细纲】\n第一集细纲\n\n---\n\n【第2集细纲】\n第二集细纲");

    const result = await generateOutlinesAction(
      { rangeStart: 1, rangeEnd: 2, keepCurrentStep: true },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("第1-2集");
    expect(prompt).toContain("第3集：Episode 3");
    expect(prompt).toContain("批内连续");
    expect(prompt).toContain("底层先完成连续性检查");
    expect(prompt).toContain("不要把这些底层检查项名称写进细纲正文");
    expect(prompt).toContain("场景转换");
    expect(prompt).toContain("情感走向");
    expect(prompt).toContain("结尾钩子");
    expect(prompt).toContain("衔接");
    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("第一集细纲");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("第二集细纲");
    expect(nextProject.directory.find((entry) => entry.number === 3)?.outline).toBeUndefined();
    expect(nextProject.currentStep).toBe("outlines");
  });

  it("fills only missing outlines and keeps existing outlines as continuity context", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "Directory raw",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "hook",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "Existing outline 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "hook",
          isKey: false,
          isClimax: true,
          isPaywall: false,
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "Episodes 1-2", startEp: 1, endEp: 2, status: "done" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce(
      "\u3010\u7b2c2\u96c6\u7ec6\u7eb2\u3011\nSecond outline",
    );

    const result = await generateOutlinesAction(
      { fillMissingOutlines: true, keepCurrentStep: true },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("Episode 2");
    expect(prompt).toContain("Existing outline 1");
    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("Existing outline 1");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("Second outline");
    expect(nextProject.outlineBatchStatuses?.[0]?.status).toBe("done");
    expect(nextProject.currentStep).toBe("outlines");
  });

  it("enforces the outline length limit before saving generated outlines", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "Directory raw",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "hook",
          isKey: true,
          isClimax: false,
          isPaywall: false,
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "Episode 1", startEp: 1, endEp: 1, status: "pending" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce(
      `【第1集细纲】Title
${"body".repeat(140)}
场景转换：${"scene".repeat(80)}
情感走向：${"emotion".repeat(60)}
结尾钩子：${"hook".repeat(60)}
衔接：${"link".repeat(60)}`,
    );

    const result = await generateOutlinesAction({ keepCurrentStep: true }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;
    const outline = nextProject.directory[0]?.outline ?? "";

    expect(visibleLength(outline)).toBeLessThanOrEqual(340);
    expect(outline).toContain("场景转换：");
    expect(outline).toContain("情感走向：");
    expect(outline).toContain("结尾钩子：");
    expect(outline).toContain("衔接：");
  });

  it("normalizes legacy oversized outline batches before generating", async () => {
    const directory = Array.from({ length: 12 }, (_, index) => ({
      number: index + 1,
      title: `Episode ${index + 1}`,
      summary: `summary ${index + 1}`,
      hookType: "悬念",
      isKey: false,
      isClimax: false,
      isPaywall: false,
    }));
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "目录原文",
      directory,
      outlineBatchStatuses: [
        { index: 0, label: "第1-12集", startEp: 1, endEp: 12, status: "pending" },
      ],
    });
    const outlineText = Array.from({ length: 10 }, (_, index) => {
      const number = index + 1;
      return `【第${number}集细纲】\n第${number}集细纲`;
    }).join("\n\n---\n\n");

    mockedCallGeminiStream
      .mockResolvedValueOnce(outlineText)
      .mockResolvedValueOnce("【第11集细纲】\n第11集细纲\n\n---\n\n【第12集细纲】\n第12集细纲");

    const result = await generateOutlinesAction({ keepCurrentStep: true }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    const secondPrompt = String(mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(2);
    expect(prompt).toContain("第1-10集");
    expect(secondPrompt).toContain("第11-12集");
    expect(nextProject.outlineBatchStatuses).toHaveLength(2);
    expect(nextProject.outlineBatchStatuses?.[0]?.status).toBe("done");
    expect(nextProject.outlineBatchStatuses?.[1]?.status).toBe("done");
  });

  it("can regenerate finished outline batches when explicitly requested", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
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
          outline: "旧细纲 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
          outline: "旧细纲 2",
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "第1-2集", startEp: 1, endEp: 2, status: "done" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("【第1集细纲】\n新细纲 1\n\n---\n\n【第2集细纲】\n新细纲 2");

    const result = await generateOutlinesAction(
      { regenerateAll: true, keepCurrentStep: true },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("新细纲 1");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("新细纲 2");
    expect(nextProject.currentStep).toBe("outlines");
  });

  it("blocks single-episode generation when the previous episode is still missing", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });

    await expect(
      generateEpisodeAction({ episodeNumber: 3 }, createRuntime(project)),
    ).rejects.toThrow("第 3 集正文前，需先完成第 2 集正文");
    expect(mockedCallGeminiStream).not.toHaveBeenCalled();
  });

  it("uses newly generated batch content as continuity context for later episodes", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
      episodes: [{ number: 1, title: "Episode 1", content: "existing episode 1", wordCount: 1000 }],
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce("fresh episode 2")
      .mockResolvedValueOnce("fresh episode 3");

    const result = await generateEpisodeBatchAction(
      { episodeNumbers: [2, 3], durationSeconds: 90 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const thirdEpisodePrompt = String(
      mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "",
    );

    expect(nextProject.episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
    expect(nextProject.preferredEpisodeDurationSeconds).toBe(90);
    expect(nextProject.episodes.find((episode) => episode.number === 2)?.content).toBe("fresh episode 2");
    expect(thirdEpisodePrompt).toContain("fresh episode 2");
  });

  it("fills remaining unwritten episode bodies in order", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      directoryRaw: "目录原文",
      directory: [
        { number: 1, title: "Episode 1", summary: "summary 1", hookType: "反转", isKey: true, isClimax: false, isPaywall: false, outline: "outline 1" },
        { number: 2, title: "Episode 2", summary: "summary 2", hookType: "升级", isKey: false, isClimax: true, isPaywall: false, outline: "outline 2" },
        { number: 3, title: "Episode 3", summary: "summary 3", hookType: "悬念", isKey: false, isClimax: false, isPaywall: true, outline: "outline 3" },
      ],
      episodes: [
        { number: 1, title: "Episode 1", content: "existing episode 1", wordCount: 1000 },
        { number: 2, title: "Episode 2", content: "   ", wordCount: 0 },
      ],
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce("filled episode 2")
      .mockResolvedValueOnce("filled episode 3");

    const result = await generateEpisodeBatchAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;
    const firstPrompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");
    const secondPrompt = String(mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(2);
    expect(nextProject.episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
    expect(nextProject.episodes.find((episode) => episode.number === 2)?.content).toBe("filled episode 2");
    expect(nextProject.episodes.find((episode) => episode.number === 3)?.content).toBe("filled episode 3");
    expect(firstPrompt).toContain("自动批量补齐任务");
    expect(secondPrompt).toContain("filled episode 2");
    expect(result.summary).toContain("补齐 2 集");
  });

  it("blocks jump batch generation when a required previous episode is outside the request", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
        {
          number: 4,
          title: "Episode 4",
          summary: "summary 4",
          hookType: "爆点",
          isKey: false,
          isClimax: true,
          isPaywall: true,
          outline: "outline 4",
        },
      ],
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });

    await expect(
      generateEpisodeBatchAction({ episodeNumbers: [3, 4] }, createRuntime(project)),
    ).rejects.toThrow("第 3 集（缺少第 2 集）");
    expect(mockedCallGeminiStream).not.toHaveBeenCalled();
  });

  /*
  it("can regenerate a single outline with an adjustment instruction", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
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
          outline: "旧细纲 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "升级",
          isKey: false,
          isClimax: true,
          isPaywall: false,
          outline: "旧细纲 2",
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "第1-2集", startEp: 1, endEp: 2, status: "done" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("【第2集细纲】\n标题：Episode 2\n新细纲 2");

    const result = await generateOutlinesAction(
      {
        episodeNumbers: [2],
        keepCurrentStep: true,
        customInstruction: "加强冲突并把结尾钩子前置。",
      },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("旧细纲 1");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("新细纲 2");
    expect(prompt).toContain("加强冲突并把结尾钩子前置。");
    expect(nextProject.currentStep).toBe("outlines");
  });

  it("can regenerate a single outlined episode with a custom adjustment instruction", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "鐩綍鍘熸枃",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "鍙嶈浆",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "鏃х粏绾?1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "鍗囩骇",
          isKey: false,
          isClimax: true,
          isPaywall: false,
          outline: "鏃х粏绾?2",
        },
      ],
      outlineBatchStatuses: [
        { index: 0, label: "绗?-2闆?, startEp: 1, endEp: 2, status: "done" },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("銆愮1闆嗙粏绾层€慭n鏂板啿绐佺増缁嗙翰");

    const result = await generateOutlinesAction(
      {
        rangeStart: 1,
        rangeEnd: 1,
        keepCurrentStep: true,
        customInstruction: "加强冲突，结尾钩子更狠",
      },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.directory.find((entry) => entry.number === 1)?.outline).toBe("鏂板啿绐佺増缁嗙翰");
    expect(nextProject.directory.find((entry) => entry.number === 2)?.outline).toBe("鏃х粏绾?2");
    expect(nextProject.currentStep).toBe("outlines");
    expect(JSON.stringify(mockedCallGeminiStream.mock.calls[0])).toContain("加强冲突，结尾钩子更狠");
  });

  });
  */

  it("stores structured batch review packets for completed episodes", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
      episodes: [
        { number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 },
        { number: 2, title: "Episode 2", content: "body 2", wordCount: 1050 },
      ],
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(38)))
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(42)));

    const result = await reviewEpisodeQualityAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.episodeQualityReviewPackets).toHaveLength(2);
    expect(nextProject.episodeQualityReviewPackets?.[0]?.rewriteInstruction).toContain("第 1 集");
    expect(nextProject.episodeQualityReviewPackets?.[1]?.result.total).toBe(42);
    expect(nextProject.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "default-count",
      episodeNumbers: [1, 2],
      requestedCount: 2,
    });
    expect(result.summary).toContain("本轮质检 2 集");
  });

  it("prioritizes unreviewed episodes for default-count review batches", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 12,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: index === 11,
        isPaywall: index >= 9,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `body ${index + 1}`,
        wordCount: 1000 + index,
      })),
      episodeQualityReviewPackets: Array.from({ length: 5 }, (_, index) => ({
        id: `review-${index + 1}`,
        episodeNumber: index + 1,
        title: `Episode ${index + 1}`,
        reviewedAt: "2026-04-02T00:00:00.000Z",
        rewriteInstruction: `Repair episode ${index + 1}`,
        result: createReviewResult(30 + index),
      })),
    });

    Array.from({ length: 7 }, (_, index) => index).forEach((index) => {
      mockedCallGeminiStream.mockResolvedValueOnce(JSON.stringify(createReviewResult(40 + index)));
    });

    const result = await reviewEpisodeQualityAction(
      { defaultReviewCount: 10 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(7);
    expect(nextProject.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "default-count",
      episodeNumbers: [6, 7, 8, 9, 10, 11, 12],
      requestedCount: 10,
    });
    expect(result.summary).toContain("本轮质检 7 集");
  });

  it("fills only remaining unreviewed episodes for review batches", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 4,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 4 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: false,
        isPaywall: false,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 4 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `body ${index + 1}`,
        wordCount: 1000 + index,
      })),
      episodeQualityReviewPackets: [1, 3].map((episodeNumber) => ({
        id: `review-${episodeNumber}`,
        episodeNumber,
        title: `Episode ${episodeNumber}`,
        reviewedAt: "2026-04-02T00:00:00.000Z",
        rewriteInstruction: `Repair episode ${episodeNumber}`,
        result: createReviewResult(35 + episodeNumber),
      })),
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(42)))
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(43)));

    const result = await reviewEpisodeQualityAction(
      { reviewRemaining: true, defaultReviewCount: 10 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(2);
    expect(nextProject.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "default-count",
      episodeNumbers: [2, 4],
      requestedCount: 4,
    });
    expect(nextProject.episodeQualityReviewPackets?.map((packet) => packet.episodeNumber)).toEqual([1, 2, 3, 4]);
  });

  it("persists completed review packets before a later batch failure", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 2,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 2 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: index === 1,
        isPaywall: false,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 2 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `body ${index + 1}`,
        wordCount: 1000 + index,
      })),
    });
    upsertStoredDramaProject(project);

    mockedCallGeminiStream
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(41)))
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("review failed")), 0);
          }),
      );

    await expect(reviewEpisodeQualityAction({}, createRuntime(project))).rejects.toThrow("review failed");

    const savedProject = loadStoredDramaProjectById(project.id);
    expect(savedProject?.episodeQualityReviewPackets?.map((packet) => packet.episodeNumber)).toEqual([1]);
    expect(savedProject?.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "default-count",
      episodeNumbers: [1],
      requestedCount: 2,
    });
  });

  it("falls back to the most recently completed episodes when all completed episodes already have review packets", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 5,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 5 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: index === 4,
        isPaywall: index >= 3,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 5 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `body ${index + 1}`,
        wordCount: 1000 + index,
      })),
      episodeQualityReviewPackets: Array.from({ length: 5 }, (_, index) => ({
        id: `review-${index + 1}`,
        episodeNumber: index + 1,
        title: `Episode ${index + 1}`,
        reviewedAt: "2026-04-02T00:00:00.000Z",
        rewriteInstruction: `Repair episode ${index + 1}`,
        result: createReviewResult(32 + index),
      })),
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(41)))
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(42)))
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(43)));

    const result = await reviewEpisodeQualityAction(
      { defaultReviewCount: 3 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "default-count",
      episodeNumbers: [3, 4, 5],
      requestedCount: 3,
    });
    expect(result.summary).toContain("本轮质检 3 集");
  });

  it("supports custom review-count batches with dedicated batch metadata", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 4,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 4 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: index === 3,
        isPaywall: index >= 2,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 4 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `body ${index + 1}`,
        wordCount: 1000 + index,
      })),
    });

    mockedCallGeminiStream
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(39)))
      .mockResolvedValueOnce(JSON.stringify(createReviewResult(40)));

    const result = await reviewEpisodeQualityAction(
      { reviewCount: 2 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.lastEpisodeQualityReviewBatch).toMatchObject({
      mode: "custom-count",
      episodeNumbers: [1, 2],
      requestedCount: 2,
    });
    expect(result.summary).toContain("本轮质检 2 集");
  });

  it("blocks explicit episode review requests when some episodes have not been written yet", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });

    await expect(
      reviewEpisodeQualityAction({ episodeNumbers: [1, 2] }, createRuntime(project)),
    ).rejects.toThrow("第 2 集");
    expect(mockedCallGeminiStream).not.toHaveBeenCalled();
  });

  it("keeps editable plan and character text in sync for adaptation projects", async () => {
    const project = createProject(
      {
        currentStep: "character-transform",
        creativePlan: "Old transformed plan",
        structureTransform: "Old transformed plan",
        characters: "Old transformed characters",
        characterTransform: "Old transformed characters",
      },
      "adaptation",
    );

    const planResult = await updateDramaArtifactTextAction(
      { field: "creativePlan", text: "New transformed plan" },
      createRuntime(project),
    );
    const planProject = planResult.data?.dramaProject as DramaProject;

    expect(planProject.creativePlan).toBe("New transformed plan");
    expect(planProject.structureTransform).toBe("New transformed plan");

    const characterResult = await updateDramaArtifactTextAction(
      { field: "characters", text: "New transformed characters" },
      createRuntime(planProject),
    );
    const characterProject = characterResult.data?.dramaProject as DramaProject;

    expect(characterProject.characters).toBe("New transformed characters");
    expect(characterProject.characterTransform).toBe("New transformed characters");
  });

  it("reparses edited directory and outline text back into the project", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "第1集：旧标题 - 旧简介",
      directory: [
        {
          number: 1,
          title: "旧标题",
          summary: "旧简介",
          hookType: "悬念钩子",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "旧细纲",
        },
      ],
    });

    const directoryResult = await updateDramaArtifactTextAction(
      {
        field: "directoryRaw",
        text: "第1集：新标题 - 新简介\n第2集：第二集标题 - 第二集简介",
      },
      createRuntime(project),
    );
    const directoryProject = directoryResult.data?.dramaProject as DramaProject;

    expect(directoryProject.directory).toHaveLength(2);
    expect(directoryProject.directory[0]?.title).toBe("新标题");
    expect(directoryProject.directory[0]?.outline).toBe("旧细纲");

    const outlineResult = await updateDramaArtifactTextAction(
      {
        field: "outlines",
        text: "【第1集细纲】\n新标题\n新的第一集细纲",
      },
      createRuntime(directoryProject),
    );
    const outlineProject = outlineResult.data?.dramaProject as DramaProject;

    expect(outlineProject.directory[0]?.outline).toBe("新的第一集细纲");
    expect(outlineProject.directory[1]?.outline).toBeUndefined();
  });

  it("parses emoji markers in edited directory text without confusing climax and paywall tags", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "outlines",
      directoryRaw: "第1集：旧标题 - 旧简介",
      directory: [],
    });

    const directoryResult = await updateDramaArtifactTextAction(
      {
        field: "directoryRaw",
        text: [
          "第1集：命运签约 - 女主被迫签下契约 [悬念钩] [情绪:3] 🔥",
          "第2集：情绪爆点 - 真相当场翻盘 [反转钩] [情绪:5] ⚡",
          "第3集：付费断点 - 门外传来敲门声 [危机钩] [情绪:4] 💰",
        ].join("\n"),
      },
      createRuntime(project),
    );
    const nextProject = directoryResult.data?.dramaProject as DramaProject;

    expect(nextProject.directory).toHaveLength(3);
    expect(nextProject.directory[0]).toMatchObject({
      hookType: "悬念钩",
      isKey: true,
      isClimax: false,
      isPaywall: false,
      emotionLevel: 3,
    });
    expect(nextProject.directory[1]).toMatchObject({
      hookType: "反转钩",
      isKey: false,
      isClimax: true,
      isPaywall: false,
      emotionLevel: 5,
    });
    expect(nextProject.directory[2]).toMatchObject({
      hookType: "危机钩",
      isKey: false,
      isClimax: false,
      isPaywall: true,
      emotionLevel: 4,
    });
  });

  it("rewrites the targeted reviewed episode and clears its stale packet", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
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
      ],
      episodes: [{ number: 1, title: "Episode 1", content: "old body", wordCount: 1000 }],
      episodeQualityReviewPackets: [
        {
          id: "review-1",
          episodeNumber: 1,
          title: "Episode 1",
          reviewedAt: "2026-04-02T00:00:00.000Z",
          rewriteInstruction: "Tighten the pacing",
          result: createReviewResult(35),
        },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("new rewritten body");

    const result = await rewriteEpisodeFromReviewAction({ episodeNumber: 1 }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.episodes.find((episode) => episode.number === 1)?.content).toBe("new rewritten body");
    expect(nextProject.episodeQualityReviewPackets).toEqual([]);
  });

  it("repairs reviewed episodes in batches of at most ten", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "episodes",
      setup: {
        ...createSetup(),
        totalEpisodes: 12,
      },
      directoryRaw: "目录原文",
      directory: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        summary: `summary ${index + 1}`,
        hookType: "反转",
        isKey: index === 0,
        isClimax: false,
        isPaywall: false,
        outline: `outline ${index + 1}`,
      })),
      episodes: Array.from({ length: 12 }, (_, index) => ({
        number: index + 1,
        title: `Episode ${index + 1}`,
        content: `old body ${index + 1}`,
        wordCount: 1000 + index,
      })),
      episodeQualityReviewPackets: Array.from({ length: 12 }, (_, index) => ({
        id: `review-${index + 1}`,
        episodeNumber: index + 1,
        title: `Episode ${index + 1}`,
        reviewedAt: "2026-04-02T00:00:00.000Z",
        rewriteInstruction: `Repair episode ${index + 1}`,
        result: createReviewResult(30 + index),
      })),
    });

    Array.from({ length: 10 }, (_, index) => index).forEach((index) => {
      mockedCallGeminiStream.mockResolvedValueOnce(`new body ${index + 1}`);
    });

    const result = await rewriteEpisodeFromReviewAction(
      { repairAll: true, repairLimit: 10 },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(10);
    expect(nextProject.episodes.find((episode) => episode.number === 1)?.content).toBe("new body 1");
    expect(nextProject.episodes.find((episode) => episode.number === 10)?.content).toBe("new body 10");
    expect(nextProject.episodes.find((episode) => episode.number === 11)?.content).toBe("old body 11");
    expect(nextProject.episodeQualityReviewPackets?.map((packet) => packet.episodeNumber)).toEqual([11, 12]);
    expect(result.summary).toContain("修复 10 集");
  });

  it("persists the requested compliance review mode", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction({ reviewMode: "script" }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceReport).toBe("Structured compliance report");
    expect(nextProject.complianceReviewMode).toBe("script");
    expect(nextProject.currentStep).toBe("compliance");
    expect(nextProject.complianceWorkspace.reviewBaselineSourceText).toContain("body 1");
    expect(nextProject.complianceWorkspace.reviewBaselineReviewedAt).toBeTruthy();
    expect(mockedCallGeminiStream).toHaveBeenCalled();
    expect(mockedCallGeminiStream.mock.calls[0]?.[3]).toMatchObject({ temperature: 0.1 });
  });

  it("prefers the latest episode script when project-script source is requested", async () => {
    const staleSourceText = "stale workspace source";
    const latestScriptContent = "latest episode content";
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "directory raw",
      episodes: [{ number: 1, title: "Episode 1", content: latestScriptContent, wordCount: 1000 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText: staleSourceText,
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction(
      { reviewMode: "text", sourceStrategy: "project-script" },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(nextProject.complianceWorkspace.sourceText).toContain(latestScriptContent);
    expect(nextProject.complianceWorkspace.sourceText).not.toContain(staleSourceText);
    expect(nextProject.complianceWorkspace.paletteText).toContain(latestScriptContent);
    expect(prompt).toContain(latestScriptContent);
    expect(prompt).not.toContain(staleSourceText);
  });

  it("writes dialogue review markers into the palette text when dialogue review is enabled", async () => {
    const longDialogue = `角色A：${"这是一次很长的对话".repeat(8)}`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: longDialogue, wordCount: 1000 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        dialogueReviewEnabled: true,
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction({ reviewMode: "script" }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceWorkspace.dialogueReviewEnabled).toBe(true);
    expect(nextProject.complianceWorkspace.paletteText).toContain("【对话审查】");
    expect(nextProject.complianceWorkspace.paletteText).toContain(longDialogue);
    expect(nextProject.complianceWorkspace.dialogueOverLimitLineIndexes.length).toBeGreaterThan(0);
  });

  it("refreshes dialogue review markers from the latest script content on rerun", async () => {
    const staleDialogue = `角色A：${"旧版本对话".repeat(10)}`;
    const latestDialogue = `角色B：${"新版本对话".repeat(10)}`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: latestDialogue, wordCount: 1000 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText: staleDialogue,
        paletteText: `【对话审查】 ${staleDialogue}`,
        dialogueReviewEnabled: true,
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction({ reviewMode: "script" }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceWorkspace.sourceText).toContain(latestDialogue);
    expect(nextProject.complianceWorkspace.paletteText).toContain(latestDialogue);
    expect(nextProject.complianceWorkspace.paletteText).toContain("【对话审查】");
    expect(nextProject.complianceWorkspace.paletteText).not.toContain(staleDialogue);
  });

  it("starts a rerun from a fresh palette and history even when the source text is unchanged", async () => {
    const sourceText = "角色A：这是当前待审正文";
    const stalePaletteText = "角色A：这是上一次调色后的正文";
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: sourceText, wordCount: 1000 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText,
        paletteText: stalePaletteText,
        riskPhrases: [
          {
            id: "old-risk",
            level: "high",
            text: "旧风险片段",
            reason: "old",
            segmentIndex: 0,
            replacement: "旧改写",
            status: "resolved",
          },
        ],
        phraseReplacements: { "old-risk": "旧改写" },
        history: ["更早版本", stalePaletteText],
        historyIndex: 1,
      },
      complianceReport: "Old report",
      complianceRevisionPackets: [
        {
          id: "old-packet",
          issueTitle: "Old packet",
          riskLevel: "medium",
          recommendation: "Old recommendation",
          status: "resolved",
          replacement: "旧改写",
        },
      ],
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction({ reviewMode: "script" }, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceReport).toBe("Structured compliance report");
    expect(nextProject.complianceWorkspace.sourceText).toContain(sourceText);
    expect(nextProject.complianceWorkspace.paletteText).toBe(nextProject.complianceWorkspace.sourceText);
    expect(nextProject.complianceWorkspace.history).toEqual([nextProject.complianceWorkspace.sourceText]);
    expect(nextProject.complianceWorkspace.historyIndex).toBe(0);
    expect(nextProject.complianceWorkspace.phraseReplacements).toEqual({});
    expect(nextProject.complianceWorkspace.riskPhrases).toEqual([]);
    expect(nextProject.complianceRevisionPackets.some((packet) => packet.id === "old-packet")).toBe(false);
  });

  it("uses smart incremental rerun to keep unresolved risks while reviewing only changed content", async () => {
    const oldRiskText = "角色A：旧风险";
    const newRiskyLine = "新增风险段";
    const baselineSourceText = `第1集 Episode 1\n${oldRiskText}\n中间安全段落\n结尾安全段落`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [
        {
          number: 1,
          title: "Episode 1",
          content: `${oldRiskText}\n中间安全段落\n结尾安全段落\n${newRiskyLine}`,
          wordCount: 64,
        },
      ],
      complianceReport: "Old compliance report",
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText: baselineSourceText,
        paletteText: baselineSourceText,
        reviewBaselineSourceText: baselineSourceText,
        reviewBaselineReviewedAt: "2026-04-01T00:00:00.000Z",
        riskPhrases: [
          {
            id: "risk-1",
            level: "high",
            text: oldRiskText,
            reason: "keep watching this line",
            segmentIndex: 0,
            status: "pending",
          },
        ],
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction(
      { reviewMode: "text", sourceStrategy: "project-script", smartRerun: true },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(prompt).toContain(newRiskyLine);
    expect(prompt).not.toContain(oldRiskText);
    expect(nextProject.complianceReport).toContain("智能重审摘要");
    expect(nextProject.complianceWorkspace.riskPhrases.map((phrase) => phrase.text)).toContain(oldRiskText);
    expect(nextProject.complianceWorkspace.reviewBaselineSourceText).toContain(newRiskyLine);
  });

  it("falls back to a full rerun when the source text changes too much", async () => {
    const baselineSourceText = "第1集 Episode 1\n角色A：旧风险\n旧段落";
    const nextSourceText = "全新场景一\n全新场景二\n全新场景三\n全新场景四";
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: nextSourceText, wordCount: nextSourceText.length }],
      complianceReport: "Old compliance report",
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText: baselineSourceText,
        paletteText: baselineSourceText,
        reviewBaselineSourceText: baselineSourceText,
        reviewBaselineReviewedAt: "2026-04-01T00:00:00.000Z",
        riskPhrases: [
          {
            id: "risk-1",
            level: "high",
            text: "角色A：旧风险",
            reason: "old risk",
            segmentIndex: 0,
            status: "pending",
          },
        ],
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    const result = await runComplianceReviewAction(
      { reviewMode: "text", sourceStrategy: "project-script", smartRerun: true },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;
    const prompt = String(mockedCallGeminiStream.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(prompt).toContain("全新场景一");
    expect(prompt).toContain("全新场景四");
    expect(nextProject.complianceReport).toBe("Structured compliance report");
    expect(nextProject.complianceWorkspace.reviewBaselineSourceText).toContain("全新场景四");
    expect(nextProject.complianceWorkspace.riskPhrases).toEqual([]);
  });

  it("removes dialogue review markers when the toggle is turned off", async () => {
    const markedDialogue = `【对话审查】 角色A：${"这是一次很长的对话".repeat(8)}`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText: markedDialogue.replace("【对话审查】 ", ""),
        paletteText: markedDialogue,
        history: [markedDialogue],
        historyIndex: 0,
        dialogueReviewEnabled: true,
        dialogueOverLimitLineIndexes: [0],
      },
    });

    const result = await updateComplianceWorkspaceAction(
      { dialogueReviewEnabled: false },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceWorkspace.dialogueReviewEnabled).toBe(false);
    expect(nextProject.complianceWorkspace.paletteText).not.toContain("【对话审查】");
    expect(nextProject.complianceWorkspace.dialogueOverLimitLineIndexes).toEqual([]);
  });

  it("syncs auto-adjusted compliance text back into episodes before rerun", async () => {
    const originalText = "角色A：危险表达";
    const replacementText = "角色A：安全表达";
    const sourceText = `第1集 Episode 1\n${originalText}`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: originalText, wordCount: originalText.length }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText,
        paletteText: sourceText,
        riskPhrases: [
          {
            id: "risk-1",
            level: "high",
            text: originalText,
            reason: "weaken the expression",
            segmentIndex: 0,
            status: "pending",
          },
        ],
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce(
      JSON.stringify({ items: [{ id: "risk-1", replacement: replacementText }] }),
    );

    const adjusted = await autoAdjustComplianceAction(
      { sourceStrategy: "project-script" },
      createRuntime(project),
    );
    const adjustedProject = adjusted.data?.dramaProject as DramaProject;

    expect(adjustedProject.episodes[0]?.content).toBe(replacementText);
    expect(adjustedProject.complianceWorkspace.sourceText).toContain(replacementText);
    expect(adjustedProject.complianceWorkspace.sourceText).not.toContain(originalText);

    mockedCallGeminiStream.mockResolvedValueOnce("Structured compliance report");

    await runComplianceReviewAction(
      { reviewMode: "text", sourceStrategy: "project-script" },
      createRuntime(adjustedProject),
    );
    const rerunPrompt = String(mockedCallGeminiStream.mock.calls[1]?.[1]?.[0]?.parts?.[0]?.text ?? "");

    expect(rerunPrompt).toContain(replacementText);
    expect(rerunPrompt).not.toContain(originalText);
  });

  it("keeps unmatched compliance risks pending when auto-adjust returns no replacement", async () => {
    const sourceText = "第1集 Episode 1\n角色A：危险表达";
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "角色A：危险表达", wordCount: 9 }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText,
        paletteText: sourceText,
        riskPhrases: [
          {
            id: "risk-1",
            level: "high",
            text: "角色A：危险表达",
            reason: "weaken the expression",
            segmentIndex: 0,
            status: "pending",
          },
        ],
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce(JSON.stringify({ items: [] }));

    const result = await autoAdjustComplianceAction(
      { sourceStrategy: "project-script" },
      createRuntime(project),
    );
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.complianceWorkspace.riskPhrases[0]?.status).toBe("pending");
  });

  it("reuses the synced compliance workspace text after auto-adjust instead of re-reviewing the repaired lines", async () => {
    const originalText = "角色A：危险表达";
    const replacementText = "角色A：安全表达";
    const sourceText = `第1集 Episode 1\n${originalText}`;
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "compliance",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: originalText, wordCount: originalText.length }],
      complianceWorkspace: {
        ...createEmptyComplianceWorkspace(),
        sourceText,
        paletteText: sourceText,
        reviewBaselineSourceText: sourceText,
        reviewBaselineReviewedAt: "2026-04-01T00:00:00.000Z",
        riskPhrases: [
          {
            id: "risk-1",
            level: "high",
            text: originalText,
            reason: "weaken the expression",
            segmentIndex: 0,
            status: "pending",
          },
        ],
      },
    });

    mockedCallGeminiStream.mockResolvedValueOnce(
      JSON.stringify({ items: [{ id: "risk-1", replacement: replacementText }] }),
    );

    const adjusted = await autoAdjustComplianceAction(
      { sourceStrategy: "project-script" },
      createRuntime(project),
    );
    const adjustedProject = adjusted.data?.dramaProject as DramaProject;

    const rerun = await runComplianceReviewAction(
      { reviewMode: "text", sourceStrategy: "project-script", smartRerun: true },
      createRuntime(adjustedProject),
    );
    const rerunProject = rerun.data?.dramaProject as DramaProject;

    expect(mockedCallGeminiStream).toHaveBeenCalledTimes(1);
    expect(rerunProject.complianceWorkspace.sourceText).toContain(replacementText);
    expect(rerunProject.complianceWorkspace.riskPhrases).toEqual([]);
    expect(rerunProject.complianceRevisionPackets).toEqual([]);
    expect(rerunProject.complianceReport).toContain("智能重审摘要");
  });

  it("can skip compliance review and move the project into export", async () => {
    const project = createProject({
      currentStep: "episodes",
      creativePlan: "Creative plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });

    const result = await skipComplianceReviewAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.currentStep).toBe("export");
    expect(nextProject.complianceReport).toBe("");
  });

  it("reuses the stored project when compliance skip runs before drama hydration finishes", async () => {
    const project = createProject({
      id: "script-project-skip",
      dramaTitle: "Named Script Project",
      currentStep: "episodes",
      creativePlan: "Creative plan",
      characters: "Characters",
      directoryRaw: "目录原文",
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
    });
    upsertStoredDramaProject(project);

    const runtime: StudioRuntimeState = {
      sessionId: "session-1",
      currentProjectSnapshot: createDramaSnapshot(project),
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: [],
      recentMessageSummary: "",
    };

    const result = await skipComplianceReviewAction({ projectId: project.id }, runtime);
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.id).toBe(project.id);
    expect(nextProject.dramaTitle).toBe("Named Script Project");
    expect(nextProject.currentStep).toBe("export");
  });

  it("builds and persists a structured export patch plan", async () => {
    const project = createProject({
      creativePlan: "Creative plan",
      characters: "Characters",
      currentStep: "export",
      directoryRaw: "Directory raw",
      directory: [
        {
          number: 1,
          title: "Episode 1",
          summary: "summary 1",
          hookType: "reversal",
          isKey: true,
          isClimax: false,
          isPaywall: false,
          outline: "outline 1",
        },
        {
          number: 2,
          title: "Episode 2",
          summary: "summary 2",
          hookType: "upgrade",
          isKey: false,
          isClimax: true,
          isPaywall: false,
        },
      ],
      episodes: [{ number: 1, title: "Episode 1", content: "body 1", wordCount: 1000 }],
      complianceRevisionPackets: [
        {
          id: "compliance-1",
          issueTitle: "High risk issue",
          riskLevel: "high",
          recommendation: "Revise coercive language.",
          status: "pending",
        },
      ],
      episodeQualityReviewPackets: [
        {
          id: "review-1",
          episodeNumber: 1,
          title: "Episode 1",
          reviewedAt: "2026-04-02T00:00:00.000Z",
          rewriteInstruction: "Repair episode one",
          result: createReviewResult(34),
        },
      ],
    });

    const result = await analyzeExportPatchAction({}, createRuntime(project));
    const nextProject = result.data?.dramaProject as DramaProject;

    expect(nextProject.exportPatchPlan?.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["missing-outline", "missing-episode", "episode-review", "compliance", "export-refresh"]),
    );
    expect(nextProject.exportPatchPlan?.recommendedAction?.value).toBe("生成单集细纲");
    expect(result.summary).toContain("导出前建议处理的缺口");
  });
});
