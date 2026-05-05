import type { OriginalScriptKickoffCompletion } from "@/lib/home-agent/original-script-kickoff";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  FullAutoRunPlan,
  FullAutoRunStep,
  FullAutoRunStepStatus,
  FullAutoStageStrategy,
} from "@/lib/home-agent/types";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  listHomeAgentVideoResolutions,
  normalizeVideoGenerationMode,
  normalizeVideoGenerationResolution,
} from "@/lib/home-agent/video-models";
import type { VideoGenerationMode, VideoGenerationResolution } from "@/types/project";

export type FullAutoStrategyKey =
  | "outlineGeneration"
  | "episodeDuration"
  | "episodeWriting"
  | "episodeReview"
  | "complianceReview"
  | "videoMode"
  | "videoResolution"
  | "videoAnalyze"
  | "referenceAssets"
  | "storyboardPrep"
  | "videoPrompts"
  | "videoGeneration"
  | "videoExport";

type FullAutoStrategyDefinition = {
  key: FullAutoStrategyKey;
  phase: string;
  title: string;
  description: string;
  options: ComposerQuestionOption[];
};

const FULL_AUTO_QUESTION_PREFIX = "full-auto-preflight";

const AUTO_EXPORT_STRATEGY: FullAutoStageStrategy = {
  key: "videoExport",
  phase: "全部导出",
  value: "video:export:all",
  label: "全部导出",
};

function option(
  id: string,
  label: string,
  value: string,
  rationale?: string,
  extra?: Partial<ComposerQuestionOption>,
): ComposerQuestionOption {
  return {
    id,
    label,
    value,
    ...(rationale ? { rationale } : {}),
    ...extra,
  };
}

function readTotalEpisodes(setupInput: Record<string, unknown> | undefined): number {
  const total = Number(setupInput?.totalEpisodes ?? setupInput?.episodes ?? setupInput?.episodeCount);
  return Number.isFinite(total) && total > 0 ? Math.max(1, Math.floor(total)) : 60;
}

function buildOutlineOptions(totalEpisodes: number): ComposerQuestionOption[] {
  const batchEnd = Math.min(totalEpisodes, 10);
  return [
    option(
      "full-auto-outline-all",
      "生成全部细纲",
      "script:outline-generate-all",
      "按分集目录连续生成全部单集细纲。",
    ),
    option(
      "full-auto-outline-batch",
      `先生成第 1-${batchEnd} 集细纲`,
      `script:outline-generate-batch:1:${batchEnd}`,
      "先跑首批细纲，后续自动继续补齐遗漏项。",
    ),
    option(
      "full-auto-outline-fill",
      "只补齐缺失细纲",
      "script:outline-fill-missing",
      "运行时按当前项目产物补齐缺失集数。",
    ),
  ];
}

function buildVideoResolutionOptions(current?: VideoGenerationResolution): ComposerQuestionOption[] {
  const selected = current ?? DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.resolution;
  return listHomeAgentVideoResolutions()
    .filter((resolution) => !resolution.disabledLabel)
    .map((resolution) =>
      option(
        `full-auto-video-resolution-${resolution.value}`,
        resolution.label,
        `video:kickoff:prefs:resolution:${resolution.value}`,
        resolution.description,
        { selected: resolution.value === selected },
      ),
    );
}

