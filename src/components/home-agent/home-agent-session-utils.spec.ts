import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSessionStoreCachesForTests,
  clearStudioSession,
  writeProjectStudioSession,
} from "@/lib/home-agent/session-store";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioSessionState,
} from "@/lib/home-agent/types";
import {
  createAutomationModeProjectMemory,
  buildProjectSuggestionKey,
  createInitialStudioSeed,
  didSessionScopedProjectSwitch,
  filterRecentProjectsForAutomationMode,
  mergeRecentProjects,
  mergeRecentProjectsWithSessionSnapshots,
  reconcileRecentProjectsWithStableOrder,
  rememberProjectForAutomationMode,
  resolveEffectiveProjectAutomationMode,
  resolveComposerDraftSnapshot,
  resolvePendingWorkflowUploadKind,
  resolveSessionProjectIdForSnapshot,
  selectRecentProjectForAutomationMode,
  upsertRecentProjectSession,
} from "./home-agent-session-utils";

beforeEach(() => {
  localStorage.clear();
  __resetSessionStoreCachesForTests();
});

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Session Utils Project",
    currentObjective: "继续完善角色弧光",
    derivedStage: "角色开发",
    agentSummary: "summary",
    recommendedActions: ["进入角色开发"],
    artifacts: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };
}

function createQuestion(
  overrides: Partial<ComposerQuestion> = {},
): ComposerQuestion {
  return {
    id: "script-characters-script-project-1",
    title: "下一步：进入角色开发",
    description: "确认后直接开始角色开发。",
    options: [
      {
        id: "enter-characters",
        label: "进入角色开发",
        value: "进入角色开发",
      },
    ],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-characters",
    ...overrides,
  };
}

describe("buildProjectSuggestionKey", () => {
  it("stays stable when only project timestamps change", () => {
    const question = createQuestion();

    const first = buildProjectSuggestionKey(
      createSnapshot({ updatedAt: "2026-04-08T00:00:00.000Z" }),
      question,
    );
    const second = buildProjectSuggestionKey(
      createSnapshot({ updatedAt: "2026-04-08T00:00:05.000Z" }),
      question,
    );

    expect(first).toBe(second);
  });

  it("changes when the next-step question content changes", () => {
    const snapshot = createSnapshot();

    const first = buildProjectSuggestionKey(snapshot, createQuestion());
    const second = buildProjectSuggestionKey(
      snapshot,
      createQuestion({
        title: "《Session Utils Project》角色设定已完成，下一步生成分集目录？",
        options: [
          {
            id: "generate-directory",
            label: "生成分集目录",
            value: "生成分集目录",
          },
        ],
      }),
    );

    expect(first).not.toBe(second);
  });
});

