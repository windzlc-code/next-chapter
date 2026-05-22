import { useMemo } from "react";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import { buildProjectSuggestionKey, qToComposer } from "./home-agent-session-utils";
import {
  buildVideoBridgePrefixQuestion,
  buildVideoContinuationQuestion,
  buildVideoGenerationQuestion,
  resolveScriptWorkflowStage,
} from "./home-agent-project-questions";

function resolveVisibleCurrentProject(
  runtime: StudioRuntimeState,
): ConversationProjectSnapshot | null {
  const snapshot = runtime.currentProjectSnapshot as ConversationProjectSnapshot | null;
  if (snapshot) return snapshot;

  const videoProjectId = runtime.currentVideoProject?.id;
  if (!videoProjectId) return null;

  return (
    runtime.recentProjects.find(
      (project) => project.projectKind === "video" && project.projectId === videoProjectId,
    ) ?? null
  );
}

function isLegacyVideoBridgePrefixQuestion(
  question: ComposerQuestion | null,
  runtime: StudioRuntimeState,
): boolean {
  if (question?.answerKey !== "video-bridge-prefix") return false;
  const snapshot = runtime.currentProjectSnapshot as ConversationProjectSnapshot | null;
  if (!snapshot || snapshot.projectKind !== "video") return true;
  const currentQuestion = buildVideoBridgePrefixQuestion(snapshot, runtime.currentVideoProject);
  return currentQuestion?.id !== question.id;
}

// video-bridge-panel question ID encodes the mode: ends with "-t2v" for text-to-video.
// If the stored question was built under a different mode, discard it so it gets rebuilt.
function isVideoBridgePanelCompatibleWithMode(
  question: ComposerQuestion | null,
  videoProject: StudioRuntimeState["currentVideoProject"] | null | undefined,
): boolean {
  if (question?.answerKey !== "video-bridge-panel") return true;
  const currentMode = videoProject?.videoGenerationPrefs?.mode ?? "image-to-video";
  const isT2V = question.id.endsWith("-t2v");
  return currentMode === "text-to-video" ? isT2V : !isT2V;
}

function hasRunningVideoGenerationTasks(
  videoProject: StudioRuntimeState["currentVideoProject"] | null | undefined,
): boolean {
  return Boolean(
    videoProject?.scenes?.some((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return Boolean(scene.videoTaskId) && (status === "queued" || status === "processing");
    }),
  );
}

function shouldHideQuestionWhileVideoGenerationRuns(
  question: ComposerQuestion | null,
  runtime: StudioRuntimeState,
): boolean {
  return (
    question?.answerKey === "video-refresh-panel" &&
    hasRunningVideoGenerationTasks(runtime.currentVideoProject)
  );
}

function shouldHideQuestionWhileFullAutoRuns(
  question: ComposerQuestion | null,
  runtime: StudioRuntimeState,
): boolean {
  if (!question) return false;
  return (
    runtime.fullAutoRun?.status === "running" ||
    runtime.fullAutoRun?.status === "retrying"
  );
}

function countQuestionOptions(options: ComposerQuestionOption[] | undefined): number {
  if (!options?.length) return 0;
  return options.reduce(
    (total, option) => total + 1 + countQuestionOptions(option.children),
    0,
  );
}

function scoreVideoBridgeQuestionValue(value: string | undefined): number {
  if (!value) return 0;
  if (value === "video:analyze" || value === "video:bridge:next-step") return 10;
  if (value === "video:bridge:entities") return 20;
  if (value.startsWith("video:bridge:reference-assets")) return 30;
  if (value === "video:bridge:storyboard" || value === "video:step:storyboard") return 40;
  if (value === "video:bridge:shots") return 50;
  if (value.startsWith("video:bridge:prompts")) return 60;
  if (value === "video:step:render" || value === "video:step:video") return 70;
  return 0;
}

function collectVideoBridgeStageScore(options: ComposerQuestionOption[] | undefined): number {
  if (!options?.length) return 0;
  return options.reduce((best, option) => {
    const optionScore = scoreVideoBridgeQuestionValue(option.value);
    const childScore = collectVideoBridgeStageScore(option.children);
    return Math.max(best, optionScore, childScore);
  }, 0);
}