function buildStrategyDefinitions(plan: FullAutoRunPlan): FullAutoStrategyDefinition[] {
  const totalEpisodes = readTotalEpisodes(plan.setupInput);
  const currentVideoMode = getFullAutoVideoMode(plan);
  const currentResolution = getFullAutoVideoResolution(plan);
  const definitions: FullAutoStrategyDefinition[] = [
    {
      key: "outlineGeneration",
      phase: "单集细纲",
      title: "单集细纲生成策略",
      description: "确认全自动执行到单集细纲阶段时的批量生成方式。",
      options: buildOutlineOptions(totalEpisodes),
    },
    {
      key: "episodeDuration",
      phase: "正文撰写",
      title: "正文单集时长",
      description: "该时长会在批量撰写正文时作为每集节奏和篇幅约束。",
      options: [
        option("full-auto-episode-duration-60", "60 秒", "script:episode-duration-gate:60", "快节奏短剧。"),
        option("full-auto-episode-duration-90", "90 秒", "script:episode-duration-gate:90", "标准短剧节奏。"),
        option("full-auto-episode-duration-120", "120 秒", "script:episode-duration-gate:120", "更充足的情绪铺垫。"),
        option("full-auto-episode-duration-custom", "自定义", "script:episode-duration-gate:custom", "输入自定义秒数。", {
          childInput: {
            type: "number",
            actionPrefix: "script:episode-duration-gate:custom:",
            min: 30,
            max: 600,
            placeholder: "输入单集时长",
            suffix: "秒",
            buttonLabel: "写入时长",
          },
        }),
      ],
    },
    {
      key: "episodeWriting",
      phase: "正文撰写",
      title: "正文批量撰写策略",
      description: "确认全自动执行到正文阶段时如何批量撰写或补齐正文。",
      options: [
        option("full-auto-episode-write-batch", "批量自动撰写", "script:episode-generate-batch", "按细纲顺序连续生成正文。"),
        option("full-auto-episode-write-fill", "补齐缺失正文", "script:episode-fill-missing", "运行时只补齐缺失或失败的集数。"),
      ],
    },
    {
      key: "episodeReview",
      phase: "正文后处理",
      title: "正文批量质检策略",
      description: "正文撰写完成后，先按这里的策略进行质量自检，再进入合规审查。",
      options: [
        option("full-auto-episode-review-batch", "批量质量审查", "script:episode-review", "连续抽检/批量质检正文。"),
        option("full-auto-episode-review-remaining", "补齐剩余质检", "script:episode-review:remaining", "只处理尚未质检的正文。"),
      ],
    },
    {
      key: "complianceReview",
      phase: "合规审查",
      title: "合规审查模式",
      description: "选择进入合规审查阶段时的检查颗粒度。",
      options: [
        option("full-auto-compliance-text", "文字审查", "script:compliance-mode:text", "偏敏感词、表达和文本风险。"),
        option("full-auto-compliance-script", "剧情审查", "script:compliance-mode:script", "同时检查剧情逻辑与风险桥段。"),
      ],
    },
    {
      key: "videoMode",
      phase: "进入视频工作流",
      title: "视频生成模式",
      description: "文生视频会跳过参考图/分镜图准备；图生视频会先补齐参考资产与分镜图。",
      options: [
        option("full-auto-video-mode-text", "文生视频", "video:kickoff:prefs:mode:text-to-video", "直接从镜头描述与提示词生成视频。", {
          selected: currentVideoMode === "text-to-video",
        }),
        option("full-auto-video-mode-image", "图生视频", "video:kickoff:prefs:mode:image-to-video", "先准备角色/场景参考图与分镜图，再生成视频。", {
          selected: currentVideoMode === "image-to-video",
        }),
      ],
    },
    {
      key: "videoResolution",
      phase: "视频生成",
      title: "视频分辨率",
      description: "写入全自动视频生成参数，后续出片会沿用该分辨率。",
      options: buildVideoResolutionOptions(currentResolution),
    },
    {
      key: "videoAnalyze",
      phase: "剧本拆解",
      title: "剧本拆解节奏",
      description: "确认拆解时长和镜头节奏，运行时传给普通视频工作流。",
      options: [
        option("full-auto-video-analyze-60-medium", "60 秒 / 中等节奏", "video:bridge:analyze:pace:medium:60", "每集约 60 秒，适合高密度短剧。"),
        option("full-auto-video-analyze-90-medium", "90 秒 / 中等节奏", "video:bridge:analyze:pace:medium:90", "标准拆解颗粒度。"),
        option("full-auto-video-analyze-120-slow", "120 秒 / 慢速节奏", "video:bridge:analyze:pace:slow:120", "适合情绪和关系铺垫较多的项目。"),
        option("full-auto-video-analyze-90-fast", "90 秒 / 快速节奏", "video:bridge:analyze:pace:fast:90", "更密集的镜头推进。"),
      ],
    },
  ];

  if (currentVideoMode === "image-to-video") {
    definitions.push(
      {
        key: "referenceAssets",
        phase: "角色和场景",
        title: "角色和场景资产补齐",
        description: "图生视频会先用普通工作流的参考资产补齐协议处理角色、服装、场景和变体。",
        options: [
          option("full-auto-reference-full", "智能补齐全部参考资产", "video:bridge:reference-assets:full", "优先补缺，若已齐全则允许刷新。"),
          option("full-auto-reference-characters", "只补齐角色资产", "video:bridge:reference-assets:characters", "只处理角色与服装参考图。"),
          option("full-auto-reference-scenes", "只补齐场景资产", "video:bridge:reference-assets:scenes", "只处理场景与场景变体参考图。"),
        ],
      },
      {
        key: "storyboardPrep",
        phase: "条件视频准备",
        title: "分镜文本/分镜图准备",
        description: "确认图生视频在出片前如何准备分镜文本与分镜图。",
        options: [
          option("full-auto-storyboard-frames", "批量准备分镜文本并生成分镜图", "video:bridge:storyboard-frames", "先整理分镜文本，再补齐分镜图。"),
          option("full-auto-storyboard-text", "只批量准备分镜文本", "video:bridge:storyboard", "先只准备分镜文本，后续可人工介入分镜图。"),
        ],
      },
    );
  }

  definitions.push(
    {
      key: "videoPrompts",
      phase: "视频提示词",
      title: "视频提示词生成策略",
      description: "选择片段提示词或镜头提示词的批量生成方式。",
      options: [
        option("full-auto-prompts-segment-remaining", "补齐剩余片段提示词", "video:bridge:prompts:segment:remaining", "按片段补齐缺失提示词。"),
        option("full-auto-prompts-segment-batch", "分批生成片段提示词", "video:bridge:prompts:segment:batch", "每次推进一个片段批次。"),
        option("full-auto-prompts-shot-batch", "按片段分批生成镜头提示词", "video:bridge:prompts:batch", "为片段内每个镜头生成提示词。"),
      ],
    },
    {
      key: "videoGeneration",
      phase: "视频生成",
      title: "视频批量生成策略",
      description: "确认进入出片阶段时如何处理待生成或失败片段。",
      options: [
        option("full-auto-video-generate-first", "批量生成前 3 个片段", "video:generate:segments:first", "从当前可生成片段开始批量推进。"),
        option("full-auto-video-generate-failed", "补发失败片段", "video:generate:segments:failed", "运行时优先重试失败片段。"),
        option("full-auto-video-generate-refresh", "刷新进行中片段", "video:generate:segments:refresh", "用于继续处理卡住的片段。"),
      ],
    },
  );

  return definitions;
}

