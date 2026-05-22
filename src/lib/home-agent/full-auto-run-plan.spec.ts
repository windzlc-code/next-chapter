import { describe, expect, it } from "vitest";
import type { ComposerQuestion, FullAutoRunPlan } from "@/lib/home-agent/types";
import {
  buildFullAutoExecutionUserMessage,
  applyFullAutoStrategyAnswer,
  buildFullAutoVisualChecklist,
  buildFullAutoExecutionSteps,
  buildFullAutoProgressDisplaySteps,
  canRewindFullAutoStrategyPlan,
  createFullAutoAdaptationRunPlan,
  createFullAutoOriginalScriptRunPlan,
  createFullAutoVideoWorkflowRunPlan,
  getFullAutoEpisodeDurationSeconds,
  getFullAutoPromptBatchMode,
  getFullAutoVideoAnalyzePrefs,
  getNextFullAutoStrategyQuestion,
  markFullAutoSteps,
  resetFullAutoStrategyPlan,
  rewindFullAutoStrategyPlan,
  shouldAutoRetryFullAutoGenerationStep,
} from "./full-auto-run-plan";

const completion = {
  setupInput: { totalEpisodes: 24, title: "Test drama" },
  userBubble: "Original script: test drama",
  structuredSummary: "24-episode original drama",
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

function getQuestionForKey(plan: FullAutoRunPlan, key: string): ComposerQuestion {
  let current = plan;
  for (let guard = 0; guard < 20; guard += 1) {
    const question = getNextFullAutoStrategyQuestion(current);
    if (!question) throw new Error(`Question ${key} was not reached`);
    if (question.answerKey.endsWith(`:${key}`)) {
      return question;
    }
    current = answerQuestion(current, question);
  }
  throw new Error(`Question ${key} loop guard exceeded`);
}

function collectOptionValues(question: ComposerQuestion): string[] {
  const values: string[] = [];
  const queue = [...question.options];
  while (queue.length) {
    const option = queue.shift();
    if (!option) continue;
    values.push(option.value);
    if (option.children?.length) {
      queue.push(...option.children);
    }
  }
  return values;
}

function collectQuestionKeys(plan: FullAutoRunPlan): string[] {
  const keys: string[] = [];
  let current = plan;
  for (let guard = 0; guard < 30; guard += 1) {
    const question = getNextFullAutoStrategyQuestion(current);
    if (!question) break;
    keys.push(question.answerKey.replace("full-auto-preflight:", ""));
    current = answerQuestion(current, question);
  }
  return keys;
}

function withStrategy(
  plan: FullAutoRunPlan,
  key: string,
  value: string,
  label = value,
): FullAutoRunPlan {
  return {
    ...plan,
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      [key]: {
        key,
        phase: key,
        value,
        label,
      },
    },
    answers: {
      ...plan.answers,
      [key]: value,
    },
    displayAnswers: {
      ...plan.displayAnswers,
      [key]: label,
    },
    collectedAnswers: {
      ...(plan.collectedAnswers ?? {}),
      [key]: value,
    },
  };
}