function inferVideoBridgeQuestionStageScore(question: ComposerQuestion | null): number {
  if (!question || question.answerKey !== "video-bridge-panel") return 0;

  let stageScore = collectVideoBridgeStageScore(question.options);
  const stepIndex =
    typeof question.stepIndex === "number" && Number.isFinite(question.stepIndex)
      ? Math.max(0, question.stepIndex)
      : -1;
  if (stepIndex >= 0) {
    stageScore = Math.max(stageScore, (stepIndex + 1) * 10);
  }

  const labelText = `${question.title ?? ""} ${question.description ?? ""}`.toLowerCase();
  if (labelText.includes("预览") || labelText.includes("导出")) {
    stageScore = Math.max(stageScore, 70);
  } else if (labelText.includes("视频生成") || labelText.includes("出片")) {
    stageScore = Math.max(stageScore, 60);
  } else if (labelText.includes("提示词") || labelText.includes("镜头包")) {
    stageScore = Math.max(stageScore, 50);
  } else if (labelText.includes("分镜")) {
    stageScore = Math.max(stageScore, 40);
  } else if (labelText.includes("角色与场景") || labelText.includes("参考图")) {
    stageScore = Math.max(stageScore, 30);
  } else if (labelText.includes("脚本拆解")) {
    stageScore = Math.max(stageScore, 20);
  }

  return stageScore;
}

function scoreStoredQuestion(question: ComposerQuestion | null): number {
  if (!question) return Number.NEGATIVE_INFINITY;
  if (question.answerKey !== "video-bridge-panel") return 0;

  const stageScore = inferVideoBridgeQuestionStageScore(question);
  const stepScore =
    typeof question.stepIndex === "number" && Number.isFinite(question.stepIndex)
      ? Math.max(0, question.stepIndex + 1)
      : 0;
  const statusBadgeCount = question.statusBadges?.length ?? 0;
  const optionCount = countQuestionOptions(question.options);
  return stageScore * 100 + stepScore * 10 + statusBadgeCount * 5 + optionCount;
}

function preferStoredChoiceQuestion(
  popoverOverride: ComposerQuestion | null,
  interruptedChoiceQuestion: ComposerQuestion | null,
): ComposerQuestion | null {
  if (!popoverOverride) return interruptedChoiceQuestion;
  if (!interruptedChoiceQuestion) return popoverOverride;

  if (
    popoverOverride.answerKey === "video-bridge-panel" &&
    interruptedChoiceQuestion.answerKey === "video-bridge-panel"
  ) {
    const popoverScore = scoreStoredQuestion(popoverOverride);
    const interruptedScore = scoreStoredQuestion(interruptedChoiceQuestion);
    if (interruptedScore > popoverScore) {
      return interruptedChoiceQuestion;
    }
  }

  return popoverOverride;
}

function rebuildDynamicVideoQuestion(
  question: ComposerQuestion | null,
  runtime: StudioRuntimeState,
): ComposerQuestion | null {
  if (!question) return null;
  if (question.preserveExactOnRestore) return question;

  const snapshot = runtime.currentProjectSnapshot as ConversationProjectSnapshot | null;
  if (!snapshot || snapshot.projectKind !== "video") return question;

  if (question.answerKey === "video-bridge-panel") {
    const rebuiltQuestion = buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject);
    if (!rebuiltQuestion) return question;
    return scoreStoredQuestion(question) > scoreStoredQuestion(rebuiltQuestion)
      ? question
      : rebuiltQuestion;
  }

  if (question.answerKey === "video-generation-panel") {
    return buildVideoGenerationQuestion(snapshot, runtime.currentVideoProject);
  }

  if (question.answerKey === "video-refresh-panel") {
    return buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject);
  }

  if (question.answerKey === "review-stage-panel") {
    return buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject);
  }

  return question;
}

export function isQuestionCompatibleWithCurrentRuntime(
  question: ComposerQuestion | null,
  runtime: StudioRuntimeState,
): boolean {
  if (!question) return false;
  if (isLegacyVideoBridgePrefixQuestion(question, runtime)) return false;
  if (!isVideoBridgePanelCompatibleWithMode(question, runtime.currentVideoProject)) return false;
  if (
    !isScriptPopoverCompatibleWithCurrentStage(
      runtime.currentProjectSnapshot as ConversationProjectSnapshot | null,
      question,
    )
  ) {
    return false;
  }
  if (shouldHideQuestionWhileVideoGenerationRuns(question, runtime)) return false;
  if (shouldHideQuestionWhileFullAutoRuns(question, runtime)) return false;
  return true;
}

