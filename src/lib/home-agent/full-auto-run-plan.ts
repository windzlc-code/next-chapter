import type { OriginalScriptKickoffCompletion } from "@/lib/home-agent/original-script-kickoff";
import type { VideoKickoffSource } from "@/lib/home-agent/video-workflow-kickoff";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  FullAutoRunPlan,
  FullAutoRunStatus,
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
import {
  listHomeAgentImageStyleCategories,
  listHomeAgentImageStylePresets,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import type {
  VideoGenerationMode,
  VideoGenerationResolution,
  VideoImageGenerationPrefs,
} from "@/types/project";
import { EPISODE_COUNTS, GENRES, TARGET_MARKETS } from "@/types/drama";

export type FullAutoStrategyKey =
  | "adaptationEpisodeCount"
  | "adaptationTargetMarket"
  | "adaptationGenres"
  | "outlineGeneration"
  | "outlineGenerationDetail"
  | "episodeDuration"
  | "episodeWriting"
  | "episodeWritingDetail"
  | "episodeReview"
  | "episodeReviewDetail"
  | "complianceReview"
  | "complianceReviewStrictness"
  | "complianceReviewDialogue"
  | "scriptExportRoute"
  | "scriptDocumentExport"
  | "scriptDocumentExportPath"
  | "videoMode"
  | "videoStyle"
  | "videoAnalyze"
  | "videoAnalyzeDetail"
  | "storyboardXlsxExport"
  | "storyboardXlsxExportPath"
  | "referenceAssets"
  | "storyboardPrep"
  | "videoPrompts"
  | "videoPromptsDetail"
  | "videoGeneration"
  | "videoExport"
  | "videoExportDetail"
  | "videoExportPath";

export type FullAutoProgressDisplayStep = {
  id: string;
  label: string;
  status: FullAutoRunStepStatus;
  current: boolean;
  rawStepIds: string[];
};

export type FullAutoVisualChecklistItemStatus = FullAutoRunStepStatus | "selected";

export type FullAutoVisualChecklistItem = {
  id: string;
  kind: "choice" | "step";
  label: string;
  phase: string;
  detail?: string;
  current: boolean;
  status: FullAutoVisualChecklistItemStatus;
};

type FullAutoStrategyDefinition = {
  key: FullAutoStrategyKey;
  majorId: string;
  phase: string;
  title: string;
  description: string;
  options: ComposerQuestionOption[];
  allowCustomInput?: boolean;
  branchGroup?: string;
};

type QuestionProgressMeta = {
  majorIndex: number;
  majorTotal: number;
  subIndex?: number;
  subTotal?: number;
};

export interface FullAutoAdaptationRunSeed {
  referenceScript: string;
  title?: string;
  userBubble: string;
}

export interface FullAutoVideoWorkflowRunSeed {
  source: VideoKickoffSource;
  userBubble: string;
  title?: string;
  script?: string;
  projectId?: string;
  sourceProjectId?: string;
}

const FULL_AUTO_QUESTION_PREFIX = "full-auto-preflight";
const COMPLIANCE_SKIP_VALUE = "script:skip-compliance-review";
const EPISODE_REVIEW_REPAIR_VALUE = "full-auto:episode-review:repair";
const EPISODE_REVIEW_SKIP_VALUE = "script:episode-review:skip";
const SCRIPT_DOCUMENT_EXPORT_SKIP_VALUE = "script:export-local:skip";
const SCRIPT_DOCUMENT_EXPORT_PATH_PICK_VALUE = "script:export:path:pick";
const VIDEO_REFERENCE_ASSETS_SKIP_VALUE = "video:bridge:reference-assets:skip";
const VIDEO_PROMPTS_SEGMENT_VALUE = "full-auto:video-prompts:segment";
const VIDEO_PROMPTS_SHOT_VALUE = "full-auto:video-prompts:shot";
const VIDEO_EXPORT_AI_AUTO_VALUE = "video:export:ai-auto";
const VIDEO_EXPORT_ALL_VALUE = "video:export:all";
const VIDEO_EXPORT_PATH_PICK_VALUE = "video:export:path:pick";
const STORYBOARD_XLSX_EXPORT_SKIP_VALUE = "video:bridge:export-xlsx:skip";
const STORYBOARD_XLSX_EXPORT_PATH_PICK_VALUE = "video:bridge:export-xlsx:path:pick";
const DEFAULT_VIDEO_GENERATION_VALUE = "video:generate:segments:first";

const AUTO_EXPORT_STRATEGY: FullAutoStageStrategy = {
  key: "videoExport",
  phase: "预览导出",
  value: VIDEO_EXPORT_ALL_VALUE,
  label: "全部导出素材包",
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

function buildAdaptationEpisodeCountOptions(totalEpisodes: number): ComposerQuestionOption[] {
  const normalizedTotal = Math.max(1, Math.floor(totalEpisodes));
  const standardOptions = EPISODE_COUNTS
    .filter((item) => item.value > 0 && item.value !== normalizedTotal)
    .map((item) =>
      option(
        `adaptation-episode-count-${item.value}`,
        item.label,
        `script:adaptation-total-episodes:${item.value}`,
        "按这个改编集数继续后续结构转译、目录和分集撰写。",
      ),
    );

  return [
    option(
      "adaptation-episode-count-recommended",
      `AI 推荐（${normalizedTotal}集）`,
      `script:adaptation-total-episodes:${normalizedTotal}`,
      "沿用当前参考内容默认推荐的改编集数。",
    ),
    ...standardOptions,
    option(
      "adaptation-episode-count-custom",
      "自定义",
      "script:adaptation-total-episodes:custom",
      "手动输入改编后的总集数。",
      {
        childInput: {
          type: "number",
          actionPrefix: "script:adaptation-total-episodes:custom:",
          min: 1,
          max: 1000,
          placeholder: "输入总集数",
          suffix: "集",
          buttonLabel: "确认集数",
          labelTemplate: "自定义 {value} 集",
        },
      },
    ),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));
}

function buildAdaptationTargetMarketOptions(currentMarket: string): ComposerQuestionOption[] {
  return TARGET_MARKETS.map((market) =>
    option(
      `adaptation-target-market-${market.value}`,
      currentMarket === market.value ? `AI 推荐（${market.label}）` : market.label,
      `script:adaptation-target-market:${market.value}`,
      market.desc,
      { selected: currentMarket === market.value },
    ),
  );
}

function buildAdaptationGenreOptions(targetMarket: string): ComposerQuestionOption[] {
  const availableGenres = GENRES.filter((genre) =>
    (genre.markets as readonly string[]).includes(targetMarket),
  );
  const fallbackGenres =
    availableGenres.length > 0
      ? availableGenres
      : GENRES.filter((genre) => (genre.markets as readonly string[]).includes("cn")).slice(0, 12);

  return fallbackGenres.map((genre) =>
    option(
      `adaptation-genre-${genre.value}`,
      genre.label,
      `script:adaptation-genres:${encodeURIComponent(genre.label)}`,
      `${genre.category} / ${genre.desc} / 受众：${genre.audience}`,
    ),
  );
}

function buildQuestion(
  definition: FullAutoStrategyDefinition,
  progress: QuestionProgressMeta,
  contextBadges: NonNullable<ComposerQuestion["statusBadges"]> = [],
): ComposerQuestion {
  const statusBadges: NonNullable<ComposerQuestion["statusBadges"]> = [
    { label: "全自动", value: definition.phase, tone: "default" },
    ...contextBadges,
    { label: "总步骤", value: `${progress.majorIndex}/${progress.majorTotal}`, tone: "default" },
  ];
  if (progress.subIndex != null && progress.subTotal != null) {
    statusBadges.push({
      label: "子步骤",
      value: `${progress.subIndex}/${progress.subTotal}`,
      tone: "default",
    });
  }

  return {
    id: `${FULL_AUTO_QUESTION_PREFIX}:${definition.key}`,
    title: definition.title,
    description: definition.description,
    options: definition.options,
    presentation: "card",
    allowCustomInput: definition.allowCustomInput ?? false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: progress.majorIndex - 1,
    totalSteps: progress.majorTotal,
    answerKey: `${FULL_AUTO_QUESTION_PREFIX}:${definition.key}`,
    statusBadges,
  };
}

function buildOutlineOptions(totalEpisodes: number): ComposerQuestionOption[] {
  const batchEnd = Math.min(totalEpisodes, 10);
  return [
    option("outline-all", "生成全部细纲", "script:outline-generate-all", "按当前分集目录连续生成全部单集细纲。"),
    option(
      "outline-batch",
      `先生成第 1-${batchEnd} 集细纲`,
      `script:outline-generate-batch:1:${batchEnd}`,
      "先跑首批细纲，后续由 AI 自动续跑。",
    ),
    option(
      "outline-custom-range",
      "自定义细纲范围",
      "script:outline-generate-range:custom",
      `支持输入指定集数、逗号列表或范围，例如 1-${totalEpisodes}、1,3,5 或 8-12。`,
      {
        childInput: {
          type: "text",
          actionPrefix: "script:outline-generate-range:",
          buttonLabel: "确认范围",
          labelTemplate: "生成 {value} 细纲",
          placeholder: `输入集数或范围，例如 1-${Math.min(totalEpisodes, 12)}`,
          maxLength: 64,
        },
      },
    ),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));
}

function buildEpisodeDurationOptions(): ComposerQuestionOption[] {
  return [
    option("episode-duration-60", "60 秒", "script:episode-duration-gate:60", "节奏更快，适合短平快内容。"),
    option("episode-duration-90", "90 秒", "script:episode-duration-gate:90", "默认短剧时长。"),
    option("episode-duration-120", "120 秒", "script:episode-duration-gate:120", "给情绪和铺垫更多空间。"),
    option("episode-duration-custom", "自定义时长", "script:episode-duration-gate:custom", "按项目规格输入单集时长。", {
      childInput: {
        type: "number",
        actionPrefix: "script:episode-duration-gate:",
        buttonLabel: "确认时长",
        labelTemplate: "自定义 {value} 秒",
        min: 30,
        max: 600,
        placeholder: "输入秒数",
        suffix: "秒",
      },
    }),
  ];
}

function buildEpisodeWritingOptions(): ComposerQuestionOption[] {
  return [
    option("episode-writing-batch", "连续批量撰写正文", "script:episode-generate-batch", "由 AI 连续推进正文批量生成。"),
    option(
      "episode-writing-custom-range",
      "自定义正文范围",
      "script:episode-generate-range:custom",
      "支持输入指定集数、逗号列表或范围，例如 1-3、5,8。",
      {
        childInput: {
          type: "text",
          actionPrefix: "script:episode-generate-range:",
          buttonLabel: "确认范围",
          labelTemplate: "生成 {value} 正文",
          placeholder: "输入集数或范围，例如 1-3,5",
          maxLength: 64,
        },
      },
    ),
  ];
}

function buildEpisodeReviewOptions(): ComposerQuestionOption[] {
  return [
    option("episode-review", "批量正文质检", "script:episode-review", "先做常规正文质检。"),
    option(
      "episode-review-repair",
      "生成后自动修复",
      EPISODE_REVIEW_REPAIR_VALUE,
      "发生问题时自动进入修复分支。",
      { drilldownHint: true },
    ),
    option("episode-review-skip", "跳过正文质检", EPISODE_REVIEW_SKIP_VALUE, "直接进入合规审查。"),
  ];
}

function buildEpisodeReviewRepairOptions(): ComposerQuestionOption[] {
  return [
    option("episode-review-repair-worst", "只修复问题最重的一集", "script:episode-review:repair-worst", "保守修复。"),
    option("episode-review-repair-all", "修复全部已审正文", "script:episode-review:repair-all", "一次性处理当前问题正文。"),
  ];
}

function buildComplianceReviewOptions(): ComposerQuestionOption[] {
  return [
    option("compliance-text", "文本合规审查", "script:compliance-run:text", "先关注文本表达风险。", {
      drilldownHint: true,
    }),
    option("compliance-script", "剧本合规审查", "script:compliance-run:script", "同时检查剧情与表达风险。", {
      drilldownHint: true,
    }),
    option("compliance-skip", "跳过合规审查", COMPLIANCE_SKIP_VALUE, "直接进入后续桥接与视频阶段。"),
  ];
}

function buildComplianceStrictnessOptions(): ComposerQuestionOption[] {
  return [
    option("compliance-strictness-standard", "标准", "script:compliance-set-strictness:standard", "平衡覆盖与效率。"),
    option("compliance-strictness-strict", "严格", "script:compliance-set-strictness:strict", "提高风险抓取力度。"),
    option("compliance-strictness-extreme", "极限", "script:compliance-set-strictness:extreme", "最保守口径。"),
  ];
}

function buildComplianceDialogueOptions(): ComposerQuestionOption[] {
  return [
    option("compliance-dialogue-on", "开启对话审查", "script:compliance-toggle-dialogue:on", "把对话风险一起纳入。"),
    option("compliance-dialogue-off", "关闭对话审查", "script:compliance-toggle-dialogue:off", "只检查非对话内容。"),
  ];
}

function buildScriptExportRouteOptions(): ComposerQuestionOption[] {
  return [
    option("script-export-document", "先导出剧本文档", "script:export-document", "先保留一版剧本交付。"),
    option("script-export-video", "直接桥接视频工作流", "script:export-video", "跳过剧本文档导出。"),
  ];
}

