import { useMemo } from "react";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import { buildProjectSuggestionKey, qToComposer } from "./home-agent-session-utils";
import { resolveScriptWorkflowStage } from "./home-agent-project-questions";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "@/lib/home-agent/video-models";

function isLegacyVideoBridgePrefixQuestion(question: ComposerQuestion | null): boolean {
  return question?.answerKey === "video-bridge-prefix";
}

// video-bridge-panel question ID encodes the mode: ends with "-t2v" for text-to-video.
// If the stored question was built under a different mode, discard it so it gets rebuilt.
function isVideoBridgePanelCompatibleWithMode(
  question: ComposerQuestion | null,
  videoProject: StudioRuntimeState["currentVideoProject"] | null | undefined,
): boolean {
  if (question?.answerKey !== "video-bridge-panel") return true;
  const currentMode =
    videoProject?.videoGenerationPrefs?.mode ?? DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.mode;
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
    suggested,
    selectedValues,
    dismissedProjectSuggestionKeys,
    dismissedQuestionStepKey,
    devMode,
    buildDevFallbackQuestion,
  } = params;

  const currentProject = runtime.currentProjectSnapshot;
  const visibleQState = (() => {
    const stepKey = qState ? `${qState.request.id}:${qState.currentIndex}` : null;
    return stepKey && stepKey === dismissedQuestionStepKey ? null : qState;
  })();
  const compatiblePopoverOverride = (() => {
    if (isLegacyVideoBridgePrefixQuestion(popoverOverride)) return null;
    if (!isVideoBridgePanelCompatibleWithMode(popoverOverride, runtime.currentVideoProject)) return null;
    const nextQuestion = isScriptPopoverCompatibleWithCurrentStage(
      currentProject as ConversationProjectSnapshot | null,
      popoverOverride,
    )
      ? popoverOverride
      : null;
    if (nextQuestion?.answerKey === "script-adaptation-target-market") {
      return nextQuestion;
    }
    const suggestionKey = buildProjectSuggestionKey(currentProject, nextQuestion);
    return suggestionKey && dismissedProjectSuggestionKeys?.has(suggestionKey) ? null : nextQuestion;
  })();
  const visibleSuggested = (() => {
    if (isLegacyVideoBridgePrefixQuestion(suggested)) return null;
    if (!isVideoBridgePanelCompatibleWithMode(suggested, runtime.currentVideoProject)) return null;
    const suggestionKey = buildProjectSuggestionKey(currentProject, suggested);
    return suggestionKey && dismissedProjectSuggestionKeys?.has(suggestionKey) ? null : suggested;
  })();

  const baseQuestion = useMemo(
    () =>
      qToComposer(visibleQState) ||
      compatiblePopoverOverride ||
      visibleSuggested ||
      (devMode && buildDevFallbackQuestion && currentProject
        ? buildDevFallbackQuestion(currentProject as ConversationProjectSnapshot, runtime)
        : null),
    [compatiblePopoverOverride, visibleQState, visibleSuggested, devMode, buildDevFallbackQuestion, currentProject, runtime],
  );

  const question = useMemo<ComposerQuestion | null>(
    () => {
      if (!baseQuestion || shouldHideQuestionWhileVideoGenerationRuns(baseQuestion, runtime)) {
        return null;
      }

      return {
        ...baseQuestion,
        options: dedupeQuestionOptions(baseQuestion.options).map((option) =>
          applySelectedState(option, selectedValues),
        ),
      };
    },
    [baseQuestion, runtime, selectedValues],
  );

  return {
    currentProject: currentProject as ConversationProjectSnapshot | null,
    question,
  };
}
