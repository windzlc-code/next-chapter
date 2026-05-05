import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerQuestion, ConversationProjectSnapshot, HomeAgentMessage, StudioQuestionState, StudioRuntimeState } from "@/lib/home-agent/types";
import { DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS } from "@/lib/home-agent/image-models";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "@/lib/home-agent/video-models";
import { useHomeAgentComposerBindings } from "./use-home-agent-composer-bindings";

function createSnapshot(
  overrides: Partial<ConversationProjectSnapshot> = {},
): ConversationProjectSnapshot {
  return {
    projectId: "script-project-1",
    projectKind: "script",
    title: "Composer Bindings Project",
    currentObjective: "Continue character design",
    derivedStage: "角色开发",
    agentSummary: "summary",
    recommendedActions: ["进入角色开发步骤"],
    artifacts: [],
    ...overrides,
  };
}

function createQuestion(
  overrides: Partial<ComposerQuestion> = {},
): ComposerQuestion {
  return {
    id: "recovery-script-project-1",
    title: "Next step: character design",
    description: "desc",
    options: [
      {
        id: "enter-characters",
        label: "进入角色开发步骤",
        value: "进入角色开发步骤",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "recovery",
    ...overrides,
  };
}

function createQState(question = createQuestion()): StudioQuestionState {
  return {
    source: "deferred",
    request: {
      id: "ask-1",
      title: question.title,
      description: question.description,
      allowCustomInput: question.allowCustomInput,
      submissionMode: question.submissionMode,
      questions: [
        {
          question: question.title,
          header: question.answerKey,
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
        },
      ],
    },
    currentIndex: 0,
    answers: {},
    displayAnswers: {},
  };
}

function createRuntime(snapshot = createSnapshot()): StudioRuntimeState {
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

function message(role: HomeAgentMessage["role"], content: string): HomeAgentMessage {
  return {
    id: `${role}-${content}`,
    role,
    content,
    createdAt: "2026-04-07T00:00:00.000Z",
    status: "complete",
  };
}

type ComposerBindingsProps = Parameters<typeof useHomeAgentComposerBindings>[0];

function createComposerBindingsProps(
  overrides: Partial<ComposerBindingsProps> = {},
): ComposerBindingsProps {
  const currentProject = overrides.currentProject ?? createSnapshot();
  return {
    idle: false,
    currentProject,
    maintenanceHint: null,
    videoTransportHint: null,
    launchNotice: null,
    draftInitialValue: "",
    draftResetVersion: 0,
    draftPresence: false,
    syncComposerDraft: vi.fn(),
    placeholder: "placeholder",
    runtimeRef: { current: createRuntime(currentProject) },
    question: createQuestion(),
    qState: null,
    selectedValues: [],
    streaming: false,
    reduceMotion: true,
    composerShellClass: "",
    activeTheme: false,
    activeWorkflowAction: null,
    selectedTextModelKey: "default",
    selectedTextModelLabel: "Default",
    textModelGroups: [],
    onSelectTextModel: vi.fn(),
    selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
    selectedImageModelLabel: "Image Model",
    imageModelOptions: [],
    imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    onSelectImageModel: vi.fn(),
    onConfirmImageSettings: vi.fn(),
    onRecognizeImageStyle: vi.fn(),
    selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
    selectedVideoModelLabel: "Video Model",
    videoModelOptions: [],
    videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    onSelectVideoModel: vi.fn(),
    onConfirmVideoResolution: vi.fn(),
    creationMode: "fast",
    onCreationModeChange: vi.fn(),
    devMode: false,
    onDevModeChange: vi.fn(),
    draftRef: { current: "" },
    engineRef: { current: null },
    setStreaming: vi.fn(),
    answer: vi.fn(),
    send: vi.fn(async () => {}),
    setDeferredQuestionState: vi.fn(),
    setDeferredSelectedValues: vi.fn(),
    setDeferredDraft: vi.fn(),
    setSelectedValues: vi.fn(),
    setQState: vi.fn(),
    setMessages: vi.fn(),
    setSuggested: vi.fn(),
    setPopoverOverride: vi.fn(),
    dismissCurrentChoiceQuestion: vi.fn(),
    resetComposerDraft: vi.fn(),
    videoProjectChoiceHandler: vi.fn(() => false),
    videoAssetChoiceHandler: vi.fn(() => false),
    scriptProjectChoiceHandler: vi.fn(() => false),
    autoResearchChoiceHandler: vi.fn(() => false),
    activeTrackClassName: "",
    idleTrackClassName: "",
    lastSuggestedRef: { current: null },
    interruptWorkflowShortcut: vi.fn(),
    onGlobalInterrupt: vi.fn(),
    clearInterruptRestoreQuestion: vi.fn(),
    rememberInterruptRestoreQuestion: vi.fn(),
    ...overrides,
  };
}

describe("useHomeAgentComposerBindings", () => {
  it("does not add a confirm button to ordinary workflow choice popovers", () => {
    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState: null,
          question: createQuestion({
            answerKey: "script-characters",
            submissionMode: "confirm",
            multiSelect: false,
          }),
        }),
      ),
    );

    expect(result.current.composerProps.onConfirmQuestion).toBeUndefined();
  });

  it("adds a confirm button only for the genre selection workflow popover", () => {
    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState: null,
          question: createQuestion({
            answerKey: "题材选择",
            submissionMode: "confirm",
            multiSelect: true,
            options: [
              { id: "romance", label: "甜宠", value: "甜宠" },
              { id: "revenge", label: "复仇", value: "复仇" },
            ],
          }),
        }),
      ),
    );

    expect(result.current.composerProps.onConfirmQuestion).toEqual(expect.any(Function));
  });

  it("does not restore an interleaved chat draft after sending during a pending question", async () => {
    const qState = createQState();
    const draftRef = { current: "nh" };
    const setDeferredDraft = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          draftRef,
          setDeferredDraft,
          resetComposerDraft,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setDeferredDraft).toHaveBeenCalledWith("");
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).toHaveBeenCalledWith("nh");
  });

  it("backs the adaptation genre popover up to target market selection", () => {
    const setPopoverOverride = vi.fn();
    const setSelectedValues = vi.fn();
    const setSuggested = vi.fn();
    const setMessages = vi.fn();
    const setRuntime = vi.fn();
    const resetComposerDraft = vi.fn();
    const currentProject = createSnapshot({
      projectKind: "adaptation",
      artifacts: [
        {
          id: "setup",
          kind: "setup",
          label: "项目设置",
          summary: "setup",
          updatedAt: "2026-04-02T00:00:00.000Z",
          payload: {
            type: "setup",
            mode: "adaptation",
            marketLabel: "欧美",
            audience: "女性",
            tone: "强情绪",
            ending: "HE",
            totalEpisodes: 80,
            genres: ["甜宠"],
            targetMarket: "west",
            adaptationEpisodeCountConfirmed: true,
            adaptationTargetMarketConfirmed: true,
            adaptationGenresConfirmed: false,
          },
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject,
          runtimeRef: { current: createRuntime(currentProject) },
          question: createQuestion({
            id: "script-adaptation-genres-script-project-1:genres",
            answerKey: "题材选择",
            submissionMode: "confirm",
            multiSelect: true,
            stepIndex: 3,
            totalSteps: 8,
          }),
          setPopoverOverride,
          setMessages,
          setRuntime,
          setSelectedValues,
          setSuggested,
          resetComposerDraft,
        }),
      ),
    );

    result.current.composerProps.onBackQuestion?.();

    const runtimeUpdater = setRuntime.mock.calls[0]?.[0];
    expect(runtimeUpdater).toEqual(expect.any(Function));
    const rewoundRuntime = runtimeUpdater(createRuntime(currentProject));
    const setupPayload = rewoundRuntime.currentProjectSnapshot?.artifacts.find(
      (artifact: ConversationProjectSnapshot["artifacts"][number]) => artifact.kind === "setup",
    )?.payload;
    expect(setupPayload).toEqual(
      expect.objectContaining({
        adaptationTargetMarketConfirmed: false,
        adaptationGenresConfirmed: false,
        genres: [],
      }),
    );

    const messageUpdater = setMessages.mock.calls[0]?.[0];
    expect(messageUpdater).toEqual(expect.any(Function));
    expect(
      messageUpdater([
        message("assistant", "请选择目标市场"),
        message("user", "欧美（英文）"),
        message("assistant", "目标市场已确认。接下来请选择方向题材。"),
      ]),
    ).toEqual([message("assistant", "请选择目标市场")]);

    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setPopoverOverride).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "script-adaptation-target-market",
        id: "script-adaptation-target-market-script-project-1",
        stepIndex: 2,
        totalSteps: 8,
      }),
    );
  });

  it("routes outline progress stop through the global interrupt restore path", () => {
    const onGlobalInterrupt = vi.fn();
    const currentProject = createSnapshot({
      artifacts: [
        {
          id: "outline-progress",
          kind: "outline",
          label: "细纲进度",
          summary: "正在生成细纲",
          updatedAt: "2026-04-02T00:00:00.000Z",
          presentation: "script-rich",
          payload: {
            type: "outlines+batchProgress",
            totalEpisodes: 2,
            entries: [
              {
                number: 1,
                title: "第一集",
                summary: "第一集概要",
                outline: "第一集细纲",
                hookType: "开局",
                isKey: true,
                isClimax: false,
                isPaywall: false,
                emotionLevel: 3,
              },
            ],
            batchProgress: {
              total: 2,
              done: 1,
              failed: 0,
              processing: 1,
              percent: 50,
              batches: [
                {
                  index: 0,
                  label: "第 1 集",
                  startEp: 1,
                  endEp: 1,
                  status: "done",
                },
                {
                  index: 1,
                  label: "第 2 集",
                  startEp: 2,
                  endEp: 2,
                  status: "processing",
                },
              ],
            },
          },
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject,
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: { current: createRuntime(currentProject) },
        question: createQuestion(),
        qState: null,
        selectedValues: [],
        streaming: true,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: "generate_outlines",
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "fast",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(async () => {}),
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion: vi.fn(),
        resetComposerDraft: vi.fn(),
        videoProjectChoiceHandler: vi.fn(() => false),
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => false),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt,
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    expect(result.current.workflowProgress?.statusLabel).toContain("[#>]");

    result.current.workflowProgress?.onStop?.();

    expect(onGlobalInterrupt).toHaveBeenCalledTimes(1);
  });

  it("exposes workflow progress while episode writing is running", () => {
    const onGlobalInterrupt = vi.fn();
    const currentProject = createSnapshot({
      artifacts: [
        {
          id: "episode-progress",
          kind: "episode",
          label: "Episode writing",
          summary: "Writing episode scripts",
          updatedAt: "2026-04-02T00:00:00.000Z",
          presentation: "script-rich",
          payload: {
            type: "episodes+batchProgress",
            totalEpisodes: 3,
            durationSeconds: null,
            entries: [
              {
                number: 1,
                title: "Episode 1",
                summary: "summary 1",
                outline: "outline 1",
                status: "done",
                wordCount: 1200,
                content: "episode body 1",
              },
              {
                number: 2,
                title: "Episode 2",
                summary: "summary 2",
                outline: "outline 2",
                status: "processing",
              },
            ],
            batchProgress: {
              total: 3,
              done: 1,
              failed: 0,
              processing: 1,
              percent: 50,
            },
          },
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject,
          runtimeRef: { current: createRuntime(currentProject) },
          streaming: true,
          activeWorkflowAction: "generate_episode_batch",
          onGlobalInterrupt,
        }),
      ),
    );

    expect(result.current.workflowProgress).toMatchObject({
      floorPercent: 33,
      ceilPercent: 67,
      hasProcessing: true,
    });
    expect(result.current.workflowProgress?.statusLabel).toContain("[#>.]");

    result.current.workflowProgress?.onStop?.();

    expect(onGlobalInterrupt).toHaveBeenCalledTimes(1);
  });

  it("shows a command-style fallback for script breakdown before chunk progress arrives", () => {
    const currentProject = createSnapshot({
      projectKind: "video",
      derivedStage: "脚本拆解",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject,
          runtimeRef: { current: createRuntime(currentProject) },
          streaming: true,
          activeWorkflowAction: "analyze_script_for_video",
        }),
      ),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:workflow-progress", {
          detail: {
            id: "shortcut-analyze_script_for_video",
            status: "start",
            content: "剧本拆解",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
  });

  it("keeps episode duration selection local in the popover", () => {
    const setSelectedValues = vi.fn();
    const send = vi.fn(async () => {});
    const dismissCurrentChoiceQuestion = vi.fn();
    const scriptProjectChoiceHandler = vi.fn(() => false);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          question: createQuestion({
            answerKey: "script-episode",
            submissionMode: "immediate",
            options: [
              {
                id: "duration-90",
                label: "90秒",
                value: "script:episode-duration:90",
              },
            ],
          }),
          setSelectedValues,
          send,
          dismissCurrentChoiceQuestion,
          scriptProjectChoiceHandler,
        }),
      ),
    );

    result.current.handleChoiceSelect("script:episode-duration:90", "90秒");

    expect(setSelectedValues).toHaveBeenCalledWith(["script:episode-duration:90"]);
    expect(scriptProjectChoiceHandler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("keeps compliance workspace choices from being dismissed as stale suggestions", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const scriptProjectChoiceHandler = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({ derivedStage: "合规审查" }),
          runtimeRef: { current: createRuntime(createSnapshot({ derivedStage: "合规审查" })) },
          question: createQuestion({
            id: "script-compliance-workspace-script-project-1",
            answerKey: "script-compliance-workspace",
            submissionMode: "immediate",
            options: [
              {
                id: "run-text",
                label: "文字审查",
                value: "script:compliance-run:text",
              },
            ],
          }),
          scriptProjectChoiceHandler,
          dismissCurrentChoiceQuestion,
        }),
      ),
    );

    result.current.handleChoiceSelect("script:compliance-run:text", "文字审查");

    expect(scriptProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("passes pending episode duration only when episode writing is confirmed", () => {
    const scriptProjectChoiceHandler = vi.fn(() => true);
    const dismissCurrentChoiceQuestion = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          question: createQuestion({
            answerKey: "script-episode",
            submissionMode: "immediate",
            options: [
              {
                id: "batch",
                label: "批量自动撰写",
                value: "script:episode-generate-batch",
              },
            ],
          }),
          selectedValues: ["script:episode-duration:90"],
          scriptProjectChoiceHandler,
          dismissCurrentChoiceQuestion,
        }),
      ),
    );

    result.current.handleChoiceSelect("script:episode-generate-batch", "批量自动撰写");

    expect(scriptProjectChoiceHandler).toHaveBeenCalledWith(
      expect.any(Object),
      "script:episode-generate-batch",
      "批量自动撰写",
      { durationSeconds: 90 },
    );
    expect(dismissCurrentChoiceQuestion).toHaveBeenCalled();
  });

  it("routes a freeform bridge-platform command to the video workflow handler when a video project is active", () => {
    const videoProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({ projectKind: "video", derivedStage: "脚本拆解" }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "补平台与镜头偏好",
        draftResetVersion: 0,
        draftPresence: true,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(createSnapshot({ projectKind: "video", derivedStage: "脚本拆解" })),
        },
        question: null,
        qState: null,
        selectedValues: [],
        streaming: false,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: null,
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "creative",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "补平台与镜头偏好" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send,
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion: vi.fn(),
        resetComposerDraft,
        videoProjectChoiceHandler,
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => false),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt: vi.fn(),
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    result.current.submitComposer();

    expect(videoProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "video" }),
      "video:bridge:platform",
      "补平台与镜头偏好",
    );
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the current immediate question visible while another workflow is running", () => {
    const dismissCurrentChoiceQuestion = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot(),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: { current: createRuntime() },
        question: createQuestion(),
        qState: null,
        selectedValues: [],
        streaming: true,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: "generate_creative_plan",
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "creative",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(async () => {}),
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion,
        resetComposerDraft: vi.fn(),
        videoProjectChoiceHandler: vi.fn(() => false),
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => true),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt: vi.fn(),
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    result.current.handleChoiceSelect("进入角色开发步骤", "进入角色开发步骤");

    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("does not dismiss the staged video analyze question while chaining to the next parameter step", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" })),
        },
        question: createQuestion({
          id: "video-analyze-duration-video-project-1",
          answerKey: "video-analyze-duration",
          options: [{ id: "dur-90", label: "90 秒", value: "video:bridge:analyze:dur:90" }],
        }),
        qState: null,
        selectedValues: [],
        streaming: false,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: null,
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "fast",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(async () => {}),
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion,
        resetComposerDraft: vi.fn(),
        videoProjectChoiceHandler,
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => false),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt: vi.fn(),
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    result.current.handleChoiceSelect("video:bridge:analyze:dur:90", "90 秒");

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("does not dismiss the first-step video bridge panel while opening the analyze parameter popup", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" })),
        },
        question: createQuestion({
          id: "video-bridge-analyze-video-project-1",
          answerKey: "video-bridge-panel",
          options: [{ id: "bridge-analyze", label: "完成剧本拆解", value: "video:bridge:analyze" }],
        }),
        qState: null,
        selectedValues: [],
        streaming: false,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: null,
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "fast",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(async () => {}),
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion,
        resetComposerDraft: vi.fn(),
        videoProjectChoiceHandler,
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => false),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt: vi.fn(),
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    result.current.handleChoiceSelect("video:bridge:analyze", "完成剧本拆解");

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("does not dismiss the review/export panel while opening the local export dialog", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);
    const exportQuestion = createQuestion({
      id: "review-stage-panel-video-project-1",
      answerKey: "review-stage-panel",
      title: "选择导出方式",
      options: [{ id: "export-all", label: "全部导出", value: "video:export:all" }],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({ projectKind: "video", derivedStage: "预览与导出" }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(createSnapshot({ projectKind: "video", derivedStage: "预览与导出" })),
        },
        question: exportQuestion,
        qState: null,
        selectedValues: [],
        streaming: false,
        reduceMotion: true,
        composerShellClass: "",
        activeTheme: false,
        activeWorkflowAction: null,
        selectedTextModelKey: "default",
        selectedTextModelLabel: "Default",
        textModelGroups: [],
        onSelectTextModel: vi.fn(),
        selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
        selectedVideoModelLabel: "Video Model",
        videoModelOptions: [],
        videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        onSelectVideoModel: vi.fn(),
        onConfirmVideoResolution: vi.fn(),
        creationMode: "fast",
        onCreationModeChange: vi.fn(),
        devMode: false,
        onDevModeChange: vi.fn(),
        draftRef: { current: "" },
        engineRef: { current: null },
        setStreaming: vi.fn(),
        answer: vi.fn(),
        send: vi.fn(async () => {}),
        setDeferredQuestionState: vi.fn(),
        setDeferredSelectedValues: vi.fn(),
        setDeferredDraft: vi.fn(),
        setSelectedValues: vi.fn(),
        setQState: vi.fn(),
        setMessages: vi.fn(),
        setSuggested: vi.fn(),
        setPopoverOverride: vi.fn(),
        dismissCurrentChoiceQuestion,
        resetComposerDraft: vi.fn(),
        videoProjectChoiceHandler,
        videoAssetChoiceHandler: vi.fn(() => false),
        scriptProjectChoiceHandler: vi.fn(() => false),
        autoResearchChoiceHandler: vi.fn(() => false),
        activeTrackClassName: "",
        idleTrackClassName: "",
        lastSuggestedRef: { current: null },
        interruptWorkflowShortcut: vi.fn(),
        onGlobalInterrupt: vi.fn(),
        clearInterruptRestoreQuestion: vi.fn(),
        rememberInterruptRestoreQuestion: vi.fn(),
      }),
    );

    result.current.handleChoiceSelect("video:export:all", "全部导出");

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });
});