describe("mergeRecentProjects", () => {
  it("keeps an existing project in place while refreshing its snapshot", () => {
    const first = createSnapshot({
      projectId: "project-1",
      title: "First",
      updatedAt: "2026-04-08T00:00:00.000Z",
    });
    const second = createSnapshot({
      projectId: "project-2",
      title: "Second",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const third = createSnapshot({
      projectId: "project-3",
      title: "Third",
      updatedAt: "2026-04-08T00:02:00.000Z",
    });
    const refreshedSecond = {
      ...second,
      title: "Second refreshed",
      updatedAt: "2026-04-08T00:05:00.000Z",
    };

    const merged = mergeRecentProjects([first, second, third], refreshedSecond);

    expect(merged.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
      "project-3",
    ]);
    expect(merged[1]).toEqual(refreshedSecond);
  });

  it("replaces a stale manual snapshot with the latest full-auto snapshot without changing list order", () => {
    const manualSnapshot = createSnapshot({
      projectId: "project-2",
      title: "Second",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const third = createSnapshot({
      projectId: "project-3",
      title: "Third",
      updatedAt: "2026-04-08T00:02:00.000Z",
    });
    const refreshedFullAutoSnapshot = {
      ...manualSnapshot,
      title: "Second full auto",
      automationMode: "full-auto" as const,
      updatedAt: "2026-04-08T00:05:00.000Z",
    };

    const merged = mergeRecentProjects([createSnapshot({
      projectId: "project-1",
      title: "First",
      updatedAt: "2026-04-08T00:00:00.000Z",
    }), manualSnapshot, third], refreshedFullAutoSnapshot);

    expect(merged.map((project) => project.projectId)).toEqual([
      "project-1",
      "project-2",
      "project-3",
    ]);
    expect(merged[1]).toEqual(refreshedFullAutoSnapshot);
    expect(merged[1].automationMode).toBe("full-auto");
  });

  it("prepends a project that is not already present", () => {
    const first = createSnapshot({ projectId: "project-1", title: "First" });
    const second = createSnapshot({ projectId: "project-2", title: "Second" });
    const newcomer = createSnapshot({ projectId: "project-3", title: "Third" });

    const merged = mergeRecentProjects([first, second], newcomer);

    expect(merged.map((project) => project.projectId)).toEqual([
      "project-3",
      "project-1",
      "project-2",
    ]);
  });
});

describe("createInitialStudioSeed", () => {
  it("falls back to the most recent project session when the active session bootstrap is missing", async () => {
    const recoveredSession = createSession(
      {
        sessionId: "fallback-session-1",
        projectId: "project-fallback-1",
        currentProjectSnapshot: createSnapshot({
          projectId: "project-fallback-1",
          title: "Recovered Project",
        }),
        recentMessageSummary: "Recovered summary",
      },
      [
        {
          id: "user-1",
          role: "user",
          content: "恢复最近项目",
          createdAt: "2026-05-18T00:00:00.000Z",
        },
      ],
    );

    await writeProjectStudioSession(recoveredSession);
    clearStudioSession();
    __resetSessionStoreCachesForTests();

    const seed = createInitialStudioSeed();

    expect(seed.session?.projectId).toBe("project-fallback-1");
    expect(seed.session?.messages).toHaveLength(1);
    expect(seed.runtime.sessionId).toBe("fallback-session-1");
    expect(seed.runtime.currentProjectSnapshot?.projectId).toBe("project-fallback-1");
    expect(seed.needsSessionHydration).toBe(false);
  });
});

describe("reconcileRecentProjectsWithStableOrder", () => {
  it("keeps the previous relative order for surviving cards after a delete-style refresh", () => {
    const bridgeShell = createSnapshot({
      projectId: "bridge-script",
      title: "Bridge Script",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
    const siblingA = createSnapshot({
      projectId: "sibling-a",
      title: "Sibling A",
      updatedAt: "2026-04-06T12:00:00.000Z",
    });
    const siblingB = createSnapshot({
      projectId: "sibling-b",
      title: "Sibling B",
      updatedAt: "2026-04-07T12:00:00.000Z",
    });

    const reconciled = reconcileRecentProjectsWithStableOrder(
      [siblingB, siblingA, bridgeShell],
      [bridgeShell, siblingB],
    );

    expect(reconciled.map((project) => project.projectId)).toEqual([
      "sibling-b",
      "bridge-script",
    ]);
  });

  it("prepends genuinely new projects while preserving the previous order of survivors", () => {
    const bridgeShell = createSnapshot({
      projectId: "bridge-script",
      title: "Bridge Script",
      updatedAt: "2026-04-05T12:00:00.000Z",
    });
    const siblingA = createSnapshot({
      projectId: "sibling-a",
      title: "Sibling A",
      updatedAt: "2026-04-06T12:00:00.000Z",
    });
    const siblingB = createSnapshot({
      projectId: "sibling-b",
      title: "Sibling B",
      updatedAt: "2026-04-07T12:00:00.000Z",
    });
    const hiddenBridgeVideo = createSnapshot({
      projectId: "bridge-video",
      projectKind: "video",
      sourceProjectId: "bridge-script",
      title: "Bridge Video",
      updatedAt: "2026-05-18T09:30:00.000Z",
    });

    const reconciled = reconcileRecentProjectsWithStableOrder(
      [siblingB, siblingA, bridgeShell],
      [bridgeShell, hiddenBridgeVideo, siblingB, siblingA],
    );

    expect(reconciled.map((project) => project.projectId)).toEqual([
      "bridge-video",
      "sibling-b",
      "sibling-a",
      "bridge-script",
    ]);
  });
});

describe("automation-mode project memory", () => {
  it("remembers the latest project independently for manual and full-auto modes", () => {
    const manualSnapshot = createSnapshot({
      projectId: "manual-project-1",
      automationMode: "manual",
    });
    const fullAutoSnapshot = createSnapshot({
      projectId: "full-auto-project-1",
      automationMode: "full-auto",
    });

    const rememberedManual = rememberProjectForAutomationMode(
      createAutomationModeProjectMemory(),
      manualSnapshot,
    );
    const rememberedBoth = rememberProjectForAutomationMode(rememberedManual, fullAutoSnapshot);

    expect(rememberedBoth).toEqual({
      manual: "manual-project-1",
      "full-auto": "full-auto-project-1",
    });
  });

  it("prefers the previously remembered project when switching back into a mode", () => {
    const manualNewest = createSnapshot({
      projectId: "manual-project-2",
      title: "Manual Newest",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:08:00.000Z",
    });
    const fullAutoCurrent = createSnapshot({
      projectId: "full-auto-project-1",
      title: "Full Auto Current",
      automationMode: "full-auto",
      updatedAt: "2026-04-08T00:09:00.000Z",
    });
    const manualRemembered = createSnapshot({
      projectId: "manual-project-1",
      title: "Manual Remembered",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:07:00.000Z",
    });

    const selected = selectRecentProjectForAutomationMode({
      recentProjects: [fullAutoCurrent, manualNewest, manualRemembered],
      mode: "manual",
      preferredProjectId: "manual-project-1",
    });

    expect(selected?.projectId).toBe("manual-project-1");
  });

  it("falls back to the first available project when a mode has no remembered project yet", () => {
    const manualProject = createSnapshot({
      projectId: "manual-project-1",
      automationMode: "manual",
    });
    const fullAutoProject = createSnapshot({
      projectId: "full-auto-project-1",
      automationMode: "full-auto",
    });

    const selected = selectRecentProjectForAutomationMode({
      recentProjects: [fullAutoProject, manualProject],
      mode: "manual",
    });

    expect(selected?.projectId).toBe("manual-project-1");
  });

  it("uses recent project sessions as a fallback when persisted snapshot modes are stale", () => {
    const staleManualSnapshot = createSnapshot({
      projectId: "shared-project",
      title: "Shared Project",
      automationMode: "manual",
    });

    const selected = selectRecentProjectForAutomationMode({
      recentProjects: [staleManualSnapshot],
      recentProjectSessions: [
        createSession({
          projectId: "shared-project",
          automationMode: "full-auto",
          currentProjectSnapshot: {
            ...staleManualSnapshot,
            automationMode: "full-auto",
          },
        }),
      ],
      mode: "full-auto",
    });

    expect(selected?.projectId).toBe("shared-project");
  });
});

describe("mode-filter fallbacks", () => {
  it("resolves a project's effective automation mode from recent project sessions", () => {
    const snapshot = createSnapshot({
      projectId: "shared-project",
      automationMode: "manual",
    });

    const resolved = resolveEffectiveProjectAutomationMode({
      snapshot,
      recentProjectSessions: [
        createSession({
          projectId: "shared-project",
          automationMode: "full-auto",
          currentProjectSnapshot: {
            ...snapshot,
            automationMode: "full-auto",
          },
        }),
      ],
    });

    expect(resolved).toBe("full-auto");
  });

  it("filters recent projects by their effective mode instead of stale snapshot metadata", () => {
    const staleManualSnapshot = createSnapshot({
      projectId: "shared-project",
      title: "Shared Project",
      automationMode: "manual",
    });
    const trueManualSnapshot = createSnapshot({
      projectId: "manual-project",
      title: "True Manual Project",
      automationMode: "manual",
    });

    const filtered = filterRecentProjectsForAutomationMode({
      recentProjects: [staleManualSnapshot, trueManualSnapshot],
      recentProjectSessions: [
        createSession({
          projectId: "shared-project",
          automationMode: "full-auto",
          currentProjectSnapshot: {
            ...staleManualSnapshot,
            automationMode: "full-auto",
          },
        }),
      ],
      mode: "manual",
    });

    expect(filtered.map((project) => project.projectId)).toEqual(["manual-project"]);
  });

  it("uses persisted project sessions when runtime sessions have stale mode data", () => {
    const staleManualSnapshot = createSnapshot({
      projectId: "shared-project",
      title: "Shared Project",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const fullAutoSnapshot = {
      ...staleManualSnapshot,
      automationMode: "full-auto" as const,
      updatedAt: "2026-04-08T00:05:00.000Z",
    };
    localStorage.setItem(
      "storyforge-home-agent-project-sessions-v1",
      JSON.stringify({
        "shared-project": createSession({
          projectId: "shared-project",
          automationMode: "full-auto",
          currentProjectSnapshot: fullAutoSnapshot,
        }),
      }),
    );

    const filtered = filterRecentProjectsForAutomationMode({
      recentProjects: [staleManualSnapshot],
      recentProjectSessions: [
        createSession({
          projectId: "shared-project",
          automationMode: "manual",
          currentProjectSnapshot: staleManualSnapshot,
        }),
      ],
      mode: "full-auto",
    });

    expect(filtered.map((project) => project.projectId)).toEqual(["shared-project"]);
  });

  it("prefers a persisted session mode over a stale current project snapshot", () => {
    const staleCurrentSnapshot = createSnapshot({
      projectId: "shared-project",
      title: "Current Project",
      automationMode: "manual",
    });

    const resolved = resolveEffectiveProjectAutomationMode({
      snapshot: staleCurrentSnapshot,
      currentProjectSnapshot: staleCurrentSnapshot,
      recentProjectSessions: [
        createSession({
          projectId: "shared-project",
          automationMode: "full-auto",
          currentProjectSnapshot: {
            ...staleCurrentSnapshot,
            automationMode: "full-auto",
          },
        }),
      ],
    });

    expect(resolved).toBe("full-auto");
  });

  it("hides a bridged video history card when the source script session already owns it", () => {
    const sourceScriptSnapshot = createSnapshot({
      projectId: "script-project-1",
      projectKind: "script",
      title: "Original Script",
      automationMode: "manual",
    });
    const bridgedVideoSnapshot = createSnapshot({
      projectId: "video-project-1",
      projectKind: "video",
      sourceProjectId: "script-project-1",
      title: "Original Script",
      derivedStage: "Script Breakdown",
      automationMode: "manual",
    });

    const filtered = filterRecentProjectsForAutomationMode({
      recentProjects: [bridgedVideoSnapshot, sourceScriptSnapshot],
      recentProjectSessions: [
        createSession({
          projectId: "script-project-1",
          automationMode: "manual",
          currentProjectSnapshot: bridgedVideoSnapshot,
        }),
      ],
      currentProjectSnapshot: bridgedVideoSnapshot,
      currentSessionProjectId: "script-project-1",
      mode: "manual",
    });

    expect(filtered.map((project) => project.projectId)).toEqual(["script-project-1"]);
  });
});

describe("mergeRecentProjectsWithSessionSnapshots", () => {
  it("keeps full-auto session snapshots visible before persisted recent-project hydration catches up", () => {
    const storedFullAuto = createSnapshot({
      projectId: "project-1",
      title: "Stored Full Auto",
      automationMode: "full-auto",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const staleStoredManual = createSnapshot({
      projectId: "project-2",
      title: "Stale Stored Manual",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:02:00.000Z",
    });
    const liveFullAutoSnapshot = createSnapshot({
      projectId: "project-2",
      title: "Recovered Full Auto",
      automationMode: "full-auto",
      updatedAt: "2026-04-08T00:05:00.000Z",
    });
    const currentSnapshot = createSnapshot({
      projectId: "project-3",
      title: "Current Full Auto",
      automationMode: "full-auto",
      updatedAt: "2026-04-08T00:06:00.000Z",
    });

    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [storedFullAuto, staleStoredManual],
      recentProjectSessions: [
        createSession({
          sessionId: "session-2",
          projectId: "project-2",
          automationMode: "full-auto",
          currentProjectSnapshot: liveFullAutoSnapshot,
        }),
      ],
      currentProjectSnapshot: currentSnapshot,
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "project-3",
      "project-1",
      "project-2",
    ]);
    expect(merged.find((project) => project.projectId === "project-2")?.automationMode).toBe("full-auto");
    expect(merged.find((project) => project.projectId === "project-3")?.title).toBe("Current Full Auto");
  });

  it("keeps the bridged source script card visible without duplicating the linked video card", () => {
    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [
        createSnapshot({
          projectId: "script-project-1",
          projectKind: "script",
          title: "Original Script",
        }),
        createSnapshot({
          projectId: "video-project-1",
          projectKind: "video",
          sourceProjectId: "script-project-1",
          title: "Original Script",
          derivedStage: "脚本拆解",
        }),
      ],
      currentProjectSnapshot: createSnapshot({
        projectId: "video-project-1",
        projectKind: "video",
        sourceProjectId: "script-project-1",
        title: "Original Script",
        derivedStage: "脚本拆解",
      }),
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "script-project-1",
    ]);
  });

  it("projects bridged video metadata back onto the source script history shell", () => {
    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [
        createSnapshot({
          projectId: "script-project-1",
          projectKind: "script",
          title: "Original Script",
          derivedStage: "导出与出片",
          currentObjective: "用于视频创作",
        }),
      ],
      recentProjectSessions: [
        createSession({
          sessionId: "session-bridge-script",
          projectId: "script-project-1",
          automationMode: "manual",
          currentProjectSnapshot: createSnapshot({
            projectId: "video-project-1",
            projectKind: "video",
            sourceProjectId: "script-project-1",
            title: "Original Script",
            derivedStage: "脚本拆解",
            currentObjective: "Continue video workflow",
            agentSummary: "Video workflow now owns the source script shell.",
          }),
        }),
      ],
      currentProjectSnapshot: createSnapshot({
        projectId: "video-project-1",
        projectKind: "video",
        sourceProjectId: "script-project-1",
        title: "Original Script",
        derivedStage: "脚本拆解",
      }),
      currentSessionProjectId: "script-project-1",
    });

    expect(merged.find((project) => project.projectId === "script-project-1")).toMatchObject({
      projectKind: "video",
      derivedStage: "脚本拆解",
    });
  });
  it("does not surface unrelated session-only history shells during later sidebar refreshes", () => {
    const visibleAlpha = createSnapshot({
      projectId: "visible-alpha",
      title: "Visible Alpha",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const visibleBeta = createSnapshot({
      projectId: "visible-beta",
      title: "Visible Beta",
      updatedAt: "2026-04-08T00:02:00.000Z",
    });
    const dormantVideoSnapshot = createSnapshot({
      projectId: "dormant-video",
      projectKind: "video",
      sourceProjectId: "dormant-script-shell",
      title: "Dormant Hidden Video",
      derivedStage: "瑙嗛鐢熸垚",
      updatedAt: "2026-04-08T00:09:00.000Z",
    });

    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [visibleAlpha, visibleBeta],
      recentProjectSessions: [
        createSession({
          sessionId: "session-dormant",
          projectId: "dormant-script-shell",
          automationMode: "manual",
          currentProjectSnapshot: dormantVideoSnapshot,
        }),
      ],
      currentProjectSnapshot: visibleBeta,
      currentSessionProjectId: "visible-beta",
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "visible-alpha",
      "visible-beta",
    ]);
  });

  it("surfaces full-auto session-only history cards so mode switching keeps automation history visible", () => {
    const visibleManual = createSnapshot({
      projectId: "visible-manual",
      title: "Visible Manual",
      automationMode: "manual",
      updatedAt: "2026-04-08T00:01:00.000Z",
    });
    const fullAutoSessionSnapshot = createSnapshot({
      projectId: "full-auto-session-only",
      title: "Full Auto Session Only",
      automationMode: "full-auto",
      updatedAt: "2026-04-08T00:09:00.000Z",
    });

    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [visibleManual],
      recentProjectSessions: [
        createSession({
          sessionId: "session-full-auto-only",
          projectId: "full-auto-session-only",
          automationMode: "full-auto",
          currentProjectSnapshot: fullAutoSessionSnapshot,
        }),
      ],
      currentProjectSnapshot: visibleManual,
      currentSessionProjectId: "visible-manual",
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "full-auto-session-only",
      "visible-manual",
    ]);
    expect(merged.find((project) => project.projectId === "full-auto-session-only")?.automationMode).toBe(
      "full-auto",
    );
  });

  it("does not let stale non-current session previews rewrite archived history card labels", () => {
    const archivedVideo = createSnapshot({
      projectId: "archived-video-1",
      projectKind: "video",
      title: "Archived Video",
      derivedStage: "角色与场景",
      updatedAt: "2026-05-19T15:52:00.000Z",
    });

    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [archivedVideo],
      recentProjectSessions: [
        createSession({
          sessionId: "stale-session-preview",
          projectId: "archived-video-1",
          currentProjectSnapshot: createSnapshot({
            projectId: "archived-video-1",
            projectKind: "script",
            title: "Archived Video",
            derivedStage: "原创立项",
            updatedAt: "2026-05-22T18:59:00.000Z",
          }),
        }),
      ],
      currentProjectSnapshot: createSnapshot({
        projectId: "active-project",
        title: "Active Project",
      }),
      currentSessionProjectId: "active-project",
    });

    expect(merged.find((project) => project.projectId === "archived-video-1")).toMatchObject({
      projectId: "archived-video-1",
      projectKind: "video",
      derivedStage: "角色与场景",
      updatedAt: "2026-05-19T15:52:00.000Z",
    });
  });

  it("keeps a bridged video snapshot projected onto the visible source shell during sidebar switching", () => {
    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [
        createSnapshot({
          projectId: "script-shell-1",
          projectKind: "script",
          title: "Bridge Source",
          derivedStage: "瀵煎嚭涓庡嚭鐗?",
        }),
        createSnapshot({
          projectId: "video-project-1",
          projectKind: "video",
          sourceProjectId: "script-shell-1",
          title: "Bridge Source",
          derivedStage: "鑴氭湰鎷嗚В",
        }),
      ],
      recentProjectSessions: [
        createSession({
          sessionId: "session-bridge-shell",
          projectId: "script-shell-1",
          automationMode: "manual",
          currentProjectSnapshot: createSnapshot({
            projectId: "video-project-1",
            projectKind: "video",
            sourceProjectId: "script-shell-1",
            title: "Bridge Source",
            derivedStage: "瑙嗛鐢熸垚",
          }),
        }),
      ],
      currentProjectSnapshot: createSnapshot({
        projectId: "video-project-1",
        projectKind: "video",
        sourceProjectId: "script-shell-1",
        title: "Bridge Source",
        derivedStage: "瑙嗛鐢熸垚",
      }),
      currentSessionProjectId: "video-project-1",
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "script-shell-1",
    ]);
    expect(merged[0]).toMatchObject({
      projectId: "script-shell-1",
      projectKind: "video",
      derivedStage: "瑙嗛鐢熸垚",
    });
  });

  it("does not surface a stale current snapshot as a new history card while the selected project is switching", () => {
    const merged = mergeRecentProjectsWithSessionSnapshots({
      recentProjects: [
        createSnapshot({
          projectId: "project-a",
          title: "Project A",
          updatedAt: "2026-04-08T00:01:00.000Z",
        }),
        createSnapshot({
          projectId: "project-b",
          title: "Project B",
          updatedAt: "2026-04-08T00:02:00.000Z",
        }),
      ],
      currentProjectSnapshot: createSnapshot({
        projectId: "stale-project",
        title: "Stale Project",
        updatedAt: "2026-04-08T00:03:00.000Z",
      }),
      currentSessionProjectId: "project-b",
    });

    expect(merged.map((project) => project.projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
  });
});