function buildScriptDocumentExportOptions(): ComposerQuestionOption[] {
  return [
    option(
      "script-document-export-md",
      "下载 .md",
      "script:export-download-md",
      "导出一份单文件 Markdown 剧本文档。",
      { drilldownHint: true },
    ),
    option(
      "script-document-export-word",
      "导出 Word",
      "script:export-word",
      "导出 .docx Word 文档。",
      { drilldownHint: true },
    ),
    option(
      "script-document-export-episodes",
      "分集下载",
      "script:export-episodes-download",
      "按分集导出多份 Markdown 文件。",
      { drilldownHint: true },
    ),
    option(
      "script-document-export-skip",
      "先跳过，最后一起导出",
      SCRIPT_DOCUMENT_EXPORT_SKIP_VALUE,
      "当前不单独落盘，等到最后的视频导出目录确认后再一起导出。",
    ),
  ];
}

function buildScriptDocumentExportPathOptions(): ComposerQuestionOption[] {
  return [
    option(
      "script-document-export-path-pick",
      "选择导出目录",
      SCRIPT_DOCUMENT_EXPORT_PATH_PICK_VALUE,
      "预先选好剧本文档导出目录。",
    ),
  ];
}

function buildVideoModeOptions(currentMode: VideoGenerationMode): ComposerQuestionOption[] {
  return [
    option(
      "video-mode-text",
      "文生视频",
      "video:kickoff:prefs:mode:text-to-video",
      "直接从拆解与提示词开始。",
      { selected: currentMode === "text-to-video", drilldownHint: true },
    ),
    option(
      "video-mode-image",
      "图生视频",
      "video:kickoff:prefs:mode:image-to-video",
      "先补齐参考资产和分镜图。",
      { selected: currentMode === "image-to-video", drilldownHint: true },
    ),
  ];
}

function buildVideoResolutionOptions(currentResolution: VideoGenerationResolution): ComposerQuestionOption[] {
  return listHomeAgentVideoResolutions()
    .filter((item) => !item.disabledLabel)
    .map((item) =>
      option(
        `video-resolution-${item.value}`,
        item.label,
        `video:kickoff:prefs:resolution:${item.value}`,
        item.description,
        { selected: item.value === currentResolution },
      ),
    );
}

function buildVideoStyleOptions(
  currentPrefs?: Partial<VideoImageGenerationPrefs> | null,
): ComposerQuestionOption[] {
  const normalized = normalizeVideoImageGenerationPrefs(currentPrefs);

  return listHomeAgentImageStyleCategories()
    .filter((category) => category.key !== "custom")
    .map((category) => ({
      id: `video-style-category-${category.key}`,
      label: category.label,
      value: `video:kickoff:prefs:style-category:${category.key}`,
      selected:
        normalized.stylePreset !== "custom" &&
        normalized.styleCategory === category.key,
      rationale: category.description,
      children: listHomeAgentImageStylePresets(category.key).map((preset) => ({
        id: `video-style-preset-${preset.key}`,
        label: preset.label,
        value: `video:kickoff:prefs:style-preset:${preset.key}`,
        selected: normalized.stylePreset === preset.key,
        rationale: preset.description,
      })),
    }));
}

function buildVideoAnalyzeDurationOptions(): ComposerQuestionOption[] {
  return [
    option("video-analyze-60", "60 秒", "video:bridge:analyze:dur:60", "紧凑短节奏。", {
      drilldownHint: true,
    }),
    option("video-analyze-90", "90 秒", "video:bridge:analyze:dur:90", "默认节奏。", {
      drilldownHint: true,
    }),
    option("video-analyze-120", "120 秒", "video:bridge:analyze:dur:120", "给镜头更多空间。", {
      drilldownHint: true,
    }),
    option("video-analyze-custom", "自定义时长", "video:bridge:analyze:dur:custom", "需要时可改成自定义时长。", {
      drilldownHint: true,
      childInput: {
        type: "number",
        actionPrefix: "video:bridge:analyze:dur:",
        buttonLabel: "确认时长",
        labelTemplate: "自定义 {value} 秒",
        min: 15,
        max: 600,
        placeholder: "输入秒数",
        suffix: "秒",
      },
    }),
  ];
}

function buildVideoAnalyzePaceOptions(duration: number): ComposerQuestionOption[] {
  return [
    option("video-analyze-pace-slow", "慢节奏", `video:bridge:analyze:pace:slow:${duration}`, "留更多情绪铺垫。"),
    option("video-analyze-pace-medium", "中节奏", `video:bridge:analyze:pace:medium:${duration}`, "均衡推进。"),
    option("video-analyze-pace-fast", "快节奏", `video:bridge:analyze:pace:fast:${duration}`, "强化冲突与推进。"),
  ];
}

function buildStoryboardXlsxExportOptions(): ComposerQuestionOption[] {
  return [
    option(
      "storyboard-xlsx-export-now",
      "导出分镜 xlsx",
      "video:bridge:export-xlsx",
      "剧本拆解完成后自动导出当前分镜 xlsx。",
      { drilldownHint: true },
    ),
    option(
      "storyboard-xlsx-export-skip",
      "先跳过，最后一起导出",
      STORYBOARD_XLSX_EXPORT_SKIP_VALUE,
      "当前不单独导出，等到最后的视频导出目录确认后再一起导出。",
    ),
  ];
}

function buildStoryboardXlsxExportPathOptions(): ComposerQuestionOption[] {
  return [
    option(
      "storyboard-xlsx-export-path-pick",
      "选择导出目录",
      STORYBOARD_XLSX_EXPORT_PATH_PICK_VALUE,
      "预先选好分镜 xlsx 的导出目录。",
    ),
  ];
}

function buildReferenceAssetOptions(): ComposerQuestionOption[] {
  return [
    option("reference-full", "智能补齐全部参考资产", "video:bridge:reference-assets:full", "角色与场景一起补齐。"),
    option("reference-characters", "只补角色资产", "video:bridge:reference-assets:characters", "聚焦角色主图和变体。"),
    option("reference-characters-main", "只补角色主图", "video:bridge:reference-assets:characters-main", "只生成角色主图。"),
    option("reference-characters-variants", "只补角色变体", "video:bridge:reference-assets:characters-variants", "只处理服装或版本变体。"),
    option("reference-scenes", "只补场景资产", "video:bridge:reference-assets:scenes", "聚焦场景主图和变体。"),
    option("reference-scenes-main", "只补场景主图", "video:bridge:reference-assets:scenes-main", "只生成场景主图。"),
    option("reference-scenes-variants", "只补场景变体", "video:bridge:reference-assets:scenes-variants", "只处理时段或版本变体。"),
  ];
}

function buildFullAutoReferenceAssetOptions(mode: VideoGenerationMode): ComposerQuestionOption[] {
  const options = [
    option(
      "reference-full-auto-full",
      "智能补齐全部参考资产",
      "video:bridge:reference-assets:full",
      mode === "text-to-video"
        ? "文生视频也可以先补齐角色、场景主参考图，后续镜头包和出片会更稳定。"
        : "角色与场景一起补齐。",
    ),
  ];

  if (mode === "text-to-video") {
    options.push(
      option(
        "reference-full-auto-skip",
        "跳过参考资产，直接文生视频",
        VIDEO_REFERENCE_ASSETS_SKIP_VALUE,
        "后续不会自动补齐角色或场景参考图，视频生成只依赖文字提示词，不会参考图片。",
      ),
    );
  }

  return options;
}

function buildStoryboardPrepOptions(totalEpisodes: number): ComposerQuestionOption[] {
  return [
    option("storyboard-frames", "批量准备分镜文本并生成分镜图", "video:bridge:storyboard-frames", "完整补齐分镜图。"),
    option("storyboard-text", "只批量准备分镜文本", "video:bridge:storyboard", "分镜图留给后续流程或人工。"),
    option(
      "storyboard-frames-episode-custom",
      "按集补分镜图",
      "video:bridge:storyboard-frames:episode:custom",
      `按指定集补齐分镜图，范围 1-${totalEpisodes}。`,
      {
        childInput: {
          type: "text",
          actionPrefix: "video:bridge:storyboard-frames:episode:",
          buttonLabel: "确认集数",
          labelTemplate: "补齐第 {value} 集分镜图",
          placeholder: "输入集数，例如 EP01",
          maxLength: 32,
        },
      },
    ),
  ];
}

function buildVideoPromptOptions(): ComposerQuestionOption[] {
  return [
    option("video-prompts-segment", "片段提示词路线", VIDEO_PROMPTS_SEGMENT_VALUE, "继续按片段推进。", {
      drilldownHint: true,
    }),
    option("video-prompts-shot", "镜头提示词路线", VIDEO_PROMPTS_SHOT_VALUE, "改为镜头包路线。", {
      drilldownHint: true,
    }),
  ];
}

function buildVideoPromptDetailOptions(mode: string, totalEpisodes: number): ComposerQuestionOption[] {
  if (mode === VIDEO_PROMPTS_SHOT_VALUE) {
    return [
      option("video-prompts-shot-all", "全部镜头提示词", "video:bridge:prompts:all", "直接生成全部镜头提示词。"),
      option("video-prompts-shot-batch", "分批镜头提示词", "video:bridge:prompts:batch", "分批推进镜头提示词。"),
    ];
  }

  return [
    option("video-prompts-segment-all", "全部片段提示词", "video:bridge:prompts:segment:all", "一次性生成全部片段提示词。"),
    option("video-prompts-segment-remaining", "补齐剩余片段提示词", "video:bridge:prompts:segment:remaining", "只补还缺失的片段。"),
    option("video-prompts-segment-batch", "分批片段提示词", "video:bridge:prompts:segment:batch", "按批次推进。"),
    option(
      "video-prompts-segment-episode-custom",
      "按集生成片段提示词",
      "video:bridge:prompts:segment:episode:custom",
      `只处理指定集，范围 1-${totalEpisodes}。`,
      {
        childInput: {
          type: "text",
          actionPrefix: "video:bridge:prompts:segment:episode:",
          buttonLabel: "确认集数",
          labelTemplate: "生成第 {value} 集片段提示词",
          placeholder: "输入集数，例如 EP01",
          maxLength: 32,
        },
      },
    ),
  ];
}

function buildFullAutoVideoPromptRouteOptions(videoMode: VideoGenerationMode): ComposerQuestionOption[] {
  const baseOptions = buildVideoPromptOptions();
  if (videoMode === "image-to-video") {
    return baseOptions.filter((option) => option.value === VIDEO_PROMPTS_SHOT_VALUE);
  }
  return baseOptions;
}

function buildFullAutoVideoPromptDetailOptions(mode: string, totalEpisodes: number): ComposerQuestionOption[] {
  return buildVideoPromptDetailOptions(mode, totalEpisodes).filter(
    (option) => option.value !== "video:bridge:prompts:segment:remaining",
  );
}

function buildVideoGenerationStrategyOptions(promptMode: string): ComposerQuestionOption[] {
  if (promptMode === VIDEO_PROMPTS_SHOT_VALUE) {
    return [
      option(
        "video-generation-shot-smart",
        "按镜头智能分批生成",
        "video:generate:first",
        "沿着镜头提示词路线，按批次连续生成镜头视频。",
      ),
    ];
  }

  return [
    option(
      "video-generation-segment-smart",
      "按片段智能分批生成",
      "video:generate:segments:first",
      "沿着片段提示词路线，按批次连续生成片段视频。",
    ),
  ];
}

function buildVideoExportOptions(): ComposerQuestionOption[] {
  return [
    option("video-export-ai-auto", "AI 自动处理导出", VIDEO_EXPORT_AI_AUTO_VALUE, "执行结束后自动合成导出。", {
      drilldownHint: true,
    }),
    option("video-export-all", "全部导出素材包", VIDEO_EXPORT_ALL_VALUE, "导出完整素材包。", {
      drilldownHint: true,
    }),
    false &&
    option(
      "video-export-nle-placeholder",
      "导入到剪辑软件",
      "video:export:nle-placeholder",
      "预留能力，当前不可用。",
      { disabled: true },
    ),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));
}

function buildVideoExportDetailOptions(): ComposerQuestionOption[] {
  return [
    option("video-export-subtitle-yes", "自动合并字幕", "video:export:ai-auto:subtitle:yes", "输出时直接加字幕。"),
    option("video-export-subtitle-no", "不自动加字幕", "video:export:ai-auto:subtitle:no", "只导出视频。"),
  ];
}

function buildVideoExportPathOptions(): ComposerQuestionOption[] {
  return [
    option("video-export-path-pick", "选择导出目录", VIDEO_EXPORT_PATH_PICK_VALUE, "预先选好导出目录。"),
  ];
}

export function buildFullAutoProxyUserMessage(
  step: Pick<FullAutoRunStep, "label" | "workflowAction">,
): string {
  switch (step.workflowAction) {
    case "save_setup":
      return "确认项目设定";
    case "generate_creative_plan":
      return "生成创作方案";
    case "generate_characters":
      return "进入角色设计";
    case "generate_directory":
      return "生成分集目录";
    case "generate_outlines":
      return "生成单集细纲";
    case "generate_episode":
    case "generate_episode_batch":
      return "撰写分集正文";
    case "review_episode_quality":
    case "rewrite_episode_from_review":
      return "处理正文质检";
    case "run_compliance_review":
      return "执行合规审查";
    case "skip_compliance_review":
      return "跳过合规审查";
    case "export_project":
      return "导出剧本成果";
    case "prepare_video_generation":
      return "进入视频工作流";
    case "auto_fill_video_bridge_prefs":
      return "补平台与镜头偏好";
    case "analyze_script_for_video":
      return "执行剧本拆解";
    case "extract_video_entities":
      return "提取角色与场景";
    case "generate_video_reference_assets":
      return "生成角色与场景参考";
    case "prepare_storyboard_batch":
      return "准备分镜文本批次";
    case "generate_storyboard_frames":
      return "生成分镜图";
    case "compile_video_shot_packets":
      return "编译镜头指令包";
    case "prepare_segment_video_prompt":
    case "prepare_video_prompt_batch":
      return "生成视频提示词";
    case "generate_segment_video":
      return "生成视频片段";
    case "export_video_asset_bundle":
      return "导出视频成片";
    default:
      return step.label.trim();
  }
}