function ensureAutoStrategies(plan: FullAutoRunPlan): FullAutoRunPlan {
  const stageStrategies = {
    ...(plan.stageStrategies ?? {}),
    videoExport: plan.stageStrategies?.videoExport ?? AUTO_EXPORT_STRATEGY,
  };
  return {
    ...plan,
    stageStrategies,
    collectedAnswers: {
      ...(plan.collectedAnswers ?? plan.answers ?? {}),
      videoExport: stageStrategies.videoExport.value,
    },
    answers: {
      ...plan.answers,
      videoExport: stageStrategies.videoExport.value,
    },
    displayAnswers: {
      ...plan.displayAnswers,
      videoExport: stageStrategies.videoExport.label,
    },
  };
}

export function createFullAutoOriginalScriptRunPlan(
  completion: OriginalScriptKickoffCompletion,
  videoGenerationPrefs?: { mode?: VideoGenerationMode; resolution?: VideoGenerationResolution },
): FullAutoRunPlan {
  const defaultVideoMode = normalizeVideoGenerationMode(videoGenerationPrefs?.mode);
  const defaultVideoResolution = normalizeVideoGenerationResolution(videoGenerationPrefs?.resolution);
  const createdAt = new Date().toISOString();
  const basePlan: FullAutoRunPlan = {
    id: globalThis.crypto?.randomUUID?.() ?? `full-auto-${Date.now()}`,
    projectKind: "script",
    entryTemplateId: "script",
    mode: "original-script-v1",
    createdAt,
    setupInput: {
      ...completion.setupInput,
      automationMode: "full-auto",
    },
    userBubble: completion.userBubble,
    structuredSummary: completion.structuredSummary,
    answers: {
      kickoff: completion.structuredSummary,
      defaultVideoMode: `video:kickoff:prefs:mode:${defaultVideoMode}`,
      defaultVideoResolution: `video:kickoff:prefs:resolution:${defaultVideoResolution}`,
    },
    displayAnswers: {
      kickoff: completion.userBubble,
      defaultVideoMode: defaultVideoMode === "image-to-video" ? "图生视频" : "文生视频",
      defaultVideoResolution,
    },
    collectedAnswers: {
      kickoff: completion.structuredSummary,
    },
    stageStrategies: {
      videoExport: AUTO_EXPORT_STRATEGY,
    },
    plannedSteps: [],
    steps: [],
    currentStepIndex: 0,
    retryCounts: {},
  };
  return syncFullAutoPlanSteps(ensureAutoStrategies(basePlan));
}

