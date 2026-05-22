import { describe, expect, it, vi } from "vitest";
import { showChoicePopoverMessage } from "./home-agent-workflow-ui";

describe("showChoicePopoverMessage", () => {
  it("prefers openPopoverQuestion when provided", () => {
    const push = vi.fn();
    const openPopoverQuestion = vi.fn();
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const nextQuestion = {
      id: "video-post-analyze-mode-video-project-1",
      title: "选择视频生成模式",
      description: "先确认这次视频是走文生还是图生，再继续后续视频工作流。",
      answerKey: "video-post-analyze-mode",
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      options: [],
    };

    showChoicePopoverMessage({
      label: "下一步",
      assistantMessage: "脚本拆解已经完成，先确认视频生成模式，再继续后续视频工作流。",
      nextQuestion,
      push,
      setPopoverOverride,
      openPopoverQuestion,
      setSuggested,
      setMode,
      resetComposerDraft,
    });

    expect(push).toHaveBeenNthCalledWith(1, "user", "下一步");
    expect(push).toHaveBeenNthCalledWith(
      2,
      "assistant",
      "脚本拆解已经完成，先确认视频生成模式，再继续后续视频工作流。",
    );
    expect(openPopoverQuestion).toHaveBeenCalledWith(nextQuestion);
    expect(setPopoverOverride).not.toHaveBeenCalled();
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setMode).toHaveBeenCalledWith("active");
    expect(resetComposerDraft).toHaveBeenCalledWith("");
  });

  it("falls back to setPopoverOverride when no workflow opener is provided", () => {
    const push = vi.fn();
    const setPopoverOverride = vi.fn();
    const setSuggested = vi.fn();
    const setMode = vi.fn();
    const resetComposerDraft = vi.fn();
    const nextQuestion = {
      id: "video-post-analyze-mode-video-project-1",
      title: "选择视频生成模式",
      description: "先确认这次视频是走文生还是图生，再继续后续视频工作流。",
      answerKey: "video-post-analyze-mode",
      allowCustomInput: false,
      submissionMode: "immediate" as const,
      multiSelect: false,
      options: [],
    };

    showChoicePopoverMessage({
      label: "下一步",
      assistantMessage: "脚本拆解已经完成，先确认视频生成模式，再继续后续视频工作流。",
      nextQuestion,
      push,
      setPopoverOverride,
      setSuggested,
      setMode,
      resetComposerDraft,
    });

    expect(setPopoverOverride).toHaveBeenCalledWith(nextQuestion);
    expect(setSuggested).toHaveBeenCalledWith(null);
    expect(setMode).toHaveBeenCalledWith("active");
    expect(resetComposerDraft).toHaveBeenCalledWith("");
  });
});
