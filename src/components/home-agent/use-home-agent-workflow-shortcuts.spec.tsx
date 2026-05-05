import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeAgentWorkflowShortcuts } from "./use-home-agent-workflow-shortcuts";
import { buildProjectSuggestionKey } from "./home-agent-session-utils";
import { recQuestion } from "./home-agent-project-questions";
import { createDramaSnapshot, createVideoSnapshot } from "@/lib/home-agent/project-store";
import { DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS } from "@/lib/home-agent/image-models";
import type { ComposerQuestion, StudioRuntimeState } from "@/lib/home-agent/types";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "@/lib/home-agent/video-models";
import { createEmptyDramaProject } from "@/types/drama";
import { launchHomeAgentAutoResearchTasks } from "./home-agent-engine-runtime";

vi.mock("./home-agent-engine-runtime", () => ({
  launchHomeAgentAutoResearchTasks: vi.fn(),
}));

function createRuntime(snapshot = createCharactersSnapshot()): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: snapshot,
    currentDramaProject: null,
    currentVideoProject: null,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: snapshot ? [snapshot] : [],
    recentMessageSummary: "",
  };
}

function createVideoProject(
  overrides: Partial<NonNullable<StudioRuntimeState["currentVideoProject"]>> = {},
): NonNullable<StudioRuntimeState["currentVideoProject"]> {
  return {
    id: "video-project-1",
    title: "Shortcut Video Project",
    script: "script body",
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
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "Scene 2",
        description: "",
        characters: [],
        dialogue: "",
        cameraDirection: "",
        duration: 5,
        storyboardUrl: "",
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
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [],
    reviewQueue: [],
    ...overrides,
  } as NonNullable<StudioRuntimeState["currentVideoProject"]>;
}

function createVideoRuntime(
  videoProject = createVideoProject(),
): StudioRuntimeState {
  return {
    sessionId: "session-1",
    currentProjectSnapshot: createVideoSnapshot(videoProject),
    currentDramaProject: null,
    currentVideoProject: videoProject,
    currentSetupDraft: null,
    skillDrafts: [],
    maintenanceReports: [],
    recentProjects: [createVideoSnapshot(videoProject)],
    recentMessageSummary: "",
  };
}

function createCharactersSnapshot() {
  const base = createEmptyDramaProject("traditional");
  return createDramaSnapshot({
    ...base,
    id: "script-project-1",
    dramaTitle: "Shortcut Test Project",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    currentStep: "characters",
    creativePlan: "ready",
    characters: "",
  });
}

function createDirectorySnapshot() {
  const base = createEmptyDramaProject("traditional");
  return createDramaSnapshot({
    ...base,
    id: "script-project-1",
    dramaTitle: "Shortcut Test Project",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:01:00.000Z",
    currentStep: "directory",
    creativePlan: "ready",
    characters: "lead character ready",
  });
}

function createEpisodeSnapshot(done = false) {
  const base = createEmptyDramaProject("traditional");
  return createDramaSnapshot({
    ...base,
    id: "script-project-1",
    dramaTitle: "Shortcut Test Project",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: done ? "2026-04-08T00:02:00.000Z" : "2026-04-08T00:01:00.000Z",
    currentStep: "episodes",
    creativePlan: "ready",
    characters: "lead character ready",
    setup: {
      ...base.setup,
      genres: ["urban romance"],
      audience: "female",
      tone: "sweet",
      totalEpisodes: 1,
      targetMarket: "cn",
    },
    directory: [
      {
        number: 1,
        title: "Episode 1",
        summary: "summary 1",
        hookType: "hook",
        isKey: false,
        isClimax: false,
        isPaywall: false,
        outline: "outline 1",
      },
    ],
    episodes: done
      ? [{ number: 1, title: "Episode 1", content: "episode body 1", wordCount: 1200 }]
      : [],
  });
}