describe("full-auto original-script run plan", () => {
  it("starts with strategy collection instead of an executable save_setup step", () => {
    const plan = createFullAutoOriginalScriptRunPlan(completion);
    const question = getNextFullAutoStrategyQuestion(plan);

    expect(question?.answerKey).toBe("full-auto-preflight:outlineGeneration");
    expect(question?.options.map((option) => option.value)).toEqual([
      "script:outline-generate-all",
      "script:outline-generate-batch:1:10",
      "script:outline-generate-range:custom",
    ]);
    expect(plan.steps[0]?.workflowAction).toBe("save_setup");
    expect(plan.steps.every((step) => step.status === "pending")).toBe(true);
  });

  it("stores ordinary option values and maps them to executor strategy inputs", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "episodeDuration", "script:episode-duration-gate:120");
    plan = answerUntil(plan, "videoAnalyze", "video:bridge:analyze:dur:90");
    plan = answerUntil(plan, "videoAnalyzeDetail", "video:bridge:analyze:pace:fast:90");
    plan = answerUntil(plan, "videoPrompts", "full-auto:video-prompts:segment");
    plan = answerUntil(plan, "videoPromptsDetail", "video:bridge:prompts:segment:batch");

    expect(plan.stageStrategies?.episodeDuration?.value).toBe("script:episode-duration-gate:120");
    expect(getFullAutoEpisodeDurationSeconds(plan)).toBe(120);
    expect(getFullAutoVideoAnalyzePrefs(plan)).toEqual({ episodeDuration: 90, videoPace: "fast" });
    expect(getFullAutoPromptBatchMode(plan)).toBe("batch");
  });

  it("keeps the preflight flow focused while restoring hidden custom entry points and removing duplicate bridge questions", () => {
    const outlineQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "outlineGeneration");
    const episodeDurationQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "episodeDuration");
    const episodeWritingQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "episodeWriting");
    const episodeReviewQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "episodeReview");
    const complianceQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "complianceReview");
    const scriptExportRouteQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "scriptExportRoute");
    const scriptDocumentExportQuestion = getQuestionForKey(
      answerUntil(createFullAutoOriginalScriptRunPlan(completion), "scriptExportRoute", "script:export-document"),
      "scriptDocumentExport",
    );
    const videoStyleQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "videoStyle");
    const videoAnalyzeQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "videoAnalyze");
    const storyboardXlsxExportQuestion = getQuestionForKey(
      createFullAutoOriginalScriptRunPlan(completion),
      "storyboardXlsxExport",
    );
    const videoPromptsQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "videoPrompts");
    const videoExportQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "videoExport");
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    const textVideoPlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:text-to-video",
    );
    const directVideoPlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "scriptExportRoute",
      "script:export-video",
    );

    expect(outlineQuestion.options.map((option) => option.value)).toEqual([
      "script:outline-generate-all",
      "script:outline-generate-batch:1:10",
      "script:outline-generate-range:custom",
    ]);
    expect(outlineQuestion.allowCustomInput).toBe(true);

    expect(episodeDurationQuestion.options.map((option) => option.value)).toEqual([
      "script:episode-duration-gate:60",
      "script:episode-duration-gate:90",
      "script:episode-duration-gate:120",
      "script:episode-duration-gate:custom",
    ]);
    expect(episodeDurationQuestion.allowCustomInput).toBe(true);

    expect(episodeWritingQuestion.options.map((option) => option.value)).toEqual([
      "script:episode-generate-batch",
      "script:episode-generate-range:custom",
    ]);
    expect(episodeWritingQuestion.allowCustomInput).toBe(true);

    expect(episodeReviewQuestion.options.map((option) => option.value)).toEqual([
      "script:episode-review",
      "full-auto:episode-review:repair",
      "script:episode-review:skip",
    ]);
    const repairPlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "episodeReview",
      "full-auto:episode-review:repair",
    );
    const episodeReviewDetailQuestion = getQuestionForKey(repairPlan, "episodeReviewDetail");
    expect(episodeReviewDetailQuestion.options.map((option) => option.value)).toEqual([
      "script:episode-review:repair-worst",
      "script:episode-review:repair-all",
    ]);

    expect(complianceQuestion.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "script:compliance-run:text",
        "script:compliance-run:script",
        "script:skip-compliance-review",
      ]),
    );
    plan = answerUntil(createFullAutoOriginalScriptRunPlan(completion), "complianceReview", "script:compliance-run:text");
    const complianceStrictnessQuestion = getQuestionForKey(plan, "complianceReviewStrictness");
    expect(complianceStrictnessQuestion.options.map((option) => option.value)).toEqual([
      "script:compliance-set-strictness:standard",
      "script:compliance-set-strictness:strict",
      "script:compliance-set-strictness:extreme",
    ]);
    plan = answerUntil(plan, "complianceReviewStrictness", "script:compliance-set-strictness:strict");
    const complianceDialogueQuestion = getQuestionForKey(plan, "complianceReviewDialogue");
    expect(complianceDialogueQuestion.options.map((option) => option.value)).toEqual([
      "script:compliance-toggle-dialogue:on",
      "script:compliance-toggle-dialogue:off",
    ]);
    expect(scriptExportRouteQuestion.options.map((option) => option.value)).toEqual([
      "script:export-document",
      "script:export-video",
    ]);
    expect(collectQuestionKeys(directVideoPlan)).not.toContain("scriptDocumentExport");
    expect(collectQuestionKeys(createFullAutoOriginalScriptRunPlan(completion))).not.toContain(
      "scriptDocumentExportPath",
    );
    expect(scriptDocumentExportQuestion.options.map((option) => option.value)).toEqual([
      "script:export-download-md",
      "script:export-word",
      "script:export-episodes-download",
      "script:export-local:skip",
    ]);

    expect(collectOptionValues(videoStyleQuestion)).toEqual(
      expect.arrayContaining([
        "video:kickoff:prefs:style-category:realistic",
        "video:kickoff:prefs:style-category:animation-3d",
        "video:kickoff:prefs:style-category:animation-2d",
        "video:kickoff:prefs:style-preset:live-action",
        "video:kickoff:prefs:style-preset:hyper-cg",
        "video:kickoff:prefs:style-preset:3d-cartoon",
        "video:kickoff:prefs:style-preset:anime-3d",
        "video:kickoff:prefs:style-preset:cel-animation",
      ]),
    );
    expect(videoStyleQuestion.allowCustomInput).toBe(true);

    expect(videoAnalyzeQuestion.options.map((option) => option.value)).toEqual([
      "video:bridge:analyze:dur:60",
      "video:bridge:analyze:dur:90",
      "video:bridge:analyze:dur:120",
      "video:bridge:analyze:dur:custom",
    ]);
    expect(videoAnalyzeQuestion.allowCustomInput).toBe(true);
    expect(storyboardXlsxExportQuestion.options.map((option) => option.value)).toEqual([
      "video:bridge:export-xlsx",
      "video:bridge:export-xlsx:skip",
    ]);
    expect(collectQuestionKeys(createFullAutoOriginalScriptRunPlan(completion))).not.toContain(
      "storyboardXlsxExportPath",
    );
    expect(collectQuestionKeys(textVideoPlan)).not.toContain("videoTargetPlatform");
    expect(collectQuestionKeys(textVideoPlan)).not.toContain("videoShotStyle");
    expect(collectQuestionKeys(textVideoPlan)).not.toContain("videoOutputGoal");
    const videoAnalyzeDetailQuestion = getQuestionForKey(
      answerUntil(createFullAutoOriginalScriptRunPlan(completion), "videoAnalyze", "video:bridge:analyze:dur:120"),
      "videoAnalyzeDetail",
    );
    expect(videoAnalyzeDetailQuestion.options.map((option) => option.value)).toEqual([
      "video:bridge:analyze:pace:slow:120",
      "video:bridge:analyze:pace:medium:120",
      "video:bridge:analyze:pace:fast:120",
    ]);

    expect(videoPromptsQuestion.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "full-auto:video-prompts:segment",
        "full-auto:video-prompts:shot",
      ]),
    );
    plan = answerUntil(createFullAutoOriginalScriptRunPlan(completion), "videoPrompts", "full-auto:video-prompts:segment");
    const videoPromptsDetailQuestion = getQuestionForKey(plan, "videoPromptsDetail");
    expect(videoPromptsDetailQuestion.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "video:bridge:prompts:segment:all",
        "video:bridge:prompts:segment:batch",
        "video:bridge:prompts:segment:episode:custom",
      ]),
    );
    const videoGenerationQuestion = getQuestionForKey(plan, "videoGeneration");
    expect(videoGenerationQuestion.options.map((option) => option.value)).toEqual([
      "video:generate:segments:first",
    ]);
    expect(videoPromptsDetailQuestion.statusBadges?.some((badge) => badge.label === "子步骤")).toBe(false);
    expect(videoGenerationQuestion.statusBadges?.some((badge) => badge.label === "子步骤")).toBe(false);

    expect(videoExportQuestion.options.map((option) => option.value)).toEqual([
      "video:export:ai-auto",
      "video:export:all",
    ]);
    plan = answerUntil(createFullAutoOriginalScriptRunPlan(completion), "videoExport", "video:export:ai-auto");
    const videoExportDetailQuestion = getQuestionForKey(plan, "videoExportDetail");
    expect(videoExportDetailQuestion.options.map((option) => option.value)).toEqual([
      "video:export:ai-auto:subtitle:yes",
      "video:export:ai-auto:subtitle:no",
    ]);
  });

  it("surfaces the export path step after the export route is fully chosen", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoExport", "video:export:all");
    const allExportPathQuestion = getQuestionForKey(plan, "videoExportPath");
    expect(allExportPathQuestion.options.map((option) => option.value)).toEqual(["video:export:path:pick"]);
    expect(allExportPathQuestion.description).toContain("直接写入");

    plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoExport", "video:export:ai-auto");
    plan = answerUntil(plan, "videoExportDetail", "video:export:ai-auto:subtitle:yes");
    const aiExportPathQuestion = getQuestionForKey(plan, "videoExportPath");
    expect(aiExportPathQuestion.options.map((option) => option.value)).toEqual(["video:export:path:pick"]);
    expect(aiExportPathQuestion.description).toContain("直接写入");
  });

  it("builds a live visual checklist from selected choices and executor proxy messages", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    const outlineQuestion = getQuestionForKey(plan, "outlineGeneration");
    const outlineOption = outlineQuestion.options.find((option) => option.value === "script:outline-generate-batch:1:10");
    if (!outlineOption) throw new Error("Missing outline option");
    plan = answerQuestion(plan, outlineQuestion, outlineOption.value);

    const durationQuestion = getQuestionForKey(plan, "episodeDuration");
    const durationOption = durationQuestion.options.find((option) => option.value === "script:episode-duration-gate:90");
    if (!durationOption) throw new Error("Missing duration option");
    plan = answerQuestion(plan, durationQuestion, durationOption.value);
    plan = markFullAutoSteps(plan, 1, "running");

    const checklist = buildFullAutoVisualChecklist(plan, 1, "running");
    const checklistIds = checklist.map((item) => item.id);

    expect(checklist.find((item) => item.id === "choice:outlineGeneration")).toEqual(
      expect.objectContaining({
        kind: "choice",
        label: outlineOption.label,
        status: "selected",
      }),
    );
    expect(checklist.find((item) => item.id === "choice:episodeDuration")).toEqual(
      expect.objectContaining({
        kind: "choice",
        label: durationOption.label,
        status: "selected",
      }),
    );
    expect(checklist.find((item) => item.id === "step:setup")).toEqual(
      expect.objectContaining({
        label: "确认项目设定",
        status: "completed",
      }),
    );
    expect(checklist.find((item) => item.id === "step:creative-plan")).toEqual(
      expect.objectContaining({
        label: "生成创作方案",
        status: "running",
        current: true,
      }),
    );
    expect(checklistIds.indexOf("choice:outlineGeneration")).toBeLessThan(checklistIds.indexOf("step:outlines"));
    expect(checklistIds.indexOf("choice:episodeDuration")).toBeLessThan(checklistIds.indexOf("step:episodes"));
    expect(checklistIds.indexOf("choice:episodeDuration")).toBeGreaterThan(checklistIds.indexOf("step:outlines"));

    const progressedPlan = markFullAutoSteps(plan, 5, "running");
    expect(buildFullAutoVisualChecklist(progressedPlan, 5, "running").find((item) => item.id === "choice:outlineGeneration"))
      .toEqual(expect.objectContaining({ status: "completed" }));

    const rewound = rewindFullAutoStrategyPlan(plan);
    expect(rewound).not.toBeNull();
    expect(
      buildFullAutoVisualChecklist(rewound!, 1, "collecting").some((item) => item.id === "choice:episodeDuration"),
    ).toBe(false);
  });


  it("reports preflight question progress with stable major steps", () => {
    const plan = createFullAutoOriginalScriptRunPlan(completion);
    const outlineQuestion = getQuestionForKey(plan, "outlineGeneration");
    expect(outlineQuestion.stepIndex).toBe(0);
    expect(outlineQuestion.totalSteps).toBe(10);
    expect(outlineQuestion.statusBadges?.[1]?.value).toBe("1/10");
    expect(outlineQuestion.statusBadges?.[2]).toBeUndefined();

    const episodeDurationQuestion = getQuestionForKey(plan, "episodeDuration");
    expect(episodeDurationQuestion.stepIndex).toBe(1);
    expect(episodeDurationQuestion.totalSteps).toBe(10);
    expect(episodeDurationQuestion.statusBadges?.[1]?.value).toBe("2/10");
    expect(episodeDurationQuestion.statusBadges?.[2]).toBeUndefined();

    const compliancePlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "complianceReview",
      "script:compliance-run:text",
    );
    const complianceStrictnessQuestion = getQuestionForKey(
      compliancePlan,
      "complianceReviewStrictness",
    );
    expect(complianceStrictnessQuestion.statusBadges?.[0]?.value).toBe("合规审查");
    expect(complianceStrictnessQuestion.statusBadges?.[1]?.value).toBe("文本合规审查");
    expect(complianceStrictnessQuestion.statusBadges?.[2]?.value).toBe("4/10");
    expect(complianceStrictnessQuestion.statusBadges?.[3]).toBeUndefined();

    const imageModePlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:image-to-video",
    );
    expect(collectQuestionKeys(imageModePlan)).not.toContain("videoTargetPlatform");
    expect(collectQuestionKeys(imageModePlan)).not.toContain("videoShotStyle");
    expect(collectQuestionKeys(imageModePlan)).not.toContain("videoOutputGoal");
    const referenceAssetsQuestion = getQuestionForKey(imageModePlan, "referenceAssets");
    const storyboardPrepQuestion = getQuestionForKey(imageModePlan, "storyboardPrep");
    expect(referenceAssetsQuestion.stepIndex).toBeGreaterThan(0);
    expect(referenceAssetsQuestion.totalSteps).toBeGreaterThan(referenceAssetsQuestion.stepIndex);
    expect(referenceAssetsQuestion.statusBadges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "视频模式", value: "图生视频" }),
        expect.objectContaining({ label: "总步骤", value: expect.stringMatching(/^\d+\/\d+$/) }),
      ]),
    );
    expect(referenceAssetsQuestion.statusBadges?.some((badge) => badge.label === "子步骤")).toBe(false);
    expect(storyboardPrepQuestion.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        "video:bridge:storyboard-frames",
        "video:bridge:storyboard-frames:episode:custom",
      ]),
    );
    expect(storyboardPrepQuestion.options.map((option) => option.value)).not.toContain("video:bridge:storyboard");
  });

  it("skips image reference and storyboard image steps for text-to-video", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");
    const actions = buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction);
    const labels = buildFullAutoProgressDisplaySteps(plan).map((step) => step.label);

    expect(actions).toContain("compile_video_shot_packets");
    expect(actions).not.toContain("generate_video_reference_assets");
    expect(actions).not.toContain("generate_storyboard_frames");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(actions.length);
    expect(labels).not.toContain("视频提示词");
    expect(labels).toContain("视频生成");
    expect(labels).toContain("预览与导出");
  });

  it("adds a role-scene route question for text-to-video and only runs reference assets when explicitly chosen", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");

    const referenceQuestion = getQuestionForKey(plan, "referenceAssets");
    const videoPromptsQuestion = getQuestionForKey(plan, "videoPrompts");
    expect(referenceQuestion.options.map((option) => option.value)).toEqual([
      "video:bridge:reference-assets:full",
      "video:bridge:reference-assets:skip",
    ]);
    expect(videoPromptsQuestion.options.map((option) => option.value)).toEqual([
      "full-auto:video-prompts:segment",
      "full-auto:video-prompts:shot",
    ]);
    expect(referenceQuestion.options.map((option) => option.label)).toEqual([
      "智能补齐全部参考资产",
      "跳过参考资产，直接文生视频",
    ]);
    expect(referenceQuestion.description).toContain("后续不会自动补图");

    const skippedPlan = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:skip");
    expect(buildFullAutoExecutionSteps(skippedPlan).map((step) => step.workflowAction)).not.toContain(
      "generate_video_reference_assets",
    );

    const fullPlan = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:full");
    expect(buildFullAutoExecutionSteps(fullPlan).map((step) => step.workflowAction)).toContain(
      "generate_video_reference_assets",
    );
  });

  it("adds reference asset and storyboard preparation steps for image-to-video", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:image-to-video");
    const actions = buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction);
    const labels = buildFullAutoProgressDisplaySteps(plan).map((step) => step.label);
    const referenceQuestion = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:full");
    const referenceOptions = getQuestionForKey(plan, "referenceAssets").options.map((option) => option.value);
    const videoPromptsQuestion = getQuestionForKey(plan, "videoPrompts");

    expect(actions).toContain("generate_video_reference_assets");
    expect(actions).toContain("prepare_storyboard_batch");
    expect(actions).toContain("generate_storyboard_frames");
    expect(actions).toContain("compile_video_shot_packets");
    expect(referenceQuestion.stageStrategies?.referenceAssets?.value).toBe("video:bridge:reference-assets:full");
    expect(referenceOptions).toEqual(["video:bridge:reference-assets:full"]);
    expect(videoPromptsQuestion.options.map((option) => option.value)).toEqual([
      "full-auto:video-prompts:shot",
    ]);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(actions.length);
  });

  it("keeps text-to-video shot packets inside the role-scene stage instead of surfacing a storyboard stage", () => {
    const plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:text-to-video",
    );

    const progressSteps = buildFullAutoProgressDisplaySteps(plan);
    const roleSceneRawStepIds = progressSteps
      .filter((step) => step.id === "reference-assets")
      .flatMap((step) => step.rawStepIds);
    const visualShotPacketStep = buildFullAutoVisualChecklist(plan, 0, "collecting").find(
      (item) => item.id === "step:video-shot-packets",
    );

    expect(progressSteps.map((step) => step.id)).not.toContain("storyboard");
    expect(new Set(progressSteps.map((step) => step.id)).size).toBe(progressSteps.length);
    expect(roleSceneRawStepIds).toEqual(expect.arrayContaining(["video-entities", "video-shot-packets"]));
    expect(visualShotPacketStep?.phase).toBe("角色与场景");
  });

  it("keeps script export separate and folds video mode setup into the script-breakdown stage in the progress checklist", () => {
    const plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:image-to-video",
    );

    const progressSteps = buildFullAutoProgressDisplaySteps(plan);
    const progressIds = progressSteps.map((step) => step.id);

    expect(progressIds).toContain("script-export");
    expect(progressIds).not.toContain("video-setup");
    expect(progressIds).toContain("video-analyze");
    expect(progressIds).toContain("reference-assets");
    expect(progressIds.indexOf("script-export")).toBeLessThan(progressIds.indexOf("video-analyze"));
    expect(progressIds.indexOf("video-analyze")).toBeLessThan(progressIds.indexOf("reference-assets"));
    expect(progressSteps.find((step) => step.id === "script-export")?.label).toBe("剧本导出");
    expect(progressSteps.find((step) => step.id === "video-analyze")?.label).toBe("剧本拆解");
    expect(progressSteps.find((step) => step.id === "reference-assets")?.label).toBe("角色与场景");
  });

  it("keeps only setup highlighted in the execution progress rail while collecting preflight answers", () => {
    const basePlan = createFullAutoOriginalScriptRunPlan(completion);
    const writingPlan = answerUntil(basePlan, "episodeDuration", "script:episode-duration-gate:90");

    const progressSteps = buildFullAutoProgressDisplaySteps(writingPlan, 0, "collecting");

    expect(progressSteps.find((step) => step.id === "setup")?.current).toBe(true);
    expect(progressSteps.filter((step) => step.id !== "setup").every((step) => step.current === false)).toBe(true);
    expect(progressSteps.every((step) => step.status === "pending")).toBe(true);
  });

  it("uses composite execution copy for the video-prepare step", () => {
    let plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:image-to-video",
    );
    const styleQuestion = getQuestionForKey(plan, "videoStyle");
    plan = answerQuestion(plan, styleQuestion);
    const step = buildFullAutoExecutionSteps(plan).find((item) => item.id === "video-prepare");

    expect(step).toBeTruthy();
    expect(buildFullAutoExecutionUserMessage(plan, step!)).toContain("：");
    expect(buildFullAutoExecutionUserMessage(plan, step!)).toContain(" / ");
  });

  it("uses clearer checklist copy for overlapping strategy and agent steps", () => {
    const plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:text-to-video",
    );

    const checklist = buildFullAutoVisualChecklist(plan, 0, "collecting");
    expect(checklist.find((item) => item.id === "step:outlines")?.label).toBe("执行细纲生成");
    expect(checklist.find((item) => item.id === "step:episodes")?.label).toBe("执行正文撰写");
    expect(checklist.find((item) => item.id === "step:script-export")?.label).toBe("执行剧本导出");
    expect(checklist.find((item) => item.id === "step:video-prepare")?.label).toBe("进入视频工作流");
    expect(checklist.find((item) => item.id === "step:video-bridge-prefs")?.label).toBe("补平台与镜头偏好");
    expect(checklist.find((item) => item.id === "step:video-analyze")?.label).toBe("执行剧本拆解");
  });

  it("normalizes verbose collected choice copy inside the visual checklist", () => {
    const bridgeChecklist = buildFullAutoVisualChecklist(
      withStrategy(
        createFullAutoOriginalScriptRunPlan(completion),
        "scriptExportRoute",
        "script:export-video",
        "直接桥接视频工作流",
      ),
      0,
      "collecting",
    );
    const exportChecklist = buildFullAutoVisualChecklist(
      withStrategy(
        withStrategy(
          createFullAutoOriginalScriptRunPlan(completion),
          "scriptExportRoute",
          "script:export-document",
          "先导出剧本文档",
        ),
        "scriptDocumentExport",
        "script:export-download-md",
        "下载 .md",
      ),
      0,
      "collecting",
    );
    const videoChecklist = buildFullAutoVisualChecklist(
      withStrategy(
        withStrategy(
          createFullAutoOriginalScriptRunPlan(completion),
          "storyboardXlsxExport",
          "video:bridge:export-xlsx",
          "导出分镜 xlsx",
        ),
        "referenceAssets",
        "video:bridge:reference-assets:full",
        "智能补齐全部参考资产",
      ),
      0,
      "collecting",
    );

    expect(bridgeChecklist.find((item) => item.id === "choice:scriptExportRoute")?.label).toBe(
      "跳过剧本导出，直接进入视频",
    );
    expect(exportChecklist.find((item) => item.id === "choice:scriptDocumentExport")?.label).toBe("导出 Markdown");
    expect(videoChecklist.find((item) => item.id === "choice:storyboardXlsxExport")?.label).toBe("导出分镜 Excel");
    expect(videoChecklist.find((item) => item.id === "choice:referenceAssets")?.label).toBe("智能补齐全部参考资产");
  });

  it("keeps storyboard preparation ordered before frame generation while using matching choice copy", () => {
    const checklist = buildFullAutoVisualChecklist(
      withStrategy(
        withStrategy(
          createFullAutoOriginalScriptRunPlan(completion),
          "videoMode",
          "video:kickoff:prefs:mode:image-to-video",
          "图生视频",
        ),
        "storyboardPrep",
        "video:bridge:storyboard-frames",
        "批量准备分镜文本并生成分镜图",
      ),
      0,
      "collecting",
    );

    const checklistIds = checklist.map((item) => item.id);
    expect(checklist.find((item) => item.id === "choice:storyboardPrep")?.label).toBe("整理分镜文本并生成分镜图");
    expect(checklist.find((item) => item.id === "step:video-storyboard")?.label).toBe("整理分镜文本");
    expect(checklist.find((item) => item.id === "step:video-storyboard-frames")?.label).toBe("生成分镜图");
    expect(checklistIds.indexOf("choice:storyboardPrep")).toBeLessThan(checklistIds.indexOf("step:video-storyboard"));
    expect(checklistIds.indexOf("step:video-storyboard")).toBeLessThan(
      checklistIds.indexOf("step:video-storyboard-frames"),
    );
  });

  it("switches to the ordinary shot-prompt workflow action when synced options choose mirror prompt batches", () => {
    let plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoPromptsDetail",
      "video:bridge:prompts:all",
      "All mirror prompts",
    );
    plan = withStrategy(plan, "videoGeneration", "video:generate:first", "按镜头智能分批生成");

    const steps = buildFullAutoExecutionSteps(plan);
    const promptStep = steps.find((step) => step.id === "video-prompts");
    const generationStep = steps.find((step) => step.id === "video-generate");
    expect(promptStep?.workflowAction).toBe("prepare_video_prompt_batch");
    expect(generationStep?.workflowAction).toBe("generate_video_assets");
  });

  it("keeps storyboard image generation in the image-to-video route after removing the text-only storyboard option", () => {
    const plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:image-to-video",
    );

    const storyboardPrepQuestion = getQuestionForKey(plan, "storyboardPrep");
    const actions = buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction);
    expect(storyboardPrepQuestion.options.map((option) => option.value)).not.toContain("video:bridge:storyboard");
    expect(actions).toContain("prepare_storyboard_batch");
    expect(actions).toContain("generate_storyboard_frames");
  });

  it("switches episode review into repair execution when synced ordinary options choose repair", () => {
    const plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "episodeReviewDetail",
      "script:episode-review:repair-all",
      "Repair all reviewed episodes",
    );

    const reviewStep = buildFullAutoExecutionSteps(plan).find((step) => step.id === "episode-review");
    expect(reviewStep?.workflowAction).toBe("rewrite_episode_from_review");
  });

  it("keeps compliance skip while preserving the hidden script-side custom duration entry", () => {
    const durationQuestion = getQuestionForKey(createFullAutoOriginalScriptRunPlan(completion), "episodeDuration");
    expect(durationQuestion.options.map((option) => option.value)).toContain("script:episode-duration-gate:custom");
    expect(durationQuestion.allowCustomInput).toBe(true);
    const skipPlan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "complianceReview",
      "script:skip-compliance-review",
    );
    expect(getNextFullAutoStrategyQuestion(skipPlan)?.answerKey).toBe("full-auto-preflight:scriptExportRoute");
    expect(buildFullAutoExecutionSteps(skipPlan).find((step) => step.id === "compliance")?.workflowAction).toBe(
      "skip_compliance_review",
    );
  });

  it("removes explicit video bridge preference questions from preflight", () => {
    const plan = answerUntil(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoMode",
      "video:kickoff:prefs:mode:text-to-video",
    );
    const questionKeys = collectQuestionKeys(plan);
    expect(questionKeys).not.toContain("videoResolution");
    expect(questionKeys).not.toContain("videoTargetPlatform");
    expect(questionKeys).not.toContain("videoShotStyle");
    expect(questionKeys).not.toContain("videoOutputGoal");
    expect(questionKeys[0]).toBe("videoStyle");
  });

  it("places video mode and visual style after entity extraction in the visual checklist", () => {
    const plan = createFullAutoOriginalScriptRunPlan(completion);
    const imageVideoPlan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:image-to-video");
    const questionKeys = collectQuestionKeys(plan);

    expect(questionKeys.indexOf("storyboardXlsxExport")).toBeLessThan(questionKeys.indexOf("videoMode"));
    expect(questionKeys.indexOf("videoMode")).toBeLessThan(questionKeys.indexOf("videoStyle"));
    expect(questionKeys.indexOf("videoStyle")).toBeLessThan(questionKeys.indexOf("referenceAssets"));

    const executionStepIds = buildFullAutoExecutionSteps(imageVideoPlan).map((step) => step.id);
    expect(executionStepIds.indexOf("video-prepare")).toBeLessThan(executionStepIds.indexOf("video-analyze"));
    expect(executionStepIds.indexOf("video-analyze")).toBeLessThan(executionStepIds.indexOf("video-entities"));
    expect(executionStepIds.indexOf("video-entities")).toBeLessThan(executionStepIds.indexOf("video-bridge-prefs"));
    expect(executionStepIds.indexOf("video-bridge-prefs")).toBeLessThan(executionStepIds.indexOf("video-reference-assets"));

    const checklist = buildFullAutoVisualChecklist(
      withStrategy(
        withStrategy(
          withStrategy(
            withStrategy(
              withStrategy(plan, "storyboardXlsxExport", "video:bridge:export-xlsx", "Export storyboard xlsx"),
              "videoMode",
              "video:kickoff:prefs:mode:image-to-video",
              "Image to video",
            ),
            "videoAnalyze",
            "video:bridge:analyze:dur:60",
            "60 秒",
          ),
          "videoAnalyzeDetail",
          "video:bridge:analyze:pace:slow:60",
          "慢节奏",
        ),
        "videoStyle",
        "video:kickoff:prefs:style-preset:live-action",
        "Live action",
      ),
      0,
      "collecting",
    );
    const checklistIds = checklist.map((item) => item.id);
    expect(checklistIds.indexOf("step:video-prepare")).toBeLessThan(checklistIds.indexOf("choice:videoAnalyze"));
    expect(checklistIds.indexOf("choice:videoAnalyze")).toBeLessThan(checklistIds.indexOf("step:video-analyze"));
    expect(checklistIds.indexOf("step:video-prepare")).toBeLessThan(checklistIds.indexOf("choice:storyboardXlsxExport"));
    expect(checklistIds.indexOf("choice:storyboardXlsxExport")).toBeLessThan(checklistIds.indexOf("step:video-entities"));
    expect(checklistIds.indexOf("step:video-entities")).toBeLessThan(checklistIds.indexOf("choice:videoMode"));
    expect(checklistIds.indexOf("choice:videoMode")).toBeLessThan(checklistIds.indexOf("choice:videoStyle"));
    expect(checklistIds.indexOf("choice:videoStyle")).toBeLessThan(checklistIds.indexOf("step:video-bridge-prefs"));
    expect(checklistIds.indexOf("step:video-bridge-prefs")).toBeLessThan(checklistIds.indexOf("step:video-reference-assets"));
    expect(checklist.find((item) => item.id === "choice:videoMode")?.phase).toBe("角色与场景");
    expect(checklist.find((item) => item.id === "choice:videoStyle")?.phase).toBe("角色与场景");
    expect(checklist.find((item) => item.id === "step:video-bridge-prefs")?.phase).toBe("角色与场景");
  });

  it("keeps text-to-video mode and style after entity extraction even when reference assets are skipped", () => {
    const checklist = buildFullAutoVisualChecklist(
      withStrategy(
        withStrategy(
          withStrategy(
            withStrategy(
              withStrategy(createFullAutoOriginalScriptRunPlan(completion), "videoMode", "video:kickoff:prefs:mode:text-to-video", "文生视频"),
              "videoStyle",
              "video:kickoff:prefs:style-preset:live-action",
              "真人影视",
            ),
            "videoAnalyze",
            "video:bridge:analyze:dur:60",
            "60 秒",
          ),
          "videoAnalyzeDetail",
          "video:bridge:analyze:pace:slow:60",
          "慢节奏",
        ),
        "referenceAssets",
        "video:bridge:reference-assets:skip",
        "跳过参考资产，直接文生视频",
      ),
      0,
      "collecting",
    );

    const checklistIds = checklist.map((item) => item.id);
    expect(checklistIds.indexOf("step:video-entities")).toBeLessThan(checklistIds.indexOf("choice:videoMode"));
    expect(checklistIds.indexOf("choice:videoMode")).toBeLessThan(checklistIds.indexOf("choice:videoStyle"));
    expect(checklistIds.indexOf("choice:videoStyle")).toBeLessThan(checklistIds.indexOf("step:video-bridge-prefs"));
    expect(checklistIds.indexOf("step:video-bridge-prefs")).toBeLessThan(checklistIds.indexOf("choice:referenceAssets"));
    expect(checklistIds.indexOf("choice:referenceAssets")).toBeLessThan(checklistIds.indexOf("step:video-shot-packets"));
  });

  it("anchors direct bridge-to-video export routing before entering the video workflow steps", () => {
    const checklist = buildFullAutoVisualChecklist(
      withStrategy(
        createFullAutoOriginalScriptRunPlan(completion),
        "scriptExportRoute",
        "script:export-video",
        "直接桥接视频工作流",
      ),
      0,
      "collecting",
    );

    const checklistIds = checklist.map((item) => item.id);
    expect(checklistIds.indexOf("choice:scriptExportRoute")).toBeLessThan(checklistIds.indexOf("step:video-prepare"));
    expect(checklistIds.indexOf("choice:scriptExportRoute")).toBeLessThan(checklistIds.indexOf("step:video-analyze"));
    expect(checklistIds.indexOf("choice:scriptExportRoute")).toBeLessThan(checklistIds.indexOf("step:video-entities"));
  });

  it("adds video mode and route badges to downstream branch questions", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");
    plan = answerUntil(plan, "videoPrompts", "full-auto:video-prompts:segment");

    const detailQuestion = getQuestionForKey(plan, "videoPromptsDetail");
    expect(detailQuestion.statusBadges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "全自动", value: "视频提示词" }),
        expect.objectContaining({ label: "视频模式", value: "文生视频" }),
        expect.objectContaining({ label: "路线", value: "片段提示词路线" }),
        expect.objectContaining({ label: "总步骤", value: "9/10" }),
      ]),
    );
  });

  it("can skip the episode-review step entirely in full-auto", () => {
    const plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "episodeReview",
      "script:episode-review:skip",
      "Skip episode review",
    );

    expect(buildFullAutoExecutionSteps(plan).some((step) => step.id === "episode-review")).toBe(false);
  });

  it("can skip the script-export step and bridge directly into video", () => {
    const plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "scriptExportRoute",
      "script:export-video",
      "Bridge directly into video",
    );

    expect(buildFullAutoExecutionSteps(plan).some((step) => step.id === "script-export")).toBe(false);
  });

  it("retries generation steps once so AI can fall back to hidden recovery logic", () => {
    const outlinePlan = createFullAutoOriginalScriptRunPlan(completion);
    const outlineStep = buildFullAutoExecutionSteps(outlinePlan).find((step) => step.id === "outlines");
    expect(shouldAutoRetryFullAutoGenerationStep(outlinePlan, outlineStep)).toBe(true);
    const episodePlan = createFullAutoOriginalScriptRunPlan(completion);
    const episodeStep = buildFullAutoExecutionSteps(episodePlan).find((step) => step.id === "episodes");
    expect(shouldAutoRetryFullAutoGenerationStep(episodePlan, episodeStep)).toBe(true);
    const exhaustedRetryPlan = {
      ...outlinePlan,
      retryCounts: { outlines: 1 },
    };
    expect(shouldAutoRetryFullAutoGenerationStep(exhaustedRetryPlan, outlineStep)).toBe(false);
  });

  it("rewinds the collecting plan by one visible preflight step", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    const firstQuestion = getNextFullAutoStrategyQuestion(plan);
    plan = answerQuestion(plan, firstQuestion!);

    expect(canRewindFullAutoStrategyPlan(plan)).toBe(true);

    const rewound = rewindFullAutoStrategyPlan(plan);
    expect(rewound).not.toBeNull();
    expect(getNextFullAutoStrategyQuestion(rewound!)?.answerKey).toBe(firstQuestion?.answerKey);
  });

  it("resets the collecting plan back to the first visible preflight step", () => {
    let plan = createFullAutoOriginalScriptRunPlan(completion);
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");
    plan = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:skip");

    const resetPlan = resetFullAutoStrategyPlan(plan);
    expect(getNextFullAutoStrategyQuestion(resetPlan)?.answerKey).toBe("full-auto-preflight:outlineGeneration");
    expect(resetPlan.stageStrategies?.outlineGeneration).toBeUndefined();
    expect(resetPlan.stageStrategies?.videoMode).toBeUndefined();
    expect(resetPlan.stageStrategies?.referenceAssets).toBeUndefined();
    expect(resetPlan.stageStrategies?.videoGeneration?.value).toBeDefined();
  });

  it("switches the final export action based on the precollected export route", () => {
    let plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoExport",
      "video:export:all",
      "Export full asset bundle",
    );
    plan = withStrategy(plan, "videoExportPath", "video:export:path:E%3A%2FExports", "E:/Exports");
    expect(buildFullAutoExecutionSteps(plan).find((step) => step.id === "video-export")?.workflowAction).toBe(
      "export_video_asset_bundle",
    );

    plan = withStrategy(
      createFullAutoOriginalScriptRunPlan(completion),
      "videoExport",
      "video:export:ai-auto",
      "AI auto export",
    );
    plan = withStrategy(
      plan,
      "videoExportDetail",
      "video:export:ai-auto:subtitle:yes",
      "Merge with subtitles",
    );
    plan = withStrategy(plan, "videoExportPath", "video:export:path:E%3A%2FExports", "E:/Exports");
    expect(buildFullAutoExecutionSteps(plan).find((step) => step.id === "video-export")?.workflowAction).toBe(
      "compile_segment_videos",
    );
  });
});

