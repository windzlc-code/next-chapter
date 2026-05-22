import { describe, expect, it } from "vitest";
import {
  buildComplianceQuestion,
  buildVideoBridgeRetryQuestion,
  buildVideoContinuationQuestion,
  buildEpisodeDurationGateQuestion,
  buildEpisodeWorkflowQuestion,
  buildExportWorkflowQuestion,
  buildScriptPacketQuestion,
  buildVideoBridgePrefixQuestion,
  buildVideoBridgeQuestion,
  buildVideoGenerationQuestion,
  buildVideoWorkflowTaskBoard,
  ensureUniqueOptionIds,
  recQuestion,
} from "./home-agent-project-questions";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { createVideoSnapshot as createProjectVideoSnapshot } from "@/lib/home-agent/project-store";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { createEmptyComplianceWorkspace } from "@/types/drama";

const SCRIPT_WRITING = "\u5267\u672c\u64b0\u5199";
const COMPLIANCE_REVIEW = "\u5408\u89c4\u5ba1\u67e5";
const OUTLINE_STAGE = "\u5355\u96c6\u7ec6\u7eb2";
const EXPORT_STAGE = "\u5bfc\u51fa\u4e0e\u51fa\u7247";
const SCRIPT_BREAKDOWN = "\u811a\u672c\u62c6\u89e3";
const ROLE_AND_SCENE = "\u89d2\u8272\u4e0e\u573a\u666f";
const STORYBOARD_STAGE = "\u5206\u955c\u56fe\u751f\u6210";
const VIDEO_PROMPT_STAGE = "\u89c6\u9891\u63d0\u793a\u8bcd";
const VIDEO_GENERATION_STAGE = "\u89c6\u9891\u751f\u6210";
const PREVIEW_EXPORT_STAGE = "\u9884\u89c8\u4e0e\u5bfc\u51fa";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "project-1",
    projectKind: "script",
    title: "Question Project",
    currentObjective: "Advance the workflow",
    derivedStage: SCRIPT_WRITING,
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
    derivedStage: SCRIPT_BREAKDOWN,
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
    if (option.children?.length) queue.push(...option.children);
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
    if (option.children?.length) queue.push(...option.children);
  }
  return labels;
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
    if (option.children?.length) queue.push(...option.children);
  }
  return null;
}

function createComplianceArtifact() {
  return {
    id: "compliance",
    kind: "compliance" as const,
    label: "Compliance",
    summary: "Compliance summary",
    updatedAt: "2026-04-02T00:00:00.000Z",
    presentation: "script-rich" as const,
    payload: {
      type: "complianceSummary" as const,
      mode: "text" as const,
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
        riskPhrases: [
          { id: "risk-red", level: "red" as const, text: "risk", reason: "", segmentIndex: 0, status: "pending" as const },
          { id: "risk-high", level: "high" as const, text: "risk", reason: "", segmentIndex: 0, status: "pending" as const },
          { id: "risk-info", level: "info" as const, text: "risk", reason: "", segmentIndex: 0, status: "pending" as const },
          { id: "risk-resolved", level: "high" as const, text: "risk", reason: "", segmentIndex: 0, status: "resolved" as const },
        ],
      },
      counts: {
        redLine: 1,
        highRisk: 2,
        suggestion: 1,
        pendingPackets: 3,
      },
    },
  };
}