describe("useHomeAgentWorkflowShortcuts", () => {
  it("clears a dismissed episode follow-up key before auto-opening the workflow popover", async () => {
    const previousSnapshot = createEpisodeSnapshot(false);
    const nextSnapshot = createEpisodeSnapshot(true);
    const nextQuestion = recQuestion(nextSnapshot);
    const suggestionKey = buildProjectSuggestionKey(nextSnapshot, nextQuestion);
    expect(nextQuestion?.answerKey).toBe("script-episode");
    expect(suggestionKey).toBeTruthy();

    const runtimeRef = { current: createRuntime(previousSnapshot) };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const dismissedProjectSuggestionKeysRef = { current: new Set<string>([suggestionKey!]) };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        dismissedProjectSuggestionKeysRef,
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(async () => ({
            summary: "Generated episode scripts.",
            projectSnapshot: nextSnapshot,
            data: { projectSnapshot: nextSnapshot },
          })),
        })),
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_episode_batch",
        { projectId: previousSnapshot.projectId },
        "批量自动撰写",
      );
    });

    await waitFor(() => expect(setPopoverOverride).toHaveBeenCalledWith(nextQuestion));
    expect(dismissedProjectSuggestionKeysRef.current.has(suggestionKey!)).toBe(false);
    expect(surfacedProjectSuggestionKeysRef.current.has(suggestionKey!)).toBe(true);
  });

  it("keeps the bridge platform research in generating state until the grouped work is finalized", async () => {
    vi.mocked(launchHomeAgentAutoResearchTasks).mockResolvedValueOnce({
      taskIds: ["task-bridge-1", "task-bridge-2"],
    });

    const runtimeRef = { current: createVideoRuntime() };
    const backgroundResearchGroupsRef = { current: [] as import("./home-agent-task-utils").BackgroundResearchGroup[] };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(),
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      await result.current.runBackgroundVideoBridgeResearch("补齐目标平台", "targetPlatform");
    });

    expect(push).toHaveBeenCalledWith("user", "补齐目标平台");
    expect(setActiveWorkflowAction).toHaveBeenCalledWith("video:bridge:prefix:target-platform");
    expect(setStreaming).toHaveBeenCalledWith(true);
    expect(setActiveWorkflowAction).not.toHaveBeenCalledWith(null);
    expect(backgroundResearchGroupsRef.current).toHaveLength(1);
    expect(vi.mocked(launchHomeAgentAutoResearchTasks)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("补齐平台偏好"),
        planOverride: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              title: "平台偏好",
            }),
          ],
        }),
      }),
    );

    act(() => {
      backgroundResearchGroupsRef.current[0]?.onFinish?.("completed");
    });

    expect(setActiveWorkflowAction).toHaveBeenLastCalledWith(null);
    expect(setStreaming).toHaveBeenLastCalledWith(false);
  });

  it("launches a richer three-part plan for one-click bridge completion", async () => {
    vi.mocked(launchHomeAgentAutoResearchTasks).mockResolvedValueOnce({
      taskIds: ["task-bridge-1", "task-bridge-2", "task-bridge-3"],
    });

    const runtimeRef = { current: createRuntime() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(),
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      await result.current.runBackgroundVideoBridgeResearch("补充平台和镜头偏好", "all");
    });

    expect(vi.mocked(launchHomeAgentAutoResearchTasks)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("补齐平台偏好、镜头风格和出片目标"),
        planOverride: expect.objectContaining({
          tasks: expect.arrayContaining([
            expect.objectContaining({
              title: "平台偏好",
              prompt: expect.stringContaining("目标受众"),
            }),
            expect.objectContaining({
              title: "镜头风格",
              prompt: expect.stringContaining("需要避开"),
            }),
            expect.objectContaining({
              title: "出片目标",
              prompt: expect.stringContaining("后续分镜阶段应围绕什么来推进"),
            }),
          ]),
        }),
      }),
    );
  });

  it("surfaces a retry bridge panel when one-click bridge completion fails to launch", async () => {
    vi.mocked(launchHomeAgentAutoResearchTasks).mockResolvedValueOnce({
      taskIds: [],
    });

    const runtimeRef = { current: createVideoRuntime() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(),
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      await result.current.runBackgroundVideoBridgeResearch("补充平台和镜头偏好", "all");
    });

    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-retry",
      }),
    );
  });

  it("surfaces a retry bridge panel when one-click bridge completion throws", async () => {
    vi.mocked(launchHomeAgentAutoResearchTasks).mockRejectedValueOnce(new Error("boom"));

    const runtimeRef = { current: createVideoRuntime() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(),
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      await result.current.runBackgroundVideoBridgeResearch("补充平台和镜头偏好", "all");
    });

    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-retry",
      }),
    );
  });

  it("marks single-field bridge research as cancelled when globally interrupted", async () => {
    vi.mocked(launchHomeAgentAutoResearchTasks).mockResolvedValueOnce({
      taskIds: ["task-bridge-1"],
    });

    const runtimeRef = { current: createRuntime() };
    const backgroundResearchGroupsRef = { current: [] as import("./home-agent-task-utils").BackgroundResearchGroup[] };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        backgroundResearchGroupsRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(),
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        selectedTextModelKey: "default",
      }),
    );

    await act(async () => {
      await result.current.runBackgroundVideoBridgeResearch("补齐目标平台", "targetPlatform");
    });

    act(() => {
      result.current.interruptWorkflowShortcut();
    });

    expect(backgroundResearchGroupsRef.current[0]?.status).toBe("cancelled");
    expect(setActiveWorkflowAction).toHaveBeenLastCalledWith(null);
    expect(setStreaming).toHaveBeenLastCalledWith(false);
  });

  it("hands post-workflow continuation back to the LLM in normal mode", async () => {
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "Character design generated",
        data: {},
      })),
    }));

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
        send,
        creationMode: "creative",
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: "script-project-1" },
        "Enter character design",
      );
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.stringContaining("Completed action: generate_characters"),
        undefined,
        { skipUserBubble: true },
      );
    });
  });

  it("re-opens the video popover after a non-media workflow option completes", async () => {
    const nextVideoProject = createVideoProject({
      characters: [
        {
          id: "char-1",
          name: "Hero",
          description: "lead",
          imageUrl: "",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      sceneSettings: [
        {
          id: "setting-1",
          name: "Warehouse",
          description: "night warehouse",
          imageUrl: "",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      currentStep: 2,
      analysisSummary: "已整理角色和场景。",
    });
    const nextSnapshot = createVideoSnapshot(nextVideoProject);
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "已从脚本中提取 1 个角色与 1 个场景设定。",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: nextVideoProject,
          projectSnapshot: nextSnapshot,
        },
      })),
    }));

    const runtimeRef = { current: createVideoRuntime(createVideoProject()) };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "extract_video_entities",
        { projectId: "video-project-1" },
        "继续提取角色与场景",
      );
    });

    await waitFor(() => {
      const reopenedPopover = setPopoverOverride.mock.calls
        .map(([question]) => question)
        .find((question) => question && question.id !== null);
      expect(reopenedPopover).toBeTruthy();
      expect(JSON.stringify(reopenedPopover)).toContain("video:bridge:reference-assets");
      expect(setSuggested).toHaveBeenLastCalledWith(null);
    });
  });

  it("re-opens the next video panel after preparing a storyboard text batch", async () => {
    const nextVideoProject = createVideoProject({
      characters: [
        {
          id: "char-1",
          name: "Hero",
          description: "lead",
          imageUrl: "https://example.com/hero.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      sceneSettings: [
        {
          id: "setting-1",
          name: "Warehouse",
          description: "night warehouse",
          imageUrl: "https://example.com/warehouse.jpg",
          isAIGenerated: false,
          source: "auto",
        },
      ],
      currentStep: 3,
      storyboardPlan: "闀滃ご 1\n鏍囬锛歋cene 1",
      analysisSummary: "已整理分镜文本批次。",
    });
    const nextSnapshot = createVideoSnapshot(nextVideoProject);
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "已整理镜头 1-2 的分镜批次说明。",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: nextVideoProject,
          projectSnapshot: nextSnapshot,
        },
      })),
    }));

    const runtimeRef = { current: createVideoRuntime(createVideoProject({
      characters: nextVideoProject.characters,
      sceneSettings: nextVideoProject.sceneSettings,
      currentStep: 2,
    })) };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "prepare_storyboard_batch",
        { projectId: "video-project-1" },
        "鍑嗗鍒嗛暅鏂囨湰鎵规",
      );
    });

    await waitFor(() => {
      const reopenedPopover = setPopoverOverride.mock.calls
        .map(([question]) => question)
        .find((question) => question && question.id !== null);
      expect(reopenedPopover).toBeTruthy();
      expect(JSON.stringify(reopenedPopover)).toContain("video:bridge:storyboard-frames");
      expect(setSuggested).toHaveBeenLastCalledWith(null);
    });
  });

  it("dismisses and remembers the current script suggestion before loading workflow actions", async () => {
    let resolveWorkflowModule:
      | ((value: {
          runWorkflowAction: (
            action: string,
            input: Record<string, unknown>,
            runtime: StudioRuntimeState,
          ) => Promise<{ summary: string; projectSnapshot?: unknown; data?: unknown }>;
        }) => void)
      | null = null;

    const loadWorkflowActionsModule = vi.fn(
      () =>
        new Promise<{
          runWorkflowAction: (
            action: string,
            input: Record<string, unknown>,
            runtime: StudioRuntimeState,
          ) => Promise<{ summary: string; projectSnapshot?: unknown; data?: unknown }>;
        }>((resolve) => {
          resolveWorkflowModule = resolve;
        }),
    );

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
      }),
    );

    const activeSuggestion = recQuestion(
      runtimeRef.current.currentProjectSnapshot,
      runtimeRef.current.currentVideoProject,
    );
    const suggestionKey = buildProjectSuggestionKey(runtimeRef.current.currentProjectSnapshot, activeSuggestion);

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: "script-project-1" },
        "Enter character design",
      );
      await Promise.resolve();
    });

    expect(setPopoverOverride).toHaveBeenCalledWith(null);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setStreaming).toHaveBeenCalledWith(true);
    expect(setActiveWorkflowAction).toHaveBeenCalledWith("generate_characters");
    expect(suggestionKey).toBeTruthy();
    expect(surfacedProjectSuggestionKeysRef.current.has(suggestionKey!)).toBe(true);

    resolveWorkflowModule?.({
      runWorkflowAction: vi.fn(async () => {
        const nextSnapshot = createDirectorySnapshot();
        return {
          summary: "Character design generated",
          projectSnapshot: nextSnapshot,
          data: {
            projectSnapshot: nextSnapshot,
          },
        };
      }),
    });

    await waitFor(() => {
      expect(setActiveWorkflowAction).toHaveBeenLastCalledWith(null);
      expect(setStreaming).toHaveBeenLastCalledWith(false);
    });
  });

  it("shows a feedback message when a shortcut is clicked again during an in-flight workflow", async () => {
    let resolveWorkflowAction:
      | ((value: {
          summary: string;
          projectSnapshot: ReturnType<typeof createDirectorySnapshot>;
          data: { projectSnapshot: ReturnType<typeof createDirectorySnapshot> };
        }) => void)
      | null = null;

    const runWorkflowAction = vi.fn(
      () =>
        new Promise<{
          summary: string;
          projectSnapshot: ReturnType<typeof createDirectorySnapshot>;
          data: { projectSnapshot: ReturnType<typeof createDirectorySnapshot> };
        }>((resolve) => {
          resolveWorkflowAction = resolve;
        }),
    );

    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction,
    }));

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: "script-project-1" },
        "Enter character design",
      );
      result.current.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: "script-project-1" },
        "Enter character design",
      );
      await Promise.resolve();
    });

    expect(loadWorkflowActionsModule).toHaveBeenCalledTimes(1);
    expect(runWorkflowAction).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("assistant", "当前已有步骤在执行，请等待当前流程完成后再继续。");

    resolveWorkflowAction?.({
      summary: "Character design generated",
      projectSnapshot: createDirectorySnapshot(),
      data: {
        projectSnapshot: createDirectorySnapshot(),
      },
    });

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("user", "Enter character design");
      expect(push).toHaveBeenCalledWith(
        "assistant",
        "Character design generated",
        expect.any(Array),
        undefined,
        expect.any(Array),
      );
    });
  });

  it("restores the configured question when an in-flight workflow is interrupted", async () => {
    const restoreQuestion: ComposerQuestion = {
      id: "video-analyze-pace-video-project-1",
      title: "请选择视频节奏",
      description: "先重新确认节奏再决定是否继续拆解。",
      options: [
        { id: "pace-medium", label: "中等", value: "video:bridge:analyze:pace:medium:90" },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 1,
      totalSteps: 2,
      answerKey: "video-analyze-pace",
    };

    let resolveWorkflowAction:
      | ((value: {
          summary: string;
          data: Record<string, never>;
        }) => void)
      | null = null;

    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(
        () =>
          new Promise<{
            summary: string;
            data: Record<string, never>;
          }>((resolve) => {
            resolveWorkflowAction = resolve;
          }),
      ),
    }));

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "analyze_script_for_video",
        { projectId: "video-project-1", videoPace: "medium", episodeDuration: 90 },
        "瀹屾垚鍓ф湰鎷嗚В",
        { restoreQuestionOnInterrupt: restoreQuestion },
      );
      await Promise.resolve();
    });

    act(() => {
      result.current.interruptWorkflowShortcut();
    });

    expect(setMode).toHaveBeenCalledWith("active");
    expect(setPopoverOverride).toHaveBeenLastCalledWith(restoreQuestion);
    expect(setSuggested).toHaveBeenLastCalledWith(null);
    expect(resetComposerDraft).toHaveBeenLastCalledWith("");

    resolveWorkflowAction?.({
      summary: "stopped",
      data: {},
    });

    await waitFor(() => {
      expect(setActiveWorkflowAction).toHaveBeenLastCalledWith(null);
    });
  });

  it("re-opens the configured question when a workflow shortcut times out", async () => {
    const restoreQuestion: ComposerQuestion = {
      id: "script-characters-script-project-1",
      title: "继续角色开发",
      options: [{ id: "enter-characters", label: "进入角色开发", value: "进入角色开发" }],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-characters",
    };
    const restoreInterruptedChoiceQuestion = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createRuntime() },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(async () => {
            throw new Error("请求超时（60 秒），请检查网络后重试");
          }),
        })),
        push: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSuggested: vi.fn(),
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
        restoreInterruptedChoiceQuestion,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_characters",
        { projectId: "script-project-1" },
        "进入角色开发",
        { restoreQuestionOnInterrupt: restoreQuestion },
      );
    });

    await waitFor(() => {
      expect(restoreInterruptedChoiceQuestion).toHaveBeenCalledWith(restoreQuestion);
    });
  });

  it("re-opens the configured question when a workflow shortcut chain times out", async () => {
    const restoreQuestion: ComposerQuestion = {
      id: "video-review-video-project-1",
      title: "Continue video review",
      options: [
        {
          id: "retry-video-review",
          label: "Continue video review",
          value: "Continue video review",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-review",
    };
    const restoreInterruptedChoiceQuestion = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createRuntime() },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(async () => {
            throw new Error("request timed out after 60 seconds");
          }),
        })),
        push: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSuggested: vi.fn(),
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
        restoreInterruptedChoiceQuestion,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcutChain(
        [
          {
            action: "redo_video_assets",
            input: { projectId: "video-project-1", targetIds: ["scene-1"] },
          },
          {
            action: "generate_video_assets",
            input: { projectId: "video-project-1", targetIds: ["scene-1"], forceRegenerate: true },
          },
        ],
        "Continue video review",
        { restoreQuestionOnInterrupt: restoreQuestion },
      );
    });

    await waitFor(() => {
      expect(restoreInterruptedChoiceQuestion).toHaveBeenCalledWith(restoreQuestion);
    });
  });

  it("re-opens the configured question when a workflow shortcut chain is interrupted", async () => {
    const restoreQuestion: ComposerQuestion = {
      id: "video-review-video-project-1",
      title: "Continue video review",
      options: [
        {
          id: "retry-video-review",
          label: "Continue video review",
          value: "Continue video review",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-review",
    };
    let resolveWorkflowAction:
      | ((value: {
          summary: string;
          data: Record<string, never>;
        }) => void)
      | null = null;
    const restoreInterruptedChoiceQuestion = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createRuntime() },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(
            () =>
              new Promise((resolve) => {
                resolveWorkflowAction = resolve;
              }),
          ),
        })),
        push: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSuggested: vi.fn(),
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
        restoreInterruptedChoiceQuestion,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcutChain(
        [
          {
            action: "redo_video_assets",
            input: { projectId: "video-project-1", targetIds: ["scene-1"] },
          },
        ],
        "Continue video review",
        { restoreQuestionOnInterrupt: restoreQuestion },
      );
      await Promise.resolve();
    });

    act(() => {
      result.current.interruptWorkflowShortcut();
    });

    expect(restoreInterruptedChoiceQuestion).toHaveBeenCalledWith(restoreQuestion);

