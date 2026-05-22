import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerQuestion } from "@/lib/home-agent/types";
import ComposerChoiceModal from "./ComposerChoiceModal";

function createQuestion(overrides: Partial<ComposerQuestion> = {}): ComposerQuestion {
  return {
    id: "homepage-kickoff-question",
    title: "原创剧本立项",
    description: "请选择创作方式。",
    options: [
      { id: "topic", label: "选题创作", value: "topic" },
      { id: "creative", label: "创意创作", value: "creative" },
    ],
    answerKey: "original-script-kickoff",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    ...overrides,
  };
}

describe("ComposerChoiceModal", () => {
  it("marks the standard workflow popup with stable DOM attributes", () => {
    render(
      <ComposerChoiceModal
        question={createQuestion()}
        onSelect={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-composer-choice-modal", "true");
    expect(dialog).toHaveAttribute("data-composer-question-answer-key", "original-script-kickoff");
    expect(dialog).toHaveAttribute("data-composer-question-id", "homepage-kickoff-question");
    expect(dialog).toHaveTextContent("原创剧本立项");
    expect(dialog).toHaveTextContent("选题创作");
    expect(dialog).toHaveTextContent("创意创作");
  });
});