describe("upsertRecentProjectSession", () => {
  it("refreshes a stored session preview when the current project snapshot bridges from script to video", () => {
    const sourceProjectId = "script-project-bridge";
    const previousSession = createSession({
      sessionId: "session-bridge",
      projectId: sourceProjectId,
      automationMode: "manual",
      currentProjectSnapshot: createSnapshot({
        projectId: sourceProjectId,
        projectKind: "script",
        title: "Bridge Script",
        currentObjective: "用于视频创作",
        derivedStage: "导出与出片",
        updatedAt: "2026-05-17T13:40:00.000Z",
      }),
    });
    const bridgedSession = createSession({
      sessionId: "session-bridge",
      projectId: sourceProjectId,
      automationMode: "manual",
      currentProjectSnapshot: createSnapshot({
        projectId: "video-project-bridge",
        projectKind: "video",
        sourceProjectId,
        title: "Bridge Script 视频工作流",
        currentObjective: "继续脚本拆解",
        derivedStage: "脚本拆解",
        updatedAt: "2026-05-17T13:45:00.000Z",
      }),
    });

    const merged = upsertRecentProjectSession([previousSession], bridgedSession);

    expect(merged).toEqual([bridgedSession]);
  });

  it("replaces a stale placeholder session entry when the same session id later points to a real project", () => {
    const placeholderSession = createSession({
      sessionId: "session-full-auto-1",
      projectId: "session-full-auto-1",
      automationMode: "full-auto",
      currentProjectSnapshot: createSnapshot({
        projectId: "session-full-auto-1",
        title: "你好",
        derivedStage: "历史对话",
        currentObjective: "继续当前对话",
        automationMode: "full-auto",
      }),
    });
    const realProjectSession = createSession({
      sessionId: "session-full-auto-1",
      projectId: "script-project-1",
      automationMode: "full-auto",
      currentProjectSnapshot: createSnapshot({
        projectId: "script-project-1",
        title: "未命名剧本项目",
        derivedStage: "创意方案",
        currentObjective: "继续创意方案",
        automationMode: "full-auto",
      }),
    });

    const merged = upsertRecentProjectSession([placeholderSession], realProjectSession);

    expect(merged).toEqual([realProjectSession]);
  });
});

