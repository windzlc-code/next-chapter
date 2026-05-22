import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioQuestionState,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import { DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS } from "@/lib/home-agent/image-models";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "@/lib/home-agent/video-models";
import {
  applyFullAutoStrategyAnswer,
  createFullAutoOriginalScriptRunPlan,
  getNextFullAutoStrategyQuestion,
} from "@/lib/home-agent/full-auto-run-plan";
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

function createRuntime(
  snapshot: ConversationProjectSnapshot | null = createSnapshot(),
): StudioRuntimeState {
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

function message(
  role: HomeAgentMessage["role"],
  content: string,
): HomeAgentMessage {
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
  const currentProject = Object.prototype.hasOwnProperty.call(
    overrides,
    "currentProject",
  )
    ? (overrides.currentProject ?? null)
    : createSnapshot();
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
    automationMode: "manual",
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
    setMode: vi.fn(),
    queueWorkflowPopoverAfterAssistantReply: vi.fn(),
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
    getInterruptedChoiceQuestion: vi.fn(() => null),
    ...overrides,
  };
}

function createOriginalKickoffQState(
  question: ComposerQuestion,
  step = "audience",
): StudioQuestionState {
  return {
    source: "deferred",
    request: {
      id: `original-script-kickoff:test-flow:${step}`,
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

describe("useHomeAgentComposerBindings", () => {
  it("lets special popup choices short-circuit normal workflow selection", () => {
    const onBeforeChoiceSelect = vi.fn(() => true);
    const rememberInterruptRestoreQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => false);
    const send = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          question: createQuestion({
            id: "pending-character-audio-upload:video-project-1:char-1:restore",
            title: "正在等待上传《林萧》的音频参考",
            options: [
              {
                id: "char-1-return-menu",
                label: "返回菜单",
                value: "home:pending-character-audio:return-menu",
              },
            ],
            answerKey: "pending-character-audio-upload",
          }),
          onBeforeChoiceSelect,
          rememberInterruptRestoreQuestion,
          videoProjectChoiceHandler,
          send,
        }),
      ),
    );

    act(() => {
      result.current.handleChoiceSelect(
        "home:pending-character-audio:return-menu",
        "返回菜单",
      );
    });

    expect(onBeforeChoiceSelect).toHaveBeenCalledWith(
      "home:pending-character-audio:return-menu",
      "返回菜单",
      expect.objectContaining({
        answerKey: "pending-character-audio-upload",
      }),
    );
    expect(rememberInterruptRestoreQuestion).not.toHaveBeenCalled();
    expect(videoProjectChoiceHandler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("lets special popup back actions short-circuit the ordinary back channel", () => {
    const onBeforeQuestionBack = vi.fn(() => true);
    const handleFullAutoQuestionBack = vi.fn(() => false);
    const setPopoverOverride = vi.fn();
    const setRuntime = vi.fn();
    const setMessages = vi.fn();
    const setSelectedValues = vi.fn();
    const setSuggested = vi.fn();
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "adaptation",
          }),
          question: createQuestion({
            id: "pending-character-audio-upload:video-project-1:char-1:restore",
            title: "正在等待上传《陆沉》的音频参考",
            options: [
              {
                id: "return-menu",
                label: "返回菜单",
                value: "home:pending-character-audio:return-menu",
              },
            ],
            answerKey: "pending-character-audio-upload",
          }),
          canHandleQuestionBack: (question) =>
            question?.answerKey === "pending-character-audio-upload",
          onBeforeQuestionBack,
          handleFullAutoQuestionBack,
          setPopoverOverride,
          setRuntime,
          setMessages,
          setSelectedValues,
          setSuggested,
          resetComposerDraft,
        }),
      ),
    );

    result.current.composerProps.onBackQuestion?.();

    expect(onBeforeQuestionBack).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "pending-character-audio-upload",
      }),
    );
    expect(handleFullAutoQuestionBack).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSelectedValues).not.toHaveBeenCalled();
    expect(setSuggested).not.toHaveBeenCalled();
    expect(resetComposerDraft).not.toHaveBeenCalled();
  });

  it("lets preset reference-audio picker questions intercept the back action", () => {
    const onBeforeQuestionBack = vi.fn(() => true);
    const handleFullAutoQuestionBack = vi.fn(() => false);
    const setPopoverOverride = vi.fn();
    const setRuntime = vi.fn();
    const setMessages = vi.fn();
    const setSelectedValues = vi.fn();
    const setSuggested = vi.fn();
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
          }),
          question: createQuestion({
            id: "video-bridge-preset-audio-picker-video-project-1",
            title: "Choose preset reference audio",
            options: [
              {
                id: "preset-group-basic",
                label: "Basic presets (1)",
                value: "video:bridge:reference-audio:preset-group:basic",
              },
            ],
            answerKey: "video-bridge-preset-audio-panel",
          }),
          canHandleQuestionBack: (question) =>
            question?.answerKey === "video-bridge-preset-audio-panel",
          onBeforeQuestionBack,
          handleFullAutoQuestionBack,
          setPopoverOverride,
          setRuntime,
          setMessages,
          setSelectedValues,
          setSuggested,
          resetComposerDraft,
        }),
      ),
    );

    result.current.composerProps.onBackQuestion?.();

    expect(onBeforeQuestionBack).toHaveBeenCalledWith(
      expect.objectContaining({
        answerKey: "video-bridge-preset-audio-panel",
      }),
    );
    expect(handleFullAutoQuestionBack).not.toHaveBeenCalled();
    expect(setPopoverOverride).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSelectedValues).not.toHaveBeenCalled();
    expect(setSuggested).not.toHaveBeenCalled();
    expect(resetComposerDraft).not.toHaveBeenCalled();
  });

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

    expect(result.current.composerProps.onConfirmQuestion).toEqual(
      expect.any(Function),
    );
  });

  it("defers a pending structured question to chat when freeform text does not match an option", async () => {
    const question = createQuestion();
    const qState = createQState(question);
    const draftRef = { current: "tell me more first" };
    const deferDismissedQuestion = vi.fn();
    const rememberInterruptRestoreQuestion = vi.fn();
    const setDeferredDraft = vi.fn();
    const setDeferredQuestionState = vi.fn();
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          question,
          draftRef,
          deferDismissedQuestion,
          rememberInterruptRestoreQuestion,
          setDeferredDraft,
          setDeferredQuestionState,
          setMessages,
          setMode,
          setQState,
          setSelectedValues,
          resetComposerDraft,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(question);
    expect(deferDismissedQuestion).toHaveBeenCalledWith(qState, [], "");
    expect(setDeferredQuestionState).not.toHaveBeenCalled();
    expect(setDeferredDraft).not.toHaveBeenCalled();
    expect(setQState).toHaveBeenCalledWith(null);
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).toHaveBeenCalledWith("tell me more first", undefined, {
      disableAutoResearch: true,
    });
  });

  it("defers the original kickoff question to chat when the user types an unrelated greeting", async () => {
    const kickoffQuestion = createQuestion({
      id: "original-script-kickoff:test-flow:audience",
      title: "这次更希望主打哪类受众？",
      answerKey: "目标受众",
      options: [
        { id: "female", label: "女频", value: "女频" },
        { id: "male", label: "男频", value: "男频" },
        { id: "all", label: "全年龄", value: "全年龄" },
      ],
    });
    const qState = createOriginalKickoffQState(kickoffQuestion);
    const draftRef = { current: "hello there" };
    const rememberInterruptRestoreQuestion = vi.fn();
    const setDeferredDraft = vi.fn();
    const setDeferredQuestionState = vi.fn();
    const setQState = vi.fn();
    const setDeferredSelectedValues = vi.fn();
    const setSelectedValues = vi.fn();
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          question: kickoffQuestion,
          draftRef,
          draftInitialValue: "hello there",
          draftPresence: true,
          rememberInterruptRestoreQuestion,
          setDeferredDraft,
          setDeferredQuestionState,
          setDeferredSelectedValues,
          setQState,
          setSelectedValues,
          setMessages,
          setMode,
          resetComposerDraft,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(
      kickoffQuestion,
    );
    expect(setDeferredQuestionState).toHaveBeenCalledWith(qState);
    expect(setDeferredSelectedValues).toHaveBeenCalledWith([]);
    expect(setDeferredDraft).toHaveBeenCalledWith("");
    expect(setQState).toHaveBeenCalledWith(null);
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).toHaveBeenCalledWith("hello there", undefined, {
      disableAutoResearch: true,
    });
  });

  it("accepts a pure numeric original kickoff word-count answer", async () => {
    const kickoffQuestion = createQuestion({
      id: "original-script-kickoff:test-flow:word-count",
      title: "Word count",
      answerKey: "Word count",
      options: [
        { id: "40", label: "40 episodes", value: "40 episodes" },
        { id: "60", label: "60 episodes", value: "60 episodes" },
        { id: "80", label: "80 episodes", value: "80 episodes" },
        { id: "100", label: "100 episodes", value: "100 episodes" },
      ],
    });
    const qState = createOriginalKickoffQState(kickoffQuestion, "word-count");
    const draftRef = { current: "10集" };
    const answer = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          question: kickoffQuestion,
          draftRef,
          draftInitialValue: "10集",
          draftPresence: true,
          answer,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(answer).toHaveBeenCalledWith("10集");
    expect(send).not.toHaveBeenCalled();
  });

  it("stores a pending popup as deferred state before sending arbitrary freeform text to chat", async () => {
    const question = createQuestion();
    const qState = createQState(question);
    const draftRef = { current: "tell me more" };
    const rememberInterruptRestoreQuestion = vi.fn();
    const setDeferredDraft = vi.fn();
    const setDeferredQuestionState = vi.fn();
    const setDeferredSelectedValues = vi.fn();
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          question,
          draftRef,
          rememberInterruptRestoreQuestion,
          setDeferredDraft,
          setDeferredQuestionState,
          setDeferredSelectedValues,
          setMessages,
          setMode,
          setQState,
          setSelectedValues,
          resetComposerDraft,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(question);
    expect(setDeferredQuestionState).toHaveBeenCalledWith(qState);
    expect(setDeferredSelectedValues).toHaveBeenCalledWith([]);
    expect(setDeferredDraft).toHaveBeenCalledWith("");
    expect(setQState).toHaveBeenCalledWith(null);
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).toHaveBeenCalledWith("tell me more", undefined, {
      disableAutoResearch: true,
    });
  });

  it("sends repeated freeform turns to chat while temporarily hiding the pending popup", async () => {
    const question = createQuestion({
      id: "video-bridge-panel:test",
      title: "继续补角色与场景",
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "batch",
          label: "批量执行",
          value: "批量执行",
        },
      ],
      allowCustomInput: true,
    });
    const draftRef = { current: "first detour" };
    const rememberInterruptRestoreQuestion = vi.fn();
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});
    const dismissCurrentChoiceQuestion = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          question,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          rememberInterruptRestoreQuestion,
          setMessages,
          setMode,
          setSelectedValues,
          resetComposerDraft,
          send,
          dismissCurrentChoiceQuestion,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    setMessages.mockClear();
    draftRef.current = "second detour";

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenNthCalledWith(
      1,
      question,
    );
    expect(rememberInterruptRestoreQuestion).toHaveBeenNthCalledWith(
      2,
      question,
    );
    expect(dismissCurrentChoiceQuestion).toHaveBeenNthCalledWith(1, question);
    expect(dismissCurrentChoiceQuestion).toHaveBeenNthCalledWith(2, question);
    expect(setSelectedValues).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "first detour", undefined, {
      disableAutoResearch: true,
    });
    expect(send).toHaveBeenNthCalledWith(2, "second detour", undefined, {
      disableAutoResearch: true,
    });
  });

  it("routes direct homepage original-script kickoff text into the standard local kickoff panel", async () => {
    const draftRef = {
      current:
        "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。",
    };
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setMessages,
          setMode,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setMode).toHaveBeenCalledWith("active");
    expect(setMessages).toHaveBeenCalledTimes(1);
    const nextMessages = setMessages.mock.calls[0]?.[0]([]);
    expect(nextMessages).toHaveLength(2);
    expect(nextMessages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: draftRef.current,
      }),
    );
    expect(nextMessages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("原创剧本"),
      }),
    );
    expect(setQState).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          title: "原创剧本立项",
        }),
      }),
    );
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).not.toHaveBeenCalled();
  });

  it("routes direct homepage adaptation kickoff text into the standard local kickoff panel", async () => {
    const draftRef = {
      current:
        "我要做参考改编。请先问我目标市场和改编方向，然后接收参考内容，在首页会话里继续推进结构转译和角色设计。",
    };
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setMessages,
          setMode,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setQState).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          title: "参考改编入口",
        }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("routes direct homepage video-workflow kickoff text into the standard local kickoff panel", async () => {
    const draftRef = {
      current:
        "我要继续视频工作流。请先分析我现有的脚本或项目，再在当前首页会话里继续推进分镜、提示词批次和出片准备。",
    };
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setMessages,
          setMode,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setQState).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          title: "视频工作流入口",
        }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps pasted script text when submitting during workflow document upload mode", async () => {
    const draftRef = {
      current:
        "1-1 客厅 日 内\n女主坐在沙发上。\n1-2 走廊 夜 内\n男主推门而入。",
    };
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          isAwaitingWorkflowDocumentUpload: true,
          send,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(send).toHaveBeenCalledWith(draftRef.current);
  });

  it("submits vague manual homepage chatter to the llm instead of opening a local router", async () => {
    const draftRef = { current: "想试试" };
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          automationMode: "manual",
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setMessages,
          setMode,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(send).toHaveBeenCalledWith("想试试");
    expect(setMode).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setQState).not.toHaveBeenCalled();
    expect(resetComposerDraft).not.toHaveBeenCalled();
  });

  it("submits vague full-auto homepage chatter to the llm instead of forcing the kickoff popup", async () => {
    const draftRef = { current: "先试试" };
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          automationMode: "full-auto",
          currentProject: null,
          runtimeRef: { current: createRuntime(null) },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setMessages,
          setMode,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(send).toHaveBeenCalledWith("先试试");
    expect(setMode).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(setQState).not.toHaveBeenCalled();
    expect(resetComposerDraft).not.toHaveBeenCalled();
  });

  it("still routes an explicit homepage adaptation kickoff from a placeholder snapshot into the standard local kickoff panel", async () => {
    const draftRef = {
      current:
        "我要做参考改编。请先问我目标市场和改编方向，然后接收参考内容，在首页会话里继续推进结构转译和角色设计。",
    };
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectId: "session-placeholder",
            currentObjective: "继续当前对话",
            derivedStage: "历史对话",
            recommendedActions: [],
            artifacts: [],
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectId: "session-placeholder",
                currentObjective: "继续当前对话",
                derivedStage: "历史对话",
                recommendedActions: [],
                artifacts: [],
              }),
            ),
          },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setQState).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          title: "参考改编入口",
        }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("still routes an explicit homepage video kickoff from a placeholder snapshot into the standard local kickoff panel", async () => {
    const draftRef = {
      current:
        "我要继续视频工作流。请先分析我现有的脚本或项目，再在当前首页会话里继续推进分镜、提示词批次和出片准备。",
    };
    const setQState = vi.fn();
    const send = vi.fn(async () => {});
    const resetComposerDraft = vi.fn();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectId: "session-placeholder",
            currentObjective: "继续当前对话",
            derivedStage: "历史对话",
            recommendedActions: [],
            artifacts: [],
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectId: "session-placeholder",
                currentObjective: "继续当前对话",
                derivedStage: "历史对话",
                recommendedActions: [],
                artifacts: [],
              }),
            ),
          },
          question: null,
          qState: null,
          draftRef,
          draftInitialValue: draftRef.current,
          draftPresence: true,
          setQState,
          send,
          resetComposerDraft,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
    });

    expect(setQState).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          title: "视频工作流入口",
        }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("restores the current structured question locally when the user says continue", () => {
    const kickoffQuestion = createQuestion({
      id: "original-script-kickoff:test-flow:audience",
      title: "这次更希望主打哪类受众？",
      answerKey: "目标受众",
      options: [
        { id: "female", label: "女频", value: "女频" },
        { id: "male", label: "男频", value: "男频" },
        { id: "all", label: "全年龄", value: "全年龄" },
        {
          id: "unknown",
          label: "暂不确定，先给建议",
          value: "暂不确定，先给建议",
        },
      ],
    });
    const qState = createOriginalKickoffQState(kickoffQuestion);
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState,
          question: kickoffQuestion,
          draftRef: { current: "继续" },
          draftInitialValue: "继续",
          draftPresence: true,
          setMessages,
          setMode,
          resetComposerDraft,
          send,
        }),
      ),
    );

    result.current.submitComposer();

    expect(setMode).toHaveBeenCalledWith("active");
    expect(setMessages).toHaveBeenCalledTimes(1);
    const nextMessages = setMessages.mock.calls[0]?.[0]([]);
    expect(nextMessages).toHaveLength(2);
    expect(nextMessages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "继续",
      }),
    );
    expect(nextMessages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining(
          "你可以直接选择：女频 / 男频 / 全年龄 / 暂不确定，先给建议。",
        ),
      }),
    );
    expect(resetComposerDraft).toHaveBeenCalledWith("");
    expect(send).not.toHaveBeenCalled();
  });

  it("temporarily hides a workflow popover and forwards unmatched freeform text to chat", () => {
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const rememberInterruptRestoreQuestion = vi.fn();
    const dismissCurrentChoiceQuestion = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});
    const question = createQuestion({
      answerKey: "script-characters",
      allowCustomInput: false,
      submissionMode: "immediate",
      options: [
        {
          id: "enter-characters",
          label: "进入角色开发步骤",
          value: "进入角色开发步骤",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState: null,
          question,
          draftRef: { current: "please explain first" },
          draftInitialValue: "please explain first",
          draftPresence: true,
          rememberInterruptRestoreQuestion,
          setMessages,
          setMode,
          dismissCurrentChoiceQuestion,
          setSelectedValues,
          resetComposerDraft,
          send,
        }),
      ),
    );

    result.current.submitComposer();

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(question);
    expect(dismissCurrentChoiceQuestion).toHaveBeenCalledWith(question);
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(send).toHaveBeenCalledWith("please explain first", undefined, {
      disableAutoResearch: true,
    });
  });

  it("lets the user ask a vague follow-up while keeping the workflow popover restorable", () => {
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const rememberInterruptRestoreQuestion = vi.fn();
    const dismissCurrentChoiceQuestion = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});
    const question = createQuestion({
      answerKey: "video-analyze-duration",
      title: "请选择单集时长",
      allowCustomInput: false,
      submissionMode: "immediate",
      options: [
        {
          id: "duration-60",
          label: "60 秒",
          value: "video:bridge:analyze:dur:60",
        },
        {
          id: "duration-90",
          label: "90 秒",
          value: "video:bridge:analyze:dur:90",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          qState: null,
          question,
          draftRef: { current: "can you help me decide" },
          draftInitialValue: "can you help me decide",
          draftPresence: true,
          rememberInterruptRestoreQuestion,
          setMessages,
          setMode,
          dismissCurrentChoiceQuestion,
          setSelectedValues,
          resetComposerDraft,
          send,
        }),
      ),
    );

    result.current.submitComposer();

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(question);
    expect(dismissCurrentChoiceQuestion).toHaveBeenCalledWith(question);
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(send).toHaveBeenCalledWith("can you help me decide", undefined, {
      disableAutoResearch: true,
    });
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
      (artifact: ConversationProjectSnapshot["artifacts"][number]) =>
        artifact.kind === "setup",
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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
    expect(result.current.workflowProgress?.title).toBe("从第 2 集继续撰写");
    expect(result.current.workflowProgress?.description).toContain(
      "重试会从第 2 集继续",
    );

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

  it("repairs legacy mojibake in script breakdown workflow progress copy", () => {
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
            status: "progress",
            content: "鍓ф湰鎷嗚В [>] 0/8 集 · 鍒濆鍖?",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toBe("剧本拆解 [>] 0/8 集");
    expect(result.current.workflowProgress?.detailLabel).toBe("初始化");
  });

  it("shows a command-style fallback for shot prompt batches before unit progress arrives", () => {
    const currentProject = createSnapshot({
      projectKind: "video",
      derivedStage: "视频提示词",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject,
          runtimeRef: { current: createRuntime(currentProject) },
          streaming: true,
          activeWorkflowAction: "prepare_video_prompt_batch",
        }),
      ),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:workflow-progress", {
          detail: {
            id: "shortcut-prepare_video_prompt_batch",
            status: "start",
            content: "生成视频提示词批次",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
    expect(result.current.workflowProgress?.title).toBe("正在生成镜头提示词");
  });

  it("shows segment prompt workflow progress even before a project snapshot is attached", () => {
    const runtime = createRuntime(null);
    runtime.currentVideoProject = {
      id: "video-project-1",
      title: "Segment Prompt Project",
      storyTitle: "Segment Prompt Project",
      currentStep: 4,
      scenes: [],
      characters: [],
      sceneSettings: [],
      styleLock: null,
      shotPackets: [],
      promptBatches: {},
      segmentVideoPrompts: {},
      automationMode: "manual",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    } as StudioRuntimeState["currentVideoProject"];

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: runtime },
          streaming: true,
          activeWorkflowAction: "prepare_segment_video_prompt",
        }),
      ),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:workflow-progress", {
          detail: {
            id: "shortcut-prepare_segment_video_prompt",
            status: "progress",
            content: "片段提示词 [>] 0/8 片段 · 正在生成片段 1-1",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
    expect(result.current.workflowProgress?.title).toBe("正在生成片段提示词");
    expect(result.current.workflowProgress?.detailLabel).toContain(
      "正在生成片段 1-1",
    );
  });

  it("shows a command-style fallback for segment prompt generation before segment progress arrives", () => {
    const runtime = createRuntime(null);
    runtime.currentVideoProject = {
      id: "video-project-1",
      title: "Segment Prompt Project",
      storyTitle: "Segment Prompt Project",
      currentStep: 4,
      scenes: [],
      characters: [],
      sceneSettings: [],
      styleLock: null,
      shotPackets: [],
      promptBatches: {},
      segmentVideoPrompts: {},
      automationMode: "manual",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    } as StudioRuntimeState["currentVideoProject"];

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: runtime },
          streaming: true,
          activeWorkflowAction: "prepare_segment_video_prompt",
        }),
      ),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:workflow-progress", {
          detail: {
            id: "shortcut-prepare_segment_video_prompt",
            status: "start",
            content: "片段提示词",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
    expect(result.current.workflowProgress?.title).toBe("正在生成片段提示词");
  });

  it.skip("keeps segment video workflow progress visible before media results arrive", () => {
    const runtime = createRuntime(null);
    runtime.currentVideoProject = {
      id: "video-project-1",
      title: "Segment Video Project",
      storyTitle: "Segment Video Project",
      currentStep: 4,
      scenes: [],
      characters: [],
      sceneSettings: [],
      styleLock: null,
      shotPackets: [],
      promptBatches: {},
      segmentVideoPrompts: {},
      automationMode: "manual",
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    } as StudioRuntimeState["currentVideoProject"];

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: null,
          runtimeRef: { current: runtime },
          streaming: true,
          activeWorkflowAction: "generate_segment_video",
        }),
      ),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("agent:workflow-progress", {
          detail: {
            id: "shortcut-generate_segment_video",
            status: "start",
            content: "片段视频",
          },
        }),
      );
    });

    expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
    expect(result.current.workflowProgress?.title).toBe("正在生成片段视频");
  });

  it("keeps the last shortcut progress frame visible briefly after the active workflow action clears", () => {
    vi.useFakeTimers();
    try {
      const runtime = createRuntime(null);
      runtime.currentVideoProject = {
        id: "video-project-1",
        title: "Segment Prompt Project",
        storyTitle: "Segment Prompt Project",
        currentStep: 4,
        scenes: [],
        characters: [],
        sceneSettings: [],
        styleLock: null,
        shotPackets: [],
        promptBatches: {},
        segmentVideoPrompts: {},
        automationMode: "manual",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      } as StudioRuntimeState["currentVideoProject"];

      const { result, rerender } = renderHook(
        ({ activeWorkflowAction }) =>
          useHomeAgentComposerBindings(
            createComposerBindingsProps({
              currentProject: null,
              runtimeRef: { current: runtime },
              streaming: true,
              activeWorkflowAction,
            }),
          ),
        {
          initialProps: {
            activeWorkflowAction: "prepare_segment_video_prompt" as const,
          },
        },
      );

      act(() => {
        window.dispatchEvent(
          new CustomEvent("agent:workflow-progress", {
            detail: {
              id: "shortcut-prepare_segment_video_prompt",
              status: "progress",
              content: "鐗囨鎻愮ず璇?[>] 0/8 鐗囨 路 姝ｅ湪鐢熸垚鐗囨 1-1",
            },
          }),
        );
      });

      expect(result.current.workflowProgress?.statusLabel).toBe(
        "片段提示词 [>] 0/8 片段",
      );
      expect(result.current.workflowProgress?.detailLabel).toBe(
        "正在生成片段 1-1",
      );

      act(() => {
        window.dispatchEvent(
          new CustomEvent("agent:workflow-progress", {
            detail: {
              id: "shortcut-prepare_segment_video_prompt",
              status: "complete",
              content: "",
            },
          }),
        );
      });

      expect(result.current.workflowProgress?.statusLabel).toContain("[>]");
      expect(result.current.workflowProgress?.onStop).toBeUndefined();

      rerender({ activeWorkflowAction: null });

      expect(result.current.workflowProgress?.statusLabel).toContain("[>]");

      act(() => {
        vi.advanceTimersByTime(1799);
      });

      expect(result.current.workflowProgress?.statusLabel).toContain("[>]");

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(result.current.workflowProgress).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

    expect(setSelectedValues).toHaveBeenCalledWith([
      "script:episode-duration:90",
    ]);
    expect(scriptProjectChoiceHandler).not.toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("keeps compliance workspace choices from being dismissed as stale suggestions", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const scriptProjectChoiceHandler = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({ derivedStage: "合规审查" }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({ derivedStage: "合规审查" }),
            ),
          },
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
                label: "自动批量补齐",
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

    result.current.handleChoiceSelect(
      "script:episode-generate-batch",
      "自动批量补齐",
    );

    expect(scriptProjectChoiceHandler).toHaveBeenCalledWith(
      expect.any(Object),
      "script:episode-generate-batch",
      "自动批量补齐",
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
        currentProject: createSnapshot({
          projectKind: "video",
          derivedStage: "脚本拆解",
        }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "补平台与镜头偏好",
        draftResetVersion: 0,
        draftPresence: true,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(
            createSnapshot({ projectKind: "video", derivedStage: "脚本拆解" }),
          ),
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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
    expect(send).not.toHaveBeenCalled();
  });

  it("routes freeform custom style text through the video kickoff style handler", () => {
    const videoProjectChoiceHandler = vi.fn(() => true);
    const dismissCurrentChoiceQuestion = vi.fn();
    const send = vi.fn(async () => {});
    const draft = "电影级低饱和胶片质感，雨夜霓虹反射";

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "剧本拆解",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "剧本拆解",
              }),
            ),
          },
          draftInitialValue: draft,
          draftPresence: true,
          draftRef: { current: draft },
          question: createQuestion({
            id: "video-kickoff-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            allowCustomInput: true,
            answerKey: "video-kickoff-prefs-style",
            options: [
              {
                id: "style-live-action",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:live-action",
              },
            ],
          }),
          dismissCurrentChoiceQuestion,
          send,
          videoProjectChoiceHandler,
        }),
      ),
    );

    result.current.submitComposer();

    expect(videoProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "video" }),
      `video:kickoff:prefs:custom-style:${encodeURIComponent(draft)}`,
      draft,
    );
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("routes uploaded reference images through the video kickoff style recognizer", () => {
    const videoProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const referenceFile = new File(["image-binary"], "reference-style.png", {
      type: "image/png",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "剧本拆解",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "剧本拆解",
              }),
            ),
          },
          draftInitialValue: "",
          draftPresence: false,
          draftRef: { current: "" },
          attachedFiles: [referenceFile],
          question: createQuestion({
            id: "video-kickoff-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            allowCustomInput: true,
            answerKey: "video-kickoff-prefs-style",
            options: [
              {
                id: "style-live-action",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:live-action",
              },
            ],
          }),
          send,
          videoProjectChoiceHandler,
        }),
      ),
    );

    result.current.submitComposer();

    expect(videoProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "video" }),
      "video:kickoff:prefs:style-reference",
      "识别已上传参考图",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("shows the video mode badge immediately on the kickoff style step after mode selection", () => {
    const snapshot = createSnapshot({
      projectKind: "video",
      derivedStage: "Script breakdown",
    });
    const runtime = createRuntime(snapshot);
    runtime.currentVideoProject = {
      id: "video-project-style-step",
      title: "Composer Bindings Video Project",
      script: "test script",
      targetPlatform: "Douyin",
      shotStyle: "Trailer",
      outputGoal: "Launch teaser",
      productionNotes: "",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "ready",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "script-project-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-07T00:00:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
      kickoffModeConfirmed: false,
      videoGenerationPrefs: {
        ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        mode: "image-to-video",
      },
    } as NonNullable<StudioRuntimeState["currentVideoProject"]>;

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: snapshot,
          runtimeRef: { current: runtime },
          question: createQuestion({
            id: "video-kickoff-style-question",
            title: "Choose style category",
            description:
              "Choose a preset style or enter custom style text.",
            allowCustomInput: true,
            answerKey: "video-kickoff-prefs-style",
            options: [
              {
                id: "style-live-action",
                label: "Live action",
                value: "video:kickoff:prefs:style-category:live-action",
              },
            ],
          }),
        }),
      ),
    );

    expect(result.current.composerProps.devVideoGenerationMode).toBe(
      "image-to-video",
    );
    expect(result.current.composerProps.showVideoModeBadge).toBe(true);
  });

  it("keeps the video mode badge hidden on the kickoff mode chooser itself", () => {
    const snapshot = createSnapshot({
      projectKind: "video",
      derivedStage: "Script breakdown",
    });
    const runtime = createRuntime(snapshot);
    runtime.currentVideoProject = {
      id: "video-project-mode-step",
      title: "Composer Bindings Video Project",
      script: "test script",
      targetPlatform: "Douyin",
      shotStyle: "Trailer",
      outputGoal: "Launch teaser",
      productionNotes: "",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "ready",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "script-project-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-07T00:00:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
      kickoffModeConfirmed: false,
      videoGenerationPrefs: {
        ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        mode: "text-to-video",
      },
    } as NonNullable<StudioRuntimeState["currentVideoProject"]>;

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: snapshot,
          runtimeRef: { current: runtime },
          question: createQuestion({
            id: "video-kickoff-mode-question",
            title: "Choose video generation mode",
            answerKey: "video-kickoff-prefs-mode",
            allowCustomInput: false,
            options: [
              {
                id: "mode-text",
                label: "Text-to-video",
                value: "video:kickoff:prefs:mode:text-to-video",
              },
            ],
          }),
        }),
      ),
    );

    expect(result.current.composerProps.devVideoGenerationMode).toBe(
      "text-to-video",
    );
    expect(result.current.composerProps.showVideoModeBadge).toBe(false);
  });

  it("routes freeform custom style text through the full-auto preflight style handler", () => {
    const handleFullAutoChoiceSelect = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const draft = "港风夜景写实，强对比霓虹光效";

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "script",
            derivedStage: "项目设定",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "script",
                derivedStage: "项目设定",
              }),
            ),
          },
          draftInitialValue: draft,
          draftPresence: true,
          draftRef: { current: draft },
          question: createQuestion({
            id: "full-auto-video-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            allowCustomInput: true,
            answerKey: "full-auto-preflight:videoStyle",
            options: [
              {
                id: "style-realistic",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:realistic",
              },
            ],
          }),
          handleFullAutoChoiceSelect,
          send,
        }),
      ),
    );

    result.current.submitComposer();

    expect(handleFullAutoChoiceSelect).toHaveBeenCalledWith(
      `video:kickoff:prefs:custom-style:${encodeURIComponent(draft)}`,
      draft,
      expect.objectContaining({ answerKey: "full-auto-preflight:videoStyle" }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("recognizes uploaded reference images before answering the full-auto preflight style question", async () => {
    const handleFullAutoChoiceSelect = vi.fn(() => true);
    const onAttachedFilesChange = vi.fn();
    const onRecognizeImageStyle = vi.fn(async () => ({
      styleCategory: "realistic" as const,
      stylePreset: "live-action" as const,
      summary: "港风写实夜景，霓虹反射明显。",
      confidence: 0.92,
      reasons: ["matched cinematic live-action cues"],
      imageSummaries: [],
    }));
    const referenceFile = new File(["image-binary"], "full-auto-style.png", {
      type: "image/png",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "script",
            derivedStage: "项目设定",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "script",
                derivedStage: "项目设定",
              }),
            ),
          },
          draftInitialValue: "",
          draftPresence: false,
          draftRef: { current: "" },
          attachedFiles: [referenceFile],
          onAttachedFilesChange,
          onRecognizeImageStyle,
          question: createQuestion({
            id: "full-auto-video-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            allowCustomInput: true,
            answerKey: "full-auto-preflight:videoStyle",
            options: [
              {
                id: "style-realistic",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:realistic",
              },
            ],
          }),
          handleFullAutoChoiceSelect,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
      await Promise.resolve();
    });

    expect(onRecognizeImageStyle).toHaveBeenCalledTimes(1);
    expect(onAttachedFilesChange).toHaveBeenCalledWith([]);
    expect(handleFullAutoChoiceSelect).toHaveBeenCalledWith(
      "video:kickoff:prefs:style-preset:live-action",
      "写实类 · 真人影视",
      expect.objectContaining({ answerKey: "full-auto-preflight:videoStyle" }),
    );
  });

  it("exposes a temporary style-recognition progress state while full-auto reference analysis is running", async () => {
    const handleFullAutoChoiceSelect = vi.fn(() => true);
    const onAttachedFilesChange = vi.fn();
    let resolveRecognition:
      | ((value: {
          styleCategory: "realistic";
          stylePreset: "live-action";
          summary: string;
          confidence: number;
          reasons: string[];
          imageSummaries: [];
        }) => void)
      | null = null;
    const onRecognizeImageStyle = vi.fn(
      () =>
        new Promise<{
          styleCategory: "realistic";
          stylePreset: "live-action";
          summary: string;
          confidence: number;
          reasons: string[];
          imageSummaries: [];
        }>((resolve) => {
          resolveRecognition = resolve;
        }),
    );
    const referenceFile = new File(["image-binary"], "full-auto-style.png", {
      type: "image/png",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "script",
            derivedStage: "椤圭洰璁惧畾",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "script",
                derivedStage: "椤圭洰璁惧畾",
              }),
            ),
          },
          draftInitialValue: "",
          draftPresence: false,
          draftRef: { current: "" },
          attachedFiles: [referenceFile],
          onAttachedFilesChange,
          onRecognizeImageStyle,
          question: createQuestion({
            id: "full-auto-video-style-question",
            title: "閫夋嫨鐢婚潰椋庢牸绫诲瀷",
            description:
              "鐩存帴閫夋嫨棰勮椋庢牸锛屾垨鍦ㄥ簳閮ㄨ緭鍏ヨ嚜瀹氫箟椋庢牸璇存槑銆?",
            allowCustomInput: true,
            answerKey: "full-auto-preflight:videoStyle",
            options: [
              {
                id: "style-realistic",
                label: "鍐欏疄绫?",
                value: "video:kickoff:prefs:style-category:realistic",
              },
            ],
          }),
          handleFullAutoChoiceSelect,
        }),
      ),
    );

    await act(async () => {
      result.current.submitComposer();
      await Promise.resolve();
    });

    expect(result.current.composerProps.styleRecognitionProgress).toEqual(
      expect.objectContaining({
        progress: 14,
        label: "正在识别参考图风格",
      }),
    );

    await act(async () => {
      resolveRecognition?.({
        styleCategory: "realistic",
        stylePreset: "live-action",
        summary: "娓鍐欏疄澶滄櫙锛岄湏铏瑰弽灏勬槑鏄俱€?",
        confidence: 0.92,
        reasons: ["matched cinematic live-action cues"],
        imageSummaries: [],
      });
      await Promise.resolve();
    });

    expect(result.current.composerProps.styleRecognitionProgress).toBeNull();
    expect(onAttachedFilesChange).toHaveBeenCalledWith([]);
    expect(handleFullAutoChoiceSelect).toHaveBeenCalled();
  });

  it("exposes a full-auto reset action when the preflight plan can rewind", () => {
    const handleFullAutoQuestionReset = vi.fn(() => true);
    const completion = {
      setupInput: { totalEpisodes: 12, title: "Reset test drama" },
      userBubble: "Original script: reset test drama",
      structuredSummary: "12-episode original drama",
    };
    const initialPlan = createFullAutoOriginalScriptRunPlan(completion);
    const firstQuestion = getNextFullAutoStrategyQuestion(initialPlan);
    const firstOption = firstQuestion?.options[0];
    if (!firstQuestion || !firstOption) {
      throw new Error(
        "Expected the full-auto preflight plan to expose the first question.",
      );
    }
    const answeredPlan = applyFullAutoStrategyAnswer(
      initialPlan,
      firstOption.value,
      firstOption.label,
      firstQuestion,
    );
    if (!answeredPlan) {
      throw new Error(
        "Expected the full-auto preflight answer to produce a plan.",
      );
    }

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "script",
            derivedStage: "项目设定",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "script",
                derivedStage: "项目设定",
              }),
            ),
          },
          question: getNextFullAutoStrategyQuestion(answeredPlan),
          fullAutoRun: {
            status: "collecting",
            plan: answeredPlan,
            currentStepIndex: 0,
            currentStepLabel: "collecting",
          } as NonNullable<ComposerBindingsProps["fullAutoRun"]>,
          handleFullAutoQuestionReset,
        }),
      ),
    );

    expect(result.current.composerProps.onResetQuestion).toEqual(
      expect.any(Function),
    );
    result.current.composerProps.onResetQuestion?.();
    expect(handleFullAutoQuestionReset).toHaveBeenCalledTimes(1);
  });

  it("routes freeform numeric custom input through the video analyze duration handler", () => {
    const videoProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const draft = "75";

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "鍓ф湰鎷嗚В",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "鍓ф湰鎷嗚В",
              }),
            ),
          },
          draftInitialValue: draft,
          draftPresence: true,
          draftRef: { current: draft },
          question: createQuestion({
            id: "video-analyze-duration-question",
            title: "请选择单集时长",
            description: "时长会影响镜头拆解的颗粒度和时长分配。",
            allowCustomInput: false,
            answerKey: "video-analyze-duration",
            options: [
              {
                id: "duration-60",
                label: "60 秒",
                value: "video:bridge:analyze:dur:60",
              },
              {
                id: "duration-custom",
                label: "自定义",
                value: "video:bridge:analyze:dur:custom",
                childInput: {
                  type: "number",
                  actionPrefix: "video:bridge:analyze:dur:n:",
                  min: 15,
                  max: 600,
                  placeholder: "输入时长（秒）",
                  suffix: "秒",
                  buttonLabel: "确认",
                },
              },
            ],
          }),
          send,
          videoProjectChoiceHandler,
        }),
      ),
    );

    result.current.submitComposer();

    expect(videoProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "video" }),
      "video:bridge:analyze:dur:n:75",
      expect.stringContaining("75"),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("routes freeform numeric custom input through the script duration gate handler", () => {
    const scriptProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const draft = "150";

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "script",
            derivedStage: "鍗曢泦缁嗙翰",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "script",
                derivedStage: "鍗曢泦缁嗙翰",
              }),
            ),
          },
          draftInitialValue: draft,
          draftPresence: true,
          draftRef: { current: draft },
          question: createQuestion({
            id: "script-episode-duration-gate-question",
            title: "先确认单集目标时长",
            description: "确认时长后再进入分集撰写。",
            allowCustomInput: true,
            answerKey: "script-episode-duration-gate",
            options: [
              {
                id: "duration-60",
                label: "60 秒",
                value: "script:episode-duration-gate:60",
              },
              {
                id: "duration-custom",
                label: "自定义时长",
                value: "script:episode-duration-gate:custom",
                childInput: {
                  type: "number",
                  actionPrefix: "script:episode-duration-gate:custom:",
                  min: 30,
                  max: 600,
                  placeholder: "输入秒数",
                  suffix: "秒",
                  buttonLabel: "确认并进入分集撰写",
                  labelTemplate: "自定义 {value} 秒",
                },
              },
            ],
          }),
          send,
          scriptProjectChoiceHandler,
        }),
      ),
    );

    result.current.submitComposer();

    expect(scriptProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "script" }),
      "script:episode-duration-gate:custom:150",
      "自定义 150 秒",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("routes direct numeric adaptation episode input through the shortcut handler", () => {
    const scriptProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const draft = "72";
    const currentProject = createSnapshot({
      projectKind: "adaptation",
      derivedStage: "\u7ed3\u6784\u8f6c\u8bd1",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings(
        createComposerBindingsProps({
          currentProject,
          runtimeRef: { current: createRuntime(currentProject) },
          draftInitialValue: draft,
          draftPresence: true,
          draftRef: { current: draft },
          question: createQuestion({
            id: "script-adaptation-episode-count-question",
            title: "Confirm adaptation episode count",
            description: "Confirm total episodes before continuing.",
            allowCustomInput: true,
            answerKey: "script-adaptation-episode-count",
            options: [
              {
                id: "episode-count-60",
                label: "60 episodes",
                value: "script:adaptation-total-episodes:60",
              },
              {
                id: "episode-count-custom",
                label: "Custom episodes",
                value: "script:adaptation-total-episodes:custom",
                childInput: {
                  type: "number",
                  actionPrefix: "script:adaptation-total-episodes:custom:",
                  min: 1,
                  max: 1000,
                  placeholder: "Enter total episodes",
                  suffix: " episodes",
                  buttonLabel: "Confirm",
                  labelTemplate: "Custom {value} episodes",
                },
              },
            ],
          }),
          send,
          scriptProjectChoiceHandler,
        }),
      ),
    );

    result.current.submitComposer();

    expect(scriptProjectChoiceHandler).toHaveBeenCalledWith(
      expect.objectContaining({ projectKind: "adaptation" }),
      "script:adaptation-total-episodes:custom:72",
      "Custom 72 episodes",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("routes a natural-language next-step request to the recommended script workflow option", () => {
    const scriptProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const suggestedQuestion = createQuestion({
      title: "Next step: enter character design",
      options: [
        {
          id: "enter-characters",
          label: "Enter character design",
          value: "script:step-enter-characters",
        },
      ],
    });
    const snapshot = createSnapshot();

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          question: null,
          currentProject: snapshot,
          runtimeRef: { current: createRuntime(snapshot) },
          draftRef: { current: "next step" },
          draftInitialValue: "next step",
          draftPresence: true,
          lastSuggestedRef: { current: suggestedQuestion },
          queueWorkflowPopoverAfterAssistantReply,
          send,
          scriptProjectChoiceHandler,
        }),
      }),
    );

    result.current.submitComposer();

    expect(scriptProjectChoiceHandler).not.toHaveBeenCalled();
    expect(queueWorkflowPopoverAfterAssistantReply).toHaveBeenCalledWith(
      suggestedQuestion,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(suggestedQuestion.title),
    );
    expect(send).toHaveBeenCalledWith(expect.any(String), "next step", {
      disableAutoResearch: true,
    });
  });

  it("routes a natural-language next-step request to the video advance shortcut when available", () => {
    const videoProjectChoiceHandler = vi.fn(() => true);
    const send = vi.fn(async () => {});
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const videoSnapshot = createSnapshot({
      projectKind: "video",
      derivedStage: "Script breakdown",
    });
    const runtime = createRuntime(videoSnapshot);
    runtime.currentVideoProject = {
      id: "video-project-1",
      title: "Composer Bindings Video Project",
      script: "test script",
      targetPlatform: "Douyin",
      shotStyle: "Trailer",
      outputGoal: "Launch teaser",
      productionNotes: "",
      scenes: [],
      characters: [],
      sceneSettings: [],
      artStyle: "live-action",
      currentStep: 1,
      systemPrompt: "",
      analysisSummary: "ready",
      storyboardPlan: "",
      videoPromptBatch: "",
      sourceProjectId: "script-project-1",
      createdAt: "2026-04-07T00:00:00.000Z",
      updatedAt: "2026-04-07T00:00:00.000Z",
      styleLock: null,
      worldModel: null,
      assetManifest: null,
      shotPackets: [],
      reviewQueue: [],
      videoGenerationPrefs: {
        ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
        mode: "text-to-video",
      },
    } as NonNullable<StudioRuntimeState["currentVideoProject"]>;
    const suggestedQuestion = createQuestion({
      id: "video-next-step-t2v",
      answerKey: "video-bridge-panel",
      title: "Next step: continue video workflow",
      options: [
        {
          id: "video-advance",
          label: "Let Agent continue",
          value: "video:advance",
        },
        {
          id: "video-platform",
          label: "Platform and camera preferences",
          value: "video:bridge:platform",
        },
      ],
    });
    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          question: null,
          currentProject: videoSnapshot,
          runtimeRef: { current: runtime },
          draftRef: { current: "next step" },
          draftInitialValue: "next step",
          draftPresence: true,
          lastSuggestedRef: { current: suggestedQuestion },
          queueWorkflowPopoverAfterAssistantReply,
          send,
          videoProjectChoiceHandler,
        }),
      }),
    );

    result.current.submitComposer();

    expect(videoProjectChoiceHandler).not.toHaveBeenCalled();
    expect(queueWorkflowPopoverAfterAssistantReply).toHaveBeenCalledWith(
      suggestedQuestion,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(suggestedQuestion.title),
    );
    expect(send).toHaveBeenCalledWith(expect.any(String), "next step", {
      disableAutoResearch: true,
    });
  });

  it("opens the suggested workflow popover when next-step intent needs a panel decision", () => {
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const send = vi.fn(async () => {});
    const suggestedQuestion = createQuestion({
      id: "workflow-next-panel",
      title: "Choose generation mode",
      answerKey: "script-outlines",
      options: [
        {
          id: "outline-all",
          label: "Generate all outlines",
          value: "script:outline-generate-all",
        },
        {
          id: "outline-fill",
          label: "Fill missing outlines",
          value: "script:outline-fill-missing",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          question: null,
          draftRef: { current: "continue to next step" },
          draftInitialValue: "continue to next step",
          draftPresence: true,
          lastSuggestedRef: { current: suggestedQuestion },
          queueWorkflowPopoverAfterAssistantReply,
          send,
        }),
      }),
    );

    result.current.submitComposer();

    expect(queueWorkflowPopoverAfterAssistantReply).toHaveBeenCalledWith(
      suggestedQuestion,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(suggestedQuestion.title),
    );
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      "continue to next step",
      { disableAutoResearch: true },
    );
  });

  it("prioritizes the interrupted workflow question when resuming by natural language", () => {
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const send = vi.fn(async () => {});
    const interruptedQuestion = createQuestion({
      id: "interrupted-script-characters",
      title: "Resume: character design",
      answerKey: "script-characters",
      options: [
        {
          id: "resume-characters",
          label: "Resume character design",
          value: "script:step-enter-characters",
        },
      ],
    });
    const fallbackSuggested = createQuestion({
      id: "fallback-script-outlines",
      title: "Fallback: outlines",
      answerKey: "script-outlines",
      options: [
        {
          id: "fallback-outlines",
          label: "Enter outlines",
          value: "script:step-enter-outlines",
        },
      ],
    });
    const getInterruptedChoiceQuestion = vi.fn(() => interruptedQuestion);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          question: null,
          draftRef: { current: "继续当前步骤" },
          draftInitialValue: "继续当前步骤",
          draftPresence: true,
          lastSuggestedRef: { current: fallbackSuggested },
          getInterruptedChoiceQuestion,
          queueWorkflowPopoverAfterAssistantReply,
          send,
        }),
      }),
    );

    result.current.submitComposer();

    expect(getInterruptedChoiceQuestion).toHaveBeenCalled();
    expect(queueWorkflowPopoverAfterAssistantReply).toHaveBeenCalledWith(
      interruptedQuestion,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(interruptedQuestion.title),
    );
    expect(send).toHaveBeenCalledWith(expect.any(String), "继续当前步骤", {
      disableAutoResearch: true,
    });
  });

  it("temporarily hides the current workflow popup during an interleaved freeform send", () => {
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const rememberInterruptRestoreQuestion = vi.fn();
    const dismissCurrentChoiceQuestion = vi.fn();
    const setMessages = vi.fn();
    const setMode = vi.fn();
    const setSelectedValues = vi.fn();
    const resetComposerDraft = vi.fn();
    const send = vi.fn(async () => {});
    const currentQuestion = createQuestion({
      id: "script-characters-script-project-1",
      answerKey: "script-characters",
      title: "下一步：进入角色开发",
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          question: currentQuestion,
          draftRef: { current: "please answer first" },
          draftInitialValue: "please answer first",
          draftPresence: true,
          queueWorkflowPopoverAfterAssistantReply,
          rememberInterruptRestoreQuestion,
          dismissCurrentChoiceQuestion,
          setMessages,
          setMode,
          setSelectedValues,
          resetComposerDraft,
          send,
        }),
      }),
    );

    result.current.submitComposer();

    expect(setMessages).not.toHaveBeenCalled();
    expect(rememberInterruptRestoreQuestion).toHaveBeenCalledWith(
      currentQuestion,
    );
    expect(dismissCurrentChoiceQuestion).toHaveBeenCalledWith(currentQuestion);
    expect(queueWorkflowPopoverAfterAssistantReply).not.toHaveBeenCalled();
    expect(setSelectedValues).toHaveBeenCalledWith([]);
    expect(send).toHaveBeenCalledWith("please answer first", undefined, {
      disableAutoResearch: true,
    });
  });

  it("blocks skip-ahead descriptions and keeps the user on the current stage panel", () => {
    const queueWorkflowPopoverAfterAssistantReply = vi.fn();
    const send = vi.fn(async () => {});
    const currentStageQuestion = createQuestion({
      id: "current-stage-panel",
      title: "Next step: enter character design",
      options: [
        {
          id: "enter-characters",
          label: "Enter character design",
          value: "script:step-enter-characters",
        },
      ],
    });
    const snapshot = createSnapshot({ derivedStage: "Character design" });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          currentProject: snapshot,
          runtimeRef: { current: createRuntime(snapshot) },
          question: currentStageQuestion,
          draftRef: { current: "跳过这个阶段，直接去分集目录" },
          draftInitialValue: "跳过这个阶段，直接去分集目录",
          draftPresence: true,
          queueWorkflowPopoverAfterAssistantReply,
          send,
          scriptProjectChoiceHandler: vi.fn(() => true),
        }),
      }),
    );

    result.current.submitComposer();

    expect(queueWorkflowPopoverAfterAssistantReply).toHaveBeenCalledWith(
      currentStageQuestion,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining(currentStageQuestion.title),
    );
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      "跳过这个阶段，直接去分集目录",
      { disableAutoResearch: true },
    );
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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
        currentProject: createSnapshot({
          projectKind: "video",
          derivedStage: "剧本拆解",
        }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(
            createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" }),
          ),
        },
        question: createQuestion({
          id: "video-analyze-duration-video-project-1",
          answerKey: "video-analyze-duration",
          options: [
            {
              id: "dur-90",
              label: "90 秒",
              value: "video:bridge:analyze:dur:90",
            },
          ],
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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
        currentProject: createSnapshot({
          projectKind: "video",
          derivedStage: "剧本拆解",
        }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(
            createSnapshot({ projectKind: "video", derivedStage: "剧本拆解" }),
          ),
        },
        question: createQuestion({
          id: "video-bridge-analyze-video-project-1",
          answerKey: "video-bridge-panel",
          options: [
            {
              id: "bridge-analyze",
              label: "完成剧本拆解",
              value: "video:bridge:analyze",
            },
          ],
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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

  it("does not dismiss the script-breakdown handoff panel while opening the video mode popup", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({
          projectKind: "video",
          derivedStage: "脚本拆解",
        }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(
            createSnapshot({ projectKind: "video", derivedStage: "脚本拆解" }),
          ),
        },
        question: createQuestion({
          id: "video-bridge-next-step-video-project-1",
          answerKey: "video-bridge-panel",
          options: [
            {
              id: "bridge-next-step",
              label: "下一步",
              value: "video:bridge:next-step",
            },
          ],
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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

    result.current.handleChoiceSelect("video:bridge:next-step", "下一步");

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
      options: [
        { id: "export-all", label: "全部导出", value: "video:export:all" },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        idle: false,
        currentProject: createSnapshot({
          projectKind: "video",
          derivedStage: "预览与导出",
        }),
        maintenanceHint: null,
        videoTransportHint: null,
        launchNotice: null,
        draftInitialValue: "",
        draftResetVersion: 0,
        draftPresence: false,
        syncComposerDraft: vi.fn(),
        placeholder: "placeholder",
        runtimeRef: {
          current: createRuntime(
            createSnapshot({
              projectKind: "video",
              derivedStage: "预览与导出",
            }),
          ),
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
        selectedImageModelKey:
          DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
        selectedImageModelLabel: "Image Model",
        imageModelOptions: [],
        imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
        onSelectImageModel: vi.fn(),
        onConfirmImageSettings: vi.fn(),
        onRecognizeImageStyle: vi.fn(),
        selectedVideoModelKey:
          DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
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

  it("does not dismiss the current video bridge panel while opening character audio upload", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);
    const question = createQuestion({
      id: "video-bridge-reference-audio-video-project-1",
      answerKey: "video-bridge-panel",
      title: "视频工作流",
      options: [
        {
          id: "bridge-reference-audio-char-1",
          label: "更新林萧音频参考",
          value: "video:bridge:reference-audio:character:char-1",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "角色与场景",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "角色与场景",
              }),
            ),
          },
          question,
          dismissCurrentChoiceQuestion,
          videoProjectChoiceHandler,
          scriptProjectChoiceHandler: vi.fn(() => false),
          videoAssetChoiceHandler: vi.fn(() => false),
          autoResearchChoiceHandler: vi.fn(() => false),
        }),
      }),
    );

    act(() => {
      result.current.handleChoiceSelect(
        "video:bridge:reference-audio:character:char-1",
        "更新林萧音频参考",
      );
    });

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("does not dismiss the current video bridge panel while opening preset character audio", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);
    const question = createQuestion({
      id: "video-bridge-reference-audio-preset-video-project-1",
      answerKey: "video-bridge-panel",
      title: "视频工作流",
      options: [
        {
          id: "bridge-reference-audio-preset-char-1",
          label: "使用预设参考音频",
          value: "video:bridge:reference-audio:preset-picker:character:char-1",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "角色与场景",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "角色与场景",
              }),
            ),
          },
          question,
          dismissCurrentChoiceQuestion,
          videoProjectChoiceHandler,
          scriptProjectChoiceHandler: vi.fn(() => false),
          videoAssetChoiceHandler: vi.fn(() => false),
          autoResearchChoiceHandler: vi.fn(() => false),
        }),
      }),
    );

    act(() => {
      result.current.handleChoiceSelect(
        "video:bridge:reference-audio:preset-picker:character:char-1",
        "使用预设参考音频",
      );
    });

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });

  it("does not dismiss the preset-audio picker while binding a preset file", () => {
    const dismissCurrentChoiceQuestion = vi.fn();
    const videoProjectChoiceHandler = vi.fn(() => true);
    const question = createQuestion({
      id: "video-bridge-preset-audio-picker-video-project-1",
      answerKey: "video-bridge-preset-audio-panel",
      title: "使用预设参考音频",
      options: [
        {
          id: "preset-entry-char-1",
          label: "01. Hero 5.2s",
          value:
            "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Chero.wav&name=hero.wav",
        },
      ],
    });

    const { result } = renderHook(() =>
      useHomeAgentComposerBindings({
        ...createComposerBindingsProps({
          currentProject: createSnapshot({
            projectKind: "video",
            derivedStage: "角色与场景",
          }),
          runtimeRef: {
            current: createRuntime(
              createSnapshot({
                projectKind: "video",
                derivedStage: "角色与场景",
              }),
            ),
          },
          question,
          dismissCurrentChoiceQuestion,
          videoProjectChoiceHandler,
          scriptProjectChoiceHandler: vi.fn(() => false),
          videoAssetChoiceHandler: vi.fn(() => false),
          autoResearchChoiceHandler: vi.fn(() => false),
        }),
      }),
    );

    act(() => {
      result.current.handleChoiceSelect(
        "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Chero.wav&name=hero.wav",
        "01. Hero 5.2s",
      );
    });

    expect(videoProjectChoiceHandler).toHaveBeenCalled();
    expect(dismissCurrentChoiceQuestion).not.toHaveBeenCalled();
  });
});