function buildNormalizedFullAutoProxyUserMessage(
  step: Pick<FullAutoRunStep, "label" | "workflowAction">,
): string {
  switch (step.workflowAction) {
    case "save_setup":
      return "确认项目设定";
    case "generate_creative_plan":
      return "生成创作方案";
    case "generate_characters":
      return "进入角色设计";
    case "generate_directory":
      return "生成分集目录";
    case "generate_outlines":
      return "生成单集细纲";
    case "generate_episode":
    case "generate_episode_batch":
      return "撰写分集正文";
    case "review_episode_quality":
    case "rewrite_episode_from_review":
      return "处理正文质检";
    case "run_compliance_review":
      return "执行合规审查";
    case "skip_compliance_review":
      return "跳过合规审查";
    case "export_project":
      return "导出剧本成果";
    case "prepare_video_generation":
      return "进入视频工作流";
    case "auto_fill_video_bridge_prefs":
      return "补平台与镜头偏好";
    case "analyze_script_for_video":
      return "执行剧本拆解";
    case "extract_video_entities":
      return "提取角色与场景";
    case "generate_video_reference_assets":
      return "生成角色与场景参考";
    case "prepare_storyboard_batch":
      return "准备分镜文本批次";
    case "generate_storyboard_frames":
      return "生成分镜图";
    case "compile_video_shot_packets":
      return "编译镜头指令包";
    case "prepare_segment_video_prompt":
    case "prepare_video_prompt_batch":
      return "生成视频提示词";
    case "generate_segment_video":
      return "生成视频片段";
    case "generate_video_assets":
      return "生成镜头视频";
    case "compile_segment_videos":
      return "合成视频成片";
    case "export_video_asset_bundle":
      return "导出视频素材包";
    default:
      return step.label.trim();
  }
}

function buildReadableFullAutoChecklistLabel(
  step: Pick<FullAutoRunStep, "label" | "workflowAction">,
): string {
  switch (step.workflowAction) {
    case "save_setup":
      return "确认项目设定";
    case "generate_creative_plan":
      return "生成创作方案";
    case "generate_characters":
      return "生成角色设定";
    case "generate_directory":
      return "生成分集目录";
    case "generate_outlines":
      return "执行细纲生成";
    case "generate_episode":
    case "generate_episode_batch":
      return "执行正文撰写";
    case "review_episode_quality":
    case "rewrite_episode_from_review":
      return "处理正文质检";
    case "run_compliance_review":
      return "执行合规审查";
    case "skip_compliance_review":
      return "跳过合规审查";
    case "export_project":
      return "执行剧本导出";
    case "prepare_video_generation":
      return "进入视频工作流";
    case "auto_fill_video_bridge_prefs":
      return "补平台与镜头偏好";
    case "analyze_script_for_video":
      return "执行剧本拆解";
    case "extract_video_entities":
      return "提取角色与场景";
    case "generate_video_reference_assets":
      return "补齐参考资产";
    case "prepare_storyboard_batch":
      return "整理分镜文本";
    case "generate_storyboard_frames":
      return "生成分镜图";
    case "compile_video_shot_packets":
      return "编译镜头指令包";
    case "prepare_segment_video_prompt":
    case "prepare_video_prompt_batch":
      return "生成视频提示词";
    case "generate_segment_video":
      return "生成片段视频";
    case "generate_video_assets":
      return "生成镜头视频";
    case "compile_segment_videos":
      return "合成视频成片";
    case "export_video_asset_bundle":
      return "导出视频素材包";
    default:
      return buildNormalizedFullAutoProxyUserMessage(step).trim();
  }
}

function buildReadableFullAutoChoiceLabel(label: string, value?: string): string {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return label.trim();

  if (normalizedValue === "script:export-video") {
    return "跳过剧本导出，直接进入视频";
  }
  if (normalizedValue === "script:export-document") {
    return "先导出剧本";
  }
  if (normalizedValue === "script:export-download-md") {
    return "导出 Markdown";
  }
  if (normalizedValue === "script:export-episodes-download") {
    return "分集导出 Markdown";
  }
  if (normalizedValue === "video:bridge:export-xlsx") {
    return "导出分镜 Excel";
  }
  if (normalizedValue === "video:bridge:storyboard-frames") {
    return "整理分镜文本并生成分镜图";
  }
  if (normalizedValue === "video:bridge:storyboard") {
    return "只整理分镜文本";
  }
  if (normalizedValue === "video:bridge:reference-assets:full") {
    return "智能补齐全部参考资产";
  }
  if (normalizedValue === VIDEO_REFERENCE_ASSETS_SKIP_VALUE) {
    return "跳过参考资产，直接文生视频";
  }
  if (normalizedValue === "video:bridge:prompts:all") {
    return "全部镜头提示词";
  }
  if (normalizedValue === "video:bridge:prompts:batch") {
    return "分批镜头提示词";
  }
  if (normalizedValue === "video:bridge:prompts:segment:all") {
    return "全部片段提示词";
  }
  if (normalizedValue === "video:bridge:prompts:segment:batch") {
    return "分批片段提示词";
  }
  if (normalizedValue.startsWith("script:outline-generate-range:")) {
    return label.trim().startsWith("生成 ")
      ? label.trim()
      : `按范围生成细纲：${label.trim().replace(/^生成\s*/, "")}`;
  }
  if (normalizedValue.startsWith("script:episode-generate-range:")) {
    return label.trim().startsWith("生成 ")
      ? label.trim().replace(/^生成/, "撰写")
      : `按范围撰写正文：${label.trim()}`;
  }
  if (normalizedValue.startsWith("video:bridge:storyboard-frames:episode:")) {
    const trimmedLabel = label.trim();
    const episodeLabel = trimmedLabel.replace(/^补齐/, "").replace(/分镜图$/, "").trim();
    return `整理${episodeLabel}分镜文本并生成分镜图`;
  }
  if (normalizedValue.startsWith("video:bridge:prompts:segment:episode:")) {
    return `生成${label.trim().replace(/^生成/, "")}`;
  }

  return label.trim();
}

export function buildFullAutoCollectedChoiceUserMessage(label: string, value?: string): string {
  const trimmedLabel = buildReadableFullAutoChoiceLabel(label, value);
  if (trimmedLabel) return trimmedLabel;
  return String(value ?? "").trim();
}

function getFullAutoStrategyLabel(plan: FullAutoRunPlan, key: FullAutoStrategyKey): string | undefined {
  const stageStrategy = plan.stageStrategies?.[key];
  if (stageStrategy?.label?.trim()) return stageStrategy.label.trim();
  const displayValue = plan.displayAnswers?.[key];
  return typeof displayValue === "string" && displayValue.trim() ? displayValue.trim() : undefined;
}

export function getResolvedFullAutoStrategyLabel(
  plan: FullAutoRunPlan,
  key: FullAutoStrategyKey,
): string | undefined {
  switch (key) {
    case "outlineGeneration":
      return getFullAutoStrategyLabel(plan, "outlineGenerationDetail") ?? getFullAutoStrategyLabel(plan, "outlineGeneration");
    case "episodeWriting":
      return getFullAutoStrategyLabel(plan, "episodeWritingDetail") ?? getFullAutoStrategyLabel(plan, "episodeWriting");
    case "episodeReview":
      return getFullAutoStrategyLabel(plan, "episodeReviewDetail") ?? getFullAutoStrategyLabel(plan, "episodeReview");
    case "videoAnalyze":
      return getFullAutoStrategyLabel(plan, "videoAnalyzeDetail") ?? getFullAutoStrategyLabel(plan, "videoAnalyze");
    case "videoPrompts":
      return getFullAutoStrategyLabel(plan, "videoPromptsDetail") ?? getFullAutoStrategyLabel(plan, "videoPrompts");
    case "videoExport":
      return getFullAutoStrategyLabel(plan, "videoExportDetail") ?? getFullAutoStrategyLabel(plan, "videoExport");
    default:
      return getFullAutoStrategyLabel(plan, key);
  }
}

function buildFullAutoExecutionStrategySummary(
  plan: FullAutoRunPlan,
  step: Pick<FullAutoRunStep, "workflowAction" | "strategyKey">,
): string | undefined {
  if (step.workflowAction === "prepare_video_generation") {
    const videoModeLabel = getFullAutoStrategyLabel(plan, "videoMode");
    const videoStyleLabel = getFullAutoStrategyLabel(plan, "videoStyle");
    if (videoModeLabel && videoStyleLabel) return `${videoModeLabel} / ${videoStyleLabel}`;
    return videoModeLabel ?? videoStyleLabel;
  }

  if (step.workflowAction === "export_project") {
    return (
      getResolvedFullAutoStrategyLabel(plan, "scriptDocumentExport") ??
      getResolvedFullAutoStrategyLabel(plan, "scriptExportRoute")
    );
  }

  if (step.workflowAction === "generate_video_reference_assets") {
    return (
      getResolvedFullAutoStrategyLabel(plan, "referenceAssets") ??
      getResolvedFullAutoStrategyLabel(plan, "videoStyle")
    );
  }

  if (step.workflowAction === "prepare_storyboard_batch" || step.workflowAction === "generate_storyboard_frames") {
    return getResolvedFullAutoStrategyLabel(plan, "storyboardPrep");
  }

  return step.strategyKey ? getResolvedFullAutoStrategyLabel(plan, step.strategyKey) : undefined;
}

export function buildFullAutoExecutionUserMessage(
  plan: FullAutoRunPlan,
  step: Pick<FullAutoRunStep, "label" | "workflowAction" | "strategyKey">,
): string {
  const actionLabel = buildReadableFullAutoChecklistLabel(step).trim();
  const strategyLabel = buildFullAutoExecutionStrategySummary(plan, step)?.trim();
  if (!strategyLabel) return actionLabel;
  if (strategyLabel === actionLabel) return actionLabel;
  if (
    [
      "prepare_video_generation",
      "export_project",
      "generate_video_reference_assets",
      "prepare_storyboard_batch",
      "generate_storyboard_frames",
      "prepare_segment_video_prompt",
      "prepare_video_prompt_batch",
      "generate_segment_video",
      "generate_video_assets",
      "compile_segment_videos",
      "export_video_asset_bundle",
      "analyze_script_for_video",
    ].includes(step.workflowAction ?? "")
  ) {
    return `${actionLabel}：${strategyLabel}`;
  }
  return strategyLabel;
}

function buildPreflightContextBadges(
  plan: FullAutoRunPlan,
  definition: FullAutoStrategyDefinition,
): NonNullable<ComposerQuestion["statusBadges"]> {
  const badges: NonNullable<ComposerQuestion["statusBadges"]> = [];
  const videoModeLabel = getFullAutoStrategyLabel(plan, "videoMode");
  if (
    videoModeLabel &&
    [
      "video-setup",
      "video-analyze",
      "reference-assets",
      "storyboard",
      "prompts",
      "export",
    ].includes(definition.majorId)
  ) {
    badges.push({
      label: "视频模式",
      value: videoModeLabel,
      tone: videoModeLabel === "文生视频" ? "success" : videoModeLabel === "图生视频" ? "notice" : "default",
    });
  }

  const routeKey =
    definition.key === "episodeReviewDetail"
      ? "episodeReview"
      : definition.key === "complianceReviewStrictness" || definition.key === "complianceReviewDialogue"
        ? "complianceReview"
        : definition.key === "scriptDocumentExportPath"
          ? "scriptDocumentExport"
          : definition.key === "storyboardXlsxExportPath"
            ? "storyboardXlsxExport"
        : definition.key === "videoPromptsDetail" || definition.key === "videoGeneration"
          ? "videoPrompts"
          : definition.key === "videoExportDetail" || definition.key === "videoExportPath"
            ? "videoExport"
            : null;
  if (!routeKey) return badges;

  const routeLabel = getFullAutoStrategyLabel(plan, routeKey);
  if (routeLabel) {
    badges.push({ label: "路线", value: routeLabel, tone: "default" });
  }
  return badges;
}

function buildNormalizedPreflightContextBadges(
  plan: FullAutoRunPlan,
  definition: FullAutoStrategyDefinition,
): NonNullable<ComposerQuestion["statusBadges"]> {
  const badges: NonNullable<ComposerQuestion["statusBadges"]> = [];
  const videoModeLabel = getFullAutoStrategyLabel(plan, "videoMode");
  if (
    videoModeLabel &&
    [
      "video-setup",
      "video-analyze",
      "reference-assets",
      "storyboard",
      "prompts",
      "export",
    ].includes(definition.majorId)
  ) {
    badges.push({
      label: "视频模式",
      value: videoModeLabel,
      tone: videoModeLabel === "文生视频" ? "success" : videoModeLabel === "图生视频" ? "notice" : "default",
    });
  }

  const routeKey =
    definition.key === "episodeReviewDetail"
      ? "episodeReview"
      : definition.key === "complianceReviewStrictness" || definition.key === "complianceReviewDialogue"
        ? "complianceReview"
        : definition.key === "scriptDocumentExportPath"
          ? "scriptDocumentExport"
          : definition.key === "storyboardXlsxExportPath"
            ? "storyboardXlsxExport"
            : definition.key === "videoPromptsDetail" || definition.key === "videoGeneration"
              ? "videoPrompts"
              : definition.key === "videoExportDetail" || definition.key === "videoExportPath"
                ? "videoExport"
                : null;
  if (!routeKey) return badges;

  const routeLabel = getFullAutoStrategyLabel(plan, routeKey);
  if (routeLabel) {
    badges.push({ label: "路线", value: routeLabel, tone: "default" });
  }
  return badges;
}