describe("resolveComposerDraftSnapshot", () => {
  it("keeps an explicit empty live draft instead of reviving stale persisted text", () => {
    expect(resolveComposerDraftSnapshot("", "j'x")).toBe("");
  });

  it("returns the live draft when it differs from persisted state", () => {
    expect(resolveComposerDraftSnapshot("new draft", "old draft")).toBe("new draft");
  });

  it("keeps the persisted value when both drafts already match", () => {
    expect(resolveComposerDraftSnapshot("same", "same")).toBe("same");
  });
});

describe("didSessionScopedProjectSwitch", () => {
  it("ignores the first observation but resets session-scoped ui state on any later project change", () => {
    expect(didSessionScopedProjectSwitch(false, undefined, "project-1")).toBe(false);
    expect(didSessionScopedProjectSwitch(true, undefined, "project-1")).toBe(true);
    expect(didSessionScopedProjectSwitch(true, "project-1", "project-1")).toBe(false);
    expect(didSessionScopedProjectSwitch(true, "project-1", "project-2")).toBe(true);
    expect(didSessionScopedProjectSwitch(true, "project-1", undefined)).toBe(true);
  });
});

describe("resolveSessionProjectIdForSnapshot", () => {
  it("keeps the source script session id when a bridged video snapshot is active", () => {
    expect(
      resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: "script-project-bridge",
        snapshot: createSnapshot({
          projectId: "video-project-bridge",
          projectKind: "video",
          sourceProjectId: "script-project-bridge",
        }),
      }),
    ).toBe("script-project-bridge");
  });

  it("falls back to the snapshot project id for ordinary projects", () => {
    expect(
      resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: "script-project-1",
        snapshot: createSnapshot({
          projectId: "video-project-standalone",
          projectKind: "video",
          sourceProjectId: "another-script-project",
        }),
      }),
    ).toBe("video-project-standalone");
  });
});

