import { describe, expect, it } from "vitest";
import type { ComposerQuestion, ConversationProjectSnapshot } from "@/lib/home-agent/types";
import { buildProjectSuggestionKey } from "./home-agent-session-utils";

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