function buildNormalizedFullAutoQuestion(
  definition: FullAutoStrategyDefinition,
  progress: QuestionProgressMeta,
  contextBadges: NonNullable<ComposerQuestion["statusBadges"]> = [],
): ComposerQuestion {
  const statusBadges: NonNullable<ComposerQuestion["statusBadges"]> = [
    { label: "全自动", value: getFullAutoPhaseLabel(definition.majorId, definition.phase), tone: "default" },
    ...contextBadges,
    { label: "总步骤", value: `${progress.majorIndex}/${progress.majorTotal}`, tone: "default" },
  ];

  return {
    id: `${FULL_AUTO_QUESTION_PREFIX}:${definition.key}`,
    title: definition.title,
    description: definition.description,
    options: definition.options,
    presentation: "card",
    allowCustomInput: definition.allowCustomInput ?? false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: progress.majorIndex - 1,
    totalSteps: progress.majorTotal,
    answerKey: `${FULL_AUTO_QUESTION_PREFIX}:${definition.key}`,
    statusBadges,
  };
}

function getFullAutoPhaseLabel(majorId: string, fallback: string): string {
  switch (majorId) {
    case "outline":
      return "单集细纲";
    case "writing":
      return "正文撰写";
    case "review":
      return "正文质检";
    case "compliance":
      return "合规审查";
    case "script-export":
      return "剧本导出";
    case "video-setup":
      return "进入视频工作流";
    case "video-analyze":
      return "剧本拆解";
    case "reference-assets":
      return "角色与场景";
    case "storyboard":
      return "分镜图生成";
    case "prompts":
      return "视频提示词";
    case "export":
      return "预览导出";
    default:
      return fallback;
  }
}

function ensureAutoStrategies(plan: FullAutoRunPlan): FullAutoRunPlan {
  return {
    ...plan,
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      videoGeneration:
        plan.stageStrategies?.videoGeneration ??
        {
          key: "videoGeneration",
          phase: "视频生成",
          value: DEFAULT_VIDEO_GENERATION_VALUE,
          label: "智能生成片段",
        },
    },
    collectedAnswers: {
      ...(plan.collectedAnswers ?? plan.answers ?? {}),
    },
  };
}

function hasCollectedFullAutoStrategy(plan: FullAutoRunPlan, key: FullAutoStrategyKey): boolean {
  return Object.prototype.hasOwnProperty.call(plan.collectedAnswers ?? {}, key);
}

