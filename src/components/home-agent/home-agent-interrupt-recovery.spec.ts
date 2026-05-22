import { describe, expect, it } from "vitest";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ComposerQuestion } from "@/lib/home-agent/types";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import {
  buildVideoAnalyzeInterruptQuestion,
  resolveInterruptedWorkflowQuestion,
  shouldRestoreLastSuggestedAfterInterrupt,
} from "./home-agent-interrupt-recovery";

function createVideoProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "Interrupt Recovery Project",
    script: "第1集\n场景A\n第2集\n场景B",
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    productionNotes: "",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "Scene 1",
        description: "",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "",
        segmentLabel: "1-1",
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
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    preferredEpisodeDurationSeconds: 90,
    preferredScriptBreakdownPace: "medium",
    scriptBreakdownPassed: false,
    ...overrides,
  } as PersistedVideoProject;
}

describe("home-agent interrupt recovery", () => {
  it("restores continue-script-breakdown by default for interrupted script analysis", () => {
    const project = createVideoProject({
      script: "第1集\n场景A",
      scenes: [],
    });
    const snapshot = createVideoSnapshot(project);

    const question = buildVideoAnalyzeInterruptQuestion(snapshot, project);

    expect(question?.answerKey).toBe("video-analyze-resume");
    expect(question?.options[0]?.value).toBe("video:bridge:analyze:resume:medium:90");
  });

  it("restores continue-missing-episodes when interrupted after partial episode coverage", () => {
    const project = createVideoProject();
    const snapshot = createVideoSnapshot(project);

    const question = buildVideoAnalyzeInterruptQuestion(snapshot, project);

    expect(question?.answerKey).toBe("video-analyze-resume");
    expect(question?.options[0]?.value).toBe("video:bridge:analyze:resume:medium:90:retry-missing");
  });

  it("prefers an explicit restore question over derived workflow fallback", () => {
    const project = createVideoProject();
    const snapshot = createVideoSnapshot(project);
    const explicitRestoreQuestion: ComposerQuestion = {
      id: "explicit-restore",
      title: "继续补拆缺失集",
      options: [
        {
          id: "retry-missing",
          label: "继续补拆缺失集",
          value: "video:bridge:analyze:retry-missing",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-analyze-retry-missing",
    };

    const question = resolveInterruptedWorkflowQuestion({
      explicitRestoreQuestion,
      activeWorkflowAction: "analyze_script_for_video",
      snapshot,
      videoProject: project,
    });

    expect(question).toBe(explicitRestoreQuestion);
  });

  it("does not reuse the next-step suggestion after interrupted script analysis", () => {
    expect(shouldRestoreLastSuggestedAfterInterrupt("analyze_script_for_video")).toBe(false);
    expect(shouldRestoreLastSuggestedAfterInterrupt("video:bridge:platform")).toBe(true);
    expect(shouldRestoreLastSuggestedAfterInterrupt(null)).toBe(true);
  });
});
