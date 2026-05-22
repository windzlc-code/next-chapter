import { describe, expect, it } from "vitest";
import {
  buildVideoBridgeQuestion,
  buildVideoContinuationQuestion,
  buildVideoWorkflowTaskBoard,
} from "./home-agent-project-questions";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";

function createVideoSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "video-project-1",
    projectKind: "video",
    title: "Video Question Project",
    currentObjective: "Advance the video workflow",
    derivedStage: "\u811a\u672c\u62c6\u89e3",
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

function findTaskBoardItem(
  board: ReturnType<typeof buildVideoWorkflowTaskBoard>,
  id: string,
) {
  return board?.items.find((item) => item.id === id) ?? null;
}

describe("buildVideoContinuationQuestion role-and-scene actions", () => {
  /* legacy expectation block retained as comment because the old mojibake copy is unstable to patch safely
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 1,
        characters: [],
        sceneSettings: [],
        scenes: [],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(question?.options.slice(0, 2).map((option) => option.value)).toEqual([
      "video:bridge:entities",
      "video:bridge:analyze",
    ]);
    expect(question?.options.slice(0, 2).map((option) => option.label)).toEqual([
      "提取角色与场景",
      "完成剧本拆解",
    ]);
  });

  */

  it("shows only entity extraction when first entering the video workflow", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 1,
        characters: [],
        sceneSettings: [],
        scenes: [],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(question?.options.map((option) => option.value)).toEqual([
      "video:bridge:entities",
    ]);
    expect(question?.options.map((option) => option.label)).toEqual([
      "提取角色与场景",
    ]);
  });

  it("shows the duration question immediately after entities are extracted", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" }),
      createVideoProject({
        currentStep: 2,
        scriptBreakdownPassed: false,
        scenes: [],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.answerKey).toBe("video-analyze-duration");
    expect(listQuestionValues(question)).toContain("video:bridge:analyze:dur:90");
  });

  it("shows only the final script-breakdown action after both analyze params are confirmed", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" }),
      createVideoProject({
        currentStep: 2,
        scriptBreakdownPassed: false,
        scenes: [],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
          },
        ] as PersistedVideoProject["sceneSettings"],
        preferredEpisodeDurationSeconds: 90,
        preferredScriptBreakdownPace: "medium",
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(question?.options.map((option) => option.value)).toEqual([
      "video:bridge:analyze:execute:medium:90",
    ]);
    expect(question?.options.map((option) => option.label)).toEqual([
      "完成剧本拆解",
    ]);
  });

  it("keeps the first follow-up after script breakdown on the breakdown handoff card", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" }),
      createVideoProject({
        currentStep: 2,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        kickoffModeConfirmed: false,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(question?.title).toContain("\u6b63\u5728\u5b8c\u6210\u811a\u672c\u62c6\u89e3");
    expect(question?.stepIndex).toBe(0);
    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining([
        "video:bridge:analyze",
        "video:bridge:next-step",
        "video:bridge:export-xlsx",
      ]),
    );
    expect(listQuestionValues(question)).not.toContain("video:bridge:entities");
  });

  it("hides entity refresh once step 2 already has extracted role and scene entities", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:entities");
  });

  it("keeps entity extraction available when step 2 has not extracted any entities yet", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [],
        sceneSettings: [],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:bridge:entities");
  });

  it("hides shot-packet refresh after text-to-video shot packets already exist", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:shots");
  });

  it("keeps the step switch to video generation visible once text-to-video shot packets exist", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
            storyboardUrl: "",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            segmentLabel: "1-2",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "segment prompt 1",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).toContain("video:step:video");
  });

  it("hides shot-packet refresh after image-to-video shot packets already exist", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" }),
      createVideoProject({
        currentStep: 3,
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "jimeng-3.0",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "board.png",
          },
        ] as PersistedVideoProject["scenes"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:shots");
  });

  it("hides storyboard batch refresh after image-to-video role-and-scene step already has storyboard text", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "jimeng-3.0",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        storyboardPlan: "scene 1: storyboard batch ready",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [
          {
            id: "char-1",
            name: "Hero",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["characters"],
        sceneSettings: [
          {
            id: "setting-1",
            name: "Location",
            description: "desc",
            imageUrl: "",
          },
        ] as PersistedVideoProject["sceneSettings"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:storyboard");
  });

  it("hides storyboard batch refresh after image-to-video storyboard text already exists", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" }),
      createVideoProject({
        currentStep: 3,
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "jimeng-3.0",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        storyboardPlan: "scene 1: storyboard batch ready",
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "",
          },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(question?.answerKey).toBe("video-bridge-panel");
    expect(listQuestionValues(question)).not.toContain("video:bridge:storyboard");
  });

  it("renames the text-to-video prompt entry to video prompt generation mode", () => {
    const question = buildVideoContinuationQuestion(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        kickoffModeConfirmed: true,
        kickoffStyleConfirmed: true,
        targetPlatform: "douyin",
        shotStyle: "cinematic close-up",
        outputGoal: "trailer",
        scriptBreakdownPassed: true,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Location", description: "desc" }] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(findQuestionOption(question, "video:bridge:prompts")?.label).toBe("视频提示词生成方式");
  });

  it("uses the generation-mode prompt entry for image-to-video storyboard step", () => {
    const question = buildVideoBridgeQuestion(
      createVideoSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" }),
      createVideoProject({
        currentStep: 3,
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "jimeng-3.0",
          resolution: "720p",
        },
        scriptBreakdownPassed: true,
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "board.png",
          },
        ] as PersistedVideoProject["scenes"],
        shotPackets: [{ id: "packet-1" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(findQuestionOption(question, "video:bridge:prompts")?.label).toBe("视频提示词生成方式");
    expect(listQuestionValues(question)).toEqual(
      expect.arrayContaining(["video:bridge:prompts:all", "video:bridge:prompts:batch"]),
    );
    expect(listQuestionLabels(question)).not.toContain("准备视频提示词批次");
  });
  it("shows image-to-video prompt progress on the storyboard-stage task board", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: "\u5206\u955c\u56fe\u751f\u6210" }),
      createVideoProject({
        currentStep: 3,
        videoGenerationPrefs: {
          mode: "image-to-video",
          modelKey: "jimeng-3.0",
          resolution: "720p",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            storyboardUrl: "board-1.png",
            enhancedVideoPrompt: "prompt 1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            storyboardUrl: "board-2.png",
          },
        ] as PersistedVideoProject["scenes"],
        shotPackets: [{ id: "packet-1" }, { id: "packet-2" }] as PersistedVideoProject["shotPackets"],
      }),
    );

    expect(findTaskBoardItem(board, "shot-prompts")).toMatchObject({
      label: "缺镜头提示词",
      value: 1,
      state: "attention",
    });
  });

  it("uses refreshed prompt labels on the text-to-video task board", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: "\u89d2\u8272\u4e0e\u573a\u666f" }),
      createVideoProject({
        currentStep: 2,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
            enhancedVideoPrompt: "prompt 1",
          },
          {
            id: "scene-2",
            sceneNumber: 2,
            sceneName: "Scene 2",
            segmentLabel: "1-2",
          },
        ] as PersistedVideoProject["scenes"],
        characters: [{ id: "char-1", name: "Hero", description: "desc" }] as PersistedVideoProject["characters"],
        sceneSettings: [{ id: "setting-1", name: "Location", description: "desc" }] as PersistedVideoProject["sceneSettings"],
        shotPackets: [{ id: "packet-1" }, { id: "packet-2" }] as PersistedVideoProject["shotPackets"],
        segmentVideoPrompts: {
          "1-1": {
            segmentLabel: "1-1",
            prompt: "segment prompt 1",
            duration: 15,
            targetDuration: 15,
            modelKey: "doubao-seedance-1-5-pro",
            maxDurationForModel: 15,
            sceneIds: ["scene-1"],
            generatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    expect(findTaskBoardItem(board, "segment-prompts")?.label).toBe("缺片段提示词");
    expect(findTaskBoardItem(board, "shot-prompts")?.label).toBe("缺镜头提示词");
  });
  it("aligns the task board stage to the current continuation step when the snapshot stage lags behind", () => {
    const board = buildVideoWorkflowTaskBoard(
      createVideoSnapshot({ derivedStage: "\u811a\u672c\u62c6\u89e3" }),
      createVideoProject({
        currentStep: 2,
        scriptBreakdownPassed: true,
        videoGenerationPrefs: {
          mode: "text-to-video",
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "720p",
        },
        scenes: [
          {
            id: "scene-1",
            sceneNumber: 1,
            sceneName: "Scene 1",
            segmentLabel: "1-1",
          },
        ] as PersistedVideoProject["scenes"],
      }),
    );

    expect(board?.stage).toBe("\u89d2\u8272\u4e0e\u573a\u666f");
    expect(findTaskBoardItem(board, "scene-drafts")).toBeNull();
    expect(findTaskBoardItem(board, "characters")).toMatchObject({
      value: 0,
      state: "pending",
    });
    expect(findTaskBoardItem(board, "scene-settings")).toMatchObject({
      value: 0,
      state: "pending",
    });
  });
});
