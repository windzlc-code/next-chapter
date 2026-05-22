import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  listHomeAgentImageModelFamilies,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  listHomeAgentVideoModels,
} from "@/lib/home-agent/video-models";
import { createFullAutoOriginalScriptRunPlan } from "@/lib/home-agent/full-auto-run-plan";
import { groupHomeAgentTextModelOptions } from "@/lib/home-agent/text-models";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import type { FullAutoRunState } from "@/lib/home-agent/types";
import { ActiveConversationShell, HomeComposer, type HomeComposerProps } from "./home-agent-shell";

const DEFAULT_TEST_IMAGE_GENERATION_PREFS: VideoImageGenerationPrefs = {
  ...DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  familyKey: "nano-banana-pro",
  resolution: "2k",
  aspectRatio: "16:9",
  styleCategory: "realistic",
  stylePreset: "live-action",
  viewMode: "three",
};

const DEFAULT_TEST_VIDEO_GENERATION_PREFS: VideoGenerationPrefs = {
  ...DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  mode: "image-to-video",
};

function createComposerProps(overrides: Partial<HomeComposerProps> = {}): HomeComposerProps {
  return {
    idle: true,
    initialDraft: "",
    draftResetVersion: 0,
    draftPresence: false,
    onDraftChange: vi.fn(),
    placeholder: "Tell the agent what you want to create",
    question: null,
    workflowProgress: null,
    qState: null,
    selectedValues: [],
    streaming: false,
    fullAutoRun: null,
    isMediaGenerating: false,
    isAwaitingWorkflowDocumentUpload: false,
    reduceMotion: true,
    composerShellClass: "rounded-[28px]",
    activeTheme: true,
    selectedTextModelKey: "google/gemini-3-flash",
    selectedTextModelLabel: "Google / 3 Flash",
    textModelGroups: groupHomeAgentTextModelOptions(),
    onSelectTextModel: vi.fn(),
    selectedImageModelKey: DEFAULT_TEST_IMAGE_GENERATION_PREFS.familyKey,
    selectedImageModelLabel: "nano-banana-pro",
    imageModelOptions: listHomeAgentImageModelFamilies(),
    imageGenerationPrefs: DEFAULT_TEST_IMAGE_GENERATION_PREFS,
    onSelectImageModel: vi.fn(),
    onConfirmImageSettings: vi.fn(),
    onRecognizeImageStyle: vi.fn(),
    selectedVideoModelKey: DEFAULT_TEST_VIDEO_GENERATION_PREFS.modelKey,
    selectedVideoModelLabel: "seedance-1-5-pro",
    videoModelOptions: listHomeAgentVideoModels(),
    videoGenerationPrefs: DEFAULT_TEST_VIDEO_GENERATION_PREFS,
    onSelectVideoModel: vi.fn(),
    onConfirmVideoResolution: vi.fn(),
    onConfirmVideoPrefs: vi.fn(),
    creationMode: "creative",
    onCreationModeChange: vi.fn(),
    devMode: false,
    onDevModeChange: vi.fn(),
    onSelectChoice: vi.fn(),
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    onStopFullAuto: vi.fn(),
    ...overrides,
  };
}

function StatefulComposer(props: Partial<HomeComposerProps> = {}) {
  const [prefs, setPrefs] = useState<VideoImageGenerationPrefs>(
    props.imageGenerationPrefs ?? DEFAULT_TEST_IMAGE_GENERATION_PREFS,
  );
  const [videoPrefs, setVideoPrefs] = useState<VideoGenerationPrefs>(
    props.videoGenerationPrefs ?? DEFAULT_TEST_VIDEO_GENERATION_PREFS,
  );

  return (
    <HomeComposer
      {...createComposerProps({
        ...props,
        imageGenerationPrefs: prefs,
        videoGenerationPrefs: videoPrefs,
        onConfirmImageSettings: (nextPrefs) => {
          setPrefs(nextPrefs);
          props.onConfirmImageSettings?.(nextPrefs);
        },
        onDevImageViewModeChange: (viewMode) => {
          setPrefs((current) => ({
            ...current,
            viewMode,
          }));
          props.onDevImageViewModeChange?.(viewMode);
        },
        onConfirmVideoResolution: (nextPrefs) => {
          setVideoPrefs(nextPrefs);
          props.onConfirmVideoResolution?.(nextPrefs);
        },
        onConfirmVideoPrefs: (nextPrefs) => {
          setVideoPrefs(nextPrefs);
          props.onConfirmVideoPrefs?.(nextPrefs);
        },
      })}
    />
  );
}