describe("full-auto adaptation/video variants", () => {
  it("prepends adaptation-specific questions and actions before the shared video bridge", () => {
    const plan = createFullAutoAdaptationRunPlan({
      referenceScript: "参考剧本正文",
      title: "改编烟测项目",
      userBubble: "参考改编：改编烟测项目",
    });

    expect(collectQuestionKeys(plan).slice(0, 3)).toEqual([
      "adaptationEpisodeCount",
      "adaptationTargetMarket",
      "adaptationGenres",
    ]);
    expect(buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction).slice(0, 10)).toEqual([
      "save_setup",
      "analyze_reference_script",
      "confirm_adaptation_episode_count",
      "confirm_adaptation_target_market",
      "confirm_adaptation_genres",
      "generate_structure_transform",
      "generate_character_transform",
      "generate_directory",
      "generate_outlines",
      "generate_episode_batch",
    ]);
  });

  it("groups adaptation checklist and progress stages to match the ordinary adaptation workflow", () => {
    const plan = createFullAutoAdaptationRunPlan({
      referenceScript: "参考剧本正文",
      title: "改编烟测项目",
      userBubble: "参考改编：改编烟测项目",
    });

    const progressSteps = buildFullAutoProgressDisplaySteps(plan);
    const checklist = buildFullAutoVisualChecklist(plan, 0, "collecting");

    expect(progressSteps.map((step) => step.id).slice(0, 7)).toEqual([
      "setup",
      "reference-analysis",
      "adaptation-setup",
      "structure-transform",
      "character-transform",
      "directory",
      "outlines",
    ]);
    expect(progressSteps.find((step) => step.id === "reference-analysis")?.label).toBe("参考分析");
    expect(progressSteps.find((step) => step.id === "adaptation-setup")?.label).toBe("改编设定");
    expect(progressSteps.find((step) => step.id === "adaptation-setup")?.rawStepIds).toEqual([
      "adaptation-episode-count",
      "adaptation-target-market",
      "adaptation-genres",
    ]);
    expect(checklist.find((item) => item.id === "step:adaptation-episode-count")?.phase).toBe("改编设定");
    expect(checklist.find((item) => item.id === "step:adaptation-target-market")?.phase).toBe("改编设定");
    expect(checklist.find((item) => item.id === "step:adaptation-genres")?.phase).toBe("改编设定");
    expect(checklist.find((item) => item.id === "step:structure-transform")?.phase).toBe("结构转译");
    expect(checklist.find((item) => item.id === "step:character-transform")?.phase).toBe("角色转译");
  });

  it("inserts selected adaptation choices before their matching execution steps instead of trailing after video stages", () => {
    let plan = createFullAutoAdaptationRunPlan({
      referenceScript: "参考剧本正文",
      title: "改编烟测项目",
      userBubble: "参考改编：改编烟测项目",
    });

    plan = withStrategy(plan, "adaptationEpisodeCount", "script:adaptation-total-episodes:60", "AI 推荐（60集）");
    plan = withStrategy(plan, "adaptationTargetMarket", "script:adaptation-target-market:cn", "AI 推荐（国内（中文））");
    plan = withStrategy(plan, "adaptationGenres", "script:adaptation-genres:%E8%B1%AA%E9%97%A8%E5%A9%9A%E6%81%8B", "豪门婚恋");

    const checklistIds = buildFullAutoVisualChecklist(plan, 0, "collecting").map((item) => item.id);

    expect(checklistIds.indexOf("choice:adaptationEpisodeCount")).toBeLessThan(
      checklistIds.indexOf("step:adaptation-episode-count"),
    );
    expect(checklistIds.indexOf("choice:adaptationTargetMarket")).toBeLessThan(
      checklistIds.indexOf("step:adaptation-target-market"),
    );
    expect(checklistIds.indexOf("choice:adaptationGenres")).toBeLessThan(
      checklistIds.indexOf("step:adaptation-genres"),
    );
    expect(checklistIds.indexOf("choice:adaptationGenres")).toBeLessThan(
      checklistIds.indexOf("step:structure-transform"),
    );
    expect(checklistIds.slice(-3)).not.toEqual([
      "choice:adaptationEpisodeCount",
      "choice:adaptationTargetMarket",
      "choice:adaptationGenres",
    ]);
  });

  it("keeps video-workflow mode free of script-authoring questions and actions", () => {
    let plan = createFullAutoVideoWorkflowRunPlan(
      {
        source: "use-current-project",
        userBubble: "视频工作流：使用当前剧本项目",
        title: "视频烟测项目",
        projectId: "drama-project-video-entry",
        sourceProjectId: "drama-project-video-entry",
      },
      { mode: "text-to-video" },
    );

    expect(collectQuestionKeys(plan)).not.toEqual(
      expect.arrayContaining([
        "outlineGeneration",
        "episodeWriting",
        "episodeReview",
        "complianceReview",
        "scriptExportRoute",
      ]),
    );

    plan = answerUntil(plan, "videoAnalyze", "video:bridge:analyze:dur:90");
    plan = answerUntil(plan, "videoAnalyzeDetail", "video:bridge:analyze:pace:medium:90");
    plan = answerUntil(plan, "storyboardXlsxExport", "video:bridge:export-xlsx:skip");
    plan = answerUntil(plan, "videoMode", "video:kickoff:prefs:mode:text-to-video");
    plan = answerUntil(plan, "videoStyle", "video:kickoff:prefs:style-category:realistic");
    plan = answerUntil(plan, "referenceAssets", "video:bridge:reference-assets:skip");
    plan = answerUntil(plan, "videoPrompts", "full-auto:video-prompts:segment");
    plan = answerUntil(plan, "videoPromptsDetail", "video:bridge:prompts:segment:all");
    plan = answerUntil(plan, "videoExport", "video:export:ai-auto");
    plan = answerUntil(plan, "videoExportDetail", "video:export:ai-auto:subtitle:no");

    expect(buildFullAutoExecutionSteps(plan).map((step) => step.workflowAction)).toEqual([
      "prepare_video_generation",
      "analyze_script_for_video",
      "extract_video_entities",
      "auto_fill_video_bridge_prefs",
      "compile_video_shot_packets",
      "prepare_segment_video_prompt",
      "generate_segment_video",
      "compile_segment_videos",
    ]);
  });
});

