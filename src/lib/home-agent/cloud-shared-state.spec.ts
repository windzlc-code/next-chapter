import { describe, expect, it } from "vitest";
import { __mergeHomeAgentSharedStorageForTests } from "./cloud-shared-state";

describe("cloud shared state merge", () => {
  it("preserves remote project sessions when a client pushes a smaller local snapshot", () => {
    const remoteSession = {
      sessionId: "remote-session",
      projectId: "remote-full-auto",
      automationMode: "full-auto",
      messages: [{ id: "m1", role: "assistant", createdAt: "2026-05-22T09:00:00.000Z" }],
      currentProjectSnapshot: {
        projectId: "remote-full-auto",
        title: "Remote Full Auto",
        automationMode: "full-auto",
        updatedAt: "2026-05-22T09:00:00.000Z",
      },
    };
    const localSession = {
      sessionId: "local-session",
      projectId: "local-manual",
      automationMode: "manual",
      messages: [{ id: "m2", role: "assistant", createdAt: "2026-05-22T10:00:00.000Z" }],
      currentProjectSnapshot: {
        projectId: "local-manual",
        title: "Local Manual",
        automationMode: "manual",
        updatedAt: "2026-05-22T10:00:00.000Z",
      },
    };

    const merged = __mergeHomeAgentSharedStorageForTests(
      {
        "storyforge-home-agent-project-sessions-v1": JSON.stringify({
          "local-manual": localSession,
        }),
      },
      {
        "storyforge-home-agent-project-sessions-v1": JSON.stringify({
          "remote-full-auto": remoteSession,
        }),
      },
    );

    const sessions = JSON.parse(merged["storyforge-home-agent-project-sessions-v1"] ?? "{}");
    expect(Object.keys(sessions).sort()).toEqual(["local-manual", "remote-full-auto"]);
    expect(sessions["remote-full-auto"].automationMode).toBe("full-auto");
  });

  it("keeps the richer same-key project session during merge", () => {
    const merged = __mergeHomeAgentSharedStorageForTests(
      {
        "storyforge-home-agent-project-sessions-v1": JSON.stringify({
          shared: {
            sessionId: "shared",
            projectId: "shared",
            automationMode: "manual",
            messages: [{ id: "local", createdAt: "2026-05-22T08:00:00.000Z" }],
          },
        }),
      },
      {
        "storyforge-home-agent-project-sessions-v1": JSON.stringify({
          shared: {
            sessionId: "shared",
            projectId: "shared",
            automationMode: "full-auto",
            messages: [{ id: "remote", createdAt: "2026-05-22T11:00:00.000Z" }],
          },
        }),
      },
    );

    const sessions = JSON.parse(merged["storyforge-home-agent-project-sessions-v1"] ?? "{}");
    expect(sessions.shared.automationMode).toBe("full-auto");
  });
});
