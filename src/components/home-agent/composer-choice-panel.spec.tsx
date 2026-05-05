import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerQuestion } from "@/lib/home-agent/types";
import { GENRES } from "@/types/drama";
import { ComposerChoicePanel } from "./composer-choice-panel";

function createQuestion(overrides?: Partial<ComposerQuestion>): ComposerQuestion {
  return {
    id: "question-collapse-1",
    title: "请选择最符合你心中《半平米的余温》的创作方向",
    description: "点任一建议即可直接提交。",
    options: [
      { id: "opt-1", label: "方案一", value: "方案一", rationale: "温情烟火感" },
      { id: "opt-2", label: "方案二", value: "方案二", rationale: "职业竞技感" },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "direction",
    ...overrides,
  };
}

describe("ComposerChoicePanel", () => {
  it("collapses into a single expand button without keeping option buttons visible", () => {
    const question = createQuestion();

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: /方案一/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `收起选择窗：${question.title}` }));

    expect(screen.queryByRole("button", { name: /方案一/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /方案二/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `展开选择窗：${question.title}` })).toBeInTheDocument();
  });

  it("consumes an open nested submenu before triggering the top-level back action", () => {
    const onBack = vi.fn();
    const question = createQuestion({
      id: "question-nested-1",
      title: "选择正文推进方式",
      description: "先展开一个子菜单，再验证返回行为。",
      options: [
        {
          id: "episodes-batch",
          label: "批量生成",
          value: "episodes-batch",
          children: [
            { id: "episodes-all", label: "生成全部", value: "episodes-all" },
            { id: "episodes-range", label: "按范围生成", value: "episodes-range" },
          ],
        },
        {
          id: "episodes-single",
          label: "单集生成",
          value: "episodes-single",
        },
      ],
      allowCustomInput: false,
      answerKey: "episode-flow",
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "批量生成" }));
    expect(screen.getByRole("button", { name: "生成全部" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));

    expect(onBack).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "生成全部" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("adds aria wiring for the genre submenu and lets Escape close it with focus return", async () => {
    const question = createQuestion({
      id: "question-genre-1",
      title: "选择题材类型",
      description: "题材选择需要二级子菜单。",
      answerKey: "题材选择",
      submissionMode: "confirm",
      multiSelect: true,
      allowCustomInput: false,
      options: GENRES.slice(0, 6).map((genre) => ({
        id: genre.value,
        label: genre.label,
        value: genre.value,
        selected: false,
      })),
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onBack={vi.fn()} />);

    const categoryButtons = within(screen.getByTestId("genre-primary-list")).getAllByRole("button");
    const firstCategoryButton = categoryButtons[0]!;

    fireEvent.click(firstCategoryButton);

    const panel = screen.getByTestId("genre-secondary-panel");
    expect(firstCategoryButton).toHaveAttribute("aria-expanded", "true");
    expect(firstCategoryButton).toHaveAttribute("aria-controls", panel.id);

    fireEvent.keyDown(screen.getByTestId("genre-picker-root"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("genre-secondary-panel")).not.toBeInTheDocument();
      expect(firstCategoryButton).toHaveFocus();
    });
  });

  it("uses the genre panel back arrow for workflow back instead of closing the genre submenu", () => {
    const onBack = vi.fn();
    const question = createQuestion({
      id: "question-genre-back-1",
      title: "选择方向题材",
      description: "方向题材需要能回到目标市场。",
      answerKey: "题材选择",
      submissionMode: "confirm",
      multiSelect: true,
      allowCustomInput: false,
      options: GENRES.slice(0, 6).map((genre) => ({
        id: genre.value,
        label: genre.label,
        value: genre.value,
        selected: false,
      })),
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onBack={onBack} />);

    const firstCategoryButton = within(screen.getByTestId("genre-primary-list")).getAllByRole("button")[0]!;
    fireEvent.click(firstCategoryButton);

    expect(screen.getByTestId("genre-secondary-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens a fourth-level storyboard submenu and surfaces disabled material hints", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-storyboard-1",
      title: "选择分镜图生成方式",
      description: "片段右侧需要继续展开到单个分镜。",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "single-group",
          label: "单项处理",
          value: "single-group",
          children: [
            {
              id: "storyboard-list",
              label: "指定生成分镜图",
              value: "video:bridge:storyboard-frames:list",
              children: [
                {
                  id: "segment-a",
                  label: "片段 A（2）",
                  value: "video:bridge:storyboard-frames:group:A",
                  children: [
                    {
                      id: "segment-a-bulk",
                      label: "生成本片段全部可选分镜（1）",
                      value: "video:bridge:storyboard-frames:segment:A",
                      rationale: "只会生成当前高亮可选的分镜。",
                    },
                    {
                      id: "segment-a-shot-1",
                      label: "生成 镜头 1 / A · Warehouse",
                      value: "video:bridge:storyboard-frame:scene:scene-ready",
                    },
                    {
                      id: "segment-a-shot-2",
                      label: "生成 镜头 2 / A · Street",
                      value: "video:bridge:storyboard-frame:scene:scene-blocked",
                      disabled: true,
                      rationale: "缺失必要素材：角色主参考图《Villain》；场景主参考图《Street》",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "单项处理" }));
    fireEvent.click(screen.getByRole("button", { name: "指定生成分镜图" }));
    fireEvent.click(screen.getByRole("button", { name: "片段 A（2）" }));

    const tertiaryPanel = screen.getByTestId("nested-tertiary-panel");
    expect(tertiaryPanel).toHaveClass("left-[calc(100%+4px)]");

    const quaternaryPanel = screen.getByTestId("nested-quaternary-panel");
    expect(quaternaryPanel).toBeInTheDocument();
    expect(quaternaryPanel).toHaveClass("left-[calc(100%+4px)]");
    expect(screen.queryByText("只会生成当前高亮可选的分镜。")).not.toBeInTheDocument();
    expect(screen.getByText("缺失必要素材：角色主参考图《Villain》；场景主参考图《Street》")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /生成本片段全部可选分镜（1）/ }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:bridge:storyboard-frames:segment:A",
      "生成本片段全部可选分镜（1）",
    );
  });

  it("top-aligns the export submenu in the review-stage panel", async () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-export-alignment-1",
      title: "Review stage",
      description: "Verify export submenu alignment.",
      allowCustomInput: false,
      answerKey: "review-stage-panel",
      options: [
        {
          id: "automation-group",
          label: "Automation",
          value: "video:panel:review-stage-panel-automation",
          children: [
            {
              id: "export-group",
              label: "Export",
              value: "video:panel:review-stage-panel-export",
              children: [
                {
                  id: "export-all",
                  label: "Export all",
                  value: "video:export:all",
                },
                {
                  id: "export-nle",
                  label: "Export to NLE",
                  value: "video:export:nle-placeholder",
                },
              ],
            },
            {
              id: "open-bundle",
              label: "Open bundle",
              value: "打开生产状态目录",
            },
          ],
        },
      ],
    });

    const { container } = render(
      <ComposerChoicePanel question={question} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const root = container.firstElementChild as HTMLElement;
    const primaryList = root.firstElementChild as HTMLElement;
    const primaryButton = screen.getByRole("button", { name: "Automation" });
    const secondaryPanel = screen.getByTestId("nested-secondary-panel");
    const secondaryWrapper = secondaryPanel.parentElement as HTMLElement;
    const secondaryButton = screen.getByRole("button", { name: "Export" });
    const tertiaryPanel = screen.getByTestId("nested-tertiary-panel");
    const tertiaryButton = screen.getByRole("button", { name: "Export all" });

    const rect = (top: number, left: number, width: number, height: number) => ({
      x: left,
      y: top,
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON() {
        return this;
      },
    });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });

    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function mockRect() {
        if (this === root) return rect(100, 24, 280, 240) as DOMRect;
        if (this === primaryList) return rect(120, 40, 220, 180) as DOMRect;
        if (this === primaryButton) return rect(140, 48, 180, 48) as DOMRect;
        if (this === secondaryPanel) return rect(150, 320, 220, 180) as DOMRect;
        if (this === secondaryButton) return rect(210, 332, 180, 44) as DOMRect;
        if (this === tertiaryPanel) return rect(132, 560, 204, 120) as DOMRect;
        if (this === tertiaryButton) return rect(172, 572, 172, 44) as DOMRect;
        return rect(0, 0, 0, 0) as DOMRect;
      });

    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(secondaryWrapper).toHaveStyle({ top: "80px" });
      expect(tertiaryPanel.className).toContain("absolute");
      expect(tertiaryPanel.className).toContain("left-[calc(100%+4px)]");
      expect(tertiaryPanel).toHaveStyle({ top: "60px" });
    });

    rectSpy.mockRestore();
  });

  it("stabilizes duplicate nested ids before rendering tertiary option lists", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const question = createQuestion({
      id: "question-duplicate-grandchild-1",
      title: "处理角色变体",
      description: "验证重复子项 id 不会再触发 React key 警告。",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "single-group",
          label: "单项处理",
          value: "single-group",
          children: [
            {
              id: "character-hero",
              label: "Hero",
              value: "video:bridge:reference-assets:character:hero",
              children: [
                {
                  id: "project-video-bridge-reference-assets-character-variant-hero-dup",
                  label: "校服",
                  value: "video:bridge:reference-assets:character-variant:hero:dup-1",
                },
                {
                  id: "project-video-bridge-reference-assets-character-variant-hero-dup",
                  label: "战损",
                  value: "video:bridge:reference-assets:character-variant:hero:dup-2",
                },
              ],
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "单项处理" }));
    fireEvent.click(screen.getByRole("button", { name: "Hero" }));

    expect(screen.getByRole("button", { name: "校服" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "战损" })).toBeInTheDocument();
    expect(
      consoleErrorSpy.mock.calls.some(([message]) =>
        String(message).includes("Encountered two children with the same key"),
      ),
    ).toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it("opens the kickoff custom style input in a right-side floating panel", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "video-kickoff-style-question",
      title: "选择画面风格类型",
      description: "先选风格类型，再补充自定义说明。",
      allowCustomInput: false,
      answerKey: "video-kickoff-prefs-style",
      options: [
        {
          id: "style-custom",
          label: "自定义",
          value: "video:kickoff:prefs:style-category:custom",
          children: [
            {
              id: "style-custom-input",
              label: "输入自定义风格说明",
              value: "video:kickoff:prefs:custom-style-open",
              rationale: "会先生成摘要，再继续下一步。",
              childInput: {
                type: "text",
                actionPrefix: "video:kickoff:prefs:custom-style:",
                minLength: 2,
                maxLength: 100,
                placeholder: "输入风格说明",
                buttonLabel: "写入并继续",
                labelTemplate: "自定义风格：{value}",
              },
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.click(screen.getByRole("button", { name: /输入自定义风格说明/ }));

    expect(
      within(screen.getByTestId("nested-secondary-panel")).queryByPlaceholderText("输入风格说明"),
    ).not.toBeInTheDocument();

    const floatingPanel = screen.getByTestId("nested-child-input-panel");
    const input = within(floatingPanel).getByPlaceholderText("输入风格说明");
    fireEvent.change(input, { target: { value: "film noir" } });
    fireEvent.click(within(floatingPanel).getByRole("button", { name: "写入并继续" }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:kickoff:prefs:custom-style:film%20noir",
      "自定义风格：film noir",
    );
  });

  it("hides the step indicator on the first video kickoff popup", () => {
    const question = createQuestion({
      id: "video-kickoff-mode-question",
      title: "先选择视频生成模式",
      allowCustomInput: false,
      answerKey: "video-kickoff-prefs-mode",
      stepIndex: 0,
      totalSteps: 2,
      options: [
        { id: "mode-text", label: "文生视频", value: "video:kickoff:prefs:mode:text-to-video" },
        { id: "mode-image", label: "图生视频", value: "video:kickoff:prefs:mode:image-to-video" },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.queryByText("第 1 / 2 步")).not.toBeInTheDocument();
  });

  it("shows the video mode badge on video workflow panels after the kickoff mode step", () => {
    const baseQuestion = createQuestion({
      id: "video-kickoff-mode-question",
      title: "\u5148\u9009\u62e9\u89c6\u9891\u751f\u6210\u6a21\u5f0f",
      allowCustomInput: false,
      answerKey: "video-kickoff-prefs-mode",
      stepIndex: 0,
      totalSteps: 2,
      options: [
        { id: "mode-text", label: "\u6587\u672c\u6a21\u5f0f", value: "video:kickoff:prefs:mode:text-to-video" },
        { id: "mode-image", label: "\u56fe\u7247\u6a21\u5f0f", value: "video:kickoff:prefs:mode:image-to-video" },
      ],
    });

    const { rerender } = render(
      <ComposerChoicePanel
        question={baseQuestion}
        onSelect={vi.fn()}
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.queryByText("\u6587\u751f\u89c6\u9891")).not.toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={{
          ...baseQuestion,
          id: "video-kickoff-style-question",
          title: "\u9009\u62e9\u753b\u9762\u98ce\u683c\u7c7b\u578b",
          answerKey: "video-kickoff-prefs-style",
          stepIndex: 1,
        }}
        onSelect={vi.fn()}
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("\u6587\u751f\u89c6\u9891")).toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={{
          ...baseQuestion,
          id: "video-generation-question",
          title: "\u751f\u6210\u7247\u6bb5\u89c6\u9891",
          answerKey: "video-generation-panel",
          stepIndex: 1,
          totalSteps: 4,
        }}
        onSelect={vi.fn()}
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("\u6587\u751f\u89c6\u9891")).toBeInTheDocument();
  });

  it("renders compact developer toggles and forwards mode changes", () => {
    const onDevVideoGenerationModeChange = vi.fn();
    const onDevImageViewModeChange = vi.fn();
    const question = createQuestion({
      id: "dev-options-question",
      title: "Dev options",
      allowCustomInput: false,
      options: [{ id: "regular-option", label: "常规项", value: "regular-option" }],
    });

    render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        devMode
        devVideoGenerationMode="text-to-video"
        devImageViewMode="three"
        onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
        onDevImageViewModeChange={onDevImageViewModeChange}
      />,
    );

    expect(screen.getByText("开发者选项")).toBeInTheDocument();
    expect(screen.getByText(/默认文生视频/)).toBeInTheDocument();
    expect(screen.getByText(/默认三视图/)).toBeInTheDocument();

    const videoToggle = screen.getByTestId("dev-video-generation-mode-toggle");
    const imageToggle = screen.getByTestId("dev-image-view-mode-toggle");
    expect(within(videoToggle).getByRole("button", { name: "文生视频" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(imageToggle).getByRole("button", { name: "三视图" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(within(videoToggle).getByRole("button", { name: "图生视频" }));
    fireEvent.click(within(imageToggle).getByRole("button", { name: "单图" }));

    expect(onDevVideoGenerationModeChange).toHaveBeenCalledWith("image-to-video");
    expect(onDevImageViewModeChange).toHaveBeenCalledWith("single");
  });

  it("renders a dismiss button and calls onDismiss when provided", () => {
    const onDismiss = vi.fn();
    const question = createQuestion({
      totalSteps: 1,
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("composer-choice-dismiss"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