resolveWorkflowAction?.({
      summary: "stopped",
      data: {},
    });
  });

  it("re-opens the configured question when video asset export is cancelled", async () => {
    const restoreQuestion: ComposerQuestion = {
      id: "review-stage-panel-video-project-1",
      title: "预览与导出阶段",
      options: [
        {
          id: "export-all",
          label: "全部导出",
          value: "video:export:all",
        },
      ],
      allowCustomInput: false,
      submissionMode: "immediate",
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "review-stage-panel",
    };
    const restoreInterruptedChoiceQuestion = vi.fn(() => true);
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createVideoRuntime() },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction: vi.fn(async () => ({
            summary: "已取消导出。",
            data: {},
          })),
        })),
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
        restoreInterruptedChoiceQuestion,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "export_video_asset_bundle",
        { projectId: "video-project-1" },
        "全部导出",
        { restoreQuestionOnCancel: restoreQuestion },
      );
    });

    await waitFor(() => {
      expect(restoreInterruptedChoiceQuestion).toHaveBeenCalledWith(restoreQuestion);
    });
    expect(setPopoverOverride).not.toHaveBeenCalledWith(restoreQuestion);
  });

  it("re-dispatches media start and completion events so the chat can render previews and placeholders", async () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "Generated assets",
        data: {},
        imageUrls: ["https://example.com/generated-frame.jpg"],
        videoUrls: ["https://example.com/generated-video.mp4"],
      })),
    }));

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        setActiveWorkflowAction,
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_storyboard_frames",
        { projectId: "video-project-1", targetIds: ["scene-1"] },
        "生成分镜图",
      );
    });

    await waitFor(() => {
      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:image-generating-start",
        }),
      );
      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:image-generated",
        }),
      );
      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:video-generated",
        }),
      );
      expect(push).not.toHaveBeenCalledWith(
        "assistant",
        expect.stringContaining("内容 分镜 分镜图"),
      );
    });

    dispatchEventSpy.mockRestore();
  });

  it("dispatches the video start event before shortcut-based video generation", async () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "Generated videos",
        data: {},
        videoUrls: ["https://example.com/generated-video.mp4"],
      })),
    }));

    const runtimeRef = { current: createVideoRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSuggested: vi.fn(),
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: "video-project-1", targetIds: ["scene-1", "scene-2"] },
        "鐢熸垚瑙嗛",
      );
    });

    await waitFor(() => {
      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:video-generating-start",
        }),
      );
      expect(dispatchEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:video-generated",
        }),
      );
    });

    const videoStartEvent = dispatchEventSpy.mock.calls
      .map(([event]) => event)
      .find((event) => event?.type === "agent:video-generating-start") as CustomEvent | undefined;
    expect(videoStartEvent?.detail?.contentSummary).toContain("镜头 1 · Scene 1");

    dispatchEventSpy.mockRestore();
  });

  it("does not re-open the next video panel while shortcut-based video generation is still running", async () => {
    const processingVideoProject = createVideoProject({
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
          storyboardUrl: "https://example.com/storyboard-1.jpg",
          videoTaskId: "task-1",
          videoStatus: "processing",
        },
      ],
      currentStep: 4,
      analysisSummary: "Videos are still rendering.",
    });
    const nextSnapshot = createVideoSnapshot(processingVideoProject);
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "Video generation in progress",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: processingVideoProject,
          projectSnapshot: nextSnapshot,
        },
        videoUrls: ["https://example.com/generated-video.mp4"],
      })),
    }));

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createVideoRuntime(processingVideoProject) },
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_video_assets",
        { projectId: "video-project-1", targetIds: ["scene-1"] },
        "继续生成视频",
      );
    });

    await waitFor(() => {
      expect(loadWorkflowActionsModule).toHaveBeenCalled();
    });

    const reopenedPopover = setPopoverOverride.mock.calls
      .map(([question]) => question)
      .find((question) => question && question.id !== null);
    expect(reopenedPopover).toBeUndefined();
    expect(setSuggested).not.toHaveBeenCalledWith(expect.objectContaining({ answerKey: expect.any(String) }));
  });

  it("restores a dismissed text-to-video bridge panel when switching back to role and scene step", async () => {
    const nextVideoProject = createVideoProject({
      currentStep: 2,
      videoGenerationPrefs: {
        ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        mode: "text-to-video",
      },
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
          segmentLabel: "1-1",
          enhancedVideoPrompt: "prompt one",
          storyboardUrl: "",
        },
        {
          id: "scene-2",
          sceneNumber: 2,
          sceneName: "Scene 2",
          description: "",
          characters: [],
          dialogue: "",
          cameraDirection: "",
          duration: 5,
          segmentLabel: "1-1",
          enhancedVideoPrompt: "prompt two",
          storyboardUrl: "",
        },
      ],
      characters: [{ id: "char-1", name: "Hero", description: "lead", isAIGenerated: false, source: "auto" }],
      sceneSettings: [{ id: "setting-1", name: "Warehouse", description: "night", isAIGenerated: false, source: "auto" }],
      shotPackets: [{ id: "packet-1" }] as NonNullable<StudioRuntimeState["currentVideoProject"]>["shotPackets"],
      videoPromptBatch: "batch ready",
    });
    const nextSnapshot = createVideoSnapshot(nextVideoProject);
    const restoredQuestion = recQuestion(nextSnapshot, nextVideoProject);
    const dismissedKey = buildProjectSuggestionKey(nextSnapshot, restoredQuestion);
    const dismissedProjectSuggestionKeysRef = { current: new Set<string>(dismissedKey ? [dismissedKey] : []) };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction: vi.fn(async () => ({
        summary: "已将《Shortcut Video Project》定位到「角色与场景」阶段。",
        projectSnapshot: nextSnapshot,
        data: {
          videoProject: nextVideoProject,
          projectSnapshot: nextSnapshot,
        },
      })),
    }));

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef: { current: createVideoRuntime({ ...nextVideoProject, currentStep: 4 }) },
        surfacedProjectSuggestionKeysRef,
        dismissedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride,
        setSuggested,
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
      }),
    );

    act(() => {
      result.current.switchVideoStep("video-project-1", 2, "切回《角色和场景》");
    });

    await waitFor(() => {
      expect(setPopoverOverride).toHaveBeenCalledWith(
        expect.objectContaining({ answerKey: "video-bridge-panel" }),
      );
    });
    expect(dismissedKey ? dismissedProjectSuggestionKeysRef.current.has(dismissedKey) : false).toBe(false);
    expect(dismissedKey ? surfacedProjectSuggestionKeysRef.current.has(dismissedKey) : false).toBe(true);
    expect(setSuggested).toHaveBeenLastCalledWith(null);
  });

  it("decorates workflow shortcut input with aligned image and video generation prefs", async () => {
    const runWorkflowAction = vi.fn(async () => ({
      summary: "Reference assets generated",
      data: {},
    }));
    const loadWorkflowActionsModule = vi.fn(async () => ({
      runWorkflowAction,
    }));

    const runtimeRef = { current: createRuntime() };
    const surfacedProjectSuggestionKeysRef = { current: new Set<string>() };
    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef,
        loadWorkflowActionsModule,
        push: vi.fn(),
        setPopoverOverride: vi.fn(),
        setSuggested: vi.fn(),
        setMode: vi.fn(),
        resetComposerDraft: vi.fn(),
        setStreaming: vi.fn(),
        setRuntime: vi.fn(),
        setActiveProjectId: vi.fn(),
        setActiveWorkflowAction: vi.fn(),
        selectedImageModelFamily: "nano-banana-2",
        imageGenerationPrefs: {
          ...DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
          familyKey: "nano-banana-pro",
          resolution: "4k",
          aspectRatio: "9:16",
        },
        selectedVideoModelKey: "doubao-seedance-1-5-pro",
        videoGenerationPrefs: {
          ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
          modelKey: "doubao-seedance-1-5-pro",
          resolution: "1080p",
          mode: "image-to-video",
        },
      }),
    );

    await act(async () => {
      result.current.runWorkflowActionShortcut(
        "generate_video_reference_assets",
        { projectId: "video-project-1" },
        "鐢熸垚鍙傝€冨浘",
      );
    });

    await waitFor(() => {
      expect(runWorkflowAction).toHaveBeenCalledWith(
        "generate_video_reference_assets",
        expect.objectContaining({
          projectId: "video-project-1",
          selectedImageModelFamily: "nano-banana-2",
          modelFamily: "nano-banana-2",
          imageGenerationPrefs: expect.objectContaining({
            familyKey: "nano-banana-2",
            resolution: "4k",
            aspectRatio: "9:16",
          }),
          selectedVideoModelKey: "doubao-seedance-1-5-pro",
          videoModelKey: "doubao-seedance-1-5-pro",
          videoGenerationPrefs: expect.objectContaining({
            modelKey: "doubao-seedance-1-5-pro",
            resolution: "1080p",
            mode: "image-to-video",
          }),
        }),
        runtimeRef.current,
        expect.any(Function),
      );
    });
  });

  it("does not write a workflow completion into another active history after project switch", async () => {
    const originSnapshot = createCharactersSnapshot();
    const otherSnapshot = {
      ...createDirectorySnapshot(),
      projectId: "script-project-2",
      title: "Other Shortcut Project",
    };
    const runtimeRef = { current: createRuntime(originSnapshot) };
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const setStreaming = vi.fn();
    const setRuntime = vi.fn();
    const setActiveProjectId = vi.fn();
    const setActiveWorkflowAction = vi.fn();
    const push = vi.fn();
    let resolveWorkflow:
      | ((value: import("@/lib/home-agent/types").WorkflowActionResult) => void)
      | undefined;
    const runWorkflowAction = vi.fn(
      () =>
        new Promise<import("@/lib/home-agent/types").WorkflowActionResult>((resolve) => {
          resolveWorkflow = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useHomeAgentWorkflowShortcuts({
        runtimeRef,
        surfacedProjectSuggestionKeysRef: { current: new Set<string>() },
        loadWorkflowActionsModule: vi.fn(async () => ({
          runWorkflowAction,
        })),
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        setStreaming,
        setRuntime,
        setActiveProjectId,
        activeProjectId: runtimeRef.current.currentProjectSnapshot?.projectId,
        setActiveWorkflowAction,
      }),
    );

    act(() => {
      result.current.runWorkflowActionShortcut(
        "generate_character_transform",
        { projectId: originSnapshot.projectId },
        "生成角色改编方案",
      );
    });

    await waitFor(() => expect(runWorkflowAction).toHaveBeenCalled());

    runtimeRef.current = createRuntime(otherSnapshot);

    await act(async () => {
      resolveWorkflow?.({
        summary: "原项目任务完成，不能写入当前历史",
        projectSnapshot: originSnapshot,
        data: {
          projectSnapshot: originSnapshot,
        },
      });
      await Promise.resolve();
    });

    expect(push).toHaveBeenCalledWith("user", "生成角色改编方案");
    expect(push).not.toHaveBeenCalledWith(
      "assistant",
      expect.stringContaining("原项目任务完成"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(setRuntime).not.toHaveBeenCalledWith(
      expect.objectContaining({
        currentProjectSnapshot: expect.objectContaining({
          projectId: originSnapshot.projectId,
        }),
      }),
    );
    expect(setActiveProjectId).not.toHaveBeenCalledWith(originSnapshot.projectId);
  });
});
