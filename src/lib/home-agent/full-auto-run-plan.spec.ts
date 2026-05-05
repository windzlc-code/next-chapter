import { describe, expect, it } from "vitest";
import type { ComposerQuestion, FullAutoRunPlan } from "@/lib/home-agent/types";
import {
  applyFullAutoStrategyAnswer,
  buildFullAutoExecutionSteps,
  createFullAutoOriginalScriptRunPlan,
  getFullAutoEpisodeDurationSeconds,
  getFullAutoPromptBatchMode,
  getFullAutoVideoAnalyzePrefs,
  getNextFullAutoStrategyQuestion,
} from "./full-auto-run-plan";

const completion = {
  setupInput: { totalEpisodes: 24, title: "测试短剧" },
  userBubble: "原创剧本：测试短剧",
  structuredSummary: "24 集原创短剧",
};

function answerQuestion(plan: FullAutoRunPlan, question: ComposerQuestion, value?: string): FullAutoRunPlan {
  const picked = value
    ? question.options.find((option) => option.value === value)
    : question.options[0];
  if (!picked) throw new Error(`Missing option ${value ?? "(first)"}`);
  const next = applyFullAutoStrategyAnswer(plan, picked.value, picked.label, question);
  if (!next) throw new Error("Question was not handled");
  return next;
}

function answerUntil(plan: FullAutoRunPlan, key: string, value: string): FullAutoRunPlan {
  let current = plan;
  for (let guard = 0; guard < 20; guard += 1) {
    const question = getNextFullAutoStrategyQuestion(current);
    if (!question) throw new Error(`Question ${key} was not reached`);
    if (question.answerKey.endsWith(`:${key}`)) {
      return answerQuestion(current, question, value);
    }
    current = answerQuestion(current, question);
  }
  throw new Error(`Question ${key} loop guard exceeded`);
}

describe("full-auto original-script run plan", () => {
  it("starts with strategy collection instead of an executable save_setup step", () => {
    const plan = createFullAutoOriginalScriptRunPlan(completion);
    const question = getNextFullAutoStrategyQuestion(plan);

    expect(question?.answerKey).toBe("full-auto-preflight:outlineGeneration");
    expect(question?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["script:outline-generate-all", "script:outline-fill-missing"]),
    );
    expect(plan.steps[0]?.workflowAction).toBe("save_setup");
    expect(plan.steps.every((step) => step.status === "pending")).toBe(true);
  });

  it("stores ordinary option values and maps them to executor strategy inputs", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "episodeDuration", "script:episode-duration-gate:120");
    plan = answerUntil(plan, "videoAnalyze", "video:bridge:analyze:pace:fast:90");
    plan = answerUntil(plan, "videoPrompts", "video:bridge:prompts:segment:batch");

    expect(plan.stageStrategies?.episodeDuration?.value).toBe("script:episode-duration-gate:120");
    expect(getFullAutoEpisodeDurationSeconds(plan)).toBe(120);
    expect(getFullAutoVideoAnalyzePrefs(plan)).toEqual({ episodeDuration: 90, videoPace: "fast" });
    expect(getFullAutoPromptBatchMode(plan)).toBe("batch");
  });

  it("skips image reference and storyboard image steps for text-to-video", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");
    const actions = buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction);

    expect(actions).toContain("compile_video_shot_packets");
    expect(actions).not.toContain("generate_video_reference_assets");
    expect(actions).not.toContain("generate_storyboard_frames");
  });

  it("adds reference asset and storyboard preparation steps for image-to-video", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:image-to-video");
    const actions = buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction);
    const referenceQuestion = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:full");

    expect(actions).toContain("generate_video_reference_assets");
    expect(actions).toContain("prepare_storyboard_batch");
    expect(actions).toContain("generate_storyboard_frames");
    expect(referenceQuestion.stageStrategies?.referenceAssets?.value).toBe("video:bridge:reference-assets:full");
  });
});