describe("HomeComposer", () => {
  it("does not render maintenance hints inside the composer area", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          maintenanceHint: "已替换当前视频素材",
        })}
      />,
    );

    expect(screen.queryByText("已替换当前视频素材")).not.toBeInTheDocument();
  });

  it("uses the full-auto stop handler from the composer when automation is still running", () => {
    const onInterrupt = vi.fn();
    const onStopFullAuto = vi.fn();
    const fullAutoRun: FullAutoRunState = {
      status: "running",
      currentStepIndex: 2,
      currentStepLabel: "角色设计",
      error: null,
      plan: {
        steps: [
          {
            id: "characters",
            label: "角色设计",
            status: "running",
          },
        ],
      },
    };

    render(
      <HomeComposer
        {...createComposerProps({
          streaming: false,
          fullAutoRun,
          onInterrupt,
          onStopFullAuto,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "停止当前执行" }));

    expect(onStopFullAuto).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("shows 待执行 for the current step while full-auto is still collecting preflight strategies", () => {
    const fullAutoRun: FullAutoRunState = {
      status: "collecting",
      currentStepIndex: 0,
      currentStepLabel: "项目设定",
      plan: createFullAutoOriginalScriptRunPlan({
        setupInput: {
          title: "味蕾觉醒",
          targetMarket: "cn",
          audience: "女频",
          tone: "逆袭",
          ending: "HE",
          totalEpisodes: 40,
          genres: ["职场"],
        },
        userBubble: "确认项目设定",
        structuredSummary: "40集都市逆袭短剧",
      }),
    };

    render(
      <ActiveConversationShell
        messages={[]}
        tasks={[]}
        onStopTask={vi.fn()}
        endRef={{ current: null }}
        composer={<div>composer</div>}
        streaming={false}
        trackClassName=""
        fullAutoRun={fullAutoRun}
        onStopFullAuto={vi.fn()}
      />,
    );

    expect(screen.getByText("项目设定")).toBeInTheDocument();
    expect(screen.getByText("待执行")).toBeInTheDocument();
    expect(screen.queryByText("执行中")).not.toBeInTheDocument();
  });

  it("accepts text input when no structured question modal is shown", () => {
    const onDraftChange = vi.fn();

    render(<HomeComposer {...createComposerProps({ onDraftChange })} />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "test input" } });

    expect(textarea.value).toBe("test input");
    expect(onDraftChange).toHaveBeenCalledWith("test input");
  });

  it("renders an inline audio player for attached audio files in the homepage composer", () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:home-composer-audio.wav"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    try {
      const { container } = render(
        <HomeComposer
          {...createComposerProps({
            attachedFiles: [new File(["audio"], "home-composer-audio.wav", { type: "audio/wav" })],
            onAttachedFilesChange: vi.fn(),
          })}
        />,
      );

      expect(container.querySelector('audio[src="blob:home-composer-audio.wav"]')).toBeTruthy();
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it("renders the pending audio upload panel and lets the user return from the homepage", () => {
    const onSelectChoice = vi.fn();

    render(
      <HomeComposer
        {...createComposerProps({
          question: {
            id: "pending-character-audio-upload:video-project-1:char-1:restore",
            title: "正在等待上传《林萧》的音频参考",
            description:
              "上传 1 个音频文件并发送即可绑定。若不继续上传，可点“返回菜单”取消当前操作并回到刚才的菜单。",
            options: [
              {
                id: "char-1-return-menu",
                label: "返回菜单",
                value: "home:pending-character-audio:return-menu",
                rationale: "取消当前音频上传，并回到刚才打开的素材菜单。",
              },
            ],
            presentation: "card",
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 1,
            answerKey: "pending-character-audio-upload",
          },
          onSelectChoice,
        })}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "正在等待上传《林萧》的音频参考" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /返回菜单/ }));
    expect(onSelectChoice).toHaveBeenCalledWith(
      "home:pending-character-audio:return-menu",
      "返回菜单",
    );
  });

  it("highlights the composer and swaps the placeholder while the video style panel is active", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          question: {
            id: "video-kickoff-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            options: [
              {
                id: "style-live-action",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:live-action",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 1,
            totalSteps: 2,
            answerKey: "video-kickoff-prefs-style",
          },
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(textarea).toHaveAttribute(
      "placeholder",
      "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
    );
    expect(textarea.closest(".composer-shell-style-capture")).not.toBeNull();
    expect(uploadButton).toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toHaveClass("composer-shell-style-capture-action");
  });

  it("reuses the same style-capture placeholder for the full-auto preflight style panel", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          question: {
            id: "full-auto-video-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            options: [
              {
                id: "style-live-action",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:realistic",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 4,
            totalSteps: 9,
            answerKey: "full-auto-preflight:videoStyle",
          },
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(textarea).toHaveAttribute(
      "placeholder",
      "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
    );
    expect(textarea.closest(".composer-shell-style-capture")).not.toBeNull();
    expect(uploadButton).toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toHaveClass("composer-shell-style-capture-action");
  });

  it("shows recognition progress on uploaded reference images and disables composer actions while scanning", () => {
    const referenceFile = new File(["image-binary"], "style-reference.png", {
      type: "image/png",
    });

    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          attachedFiles: [referenceFile],
          question: {
            id: "full-auto-video-style-question",
            title: "选择画面风格类型",
            description: "直接选择预设风格，或在底部输入自定义风格说明。",
            options: [
              {
                id: "style-live-action",
                label: "写实类",
                value: "video:kickoff:prefs:style-category:realistic",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 4,
            totalSteps: 9,
            answerKey: "full-auto-preflight:videoStyle",
          },
          styleRecognitionProgress: {
            progress: 48,
            label: "正在识别参考图风格",
          },
        })}
      />,
    );

    expect(screen.getByRole("progressbar", { name: "style-reference.png 识别进度" })).toHaveAttribute(
      "aria-valuenow",
      "48",
    );
    expect(screen.getByText("正在识别参考图风格 48%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "已附加 1 个文件" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("highlights the composer for numeric custom-capture panels too", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          question: {
            id: "video-analyze-duration-question",
            title: "请选择单集时长",
            description: "时长会影响镜头拆解的颗粒度和时长分配。",
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
            allowCustomInput: false,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 2,
            answerKey: "video-analyze-duration",
          },
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(textarea).toHaveAttribute("placeholder", "输入时长（秒）");
    expect(textarea.closest(".composer-shell-style-capture")).not.toBeNull();
    expect(uploadButton).not.toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toHaveClass("composer-shell-style-capture-action");
  });

  it("reuses the same composer border animation for original kickoff word-count input", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          question: {
            id: "original-script-kickoff:test-flow:word-count:0",
            title: "集数规模",
            description: "也可以直接输入你的自定义回答。",
            options: [
              {
                id: "episodes-40",
                label: "40集（紧凑）",
                value: "40集（紧凑）",
              },
              {
                id: "episodes-60",
                label: "60集（标准）",
                value: "60集（标准）",
              },
            ],
            allowCustomInput: true,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 1,
            answerKey: "集数规模",
          },
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(textarea).toHaveAttribute("placeholder", "可直接输入 10 或 10集，我会按集数规模识别");
    expect(textarea.closest(".composer-shell-style-capture")).not.toBeNull();
    expect(uploadButton).not.toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toHaveClass("composer-shell-style-capture-action");
  });

  it("highlights send instead of upload once a custom numeric answer is ready to submit", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          initialDraft: "150",
          draftPresence: true,
          question: {
            id: "video-analyze-duration-question",
            title: "请选择单集时长",
            description: "时长会影响镜头拆解的颗粒度和时长分配。",
            options: [
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
            allowCustomInput: false,
            submissionMode: "immediate",
            multiSelect: false,
            stepIndex: 0,
            totalSteps: 2,
            answerKey: "video-analyze-duration",
          },
        })}
      />,
    );

    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(uploadButton).not.toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).toHaveClass("composer-shell-style-capture-action");
  });

  it("clears the textarea when the parent bumps draftResetVersion", () => {
    const { rerender } = render(
      <HomeComposer {...createComposerProps({ initialDraft: "给我个图片", draftPresence: true })} />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("给我个图片");

    rerender(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "",
          draftPresence: false,
          draftResetVersion: 1,
        })}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores stale change events after the parent clears the draft until fresh input resumes", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "继续",
          draftPresence: true,
          onDraftChange,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("继续");

    rerender(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "",
          draftPresence: false,
          draftResetVersion: 1,
          onDraftChange,
        })}
      />,
    );

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "继续" } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(onDraftChange).not.toHaveBeenCalledWith("继续");

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "j" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "j" } });

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("j");
    expect(onDraftChange).toHaveBeenCalledWith("j");
  });

  it("lets Backspace clear a revived stale draft after send reset", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "顶顶",
          draftPresence: true,
          onDraftChange,
        })}
      />,
    );

    rerender(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "",
          draftPresence: false,
          draftResetVersion: 1,
          onDraftChange,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "顶顶" } });
    expect(textarea.value).toBe("");
    expect(onDraftChange).not.toHaveBeenCalledWith("顶顶");

    fireEvent.keyDown(textarea, { key: "Backspace" });
    fireEvent.change(textarea, { target: { value: "顶" } });

    expect(textarea.value).toBe("顶");
    expect(onDraftChange).toHaveBeenCalledWith("顶");
  });

  it("clears the textarea immediately on submit before the parent reset lands", () => {
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn();

    render(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "输入残留测试ABD",
          draftPresence: true,
          onDraftChange,
          onSubmit,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    expect(textarea.value).toBe("输入残留测试ABD");

    fireEvent.click(sendButton);

    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onDraftChange).not.toHaveBeenCalledWith("");
  });

  it("does not submit while the composer is in IME composition", () => {
    const onSubmit = vi.fn();

    render(<HomeComposer {...createComposerProps({ onSubmit })} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("locks the composer input while media generation is in progress", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "继续生成这段视频",
          draftPresence: true,
          isMediaGenerating: true,
          onSubmit,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    expect(textarea).toBeDisabled();
    expect(uploadButton).toBeDisabled();
    expect(uploadButton).toHaveClass("composer-shell-media-locked");
    expect(sendButton).toBeDisabled();
    expect(textarea.closest(".composer-shell-media-locked")).not.toBeNull();

    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "继续生成这段视频",
          draftPresence: true,
          isMediaGenerating: false,
          onSubmit,
        })}
      />,
    );

    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "上传文件" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "上传文件" })).not.toHaveClass("composer-shell-media-locked");
    expect(screen.getByRole("button", { name: "发送消息" })).not.toBeDisabled();
    expect(screen.getByRole("textbox").closest(".composer-shell-media-locked")).toBeNull();
  });

  it("keeps text entry, upload, and attachment send available while awaiting a workflow document", () => {
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          attachedFiles: [new File(["episode-1"], "script.txt", { type: "text/plain" })],
          isAwaitingWorkflowDocumentUpload: true,
          onDraftChange,
          onSubmit,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "已附加 1 个文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "可直接粘贴剧本文本，无关内容我会提示");
    expect(textarea.closest(".composer-shell-media-locked")).toBeNull();
    expect(uploadButton).not.toBeDisabled();
    expect(uploadButton).not.toHaveClass("composer-shell-media-locked");
    expect(uploadButton).not.toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toBeDisabled();
    expect(sendButton).toHaveClass("composer-shell-style-capture-action");

    fireEvent.change(textarea, { target: { value: "1-1 客厅 日 内\n女主坐在沙发上。" } });
    expect(onDraftChange).toHaveBeenCalledWith("1-1 客厅 日 内\n女主坐在沙发上。");

    rerender(
      <HomeComposer
        {...createComposerProps({
          attachedFiles: [new File(["episode-1"], "script.txt", { type: "text/plain" })],
          isAwaitingWorkflowDocumentUpload: false,
          onSubmit,
        })}
      />,
    );

    expect(screen.getByRole("textbox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "已附加 1 个文件" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "发送消息" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "发送消息" })).not.toHaveClass("composer-shell-style-capture-action");
    expect(screen.getByRole("textbox").closest(".composer-shell-media-locked")).toBeNull();
  });

  it("submits when only an attached file is present", () => {
    const onSubmit = vi.fn();

    render(
      <HomeComposer
        {...createComposerProps({
          attachedFiles: [new File(["audio"], "voice-reference.wav", { type: "audio/wav" })],
          onSubmit,
        })}
      />,
    );

    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("highlights upload while awaiting a workflow document before any file is attached", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          isAwaitingWorkflowDocumentUpload: true,
        })}
      />,
    );

    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(uploadButton).toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toHaveClass("composer-shell-style-capture-action");
  });

  it("highlights send while awaiting a workflow document once script text is ready", () => {
    const onSubmit = vi.fn();

    render(
      <HomeComposer
        {...createComposerProps({
          initialDraft: "1-1 客厅 日 内\n女主坐在沙发上。",
          draftPresence: true,
          isAwaitingWorkflowDocumentUpload: true,
          onSubmit,
        })}
      />,
    );

    const textarea = screen.getByRole("textbox");
    const uploadButton = screen.getByRole("button", { name: "上传文件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });

    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute("placeholder", "可直接粘贴剧本文本，无关内容我会提示");
    expect(uploadButton).not.toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).toHaveClass("composer-shell-style-capture-action");
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps standalone workflow progress hidden without question or conversation context", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          streaming: true,
          placeholder: "Continue refining the request",
          workflowProgress: {
            title: "Batch 1 outline is generating",
            description: "Generated outlines will stream back into preview cards.",
            floorPercent: 50,
            ceilPercent: 50,
            hasProcessing: true,
            statusLabel: "Completed 15/30 episodes",
            detailLabel: "1/2 batches · 50%",
            currentBatchLabel: "Episodes 1-30",
          },
        })}
      />,
    );

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText("Batch 1 outline is generating")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed 15/30 episodes")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders the video workflow task board beside the composer when work remains", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "角色与场景",
            headerHint: "多图参考图生",
            items: [
              { id: "characters", label: "角色", value: 4, detail: "已整理 4 个角色。", tone: "default", state: "completed" },
              { id: "missing-references", label: "缺参考图", value: 2, detail: "还有 2 张参考图待补齐。", tone: "warning", state: "attention" },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("video-workflow-task-board")).toBeInTheDocument();
    expect(screen.getByTestId("video-workflow-task-board-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("video-workflow-task-board-header-hint")).toHaveTextContent(
      "多图参考图生",
    );
    expect(screen.getByTestId("video-workflow-task-board-header-hint")).toHaveClass(
      "line-clamp-2",
      "text-right",
      "text-[11px]",
    );
    expect(screen.getByText("任务板")).toBeInTheDocument();
    expect(screen.getByText("共 2 条 · 已完成 1 条")).toBeInTheDocument();
    expect(screen.getByText("角色 4")).toBeInTheDocument();
    expect(screen.getByText("缺参考图 2")).toBeInTheDocument();
    expect(screen.getByText("已整理 4 个角色。")).toBeInTheDocument();
    expect(screen.getByText("还有 2 张参考图待补齐。")).toBeInTheDocument();
    expect(screen.queryByText("角色与场景 · 3/6")).not.toBeInTheDocument();
    expect(screen.queryByTestId("video-workflow-task-board-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("video-workflow-task-board-collapse")).not.toBeInTheDocument();
  });

  it("updates the task board header hint when the board state changes", () => {
    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频生成",
            headerHint: "首帧图生",
            items: [
              { id: "video-pending", label: "待生成", value: 2, detail: "还有 2 个镜头待出片。", tone: "default", state: "pending" },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("video-workflow-task-board-header-hint")).toHaveTextContent(
      "首帧图生",
    );
    fireEvent.click(screen.getByTestId("video-workflow-task-board-trigger"));
    expect(screen.getByTestId("video-workflow-task-board-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("video-workflow-task-board-header-hint")).toHaveTextContent(
      "首帧图生",
    );

    rerender(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频生成",
            headerHint: "多图参考图生",
            items: [
              { id: "video-pending", label: "待生成", value: 1, detail: "还有 1 个镜头待出片。", tone: "default", state: "pending" },
            ],
          },
        })}
      />,
    );

    expect(screen.queryByText("首帧图生")).not.toBeInTheDocument();
    expect(screen.getByTestId("video-workflow-task-board-header-hint")).toHaveTextContent(
      "多图参考图生",
    );
  });

  it("makes pending and missing-asset task board items stand out from completed rows", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频生成",
            items: [
              { id: "video-pending", label: "待生成", value: 4, detail: "还有 4 个镜头待出片。", tone: "default", state: "pending" },
              { id: "missing-assets", label: "缺素材", value: 3, detail: "待补 3 项角色或场景素材", tone: "warning", state: "attention" },
              { id: "segment-prompts", label: "缺片段提示词", value: 4, detail: "片段提示词 0/4，待补 4", tone: "warning", state: "attention" },
              { id: "shot-prompts", label: "缺镜头提示词", value: 2, detail: "镜头提示词 2/4，待补 2", tone: "warning", state: "attention" },
              { id: "video-running", label: "生成中", value: 0, detail: "当前没有进行中的镜头任务。", tone: "default", state: "completed" },
            ],
          },
        })}
      />,
    );

    const pendingRow = screen.getByText("待生成 4").closest("li");
    const missingAssetsRow = screen.getByText("缺素材 3").closest("li");
    const missingSegmentPromptsRow = screen.getByText("缺片段提示词 4").closest("li");
    const missingShotPromptsRow = screen.getByText("缺镜头提示词 2").closest("li");
    const completedRow = screen.getByText("生成中 0").closest("li");
    const pendingDetail = screen.getByText("还有 4 个镜头待出片。");
    const missingAssetsDetail = screen.getByText("待补 3 项角色或场景素材");
    const missingSegmentPromptsDetail = screen.getByText("片段提示词 0/4，待补 4");
    const missingShotPromptsDetail = screen.getByText("镜头提示词 2/4，待补 2");
    const completedDetail = screen.getByText("当前没有进行中的镜头任务。");

    expect(pendingRow).toHaveClass("bg-white/[0.09]");
    expect(pendingRow).toHaveClass("ring-1");
    expect(pendingRow).toHaveClass("ring-white/[0.06]");
    expect(pendingRow).not.toHaveClass("bg-transparent");
    expect(missingAssetsRow).toHaveClass("bg-white/[0.09]");
    expect(missingAssetsRow).toHaveClass("ring-1");
    expect(missingAssetsRow).toHaveClass("ring-white/[0.06]");
    expect(missingSegmentPromptsRow).toHaveClass("bg-white/[0.09]");
    expect(missingSegmentPromptsRow).toHaveClass("ring-1");
    expect(missingSegmentPromptsRow).toHaveClass("ring-white/[0.06]");
    expect(missingSegmentPromptsRow).not.toHaveClass("bg-orange-500/[0.08]");
    expect(missingShotPromptsRow).toHaveClass("bg-white/[0.09]");
    expect(missingShotPromptsRow).toHaveClass("ring-1");
    expect(missingShotPromptsRow).toHaveClass("ring-white/[0.06]");
    expect(missingShotPromptsRow).not.toHaveClass("bg-orange-500/[0.08]");
    expect(screen.getByText("缺素材 3")).toHaveClass("text-white");
    expect(screen.getByText("缺片段提示词 4")).toHaveClass("text-white");
    expect(screen.getByText("缺镜头提示词 2")).toHaveClass("text-white");
    expect(missingAssetsDetail).toHaveClass("text-white/12");
    expect(missingSegmentPromptsDetail).toHaveClass("text-white/12");
    expect(missingShotPromptsDetail).toHaveClass("text-white/12");
    expect(completedRow).toHaveClass("bg-white/[0.01]");
    expect(screen.getByText("生成中 0")).toHaveClass("text-white/15", "line-through");
    expect(completedDetail).toHaveClass("text-white/12");
    expect(pendingDetail).toHaveClass("text-white/12");
  });

  it("keeps the collapsed task board neutral for pending-style attention items", () => {
    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频提示词",
            items: [
              { id: "segment-prompts", label: "缺片段提示词", value: 4, detail: "片段提示词 0/4，待补 4", tone: "warning", state: "attention" },
              { id: "video-running", label: "生成中", value: 0, detail: "当前没有进行中的镜头任务。", tone: "default", state: "completed" },
            ],
          },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("video-workflow-task-board-trigger"));

    const collapsedToggle = screen.getByTestId("video-workflow-task-board-toggle");
    expect(collapsedToggle).toHaveClass("border-white/[0.08]");
    expect(collapsedToggle).toHaveClass("bg-white/[0.04]");
    expect(collapsedToggle).toHaveClass("text-white/78");
    expect(collapsedToggle).not.toHaveClass("bg-orange-500/[0.08]");
    expect(collapsedToggle).not.toHaveClass("text-orange-100");
  });

  it("portals the desktop task board into the document body with measured width", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 180,
      y: 96,
      top: 96,
      right: 540,
      bottom: 224,
      left: 180,
      width: 320,
      height: 128,
      toJSON: () => ({}),
    }));

    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "角色与场景",
            items: [
              { id: "characters", label: "角色", value: 4, detail: "已整理 4 个角色。", tone: "default", state: "completed" },
              { id: "missing-references", label: "缺参考图", value: 2, detail: "还有 2 张参考图待补齐。", tone: "warning", state: "attention" },
            ],
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("video-workflow-task-board-desktop-layer")).toBeInTheDocument();
    });

    const layer = screen.getByTestId("video-workflow-task-board-desktop-layer");
    expect(layer.parentElement).toBe(document.body);
    expect(layer).toHaveClass("pointer-events-none");
    expect(layer).toHaveClass("z-[10]");
    expect(layer).toHaveStyle({
      bottom: `${window.innerHeight - 224}px`,
      left: "564px",
      width: "200px",
    });

    rectSpy.mockRestore();
  });

  it("moves the desktop task board to the left side when the right side would overlap the composer", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 900,
    });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 420,
      y: 96,
      top: 96,
      right: 780,
      bottom: 224,
      left: 420,
      width: 320,
      height: 128,
      toJSON: () => ({}),
    }));

    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "角色与场景",
            items: [
              { id: "characters", label: "角色", value: 4, detail: "已整理 4 个角色。", tone: "default", state: "completed" },
              { id: "missing-references", label: "缺参考图", value: 2, detail: "还有 2 张参考图待补齐。", tone: "warning", state: "attention" },
            ],
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("video-workflow-task-board-desktop-layer")).toBeInTheDocument();
    });

    expect(screen.getByTestId("video-workflow-task-board-desktop-layer")).toHaveStyle({
      left: "196px",
      width: "200px",
    });

    rectSpy.mockRestore();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });

  it("keeps the desktop task board out of the floating portal while delete confirmation is open", async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 180,
      y: 96,
      top: 96,
      right: 540,
      bottom: 224,
      left: 180,
      width: 320,
      height: 128,
      toJSON: () => ({}),
    }));

    render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          suppressFloatingTaskBoard: true,
          videoWorkflowTaskBoard: {
            stage: "角色与场景",
            items: [
              { id: "characters", label: "角色", value: 4, detail: "已整理 4 个角色。", tone: "default", state: "completed" },
              { id: "missing-references", label: "缺参考图", value: 2, detail: "还有 2 张参考图待补齐。", tone: "warning", state: "attention" },
            ],
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("video-workflow-task-board-desktop-layer")).not.toBeInTheDocument();
    });

    rectSpy.mockRestore();
  });

  it("auto-collapses the task board after all items complete and allows reopening it", async () => {
    const { rerender } = render(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频生成",
            items: [
              { id: "video-pending", label: "待生成", value: 1, detail: "还有 1 个镜头待出片。", tone: "default", state: "pending" },
              { id: "video-running", label: "生成中", value: 0, detail: "当前没有进行中的镜头任务。", tone: "default", state: "completed" },
            ],
          },
        })}
      />,
    );

    expect(screen.getByTestId("video-workflow-task-board")).toBeInTheDocument();

    rerender(
      <HomeComposer
        {...createComposerProps({
          idle: false,
          videoWorkflowTaskBoard: {
            stage: "视频生成",
            items: [
              { id: "video-pending", label: "待生成", value: 0, detail: "当前没有待生成的镜头。", tone: "default", state: "completed" },
              { id: "video-running", label: "生成中", value: 0, detail: "当前没有进行中的镜头任务。", tone: "default", state: "completed" },
            ],
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("video-workflow-task-board-toggle")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("video-workflow-task-board-toggle"));
    expect(screen.getByTestId("video-workflow-task-board")).toBeInTheDocument();
    expect(screen.getByTestId("video-workflow-task-board-trigger")).toBeInTheDocument();
  });

  it("moves image resolution switching into the image model picker", async () => {
    const onConfirmImageSettings = vi.fn();

    render(<StatefulComposer onConfirmImageSettings={onConfirmImageSettings} />);

    const trigger = screen.getByTestId("home-image-model-picker-trigger");
    expect(trigger).toHaveTextContent("2K");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("home-image-model-resolution-4k"));

    expect(onConfirmImageSettings).toHaveBeenCalledWith({
      familyKey: "nano-banana-pro",
      resolution: "4k",
      aspectRatio: "16:9",
      styleCategory: "realistic",
      stylePreset: "live-action",
      viewMode: "three",
    });
    await waitFor(() => {
      expect(screen.getByTestId("home-image-model-picker-trigger")).toHaveTextContent("4K");
    });
  });

  it("applies image settings changes immediately and removes footer actions", async () => {
    const onConfirmImageSettings = vi.fn();

    render(<StatefulComposer onConfirmImageSettings={onConfirmImageSettings} />);

    const trigger = screen.getByTestId("home-image-settings-trigger");
    expect(trigger).toHaveTextContent("2K");
    expect(trigger).toHaveTextContent("16:9");

    fireEvent.click(trigger);
    expect(screen.queryByTestId("home-image-settings-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-settings-confirm")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("home-image-aspect-4-3"));

    expect(onConfirmImageSettings).toHaveBeenCalledWith({
      familyKey: "nano-banana-pro",
      resolution: "2k",
      aspectRatio: "4:3",
      styleCategory: "realistic",
      stylePreset: "live-action",
      viewMode: "three",
    });
    await waitFor(() => {
      expect(screen.getByTestId("home-image-settings-trigger")).toHaveTextContent("2K");
      expect(screen.getByTestId("home-image-settings-trigger")).toHaveTextContent("4:3");
    });
  });

  it("removes duplicated video mode and style controls from image settings while keeping view mode visible", () => {
    render(<StatefulComposer />);

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));

    expect(screen.queryByTestId("home-video-mode-text-to-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-video-mode-image-to-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-category-realistic")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-preset-live-action")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-custom-style-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-recognize")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-image-view-mode-toggle")).toBeInTheDocument();
  });

  it("keeps the image view toggle always visible in image settings", async () => {
    const onDevImageViewModeChange = vi.fn();
    const onConfirmImageSettings = vi.fn();

    render(
      <StatefulComposer
        onConfirmImageSettings={onConfirmImageSettings}
        onDevImageViewModeChange={onDevImageViewModeChange}
      />,
    );

    expect(screen.queryByTestId("dev-image-view-mode-toggle")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));

    const viewModeToggle = screen.getByTestId("home-image-view-mode-toggle");
    expect(viewModeToggle).toBeInTheDocument();
    expect(screen.getByTestId("home-image-preview-view-mode")).toHaveTextContent("三视图");

    fireEvent.click(screen.getByTestId("home-image-view-mode-single"));

    expect(onConfirmImageSettings).toHaveBeenCalledWith({
      familyKey: "nano-banana-pro",
      resolution: "2k",
      aspectRatio: "9:16",
      styleCategory: "realistic",
      stylePreset: "live-action",
      viewMode: "single",
    });
    expect(onDevImageViewModeChange).toHaveBeenCalledWith("single");

    if (!screen.queryByTestId("home-image-settings-panel")) {
      fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    }

    await waitFor(() => {
      expect(screen.getByTestId("home-image-preview-view-mode")).toHaveTextContent("单图");
    });
  });

  it("limits single-view aspect ratios to supported options and auto-corrects from 16:9", async () => {
    render(<StatefulComposer />);

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    fireEvent.click(screen.getByTestId("home-image-view-mode-single"));

    await waitFor(() => {
      expect(screen.getByTestId("home-image-settings-trigger")).toHaveTextContent("9:16");
    });

    if (!screen.queryByTestId("home-image-settings-panel")) {
      fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    }

    expect(screen.getByTestId("home-image-aspect-16-9")).toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-9-16")).not.toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-1-1")).not.toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-4-3")).not.toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-3-4")).not.toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-21-9")).not.toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-2-3")).toBeDisabled();
    expect(screen.getByTestId("home-image-aspect-3-2")).toBeDisabled();
  });

  it("shows essential summaries and keeps them in sync inside image settings", () => {
    const { rerender } = render(<HomeComposer {...createComposerProps()} />);

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    expect(screen.getByTestId("home-image-settings-panel")).toBeInTheDocument();

    expect(screen.queryByTestId("home-image-preview-creation-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-preview-fallback")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-image-preview-video-mode")).toHaveTextContent("图生视频");
    expect(screen.getByTestId("home-image-preview-style")).toHaveTextContent("写实类 · 真人影视");
    expect(screen.getByTestId("home-image-success-preview")).toHaveTextContent("nano-banana-pro");
    expect(screen.getByTestId("home-image-preview-video-model")).toHaveTextContent("seedance-1-5-pro");
    expect(screen.getByTestId("home-image-output-preview")).toHaveTextContent("2K / 16:9");
    expect(screen.getByTestId("home-image-preview-view-mode")).toHaveTextContent("三视图");
    expect(screen.getByTestId("home-image-preview-video-output")).toHaveTextContent("720p");

    rerender(
      <HomeComposer
        {...createComposerProps({
          creationMode: "fast",
          imageGenerationPrefs: {
            familyKey: "nano-banana-2-async",
            resolution: "4k",
            aspectRatio: "9:16",
            styleCategory: "animation-2d",
            stylePreset: "retro-comic",
          },
          videoGenerationPrefs: {
            modelKey: "doubao-seedance-1-5-pro",
            resolution: "1080p",
            mode: "image-to-video",
          },
        })}
      />,
    );

    if (!screen.queryByTestId("home-image-settings-panel")) {
      fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    }

    expect(screen.getByTestId("home-image-settings-panel")).toBeInTheDocument();

    expect(screen.queryByTestId("home-image-preview-creation-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-preview-fallback")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-image-preview-video-mode")).toHaveTextContent("图生视频");
    expect(screen.getByTestId("home-image-preview-style")).toHaveTextContent("二维动画类 · 美式复古漫画");
    expect(screen.getByTestId("home-image-success-preview")).toHaveTextContent("nano-banana 2-async");
    expect(screen.getByTestId("home-image-output-preview")).toHaveTextContent("4K / 9:16");
    expect(screen.getByTestId("home-image-preview-view-mode")).toHaveTextContent("三视图");
    expect(screen.getByTestId("home-image-preview-video-output")).toHaveTextContent("1080p");
    expect(screen.getByTestId("home-image-transport-preview")).toHaveTextContent(
      "gemini-3-pro-image-preview-4k-async",
    );
    expect(screen.getByTestId("home-image-preview-video-transport")).toHaveTextContent(
      "doubao-seedance-1-5-pro_1080p",
    );
  });

  it("moves video resolution switching into the video model picker", () => {
    const onConfirmVideoResolution = vi.fn();

    render(<StatefulComposer onConfirmVideoResolution={onConfirmVideoResolution} />);

    const trigger = screen.getByTestId("home-video-model-picker-trigger");

    fireEvent.click(trigger);
    expect(screen.getByTestId("home-video-resolution-720p")).toHaveClass("border-primary");
    expect(screen.getByTestId("home-video-resolution-2k")).toBeDisabled();
    expect(screen.getByTestId("home-video-resolution-4k")).toBeDisabled();
    fireEvent.click(screen.getByTestId("home-video-resolution-1080p"));

    expect(onConfirmVideoResolution).toHaveBeenCalledWith({
      mode: "image-to-video",
      modelKey: "doubao-seedance-1-5-pro",
      resolution: "1080p",
    });
  });

  it("keeps Seedance 2.0 models in the same picker and disables unsupported resolutions", () => {
    const onSelectVideoModel = vi.fn();

    render(
      <StatefulComposer
        onSelectVideoModel={onSelectVideoModel}
        selectedVideoModelKey="doubao-seedance-2-0-fast-260128"
        selectedVideoModelLabel="seedance-2.0-fast"
        videoGenerationPrefs={{
          modelKey: "doubao-seedance-2-0-fast-260128",
          resolution: "720p",
          mode: "image-to-video",
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("home-video-model-picker-trigger"));

    expect(screen.getByTestId("home-video-model-option-doubao-seedance-1-5-pro")).toBeInTheDocument();
    expect(screen.getByTestId("home-video-model-option-doubao-seedance-2-0-260128")).toBeInTheDocument();
    expect(screen.getByTestId("home-video-model-option-doubao-seedance-2-0-fast-260128")).toBeInTheDocument();
    expect(screen.getByTestId("home-video-resolution-480p")).not.toBeDisabled();
    expect(screen.getByTestId("home-video-resolution-720p")).not.toBeDisabled();
    expect(screen.getByTestId("home-video-resolution-1080p")).toBeDisabled();
  });

  it("renders upload, text model, image model, video model, then image settings in toolbar order", () => {
    render(<HomeComposer {...createComposerProps()} />);

    const allButtons = screen.getAllByRole("button");
    const uploadButton = screen.getByRole("button", { name: /上传文件/i });
    const textModelButton = screen.getByRole("button", { name: /Google \/ 3 Flash/i });
    const imageModelButton = screen.getByTestId("home-image-model-picker-trigger");
    const videoModelButton = screen.getByTestId("home-video-model-picker-trigger");
    const imageSettingsButton = screen.getByTestId("home-image-settings-trigger");

    const uploadIndex = allButtons.indexOf(uploadButton);
    const textIndex = allButtons.indexOf(textModelButton);
    const imageModelIndex = allButtons.indexOf(imageModelButton);
    const videoModelIndex = allButtons.indexOf(videoModelButton);
    const imageSettingsIndex = allButtons.indexOf(imageSettingsButton);

    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBe(uploadIndex + 1);
    expect(imageModelIndex).toBe(textIndex + 1);
    expect(videoModelIndex).toBe(imageModelIndex + 1);
    expect(imageSettingsIndex).toBe(videoModelIndex + 1);
  });
});