export function isScriptPopoverCompatibleWithCurrentStage(
  currentProject: ConversationProjectSnapshot | null,
  question: ComposerQuestion | null,
) {
  if (!currentProject || !question) return true;
  if (currentProject.projectKind !== "script" && currentProject.projectKind !== "adaptation") return true;
  if (!question.id.startsWith("script-")) return true;

  const workflowStage = resolveScriptWorkflowStage(currentProject.derivedStage);
  switch (workflowStage) {
    case "setup":
      return (
        question.answerKey === "script-setup" ||
        question.answerKey === "script-setup-v2"
      );
    case "reference-script":
      return (
        question.answerKey === "script-reference-script" ||
        question.answerKey === "script-reference-v2"
      );
    case "creative-plan":
      return question.answerKey === "script-creative-plan";
    case "structure-transform":
      return (
        question.answerKey === "script-structure-transform" ||
        question.answerKey === "script-structure-transform-v2" ||
        question.answerKey === "script-adaptation-episode-count" ||
        question.answerKey === "script-adaptation-target-market" ||
        question.answerKey === "题材选择"
      );
    case "characters":
      return (
        question.answerKey === "script-characters" ||
        question.answerKey === "script-character" ||
        question.answerKey === "script-character-list" ||
        question.answerKey === "script-character-decision"
      );
    case "character-transform":
      return (
        question.answerKey === "script-character-transform" ||
        question.answerKey === "script-character-transform-v2"
      );
    case "directory":
      return question.answerKey === "script-directory";
    case "compliance":
      return (
        question.answerKey === "script-compliance" ||
        question.answerKey === "script-compliance-workspace" ||
        question.answerKey === "script-compliance-list" ||
        question.answerKey === "script-compliance-decision"
      );
    case "outlines":
      return (
        question.answerKey === "script-outlines" ||
        question.answerKey === "script-episode-duration-gate" ||
        question.answerKey === "script-beat" ||
        question.answerKey === "script-beat-list" ||
        question.answerKey === "script-beat-decision"
      );
    case "episodes":
      return question.answerKey === "script-episode";
    case "export":
      return (
        question.answerKey === "script-export" ||
        question.answerKey === "script-export-v2"
      );
    default:
      return false;
  }
}