function parseVideoAnalyzeDurationValue(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^video:bridge:analyze:dur:(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildPreflightStrategyDefinitions(plan: FullAutoRunPlan): FullAutoStrategyDefinition[] {
  const syncedPlan = ensureAutoStrategies(plan);
  const totalEpisodes = readTotalEpisodes(syncedPlan.setupInput);
  const currentVideoMode = getFullAutoVideoMode(syncedPlan);
  const currentVideoResolution = getFullAutoVideoResolution(syncedPlan);
  const currentTargetMarket =
    typeof syncedPlan.setupInput?.targetMarket === "string" && syncedPlan.setupInput.targetMarket.trim()
      ? syncedPlan.setupInput.targetMarket.trim()
      : "cn";
  const episodeReviewMode = getFullAutoStrategyValue(syncedPlan, "episodeReview");
  const complianceMode = getFullAutoStrategyValue(syncedPlan, "complianceReview");
  const scriptExportMode = getFullAutoStrategyValue(syncedPlan, "scriptExportRoute");
  const scriptDocumentExportMode = getFullAutoStrategyValue(syncedPlan, "scriptDocumentExport");
  const videoAnalyzeDuration =
    parseVideoAnalyzeDurationValue(getFullAutoStrategyValue(syncedPlan, "videoAnalyze"));
  const storyboardXlsxExportMode = getFullAutoStrategyValue(syncedPlan, "storyboardXlsxExport");
  const videoPromptsMode = getFullAutoStrategyValue(syncedPlan, "videoPrompts");
  const videoExportMode = getFullAutoStrategyValue(syncedPlan, "videoExport");
  const videoExportDetail = getFullAutoStrategyValue(syncedPlan, "videoExportDetail");
  const currentVideoStylePrefs = getFullAutoVideoImagePrefs(syncedPlan);
  const includeScriptAuthoring = syncedPlan.mode !== "video-workflow-v1";
  const includeAdaptationPreflight = syncedPlan.mode === "adaptation-v1";

  const definitions: FullAutoStrategyDefinition[] = [
    {
      key: "outlineGeneration",
      majorId: "outline",
      phase: "单集细纲",
      title: "单集细纲生成策略",
      description: "先确定细纲如何批量推进。",
      options: buildOutlineOptions(totalEpisodes),
      allowCustomInput: true,
    },
    {
      key: "episodeDuration",
      majorId: "writing",
      phase: "正文撰写",
      title: "正文单集时长",
      description: "这个时长会作为后续正文生成的单集篇幅约束。",
      options: buildEpisodeDurationOptions(),
      allowCustomInput: true,
    },
    {
      key: "episodeWriting",
      majorId: "writing",
      phase: "正文撰写",
      title: "正文批量撰写策略",
      description: "正文阶段由 AI 连续推进。",
      options: buildEpisodeWritingOptions(),
      allowCustomInput: true,
    },
    {
      key: "episodeReview",
      majorId: "review",
      phase: "正文质检",
      title: "正文质检策略",
      description: "正文完成后如何质检或跳过。",
      options: buildEpisodeReviewOptions(),
    },
    ...(episodeReviewMode === EPISODE_REVIEW_REPAIR_VALUE
      ? [
          {
            key: "episodeReviewDetail" as const,
            majorId: "review",
            phase: "正文质检",
            title: "正文修复范围",
            description: "决定修复范围。",
            options: buildEpisodeReviewRepairOptions(),
          },
        ]
      : []),
    {
      key: "complianceReview",
      majorId: "compliance",
      phase: "合规审查",
      title: "合规审查模式",
      description: "先决定是否进入合规审查。",
      options: buildComplianceReviewOptions(),
    },
    ...(complianceMode && complianceMode !== COMPLIANCE_SKIP_VALUE
      ? [
          {
            key: "complianceReviewStrictness" as const,
            majorId: "compliance",
            phase: "合规审查",
            title: "合规严格度",
            description: "继续确认合规审查的严格度。",
            options: buildComplianceStrictnessOptions(),
            branchGroup: "compliance-review",
          },
          {
            key: "complianceReviewDialogue" as const,
            majorId: "compliance",
            phase: "合规审查",
            title: "对话审查开关",
            description: "决定是否把对话内容纳入审查。",
            options: buildComplianceDialogueOptions(),
            branchGroup: "compliance-review",
          },
        ]
      : []),
    {
      key: "scriptExportRoute",
      majorId: "script-export",
      phase: "剧本导出",
      title: "剧本导出路线",
      description: "决定是先导出剧本，还是直接桥接视频工作流。",
      options: buildScriptExportRouteOptions(),
    },
    ...(scriptExportMode && scriptExportMode !== "script:export-video"
      ? [
          {
            key: "scriptDocumentExport" as const,
            majorId: "script-export",
            phase: "剧本导出",
            title: "导出剧本文档",
            description: "选择要提前落盘的剧本文档类型；如果先跳过，会在最后的视频导出目录里一起导出。",
            options: buildScriptDocumentExportOptions(),
            branchGroup: "script-document-export",
          },
        ]
      : []),
    {
      key: "videoMode",
      majorId: "video-setup",
      phase: "进入视频工作流",
      title: "视频生成模式",
      description: "选择文生视频或图生视频。",
      options: buildVideoModeOptions(currentVideoMode),
    },
    {
      key: "videoStyle",
      majorId: "video-setup",
      phase: "进入视频工作流",
      title: "选择画面风格类型",
      description: "直接选择预设风格；如需自定义，请在底部输入风格说明；如需参考图，请上传图片后发送。",
      options: buildVideoStyleOptions(currentVideoStylePrefs),
      allowCustomInput: true,
    },
    {
      key: "videoResolution",
      majorId: "video-setup",
      phase: "进入视频工作流",
      title: "视频分辨率",
      description: "后续视频生成会沿用这里的分辨率设定。",
      options: buildVideoResolutionOptions(currentVideoResolution),
    },
    {
      key: "videoAnalyze",
      majorId: "video-analyze",
      phase: "剧本拆解",
      title: "单集拆解时长",
      description: "先确认单集拆解时长。",
      options: buildVideoAnalyzeDurationOptions(),
      allowCustomInput: true,
    },
    ...(videoAnalyzeDuration
      ? [
          {
            key: "videoAnalyzeDetail" as const,
            majorId: "video-analyze",
            phase: "剧本拆解",
            title: "视频节奏",
            description: "继续确认镜头节奏。",
            options: buildVideoAnalyzePaceOptions(videoAnalyzeDuration),
          },
        ]
      : []),
    {
      key: "storyboardXlsxExport",
      majorId: "video-analyze",
      phase: "剧本拆解",
      title: "导出分镜 xlsx",
      description: "可以在剧本拆解完成后立刻导出分镜 xlsx；如果先跳过，会在最后的视频导出目录里一起导出。",
      options: buildStoryboardXlsxExportOptions(),
      branchGroup: "storyboard-xlsx-export",
    },
    ...(currentVideoMode === "text-to-video"
      ? [
          {
            key: "referenceAssets" as const,
            majorId: "reference-assets",
            phase: "角色与场景",
            title: "角色与场景路线",
            description: "文生视频可先智能补齐参考资产；如果跳过，本轮会直接按纯文生视频推进，后续不会自动补图。",
            options: buildFullAutoReferenceAssetOptions(currentVideoMode),
          },
        ]
      : []),
    ...(currentVideoMode === "image-to-video"
      ? [
          {
            key: "referenceAssets" as const,
            majorId: "reference-assets",
            phase: "角色与场景",
            title: "角色与场景资产补齐",
            description: "图生视频先补齐角色与场景参考资产。",
            options: buildFullAutoReferenceAssetOptions(currentVideoMode),
          },
          {
            key: "storyboardPrep" as const,
            majorId: "storyboard",
            phase: "分镜图生成",
            title: "分镜文本 / 分镜图准备",
            description: "决定是否同步生成分镜图。",
            options: buildStoryboardPrepOptions(totalEpisodes).filter(
              (option) => option.value !== "video:bridge:storyboard",
            ),
          },
        ]
      : []),
    {
      key: "videoPrompts",
      majorId: "prompts",
      phase: "视频提示词",
      title: "视频提示词主路线",
      description: "先确认走片段提示词还是镜头提示词路线。",
      options: buildFullAutoVideoPromptRouteOptions(currentVideoMode),
    },
    ...(videoPromptsMode
      ? [
          {
            key: "videoPromptsDetail" as const,
            majorId: "prompts",
            phase: "视频提示词",
            title: "视频提示词生成方式",
            description: "继续细化提示词批量生成方式。",
            options: buildFullAutoVideoPromptDetailOptions(videoPromptsMode, totalEpisodes),
            branchGroup: "video-prompt-route",
          },
          {
            key: "videoGeneration" as const,
            majorId: "prompts",
            phase: "瑙嗛鐢熸垚",
            title: videoPromptsMode === VIDEO_PROMPTS_SHOT_VALUE ? "镜头生成策略" : "片段生成策略",
            description:
              videoPromptsMode === VIDEO_PROMPTS_SHOT_VALUE
                ? "当前走镜头提示词路线，继续确认镜头视频怎么分批生成。"
                : "当前走片段提示词路线，继续确认片段视频怎么分批生成。",
            options: buildVideoGenerationStrategyOptions(videoPromptsMode),
            branchGroup: "video-prompt-route",
          },
        ]
      : []),
    {
      key: "videoExport",
      majorId: "export",
      phase: "预览导出",
      title: "视频导出策略",
      description: "决定是 AI 自动合成导出，还是导出完整素材包。",
      options: buildVideoExportOptions(),
    },
    ...(videoExportMode === VIDEO_EXPORT_AI_AUTO_VALUE
      ? [
          {
            key: "videoExportDetail" as const,
            majorId: "export",
            phase: "预览导出",
            title: "AI 导出细节",
            description: "决定是否在合成时自动附加字幕。",
            options: buildVideoExportDetailOptions(),
            branchGroup: "video-export",
          },
        ]
      : []),
    ...(videoExportMode &&
    (videoExportMode === VIDEO_EXPORT_ALL_VALUE || Boolean(videoExportDetail))
      ? [
          {
            key: "videoExportPath" as const,
            majorId: "export",
            phase: "预览导出",
            title: "视频导出目录",
            description: "先选择导出目录，选完后直接写入当前预采集策略。",
            options: buildVideoExportPathOptions(),
            branchGroup: videoExportMode === VIDEO_EXPORT_AI_AUTO_VALUE ? "video-export" : undefined,
          },
        ]
      : []),
  ];

  if (includeAdaptationPreflight) {
    definitions.unshift(
      {
        key: "adaptationEpisodeCount",
        majorId: "adaptation-setup",
        phase: "参考改编",
        title: "改编总集数",
        description: "先确认改编后的目标总集数，再继续后续结构转译与分集生产。",
        options: buildAdaptationEpisodeCountOptions(totalEpisodes),
        allowCustomInput: true,
      },
      {
        key: "adaptationTargetMarket",
        majorId: "adaptation-setup",
        phase: "参考改编",
        title: "目标市场",
        description: "目标市场会直接影响结构转译、语言风格和后续视频出片约束。",
        options: buildAdaptationTargetMarketOptions(currentTargetMarket),
      },
      {
        key: "adaptationGenres",
        majorId: "adaptation-setup",
        phase: "参考改编",
        title: "改编方向题材",
        description: "选择最贴近这次改编方向的题材标签，后续会沿着这个方向自动推进。",
        options: buildAdaptationGenreOptions(
          getFullAutoStrategyValue(syncedPlan, "adaptationTargetMarket")
            ?.replace("script:adaptation-target-market:", "") || currentTargetMarket,
        ),
        allowCustomInput: true,
      },
    );
  }

  const definitionOrder = [
    "adaptationEpisodeCount",
    "adaptationTargetMarket",
    "adaptationGenres",
    "outlineGeneration",
    "episodeDuration",
    "episodeWriting",
    "episodeReview",
    "episodeReviewDetail",
    "complianceReview",
    "complianceReviewStrictness",
    "complianceReviewDialogue",
    "scriptExportRoute",
    "scriptDocumentExport",
    "scriptDocumentExportPath",
    "videoAnalyze",
    "videoAnalyzeDetail",
    "storyboardXlsxExport",
    "storyboardXlsxExportPath",
    "videoMode",
    "videoStyle",
    "videoResolution",
    "referenceAssets",
    "storyboardPrep",
    "videoPrompts",
    "videoPromptsDetail",
    "videoGeneration",
    "videoExport",
    "videoExportDetail",
    "videoExportPath",
  ] satisfies string[];
  const orderByKey = new Map(definitionOrder.map((key, index) => [key, index]));
  const scriptOnlyKeys = new Set<FullAutoStrategyKey>([
    "outlineGeneration",
    "outlineGenerationDetail",
    "episodeDuration",
    "episodeWriting",
    "episodeWritingDetail",
    "episodeReview",
    "episodeReviewDetail",
    "complianceReview",
    "complianceReviewStrictness",
    "complianceReviewDialogue",
    "scriptExportRoute",
    "scriptDocumentExport",
    "scriptDocumentExportPath",
  ]);

  return definitions
    .filter((definition) => includeScriptAuthoring || !scriptOnlyKeys.has(definition.key))
    .filter((definition) => definition.key !== "videoResolution")
    .sort((left, right) => {
      const leftIndex = orderByKey.get(left.key) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = orderByKey.get(right.key) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
}

function buildProgressMap(definitions: FullAutoStrategyDefinition[]): Map<FullAutoStrategyKey, QuestionProgressMeta> {
  const majorIds = [...new Set(definitions.map((item) => item.majorId))];
  const branchCounts = new Map<string, number>();
  for (const definition of definitions) {
    if (!definition.branchGroup) continue;
    branchCounts.set(definition.branchGroup, (branchCounts.get(definition.branchGroup) ?? 0) + 1);
  }

  const seenByBranch = new Map<string, number>();
  const progress = new Map<FullAutoStrategyKey, QuestionProgressMeta>();
  definitions.forEach((definition) => {
    const branchGroup = definition.branchGroup;
    const branchTotal = branchGroup ? (branchCounts.get(branchGroup) ?? 0) : undefined;
    const subIndex =
      branchGroup && branchTotal
        ? (seenByBranch.get(branchGroup) ?? 0) + 1
        : undefined;
    if (branchGroup && subIndex != null) {
      seenByBranch.set(branchGroup, subIndex);
    }
    progress.set(definition.key, {
      majorIndex: majorIds.indexOf(definition.majorId) + 1,
      majorTotal: majorIds.length,
      ...(subIndex != null && branchTotal != null
        ? {
            subIndex,
            subTotal: branchTotal,
          }
        : {}),
    });
  });
  return progress;
}

function getDefinitionForQuestion(
  plan: FullAutoRunPlan,
  question: ComposerQuestion | null | undefined,
): FullAutoStrategyDefinition | null {
  if (!isFullAutoStrategyQuestion(question)) return null;
  const key = question.answerKey.replace(`${FULL_AUTO_QUESTION_PREFIX}:`, "") as FullAutoStrategyKey;
  return buildPreflightStrategyDefinitions(ensureAutoStrategies(plan)).find((item) => item.key === key) ?? null;
}

function pruneTransientStrategies(plan: FullAutoRunPlan): FullAutoRunPlan {
  const syncedPlan = ensureAutoStrategies(plan);
  const allowedKeys = new Set(buildPreflightStrategyDefinitions(syncedPlan).map((item) => item.key));
  const keepHiddenScriptExportPath =
    getFullAutoStrategyValue(syncedPlan, "scriptDocumentExport") != null &&
    getFullAutoStrategyValue(syncedPlan, "scriptDocumentExport") !== SCRIPT_DOCUMENT_EXPORT_SKIP_VALUE;
  const keepHiddenStoryboardXlsxPath =
    getFullAutoStrategyValue(syncedPlan, "storyboardXlsxExport") != null &&
    getFullAutoStrategyValue(syncedPlan, "storyboardXlsxExport") !== STORYBOARD_XLSX_EXPORT_SKIP_VALUE;
  const nextStageStrategies: Record<string, FullAutoStageStrategy> = {};
  for (const [key, value] of Object.entries(syncedPlan.stageStrategies ?? {})) {
    if (
      key === "videoGeneration" ||
      key === "defaultVideoMode" ||
      key === "defaultVideoResolution" ||
      (key === "scriptDocumentExportPath" && keepHiddenScriptExportPath) ||
      (key === "storyboardXlsxExportPath" && keepHiddenStoryboardXlsxPath) ||
      allowedKeys.has(key as FullAutoStrategyKey)
    ) {
      nextStageStrategies[key] = value;
    }
  }

  const nextAnswers = { ...syncedPlan.answers };
  const nextDisplayAnswers = { ...syncedPlan.displayAnswers };
  const nextCollectedAnswers = { ...(syncedPlan.collectedAnswers ?? {}) };
  for (const key of Object.keys(nextAnswers)) {
    if (
      key === "kickoff" ||
      key === "defaultVideoMode" ||
      key === "defaultVideoResolution" ||
      key === "videoGeneration" ||
      (key === "scriptDocumentExportPath" && keepHiddenScriptExportPath) ||
      (key === "storyboardXlsxExportPath" && keepHiddenStoryboardXlsxPath) ||
      allowedKeys.has(key as FullAutoStrategyKey)
    ) {
      continue;
    }
    delete nextAnswers[key];
    delete nextDisplayAnswers[key];
    delete nextCollectedAnswers[key];
  }

  return {
    ...syncedPlan,
    stageStrategies: nextStageStrategies,
    answers: nextAnswers,
    displayAnswers: nextDisplayAnswers,
    collectedAnswers: nextCollectedAnswers,
  };
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
      videoGeneration: {
        key: "videoGeneration",
        phase: "视频生成",
        value: DEFAULT_VIDEO_GENERATION_VALUE,
        label: "智能生成片段",
      },
    },
    plannedSteps: [],
    steps: [],
    currentStepIndex: 0,
    retryCounts: {},
  };
  return syncFullAutoPlanSteps(basePlan);
}

export function createFullAutoAdaptationRunPlan(
  seed: FullAutoAdaptationRunSeed,
  videoGenerationPrefs?: { mode?: VideoGenerationMode; resolution?: VideoGenerationResolution },
): FullAutoRunPlan {
  const defaultVideoMode = normalizeVideoGenerationMode(videoGenerationPrefs?.mode);
  const defaultVideoResolution = normalizeVideoGenerationResolution(videoGenerationPrefs?.resolution);
  const createdAt = new Date().toISOString();
  const title = seed.title?.trim() || "未命名改编项目";
  const basePlan: FullAutoRunPlan = {
    id: globalThis.crypto?.randomUUID?.() ?? `full-auto-${Date.now()}`,
    projectKind: "adaptation",
    entryTemplateId: "adaptation",
    mode: "adaptation-v1",
    createdAt,
    setupInput: {
      projectKind: "adaptation",
      title,
      referenceScript: seed.referenceScript,
      totalEpisodes: 60,
      targetMarket: "cn",
      automationMode: "full-auto",
    },
    userBubble: seed.userBubble,
    structuredSummary: `参考改编：${title}`,
    answers: {
      kickoff: seed.referenceScript,
      defaultVideoMode: `video:kickoff:prefs:mode:${defaultVideoMode}`,
      defaultVideoResolution: `video:kickoff:prefs:resolution:${defaultVideoResolution}`,
    },
    displayAnswers: {
      kickoff: seed.userBubble,
      defaultVideoMode: defaultVideoMode === "image-to-video" ? "图生视频" : "文生视频",
      defaultVideoResolution,
    },
    collectedAnswers: {
      kickoff: seed.referenceScript,
    },
    stageStrategies: {
      videoGeneration: {
        key: "videoGeneration",
        phase: "视频生成",
        value: DEFAULT_VIDEO_GENERATION_VALUE,
        label: "智能生成片段",
      },
    },
    plannedSteps: [],
    steps: [],
    currentStepIndex: 0,
    retryCounts: {},
  };
  return syncFullAutoPlanSteps(basePlan);
}

export function createFullAutoVideoWorkflowRunPlan(
  seed: FullAutoVideoWorkflowRunSeed,
  videoGenerationPrefs?: { mode?: VideoGenerationMode; resolution?: VideoGenerationResolution },
): FullAutoRunPlan {
  const defaultVideoMode = normalizeVideoGenerationMode(videoGenerationPrefs?.mode);
  const defaultVideoResolution = normalizeVideoGenerationResolution(videoGenerationPrefs?.resolution);
  const createdAt = new Date().toISOString();
  const basePlan: FullAutoRunPlan = {
    id: globalThis.crypto?.randomUUID?.() ?? `full-auto-${Date.now()}`,
    projectKind: "video",
    entryTemplateId: "video",
    mode: "video-workflow-v1",
    createdAt,
    setupInput: {
      projectKind: "video",
      ...(seed.projectId ? { projectId: seed.projectId } : {}),
      ...(seed.sourceProjectId ? { sourceProjectId: seed.sourceProjectId } : {}),
      ...(seed.title?.trim() ? { title: seed.title.trim() } : {}),
      ...(seed.script?.trim() ? { script: seed.script.trim() } : {}),
      automationMode: "full-auto",
    },
    userBubble: seed.userBubble,
    structuredSummary: seed.title?.trim()
      ? `视频工作流：${seed.title.trim()}`
      : seed.source === "use-current-project"
        ? "视频工作流：使用当前剧本项目"
        : "视频工作流：上传剧本",
    answers: {
      kickoff: seed.userBubble,
      defaultVideoMode: `video:kickoff:prefs:mode:${defaultVideoMode}`,
      defaultVideoResolution: `video:kickoff:prefs:resolution:${defaultVideoResolution}`,
    },
    displayAnswers: {
      kickoff: seed.userBubble,
      defaultVideoMode: defaultVideoMode === "image-to-video" ? "图生视频" : "文生视频",
      defaultVideoResolution,
    },
    collectedAnswers: {
      kickoff: seed.userBubble,
    },
    stageStrategies: {
      videoGeneration: {
        key: "videoGeneration",
        phase: "视频生成",
        value: DEFAULT_VIDEO_GENERATION_VALUE,
        label: "智能生成片段",
      },
    },
    plannedSteps: [],
    steps: [],
    currentStepIndex: 0,
    retryCounts: {},
  };
  return syncFullAutoPlanSteps(basePlan);
}

export function isFullAutoStrategyQuestion(question: ComposerQuestion | null | undefined): boolean {
  return Boolean(question?.answerKey?.startsWith(`${FULL_AUTO_QUESTION_PREFIX}:`));
}

export function getNextFullAutoStrategyQuestion(plan: FullAutoRunPlan): ComposerQuestion | null {
  const syncedPlan = pruneTransientStrategies(plan);
  const definitions = buildPreflightStrategyDefinitions(syncedPlan);
  const nextDefinition = definitions.find((definition) => !hasCollectedFullAutoStrategy(syncedPlan, definition.key));
  if (!nextDefinition) return null;
  const progress = buildProgressMap(definitions).get(nextDefinition.key);
  return progress
    ? buildNormalizedFullAutoQuestion(
        nextDefinition,
        progress,
        buildNormalizedPreflightContextBadges(syncedPlan, nextDefinition),
      )
    : null;
}

export function applyFullAutoStrategyAnswer(
  plan: FullAutoRunPlan,
  value: string,
  label: string,
  question: ComposerQuestion | null | undefined,
): FullAutoRunPlan | null {
  const definition = getDefinitionForQuestion(plan, question);
  if (!definition) return null;

  const nextPlan: FullAutoRunPlan = {
    ...plan,
    answers: {
      ...plan.answers,
      [definition.key]: value,
    },
    displayAnswers: {
      ...plan.displayAnswers,
      [definition.key]: label,
    },
    collectedAnswers: {
      ...(plan.collectedAnswers ?? {}),
      [definition.key]: value,
    },
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      [definition.key]: {
        key: definition.key,
        phase: definition.phase,
        value,
        label,
      },
    },
  };

  return syncFullAutoPlanSteps(pruneTransientStrategies(nextPlan));
}

export function getFullAutoStrategyValue(plan: FullAutoRunPlan, key: string): string | undefined {
  return plan.stageStrategies?.[key]?.value;
}

export function getResolvedFullAutoStrategyValue(plan: FullAutoRunPlan, key: string): string | undefined {
  switch (key) {
    case "outlineGeneration":
      return getFullAutoStrategyValue(plan, "outlineGenerationDetail") ?? getFullAutoStrategyValue(plan, "outlineGeneration");
    case "episodeWriting":
      return getFullAutoStrategyValue(plan, "episodeWritingDetail") ?? getFullAutoStrategyValue(plan, "episodeWriting");
    case "episodeReview":
      return getFullAutoStrategyValue(plan, "episodeReviewDetail") ?? getFullAutoStrategyValue(plan, "episodeReview");
    case "videoAnalyze":
      return getFullAutoStrategyValue(plan, "videoAnalyzeDetail") ?? getFullAutoStrategyValue(plan, "videoAnalyze");
    case "videoPrompts":
      return getFullAutoStrategyValue(plan, "videoPromptsDetail") ?? getFullAutoStrategyValue(plan, "videoPrompts");
    case "videoExport":
      return getFullAutoStrategyValue(plan, "videoExportDetail") ?? getFullAutoStrategyValue(plan, "videoExport");
    default:
      return getFullAutoStrategyValue(plan, key);
  }
}

export function getFullAutoVideoMode(plan: FullAutoRunPlan): VideoGenerationMode {
  const value =
    getFullAutoStrategyValue(plan, "videoMode") ??
    String(plan.answers.defaultVideoMode ?? `video:kickoff:prefs:mode:${DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.mode}`);
  return normalizeVideoGenerationMode(value.replace("video:kickoff:prefs:mode:", ""));
}

export function getFullAutoVideoResolution(plan: FullAutoRunPlan): VideoGenerationResolution {
  const value =
    getFullAutoStrategyValue(plan, "videoResolution") ??
    String(
      plan.answers.defaultVideoResolution ??
        `video:kickoff:prefs:resolution:${DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.resolution}`,
    );
  return normalizeVideoGenerationResolution(value.replace("video:kickoff:prefs:resolution:", ""));
}

export function getFullAutoVideoImagePrefs(
  plan: FullAutoRunPlan,
): Partial<VideoImageGenerationPrefs> | undefined {
  const value = getFullAutoStrategyValue(plan, "videoStyle");
  if (!value) return undefined;

  const pickStylePrefs = (
    prefs: Partial<VideoImageGenerationPrefs>,
  ): Partial<VideoImageGenerationPrefs> => {
    const normalized = normalizeVideoImageGenerationPrefs(prefs);
    return {
      styleCategory: normalized.styleCategory,
      stylePreset: normalized.stylePreset,
      ...(normalized.customStylePrompt
        ? { customStylePrompt: normalized.customStylePrompt }
        : {}),
    };
  };

  if (value.startsWith("video:kickoff:prefs:custom-style:")) {
    const customStylePrompt = decodeURIComponent(
      value.replace("video:kickoff:prefs:custom-style:", ""),
    ).trim();
    if (!customStylePrompt) return undefined;
    return pickStylePrefs({
      styleCategory: "custom",
      stylePreset: "custom",
      customStylePrompt,
    });
  }

  if (value.startsWith("video:kickoff:prefs:style-preset:")) {
    return pickStylePrefs({
      stylePreset: value.replace("video:kickoff:prefs:style-preset:", ""),
    });
  }

  if (value.startsWith("video:kickoff:prefs:style-category:")) {
    return pickStylePrefs({
      styleCategory: value.replace("video:kickoff:prefs:style-category:", ""),
    });
  }

  return undefined;
}

export function getFullAutoEpisodeDurationSeconds(plan: FullAutoRunPlan): number {
  const value = getFullAutoStrategyValue(plan, "episodeDuration");
  const match = value?.match(/^script:episode-duration-gate:(\d+)$/);
  const parsed = match ? Number(match[1]) : 90;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

export function getFullAutoVideoAnalyzePrefs(plan: FullAutoRunPlan): {
  videoPace: "slow" | "medium" | "fast";
  episodeDuration: number;
} {
  const resolved = getResolvedFullAutoStrategyValue(plan, "videoAnalyze");
  const paceMatch = resolved?.match(/^video:bridge:analyze:pace:(slow|medium|fast):(\d+)$/);
  if (paceMatch) {
    return {
      videoPace: paceMatch[1] as "slow" | "medium" | "fast",
      episodeDuration: Number(paceMatch[2]),
    };
  }
  const durationMatch = resolved?.match(/^video:bridge:analyze:dur:(\d+)$/);
  return {
    videoPace: "medium",
    episodeDuration: durationMatch ? Number(durationMatch[1]) : 90,
  };
}

export function getFullAutoPromptBatchMode(plan: FullAutoRunPlan): "all" | "batch" | "remaining" {
  const value = getResolvedFullAutoStrategyValue(plan, "videoPrompts");
  if (value?.endsWith(":all")) return "all";
  if (value?.endsWith(":batch")) return "batch";
  return "remaining";
}

export function getFullAutoExportDirectoryPath(plan: FullAutoRunPlan): string | undefined {
  const value = getFullAutoStrategyValue(plan, "videoExportPath");
  if (!value?.startsWith("video:export:path:") || value === VIDEO_EXPORT_PATH_PICK_VALUE) return undefined;
  return decodeURIComponent(value.replace("video:export:path:", ""));
}

export function getFullAutoScriptDocumentExportDirectoryPath(plan: FullAutoRunPlan): string | undefined {
  const value = getFullAutoStrategyValue(plan, "scriptDocumentExportPath");
  if (
    !value?.startsWith("script:export:path:") ||
    value === SCRIPT_DOCUMENT_EXPORT_PATH_PICK_VALUE
  ) {
    return undefined;
  }
  return decodeURIComponent(value.replace("script:export:path:", ""));
}

export function getFullAutoStoryboardXlsxExportDirectoryPath(plan: FullAutoRunPlan): string | undefined {
  const value = getFullAutoStrategyValue(plan, "storyboardXlsxExportPath");
  if (
    !value?.startsWith("video:bridge:export-xlsx:path:") ||
    value === STORYBOARD_XLSX_EXPORT_PATH_PICK_VALUE
  ) {
    return undefined;
  }
  return decodeURIComponent(value.replace("video:bridge:export-xlsx:path:", ""));
}

export function buildFullAutoExecutionSteps(plan: FullAutoRunPlan): FullAutoRunStep[] {
  const syncedPlan = ensureAutoStrategies(plan);
  if (syncedPlan.mode === "original-script-v1") {
    return buildLegacyFullAutoExecutionSteps(syncedPlan);
  }

  const videoMode = getFullAutoVideoMode(syncedPlan);
  const referenceStrategy = getFullAutoStrategyValue(syncedPlan, "referenceAssets");
  const storyboardStrategy = getFullAutoStrategyValue(syncedPlan, "storyboardPrep");
  const promptStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoPrompts");
  const generationStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoGeneration");
  const exportStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoExport");
  const reviewStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "episodeReview");
  const shouldIncludeScriptExport =
    syncedPlan.mode !== "video-workflow-v1" &&
    getFullAutoStrategyValue(syncedPlan, "scriptExportRoute") !== "script:export-video";

  const steps: FullAutoRunStep[] = [];

  if (syncedPlan.mode === "adaptation-v1") {
    steps.push(
      step("setup", "项目设定", "项目设定", "save_setup"),
      step("reference-analysis", "参考分析", "改编工作流", "analyze_reference_script"),
      step(
        "adaptation-episode-count",
        "改编集数",
        "改编工作流",
        "confirm_adaptation_episode_count",
        "adaptationEpisodeCount",
      ),
      step(
        "adaptation-target-market",
        "目标市场",
        "改编工作流",
        "confirm_adaptation_target_market",
        "adaptationTargetMarket",
      ),
      step(
        "adaptation-genres",
        "方向题材",
        "改编工作流",
        "confirm_adaptation_genres",
        "adaptationGenres",
      ),
      step("structure-transform", "结构转译", "改编工作流", "generate_structure_transform"),
      step("character-transform", "角色转译", "改编工作流", "generate_character_transform"),
      step("directory", "分集目录", "改编工作流", "generate_directory"),
      step("outlines", "单集细纲", "改编工作流", "generate_outlines", "outlineGeneration"),
      step("episodes", "正文撰写", "改编工作流", "generate_episode_batch", "episodeWriting"),
    );

    if (reviewStrategy !== EPISODE_REVIEW_SKIP_VALUE) {
      steps.push(
        step(
          "episode-review",
          "正文质检",
          "改编工作流",
          reviewStrategy?.startsWith("script:episode-review:repair")
            ? "rewrite_episode_from_review"
            : "review_episode_quality",
          "episodeReview",
        ),
      );
    }

    steps.push(
      step(
        "compliance",
        "合规审查",
        "改编工作流",
        getFullAutoStrategyValue(syncedPlan, "complianceReview") === COMPLIANCE_SKIP_VALUE
          ? "skip_compliance_review"
          : "run_compliance_review",
        "complianceReview",
      ),
    );

    if (shouldIncludeScriptExport) {
      steps.push(step("script-export", "剧本导出", "改编工作流", "export_project", "scriptExportRoute"));
    }
  }

  steps.push(
    step("video-prepare", "接入视频工作流", "视频工作流", "prepare_video_generation", "videoMode"),
    step("video-analyze", "脚本拆解", "视频工作流", "analyze_script_for_video", "videoAnalyze"),
    step("video-entities", "角色与场景", "视频工作流", "extract_video_entities"),
    step("video-bridge-prefs", "补平台与镜头偏好", "视频工作流", "auto_fill_video_bridge_prefs"),
  );

  if (videoMode === "text-to-video" && referenceStrategy === "video:bridge:reference-assets:full") {
    steps.push(
      step("video-reference-assets", "角色与场景资产补齐", "视频工作流", "generate_video_reference_assets", "referenceAssets"),
    );
  }

  if (videoMode === "image-to-video") {
    steps.push(
      step("video-reference-assets", "角色与场景资产补齐", "视频工作流", "generate_video_reference_assets", "referenceAssets"),
      step("video-storyboard", "分镜文本准备", "视频工作流", "prepare_storyboard_batch", "storyboardPrep"),
    );
    if (storyboardStrategy !== "video:bridge:storyboard") {
      steps.push(step("video-storyboard-frames", "分镜图生成", "视频工作流", "generate_storyboard_frames", "storyboardPrep"));
    }
  }

  steps.push(step("video-shot-packets", "镜头指令包", "视频工作流", "compile_video_shot_packets"));
  steps.push(
    step(
      "video-prompts",
      "视频提示词",
      "视频工作流",
      promptStrategy?.startsWith("video:bridge:prompts:all") || promptStrategy?.startsWith("video:bridge:prompts:batch")
        ? "prepare_video_prompt_batch"
        : "prepare_segment_video_prompt",
      "videoPrompts",
    ),
    step("video-generate", "视频生成", "视频工作流", "generate_segment_video", "videoGeneration"),
    step(
      "video-export",
      "预览导出",
      "预览导出",
      exportStrategy?.startsWith("video:export:ai-auto")
        ? "compile_segment_videos"
        : "export_video_asset_bundle",
      "videoExport",
    ),
  );

  const videoGenerateStep = steps.find((item) => item.id === "video-generate");
  if (videoGenerateStep) {
    videoGenerateStep.workflowAction = generationStrategy?.startsWith("video:generate:segments:")
      ? "generate_segment_video"
      : "generate_video_assets";
  }

  const stepOrder = [
    "setup",
    "reference-analysis",
    "adaptation-episode-count",
    "adaptation-target-market",
    "adaptation-genres",
    "structure-transform",
    "character-transform",
    "directory",
    "outlines",
    "episodes",
    "episode-review",
    "compliance",
    "script-export",
    "video-prepare",
    "video-analyze",
    "video-entities",
    "video-bridge-prefs",
    "video-reference-assets",
    "video-storyboard",
    "video-storyboard-frames",
    "video-shot-packets",
    "video-prompts",
    "video-generate",
    "video-export",
  ] satisfies string[];
  const stepOrderMap = new Map(stepOrder.map((stepId, index) => [stepId, index]));
  steps.sort((left, right) => {
    const leftIndex = stepOrderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = stepOrderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  return steps.map((item) => ({
    ...item,
    strategyValue: item.strategyKey ? getResolvedFullAutoStrategyValue(syncedPlan, item.strategyKey) : undefined,
  }));
}

function buildLegacyFullAutoExecutionSteps(plan: FullAutoRunPlan): FullAutoRunStep[] {
  const syncedPlan = ensureAutoStrategies(plan);
  const videoMode = getFullAutoVideoMode(syncedPlan);
  const reviewStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "episodeReview");
  const referenceStrategy = getFullAutoStrategyValue(syncedPlan, "referenceAssets");
  const storyboardStrategy = getFullAutoStrategyValue(syncedPlan, "storyboardPrep");
  const promptStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoPrompts");
  const generationStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoGeneration");
  const exportStrategy = getResolvedFullAutoStrategyValue(syncedPlan, "videoExport");

  const steps: FullAutoRunStep[] = [
    step("setup", "项目设定", "项目设定", "save_setup"),
    step("creative-plan", "创意方案", "剧本工作流", "generate_creative_plan"),
    step("characters", "角色设计", "剧本工作流", "generate_characters"),
    step("directory", "分集目录", "剧本工作流", "generate_directory"),
    step("outlines", "单集细纲", "剧本工作流", "generate_outlines", "outlineGeneration"),
    step("episodes", "正文撰写", "剧本工作流", "generate_episode_batch", "episodeWriting"),
  ];

  if (reviewStrategy !== EPISODE_REVIEW_SKIP_VALUE) {
    steps.push(
      step(
        "episode-review",
        "正文质检",
        "剧本工作流",
        reviewStrategy?.startsWith("script:episode-review:repair")
          ? "rewrite_episode_from_review"
          : "review_episode_quality",
        "episodeReview",
      ),
    );
  }

  steps.push(
    step(
      "compliance",
      "合规审查",
      "剧本工作流",
      getFullAutoStrategyValue(syncedPlan, "complianceReview") === COMPLIANCE_SKIP_VALUE
        ? "skip_compliance_review"
        : "run_compliance_review",
      "complianceReview",
    ),
  );

  if (getFullAutoStrategyValue(syncedPlan, "scriptExportRoute") !== "script:export-video") {
    steps.push(step("script-export", "剧本导出", "剧本工作流", "export_project", "scriptExportRoute"));
  }

  steps.push(
    step("video-prepare", "进入视频工作流", "视频工作流", "prepare_video_generation", "videoMode"),
    step("video-analyze", "剧本拆解", "视频工作流", "analyze_script_for_video", "videoAnalyze"),
    step("video-entities", "角色与场景", "视频工作流", "extract_video_entities"),
    step("video-bridge-prefs", "补平台与镜头偏好", "视频工作流", "auto_fill_video_bridge_prefs"),
  );

  if (videoMode === "text-to-video" && referenceStrategy === "video:bridge:reference-assets:full") {
    steps.push(
      step("video-reference-assets", "角色与场景资产补齐", "视频工作流", "generate_video_reference_assets", "referenceAssets"),
    );
  }

  if (videoMode === "image-to-video") {
    steps.push(
      step("video-reference-assets", "角色与场景资产补齐", "视频工作流", "generate_video_reference_assets", "referenceAssets"),
      step("video-storyboard", "分镜文本准备", "视频工作流", "prepare_storyboard_batch", "storyboardPrep"),
    );
    if (storyboardStrategy !== "video:bridge:storyboard") {
      steps.push(step("video-storyboard-frames", "分镜图生成", "视频工作流", "generate_storyboard_frames", "storyboardPrep"));
    }
  }

  steps.push(step("video-shot-packets", "镜头指令包", "视频工作流", "compile_video_shot_packets"));
  steps.push(
    step(
      "video-prompts",
      "视频提示词",
      "视频工作流",
      promptStrategy?.startsWith("video:bridge:prompts:all") || promptStrategy?.startsWith("video:bridge:prompts:batch")
        ? "prepare_video_prompt_batch"
        : "prepare_segment_video_prompt",
      "videoPrompts",
    ),
    step("video-generate", "视频生成", "视频工作流", "generate_segment_video", "videoGeneration"),
    step(
      "video-export",
      "预览导出",
      "预览导出",
      exportStrategy?.startsWith("video:export:ai-auto")
        ? "compile_segment_videos"
        : "export_video_asset_bundle",
      "videoExport",
    ),
  );

  const videoGenerateStep = steps.find((item) => item.id === "video-generate");
  if (videoGenerateStep) {
    videoGenerateStep.workflowAction = generationStrategy?.startsWith("video:generate:segments:")
      ? "generate_segment_video"
      : "generate_video_assets";
  }

  const stepOrder = [
    "setup",
    "creative-plan",
    "characters",
    "directory",
    "outlines",
    "episodes",
    "episode-review",
    "compliance",
    "script-export",
    "video-prepare",
    "video-analyze",
    "video-entities",
    "video-bridge-prefs",
    "video-reference-assets",
    "video-storyboard",
    "video-storyboard-frames",
    "video-shot-packets",
    "video-prompts",
    "video-generate",
    "video-export",
  ] satisfies string[];
  const stepOrderMap = new Map(stepOrder.map((stepId, index) => [stepId, index]));
  steps.sort((left, right) => {
    const leftIndex = stepOrderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = stepOrderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });

  return steps.map((item) => ({
    ...item,
    strategyValue: item.strategyKey ? getResolvedFullAutoStrategyValue(syncedPlan, item.strategyKey) : undefined,
  }));
}

export function syncFullAutoPlanSteps(plan: FullAutoRunPlan): FullAutoRunPlan {
  const syncedPlan = pruneTransientStrategies(ensureAutoStrategies(plan));
  const previousSteps = new Map((syncedPlan.steps ?? syncedPlan.plannedSteps ?? []).map((item) => [item.id, item]));
  const nextSteps = buildFullAutoExecutionSteps(syncedPlan).map((item) => ({
    ...item,
    status: previousSteps.get(item.id)?.status ?? "pending",
  }));
  return {
    ...syncedPlan,
    plannedSteps: nextSteps,
    steps: nextSteps,
  };
}

export function markFullAutoSteps(
  plan: FullAutoRunPlan,
  currentStepIndex: number,
  status: FullAutoRunStepStatus,
): FullAutoRunPlan {
  const syncedPlan = syncFullAutoPlanSteps(plan);
  const steps = syncedPlan.steps.map((item, index) => {
    if (status === "completed") return { ...item, status: "completed" as const };
    if (index < currentStepIndex) return { ...item, status: "completed" as const };
    if (index === currentStepIndex) return { ...item, status };
    return { ...item, status: "pending" as const };
  });
  return {
    ...syncedPlan,
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
  return syncFullAutoPlanSteps({
    ...plan,
    stageStrategies: {
      ...(plan.stageStrategies ?? {}),
      [step.strategyKey]: {
        key: step.strategyKey,
        phase: step.phase ?? step.label,
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
  });
}

export function shouldAutoRetryFullAutoGenerationStep(
  plan: FullAutoRunPlan,
  step: FullAutoRunStep | undefined,
): boolean {
  if (!step) return false;
  if ((plan.retryCounts?.[step.id] ?? 0) > 0) return false;
  return step.id === "outlines" || step.id === "episodes";
}

export function canRewindFullAutoStrategyPlan(plan: FullAutoRunPlan): boolean {
  const syncedPlan = pruneTransientStrategies(ensureAutoStrategies(plan));
  const definitions = buildPreflightStrategyDefinitions(syncedPlan);
  const answeredVisibleKeys = definitions.filter((definition) => hasCollectedFullAutoStrategy(syncedPlan, definition.key));
  return answeredVisibleKeys.length > 0;
}

export function rewindFullAutoStrategyPlan(plan: FullAutoRunPlan): FullAutoRunPlan | null {
  if (!canRewindFullAutoStrategyPlan(plan)) return null;
  let nextPlan = pruneTransientStrategies(ensureAutoStrategies(plan));
  const definitions = buildPreflightStrategyDefinitions(nextPlan);
  const answeredVisibleKeys = definitions
    .filter((definition) => hasCollectedFullAutoStrategy(nextPlan, definition.key))
    .map((definition) => definition.key);
  const keyToRemove = answeredVisibleKeys[answeredVisibleKeys.length - 1];
  if (!keyToRemove) return null;

  const nextStageStrategies = { ...(nextPlan.stageStrategies ?? {}) };
  const nextAnswers = { ...nextPlan.answers };
  const nextDisplayAnswers = { ...nextPlan.displayAnswers };
  const nextCollectedAnswers = { ...(nextPlan.collectedAnswers ?? {}) };
  delete nextStageStrategies[keyToRemove];
  delete nextAnswers[keyToRemove];
  delete nextDisplayAnswers[keyToRemove];
  delete nextCollectedAnswers[keyToRemove];

  nextPlan = {
    ...nextPlan,
    stageStrategies: nextStageStrategies,
    answers: nextAnswers,
    displayAnswers: nextDisplayAnswers,
    collectedAnswers: nextCollectedAnswers,
  };

  return syncFullAutoPlanSteps(pruneTransientStrategies(nextPlan));
}

export function resetFullAutoStrategyPlan(plan: FullAutoRunPlan): FullAutoRunPlan {
  const nextPlan = pruneTransientStrategies(ensureAutoStrategies(plan));
  const visibleKeys = new Set(buildPreflightStrategyDefinitions(nextPlan).map((definition) => definition.key));
  const nextStageStrategies = { ...(nextPlan.stageStrategies ?? {}) };
  const nextAnswers = { ...nextPlan.answers };
  const nextDisplayAnswers = { ...nextPlan.displayAnswers };
  const nextCollectedAnswers = { ...(nextPlan.collectedAnswers ?? {}) };

  for (const key of visibleKeys) {
    delete nextStageStrategies[key];
    delete nextAnswers[key];
    delete nextDisplayAnswers[key];
    delete nextCollectedAnswers[key];
  }

  return syncFullAutoPlanSteps(pruneTransientStrategies({
    ...nextPlan,
    stageStrategies: nextStageStrategies,
    answers: nextAnswers,
    displayAnswers: nextDisplayAnswers,
    collectedAnswers: nextCollectedAnswers,
  }));
}

function resolveFullAutoVisualChecklistStepStatus(
  step: FullAutoRunStep,
  stepIndex: number,
  currentStepIndex: number,
  overallStatus?: FullAutoRunStatus,
): FullAutoRunStepStatus {
  if (overallStatus === "completed") return "completed";
  if (step.status === "failed") return "failed";
  if (step.status === "stopped") return "stopped";
  if (step.status === "retrying") return "retrying";
  if (step.status === "running") return "running";
  if (step.status === "completed") return "completed";
  if (overallStatus === "retrying" && stepIndex === currentStepIndex) return "retrying";
  if (overallStatus === "running" && stepIndex === currentStepIndex) return "running";
  return "pending";
}

function resolveFullAutoChoiceInsertStepAnchor(
  plan: FullAutoRunPlan,
  key: FullAutoStrategyKey,
): { stepId: string | null; position: "before" | "after" } {
  const hasStep = (stepId: string) => plan.steps.some((step) => step.id === stepId);
  switch (key) {
    case "adaptationEpisodeCount":
      return { stepId: "adaptation-episode-count", position: "before" };
    case "adaptationTargetMarket":
      return { stepId: "adaptation-target-market", position: "before" };
    case "adaptationGenres":
      return { stepId: "adaptation-genres", position: "before" };
    case "outlineGeneration":
    case "outlineGenerationDetail":
      return { stepId: "outlines", position: "before" };
    case "episodeDuration":
    case "episodeWriting":
    case "episodeWritingDetail":
      return { stepId: "episodes", position: "before" };
    case "episodeReview":
    case "episodeReviewDetail":
      return { stepId: hasStep("episode-review") ? "episode-review" : "compliance", position: "before" };
    case "complianceReview":
    case "complianceReviewStrictness":
    case "complianceReviewDialogue":
      return { stepId: "compliance", position: "before" };
    case "scriptExportRoute":
    case "scriptDocumentExport":
    case "scriptDocumentExportPath":
      if (hasStep("script-export")) return { stepId: "script-export", position: "before" };
      if (hasStep("video-prepare")) return { stepId: "video-prepare", position: "before" };
      return { stepId: "video-analyze", position: "before" };
    case "videoMode":
    case "videoStyle":
      if (hasStep("video-entities")) return { stepId: "video-entities", position: "after" };
      if (hasStep("video-reference-assets")) return { stepId: "video-reference-assets", position: "before" };
      if (hasStep("video-storyboard")) return { stepId: "video-storyboard", position: "before" };
      if (hasStep("video-shot-packets")) return { stepId: "video-shot-packets", position: "before" };
      if (hasStep("video-prompts")) return { stepId: "video-prompts", position: "before" };
      return { stepId: "video-prepare", position: "before" };
    case "videoAnalyze":
    case "videoAnalyzeDetail":
      return { stepId: "video-analyze", position: "before" };
    case "storyboardXlsxExport":
    case "storyboardXlsxExportPath":
      return { stepId: hasStep("video-entities") ? "video-entities" : "video-analyze", position: "before" };
    case "referenceAssets":
      if (hasStep("video-reference-assets")) return { stepId: "video-reference-assets", position: "before" };
      if (hasStep("video-storyboard")) return { stepId: "video-storyboard", position: "before" };
      return { stepId: hasStep("video-shot-packets") ? "video-shot-packets" : "video-prompts", position: "before" };
    case "storyboardPrep":
      return { stepId: hasStep("video-storyboard") ? "video-storyboard" : "video-shot-packets", position: "before" };
    case "videoPrompts":
    case "videoPromptsDetail":
      return { stepId: "video-prompts", position: "before" };
    case "videoGeneration":
      return { stepId: "video-generate", position: "before" };
    case "videoExport":
    case "videoExportDetail":
    case "videoExportPath":
      return { stepId: "video-export", position: "before" };
    default:
      return { stepId: null, position: "before" };
  }
}

function resolveFullAutoChoiceInsertOrder(key: FullAutoStrategyKey): number {
  switch (key) {
    case "adaptationEpisodeCount":
      return 0;
    case "adaptationTargetMarket":
      return 1;
    case "adaptationGenres":
      return 2;
    case "episodeDuration":
      return 0;
    case "episodeWriting":
    case "episodeWritingDetail":
      return 1;
    case "episodeReview":
      return 0;
    case "episodeReviewDetail":
      return 1;
    case "complianceReview":
      return 0;
    case "complianceReviewStrictness":
      return 1;
    case "complianceReviewDialogue":
      return 2;
    case "scriptExportRoute":
      return 0;
    case "scriptDocumentExport":
      return 1;
    case "scriptDocumentExportPath":
      return 2;
    case "videoMode":
      return 0;
    case "videoStyle":
      return 1;
    case "videoAnalyze":
      return 0;
    case "videoAnalyzeDetail":
      return 1;
    case "storyboardXlsxExport":
      return 2;
    case "storyboardXlsxExportPath":
      return 3;
    case "videoPrompts":
      return 0;
    case "videoPromptsDetail":
      return 1;
    case "videoGeneration":
      return 2;
    case "videoExport":
      return 0;
    case "videoExportDetail":
      return 1;
    case "videoExportPath":
      return 2;
    default:
      return 0;
  }
}

function resolveFullAutoChoiceVisualStatus(
  stepId: string | null,
  stepItems: FullAutoVisualChecklistItem[],
): FullAutoVisualChecklistItemStatus {
  if (!stepId) return "selected";
  const anchoredStep = stepItems.find((item) => item.id === `step:${stepId}`);
  if (!anchoredStep) return "selected";
  return anchoredStep.status === "completed" ? "completed" : "selected";
}

function resolveCollectingChoiceKey(plan: FullAutoRunPlan): FullAutoStrategyKey | null {
  const definitions = buildPreflightStrategyDefinitions(plan);
  const answeredKeys = definitions
    .filter((definition) => hasCollectedFullAutoStrategy(plan, definition.key))
    .map((definition) => definition.key);
  return answeredKeys.length ? answeredKeys[answeredKeys.length - 1] : null;
}

function hasFullAutoStoryboardStage(plan: Pick<FullAutoRunPlan, "steps"> | null | undefined): boolean {
  return Boolean(plan?.steps.some((step) => step.id === "video-storyboard" || step.id === "video-storyboard-frames"));
}

function resolveNormalizedFullAutoDisplayGroup(
  stepId: string,
  plan?: Pick<FullAutoRunPlan, "steps"> | null,
): { id: string; label: string } {
  if (stepId === "episode-review") {
    return { id: "episode-review", label: "\u6b63\u6587\u8d28\u68c0" };
  }

  if (["video-entities", "video-prepare", "video-reference-assets"].includes(stepId)) {
    return { id: "reference-assets", label: "\u89d2\u8272\u4e0e\u573a\u666f" };
  }

  if (stepId === "video-shot-packets" && !hasFullAutoStoryboardStage(plan)) {
    return { id: "reference-assets", label: "\u89d2\u8272\u4e0e\u573a\u666f" };
  }

  return resolveDisplayGroupIdForPreflight(stepId);
}

function resolveFullAutoProgressDisplayGroup(
  stepId: string,
  plan?: Pick<FullAutoRunPlan, "steps"> | null,
): { id: string; label: string } {
  if (["video-prepare", "video-analyze"].includes(stepId)) {
    return { id: "video-analyze", label: "剧本拆解" };
  }

  if (stepId === "video-bridge-prefs") {
    return { id: "reference-assets", label: "角色与场景" };
  }

  if (["video-prompts", "video-generate"].includes(stepId)) {
    return { id: "video-generate", label: "视频生成" };
  }

  if (stepId === "video-export") {
    return { id: "video-export", label: "预览与导出" };
  }

  return resolveNormalizedFullAutoDisplayGroup(stepId, plan);
}

export function buildFullAutoVisualChecklist(
  plan: FullAutoRunPlan,
  currentStepIndex = Math.max(0, plan.currentStepIndex ?? 0),
  overallStatus?: FullAutoRunStatus,
): FullAutoVisualChecklistItem[] {
  const syncedPlan = syncFullAutoPlanSteps(plan);
  const collectingChoiceKey = overallStatus === "collecting" ? resolveCollectingChoiceKey(syncedPlan) : null;
  const selectedChoices = buildPreflightStrategyDefinitions(syncedPlan)
    .filter((definition) => hasCollectedFullAutoStrategy(syncedPlan, definition.key))
    .map((definition) => {
      const strategy = syncedPlan.stageStrategies?.[definition.key];
      const label = buildFullAutoCollectedChoiceUserMessage(
        getFullAutoStrategyLabel(syncedPlan, definition.key) ?? definition.title,
        strategy?.value,
      );

      return {
        id: `choice:${definition.key}`,
        kind: "choice" as const,
        label,
        phase: getFullAutoPhaseLabel(definition.majorId, definition.phase),
        detail: definition.title,
        current: definition.key === collectingChoiceKey,
        status: "selected" as const,
      };
    });

  const stepItems = syncedPlan.steps.map((step, index) => {
    const label = buildReadableFullAutoChecklistLabel(step);
    const phase = resolveNormalizedFullAutoDisplayGroup(step.id, syncedPlan).label;
    const detail = step.label.trim() === label ? undefined : step.label.trim();
    const status = resolveFullAutoVisualChecklistStepStatus(step, index, currentStepIndex, overallStatus);

    return {
      id: `step:${step.id}`,
      kind: "step" as const,
      label,
      phase,
      detail,
      current: overallStatus !== "collecting" && index === currentStepIndex && status !== "completed",
      status,
    };
  });

  const choicesBeforeByStepId = new Map<string, FullAutoVisualChecklistItem[]>();
  const choicesAfterByStepId = new Map<string, FullAutoVisualChecklistItem[]>();
  const trailingChoices: FullAutoVisualChecklistItem[] = [];
  selectedChoices.forEach((choice) => {
    const key = choice.id.replace(/^choice:/, "") as FullAutoStrategyKey;
    const anchor = resolveFullAutoChoiceInsertStepAnchor(syncedPlan, key);
    const stepId = anchor.stepId;
    const anchoredPhase = stepId ? resolveNormalizedFullAutoDisplayGroup(stepId, syncedPlan).label : choice.phase;
    const nextChoice = {
      ...choice,
      phase: anchoredPhase,
      status: resolveFullAutoChoiceVisualStatus(stepId, stepItems),
    };
    if (!stepId) {
      trailingChoices.push(nextChoice);
      return;
    }
    const groupMap = anchor.position === "after" ? choicesAfterByStepId : choicesBeforeByStepId;
    const group = groupMap.get(stepId) ?? [];
    group.push(nextChoice);
    groupMap.set(stepId, group);
  });

  const sortChoiceGroups = (groupMap: Map<string, FullAutoVisualChecklistItem[]>) => {
    for (const [stepId, choices] of groupMap) {
      choices.sort((left, right) => {
        const leftKey = left.id.replace(/^choice:/, "") as FullAutoStrategyKey;
        const rightKey = right.id.replace(/^choice:/, "") as FullAutoStrategyKey;
        return resolveFullAutoChoiceInsertOrder(leftKey) - resolveFullAutoChoiceInsertOrder(rightKey);
      });
      groupMap.set(stepId, choices);
    }
  };

  sortChoiceGroups(choicesBeforeByStepId);
  sortChoiceGroups(choicesAfterByStepId);

  const orderedItems: FullAutoVisualChecklistItem[] = [];
  for (const step of stepItems) {
    const rawStepId = step.id.replace(/^step:/, "");
    const beforeChoices = choicesBeforeByStepId.get(rawStepId);
    const afterChoices = choicesAfterByStepId.get(rawStepId);
    if (beforeChoices?.length) orderedItems.push(...beforeChoices);
    orderedItems.push(step);
    if (afterChoices?.length) orderedItems.push(...afterChoices);
  }
  if (trailingChoices.length) orderedItems.push(...trailingChoices);
  return orderedItems;
}

function resolveDisplayGroupId(stepId: string): { id: string; label: string } {
  if (["reference-analysis"].includes(stepId)) return { id: "reference-analysis", label: "参考分析" };
  if (["adaptation-episode-count", "adaptation-target-market", "adaptation-genres"].includes(stepId)) {
    return { id: "adaptation-setup", label: "改编设定" };
  }
  if (["structure-transform"].includes(stepId)) return { id: "structure-transform", label: "结构转译" };
  if (["character-transform"].includes(stepId)) return { id: "character-transform", label: "角色转译" };
  if (["setup"].includes(stepId)) return { id: "setup", label: "项目设定" };
  if (["creative-plan"].includes(stepId)) return { id: "creative-plan", label: "创意方案" };
  if (["characters"].includes(stepId)) return { id: "characters", label: "角色设计" };
  if (["directory"].includes(stepId)) return { id: "directory", label: "分集目录" };
  if (["outlines"].includes(stepId)) return { id: "outlines", label: "单集细纲" };
  if (["episodes", "episode-review"].includes(stepId)) return { id: "episodes", label: "正文撰写" };
  if (["compliance"].includes(stepId)) return { id: "compliance", label: "合规审查" };
  if (["script-export", "video-prepare"].includes(stepId)) {
    return { id: "bridge", label: "进入视频工作流" };
  }
  if (["video-analyze", "video-entities"].includes(stepId)) return { id: "video-analyze", label: "剧本拆解" };
  if (["video-bridge-prefs", "video-reference-assets"].includes(stepId)) return { id: "reference-assets", label: "角色与场景" };
  if (["video-storyboard", "video-storyboard-frames", "video-shot-packets"].includes(stepId)) {
    return { id: "storyboard", label: "分镜图生成" };
  }
  if (["video-prompts"].includes(stepId)) return { id: "prompts", label: "视频提示词" };
  if (["video-generate"].includes(stepId)) return { id: "video-generate", label: "视频生成" };
  if (["video-export"].includes(stepId)) return { id: "video-export", label: "预览导出" };
  return { id: stepId, label: stepId };
}

export function buildFullAutoProgressDisplaySteps(
  plan: FullAutoRunPlan,
  currentStepIndex = Math.max(0, plan.currentStepIndex ?? 0),
  overallStatus?: string,
): FullAutoProgressDisplayStep[] {
  const syncedPlan = syncFullAutoPlanSteps(plan);
  const steps = syncedPlan.steps;
  const groups: Array<{
    id: string;
    label: string;
    rawStepIds: string[];
    rawIndexes: number[];
    statuses: FullAutoRunStepStatus[];
  }> = [];

  for (let index = 0; index < steps.length; index += 1) {
    const stepItem = steps[index];
    const groupInfo = resolveFullAutoProgressDisplayGroup(stepItem.id, syncedPlan);
    const previous = groups[groups.length - 1];
    if (previous?.id === groupInfo.id) {
      previous.rawStepIds.push(stepItem.id);
      previous.rawIndexes.push(index);
      previous.statuses.push(stepItem.status);
    } else {
      groups.push({
        id: groupInfo.id,
        label: groupInfo.label,
        rawStepIds: [stepItem.id],
        rawIndexes: [index],
        statuses: [stepItem.status],
      });
    }
  }

  return groups.map((group) => {
    const current =
      overallStatus === "collecting" ? group.id === "setup" : group.rawIndexes.includes(currentStepIndex);
    let status: FullAutoRunStepStatus = "pending";
    if (overallStatus === "completed" || group.statuses.every((item) => item === "completed")) {
      status = "completed";
    } else if (group.statuses.some((item) => item === "failed")) {
      status = "failed";
    } else if (group.statuses.some((item) => item === "stopped")) {
      status = "stopped";
    } else if (current && overallStatus === "collecting") {
      status = "pending";
    } else if (group.statuses.some((item) => item === "retrying")) {
      status = "retrying";
    } else if (current || group.statuses.some((item) => item === "running")) {
      status = "running";
    }

    return {
      id: group.id,
      label: group.label,
      status,
      current,
      rawStepIds: group.rawStepIds,
    };
  });
}

function resolveDisplayGroupIdForPreflight(stepId: string): { id: string; label: string } {
  switch (stepId) {
    case "setup":
      return { id: "setup", label: "项目设定" };
    case "creative-plan":
      return { id: "creative-plan", label: "创意方案" };
    case "characters":
      return { id: "characters", label: "角色设计" };
    case "directory":
      return { id: "directory", label: "分集目录" };
    case "outlines":
      return { id: "outlines", label: "单集细纲" };
    case "episodes":
    case "episode-review":
      return { id: "episodes", label: "正文撰写" };
    case "compliance":
      return { id: "compliance", label: "合规审查" };
    case "script-export":
      return { id: "script-export", label: "剧本导出" };
    case "video-analyze":
    case "video-entities":
      return { id: "video-analyze", label: "剧本拆解" };
    case "video-prepare":
      return { id: "video-setup", label: "视频模式与画风" };
    case "video-bridge-prefs":
      return { id: "reference-assets", label: "角色与场景" };
    case "video-reference-assets":
      return { id: "reference-assets", label: "角色与场景" };
    case "video-storyboard":
    case "video-storyboard-frames":
    case "video-shot-packets":
      return { id: "storyboard", label: "分镜图生成" };
    case "video-prompts":
      return { id: "prompts", label: "视频提示词" };
    case "video-generate":
      return { id: "video-generate", label: "视频生成" };
    case "video-export":
      return { id: "video-export", label: "预览导出" };
    default:
      return resolveDisplayGroupId(stepId);
  }
}
