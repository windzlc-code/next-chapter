import type { WorkflowRuntimeDelta } from "./types";

export const HOME_AGENT_WORKFLOW_RUNTIME_DELTA_EVENT =
  "home-agent:workflow-runtime-delta";

export interface HomeAgentWorkflowRuntimeDeltaDetail {
  action: string;
  projectId: string;
  summary?: string;
  data: WorkflowRuntimeDelta;
}

export function emitHomeAgentWorkflowRuntimeDelta(
  detail: HomeAgentWorkflowRuntimeDeltaDetail,
): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<HomeAgentWorkflowRuntimeDeltaDetail>(
      HOME_AGENT_WORKFLOW_RUNTIME_DELTA_EVENT,
      { detail },
    ),
  );
}
