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

function getHeaderBackButton(): HTMLButtonElement {
  const button = screen.getAllByRole("button").find((candidate) =>
    Boolean(candidate.querySelector("svg.lucide-chevron-left")),
  );
  if (!button) {
    throw new Error("Expected a header back button to be present.");
  }
  return button as HTMLButtonElement;
}

describe("ComposerChoicePanel", () => {
  it("shows larger right-side status labels with distinct active and inactive colors", () => {
    const question = createQuestion({
      id: "question-status-label-1",
      title: "合规审查",
      description: "状态文案应显示在右侧。",
      answerKey: "script-compliance",
      allowCustomInput: false,
      options: [
        {
          id: "compliance-strictness",
          label: "严格度：标准",
          value: "script:compliance-set-strictness:standard",
          rationale: "标准、严格、极限三档都会持久化保存到当前项目。",
          statusLabel: "已开启对话审查",
          statusTone: "active",
          children: [
            {
              id: "strictness-standard",
              label: "标准",
              value: "script:compliance-set-strictness:standard",
            },
            {
              id: "toggle-dialogue",
              label: "关闭对话审查",
              value: "script:compliance-toggle-dialogue:off",
            },
          ],
        },
        {
          id: "compliance-strictness-closed",
          label: "严格度：标准 2",
          value: "script:compliance-set-strictness:standard:closed",
          rationale: "标准、严格、极限三档都会持久化保存到当前项目。",
          statusLabel: "已关闭对话审查",
          statusTone: "inactive",
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    const activeLabel = screen.getByText("已开启对话审查");
    const activeButton = activeLabel.closest("button");
    expect(activeLabel.className).toContain("text-[12px]");
    expect(activeLabel.className).toContain("text-[#8bb3ff]");
    expect(activeButton?.className).not.toContain("border-[#2a73ff]/40");

    const inactiveLabel = screen.getByText("已关闭对话审查");
    const inactiveButton = inactiveLabel.closest("button");
    expect(inactiveLabel.className).toContain("text-[12px]");
    expect(inactiveLabel.className).toContain("text-slate-300");
    expect(inactiveButton?.className).not.toContain("border-[#2a73ff]/40");
  });

  it("renders colored right-side status badges for compliance counts", () => {
    const question = createQuestion({
      id: "question-status-badges-1",
      title: "合规审查",
      description: "风险数量应显示在右侧。",
      answerKey: "script-compliance",
      allowCustomInput: false,
      options: [
        {
          id: "compliance-run",
          label: "重新完整审查",
          value: "script:compliance-run:text",
          rationale: "保留当前状态并重新检查。",
          statusBadges: [
            { label: "红线", value: 2, tone: "danger" },
            { label: "高风险", value: 3, tone: "warning" },
            { label: "提示", value: 1, tone: "notice" },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getByText("红线 2").className).toContain("text-red-300");
    expect(screen.getByText("高风险 3").className).toContain("text-orange-300");
    expect(screen.getByText("提示 1").className).toContain("text-yellow-300");
  });

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

  it("uses single-panel drilldown navigation for episode-stage submenu choices", () => {
    const question = createQuestion({
      id: "question-script-episode-1",
      title: "选择正文推进方式",
      description: "正文阶段切换到子菜单后应在同一面板内显示。",
      options: [
        {
          id: "episodes-review-group",
          label: "质量审查",
          value: "script:episode-review-group",
          children: [
            { id: "episodes-review-batch", label: "批量质量审查", value: "script:episode-review" },
            { id: "episodes-review-single", label: "质量自检", value: "script:episode-review:single" },
          ],
        },
        {
          id: "episodes-compliance",
          label: "进入合规审查",
          value: "script:step-enter-compliance",
        },
      ],
      allowCustomInput: false,
      answerKey: "script-episode",
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "返回上一步" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "质量审查" }));

    expect(screen.queryByTestId("nested-secondary-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回上一步" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量质量审查" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入合规审查" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回上一步" }));

    expect(screen.getByRole("button", { name: "质量审查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入合规审查" })).toBeInTheDocument();
  });

  it("returns to the top-level menu after selecting a strictness leaf option", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-compliance-strictness-1",
      title: "合规审查",
      description: "严格度子项选中后应返回主菜单。",
      answerKey: "script-compliance",
      allowCustomInput: false,
      options: [
        {
          id: "compliance-strictness",
          label: "严格度：标准",
          value: "script:compliance-set-strictness:standard",
          children: [
            { id: "strictness-standard", label: "标准", value: "script:compliance-set-strictness:standard" },
            { id: "strictness-strict", label: "严格", value: "script:compliance-set-strictness:strict" },
            { id: "strictness-extreme", label: "极限", value: "script:compliance-set-strictness:extreme" },
          ],
        },
        {
          id: "compliance-ops",
          label: "工作台快捷操作",
          value: "script:compliance-auto-adjust",
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "严格度：标准" }));
    expect(screen.getByRole("button", { name: "极限" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "工作台快捷操作" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "严格" }));

    expect(onSelect).toHaveBeenCalledWith(
      "script:compliance-set-strictness:strict",
      "严格",
    );
    expect(screen.queryByRole("button", { name: "极限" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "工作台快捷操作" })).toBeInTheDocument();
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

  it("uses single-panel drilldown navigation for storyboard submenu choices", () => {
    const onSelect = vi.fn();
    const onBack = vi.fn();
    const question = createQuestion({
      id: "question-storyboard-drilldown-1",
      title: "Storyboard stage",
      description: "Storyboard submenu should stay in the same panel.",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "single-group",
          label: "Single actions",
          value: "single-group",
          children: [
            {
              id: "storyboard-list",
              label: "Storyboard list",
              value: "video:bridge:storyboard-frames:list",
              children: [
                {
                  id: "segment-a",
                  label: "Segment A",
                  value: "video:bridge:storyboard-frames:group:A",
                  children: [
                    {
                      id: "segment-a-bulk",
                      label: "Generate segment",
                      value: "video:bridge:storyboard-frames:segment:A",
                      rationale: "Generates the currently eligible shots in this segment.",
                    },
                    {
                      id: "segment-a-shot-2",
                      label: "Generate shot 2",
                      value: "video:bridge:storyboard-frame:scene:scene-blocked",
                      disabled: true,
                      rationale: "Missing required Street reference.",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "go-video",
          label: "Go to video",
          value: "video:step:video",
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={onSelect} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Single actions" }));

    expect(screen.queryByTestId("nested-secondary-panel")).not.toBeInTheDocument();
    const headerBackButton = getHeaderBackButton();
    expect(headerBackButton).toBeInTheDocument();
    expect(headerBackButton.className).toContain("h-8");
    expect(headerBackButton.className).toContain("w-8");
    expect(screen.getByRole("button", { name: "Storyboard list" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to video" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Storyboard list" }));
    fireEvent.click(screen.getByRole("button", { name: "Segment A" }));

    expect(screen.queryByTestId("nested-tertiary-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nested-quaternary-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate segment/ })).toBeInTheDocument();
    expect(screen.getAllByText("Missing required Street reference.").length).toBeGreaterThan(0);

    fireEvent.click(headerBackButton);

    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Segment A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate segment" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Segment A" }));
    fireEvent.click(screen.getByRole("button", { name: /Generate segment/ }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:bridge:storyboard-frames:segment:A",
      "Generate segment",
    );

    fireEvent.click(getHeaderBackButton());

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens role asset actions in a right-side submenu without replacing the current single-panel list", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-single-panel-floating-assets-1",
      title: "Role assets",
      description: "Single asset actions should stay in place and open a side panel.",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "single-assets",
          label: "Single assets",
          value: "single-assets",
          children: [
            {
              id: "character-batch",
              label: "Refresh all characters",
              value: "video:bridge:reference-assets:characters",
              menuSection: "batch",
            },
            {
              id: "character-hero",
              label: "Hero",
              value: "video:bridge:reference-assets:character:hero",
              menuSection: "single",
              singlePanelPresentation: "floating-submenu",
              children: [
                {
                  id: "character-hero-main",
                  label: "Generate hero image",
                  value: "video:bridge:reference-assets:character-main:hero",
                  menuSection: "main-image",
                  rationale:
                    "角色主参考图已生成，可继续重新生成。进入后可继续选择更多操作。",
                },
                {
                  id: "character-hero-audio",
                  label: "Upload hero audio reference",
                  value: "video:bridge:reference-audio:character:hero",
                  menuSection: "audio",
                },
                {
                  id: "character-hero-audio-preset",
                  label: "Use preset reference audio",
                  value: "video:bridge:reference-audio:preset-picker:character:hero",
                  menuSection: "audio",
                },
                {
                  id: "character-hero-variant",
                  label: "Generate hero variant",
                  value: "video:bridge:reference-assets:character-variant:hero:1",
                  menuSection: "variants",
                },
              ],
            },
            {
              id: "character-sidekick",
              label: "Sidekick",
              value: "video:bridge:reference-assets:character:sidekick",
              menuSection: "single",
              singlePanelPresentation: "floating-submenu",
              children: [
                {
                  id: "character-sidekick-main",
                  label: "Generate sidekick image",
                  value: "video:bridge:reference-assets:character-main:sidekick",
                },
              ],
            },
          ],
        },
      ],
    });

    const { container } = render(<ComposerChoicePanel question={question} onSelect={onSelect} />);

    const panel = container.querySelector("[data-choice-mode='card']");
    expect(panel?.className).toContain("max-h-[min(48dvh,560px)]");
    expect(panel?.className).toContain("overflow-visible");
    const primaryOptionList =
      screen.queryByTestId("nested-primary-option-list") ??
      screen.getByTestId("genre-primary-option-list");
    expect(primaryOptionList.parentElement?.parentElement?.className).toContain(
      "overflow-visible",
    );

    fireEvent.click(screen.getByRole("button", { name: "Single assets" }));
    fireEvent.click(screen.getByRole("button", { name: "Hero" }));

    expect(screen.getByRole("button", { name: "Refresh all characters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hero" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidekick" })).toBeInTheDocument();
    expect(screen.getByTestId("single-panel-floating-submenu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate hero image/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload hero audio reference" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use preset reference audio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate hero variant" })).toBeInTheDocument();
    expect(screen.queryByTestId("nested-tertiary-panel")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-testid='choice-option-section-divider']")).toHaveLength(3);
    expect(screen.getByText("主图已生成，可重生")).toBeInTheDocument();
    expect(
      container
        .querySelector("[data-testid='choice-option-section-divider']")
        ?.className,
    ).toContain("bg-white/[0.2]");

    fireEvent.click(screen.getByRole("button", { name: "Use preset reference audio" }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:bridge:reference-audio:preset-picker:character:hero",
      "Use preset reference audio",
    );
  });

  it("renders section dividers for downstream workflow panels and nested submenu action types", () => {
    const question = createQuestion({
      id: "question-workflow-divider-1",
      title: "Video workflow",
      description: "Later workflow steps should separate batch and single actions clearly.",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "workflow-bulk",
          label: "Batch actions",
          value: "video:panel:video-bridge-panel-bulk",
          menuSection: "batch",
          children: [
            {
              id: "storyboard-all",
              label: "Generate episode storyboard",
              value: "video:bridge:storyboard-frames:episode:1",
              menuSection: "batch",
            },
          ],
        },
        {
          id: "workflow-single",
          label: "Single actions",
          value: "video:panel:video-bridge-panel-single",
          menuSection: "single",
          children: [
            {
              id: "segment-a",
              label: "Segment A",
              value: "video:generate:group:A",
              menuSection: "single",
              children: [
                {
                  id: "segment-a-batch",
                  label: "Generate segment video",
                  value: "video:generate:segment-video:A",
                  menuSection: "batch",
                },
                {
                  id: "segment-a-scene-1",
                  label: "Generate shot 1",
                  value: "video:generate:scene:scene-1",
                  menuSection: "single",
                },
              ],
            },
          ],
        },
        {
          id: "workflow-automation",
          label: "Automation",
          value: "video:panel:video-bridge-panel-automation",
          children: [
            {
              id: "switch-step",
              label: "Switch step",
              value: "video:step:video",
            },
          ],
        },
      ],
    });

    const { container } = render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(container.querySelectorAll("[data-testid='choice-option-section-divider']")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Single actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Segment A" }));

    expect(screen.getByRole("button", { name: "Generate segment video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate shot 1" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-testid='choice-option-section-divider']")).toHaveLength(1);
  });

  it("uses single-panel drilldown navigation for review-stage export choices", () => {
    const question = createQuestion({
      id: "question-review-drilldown-1",
      title: "Review stage",
      description: "Export submenu should stay in the same panel.",
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
              value: "open-bundle",
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Automation" }));

    expect(screen.queryByTestId("nested-secondary-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Automation" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(screen.queryByTestId("nested-tertiary-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export to NLE" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open bundle" })).not.toBeInTheDocument();

    fireEvent.click(getHeaderBackButton());

    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open bundle" })).toBeInTheDocument();
  });

  it("uses single-panel drilldown navigation for video-generation submenu choices", () => {
    const question = createQuestion({
      id: "question-video-generation-drilldown-1",
      title: "Video generation",
      description: "Generation submenu should stay in the same panel.",
      allowCustomInput: false,
      answerKey: "video-generation-panel",
      options: [
        {
          id: "generation-batch",
          label: "Batch generate",
          value: "video:generate:batch",
          children: [
            { id: "generation-first", label: "Generate first batch", value: "video:generate:first" },
            { id: "generation-failed", label: "Retry failed", value: "video:generate:failed" },
          ],
        },
        {
          id: "generation-preview",
          label: "Go to preview",
          value: "video:step:preview",
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Batch generate" }));

    expect(screen.queryByTestId("nested-secondary-panel")).not.toBeInTheDocument();
    expect(getHeaderBackButton()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate first batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to preview" })).not.toBeInTheDocument();

    fireEvent.click(getHeaderBackButton());

    expect(screen.getByRole("button", { name: "Batch generate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to preview" })).toBeInTheDocument();
  });

  it("uses single-panel drilldown navigation for character preset-audio picker choices", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-character-preset-audio-picker-1",
      title: "Choose preset reference audio",
      description: "Preset audio categories should stay in the same shared panel.",
      allowCustomInput: false,
      answerKey: "video-bridge-preset-audio-panel",
      options: [
        {
          id: "preset-group-basic",
          label: "Basic presets (1)",
          value: "video:bridge:reference-audio:preset-group:basic",
          children: [
            {
              id: "preset-category-loli",
              label: "Female / loli bright",
              value: "video:bridge:reference-audio:preset-category:loli",
              children: [
                {
                  id: "preset-entry-paimon",
                  label: "01. Paimon 5.4s",
                  value:
                    "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Cpresets%5Cpaimon.wav&name=paimon.wav",
                },
              ],
            },
          ],
        },
        {
          id: "preset-group-status",
          label: "Status presets (1)",
          value: "video:bridge:reference-audio:preset-group:status",
        },
      ],
    });

    const { container } = render(
      <ComposerChoicePanel question={question} onSelect={onSelect} />,
    );
    const panel = container.querySelector("[data-choice-mode='card']");
    expect(panel?.className).toContain("max-h-[50vh]");
    expect(panel?.className).toContain("overflow-hidden");

    const optionList = screen.getByTestId("genre-primary-option-list");
    expect(optionList.className).toContain("overflow-y-auto");
    expect(optionList.parentElement?.className).toContain("overflow-hidden");
    Object.defineProperty(optionList, "clientHeight", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(optionList, "scrollHeight", {
      configurable: true,
      value: 680,
    });
    Object.defineProperty(optionList, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    fireEvent.wheel(optionList, { deltaY: 120 });

    expect(optionList.scrollTop).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: "Basic presets (1)" }));

    expect(screen.getByRole("button", { name: "Female / loli bright" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Status presets (1)" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Female / loli bright" }));

    expect(screen.getByRole("button", { name: "01. Paimon 5.4s" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "01. Paimon 5.4s" }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Cpresets%5Cpaimon.wav&name=paimon.wav",
      "01. Paimon 5.4s",
    );
  });

  it("uses the back button to unwind preset-audio drilldown before leaving the picker", () => {
    const onBack = vi.fn();
    const question = createQuestion({
      id: "question-character-preset-audio-picker-back-1",
      title: "Choose preset reference audio",
      description: "The preset-audio picker should step back inside the panel before exiting it.",
      allowCustomInput: false,
      answerKey: "video-bridge-preset-audio-panel",
      options: [
        {
          id: "preset-group-basic",
          label: "Basic presets (1)",
          value: "video:bridge:reference-audio:preset-group:basic",
          children: [
            {
              id: "preset-category-loli",
              label: "Female / loli bright",
              value: "video:bridge:reference-audio:preset-category:loli",
              children: [
                {
                  id: "preset-entry-paimon",
                  label: "01. Paimon 5.4s",
                  value:
                    "video:bridge:reference-audio:preset-bind:character:char-1?path=E%3A%5Cpresets%5Cpaimon.wav&name=paimon.wav",
                },
              ],
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: "Basic presets (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Female / loli bright" }));

    expect(screen.getByRole("button", { name: "01. Paimon 5.4s" })).toBeInTheDocument();

    fireEvent.click(getHeaderBackButton());

    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Female / loli bright" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "01. Paimon 5.4s" })).not.toBeInTheDocument();

    fireEvent.click(getHeaderBackButton());

    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Basic presets (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Female / loli bright" })).not.toBeInTheDocument();

    fireEvent.click(getHeaderBackButton());

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("resets drilldown state when a video step switch reuses the same panel id with new options", () => {
    const baseQuestion = createQuestion({
      id: "video-bridge-panel-video-project-1",
      title: "角色与场景",
      description: "Step two panel",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      stepIndex: 1,
      totalSteps: 4,
      options: [
        {
          id: "single-actions",
          label: "单项处理",
          value: "video:panel:video-bridge-panel-single",
          children: [
            {
              id: "single-character-1",
              label: "重生成陆沉",
              value: "video:bridge:reference-assets:character:char-1",
            },
          ],
        },
        {
          id: "switch-step",
          label: "步骤切换/导出",
          value: "video:panel:video-bridge-panel-automation",
        },
      ],
    });

    const { rerender } = render(
      <ComposerChoicePanel question={baseQuestion} onSelect={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "单项处理" }));
    expect(screen.getByRole("button", { name: "重生成陆沉" })).toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={{
          ...baseQuestion,
          title: "分镜图生成",
          stepIndex: 2,
          options: [
            {
              id: "batch-storyboards",
              label: "批量执行",
              value: "video:panel:video-bridge-panel-bulk",
              children: [
                {
                  id: "batch-storyboards-all",
                  label: "生成整批分镜图",
                  value: "video:bridge:storyboard-frames:batch",
                },
              ],
            },
            {
              id: "switch-step-video",
              label: "步骤切换/导出",
              value: "video:panel:video-bridge-panel-automation",
            },
          ],
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "重生成陆沉" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量执行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "步骤切换/导出" })).toBeInTheDocument();
  });

  it("keeps deeply nested episode segment prompt groups reachable in single-panel drilldown mode", () => {
    const onSelect = vi.fn();
    const question = createQuestion({
      id: "question-segment-prompt-episode-1",
      title: "Segment prompt generation",
      description: "Episode groups should still expand after passing through bulk and prompt-mode wrappers.",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      options: [
        {
          id: "bulk-actions",
          label: "Bulk actions",
          value: "video:panel:video-bridge-panel-bulk",
          children: [
            {
              id: "prompt-modes",
              label: "Video prompt modes",
              value: "video:bridge:prompts",
              children: [
                {
                  id: "segment-prompts",
                  label: "Segment prompts",
                  value: "video:bridge:prompts:segment",
                  children: [
                    {
                      id: "segment-prompts-batch",
                      label: "Batch generate segments",
                      value: "video:bridge:prompts:segment:batch",
                    },
                    {
                      id: "segment-prompts-episode-group-1",
                      label: "Episode 1 (4/4 ready)",
                      value: "video:panel:bridge:prompts:segment:ep-group:1",
                      devOnly: true,
                      children: [
                        {
                          id: "segment-prompts-episode-1",
                          label: "Regenerate episode 1 prompts (4)",
                          value: "video:bridge:prompts:segment:episode:1",
                          devOnly: true,
                        },
                        {
                          id: "segment-prompts-label-1-1",
                          label: "Regenerate segment 1-1",
                          value: "video:bridge:prompts:segment:label:1-1",
                          devOnly: true,
                        },
                        {
                          id: "segment-prompts-label-1-2",
                          label: "Regenerate segment 1-2",
                          value: "video:bridge:prompts:segment:label:1-2",
                          devOnly: true,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={onSelect} devMode />);

    fireEvent.click(screen.getByRole("button", { name: "Bulk actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Video prompt modes" }));
    fireEvent.click(screen.getByRole("button", { name: "Segment prompts" }));
    expect(screen.getByRole("button", { name: "Episode 1 (4/4 ready)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Episode 1 (4/4 ready)" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Regenerate episode 1 prompts (4)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate segment 1-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate segment 1-2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batch generate segments" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate segment 1-1" }));

    expect(onSelect).toHaveBeenCalledWith(
      "video:bridge:prompts:segment:label:1-1",
      "Regenerate segment 1-1",
    );
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

  it.skip("opens the kickoff custom style input in a right-side floating panel", () => {
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

  it.skip("surfaces the bottom custom-input hint instead of a legacy custom style branch", () => {
    const question = createQuestion({
      id: "video-kickoff-style-question-inline-custom",
      title: "选择画面风格类型",
      description: "直接选择预设风格，或在底部输入自定义风格说明。",
      allowCustomInput: true,
      answerKey: "video-kickoff-prefs-style",
      options: [
        {
          id: "style-live-action",
          label: "写实类",
          value: "video:kickoff:prefs:style-category:live-action",
          children: [
            {
              id: "style-live-action-noir",
              label: "电影黑色质感",
              value: "video:kickoff:prefs:style-preset:film-noir",
            },
          ],
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "自定义" })).not.toBeInTheDocument();
    expect(screen.getByText("也可在底部输入框填写自定义答案，不必受预设选项限制。")).toBeInTheDocument();
  });

  it("hides numeric custom branches and replaces them with the shared composer hint", () => {
    const question = createQuestion({
      id: "video-analyze-duration-question",
      title: "请选择单集时长",
      description: "时长会影响镜头拆解的颗粒度和时长分配。",
      answerKey: "video-analyze-duration",
      allowCustomInput: false,
      options: [
        { id: "duration-60", label: "60 秒", value: "video:bridge:analyze:dur:60" },
        { id: "duration-90", label: "90 秒", value: "video:bridge:analyze:dur:90" },
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
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "自定义" })).not.toBeInTheDocument();
    expect(
      screen.getByText("也可在底部输入框直接填写自定义数值后发送。"),
    ).toBeInTheDocument();
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

  it("keeps the video mode badge hidden on the post-breakdown mode chooser until the mode is confirmed", () => {
    const question = createQuestion({
      id: "video-post-analyze-mode-question",
      title: "\u9009\u62e9\u89c6\u9891\u751f\u6210\u6a21\u5f0f",
      allowCustomInput: false,
      answerKey: "video-post-analyze-mode",
      stepIndex: 0,
      totalSteps: 2,
      options: [
        { id: "mode-text", label: "\u6587\u751f\u89c6\u9891", value: "video:kickoff:prefs:mode:text-to-video" },
        { id: "mode-image", label: "\u56fe\u751f\u89c6\u9891", value: "video:kickoff:prefs:mode:image-to-video" },
      ],
    });

    render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByRole("button", { name: "\u6587\u751f\u89c6\u9891" })).toBeInTheDocument();
    expect(screen.getAllByText("\u6587\u751f\u89c6\u9891")).toHaveLength(1);
    expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument();
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
        showVideoModeBadge={false}
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
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("\u6587\u751f\u89c6\u9891")).toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={{
          ...baseQuestion,
          id: "video-bridge-question",
          title: "继续补平台与镜头偏好",
          answerKey: "video-bridge-panel",
          stepIndex: 0,
          totalSteps: 4,
          options: [{ id: "bridge-entities", label: "整理角色和场景资产", value: "video:bridge:entities" }],
        }}
        onSelect={vi.fn()}
        showVideoModeBadge
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
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("\u6587\u751f\u89c6\u9891")).toBeInTheDocument();
  });

  it("keeps the video mode badge hidden on pre-kickoff analysis popups", () => {
    const question = createQuestion({
      id: "video-analyze-pace-question",
      title: "请选择视频节奏",
      allowCustomInput: false,
      answerKey: "video-analyze-pace",
      stepIndex: 1,
      totalSteps: 2,
      options: [
        { id: "pace-slow", label: "慢速", value: "video:bridge:analyze:pace:slow:90" },
        { id: "pace-medium", label: "中等", value: "video:bridge:analyze:pace:medium:90" },
      ],
    });

    render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.queryByText("文生视频")).not.toBeInTheDocument();
  });

  it("shows the video mode badge on post-kickoff bridge analysis panels", () => {
    const question = createQuestion({
      id: "video-bridge-analyze-question",
      title: "完成脚本拆解",
      allowCustomInput: false,
      answerKey: "video-bridge-panel",
      stepIndex: 0,
      totalSteps: 4,
      options: [{ id: "bridge-analyze", label: "完成脚本拆解", value: "video:bridge:analyze" }],
    });

    render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("文生视频")).toBeInTheDocument();
  });

  it("shows the video mode badge on the final review/export panel", () => {
    const question = createQuestion({
      id: "review-stage-panel-video-project-1",
      title: "进入预览与导出阶段",
      allowCustomInput: false,
      answerKey: "review-stage-panel",
      stepIndex: 3,
      totalSteps: 4,
      options: [
        {
          id: "review-stage-panel-automation",
          label: "步骤切换/导出",
          value: "video:panel:review-stage-panel-automation",
        },
      ],
    });

    const { rerender } = render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("文生视频")).toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="image-to-video"
      />,
    );

    expect(screen.getByText("图生视频")).toBeInTheDocument();
  });

  it("uses larger badge, step pill, and collapse controls on workflow panels", () => {
    const question = createQuestion({
      id: "video-generation-question",
      title: "\u751f\u6210\u7247\u6bb5\u89c6\u9891",
      allowCustomInput: false,
      answerKey: "video-generation-panel",
      stepIndex: 1,
      totalSteps: 4,
      options: [{ id: "go", label: "缁х画", value: "video:step:video" }],
    });

    render(
      <ComposerChoicePanel
        question={question}
        onSelect={vi.fn()}
        showVideoModeBadge
        devVideoGenerationMode="text-to-video"
      />,
    );

    expect(screen.getByText("文生视频")).toHaveClass("px-2.5", "py-1", "text-[11px]");
    expect(screen.getByText(/2\s*\/\s*4/)).toHaveClass("px-2.5", "py-1", "text-[11px]");
    expect(screen.getByRole("button", { name: `收起选择窗：${question.title}` })).toHaveClass("h-7", "w-7");
  });

  it("renders the phase and total-step pills inline for preflight panels without substep pills", () => {
    const question = createQuestion({
      id: "preflight-question",
      title: "视频导出策略",
      allowCustomInput: false,
      answerKey: "full-auto-preflight:videoExport",
      totalSteps: 12,
      statusBadges: [
        { label: "全自动", value: "预览导出", tone: "default" },
        { label: "视频模式", value: "图生视频", tone: "default" },
        { label: "路线", value: "AI 自动处理导出", tone: "default" },
        { label: "总步骤", value: "7/7", tone: "default" },
        { label: "子步骤", value: "1/2", tone: "warning" },
      ],
      options: [{ id: "export-all", label: "全部导出素材包", value: "video:export:all", drilldownHint: true }],
    });

    const { container } = render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getByText("预览导出")).toBeInTheDocument();
    expect(screen.getByText("图生视频")).toBeInTheDocument();
    expect(screen.getByText("AI 自动处理导出")).toBeInTheDocument();
    expect(screen.getByText("总步骤")).toBeInTheDocument();
    expect(screen.getByText("7/7")).toBeInTheDocument();
    expect(screen.queryByText("子步骤")).not.toBeInTheDocument();
    expect(container.querySelector("svg.lucide-chevron-right")).toBeTruthy();
  });

  it("keeps preflight badges on a single right-aligned row and differentiates video-mode badge colors", () => {
    const question = createQuestion({
      id: "preflight-video-mode-badge-question",
      title: "角色与场景路线",
      allowCustomInput: false,
      answerKey: "full-auto-preflight:referenceAssets",
      totalSteps: 10,
      statusBadges: [
        { label: "全自动", value: "进入视频工作流", tone: "default" },
        { label: "视频模式", value: "文生视频", tone: "success" },
        { label: "路线", value: "角色与场景路线", tone: "default" },
        { label: "总步骤", value: "8/10", tone: "default" },
        { label: "子步骤", value: "1/2", tone: "warning" },
      ],
      options: [{ id: "reference-full", label: "智能补齐全部参考资产", value: "video:bridge:reference-assets:full" }],
    });

    const { rerender } = render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getByText("文生视频")).toHaveClass("text-sky-200");
    const badgeRowClassName = screen.getByText("文生视频").closest("div")?.parentElement?.className ?? "";
    expect(badgeRowClassName).toContain("flex-nowrap");
    expect(badgeRowClassName).toContain("justify-end");
    expect(badgeRowClassName).toContain("items-center");
    expect(badgeRowClassName).toContain("overflow-hidden");
    expect(badgeRowClassName).toContain("whitespace-nowrap");
    expect(badgeRowClassName).not.toContain("pr-24");
    expect(screen.getAllByText("角色与场景路线")).toHaveLength(2);
    expect(screen.queryByText("子步骤")).not.toBeInTheDocument();

    rerender(
      <ComposerChoicePanel
        question={{
          ...question,
          statusBadges: [
            { label: "全自动", value: "进入视频工作流", tone: "default" },
            { label: "视频模式", value: "图生视频", tone: "notice" },
            { label: "路线", value: "角色与场景路线", tone: "default" },
            { label: "总步骤", value: "8/11", tone: "default" },
            { label: "子步骤", value: "1/1", tone: "warning" },
          ],
        }}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("图生视频")).toHaveClass("text-violet-200");
  });

  it("shows a reset action for full-auto preflight panels and invokes it", () => {
    const onReset = vi.fn();
    const question = createQuestion({
      id: "preflight-reset-question",
      title: "角色与场景路线",
      allowCustomInput: false,
      answerKey: "full-auto-preflight:referenceAssets",
      totalSteps: 10,
      statusBadges: [
        { label: "全自动", value: "进入视频工作流", tone: "default" },
        { label: "视频模式", value: "文生视频", tone: "success" },
        { label: "路线", value: "角色与场景路线", tone: "default" },
        { label: "总步骤", value: "8/10", tone: "default" },
        { label: "子步骤", value: "1/2", tone: "warning" },
      ],
      options: [{ id: "reference-full", label: "智能补齐全部参考资产", value: "video:bridge:reference-assets:full" }],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onReset={onReset} />);

    fireEvent.click(screen.getByRole("button", { name: "重置到第一个选项" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("hides the substep pill for non-branch full-auto panels while keeping the phase pill", () => {
    const question = createQuestion({
      id: "preflight-major-only-question",
      title: "选择画面风格类型",
      allowCustomInput: true,
      answerKey: "full-auto-preflight:videoStyle",
      totalSteps: 9,
      statusBadges: [
        { label: "全自动", value: "进入视频工作流", tone: "default" },
        { label: "总步骤", value: "5/9", tone: "default" },
      ],
      options: [{ id: "style-live-action", label: "真人影视", value: "video:kickoff:prefs:style-preset:live-action" }],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getByText("进入视频工作流")).toBeInTheDocument();
    expect(screen.getByText("总步骤")).toBeInTheDocument();
    expect(screen.getByText("5/9")).toBeInTheDocument();
    expect(screen.queryByText("子步骤")).not.toBeInTheDocument();
  });

  it("suppresses selected borders and checkmarks for full-auto preflight options", () => {
    const { container } = render(
      <ComposerChoicePanel
        question={createQuestion({
          id: "preflight-selected-appearance-question",
          title: "视频生成模式",
          allowCustomInput: false,
          answerKey: "full-auto-preflight:videoMode",
          options: [
            {
              id: "mode-text",
              label: "文生视频",
              value: "video:kickoff:prefs:mode:text-to-video",
            },
            {
              id: "mode-image",
              label: "图生视频",
              value: "video:kickoff:prefs:mode:image-to-video",
              selected: true,
            },
          ],
        })}
        onSelect={vi.fn()}
      />,
    );

    const selectedOption = screen.getByRole("button", { name: /图生视频/ });
    expect(selectedOption.className).not.toContain("border-[#2a73ff]/40");
    expect(selectedOption.className).not.toContain("bg-[#0f62fe]/16");
    expect(container.querySelector("svg.lucide-check")).toBeNull();
  });

  it("suppresses selected borders and checkmarks for the post-breakdown mode chooser", () => {
    const { container } = render(
      <ComposerChoicePanel
        question={createQuestion({
          id: "video-post-analyze-mode-question",
          title: "选择视频生成模式",
          allowCustomInput: false,
          answerKey: "video-post-analyze-mode",
          options: [
            {
              id: "mode-text",
              label: "文生视频",
              value: "video:kickoff:prefs:mode:text-to-video",
            },
            {
              id: "mode-image",
              label: "图生视频",
              value: "video:kickoff:prefs:mode:image-to-video",
              selected: true,
            },
          ],
        })}
        onSelect={vi.fn()}
        showVideoModeBadge={false}
        devVideoGenerationMode="text-to-video"
      />,
    );

    const selectedOption = screen.getByRole("button", { name: /图生视频/ });
    expect(selectedOption.className).not.toContain("border-[#2a73ff]/40");
    expect(selectedOption.className).not.toContain("bg-[#0f62fe]/16");
    expect(container.querySelector("svg.lucide-check")).toBeNull();
  });

  it("shows drilldown arrows for branch-like card options", () => {
    const { container } = render(
      <ComposerChoicePanel
        question={createQuestion({
          id: "preflight-drilldown-question",
          title: "合规审查模式",
          allowCustomInput: false,
          answerKey: "full-auto-preflight:complianceReview",
          totalSteps: 9,
          options: [
            {
              id: "compliance-text",
              label: "文本合规审查",
              value: "script:compliance-run:text",
              drilldownHint: true,
            },
            {
              id: "compliance-skip",
              label: "跳过合规审查",
              value: "script:skip-compliance-review",
            },
          ],
        })}
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("svg.lucide-chevron-right").length).toBeGreaterThan(0);
  });

  it("renders the developer video toggle and no longer shows the image view toggle", () => {
    const onDevVideoGenerationModeChange = vi.fn();
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
        onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
      />,
    );

    expect(screen.getByText("开发者选项")).toBeInTheDocument();
    expect(screen.getByText(/默认文生视频/)).toBeInTheDocument();

    const videoToggle = screen.getByTestId("dev-video-generation-mode-toggle");
    expect(within(videoToggle).getByRole("button", { name: "文生视频" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByTestId("dev-image-view-mode-toggle")).not.toBeInTheDocument();

    fireEvent.click(within(videoToggle).getByRole("button", { name: "图生视频" }));

    expect(onDevVideoGenerationModeChange).toHaveBeenCalledWith("image-to-video");
  });


  it("does not render the global dismiss button even when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    const question = createQuestion({
      totalSteps: 1,
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} onDismiss={onDismiss} />);

    expect(screen.getByRole("button", { name: "关闭选择窗" })).toHaveClass("hidden");
    expect(screen.getByTestId("composer-choice-dismiss")).toHaveClass("hidden");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("makes long card option lists scrollable without stretching the whole panel", () => {
    const question = createQuestion({
      id: "question-scrollable-card-list-1",
      options: Array.from({ length: 6 }, (_, index) => ({
        id: `scroll-option-${index + 1}`,
        label: `生成镜头 ${index + 1}`,
        value: `generate-shot-${index + 1}`,
        rationale: `这是第 ${index + 1} 个选项，用来验证选项过多时中间列表会进入纵向滚动。`,
      })),
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    const optionList = screen.getByTestId("composer-choice-option-list");
    expect(optionList.className).toContain("overflow-y-auto");
    expect(optionList.className).toContain("max-h-[min(44vh,360px)]");
  });

  it("keeps nested option menus inside the panel height and scrolls the option list", () => {
    const question = createQuestion({
      id: "question-scrollable-nested-list-1",
      options: Array.from({ length: 8 }, (_, index) => ({
        id: `nested-scroll-option-${index + 1}`,
        label: `重生成角色 ${index + 1}`,
        value: `regen-character-${index + 1}`,
        rationale: `角色主参考图已就绪，识别到 ${index + 1} 个角色变体，可继续逐项处理。`,
        children: [
          {
            id: `nested-scroll-option-${index + 1}-child`,
            label: "继续处理",
            value: `regen-character-${index + 1}:continue`,
          },
        ],
      })),
    });

    const { container } = render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    const panel = container.firstElementChild as HTMLElement | null;
    expect(panel?.className).toContain("max-h-[min(48dvh,560px)]");
    expect(panel?.className).toContain("overflow-visible");

    const optionList = screen.getByTestId("nested-primary-option-list");
    expect(optionList.className).toContain("overflow-y-auto");
    expect(optionList.className).toContain("min-h-0");
    expect(optionList.parentElement?.parentElement?.className).toContain(
      "overflow-visible",
    );
  });

  it("shows a single compact summary for disabled options", () => {
    const question = createQuestion({
      id: "question-disabled-summary-1",
      options: [
        {
          id: "missing-assets",
          label: "生成镜头 10 / 1-4 · 陆家餐厅",
          value: "generate-shot-10",
          disabled: true,
          rationale: "缺失必要素材：角色主参考图《陆幸沉》；场景主参考图《陆家餐厅》",
        },
      ],
    });

    render(<ComposerChoicePanel question={question} onSelect={vi.fn()} />);

    expect(screen.getAllByText("缺素材：角色主参考图、场景主参考图")).toHaveLength(1);
    expect(screen.queryByText("缺失必要素材：角色主参考图《陆幸沉》；场景主参考图《陆家餐厅》")).not.toBeInTheDocument();
  });

});