function createSession(
  overrides: Partial<StudioSessionState> = {},
  messages: HomeAgentMessage[] = [],
): StudioSessionState {
  return {
    mode: "active",
    messages,
    currentProjectSnapshot: null,
    recentMessageSummary: "",
    ...overrides,
  };
}

describe("resolvePendingWorkflowUploadKind", () => {
  it("prefers the explicitly persisted pending upload kind", () => {
    expect(resolvePendingWorkflowUploadKind(createSession({ pendingWorkflowUploadKind: "video" }))).toBe("video");
  });

  it("infers an adaptation upload wait from the latest assistant instruction in legacy sessions", () => {
    expect(
      resolvePendingWorkflowUploadKind(
        createSession(
          {},
          [
            {
              id: "assistant-1",
              role: "assistant",
              content:
                "好的，请通过下方的回形针按钮上传参考剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。我会先写入参考文本，再打开当前步骤原有的选择面板。",
              createdAt: "2026-05-10T11:00:00.000Z",
            },
          ],
        ),
      ),
    ).toBe("adaptation");
  });

  it("infers an adaptation upload wait from a legacy upload panel plus an earlier assistant instruction", () => {
    expect(
      resolvePendingWorkflowUploadKind(
        createSession(
          {
            pendingChoiceQuestion: {
              id: "choice-legacy-upload",
              title: "需要时可以直接从这里上传参考剧本。",
              description: "你可以先继续和 Agent 对话；如果已经准备好参考剧本，也可以随时上传参考文档。",
              answerKey: "continue",
              allowCustomInput: false,
              submissionMode: "immediate",
              multiSelect: false,
              stepIndex: 0,
              totalSteps: 1,
              options: [
                {
                  id: "upload-reference-document",
                  label: "上传参考文档",
                  value: "upload-document",
                },
              ],
            },
          },
          [
            {
              id: "assistant-legacy-upload-instruction",
              role: "assistant",
              content:
                "好的，请通过下方的回形针按钮上传参考剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。我会先写入参考文本，再打开当前步骤原有的选择面板。",
              createdAt: "2026-05-10T11:00:00.000Z",
            },
            {
              id: "assistant-later-message",
              role: "assistant",
              content: "收到，文档已上传。",
              createdAt: "2026-05-10T11:01:00.000Z",
            },
          ],
        ),
      ),
    ).toBe("adaptation");
  });

  it("infers a video upload wait from the latest assistant instruction in legacy sessions", () => {
    expect(
      resolvePendingWorkflowUploadKind(
        createSession(
          {},
          [
            {
              id: "assistant-2",
              role: "assistant",
              content: "好的，请通过下方的回形针按钮上传你的剧本文档（支持 txt、docx、pdf 格式），上传后直接发送即可。",
              createdAt: "2026-05-10T11:00:00.000Z",
            },
          ],
        ),
      ),
    ).toBe("video");
  });
});