function dedupeQuestionOptions(options: ComposerQuestionOption[]): ComposerQuestionOption[] {
  const seen = new Set<string>();
  const deduped: ComposerQuestionOption[] = [];

  options.forEach((option) => {
    const key = `${option.value}::${option.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push({
      ...option,
      children: option.children ? dedupeQuestionOptions(option.children) : undefined,
    });
  });

  return deduped;
}

function filterQuestionOptionsByDevMode(
  options: ComposerQuestionOption[],
  devMode: boolean,
): ComposerQuestionOption[] {
  return options.flatMap((option) => {
    if (!devMode && option.devOnly) return [];

    const hasChildren = Array.isArray(option.children);
    const children = hasChildren
      ? filterQuestionOptionsByDevMode(option.children ?? [], devMode)
      : option.children;

    if (!hasChildren) {
      return [{ ...option, children }];
    }

    if (children && children.length > 0) {
      return [{ ...option, children }];
    }

    if (option.value.startsWith("video:panel:")) {
      return [];
    }

    const { children: _children, ...optionWithoutChildren } = option;
    return [optionWithoutChildren];
  });
}

function applySelectedState(
  option: ComposerQuestionOption,
  selectedValues: string[],
): ComposerQuestionOption {
  const children = option.children?.map((child) => applySelectedState(child, selectedValues));
  const childSelected = children?.some((child) => child.selected) ?? false;

  return {
    ...option,
    children,
    selected: option.selected || selectedValues.includes(option.value) || childSelected,
  };
}

export function useHomeAgentQuestionView(params: {
  runtime: StudioRuntimeState;
  qState: StudioQuestionState | null;
  popoverOverride: ComposerQuestion | null;
  interruptedChoiceQuestion?: ComposerQuestion | null;
  suggested: ComposerQuestion | null;
  selectedValues: string[];
  dismissedProjectSuggestionKeys?: Set<string>;
  dismissedQuestionStepKey?: string | null;
  devMode?: boolean;
  buildDevFallbackQuestion?: (
    snapshot: ConversationProjectSnapshot,
    runtime: StudioRuntimeState,
  ) => ComposerQuestion | null;
}) {
  const {
    runtime,
    qState,
    popoverOverride,
    interruptedChoiceQuestion,
    suggested,
    selectedValues,
    dismissedProjectSuggestionKeys,
    dismissedQuestionStepKey,
    devMode,
    buildDevFallbackQuestion,
  } = params;

  const currentProject = resolveVisibleCurrentProject(runtime);
  const visibleQState = (() => {
    const stepKey = qState ? `${qState.request.id}:${qState.currentIndex}` : null;
    return stepKey && stepKey === dismissedQuestionStepKey ? null : qState;
  })();
  const compatiblePopoverOverride = (() => {
    const nextQuestion = isQuestionCompatibleWithCurrentRuntime(popoverOverride, runtime)
      ? popoverOverride
      : null;
    if (nextQuestion?.answerKey === "script-adaptation-target-market") {
      return nextQuestion;
    }
    const suggestionKey = buildProjectSuggestionKey(currentProject, nextQuestion);
    return suggestionKey && dismissedProjectSuggestionKeys?.has(suggestionKey) ? null : nextQuestion;
  })();
  const visibleSuggested = (() => {
    if (!isQuestionCompatibleWithCurrentRuntime(suggested, runtime)) return null;
    const suggestionKey = buildProjectSuggestionKey(currentProject, suggested);
    return suggestionKey && dismissedProjectSuggestionKeys?.has(suggestionKey) ? null : suggested;
  })();
  const compatibleInterruptedChoiceQuestion = (() => {
    const nextQuestion = isQuestionCompatibleWithCurrentRuntime(interruptedChoiceQuestion ?? null, runtime)
      ? (interruptedChoiceQuestion ?? null)
      : null;
    if (nextQuestion?.answerKey === "script-adaptation-target-market") {
      return nextQuestion;
    }
    const suggestionKey = buildProjectSuggestionKey(currentProject, nextQuestion);
    return suggestionKey && dismissedProjectSuggestionKeys?.has(suggestionKey) ? null : nextQuestion;
  })();
  const preferredStoredChoiceQuestion = useMemo(
    () =>
      preferStoredChoiceQuestion(
        compatiblePopoverOverride,
        compatibleInterruptedChoiceQuestion,
      ),
    [compatibleInterruptedChoiceQuestion, compatiblePopoverOverride],
  );

  const baseQuestion = useMemo(
    () =>
      qToComposer(visibleQState) ||
      preferredStoredChoiceQuestion ||
      visibleSuggested ||
      (devMode && buildDevFallbackQuestion && currentProject
        ? buildDevFallbackQuestion(currentProject as ConversationProjectSnapshot, runtime)
        : null),
    [
      visibleQState,
      preferredStoredChoiceQuestion,
      visibleSuggested,
      devMode,
      buildDevFallbackQuestion,
      currentProject,
      runtime,
    ],
  );

  const question = useMemo<ComposerQuestion | null>(
    () => {
      const nextQuestion = rebuildDynamicVideoQuestion(baseQuestion, runtime);
      if (!isQuestionCompatibleWithCurrentRuntime(nextQuestion, runtime)) {
        return null;
      }

      const visibleOptions = filterQuestionOptionsByDevMode(
        dedupeQuestionOptions(nextQuestion.options),
        Boolean(devMode),
      );
      if (!visibleOptions.length) {
        return null;
      }

      return {
        ...nextQuestion,
        options: visibleOptions.map((option) =>
          applySelectedState(option, selectedValues),
        ),
      };
    },
    [baseQuestion, devMode, runtime, selectedValues],
  );

  return {
    currentProject: currentProject as ConversationProjectSnapshot | null,
    question,
  };
}
