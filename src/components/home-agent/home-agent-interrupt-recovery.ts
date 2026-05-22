import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { hasIncompleteVideoEpisodeCoverage } from "@/lib/home-agent/video-workflow-step-gates";
import {
  buildVideoAnalyzeResumeQuestion,
  buildVideoBridgeRetryQuestion,
} from "./home-agent-project-questions";

type InterruptedWorkflowAction = string | null | undefined;

export function buildVideoAnalyzeInterruptQuestion(
  snapshot: ConversationProjectSnapshot | null | undefined,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  return buildVideoAnalyzeResumeQuestion(snapshot, project, {
    retryMissingEpisodes: hasIncompleteVideoEpisodeCoverage(project),
  });
}

export function resolveInterruptedWorkflowQuestion(params: {
  explicitRestoreQuestion?: ComposerQuestion | null;
  activeWorkflowAction?: InterruptedWorkflowAction;
  snapshot: ConversationProjectSnapshot | null | undefined;
  videoProject: PersistedVideoProject | null | undefined;
}): ComposerQuestion | null {
  if (params.explicitRestoreQuestion) {
    return params.explicitRestoreQuestion;
  }

  if (params.activeWorkflowAction === "video:bridge:platform") {
    return buildVideoBridgeRetryQuestion(params.snapshot);
  }

  if (params.activeWorkflowAction === "analyze_script_for_video") {
    return buildVideoAnalyzeInterruptQuestion(params.snapshot, params.videoProject);
  }

  return null;
}

export function shouldRestoreLastSuggestedAfterInterrupt(
  activeWorkflowAction: InterruptedWorkflowAction,
): boolean {
  return activeWorkflowAction !== "analyze_script_for_video";
}
