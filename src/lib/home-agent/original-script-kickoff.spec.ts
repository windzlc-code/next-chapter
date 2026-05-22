import { describe, expect, it } from "vitest";
import type { HomeAgentMessage } from "@/lib/home-agent/types";
import type { StudioQuestionState } from "@/lib/home-agent/types";
import {
  buildOriginalScriptKickoffBlueprintRequests,
  rewindOriginalScriptKickoffMessages,
  shouldTreatOriginalScriptKickoffInputAsAnswer,
} from "./original-script-kickoff";

function message(role: HomeAgentMessage["role"], content: string): HomeAgentMessage {
  return {
    id: `${role}-${content}`,
    role,
    content,
    createdAt: "2026-04-07T00:00:00.000Z",
    status: "complete",
  };
}

function createKickoffQState(params: {
  step: string;
  title: string;
  header: string;
  options?: Array<{ label: string; value: string }>;
}): StudioQuestionState {
  return {
    source: "deferred",
    request: {
      id: `original-script-kickoff:test-flow:${params.step}`,
      title: params.title,
      description: params.title,
      allowCustomInput: true,
      submissionMode: "immediate",
      questions: [
        {
          question: params.title,
          header: params.header,
          multiSelect: false,
          options: params.options ?? [],
        },
      ],
    },
    currentIndex: 0,
    answers: {},
    displayAnswers: {},
  };
}

describe("rewindOriginalScriptKickoffMessages", () => {
  it("removes the previous kickoff answer bubble and the trailing assistant prompt together", () => {
    const messages: HomeAgentMessage[] = [
      message("assistant", "我们先按传统创作面板把原创剧本立项定下来。"),
      message("user", "创作方式：选题创作"),
      message("assistant", "这次原创剧本主要想打哪个目标市场？"),
      message("user", "目标市场：国内（中文）"),
      message("assistant", "先选 1 到 2 个更接近你这次方向的题材。"),
    ];

    expect(rewindOriginalScriptKickoffMessages(messages)).toEqual([
      messages[0],
      messages[1],
      messages[2],
    ]);
  });

  it("falls back to removing only the trailing assistant prompt when no preceding user answer is found", () => {
    const messages: HomeAgentMessage[] = [
      message("assistant", "我们先按传统创作面板把原创剧本立项定下来。"),
      message("assistant", "这次原创剧本主要想打哪个目标市场？"),
    ];

    expect(rewindOriginalScriptKickoffMessages(messages)).toEqual([messages[0]]);
  });
});

describe("shouldTreatOriginalScriptKickoffInputAsAnswer", () => {
  it("rejects greetings as audience answers so the chat can continue naturally", () => {
    const qState = createKickoffQState({
      step: "audience",
      title: "这次更希望主打哪类受众？",
      header: "目标受众",
      options: [
        { label: "女频", value: "女频" },
        { label: "男频", value: "男频" },
        { label: "全年龄", value: "全年龄" },
      ],
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "你好",
      }),
    ).toBe(false);
  });

  it("accepts a clear freeform audience preference", () => {
    const qState = createKickoffQState({
      step: "audience",
      title: "这次更希望主打哪类受众？",
      header: "目标受众",
      options: [
        { label: "女频", value: "女频" },
        { label: "男频", value: "男频" },
        { label: "全年龄", value: "全年龄" },
      ],
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "想偏年轻女性，整体还是女频向",
      }),
    ).toBe(true);
  });

  it("accepts uncertainty as a valid audience answer", () => {
    const qState = createKickoffQState({
      step: "audience",
      title: "这次更希望主打哪类受众？",
      header: "目标受众",
      options: [
        { label: "女频", value: "女频" },
        { label: "男频", value: "男频" },
        { label: "全年龄", value: "全年龄" },
        { label: "暂不确定，先给建议", value: "暂不确定，先给建议" },
      ],
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "不知道，先给建议",
      }),
    ).toBe(true);
  });

  it("keeps meta discussion out of the creative-input slot", () => {
    const qState = createKickoffQState({
      step: "creative-input",
      title: "把你的创意想法直接发给我。",
      header: "创意内容",
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "先聊聊你为什么要问这个",
      }),
    ).toBe(false);
  });

  it("does not swallow a target-market guidance request just because it mentions a valid option", () => {
    const qState = createKickoffQState({
      step: "target-market",
      title: "这次原创剧本主要想打哪个目标市场？",
      header: "目标市场",
      options: [
        { label: "国内（中文）", value: "cn" },
        { label: "海外", value: "global" },
      ],
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft:
          "国内（中文）市场我还拿不准，你先用自然语言说说通常适合什么受众和节奏。",
      }),
    ).toBe(false);
  });

  it("accepts pure numeric word-count answers like 10 and 10集", () => {
    const qState = createKickoffQState({
      step: "word-count",
      title: "Word count",
      header: "Word count",
      options: [
        { label: "40 episodes", value: "40 episodes" },
        { label: "60 episodes", value: "60 episodes" },
        { label: "80 episodes", value: "80 episodes" },
        { label: "100 episodes", value: "100 episodes" },
      ],
    });

    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "10",
      }),
    ).toBe(true);
    expect(
      shouldTreatOriginalScriptKickoffInputAsAnswer({
        qState,
        draft: "10集",
      }),
    ).toBe(true);
  });

  it("exposes an explicit fallback option for the audience step", () => {
    const audienceRequest = buildOriginalScriptKickoffBlueprintRequests().find((request) =>
      request.id.includes(":audience"),
    );
    const labels = audienceRequest?.questions[0]?.options.map((option) => option.label) ?? [];

    expect(labels).toContain("暂不确定，先给建议");
  });
});