export function isFullAutoStrategyQuestion(question: ComposerQuestion | null | undefined): boolean {
  return Boolean(question?.answerKey?.startsWith(`${FULL_AUTO_QUESTION_PREFIX}:`));
}

function buildQuestion(def: FullAutoStrategyDefinition, index: number, total: number): ComposerQuestion {
  return {
    id: `${FULL_AUTO_QUESTION_PREFIX}:${def.key}`,
    title: def.title,
    description: def.description,
    options: def.options,
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: index,
    totalSteps: total,
    answerKey: `${FULL_AUTO_QUESTION_PREFIX}:${def.key}`,
    statusBadges: [{ label: "全自动", value: def.phase, tone: "default" }],
  };
}

export function getNextFullAutoStrategyQuestion(plan: FullAutoRunPlan): ComposerQuestion | null {
  const syncedPlan = ensureAutoStrategies(plan);
  const definitions = buildStrategyDefinitions(syncedPlan);
  const unanswered = definitions.findIndex((def) => !syncedPlan.stageStrategies?.[def.key]);
  if (unanswered === -1) return null;
  return buildQuestion(definitions[unanswered], unanswered, definitions.length);
}

export function applyFullAutoStrategyAnswer(
  plan: FullAutoRunPlan,
  value: string,
  label: string,
  question: ComposerQuestion | null | undefined,
): FullAutoRunPlan | null {
  if (!isFullAutoStrategyQuestion(question)) return null;
  const key = question?.answerKey.replace(`${FULL_AUTO_QUESTION_PREFIX}:`, "") as FullAutoStrategyKey;
  const definitions = buildStrategyDefinitions(plan);
  const definition = definitions.find((item) => item.key === key);
  if (!definition) return null;

  const nextPlan: FullAutoRunPlan = {
    ...plan,
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
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      [key]: {
        key,
        phase: definition.phase,
        value,
        label,
      },
    },
  };
  return syncFullAutoPlanSteps(ensureAutoStrategies(nextPlan));
}

export function getFullAutoVideoMode(plan: FullAutoRunPlan): VideoGenerationMode {
  const value =
    plan.stageStrategies?.videoMode?.value ??
    String(plan.answers.videoMode ?? plan.answers.defaultVideoMode ?? "");
  const match = value.match(/video:kickoff:prefs:mode:(text-to-video|image-to-video)$/);
  return normalizeVideoGenerationMode(match?.[1]);
}

export function getFullAutoVideoResolution(plan: FullAutoRunPlan): VideoGenerationResolution {
  const value =
    plan.stageStrategies?.videoResolution?.value ??
    String(plan.answers.videoResolution ?? plan.answers.defaultVideoResolution ?? "");
  const match = value.match(/video:kickoff:prefs:resolution:([^:]+)$/);
  return normalizeVideoGenerationResolution(match?.[1]);
}

export function getFullAutoEpisodeDurationSeconds(plan: FullAutoRunPlan): number {
  const value = plan.stageStrategies?.episodeDuration?.value ?? String(plan.answers.episodeDuration ?? "");
  const match = value.match(/^script:episode-duration-gate:(?:custom:)?(\d+)$/);
  const seconds = match ? Number(match[1]) : 90;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 90;
}

export function getFullAutoVideoAnalyzePrefs(plan: FullAutoRunPlan): {
  videoPace: "slow" | "medium" | "fast";
  episodeDuration: number;
} {
  const value = plan.stageStrategies?.videoAnalyze?.value ?? String(plan.answers.videoAnalyze ?? "");
  const match = value.match(/^video:bridge:analyze:pace:(slow|medium|fast):(\d+)$/);
  return {
    videoPace: (match?.[1] as "slow" | "medium" | "fast" | undefined) ?? "medium",
    episodeDuration: match?.[2] ? Number(match[2]) : 90,
  };
}

export function getFullAutoPromptBatchMode(plan: FullAutoRunPlan): "all" | "batch" | "remaining" {
  const value = plan.stageStrategies?.videoPrompts?.value ?? "video:bridge:prompts:segment:remaining";
  if (value.endsWith(":all")) return "all";
  if (value.endsWith(":batch")) return "batch";
  return "remaining";
}

export function getFullAutoStrategyValue(plan: FullAutoRunPlan, key: string): string | undefined {
  return plan.stageStrategies?.[key]?.value;
}

function step(
  id: string,
  label: string,
  phase: string,
  workflowAction: string,
  strategyKey?: FullAutoStrategyKey,
): FullAutoRunStep {
  return {
    id,
    label,
    phase,
    workflowAction,
    strategyKey,
    status: "pending",
  };
}