describe("home agent project questions", () => {
  it("offers both compliance review modes from the compliance question", () => {
    const question = buildComplianceQuestion(
      createSnapshot({
        derivedStage: COMPLIANCE_REVIEW,
        recommendedActions: ["rerun-plot-review", "rerun-text-review"],
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

  it("shows unresolved compliance counts on the main rerun option after review", () => {
    const question = buildScriptPacketQuestion(
      createSnapshot({
        derivedStage: COMPLIANCE_REVIEW,
        artifacts: [createComplianceArtifact()],
      }),
    );

    expect(findQuestionOption(question, "script:compliance-run:text")?.statusBadges).toEqual([
      { label: "\u7ea2\u7ebf", value: 1, tone: "danger" },
      { label: "\u9ad8\u98ce\u9669", value: 1, tone: "warning" },
      { label: "\u63d0\u793a", value: 1, tone: "notice" },
    ]);
  });

  it("builds episode-stage shortcuts for next episode and review from lightweight snapshots", () => {
    const question = buildEpisodeWorkflowQuestion(
      createSnapshot({
        derivedStage: SCRIPT_WRITING,
        recommendedActions: [
          "\u7ee7\u7eed\u751f\u6210\u7b2c 2 \u96c6",
          "\u505a\u4e00\u8f6e\u5df2\u5b8c\u6210 1 \u96c6\u7684\u6279\u91cf\u8d28\u68c0",
          "\u51c6\u5907\u5408\u89c4\u5ba1\u67e5",
        ],
      }),
    );

    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["script:episode-generate:2", "script:episode-review"]),
    );
    expect(question?.options.some((option) => option.value === "script:step-enter-compliance")).toBe(false);
    expect(question?.options.some((option) => option.value === "script:episode-skip-compliance")).toBe(false);
  });

  it("builds a pre-entry duration gate before episode writing", () => {
    const question = buildEpisodeDurationGateQuestion(
      createSnapshot({
        title: "Duration Gate Project",
        agentSummary: "\u5f3a\u60c5\u7eea\u590d\u4ec7\u77ed\u5267",
        derivedStage: OUTLINE_STAGE,
      }),
    );

    expect(question?.answerKey).toBe("script-episode-duration-gate");
    expect(question?.description).toContain("\u8fdb\u5165\u5206\u96c6\u64b0\u5199");
    expect(question?.options.map((option) => option.value)).toEqual([
      "script:episode-duration-gate:60",
      "script:episode-duration-gate:90",
      "script:episode-duration-gate:120",
      "script:episode-duration-gate:custom",
    ]);
  });

  it("builds export-stage shortcuts for refine, video bridge, and patch planning", () => {
    const question = buildExportWorkflowQuestion(
      createSnapshot({
        derivedStage: EXPORT_STAGE,
        recommendedActions: [
          "\u4fee\u6539\u5bfc\u51fa\u7a3f",
          "\u63a5\u5165\u89c6\u9891\u5de5\u4f5c\u6d41",
          "\u56de\u5934\u8865\u5199\u7f3a\u5931\u7ae0\u8282\u6216\u96c6\u6570",
        ],
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

  it("uses the initial bridge-pref label before any platform prefs are written", () => {
    const question = buildVideoBridgePrefixQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
      createVideoProject(),
    );

    expect(listQuestionValues(question)).toEqual(["video:bridge:platform"]);
    expect(listQuestionLabels(question)).toContain("\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d");
    expect(listQuestionLabels(question)).not.toContain(
      "\u7ee7\u7eed\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d",
    );
  });

  it("uses the continue bridge-pref label once part of the platform prefs are already written", () => {
    const question = buildVideoBridgePrefixQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
      createVideoProject({ targetPlatform: "\u6296\u97f3" }),
    );

    expect(listQuestionValues(question)).toEqual(["video:bridge:platform"]);
    expect(listQuestionLabels(question)).toContain(
      "\u7ee7\u7eed\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d",
    );
  });

  it("hides the dedicated bridge-pref panel once all three fields are written", () => {
    const question = buildVideoBridgePrefixQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
      createVideoProject({
        targetPlatform: "\u6296\u97f3",
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        shotStyle: "\u7535\u5f71\u611f\u8fd1\u666f",
        outputGoal: "\u9884\u544a\u7247",
      }),
    );

    expect(question).toBeNull();
  });

  it("surfaces the retry bridge-pref panel with the continue action", () => {
    const question = buildVideoBridgeRetryQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
    );

    expect(question?.answerKey).toBe("video-bridge-retry");
    expect(question?.options.map((option) => option.value)).toEqual(["video:bridge:platform"]);
    expect(question?.options.map((option) => option.label)).toContain(
      "\u7ee7\u7eed\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d",
    );
  });

  it("keeps next-step options hidden until the script breakdown passes internal checks", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
      createVideoProject({
        scriptBreakdownPassed: false,
        targetPlatform: "\u6296\u97f3",
        shotStyle: "\u7535\u5f71\u611f\u8fd1\u666f",
        outputGoal: "\u9884\u544a\u7247",
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:analyze");
    expect(listQuestionValues(question)).not.toContain("video:bridge:entities");
    expect(question?.description).toContain("\u5185\u90e8\u68c0\u67e5\u4e2d");
  });

  it("shows storyboard xlsx export once script breakdown has passed", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: SCRIPT_BREAKDOWN }),
      createVideoProject({
        scriptBreakdownPassed: true,
        targetPlatform: "\u6296\u97f3",
        shotStyle: "\u7535\u5f71\u611f\u8fd1\u666f",
        outputGoal: "\u9884\u544a\u7247",
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:bridge:export-xlsx");
    expect(findQuestionOption(question, "video:bridge:export-xlsx")?.label).toBe(
      "\u5bfc\u51fa\u5206\u955c xlsx",
    );
  });

  it("hides the direct step switch from role-and-scene to storyboard without minimum materials", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: ROLE_AND_SCENE }),
      createVideoProject({
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", storyboardUrl: "" }] as PersistedVideoProject["scenes"],
      }),
    );

    expect(listQuestionValues(question)).not.toContain("video:step:storyboard");
  });

  it("shows the direct step switch to storyboard once one scene has minimum materials", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: ROLE_AND_SCENE }),
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
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Warehouse", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(listQuestionValues(question)).toContain("video:step:storyboard");
    expect(findQuestionOption(question, "video:step:storyboard")?.label).toBe(
      "切到《生成分镜图》（第 3/5 步）",
    );
    expect(findQuestionOption(question, "video:step:storyboard")?.rationale).toContain("第 3/5 步");
  });

  it("adds storyboard-targeting and step-switch options in the storyboard stage", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: STORYBOARD_STAGE }),
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

    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining([
        "video:bridge:storyboard-frames:ep-group:A",
        "video:bridge:storyboard-frames:group:A",
        "video:bridge:storyboard-frames:segment:A",
        "video:bridge:storyboard-frame:scene:scene-ready",
        "video:bridge:storyboard-frame:scene:scene-blocked",
        "video:step:entities",
      ]),
    );
    expect(listQuestionValues(question)).not.toContain("video:bridge:storyboard-frames:list");
    expect(findQuestionOption(question, "video:bridge:storyboard-frames:segment:A")?.disabled).toBe(false);
    expect(findQuestionOption(question, "video:bridge:storyboard-frames:segment:A")?.label).toContain(
      "\u5168\u90e8\u53ef\u9009\u5206\u955c",
    );
    expect(findQuestionOption(question, "video:bridge:storyboard-frame:scene:scene-blocked")?.disabled).toBe(true);
    expect(findQuestionOption(question, "video:bridge:storyboard-frame:scene:scene-blocked")?.rationale).toContain(
      "\u7f3a\u5931\u5fc5\u8981\u7d20\u6750",
    );
    expect(findQuestionOption(question, "video:bridge:storyboard-frame:scene:scene-blocked")?.rationale).toContain(
      "Villain",
    );
  });

  it("uses the current image-model batch limit for storyboard smart-fill labels", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: STORYBOARD_STAGE }),
      createVideoProject({
        imageGenerationPrefs: {
          familyKey: "gpt-image-2",
          resolution: "4k",
          aspectRatio: "16:9",
          styleCategory: "realistic",
          stylePreset: "live-action",
          viewMode: "three",
        },
        scenes: Array.from({ length: 12 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          characters: ["Hero"],
          storyboardUrl: "",
          description: `scene ${index + 1}`,
        })) as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc", imageUrl: "hero.png" }] as PersistedVideoProject["characters"],
        sceneSettings: Array.from({ length: 12 }, (_, index) => ({
          id: `setting-${index + 1}`,
          name: `Scene ${index + 1}`,
          description: "desc",
          imageUrl: `scene-${index + 1}.png`,
        })) as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(findQuestionOption(question, "video:bridge:storyboard-frames")?.label).toBe(
      "智能补图 剩余12（本轮2）",
    );
    expect(findQuestionOption(question, "video:bridge:storyboard-frames")?.rationale).toContain("2/12 张");
    expect(findQuestionOption(question, "video:bridge:storyboard-frames")?.rationale).toContain(
      "按当前生图模型上限分批补齐",
    );
  });

  it("adds grouped targeted video actions in the generation stage and keeps them on the video step", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_PROMPT_STAGE }),
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
    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining([
        "video:generate:ep-group:A",
        "video:generate:group:A",
        "video:generate:segment:A",
        "video:generate:scene:scene-g1",
      ]),
    );
    expect(listQuestionValues(question)).not.toContain("video:generate:list");
    expect(listQuestionValues(question)).not.toContain("video:refresh:list");
  });

  it("uses segment-first smart batch labels when segment prompts unlock text-to-video generation", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
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

    expect(findQuestionOption(question, "video:generate:segments:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u7247\u6bb5 3/4",
    );
    expect(findQuestionOption(question, "video:generate:first")).toBeNull();
    expect(findQuestionOption(question, "video:step:entities")?.label).toBe(
      "切回《角色和场景》（第 2/4 步）",
    );
  });

  it("caps segment smart batch labels and rationale at 3/12 for larger text-to-video runs", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: Array.from({ length: 12 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          segmentLabel: `1-${index + 1}`,
        })) as PersistedVideoProject["scenes"],
        segmentVideoPrompts: Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => {
            const label = `1-${index + 1}`;
            return [label, createSegmentPrompt(label)];
          }),
        ),
      }),
    );

    expect(findQuestionOption(question, "video:generate:segments:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u7247\u6bb5 3/12",
    );
    expect(findQuestionOption(question, "video:generate:segments:first")?.rationale).toContain("3/12");
    expect(findQuestionOption(question, "video:generate:segments:first")?.rationale).toContain(
      "\u6309\u5f53\u524d\u89c6\u9891\u6279\u6b21\u4e0a\u9650\u5206\u6279\u751f\u6210\uff1b\u672c\u8f6e\u5148\u5904\u7406 3/12 \u4e2a\u7247\u6bb5",
    );
  });

  it("uses shot-first smart batch labels when shot prompts unlock text-to-video generation", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
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

    expect(findQuestionOption(question, "video:generate:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u955c\u5934 3/4",
    );
    expect(findQuestionOption(question, "video:generate:segments:first")).toBeNull();
  });

  it("caps shot smart batch labels and rationale at 3/12 for larger text-to-video runs", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: Array.from({ length: 12 }, (_, index) => ({
          id: `scene-${index + 1}`,
          sceneNumber: index + 1,
          sceneName: `Scene ${index + 1}`,
          segmentLabel: `1-${index + 1}`,
          enhancedVideoPrompt: `shot prompt ${index + 1}`,
        })) as PersistedVideoProject["scenes"],
        videoPromptBatch: "shot prompts ready",
      }),
    );

    expect(findQuestionOption(question, "video:generate:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u955c\u5934 3/12",
    );
    expect(findQuestionOption(question, "video:generate:first")?.rationale).toContain("3/12");
    expect(findQuestionOption(question, "video:generate:first")?.rationale).toContain(
      "\u6309\u5f53\u524d\u89c6\u9891\u6279\u6b21\u4e0a\u9650\u5206\u6279\u751f\u6210\uff1b\u672c\u8f6e\u5148\u5904\u7406 3/12 \u4e2a\u955c\u5934",
    );
  });

  it("shows both smart segment and smart shot actions when both prompt paths are ready", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
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

    expect(findQuestionOption(question, "video:generate:segments:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u7247\u6bb5 3/3",
    );
    expect(findQuestionOption(question, "video:generate:first")?.label).toBe(
      "\u667a\u80fd\u751f\u6210\u955c\u5934 3/3",
    );
  });

  it("promotes the recommended actionable child to the top of a video generation submenu", () => {
    const question = buildVideoGenerationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
            enhancedVideoPrompt: "shot prompt 1",
          },
        ] as PersistedVideoProject["scenes"],
        segmentVideoPrompts: {
          "1-1": createSegmentPrompt("1-1"),
        },
      }),
    );

    const groupOption = findQuestionOption(question, "video:generate:group:1-1");
    expect(groupOption?.children?.[0]?.value).toBe("video:generate:segment-video:1-1");
    expect(groupOption?.children?.[1]?.value).toBe("video:generate:segment:1-1");
  });

  it("offers regenerate, remaining, and batch segment prompt actions for text-to-video gaps", () => {
    const project = createVideoProject({
      currentStep: 2,
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
      targetPlatform: "douyin",
      shotStyle: "cinematic close-up",
      outputGoal: "trailer",
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
      scenes: [
        { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1", characters: [] },
        { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2", characters: [] },
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

    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining([
        "video:bridge:prompts:segment:all",
        "video:bridge:prompts:segment:remaining",
        "video:bridge:prompts:segment:batch",
        "video:panel:bridge:prompts:segment:ep-group:1",
        "video:bridge:prompts:segment:episode:1",
        "video:bridge:prompts:segment:label:1-1",
      ]),
    );
    expect(listQuestionLabels(question)).toEqual(
      expect.arrayContaining([
        "\u91cd\u65b0\u751f\u6210\u5168\u90e8\u7247\u6bb5\uff082\uff09",
        "\u8865\u9f50\u5269\u4f59\u7247\u6bb5\uff081\uff09",
        "\u5206\u6279\u751f\u6210\u7247\u6bb5",
        "\u6309\u96c6\u5206\u6279\u751f\u6210",
        "\u6309\u7247\u6bb5\u5206\u6279\u751f\u6210",
      ]),
    );
    expect(findQuestionOption(question, "video:panel:bridge:prompts:segment:ep-group:1")).toMatchObject({
      label: "第 1 集（待补 1/2）",
      devOnly: true,
    });
    expect(findQuestionOption(question, "video:bridge:prompts:segment:episode:1")).toMatchObject({
      label: "重建第 1 集片段提示词（2）",
      devOnly: true,
    });
    expect(findQuestionOption(question, "video:bridge:prompts:segment:label:1-1")).toMatchObject({
      label: "重生成 片段 1-1",
      devOnly: true,
    });
  });

  it("switches the batch segment prompt label to refresh mode after all text-to-video segment prompts are ready", () => {
    const project = createVideoProject({
      currentStep: 2,
      kickoffModeConfirmed: true,
      kickoffStyleConfirmed: true,
      targetPlatform: "douyin",
      shotStyle: "cinematic close-up",
      outputGoal: "trailer",
      videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [
        { id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1", characters: [] },
        { id: "scene-2", sceneNumber: 2, sceneName: "Scene 2", segmentLabel: "1-2", characters: [] },
      ] as PersistedVideoProject["scenes"],
      characters: [{ id: "char-1", name: "A", description: "desc" }] as PersistedVideoProject["characters"],
      sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc" }] as PersistedVideoProject["sceneSettings"],
      shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      segmentVideoPrompts: {
        "1-1": createSegmentPrompt("1-1"),
        "1-2": createSegmentPrompt("1-2"),
      },
    });
    const snapshot = createProjectVideoSnapshot(project);
    const question = recQuestion(snapshot, project);

    expect(listQuestionValues(question)).toContain("video:bridge:prompts:segment:batch");
    expect(listQuestionLabels(question)).toContain("重新分批生成片段");
    expect(listQuestionLabels(question)).not.toContain("分批生成片段");
    expect(listQuestionLabels(question)).not.toContain("补齐剩余片段（0）");
  });

  it("falls back to the bridge panel in continuation flow when text-to-video still needs prompt preparation", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        currentStep: 4,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        videoGenerationPrefs: { mode: "text-to-video", modelKey: "doubao-seedance-1-5-pro", resolution: "720p" },
        scenes: [{ id: "scene-1", sceneNumber: 1, sceneName: "Scene 1", segmentLabel: "1-1" }] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "A", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Loc", description: "desc", imageUrl: "ok" }] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:prompts");
  });

  it("allows direct numeric custom input on the adaptation episode-count question", () => {
    const question = recQuestion(
      createSnapshot({
        projectKind: "adaptation",
        derivedStage: "\u7ed3\u6784\u8f6c\u8bd1",
        artifacts: [
          {
            id: "setup",
            kind: "setup",
            label: "Project setup",
            summary: "setup",
            updatedAt: "2026-04-02T00:00:00.000Z",
            payload: {
              type: "setup",
              mode: "adaptation",
              targetMarket: "west",
              marketLabel: "West",
              audience: "Audience",
              tone: "Tone",
              ending: "HE",
              totalEpisodes: 80,
              genres: ["Romance"],
              referenceStructure: "reference structure",
              adaptationEpisodeCountConfirmed: false,
              adaptationTargetMarketConfirmed: false,
              adaptationGenresConfirmed: false,
            },
          },
        ],
      }),
      undefined,
    );

    expect(question?.answerKey).toBe("script-adaptation-episode-count");
    expect(question?.allowCustomInput).toBe(true);
    expect(
      findQuestionOption(question, "script:adaptation-total-episodes:custom")?.childInput,
    ).toEqual(
      expect.objectContaining({
        type: "number",
        actionPrefix: "script:adaptation-total-episodes:custom:",
      }),
    );
  });

  it("keeps storyboard xlsx export visible in the preview and export stage", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: PREVIEW_EXPORT_STAGE }),
      createVideoProject({
        currentStep: 5,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "storyboard-1.png",
            videoUrl: "scene-1.mp4",
          },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(question?.answerKey).toBe("review-stage-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:export-xlsx");
    expect(listQuestionValues(question)).not.toContain("video:export:nle-placeholder");
  });

  it("shows missing reference badges against total reference slots in the bridge panel", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: ROLE_AND_SCENE }),
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "lead",
            imageUrl: "ready-character",
            costumes: [{ id: "cost-1", label: "School", description: "uniform" }],
          },
          {
            id: "char-2",
            name: "Partner",
            description: "support",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "scene-1",
            name: "Warehouse",
            description: "night",
            imageUrl: "ready-scene",
            timeVariants: [{ id: "time-1", label: "Rain", description: "storm" }],
          },
          {
            id: "scene-2",
            name: "Rooftop",
            description: "dawn",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.statusBadges).toEqual(
      expect.arrayContaining([{ label: "缺参考图", value: 6, tone: "warning" }]),
    );
  });

  it("summarizes pending, running, and failed video tasks on the board", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        scenes: [
          { id: "scene-p1", sceneNumber: 1, sceneName: "Scene 1" },
          { id: "scene-p2", sceneNumber: 2, sceneName: "Scene 2" },
          { id: "scene-r1", sceneNumber: 3, sceneName: "Scene 3", videoTaskId: "task-1", videoStatus: "processing" },
          { id: "scene-f1", sceneNumber: 4, sceneName: "Scene 4", videoStatus: "failed" },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(board?.items.find((item) => item.id === "video-pending")).toMatchObject({
      label: "\u5f85\u751f\u6210",
      value: 3,
      state: "pending",
    });
    expect(board?.items.find((item) => item.id === "video-running")).toMatchObject({
      label: "\u751f\u6210\u4e2d",
      value: 1,
      state: "attention",
    });
    expect(board?.items.find((item) => item.id === "video-failed")).toMatchObject({
      label: "\u5931\u8d25",
      value: 1,
      state: "attention",
      tone: "danger",
    });
  });

  it("counts missing references against the total reference slots on the board", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: ROLE_AND_SCENE }),
      createVideoProject({
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "lead",
            imageUrl: "ready-character",
            costumes: [{ id: "cost-1", label: "School", description: "uniform" }],
          },
          {
            id: "char-2",
            name: "Partner",
            description: "support",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "scene-1",
            name: "Warehouse",
            description: "night",
            imageUrl: "ready-scene",
            timeVariants: [{ id: "time-1", label: "Rain", description: "storm" }],
          },
          {
            id: "scene-2",
            name: "Rooftop",
            description: "dawn",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(board?.items.find((item) => item.id === "missing-references")).toMatchObject({
      label: "缺参考图",
      value: 6,
      state: "attention",
      tone: "warning",
    });
    expect(board?.items.find((item) => item.id === "missing-references")?.detail).toContain("2/6");
    expect(board?.items.find((item) => item.id === "missing-references")?.detail).toContain("4");
  });

  it("adds a live route hint to the task board header for multi-reference image-to-video projects", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: VIDEO_GENERATION_STAGE }),
      createVideoProject({
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "doubao-seedance-2-0-fast-260128",
          resolution: "720p",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "https://media.storyforge.test/storyboard-1.jpg",
            videoTaskId: "task-1",
            videoStatus: "processing",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "lead",
            imageUrl: "https://media.storyforge.test/hero-1.jpg",
          },
        ] as PersistedVideoProject["characters"],
      }),
    );

    expect(board?.headerHint).toBe("多图参考图生");
  });

  it("stabilizes duplicate option ids so nested bridge pickers never render duplicate keys", () => {
    const optionIds = ensureUniqueOptionIds([
      {
        id: "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant",
        label: "\u6821\u670d",
        value: "video:bridge:reference-assets:character-variant:char-1:dup-variant",
        rationale: "first",
      },
      {
        id: "video-project-1-video-bridge-reference-assets-character-variant-char-1-dup-variant",
        label: "\u6218\u635f",
        value: "video:bridge:reference-assets:character-variant:char-1:dup-variant",
        rationale: "second",
      },
    ]).map((option) => option.id);

    expect(new Set(optionIds).size).toBe(optionIds.length);
    expect(optionIds[0]).not.toBe(optionIds[1]);
  });

  it("builds single-item role and scene asset entries as floating submenus in the bridge panel", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        scriptBreakdownPassed: true,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "lead",
            costumes: [
              {
                id: "costume-1",
                label: "School uniform",
                description: "variant",
              },
            ],
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Warehouse",
            description: "night",
            timeVariants: [
              {
                id: "night-1",
                label: "Night",
                description: "variant",
              },
            ],
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    const characterOption = findQuestionOption(
      question,
      "video:bridge:reference-assets:character:char-1",
    );
    const characterAudioOption = findQuestionOption(
      question,
      "video:bridge:reference-audio:character:char-1",
    );
    const characterPresetAudioOption = findQuestionOption(
      question,
      "video:bridge:reference-audio:preset-picker:character:char-1",
    );
    const sceneOption = findQuestionOption(
      question,
      "video:bridge:reference-assets:scene:setting-1",
    );

    expect(characterOption?.singlePanelPresentation).toBe("floating-submenu");
    expect(characterOption?.menuSection).toBe("single");
    expect(characterOption?.children?.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "video:bridge:reference-assets:character-main:char-1",
        "video:bridge:reference-audio:character:char-1",
        "video:bridge:reference-audio:preset-picker:character:char-1",
        "video:bridge:reference-assets:character-variant:char-1:costume-1",
      ]),
    );
    expect(characterOption?.children?.map((option) => option.menuSection)).toEqual([
      "main-image",
      "audio",
      "audio",
      "variants",
      "variants",
    ]);
    expect(characterAudioOption?.label).toBe("上传Hero音频参考");
    expect(characterAudioOption?.menuSection).toBe("audio");
    expect(characterPresetAudioOption?.label).toBe("使用预设参考音频");
    expect(characterPresetAudioOption?.menuSection).toBe("audio");
    expect(sceneOption?.singlePanelPresentation).toBe("floating-submenu");
    expect(sceneOption?.menuSection).toBe("single");
    expect(sceneOption?.children?.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "video:bridge:reference-assets:scene-main:setting-1",
        "video:bridge:reference-assets:scene-variant:setting-1:night-1",
      ]),
    );
    expect(sceneOption?.children?.map((option) => option.menuSection)).toEqual([
      "main-image",
      "variants",
      "variants",
    ]);
  });
});
