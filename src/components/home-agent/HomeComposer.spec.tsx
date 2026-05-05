import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  listHomeAgentImageModelFamilies,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  listHomeAgentVideoModels,
} from "@/lib/home-agent/video-models";
import { groupHomeAgentTextModelOptions } from "@/lib/home-agent/text-models";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import { HomeComposer, type HomeComposerProps } from "./home-agent-shell";

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
    reduceMotion: true,
    composerShellClass: "rounded-[28px]",
    activeTheme: true,
    selectedTextModelKey: "google/gemini-3-flash",
    selectedTextModelLabel: "Google / 3 Flash",
    textModelGroups: groupHomeAgentTextModelOptions(),
    onSelectTextModel: vi.fn(),
    selectedImageModelKey: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
    selectedImageModelLabel: "nano-banana-pro",
    imageModelOptions: listHomeAgentImageModelFamilies(),
    imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    onSelectImageModel: vi.fn(),
    onConfirmImageSettings: vi.fn(),
    onRecognizeImageStyle: vi.fn(),
    selectedVideoModelKey: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
    selectedVideoModelLabel: "seedance-1-5-pro",
    videoModelOptions: listHomeAgentVideoModels(),
    videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    onSelectVideoModel: vi.fn(),
    onConfirmVideoResolution: vi.fn(),
    creationMode: "creative",
    onCreationModeChange: vi.fn(),
    devMode: false,
    onDevModeChange: vi.fn(),
    onSelectChoice: vi.fn(),
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    ...overrides,
  };
}

function StatefulComposer(props: Partial<HomeComposerProps> = {}) {
  const [prefs, setPrefs] = useState<VideoImageGenerationPrefs>(
    props.imageGenerationPrefs ?? DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  );
  const [videoPrefs, setVideoPrefs] = useState<VideoGenerationPrefs>(
    props.videoGenerationPrefs ?? DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
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
        onConfirmVideoResolution: (nextPrefs) => {
          setVideoPrefs(nextPrefs);
          props.onConfirmVideoResolution?.(nextPrefs);
        },
      })}
    />
  );
}

describe("HomeComposer", () => {

  it("accepts text input when no structured question modal is shown", () => {
    const onDraftChange = vi.fn();

    render(<HomeComposer {...createComposerProps({ onDraftChange })} />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "test input" } });

    expect(textarea.value).toBe("test input");
    expect(onDraftChange).toHaveBeenCalledWith("test input");
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
    fireEvent.click(screen.getByTestId("home-image-aspect-3-2"));

    expect(onConfirmImageSettings).toHaveBeenCalledWith({
      familyKey: "nano-banana-pro",
      resolution: "2k",
      aspectRatio: "3:2",
      styleCategory: "realistic",
      stylePreset: "live-action",
    });
    await waitFor(() => {
      expect(screen.getByTestId("home-image-settings-trigger")).toHaveTextContent("2K");
      expect(screen.getByTestId("home-image-settings-trigger")).toHaveTextContent("3:2");
    });
  });

  it("removes duplicated video mode and style controls from image settings", () => {
    render(<StatefulComposer />);

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));

    expect(screen.queryByTestId("home-video-mode-text-to-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-video-mode-image-to-video")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-category-realistic")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-preset-live-action")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-custom-style-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-recognize")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-image-style-preview")).not.toBeInTheDocument();
  });

  it("shows current parameters as text and keeps them in sync inside image settings", () => {
    const { rerender } = render(<HomeComposer {...createComposerProps()} />);

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    expect(screen.getByTestId("home-image-settings-panel")).toBeInTheDocument();

    expect(screen.getByTestId("home-image-preview-creation-mode")).toHaveTextContent("创作模式");
    expect(screen.getByTestId("home-image-preview-video-mode")).toHaveTextContent("图生视频");
    expect(screen.getByTestId("home-image-preview-style")).toHaveTextContent("写实类 · 真人影视");
    expect(screen.getByTestId("home-image-success-preview")).toHaveTextContent("nano-banana-pro");
    expect(screen.getByTestId("home-image-preview-video-model")).toHaveTextContent("seedance-1-5-pro");
    expect(screen.getByTestId("home-image-output-preview")).toHaveTextContent("2K / 16:9");
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

    fireEvent.click(screen.getByTestId("home-image-settings-trigger"));
    expect(screen.getByTestId("home-image-settings-panel")).toBeInTheDocument();

    expect(screen.getByTestId("home-image-preview-creation-mode")).toHaveTextContent("快速模式");
    expect(screen.getByTestId("home-image-preview-video-mode")).toHaveTextContent("图生视频");
    expect(screen.getByTestId("home-image-preview-style")).toHaveTextContent("二维动画类 · 美式复古漫画");
    expect(screen.getByTestId("home-image-success-preview")).toHaveTextContent("nano-banana 2-async");
    expect(screen.getByTestId("home-image-output-preview")).toHaveTextContent("4K / 9:16");
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