export function buildFullAutoExecutionSteps(plan: FullAutoRunPlan): FullAutoRunStep[] {
  const videoMode = getFullAutoVideoMode(plan);
  const steps: FullAutoRunStep[] = [
    step("setup", "项目设定", "剧本工作流", "save_setup"),
    step("creative-plan", "创意方案", "剧本工作流", "generate_creative_plan"),
    step("characters", "角色设计", "剧本工作流", "generate_characters"),
    step("directory", "分集目录", "剧本工作流", "generate_directory"),
    step("outlines", "单集细纲", "剧本工作流", "generate_outlines", "outlineGeneration"),
    step("episodes", "正文撰写", "剧本工作流", "generate_episode_batch", "episodeWriting"),
    step("episode-review", "正文后处理", "剧本工作流", "review_episode_quality", "episodeReview"),
    step("compliance", "合规审查", "剧本工作流", "run_compliance_review", "complianceReview"),
    step("script-export", "剧本导出", "剧本工作流", "export_project"),
    step("video-prepare", "进入视频工作流", "视频工作流", "prepare_video_generation", "videoMode"),
    step("video-analyze", "剧本拆解", "视频工作流", "analyze_script_for_video", "videoAnalyze"),
    step("video-entities", "角色和场景", "视频工作流", "extract_video_entities"),
  ];

  if (videoMode === "image-to-video") {
    steps.push(
      step("video-reference-assets", "角色和场景参考资产", "视频工作流", "generate_video_reference_assets", "referenceAssets"),
      step("video-storyboard", "分镜文本准备", "视频工作流", "prepare_storyboard_batch", "storyboardPrep"),
      step("video-storyboard-frames", "分镜图准备", "视频工作流", "generate_storyboard_frames", "storyboardPrep"),
    );
  } else {
    steps.push(step("video-shot-packets", "条件视频准备", "视频工作流", "compile_video_shot_packets"));
  }

  steps.push(
    step("video-prompts", "视频提示词", "视频工作流", "prepare_segment_video_prompt", "videoPrompts"),
    step("video-generate", "视频生成", "视频工作流", "generate_segment_video", "videoGeneration"),
    step("video-export", "全部导出", "预览导出", "export_video_asset_bundle", "videoExport"),
  );

  return steps.map((item) => ({
    ...item,
    strategyValue: item.strategyKey ? plan.stageStrategies?.[item.strategyKey]?.value : undefined,
  }));
}

export function syncFullAutoPlanSteps(plan: FullAutoRunPlan): FullAutoRunPlan {
  const previous = new Map((plan.steps?.length ? plan.steps : plan.plannedSteps ?? []).map((item) => [item.id, item]));
  const steps = buildFullAutoExecutionSteps(plan).map((item) => {
    const existing = previous.get(item.id);
    return {
      ...item,
      status: existing?.status ?? item.status,
    };
  });
  return {
    ...plan,
    plannedSteps: steps,
    steps,
  };
}

export function markFullAutoSteps(
  plan: FullAutoRunPlan,
  currentStepIndex: number,
  status: FullAutoRunStepStatus,
): FullAutoRunPlan {
  const synced = syncFullAutoPlanSteps(plan);
  const steps = synced.steps.map((item, index) => {
    if (status === "completed") return { ...item, status: "completed" as const };
    if (index < currentStepIndex) return { ...item, status: "completed" as const };
    if (index === currentStepIndex) return { ...item, status };
    return { ...item, status: "pending" as const };
  });
  return {
    ...synced,
    currentStepIndex,
    plannedSteps: steps,
    steps,
  };
}

export function updateFullAutoStepStrategy(
  plan: FullAutoRunPlan,
  step: FullAutoRunStep | undefined,
  value: string,
  label: string,
): FullAutoRunPlan {
  if (!step?.strategyKey) return plan;
  const nextPlan: FullAutoRunPlan = {
    ...plan,
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      [step.strategyKey]: {
        key: step.strategyKey,
        phase: step.label,
        value,
        label,
      },
    },
    answers: {
      ...plan.answers,
      [step.strategyKey]: value,
    },
    displayAnswers: {
      ...plan.displayAnswers,
      [step.strategyKey]: label,
    },
    collectedAnswers: {
      ...(plan.collectedAnswers ?? {}),
      [step.strategyKey]: value,
    },
    resumeFromStepId: step.id,
    stoppedStepId: undefined,
  };
  return syncFullAutoPlanSteps(nextPlan);
}
