import { describe, expect, it } from "vitest";
import type { ConversationProjectSnapshot, StudioRuntimeState } from "./types";
import { mergeRuntimeWithWorkflowDelta } from "./workflow-shortcut-runner";

function createSnapshot(index: number): ConversationProjectSnapshot {
  return {
    projectId: `project-${index}`,
    projectKind: "script",
    title: `Project ${index}`,
    currentObjective: `Objective ${index}`,
    derivedStage: "directory",
    agentSummary: `Summary ${index}`,
    recommendedActions: [`Action ${index}`],
    artifacts: [],
    updatedAt: `2026-04-08T00:${String(index).padStart(2, "0")}:00.000Z`,
  };
}

describe("mergeRuntimeWithWorkflowDelta recentProjects", () => {
  it("does not truncate existing history rows when refreshing an already-listed project", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) => createSnapshot(index + 1));
    const runtime: StudioRuntimeState = {
      sessionId: "session-1",
      suppressHistoricalMemory: true,
      currentProjectSnapshot: snapshots[0],
      currentDramaProject: null,
      currentVideoProject: null,
      currentSetupDraft: null,
      skillDrafts: [],
      maintenanceReports: [],
      recentProjects: snapshots,
      recentProjectSessions: [],
      recentMessageSummary: "",
      fullAutoRun: null,
    };

    const refreshedSnapshot: ConversationProjectSnapshot = {
      ...snapshots[0],
      updatedAt: "2026-04-08T01:00:00.000Z",
      agentSummary: "Refreshed summary",
    };

    const nextRuntime = mergeRuntimeWithWorkflowDelta(runtime, {
      projectSnapshot: refreshedSnapshot,
    });

    expect(nextRuntime.recentProjects).toHaveLength(9);
    expect(nextRuntime.recentProjects.map((item) => item.projectId)).toEqual(snapshots.map((item) => item.projectId));
    expect(nextRuntime.recentProjects[0]).toEqual(refreshedSnapshot);
  });
});
