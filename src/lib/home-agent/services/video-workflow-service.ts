import {
  createStoredVideoProject,
  listStoredVideoProjects,
  loadStoredVideoProjectById,
  type PersistedVideoProject,
  upsertStoredVideoProject,
} from "@/hooks/use-local-persistence";
import { mapWithConcurrency } from "@/lib/async";
import { getProjectRootPath } from "@/lib/file-cache";
import {
  buildSegmentContinuityRecapText as buildCanonicalSegmentContinuityRecapText,
  formatSegmentContinuityRecapDisplayText,
} from "@/lib/home-agent/segment-continuity-recap";
import { formatDetailedSegmentPrompt, invokeFunction } from "@/lib/invoke-with-key";
import {
  getApiConfig,
  isArkJimengEndpoint,  resolveJimengApiKey,
} from "@/lib/api-config";
import { hasUsableApiCredential, isServerProxyEndpoint } from "@/lib/server-proxy";
import {
  buildCharacterAssetFileStem,
  buildCharacterAssetLabel,
  buildSceneAssetFileStem,
  buildSceneAssetLabel,
  buildSegmentVideoFileStem,
  buildSegmentVideoLabel,
  buildStoryboardAssetFileStem,
  buildStoryboardAssetLabel,
  buildVideoAssetFileStem,
  resolveNextAssetVersion,
} from "@/lib/home-agent/asset-naming";
import { createVideoSnapshot } from "@/lib/home-agent/project-store";
import { buildStoryboardBreakdownMessage } from "@/lib/home-agent/storyboard-breakdown";
import { cacheProjectVideoSource, normalizeLocalVideoPath } from "@/lib/home-agent/video-cache";
import {
  analyzeSegmentVideoVisualQuality,
  type SegmentVideoVisualQualityReport,
} from "@/lib/home-agent/video-visual-quality-analysis";
import {
  analyzeReferenceVariantDistinctness,
  analyzeReferenceImageQuality,
  type ReferenceImageQualityReport,
  type ReferenceVariantDistinctnessReport,
} from "@/lib/home-agent/image-reference-quality-analysis";
import {
  getVideoImageGenerationBatchLimit,
  normalizeVideoImageGenerationPrefs,
  resolveVideoImageAspectRatioForViewMode,
  resolveVideoImageProjectArtStyle,
  resolveVideoImagePromptStyle,
  resolveVideoImageRequestPrefs,
} from "@/lib/home-agent/image-models";
import {
  getHomeAgentVideoGenerationBatchLimit,
  getHomeAgentVideoGenerationConcurrencyLimit,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
  getVideoModelMaxDuration,
  HAPPYHORSE_1_0_MODEL_KEY,
  SEEDANCE_2_0_FAST_MODEL_KEY,
  VIDEO_SEGMENT_DESIGN_DURATION,
  videoModelRequiresRunningHubTransport,
  videoModelSupportsDirectReferenceImage,
  videoModelSupportsMultiReferenceImages,
} from "@/lib/home-agent/video-models";
import {
  canSwitchToVideoWorkflowStep,
  deriveNaturalVideoStep,
  hasCompleteTextToVideoPrompts,
  hasCompleteVideoReferenceAssets,
  hasIncompleteVideoEpisodeCoverage,
  hasPassedVideoScriptBreakdown,
} from "@/lib/home-agent/video-workflow-step-gates";
import {
  doesUsableMediaAssetExist,
  hasUsableMediaUrl,
  isExpiredRemoteSignedMediaUrl,
  isKnownPlaceholderMediaUrl,
  isLocalMediaFilePath,
  isMediaAssetDefinitelyMissing,
  resolveLocalMediaPreviewDataUrl,
} from "@/lib/home-agent/media-url";
import type { WorkflowActionResult, StudioRuntimeState, WorkflowActionProgressCallback } from "@/lib/home-agent/types";
import {
  deriveVideoStyleLock,
  deriveVideoShotPackets,
  synchronizeVideoProductionState,
} from "@/lib/home-agent/video-production-memory";
import type {
  ArtStyle,
  CostumeSetting,
  CharacterSetting,
  Scene,
  SceneSetting,
  TimeVariantSetting,
  VideoAuditPacket,
  VideoAutomationState,
  VideoRepairTask,
  VideoImageGenerationPrefs,
  ArchivedSegmentVideoCandidate,
  SegmentVideoPrompt,
  SegmentVideoStatus,
  VideoShotPacket,
} from "@/types/project";

interface VideoEnhanceResult {
  enhanced: string;
  duration?: number;
  durationReason?: string;
}

interface ExtractedVariantResult {
  label?: string;
  description?: string;
}

interface ExtractEntitiesResult {
  characters?: Array<{ name?: string; description?: string; costumes?: ExtractedVariantResult[] }>;
  sceneSettings?: Array<{ name?: string; description?: string; timeVariants?: ExtractedVariantResult[] }>;
}

interface EntityCoverageCandidates {
  characterNames: string[];
  sceneNames: string[];
}

interface EntityCoverageGaps {
  missingCharacterNames: string[];
  missingSceneNames: string[];
}

interface DecomposeResult {
  scenes?: Array<Partial<Scene>>;
}

type DecomposeProgressPayload = {
  scenes?: Array<Partial<Scene>>;
  chunkIndex?: number;
  totalChunks?: number;
  status?: "init" | "processing" | "done" | "failed" | "cancelled";
  failedChunks?: number[];
  retryAttempt?: number;
  retryReason?: string;
  error?: string;
};

const DEFAULT_VIDEO_AUTOMATION_TEMPLATE: VideoAutomationState = {
  strategy: "quality-first",
  segmentPassBudget: 5,
  localRepairBudget: 2,
  regenerateBudget: 2,
  assetPrimaryRetryBudget: 3,
  assetVariantRetryBudget: 2,
  segments: {},
  referenceTargets: {},
  updatedAt: new Date().toISOString(),
};

const SEGMENT_AUDIT_SCORE_THRESHOLDS = {
  total: 85,
  continuity: 85,
  identity: 85,
  semantic: 80,
  visual: 80,
} as const;

const REFERENCE_IMAGE_QA_THRESHOLDS = {
  overall: 82,
  identity: 80,
  visual: 78,
  consistency: 78,
} as const;

function isNonBlockingReferenceImageIssue(issue: string): boolean {
  return /(字幕|上屏文字|文字污染|水印|logo|品牌文字|海报文字|屏幕文字|ui\s*叠层|subtitle|subtitles|watermark|on-screen text|logo|brand text|poster text|screen text|ui overlay)/i
    .test(issue);
}

function getBlockingReferenceImageQaIssues(
  report: ReferenceImageQualityReport | null | undefined,
): string[] {
  if (!report?.issues?.length) return [];
  return report.issues.filter((issue) => !isNonBlockingReferenceImageIssue(issue));
}

function shouldRejectReferenceImageQuality(
  report: ReferenceImageQualityReport | null | undefined,
): boolean {
  if (!report?.inspected) return false;
  if (report.styleMismatchVisible === true) return true;
  if (report.unintendedDuplicatePeopleVisible === true) return true;
  if (report.deliverableReady) return false;
  if (report.overallScore < REFERENCE_IMAGE_QA_THRESHOLDS.overall) return true;
  if (report.identityScore < REFERENCE_IMAGE_QA_THRESHOLDS.identity) return true;
  if (report.visualScore < REFERENCE_IMAGE_QA_THRESHOLDS.visual) return true;
  if (report.consistencyScore < REFERENCE_IMAGE_QA_THRESHOLDS.consistency) return true;
  return getBlockingReferenceImageQaIssues(report).length > 0;
}

function buildReferenceImageQaFailureReason(params: {
  report: ReferenceImageQualityReport;
  mode: "character" | "scene";
  name: string;
}): string {
  const lead = params.mode === "character" ? "角色参考图 QA 未通过" : "场景参考图 QA 未通过";
  const topIssues = getBlockingReferenceImageQaIssues(params.report).slice(0, 3).join("；");
  return [
    `${lead}：${params.name}`,
    `总分 ${params.report.overallScore}，一致性 ${params.report.consistencyScore}，视觉 ${params.report.visualScore}。`,
    topIssues || params.report.summary || "请重试并优先稳定身份、主体完整度和画面清晰度。",
  ].join(" ");
}

function formatReferenceImageQaSummary(params: {
  passedCount: number;
  rejectedCount: number;
  exhaustedCount: number;
  highlightedIssues: string[];
}): string {
  const lines = [
    `参考图 QA：通过 ${params.passedCount} 张，拦截并重试 ${params.rejectedCount} 张候选图。`,
  ];
  if (params.exhaustedCount > 0) {
    lines.push(`其中 ${params.exhaustedCount} 个目标已超出自动补图预算，转入 review 兜底。`);
  }
  if (params.highlightedIssues.length > 0) {
    lines.push(`主要问题：${params.highlightedIssues.slice(0, 3).join("；")}。`);
  }
  return lines.join(" ");
}

function getLatestSegmentAuditPacket(
  project: PersistedVideoProject,
  segmentLabel: string,
): VideoAuditPacket | null {
  const packets = (project.videoAuditPackets || []).filter((packet) => packet.segmentLabel === segmentLabel);
  return packets.at(-1) || null;
}

function buildSegmentAuditChatSummary(
  project: PersistedVideoProject,
  segmentLabel: string,
): string {
  const packet = getLatestSegmentAuditPacket(project, segmentLabel);
  if (!packet) return "";
  const continuityScore = Number(packet.scores?.continuity?.score ?? 0);
  const identityScore = Number(packet.scores?.identity?.score ?? 0);
  const semanticScore = Number(packet.scores?.semantic?.score ?? 0);
  const visualScore = Number(packet.scores?.visual?.score ?? 0);

  const routeLabel =
    packet.status === "pass"
      ? "通过"
      : packet.status === "local_repair"
        ? "局部修复"
        : packet.status === "regenerate"
          ? "整段重生"
          : "进入 review";
  const issues = packet.issues?.slice(0, 2).join("；");
  return [
    `QA：总分 ${packet.totalScore}，连续性 ${continuityScore}，身份 ${identityScore}，语义 ${semanticScore}，视觉 ${visualScore}，结果：${routeLabel}。`,
    issues ? `原因：${issues}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface VideoGenerationResult {
  task_id: string;
  status: string;
  provider?: string;
}

interface VideoGenerationStatusResult {
  status: string;
  video_url?: string;
  last_frame_url?: string;
  state?: string;
  error_code?: string;
  error_message?: string;
  prompt_tips?: string;
}

const EXACT_DIALOGUE_LOCK_HEADING = "【精确台词锁定】";
const NO_DIALOGUE_LOCK_HEADING = "【无台词锁定】";
const DEFAULT_ENTITY_EXTRACTION_MAX_ROUNDS = 3;
const MIN_ENTITY_EXTRACTION_REVIEW_ROUNDS = 2;
const ENTITY_EXTRACTION_PLACEHOLDER_DESCRIPTION = "AI 暂未补充该项描述，请根据剧本继续完善。";
const VIDEO_MODEL_SUBMISSION_PROMPT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bno subtitles\b/gi, "无字幕"],
  [/\bno watermark\b/gi, "无水印"],
  [/\bno on-screen text\b/gi, "无屏幕文字"],
  [/\bno background music\b/gi, "无背景音乐"],
  [/\bslow push-?in\b/gi, "缓慢推进"],
  [/\bhandheld shake\b/gi, "手持晃动"],
  [/\bsudden pause\b/gi, "突然停顿"],
  [/\bbreath hold\b/gi, "屏息停顿"],
  [/\bdramatic silence\b/gi, "戏剧性静默"],
  [/\bshallow depth of field\b/gi, "浅景深"],
  [/\bfocus pull\b/gi, "焦点转换"],
  [/\[Scene\]/g, "【场景】"],
  [/\[Characters\]/g, "【角色】"],
  [/\[Environment\]/g, "【环境】"],
  [/\[Camera\]/g, "【镜头】"],
  [/\[Style\]/g, "【风格】"],
  [/\[Character Details\]/g, "【角色细节】"],
  [/\[Previous Shot\]/g, "【上一镜头】"],
  [/\[Current Shot\]/g, "【当前镜头】"],
  [/\[Next Shot\]/g, "【下一镜头】"],
  [/\[Dialogue\]/g, "【台词】"],
];
const VIDEO_MODEL_GLOBAL_CONTROL_TERMS = [
  "无字幕",
  "无水印",
  "无屏幕文字",
] as const;
const VIDEO_MODEL_SUPPRESSED_CONTROL_TERMS = [
  "无背景音乐",
] as const;
const VIDEO_MODEL_CONTROL_TERMS_FOR_STRIPPING = [
  ...VIDEO_MODEL_GLOBAL_CONTROL_TERMS,
  ...VIDEO_MODEL_SUPPRESSED_CONTROL_TERMS,
] as const;
const VIDEO_MODEL_GLOBAL_CONTROL_TEXT = VIDEO_MODEL_GLOBAL_CONTROL_TERMS.join("、");
const VIDEO_MODEL_COMMON_SUFFIX_LABEL = "通用后缀";
const VIDEO_MODEL_SEGMENT_COVERAGE_HEADING = "【镜头锚点补充】";
const RUNNINGHUB_VIDEO_SUBMISSION_HARD_MAX_CHARS = 2400;
const SEGMENT_CONTINUITY_REFERENCE_FRAME_PERCENTS = [0, 28, 44, 60, 76, 100] as const;
const SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT = 6;
const SEGMENT_CONTINUITY_FRAME_SET_MAX_COUNT = 6;
const SEGMENT_CONTINUITY_REFERENCE_FRAME_NEIGHBOR_OFFSETS = [-4, -2, 0, 2, 4] as const;
const SEGMENT_CONTINUITY_GRID_CELL_COLUMNS = 3;
const SEGMENT_CONTINUITY_GRID_CELL_ROWS = 2;
const SEGMENT_CONTINUITY_GRID_CANVAS_WIDTH = 1800;
const SEGMENT_CONTINUITY_GRID_GAP = 18;
const SEGMENT_CONTINUITY_GRID_TEXT_PANEL_HEIGHT = 272;
const SEGMENT_CONTINUITY_GRID_MIN_ASPECT_RATIO = 9 / 16;
const SEGMENT_CONTINUITY_GRID_MAX_ASPECT_RATIO = 21 / 9;
const SEGMENT_CONTINUITY_REFERENCE_MIN_PERCENT_GAP = 8;
const SEGMENT_CONTINUITY_REFERENCE_MIN_VISUAL_DISTANCE = 0.075;
const SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE = 12;
const VIDEO_MODEL_SUBMISSION_SECTION_LABELS = [
  "全局风格",
  "全局要求",
  "视觉锚点",
  "起始衔接",
  "衔接原则",
  "镜头推进",
  "环境细节",
  "环境动态",
  "声音氛围",
  "节奏衔接",
  "结尾钩子",
  "台词",
  "用后缀",
  "通用后缀",
] as const;
type VideoModelSubmissionSectionLabel = typeof VIDEO_MODEL_SUBMISSION_SECTION_LABELS[number];
const VIDEO_MODEL_SUBMISSION_SECTION_PREFIX = "[；。！？，,、\\n]";
const VIDEO_MODEL_SUBMISSION_SECTION_PATTERN = new RegExp(
  `(?:^|${VIDEO_MODEL_SUBMISSION_SECTION_PREFIX})\\s*(${VIDEO_MODEL_SUBMISSION_SECTION_LABELS.join("|")})\\s*[:：]`,
  "g",
);
const VIDEO_SUBMISSION_NARRATIVE_CAMERA_PREFIX_PATTERN = /^(?:特写|大特写|近特写|近景|中近景|中景|远景|全景|大全景|俯拍|仰拍|跟拍|推近|推进|横移|手持|低机位|高机位|广角|航拍|空镜|眼部特写|极近特写|极致眼部特写)$/;
const VIDEO_SUBMISSION_GENERIC_CAMERA_CUE_SOURCE =
  "(?:超近景特写|极致眼部特写|眼部特写|极近特写|大特写|近特写|特写|近景|中近景|中景|远景|全景|大全景|大远景|俯拍|仰拍|空镜)";
const VIDEO_SUBMISSION_LEADING_GENERIC_CAMERA_CUE_PATTERN = new RegExp(
  `^(?:(?:${VIDEO_SUBMISSION_GENERIC_CAMERA_CUE_SOURCE})\\s*){1,3}(?:镜头)?\\s*(?:[:：，,、]\\s*|(?=[\\u4e00-\\u9fffA-Za-z]))`,
);
const VIDEO_SUBMISSION_GENERIC_CAMERA_CUE_PATTERN = new RegExp(
  VIDEO_SUBMISSION_GENERIC_CAMERA_CUE_SOURCE,
  "g",
);
const VIDEO_SUBMISSION_PRELUDE_SPLIT_PATTERN = /视觉锚点\s*[:：]|(?:角色|场景|背景)\s*[:：]/;
const VIDEO_SUBMISSION_PRELUDE_CUTOFF_PATTERN = /起始衔接\s*[:：]|衔接原则\s*[:：]|分镜\s*\d+\s*[（(]|镜头\s*\d+\s*[:：]|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒\s*[:：]|环境细节\s*[:：]|环境动态\s*[:：]|声音氛围\s*[:：]|结尾钩子\s*[:：]|通用后缀\s*[:：]|剧情\s*[:：]|台词\s*[:：]/;
const VIDEO_SUBMISSION_RULE_LIKE_FRAGMENT_PATTERN = /(?:优先把|优先写|优先保留|不要把|不要写|只检查|只补|只允许|固定按|先按|可并入|不能缺失|不得|不改写|尽量控制|写出来|塞进|留在分镜外|展开成说明书|把篇幅|只保留|再进入|先给|再用)/;

const VIDEO_WORKFLOW_GENERATION_ABORT_KEY = "video-workflow-generation";
const activeVideoAbortControllers = new Map<string, AbortController>();

export function getSegmentContinuityGridFrameLabel(
  index: number,
  totalCount = SEGMENT_CONTINUITY_FRAME_SET_MAX_COUNT,
): string {
  const normalizedIndex = Math.max(0, Math.trunc(index));
  const normalizedTotal = Math.max(1, Math.trunc(totalCount));
  if (normalizedIndex === 0) return "首帧";
  if (normalizedIndex === normalizedTotal - 1) return "尾帧";
  return `过程${normalizedIndex}`;
}

export function abortVideoWorkflowGeneration(): void {
  const controller = activeVideoAbortControllers.get(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
  if (controller) {
    controller.abort();
    activeVideoAbortControllers.delete(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
  }
}

function summarizeVideoGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return "视频生成失败，请检查当前运行通道与提示词后重试。";
  return truncate(normalized, 120);
}

function buildVideoStatusFailureMessage(
  data: Pick<VideoGenerationStatusResult, "error_code" | "error_message" | "prompt_tips"> | null | undefined,
  fallback: string,
): string {
  const details = [
    typeof data?.error_code === "string" ? data.error_code.trim() : "",
    typeof data?.error_message === "string" ? data.error_message.trim() : "",
    typeof data?.prompt_tips === "string" ? data.prompt_tips.trim() : "",
  ].filter(Boolean);
  if (!details.length) return fallback;
  return truncate(`${fallback}：${details.join(" | ")}`, 220);
}

function resolveVideoGenerationPollPlan(
  providerOrProviders?: string | Array<string | undefined> | null,
): { maxPollRounds: number; pollIntervalMs: number } {
  const providers = Array.isArray(providerOrProviders)
    ? providerOrProviders
    : [providerOrProviders];
  const hasRunningHub = providers.some((provider) =>
    String(provider || "").trim().toLowerCase().startsWith("runninghub"),
  );
  return {
    maxPollRounds: hasRunningHub ? 96 : 72,
    pollIntervalMs: 10_000,
  };
}

function isRetryableVideoGenerationError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error || ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!message) return false;
  return (
    /(^|\D)(500|502|503|504)(\D|$)/.test(message) ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
}

function logVideoWorkflowSceneEvent(
  stage: "submit" | "status" | "result" | "warning",
  detail: Record<string, unknown>,
): void {
  const entries = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  const message = `[video-workflow] ${stage}${entries.length ? ` ${entries.join(" ")}` : ""}`;
  if (stage === "warning") {
    console.warn(message);
    return;
  }
  console.log(message);
}

function splitExactDialogueLines(dialogue: string | null | undefined): string[] {
  return String(dialogue || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildExactDialogueLockBlock(dialogue: string | null | undefined): string {
  const lines = splitExactDialogueLines(dialogue);
  if (!lines.length) {
    return [
      NO_DIALOGUE_LOCK_HEADING,
      "本片段无台词。不要生成对白、旁白或其他可听语言内容。",
      "画面中不要出现字幕或其他上屏文字。",
    ].join("\n");
  }

  return [
    EXACT_DIALOGUE_LOCK_HEADING,
    "以下台词原文保持一致，只通过对白、口型或旁白音频出现，不以上屏文字呈现。",
    ...lines.map((line, index) => `${index + 1}. ${line}`),
    "角色名前缀用于指定说话人；“旁白：”用于画外音。可调整语气、停顿和情绪，但文字本身不要改写。",
  ].join("\n");
}

function appendExactDialogueLock(prompt: string, dialogue: string | null | undefined): string {
  const rawPrompt = String(prompt || "").trim();
  const lockIndexes = [
    rawPrompt.indexOf(EXACT_DIALOGUE_LOCK_HEADING),
    rawPrompt.indexOf(NO_DIALOGUE_LOCK_HEADING),
  ].filter((index) => index >= 0);
  const basePrompt = lockIndexes.length ? rawPrompt.slice(0, Math.min(...lockIndexes)).trim() : rawPrompt;
  const lockBlock = buildExactDialogueLockBlock(dialogue);
  return [basePrompt, lockBlock].filter(Boolean).join("\n\n");
}

function hasCjkCharacter(value: string | undefined): boolean {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function extractLikelyLatinNameAliases(text: string | null | undefined): string[] {
  const source = String(text || "");
  if (!source) return [];
  const matches = Array.from(
    source.matchAll(/\b([A-Z][a-z]+(?:[\s-]+[A-Z][a-z]+)+)\b/g),
  );
  const aliases = matches
    .map((match) => {
      const words = String(match[1] || "")
        .split(/[\s-]+/)
        .map((word) => word.trim())
        .filter(Boolean);
      return words.length >= 2 ? `${words[0]} ${words[1]}` : "";
    })
    .filter(Boolean);
  return [...new Set(aliases)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildVideoSubmissionNameReplacements(
  scenes: Array<Pick<Scene, "sceneName" | "description" | "enhancedVideoPrompt" | "characters" | "dialogue">>,
  characters: CharacterSetting[],
  extraTexts: Array<string | null | undefined> = [],
): Array<{ alias: string; canonical: string }> {
  const canonicalNames = new Set<string>();
  const aliasToCanonical = new Map<string, string>();

  const registerAlias = (alias: string, canonical: string) => {
    const normalizedAlias = String(alias || "").trim();
    const normalizedCanonical = String(canonical || "").trim();
    if (!normalizedAlias || !normalizedCanonical || normalizedAlias === normalizedCanonical) return;
    if (!/[A-Za-z]/.test(normalizedAlias)) return;
    const key = normalizedAlias.toLowerCase();
    const existing = aliasToCanonical.get(key);
    if (existing && existing !== normalizedCanonical) return;
    aliasToCanonical.set(key, normalizedCanonical);
  };

  for (const character of characters || []) {
    const name = String(character?.name || "").trim();
    if (name && hasCjkCharacter(name)) {
      canonicalNames.add(name);
    }
  }

  for (const scene of scenes || []) {
    for (const name of scene.characters || []) {
      const trimmed = String(name || "").trim();
      if (trimmed && hasCjkCharacter(trimmed)) {
        canonicalNames.add(trimmed);
      }
    }
  }

  for (const scene of scenes || []) {
    const sceneCharacterNames = [...new Set((scene.characters || []).map((name) => String(name || "").trim()).filter(Boolean))];
    if (sceneCharacterNames.length !== 1) continue;
    const canonicalName = sceneCharacterNames[0];
    if (!hasCjkCharacter(canonicalName)) continue;

    const aliasCandidates = [
      ...extractLikelyLatinNameAliases(scene.sceneName),
      ...extractLikelyLatinNameAliases(scene.description),
      ...extractLikelyLatinNameAliases(scene.enhancedVideoPrompt),
      ...extractLikelyLatinNameAliases(scene.dialogue),
    ];
    for (const alias of aliasCandidates) {
      registerAlias(alias, canonicalName);
    }
  }

  if (canonicalNames.size === 1) {
    const [onlyCanonicalName] = [...canonicalNames];
    const aliasCandidates = extraTexts.flatMap((text) => extractLikelyLatinNameAliases(text));
    for (const alias of aliasCandidates) {
      registerAlias(alias, onlyCanonicalName);
    }
  }

  return [...aliasToCanonical.entries()]
    .map(([alias, canonical]) => ({ alias, canonical }))
    .sort((left, right) => right.alias.length - left.alias.length);
}

function applyVideoSubmissionNameReplacements(
  text: string | null | undefined,
  replacements: Array<{ alias: string; canonical: string }>,
): string {
  let output = String(text || "");
  if (!output || !replacements.length) return output;

  for (const { alias, canonical } of replacements) {
    const escapedAlias = escapeRegExp(alias);
    output = output.replace(
      new RegExp(`(?<![A-Za-z])${escapedAlias}(?![A-Za-z])`, "gi"),
      canonical,
    );
  }

  return output;
}

function stripExactDialogueLockBlock(prompt: string | null | undefined): string {
  const rawPrompt = String(prompt || "").trim();
  const lockIndexes = [
    rawPrompt.indexOf(EXACT_DIALOGUE_LOCK_HEADING),
    rawPrompt.indexOf(NO_DIALOGUE_LOCK_HEADING),
  ].filter((index) => index >= 0);
  return lockIndexes.length ? rawPrompt.slice(0, Math.min(...lockIndexes)).trim() : rawPrompt;
}

function cleanupVideoSubmissionPrompt(text: string): string {
  return text
    .replace(/(^|\n)\s*\/+\s*/g, "$1")
    .replace(/\s*\/+\s*(?=[，。；：！？])/g, "")
    .replace(/\s*\/+\s*(?=\n|$)/g, "")
    .replace(/…+/g, "")
    .replace(/\.{3,}/g, "")
    .replace(/\s+/g, " ")
    .replace(
      /((?:分镜\s*\d+(?:\s*[（(][^）)]*[）)])?|镜头\s*\d+|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒)\s*[:：])\s*[。；，、]+/g,
      "$1",
    )
    .replace(/\s*([，。；：！？])/g, "$1")
    .replace(/([。；！？])\s+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/([，。；：！？])(?=[，。；：！？])/g, "")
    .replace(/，\s*，/g, "，")
    .replace(/。\s*。/g, "。")
    .replace(/；{2,}/g, "；")
    .replace(/：(?=[，。；！？])/g, "")
    .replace(/([，；])(?=[。；！？])/g, "")
    .trim();
}

function ensureVideoSubmissionSentence(text: string): string {
  const normalized = cleanupVideoSubmissionPrompt(text).replace(/[，；]+$/g, "");
  if (!normalized) return "";
  return /[。！？]["'”’」』）)]?$/.test(normalized) ? normalized : `${normalized}。`;
}

function splitVideoSubmissionCoverageBlock(prompt: string): {
  primaryBody: string;
  coverageBlock: string;
} {
  const rawPrompt = String(prompt || "").trim();
  const markerIndex = rawPrompt.indexOf(VIDEO_MODEL_SEGMENT_COVERAGE_HEADING);
  if (markerIndex < 0) {
    return { primaryBody: rawPrompt, coverageBlock: "" };
  }

  return {
    primaryBody: rawPrompt.slice(0, markerIndex).replace(/[；\s]+$/g, "").trim(),
    coverageBlock: rawPrompt.slice(markerIndex + VIDEO_MODEL_SEGMENT_COVERAGE_HEADING.length).trim(),
  };
}

function normalizeVideoSubmissionTimeValue(raw: string): number {
  const cleaned = String(raw || "").trim().replace(/[^\d:]/g, "");
  if (!cleaned) return 0;
  const parts = cleaned.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 1) return parts[0] || 0;
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  return 0;
}

function normalizeVideoSubmissionFragment(prompt: string): string {
  let normalized = String(prompt || "");
  for (const [pattern, replacement] of VIDEO_MODEL_SUBMISSION_PROMPT_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return cleanupVideoSubmissionPrompt(
    normalized
      .replace(
        /\[(\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})s?\]\s*(?:镜头\s*\d+[:：]?)?/gi,
        (_, start, end) => `${normalizeVideoSubmissionTimeValue(start)}-${normalizeVideoSubmissionTimeValue(end)}秒：`,
      )
      .replace(
        /Scene\s*\d+\s*\((\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})\)[:：]?/gi,
        (_, start, end) => `${normalizeVideoSubmissionTimeValue(start)}-${normalizeVideoSubmissionTimeValue(end)}秒：`,
      )
      .replace(/(\d+)\s*-\s*(\d+)\s*s\b/gi, "$1-$2秒")
      .replace(/\b(\d+(?:\.\d+)?)\s*seconds?\b/gi, "$1秒")
      .replace(/\b(\d+(?:\.\d+)?)\s*sec(?:ond)?s?\b/gi, "$1秒")
      .replace(/\b(\d+(?:\.\d+)?)s\b/g, "$1秒"),
  );
}

function stripStandaloneVideoControlTerms(text: string): string {
  let stripped = text.replace(/(?:^|\n)\s*(?:通用后缀|用后缀)\s*[:：][^\n]*/g, "");
  for (const term of VIDEO_MODEL_CONTROL_TERMS_FOR_STRIPPING) {
    stripped = stripped.replace(
      new RegExp(`(^|[\\s，,、；;])${term}(?=($|[\\s，,、；;。！？]))`, "g"),
      "$1",
    );
  }

  return cleanupVideoSubmissionPrompt(
    stripped
      .replace(/全局要求[:：]?\s*(?=[。；\n]|$)/g, "")
      .replace(/(?:通用后缀|用后缀)[:：]?\s*(?=[。；\n]|$)/g, "")
      .replace(/画面保持(?=[。；\n]|$)/g, ""),
  );
}

function isOnlyVideoControlTerms(text: string): boolean {
  return !stripStandaloneVideoControlTerms(text).replace(/[、，；。！？\s]/g, "");
}

function enforceVideoSubmissionGlobalControls(prompt: string): string {
  return stripStandaloneVideoControlTerms(prompt);
}

function appendVideoSubmissionCommonSuffix(prompt: string): string {
  const body = String(prompt || "").trim();
  const suffix = `${VIDEO_MODEL_COMMON_SUFFIX_LABEL}： ${VIDEO_MODEL_GLOBAL_CONTROL_TEXT}`;
  return [body, suffix].filter(Boolean).join("\n\n");
}

function dedupeVideoSubmissionContinuityEchoes(prompt: string): string {
  return String(prompt || "")
    .replace(
      /(片段结尾把本段核心动作收在这个停点：([^。\n]+)。)\s*推进到\2。/g,
      "$1",
    )
    .trim();
}

function fitVideoSubmissionTextToNaturalBoundary(text: string, maxChars: number): string {
  const normalized = cleanupVideoSubmissionPrompt(text);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;

  const sentenceParts =
    normalized.match(/[^。！？；]+[。！？；]?/g)?.map((part) => part.trim()).filter(Boolean) || [];
  if (sentenceParts.length) {
    const chosen: string[] = [];
    for (const part of sentenceParts) {
      const candidate = `${chosen.join("")}${part}`;
      if (candidate.length > maxChars) break;
      chosen.push(part);
    }
    if (chosen.length) {
      return cleanupVideoSubmissionPrompt(chosen.join(""));
    }
  }

  const clauseParts = normalized
    .split(/[，、]/)
    .map((part) => cleanupVideoSubmissionPrompt(part))
    .filter(Boolean);
  if (clauseParts.length > 1) {
    const chosen: string[] = [];
    for (const part of clauseParts) {
      const candidate = chosen.length ? `${chosen.join("，")}，${part}` : part;
      if (candidate.length > maxChars) break;
      chosen.push(part);
    }
    if (chosen.length) {
      return cleanupVideoSubmissionPrompt(chosen.join("，"));
    }
  }

  const whitespaceParts = normalized
    .split(/\s+/)
    .map((part) => cleanupVideoSubmissionPrompt(part))
    .filter(Boolean);
  if (whitespaceParts.length > 1) {
    const chosen: string[] = [];
    for (const part of whitespaceParts) {
      const candidate = chosen.length ? `${chosen.join(" ")} ${part}` : part;
      if (candidate.length > maxChars) break;
      chosen.push(part);
    }
    if (chosen.length) {
      return cleanupVideoSubmissionPrompt(chosen.join(" "));
    }
  }

  return cleanupVideoSubmissionPrompt(normalized.slice(0, maxChars).replace(/[，、；：\s]+$/g, ""));
}

function tightenVideoSubmissionSentence(text: string, maxChars: number): string {
  const normalized = fitVideoSubmissionTextToNaturalBoundary(text, maxChars);
  if (!normalized) return "";
  return ensureVideoSubmissionSentence(normalized);
}

function tightenVideoSubmissionNamedBlock(block: string, label: string, maxChars: number): string {
  if (!block.startsWith(`${label}：`)) return block;
  const content = block
    .slice(`${label}：`.length)
    .replace(/^\s*\n+/, "")
    .trim();
  const tightened = tightenVideoSubmissionSentence(content, maxChars);
  return tightened ? `${label}：\n${tightened}` : "";
}

function tightenVideoSubmissionStoryboardBlock(block: string, maxNarrativeChars: number): string {
  const lines = String(block || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => hasMeaningfulVideoSubmissionText(line));
  if (!lines.length || !/^分镜\d+/.test(lines[0])) return block;

  const label = lines[0];
  const narrativeLines: string[] = [];
  const dialogueLines: string[] = [];
  lines.slice(1).forEach((line) => {
    if (/^[^：:\n]{1,16}[:：]/.test(line)) {
      dialogueLines.push(line);
      return;
    }
    narrativeLines.push(line);
  });

  const tightenedNarrative = tightenVideoSubmissionSentence(narrativeLines.join(" "), maxNarrativeChars);
  return [label, tightenedNarrative, ...dialogueLines].filter(Boolean).join("\n");
}

function tightenVideoSubmissionBodyLength(
  prompt: string,
  maxChars: number,
  options?: {
    preserveStartContinuityBlock?: boolean;
  },
): string {
  const normalized = String(prompt || "").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;
  const preserveStartContinuityBlock = options?.preserveStartContinuityBlock === true;

  let blocks = normalized
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return truncate(normalized, maxChars);

  blocks = blocks.map((block, index) => {
    if (block.startsWith("起始衔接：")) {
      return preserveStartContinuityBlock
        ? block
        : tightenVideoSubmissionNamedBlock(block, "起始衔接", 168);
    }
    if (block.startsWith("衔接原则：")) return block;
    if (block.startsWith("环境细节：")) return tightenVideoSubmissionNamedBlock(block, "环境细节", 100);
    if (block.startsWith("结尾钩子：")) return tightenVideoSubmissionNamedBlock(block, "结尾钩子", 90);
    if (index === 0) return tightenVideoSubmissionSentence(block, 96);
    if (index === 1 && !/^[^：:\n]{1,16}[:：]/.test(block)) {
      return tightenVideoSubmissionSentence(block, 168);
    }
    return block;
  }).filter(Boolean);

  let tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  blocks = blocks.map((block) => (/^分镜\d+/.test(block) ? tightenVideoSubmissionStoryboardBlock(block, 120) : block));
  tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  blocks = blocks.map((block) => (/^分镜\d+/.test(block) ? tightenVideoSubmissionStoryboardBlock(block, 90) : block));
  tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  blocks = blocks.map((block) => (/^分镜\d+/.test(block) ? tightenVideoSubmissionStoryboardBlock(block, 80) : block));
  tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  if (preserveStartContinuityBlock) {
    blocks = blocks.filter((block) => !block.startsWith("环境细节：") && !block.startsWith("结尾钩子："));
    tightened = blocks.join("\n\n");
    if (tightened.length <= maxChars) return tightened;

    blocks = blocks.filter((block) => !block.startsWith("衔接原则："));
    tightened = blocks.join("\n\n");
    if (tightened.length <= maxChars) return tightened;
  }

  blocks = blocks.filter(
    (block) => !block.startsWith("环境细节：") && !block.startsWith("结尾钩子："),
  );
  tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  blocks = blocks.map((block) => (/^分镜\d+/.test(block) ? tightenVideoSubmissionStoryboardBlock(block, 64) : block));
  tightened = blocks.join("\n\n");
  if (tightened.length <= maxChars) return tightened;

  return truncate(tightened, maxChars);
}

function ensureVideoSubmissionOpeningDuration(
  prompt: string,
  durationSeconds?: number,
): string {
  const normalizedDuration = Number(durationSeconds);
  const body = String(prompt || "").trim();
  if (!Number.isFinite(normalizedDuration) || normalizedDuration <= 0) {
    return body;
  }

  const durationText = `${Math.max(1, Math.round(normalizedDuration))}秒`;
  if (!body) {
    return ensureVideoSubmissionSentence(durationText);
  }

  const blocks = body.split(/\n\n/);
  const firstBlock = blocks[0]?.trim();
  if (!firstBlock) {
    return body;
  }

  const firstSentenceMatch = firstBlock.match(/^[^。！？]*[。！？]?/);
  const firstSentence = (firstSentenceMatch?.[0] || firstBlock).trim();
  if (!firstSentence || /\d+(?:\.\d+)?秒/.test(firstSentence)) {
    return body;
  }

  const remainder = firstBlock.slice(firstSentence.length).trimStart();
  const endingMatch = firstSentence.match(/[。！？]["'”’」』）)]?$/);
  const ending = endingMatch?.[0] || "";
  const sentenceBody = ending ? firstSentence.slice(0, -ending.length).trim() : firstSentence;
  const commaParts = sentenceBody
    .split("，")
    .map((part) => part.trim())
    .filter(Boolean);

  const nextSentenceBody = commaParts.length >= 2
    ? [commaParts[0], durationText, ...commaParts.slice(1)].join("，")
    : [sentenceBody, durationText].filter(Boolean).join("，");
  const nextFirstSentence = ensureVideoSubmissionSentence(nextSentenceBody);
  blocks[0] = [nextFirstSentence, remainder].filter(Boolean).join(remainder ? " " : "");
  return blocks.filter(Boolean).join("\n\n");
}

function extractVideoSubmissionSections(
  prompt: string,
): Array<{ label: VideoModelSubmissionSectionLabel; content: string }> {
  const matches = Array.from(prompt.matchAll(VIDEO_MODEL_SUBMISSION_SECTION_PATTERN));
  if (!matches.length) return [];

  const sectionStarts = matches.map((match) => {
    const label = match[1] as VideoModelSubmissionSectionLabel;
    const fullMatch = match[0] || "";
    const labelOffset = fullMatch.search(new RegExp(`${label}\\s*[:：]`));
    const labelStart = (match.index ?? 0) + (labelOffset >= 0 ? labelOffset : fullMatch.lastIndexOf(label));
    const separatorOffset = prompt.slice(labelStart).search(/[:：]/);
    return {
      label,
      labelStart,
      sectionStart: labelStart + (separatorOffset >= 0 ? separatorOffset + 1 : `${label}：`.length),
    };
  });

  const sections: Array<{ label: VideoModelSubmissionSectionLabel; content: string }> = [];
  const leadingContent = cleanupVideoSubmissionPrompt(prompt.slice(0, sectionStarts[0]?.labelStart ?? 0));
  if (leadingContent) {
    sections.push({ label: "全局风格", content: leadingContent });
  }

  return sections.concat(sectionStarts.map((section, index) => {
    const nextStart = index + 1 < sectionStarts.length
      ? sectionStarts[index + 1].labelStart
      : prompt.length;
    const content = cleanupVideoSubmissionPrompt(
      prompt
        .slice(section.sectionStart, nextStart)
        .replace(/^；+/, "")
        .replace(/；+$/g, ""),
    );
    return { label: section.label, content };
  }));
}

function findVideoSubmissionTimelineStart(content: string): number {
  const normalized = String(content || "");
  const patterns = [
    /(?:^|[；。！？，,、\n])\s*镜头\s*\d+\s*[:：]/,
    /(?:^|[；。！？，,、\n])\s*分镜\s*\d+\s*[（(]\s*\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒\s*[）)]\s*[:：]/,
    /(?:^|[；。！？，,、\n])\s*\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒\s*[:：]/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && typeof match.index === "number") {
      const matched = match[0] || "";
      const rawStart = match.index + matched.length - matched.trimStart().length;
      const markerIndex = matched.search(/镜头|分镜|\d/);
      return markerIndex >= 0 ? match.index + markerIndex : rawStart;
    }
  }

  return -1;
}

function splitVideoSubmissionTimelineFromSection(content: string): {
  prose: string;
  timeline: string;
} {
  const normalized = cleanupVideoSubmissionPrompt(content);
  if (!normalized) {
    return { prose: "", timeline: "" };
  }

  const timelineStart = findVideoSubmissionTimelineStart(normalized);
  if (timelineStart < 0) {
    return { prose: normalized, timeline: "" };
  }

  return {
    prose: cleanupVideoSubmissionPrompt(normalized.slice(0, timelineStart).replace(/[，,、；\s]+$/g, "")),
    timeline: cleanupVideoSubmissionPrompt(normalized.slice(timelineStart)),
  };
}

function normalizeVideoSubmissionDialogueLine(line: string): string {
  const normalized = String(line || "")
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[（(]\s*|\s*[）)]$/g, "")
    .replace(/^(?:(?:音频|对白)[:：]\s*)+/g, "")
    .trim();
  if (!normalized) return "";

  const speakerMatch = normalized.match(/^([^：:]+)\s*[:：]\s*(.+)$/);
  if (!speakerMatch) {
    return normalized
      .replace(/^[“"'「『]+/, "")
      .replace(/[”"'」』]+$/g, "")
      .trim();
  }

  const speaker = speakerMatch[1].trim();
  const content = speakerMatch[2]
    .trim()
    .replace(/^[“"'「『]+/, "")
    .replace(/[”"'」』]+$/g, "")
    .trim();
  const normalizedSpeaker = speaker.replace(/^[\[【(（]+|[\]】)）]+$/g, "").trim();
  return content ? `${normalizedSpeaker}：${content}` : normalizedSpeaker;
}

function isLikelyVideoSubmissionDialogueLine(line: string): boolean {
  const normalized = String(line || "").trim();
  const speakerMatch = normalized.match(/^([^：:；;，,。！？!?\n]{1,16})\s*[:：]\s*(.+)$/);
  if (!speakerMatch?.[1] || !speakerMatch[2]?.trim()) return false;
  const speaker = speakerMatch[1].trim();
  if (
    /^(?:全局风格|全局要求|视觉锚点|起始衔接|衔接原则|环境细节|环境动态|声音氛围|节奏衔接|结尾钩子|通用后缀|场景|剧情|台词)$/.test(
      speaker,
    )
  ) {
    return false;
  }
  if (VIDEO_SUBMISSION_NARRATIVE_CAMERA_PREFIX_PATTERN.test(speaker)) return false;
  if (/^(?:分镜|镜头)\s*\d+/i.test(speaker)) return false;
  return true;
}

function buildVideoSubmissionDialogueKey(line: string): string {
  return normalizeVideoSubmissionDialogueLine(line)
    .replace(/[“”"'「」『』]/g, "")
    .replace(/[，,。！？!?；;：:\-—_\[\]【】()（）]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function hasMeaningfulVideoSubmissionText(text: string): boolean {
  return Boolean(
    cleanupVideoSubmissionPrompt(text).replace(/[，,、；;。！？!?：:·•\-—_\s"'“”‘’【】\[\]（）()]/g, ""),
  );
}

function splitVideoSubmissionSentenceLikeFragments(text: string): string[] {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/(?<=[。！？；])\s*|\n+/)
    .map((fragment) => cleanupVideoSubmissionPrompt(fragment))
    .filter((fragment) => hasMeaningfulVideoSubmissionText(fragment));
}

function stripVideoSubmissionRuleLikeFragments(text: string): string {
  const filtered = splitVideoSubmissionSentenceLikeFragments(text).filter(
    (fragment) => !VIDEO_SUBMISSION_RULE_LIKE_FRAGMENT_PATTERN.test(fragment),
  );
  return cleanupVideoSubmissionPrompt(filtered.join("；"));
}

function sanitizeVideoSubmissionGlobalStyleText(text: string): string {
  let normalized = cleanupVideoSubmissionPrompt(String(text || ""))
    .replace(/[＃#]+\s*/g, "")
    .replace(/出片目标\s*[（(][^）)]*[）)]/g, "")
    .replace(/^全局风格\s*[:：]\s*/g, "")
    .trim();
  const cutoffMatch = normalized.match(VIDEO_SUBMISSION_PRELUDE_SPLIT_PATTERN);
  if (cutoffMatch && typeof cutoffMatch.index === "number") {
    normalized = normalized.slice(0, cutoffMatch.index);
  }
  return stripVideoSubmissionRuleLikeFragments(normalized);
}

function sanitizeVideoSubmissionVisualAnchorsText(text: string): string {
  let normalized = cleanupVideoSubmissionPrompt(String(text || ""))
    .replace(/^视觉锚点\s*[:：]\s*/g, "")
    .replace(/[＃#]+\s*/g, "")
    .trim();
  const cutoffMatch = normalized.match(VIDEO_SUBMISSION_PRELUDE_CUTOFF_PATTERN);
  if (cutoffMatch && typeof cutoffMatch.index === "number") {
    normalized = normalized.slice(0, cutoffMatch.index);
  }
  normalized = normalized
    .replace(/(?:^|；)\s*剧情\s*[:：][^；。！？]*/g, "")
    .replace(/(?:^|；)\s*台词\s*[:：][^；。！？]*/g, "");
  return stripVideoSubmissionRuleLikeFragments(normalized);
}

function formatVideoSubmissionVisualAnchorsBlock(text: string): string {
  const normalized = sanitizeVideoSubmissionVisualAnchorsText(text);
  if (!normalized) return "";

  const lines = normalized
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .flatMap((line) =>
      line.split(/；(?=(?:角色|场景|背景|系统音|道具|空间|服装|人物|[^；\n]{1,12}[:：]))/g)
    )
    .map((line) => cleanupVideoSubmissionPrompt(line))
    .filter((line) => hasMeaningfulVideoSubmissionText(line))
    .map((line) => ensureVideoSubmissionSentence(line));

  return lines.join("\n");
}

function sanitizeVideoSubmissionEnvironmentText(text: string): string {
  let normalized = cleanupVideoSubmissionPrompt(String(text || ""))
    .replace(/^环境(?:细节|动态)\s*[:：]\s*/g, "")
    .replace(/^声音氛围\s*[:：]\s*/g, "")
    .trim();
  normalized = normalized
    .replace(/(?:^|；)\s*剧情\s*[:：][^；。！？]*/g, "")
    .replace(/(?:^|；)\s*台词\s*[:：][^；。！？]*/g, "");
  return stripVideoSubmissionRuleLikeFragments(normalized);
}

function softenVideoSubmissionNarrativeCameraCue(text: string): string {
  const normalized = cleanupVideoSubmissionPrompt(String(text || ""));
  if (!normalized) return "";
  const softened = normalized
    .replace(VIDEO_SUBMISSION_LEADING_GENERIC_CAMERA_CUE_PATTERN, "")
    .replace(/^[，,、；;:：\s]+/, "");
  return cleanupVideoSubmissionPrompt(softened);
}

function softenSegmentCameraDirectionHint(text: string): string {
  const normalized = cleanupVideoSubmissionPrompt(String(text || ""));
  if (!normalized) return "";
  const softened = normalized
    .replace(VIDEO_SUBMISSION_GENERIC_CAMERA_CUE_PATTERN, " ")
    .replace(/镜头/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[，,、；;:：\s]+|[，,、；;:：\s]+$/g, "");
  return cleanupVideoSubmissionPrompt(softened);
}

function splitVideoSubmissionDialogueLineCandidates(rawLine: string): string[] {
  const source = String(rawLine || "").trim();
  if (!source) return [];

  const speakerStartPattern = /(^|[\s；;，,。！？!?])([^：:；;，,。！？!?\n]{1,16})[:：]\s*/g;
  const speakerStarts = Array.from(source.matchAll(speakerStartPattern))
    .map((match) => {
      const prefix = match[1] || "";
      const startIndex = (match.index ?? 0) + prefix.length;
      return startIndex >= 0 ? startIndex : -1;
    })
    .filter((index) => index >= 0);

  if (speakerStarts.length > 1) {
    return speakerStarts
      .map((startIndex, index) => {
        const endIndex = index + 1 < speakerStarts.length ? speakerStarts[index + 1] : source.length;
        return normalizeVideoSubmissionDialogueLine(
          source.slice(startIndex, endIndex).replace(/^[；;，,。！？!?\s]+/, "").trim(),
        );
      })
      .filter(Boolean);
  }

  const normalizedLine = normalizeVideoSubmissionDialogueLine(source);
  return normalizedLine ? [normalizedLine] : [];
}

function extractInlineVideoSubmissionDialogues(text: string): {
  content: string;
  dialogueLines: string[];
} {
  const source = String(text || "").trim();
  if (!source) {
    return { content: "", dialogueLines: [] };
  }

  const collected = new Map<string, string>();
  const collect = (rawLine: string) => {
    const line = normalizeVideoSubmissionDialogueLine(rawLine);
    if (!line) return "";
    const key = buildVideoSubmissionDialogueKey(line);
    if (!key || collected.has(key)) return "";
    collected.set(key, line);
    return "";
  };

  const withoutParenthesizedDialogue = source.replace(
    /[（(]\s*(?:音频|对白)[:：]\s*([^）)]*)[）)]/g,
    (_match, rawLine: string) => collect(rawLine),
  );

  const withoutInlineDialogue = withoutParenthesizedDialogue.replace(
    /(?:^|[，；。！？]\s*)(?:音频|对白)[:：]\s*([^：:，；。！？\n]+[:：]\s*(?:[“"'「『][^”"'」』]+[”"'」』]|[^；。\n]+))/g,
    (_match, rawLine: string) => collect(rawLine),
  );

  const withoutSpeakerDialogue = withoutInlineDialogue.replace(
    /(^|[，；。！？]\s*)([^：:；;，,。！？!?\n]{1,16}[:：]\s*(?:[“"'「『][^”"'」』]+[”"'」』]|[^；。\n]+))/g,
    (match, prefix: string, rawLine: string) => (isLikelyVideoSubmissionDialogueLine(rawLine) ? prefix + collect(rawLine) : match),
  );

  return {
    content: cleanupVideoSubmissionPrompt(withoutSpeakerDialogue),
    dialogueLines: Array.from(collected.values()),
  };
}

function mergeVideoSubmissionDialogueLines(...groups: Array<string[] | undefined>): string[] {
  const merged = new Map<string, string>();
  for (const group of groups) {
    for (const rawLine of group || []) {
      for (const line of splitVideoSubmissionDialogueLineCandidates(rawLine)) {
        const key = buildVideoSubmissionDialogueKey(line);
        if (!key) continue;
        merged.set(key, line);
      }
    }
  }
  return Array.from(merged.values());
}

function buildVideoSubmissionDialogueKeySet(
  groups: string[][] | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const group of groups || []) {
    for (const rawLine of group || []) {
      for (const line of splitVideoSubmissionDialogueLineCandidates(rawLine)) {
        const key = buildVideoSubmissionDialogueKey(line);
        if (!key) continue;
        keys.add(key);
      }
    }
  }
  return keys;
}

function filterVideoSubmissionDialogueLinesByBlockedKeys(
  lines: string[] | undefined,
  blockedKeys: Set<string>,
): string[] {
  if (!lines?.length || !blockedKeys.size) return lines || [];
  return lines.filter((rawLine) =>
    splitVideoSubmissionDialogueLineCandidates(rawLine).some((candidate) => {
      const key = buildVideoSubmissionDialogueKey(candidate);
      return !key || !blockedKeys.has(key);
    })
  );
}

function injectLeadingDialogueIntoTimeline(
  timeline: string,
  dialogueLines: string[] | undefined,
): string {
  const normalizedTimeline = cleanupVideoSubmissionPrompt(timeline);
  const normalizedDialogueLines = mergeVideoSubmissionDialogueLines(dialogueLines || []);
  if (!normalizedTimeline || !normalizedDialogueLines.length) return normalizedTimeline;
  return normalizedTimeline.replace(
    /((?:镜头\s*\d+\s*[:：])|(?:分镜\s*\d+(?:\s*[（(][^）)]*[）)])?\s*[:：])|(?:\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒\s*[:：]))/,
    `$1${normalizedDialogueLines.join("；")}；`,
  );
}

function peelTimelineFromNamedSection(content: string, blockedDialogueKeys?: Set<string>): {
  prose: string;
  timeline: string;
} {
  const split = splitVideoSubmissionTimelineFromSection(content);
  if (!split.timeline) {
    return {
      prose: cleanupVideoSubmissionPrompt(content),
      timeline: "",
    };
  }

  const extractedProse = extractInlineVideoSubmissionDialogues(split.prose);
  return {
    prose: extractedProse.content,
    timeline: injectLeadingDialogueIntoTimeline(
      split.timeline,
      filterVideoSubmissionDialogueLinesByBlockedKeys(
        extractedProse.dialogueLines,
        blockedDialogueKeys || new Set<string>(),
      ),
    ),
  };
}

function distributeVideoSubmissionShotDialogues(
  shotDialogueGroups: string[][] | undefined,
  blockCount: number,
): string[][] {
  const buckets = Array.from({ length: Math.max(0, blockCount) }, () => [] as string[]);
  if (!shotDialogueGroups?.length || !blockCount) return buckets;

  for (let index = 0; index < shotDialogueGroups.length; index += 1) {
    const lines = (shotDialogueGroups[index] || [])
      .map((line) => normalizeVideoSubmissionDialogueLine(line))
      .filter(Boolean);
    if (!lines.length) continue;
    const bucketIndex = Math.min(index, blockCount - 1);
    buckets[bucketIndex].push(...lines);
  }

  return buckets;
}

function distributeVideoSubmissionDialogueLines(
  dialogueLines: string[] | undefined,
  blockCount: number,
): string[][] {
  const buckets = Array.from({ length: Math.max(0, blockCount) }, () => [] as string[]);
  if (!dialogueLines?.length || !blockCount) return buckets;

  for (let index = 0; index < dialogueLines.length; index += 1) {
    const line = normalizeVideoSubmissionDialogueLine(dialogueLines[index]);
    if (!line) continue;
    const bucketIndex = Math.min(index, blockCount - 1);
    buckets[bucketIndex].push(line);
  }

  return buckets;
}

function formatVideoSubmissionTimeNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
}

function buildVideoSubmissionTimelineLabels(
  blockCount: number,
  durationSeconds?: number,
  shotDurations?: number[],
): string[] {
  if (!blockCount) return [];
  const totalDuration = Number(durationSeconds);
  const resolvedTotalDuration =
    Number.isFinite(totalDuration) && totalDuration > 0
      ? totalDuration
      : blockCount;
  const weights = Array.from({ length: blockCount }, (_, index) => {
    const rawWeight = Number(shotDurations?.[index]);
    return Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || blockCount;
  const labels: string[] = [];
  let elapsed = 0;
  let consumedWeight = 0;

  for (let index = 0; index < blockCount; index += 1) {
    const start = elapsed;
    consumedWeight += weights[index] || 1;
    let end = index === blockCount - 1
      ? resolvedTotalDuration
      : Math.round((resolvedTotalDuration * consumedWeight / totalWeight) * 10) / 10;
    if (end <= start) {
      const minimumStep = resolvedTotalDuration > blockCount ? resolvedTotalDuration / blockCount : 0.5;
      end = Math.min(resolvedTotalDuration, start + minimumStep);
    }
    if (index === blockCount - 1) {
      end = resolvedTotalDuration;
    }
    labels.push(`${formatVideoSubmissionTimeNumber(start)}-${formatVideoSubmissionTimeNumber(end)}秒`);
    elapsed = end;
  }

  return labels;
}

function buildVideoSubmissionStoryboardLabel(index: number, timeLabel?: string): string {
  const shotNumber = index + 1;
  const normalizedTimeLabel = String(timeLabel || "").trim();
  return normalizedTimeLabel
    ? `分镜${shotNumber}（${normalizedTimeLabel}）：`
    : `分镜${shotNumber}：`;
}

function extractVideoSubmissionDialogueSectionLines(content: string): string[] {
  const normalized = String(content || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.includes("无台词")) return [];
  return normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/；(?=[^；\n]+[:：])/g))
    .flatMap((line) => splitVideoSubmissionDialogueLineCandidates(line))
    .filter(Boolean);
}

function appendVideoSubmissionDialogueLinesToLastBlock(
  formattedBody: string,
  dialogueLines: string[] | undefined,
): string {
  const normalizedDialogueLines = mergeVideoSubmissionDialogueLines(dialogueLines || []);
  if (!normalizedDialogueLines.length) return formattedBody;

  const blocks = String(formattedBody || "")
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) {
    return normalizedDialogueLines.join("\n");
  }

  blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n${normalizedDialogueLines.join("\n")}`;
  return blocks.join("\n\n");
}

function dedupeVideoSubmissionDialogueLinesInBody(formattedBody: string): string {
  const blocks = String(formattedBody || "")
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return "";

  const seenDialogueKeys = new Set<string>();
  const dedupedBlocks = blocks
    .map((block) => {
      const dedupedLines: string[] = [];
      const deferredDialogueLines: string[] = [];
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          if (isLikelyVideoSubmissionDialogueLine(line)) {
            splitVideoSubmissionDialogueLineCandidates(line).forEach((candidate) => {
              const key = buildVideoSubmissionDialogueKey(candidate);
              if (!key || seenDialogueKeys.has(key)) {
                return;
              }
              seenDialogueKeys.add(key);
              dedupedLines.push(candidate);
            });
            return;
          }

          const extracted = extractInlineVideoSubmissionDialogues(line);
          if (extracted.content) {
            dedupedLines.push(extracted.content);
          }

          extracted.dialogueLines.forEach((dialogueLine) => {
            splitVideoSubmissionDialogueLineCandidates(dialogueLine).forEach((candidate) => {
              const key = buildVideoSubmissionDialogueKey(candidate);
              if (!key || seenDialogueKeys.has(key)) return;
              seenDialogueKeys.add(key);
              deferredDialogueLines.push(candidate);
            });
          });
        });
      return [...dedupedLines, ...deferredDialogueLines].join("\n").trim();
    })
    .filter(Boolean);

  return dedupedBlocks.join("\n\n");
}

function formatVideoSubmissionTimeline(
  content: string,
  options?: {
    shotDialogueGroups?: string[][];
    durationSeconds?: number;
    shotDurations?: number[];
    tailDialogueLines?: string[];
  },
): { text: string; dialogueLines: string[] } {
  const explicitShotDialogueKeys = buildVideoSubmissionDialogueKeySet(options?.shotDialogueGroups);
  const normalized = cleanupVideoSubmissionPrompt(content)
    .replace(/\[(\d{1,2}(?::\d{2}){0,2})\s*-\s*(\d{1,2}(?::\d{2}){0,2})s?\]\s*镜头\s*(\d+)[:：]?/gi, "镜头$3：")
    .replace(
      /分镜\s*(\d+)\s*[（(]\s*(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)秒\s*[）)]\s*[:：]/g,
      "$2秒：",
    )
    .replace(/分镜\s*(\d+)\s*[（(]\s*[^）)]*\s*[）)]\s*[:：]/g, "镜头$1：")
    .replace(
      /镜头\s*(\d+)\s+(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)秒\s*[:：]/g,
      "$2秒：",
    )
    .replace(
      /镜头\s*(\d+)\s*[:：]\s*(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)秒\s*[:：]/g,
      "$2秒：",
    );
  const shotMatches = Array.from(normalized.matchAll(/镜头\s*(\d+)\s*[:：]/g));
  if (shotMatches.length) {
    const emittedDialogueKeys = new Set<string>();
    const distributedDialogueGroups = distributeVideoSubmissionShotDialogues(
      options?.shotDialogueGroups,
      shotMatches.length,
    );
    const tailDialogueGroups = distributeVideoSubmissionDialogueLines(
      filterVideoSubmissionDialogueLinesByBlockedKeys(
        options?.tailDialogueLines,
        explicitShotDialogueKeys,
      ),
      shotMatches.length,
    );
    const timelineLabels = buildVideoSubmissionTimelineLabels(
      shotMatches.length,
      options?.durationSeconds,
      options?.shotDurations,
    );
    const extractedShotLead = extractInlineVideoSubmissionDialogues(
      cleanupVideoSubmissionPrompt(
      normalized.slice(0, shotMatches[0]?.index ?? 0).replace(/[，,、；\s]+$/g, ""),
      ),
    );
    const shotLead = extractedShotLead.content;
    const shotLeadDialogueLines = filterVideoSubmissionDialogueLinesByBlockedKeys(
      extractedShotLead.dialogueLines,
      explicitShotDialogueKeys,
    );

    const dialogueGroups: string[][] = [];
    const text = shotMatches
      .map((match, index) => {
        const label = buildVideoSubmissionStoryboardLabel(index, timelineLabels[index]);
        const start = (match.index ?? 0) + match[0].length;
        const end = index + 1 < shotMatches.length
          ? (shotMatches[index + 1].index ?? normalized.length)
          : normalized.length;
        const extractedBlock = extractInlineVideoSubmissionDialogues(normalized.slice(start, end).trim());
        const filteredBlockDialogueLines = filterVideoSubmissionDialogueLinesByBlockedKeys(
          extractedBlock.dialogueLines,
          explicitShotDialogueKeys,
        );
        const rawBlockContent = extractedBlock.content.replace(/^[；;，,\s]+/, "");
        const prefixedBlockContent = index === 0 && shotLead
          ? `${shotLead}；${rawBlockContent}`.replace(/^；+/, "")
          : rawBlockContent;
        const softenedBlockContent = softenVideoSubmissionNarrativeCameraCue(prefixedBlockContent);
        const blockContent = hasMeaningfulVideoSubmissionText(softenedBlockContent)
          ? ensureVideoSubmissionSentence(softenedBlockContent)
          : "";
        const dialogueLines = mergeVideoSubmissionDialogueLines(
          index === 0 ? shotLeadDialogueLines : [],
          filteredBlockDialogueLines,
          distributedDialogueGroups[index],
          tailDialogueGroups[index],
        ).filter((line) => {
          const key = buildVideoSubmissionDialogueKey(line);
          if (!key || emittedDialogueKeys.has(key)) return false;
          emittedDialogueKeys.add(key);
          return true;
        });
        const blockLines = [blockContent, ...dialogueLines].filter(Boolean);
        if (dialogueLines.length) dialogueGroups.push(dialogueLines);
        if (!blockLines.length) return "";
        return `${label}\n${blockLines.join("\n")}`;
      })
      .filter(Boolean)
      .join("\n\n");
    return { text, dialogueLines: [] };
  }

  const timeMatches = Array.from(normalized.matchAll(/(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒)[:：]/g));
  if (!timeMatches.length) {
    const extracted = extractInlineVideoSubmissionDialogues(normalized);
    return {
      text: extracted.content
      .replace(/；(?=(?:镜头\s*\d+\s*[:：]|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒[:：]))/g, "\n\n")
      .split(/\n{2,}/)
      .map((line) => ensureVideoSubmissionSentence(softenVideoSubmissionNarrativeCameraCue(line)))
      .filter(Boolean)
      .join("\n\n"),
      dialogueLines: mergeVideoSubmissionDialogueLines(
        filterVideoSubmissionDialogueLinesByBlockedKeys(
          extracted.dialogueLines,
          explicitShotDialogueKeys,
        ),
        ...(options?.shotDialogueGroups || []),
      ),
    };
  }

  const emittedDialogueKeys = new Set<string>();
  const distributedDialogueGroups = distributeVideoSubmissionShotDialogues(
    options?.shotDialogueGroups,
    timeMatches.length,
  );
  const tailDialogueGroups = distributeVideoSubmissionDialogueLines(
    filterVideoSubmissionDialogueLinesByBlockedKeys(
      options?.tailDialogueLines,
      explicitShotDialogueKeys,
    ),
    timeMatches.length,
  );
  const extractedTimelineLead = extractInlineVideoSubmissionDialogues(
    cleanupVideoSubmissionPrompt(
    normalized.slice(0, timeMatches[0]?.index ?? 0).replace(/[，,、；\s]+$/g, ""),
    ),
  );
  const timelineLead = extractedTimelineLead.content;
  const timelineLeadDialogueLines = filterVideoSubmissionDialogueLinesByBlockedKeys(
    extractedTimelineLead.dialogueLines,
    explicitShotDialogueKeys,
  );

  const dialogueGroups: string[][] = [];
  const text = timeMatches
    .map((match, index) => {
      const label = buildVideoSubmissionStoryboardLabel(index, match[1]);
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < timeMatches.length
        ? (timeMatches[index + 1].index ?? normalized.length)
        : normalized.length;
      const extractedBlock = extractInlineVideoSubmissionDialogues(normalized.slice(start, end).trim());
      const filteredBlockDialogueLines = filterVideoSubmissionDialogueLinesByBlockedKeys(
        extractedBlock.dialogueLines,
        explicitShotDialogueKeys,
      );
      const rawBlockContent = extractedBlock.content.replace(/^[；;，,\s]+/, "");
      const prefixedBlockContent = index === 0 && timelineLead
        ? `${timelineLead}；${rawBlockContent}`.replace(/^；+/, "")
        : rawBlockContent;
      const softenedBlockContent = softenVideoSubmissionNarrativeCameraCue(prefixedBlockContent);
      const blockContent = hasMeaningfulVideoSubmissionText(softenedBlockContent)
        ? ensureVideoSubmissionSentence(softenedBlockContent)
        : "";
      const dialogueLines = mergeVideoSubmissionDialogueLines(
        index === 0 ? timelineLeadDialogueLines : [],
        filteredBlockDialogueLines,
        distributedDialogueGroups[index],
        tailDialogueGroups[index],
      ).filter((line) => {
        const key = buildVideoSubmissionDialogueKey(line);
        if (!key || emittedDialogueKeys.has(key)) return false;
        emittedDialogueKeys.add(key);
        return true;
      });
      const blockLines = [blockContent, ...dialogueLines].filter(Boolean);
      if (dialogueLines.length) dialogueGroups.push(dialogueLines);
      if (!blockLines.length) return "";
      return `${label}\n${blockLines.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return { text, dialogueLines: [] };
}

function buildVideoSubmissionDialogueFromLockBlock(lockBlock: string): string[] {
  const raw = String(lockBlock || "").trim();
  if (!raw) return [];
  if (raw.includes(NO_DIALOGUE_LOCK_HEADING)) return [];
  if (!raw.includes(EXACT_DIALOGUE_LOCK_HEADING)) {
    return [];
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s*/.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);

  return lines;
}

function formatVideoSubmissionEndHook(endHook: string): string {
  const normalizedEndHook = cleanupVideoSubmissionPrompt(endHook);
  if (!normalizedEndHook) return "";
  return `结尾钩子：\n${ensureVideoSubmissionSentence(normalizedEndHook)}`;
}

function formatVideoSubmissionNamedBlock(label: string, text: string): string {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => cleanupVideoSubmissionPrompt(line))
    .filter((line) => hasMeaningfulVideoSubmissionText(line))
    .map((line) => (/[:：]$/.test(line) ? line : ensureVideoSubmissionSentence(line)))
    .filter(Boolean)
    .join("\n");
  if (!normalized) return "";
  return `${label}：\n${normalized}`;
}

function normalizeVideoSubmissionNamedBlockText(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => cleanupVideoSubmissionPrompt(line))
    .filter((line) => hasMeaningfulVideoSubmissionText(line))
    .join("\n");
}

function stripVideoSubmissionNamedSections(
  content: string,
  labels: VideoModelSubmissionSectionLabel[],
): string {
  const normalized = String(content || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized || !labels.length) return normalized;
  const escapedLabels = labels.map((label) => escapeRegExp(label)).join("|");
  const escapedAllLabels = VIDEO_MODEL_SUBMISSION_SECTION_LABELS.map((label) => escapeRegExp(label)).join("|");
  return normalized
    .replace(
      new RegExp(
        `(?:^|\\n)\\s*(?:${escapedLabels})\\s*[:：][\\s\\S]*?(?=(?:\\n\\s*(?:${escapedAllLabels})\\s*[:：])|$)`,
        "g",
      ),
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitVideoSubmissionPreludeBlocks(content: string): {
  globalStyle: string;
  visualAnchors: string;
} {
  const normalized = cleanupVideoSubmissionPrompt(content);
  if (!normalized) {
    return { globalStyle: "", visualAnchors: "" };
  }

  const explicitAnchorMatch = normalized.match(/视觉锚点\s*[:：]/);
  if (explicitAnchorMatch && typeof explicitAnchorMatch.index === "number") {
    return {
      globalStyle: sanitizeVideoSubmissionGlobalStyleText(normalized.slice(0, explicitAnchorMatch.index)),
      visualAnchors: sanitizeVideoSubmissionVisualAnchorsText(
        normalized.slice(explicitAnchorMatch.index + explicitAnchorMatch[0].length),
      ),
    };
  }

  const implicitAnchorMatch = normalized.match(VIDEO_SUBMISSION_PRELUDE_SPLIT_PATTERN);
  if (implicitAnchorMatch && typeof implicitAnchorMatch.index === "number") {
    return {
      globalStyle: sanitizeVideoSubmissionGlobalStyleText(normalized.slice(0, implicitAnchorMatch.index)),
      visualAnchors: sanitizeVideoSubmissionVisualAnchorsText(normalized.slice(implicitAnchorMatch.index)),
    };
  }

  const firstSentenceMatch = normalized.match(/^[^。！？]*[。！？]?/);
  const firstSentence = sanitizeVideoSubmissionGlobalStyleText(firstSentenceMatch?.[0] || normalized);
  const remainder = cleanupVideoSubmissionPrompt(
    normalized
      .slice((firstSentenceMatch?.[0] || normalized).length)
      .replace(/^[\s，,、；;]+/, ""),
  );
  if (!firstSentence) {
    return { globalStyle: sanitizeVideoSubmissionGlobalStyleText(remainder), visualAnchors: "" };
  }
  return {
    globalStyle: firstSentence,
    visualAnchors: sanitizeVideoSubmissionVisualAnchorsText(remainder),
  };
}

function formatVideoSubmissionBody(
  prompt: string,
  options?: {
    shotDialogueGroups?: string[][];
    durationSeconds?: number;
    shotDurations?: number[];
    extraDialogueLines?: string[];
    startContinuityText?: string;
    flowContinuityText?: string;
  },
): string {
  const explicitShotDialogueKeys = buildVideoSubmissionDialogueKeySet(options?.shotDialogueGroups);
  const sections = extractVideoSubmissionSections(prompt);
  if (!sections.length) {
    const normalizedPrompt = cleanupVideoSubmissionPrompt(prompt);
    if (!normalizedPrompt) return "";

    const extractedPrompt = extractInlineVideoSubmissionDialogues(normalizedPrompt);
    const { prose, timeline } = splitVideoSubmissionTimelineFromSection(extractedPrompt.content);
    const mergedDialogueLines = mergeVideoSubmissionDialogueLines(
      filterVideoSubmissionDialogueLinesByBlockedKeys(
        extractedPrompt.dialogueLines,
        explicitShotDialogueKeys,
      ),
      options?.extraDialogueLines || [],
    );
    const blocks: string[] = [];
    const preludeBlocks = splitVideoSubmissionPreludeBlocks(prose);

    if (preludeBlocks.globalStyle) {
      blocks.push(ensureVideoSubmissionSentence(preludeBlocks.globalStyle));
    }
    if (preludeBlocks.visualAnchors) {
      const formattedVisualAnchors = formatVideoSubmissionVisualAnchorsBlock(preludeBlocks.visualAnchors);
      if (formattedVisualAnchors) {
        blocks.push(formattedVisualAnchors);
      }
    }

    const startContinuityBlock = formatVideoSubmissionNamedBlock(
      "起始衔接",
      options?.startContinuityText || "",
    );
    if (startContinuityBlock) {
      blocks.push(startContinuityBlock);
    }

    const flowContinuityBlock = formatVideoSubmissionNamedBlock(
      "衔接原则",
      options?.flowContinuityText || "",
    );
    if (flowContinuityBlock) {
      blocks.push(flowContinuityBlock);
    }

    if (timeline) {
      const formattedTimeline = formatVideoSubmissionTimeline(timeline, {
        shotDialogueGroups: options?.shotDialogueGroups,
        durationSeconds: options?.durationSeconds,
        shotDurations: options?.shotDurations,
        tailDialogueLines: mergedDialogueLines,
      });
      if (formattedTimeline.text) {
        blocks.push(formattedTimeline.text);
      }
      return blocks.filter(Boolean).join("\n\n");
    }

    const fallbackBody = blocks.length
      ? blocks.join("\n\n")
      : ensureVideoSubmissionSentence(extractedPrompt.content);
    return appendVideoSubmissionDialogueLinesToLastBlock(fallbackBody, mergedDialogueLines);
  }

  const byLabel = new Map<VideoModelSubmissionSectionLabel, string>();
  for (const section of sections) {
    if (!section.content) continue;
    const existing = byLabel.get(section.label);
    byLabel.set(
      section.label,
      cleanupVideoSubmissionPrompt([existing, section.content].filter(Boolean).join("；")),
    );
  }

  const blocks: string[] = [];
  const globalOnly = byLabel.get("全局要求");
  let globalStyleText = byLabel.get("全局风格") || "";
  let visualAnchors = byLabel.get("视觉锚点") || "";
  let timeline = byLabel.get("镜头推进") || "";
  const dialogueLines = mergeVideoSubmissionDialogueLines(
    filterVideoSubmissionDialogueLinesByBlockedKeys(
      extractVideoSubmissionDialogueSectionLines(byLabel.get("台词") || ""),
      explicitShotDialogueKeys,
    ),
    options?.extraDialogueLines || [],
  );

  if (globalStyleText && !visualAnchors) {
    const preludeBlocks = splitVideoSubmissionPreludeBlocks(globalStyleText);
    globalStyleText = preludeBlocks.globalStyle || globalStyleText;
    if (preludeBlocks.visualAnchors) {
      visualAnchors = preludeBlocks.visualAnchors;
    }
  }

  if (!timeline && visualAnchors) {
    const splitFromAnchor = splitVideoSubmissionTimelineFromSection(visualAnchors);
    visualAnchors = splitFromAnchor.prose;
    timeline = splitFromAnchor.timeline;
  }

  if (!timeline && globalStyleText) {
    const splitFromGlobal = splitVideoSubmissionTimelineFromSection(globalStyleText);
    globalStyleText = splitFromGlobal.prose;
    timeline = splitFromGlobal.timeline;
  }

  const sectionsThatMayHideTimeline: VideoModelSubmissionSectionLabel[] = [
    "起始衔接",
    "衔接原则",
    "环境细节",
    "环境动态",
    "声音氛围",
    "节奏衔接",
    "结尾钩子",
  ];
  sectionsThatMayHideTimeline.forEach((label) => {
    const original = byLabel.get(label);
    if (!original) return;
    const peeled = peelTimelineFromNamedSection(original, explicitShotDialogueKeys);
    if (!peeled.timeline) return;
    byLabel.set(label, peeled.prose);
    timeline = cleanupVideoSubmissionPrompt([timeline, peeled.timeline].filter(Boolean).join("；"));
  });

  const startContinuityText = normalizeVideoSubmissionNamedBlockText(
    options?.startContinuityText || byLabel.get("起始衔接") || "",
  );
  const flowContinuityText = normalizeVideoSubmissionNamedBlockText(
    options?.flowContinuityText || byLabel.get("衔接原则") || "",
  );

  if (globalStyleText) {
    const sanitizedGlobalStyle = sanitizeVideoSubmissionGlobalStyleText(globalStyleText);
    if (sanitizedGlobalStyle) {
      blocks.push(ensureVideoSubmissionSentence(sanitizedGlobalStyle));
    }
  } else if (globalOnly) {
    const normalizedGlobalOnly = sanitizeVideoSubmissionGlobalStyleText(globalOnly);
    if (normalizedGlobalOnly) {
      const firstSentenceEnd = normalizedGlobalOnly.indexOf("。");
      if (firstSentenceEnd >= 0) {
        const firstSentence = ensureVideoSubmissionSentence(normalizedGlobalOnly.slice(0, firstSentenceEnd + 1));
        const remainder = normalizedGlobalOnly.slice(firstSentenceEnd + 1).trim();
        if (remainder && isOnlyVideoControlTerms(firstSentence)) {
          const cleanedRemainder = cleanupVideoSubmissionPrompt(remainder).replace(/[。；]+$/g, "");
          if (cleanedRemainder) {
            blocks.push(ensureVideoSubmissionSentence(cleanedRemainder));
          }
        } else {
          blocks.push(firstSentence);
          if (remainder) {
            blocks.push(ensureVideoSubmissionSentence(remainder));
          }
        }
      } else {
        blocks.push(ensureVideoSubmissionSentence(normalizedGlobalOnly));
      }
    }
  }

  if (visualAnchors) {
    const formattedVisualAnchors = formatVideoSubmissionVisualAnchorsBlock(visualAnchors);
    if (formattedVisualAnchors) {
      blocks.push(formattedVisualAnchors);
    }
  }

  const formattedStartContinuity = formatVideoSubmissionNamedBlock("起始衔接", startContinuityText);
  if (formattedStartContinuity) {
    blocks.push(formattedStartContinuity);
  }

  const formattedFlowContinuity = formatVideoSubmissionNamedBlock("衔接原则", flowContinuityText);
  if (formattedFlowContinuity) {
    blocks.push(formattedFlowContinuity);
  }

    if (timeline) {
      const formattedTimeline = formatVideoSubmissionTimeline(timeline, {
        shotDialogueGroups: options?.shotDialogueGroups,
        durationSeconds: options?.durationSeconds,
        shotDurations: options?.shotDurations,
        tailDialogueLines: dialogueLines,
      });
      timeline = formattedTimeline.text;
      if (timeline) {
        blocks.push(timeline);
      }

      const environmentParts = [byLabel.get("环境细节"), byLabel.get("环境动态"), byLabel.get("声音氛围")]
        .filter(Boolean)
        .map((part) => sanitizeVideoSubmissionEnvironmentText(part))
        .filter(Boolean);
      if (environmentParts.length) {
        blocks.push(`环境细节：\n${ensureVideoSubmissionSentence(environmentParts.join("；"))}`);
      }

      const transition = cleanupVideoSubmissionPrompt(byLabel.get("节奏衔接") || "");
      const endHook = byLabel.get("结尾钩子");
      const mergedEndHook = cleanupVideoSubmissionPrompt([transition, endHook].filter(Boolean).join("；"));
      const formattedEndHook = formatVideoSubmissionEndHook(mergedEndHook);
      if (formattedEndHook) {
        blocks.push(formattedEndHook);
      }
      return blocks.filter(Boolean).join("\n\n");
  }

  const environmentParts = [byLabel.get("环境细节"), byLabel.get("环境动态"), byLabel.get("声音氛围")]
    .filter(Boolean)
    .map((part) => sanitizeVideoSubmissionEnvironmentText(part))
    .filter(Boolean);
  if (environmentParts.length) {
    blocks.push(`环境细节：\n${ensureVideoSubmissionSentence(environmentParts.join("；"))}`);
  }

  const transition = cleanupVideoSubmissionPrompt(byLabel.get("节奏衔接") || "");
  const endHook = byLabel.get("结尾钩子");
  const mergedEndHook = cleanupVideoSubmissionPrompt([transition, endHook].filter(Boolean).join("；"));
  const formattedEndHook = formatVideoSubmissionEndHook(mergedEndHook);
  if (formattedEndHook) {
    blocks.push(formattedEndHook);
  }
  return appendVideoSubmissionDialogueLinesToLastBlock(
    blocks.filter(Boolean).join("\n\n"),
    dialogueLines,
  );
}

function normalizeVideoSubmissionLockBlock(prompt: string): string {
  return String(prompt || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => normalizeVideoSubmissionFragment(line))
    .filter(Boolean)
    .join("\n");
}

function normalizeVideoSubmissionPrompt(
  prompt: string | null | undefined,
  options?: {
    shotDialogueGroups?: string[][];
    durationSeconds?: number;
    shotDurations?: number[];
    startContinuityText?: string;
    flowContinuityText?: string;
    softMaxChars?: number;
    hardMaxChars?: number;
    preserveStartContinuityBlock?: boolean;
  },
): string {
  const raw = String(prompt || "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return "";

  const lockIndexes = [
    raw.indexOf(EXACT_DIALOGUE_LOCK_HEADING),
    raw.indexOf(NO_DIALOGUE_LOCK_HEADING),
  ].filter((index) => index >= 0);
  const lockStart = lockIndexes.length ? Math.min(...lockIndexes) : -1;
  const promptWithCoverage = lockStart >= 0 ? raw.slice(0, lockStart).trim() : raw;
  const lockBlock = lockStart >= 0 ? raw.slice(lockStart).trim() : "";
  const { primaryBody: promptBody } = splitVideoSubmissionCoverageBlock(promptWithCoverage);
  const legacyDialogueLines = buildVideoSubmissionDialogueFromLockBlock(lockBlock);

  const normalizedBody = promptBody
    ? enforceVideoSubmissionGlobalControls(normalizeVideoSubmissionFragment(promptBody))
    : "";
  const formattedBody = ensureVideoSubmissionOpeningDuration(
    formatVideoSubmissionBody(normalizedBody, {
      ...options,
      extraDialogueLines: legacyDialogueLines,
    }),
    options?.durationSeconds,
  );
  const softMaxChars = Number(options?.softMaxChars);
  const hardMaxChars = Number(options?.hardMaxChars);
  const effectiveMaxChars = [softMaxChars, hardMaxChars]
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce<number | null>((min, value) => (min === null ? Number(value) : Math.min(min, Number(value))), null);
  const shouldPreserveStructuredSegmentFormat =
    /起始衔接：/.test(formattedBody) && /衔接原则：/.test(formattedBody) && /分镜\d+/.test(formattedBody);
  const normalizedEffectiveMaxChars =
    effectiveMaxChars && shouldPreserveStructuredSegmentFormat
      ? Math.max(effectiveMaxChars, 980)
      : effectiveMaxChars;
  if (!normalizedEffectiveMaxChars) {
    return appendVideoSubmissionCommonSuffix(
      dedupeVideoSubmissionContinuityEchoes(dedupeVideoSubmissionDialogueLinesInBody(formattedBody)),
    );
  }
  const suffix = `${VIDEO_MODEL_COMMON_SUFFIX_LABEL}： ${VIDEO_MODEL_GLOBAL_CONTROL_TEXT}`;
  const tightenedBody = tightenVideoSubmissionBodyLength(
    formattedBody,
    Math.max(240, Math.round(normalizedEffectiveMaxChars) - suffix.length - 2),
    {
      preserveStartContinuityBlock: options?.preserveStartContinuityBlock === true,
    },
  );
  return appendVideoSubmissionCommonSuffix(
    dedupeVideoSubmissionContinuityEchoes(dedupeVideoSubmissionDialogueLinesInBody(tightenedBody)),
  );
}

function collectSegmentDialogueLock(scenes: Scene[]): string {
  const lines = scenes.flatMap((scene) => splitExactDialogueLines(scene.dialogue));
  return lines.join("\n");
}

function withExactDialogueLock(
  result: VideoEnhanceResult,
  dialogue: string | null | undefined,
): VideoEnhanceResult {
  return {
    ...result,
    enhanced: appendExactDialogueLock(result.enhanced, dialogue),
  };
}

export interface VideoWorkflowContinuationPlan {
  actionKind:
    | "analyze_script_for_video"
    | "extract_video_entities"
    | "generate_video_reference_assets"
    | "prepare_storyboard_batch"
    | "generate_storyboard_frames"
    | "compile_video_shot_packets"
    | "prepare_video_prompt_batch"
    | "prepare_segment_video_prompt"
    | "generate_video_assets"
    | "generate_segment_video"
    | "refresh_segment_video"
    | "review_video_assets"
    | "export_storyboard_xlsx"
    | "create_video_bridge_artifact";
  policy:
    | "bootstrap-analysis"
    | "bootstrap-entities"
    | "bootstrap-reference-assets"
    | "bootstrap-storyboard-text"
    | "bootstrap-storyboard-frames"
    | "bootstrap-shot-packets"
    | "bootstrap-prompt-batch"
    | "bootstrap-segment-prompt"
    | "refresh-running"
    | "refresh-running-segments"
    | "repair-failed"
    | "repair-failed-segments"
    | "generate-next-batch"
    | "generate-next-segment-batch"
    | "review-escalated"
    | "bridge-summary";
  input: Record<string, unknown>;
  reason: string;
  targetCount?: number;
  totalTargetCount?: number;
  remainingTargetCount?: number;
}

const VIDEO_ROUND_TERMINAL_POLICIES = new Set<VideoWorkflowContinuationPlan["policy"]>([
  "refresh-running",
  "refresh-running-segments",
  "review-escalated",
  "bridge-summary",
]);

function truncate(text: string, max = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function appendImageHistory(
  currentUrl: string | undefined,
  nextUrl: string | undefined,
  description: string,
  previousHistory: Array<{ imageUrl: string; description: string; createdAt: string }> | undefined,
) {
  if (!currentUrl || currentUrl === nextUrl) return previousHistory || [];
  if (previousHistory?.some((entry) => entry.imageUrl === currentUrl)) {
    return previousHistory;
  }

  return [
    ...(previousHistory || []),
    {
      imageUrl: currentUrl,
      description,
      createdAt: new Date().toISOString(),
    },
  ];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeName(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

type EntityConsistencyKind = "character" | "scene";

const CHARACTER_ENTITY_DECORATION_PATTERN =
  /(?:少年|幼年|童年|成年|青年|老年|小时候|幼时|暮年|战损|染血|黑化|魔化|神化|伪装|男装|女装|婚纱|礼服|校服|制服|官服|军装|常服|便装|华服|旗袍|红衣|白衣|黑衣)/;
const SCENE_ENTITY_DECORATION_PATTERN =
  /(?:清晨|黎明|白天|日间|午间|黄昏|傍晚|夜景|夜晚|深夜|夜间|雨夜|雪夜|暴雨夜|雷雨夜|断电|停电|熄灯|火场|战后|废墟|毁坏)/;

function stripTrailingEntityDecoration(
  value: string,
  pattern: RegExp,
): string {
  let next = value.trim();
  if (!next) return next;

  next = next.replace(
    /\s*[（(【\[]([^（）()【】\[\]]+)[】）)\]]\s*$/u,
    (match, inner: string) => (pattern.test(inner.trim()) ? "" : match),
  );
  next = next.replace(
    /\s*(?:[-/|｜:：]\s*)([^-/|｜:：]+)\s*$/u,
    (match, inner: string) => (pattern.test(inner.trim()) ? "" : match),
  );

  return next.trim();
}

function normalizeEntityConsistencyName(
  value: string | undefined,
  kind: EntityConsistencyKind,
): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const stripped = stripTrailingEntityDecoration(
    trimmed,
    kind === "character" ? CHARACTER_ENTITY_DECORATION_PATTERN : SCENE_ENTITY_DECORATION_PATTERN,
  );
  return normalizeName(stripped);
}

function areEntityNamesEquivalent(
  leftName: string | undefined,
  rightName: string | undefined,
  kind: EntityConsistencyKind,
): boolean {
  const left = normalizeName(leftName);
  const right = normalizeName(rightName);
  if (!left || !right) return false;
  if (left === right) return true;

  const leftConsistency = normalizeEntityConsistencyName(leftName, kind);
  const rightConsistency = normalizeEntityConsistencyName(rightName, kind);
  return Boolean(leftConsistency && rightConsistency && leftConsistency === rightConsistency);
}

function resolveEntityExtractionMaxRounds(input: Record<string, unknown>): number {
  const requested = Number(input.entityExtractionMaxRounds ?? input.maxEntityExtractionRounds);
  if (!Number.isFinite(requested)) return DEFAULT_ENTITY_EXTRACTION_MAX_ROUNDS;
  return Math.max(1, Math.min(DEFAULT_ENTITY_EXTRACTION_MAX_ROUNDS, Math.floor(requested)));
}

function collectEntityCoverageCandidates(scenes: Scene[] | undefined): EntityCoverageCandidates {
  const characterNames: string[] = [];
  const sceneNames: string[] = [];
  const seenCharacterNames = new Set<string>();
  const seenSceneNames = new Set<string>();

  (scenes || []).forEach((scene) => {
    (scene.characters || []).forEach((name) => {
      const trimmed = String(name || "").trim();
      const normalized = normalizeEntityConsistencyName(trimmed, "character") || normalizeName(trimmed);
      if (!trimmed || seenCharacterNames.has(normalized)) return;
      seenCharacterNames.add(normalized);
      characterNames.push(trimmed);
    });

    const sceneName = String(scene.sceneName || "").trim();
    const normalizedSceneName = normalizeEntityConsistencyName(sceneName, "scene") || normalizeName(sceneName);
    if (!sceneName || seenSceneNames.has(normalizedSceneName)) return;
    seenSceneNames.add(normalizedSceneName);
    sceneNames.push(sceneName);
  });

  return { characterNames, sceneNames };
}

function resolveEntityCoverageGaps(
  candidates: EntityCoverageCandidates,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): EntityCoverageGaps {
  return {
    missingCharacterNames: candidates.characterNames.filter((name) =>
      !characters.some((character) => areEntityNamesEquivalent(character.name, name, "character")),
    ),
    missingSceneNames: candidates.sceneNames.filter((name) =>
      !sceneSettings.some((sceneSetting) => areEntityNamesEquivalent(sceneSetting.name, name, "scene")),
    ),
  };
}

function buildEntityExtractionHint(gaps: EntityCoverageGaps): string {
  const hasMissingCoverage =
    gaps.missingCharacterNames.length > 0 || gaps.missingSceneNames.length > 0;
  const lines = [
    hasMissingCoverage
      ? "这是一次内部复核，请重点核对上一轮遗漏的角色与场景，并把它们补充进 JSON 输出。"
      : "这是一次内部复核，请在保留已识别实体的前提下，复查是否还有遗漏，并合并重复或近义的角色服装变体、场景变体。",
  ];

  if (gaps.missingCharacterNames.length) {
    lines.push(`仍缺少的角色：${gaps.missingCharacterNames.join("、")}`);
  }

  if (gaps.missingSceneNames.length) {
    lines.push(`仍缺少的场景：${gaps.missingSceneNames.join("、")}`);
  }

  lines.push("不要删除已经识别出的其他实体；如果只是同一视觉状态的重复命名，只保留一个最稳定的标签。");
  lines.push("继续只根据已经写出的剧本正文内容复核，过滤旁白/画外音/VO/OS，以及预告、提要、未来计划等未正式撰写的内容，不要把它们提成当前资产。");
  if (hasMissingCoverage) {
    lines.push(
      "如果剧本里确实出现了这些名称，请将它们写入 characters 或 sceneSettings，并继续返回完整 JSON。",
    );
  } else {
    lines.push("若没有新增实体，也请继续返回完整 JSON，并优先清理重复变体与近义标签。");
  }

  return lines.join("\n");
}

function buildEntityExtractionFingerprint(
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): string {
  return JSON.stringify({
    characters: [...characters]
      .map((character) => ({
        name: normalizeName(character.name),
        description: character.description.trim(),
        costumes: [...(character.costumes || [])]
          .map((costume) => ({
            label: normalizeName(costume.label),
            description: costume.description.trim(),
          }))
          .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    sceneSettings: [...sceneSettings]
      .map((sceneSetting) => ({
        name: normalizeName(sceneSetting.name),
        description: sceneSetting.description.trim(),
        timeVariants: [...(sceneSetting.timeVariants || [])]
          .map((variant) => ({
            label: normalizeName(variant.label),
            description: variant.description.trim(),
          }))
          .sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
  });
}

function stabilizeNamedEntityOrder<T extends { name: string }>(previous: T[], next: T[]): T[] {
  const ordered: T[] = [];
  const remaining = new Map(next.map((item) => [normalizeName(item.name), item] as const));

  previous.forEach((item) => {
    const normalizedName = normalizeName(item.name);
    const matched = remaining.get(normalizedName);
    if (!matched) return;
    ordered.push(matched);
    remaining.delete(normalizedName);
  });

  next.forEach((item) => {
    const normalizedName = normalizeName(item.name);
    const matched = remaining.get(normalizedName);
    if (!matched) return;
    ordered.push(matched);
    remaining.delete(normalizedName);
  });

  return ordered;
}

function appendEntityCoveragePlaceholders(
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
  gaps: EntityCoverageGaps,
): {
  characters: CharacterSetting[];
  sceneSettings: SceneSetting[];
  placeholderCharacterCount: number;
  placeholderSceneCount: number;
} {
  const nextCharacters = [...characters];
  const nextSceneSettings = [...sceneSettings];

  gaps.missingCharacterNames.forEach((name) => {
    nextCharacters.push({
      id: crypto.randomUUID(),
      name,
      description: ENTITY_EXTRACTION_PLACEHOLDER_DESCRIPTION,
      isAIGenerated: false,
      isGenerating: false,
      source: "auto",
    });
  });

  gaps.missingSceneNames.forEach((name) => {
    nextSceneSettings.push({
      id: crypto.randomUUID(),
      name,
      description: ENTITY_EXTRACTION_PLACEHOLDER_DESCRIPTION,
      isAIGenerated: false,
      isGenerating: false,
      source: "auto",
    });
  });

  return {
    characters: nextCharacters,
    sceneSettings: nextSceneSettings,
    placeholderCharacterCount: gaps.missingCharacterNames.length,
    placeholderSceneCount: gaps.missingSceneNames.length,
  };
}

type EntityVariantKind = "costume" | "scene-time";

type EntityVariantLike = {
  id: string;
  label: string;
  description: string;
  imageUrl?: string;
  isAIGenerated: boolean;
  imageHistory?: Array<{ imageUrl: string; description: string; createdAt: string }>;
};

const COSTUME_CORE_TERMS = [
  "日常装",
  "便装",
  "便服",
  "常服",
  "校服",
  "制服",
  "婚纱",
  "礼服",
  "旗袍",
  "华服",
  "法袍",
  "道袍",
  "睡衣",
  "浴袍",
  "长裙",
  "短裙",
  "红衣",
  "白衣",
  "黑衣",
  "青衣",
  "战甲",
  "铠甲",
  "盔甲",
  "披风",
  "斗篷",
  "官服",
  "军装",
  "西装",
].sort((a, b) => b.length - a.length);

const COSTUME_GENERIC_BASELINE_PATTERN = /^(?:常态|常规|普通|默认|基础|原始|原貌|本体|平时|日常)(?:状态|形态|姿态|版|款)?$/;
const SCENE_GENERIC_BASELINE_PATTERN = /^(?:日常|常态|常规|普通|默认|基础|平时|原貌)(?:状态|场景|版|款)?$/;
const ENGLISH_GENERIC_BASELINE_PATTERN = /^(?:default|normal|regular|standard|base|basic|original|daily|casual)$/;
const COSTUME_VISUAL_SIGNAL_PATTERN =
  /(?:装|服装|校服|制服|便服|常服|礼服|华服|官服|军装|囚服|丧服|法服|衣|袍|裙|甲|冠|纱|披风|斗篷|面具|发髻|发型|妆容|战损|破损|染血|血污|神化|新神|成神|黑化|魔化|入魔|白发|银发|少年|幼年|成年|老年)/;
const SCENE_VISUAL_SIGNAL_PATTERN =
  /(?:夜|晨|昏|午|日间|白天|白昼|雨|雪|雾|晴|阴|风|雷|霾|春|夏|秋|冬|断电|停电|熄灯|火灾|火场|火后|战后|战斗后|废墟|毁坏|坍塌|残破|雨后|雪后|洪水|夕阳|黎明|霓虹|灯火)/;

function normalizeVariantLabel(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[【】「」『』《》()（）[\]{}"'“”‘’、，,。.!！?？:：;；\s_-]+/g, "")
    .replace(/(?:状态|形态|姿态|版本|版|造型|模式)$/g, "")
    .replace(/颜色/g, "色")
    .replace(/暗红色/g, "暗红")
    .replace(/绛红色/g, "绛红")
    .replace(/深红色/g, "深红");
}

function buildVariantSignalText(label: string, description: string): string {
  return normalizeVariantLabel(`${label} ${description}`);
}

function hasVariantMedia(
  variant: Pick<EntityVariantLike, "imageUrl" | "imageHistory"> | undefined,
): boolean {
  return Boolean(variant?.imageUrl?.trim() || variant?.imageHistory?.length);
}

function resolveCostumeVariantStates(normalized: string): string[] {
  const states: string[] = [];
  const registerState = (label: string, pattern: RegExp) => {
    if (pattern.test(normalized) && !states.includes(label)) {
      states.push(label);
    }
  };

  registerState("神化", /(?:神化|新神|成神)/);
  registerState("魔化", /(?:魔化|入魔|妖化|兽化|龙化)/);
  registerState("黑化", /(?:黑化)/);
  registerState("染血", /(?:染血|血污|溅血|血迹)/);
  registerState("战损", /(?:战损|破损|受伤|负伤)/);
  registerState("白发", /(?:白发|银发)/);
  registerState("伪装", /(?:伪装|易容)/);
  registerState("男装", /(?:男装)/);
  registerState("女装", /(?:女装)/);
  registerState("少年", /(?:少年|幼年|童年)/);
  registerState("成年", /(?:成年)/);
  registerState("老年", /(?:老年|暮年)/);
  registerState("病弱", /(?:病弱|虚弱)/);

  return states;
}

function resolveCostumeVariantStateKey(normalized: string): string {
  return resolveCostumeVariantStates(normalized).join("+");
}

function shouldKeepVariantCandidate(
  label: string,
  description: string,
  kind: EntityVariantKind,
): boolean {
  const normalizedLabel = normalizeVariantLabel(label);
  if (!normalizedLabel) return false;

  const signalText = buildVariantSignalText(label, description);
  const hasEnglishSignal = /[a-z]/i.test(`${label} ${description}`) && Boolean(description.trim());
  if (kind === "costume") {
    if (COSTUME_GENERIC_BASELINE_PATTERN.test(normalizedLabel) || ENGLISH_GENERIC_BASELINE_PATTERN.test(normalizedLabel)) {
      return false;
    }
    return COSTUME_VISUAL_SIGNAL_PATTERN.test(signalText) || hasEnglishSignal;
  }

  if (SCENE_GENERIC_BASELINE_PATTERN.test(normalizedLabel) || ENGLISH_GENERIC_BASELINE_PATTERN.test(normalizedLabel)) {
    return false;
  }
  return SCENE_VISUAL_SIGNAL_PATTERN.test(signalText) || hasEnglishSignal;
}

function shouldPreserveVariant<T extends EntityVariantLike>(
  variant: T,
  kind: EntityVariantKind,
): boolean {
  return hasVariantMedia(variant) || shouldKeepVariantCandidate(variant.label, variant.description, kind);
}

function resolveCostumeVariantKeyFromText(text: string): string {
  const normalized = normalizeVariantLabel(text);
  if (!normalized) return "";

  const core = COSTUME_CORE_TERMS.find((term) => normalized.includes(term));
  const state = resolveCostumeVariantStateKey(normalized);
  if (core) {
    return state ? `${state}:${core}` : core;
  }
  return state || normalized;
}

function resolveCostumeVariantKey(label: string): string {
  return resolveCostumeVariantKeyFromText(label);
}

function resolveSceneTimeVariantKeyFromText(text: string): string {
  const normalized = normalizeVariantLabel(text);
  if (!normalized) return "";

  const time =
    /(?:夜|夜晚|夜间|夜景|雨夜|雷雨夜|深夜)/.test(normalized) ? "夜间" :
    /(?:清晨|晨间|早晨|黎明|拂晓)/.test(normalized) ? "清晨" :
    /(?:黄昏|傍晚|夕阳|日落)/.test(normalized) ? "黄昏" :
    /(?:正午|中午|午间)/.test(normalized) ? "正午" :
    /(?:日间|白天|白昼|日景|晴天|上午|下午)/.test(normalized) ? "日间" :
    "";
  const weather =
    /(?:雷雨|暴雨|大雨|雨夜|雨天|雨中|下雨|雨)/.test(normalized) ? "雨" :
    /(?:暴雪|大雪|雪夜|雪天|雪中|下雪|雪)/.test(normalized) ? "雪" :
    /(?:浓雾|雾天|雾中|雾)/.test(normalized) ? "雾" :
    /(?:阴天|阴沉|阴云)/.test(normalized) ? "阴" :
    /(?:晴天|晴朗)/.test(normalized) ? "晴" :
    "";
  const state =
    /(?:断电|停电|熄灯)/.test(normalized) ? "断电" :
    /(?:火灾后|火灾|火场|火后)/.test(normalized) ? "火灾" :
    /(?:废墟|战斗后|战后|毁坏|坍塌)/.test(normalized) ? "毁坏" :
    "";

  return [weather, time, state].filter(Boolean).join(":") || normalized;
}

function resolveSceneTimeVariantKey(label: string): string {
  return resolveSceneTimeVariantKeyFromText(label);
}

function resolveVariantSemanticKey(
  label: string,
  description: string | undefined,
  kind: EntityVariantKind,
): string {
  const signalText = buildVariantSignalText(label, description || "");
  return kind === "costume"
    ? resolveCostumeVariantKeyFromText(signalText)
    : resolveSceneTimeVariantKeyFromText(signalText);
}

function resolveVariantKey(label: string, kind: EntityVariantKind): string {
  return kind === "costume"
    ? resolveCostumeVariantKey(label)
    : resolveSceneTimeVariantKey(label);
}

function areVariantCandidatesEquivalent(
  left: { label: string; description?: string },
  right: { label: string; description?: string },
  kind: EntityVariantKind,
): boolean {
  const leftLabel = normalizeVariantLabel(left.label);
  const rightLabel = normalizeVariantLabel(right.label);
  if (!leftLabel || !rightLabel) return false;
  if (leftLabel === rightLabel) return true;

  const leftKey = resolveVariantKey(left.label, kind);
  const rightKey = resolveVariantKey(right.label, kind);
  if (leftKey && rightKey && leftKey === rightKey) return true;

  const leftSemanticKey = resolveVariantSemanticKey(left.label, left.description, kind);
  const rightSemanticKey = resolveVariantSemanticKey(right.label, right.description, kind);
  if (leftSemanticKey && rightSemanticKey && leftSemanticKey === rightSemanticKey) return true;

  return false;
}

function chooseMergedVariantLabel(
  currentLabel: string,
  nextLabel: string,
  hasCurrentImage: boolean,
  kind?: EntityVariantKind,
  hasNextImage?: boolean,
): string {
  if (hasCurrentImage && !hasNextImage) return currentLabel;
  if (hasNextImage && !hasCurrentImage) return nextLabel;
  const current = normalizeVariantLabel(currentLabel);
  const next = normalizeVariantLabel(nextLabel);
  if (!current) return nextLabel;
  if (!next) return currentLabel;
  if (kind) {
    const currentKey = resolveVariantKey(currentLabel, kind);
    const nextKey = resolveVariantKey(nextLabel, kind);
    if (currentKey && currentKey === nextKey) {
      if (current === currentKey) return currentLabel;
      if (next === nextKey) return nextLabel;
      return currentLabel.trim().length <= nextLabel.trim().length ? currentLabel : nextLabel;
    }
  }
  if (next.includes(current) && next.length > current.length) return nextLabel;
  return currentLabel;
}

function chooseMergedVariantDescription(currentDescription: string, nextDescription: string): string {
  const current = currentDescription.trim();
  const next = nextDescription.trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function mergeEntityVariant<T extends EntityVariantLike>(
  current: T,
  next: T,
  kind?: EntityVariantKind,
): T {
  return {
    ...current,
    label: chooseMergedVariantLabel(
      current.label,
      next.label,
      Boolean(current.imageUrl?.trim()),
      kind,
      Boolean(next.imageUrl?.trim()),
    ),
    description: chooseMergedVariantDescription(current.description, next.description),
    imageUrl: current.imageUrl || next.imageUrl,
    isAIGenerated: current.isAIGenerated || next.isAIGenerated,
    imageHistory: current.imageHistory || next.imageHistory,
  };
}

function findMatchedVariantIndex<T extends { label: string; description?: string }>(
  items: T[],
  candidate: { label: string; description?: string },
  kind: EntityVariantKind,
  usedIndexes?: Set<number>,
): number {
  return items.findIndex(
    (item, candidateIndex) =>
      !usedIndexes?.has(candidateIndex) &&
      areVariantCandidatesEquivalent(item, candidate, kind),
  );
}

function dedupeEntityVariants<T extends EntityVariantLike>(
  variants: T[],
  kind: EntityVariantKind,
): T[] {
  const deduped: T[] = [];
  for (const variant of variants) {
    const existingIndex = findMatchedVariantIndex(deduped, variant, kind);
    if (existingIndex < 0) {
      deduped.push(variant);
      continue;
    }

    const existing = deduped[existingIndex]!;
    if (existing.imageUrl?.trim() && variant.imageUrl?.trim() && existing.imageUrl !== variant.imageUrl) {
      deduped.push(variant);
      continue;
    }

    deduped[existingIndex] = mergeEntityVariant(existing, variant, kind);
  }
  return deduped.filter((variant) => shouldPreserveVariant(variant, kind));
}

function chooseMergedEntityName(currentName: string, nextName: string): string {
  const current = currentName.trim();
  const next = nextName.trim();
  if (!current) return next;
  if (!next) return current;
  if (normalizeName(current) !== normalizeName(next)) return current;
  return current.length <= next.length ? current : next;
}

function chooseMergedConsistencyEntityName(
  currentName: string,
  nextName: string,
  kind: EntityConsistencyKind,
): string {
  const current = currentName.trim();
  const next = nextName.trim();
  if (!current) return next;
  if (!next) return current;
  if (normalizeName(current) === normalizeName(next)) {
    return chooseMergedEntityName(current, next);
  }

  const currentConsistency = normalizeEntityConsistencyName(current, kind);
  const nextConsistency = normalizeEntityConsistencyName(next, kind);
  if (!currentConsistency || currentConsistency !== nextConsistency) {
    return current;
  }

  const currentIsDecorated = normalizeName(current) !== currentConsistency;
  const nextIsDecorated = normalizeName(next) !== nextConsistency;
  if (currentIsDecorated !== nextIsDecorated) {
    return currentIsDecorated ? next : current;
  }

  return current.length <= next.length ? current : next;
}

function normalizeExtractedVariants(
  rawVariants: ExtractedVariantResult[] | undefined,
  kind: EntityVariantKind,
): ExtractedVariantResult[] | undefined {
  const deduped = dedupeEntityVariants(
    (rawVariants || []).map((variant, index) => ({
      id: `${kind}-${index}`,
      label: variant?.label?.trim() || `${kind === "costume" ? "角色变体" : "场景变体"} ${index + 1}`,
      description: variant?.description?.trim() || "",
      isAIGenerated: false,
    })),
    kind,
  );

  if (!deduped.length) return undefined;
  return deduped.map((variant) => ({
    label: variant.label,
    description: variant.description,
  }));
}

function mergeExtractedVariants(
  current: ExtractedVariantResult[] | undefined,
  next: ExtractedVariantResult[] | undefined,
  kind: EntityVariantKind,
): ExtractedVariantResult[] | undefined {
  return normalizeExtractedVariants([...(current || []), ...(next || [])], kind);
}

function dedupeExtractedCharacters(
  rawCharacters: ExtractEntitiesResult["characters"],
): NonNullable<ExtractEntitiesResult["characters"]> {
  const deduped: NonNullable<ExtractEntitiesResult["characters"]> = [];

  (rawCharacters || []).forEach((character, index) => {
    const name = character?.name?.trim() || `角色 ${index + 1}`;
    const nextCharacter = {
      name,
      description: character?.description?.trim() || "",
      costumes: normalizeExtractedVariants(character?.costumes, "costume"),
    };
    const existingIndex = deduped.findIndex((item) => areEntityNamesEquivalent(item.name, name, "character"));

    if (existingIndex < 0) {
      deduped.push(nextCharacter);
      return;
    }

    const existing = deduped[existingIndex]!;
    deduped[existingIndex] = {
      name: chooseMergedConsistencyEntityName(existing.name || "", nextCharacter.name, "character"),
      description: chooseMergedVariantDescription(existing.description || "", nextCharacter.description),
      costumes: mergeExtractedVariants(existing.costumes, nextCharacter.costumes, "costume"),
    };
  });

  return deduped;
}

function dedupeExtractedSceneSettings(
  rawSceneSettings: ExtractEntitiesResult["sceneSettings"],
): NonNullable<ExtractEntitiesResult["sceneSettings"]> {
  const deduped: NonNullable<ExtractEntitiesResult["sceneSettings"]> = [];

  (rawSceneSettings || []).forEach((sceneSetting, index) => {
    const name = sceneSetting?.name?.trim() || `场景 ${index + 1}`;
    const nextSceneSetting = {
      name,
      description: sceneSetting?.description?.trim() || "",
      timeVariants: normalizeExtractedVariants(sceneSetting?.timeVariants, "scene-time"),
    };
    const existingIndex = deduped.findIndex((item) => areEntityNamesEquivalent(item.name, name, "scene"));

    if (existingIndex < 0) {
      deduped.push(nextSceneSetting);
      return;
    }

    const existing = deduped[existingIndex]!;
    deduped[existingIndex] = {
      name: chooseMergedConsistencyEntityName(existing.name || "", nextSceneSetting.name, "scene"),
      description: chooseMergedVariantDescription(existing.description || "", nextSceneSetting.description),
      timeVariants: mergeExtractedVariants(existing.timeVariants, nextSceneSetting.timeVariants, "scene-time"),
    };
  });

  return deduped;
}

function buildVideoTitle(runtime: StudioRuntimeState, input: Record<string, unknown>): string {
  if (typeof input.title === "string" && input.title.trim()) {
    return input.title.trim();
  }
  if (runtime.currentVideoProject?.title?.trim()) {
    return runtime.currentVideoProject.title.trim();
  }
  if (runtime.currentDramaProject?.dramaTitle?.trim()) {
    return runtime.currentDramaProject.dramaTitle.trim();
  }
  if (runtime.currentProjectSnapshot?.title?.trim()) {
    return runtime.currentProjectSnapshot.title.trim();
  }
  return "未命名视频项目";
}

function buildScriptFromDrama(runtime: StudioRuntimeState): string {
  const drama = runtime.currentDramaProject;
  if (!drama) return "";
  if (drama.exportDocument.trim()) return drama.exportDocument;
  if (drama.episodes.length > 0) {
    return drama.episodes
      .map((episode) => `第${episode.number}集：${episode.title}\n${episode.content}`)
      .join("\n\n---\n\n");
  }
  if (drama.creativePlan.trim()) return drama.creativePlan;
  if (drama.structureTransform.trim()) return drama.structureTransform;
  return "";
}

function resolveWorkingScript(
  runtime: StudioRuntimeState,
  project: PersistedVideoProject | null,
  input: Record<string, unknown>,
): string {
  if (typeof input.script === "string" && input.script.trim()) {
    return input.script.trim();
  }
  if (project?.script?.trim()) return project.script.trim();
  const dramaScript = buildScriptFromDrama(runtime);
  if (dramaScript.trim()) return dramaScript.trim();
  if (runtime.currentProjectSnapshot?.artifacts?.length) {
    const artifactWithContent = runtime.currentProjectSnapshot.artifacts.find((artifact) => artifact.content?.trim());
    if (artifactWithContent?.content?.trim()) {
      return artifactWithContent.content.trim();
    }
  }
  return "";
}

function readTextInput(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" && String(input[key]).trim()
    ? String(input[key]).trim()
    : undefined;
}

function buildVideoContextSummary(project: PersistedVideoProject): string {
  return [
    project.targetPlatform?.trim()
      ? `目标平台：${project.targetPlatform.trim()}`
      : null,
    project.shotStyle?.trim() ? `镜头风格：${project.shotStyle.trim()}` : null,
    project.outputGoal?.trim() ? `出片目标：${project.outputGoal.trim()}` : null,
    project.productionNotes?.trim()
      ? `补充说明：${truncate(project.productionNotes.trim(), 160)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeVideoInputContext(
  project: PersistedVideoProject,
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): PersistedVideoProject {
  const requestedImageGenerationPrefs =
    typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
      ? normalizeVideoImageGenerationPrefs({
          ...(project.imageGenerationPrefs ?? {}),
          ...(input.imageGenerationPrefs as Partial<VideoImageGenerationPrefs>),
        })
      : project.imageGenerationPrefs;
  const fallbackArtStyle =
    typeof input.artStyle === "string"
      ? (input.artStyle as ArtStyle)
      : project.artStyle || "live-action";
  const artStyle = requestedImageGenerationPrefs
    ? resolveVideoImageProjectArtStyle(requestedImageGenerationPrefs, fallbackArtStyle)
    : fallbackArtStyle;
  const requestedVideoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const mergedProject = {
    ...project,
    title: buildVideoTitle(runtime, input),
    script: resolveWorkingScript(runtime, project, input),
    artStyle,
    ...(requestedImageGenerationPrefs ? { imageGenerationPrefs: requestedImageGenerationPrefs } : {}),
    videoGenerationPrefs: requestedVideoGenerationPrefs,
    systemPrompt: readTextInput(input, "systemPrompt") || project.systemPrompt || "",
    targetPlatform: readTextInput(input, "targetPlatform") || project.targetPlatform || "",
    shotStyle: readTextInput(input, "shotStyle") || project.shotStyle || "",
    outputGoal: readTextInput(input, "outputGoal") || project.outputGoal || "",
    productionNotes:
      readTextInput(input, "productionNotes") ||
      readTextInput(input, "customInstruction") ||
      project.productionNotes ||
      "",
    sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
  };
  return {
    ...mergedProject,
    styleLock: deriveVideoStyleLock(mergedProject),
  };
}

function buildCharacterVariantReferenceDescription(
  character: Pick<CharacterSetting, "name" | "description">,
  costume: Pick<CostumeSetting, "label" | "description">,
): string {
  return [
    character.description?.trim() || character.name,
    costume.description?.trim()
      ? `角色变体：${costume.label}。${costume.description.trim()}`
      : `角色变体：${costume.label}`,
    `本次只生成角色「${costume.label}」这一套变体，人物身份、脸部、发型轮廓和体型必须与主参考图保持一致。`,
    "必须让这张图与主参考图明显不同，重点把服装颜色、材质、损伤/血迹状态、配饰、层次和整体造型差异清楚落到画面里。",
    "不要回退成主参考图的默认版本；如果看起来仍像同一套默认服装或差异不够明显，就视为失败并需要重生。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSceneVariantReferenceDescription(
  sceneSetting: Pick<SceneSetting, "name" | "description">,
  variant: Pick<TimeVariantSetting, "label" | "description">,
): string {
  return [
    sceneSetting.description?.trim() || sceneSetting.name,
    variant.description?.trim()
      ? `场景变体：${variant.label}。${variant.description.trim()}`
      : `场景变体：${variant.label}`,
    `本次只生成场景「${variant.label}」这一套变体，空间结构、机位基准和主体布局必须与主参考图保持同一地点。`,
    "必须让这张图与主参考图明显不同，重点把时段、天气、光色、能见度、地面状态、损毁程度或氛围变化清楚落到画面里。",
    "不要回退成主参考图的默认场景版本；如果看起来仍像默认主场景或差异不够明显，就视为失败并需要重生。",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveProjectImagePromptStyle(
  project: Pick<PersistedVideoProject, "artStyle" | "imageGenerationPrefs">,
): string {
  return resolveVideoImagePromptStyle(
    project.imageGenerationPrefs,
    project.artStyle || "live-action",
  );
}

function buildProjectReferenceImageQaStyleContext(
  project: Pick<PersistedVideoProject, "artStyle" | "imageGenerationPrefs" | "styleLock" | "shotStyle">,
): string {
  const selectedPreset = resolveVideoImageProjectArtStyle(
    project.imageGenerationPrefs,
    project.artStyle || "live-action",
  );
  const lines = [
    `Selected render preset: ${selectedPreset}.`,
    `Generation style token: ${resolveProjectImagePromptStyle(project)}.`,
  ];

  const styleLock = project.styleLock;
  if (styleLock?.visualStyle?.trim()) {
    lines.push(`Locked visual style: ${styleLock.visualStyle.trim()}.`);
  }
  if (styleLock?.tone?.trim()) {
    lines.push(`Locked tone: ${styleLock.tone.trim()}.`);
  }
  if (styleLock?.genre?.length) {
    lines.push(`Locked genre anchors: ${styleLock.genre.join(" / ")}.`);
  }
  if (styleLock?.colorMood?.trim()) {
    lines.push(`Locked color mood: ${styleLock.colorMood.trim()}.`);
  }
  if (styleLock?.cinematography?.trim()) {
    lines.push(`Locked cinematography: ${styleLock.cinematography.trim()}.`);
  }
  if (project.shotStyle?.trim()) {
    lines.push(`Requested shot style: ${project.shotStyle.trim()}.`);
  }
  if (styleLock?.negativeRules?.length) {
    lines.push(`Avoided style drift: ${styleLock.negativeRules.join(" / ")}.`);
  }
  if (styleLock?.forbidden?.length) {
    lines.push(`Forbidden looks: ${styleLock.forbidden.join(" / ")}.`);
  }
  return lines.join("\n");
}

function resolveEffectiveImageGenerationPrefs(
  input: Record<string, unknown>,
  project?: Pick<PersistedVideoProject, "imageGenerationPrefs"> | null,
): VideoImageGenerationPrefs {
  const mergedPrefs =
    typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
      ? {
          ...(project?.imageGenerationPrefs ?? {}),
          ...(input.imageGenerationPrefs as Partial<VideoImageGenerationPrefs>),
        }
      : project?.imageGenerationPrefs ?? null;
  const resolvedModelFamily =
    typeof input.modelFamily === "string" && input.modelFamily.trim()
      ? input.modelFamily.trim()
      : typeof input.selectedImageModelFamily === "string" && input.selectedImageModelFamily.trim()
        ? input.selectedImageModelFamily.trim()
        : undefined;

  return resolveVideoImageRequestPrefs({
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
    modelFamily: resolvedModelFamily,
    resolution: typeof input.resolution === "string" && input.resolution.trim() ? input.resolution.trim() : undefined,
    aspectRatio: typeof input.aspectRatio === "string" && input.aspectRatio.trim() ? input.aspectRatio.trim() : undefined,
    imageGenerationPrefs: mergedPrefs,
  }).prefs;
}

function resolveRequestedImageModelFamily(
  input: Record<string, unknown>,
  project?: Pick<PersistedVideoProject, "imageGenerationPrefs"> | null,
): string {
  if (typeof input.modelFamily === "string" && input.modelFamily.trim()) {
    return input.modelFamily.trim();
  }
  if (typeof input.selectedImageModelFamily === "string" && input.selectedImageModelFamily.trim()) {
    return input.selectedImageModelFamily.trim();
  }
  if (typeof project?.imageGenerationPrefs?.familyKey === "string" && project.imageGenerationPrefs.familyKey.trim()) {
    return project.imageGenerationPrefs.familyKey.trim();
  }
  return "";
}

function buildScopedImageGenerationInput(
  input: Record<string, unknown>,
  project?: Pick<PersistedVideoProject, "imageGenerationPrefs"> | null,
  options?: { allowStoryboardMode?: boolean; allowReferenceImage?: boolean; allowViewMode?: boolean },
): Record<string, unknown> {
  const nextInput: Record<string, unknown> = {};
  const normalizedImageGenerationPrefs = resolveEffectiveImageGenerationPrefs(input, project);
  const requestedModelFamily = resolveRequestedImageModelFamily(input, project) || normalizedImageGenerationPrefs.familyKey;
  const imageGenerationPrefs: Record<string, unknown> = {
    ...normalizedImageGenerationPrefs,
    familyKey: requestedModelFamily,
  };
  const modelFamily = requestedModelFamily;

  if (typeof input.model === "string" && input.model.trim()) {
    nextInput.model = input.model.trim();
  }
  if (modelFamily) {
    nextInput.modelFamily = modelFamily;
    nextInput.selectedImageModelFamily = modelFamily;
  }
  nextInput.imageGenerationPrefs = imageGenerationPrefs;
  nextInput.aspectRatio = imageGenerationPrefs.aspectRatio;
  nextInput.resolution = imageGenerationPrefs.resolution;
  if (options?.allowStoryboardMode && input.mode === "panorama") {
    nextInput.mode = "panorama";
  }
  if (options?.allowReferenceImage && typeof input.referenceImageUrl === "string" && input.referenceImageUrl.trim()) {
    nextInput.referenceImageUrl = input.referenceImageUrl.trim();
  }
  const requestedViewMode =
    typeof input.viewMode === "string" && input.viewMode.trim()
      ? input.viewMode.trim()
      : typeof imageGenerationPrefs.viewMode === "string"
        ? imageGenerationPrefs.viewMode.trim()
        : "";
  if (options?.allowViewMode && requestedViewMode) {
    nextInput.viewMode = requestedViewMode;
    const constrainedAspectRatio = resolveVideoImageAspectRatioForViewMode(
      requestedViewMode,
      typeof nextInput.aspectRatio === "string"
        ? nextInput.aspectRatio
        : typeof imageGenerationPrefs.aspectRatio === "string"
          ? imageGenerationPrefs.aspectRatio
          : undefined,
    );
    nextInput.aspectRatio = constrainedAspectRatio;
    if (typeof nextInput.imageGenerationPrefs === "object" && nextInput.imageGenerationPrefs) {
      nextInput.imageGenerationPrefs = {
        ...(nextInput.imageGenerationPrefs as Record<string, unknown>),
        viewMode: requestedViewMode,
        aspectRatio: constrainedAspectRatio,
      };
    }
  }

  return nextInput;
}

function resolveSmartReferenceAssetBatchLimit(
  input: Record<string, unknown>,
  project?: Pick<PersistedVideoProject, "imageGenerationPrefs"> | null,
): number {
  const modelLimit = getVideoImageGenerationBatchLimit(resolveEffectiveImageGenerationPrefs(input, project));
  const requestedLimit = Number(input.maxImageCount ?? input.maxImagesPerRun ?? input.batchLimit);

  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) return modelLimit;
  return Math.max(1, Math.min(modelLimit, Math.floor(requestedLimit)));
}

function inferProjectImageKind(imagePrompt: string): "character" | "scene" {
  if (
    /(?:角色|人物|人像|肖像|头像|半身像|全身像|立绘|主角|女主|男主|portrait|character|person|people|face|hero|heroine|man|woman|girl|boy)/i.test(
      imagePrompt,
    )
  ) {
    return "character";
  }

  return "scene";
}

function resolveRequestedProjectImageKind(
  input: Record<string, unknown>,
  imagePrompt: string,
): "character" | "scene" {
  return input.imageKind === "character" || input.imageKind === "scene"
    ? input.imageKind
    : inferProjectImageKind(imagePrompt);
}

function withVideoProject(
  runtime: StudioRuntimeState,
  project: PersistedVideoProject,
): StudioRuntimeState {
  return {
    ...runtime,
    currentVideoProject: project,
    currentProjectSnapshot: createVideoSnapshot(project),
  };
}

function batchSceneRange(
  scenes: Scene[],
  size: number,
): { sceneStart: number; sceneEnd: number } {
  const start = scenes[0]?.sceneNumber ?? 1;
  const end = Math.min(start + size - 1, scenes.at(-1)?.sceneNumber ?? start);
  return { sceneStart: start, sceneEnd: end };
}

function resolveEpisodeDuration(
  input: Record<string, unknown>,
  project: PersistedVideoProject,
): number | null {
  const candidate =
    typeof input.episodeDuration === "number" && Number.isFinite(input.episodeDuration)
      ? input.episodeDuration
      : typeof project.preferredEpisodeDurationSeconds === "number" &&
          Number.isFinite(project.preferredEpisodeDurationSeconds)
        ? project.preferredEpisodeDurationSeconds
        : null;

  return candidate ? Math.max(1, Math.round(candidate)) : null;
}

function deriveSegmentsPerEpisode(durationSeconds: number | null): number {
  if (!durationSeconds) return 5;
  return Math.max(1, Math.round(durationSeconds / 15));
}

function listFailedSceneIds(project: PersistedVideoProject): string[] {
  return project.scenes
    .filter((scene) => normalizeSceneStatus(scene.videoStatus) === "failed")
    .map((scene) => scene.id);
}

function listRunningSceneIds(project: PersistedVideoProject): string[] {
  return project.scenes
    .filter(
      (scene) =>
        !!scene.videoTaskId &&
        ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus)),
    )
    .map((scene) => scene.id);
}

function resolveVideoGenerationBatchSize(
  input?: Record<string, unknown> | null,
  fallbackPrefs?: PersistedVideoProject["videoGenerationPrefs"] | null,
): number {
  const requestedPrefs =
    typeof input?.videoGenerationPrefs === "object" && input.videoGenerationPrefs
      ? (input.videoGenerationPrefs as PersistedVideoProject["videoGenerationPrefs"])
      : null;
  const modelKey =
    typeof input?.selectedVideoModelKey === "string"
      ? input.selectedVideoModelKey
      : typeof input?.videoModelKey === "string"
        ? input.videoModelKey
        : null;
  const batchLimit = getHomeAgentVideoGenerationBatchLimit({
    ...(fallbackPrefs ?? {}),
    ...(requestedPrefs ?? {}),
    ...(modelKey ? { modelKey } : {}),
    ...(typeof input?.resolution === "string" ? { resolution: input.resolution } : {}),
    ...(typeof input?.mode === "string" ? { mode: input.mode } : {}),
  });
  const requestedBatchSize =
    typeof input?.batchSize === "number" && Number.isFinite(input.batchSize)
      ? Math.floor(input.batchSize)
      : batchLimit;
  return Math.max(1, Math.min(batchLimit, requestedBatchSize));
}

function listGeneratableSceneIds(
  project: PersistedVideoProject,
  limit = getHomeAgentVideoGenerationBatchLimit(project.videoGenerationPrefs),
): string[] {
  return project.scenes
    .filter((scene) => {
      const status = normalizeSceneStatus(scene.videoStatus);
      if (["queued", "processing"].includes(status)) return false;
      return !scene.videoUrl;
    })
    .slice(0, limit)
    .map((scene) => scene.id);
}

function buildVideoContinuationBatchHint(plan: VideoWorkflowContinuationPlan): string {
  const targetCount = plan.targetCount ?? 0;
  const remainingTargetCount = plan.remainingTargetCount ?? 0;
  if (!targetCount) {
    return "";
  }

  switch (plan.policy) {
    case "generate-next-batch":
    case "repair-failed":
    case "generate-next-segment-batch":
    case "repair-failed-segments":
      return remainingTargetCount > 0
        ? `当前按批次推进：本轮先处理 ${targetCount} 个目标，剩余 ${remainingTargetCount} 个可继续让 Agent 自动推进。`
        : `当前批次会直接处理这 ${targetCount} 个目标，处理完成后就会自然衔接到下一轮轮询。`;
    case "refresh-running":
    case "refresh-running-segments":
      return remainingTargetCount > 0
        ? `本轮先刷新 ${targetCount} 个进行中目标，剩余 ${remainingTargetCount} 个任务稍后也能继续自动回收。`
        : `本轮会先刷新这 ${targetCount} 个进行中目标，再根据结果决定继续补发。`;
    default:
      return "";
  }
}

function getVideoManifestItems(project: PersistedVideoProject) {
  return project.assetManifest?.items ?? [];
}

function isLocalSegmentVideoLibrarySource(url: string | undefined): boolean {
  const storedVideoPath = resolveStoredSegmentVideoPath(String(url || "").trim());
  return Boolean(storedVideoPath && isLocalMediaFilePath(storedVideoPath));
}

function findSegmentVideoAssetLibraryUrl(
  project: PersistedVideoProject,
  segmentLabel: string | undefined,
): string | undefined {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  if (!normalizedSegmentLabel) return undefined;

  const matchingManifestUrls = getVideoManifestItems(project)
    .filter((item) => {
      if (item.kind !== "video-segment") return false;
      if (!hasUsableMediaUrl(item.url)) return false;
      const sourceEntityId = String(item.sourceEntityId || "").trim();
      const assetId = String(item.id || "").trim();
      const normalizedLabel = String(item.label || "").trim();
      return (
        sourceEntityId === normalizedSegmentLabel ||
        assetId === `segment:${normalizedSegmentLabel}:video` ||
        normalizedLabel === buildSegmentVideoLabel(normalizedSegmentLabel)
      );
    })
    .map((item) => String(item.url || "").trim())
    .filter(Boolean);

  const prioritizedUrl = matchingManifestUrls.find((url) => isLocalSegmentVideoLibrarySource(url));
  return prioritizedUrl || matchingManifestUrls[0] || undefined;
}

function resolveSegmentVideoLibrarySourceUrl(
  project: PersistedVideoProject,
  segmentLabel: string | undefined,
  fallbackVideoUrl?: string,
): string | undefined {
  const normalizedSegmentLabel = String(segmentLabel || "").trim();
  const existingSegmentVideoUrl = normalizedSegmentLabel
    ? String(project.segmentVideos?.[normalizedSegmentLabel] || "").trim()
    : "";
  const manifestSegmentVideoUrl = findSegmentVideoAssetLibraryUrl(project, normalizedSegmentLabel);
  const fallbackTrimmed = String(fallbackVideoUrl || "").trim();
  const candidates = [existingSegmentVideoUrl, manifestSegmentVideoUrl, fallbackTrimmed].filter(Boolean);
  const localCandidate = candidates.find((url) => isLocalSegmentVideoLibrarySource(url));
  return localCandidate || candidates[0] || undefined;
}

function findManifestReferenceImageUrl(
  project: PersistedVideoProject,
  kind: "character-reference" | "scene-reference",
  sourceEntityId: string,
): string | undefined {
  const matchedItem = getVideoManifestItems(project).find(
    (item) =>
      item.kind === kind &&
      item.status === "ready" &&
      hasUsableMediaUrl(item.url) &&
      item.sourceEntityId === sourceEntityId &&
      item.url.trim(),
  );
  return matchedItem?.url.trim() || undefined;
}

function findCharacterPrimaryReferenceImage(
  project: PersistedVideoProject,
  character: CharacterSetting,
): string | undefined {
  if (hasUsableMediaUrl(character.imageUrl)) return character.imageUrl.trim();
  return findManifestReferenceImageUrl(project, "character-reference", character.id);
}

function findScenePrimaryReferenceImage(
  project: PersistedVideoProject,
  sceneSetting: SceneSetting,
): string | undefined {
  if (hasUsableMediaUrl(sceneSetting.imageUrl)) return sceneSetting.imageUrl.trim();
  return findManifestReferenceImageUrl(project, "scene-reference", sceneSetting.id);
}

function collectCharacterSiblingVariantReferenceImages(
  character: CharacterSetting,
  currentVariantId: string,
): Array<{ label: string; description?: string; imageUrl: string }> {
  return (character.costumes || [])
    .filter((variant) => variant.id !== currentVariantId && hasUsableMediaUrl(variant.imageUrl))
    .map((variant) => ({
      label: variant.label,
      description: variant.description,
      imageUrl: variant.imageUrl!.trim(),
    }));
}

function collectSceneSiblingVariantReferenceImages(
  sceneSetting: SceneSetting,
  currentVariantId: string,
): Array<{ label: string; description?: string; imageUrl: string }> {
  return (sceneSetting.timeVariants || [])
    .filter((variant) => variant.id !== currentVariantId && hasUsableMediaUrl(variant.imageUrl))
    .map((variant) => ({
      label: variant.label,
      description: variant.description,
      imageUrl: variant.imageUrl!.trim(),
    }));
}

function mergeUniqueReferenceQaNotes(...groups: Array<Array<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const item of group || []) {
      const trimmed = String(item || "").trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

function mergeVariantDistinctnessIntoReferenceQaReport(
  report: ReferenceImageQualityReport | null | undefined,
  distinctnessReport: ReferenceVariantDistinctnessReport,
): ReferenceImageQualityReport {
  const duplicateLabels = distinctnessReport.duplicateSiblingLabels.filter(Boolean);
  const defaultIssue =
    duplicateLabels.length > 0
      ? `与兄弟变体「${duplicateLabels.join("、")}」区分度不足，容易生成重复参考图。`
      : "与主参考图或兄弟变体区分度不足，容易生成重复参考图。";
  const mergedIssues = mergeUniqueReferenceQaNotes(
    report?.issues,
    distinctnessReport.issues.length ? distinctnessReport.issues : [defaultIssue],
  ).slice(0, 6);
  const mergedFixPriorities = mergeUniqueReferenceQaNotes(
    report?.fixPriorities,
    distinctnessReport.fixPriorities,
  ).slice(0, 4);
  const similarityPenalty = distinctnessReport.similarityTier === "duplicate" ? 58 : 72;
  const consistencyPenalty = distinctnessReport.similarityTier === "duplicate" ? 55 : 70;

  return {
    inspected: true,
    summary: [report?.summary?.trim(), distinctnessReport.summary.trim()].filter(Boolean).join("；") || defaultIssue,
    overallScore: Math.min(report?.overallScore ?? 82, similarityPenalty),
    identityScore: report?.identityScore ?? 82,
    visualScore: report?.visualScore ?? 80,
    consistencyScore: Math.min(report?.consistencyScore ?? 82, consistencyPenalty),
    styleMismatchVisible: report?.styleMismatchVisible === true,
    unintendedDuplicatePeopleVisible: report?.unintendedDuplicatePeopleVisible === true,
    textPollutionVisible: report?.textPollutionVisible === true,
    watermarkVisible: report?.watermarkVisible === true,
    deliverableReady: false,
    qualityTier: distinctnessReport.similarityTier === "duplicate" ? "fail" : "borderline",
    goldenSampleVersion: report?.goldenSampleVersion,
    strengths: report?.strengths || [],
    goldenSignals: report?.goldenSignals || [],
    fixPriorities: mergedFixPriorities,
    issues: mergedIssues,
  };
}

async function resolveVerifiedGeneratedReferenceImageUrl(
  imageUrl: string | undefined,
): Promise<string | null> {
  const trimmed = imageUrl?.trim();
  if (!hasUsableMediaUrl(trimmed)) return null;
  const exists = await doesUsableMediaAssetExist(trimmed);
  return exists ? trimmed : null;
}

async function resolveVerifiedSegmentContinuityFrameUrl(
  project: PersistedVideoProject,
  segmentLabel: string | undefined,
): Promise<string | undefined> {
  const trimmed = segmentLabel ? String(project.segmentContinuityFrames?.[segmentLabel] || "").trim() : "";
  if (!trimmed) return undefined;
  return (await resolveVerifiedGeneratedReferenceImageUrl(trimmed)) || undefined;
}

async function resolveVerifiedSegmentContinuityFrameSetUrls(
  project: PersistedVideoProject,
  segmentLabel: string | undefined,
): Promise<string[]> {
  const rawUrls = segmentLabel ? project.segmentContinuityFrameSets?.[segmentLabel] : undefined;
  if (!Array.isArray(rawUrls) || !rawUrls.length) return [];

  const verified = await Promise.all(
    rawUrls.map(async (url) => (await resolveVerifiedGeneratedReferenceImageUrl(String(url || "").trim())) || ""),
  );
  return Array.from(new Set(verified.map((url) => url.trim()).filter(Boolean))).slice(
    0,
    SEGMENT_CONTINUITY_FRAME_SET_MAX_COUNT,
  );
}

async function resolveVerifiedSegmentContinuityGridImage(
  project: PersistedVideoProject,
  segmentLabel: string | undefined,
): Promise<
  | {
      imageUrl: string;
      recapText?: string;
      frameUrls?: string[];
    }
  | undefined
> {
  const value = segmentLabel ? project.segmentContinuityGridImages?.[segmentLabel] : undefined;
  const imageUrl = (await resolveVerifiedGeneratedReferenceImageUrl(value?.imageUrl?.trim())) || "";
  if (!imageUrl) return undefined;
  const frameUrls = Array.isArray(value?.frameUrls)
    ? (
        await Promise.all(
          value.frameUrls.map(async (url) => (await resolveVerifiedGeneratedReferenceImageUrl(String(url || "").trim())) || ""),
        )
      ).filter((url) => String(url || "").trim())
    : undefined;
  const recapText = typeof value?.recapText === "string" ? value.recapText.trim() : "";
  return {
    imageUrl,
    ...(recapText ? { recapText } : {}),
    ...(frameUrls?.length ? { frameUrls } : {}),
  };
}

async function shouldClearUnavailableReferenceAssetUrl(url: string | undefined): Promise<boolean> {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  if (isKnownPlaceholderMediaUrl(trimmed) || isExpiredRemoteSignedMediaUrl(trimmed)) return true;
  if (!isLocalMediaFilePath(trimmed)) return false;
  return isMediaAssetDefinitelyMissing(trimmed);
}

async function scrubBrokenReferenceAssetUrls(
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): Promise<{ characters: CharacterSetting[]; sceneSettings: SceneSetting[]; changed: boolean }> {
  let changed = false;

  const nextCharacters = await Promise.all(
    characters.map(async (character) => {
      let nextCharacter = character;

      if (await shouldClearUnavailableReferenceAssetUrl(character.imageUrl)) {
        nextCharacter = {
          ...nextCharacter,
          imageUrl: "",
        };
        changed = true;
      }

      if (character.costumes?.length) {
        let costumesChanged = false;
        const nextCostumes = await Promise.all(
          character.costumes.map(async (costume) => {
            if (!costume.imageUrl?.trim()) return costume;
            if (!(await shouldClearUnavailableReferenceAssetUrl(costume.imageUrl))) return costume;
            costumesChanged = true;
            changed = true;
            return {
              ...costume,
              imageUrl: "",
            };
          }),
        );
        if (costumesChanged) {
          nextCharacter = {
            ...nextCharacter,
            costumes: nextCostumes,
          };
        }
      }

      return nextCharacter;
    }),
  );

  const nextSceneSettings = await Promise.all(
    sceneSettings.map(async (sceneSetting) => {
      let nextSceneSetting = sceneSetting;

      if (await shouldClearUnavailableReferenceAssetUrl(sceneSetting.imageUrl)) {
        nextSceneSetting = {
          ...nextSceneSetting,
          imageUrl: "",
        };
        changed = true;
      }

      if (sceneSetting.timeVariants?.length) {
        let variantsChanged = false;
        const nextVariants = await Promise.all(
          sceneSetting.timeVariants.map(async (variant) => {
            if (!variant.imageUrl?.trim()) return variant;
            if (!(await shouldClearUnavailableReferenceAssetUrl(variant.imageUrl))) return variant;
            variantsChanged = true;
            changed = true;
            return {
              ...variant,
              imageUrl: "",
            };
          }),
        );
        if (variantsChanged) {
          nextSceneSetting = {
            ...nextSceneSetting,
            timeVariants: nextVariants,
          };
        }
      }

      return nextSceneSetting;
    }),
  );

  return { characters: nextCharacters, sceneSettings: nextSceneSettings, changed };
}

function hasExtractedVideoEntities(project: PersistedVideoProject): boolean {
  return project.characters.length > 0 && project.sceneSettings.length > 0;
}

function countMissingReferenceAssets(project: PersistedVideoProject): number {
  const items = getVideoManifestItems(project);
  const readyCharacterIds = new Set(
    items
      .filter((item) => item.kind === "character-reference" && hasUsableMediaUrl(item.url) && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );
  const readySceneIds = new Set(
    items
      .filter((item) => item.kind === "scene-reference" && hasUsableMediaUrl(item.url) && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );

  return (
    project.characters.filter((character) => !readyCharacterIds.has(character.id) && !hasUsableMediaUrl(character.imageUrl)).length +
    project.sceneSettings.filter((scene) => !readySceneIds.has(scene.id) && !hasUsableMediaUrl(scene.imageUrl)).length
  );
}

function hasMinimumReferenceAssets(project: PersistedVideoProject): boolean {
  if (!hasExtractedVideoEntities(project)) return false;

  const items = getVideoManifestItems(project);
  const readyCharacterCount = items.filter(
    (item) => item.kind === "character-reference" && hasUsableMediaUrl(item.url) && item.sourceEntityId,
  ).length;
  const readySceneCount = items.filter(
    (item) => item.kind === "scene-reference" && hasUsableMediaUrl(item.url) && item.sourceEntityId,
  ).length;

  const characterRequirementMet =
    project.characters.length === 0 || readyCharacterCount > 0;
  const sceneRequirementMet =
    project.sceneSettings.length === 0 || readySceneCount > 0;

  return characterRequirementMet && sceneRequirementMet;
}

function getReferenceTargetState(
  project: PersistedVideoProject,
  targetId: string,
) {
  return project.automationState?.referenceTargets?.[targetId];
}

function withReferenceTargetState(
  project: PersistedVideoProject,
  targetId: string,
  updater: (
    currentState: NonNullable<VideoAutomationState["referenceTargets"]>[string] | undefined,
  ) => NonNullable<VideoAutomationState["referenceTargets"]>[string],
): PersistedVideoProject {
  const automationState = {
    ...DEFAULT_VIDEO_AUTOMATION_TEMPLATE,
    ...(project.automationState || {}),
    segments: {
      ...DEFAULT_VIDEO_AUTOMATION_TEMPLATE.segments,
      ...(project.automationState?.segments || {}),
    },
    referenceTargets: {
      ...DEFAULT_VIDEO_AUTOMATION_TEMPLATE.referenceTargets,
      ...(project.automationState?.referenceTargets || {}),
    },
  };
  return {
    ...project,
    automationState: {
      ...automationState,
      referenceTargets: {
        ...automationState.referenceTargets,
        [targetId]: updater(automationState.referenceTargets[targetId]),
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

function buildReferenceTargetReviewItem(
  project: PersistedVideoProject,
  targetId: string,
  reason: string,
  status: string,
  timestamp: string,
): NonNullable<PersistedVideoProject["reviewQueue"]>[number] {
  const targetState = getReferenceTargetState(project, targetId);
  const fallbackTitle = targetId.replace(/^reference-/, "").replace(/:/g, " / ");
  const character = targetState?.entityId
    ? project.characters.find((item) => item.id === targetState.entityId)
    : undefined;
  const sceneSetting = targetState?.entityId
    ? project.sceneSettings.find((item) => item.id === targetState.entityId)
    : undefined;
  const variantLabel =
    targetState?.variantId && character
      ? character.costumes?.find((item) => item.id === targetState.variantId)?.label
      : targetState?.variantId && sceneSetting
        ? sceneSetting.timeVariants?.find((item) => item.id === targetState.variantId)?.label
        : undefined;
  const title = targetState?.targetType === "character-primary"
    ? `角色参考图 · ${character?.name || fallbackTitle}`
    : targetState?.targetType === "character-variant"
      ? `角色变体参考图 · ${character?.name || fallbackTitle}${variantLabel ? ` · ${variantLabel}` : ""}`
      : targetState?.targetType === "scene-primary"
        ? `场景参考图 · ${sceneSetting?.name || fallbackTitle}`
        : `场景变体参考图 · ${sceneSetting?.name || fallbackTitle}${variantLabel ? ` · ${variantLabel}` : ""}`;
  return {
    id: `review:${targetId}`,
    title,
    summary: reason,
    targetIds: [targetId],
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function upsertReferenceTargetReviewItem(
  project: PersistedVideoProject,
  targetId: string,
  reason: string,
  status: string,
  timestamp: string,
): PersistedVideoProject {
  const nextReviewQueue = [...(project.reviewQueue || [])];
  const reviewId = `review:${targetId}`;
  const reviewIndex = nextReviewQueue.findIndex((item) => item.id === reviewId);
  const nextItem = buildReferenceTargetReviewItem(project, targetId, reason, status, timestamp);
  if (reviewIndex >= 0) {
    nextReviewQueue[reviewIndex] = {
      ...nextReviewQueue[reviewIndex],
      ...nextItem,
      createdAt: nextReviewQueue[reviewIndex]?.createdAt || nextItem.createdAt,
    };
  } else {
    nextReviewQueue.push(nextItem);
  }
  return {
    ...project,
    reviewQueue: nextReviewQueue,
  };
}

function dismissReferenceTargetReviewItems(
  project: PersistedVideoProject,
  targetIds: string[],
  status: string,
  summary: string,
): PersistedVideoProject {
  if (!targetIds.length || !(project.reviewQueue?.length)) return project;
  const targetSet = new Set(targetIds);
  const timestamp = new Date().toISOString();
  return {
    ...project,
    reviewQueue: project.reviewQueue.map((item) =>
      item.targetIds.some((targetId) => targetSet.has(targetId))
        ? { ...item, status, summary, updatedAt: timestamp }
        : item,
    ),
  };
}

function listPendingReferenceAssetTargetIds(project: PersistedVideoProject): string[] {
  const targetIds: string[] = [];

  for (const character of project.characters) {
    const primaryTargetId = `reference-character:${character.id}`;
    const primaryState = getReferenceTargetState(project, primaryTargetId);
    if (!findCharacterPrimaryReferenceImage(project, character) && primaryState?.status !== "exhausted") {
      targetIds.push(`reference-character:${character.id}`);
    }
    for (const costume of character.costumes ?? []) {
      const targetId = `reference-character-variant:${character.id}:${costume.id}`;
      const targetState = getReferenceTargetState(project, targetId);
      if (
        !hasUsableMediaUrl(costume.imageUrl) &&
        targetState?.status !== "blocked" &&
        targetState?.status !== "exhausted"
      ) {
        targetIds.push(targetId);
      }
    }
  }

  for (const sceneSetting of project.sceneSettings) {
    const primaryTargetId = `reference-scene:${sceneSetting.id}`;
    const primaryState = getReferenceTargetState(project, primaryTargetId);
    if (!findScenePrimaryReferenceImage(project, sceneSetting) && primaryState?.status !== "exhausted") {
      targetIds.push(primaryTargetId);
    }
    for (const variant of sceneSetting.timeVariants ?? []) {
      const targetId = `reference-scene-variant:${sceneSetting.id}:${variant.id}`;
      const targetState = getReferenceTargetState(project, targetId);
      if (
        !hasUsableMediaUrl(variant.imageUrl) &&
        targetState?.status !== "blocked" &&
        targetState?.status !== "exhausted"
      ) {
        targetIds.push(targetId);
      }
    }
  }

  return targetIds;
}

function listExhaustedReferenceAssetTargetIds(project: PersistedVideoProject): string[] {
  return Object.entries(project.automationState?.referenceTargets || {})
    .filter(([, state]) => state.status === "exhausted")
    .map(([targetId]) => targetId);
}

function clearReferenceTargetAsset(
  project: PersistedVideoProject,
  targetId: string,
): PersistedVideoProject {
  if (targetId.startsWith("reference-character:")) {
    const characterId = targetId.slice("reference-character:".length).trim();
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? { ...character, imageUrl: "" }
          : character
      ),
    };
  }
  if (targetId.startsWith("reference-character-variant:")) {
    const [, characterId, variantId] = targetId.split(":");
    return {
      ...project,
      characters: project.characters.map((character) =>
        character.id === characterId
          ? {
              ...character,
              costumes: character.costumes?.map((costume) =>
                costume.id === variantId
                  ? { ...costume, imageUrl: undefined }
                  : costume
              ),
            }
          : character
      ),
    };
  }
  if (targetId.startsWith("reference-scene:")) {
    const sceneSettingId = targetId.slice("reference-scene:".length).trim();
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneSettingId
          ? { ...sceneSetting, imageUrl: "" }
          : sceneSetting
      ),
    };
  }
  if (targetId.startsWith("reference-scene-variant:")) {
    const [, sceneSettingId, variantId] = targetId.split(":");
    return {
      ...project,
      sceneSettings: project.sceneSettings.map((sceneSetting) =>
        sceneSetting.id === sceneSettingId
          ? {
              ...sceneSetting,
              timeVariants: sceneSetting.timeVariants?.map((variant) =>
                variant.id === variantId
                  ? { ...variant, imageUrl: undefined }
                  : variant
              ),
            }
          : sceneSetting
      ),
    };
  }
  return project;
}

function hasStoryboardText(project: PersistedVideoProject): boolean {
  return Boolean(project.storyboardPlan?.trim());
}

function countMissingStoryboardFrames(project: PersistedVideoProject): number {
  const readyStoryboardSceneIds = new Set(
    getVideoManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.sceneId)
      .map((item) => item.sceneId!),
  );

  return project.scenes.filter((scene) => !readyStoryboardSceneIds.has(scene.id)).length;
}

function countReadyStoryboardFrames(project: PersistedVideoProject): number {
  return Math.max(project.scenes.length - countMissingStoryboardFrames(project), 0);
}

function hasMinimumStoryboardFrames(project: PersistedVideoProject): boolean {
  return project.scenes.length > 0 && countMissingStoryboardFrames(project) === 0;
}

function hasReviewableVideoOutputs(project: PersistedVideoProject): boolean {
  return Boolean(
    project.productionStateBundle?.directoryPath ||
      (project.reviewQueue?.length ?? 0) > 0 ||
      Object.keys(project.segmentVideos ?? {}).length > 0 ||
      Object.values(project.segmentVideoStatuses ?? {}).some(
        (status) => normalizeSceneStatus(status.status) === "failed",
      ) ||
      project.scenes.some(
        (scene) => !!scene.videoUrl || String(scene.videoStatus || "").toLowerCase() === "failed",
      ),
  );
}

function hasVideoBootstrapContext(project: PersistedVideoProject): boolean {
  return Boolean(
    project.targetPlatform?.trim() &&
      project.shotStyle?.trim() &&
      project.outputGoal?.trim(),
  );
}

function deriveVisibleVideoStep(project: PersistedVideoProject): number {
  return deriveNaturalVideoStep(project);
}

function assertReferenceAssetsReady(project: PersistedVideoProject): void {
  if (!hasExtractedVideoEntities(project)) {
    throw new Error("当前还没有完成角色与场景提取，先整理实体信息再继续生成分镜。");
  }

  if (!hasMinimumReferenceAssets(project)) {
    throw new Error("当前至少需要 1 个角色主参考图和 1 个场景主参考图，满足分镜下限后再继续。");
  }
}

function assertStoryboardAssetsReady(project: PersistedVideoProject, mode?: string): void {
  // 文生视频模式或没有分镜图时，跳过分镜检查（自动降级为文生视频）
  if (mode === "text-to-video") return;
  if (!hasStoryboardText(project) && !hasMinimumStoryboardFrames(project)) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续推进视频生成。");
  }

  const missingStoryboardCount = countMissingStoryboardFrames(project);
  if (missingStoryboardCount > 0) {
    throw new Error(`当前还有 ${missingStoryboardCount} 个镜头缺少分镜图，补齐后再进入视频生成会更稳。`);
  }
}

function assertStoryboardCompileReady(project: PersistedVideoProject, mode?: string): void {
  // 文生视频模式或没有分镜图时，跳过分镜检查（自动降级为文生视频）
  if (mode === "text-to-video") return;
  if (!hasStoryboardText(project) && countReadyStoryboardFrames(project) <= 0) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续编译镜头指令包。");
  }

  if (countReadyStoryboardFrames(project) <= 0) {
    throw new Error("当前还没有可用的分镜图，至少生成 1 张分镜图后再编译镜头指令包。");
  }
}

function listSceneEpisodeNumbers(scenes: Scene[]): number[] {
  const episodeNumbers = new Set<number>();
  for (const scene of scenes) {
    const match = String(scene.segmentLabel || "").trim().match(/^(\d+)-/);
    if (!match) continue;
    const episodeNumber = Number(match[1]);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

function compareSceneOrder(left: Pick<Scene, "sceneNumber">, right: Pick<Scene, "sceneNumber">): number {
  return left.sceneNumber - right.sceneNumber;
}

function listGeneratableSegmentVideoLabelsForBatch(
  project: PersistedVideoProject,
): string[] {
  if (!project.scenes.length) return [];

  const segmentPrompts = project.segmentVideoPrompts ?? {};
  const segmentVideos = project.segmentVideos ?? {};
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  const labels: string[] = [];

  [...project.scenes]
    .sort(compareSceneOrder)
    .forEach((scene) => {
      const label = scene.segmentLabel?.trim();
      if (!label) return;
      if (!segmentPrompts[label]?.prompt?.trim()) return;
      const latestRepairTask = getLatestSegmentRepairTask(project, label);
      if (
        segmentVideos[label] &&
        (!latestRepairTask || latestRepairTask.status === "completed" || latestRepairTask.status === "exhausted")
      ) {
        return;
      }
      const status = normalizeSceneStatus(segmentStatuses[label]?.status);
      if (status === "queued" || status === "processing") return;
      if (latestRepairTask?.status === "exhausted") return;
      if (!labels.includes(label)) labels.push(label);
    });

  return labels;
}

function listFailedSegmentVideoLabelsForBatch(
  project: PersistedVideoProject,
): string[] {
  const generatableLabels = listGeneratableSegmentVideoLabelsForBatch(project);
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  return generatableLabels.filter(
    (label) =>
      normalizeSceneStatus(segmentStatuses[label]?.status) === "failed" ||
      Boolean(getLatestSegmentRepairTask(project, label)?.status === "pending"),
  );
}

function ensureVideoAutomationState(project: PersistedVideoProject): VideoAutomationState {
  return {
    ...DEFAULT_VIDEO_AUTOMATION_TEMPLATE,
    ...(project.automationState || {}),
    segments: {
      ...DEFAULT_VIDEO_AUTOMATION_TEMPLATE.segments,
      ...(project.automationState?.segments || {}),
    },
    updatedAt: project.automationState?.updatedAt || new Date().toISOString(),
  };
}

function getLatestSegmentRepairTask(
  project: PersistedVideoProject,
  segmentLabel: string,
): VideoRepairTask | undefined {
  return [...(project.videoRepairTasks || [])]
    .filter((task) => task.targetType === "segment" && task.segmentLabel === segmentLabel)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function getPendingSegmentRepairTasks(project: PersistedVideoProject): VideoRepairTask[] {
  return [...(project.videoRepairTasks || [])]
    .filter((task) => task.targetType === "segment" && task.status === "pending")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function getEscalatedSegmentRepairTasks(project: PersistedVideoProject): VideoRepairTask[] {
  return [...(project.videoRepairTasks || [])]
    .filter(
      (task) =>
        task.targetType === "segment" &&
        (task.status === "exhausted" || task.route === "escalate"),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function withVideoAutomationSegmentState(
  project: PersistedVideoProject,
  segmentLabel: string,
  update: (state: NonNullable<VideoAutomationState["segments"][string]>) => NonNullable<VideoAutomationState["segments"][string]>,
): PersistedVideoProject {
  const automationState = ensureVideoAutomationState(project);
  const currentSegmentState = automationState.segments[segmentLabel] || {
    totalPasses: 0,
    localRepairCount: 0,
    regenerateCount: 0,
  };
  return {
    ...project,
    automationState: {
      ...automationState,
      segments: {
        ...automationState.segments,
        [segmentLabel]: update(currentSegmentState),
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

function upsertVideoAuditPacket(
  project: PersistedVideoProject,
  auditPacket: VideoAuditPacket,
): PersistedVideoProject {
  const nextAuditPackets = [...(project.videoAuditPackets || [])];
  const existingIndex = nextAuditPackets.findIndex((item) => item.id === auditPacket.id);
  if (existingIndex >= 0) {
    nextAuditPackets[existingIndex] = auditPacket;
  } else {
    nextAuditPackets.push(auditPacket);
  }
  return {
    ...project,
    videoAuditPackets: nextAuditPackets,
  };
}

function upsertVideoRepairTask(
  project: PersistedVideoProject,
  repairTask: VideoRepairTask,
): PersistedVideoProject {
  const nextRepairTasks = [...(project.videoRepairTasks || [])];
  const existingIndex = nextRepairTasks.findIndex((item) => item.id === repairTask.id);
  if (existingIndex >= 0) {
    nextRepairTasks[existingIndex] = repairTask;
  } else {
    nextRepairTasks.push(repairTask);
  }
  return {
    ...project,
    videoRepairTasks: nextRepairTasks,
  };
}

function removeSegmentVideoOutput(
  project: PersistedVideoProject,
  segmentLabel: string,
): PersistedVideoProject {
  const nextSegmentVideos = { ...(project.segmentVideos || {}) };
  delete nextSegmentVideos[segmentLabel];
  const nextContinuityFrames = { ...(project.segmentContinuityFrames || {}) };
  delete nextContinuityFrames[segmentLabel];
  const nextContinuityFrameSets = { ...(project.segmentContinuityFrameSets || {}) };
  delete nextContinuityFrameSets[segmentLabel];
  const nextContinuityGridImages = { ...(project.segmentContinuityGridImages || {}) };
  delete nextContinuityGridImages[segmentLabel];
  return {
    ...project,
    segmentVideos: nextSegmentVideos,
    segmentContinuityFrames: nextContinuityFrames,
    segmentContinuityFrameSets: nextContinuityFrameSets,
    segmentContinuityGridImages: nextContinuityGridImages,
  };
}

const ARCHIVED_SEGMENT_VIDEO_CANDIDATE_LIMIT = 12;

function summarizeArchivedSegmentVideoFailureReason(
  route: VideoRepairTask["route"],
  auditPacket: VideoAuditPacket,
): string {
  const routeLabel =
    route === "local_repair"
      ? "自动 QA 触发局部修复"
      : route === "regenerate"
        ? "自动 QA 要求整段重生"
        : "自动 QA 拦截并转入人工复核";
  const snippets: string[] = [];
  const seen = new Set<string>();
  const pushSnippet = (value: string | undefined) => {
    const text = String(value || "").replace(/^视觉质检摘要[:：]\s*/i, "").trim();
    if (!text) return;
    const key = normalizeQaConstraintText(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    snippets.push(text);
  };
  pushSnippet(auditPacket.visualInspection?.summary);
  auditPacket.issues.forEach((issue) => pushSnippet(issue));
  const excerpt = snippets.slice(0, 2).join("；");
  return excerpt ? `${routeLabel}：${excerpt}` : routeLabel;
}

function buildArchivedSegmentVideoQaSummary(auditPacket: VideoAuditPacket): string | undefined {
  const summaryParts = [
    auditPacket.visualInspection?.summary,
    ...auditPacket.issues.slice(0, 4),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!summaryParts.length) return undefined;
  return Array.from(new Set(summaryParts)).join("；");
}

function archiveRejectedSegmentVideoCandidate(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  videoUrl: string;
  route: VideoRepairTask["route"];
  auditPacket: VideoAuditPacket;
  provider?: string;
  taskId?: string;
  submittedPrompt?: string;
  referenceImageUrls?: string[];
  usedContinuityFrame?: boolean;
  usedRelayVideo?: boolean;
}): {
  project: PersistedVideoProject;
  entry: ArchivedSegmentVideoCandidate;
} {
  const normalizedSegmentLabel = params.segmentLabel.trim();
  const archivedAt = new Date().toISOString();
  const entry: ArchivedSegmentVideoCandidate = {
    id: `archived-segment-video:${normalizedSegmentLabel}:${crypto.randomUUID()}`,
    segmentLabel: normalizedSegmentLabel,
    videoUrl: params.videoUrl,
    failureReason: summarizeArchivedSegmentVideoFailureReason(params.route, params.auditPacket),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.submittedPrompt ? { submittedPrompt: params.submittedPrompt } : {}),
    ...(params.referenceImageUrls?.length ? { referenceImageUrls: params.referenceImageUrls } : {}),
    ...(typeof params.usedContinuityFrame === "boolean"
      ? { usedContinuityFrame: params.usedContinuityFrame }
      : {}),
    ...(typeof params.usedRelayVideo === "boolean"
      ? { usedRelayVideo: params.usedRelayVideo }
      : {}),
    route: params.route,
    auditId: params.auditPacket.id,
    ...(buildArchivedSegmentVideoQaSummary(params.auditPacket)
      ? { qaSummary: buildArchivedSegmentVideoQaSummary(params.auditPacket) }
      : {}),
    ...(params.auditPacket.issues.length ? { issues: params.auditPacket.issues } : {}),
    ...(params.auditPacket.visualInspection?.qualityTier
      ? { qualityTier: params.auditPacket.visualInspection.qualityTier }
      : {}),
    archivedAt,
  };
  const nextEntries = [
    entry,
    ...((params.project.archivedSegmentVideos?.[normalizedSegmentLabel] ?? []).filter(
      (candidate) => String(candidate.videoUrl || "").trim() !== params.videoUrl,
    )),
  ].slice(0, ARCHIVED_SEGMENT_VIDEO_CANDIDATE_LIMIT);
  return {
    project: {
      ...params.project,
      archivedSegmentVideos: {
        ...(params.project.archivedSegmentVideos ?? {}),
        [normalizedSegmentLabel]: nextEntries,
      },
    },
    entry,
  };
}

function appendSegmentRepairGuidance(prompt: string, issues: string[], route: VideoRepairTask["route"]): string {
  const guidance = issues.length
    ? issues.slice(0, 4).join("；")
    : route === "regenerate"
      ? "重建本段的起始衔接、角色身份和镜头接力。"
      : "强化本段的衔接、身份和剧情可读性。";
  const suffix = route === "regenerate"
    ? `\n\n修复重点：重编本段镜头衔接与视觉锚点，确保动作链、视线方向、服装与道具状态完全连续。${guidance}`
    : `\n\n修复重点：保留现有 continuity frame / keyframe references，只局部强化开场承接、动作接力、角色身份与剧情清晰度。${guidance}`;
  return `${prompt.trim()}${suffix}`;
}

function scoreAuditDimension(score: number, threshold: number, reason: string) {
  return {
    score,
    passed: score >= threshold,
    reason,
  };
}

function isSubtitleOnlyVisualIssue(issue: string): boolean {
  return /(字幕|上屏文字|subtitle|subtitles|on-screen text)/i.test(issue);
}

function getFilteredVisualQaIssues(
  report: SegmentVideoVisualQualityReport | null | undefined,
): string[] {
  if (!report?.issues?.length) return [];
  return report.issues.filter((issue) => !isSubtitleOnlyVisualIssue(issue));
}

function shouldRejectVisualDeliverable(
  report: SegmentVideoVisualQualityReport | null | undefined,
): boolean {
  if (!report?.inspected || report.deliverableReady) return false;
  if (report.watermarkVisible) return true;
  return getFilteredVisualQaIssues(report).length > 0;
}

function normalizeQaConstraintText(value: string | undefined): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[【】\[\]（）(){}<>《》〈〉「」『』"'`~:：,，.。;；!！?？|\\/]/g, "");
}

function splitQaConstraintFragments(value: string | undefined, limit = 4): string[] {
  return String(value || "")
    .split(/[\n,，、;；。]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 36)
    .slice(0, limit);
}

function promptIncludesConstraint(prompt: string, candidate: string | undefined): boolean {
  const normalizedPrompt = normalizeQaConstraintText(prompt);
  const normalizedCandidate = normalizeQaConstraintText(candidate);
  if (!normalizedPrompt || !normalizedCandidate) return false;
  return normalizedPrompt.includes(normalizedCandidate);
}

function calculateCoveragePercent(matches: number, checks: number, fallback: number): number {
  if (checks <= 0) return fallback;
  return Math.round((matches / checks) * 100);
}

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function collectSegmentShotPackets(
  project: PersistedVideoProject,
  sceneIds: string[],
): VideoShotPacket[] {
  if (!sceneIds.length) return [];
  const sceneIdSet = new Set(sceneIds.map((sceneId) => sceneId.trim()).filter(Boolean));
  return (project.shotPackets || deriveVideoShotPackets(project)).filter((packet) => sceneIdSet.has(packet.sceneId));
}

function buildSegmentSymbolicAudit(params: {
  project: PersistedVideoProject;
  segmentScenes: Scene[];
  segmentShotPackets: VideoShotPacket[];
  submittedPrompt: string;
  segmentStartContinuityText: string;
  hasReferenceImages: boolean;
  hasPreviousSegment: boolean;
}) {
  const blockingIssues: string[] = [];
  const advisoryIssues: string[] = [];
  const matchedSignals: string[] = [];

  let identityChecks = 0;
  let identityMatches = 0;
  let continuityChecks = 0;
  let continuityMatches = 0;
  let semanticChecks = 0;
  let semanticMatches = 0;

  const characterNames = dedupeStrings(
    params.segmentScenes.flatMap((scene) => (scene.characters || []).map((name) => String(name || "").trim())),
  );
  const requiredEntities = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => packet.requiredEntities || []).map((value) => value.trim()),
  );
  const requiredProps = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => packet.requiredProps || []).map((value) => value.trim()),
  );
  const startStateFragments = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => splitQaConstraintFragments(packet.startState, 3)),
  );
  const endStateFragments = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => splitQaConstraintFragments(packet.endState, 2)),
  );
  const continuityFragments = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => [
      ...splitQaConstraintFragments(packet.previousAnchor, 2),
      ...splitQaConstraintFragments(packet.nextAnchor, 2),
    ]),
  );
  const derivedConstraintFragments = dedupeStrings(
    params.segmentShotPackets.flatMap((packet) => (packet.derivedConstraints || []).flatMap((item) => splitQaConstraintFragments(item, 2))),
  );

  for (const name of dedupeStrings([...characterNames, ...requiredEntities])) {
    identityChecks += 1;
    if (promptIncludesConstraint(params.submittedPrompt, name) || params.hasReferenceImages) {
      identityMatches += 1;
      if (!promptIncludesConstraint(params.submittedPrompt, name)) {
        advisoryIssues.push(`提交 prompt 未明确锁定关键角色/实体：${name}。`);
      }
    } else {
      advisoryIssues.push(`提交 prompt 未明确锁定关键角色/实体：${name}。`);
    }
  }

  for (const prop of requiredProps.slice(0, 4)) {
    identityChecks += 1;
    if (promptIncludesConstraint(params.submittedPrompt, prop) || params.hasReferenceImages) {
      identityMatches += 1;
      if (!promptIncludesConstraint(params.submittedPrompt, prop)) {
        advisoryIssues.push(`提交 prompt 未明确保留关键道具：${prop}。`);
      }
    } else {
      advisoryIssues.push(`提交 prompt 未明确保留关键道具：${prop}。`);
    }
  }

  for (const fragment of continuityFragments.slice(0, 4)) {
    continuityChecks += 1;
    if (
      promptIncludesConstraint(params.submittedPrompt, fragment) ||
      promptIncludesConstraint(params.segmentStartContinuityText, fragment)
    ) {
      continuityMatches += 1;
    } else {
      advisoryIssues.push(`提交 prompt 对前后镜头衔接锚点覆盖不足：${fragment}。`);
    }
  }

  for (const fragment of startStateFragments.slice(0, 3)) {
    continuityChecks += 1;
    if (
      promptIncludesConstraint(params.submittedPrompt, fragment) ||
      promptIncludesConstraint(params.segmentStartContinuityText, fragment)
    ) {
      continuityMatches += 1;
    } else {
      advisoryIssues.push(`提交 prompt 未明确承接片段开场状态：${fragment}。`);
    }
  }

  for (const fragment of endStateFragments.slice(0, 2)) {
    semanticChecks += 1;
    if (promptIncludesConstraint(params.submittedPrompt, fragment)) {
      semanticMatches += 1;
    } else {
      advisoryIssues.push(`提交 prompt 未明确落到目标结尾状态：${fragment}。`);
    }
  }

  for (const fragment of derivedConstraintFragments.slice(0, 3)) {
    semanticChecks += 1;
    if (promptIncludesConstraint(params.submittedPrompt, fragment)) {
      semanticMatches += 1;
    } else {
      advisoryIssues.push(`提交 prompt 未覆盖关键叙事/连续性约束：${fragment}。`);
    }
  }

  if (params.hasReferenceImages) {
    matchedSignals.push("参考图锚点已附带，身份锁定基础存在。");
  } else {
    advisoryIssues.push("参考资产为空，身份与连续性约束偏弱。");
  }

  if (params.hasPreviousSegment) {
    continuityChecks += 1;
    if (params.segmentStartContinuityText.trim()) {
      continuityMatches += 1;
      matchedSignals.push("存在显式的片段开场衔接锁定。");
    } else {
      advisoryIssues.push("非首片段缺少明确的起始衔接锁定。");
    }
  }

  if (/分镜\d+/.test(params.submittedPrompt)) {
    semanticChecks += 1;
    semanticMatches += 1;
    matchedSignals.push("提交 prompt 保留了分镜级叙事结构。");
  } else {
    advisoryIssues.push("最终提交 prompt 缺少明确的分镜分段。");
  }

  if (/结尾钩子/.test(params.submittedPrompt)) {
    semanticChecks += 1;
    semanticMatches += 1;
    matchedSignals.push("提交 prompt 保留了结尾 handoff。");
  } else {
    advisoryIssues.push("最终提交 prompt 缺少结尾钩子。");
  }

  if (/环境细节/.test(params.submittedPrompt)) {
    matchedSignals.push("提交 prompt 保留了环境细节约束。");
  } else {
    advisoryIssues.push("最终提交 prompt 缺少环境细节。");
  }

  return {
    blockingIssues: dedupeStrings(blockingIssues),
    advisoryIssues: dedupeStrings(advisoryIssues),
    matchedSignals: dedupeStrings(matchedSignals),
    identityCoverage: calculateCoveragePercent(identityMatches, identityChecks, params.hasReferenceImages ? 86 : 72),
    continuityCoverage: calculateCoveragePercent(
      continuityMatches,
      continuityChecks,
      params.hasPreviousSegment ? 78 : 90,
    ),
    semanticCoverage: calculateCoveragePercent(semanticMatches, semanticChecks, 84),
  };
}

function buildSegmentAuditPacket(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  sceneIds: string[];
  submittedPrompt: string;
  referenceImageUrls: string[];
  usedContinuityFrame: boolean;
  usedRelayVideo: boolean;
  symbolicPassed: boolean;
  issues: string[];
  continuityScore: number;
  identityScore: number;
  semanticScore: number;
  visualScore: number;
  visualQualityReport?: SegmentVideoVisualQualityReport | null;
  provider?: string;
}): VideoAuditPacket {
  const visualDeliverablePassed =
    !shouldRejectVisualDeliverable(params.visualQualityReport);
  const continuity = scoreAuditDimension(
    params.continuityScore,
    SEGMENT_AUDIT_SCORE_THRESHOLDS.continuity,
    params.usedContinuityFrame || params.usedRelayVideo
      ? "Continuity references were attached to carry motion, composition, and frame-to-frame flow."
      : "Continuity relies on prompt-only sequencing and may drift.",
  );
  const identity = scoreAuditDimension(
    params.identityScore,
    SEGMENT_AUDIT_SCORE_THRESHOLDS.identity,
    params.referenceImageUrls.length > 0
      ? "Reference bundle contains identity anchors."
      : "No stable identity reference bundle was attached.",
  );
  const semantic = scoreAuditDimension(
    params.semanticScore,
    SEGMENT_AUDIT_SCORE_THRESHOLDS.semantic,
    /分镜\d+/.test(params.submittedPrompt) && /结尾钩子/.test(params.submittedPrompt)
      ? "Prompt preserves storyboard flow and ending handoff."
      : "Prompt structure is too loose to guarantee readable story flow.",
  );
  const visual = scoreAuditDimension(
    params.visualScore,
    SEGMENT_AUDIT_SCORE_THRESHOLDS.visual,
    /环境细节/.test(params.submittedPrompt)
      ? "Prompt includes environment motion and visual atmosphere cues."
      : "Prompt lacks enough visual/environment guidance.",
  );
  const totalScore = Math.round((continuity.score + identity.score + semantic.score + visual.score) / 4);
  const status: VideoAuditPacket["status"] =
    !params.symbolicPassed
      ? "regenerate"
      : totalScore >= SEGMENT_AUDIT_SCORE_THRESHOLDS.total &&
          visualDeliverablePassed &&
          continuity.passed &&
          identity.passed &&
          semantic.passed &&
          visual.passed
        ? "pass"
        : totalScore < 75 || continuity.score < 75 || identity.score < 75
          ? "regenerate"
          : "local_repair";
  return {
    id: `audit:segment:${params.segmentLabel}:${new Date().toISOString()}`,
    targetType: "segment",
    targetId: `segment:${params.segmentLabel}`,
    segmentLabel: params.segmentLabel,
    sceneIds: params.sceneIds,
    provider: params.provider,
    submittedPrompt: params.submittedPrompt,
    referenceImageUrls: params.referenceImageUrls,
    usedContinuityFrame: params.usedContinuityFrame,
    usedRelayVideo: params.usedRelayVideo,
    symbolicPassed: params.symbolicPassed,
    totalScore,
    status,
    scores: {
      continuity,
      identity,
      semantic,
      visual,
    },
    visualInspection: params.visualQualityReport
      ? {
          inspected: params.visualQualityReport.inspected,
          frameCount: params.visualQualityReport.frameCount,
          summary: params.visualQualityReport.summary,
          subtitleVisible: params.visualQualityReport.subtitleVisible,
          watermarkVisible: params.visualQualityReport.watermarkVisible,
          deliverableReady: params.visualQualityReport.deliverableReady,
          qualityTier: params.visualQualityReport.qualityTier,
          goldenSampleVersion: params.visualQualityReport.goldenSampleVersion,
          strengths: params.visualQualityReport.strengths,
          goldenSignals: params.visualQualityReport.goldenSignals,
          fixPriorities: params.visualQualityReport.fixPriorities,
          issues: params.visualQualityReport.issues,
        }
      : undefined,
    issues: params.issues,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function decideSegmentRepairRoute(
  project: PersistedVideoProject,
  segmentLabel: string,
  auditPacket: VideoAuditPacket,
): VideoRepairTask["route"] {
  const automationState = ensureVideoAutomationState(project);
  const segmentState = automationState.segments[segmentLabel] || {
    totalPasses: 0,
    localRepairCount: 0,
    regenerateCount: 0,
  };
  if (auditPacket.status === "pass") return "pass";
  if (!auditPacket.symbolicPassed) {
    if (
      segmentState.regenerateCount < automationState.regenerateBudget &&
      segmentState.totalPasses < automationState.segmentPassBudget
    ) {
      return "regenerate";
    }
    return "escalate";
  }
  if (
    auditPacket.status === "local_repair" &&
    segmentState.localRepairCount < automationState.localRepairBudget &&
    segmentState.totalPasses < automationState.segmentPassBudget
  ) {
    return "local_repair";
  }
  if (
    segmentState.regenerateCount < automationState.regenerateBudget &&
    segmentState.totalPasses < automationState.segmentPassBudget
  ) {
    return "regenerate";
  }
  return "escalate";
}

function upsertSegmentReviewQueueItem(
  project: PersistedVideoProject,
  segmentLabel: string,
  summary: string,
): PersistedVideoProject {
  const reviewId = `review:segment:${segmentLabel}`;
  const nextReviewQueue = [...(project.reviewQueue || [])];
  const nextItem = {
    id: reviewId,
    title: buildSegmentVideoLabel(segmentLabel),
    summary,
    targetIds: [`segment:${segmentLabel}`],
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const existingIndex = nextReviewQueue.findIndex((item) => item.id === reviewId);
  if (existingIndex >= 0) {
    nextReviewQueue[existingIndex] = {
      ...nextReviewQueue[existingIndex],
      ...nextItem,
      createdAt: nextReviewQueue[existingIndex].createdAt,
    };
  } else {
    nextReviewQueue.push(nextItem);
  }
  return {
    ...project,
    reviewQueue: nextReviewQueue,
  };
}

function applySegmentAutomationAuditDecision(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  auditPacket: VideoAuditPacket;
  taskId?: string;
}): {
  project: PersistedVideoProject;
  route: VideoRepairTask["route"];
  archivedCandidate?: ArchivedSegmentVideoCandidate;
} {
  const route = decideSegmentRepairRoute(params.project, params.segmentLabel, params.auditPacket);
  const now = new Date().toISOString();
  const finalAuditPacket: VideoAuditPacket = {
    ...params.auditPacket,
    status: route,
    updatedAt: now,
  };
  let nextProject = upsertVideoAuditPacket(params.project, finalAuditPacket);
  nextProject = withVideoAutomationSegmentState(nextProject, params.segmentLabel, (state) => ({
    ...state,
    totalPasses: state.totalPasses + 1,
    localRepairCount: state.localRepairCount + (route === "local_repair" ? 1 : 0),
    regenerateCount: state.regenerateCount + (route === "regenerate" ? 1 : 0),
    exhausted: route === "escalate" ? true : state.exhausted,
    latestAuditId: finalAuditPacket.id,
  }));

  const latestRepairTask = getLatestSegmentRepairTask(nextProject, params.segmentLabel);
  if (route === "pass") {
    if (latestRepairTask && latestRepairTask.status !== "completed") {
      nextProject = upsertVideoRepairTask(nextProject, {
        ...latestRepairTask,
        status: "completed",
        auditId: finalAuditPacket.id,
        updatedAt: now,
      });
      nextProject = withVideoAutomationSegmentState(nextProject, params.segmentLabel, (state) => ({
        ...state,
        latestRepairTaskId: latestRepairTask.id,
      }));
    }
    return { project: nextProject, route };
  }

  const repairTask: VideoRepairTask = {
    id: latestRepairTask?.id || `repair:segment:${params.segmentLabel}`,
    targetType: "segment",
    targetId: `segment:${params.segmentLabel}`,
    segmentLabel: params.segmentLabel,
    route,
    status: route === "escalate" ? "exhausted" : "pending",
    reason: params.auditPacket.issues.join("；") || "Auto QA requested another pass.",
    auditId: finalAuditPacket.id,
    attempts: (latestRepairTask?.attempts || 0) + 1,
    createdAt: latestRepairTask?.createdAt || now,
    updatedAt: now,
  };
  nextProject = upsertVideoRepairTask(nextProject, repairTask);
  nextProject = withVideoAutomationSegmentState(nextProject, params.segmentLabel, (state) => ({
    ...state,
    latestRepairTaskId: repairTask.id,
    exhausted: route === "escalate" ? true : state.exhausted,
  }));
  const candidateVideoUrl = String(nextProject.segmentVideos?.[params.segmentLabel] || "").trim();
  let archivedCandidate: ArchivedSegmentVideoCandidate | undefined;
  if (candidateVideoUrl) {
    const archived = archiveRejectedSegmentVideoCandidate({
      project: nextProject,
      segmentLabel: params.segmentLabel,
      videoUrl: candidateVideoUrl,
      route,
      auditPacket: finalAuditPacket,
      provider: finalAuditPacket.provider,
      taskId: params.taskId,
      submittedPrompt: finalAuditPacket.submittedPrompt,
      referenceImageUrls: finalAuditPacket.referenceImageUrls,
      usedContinuityFrame: finalAuditPacket.usedContinuityFrame,
      usedRelayVideo: finalAuditPacket.usedRelayVideo,
    });
    nextProject = archived.project;
    archivedCandidate = archived.entry;
  }

  if (route === "local_repair") {
    const currentPrompt = nextProject.segmentVideoPrompts?.[params.segmentLabel];
    nextProject = removeSegmentVideoOutput(nextProject, params.segmentLabel);
    nextProject = {
      ...nextProject,
      segmentVideoPrompts: currentPrompt
        ? {
            ...(nextProject.segmentVideoPrompts || {}),
            [params.segmentLabel]: {
              ...currentPrompt,
              prompt: appendSegmentRepairGuidance(currentPrompt.prompt, params.auditPacket.issues, route),
              generatedAt: now,
            },
          }
        : nextProject.segmentVideoPrompts,
      segmentVideoStatuses: {
        ...(nextProject.segmentVideoStatuses || {}),
        [params.segmentLabel]: buildSegmentVideoStatus(params.segmentLabel, "failed", {
          provider: params.auditPacket.provider,
          failure: {
            message: "自动 QA 触发了局部修复，片段会按现有 continuity assets 再出一轮。",
            provider: params.auditPacket.provider,
            stage: "status",
            updatedAt: now,
          },
        }),
      },
    };
    return { project: nextProject, route, archivedCandidate };
  }

  if (route === "regenerate") {
    const nextPrompts = { ...(nextProject.segmentVideoPrompts || {}) };
    delete nextPrompts[params.segmentLabel];
    nextProject = removeSegmentVideoOutput(nextProject, params.segmentLabel);
    nextProject = {
      ...nextProject,
      segmentVideoPrompts: nextPrompts,
      segmentVideoStatuses: {
        ...(nextProject.segmentVideoStatuses || {}),
        [params.segmentLabel]: buildSegmentVideoStatus(params.segmentLabel, "failed", {
          provider: params.auditPacket.provider,
          failure: {
            message: "自动 QA 判定需要重建该片段提示词并整段重生。",
            provider: params.auditPacket.provider,
            stage: "status",
            updatedAt: now,
          },
        }),
      },
    };
    return { project: nextProject, route, archivedCandidate };
  }

  nextProject = removeSegmentVideoOutput(nextProject, params.segmentLabel);
  nextProject = upsertSegmentReviewQueueItem(
    nextProject,
    params.segmentLabel,
    params.auditPacket.issues.join("；") || "自动 QA 超出预算，进入人工兜底审阅。",
  );
  return { project: nextProject, route, archivedCandidate };
}

function dismissSegmentReviewQueueItems(
  project: PersistedVideoProject,
  segmentLabels: string[],
  status?: "approved" | "redo",
  summary?: string,
): PersistedVideoProject {
  if (!segmentLabels.length || !(project.reviewQueue?.length)) return project;
  const normalizedLabels = new Set(segmentLabels.map((label) => label.trim()).filter(Boolean));
  const now = new Date().toISOString();
  return {
    ...project,
    reviewQueue: project.reviewQueue.map((item) => {
      const matched = item.targetIds.some((targetId) => {
        const normalizedTarget = targetId.trim();
        if (!normalizedTarget.startsWith("segment:")) return false;
        return normalizedLabels.has(normalizedTarget.slice("segment:".length));
      });
      if (!matched) return item;
      if (!status) return item;
      return {
        ...item,
        status,
        ...(summary ? { summary } : {}),
        updatedAt: now,
      };
    }),
  };
}

function buildSegmentAutomationAuditOutcome(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  segmentPrompt: SegmentVideoPrompt;
  segmentScenes: Scene[];
  segmentContinuityContext: ReturnType<typeof buildSegmentPromptContinuityContext>;
  provider?: string;
  submittedPrompt: string;
  referenceImageUrls: string[];
  usedContinuityFrame: boolean;
  usedRelayVideo: boolean;
  segmentStartContinuityText: string;
  videoUrl?: string;
  continuityFrameUrl?: string;
  taskId?: string;
  failedStatus?: SegmentVideoStatus | null;
  visualQualityReport?: SegmentVideoVisualQualityReport | null;
}): {
  project: PersistedVideoProject;
  route: VideoRepairTask["route"];
  videoUrl?: string;
  continuityFrameUrl?: string;
  failedStatus: SegmentVideoStatus | null;
  archivedCandidate?: ArchivedSegmentVideoCandidate;
} {
  const auditIssues: string[] = [];
  const segmentShotPackets = collectSegmentShotPackets(params.project, params.segmentPrompt.sceneIds);
  const hasVisibleWatermarkPollution = params.visualQualityReport?.watermarkVisible === true;
  const visualDeliverableRejected = shouldRejectVisualDeliverable(params.visualQualityReport);
  const hasPromptFormatViolation =
    params.submittedPrompt.includes("【精确台词锁定】") ||
    params.submittedPrompt.includes("【镜头锚点补充】") ||
    !params.submittedPrompt.includes(VIDEO_MODEL_COMMON_SUFFIX_LABEL) ||
    !params.submittedPrompt.includes(VIDEO_MODEL_GLOBAL_CONTROL_TEXT);
  if (hasPromptFormatViolation) {
    auditIssues.push("最终提交 prompt 没有通过基础格式约束。");
  }
  const symbolicAudit = buildSegmentSymbolicAudit({
    project: params.project,
    segmentScenes: params.segmentScenes,
    segmentShotPackets,
    submittedPrompt: params.submittedPrompt,
    segmentStartContinuityText: params.segmentStartContinuityText,
    hasReferenceImages: params.referenceImageUrls.length > 0,
    hasPreviousSegment: Boolean(params.segmentContinuityContext.previousSegmentLabel),
  });
  const symbolicPassed =
    !hasPromptFormatViolation &&
    symbolicAudit.blockingIssues.length === 0 &&
    !hasVisibleWatermarkPollution &&
    !visualDeliverableRejected;
  auditIssues.push(...symbolicAudit.blockingIssues);
  auditIssues.push(...symbolicAudit.advisoryIssues.slice(0, 6));
  if (params.failedStatus?.failure?.message) {
    auditIssues.push(params.failedStatus.failure.message);
  }
  if (hasVisibleWatermarkPollution) {
    auditIssues.push("关键帧视觉检查发现成片出现了水印。");
  }
  if (visualDeliverableRejected) {
    auditIssues.push("关键帧视觉检查判定当前片段还不具备直接拼接交付条件。");
  }
  const filteredVisualIssues = getFilteredVisualQaIssues(params.visualQualityReport);
  if (filteredVisualIssues.length) {
    auditIssues.push(...filteredVisualIssues);
  }
  if (params.visualQualityReport?.fixPriorities?.length) {
    auditIssues.push(
      ...params.visualQualityReport.fixPriorities.map((item) => `优先修复：${item}`),
    );
  }
  if (params.visualQualityReport?.summary?.trim()) {
    auditIssues.push(`视觉质检摘要：${params.visualQualityReport.summary.trim()}`);
  }

  const heuristicContinuityScore = params.failedStatus
    ? 42
    : Math.min(
        97,
        (params.segmentContinuityContext.previousSegmentLabel ? 72 : 88) +
          (params.usedContinuityFrame ? 12 : 0) +
          (params.usedRelayVideo ? 8 : 0) +
          (/起始衔接/.test(params.submittedPrompt) ? 5 : 0) +
          Math.round((symbolicAudit.continuityCoverage - 80) / 5),
      );
  const heuristicIdentityScore = params.failedStatus
    ? 45
    : Math.min(
        96,
        72 +
          Math.min(params.referenceImageUrls.length, 3) * 6 +
          (params.segmentScenes.some((scene) => scene.characters.length > 0) ? 4 : 0) +
          Math.round((symbolicAudit.identityCoverage - 80) / 5),
      );
  const heuristicSemanticScore = params.failedStatus
    ? 40
    : Math.min(
        95,
        72 +
          (/分镜\d+/.test(params.submittedPrompt) ? 8 : -8) +
          (/结尾钩子/.test(params.submittedPrompt) ? 6 : -6) +
          (params.segmentContinuityContext.currentSegmentStoryGoal ? 6 : 0) +
          Math.round((symbolicAudit.semanticCoverage - 80) / 5),
      );
  const heuristicVisualScore = params.failedStatus
    ? 45
    : Math.min(
        95,
        72 +
          (/环境细节/.test(params.submittedPrompt) ? 8 : -8) +
          (params.referenceImageUrls.length > 0 ? 8 : 0) +
          (/通用后缀/.test(params.submittedPrompt) ? 3 : 0) +
          Math.round((params.visualQualityReport?.goldenSignals?.length ?? 0) * 1.5),
      );
  const blendVisualQaScore = (
    heuristicScore: number,
    visualScore: number | undefined,
  ) => {
    if (!Number.isFinite(visualScore)) return heuristicScore;
    return Math.round((heuristicScore + Number(visualScore) * 2) / 3);
  };
  const continuityScore = blendVisualQaScore(
    heuristicContinuityScore,
    params.visualQualityReport?.continuityScore,
  );
  const identityScore = blendVisualQaScore(
    heuristicIdentityScore,
    params.visualQualityReport?.identityScore,
  );
  const semanticScore = blendVisualQaScore(
    heuristicSemanticScore,
    params.visualQualityReport?.semanticScore,
  );
  const visualScore = blendVisualQaScore(
    heuristicVisualScore,
    params.visualQualityReport?.visualScore,
  );

  const auditPacket = buildSegmentAuditPacket({
    project: params.project,
    segmentLabel: params.segmentLabel,
    sceneIds: params.segmentPrompt.sceneIds,
    submittedPrompt: params.submittedPrompt,
    referenceImageUrls: params.referenceImageUrls,
    usedContinuityFrame: params.usedContinuityFrame,
    usedRelayVideo: params.usedRelayVideo,
    symbolicPassed,
    issues: auditIssues,
    continuityScore,
    identityScore,
    semanticScore,
    visualScore,
    visualQualityReport: params.visualQualityReport,
    provider: params.provider,
  });
  const automationCandidateProject = params.videoUrl
    ? withSegmentContinuityFrame(
        {
          ...params.project,
          segmentVideos: {
            ...(params.project.segmentVideos ?? {}),
            [params.segmentLabel]: params.videoUrl,
          },
          segmentVideoStatuses: {
            ...(params.project.segmentVideoStatuses ?? {}),
            [params.segmentLabel]: buildSegmentVideoStatus(params.segmentLabel, "completed", {
              taskId: params.taskId,
              provider: params.provider,
              submittedPrompt: params.submittedPrompt,
              referenceImageUrls: params.referenceImageUrls,
              usedContinuityFrame: params.usedContinuityFrame,
              usedRelayVideo: params.usedRelayVideo,
            }),
          },
        },
        params.segmentLabel,
        params.continuityFrameUrl,
      )
    : params.project;
  const automationDecision = applySegmentAutomationAuditDecision({
    project: automationCandidateProject,
    segmentLabel: params.segmentLabel,
    auditPacket,
    taskId: params.taskId,
  });
  if (automationDecision.route === "pass") {
    return {
      project: dismissSegmentReviewQueueItems(automationDecision.project, [params.segmentLabel], "approved"),
      route: automationDecision.route,
      videoUrl: params.videoUrl,
      continuityFrameUrl: params.continuityFrameUrl,
      failedStatus: null,
      archivedCandidate: undefined,
    };
  }

  return {
    project: automationDecision.project,
    route: automationDecision.route,
    videoUrl: undefined,
    continuityFrameUrl: undefined,
    archivedCandidate: automationDecision.archivedCandidate,
    failedStatus: buildSegmentVideoStatus(params.segmentLabel, "failed", {
      taskId: params.taskId,
      provider: params.provider,
      submittedPrompt: params.submittedPrompt,
      referenceImageUrls: params.referenceImageUrls,
      usedContinuityFrame: params.usedContinuityFrame,
      usedRelayVideo: params.usedRelayVideo,
      failure: {
        message:
          automationDecision.route === "local_repair"
            ? "自动 QA 已触发局部修复，当前候选已归档到历史候选，系统会保留 continuity assets 并继续补发该片段。"
            : automationDecision.route === "regenerate"
              ? "自动 QA 已触发整段重生，当前候选已归档到历史候选，系统会重建片段提示词后再次出片。"
              : "自动 QA 已超出预算，当前候选已归档到历史候选并进入 review 兜底。",
        provider: params.provider,
        stage: "status",
        updatedAt: new Date().toISOString(),
        route: automationDecision.route,
        auditId: automationDecision.archivedCandidate?.auditId,
        auditSummary: automationDecision.archivedCandidate?.qaSummary,
        historyEntryId: automationDecision.archivedCandidate?.id,
        historySegmentLabel: automationDecision.archivedCandidate?.segmentLabel,
        previewVideoUrl: automationDecision.archivedCandidate?.videoUrl,
      },
    }),
  };
}

function collectRequestedSegmentVideoLabels(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.targetSegmentLabels)) return [];

  return Array.from(
    new Set(
      input.targetSegmentLabels
        .filter((label): label is string => typeof label === "string")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  );
}

function createScriptDecomposeProgressFormatter(): (partial: DecomposeProgressPayload) => string {
  let marks: string[] = [];
  let totalChunks = 0;
  const summarizeReason = (value: string | undefined): string => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > 44 ? `${text.slice(0, 44)}...` : text;
  };

  const ensureMarks = (nextTotal: number) => {
    if (nextTotal <= 0 || nextTotal === totalChunks) return;
    const nextMarks = Array.from({ length: nextTotal }, (_, index) => marks[index] || ".");
    marks = nextMarks;
    totalChunks = nextTotal;
  };

  return (partial: DecomposeProgressPayload) => {
    const nextTotal =
      typeof partial.totalChunks === "number" && Number.isFinite(partial.totalChunks)
        ? Math.max(0, Math.floor(partial.totalChunks))
        : totalChunks;
    ensureMarks(nextTotal);

    if (partial.status === "init" && Array.isArray(partial.scenes) && partial.scenes.length > 0) {
      for (const episodeNumber of listSceneEpisodeNumbers(partial.scenes.map((scene, index) => mapScene(scene, index)))) {
        const markIndex = episodeNumber - 1;
        if (markIndex >= 0 && markIndex < marks.length) {
          marks[markIndex] = "#";
        }
      }
    }

    const chunkIndex =
      typeof partial.chunkIndex === "number" && Number.isFinite(partial.chunkIndex)
        ? Math.floor(partial.chunkIndex)
        : -1;
    if (chunkIndex >= 0 && chunkIndex < marks.length) {
      if (partial.status === "done") marks[chunkIndex] = "#";
      if (partial.status === "failed") marks[chunkIndex] = "x";
      if (partial.status === "cancelled") marks[chunkIndex] = "!";
      if (partial.status === "processing" && marks[chunkIndex] !== "#") marks[chunkIndex] = ">";
    }

    for (const failedIndex of partial.failedChunks || []) {
      if (failedIndex >= 0 && failedIndex < marks.length) {
        marks[failedIndex] = "x";
      }
    }

    const sceneCount = Array.isArray(partial.scenes) ? partial.scenes.length : 0;
    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const activeIndexes = marks
      .map((mark, index) => (mark === ">" ? index + 1 : 0))
      .filter(Boolean);
    const totalLabel = Math.max(totalChunks, 1);
    const bar = marks.length ? `[${marks.join("")}]` : "[.]";
    const retryLabel =
      typeof partial.retryAttempt === "number" && partial.retryAttempt > 0
        ? ` · 重试 ${partial.retryAttempt}`
        : "";
    const retryReasonLabel = partial.retryReason ? ` · 原因：${summarizeReason(partial.retryReason)}` : "";
    const errorLabel = partial.error ? ` · 失败原因：${summarizeReason(partial.error)}` : "";

    if (partial.status === "init") {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 初始化分集任务 · 已出 ${sceneCount} 镜头`;
    }
    if (activeIndexes.length > 0) {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 正在拆第 ${activeIndexes.join("、")} 集${retryLabel}${retryReasonLabel} · 已出 ${sceneCount} 镜头`;
    }
    if (failedCount > 0) {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · ${failedCount} 集失败${errorLabel} · 已出 ${sceneCount} 镜头`;
    }
    if (partial.status === "cancelled") {
      return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 已停止 · 已出 ${sceneCount} 镜头`;
    }
    return `剧本拆解 ${bar} ${doneCount}/${totalLabel} 集 · 已出 ${sceneCount} 镜头`;
  };
}

type ProgressMark = "." | "#" | ">" | "x" | "!";

function buildCompactProgressBar(marks: ProgressMark[]): string {
  if (!marks.length) return "[.]";
  if (marks.length <= 48) return `[${marks.join("")}]`;
  return `[${marks.slice(0, 22).join("")}...${marks.slice(-22).join("")}]`;
}

type PromptBatchProgressStatus = "init" | "processing" | "done" | "failed" | "cancelled";

function createSegmentPromptProgressFormatter(
  segmentOrder: string[],
  readySegments: Set<string>,
): (params: { segmentLabel?: string; status: PromptBatchProgressStatus }) => string {
  const marks: ProgressMark[] = segmentOrder.map((segmentLabel): ProgressMark =>
    readySegments.has(segmentLabel) ? "#" : ".",
  );

  return ({ segmentLabel, status }) => {
    const index = segmentLabel ? segmentOrder.indexOf(segmentLabel) : -1;
    if (index >= 0) {
      if (status === "processing" && marks[index] !== "#") marks[index] = ">";
      if (status === "done") marks[index] = "#";
      if (status === "failed") marks[index] = "x";
      if (status === "cancelled") marks[index] = "!";
    }

    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const bar = buildCompactProgressBar(marks);
    const total = Math.max(segmentOrder.length, 1);

    if (status === "init") {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 初始化片段任务`;
    }
    if (status === "processing" && segmentLabel) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 正在生成片段 ${segmentLabel}`;
    }
    if (status === "failed" && segmentLabel) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 片段 ${segmentLabel} 失败`;
    }
    if (status === "cancelled") {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · 已停止`;
    }
    if (failedCount > 0) {
      return `片段提示词 ${bar} ${doneCount}/${total} 片段 · ${failedCount} 个片段失败`;
    }
    return `片段提示词 ${bar} ${doneCount}/${total} 片段`;
  };
}

function deriveShotPromptEpisodeKey(scene: Scene): string {
  const match = String(scene.segmentLabel || "").trim().match(/^(\d+)-/);
  return match?.[1] || "1";
}

function deriveShotPromptSegmentKey(scene: Scene): string {
  const segmentLabel = String(scene.segmentLabel || "").trim();
  return segmentLabel || "__no_segment__";
}

function hasReadyShotPrompt(scene: Scene): boolean {
  return Boolean(scene.enhancedVideoPrompt?.trim());
}

function buildSceneProgressUnitMap(
  scenes: Scene[],
  getKey: (scene: Scene) => string,
): { order: string[]; sceneMap: Map<string, Scene[]> } {
  const order: string[] = [];
  const sceneMap = new Map<string, Scene[]>();
  for (const scene of scenes) {
    const key = getKey(scene);
    if (!sceneMap.has(key)) {
      order.push(key);
      sceneMap.set(key, []);
    }
    sceneMap.get(key)!.push(scene);
  }
  return { order, sceneMap };
}

function createShotPromptBatchProgressFormatter(
  unitOrder: string[],
  readyUnits: Set<string>,
  mode: "episode" | "segment",
): (params: { unitKey?: string; status: PromptBatchProgressStatus }) => string {
  const marks: ProgressMark[] = unitOrder.map((unitKey): ProgressMark =>
    readyUnits.has(unitKey) ? "#" : ".",
  );
  const unitLabel = mode === "episode" ? "集" : "片段";
  const initLabel = mode === "episode" ? "初始化分集任务" : "初始化片段任务";
  const failedLabel = mode === "episode" ? "个分集失败" : "个片段失败";
  const describeUnit = (unitKey: string): string => {
    if (mode === "episode") return `第 ${unitKey} 集`;
    return unitKey === "__no_segment__" ? "未分组片段" : `片段 ${unitKey}`;
  };

  return ({ unitKey, status }) => {
    const index = unitKey ? unitOrder.indexOf(unitKey) : -1;
    if (index >= 0) {
      if (status === "processing" && marks[index] !== "#") marks[index] = ">";
      if (status === "done") marks[index] = "#";
      if (status === "failed") marks[index] = "x";
      if (status === "cancelled") marks[index] = "!";
    }

    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const bar = buildCompactProgressBar(marks);
    const total = Math.max(unitOrder.length, 1);

    if (status === "init") {
      return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel} · ${initLabel}`;
    }
    if (status === "processing" && unitKey) {
      return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel} · 正在生成${describeUnit(unitKey)}`;
    }
    if (status === "failed" && unitKey) {
      return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel} · ${describeUnit(unitKey)}失败`;
    }
    if (status === "cancelled") {
      return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel} · 已停止`;
    }
    if (failedCount > 0) {
      return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel} · ${failedCount} ${failedLabel}`;
    }
    return `镜头提示词 ${bar} ${doneCount}/${total} ${unitLabel}`;
  };
}

function createVideoTaskProgressFormatter(
  unitOrder: string[],
  readyUnits: Set<string>,
  options: {
    prefix: string;
    unitLabel: string;
    initLabel: string;
    failedLabel: string;
    describeUnit: (unitKey: string) => string;
  },
): (params: { unitKey?: string; status: PromptBatchProgressStatus }) => string {
  const marks: ProgressMark[] = unitOrder.map((unitKey): ProgressMark =>
    readyUnits.has(unitKey) ? "#" : ".",
  );

  return ({ unitKey, status }) => {
    const index = unitKey ? unitOrder.indexOf(unitKey) : -1;
    if (index >= 0) {
      if (status === "processing" && marks[index] !== "#") marks[index] = ">";
      if (status === "done") marks[index] = "#";
      if (status === "failed") marks[index] = "x";
      if (status === "cancelled") marks[index] = "!";
    }

    const doneCount = marks.filter((mark) => mark === "#").length;
    const failedCount = marks.filter((mark) => mark === "x").length;
    const bar = buildCompactProgressBar(marks);
    const total = Math.max(unitOrder.length, 1);

    if (status === "init") {
      return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel} · ${options.initLabel}`;
    }
    if (status === "processing" && unitKey) {
      return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel} · 正在生成${options.describeUnit(unitKey)}`;
    }
    if (status === "failed" && unitKey) {
      return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel} · ${options.describeUnit(unitKey)}失败`;
    }
    if (status === "cancelled") {
      return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel} · 已停止`;
    }
    if (failedCount > 0) {
      return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel} · ${failedCount} ${options.failedLabel}`;
    }
    return `${options.prefix} ${bar} ${doneCount}/${total} ${options.unitLabel}`;
  };
}

function createSegmentVideoProgressFormatter(
  segmentOrder: string[],
): (params: { unitKey?: string; status: PromptBatchProgressStatus }) => string {
  return createVideoTaskProgressFormatter(segmentOrder, new Set<string>(), {
    prefix: "片段视频",
    unitLabel: "片段",
    initLabel: "初始化片段任务",
    failedLabel: "个片段失败",
    describeUnit: (segmentLabel) => `片段 ${segmentLabel}`,
  });
}

function createSceneVideoProgressFormatter(
  scenes: Array<Pick<Scene, "id" | "sceneName">>,
): (params: { unitKey?: string; status: PromptBatchProgressStatus }) => string {
  const sceneNameById = new Map(scenes.map((scene) => [scene.id, scene.sceneName] as const));
  return createVideoTaskProgressFormatter(
    scenes.map((scene) => scene.id),
    new Set<string>(),
    {
      prefix: "镜头视频",
      unitLabel: "镜头",
      initLabel: "初始化镜头任务",
      failedLabel: "条镜头失败",
      describeUnit: (sceneId) => `镜头 ${sceneNameById.get(sceneId) || sceneId}`,
    },
  );
}

export function planVideoWorkflowContinuation(
  project: PersistedVideoProject,
  input: Record<string, unknown> = {},
): VideoWorkflowContinuationPlan {
  let syncedProject = synchronizeVideoProductionState(project);

  if (!syncedProject.script?.trim()) {
    throw new Error("当前没有可用于视频生产的脚本，请先提供脚本或挂载剧本项目。");
  }

  // 用户通过步骤切换手动跳到了更靠后的步骤，且自然进度尚未追上，不自动推进
  const naturalStep = deriveVisibleVideoStep(syncedProject);
  const manualOverride = syncedProject.manualStepOverride ?? null;
  if (manualOverride !== null && manualOverride > naturalStep) {
    return {
      actionKind: "create_video_bridge_artifact",
      policy: "bridge-summary",
      input,
      reason: "当前处于手动切换的步骤，请先回到原步骤完成所有条件后再推进。",
    };
  }

  if (!syncedProject.scenes.length) {
    return {
      actionKind: "analyze_script_for_video",
      policy: "bootstrap-analysis",
      input,
      reason: "先把当前脚本拆成镜头，首页会话才能继续推进视频生产。",
    };
  }

  if (hasIncompleteVideoEpisodeCoverage(syncedProject)) {
    return {
      actionKind: "analyze_script_for_video",
      policy: "bootstrap-analysis",
      input,
      reason: "当前脚本包含多集，但已保存的镜头拆解没有覆盖全部集数，需要重新完整拆解后再继续。",
    };
  }

  if (!hasExtractedVideoEntities(syncedProject)) {
    return {
      actionKind: "extract_video_entities",
      policy: "bootstrap-entities",
      input,
      reason: "镜头已经拆完，下一步先整理角色和场景资产。",
    };
  }

  const exhaustedReferenceTargetIds = listExhaustedReferenceAssetTargetIds(syncedProject);
  if (exhaustedReferenceTargetIds.length > 0) {
    const reviewTargetIds = exhaustedReferenceTargetIds
      .slice(0, getHomeAgentVideoGenerationBatchLimit(syncedProject.videoGenerationPrefs));
    return {
      actionKind: "review_video_assets",
      policy: "review-escalated",
      input: {
        ...input,
        targetIds: reviewTargetIds,
      },
      reason:
        reviewTargetIds.length === 1
          ? "当前有 1 个参考资产已经超出自动补图预算，先进入 review 兜底。"
          : `当前有 ${exhaustedReferenceTargetIds.length} 个参考资产超出自动补图预算，先进入 review 兜底。`,
      targetCount: reviewTargetIds.length,
      totalTargetCount: exhaustedReferenceTargetIds.length,
      remainingTargetCount: Math.max(exhaustedReferenceTargetIds.length - reviewTargetIds.length, 0),
    };
  }

  // 自动推进时，角色与场景阶段必须先满足完整资产条件，再进入后续步骤
  const videoMode = syncedProject.videoGenerationPrefs?.mode ?? "image-to-video";
  if (!hasCompleteVideoReferenceAssets(syncedProject)) {
    return {
      actionKind: "generate_video_reference_assets",
      policy: "bootstrap-reference-assets",
      input: {
        ...input,
        smartBatch: true,
      },
      reason: "角色与场景实体已整理完毕，下一步自动补齐参考资产包。",
    };
  }

  if (!syncedProject.shotPackets?.length) {
    return {
      actionKind: "compile_video_shot_packets",
      policy: "bootstrap-shot-packets",
      input,
      reason: "分镜说明已经就绪，下一步先把镜头压成可复用的 shot packet。",
    };
  }

  const segmentOrderContext = buildSceneSegmentOrderContext(syncedProject.scenes);
  const segmentLabels = segmentOrderContext.segmentOrder;
  const hasSegmentChain = segmentLabels.length > 0;
  const missingSegmentPromptLabels = segmentLabels.filter(
    (segmentLabel) => !hasReadySegmentVideoPrompt(syncedProject.segmentVideoPrompts, segmentLabel),
  );
  const escalatedSegmentRepairs = getEscalatedSegmentRepairTasks(syncedProject);
  if (escalatedSegmentRepairs.length) {
    const reviewTargetIds = escalatedSegmentRepairs
      .map((task) => task.targetId)
      .filter(Boolean)
      .slice(0, getHomeAgentVideoGenerationBatchLimit(syncedProject.videoGenerationPrefs));
    return {
      actionKind: "review_video_assets",
      policy: "review-escalated",
      input: {
        ...input,
        targetIds: reviewTargetIds,
      },
      reason:
        reviewTargetIds.length === 1
          ? "当前有 1 个片段已经超出自动修复预算，先进入 review 兜底。"
          : `当前有 ${escalatedSegmentRepairs.length} 个片段超出自动修复预算，先进入 review 兜底。`,
      targetCount: reviewTargetIds.length,
      totalTargetCount: escalatedSegmentRepairs.length,
      remainingTargetCount: Math.max(escalatedSegmentRepairs.length - reviewTargetIds.length, 0),
    };
  }

  if (videoMode === "text-to-video" && hasSegmentChain) {
    const batchLimit = getHomeAgentVideoGenerationBatchLimit(syncedProject.videoGenerationPrefs);
    const pendingSegmentRepairs = getPendingSegmentRepairTasks(syncedProject);
    const repairSegmentLabels = pendingSegmentRepairs
      .map((task) => task.segmentLabel || "")
      .filter(Boolean);
    const runningSegmentLabels = Object.entries(syncedProject.segmentVideoStatuses ?? {})
      .filter(([, status]) => {
        const normalizedStatus = normalizeSceneStatus(status.status);
        return normalizedStatus === "queued" || normalizedStatus === "processing";
      })
      .map(([label]) => label)
      .filter((label) => segmentLabels.includes(label));

    if (
      missingSegmentPromptLabels.length > 0 ||
      repairSegmentLabels.some((segmentLabel) => !hasReadySegmentVideoPrompt(syncedProject.segmentVideoPrompts, segmentLabel))
    ) {
      const targetSegmentLabel =
        repairSegmentLabels.find(
          (segmentLabel) => !hasReadySegmentVideoPrompt(syncedProject.segmentVideoPrompts, segmentLabel),
        ) || missingSegmentPromptLabels[0];
      return {
        actionKind: "prepare_segment_video_prompt",
        policy: "bootstrap-segment-prompt",
        input: {
          ...input,
          batchMode: "remaining",
          ...(targetSegmentLabel ? { targetSegmentLabel } : {}),
        },
        reason:
          repairSegmentLabels.length > 0
            ? "自动 QA 标记了需要重编的片段，先重建对应片段提示词。"
            : "文生视频模式优先走片段主链，下一步先补齐缺失的片段提示词。",
      };
    }

    const repairableSegmentLabels = repairSegmentLabels
      .filter((segmentLabel) => hasReadySegmentVideoPrompt(syncedProject.segmentVideoPrompts, segmentLabel))
      .slice(0, batchLimit);
    if (repairableSegmentLabels.length) {
      return {
        actionKind: "generate_segment_video",
        policy: "repair-failed-segments",
        input: {
          ...input,
          targetSegmentLabels: repairableSegmentLabels,
          retryFailed: true,
        },
        reason:
          repairableSegmentLabels.length === 1
            ? "自动 QA 标记了 1 个片段需要继续修复，先重新提交这一段。"
            : `自动 QA 标记了 ${pendingSegmentRepairs.length} 个片段待修复，先补发前 ${repairableSegmentLabels.length} 段。`,
        targetCount: repairableSegmentLabels.length,
        totalTargetCount: pendingSegmentRepairs.length,
        remainingTargetCount: Math.max(pendingSegmentRepairs.length - repairableSegmentLabels.length, 0),
      };
    }

    if (runningSegmentLabels.length) {
      const targetSegmentLabel = runningSegmentLabels[0];
      return {
        actionKind: "refresh_segment_video",
        policy: "refresh-running-segments",
        input: {
          ...input,
          segmentLabel: targetSegmentLabel,
        },
        reason:
          runningSegmentLabels.length === 1
            ? "当前有 1 个片段视频仍在生成中，先刷新它的状态。"
            : `当前有 ${runningSegmentLabels.length} 个片段视频仍在生成中，先刷新最靠前的一个。`,
        targetCount: 1,
        totalTargetCount: runningSegmentLabels.length,
        remainingTargetCount: Math.max(runningSegmentLabels.length - 1, 0),
      };
    }

    const generatableSegmentLabels = listGeneratableSegmentVideoLabelsForBatch(syncedProject);
    if (generatableSegmentLabels.length) {
      const targetSegmentLabels = generatableSegmentLabels.slice(0, batchLimit);
      return {
        actionKind: "generate_segment_video",
        policy: "generate-next-segment-batch",
        input: {
          ...input,
          targetSegmentLabels,
        },
        reason:
          targetSegmentLabels.length === 1
            ? "片段提示词已经就绪，下一步先提交这一段片段视频。"
            : `片段提示词已经就绪，下一步先提交前 ${targetSegmentLabels.length} 个片段视频。`,
        targetCount: targetSegmentLabels.length,
        totalTargetCount: generatableSegmentLabels.length,
        remainingTargetCount: Math.max(generatableSegmentLabels.length - targetSegmentLabels.length, 0),
      };
    }
  } else if (videoMode === "text-to-video") {
    if (!hasCompleteTextToVideoPrompts(syncedProject)) {
      return {
        actionKind: "prepare_video_prompt_batch",
        policy: "bootstrap-prompt-batch",
        input: { ...batchSceneRange(syncedProject.scenes, 4), ...input },
        reason: "文生视频模式未检测到可直接出片的完整提示词链路，先补齐镜头提示词批次。",
      };
    }
  } else if (!syncedProject.videoPromptBatch?.trim()) {
    return {
      actionKind: "prepare_video_prompt_batch",
      policy: "bootstrap-prompt-batch",
      input: { ...batchSceneRange(syncedProject.scenes, 4), ...input },
      reason: "分镜批次已经完成，下一步生成对应的视频提示词。",
    };
  }

  const failedSceneIds = listFailedSceneIds(syncedProject);
  if (failedSceneIds.length) {
    const batchLimit = getHomeAgentVideoGenerationBatchLimit(syncedProject.videoGenerationPrefs);
    const targetIds = failedSceneIds.slice(0, batchLimit);
    return {
      actionKind: "generate_video_assets",
      policy: "repair-failed",
      input: {
        ...input,
        targetIds,
        forceRegenerate: true,
      },
      reason:
        targetIds.length === 1
          ? "当前有 1 条镜头出片失败，先直接补发这条失败镜头。"
          : `当前有 ${failedSceneIds.length} 条镜头出片失败，先统一补发失败镜头。`,
      targetCount: targetIds.length,
      totalTargetCount: failedSceneIds.length,
      remainingTargetCount: Math.max(failedSceneIds.length - targetIds.length, 0),
    };
  }

  const batchLimit = getHomeAgentVideoGenerationBatchLimit(syncedProject.videoGenerationPrefs);
  const generatableSceneIds = listGeneratableSceneIds(
    syncedProject,
    batchLimit,
  );
  if (generatableSceneIds.length) {
    const totalGeneratableSceneIds = listGeneratableSceneIds(syncedProject, Number.MAX_SAFE_INTEGER);
    return {
      actionKind: "generate_video_assets",
      policy: "generate-next-batch",
      input: {
        ...input,
        targetIds: generatableSceneIds,
      },
      reason:
        generatableSceneIds.length === 1
          ? "视频提示词已经就绪，下一步先提交这一条镜头出片。"
          : `视频提示词已经就绪，下一步先提交前 ${generatableSceneIds.length} 条镜头出片。`,
      targetCount: generatableSceneIds.length,
      totalTargetCount: totalGeneratableSceneIds.length,
      remainingTargetCount: Math.max(totalGeneratableSceneIds.length - generatableSceneIds.length, 0),
    };
  }

  return {
    actionKind: "create_video_bridge_artifact",
    policy: "bridge-summary",
    input,
    reason: "当前视频项目已经具备首页继续出片所需的桥接摘要。",
  };
}

async function ensureVideoProject(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): Promise<PersistedVideoProject> {
  const requestedProjectId =
    typeof input.projectId === "string" && input.projectId.trim()
      ? input.projectId.trim()
      : null;
  const sourceProjectId = resolveVideoSourceProjectId(runtime, input, requestedProjectId);

  if (
    requestedProjectId &&
    runtime.currentVideoProject?.id === requestedProjectId
  ) {
    return mergeVideoInputContext(runtime.currentVideoProject, runtime, input);
  }

  if (requestedProjectId) {
    const restored = await loadStoredVideoProjectById(requestedProjectId);
    if (restored) return mergeVideoInputContext(restored, runtime, input);
  }

  if (sourceProjectId) {
    const linkedProject = await findVideoProjectBySourceProjectId(sourceProjectId);
    if (linkedProject) {
      return mergeVideoInputContext(linkedProject, runtime, input);
    }
  }

  if (runtime.currentVideoProject) {
    return mergeVideoInputContext(runtime.currentVideoProject, runtime, input);
  }

  const script = resolveWorkingScript(runtime, null, input);
  const created = await createStoredVideoProject({
    title: buildVideoTitle(runtime, input),
    script,
    targetPlatform: readTextInput(input, "targetPlatform"),
    shotStyle: readTextInput(input, "shotStyle"),
    outputGoal: readTextInput(input, "outputGoal"),
    productionNotes:
      readTextInput(input, "productionNotes") ||
      readTextInput(input, "customInstruction"),
    artStyle:
      typeof input.artStyle === "string"
        ? (input.artStyle as ArtStyle)
        : "live-action",
    currentStep: 1,
    sourceProjectId: sourceProjectId || undefined,
    scriptBreakdownPassed: false,
    analysisSummary: script
      ? "已从当前首页会话接入脚本，可继续做镜头拆解、资产梳理和出片准备。"
      : "已建立视频会话项目，等待脚本或镜头需求进入生产。",
  });
  return mergeVideoInputContext(created, runtime, input);
}

function resolveVideoSourceProjectId(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
  requestedProjectId?: string | null,
): string | null {
  const inputSourceProjectId =
    typeof input.sourceProjectId === "string" && input.sourceProjectId.trim()
      ? input.sourceProjectId.trim()
      : null;
  if (inputSourceProjectId) return inputSourceProjectId;

  if (runtime.currentDramaProject?.id?.trim()) {
    return runtime.currentDramaProject.id.trim();
  }

  const snapshot = runtime.currentProjectSnapshot;
  if (snapshot?.projectKind && snapshot.projectKind !== "video" && snapshot.projectId.trim()) {
    return snapshot.projectId.trim();
  }

  if (
    requestedProjectId &&
    runtime.currentProjectSnapshot?.projectKind !== "video" &&
    runtime.currentVideoProject?.id !== requestedProjectId
  ) {
    return requestedProjectId;
  }

  return null;
}

async function findVideoProjectBySourceProjectId(
  sourceProjectId: string,
): Promise<PersistedVideoProject | null> {
  const projects = await listStoredVideoProjects({ fast: true });
  return projects.find((project) => project.sourceProjectId === sourceProjectId) ?? null;
}

async function saveVideoProject(
  project: PersistedVideoProject,
  summary: string,
): Promise<WorkflowActionResult> {
  const saved = await upsertStoredVideoProject(synchronizeVideoProductionState(project));
  const snapshot = createVideoSnapshot(saved);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(VIDEO_PROJECT_SAVED_EVENT, {
        detail: {
          projectId: saved.id,
          videoProject: saved,
          projectSnapshot: snapshot,
        },
      }),
    );
  }
  return {
    summary,
    projectSnapshot: snapshot,
    recommendedActions: snapshot.recommendedActions,
    data: {
      videoProject: saved,
      projectSnapshot: snapshot,
    },
  };
}

function buildTransientVideoProjectResult(
  project: PersistedVideoProject,
  summary: string,
): WorkflowActionResult {
  const syncedProject = synchronizeVideoProductionState(project);
  const snapshot = createVideoSnapshot(syncedProject);
  return {
    summary,
    projectSnapshot: snapshot,
    recommendedActions: snapshot.recommendedActions,
    data: {
      videoProject: syncedProject,
      projectSnapshot: snapshot,
    },
  };
}

function emitVideoImageProgress(
  onProgress: WorkflowActionProgressCallback | undefined,
  project: PersistedVideoProject,
  imageUrl: string,
  imageLabel: string,
) {
  if (!onProgress) return;
  const partialResult = buildTransientVideoProjectResult(project, "");
  onProgress({ ...partialResult, imageUrls: [imageUrl], imageLabels: [imageLabel] });
}

function collectOrderedGeneratedImages(
  completedImages: Array<{ url: string; label: string } | undefined>,
): { imageUrls: string[]; imageLabels: string[] } {
  return completedImages.reduce<{ imageUrls: string[]; imageLabels: string[] }>(
    (accumulator, image) => {
      if (image) {
        accumulator.imageUrls.push(image.url);
        accumulator.imageLabels.push(image.label);
      }
      return accumulator;
    },
    { imageUrls: [], imageLabels: [] },
  );
}

async function runWithVideoAbortSignal<T>(
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  activeVideoAbortControllers.set(VIDEO_WORKFLOW_GENERATION_ABORT_KEY, controller);
  try {
    return await task(controller.signal);
  } finally {
    if (activeVideoAbortControllers.get(VIDEO_WORKFLOW_GENERATION_ABORT_KEY) === controller) {
      activeVideoAbortControllers.delete(VIDEO_WORKFLOW_GENERATION_ABORT_KEY);
    }
  }
}

function resolveGenerationScenes(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
): Scene[] {
  const targetIds = collectTargetIds(input);
  if (targetIds.length) {
    return project.scenes.filter((scene) => sceneTargetMatches(scene, project.id, targetIds));
  }

  const start = typeof input.sceneStart === "number" ? input.sceneStart : null;
  const end = typeof input.sceneEnd === "number" ? input.sceneEnd : null;
  if (start !== null || end !== null) {
    const lower = start ?? project.scenes[0]?.sceneNumber ?? 1;
    const upper = end ?? lower;
    return project.scenes.filter((scene) => scene.sceneNumber >= lower && scene.sceneNumber <= upper);
  }

  const forceRegenerate = input.forceRegenerate === true;
  const batchSize = resolveVideoGenerationBatchSize(input, project.videoGenerationPrefs);

  return project.scenes
    .filter((scene) => {
      if (forceRegenerate) return true;
      if (["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus))) return false;
      return !scene.videoUrl;
    })
    .slice(0, batchSize);
}

async function buildSceneVideoPrompt(
  project: PersistedVideoProject,
  scene: Scene,
  context?: {
    prevDescription?: string;
    nextDescription?: string;
    excludeStoryboard?: boolean;
    textModel?: string;
  },
): Promise<VideoEnhanceResult> {
  if (scene.enhancedVideoPrompt?.trim()) {
    return {
      enhanced: appendExactDialogueLock(scene.enhancedVideoPrompt.trim(), scene.dialogue),
      duration: scene.recommendedDuration,
    };
  }

  const characterDetails = findCharacterDetails(scene, project.characters || []);
  const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
  const referenceImageUrl = findSceneReferenceImage(scene, project.sceneSettings || [], {
    excludeStoryboard: context?.excludeStoryboard,
  });
  const { data, error } = await invokeFunction<VideoEnhanceResult>(
    "enhance-video-prompt",
    {
      description: scene.description,
      characters: scene.characters,
      cameraDirection: scene.cameraDirection,
      sceneName: scene.sceneName,
      dialogue: scene.dialogue,
      style: resolveProjectImagePromptStyle(project),
      characterDescriptions: characterDetails,
      sceneDescription: matchedSetting?.description || scene.sceneName,
      referenceImageUrl,
      hasRefImage: Boolean(referenceImageUrl),
      videoMode: context?.excludeStoryboard ? "text-to-video" : "image-to-video",
      characterImages: characterDetails
        .filter((c) => c.imageUrl)
        .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
      prevDescription: context?.prevDescription,
      nextDescription: context?.nextDescription,
      ...(context?.textModel ? { textModel: context.textModel } : {}),
    },
  );

  if (error) throw error;
  return withExactDialogueLock(
    data || { enhanced: scene.description || scene.sceneName || "继续生成当前镜头", duration: scene.duration || 5 },
    scene.dialogue,
  );
}

function appendVideoHistory(scene: Scene, nextUrl?: string) {
  if (!scene.videoUrl || scene.videoUrl === nextUrl) return scene.videoHistory || [];

  const previous = scene.videoHistory || [];
  if (previous.some((entry) => entry.videoUrl === scene.videoUrl)) {
    return previous;
  }

  return [
    ...previous,
    {
      videoUrl: scene.videoUrl,
      createdAt: new Date().toISOString(),
    },
  ];
}

function decodeVideoFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mapScene(raw: Partial<Scene>, index: number): Scene {
  return {
    id: raw.id || crypto.randomUUID(),
    sceneNumber: typeof raw.sceneNumber === "number" ? raw.sceneNumber : index + 1,
    sceneName: raw.sceneName?.trim() || `镜头 ${index + 1}`,
    description: raw.description?.trim() || "",
    characters: Array.isArray(raw.characters)
      ? raw.characters.filter((item): item is string => typeof item === "string")
      : [],
    dialogue: raw.dialogue?.trim() || "",
    cameraDirection: raw.cameraDirection?.trim() || "",
    segmentLabel: raw.segmentLabel,
    duration: typeof raw.duration === "number" ? raw.duration : 5,
    storyboardUrl: raw.storyboardUrl,
    storyboardHistory: raw.storyboardHistory,
    panoramaUrl: raw.panoramaUrl,
    videoUrl: raw.videoUrl,
    videoTaskId: raw.videoTaskId,
    videoProvider: raw.videoProvider,
    videoStatus: raw.videoStatus,
    videoHistory: raw.videoHistory,
    recommendedDuration: raw.recommendedDuration,
    isManualDuration: raw.isManualDuration,
    characterCostumes: raw.characterCostumes,
    sceneTimeVariantId: raw.sceneTimeVariantId,
    enhancedVideoPrompt: raw.enhancedVideoPrompt,
  };
}

function mapCharacters(
  rawCharacters: ExtractEntitiesResult["characters"],
  existingCharacters: CharacterSetting[] = [],
  options?: { replaceExisting?: boolean },
): CharacterSetting[] {
  const usedExistingIndexes = new Set<number>();
  const dedupedCharacters = dedupeExtractedCharacters(rawCharacters);

  const mappedCharacters = dedupedCharacters.map((character, index) => {
    const name = character?.name?.trim() || `角色 ${index + 1}`;
    const existing = takeMatchedEntity(existingCharacters, name, usedExistingIndexes, "character");
    const costumes = mapCostumeVariants(character?.costumes, existing?.costumes, options);
    const activeCostumeId = resolvePreservedVariantId(
      existing?.activeCostumeId,
      existing?.costumes,
      costumes,
    );

    return {
      id: existing?.id || crypto.randomUUID(),
      name: existing
        ? chooseMergedConsistencyEntityName(existing.name, name, "character")
        : name,
      description: character?.description?.trim() || existing?.description || "",
      imageUrl: existing?.imageUrl,
      audioUrl: existing?.audioUrl,
      audioFileName: existing?.audioFileName,
      threeViewUrls: existing?.threeViewUrls,
      isAIGenerated: existing?.isAIGenerated ?? false,
      isGenerating: false,
      source: existing?.source || "auto",
      imageHistory: existing?.imageHistory,
      costumes,
      activeCostumeId,
    };
  });

  if (options?.replaceExisting) return mappedCharacters;

  const preservedCharacters = existingCharacters.filter((_, index) => !usedExistingIndexes.has(index));
  return [...mappedCharacters, ...preservedCharacters];
}

function mapSceneSettings(
  rawSceneSettings: ExtractEntitiesResult["sceneSettings"],
  existingSceneSettings: SceneSetting[] = [],
  options?: { replaceExisting?: boolean },
): SceneSetting[] {
  const usedExistingIndexes = new Set<number>();
  const dedupedSceneSettings = dedupeExtractedSceneSettings(rawSceneSettings);

  const mappedSceneSettings = dedupedSceneSettings.map((sceneSetting, index) => {
    const name = sceneSetting?.name?.trim() || `场景 ${index + 1}`;
    const existing = takeMatchedEntity(existingSceneSettings, name, usedExistingIndexes, "scene");
    const timeVariants = mapSceneTimeVariants(sceneSetting?.timeVariants, existing?.timeVariants, options);
    const activeTimeVariantId = resolvePreservedVariantId(
      existing?.activeTimeVariantId,
      existing?.timeVariants,
      timeVariants,
    );

    return {
      id: existing?.id || crypto.randomUUID(),
      name: existing
        ? chooseMergedConsistencyEntityName(existing.name, name, "scene")
        : name,
      description: sceneSetting?.description?.trim() || existing?.description || "",
      imageUrl: existing?.imageUrl,
      isAIGenerated: existing?.isAIGenerated ?? false,
      isGenerating: false,
      source: existing?.source || "auto",
      imageHistory: existing?.imageHistory,
      timeVariants,
      activeTimeVariantId,
    };
  });

  if (options?.replaceExisting) return mappedSceneSettings;

  const preservedSceneSettings = existingSceneSettings.filter((_, index) => !usedExistingIndexes.has(index));
  return [...mappedSceneSettings, ...preservedSceneSettings];
}

function mapCostumeVariants(
  rawVariants: ExtractedVariantResult[] | undefined,
  existingVariants: CostumeSetting[] = [],
  options?: { replaceExisting?: boolean },
): CostumeSetting[] | undefined {
  const usedExistingIndexes = new Set<number>();
  const variants: CostumeSetting[] = [];

  (rawVariants || []).forEach((variant, index) => {
    const label = variant?.label?.trim() || `角色变体 ${index + 1}`;
    if (!label) return;

    const existing = takeMatchedVariant(
      existingVariants,
      label,
      variant?.description?.trim() || "",
      usedExistingIndexes,
      "costume",
    );
    const nextVariant: CostumeSetting = {
        id: existing?.id || crypto.randomUUID(),
        label: existing
          ? chooseMergedVariantLabel(existing.label, label, Boolean(existing.imageUrl?.trim()), "costume")
          : label,
        description: variant?.description?.trim() || existing?.description || "",
        imageUrl: existing?.imageUrl,
        isAIGenerated: existing?.isAIGenerated ?? false,
        imageHistory: existing?.imageHistory,
    };

    const duplicateIndex = findMatchedVariantIndex(variants, nextVariant, "costume");
    if (duplicateIndex >= 0) {
      variants[duplicateIndex] = mergeEntityVariant(variants[duplicateIndex]!, nextVariant, "costume");
    } else {
      variants.push(nextVariant);
    }
  });

  const preservedVariants = options?.replaceExisting
    ? []
    : existingVariants.filter((_, index) => !usedExistingIndexes.has(index));
  const mergedVariants = dedupeEntityVariants([...variants, ...preservedVariants], "costume");

  return mergedVariants.length ? mergedVariants : undefined;
}

function mapSceneTimeVariants(
  rawVariants: ExtractedVariantResult[] | undefined,
  existingVariants: TimeVariantSetting[] = [],
  options?: { replaceExisting?: boolean },
): TimeVariantSetting[] | undefined {
  const usedExistingIndexes = new Set<number>();
  const variants: TimeVariantSetting[] = [];

  (rawVariants || []).forEach((variant, index) => {
    const label = variant?.label?.trim() || `场景变体 ${index + 1}`;
    if (!label) return;

    const existing = takeMatchedVariant(
      existingVariants,
      label,
      variant?.description?.trim() || "",
      usedExistingIndexes,
      "scene-time",
    );
    const nextVariant: TimeVariantSetting = {
        id: existing?.id || crypto.randomUUID(),
        label: existing
          ? chooseMergedVariantLabel(existing.label, label, Boolean(existing.imageUrl?.trim()), "scene-time")
          : label,
        description: variant?.description?.trim() || existing?.description || "",
        imageUrl: existing?.imageUrl,
        isAIGenerated: existing?.isAIGenerated ?? false,
        imageHistory: existing?.imageHistory,
    };

    const duplicateIndex = findMatchedVariantIndex(variants, nextVariant, "scene-time");
    if (duplicateIndex >= 0) {
      variants[duplicateIndex] = mergeEntityVariant(variants[duplicateIndex]!, nextVariant, "scene-time");
    } else {
      variants.push(nextVariant);
    }
  });

  const preservedVariants = options?.replaceExisting
    ? []
    : existingVariants.filter((_, index) => !usedExistingIndexes.has(index));
  const mergedVariants = dedupeEntityVariants([...variants, ...preservedVariants], "scene-time");

  return mergedVariants.length ? mergedVariants : undefined;
}

function hasVariantMediaEntries(
  variants: Array<Pick<EntityVariantLike, "imageUrl" | "imageHistory">> | undefined,
): boolean {
  return Boolean(variants?.some((variant) => hasVariantMedia(variant)));
}

function hasCharacterReferenceMedia(character: CharacterSetting): boolean {
  return Boolean(
    character.imageUrl?.trim() ||
    character.audioUrl?.trim() ||
    character.audioFileName?.trim() ||
    Object.values(character.threeViewUrls || {}).some((value) => String(value || "").trim()) ||
    character.imageHistory?.length ||
    hasVariantMediaEntries(character.costumes),
  );
}

function hasSceneReferenceMedia(sceneSetting: SceneSetting): boolean {
  return Boolean(
    sceneSetting.imageUrl?.trim() ||
    sceneSetting.imageHistory?.length ||
    hasVariantMediaEntries(sceneSetting.timeVariants),
  );
}

function chooseMergedEntitySource(
  currentSource: CharacterSetting["source"] | SceneSetting["source"] | undefined,
  nextSource: CharacterSetting["source"] | SceneSetting["source"] | undefined,
): "auto" | "manual" {
  if (currentSource === "manual" || nextSource === "manual") return "manual";
  return "auto";
}

function mergeCharacterSettingsForConsistency(
  current: CharacterSetting,
  next: CharacterSetting,
): CharacterSetting {
  const primary = hasCharacterReferenceMedia(current) || !hasCharacterReferenceMedia(next) ? current : next;
  const secondary = primary === current ? next : current;
  const costumes = dedupeEntityVariants([...(primary.costumes || []), ...(secondary.costumes || [])], "costume");
  const activeCostumeId =
    resolvePreservedVariantId(primary.activeCostumeId, primary.costumes, costumes) ||
    resolvePreservedVariantId(secondary.activeCostumeId, secondary.costumes, costumes);

  return {
    ...primary,
    name: chooseMergedConsistencyEntityName(primary.name, secondary.name, "character"),
    description: chooseMergedVariantDescription(primary.description || "", secondary.description || ""),
    imageUrl: primary.imageUrl || secondary.imageUrl,
    audioUrl: primary.audioUrl || secondary.audioUrl,
    audioFileName: primary.audioFileName || secondary.audioFileName,
    threeViewUrls: primary.threeViewUrls || secondary.threeViewUrls,
    isAIGenerated: primary.isAIGenerated || secondary.isAIGenerated,
    isGenerating: primary.isGenerating || secondary.isGenerating,
    source: chooseMergedEntitySource(primary.source, secondary.source),
    imageHistory: primary.imageHistory || secondary.imageHistory,
    costumes: costumes.length ? costumes : undefined,
    activeCostumeId,
  };
}

function mergeSceneSettingsForConsistency(
  current: SceneSetting,
  next: SceneSetting,
): SceneSetting {
  const primary = hasSceneReferenceMedia(current) || !hasSceneReferenceMedia(next) ? current : next;
  const secondary = primary === current ? next : current;
  const timeVariants = dedupeEntityVariants(
    [...(primary.timeVariants || []), ...(secondary.timeVariants || [])],
    "scene-time",
  );
  const activeTimeVariantId =
    resolvePreservedVariantId(primary.activeTimeVariantId, primary.timeVariants, timeVariants) ||
    resolvePreservedVariantId(secondary.activeTimeVariantId, secondary.timeVariants, timeVariants);

  return {
    ...primary,
    name: chooseMergedConsistencyEntityName(primary.name, secondary.name, "scene"),
    description: chooseMergedVariantDescription(primary.description || "", secondary.description || ""),
    imageUrl: primary.imageUrl || secondary.imageUrl,
    isAIGenerated: primary.isAIGenerated || secondary.isAIGenerated,
    isGenerating: primary.isGenerating || secondary.isGenerating,
    source: chooseMergedEntitySource(primary.source, secondary.source),
    imageHistory: primary.imageHistory || secondary.imageHistory,
    timeVariants: timeVariants.length ? timeVariants : undefined,
    activeTimeVariantId,
  };
}

function dedupeCharacterSettingsWithConsistencyQa(
  characters: CharacterSetting[],
): CharacterSetting[] {
  const deduped: CharacterSetting[] = [];
  for (const character of characters) {
    const existingIndex = deduped.findIndex((item) =>
      areEntityNamesEquivalent(item.name, character.name, "character"),
    );
    if (existingIndex < 0) {
      deduped.push({
        ...character,
        costumes: character.costumes?.length
          ? dedupeEntityVariants(character.costumes, "costume")
          : undefined,
      });
      continue;
    }

    deduped[existingIndex] = mergeCharacterSettingsForConsistency(
      deduped[existingIndex]!,
      character,
    );
  }

  return deduped;
}

function dedupeSceneSettingsWithConsistencyQa(
  sceneSettings: SceneSetting[],
): SceneSetting[] {
  const deduped: SceneSetting[] = [];
  for (const sceneSetting of sceneSettings) {
    const existingIndex = deduped.findIndex((item) =>
      areEntityNamesEquivalent(item.name, sceneSetting.name, "scene"),
    );
    if (existingIndex < 0) {
      deduped.push({
        ...sceneSetting,
        timeVariants: sceneSetting.timeVariants?.length
          ? dedupeEntityVariants(sceneSetting.timeVariants, "scene-time")
          : undefined,
      });
      continue;
    }

    deduped[existingIndex] = mergeSceneSettingsForConsistency(
      deduped[existingIndex]!,
      sceneSetting,
    );
  }

  return deduped;
}

function runEntityExtractionConsistencyQa(params: {
  previousCharacters: CharacterSetting[];
  previousSceneSettings: SceneSetting[];
  nextCharacters: CharacterSetting[];
  nextSceneSettings: SceneSetting[];
}): {
  characters: CharacterSetting[];
  sceneSettings: SceneSetting[];
} {
  return {
    characters: stabilizeNamedEntityOrder(
      params.previousCharacters,
      dedupeCharacterSettingsWithConsistencyQa(params.nextCharacters),
    ),
    sceneSettings: stabilizeNamedEntityOrder(
      params.previousSceneSettings,
      dedupeSceneSettingsWithConsistencyQa(params.nextSceneSettings),
    ),
  };
}

function takeMatchedEntity<T extends { name: string }>(
  items: T[],
  name: string,
  usedIndexes: Set<number>,
  kind: EntityConsistencyKind,
): T | undefined {
  const index = items.findIndex(
    (item, candidateIndex) =>
      !usedIndexes.has(candidateIndex) && areEntityNamesEquivalent(item.name, name, kind),
  );
  if (index < 0) return undefined;
  usedIndexes.add(index);
  return items[index];
}

function takeMatchedVariant<T extends { label: string; description?: string }>(
  items: T[],
  label: string,
  description: string | undefined,
  usedIndexes: Set<number>,
  kind: EntityVariantKind,
): T | undefined {
  const index = findMatchedVariantIndex(items, { label, description }, kind, usedIndexes);
  if (index < 0) return undefined;
  usedIndexes.add(index);
  return items[index];
}

function resolvePreservedVariantId<T extends { id: string; label: string }>(
  previousActiveId: string | undefined,
  previousVariants: T[] | undefined,
  nextVariants: T[] | undefined,
): string | undefined {
  if (!previousActiveId || !nextVariants?.length) return undefined;
  if (nextVariants.some((variant) => variant.id === previousActiveId)) return previousActiveId;

  const previousActive = previousVariants?.find((variant) => variant.id === previousActiveId);
  if (!previousActive) return undefined;
  return nextVariants.find((variant) => normalizeName(variant.label) === normalizeName(previousActive.label))?.id;
}

function clearInvalidCostumeSelections(
  characterCostumes: Scene["characterCostumes"],
  characters: CharacterSetting[],
): Scene["characterCostumes"] {
  if (!characterCostumes) return undefined;
  const nextEntries = Object.entries(characterCostumes)
    .map(([characterName, costumeId]) => {
      const character = characters.find((item) => normalizeName(item.name) === normalizeName(characterName));
      if (!character?.costumes?.length) return null;

      const normalizedValue = String(costumeId || "").trim();
      if (!normalizedValue) return null;

      const directMatch =
        character.costumes.find((costume) => costume.id === normalizedValue) ||
        character.costumes.find((costume) => normalizeName(costume.label) === normalizeName(normalizedValue)) ||
        character.costumes.find((costume) => {
          const label = String(costume.label || "").trim();
          return Boolean(label) && (normalizedValue.includes(label) || label.includes(normalizedValue));
        });

      return directMatch ? ([characterName, directMatch.id] as const) : null;
    })
    .filter((entry): entry is readonly [string, string] => !!entry);
  return nextEntries.length ? Object.fromEntries(nextEntries) : undefined;
}

function clearInvalidSceneTimeVariant(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string | undefined {
  if (!scene.sceneTimeVariantId) return undefined;
  const matchedSetting = findSceneSetting(scene, sceneSettings);
  if (!matchedSetting?.timeVariants?.length) return undefined;

  const normalizedValue = String(scene.sceneTimeVariantId || "").trim();
  if (!normalizedValue) return undefined;

  const matchedVariant =
    matchedSetting.timeVariants.find((variant) => variant.id === normalizedValue) ||
    matchedSetting.timeVariants.find(
      (variant) => normalizeName(variant.label) === normalizeName(normalizedValue),
    ) ||
    matchedSetting.timeVariants.find((variant) => {
      const label = String(variant.label || "").trim();
      return Boolean(label) && (normalizedValue.includes(label) || label.includes(normalizedValue));
    });

  return matchedVariant?.id;
}

function invalidateEntityDependentSceneState(
  scenes: Scene[],
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): Scene[] {
  return scenes.map((scene) => ({
    ...scene,
    characterCostumes: clearInvalidCostumeSelections(scene.characterCostumes, characters),
    sceneTimeVariantId: clearInvalidSceneTimeVariant(scene, sceneSettings),
    enhancedVideoPrompt: undefined,
    recommendedDuration: scene.isManualDuration ? scene.recommendedDuration : undefined,
  }));
}

function buildEntityExtractionVariantSummary(
  variants: Array<{ label?: string; description?: string }>,
): string {
  if (!variants.length) {
    return "无";
  }

  return variants
    .map((variant) => {
      const label = variant.label?.trim() || "未命名变体";
      const description = variant.description?.trim();
      return description ? `${label}：${description}` : label;
    })
    .join("；");
}

function buildEntityExtractionSection(
  title: string,
  items: Array<{ name?: string; description?: string; costumes?: CostumeSetting[]; timeVariants?: TimeVariantSetting[] }>,
  emptyLabel: string,
): string {
  if (!items.length) {
    return [`## ${title}清单`, emptyLabel].join("\n");
  }

  const variantHeader = title === "角色" ? "角色变体" : "场景变体";
  const subjectFallback = title === "角色" ? "角色" : "场景";
  const rows = items.map((item, index) => {
    const name = item.name?.trim() || `${subjectFallback} ${index + 1}`;
    const description = item.description?.trim() || "暂无描述";
    const variants = title === "角色" ? item.costumes ?? [] : item.timeVariants ?? [];
    const variantSummary = buildEntityExtractionVariantSummary(variants);

    return [
      `${index + 1}`,
      escapeSummaryTableCell(name, 18),
      escapeSummaryTableCell(description, 48),
      escapeSummaryTableCell(variantSummary, 56),
    ].join(" | ");
  });

  return [
    `## ${title}清单`,
    `| 序号 | ${title}名 | 描述 | ${variantHeader} |`,
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

function buildEntityExtractionSummary(
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): string {
  const characterVariantCount = characters.reduce((sum, character) => sum + (character.costumes?.length ?? 0), 0);
  const sceneVariantCount = sceneSettings.reduce((sum, sceneSetting) => sum + (sceneSetting.timeVariants?.length ?? 0), 0);
  return [
    `已从脚本中提取 ${characters.length} 个角色与 ${sceneSettings.length} 个场景设定。` +
      (characterVariantCount || sceneVariantCount
        ? `另外识别出 ${characterVariantCount} 个角色变体与 ${sceneVariantCount} 个场景变体。`
        : ""),
    buildEntityExtractionSection("角色", characters, "未识别到明确角色"),
    buildEntityExtractionSection("场景", sceneSettings, "未识别到明确场景"),
  ].join("\n\n");
}

function buildStoryboardBatchSummary(params: {
  generatableCount: number;
  generatedCount: number;
  blockedCount: number;
  totalCount: number;
  storyboardPlan: string;
}): string {
  const { generatableCount, generatedCount, blockedCount, totalCount, storyboardPlan } = params;
  return [
    "已更新分镜摘要。",
    `镜头总数：${totalCount}`,
    `已生成分镜图：${generatedCount} / ${totalCount}`,
    `当前可生成分镜图：${generatableCount} / ${totalCount}`,
    `缺素材镜头：${blockedCount} / ${totalCount}`,
    storyboardPlan.trim() || "本次没有生成新的分镜摘要。",
  ].join("\n\n");
}

function escapeSummaryTableCell(value: string, maxLength = 28): string {
  const normalized = String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "｜")
    .trim();

  if (!normalized) return "待补充";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function buildShotPacketOutline(project: PersistedVideoProject, shotPackets: VideoShotPacket[]): string {
  if (!shotPackets.length) {
    return "当前没有可展示的镜头指令包摘要。";
  }

  const episodeSegmentRe = /^(\d+)-(\d+)$/;
  const sortedPackets = [...shotPackets].sort((left, right) => left.sceneNumber - right.sceneNumber);
  const hasEpisodeSegments = sortedPackets.some((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    return episodeSegmentRe.test(scene?.segmentLabel?.trim() || "");
  });
  const groupedPackets = new Map<string, VideoShotPacket[]>();
  const groupOrder: string[] = [];

  sortedPackets.forEach((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const segmentLabel = scene?.segmentLabel?.trim() || "未分组";
    const groupKey =
      hasEpisodeSegments
        ? episodeSegmentRe.exec(segmentLabel)?.[1] || "1"
        : "__single__";

    if (!groupedPackets.has(groupKey)) {
      groupedPackets.set(groupKey, []);
      groupOrder.push(groupKey);
    }
    groupedPackets.get(groupKey)?.push(packet);
  });

  const sections = groupOrder.map((groupKey) => {
    const groupPackets = groupedPackets.get(groupKey) || [];
    const firstSceneNumber = groupPackets[0]?.sceneNumber ?? 0;
    const lastSceneNumber = groupPackets.at(-1)?.sceneNumber ?? firstSceneNumber;

    const sceneNames: string[] = [];
    const seenNames = new Set<string>();
    for (const packet of groupPackets) {
      const scene = project.scenes.find((item) => item.id === packet.sceneId);
      const name =
        packet.backgroundRef?.name?.trim() ||
        (scene && findSceneSetting(scene, project.sceneSettings || [])?.name?.trim()) ||
        packet.title?.trim() ||
        scene?.sceneName?.trim() ||
        "";
      if (name && !seenNames.has(name)) {
        seenNames.add(name);
        sceneNames.push(name);
      }
    }
    const sceneLabel = sceneNames.length ? sceneNames.join("、") : project.title || "未命名分组";

    return (
      groupKey === "__single__"
        ? `${sceneLabel}：镜头 ${firstSceneNumber}-${lastSceneNumber}，共 ${groupPackets.length} 个`
        : `第 ${groupKey} 集｜${sceneLabel}：镜头 ${firstSceneNumber}-${lastSceneNumber}，共 ${groupPackets.length} 个`
    );
  });

  const totalStart = sortedPackets[0]?.sceneNumber ?? 0;
  const totalEnd = sortedPackets.at(-1)?.sceneNumber ?? totalStart;
  return [
    `已收口 ${shotPackets.length} 个镜头指令包，覆盖镜头 ${totalStart}-${totalEnd}。`,
    "",
    ...sections,
  ].join("\n\n");
}

type SceneCharacterDetail = {
  name: string;
  description: string;
  imageUrl?: string;
  audioUrl?: string;
  audioFileName?: string;
  referenceKind: "character-primary" | "character-costume";
  referenceLabel: string;
  variantLabel?: string;
};

function findCharacterDetails(
  scene: Scene,
  characters: CharacterSetting[],
): SceneCharacterDetail[] {
  const knownNames = new Set(scene.characters.map((name) => normalizeName(name)));
  return characters
    .filter((character) => knownNames.has(normalizeName(character.name)))
    .map((character) => {
      const sceneCostumeId = scene.characterCostumes?.[character.name];
      const costume = sceneCostumeId
        ? (character.costumes || []).find((c) => c.id === sceneCostumeId)
        : (character.costumes || []).find((c) => c.id === character.activeCostumeId);
      return {
        name: character.name,
        description: costume
          ? `${character.description} [服装：${costume.description}]`
          : character.description,
        imageUrl: costume?.imageUrl?.trim() || character.imageUrl,
        audioUrl: character.audioUrl?.trim() || undefined,
        audioFileName: character.audioFileName?.trim() || undefined,
        referenceKind: costume ? "character-costume" : "character-primary",
        referenceLabel: costume
          ? `角色资产图 · ${character.name} · ${costume.label}`
          : `角色资产图 · ${character.name}`,
        variantLabel: costume?.label,
      };
    });
}

function findSceneSetting(scene: Scene, sceneSettings: SceneSetting[]): SceneSetting | undefined {
  const normalizedSceneName = normalizeName(scene.sceneName);
  const exact = sceneSettings.find((s) => normalizeName(s.name) === normalizedSceneName);
  if (exact) return exact;
  const fuzzy = sceneSettings.filter((s) => {
    const n = normalizeName(s.name);
    return normalizedSceneName.includes(n) || n.includes(normalizedSceneName);
  });
  if (!fuzzy.length) return undefined;
  return fuzzy.reduce((best, cur) =>
    normalizeName(cur.name).length > normalizeName(best.name).length ? cur : best,
  );
}

function findSceneReferenceImage(
  scene: Scene,
  sceneSettings: SceneSetting[],
  options?: { excludeStoryboard?: boolean },
): string | undefined {
  if (!options?.excludeStoryboard) {
    if (scene.storyboardUrl?.trim()) return scene.storyboardUrl.trim();
    if (scene.panoramaUrl?.trim()) return scene.panoramaUrl.trim();
  }

  const matchedSetting = findSceneSetting(scene, sceneSettings);
  const matchedVariant = matchedSetting?.timeVariants?.find(
    (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
  );

  if (matchedVariant?.imageUrl?.trim()) return matchedVariant.imageUrl.trim();
  if (matchedSetting?.imageUrl?.trim()) return matchedSetting.imageUrl.trim();
  return undefined;
}

type VideoReferenceDebugInfo = {
  url: string;
  label: string;
  kind:
    | "segment-continuity-frame"
    | "segment-continuity-grid"
    | "segment-continuity-keyframe"
    | "storyboard"
    | "panorama"
    | "scene-primary"
    | "scene-variant"
    | "character-primary"
    | "character-costume";
  entityName?: string;
  variantLabel?: string;
  sceneName?: string;
  sceneNumbers?: number[];
  recapText?: string;
};

function pushUniqueReferenceDebugInfo(
  target: VideoReferenceDebugInfo[],
  value?: VideoReferenceDebugInfo | null,
) {
  const normalizedUrl = String(value?.url || "").trim();
  if (!normalizedUrl) return;
  const normalizedSceneNumbers = Array.isArray(value?.sceneNumbers)
    ? Array.from(
        new Set(
          value.sceneNumbers.filter((sceneNumber): sceneNumber is number => typeof sceneNumber === "number"),
        ),
      ).sort((left, right) => left - right)
    : [];
  const existing = target.find((item) => item.url === normalizedUrl);
  if (existing) {
    const mergedSceneNumbers = Array.from(
      new Set([...(existing.sceneNumbers ?? []), ...normalizedSceneNumbers]),
    ).sort((left, right) => left - right);
    if (mergedSceneNumbers.length) {
      existing.sceneNumbers = mergedSceneNumbers;
    }
    if (!existing.sceneName && value?.sceneName) existing.sceneName = value.sceneName;
    if (!existing.entityName && value?.entityName) existing.entityName = value.entityName;
    if (!existing.variantLabel && value?.variantLabel) existing.variantLabel = value.variantLabel;
    if (!existing.recapText && value?.recapText) existing.recapText = value.recapText;
    return;
  }

  target.push({
    ...value!,
    url: normalizedUrl,
    ...(normalizedSceneNumbers.length ? { sceneNumbers: normalizedSceneNumbers } : {}),
  });
}

function collectSceneReferenceDebugInfo(
  scene: Scene,
  sceneSettings: SceneSetting[],
  characterDetails: SceneCharacterDetail[],
  options?: { excludeStoryboard?: boolean },
): VideoReferenceDebugInfo[] {
  const collected: VideoReferenceDebugInfo[] = [];
  const sceneContext = {
    sceneName: scene.sceneName,
    sceneNumbers: [scene.sceneNumber],
  };

  if (!options?.excludeStoryboard) {
    pushUniqueReferenceDebugInfo(collected, {
      url: scene.storyboardUrl?.trim() || "",
      label: `分镜图 · 镜头 ${scene.sceneNumber} · ${scene.sceneName}`,
      kind: "storyboard",
      ...sceneContext,
    });
    pushUniqueReferenceDebugInfo(collected, {
      url: scene.panoramaUrl?.trim() || "",
      label: `全景图 · 镜头 ${scene.sceneNumber} · ${scene.sceneName}`,
      kind: "panorama",
      ...sceneContext,
    });
  }

  const matchedSetting = findSceneSetting(scene, sceneSettings);
  const matchedVariant = matchedSetting?.timeVariants?.find(
    (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
  );

  pushUniqueReferenceDebugInfo(collected, {
    url: matchedVariant?.imageUrl?.trim() || "",
    label:
      matchedSetting && matchedVariant
        ? `场景资产图 · ${matchedSetting.name} · ${matchedVariant.label}`
        : "",
    kind: "scene-variant",
    entityName: matchedSetting?.name,
    variantLabel: matchedVariant?.label,
    ...sceneContext,
  });
  pushUniqueReferenceDebugInfo(collected, {
    url: matchedSetting?.imageUrl?.trim() || "",
    label: matchedSetting ? `场景资产图 · ${matchedSetting.name}` : "",
    kind: "scene-primary",
    entityName: matchedSetting?.name,
    ...sceneContext,
  });

  characterDetails.forEach((detail) =>
    pushUniqueReferenceDebugInfo(collected, {
      url: detail.imageUrl?.trim() || "",
      label: detail.referenceLabel,
      kind: detail.referenceKind,
      entityName: detail.name,
      variantLabel: detail.variantLabel,
      ...sceneContext,
    }),
  );

  return collected.slice(0, 9);
}

function collectSceneReferenceImages(
  scene: Scene,
  sceneSettings: SceneSetting[],
  characterDetails: SceneCharacterDetail[],
  options?: { excludeStoryboard?: boolean },
): string[] {
  return collectSceneReferenceDebugInfo(
    scene,
    sceneSettings,
    characterDetails,
    options,
  ).map((item) => item.url);
}

function collectSceneReferenceAudioUrls(characterDetails: SceneCharacterDetail[]): string[] {
  const urls = characterDetails
    .map((detail) => detail.audioUrl?.trim() || "")
    .filter((url) => hasUsableMediaUrl(url));
  return Array.from(new Set(urls));
}

function dedupeVideoReferenceDebugInfo(
  items: VideoReferenceDebugInfo[],
  maxCount = 9,
): VideoReferenceDebugInfo[] {
  const deduped: VideoReferenceDebugInfo[] = [];
  items.forEach((item) => {
    if (deduped.length >= maxCount) return;
    pushUniqueReferenceDebugInfo(deduped, item);
  });
  return deduped.slice(0, maxCount);
}

function formatVideoReferenceIndexRange(startIndex: number, count: number): string {
  if (!Number.isFinite(startIndex) || startIndex <= 0 || !Number.isFinite(count) || count <= 0) {
    return "";
  }
  if (count === 1) return `第${startIndex}张`;
  return `第${startIndex}-${startIndex + count - 1}张`;
}

function formatVideoReferenceFigureLabel(index: number): string {
  return Number.isFinite(index) && index > 0 ? `图片 ${index}` : "图片";
}

function buildVideoReferenceSceneTag(item: VideoReferenceDebugInfo): string {
  const sceneName = String(item.sceneName || "").trim();
  return sceneName ? `（${sceneName}）` : "";
}

function buildVideoReferenceAnchorTag(item: VideoReferenceDebugInfo): string {
  const entityName = String(item.entityName || "").trim();
  const variantLabel = String(item.variantLabel || "").trim();
  if (entityName && variantLabel) return `（${entityName}·${variantLabel}）`;
  if (entityName) return `（${entityName}）`;
  if (variantLabel) return `（${variantLabel}）`;
  return "";
}

function buildVideoReferenceUsageLine(params: {
  item: VideoReferenceDebugInfo;
  index: number;
  strictTextToVideoContinuity: boolean;
  currentHeadSceneNumber?: number;
  currentTailSceneNumber?: number;
  currentSceneNumberSet: Set<number>;
}): string {
  const { item, index, strictTextToVideoContinuity, currentHeadSceneNumber, currentTailSceneNumber, currentSceneNumberSet } = params;
  const figureLabel = formatVideoReferenceFigureLabel(index);
  const sceneNumbers = Array.isArray(item.sceneNumbers)
    ? item.sceneNumbers.filter((value): value is number => Number.isFinite(value))
    : [];
  const belongsToCurrentHead =
    currentHeadSceneNumber != null && sceneNumbers.includes(currentHeadSceneNumber);
  const belongsToCurrentTail =
    currentTailSceneNumber != null && sceneNumbers.includes(currentTailSceneNumber);
  const belongsToCurrentSegment = sceneNumbers.some((value) => currentSceneNumberSet.has(value));

  switch (item.kind) {
    case "segment-continuity-frame":
      return strictTextToVideoContinuity
        ? `${figureLabel}：上传的上一片段真实末帧${buildVideoReferenceSceneTag(item)}为本段首镜直接接拍基准。人物姿态、站位、视线方向、镜头轴线、主光方向与环境动势必须先完全对齐，再从尚未收完的动作结果继续推进。`
        : `${figureLabel}：上传的上一片段真实末帧${buildVideoReferenceSceneTag(item)}为本段首镜直接接拍基准。人物姿态、站位、视线方向、镜头轴线和光影氛围都要与该尾帧保持连续。`;
    case "segment-continuity-keyframe":
      return `${figureLabel}：动作延续关键帧${buildVideoReferenceSceneTag(item)}，补足上一段到本段之间的动作惯性、角色位移、镜头延续和时间线落点，不改首镜起拍关系。`;
    case "segment-continuity-grid":
      return buildSegmentContinuityGridReferenceUsageLine(figureLabel, item);
    case "storyboard":
      if (belongsToCurrentHead && belongsToCurrentTail) {
        return `${figureLabel}：本段分镜图${buildVideoReferenceSceneTag(item)}，补镜头构图、角色位置和时间线落点，不改首镜起拍关系。`;
      }
      if (belongsToCurrentHead) {
        return `${figureLabel}：本段开场分镜图${buildVideoReferenceSceneTag(item)}，补开场构图和角色位置，不改首镜起拍关系。`;
      }
      if (belongsToCurrentTail) {
        return `${figureLabel}：本段收尾分镜图${buildVideoReferenceSceneTag(item)}，补收尾构图和停点落位，不改首镜起拍关系。`;
      }
      if (belongsToCurrentSegment) {
        return `${figureLabel}：本段中段分镜图${buildVideoReferenceSceneTag(item)}，补中段构图和动作落点，不改首镜起拍关系。`;
      }
      return `${figureLabel}：相邻时间线分镜图${buildVideoReferenceSceneTag(item)}，只补时间线衔接，不改首镜起拍关系。`;
    case "panorama":
      if (belongsToCurrentHead && belongsToCurrentTail) {
        return `${figureLabel}：本段全景图${buildVideoReferenceSceneTag(item)}，补空间关系和整体调度，不改首镜起拍关系。`;
      }
      if (belongsToCurrentHead) {
        return `${figureLabel}：本段开场全景图${buildVideoReferenceSceneTag(item)}，补空间关系和开场调度，不改首镜起拍关系。`;
      }
      if (belongsToCurrentTail) {
        return `${figureLabel}：本段收尾全景图${buildVideoReferenceSceneTag(item)}，补收尾空间关系和落点调度，不改首镜起拍关系。`;
      }
      if (belongsToCurrentSegment) {
        return `${figureLabel}：本段全景图${buildVideoReferenceSceneTag(item)}，补空间关系和镜头调度，不改首镜起拍关系。`;
      }
      return `${figureLabel}：相邻时间线全景图${buildVideoReferenceSceneTag(item)}，只补空间连续性，不改首镜起拍关系。`;
    case "scene-primary":
      return `${figureLabel}：场景资产图${buildVideoReferenceAnchorTag(item)}，只补场景锚点，不改首镜起拍关系。`;
    case "scene-variant":
      return `${figureLabel}：场景资产图${buildVideoReferenceAnchorTag(item)}，补当前时段场景状态，不改首镜起拍关系。`;
    case "character-primary":
      return `${figureLabel}：角色资产图${buildVideoReferenceAnchorTag(item)}，只补角色身份锚点，不改首镜起拍关系。`;
    case "character-costume":
      return `${figureLabel}：角色资产图${buildVideoReferenceAnchorTag(item)}，只补服装和造型锚点，不改首镜起拍关系。`;
    default:
      return `${figureLabel}：参考图${buildVideoReferenceSceneTag(item) || buildVideoReferenceAnchorTag(item)}，只补连续性锚点，不改首镜起拍关系。`;
  }
}

function buildSegmentReferenceUsageSummary(
  referenceDebugInfo: VideoReferenceDebugInfo[],
  currentSceneNumbers?: number[],
  options?: {
    strictTextToVideoContinuity?: boolean;
  },
): string {
  const orderedItems = Array.isArray(referenceDebugInfo)
    ? referenceDebugInfo.filter((item) => hasUsableMediaUrl(item?.url))
    : [];
  if (!orderedItems.length) return "";
  const strictTextToVideoContinuity = options?.strictTextToVideoContinuity === true;
  const currentSceneNumberSet = new Set(
    Array.isArray(currentSceneNumbers)
      ? currentSceneNumbers.filter((value): value is number => Number.isFinite(value))
      : [],
  );
  const orderedCurrentSceneNumbers = Array.from(currentSceneNumberSet).sort((left, right) => left - right);
  const currentHeadSceneNumber = orderedCurrentSceneNumbers[0];
  const currentTailSceneNumber = orderedCurrentSceneNumbers.at(-1);

  const lines = orderedItems.map((item, index) => {
    if (item.kind === "segment-continuity-grid") {
      return buildSegmentContinuityGridReferenceUsageLine(`图片 ${index + 1}`, item);
    }
    return buildVideoReferenceUsageLine({
      item,
      index: index + 1,
      strictTextToVideoContinuity,
      currentHeadSceneNumber,
      currentTailSceneNumber,
      currentSceneNumberSet,
    });
  });

  return lines.join("\n");
}

function compressSegmentContinuityCue(
  text: string,
  maxChars: number,
  options?: {
    stripLeadingTags?: boolean;
  },
): string {
  let normalized = String(text || "")
    .replace(/[“”"'「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (options?.stripLeadingTags) {
    let next = normalized;
    for (let index = 0; index < 2; index += 1) {
      const stripped = next.replace(/^[^：:\s]{1,16}[:：]\s*/, "");
      if (stripped === next) break;
      next = stripped.trim();
    }
    normalized = next;
  }
  return fitVideoSubmissionTextToNaturalBoundary(normalized, maxChars);
}

function buildSegmentContinuityRecapUsageCue(recapText: string): string {
  const normalized = String(recapText || "")
    .replace(/\s+/g, " ")
    .replace(/^前情提要[：:]\s*/u, "")
    .trim();
  if (!normalized) return "";

  const rawSentences = normalized
    .split(/(?<=[。！？])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (!rawSentences.length) return "";

  const cleanedSentences = rawSentences
    .map((sentence) =>
      sentence
        .replace(/[。！？]+$/u, "")
        .replace(/^(随着|最终)[，,\s]*/u, "")
        .replace(/^上一段/u, "")
        .trim(),
    )
    .filter(Boolean);
  if (!cleanedSentences.length) return "";

  const preferredSentence =
    cleanedSentences[Math.min(1, cleanedSentences.length - 1)] ||
    cleanedSentences[0] ||
    "";

  return compressSegmentContinuityCue(preferredSentence, 56, {
    stripLeadingTags: true,
  })
    .replace(/^上一段/u, "")
    .trim();
}

function buildSegmentContinuityGridUsageTail(item: VideoReferenceDebugInfo): string {
  const dynamicCue = buildSegmentContinuityRecapUsageCue(String(item.recapText || ""));
  if (dynamicCue) {
    return `保持完全一致的人物状态、镜头运动、动作惯性、烟尘漂浮与光影氛围，并把上一段“${dynamicCue}”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜，保持电影级时间连续性。`;
  }
  return "";
}

function buildSegmentContinuityGridReferenceUsageLine(
  figureLabel: string,
  item: VideoReferenceDebugInfo,
): string {
  const usageTail = buildSegmentContinuityGridUsageTail(item);
  return `${figureLabel}：上传的六宫格图片为上一段视频的连续时间参考。六张画面按照：左→右、上→下 进行时间推进排列。第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。本段视频必须从六宫格最后一格尾帧画面状态直接开始${usageTail ? `，${usageTail}` : "。"}`;
}

type SegmentContinuityReferenceBundle = {
  primaryReferenceImageUrl?: string;
  referenceImageUrls: string[];
  referenceDebugInfo: VideoReferenceDebugInfo[];
};

function collectSceneTemporalReferenceDebugInfo(
  scene: Scene | undefined,
  sceneSettings: SceneSetting[],
  characters: CharacterSetting[],
): VideoReferenceDebugInfo[] {
  if (!scene) return [];
  return collectSceneReferenceDebugInfo(
    scene,
    sceneSettings,
    findCharacterDetails(scene, characters),
    { excludeStoryboard: false },
  ).filter((item) => item.kind === "storyboard" || item.kind === "panorama");
}

function collectSegmentContinuityReferenceBundle(params: {
  modelKey?: string | null;
  mode?: string;
  currentScenes: Scene[];
  previousScenes?: Scene[];
  previousSegmentContinuityFrameUrl?: string | null;
  previousSegmentContinuityGridImage?: {
    imageUrl: string;
    recapText?: string;
    frameUrls?: string[];
  } | null;
  previousSegmentContinuityFrameSetUrls?: string[] | null;
  sceneSettings: SceneSetting[];
  characters: CharacterSetting[];
}): SegmentContinuityReferenceBundle {
  const orderedCurrentScenes = [...params.currentScenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const orderedPreviousScenes = [...(params.previousScenes ?? [])].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const currentHeadScene = orderedCurrentScenes[0];
  const currentTailScene = orderedCurrentScenes.at(-1);
  const previousTailScene = orderedPreviousScenes.at(-1);
  const supportsMultiReferenceImages = videoModelSupportsMultiReferenceImages(params.modelKey);
  const shouldUseContinuityGridAsPrimaryReference =
    hasUsableMediaUrl(params.previousSegmentContinuityGridImage?.imageUrl);
  const prioritizedDebugInfo: VideoReferenceDebugInfo[] = [];
  const pushItems = (items: VideoReferenceDebugInfo[]) => {
    items.forEach((item) => pushUniqueReferenceDebugInfo(prioritizedDebugInfo, item));
  };

  const currentHeadPrimaryImageUrl = currentHeadScene
    ? findSceneReferenceImage(currentHeadScene, params.sceneSettings, { excludeStoryboard: true })
    : undefined;
  const currentHeadPrimaryDebugInfo = currentHeadScene
    ? collectSceneReferenceDebugInfo(
        currentHeadScene,
        params.sceneSettings,
        findCharacterDetails(currentHeadScene, params.characters),
        { excludeStoryboard: true },
      ).find((item) => item.url === currentHeadPrimaryImageUrl)
    : undefined;
  const previousTailTemporalDebugInfo = collectSceneTemporalReferenceDebugInfo(
    previousTailScene,
    params.sceneSettings,
    params.characters,
  );
  const currentHeadTemporalDebugInfo = collectSceneTemporalReferenceDebugInfo(
    currentHeadScene,
    params.sceneSettings,
    params.characters,
  );
  const previousSegmentContinuityDebugInfo: VideoReferenceDebugInfo[] = hasUsableMediaUrl(
    params.previousSegmentContinuityFrameUrl,
  )
    ? [
        {
          url: String(params.previousSegmentContinuityFrameUrl).trim(),
          label: previousTailScene?.sceneName
            ? `上一片段真实末帧：${previousTailScene.sceneName}`
            : "上一片段真实末帧",
          kind: "segment-continuity-frame",
          sceneName: previousTailScene?.sceneName,
          ...(typeof previousTailScene?.sceneNumber === "number"
            ? { sceneNumbers: [previousTailScene.sceneNumber] }
            : {}),
        },
      ]
    : [];
  const previousSegmentContinuityGridDebugInfo: VideoReferenceDebugInfo[] = hasUsableMediaUrl(
    params.previousSegmentContinuityGridImage?.imageUrl,
  )
    ? [
        {
          url: String(params.previousSegmentContinuityGridImage?.imageUrl).trim(),
          label: previousTailScene?.sceneName
            ? `上一片段六宫格前情图：${previousTailScene.sceneName}`
            : "上一片段六宫格前情图",
          kind: "segment-continuity-grid",
          sceneName: previousTailScene?.sceneName,
          recapText: String(params.previousSegmentContinuityGridImage?.recapText || "").trim() || undefined,
          ...(typeof previousTailScene?.sceneNumber === "number"
            ? { sceneNumbers: [previousTailScene.sceneNumber] }
            : {}),
        },
      ]
    : [];
  const previousSegmentContinuityKeyframeDebugInfo = (
    Array.isArray(params.previousSegmentContinuityFrameSetUrls)
      ? params.previousSegmentContinuityFrameSetUrls
      : []
  )
    .map((url, index) => String(url || "").trim())
    .filter((url) => hasUsableMediaUrl(url))
    .map((url, index) => ({
      url,
      label: previousTailScene?.sceneName
        ? `上一片段关键帧${index + 1}：${previousTailScene.sceneName}`
        : `上一片段关键帧${index + 1}`,
      kind: "segment-continuity-keyframe" as const,
      sceneName: previousTailScene?.sceneName,
      ...(typeof previousTailScene?.sceneNumber === "number"
        ? { sceneNumbers: [previousTailScene.sceneNumber] }
        : {}),
    }));
  const currentTailTemporalDebugInfo =
    currentTailScene && currentTailScene.id !== currentHeadScene?.id
      ? collectSceneTemporalReferenceDebugInfo(currentTailScene, params.sceneSettings, params.characters)
      : [];
  const currentSegmentAnchorDebugInfo = dedupeVideoReferenceDebugInfo(
    orderedCurrentScenes.flatMap((scene) =>
      collectSceneReferenceDebugInfo(
        scene,
        params.sceneSettings,
        findCharacterDetails(scene, params.characters),
        { excludeStoryboard: true },
      ),
    ),
    9,
  );

  if (shouldUseContinuityGridAsPrimaryReference) {
    pushItems(previousSegmentContinuityGridDebugInfo);
    pushItems(currentSegmentAnchorDebugInfo);
  } else if (params.mode === "image-to-video") {
    pushItems(previousSegmentContinuityDebugInfo);
    pushItems(previousSegmentContinuityGridDebugInfo);
    if (!previousSegmentContinuityGridDebugInfo.length) {
      pushItems(previousSegmentContinuityKeyframeDebugInfo);
    }
    if (currentHeadPrimaryDebugInfo) {
      pushUniqueReferenceDebugInfo(prioritizedDebugInfo, currentHeadPrimaryDebugInfo);
    }
    pushItems(previousTailTemporalDebugInfo);
    pushItems(currentHeadTemporalDebugInfo);
    pushItems(currentTailTemporalDebugInfo);
    pushItems(currentSegmentAnchorDebugInfo);
  } else if (supportsMultiReferenceImages) {
    pushItems(previousSegmentContinuityDebugInfo);
    pushItems(previousSegmentContinuityGridDebugInfo);
    if (!previousSegmentContinuityGridDebugInfo.length) {
      pushItems(previousSegmentContinuityKeyframeDebugInfo);
    }
    pushItems(previousTailTemporalDebugInfo);
    pushItems(currentHeadTemporalDebugInfo);
    pushItems(currentTailTemporalDebugInfo);
    pushItems(currentSegmentAnchorDebugInfo);
  } else {
    pushItems(previousSegmentContinuityDebugInfo);
    pushItems(previousSegmentContinuityGridDebugInfo.slice(0, 1));
    if (!previousSegmentContinuityGridDebugInfo.length) {
      pushItems(previousSegmentContinuityKeyframeDebugInfo.slice(0, 1));
    }
    pushItems(currentSegmentAnchorDebugInfo);
  }

  const referenceDebugInfo = dedupeVideoReferenceDebugInfo(prioritizedDebugInfo, 9);
  const referenceImageUrls = referenceDebugInfo.map((item) => item.url);
  const primaryReferenceImageUrl =
    shouldUseContinuityGridAsPrimaryReference
      ? referenceImageUrls[0]
      : params.mode === "image-to-video"
      ? String(params.previousSegmentContinuityFrameUrl || "").trim() ||
        currentHeadPrimaryImageUrl?.trim() ||
        referenceImageUrls[0]
      : supportsMultiReferenceImages
        ? referenceImageUrls[0]
        : undefined;

  return {
    primaryReferenceImageUrl: primaryReferenceImageUrl?.trim() || undefined,
    referenceImageUrls,
    referenceDebugInfo,
  };
}

function selectSegmentSubmissionReferenceBundle(params: {
  provider?: string | null;
  continuityFrameUrl?: string | null;
  mode?: string | null;
  currentHeadSceneNumber?: number | null;
  currentTailSceneNumber?: number | null;
  currentSceneNumbers?: number[] | null;
  baseBundle: SegmentContinuityReferenceBundle;
}): SegmentContinuityReferenceBundle {
  const provider = String(params.provider || "")
    .trim()
    .toLowerCase();
  const continuityFrameUrl = String(params.continuityFrameUrl || "").trim();
  const hasContinuityFrame = hasUsableMediaUrl(continuityFrameUrl);
  const hasContinuityGrid = params.baseBundle.referenceDebugInfo.some(
    (item) => item.kind === "segment-continuity-grid",
  );
  const hasContinuityKeyframes = params.baseBundle.referenceDebugInfo.some(
    (item) => item.kind === "segment-continuity-keyframe",
  );
  if (!hasContinuityFrame && !hasContinuityGrid && !hasContinuityKeyframes) {
    return params.baseBundle;
  }

  const continuityItem = hasContinuityFrame
    ? params.baseBundle.referenceDebugInfo.find(
        (item) =>
          item.kind === "segment-continuity-frame" && item.url.trim() === continuityFrameUrl,
      ) ??
      params.baseBundle.referenceDebugInfo.find((item) => item.url.trim() === continuityFrameUrl)
    : undefined;
  if (hasContinuityFrame && !continuityItem) {
    return params.baseBundle;
  }

  const currentSceneNumbers = new Set(
    Array.isArray(params.currentSceneNumbers)
      ? params.currentSceneNumbers.filter((value): value is number => Number.isFinite(value))
      : [],
  );
  const currentHeadSceneNumber = Number.isFinite(params.currentHeadSceneNumber)
    ? Number(params.currentHeadSceneNumber)
    : null;
  const currentTailSceneNumber = Number.isFinite(params.currentTailSceneNumber)
    ? Number(params.currentTailSceneNumber)
    : null;
  const currentHeadSceneItems = (items: VideoReferenceDebugInfo[]) =>
    items.filter((item) => item.sceneNumbers?.includes(currentHeadSceneNumber ?? NaN));
  const currentTailSceneItems = (items: VideoReferenceDebugInfo[]) =>
    items.filter((item) => item.sceneNumbers?.includes(currentTailSceneNumber ?? NaN));
  const currentSegmentItems = (items: VideoReferenceDebugInfo[]) =>
    items.filter((item) => item.sceneNumbers?.some((value) => currentSceneNumbers.has(value)));
  const previousTimelineItems = (items: VideoReferenceDebugInfo[]) =>
    items.filter((item) => !item.sceneNumbers?.some((value) => currentSceneNumbers.has(value)));
  const sortTimelineFirst = (items: VideoReferenceDebugInfo[]) => {
    const prioritized: VideoReferenceDebugInfo[] = [];
    currentHeadSceneItems(items).forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    currentTailSceneItems(items).forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    currentSegmentItems(items).forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    previousTimelineItems(items).forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    items.forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    return prioritized;
  };

  const referenceItemsWithoutContinuity = params.baseBundle.referenceDebugInfo.filter(
    (item) => !hasContinuityFrame || item.url.trim() !== continuityFrameUrl,
  );
  const temporalItems = sortTimelineFirst(
    referenceItemsWithoutContinuity.filter(
      (item) => item.kind === "storyboard" || item.kind === "panorama",
    ),
  );
  const continuityGridItems = sortTimelineFirst(
    referenceItemsWithoutContinuity.filter((item) => item.kind === "segment-continuity-grid"),
  );
  const continuityKeyframeItems = sortTimelineFirst(
    referenceItemsWithoutContinuity.filter((item) => item.kind === "segment-continuity-keyframe"),
  );
  const anchorItems = sortTimelineFirst(
    referenceItemsWithoutContinuity.filter(
      (item) =>
        item.kind === "scene-primary" ||
        item.kind === "scene-variant" ||
        item.kind === "character-primary" ||
        item.kind === "character-costume",
    ),
  );

  const currentHeadTemporalItems = currentHeadSceneItems(temporalItems);
  const currentTailTemporalItems = currentTailSceneItems(temporalItems).filter(
    (item) => !currentHeadTemporalItems.some((existing) => existing.url === item.url),
  );
  const previousTimelineTemporalItems = previousTimelineItems(temporalItems);
  const currentHeadAnchorItems = currentHeadSceneItems(anchorItems);
  const currentSegmentAnchorItems = currentSegmentItems(anchorItems);
  const currentAnchorCandidates = currentSegmentAnchorItems.length
    ? currentSegmentAnchorItems
    : currentHeadAnchorItems.length
      ? currentHeadAnchorItems
      : anchorItems;
  const prioritizedDynamicAnchorItems = (() => {
    const prioritizedAnchors: VideoReferenceDebugInfo[] = [];
    const pushFirstPerEntity = (
      source: VideoReferenceDebugInfo[],
      preferredKinds: Array<VideoReferenceDebugInfo["kind"]>,
    ) => {
      const seenEntities = new Set<string>();
      preferredKinds.forEach((kind) => {
        source
          .filter((item) => item.kind === kind)
          .forEach((item) => {
            const entityKey = `${kind.startsWith("scene-") ? "scene" : "character"}:${String(item.entityName || item.url).trim()}`;
            if (seenEntities.has(entityKey)) return;
            seenEntities.add(entityKey);
            pushUniqueReferenceDebugInfo(prioritizedAnchors, item);
          });
      });
    };
    pushFirstPerEntity(currentHeadAnchorItems, ["scene-variant", "scene-primary"]);
    pushFirstPerEntity(currentAnchorCandidates, ["scene-variant", "scene-primary"]);
    pushFirstPerEntity(currentHeadAnchorItems, ["character-costume", "character-primary"]);
    pushFirstPerEntity(currentAnchorCandidates, ["character-costume", "character-primary"]);

    if (!prioritizedAnchors.length) {
      pushFirstPerEntity(anchorItems, ["scene-variant", "scene-primary", "character-costume", "character-primary"]);
    }

    return prioritizedAnchors;
  })();
  const normalizedMode =
    params.mode === "image-to-video" ? "image-to-video" : "text-to-video";
  const isRunningHubSeedance = provider.startsWith("runninghub-seedance");
  const preferredContinuityKeyframeCount = isRunningHubSeedance
    ? 3
    : normalizedMode === "image-to-video"
      ? 2
      : 1;
  const shouldPrioritizeContinuityGridOnly = continuityGridItems.length > 0;
  const useContinuityKeyframeItems = !shouldPrioritizeContinuityGridOnly;
  const leadingContinuityKeyframeItems = useContinuityKeyframeItems
    ? continuityKeyframeItems.slice(0, preferredContinuityKeyframeCount)
    : [];
  const trailingContinuityKeyframeItems = useContinuityKeyframeItems
    ? continuityKeyframeItems.slice(preferredContinuityKeyframeCount)
    : [];

  const prioritized: VideoReferenceDebugInfo[] = [];
  const shouldUseGridAndAnchorOnly = shouldPrioritizeContinuityGridOnly;
  if (shouldUseGridAndAnchorOnly) {
    if (continuityGridItems[0]) pushUniqueReferenceDebugInfo(prioritized, continuityGridItems[0]);
    prioritizedDynamicAnchorItems.forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
  } else {
    if (continuityItem) pushUniqueReferenceDebugInfo(prioritized, continuityItem);
    if (continuityGridItems[0]) pushUniqueReferenceDebugInfo(prioritized, continuityGridItems[0]);
    leadingContinuityKeyframeItems.forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    if (currentHeadTemporalItems[0]) pushUniqueReferenceDebugInfo(prioritized, currentHeadTemporalItems[0]);
    if (currentTailTemporalItems[0]) pushUniqueReferenceDebugInfo(prioritized, currentTailTemporalItems[0]);
    if (!continuityItem && previousTimelineTemporalItems[0]) {
      pushUniqueReferenceDebugInfo(prioritized, previousTimelineTemporalItems[0]);
    }
    prioritizedDynamicAnchorItems.forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
    trailingContinuityKeyframeItems.forEach((item) => pushUniqueReferenceDebugInfo(prioritized, item));
  }
  if (!prioritized.length) {
    return params.baseBundle;
  }

  const maxReferenceCount = isRunningHubSeedance
    ? 6
    : normalizedMode === "image-to-video"
      ? 5
      : 4;
  const referenceDebugInfo = dedupeVideoReferenceDebugInfo(prioritized, maxReferenceCount);
  if (!referenceDebugInfo.length) {
    return params.baseBundle;
  }
  if (continuityItem) {
    const continuityIndex = referenceDebugInfo.findIndex((item) => item.url.trim() === continuityItem.url.trim());
    if (continuityIndex > 0) {
      const [forcedLeadingItem] = referenceDebugInfo.splice(continuityIndex, 1);
      referenceDebugInfo.unshift(forcedLeadingItem);
    }
  }

  return {
    primaryReferenceImageUrl:
      referenceDebugInfo[0]?.url?.trim() ||
      continuityFrameUrl ||
      params.baseBundle.primaryReferenceImageUrl,
    referenceImageUrls: referenceDebugInfo.map((item) => item.url),
    referenceDebugInfo,
  };
}

type VideoGenerationReferencePayload = {
  imageUrl?: string;
  referenceImageUrls?: string[];
  preferFirstFrameReference?: boolean;
};

function shouldKeepStrictSegmentTextToVideoContinuity(requestedMode?: string | null): boolean {
  return requestedMode !== "image-to-video";
}

function canUseStrictTextToVideoReferenceChain(params: {
  provider?: string | null;
  modelKey?: string | null;
}): boolean {
  if (!videoModelSupportsMultiReferenceImages(params.modelKey)) {
    return false;
  }

  const provider = String(params.provider || "")
    .trim()
    .toLowerCase();
  if (provider === "runninghub-seedance" || provider === "runninghub-seedance-fast") {
    return true;
  }

  if (provider === "jimeng") {
    return isArkJimengEndpoint(getApiConfig().jimengEndpoint);
  }

  return false;
}

function shouldPreferSegmentOpeningFrameReference(params: {
  strictTextToVideoContinuity: boolean;
  provider?: string | null;
  modelKey?: string | null;
  continuityFrameUrl?: string | null;
  continuityKeyframeUrls?: string[] | null;
}): boolean {
  const hasContinuityFrame = hasUsableMediaUrl(params.continuityFrameUrl);
  const hasContinuityKeyframes = Array.isArray(params.continuityKeyframeUrls)
    ? params.continuityKeyframeUrls.some((url) => hasUsableMediaUrl(url))
    : false;
  if (params.strictTextToVideoContinuity) {
    return (
      hasContinuityFrame &&
      canUseStrictTextToVideoReferenceChain({
        provider: params.provider,
        modelKey: params.modelKey,
      })
    );
  }
  return hasContinuityFrame || hasContinuityKeyframes;
}

function collectSubmittedReferenceImageUrls(payload: VideoGenerationReferencePayload): string[] {
  return Array.from(
    new Set(
      [payload.imageUrl, ...(Array.isArray(payload.referenceImageUrls) ? payload.referenceImageUrls : [])]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function filterSubmittedReferenceDebugInfo(
  referenceDebugInfo: VideoReferenceDebugInfo[],
  submittedUrls: string[],
): VideoReferenceDebugInfo[] {
  if (!Array.isArray(referenceDebugInfo) || !submittedUrls.length) return [];
  const ordered: VideoReferenceDebugInfo[] = [];
  submittedUrls.forEach((url) => {
    const match = referenceDebugInfo.find((item) => item.url.trim() === url);
    if (match) {
      pushUniqueReferenceDebugInfo(ordered, match);
    }
  });
  return ordered;
}

function resolveVideoGenerationReferencePayload(options: {
  mode?: string;
  provider?: string | null;
  modelKey?: string | null;
  primaryReferenceImageUrl?: string | null;
  referenceImageUrls?: string[] | null;
  preferFirstFrameReference?: boolean;
  strictTextToVideoContinuity?: boolean;
}): VideoGenerationReferencePayload {
  const normalizedReferences = Array.from(
    new Set(
      [
        options.primaryReferenceImageUrl,
        ...(Array.isArray(options.referenceImageUrls) ? options.referenceImageUrls : []),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 9);

  if (!normalizedReferences.length) return {};

  const strictTextToVideoContinuity =
    options.strictTextToVideoContinuity === true && options.mode !== "image-to-video";
  if (strictTextToVideoContinuity) {
    if (!canUseStrictTextToVideoReferenceChain({ provider: options.provider, modelKey: options.modelKey })) {
      return {};
    }

    if (options.preferFirstFrameReference && normalizedReferences.length) {
      return {
        imageUrl: normalizedReferences[0],
        referenceImageUrls: normalizedReferences,
        preferFirstFrameReference: true,
      };
    }

    return {
      referenceImageUrls: normalizedReferences,
    };
  }

  if (options.mode === "image-to-video") {
    return {
      imageUrl: normalizedReferences[0],
      referenceImageUrls: normalizedReferences,
      ...(options.preferFirstFrameReference ? { preferFirstFrameReference: true } : {}),
    };
  }

  if (options.preferFirstFrameReference && normalizedReferences.length) {
    return {
      imageUrl: normalizedReferences[0],
      referenceImageUrls: normalizedReferences,
      preferFirstFrameReference: true,
    };
  }

  if (
    videoModelSupportsMultiReferenceImages(options.modelKey) &&
    normalizedReferences.length > 1
  ) {
    return {
      imageUrl: normalizedReferences[0],
      referenceImageUrls: normalizedReferences,
      ...(options.preferFirstFrameReference ? { preferFirstFrameReference: true } : {}),
    };
  }

  return {};
}

function hasVideoGenerationReferencePayload(
  payload: VideoGenerationReferencePayload,
): boolean {
  return Boolean(
    String(payload.imageUrl || "").trim() ||
      (Array.isArray(payload.referenceImageUrls) &&
        payload.referenceImageUrls.some((url) => String(url || "").trim())),
  );
}

function appendVideoProgressDetail(summary: string, detail?: string | null): string {
  const normalizedDetail = String(detail || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedDetail) return summary;
  return `${summary} · ${truncate(normalizedDetail, 180)}`;
}

function resolveVideoProgressProviderLabel(provider?: string | null): string {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "视频通道";
  if (normalized === "aliyun") return "HappyHorse";
  if (normalized === "tuzi") return "Tuzi / Sora 2";
  if (normalized === "ark") return "Ark / Seedance";
  if (normalized === "jimeng") return "Seedance / Ark";
  if (normalized === "runninghub-happyhorse") return "RunningHub HappyHorse";
  if (normalized === "runninghub-seedance-fast") return "RunningHub Seedance Fast";
  if (normalized.startsWith("runninghub-seedance")) return "RunningHub Seedance";
  return provider || "视频通道";
}

function describeVideoProgressStatus(status?: string | null): string {
  const normalized = normalizeSceneStatus(String(status || ""));
  if (normalized === "completed") return "已完成";
  if (normalized === "failed") return "失败";
  if (normalized === "queued") return "排队中";
  return "生成中";
}

function summarizeVideoReferenceNamesForProgress(
  items?: VideoReferenceDebugInfo[] | null,
  maxCount = 3,
): string {
  const labels = Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => {
          const entityName = String(item.entityName || "").trim();
          const variantLabel = String(item.variantLabel || "").trim();
          const sceneName = String(item.sceneName || "").trim();
          if (entityName && variantLabel) return `${entityName}（${variantLabel}）`;
          return entityName || sceneName || String(item.label || "").trim();
        })
        .filter(Boolean),
    ),
  );
  if (!labels.length) return "";
  if (labels.length <= maxCount) return labels.join("、");
  return `${labels.slice(0, maxCount).join("、")} 等 ${labels.length} 项`;
}

function countVideoReferenceAssets(payload: VideoGenerationReferencePayload): number {
  if (Array.isArray(payload.referenceImageUrls)) {
    const normalizedReferences = Array.from(
      new Set(payload.referenceImageUrls.map((url) => String(url || "").trim()).filter(Boolean)),
    );
    if (normalizedReferences.length) return normalizedReferences.length;
  }
  return String(payload.imageUrl || "").trim() ? 1 : 0;
}

function buildVideoSubmitProgressDetail(params: {
  provider?: string | null;
  referencePayload: VideoGenerationReferencePayload;
  referenceDebugInfo?: VideoReferenceDebugInfo[] | null;
}): string {
  const parts = [`已提交到 ${resolveVideoProgressProviderLabel(params.provider)}`];
  const referenceCount = countVideoReferenceAssets(params.referencePayload);
  if (referenceCount > 1) {
    parts.push(`多参考图 ${referenceCount} 张`);
  } else if (referenceCount === 1) {
    parts.push("参考图 1 张");
  }
  const referenceSummary = summarizeVideoReferenceNamesForProgress(params.referenceDebugInfo);
  if (referenceSummary) {
    parts.push(`参考：${referenceSummary}`);
  }
  return parts.join("，");
}

function buildVideoPollingProgressDetail(params: {
  round: number;
  maxRounds: number;
  provider?: string | null;
  status?: string | null;
  promptTips?: string | null;
}): string {
  const parts = [
    `第 ${params.round}/${params.maxRounds} 轮轮询`,
    resolveVideoProgressProviderLabel(params.provider),
    `状态：${describeVideoProgressStatus(params.status)}`,
  ];
  const promptTips = String(params.promptTips || "").replace(/\s+/g, " ").trim();
  if (promptTips) {
    parts.push(`提示：${truncate(promptTips, 80)}`);
  }
  return parts.join("，");
}

function shouldSurfaceTextToVideoReferenceModerationFailure(
  error: Error,
  mode: string | undefined,
  payload: VideoGenerationReferencePayload,
): boolean {
  if (mode !== "text-to-video") return false;
  if (!hasVideoGenerationReferencePayload(payload)) return false;
  const normalized = String(error.message || "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return (
    normalized.includes("inputimagesensitivecontentdetected") ||
    normalized.includes("privacyinformation") ||
    normalized.includes("input image")
  );
}

function buildTextToVideoReferenceModerationFailureNotice(): NonNullable<
  PersistedVideoProject["videoGenerationModeNotice"]
> {
  const reason =
    "参考图触发 Ark 输入图隐私审核，未自动切换为纯文生，请更换参考图后重试。";
  return {
    message: `当前模式：文生视频。失败原因：${reason}`,
    activeMode: "text-to-video",
    reason,
    updatedAt: new Date().toISOString(),
  };
}

async function invokeVideoGenerationWithReferenceFailureNotice(
  body: Record<string, unknown>,
  options: { abortSignal?: AbortSignal } | undefined,
  mode: string | undefined,
  referencePayload: VideoGenerationReferencePayload,
): Promise<
  | { data: VideoGenerationResult; error: null; notice?: NonNullable<PersistedVideoProject["videoGenerationModeNotice"]> }
  | { data: null; error: Error; notice?: NonNullable<PersistedVideoProject["videoGenerationModeNotice"]> }
> {
  const initialResponse = await invokeFunction<VideoGenerationResult>(
    "generate-video",
    body,
    options,
  );
  if (!initialResponse.error) {
    return {
      ...initialResponse,
      ...(initialResponse.data?.notice ? { notice: initialResponse.data.notice } : {}),
    };
  }
  if (
    !shouldSurfaceTextToVideoReferenceModerationFailure(
      initialResponse.error,
      mode,
      referencePayload,
    )
  ) {
    return initialResponse;
  }

  return {
    ...initialResponse,
    notice: buildTextToVideoReferenceModerationFailureNotice(),
  };
}

function countMissingStoryboardFramesForScenes(
  project: PersistedVideoProject,
  scenes: Scene[],
): number {
  const readyStoryboardSceneIds = new Set(
    getVideoManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.sceneId)
      .map((item) => item.sceneId!),
  );

  return scenes.filter((scene) => {
    if (readyStoryboardSceneIds.has(scene.id)) return false;
    return !findSceneReferenceImage(scene, project.sceneSettings || []);
  }).length;
}

function assertStoryboardAssetsReadyForScenes(
  project: PersistedVideoProject,
  scenes: Scene[],
  mode?: string,
): void {
  if (mode === "text-to-video") return;
  if (!scenes.length) return;
  if (!hasStoryboardText(project) && !hasMinimumStoryboardFrames(project)) return;
  if (!hasStoryboardText(project)) {
    throw new Error("当前还没有分镜文本计划，先整理分镜文本再继续推进视频生成。");
  }

  const missingStoryboardCount = countMissingStoryboardFramesForScenes(project, scenes);
  if (missingStoryboardCount > 0) {
    throw new Error(`当前选中的 ${missingStoryboardCount} 个镜头缺少参考图，补齐后再进入视频生成会更稳。`);
  }
}

function resolveRequestedVideoGenerationPrefs(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
) {
  return normalizeVideoGenerationPrefs({
    ...project.videoGenerationPrefs,
    ...(typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs
      ? input.videoGenerationPrefs
      : {}),
    ...(typeof input.videoModelKey === "string" && input.videoModelKey.trim()
      ? { modelKey: input.videoModelKey.trim() as never }
      : typeof input.selectedVideoModelKey === "string" && input.selectedVideoModelKey.trim()
        ? { modelKey: input.selectedVideoModelKey.trim() as never }
        : typeof input.modelKey === "string" && input.modelKey.trim()
          ? { modelKey: input.modelKey.trim() as never }
          : {}),
    ...(typeof input.resolution === "string" && input.resolution.trim()
      ? { resolution: input.resolution.trim() as never }
      : {}),
    ...(typeof input.aspectRatio === "string" && input.aspectRatio.trim()
      ? { aspectRatio: input.aspectRatio.trim() }
      : {}),
    ...(typeof input.mode === "string" && input.mode.trim()
      ? { mode: input.mode.trim() as never }
      : {}),
  });
}

function hasUsableRunningHubVideoKey(): boolean {
  const config = getApiConfig();
  return hasUsableApiCredential(config.runninghubEndpoint, config.runninghubKey);
}

function buildRunningHubTransportLabel(provider: string): string {
  if (provider === "runninghub-happyhorse") {
    return "RunningHub HappyHorse API";
  }
  if (provider === "runninghub-seedance-fast") {
    return "RunningHub Seedance 2.0 Fast fallback";
  }
  return "RunningHub Seedance 2.0 fallback";
}

function isLiveActionNegativeStyleSignal(text: string): boolean {
  return /(hyper[\s-]?cg|超写实\s*cg|cg质感|卡通|动漫|动画|二次元|漫画|anime|cartoon|cel[-\s]?animation)/i.test(
    text,
  );
}

function isLiveActionPositiveStyleSignal(text: string): boolean {
  return /(真人|写实|实拍|现实题材|真人影视|live[\s-]?action|photoreal|photorealistic)/i.test(text);
}

function projectPrefersRunningHubForLiveAction(
  project?: Pick<PersistedVideoProject, "artStyle" | "shotStyle" | "styleLock" | "imageGenerationPrefs"> | null,
): boolean {
  if (!project) return false;

  const mergedStyleText = [
    project.styleLock?.visualStyle,
    project.styleLock?.tone,
    project.shotStyle,
    project.imageGenerationPrefs?.customStylePrompt,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  if (mergedStyleText && isLiveActionNegativeStyleSignal(mergedStyleText)) {
    return false;
  }
  if (mergedStyleText && isLiveActionPositiveStyleSignal(mergedStyleText)) {
    return true;
  }

  const normalizedProjectArtStyle = resolveVideoImageProjectArtStyle(
    project.imageGenerationPrefs,
    project.artStyle || "live-action",
  );
  if (normalizedProjectArtStyle === "live-action") return true;
  if (normalizedProjectArtStyle !== "custom") return false;

  return String(project.imageGenerationPrefs?.styleCategory || "").trim().toLowerCase() === "realistic";
}

function resolveRunningHubLiveActionProvider(modelKey: string): string {
  const normalizedModelKey = normalizeVideoGenerationPrefs({ modelKey }).modelKey;
  if (normalizedModelKey === HAPPYHORSE_1_0_MODEL_KEY) {
    return "runninghub-happyhorse";
  }
  if (normalizedModelKey === SEEDANCE_2_0_FAST_MODEL_KEY) {
    return "runninghub-seedance-fast";
  }
  return "runninghub-seedance";
}

type VideoGenerationTransport = {
  mode: "api" | "cli";
  provider?: string;
  providerLabel: string;
};

function resolveVideoGenerationTransportProviderHint(
  prefs?: Parameters<typeof normalizeVideoGenerationPrefs>[0],
  project?: Pick<PersistedVideoProject, "artStyle" | "shotStyle" | "styleLock" | "imageGenerationPrefs"> | null,
): string | undefined {
  const normalizedPrefs = normalizeVideoGenerationPrefs(prefs);
  if (normalizedPrefs.modelKey === HAPPYHORSE_1_0_MODEL_KEY) {
    const config = getApiConfig();
    if (hasUsableRunningHubVideoKey()) {
      return "runninghub-happyhorse";
    }
    if (hasUsableApiCredential(config.aliyunEndpoint, config.aliyunKey)) {
      return "aliyun";
    }
    return undefined;
  }
  if (videoModelRequiresRunningHubTransport(normalizedPrefs) && hasUsableRunningHubVideoKey()) {
    return "runninghub-seedance";
  }
  if (hasUsableRunningHubVideoKey() && projectPrefersRunningHubForLiveAction(project)) {
    return resolveRunningHubLiveActionProvider(normalizedPrefs.modelKey);
  }
  return resolveVideoGenerationProvider(normalizedPrefs);
}

function resolveSegmentContinuationVideoMode(params: {
  requestedMode?: string | null;
  provider?: string | null;
  modelKey?: string | null;
  continuityFrameUrl?: string | null;
  strictTextToVideoContinuity?: boolean;
}): "text-to-video" | "image-to-video" {
  const requestedMode =
    params.requestedMode === "image-to-video" ? "image-to-video" : "text-to-video";
  if (requestedMode !== "text-to-video") return requestedMode;
  if (params.strictTextToVideoContinuity === true) return requestedMode;
  if (!hasUsableMediaUrl(params.continuityFrameUrl)) return requestedMode;
  if (!videoModelSupportsDirectReferenceImage(params.modelKey)) return requestedMode;

  const provider = String(params.provider || "")
    .trim()
    .toLowerCase();

  if (
    provider === "jimeng" ||
    provider === "tuzi" ||
    provider === "aliyun" ||
    provider === "runninghub-happyhorse" ||
    provider === "runninghub-seedance" ||
    provider === "runninghub-seedance-fast"
  ) {
    return "image-to-video";
  }

  return requestedMode;
}

async function ensureVideoGenerationTransport(
  input: Record<string, unknown>,
): Promise<VideoGenerationTransport> {
  const config = getApiConfig();
  const usesArkSeedanceApi = isArkJimengEndpoint(config.jimengEndpoint);
  const explicitProvider =
    typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : "";
  const requestedModel = String(
    input.videoModelKey ||
      input.selectedVideoModelKey ||
      input.modelKey ||
      input.model ||
      "",
  )
    .trim()
    .toLowerCase();
  const hasRunningHubCredential = hasUsableRunningHubVideoKey();
  const hasAliyunCredential = hasUsableApiCredential(config.aliyunEndpoint, config.aliyunKey);
  const provider =
    explicitProvider === "dreamina-cli"
      ? "jimeng"
      : explicitProvider ||
        (requestedModel.includes("happyhorse")
          ? hasRunningHubCredential
            ? "runninghub-happyhorse"
            : "aliyun"
          : undefined);
  const requestedPrefs = normalizeVideoGenerationPrefs({
    modelKey:
      typeof input.videoModelKey === "string" && input.videoModelKey.trim()
        ? input.videoModelKey
        : typeof input.selectedVideoModelKey === "string" && input.selectedVideoModelKey.trim()
          ? input.selectedVideoModelKey
          : typeof input.modelKey === "string" && input.modelKey.trim()
            ? input.modelKey
            : typeof input.model === "string" && input.model.trim()
              ? input.model
              : undefined,
    resolution: typeof input.resolution === "string" && input.resolution.trim()
      ? input.resolution
      : undefined,
    mode: typeof input.mode === "string" && input.mode.trim() ? input.mode : undefined,
  });

  if (provider?.startsWith("runninghub")) {
    if (!hasRunningHubCredential) {
      if (provider === "runninghub-happyhorse" && hasAliyunCredential) {
        return {
          mode: "api",
          provider: "aliyun",
          providerLabel: "Aliyun HappyHorse API",
        };
      }
      throw new Error("当前指定了 RunningHub 通道，但缺少可用 RunningHub API Key，无法发起出片。");
    }

    return {
      mode: "api",
      provider,
      providerLabel: buildRunningHubTransportLabel(provider),
    };
  }

  if (videoModelRequiresRunningHubTransport(requestedPrefs)) {
    if (!hasUsableRunningHubVideoKey()) {
      throw new Error("当前 2K / 4K 仅支持 RunningHub Seedance 2.0 满血版，但缺少可用 RunningHub API Key。");
    }

    return {
      mode: "api",
      provider: "runninghub-seedance",
      providerLabel: buildRunningHubTransportLabel("runninghub-seedance"),
    };
  }

  if (provider === "tuzi") {
    if (!hasUsableApiCredential(config.tuziEndpoint, config.tuziKey)) {
      throw new Error("当前指定了 Tuzi / Sora 2，但缺少可用 API Key，无法发起出片。");
    }

    return {
      mode: "api",
      provider: "tuzi",
      providerLabel: "Tuzi API / Sora 2",
    };
  }

  if (provider === "aliyun") {
    if (!hasAliyunCredential) {
      throw new Error("当前指定了阿里云 HappyHorse，但缺少可用 DashScope API Key，无法发起出片。");
    }

    return {
      mode: "api",
      provider: "aliyun",
      providerLabel: "Aliyun HappyHorse API",
    };
  }

  if (!resolveJimengApiKey(config) && !isServerProxyEndpoint(config.jimengEndpoint)) {
    throw new Error(
      usesArkSeedanceApi
        ? "当前已锁定 API，但缺少 Seedance / Ark 专用 Key，无法发起出片。"
        : "当前已锁定 API，但缺少 Seedance / Gemini 可用 Key，无法发起出片。",
    );
  }

  return {
    mode: "api",
    provider: "jimeng",
    providerLabel: usesArkSeedanceApi ? "Ark / Seedance API" : "Seedance API",
  };
}

function normalizeSceneStatus(value: string | undefined): string {
  if (!value?.trim()) return "";
  const lowered = String(value || "").toLowerCase();
  if (/(succeeded|success|completed|done)/.test(lowered)) return "completed";
  if (/(queued|pending|submitted)/.test(lowered)) return "queued";
  if (/(failed|error|cancel)/.test(lowered)) return "failed";
  return "processing";
}

function isSameRefreshSceneState(previous: Scene, next: Scene): boolean {
  return (
    normalizeSceneStatus(previous.videoStatus) === normalizeSceneStatus(next.videoStatus) &&
    (previous.videoTaskId || "") === (next.videoTaskId || "") &&
    (previous.videoUrl || "") === (next.videoUrl || "") &&
    (previous.videoFailure?.message || "") === (next.videoFailure?.message || "") &&
    (previous.videoFailure?.provider || "") === (next.videoFailure?.provider || "") &&
    (previous.videoFailure?.stage || "") === (next.videoFailure?.stage || "")
  );
}

function characterReferenceTargetMatches(
  character: CharacterSetting,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === character.id ||
      normalized === `character:${character.id}` ||
      normalized === `reference-character:${character.id}`
    );
  });
}

function sceneReferenceTargetMatches(
  sceneSetting: SceneSetting,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === sceneSetting.id ||
      normalized === `scene:${sceneSetting.id}` ||
      normalized === `scene-setting:${sceneSetting.id}` ||
      normalized === `reference-scene:${sceneSetting.id}`
    );
  });
}

function characterVariantTargetMatches(
  characterId: string,
  costumeId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === costumeId ||
      normalized === `costume:${costumeId}` ||
      normalized === `reference-character-variant:${characterId}:${costumeId}`
    );
  });
}

function hasExplicitCharacterVariantTarget(
  characterId: string,
  costumeId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return normalized === `reference-character-variant:${characterId}:${costumeId}`;
  });
}

function sceneVariantTargetMatches(
  sceneSettingId: string,
  variantId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === variantId ||
      normalized === `time-variant:${variantId}` ||
      normalized === `reference-scene-variant:${sceneSettingId}:${variantId}`
    );
  });
}

function hasExplicitSceneVariantTarget(
  sceneSettingId: string,
  variantId: string,
  targetIds: string[],
): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return normalized === `reference-scene-variant:${sceneSettingId}:${variantId}`;
  });
}

function buildReferenceAssetGenerationSummary(params: {
  characterPrimaryCount: number;
  characterVariantCount: number;
  scenePrimaryCount: number;
  sceneVariantCount: number;
}): string {
  const parts = [
    params.characterPrimaryCount ? `${params.characterPrimaryCount} 个角色主参考图` : "",
    params.characterVariantCount ? `${params.characterVariantCount} 个角色变体` : "",
    params.scenePrimaryCount ? `${params.scenePrimaryCount} 个场景主参考图` : "",
    params.sceneVariantCount ? `${params.sceneVariantCount} 个场景变体` : "",
  ].filter(Boolean);

  return parts.length ? `已生成 ${parts.join("、")}。` : "";
}

function sceneTargetMatches(scene: Scene, projectId: string, targetIds: string[]): boolean {
  if (!targetIds.length) return false;

  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === scene.id ||
      normalized === `packet:${projectId}:${scene.id}` ||
      normalized === `review:packet:${projectId}:${scene.id}` ||
      normalized === `shot:${scene.id}:video` ||
      normalized === `shot:${scene.id}:storyboard` ||
      normalized.endsWith(`:${scene.id}`) ||
      normalized.includes(`:${scene.id}:`)
    );
  });
}

type StoryboardSceneStatus =
  | "已生成"
  | "可生成"
  | "缺角色参考"
  | "缺场景参考"
  | "缺角色/场景参考";

function collectStoryboardReadyIds(project: PersistedVideoProject) {
  const readyCharacterIds = new Set<string>();
  const readySceneIds = new Set<string>();
  const readyStoryboardSceneIds = new Set<string>();

  (project.characters || []).forEach((character) => {
    const activeCostume = character.costumes?.find((costume) => costume.id === character.activeCostumeId);
    if (hasUsableMediaUrl(character.imageUrl) || hasUsableMediaUrl(activeCostume?.imageUrl)) {
      readyCharacterIds.add(character.id);
    }
  });

  (project.sceneSettings || []).forEach((sceneSetting) => {
    const activeTimeVariant = sceneSetting.timeVariants?.find((variant) => variant.id === sceneSetting.activeTimeVariantId);
    if (hasUsableMediaUrl(sceneSetting.imageUrl) || hasUsableMediaUrl(activeTimeVariant?.imageUrl)) {
      readySceneIds.add(sceneSetting.id);
    }
  });

  project.scenes.forEach((scene) => {
    if (hasUsableMediaUrl(scene.storyboardUrl)) {
      readyStoryboardSceneIds.add(scene.id);
    }
  });

  (project.assetManifest?.items ?? []).forEach((item) => {
    if (
      (item.kind === "character-reference" || item.kind === "costume-reference") &&
      item.status === "ready" &&
      hasUsableMediaUrl(item.url) &&
      item.sourceEntityId
    ) {
      readyCharacterIds.add(item.sourceEntityId);
    }

    if (
      (item.kind === "scene-reference" || item.kind === "time-variant") &&
      item.status === "ready" &&
      hasUsableMediaUrl(item.url) &&
      item.sourceEntityId
    ) {
      readySceneIds.add(item.sourceEntityId);
    }

    if (item.kind === "storyboard-frame" && item.status === "ready" && item.sceneId) {
      readyStoryboardSceneIds.add(item.sceneId);
    }
  });

  return { readyCharacterIds, readySceneIds, readyStoryboardSceneIds };
}

function resolveStoryboardSceneStatus(
  scene: Scene,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
  readyIds: ReturnType<typeof collectStoryboardReadyIds>,
): StoryboardSceneStatus {
  if (readyIds.readyStoryboardSceneIds.has(scene.id)) {
    return "已生成";
  }

  const characterMap = new Map(
    characters.map((character) => [normalizeName(character.name), character]),
  );
  const missingCharacterRefs = (scene.characters ?? []).filter((name) => {
    const matchedCharacter = characterMap.get(normalizeName(name));
    return !matchedCharacter || !readyIds.readyCharacterIds.has(matchedCharacter.id);
  });

  const matchedSetting = findSceneSetting(scene, sceneSettings);
  const sceneReferenceReady =
    Boolean(scene.panoramaUrl?.trim()) ||
    Boolean(matchedSetting && readyIds.readySceneIds.has(matchedSetting.id));

  if (missingCharacterRefs.length === 0 && sceneReferenceReady) {
    return "可生成";
  }

  if (missingCharacterRefs.length > 0 && !sceneReferenceReady) {
    return "缺角色/场景参考";
  }

  if (missingCharacterRefs.length > 0) {
    return "缺角色参考";
  }

  return "缺场景参考";
}

function resolveStoryboardSceneReferenceLabel(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string {
  const matchedSetting = findSceneSetting(scene, sceneSettings);
  if (matchedSetting?.name?.trim()) {
    return matchedSetting.name.trim();
  }
  if (scene.panoramaUrl?.trim()) {
    return "镜头全景";
  }
  return "待匹配";
}

function buildStoryboardBatch(project: PersistedVideoProject): string {
  const scenes = project.scenes;
  const characters = project.characters || [];
  const sceneSettings = project.sceneSettings || [];

  if (!scenes.length) {
    return "暂无可整理的分镜摘要。";
  }

  const readyIds = collectStoryboardReadyIds(project);
  const segmentEntries: Array<{ segmentLabel: string; segmentScenes: Scene[] }> = [];
  const segmentMap = new Map<string, Scene[]>();

  [...scenes]
    .sort((left, right) => left.sceneNumber - right.sceneNumber)
    .forEach((scene) => {
      const segmentLabel = scene.segmentLabel?.trim() || "未分组";
      const existing = segmentMap.get(segmentLabel);
      if (existing) {
        existing.push(scene);
        return;
      }
      const nextGroup = [scene];
      segmentMap.set(segmentLabel, nextGroup);
      segmentEntries.push({ segmentLabel, segmentScenes: nextGroup });
    });

  const buildRoleReference = (scene: Scene) => {
    const characterMap = new Map(
      characters.map((character) => [normalizeName(character.name), character]),
    );
    const names = [...new Set(
      (scene.characters || [])
        .map((characterName) => {
          const matchedCharacter = characterMap.get(normalizeName(characterName));
          return matchedCharacter?.name?.trim() || String(characterName || "").trim();
        })
        .filter(Boolean),
    )];

    return escapeSummaryTableCell(names.join("、") || "暂无", 22);
  };

  const buildSceneReference = (scene: Scene, segmentScenes: Scene[]) => {
    return escapeSummaryTableCell(resolveStoryboardSceneReferenceLabel(scene, sceneSettings), 24);
  };

  return segmentEntries
    .map(({ segmentLabel, segmentScenes }) => {
      const statuses = segmentScenes.map((scene) =>
        resolveStoryboardSceneStatus(scene, characters, sceneSettings, readyIds),
      );
      const generatedCount = statuses.filter((status) => status === "已生成").length;
      const generatableCount = statuses.filter((status) => status === "可生成").length;
      const blockedCount = statuses.length - generatedCount - generatableCount;
      const segmentTitle =
        findSceneSetting(segmentScenes[0]!, sceneSettings)?.name?.trim() ||
        segmentScenes[0]?.sceneName?.trim() ||
        "未命名片段";
      const heading =
        `## 片段 ${segmentLabel}｜${segmentTitle}（已生成 ${generatedCount} / 可生成 ${generatableCount} / 缺素材 ${blockedCount}）`;

      const table = [
        "| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |",
        "| --- | --- | --- | --- | --- |",
        ...segmentScenes.map((scene) => [
          `| ${escapeSummaryTableCell(`镜头 ${scene.sceneNumber}`, 12)}`,
          `${escapeSummaryTableCell(scene.sceneName || `镜头 ${scene.sceneNumber}`, 18)}`,
          `${escapeSummaryTableCell(resolveStoryboardSceneStatus(scene, characters, sceneSettings, readyIds), 18)}`,
          `${buildRoleReference(scene)}`,
          `${buildSceneReference(scene, segmentScenes)} |`,
        ].join(" | ")),
      ].join("\n");

      return [heading, table].join("\n\n");
    })
    .join("\n\n");
}

function buildRealtimeStoryboardSummary(
  project: PersistedVideoProject,
): {
  storyboardPlan: string;
  generatedCount: number;
  generatableCount: number;
  blockedCount: number;
  totalCount: number;
} {
  let syncedProject = synchronizeVideoProductionState(project);
  const readyIds = collectStoryboardReadyIds(syncedProject);
  const totalCount = syncedProject.scenes.length;
  const statuses = syncedProject.scenes.map((scene) =>
    resolveStoryboardSceneStatus(
      scene,
      syncedProject.characters || [],
      syncedProject.sceneSettings || [],
      readyIds,
    ),
  );
  const generatedCount = statuses.filter((status) => status === "已生成").length;
  const generatableCount = statuses.filter((status) => status === "可生成").length;
  const blockedCount = statuses.length - generatedCount - generatableCount;

  return {
    storyboardPlan: buildStoryboardBatch(syncedProject),
    generatedCount,
    generatableCount,
    blockedCount,
    totalCount,
  };
}

function buildPromptBatchSummary(
  scenes: Scene[],
  results: Array<{ scene: Scene; prompt: VideoEnhanceResult }>,
): string {
  return results
    .map(({ scene, prompt }, index) => [
      `批次 ${index + 1} / 镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""}`,
      `场景：${scene.sceneName}`,
      `推荐时长：${prompt.duration ?? scene.duration ?? 5}s`,
      `时长依据：${prompt.durationReason || "按镜头复杂度自动估算"}`,
      "",
      prompt.enhanced,
    ].join("\n"))
    .join("\n\n====================\n\n");
}

function buildPromptBatchSummaryOutline(
  project: PersistedVideoProject,
  selectedScenes: Scene[],
): string {
  if (!selectedScenes.length) {
    return "当前没有可展示的视频提示词批次摘要。";
  }

  const episodeSegmentRe = /^(\d+)-(\d+)$/;
  const selectedIds = new Set(selectedScenes.map((s) => s.id));

  // 全量镜头按集数分组
  const allScenesSorted = [...project.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const hasEpisodeSegments = allScenesSorted.some((scene) =>
    episodeSegmentRe.test(scene.segmentLabel?.trim() || ""),
  );

  // 按集数 → 片段 两级分组（全量）
  const episodeMap = new Map<string, Map<string, Scene[]>>();
  const episodeOrder: string[] = [];

  for (const scene of allScenesSorted) {
    const segLabel = scene.segmentLabel?.trim() || "";
    const episodeKey = hasEpisodeSegments
      ? episodeSegmentRe.exec(segLabel)?.[1] || "1"
      : "__single__";
    const segmentKey = hasEpisodeSegments ? segLabel || "未分组" : "__single__";

    if (!episodeMap.has(episodeKey)) {
      episodeMap.set(episodeKey, new Map());
      episodeOrder.push(episodeKey);
    }
    const segMap = episodeMap.get(episodeKey)!;
    if (!segMap.has(segmentKey)) {
      segMap.set(segmentKey, []);
    }
    segMap.get(segmentKey)!.push(scene);
  }

  const totalStart = selectedScenes[0]?.sceneNumber ?? 0;
  const totalEnd = selectedScenes.at(-1)?.sceneNumber ?? totalStart;
  const header = `已收口 ${selectedScenes.length} 个镜头的视频提示词批次，覆盖镜头 ${totalStart}-${totalEnd}。`;

  const outputParts: string[] = [header];

  for (const episodeKey of episodeOrder) {
    const segMap = episodeMap.get(episodeKey)!;
    const segmentOrder = [...segMap.keys()];

    // 只保留包含至少一个已覆盖镜头的片段
    const visibleSegments = segmentOrder.filter((segKey) => {
      const segScenes = segMap.get(segKey)!;
      return segScenes.some((scene) => selectedIds.has(scene.id));
    });

    if (!visibleSegments.length) continue;

    if (hasEpisodeSegments) {
      outputParts.push(`\n## 第 ${episodeKey} 集`);
    }

    for (const segKey of visibleSegments) {
      const segScenes = segMap.get(segKey)!;
      const coveredCount = segScenes.filter((s) => selectedIds.has(s.id)).length;
      const pendingCount = segScenes.length - coveredCount;
      const totalCount = segScenes.length;

      const firstScene = segScenes[0];
      const sceneName =
        findSceneSetting(firstScene, project.sceneSettings || [])?.name?.trim() ||
        firstScene?.sceneName?.trim() ||
        "未命名场景";

      const segLabel = segKey === "__single__" ? "" : segKey;
      const segmentDuration = segScenes.reduce(
        (sum, scene) => sum + (scene.recommendedDuration ?? scene.duration ?? 5),
        0,
      );
      const segTitle = segLabel
        ? `**片段 ${segLabel}（${segmentDuration}s）｜${sceneName}（已覆盖 ${coveredCount} / 待生成 ${pendingCount} / 总数 ${totalCount}）**`
        : `**${sceneName}（已覆盖 ${coveredCount} / 待生成 ${pendingCount} / 总数 ${totalCount}）**`;

      const shotLines = segScenes.map((scene) => {
        const duration = scene.recommendedDuration ?? scene.duration ?? 5;
        const status = selectedIds.has(scene.id) ? "已覆盖" : "待生成";
        return `  镜头 ${scene.sceneNumber} — ${duration}s（${status}）`;
      });

      outputParts.push(`\n${segTitle}\n${shotLines.join("\n")}`);
    }
  }

  return outputParts.join("\n");
}

function buildStoryboardOutputStabilitySummary(params: {
  totalCount: number;
  generatedCount: number;
  generatableCount: number;
  blockedCount: number;
}): string {
  const { totalCount, generatedCount, generatableCount, blockedCount } = params;
  const stability =
    blockedCount === 0
      ? "稳定"
      : generatedCount + generatableCount > 0
        ? "条件稳定"
        : "受阻";
  return [
    `分镜输出稳定性：${stability}。`,
    "说明：当前分镜摘要由项目状态本地拼装生成，不依赖额外模型调用，所以文本本身是可重复、可恢复的。",
    `覆盖情况：总镜头 ${totalCount}，已生成 ${generatedCount}，可生成 ${generatableCount}，缺素材 ${blockedCount}。`,
    blockedCount > 0
      ? "风险提示：仍有镜头缺少角色或场景参考，摘要可以稳定输出，但这些镜头暂时不能稳定继续出图。"
      : "风险提示：当前没有缺素材镜头，分镜摘要与后续分镜图生成条件一致。",
  ].join("\n");
}

function summarizeSegmentPromptSourceLabel(
  source: "model" | undefined,
): string {
  switch (source) {
    case "model":
      return "模型直出";
    default:
      return "未记录";
  }
}

function buildSegmentPromptStabilitySummary(params: {
  segmentLabels: string[];
  prompts: Record<string, SegmentVideoPrompt>;
}): string {
  const entries = params.segmentLabels
    .map((segmentLabel) => params.prompts[segmentLabel])
    .filter((entry): entry is SegmentVideoPrompt => Boolean(entry?.prompt?.trim()));
  if (!entries.length) {
    return "最终提示词稳定性：未生成任何片段提示词。";
  }

  const modelCount = entries.filter((entry) => entry.debug?.source === "model").length;
  const coveragePassedCount = entries.filter((entry) => entry.debug?.shotCoverageComplete !== false).length;
  const stability =
    coveragePassedCount === entries.length && modelCount === entries.length
      ? "稳定"
      : "待关注";

  return [
    `最终提示词稳定性：${stability}。`,
    "说明：片段最终提示词只走模型直出与同一份规范化整理，不再使用本地回退模板。",
    `来源统计：模型直出 ${modelCount} / ${entries.length}。`,
    `镜头覆盖校验：通过 ${coveragePassedCount} / ${entries.length} 个片段。`,
  ].join("\n");
}

function buildSegmentPromptLogDisplay(params: {
  project: PersistedVideoProject;
  segmentLabels: string[];
  prompts: Record<string, SegmentVideoPrompt>;
}): string {
  const sceneById = new Map((params.project.scenes ?? []).map((scene) => [scene.id, scene] as const));
  const sections = params.segmentLabels
    .map((segmentLabel) => params.prompts[segmentLabel])
    .filter((entry): entry is SegmentVideoPrompt => Boolean(entry?.prompt?.trim()))
    .map((entry) => {
      const sceneNumbers = entry.sceneIds
        .map((sceneId) => sceneById.get(sceneId)?.sceneNumber)
        .filter((sceneNumber): sceneNumber is number => Number.isFinite(sceneNumber))
        .join("、");
      return [
        `### 片段 ${entry.segmentLabel} 最终提示词`,
        `镜头：${sceneNumbers || "未记录"}`,
        `时长：${entry.duration}s / 模型上限 ${entry.maxDurationForModel}s`,
        `来源：${summarizeSegmentPromptSourceLabel(entry.debug?.source)}`,
        `镜头覆盖校验：${entry.debug?.shotCoverageComplete === false ? "待关注" : "通过"}`,
        "",
        entry.prompt.trim(),
      ].join("\n");
    });

  return sections.length ? ["最终提示词日志：", ...sections].join("\n\n====================\n\n") : "";
}

function buildVideoAssetStatusReport(
  project: PersistedVideoProject,
  selectedScenes: Scene[],
  mode: string,
): string {
  const isImageToVideo = mode !== "text-to-video";
  const characters = project.characters || [];
  const sceneSettings = project.sceneSettings || [];

  const involvedCharacterNames = new Set<string>();
  selectedScenes.forEach((scene) => {
    (scene.characters || []).forEach((name) => involvedCharacterNames.add(name));
  });

  const involvedSceneNames = new Set<string>();
  selectedScenes.forEach((scene) => involvedSceneNames.add(scene.sceneName));

  const lines: string[] = [];
  lines.push("---");
  lines.push(isImageToVideo ? "## 当前批次资产状态（图生视频模式）" : "## 当前批次资产状态（文生视频模式）");
  lines.push("");

  if (isImageToVideo) {
    lines.push("分镜图（首帧参考）：");
    selectedScenes.forEach((scene) => {
      if (scene.storyboardUrl?.trim()) {
        lines.push(`  镜头 ${scene.sceneNumber} — [就绪]`);
      } else {
        lines.push(`  镜头 ${scene.sceneNumber} — [缺失]（已跳过）`);
      }
    });
    lines.push("");
    lines.push("角色参考（提示词增强用）：");
  } else {
    lines.push("角色参考：");
  }

  if (involvedCharacterNames.size === 0) {
    lines.push("  （本批次镜头无角色）");
  } else {
    involvedCharacterNames.forEach((name) => {
      const character = characters.find((c) => normalizeName(c.name) === normalizeName(name));
      if (!character) {
        lines.push(`  ${name} — [缺失]（提示词将仅使用文字描述）`);
        return;
      }
      const costumeIds = new Set(
        selectedScenes
          .map((scene) => scene.characterCostumes?.[character.name])
          .filter((id): id is string => Boolean(id)),
      );
      if (costumeIds.size > 0) {
        const costumeId = [...costumeIds][0];
        const costume = (character.costumes || []).find((c) => c.id === costumeId);
        if (costume) {
          const hasImage = !!(costume.imageUrl?.trim() || character.imageUrl?.trim());
          lines.push(
            hasImage
              ? `  ${character.name} — 服装变体「${costume.label}」[就绪]`
              : `  ${character.name} — 服装变体「${costume.label}」[缺失]（提示词将仅使用文字描述）`,
          );
          return;
        }
      }
      lines.push(
        character.imageUrl?.trim()
          ? `  ${character.name} — 主参考图 [就绪]`
          : `  ${character.name} — [缺失]（提示词将仅使用文字描述）`,
      );
    });
  }

  lines.push("");
  lines.push(isImageToVideo ? "场景参考（提示词增强用）：" : "场景参考：");

  if (involvedSceneNames.size === 0) {
    lines.push("  （本批次镜头无场景信息）");
  } else {
    involvedSceneNames.forEach((sceneName) => {
      const normalizedName = normalizeName(sceneName);
      const matchedSetting =
        sceneSettings.find((s) => normalizeName(s.name) === normalizedName) ||
        sceneSettings
          .filter((s) => {
            const n = normalizeName(s.name);
            return normalizedName.includes(n) || n.includes(normalizedName);
          })
          .reduce<SceneSetting | undefined>((best, cur) => {
            if (!best) return cur;
            return normalizeName(cur.name).length > normalizeName(best.name).length ? cur : best;
          }, undefined);
      lines.push(
        matchedSetting?.imageUrl?.trim()
          ? `  ${sceneName} — 场景参考图 [就绪]`
          : `  ${sceneName} — [缺失]（提示词将仅使用文字描述）`,
      );
    });
  }

  lines.push("");
  lines.push(
    isImageToVideo
      ? "温馨提示：图生视频模式下，分镜图质量直接决定视频首帧效果，建议先补齐所有分镜图，角色和场景参考图补齐后提示词增强效果也会更好。"
      : "温馨提示：补齐角色和场景参考图后，视频生成效果会更好。",
  );

  return lines.join("\n");
}

export async function prepareVideoGenerationAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const nextProject: PersistedVideoProject = {
    ...project,
    title: buildVideoTitle(runtime, input),
    script: resolveWorkingScript(runtime, project, input),
    analysisSummary:
      project.analysisSummary ||
      "首页会话已经接管视频生产，你可以继续做镜头拆解、资产梳理和提示词批处理。",
    currentStep: deriveVisibleVideoStep(synchronizeVideoProductionState(project)),
    sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
  };
  return saveVideoProject(
    nextProject,
    `已接管视频项目《${nextProject.title}》的首页会话上下文。`,
  );
}

const MEDIA_SUBMISSION_GUARD_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 3000;
let mediaSubmissionGuardDelayMsOverride: number | null = null;

function resolveInputAbortSignal(input: Record<string, unknown>): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  return input.abortSignal instanceof AbortSignal ? input.abortSignal : undefined;
}

function createWorkflowAbortError(message = "请求已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createWorkflowAbortError();
  }
}

function waitForAbortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfSignalAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createWorkflowAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveMediaSubmissionGuardDelayMs(): number {
  return mediaSubmissionGuardDelayMsOverride ?? MEDIA_SUBMISSION_GUARD_DELAY_MS;
}

export function __setVideoWorkflowMediaSubmissionGuardDelayForTests(delayMs: number | null): void {
  mediaSubmissionGuardDelayMsOverride = delayMs;
}

function buildMediaSubmissionGuardLine(kind: "image" | "video", delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return kind === "image"
    ? `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生图请求；这段时间内仍可撤回。`
    : `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生视频请求；这段时间内仍可撤回。`;
}

function truncateMultilineText(value: string | null | undefined, max = 560): string {
  const normalized = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function summarizeSubmissionTargetLabels(labels: string[], maxCount = 3): string {
  const normalizedLabels = Array.from(
    new Set(
      labels
        .map((label) => String(label || "").trim())
        .filter(Boolean),
    ),
  );
  if (!normalizedLabels.length) return "";
  if (normalizedLabels.length <= maxCount) return normalizedLabels.join("、");
  return `${normalizedLabels.slice(0, maxCount).join("、")} 等 ${normalizedLabels.length} 项`;
}

function resolveReferenceAssetSubmissionLabel(
  project: PersistedVideoProject,
  targetId: string,
): string {
  const normalizedTargetId = String(targetId || "").trim();
  if (!normalizedTargetId) return "";

  if (normalizedTargetId.startsWith("reference-character-variant:")) {
    const [, characterId = "", variantId = ""] = normalizedTargetId.split(":");
    const character = project.characters.find((item) => item.id === characterId);
    const variant = character?.costumes?.find((item) => item.id === variantId);
    return character && variant ? `角色 ${character.name} · ${variant.label}` : normalizedTargetId;
  }

  if (normalizedTargetId.startsWith("reference-scene-variant:")) {
    const [, sceneSettingId = "", variantId = ""] = normalizedTargetId.split(":");
    const sceneSetting = project.sceneSettings.find((item) => item.id === sceneSettingId);
    const variant = sceneSetting?.timeVariants?.find((item) => item.id === variantId);
    return sceneSetting && variant ? `场景 ${sceneSetting.name} · ${variant.label}` : normalizedTargetId;
  }

  if (normalizedTargetId.startsWith("reference-character:")) {
    const characterId = normalizedTargetId.slice("reference-character:".length);
    const character = project.characters.find((item) => item.id === characterId);
    return character ? `角色 ${character.name}` : normalizedTargetId;
  }

  if (normalizedTargetId.startsWith("reference-scene:")) {
    const sceneSettingId = normalizedTargetId.slice("reference-scene:".length);
    const sceneSetting = project.sceneSettings.find((item) => item.id === sceneSettingId);
    return sceneSetting ? `场景 ${sceneSetting.name}` : normalizedTargetId;
  }

  return normalizedTargetId;
}

function buildReferenceAssetSubmissionContent(params: {
  project: PersistedVideoProject;
  targetIds: string[];
  selectedCharacters: CharacterSetting[];
  selectedSceneSettings: SceneSetting[];
}): string {
  const explicitLabels = params.targetIds
    .map((targetId) => resolveReferenceAssetSubmissionLabel(params.project, targetId))
    .filter(Boolean);
  if (explicitLabels.length) {
    return `目标：${summarizeSubmissionTargetLabels(explicitLabels, 5)}`;
  }

  return `目标：${summarizeSubmissionTargetLabels(
    [
      ...params.selectedCharacters.map((character) => `角色 ${character.name}`),
      ...params.selectedSceneSettings.map((sceneSetting) => `场景 ${sceneSetting.name}`),
    ],
    5,
  )}`;
}

function buildStoryboardSubmissionContent(selectedScenes: Scene[]): string {
  if (selectedScenes.length === 1) {
    const scene = selectedScenes[0]!;
    return `${scene.sceneName}\n${truncateMultilineText(scene.description || scene.sceneName)}`;
  }
  return `镜头：${summarizeSubmissionTargetLabels(
    selectedScenes.map((scene) => scene.sceneName || `镜头 ${scene.sceneNumber}`),
    5,
  )}`;
}

function buildSceneVideoSubmissionContent(selectedScenes: Scene[]): string {
  if (selectedScenes.length === 1) {
    const scene = selectedScenes[0]!;
    return truncateMultilineText(
      scene.enhancedVideoPrompt?.trim() || scene.description || scene.sceneName || "",
    );
  }
  return `镜头：${summarizeSubmissionTargetLabels(
    selectedScenes.map((scene) => scene.sceneName || `镜头 ${scene.sceneNumber}`),
    5,
  )}`;
}

function buildSegmentVideoSubmissionContent(
  project: PersistedVideoProject,
  targetSegmentLabels: string[],
): string {
  if (targetSegmentLabels.length === 1) {
    const segmentLabel = targetSegmentLabels[0]!;
    const prompt = project.segmentVideoPrompts?.[segmentLabel]?.prompt;
    return prompt?.trim()
      ? truncateMultilineText(prompt)
      : `片段 ${segmentLabel}`;
  }
  return `片段：${summarizeSubmissionTargetLabels(targetSegmentLabels, 5)}`;
}

function buildMediaSubmissionPreviewSummary(params: {
  title: string;
  content?: string;
  kind: "image" | "video";
  delayMs: number;
}): string {
  return [
    params.title,
    params.content ? `提交内容：\n${truncateMultilineText(params.content)}` : "",
    params.delayMs > 0 ? buildMediaSubmissionGuardLine(params.kind, params.delayMs) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function pauseBeforeMediaSubmission(params: {
  input: Record<string, unknown>;
  onProgress?: WorkflowActionProgressCallback;
  title: string;
  content?: string;
  kind: "image" | "video";
  requestCount?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const delayMs = resolveMediaSubmissionGuardDelayMs();
  const abortSignal = params.abortSignal ?? resolveInputAbortSignal(params.input);
  throwIfSignalAborted(abortSignal);
  params.onProgress?.({
    summary: buildMediaSubmissionPreviewSummary({
      title: params.title,
      content: params.content,
      kind: params.kind,
      delayMs,
    }),
  });
}

/** 将用户中止信号与单次图片生成超时（默认 4 分钟）合并 */
function buildPerImageAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs = 4 * 60_000,
): AbortSignal {
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : (() => {
          const controller = new AbortController();
          globalThis.setTimeout(() => controller.abort(), timeoutMs);
          return controller.signal;
        })();

  if (!parentSignal) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parentSignal, timeout]);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted || timeout.aborted) {
    abort();
    return controller.signal;
  }
  parentSignal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function throwIfInputAborted(input: Record<string, unknown>): void {
  if (resolveInputAbortSignal(input)?.aborted) {
    throw new Error("Aborted");
  }
}

function isAbortLikeWorkflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "Aborted" ||
    error.message === "请求已取消" ||
    error.message === "任务已取消"
  );
}

type ActiveVideoTaskRef = {
  taskId: string;
  provider?: string;
};

async function cancelVideoGenerationTasks(tasks: ActiveVideoTaskRef[]): Promise<void> {
  const dedupedTasks = Array.from(
    new Map(
      tasks
        .filter((task) => task.taskId.trim())
        .map((task) => [`${task.provider || "jimeng"}:${task.taskId}`, task]),
    ).values(),
  );

  if (!dedupedTasks.length) return;

  await Promise.allSettled(
    dedupedTasks.map(async (task) => {
      const { error } = await invokeFunction("generate-video", {
        action: "cancel",
        taskId: task.taskId,
        provider: task.provider,
      });
      if (error) throw error;
    }),
  );
}

function attachAbortDrivenVideoCancellation(
  input: Record<string, unknown>,
  getTasks: () => ActiveVideoTaskRef[],
): () => void {
  const abortSignal = resolveInputAbortSignal(input);
  if (!abortSignal) return () => undefined;

  const onAbort = () => {
    void cancelVideoGenerationTasks(getTasks());
  };

  abortSignal.addEventListener("abort", onAbort, { once: true });
  return () => abortSignal.removeEventListener("abort", onAbort);
}

export async function analyzeScriptForVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  if (!script) {
    throw new Error("当前没有可用于视频拆解的脚本内容。");
  }

  const episodeDuration = resolveEpisodeDuration(input, project);
  const segmentsPerEpisode =
    typeof input.segmentsPerEpisode === "number" && Number.isFinite(input.segmentsPerEpisode)
      ? input.segmentsPerEpisode
      : deriveSegmentsPerEpisode(episodeDuration);
  const abortSignal = resolveInputAbortSignal(input);
  const retryMissingEpisodes =
    input.retryMissingEpisodes === true ||
    hasIncompleteVideoEpisodeCoverage(project);
  const videoPace =
    typeof input.videoPace === "string" &&
    ["slow", "medium", "fast"].includes(input.videoPace)
      ? input.videoPace
      : project.preferredScriptBreakdownPace === "slow" ||
          project.preferredScriptBreakdownPace === "medium" ||
          project.preferredScriptBreakdownPace === "fast"
        ? project.preferredScriptBreakdownPace
        : "medium";

  let latestPartialScenes: Scene[] = [];
  const formatProgress = createScriptDecomposeProgressFormatter();
  const emitPartialProgress = (
    summary: string,
    progressScenes: Scene[],
  ) => {
    const preserveCommittedBreakdown =
      hasPassedVideoScriptBreakdown(project) && !retryMissingEpisodes;
    const effectiveScenes = preserveCommittedBreakdown
      ? project.scenes
      : progressScenes;
    const partialProject = synchronizeVideoProductionState({
      ...project,
      title: buildVideoTitle(runtime, input) || project.title,
      script,
      scenes: effectiveScenes,
      currentStep: 1,
      scriptBreakdownPassed: preserveCommittedBreakdown
        ? project.scriptBreakdownPassed
        : false,
      analysisSummary: summary,
      preferredEpisodeDurationSeconds: episodeDuration,
      preferredScriptBreakdownPace: videoPace,
      sourceProjectId:
        project.sourceProjectId || runtime.currentDramaProject?.id,
    });
    const partialSnapshot = createVideoSnapshot(partialProject);
    onProgress?.({
      summary,
      data: {
        videoProject: partialProject,
        projectSnapshot: partialSnapshot,
      },
      projectSnapshot: partialSnapshot,
      recommendedActions: partialSnapshot.recommendedActions,
    });
  };
  const { data, error } = await invokeFunction<DecomposeResult>("script-decompose", {
    script,
    costumeInfo: project.characters,
    sceneSettingInfo: project.sceneSettings,
    videoPace,
    episodeDuration,
    segmentsPerEpisode,
    retryMissingEpisodes,
    existingScenes: retryMissingEpisodes ? project.scenes : undefined,
    systemPrompt:
      typeof input.systemPrompt === "string" ? input.systemPrompt : project.systemPrompt,
    model: typeof input.model === "string" ? input.model : undefined,
  }, {
    abortSignal,
    onProgress: (partial) => {
      if (Array.isArray(partial?.scenes) && partial.scenes.length > 0) {
        latestPartialScenes = partial.scenes.map(
          (scene: Partial<Scene>, index: number) => mapScene(scene, index),
        );
      }
      const partialPayload = {
        scenes: Array.isArray(partial?.scenes) ? partial.scenes : latestPartialScenes,
        chunkIndex:
          typeof partial?.chunkIndex === "number" ? partial.chunkIndex : undefined,
        totalChunks:
          typeof partial?.totalChunks === "number" ? partial.totalChunks : undefined,
        status: partial?.status,
        failedChunks: Array.isArray(partial?.failedChunks)
          ? partial.failedChunks
          : undefined,
        retryAttempt:
          typeof partial?.retryAttempt === "number"
            ? partial.retryAttempt
            : undefined,
        retryReason:
          typeof partial?.retryReason === "string"
            ? partial.retryReason
            : undefined,
        error: typeof partial?.error === "string" ? partial.error : undefined,
      } satisfies DecomposeProgressPayload;
      const summary = formatProgress(partialPayload);
      emitPartialProgress(summary, latestPartialScenes);
    },
  });

  if (error) {
    const message = error.message || "";
    if (message.includes("剧本拆解未完成") && latestPartialScenes.length > 0) {
      const nextTitle = buildVideoTitle(runtime, input) || project.title;
      const partialSegmentCount = new Set(
        latestPartialScenes.map((scene) => scene.segmentLabel).filter(Boolean),
      ).size;
      return saveVideoProject(
        {
          ...project,
          title: nextTitle,
          script,
          scenes: latestPartialScenes,
          currentStep: 1,
          scriptBreakdownPassed: false,
          analysisSummary: `${message} 已保留当前成功拆出的 ${latestPartialScenes.length} 个镜头${partialSegmentCount ? `，覆盖 ${partialSegmentCount} 个片段` : ""}，可点击继续补拆缺失集。`,
          preferredEpisodeDurationSeconds: episodeDuration,
          preferredScriptBreakdownPace: videoPace,
          sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
        },
        `${message}\n\n已保留当前成功拆出的 ${latestPartialScenes.length} 个镜头，可在下方点击“继续补拆缺失集”。`,
      );
    }
    throw error;
  }

  const scenes = (data?.scenes || []).map((scene, index) => mapScene(scene, index));
  const segmentCount = new Set(
    scenes.map((scene) => scene.segmentLabel).filter(Boolean),
  ).size;
  const nextTitle = buildVideoTitle(runtime, input) || project.title;
  const breakdownMessage = buildStoryboardBreakdownMessage({
    title: nextTitle,
    scenes,
    characters: project.characters,
    sceneSettings: project.sceneSettings,
  });
  return saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      title: nextTitle,
      script,
      scenes,
      currentStep: 1,
      scriptBreakdownPassed: true,
      analysisSummary: retryMissingEpisodes
        ? `已在现有结果基础上补齐剧本拆解，共整理 ${scenes.length} 个镜头${segmentCount ? `，覆盖 ${segmentCount} 个片段` : ""}。`
        : `已完成镜头拆解，共整理 ${scenes.length} 个镜头${segmentCount ? `，覆盖 ${segmentCount} 个片段` : ""}。`,
      preferredEpisodeDurationSeconds: episodeDuration,
      preferredScriptBreakdownPace: videoPace,
      sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
      };
      return nextProject;
    })(),
    [
      retryMissingEpisodes
        ? `已在现有结果基础上继续拆解《${nextTitle}》，当前共 ${scenes.length} 个镜头。`
        : `已完成《${nextTitle}》的视频镜头拆解，共 ${scenes.length} 个镜头。`,
      breakdownMessage,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

export async function extractVideoEntitiesAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  if (!script) {
    throw new Error("当前没有可用于识别角色和场景的脚本内容。");
  }

  const replaceExistingEntities =
    input.replaceExistingEntities === true ||
    input.overwriteEntities === true ||
    input.resetEntities === true;
  const coverageCandidates = collectEntityCoverageCandidates(project.scenes || []);
  const maxRounds = Math.max(
    MIN_ENTITY_EXTRACTION_REVIEW_ROUNDS,
    resolveEntityExtractionMaxRounds(input),
  );
  let characters = replaceExistingEntities ? [] : [...(project.characters || [])];
  let sceneSettings = replaceExistingEntities ? [] : [...(project.sceneSettings || [])];
  let extractionRounds = 0;
  let makeUpRounds = 0;
  let previousFingerprint = buildEntityExtractionFingerprint(characters, sceneSettings);
  let finalGaps = resolveEntityCoverageGaps(coverageCandidates, characters, sceneSettings);

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
    if (
      roundIndex > 0 &&
      roundIndex >= MIN_ENTITY_EXTRACTION_REVIEW_ROUNDS &&
      finalGaps.missingCharacterNames.length === 0 &&
      finalGaps.missingSceneNames.length === 0
    ) {
      break;
    }

    if (
      roundIndex > 0 &&
      (finalGaps.missingCharacterNames.length > 0 || finalGaps.missingSceneNames.length > 0)
    ) {
      makeUpRounds += 1;
    }

    const extractionHint = roundIndex > 0 ? buildEntityExtractionHint(finalGaps) : undefined;
    const { data, error } = await invokeFunction<ExtractEntitiesResult>(
      "extract-characters-scenes",
      {
        script,
        model: typeof input.model === "string" ? input.model : undefined,
        ...(extractionHint ? { extractionHint } : {}),
      },
    );

    if (error) throw error;

    extractionRounds += 1;
    const qaNormalizedEntities = runEntityExtractionConsistencyQa({
      previousCharacters: characters,
      previousSceneSettings: sceneSettings,
      nextCharacters: mapCharacters(data?.characters, characters, {
        replaceExisting: false,
      }),
      nextSceneSettings: mapSceneSettings(data?.sceneSettings, sceneSettings, {
        replaceExisting: false,
      }),
    });
    const nextCharacters = qaNormalizedEntities.characters;
    const nextSceneSettings = qaNormalizedEntities.sceneSettings;
    const nextFingerprint = buildEntityExtractionFingerprint(nextCharacters, nextSceneSettings);
    const hasProgress = nextFingerprint !== previousFingerprint;

    characters = nextCharacters;
    sceneSettings = nextSceneSettings;
    finalGaps = resolveEntityCoverageGaps(coverageCandidates, characters, sceneSettings);
    previousFingerprint = nextFingerprint;

    if (
      finalGaps.missingCharacterNames.length === 0 &&
      finalGaps.missingSceneNames.length === 0 &&
      roundIndex >= MIN_ENTITY_EXTRACTION_REVIEW_ROUNDS - 1
    ) {
      break;
    }

    // 至少完成一次内部复核；复核/补漏轮如果没有新增内容，就提前停止，避免空转等待。
    if (roundIndex > 0 && !hasProgress) {
      break;
    }
  }

  const {
    characters: finalizedCharacters,
    sceneSettings: finalizedSceneSettings,
    placeholderCharacterCount,
    placeholderSceneCount,
  } = appendEntityCoveragePlaceholders(characters, sceneSettings, finalGaps);
  characters = finalizedCharacters;
  sceneSettings = finalizedSceneSettings;
  const scenes = invalidateEntityDependentSceneState(project.scenes || [], characters, sceneSettings);
  const reviewRounds = Math.max(0, extractionRounds - 1);
  const roundSummary = reviewRounds > 0
    ? makeUpRounds > 0
      ? reviewRounds > 1
        ? `已自动复核 ${reviewRounds} 轮，其中已自动补漏 ${makeUpRounds} 轮，并在命中后提前停止重复提取。`
        : "已自动复核 1 轮，并已自动补漏 1 轮。"
      : reviewRounds > 1
        ? `已自动复核 ${reviewRounds} 轮，并在命中后提前停止重复提取。`
        : "已自动复核 1 轮。"
    : "";
  const placeholderSummary =
    placeholderCharacterCount || placeholderSceneCount
      ? `仍有少量漏项时，已根据镜头草稿自动补入 ${placeholderCharacterCount} 个角色和 ${placeholderSceneCount} 个场景待完善项。`
      : "";
  const extractionSummary = [
    roundSummary,
    buildEntityExtractionSummary(characters, sceneSettings),
    placeholderSummary,
  ].filter(Boolean).join("\n\n");

  return saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      title: buildVideoTitle(runtime, input),
      script,
      scenes,
      characters,
      sceneSettings,
      shotPackets: [],
      videoPromptBatch: "",
      segmentVideoPrompts: {},
      reviewQueue: [],
      currentStep: 2,
      analysisSummary: [
        `已整理 ${characters.length} 个角色和 ${sceneSettings.length} 个场景设定，并已让旧镜头包与视频提示词失效，后续会基于最新设定重新生成。`,
        reviewRounds > 0
          ? makeUpRounds > 0
            ? reviewRounds > 1
              ? `本次自动复核 ${reviewRounds} 轮，其中补漏 ${makeUpRounds} 轮。`
              : "本次自动复核 1 轮，并补漏 1 轮。"
            : reviewRounds > 1
              ? `本次自动复核 ${reviewRounds} 轮。`
              : "本次自动复核 1 轮。"
          : "",
        placeholderCharacterCount || placeholderSceneCount
          ? `另根据镜头草稿补入 ${placeholderCharacterCount} 个角色和 ${placeholderSceneCount} 个场景待完善项。`
          : "",
      ].filter(Boolean).join(" "),
      sourceProjectId: project.sourceProjectId || runtime.currentDramaProject?.id,
      };
      return nextProject;
    })(),
    extractionSummary,
  );
}

export async function prepareStoryboardBatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，先运行脚本拆解更稳妥。");
  }
  let syncedProject = synchronizeVideoProductionState(project);
  assertReferenceAssetsReady(syncedProject);

  const storyboardPlan = buildStoryboardBatch(syncedProject);
  const nextProject = {
    ...syncedProject,
    storyboardPlan,
    currentStep: 3,
    analysisSummary: "分镜摘要已同步更新，可继续逐镜生成分镜图。",
  };
  const realtimeSummary = buildRealtimeStoryboardSummary(nextProject);
  const storyboardSummary = buildStoryboardBatchSummary({
    generatableCount: realtimeSummary.generatableCount,
    generatedCount: realtimeSummary.generatedCount,
    blockedCount: realtimeSummary.blockedCount,
    totalCount: realtimeSummary.totalCount,
    storyboardPlan: realtimeSummary.storyboardPlan,
  });

  return saveVideoProject(
    {
      ...nextProject,
      storyboardPlan: realtimeSummary.storyboardPlan,
    },
    [storyboardSummary, buildStoryboardOutputStabilitySummary(realtimeSummary)].join("\n\n"),
  );
}

export async function compileVideoShotPacketsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法编译镜头指令包。");
  }

  const synced = synchronizeVideoProductionState(project);
  const compileShotMode = resolveRequestedVideoGenerationPrefs(project, input).mode;
  assertStoryboardCompileReady(synced, compileShotMode);
  const shotPackets = deriveVideoShotPackets({
    ...synced,
    assetManifest: synced.assetManifest,
  });

  const img2videoCount = shotPackets.filter((p) => p.renderMode === "img2video").length;
  const text2videoCount = shotPackets.length - img2videoCount;
  const modeNote = img2videoCount > 0 && text2videoCount > 0
    ? `（图生视频 ${img2videoCount} 个，文生视频 ${text2videoCount} 个）`
    : img2videoCount > 0
      ? "（全部图生视频模式）"
      : "（全部文生视频模式，可先补充参考图提升画面一致性）";

  return saveVideoProject(
    {
      ...synced,
      shotPackets,
      // 文生视频：编译完镜头包后停留在第2步（角色与场景），让桥接面板再次弹出"视频提示词生成方式"
      // 图生视频：进入第3步（分镜图生成）
      currentStep: compileShotMode === "text-to-video" ? 2 : 3,
      analysisSummary: `已编译 ${shotPackets.length} 个镜头指令包${modeNote}，可继续选择视频提示词生成方式。`,
    },
    [
      `已为《${project.title}》编译 ${shotPackets.length} 个镜头指令包${modeNote}。`,
      buildShotPacketOutline(synced, shotPackets),
    ].join("\n\n"),
  );
}

export async function prepareVideoPromptBatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法选择视频提示词生成方式。");
  }
  let syncedProject = synchronizeVideoProductionState(project);
  const promptBatchMode = resolveRequestedVideoGenerationPrefs(project, input).mode;
  const isImageToVideo = promptBatchMode !== "text-to-video";

  // 图生视频模式：放宽条件，自动识别可用分镜图，至少需要1张
  if (isImageToVideo) {
    const readyFrameCount = countReadyStoryboardFrames(syncedProject);
    if (readyFrameCount < 1) {
      assertStoryboardAssetsReady(syncedProject, promptBatchMode);
    }
  } else {
    assertStoryboardAssetsReady(syncedProject, promptBatchMode);
  }

  if (!syncedProject.shotPackets?.length) {
    throw new Error("当前还没有镜头指令包，先编译镜头指令包再选择视频提示词生成方式。");
  }

  const batchMode = typeof input.batchMode === "string" ? input.batchMode : null;
  const targetIds = collectTargetIds(input);
  const hasExplicitSceneRange =
    typeof input.sceneStart === "number" || typeof input.sceneEnd === "number";
  const allScenesSorted = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const { order: episodeOrder, sceneMap: episodeSceneMap } = buildSceneProgressUnitMap(
    allScenesSorted,
    deriveShotPromptEpisodeKey,
  );
  const { order: segmentOrder, sceneMap: segmentSceneMap } = buildSceneProgressUnitMap(
    allScenesSorted,
    deriveShotPromptSegmentKey,
  );
  let selectedScenes: Scene[] = [];
  let selectedBatchSegmentLabel: string | null = null;
  let nextBatchSegmentLabel: string | null = null;
  const batchCoveredBefore = syncedProject.scenes.filter((scene) => scene.enhancedVideoPrompt?.trim()).length;

  if (targetIds.length) {
    selectedScenes = syncedProject.scenes.filter((scene) =>
      sceneTargetMatches(scene, syncedProject.id, targetIds),
    );
  } else if (hasExplicitSceneRange) {
    const start =
      typeof input.sceneStart === "number"
        ? input.sceneStart
        : syncedProject.scenes[0]?.sceneNumber ?? 1;
    const end =
      typeof input.sceneEnd === "number"
        ? input.sceneEnd
        : syncedProject.scenes.at(-1)?.sceneNumber ?? start;
    selectedScenes = syncedProject.scenes.filter(
      (scene) => scene.sceneNumber >= start && scene.sceneNumber <= end,
    );
  } else if (batchMode === "all") {
    // 全部生成：生成当前集内所有没有提示词的镜头，后续点击补齐下一集
    const targetEpisodeKey = episodeOrder.find((episodeKey) =>
      (episodeSceneMap.get(episodeKey) ?? []).some((scene) => !hasReadyShotPrompt(scene)),
    );
    if (!targetEpisodeKey) {
      selectedScenes = syncedProject.scenes;
    } else {
      selectedScenes = (episodeSceneMap.get(targetEpisodeKey) ?? []).filter((scene) => !hasReadyShotPrompt(scene));
    }
  } else if (batchMode === "batch") {
    // 单批生成：按顺序找到第一个未完整覆盖的片段，生成该片段内所有分镜（已有的叠加更新）
    // 找第一个还有未生成提示词的片段
    const targetSeg = segmentOrder.find((seg) =>
      (segmentSceneMap.get(seg) ?? []).some((scene) => !hasReadyShotPrompt(scene)),
    );
    if (targetSeg) {
      selectedBatchSegmentLabel = targetSeg === "__no_segment__" ? "未分组片段" : targetSeg;
      // 只选该片段内还没有提示词的镜头，已有的保留不动
      selectedScenes = (segmentSceneMap.get(targetSeg) ?? []).filter((scene) => !hasReadyShotPrompt(scene));
      nextBatchSegmentLabel =
        segmentOrder
          .slice(segmentOrder.indexOf(targetSeg) + 1)
          .find((seg) => (segmentSceneMap.get(seg) ?? []).some((scene) => !hasReadyShotPrompt(scene))) ?? null;
      if (nextBatchSegmentLabel === "__no_segment__") {
        nextBatchSegmentLabel = "未分组片段";
      }
    } else {
      // 所有片段已全部覆盖，无需再生成
      selectedScenes = [];
    }
  } else {
    const selectedSceneIds = new Set((syncedProject.shotPackets || []).map((packet) => packet.sceneId));
    selectedScenes = syncedProject.scenes.filter((scene) => selectedSceneIds.has(scene.id));
  }

  if (batchMode === "batch" && selectedScenes.length === 0) {
    const coveredScenes = syncedProject.scenes
      .filter((scene) => scene.enhancedVideoPrompt?.trim())
      .sort((left, right) => left.sceneNumber - right.sceneNumber);
    const videoPromptBatch = buildPromptBatchSummary(
      coveredScenes,
      coveredScenes.map((scene) => ({
        scene,
        prompt: {
          enhanced: scene.enhancedVideoPrompt || scene.description,
          duration: scene.recommendedDuration ?? scene.duration,
        },
      })),
    );

    return saveVideoProject(
      {
        ...syncedProject,
        videoPromptBatch,
        currentStep: 4,
        analysisSummary: "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
      },
      [
        "单批生成已完成：当前没有未覆盖的片段镜头。",
        `已覆盖 ${batchCoveredBefore} / ${syncedProject.scenes.length} 个镜头的视频提示词。`,
        "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
        buildPromptBatchSummaryOutline(syncedProject, coveredScenes),
        buildVideoAssetStatusReport(syncedProject, coveredScenes, promptBatchMode),
      ].join("\n\n"),
    );
  }

  // 图生视频模式：只对有分镜图的镜头生成提示词
  if (isImageToVideo) {
    selectedScenes = selectedScenes.filter((scene) => !!scene.storyboardUrl?.trim());
    if (selectedScenes.length === 0) {
      throw new Error("当前选中的镜头中没有可用的分镜图，请先生成分镜图再生成视频提示词。");
    }
  }

  selectedScenes = [...selectedScenes].sort((left, right) => left.sceneNumber - right.sceneNumber);
  const start = selectedScenes[0]?.sceneNumber ?? syncedProject.scenes[0]?.sceneNumber ?? 1;
  const end = selectedScenes.at(-1)?.sceneNumber ?? start;
  const progressFormatter =
    batchMode === "all"
      ? createShotPromptBatchProgressFormatter(
          episodeOrder,
          new Set(
            episodeOrder.filter((episodeKey) =>
              (episodeSceneMap.get(episodeKey) ?? []).every((scene) => hasReadyShotPrompt(scene)),
            ),
          ),
          "episode",
        )
      : batchMode === "batch"
        ? createShotPromptBatchProgressFormatter(
            segmentOrder,
            new Set(
              segmentOrder.filter((segmentKey) =>
                (segmentSceneMap.get(segmentKey) ?? []).every((scene) => hasReadyShotPrompt(scene)),
              ),
            ),
            "segment",
          )
        : null;
  const unitKeyForScene =
    batchMode === "all"
      ? deriveShotPromptEpisodeKey
      : batchMode === "batch"
        ? deriveShotPromptSegmentKey
        : null;
  const selectedUnitSceneMap = unitKeyForScene
    ? buildSceneProgressUnitMap(selectedScenes, unitKeyForScene).sceneMap
    : null;
  const sceneBatchGroups = selectedUnitSceneMap
    ? [...selectedUnitSceneMap.entries()].map(([unitKey, scenes]) => ({ unitKey, scenes }))
    : [{ unitKey: null, scenes: selectedScenes }];

  const promptResults: Array<{ scene: Scene; prompt: VideoEnhanceResult }> = [];
  let nextScenes = [...syncedProject.scenes];
  if (progressFormatter) {
    onProgress?.({ summary: progressFormatter({ status: "init" }) });
  }

  for (const { unitKey, scenes } of sceneBatchGroups) {
    if (progressFormatter && unitKey) {
      onProgress?.({ summary: progressFormatter({ unitKey, status: "processing" }) });
    }
    try {
      for (const scene of scenes) {
        const characterDetails = findCharacterDetails(scene, project.characters || []);
        const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
        const referenceImageUrl = findSceneReferenceImage(scene, syncedProject.sceneSettings || [], {
          excludeStoryboard: promptBatchMode === "text-to-video",
        });
        const sceneIdx = allScenesSorted.findIndex((s) => s.id === scene.id);
        const prevScene = sceneIdx > 0 ? allScenesSorted[sceneIdx - 1] : undefined;
        const nextScene = sceneIdx < allScenesSorted.length - 1 ? allScenesSorted[sceneIdx + 1] : undefined;
        const { data, error } = await invokeFunction<VideoEnhanceResult>(
          "enhance-video-prompt",
          {
            description: scene.description,
            characters: scene.characters,
            cameraDirection: scene.cameraDirection,
            sceneName: scene.sceneName,
            dialogue: scene.dialogue,
            style: resolveProjectImagePromptStyle(syncedProject),
            characterDescriptions: characterDetails,
            sceneDescription: matchedSetting?.description || scene.sceneName,
            prevDescription: prevScene?.description,
            nextDescription: nextScene?.description,
            referenceImageUrl,
            hasRefImage: Boolean(referenceImageUrl),
            videoMode: promptBatchMode,
            characterImages: characterDetails
              .filter((c) => c.imageUrl)
              .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
            textModel:
              typeof input.textModel === "string" && input.textModel.trim()
                ? input.textModel.trim()
                : undefined,
          },
        );

        if (error) throw error;

        const result = withExactDialogueLock(data || { enhanced: scene.description }, scene.dialogue);
        promptResults.push({ scene, prompt: result });

        const index = nextScenes.findIndex((item) => item.id === scene.id);
        if (index >= 0) {
          nextScenes[index] = {
            ...nextScenes[index],
            enhancedVideoPrompt: result.enhanced || nextScenes[index].enhancedVideoPrompt,
            recommendedDuration: result.duration ?? nextScenes[index].recommendedDuration,
          };
        }
      }

      if (progressFormatter && unitKey) {
        onProgress?.({ summary: progressFormatter({ unitKey, status: "done" }) });
      }
    } catch (error) {
      if (progressFormatter && unitKey) {
        onProgress?.({ summary: progressFormatter({ unitKey, status: "failed" }) });
      }
      throw error;
    }
  }

  const coveredScenesAfter = nextScenes
    .filter((scene) => scene.enhancedVideoPrompt?.trim())
    .sort((left, right) => left.sceneNumber - right.sceneNumber);
  const videoPromptBatch = batchMode === "batch"
    ? buildPromptBatchSummary(
        coveredScenesAfter,
        coveredScenesAfter.map((scene) => ({
          scene,
          prompt: {
            enhanced: scene.enhancedVideoPrompt || scene.description,
            duration: scene.recommendedDuration ?? scene.duration,
          },
        })),
      )
    : buildPromptBatchSummary(selectedScenes, promptResults);
  const batchCoveredAfter = coveredScenesAfter.length;
  const batchProgressNotice = batchMode === "batch"
    ? [
        selectedBatchSegmentLabel
          ? `单批生成已完成：本次处理片段 ${selectedBatchSegmentLabel}，新增 ${promptResults.length} 个镜头提示词。`
          : `单批生成已完成：新增 ${promptResults.length} 个镜头提示词。`,
        `累计已覆盖 ${batchCoveredAfter} / ${syncedProject.scenes.length} 个镜头的视频提示词。`,
        nextBatchSegmentLabel
          ? `下次点击“单批生成”会继续处理片段 ${nextBatchSegmentLabel}。`
          : "所有片段镜头的视频提示词都已覆盖完毕，可以继续进入视频生成。",
      ]
    : [];

  return saveVideoProject(
    {
      ...syncedProject,
      scenes: nextScenes,
      videoPromptBatch,
      currentStep: 4,
      analysisSummary: batchMode === "batch"
        ? batchProgressNotice.join(" ")
        : `已生成镜头 ${start}-${end} 的视频提示词批次，可继续接到生成工具。`,
    },
    [
      ...batchProgressNotice,
      `已生成镜头 ${start}-${end} 的视频提示词批次。`,
      buildPromptBatchSummaryOutline(
        { ...syncedProject, scenes: nextScenes },
        batchMode === "batch" ? coveredScenesAfter : selectedScenes,
      ),
      buildVideoAssetStatusReport(
        { ...syncedProject, scenes: nextScenes },
        batchMode === "batch" ? coveredScenesAfter : selectedScenes,
        promptBatchMode,
      ),
    ].join("\n\n"),
  );
}

export async function generateVideoReferenceAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = synchronizeVideoProductionState(mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  ));

  localStorage.setItem("storyforge_current_project", project.id);

  return runWithVideoAbortSignal(async (abortSignal) => {
    const imageGenerationInput = buildScopedImageGenerationInput(input, project);
    const mediaEventId =
      typeof input.mediaEventId === "string" && input.mediaEventId.trim()
        ? input.mediaEventId.trim()
        : undefined;
    let nextCharacters = [...(project.characters || [])];
    let nextSceneSettings = [...(project.sceneSettings || [])];
    let workingProject: PersistedVideoProject = project;
    const assetPrimaryRetryBudget = project.automationState?.assetPrimaryRetryBudget ?? DEFAULT_VIDEO_AUTOMATION_TEMPLATE.assetPrimaryRetryBudget;
    const assetVariantRetryBudget = project.automationState?.assetVariantRetryBudget ?? DEFAULT_VIDEO_AUTOMATION_TEMPLATE.assetVariantRetryBudget;
    const updateWorkingProject = (nextProject: PersistedVideoProject) => {
      workingProject = synchronizeVideoProductionState({
        ...nextProject,
        characters: nextCharacters,
        sceneSettings: nextSceneSettings,
      });
    };
    const markReferenceTargetReady = (
      targetId: string,
      imageUrl: string,
      options: {
        attempts?: number;
        sourceRefs?: string[];
        qualityScore?: number;
        qaInspected?: boolean;
        qaSummary?: string;
        qaScore?: number;
        qaPassed?: boolean;
        qaQualityTier?: ReferenceImageQualityReport["qualityTier"];
        qaGoldenSampleVersion?: string;
        qaStrengths?: string[];
        qaGoldenSignals?: string[];
        qaFixPriorities?: string[];
        qaIssues?: string[];
      } = {},
    ) => {
      const timestamp = new Date().toISOString();
      updateWorkingProject(
        dismissReferenceTargetReviewItems(
          withReferenceTargetState(workingProject, targetId, (state) => ({
            ...state,
            targetId,
            status: "ready",
            attemptCount: (state?.attemptCount || 0) + Math.max(options.attempts || 0, 0),
            retryBudget: state?.retryBudget || 0,
            lastError: undefined,
            lastTriedAt: timestamp,
            lastSucceededAt: timestamp,
            generatedUrl: imageUrl,
            qualityScore: options.qualityScore ?? state?.qualityScore,
            sourceRefs: options.sourceRefs ?? state?.sourceRefs,
            lastQaSummary:
              options.qaInspected === undefined
                ? state?.lastQaSummary
                : options.qaInspected
                  ? options.qaSummary
                  : undefined,
            lastQaScore:
              options.qaInspected === undefined
                ? state?.lastQaScore
                : options.qaInspected
                  ? options.qaScore
                  : undefined,
            lastQaPassed:
              options.qaInspected === undefined
                ? state?.lastQaPassed
                : options.qaInspected
                  ? options.qaPassed
                  : undefined,
            lastQaQualityTier:
              options.qaInspected === undefined
                ? state?.lastQaQualityTier
                : options.qaInspected
                  ? options.qaQualityTier
                  : undefined,
            lastQaGoldenSampleVersion:
              options.qaInspected === undefined
                ? state?.lastQaGoldenSampleVersion
                : options.qaInspected
                  ? options.qaGoldenSampleVersion
                  : undefined,
            lastQaStrengths:
              options.qaInspected === undefined
                ? state?.lastQaStrengths
                : options.qaInspected
                  ? options.qaStrengths
                  : undefined,
            lastQaGoldenSignals:
              options.qaInspected === undefined
                ? state?.lastQaGoldenSignals
                : options.qaInspected
                  ? options.qaGoldenSignals
                  : undefined,
            lastQaFixPriorities:
              options.qaInspected === undefined
                ? state?.lastQaFixPriorities
                : options.qaInspected
                  ? options.qaFixPriorities
                  : undefined,
            lastQaIssues:
              options.qaInspected === undefined
                ? state?.lastQaIssues
                : options.qaInspected
                  ? options.qaIssues
                  : undefined,
            lastQaAt:
              options.qaInspected === undefined
                ? state?.lastQaAt
                : options.qaInspected
                ? timestamp
                : undefined,
          })),
          [targetId],
          "approved",
          "参考资产已由自动补图补齐。",
        ),
      );
    };
    const markReferenceTargetFailed = (
      targetId: string,
      params: {
        attempts: number;
        reason: string;
        exhausted: boolean;
        sourceRefs?: string[];
        qaInspected?: boolean;
        qaSummary?: string;
        qaScore?: number;
        qaPassed?: boolean;
        qaQualityTier?: ReferenceImageQualityReport["qualityTier"];
        qaGoldenSampleVersion?: string;
        qaStrengths?: string[];
        qaGoldenSignals?: string[];
        qaFixPriorities?: string[];
        qaIssues?: string[];
      },
    ) => {
      const timestamp = new Date().toISOString();
      let nextProject = withReferenceTargetState(workingProject, targetId, (state) => ({
        ...state,
        targetId,
        status: params.exhausted ? "exhausted" : "retryable",
        attemptCount: (state?.attemptCount || 0) + params.attempts,
        retryBudget: state?.retryBudget || 0,
        lastError: params.reason,
        lastTriedAt: timestamp,
        sourceRefs: params.sourceRefs ?? state?.sourceRefs,
        lastQaSummary:
          params.qaInspected === undefined
            ? state?.lastQaSummary
            : params.qaInspected
              ? params.qaSummary
              : undefined,
        lastQaScore:
          params.qaInspected === undefined
            ? state?.lastQaScore
            : params.qaInspected
              ? params.qaScore
              : undefined,
        lastQaPassed:
          params.qaInspected === undefined
            ? state?.lastQaPassed
            : params.qaInspected
              ? params.qaPassed
              : undefined,
        lastQaQualityTier:
          params.qaInspected === undefined
            ? state?.lastQaQualityTier
            : params.qaInspected
              ? params.qaQualityTier
              : undefined,
        lastQaGoldenSampleVersion:
          params.qaInspected === undefined
            ? state?.lastQaGoldenSampleVersion
            : params.qaInspected
              ? params.qaGoldenSampleVersion
              : undefined,
        lastQaStrengths:
          params.qaInspected === undefined
            ? state?.lastQaStrengths
            : params.qaInspected
              ? params.qaStrengths
              : undefined,
        lastQaGoldenSignals:
          params.qaInspected === undefined
            ? state?.lastQaGoldenSignals
            : params.qaInspected
              ? params.qaGoldenSignals
              : undefined,
        lastQaFixPriorities:
          params.qaInspected === undefined
            ? state?.lastQaFixPriorities
            : params.qaInspected
              ? params.qaFixPriorities
              : undefined,
        lastQaIssues:
          params.qaInspected === undefined
            ? state?.lastQaIssues
            : params.qaInspected
              ? params.qaIssues
              : undefined,
        lastQaAt:
          params.qaInspected === undefined
            ? state?.lastQaAt
            : params.qaInspected
            ? timestamp
            : undefined,
      }));
      if (params.exhausted) {
        nextProject = upsertReferenceTargetReviewItem(
          nextProject,
          targetId,
          `${targetId} 已超出自动补图预算：${params.reason}`,
          "pending",
          timestamp,
        );
      }
      updateWorkingProject(nextProject);
    };
    const markReferenceTargetBlocked = (
      targetId: string,
      dependencyTargetId: string,
      reason: string,
    ) => {
      const timestamp = new Date().toISOString();
      updateWorkingProject(withReferenceTargetState(workingProject, targetId, (state) => ({
        ...state,
        targetId,
        status: "blocked",
        attemptCount: state?.attemptCount || 0,
        retryBudget: state?.retryBudget || 0,
        dependencyTargetIds: [dependencyTargetId],
        lastError: reason,
        lastTriedAt: timestamp,
      })));
    };
    const emitImageFailure = (slotIndex: number, label: string, reason: string) => {
      if (typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
        detail: { index: slotIndex, label, reason, ...(mediaEventId ? { mediaEventId } : {}) },
      }));
    };
    const noteReferenceQaReport = (report: ReferenceImageQualityReport | null | undefined, passed: boolean) => {
      if (!report?.inspected) return;
      if (passed) {
        passedReferenceAssetQaCount += 1;
      } else {
        rejectedReferenceAssetQaCount += 1;
      }
      getBlockingReferenceImageQaIssues(report)
        .slice(0, 3)
        .forEach((issue) => {
          const trimmed = issue.trim();
          if (trimmed) highlightedReferenceQaIssues.add(trimmed);
        });
      if (report.summary?.trim() && !passed && highlightedReferenceQaIssues.size < 3) {
        highlightedReferenceQaIssues.add(report.summary.trim());
      }
    };
    let retriedReferenceAssetCount = 0;
    const buildReferenceRetryDescription = (
      description: string,
      attempt: number,
      mode: "character" | "scene",
    ) => {
      if (attempt <= 1) return description;
      const retryRules = mode === "character"
        ? "重试要求：保持角色身份、服装轮廓、发型与面部特征完全一致，主体完整入镜，构图清晰稳定。"
        : "重试要求：保持空间结构、时代材质、主光方向与场景主体一致，画面完整清晰，不要偏离原始设定。";
      return `${description}\n${retryRules}\n第 ${attempt} 次自动补图，优先稳定一致性与可复用性。`;
    };
    const generateReferenceAssetWithRetries = async (params: {
      action: "generate-character" | "generate-scene";
      mode: "character" | "scene";
      name: string;
      description: string;
      style: string;
      referenceImageUrl?: string;
      assetFileNameStem: string;
      maxAttempts: number;
      variantDistinctness?: {
        variantLabel: string;
        variantDescription: string;
        siblingVariants: Array<{
          label: string;
          description?: string;
          imageUrl: string;
        }>;
      };
    }): Promise<{
      imageUrl?: string;
      attempts: number;
      reason?: string;
      qaReport?: ReferenceImageQualityReport | null;
      rejectedQaAttempts: number;
    }> => {
      let lastReason = "";
      let lastQaReport: ReferenceImageQualityReport | null = null;
      let rejectedQaAttempts = 0;
      for (let attempt = 1; attempt <= params.maxAttempts; attempt += 1) {
        const { data, error } = await invokeFunction<{ imageUrl?: string }>(
          params.action,
          {
            ...imageGenerationInput,
            name: params.name,
            description: buildReferenceRetryDescription(params.description, attempt, params.mode),
            style: params.style,
            ...(params.referenceImageUrl ? { referenceImageUrl: params.referenceImageUrl } : {}),
            assetFileNameStem:
              attempt === 1
                ? params.assetFileNameStem
                : `${params.assetFileNameStem}-retry-${attempt}`,
          },
          { abortSignal: buildPerImageAbortSignal(abortSignal) },
        );
        if (error) {
          if (abortSignal?.aborted) throw error;
          lastReason = error instanceof Error ? error.message : String(error);
        } else {
          const imageUrl = await resolveVerifiedGeneratedReferenceImageUrl(data?.imageUrl);
          if (imageUrl) {
            let qaReport = await analyzeReferenceImageQuality({
              imageUrl,
              mode: params.mode,
              name: params.name,
              description: params.description,
              referenceImageUrl: params.referenceImageUrl,
              projectStyleContext: buildProjectReferenceImageQaStyleContext(project),
            });
            if (params.variantDistinctness && params.referenceImageUrl) {
              const distinctnessReport = await analyzeReferenceVariantDistinctness({
                imageUrl,
                mode: params.mode,
                name: params.name,
                variantLabel: params.variantDistinctness.variantLabel,
                variantDescription: params.variantDistinctness.variantDescription,
                primaryReferenceImageUrl: params.referenceImageUrl,
                siblingVariants: params.variantDistinctness.siblingVariants,
              });
              if (distinctnessReport?.inspected && !distinctnessReport.distinctEnough) {
                qaReport = mergeVariantDistinctnessIntoReferenceQaReport(qaReport, distinctnessReport);
              }
            }
            if (shouldRejectReferenceImageQuality(qaReport)) {
              if (qaReport) {
                lastQaReport = qaReport;
                rejectedQaAttempts += 1;
                noteReferenceQaReport(qaReport, false);
              }
              lastReason = buildReferenceImageQaFailureReason({
                report: qaReport!,
                mode: params.mode,
                name: params.name,
              });
              continue;
            }
            retriedReferenceAssetCount += Math.max(attempt - 1, 0);
            return { imageUrl, attempts: attempt, qaReport, rejectedQaAttempts };
          }
          lastReason = "图片生成结果不可用";
        }
      }
      retriedReferenceAssetCount += Math.max(params.maxAttempts - 1, 0);
      return {
        attempts: params.maxAttempts,
        reason: lastReason || "图片生成结果不可用",
        qaReport: lastQaReport,
        rejectedQaAttempts,
      };
    };
    const requestedTargetIds = collectTargetIds(input);
    const smartBatch = input.smartBatch === true;
    const smartBatchLimit = resolveSmartReferenceAssetBatchLimit(input, project);
    const forceRegenerate = input.forceRegenerate === true;
    const countedSkippedCharacterVariantIds = new Set<string>();
    const countedSkippedSceneVariantIds = new Set<string>();
    let matchedCharacterVariantTargetCount = 0;
    let matchedSceneVariantTargetCount = 0;
    let failedReferenceAssetCount = 0;
    let skippedDependencyCount = 0;
    let passedReferenceAssetQaCount = 0;
    let rejectedReferenceAssetQaCount = 0;
    const highlightedReferenceQaIssues = new Set<string>();
    const scrubbedAssets = await scrubBrokenReferenceAssetUrls(nextCharacters, nextSceneSettings);
    nextCharacters = scrubbedAssets.characters;
    nextSceneSettings = scrubbedAssets.sceneSettings;
    updateWorkingProject({
      ...project,
      characters: nextCharacters,
      sceneSettings: nextSceneSettings,
    });
    const inferredTargetIds =
      smartBatch && requestedTargetIds.length === 0
        ? listPendingReferenceAssetTargetIds(workingProject)
        : requestedTargetIds;
    const targetIds = smartBatch && inferredTargetIds.length > smartBatchLimit
      ? inferredTargetIds.slice(0, smartBatchLimit)
      : inferredTargetIds;
    const remainingSmartTargetCount = smartBatch
      ? Math.max(inferredTargetIds.length - targetIds.length, 0)
      : 0;
    console.info("[video-reference-assets] start", {
      projectId: project.id,
      targetIds,
      requestedTargetCount: inferredTargetIds.length,
      smartBatch,
      smartBatchLimit,
      forceRegenerate,
    });
    const selectedCharacterIds = new Set(
      nextCharacters
        .filter((character) => !targetIds.length || characterReferenceTargetMatches(character, targetIds))
        .map((character) => character.id),
    );
    const selectedSceneSettingIds = new Set(
      nextSceneSettings
        .filter((sceneSetting) => !targetIds.length || sceneReferenceTargetMatches(sceneSetting, targetIds))
        .map((sceneSetting) => sceneSetting.id),
    );
    const selectedCharacters = nextCharacters.filter((character) => selectedCharacterIds.has(character.id));
    const selectedSceneSettings = nextSceneSettings.filter((sceneSetting) =>
      selectedSceneSettingIds.has(sceneSetting.id),
    );
    await pauseBeforeMediaSubmission({
      input,
      onProgress,
      kind: "image",
      title:
        targetIds.length > 1
          ? `已整理 ${targetIds.length} 个参考图生成目标。`
          : targetIds.length === 1
            ? "已整理 1 个参考图生成目标。"
            : `已整理 ${selectedCharacters.length + selectedSceneSettings.length} 个参考图生成目标。`,
      content: buildReferenceAssetSubmissionContent({
        project: workingProject,
        targetIds,
        selectedCharacters,
        selectedSceneSettings,
      }),
      requestCount:
        targetIds.length || Math.max(1, selectedCharacters.length + selectedSceneSettings.length),
      abortSignal,
    });
    const completedImages: Array<{ url: string; label: string } | undefined> = [];
    const generationConcurrency = Math.max(1, smartBatchLimit);
    let generatedCharacterPrimaryCount = 0;
    let generatedCharacterVariantCount = 0;
    let generatedScenePrimaryCount = 0;
    let generatedSceneVariantCount = 0;
    let generatedImageSlotIndex = 0;
    const primaryTasks: Array<() => Promise<void>> = [];

    for (let index = 0; index < nextCharacters.length; index += 1) {
      const character = nextCharacters[index];
      if (!character) continue;
      if (!selectedCharacterIds.has(character.id) || (!forceRegenerate && hasUsableMediaUrl(character.imageUrl))) {
        continue;
      }

      const slotIndex = generatedImageSlotIndex;
      generatedImageSlotIndex += 1;
      const nextVersion = resolveNextAssetVersion(character.imageUrl, character.imageHistory);
      primaryTasks.push(async () => {
        const result = await generateReferenceAssetWithRetries({
          action: "generate-character",
          mode: "character",
          name: character.name,
          description: character.description,
          style: resolveProjectImagePromptStyle(project),
          assetFileNameStem: buildCharacterAssetFileStem(character.name, {
            version: nextVersion,
          }),
          maxAttempts: assetPrimaryRetryBudget,
        });
        if (!result.imageUrl) {
          failedReferenceAssetCount += 1;
          markReferenceTargetFailed(`reference-character:${character.id}`, {
            attempts: result.attempts,
            reason: result.reason || "图片生成结果不可用",
            exhausted: true,
            qaInspected: Boolean(result.qaReport?.inspected),
            qaSummary: result.qaReport?.summary,
            qaScore: result.qaReport?.overallScore,
            qaPassed: false,
            qaQualityTier: result.qaReport?.qualityTier,
            qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
            qaStrengths: result.qaReport?.strengths,
            qaGoldenSignals: result.qaReport?.goldenSignals,
            qaFixPriorities: result.qaReport?.fixPriorities,
            qaIssues: result.qaReport?.issues,
          });
          if (smartBatch) {
            skippedDependencyCount += (character.costumes ?? []).filter((costume) => {
              const isTargeted = characterVariantTargetMatches(character.id, costume.id, targetIds);
              if (isTargeted) countedSkippedCharacterVariantIds.add(`${character.id}:${costume.id}`);
              return isTargeted;
            }).length;
          }
          console.warn(`[reference] 角色《${character.name}》主图生成失败，已跳过:`, result.reason);
          emitImageFailure(slotIndex, character.name, result.reason || "图片生成结果不可用，AI 代理会继续补齐该资产。");
          return;
        }
        const imageUrl = result.imageUrl;

        nextCharacters[index] = {
          ...character,
          imageUrl,
          isAIGenerated: true,
          isGenerating: false,
          imageHistory: appendImageHistory(
            character.imageUrl,
            imageUrl,
            character.description || character.name,
            character.imageHistory,
          ),
        };
        updateWorkingProject({
          ...workingProject,
          characters: nextCharacters,
          sceneSettings: nextSceneSettings,
        });
        noteReferenceQaReport(result.qaReport, true);
        markReferenceTargetReady(`reference-character:${character.id}`, imageUrl, {
          attempts: result.attempts,
          qualityScore: result.qaReport?.overallScore ?? 90,
          qaInspected: Boolean(result.qaReport?.inspected),
          qaSummary: result.qaReport?.summary,
          qaScore: result.qaReport?.overallScore,
          qaPassed: result.qaReport ? !shouldRejectReferenceImageQuality(result.qaReport) : undefined,
          qaQualityTier: result.qaReport?.qualityTier,
          qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
          qaStrengths: result.qaReport?.strengths,
          qaGoldenSignals: result.qaReport?.goldenSignals,
          qaFixPriorities: result.qaReport?.fixPriorities,
          qaIssues: result.qaReport?.issues,
        });
        const charPrimaryLabel = buildCharacterAssetLabel(character.name, {
          version: nextVersion,
        });
        completedImages[slotIndex] = { url: imageUrl, label: charPrimaryLabel };
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
            detail: {
              url: imageUrl,
              label: charPrimaryLabel,
              index: slotIndex,
              ...(mediaEventId ? { mediaEventId } : {}),
              action: "generate_video_reference_assets",
              projectId: project.id,
              targetId: `reference-character:${character.id}`,
              regenerateMode: "generate",
            },
          }));
        }
        generatedCharacterPrimaryCount += 1;
        emitVideoImageProgress(
          onProgress,
          {
            ...project,
            characters: nextCharacters,
            sceneSettings: nextSceneSettings,
          },
          imageUrl,
          charPrimaryLabel,
        );
      });
    }

    for (let index = 0; index < nextSceneSettings.length; index += 1) {
      const sceneSetting = nextSceneSettings[index];
      if (!sceneSetting) continue;
      if (!selectedSceneSettingIds.has(sceneSetting.id) || (!forceRegenerate && hasUsableMediaUrl(sceneSetting.imageUrl))) {
        continue;
      }

      const slotIndex = generatedImageSlotIndex;
      generatedImageSlotIndex += 1;
      const nextVersion = resolveNextAssetVersion(sceneSetting.imageUrl, sceneSetting.imageHistory);
      primaryTasks.push(async () => {
        const result = await generateReferenceAssetWithRetries({
          action: "generate-scene",
          mode: "scene",
          name: sceneSetting.name,
          description: sceneSetting.description,
          style: resolveProjectImagePromptStyle(project),
          assetFileNameStem: buildSceneAssetFileStem(sceneSetting.name, {
            version: nextVersion,
          }),
          maxAttempts: assetPrimaryRetryBudget,
        });
        if (!result.imageUrl) {
          failedReferenceAssetCount += 1;
          markReferenceTargetFailed(`reference-scene:${sceneSetting.id}`, {
            attempts: result.attempts,
            reason: result.reason || "图片生成结果不可用",
            exhausted: true,
            qaInspected: Boolean(result.qaReport?.inspected),
            qaSummary: result.qaReport?.summary,
            qaScore: result.qaReport?.overallScore,
            qaPassed: false,
            qaQualityTier: result.qaReport?.qualityTier,
            qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
            qaStrengths: result.qaReport?.strengths,
            qaGoldenSignals: result.qaReport?.goldenSignals,
            qaFixPriorities: result.qaReport?.fixPriorities,
            qaIssues: result.qaReport?.issues,
          });
          if (smartBatch) {
            skippedDependencyCount += (sceneSetting.timeVariants ?? []).filter((variant) => {
              const isTargeted = sceneVariantTargetMatches(sceneSetting.id, variant.id, targetIds);
              if (isTargeted) countedSkippedSceneVariantIds.add(`${sceneSetting.id}:${variant.id}`);
              return isTargeted;
            }).length;
          }
          console.warn(`[reference] 场景《${sceneSetting.name}》主图生成失败，已跳过:`, result.reason);
          emitImageFailure(slotIndex, sceneSetting.name, result.reason || "图片生成结果不可用，AI 代理会继续补齐该资产。");
          return;
        }
        const imageUrl = result.imageUrl;

        nextSceneSettings[index] = {
          ...sceneSetting,
          imageUrl,
          isAIGenerated: true,
          isGenerating: false,
          imageHistory: appendImageHistory(
            sceneSetting.imageUrl,
            imageUrl,
            sceneSetting.description || sceneSetting.name,
            sceneSetting.imageHistory,
          ),
        };
        updateWorkingProject({
          ...workingProject,
          characters: nextCharacters,
          sceneSettings: nextSceneSettings,
        });
        noteReferenceQaReport(result.qaReport, true);
        markReferenceTargetReady(`reference-scene:${sceneSetting.id}`, imageUrl, {
          attempts: result.attempts,
          qualityScore: result.qaReport?.overallScore ?? 90,
          qaInspected: Boolean(result.qaReport?.inspected),
          qaSummary: result.qaReport?.summary,
          qaScore: result.qaReport?.overallScore,
          qaPassed: result.qaReport ? !shouldRejectReferenceImageQuality(result.qaReport) : undefined,
          qaQualityTier: result.qaReport?.qualityTier,
          qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
          qaStrengths: result.qaReport?.strengths,
          qaGoldenSignals: result.qaReport?.goldenSignals,
          qaFixPriorities: result.qaReport?.fixPriorities,
          qaIssues: result.qaReport?.issues,
        });
        const scenePrimaryLabel = buildSceneAssetLabel(sceneSetting.name, {
          version: nextVersion,
        });
        completedImages[slotIndex] = { url: imageUrl, label: scenePrimaryLabel };
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
            detail: {
              url: imageUrl,
              label: scenePrimaryLabel,
              index: slotIndex,
              ...(mediaEventId ? { mediaEventId } : {}),
              action: "generate_video_reference_assets",
              projectId: project.id,
              targetId: `reference-scene:${sceneSetting.id}`,
              regenerateMode: "generate",
            },
          }));
        }
        generatedScenePrimaryCount += 1;
        emitVideoImageProgress(
          onProgress,
          {
            ...project,
            characters: nextCharacters,
            sceneSettings: nextSceneSettings,
          },
          imageUrl,
          scenePrimaryLabel,
        );
      });
    }

    await mapWithConcurrency(primaryTasks, generationConcurrency, async (task) => task());

    const variantTasks: Array<() => Promise<void>> = [];

    for (let index = 0; index < nextCharacters.length; index += 1) {
      const refreshedCharacter = nextCharacters[index];
      if (!refreshedCharacter?.costumes?.length) continue;

      for (let costumeIndex = 0; costumeIndex < refreshedCharacter.costumes.length; costumeIndex += 1) {
        const costume = refreshedCharacter.costumes[costumeIndex];
        if (!costume || !characterVariantTargetMatches(refreshedCharacter.id, costume.id, targetIds)) continue;
        matchedCharacterVariantTargetCount += 1;
        const hasExplicitTarget = hasExplicitCharacterVariantTarget(
          refreshedCharacter.id,
          costume.id,
          targetIds,
        );

        const primaryReferenceImageUrl = findCharacterPrimaryReferenceImage({
          ...project,
          characters: nextCharacters,
          sceneSettings: nextSceneSettings,
        }, refreshedCharacter);
        if (!primaryReferenceImageUrl) {
          const message = `角色《${refreshedCharacter.name}》还没有主参考图，先生成主参考图后才能生成变体。`;
          if (!smartBatch) throw new Error(message);
          markReferenceTargetBlocked(
            `reference-character-variant:${refreshedCharacter.id}:${costume.id}`,
            `reference-character:${refreshedCharacter.id}`,
            message,
          );
          const variantKey = `${refreshedCharacter.id}:${costume.id}`;
          if (!countedSkippedCharacterVariantIds.has(variantKey)) {
            skippedDependencyCount += 1;
            countedSkippedCharacterVariantIds.add(variantKey);
          }
          console.warn(`[reference] ${message}`);
          continue;
        }
        if (!forceRegenerate && !hasExplicitTarget && hasUsableMediaUrl(costume.imageUrl)) continue;
        console.info("[video-reference-assets] generate character variant", {
          projectId: project.id,
          characterId: refreshedCharacter.id,
          variantId: costume.id,
          hasExplicitTarget,
          forceRegenerate,
          referenceImageUrl: primaryReferenceImageUrl,
        });

        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const nextVersion = resolveNextAssetVersion(costume.imageUrl, costume.imageHistory);
        variantTasks.push(async () => {
          const currentCharacterForQa = nextCharacters[index] || refreshedCharacter;
          const currentCostumeForQa =
            currentCharacterForQa.costumes?.find((item) => item.id === costume.id) || costume;
          const result = await generateReferenceAssetWithRetries({
            action: "generate-character",
            mode: "character",
            name: refreshedCharacter.name,
            description: buildCharacterVariantReferenceDescription(refreshedCharacter, costume),
            style: resolveProjectImagePromptStyle(project),
            referenceImageUrl: primaryReferenceImageUrl,
            assetFileNameStem: buildCharacterAssetFileStem(refreshedCharacter.name, {
              variantLabel: costume.label,
              version: nextVersion,
            }),
            maxAttempts: assetVariantRetryBudget,
            variantDistinctness: {
              variantLabel: currentCostumeForQa.label,
              variantDescription: currentCostumeForQa.description || "",
              siblingVariants: collectCharacterSiblingVariantReferenceImages(currentCharacterForQa, costume.id),
            },
          });
          if (!result.imageUrl) {
            failedReferenceAssetCount += 1;
            markReferenceTargetFailed(`reference-character-variant:${refreshedCharacter.id}:${costume.id}`, {
              attempts: result.attempts,
              reason: result.reason || "图片生成结果不可用",
              exhausted: true,
              sourceRefs: [primaryReferenceImageUrl],
              qaInspected: Boolean(result.qaReport?.inspected),
              qaSummary: result.qaReport?.summary,
              qaScore: result.qaReport?.overallScore,
              qaPassed: false,
              qaQualityTier: result.qaReport?.qualityTier,
              qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
              qaStrengths: result.qaReport?.strengths,
              qaGoldenSignals: result.qaReport?.goldenSignals,
              qaFixPriorities: result.qaReport?.fixPriorities,
              qaIssues: result.qaReport?.issues,
            });
            console.warn(`[reference] 角色《${refreshedCharacter.name}》变体《${costume.label}》生成失败，已跳过:`, result.reason);
            emitImageFailure(slotIndex, `${refreshedCharacter.name} · ${costume.label}`, result.reason || "图片生成结果不可用，AI 代理会继续补齐该资产。");
            return;
          }
          const imageUrl = result.imageUrl;

          const latestCharacter = nextCharacters[index];
          if (!latestCharacter?.costumes?.[costumeIndex]) return;
          const latestCostumes = [...latestCharacter.costumes];
          const latestCostume = latestCostumes[costumeIndex];
          latestCostumes[costumeIndex] = {
            ...latestCostume,
            imageUrl,
            isAIGenerated: true,
            imageHistory: appendImageHistory(
              latestCostume.imageUrl,
              imageUrl,
              latestCostume.description || latestCostume.label,
              latestCostume.imageHistory,
            ),
          };
          nextCharacters[index] = {
            ...latestCharacter,
            costumes: latestCostumes,
          };
          updateWorkingProject({
            ...workingProject,
            characters: nextCharacters,
            sceneSettings: nextSceneSettings,
          });
          noteReferenceQaReport(result.qaReport, true);
          markReferenceTargetReady(`reference-character-variant:${refreshedCharacter.id}:${costume.id}`, imageUrl, {
            attempts: result.attempts,
            sourceRefs: [primaryReferenceImageUrl],
            qualityScore: result.qaReport?.overallScore ?? 88,
            qaInspected: Boolean(result.qaReport?.inspected),
            qaSummary: result.qaReport?.summary,
            qaScore: result.qaReport?.overallScore,
            qaPassed: result.qaReport ? !shouldRejectReferenceImageQuality(result.qaReport) : undefined,
            qaQualityTier: result.qaReport?.qualityTier,
            qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
            qaStrengths: result.qaReport?.strengths,
            qaGoldenSignals: result.qaReport?.goldenSignals,
            qaFixPriorities: result.qaReport?.fixPriorities,
            qaIssues: result.qaReport?.issues,
          });
          const charVariantLabel = buildCharacterAssetLabel(refreshedCharacter.name, {
            variantLabel: costume.label,
            version: nextVersion,
          });
          completedImages[slotIndex] = { url: imageUrl, label: charVariantLabel };
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
              detail: {
                url: imageUrl,
                label: charVariantLabel,
                index: slotIndex,
                ...(mediaEventId ? { mediaEventId } : {}),
                action: "generate_video_reference_assets",
                projectId: project.id,
                targetId: `reference-character-variant:${refreshedCharacter.id}:${costume.id}`,
                regenerateMode: "generate",
              },
            }));
          }
          generatedCharacterVariantCount += 1;
          emitVideoImageProgress(
            onProgress,
            {
              ...project,
              characters: nextCharacters,
              sceneSettings: nextSceneSettings,
            },
            imageUrl,
            charVariantLabel,
          );
        });
      }
    }

    for (let index = 0; index < nextSceneSettings.length; index += 1) {
      const refreshedSceneSetting = nextSceneSettings[index];
      if (!refreshedSceneSetting?.timeVariants?.length) continue;

      for (let variantIndex = 0; variantIndex < refreshedSceneSetting.timeVariants.length; variantIndex += 1) {
        const variant = refreshedSceneSetting.timeVariants[variantIndex];
        if (!variant || !sceneVariantTargetMatches(refreshedSceneSetting.id, variant.id, targetIds)) continue;
        matchedSceneVariantTargetCount += 1;
        const hasExplicitTarget = hasExplicitSceneVariantTarget(
          refreshedSceneSetting.id,
          variant.id,
          targetIds,
        );

        const primaryReferenceImageUrl = findScenePrimaryReferenceImage({
          ...project,
          characters: nextCharacters,
          sceneSettings: nextSceneSettings,
        }, refreshedSceneSetting);
        if (!primaryReferenceImageUrl) {
          const message = `场景《${refreshedSceneSetting.name}》还没有主参考图，先生成主参考图后才能生成变体。`;
          if (!smartBatch) throw new Error(message);
          markReferenceTargetBlocked(
            `reference-scene-variant:${refreshedSceneSetting.id}:${variant.id}`,
            `reference-scene:${refreshedSceneSetting.id}`,
            message,
          );
          const variantKey = `${refreshedSceneSetting.id}:${variant.id}`;
          if (!countedSkippedSceneVariantIds.has(variantKey)) {
            skippedDependencyCount += 1;
            countedSkippedSceneVariantIds.add(variantKey);
          }
          console.warn(`[reference] ${message}`);
          continue;
        }
        if (!forceRegenerate && !hasExplicitTarget && hasUsableMediaUrl(variant.imageUrl)) continue;
        console.info("[video-reference-assets] generate scene variant", {
          projectId: project.id,
          sceneSettingId: refreshedSceneSetting.id,
          variantId: variant.id,
          hasExplicitTarget,
          forceRegenerate,
          referenceImageUrl: primaryReferenceImageUrl,
        });

        const slotIndex = generatedImageSlotIndex;
        generatedImageSlotIndex += 1;
        const nextVersion = resolveNextAssetVersion(variant.imageUrl, variant.imageHistory);
        variantTasks.push(async () => {
          const currentSceneSettingForQa = nextSceneSettings[index] || refreshedSceneSetting;
          const currentVariantForQa =
            currentSceneSettingForQa.timeVariants?.find((item) => item.id === variant.id) || variant;
          const result = await generateReferenceAssetWithRetries({
            action: "generate-scene",
            mode: "scene",
            name: refreshedSceneSetting.name,
            description: buildSceneVariantReferenceDescription(refreshedSceneSetting, variant),
            style: resolveProjectImagePromptStyle(project),
            referenceImageUrl: primaryReferenceImageUrl,
            assetFileNameStem: buildSceneAssetFileStem(refreshedSceneSetting.name, {
              variantLabel: variant.label,
              version: nextVersion,
            }),
            maxAttempts: assetVariantRetryBudget,
            variantDistinctness: {
              variantLabel: currentVariantForQa.label,
              variantDescription: currentVariantForQa.description || "",
              siblingVariants: collectSceneSiblingVariantReferenceImages(currentSceneSettingForQa, variant.id),
            },
          });
          if (!result.imageUrl) {
            failedReferenceAssetCount += 1;
            markReferenceTargetFailed(`reference-scene-variant:${refreshedSceneSetting.id}:${variant.id}`, {
              attempts: result.attempts,
              reason: result.reason || "图片生成结果不可用",
              exhausted: true,
              sourceRefs: [primaryReferenceImageUrl],
              qaInspected: Boolean(result.qaReport?.inspected),
              qaSummary: result.qaReport?.summary,
              qaScore: result.qaReport?.overallScore,
              qaPassed: false,
              qaQualityTier: result.qaReport?.qualityTier,
              qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
              qaStrengths: result.qaReport?.strengths,
              qaGoldenSignals: result.qaReport?.goldenSignals,
              qaFixPriorities: result.qaReport?.fixPriorities,
              qaIssues: result.qaReport?.issues,
            });
            console.warn(`[reference] 场景《${refreshedSceneSetting.name}》变体《${variant.label}》生成失败，已跳过:`, result.reason);
            emitImageFailure(slotIndex, `${refreshedSceneSetting.name} · ${variant.label}`, result.reason || "图片生成结果不可用，AI 代理会继续补齐该资产。");
            return;
          }
          const imageUrl = result.imageUrl;

          const latestSceneSetting = nextSceneSettings[index];
          if (!latestSceneSetting?.timeVariants?.[variantIndex]) return;
          const latestTimeVariants = [...latestSceneSetting.timeVariants];
          const latestVariant = latestTimeVariants[variantIndex];
          latestTimeVariants[variantIndex] = {
            ...latestVariant,
            imageUrl,
            isAIGenerated: true,
            imageHistory: appendImageHistory(
              latestVariant.imageUrl,
              imageUrl,
              latestVariant.description || latestVariant.label,
              latestVariant.imageHistory,
            ),
          };
          nextSceneSettings[index] = {
            ...latestSceneSetting,
            timeVariants: latestTimeVariants,
          };
          updateWorkingProject({
            ...workingProject,
            characters: nextCharacters,
            sceneSettings: nextSceneSettings,
          });
          noteReferenceQaReport(result.qaReport, true);
          markReferenceTargetReady(`reference-scene-variant:${refreshedSceneSetting.id}:${variant.id}`, imageUrl, {
            attempts: result.attempts,
            sourceRefs: [primaryReferenceImageUrl],
            qualityScore: result.qaReport?.overallScore ?? 88,
            qaInspected: Boolean(result.qaReport?.inspected),
            qaSummary: result.qaReport?.summary,
            qaScore: result.qaReport?.overallScore,
            qaPassed: result.qaReport ? !shouldRejectReferenceImageQuality(result.qaReport) : undefined,
            qaQualityTier: result.qaReport?.qualityTier,
            qaGoldenSampleVersion: result.qaReport?.goldenSampleVersion,
            qaStrengths: result.qaReport?.strengths,
            qaGoldenSignals: result.qaReport?.goldenSignals,
            qaFixPriorities: result.qaReport?.fixPriorities,
            qaIssues: result.qaReport?.issues,
          });
          const sceneVariantLabel = buildSceneAssetLabel(refreshedSceneSetting.name, {
            variantLabel: variant.label,
            version: nextVersion,
          });
          completedImages[slotIndex] = { url: imageUrl, label: sceneVariantLabel };
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
              detail: {
                url: imageUrl,
                label: sceneVariantLabel,
                index: slotIndex,
                ...(mediaEventId ? { mediaEventId } : {}),
                action: "generate_video_reference_assets",
                projectId: project.id,
                targetId: `reference-scene-variant:${refreshedSceneSetting.id}:${variant.id}`,
                regenerateMode: "generate",
              },
            }));
          }
          generatedSceneVariantCount += 1;
          emitVideoImageProgress(
            onProgress,
            {
              ...project,
              characters: nextCharacters,
              sceneSettings: nextSceneSettings,
            },
            imageUrl,
            sceneVariantLabel,
          );
        });
      }
    }

    // Keep variant generation sequential so sibling-distinctness QA can compare
    // each new candidate against previously approved sibling variants in the same batch.
    await mapWithConcurrency(variantTasks, 1, async (task) => task());

    const { imageUrls: generatedImageUrls, imageLabels: generatedImageLabels } =
      collectOrderedGeneratedImages(completedImages);

    const generationSummary = buildReferenceAssetGenerationSummary({
      characterPrimaryCount: generatedCharacterPrimaryCount,
      characterVariantCount: generatedCharacterVariantCount,
      scenePrimaryCount: generatedScenePrimaryCount,
      sceneVariantCount: generatedSceneVariantCount,
    });
    const nextProject = synchronizeVideoProductionState({
      ...workingProject,
      characters: nextCharacters,
      sceneSettings: nextSceneSettings,
    });
    const remainingTargetIds = listPendingReferenceAssetTargetIds(nextProject);
    const exhaustedReferenceTargetCount = listExhaustedReferenceAssetTargetIds(nextProject).length;
    const qaSummary =
      passedReferenceAssetQaCount > 0 || rejectedReferenceAssetQaCount > 0
        ? formatReferenceImageQaSummary({
            passedCount: passedReferenceAssetQaCount,
            rejectedCount: rejectedReferenceAssetQaCount,
            exhaustedCount: exhaustedReferenceTargetCount,
            highlightedIssues: [...highlightedReferenceQaIssues],
          })
        : "";
    const smartBatchHint = smartBatch
      ? [
          `本轮按当前生图模型上限处理 ${targetIds.length}/${inferredTargetIds.length || targetIds.length} 个资产目标。`,
          remainingTargetIds.length > 0
            ? `还剩 ${remainingTargetIds.length} 个待补齐目标，继续点击同一个按钮会补下一批。`
            : remainingSmartTargetCount > 0
              ? `后续批次已排队，继续点击同一个按钮会补下一批。`
              : "",
          retriedReferenceAssetCount > 0 ? `本轮自动重试了 ${retriedReferenceAssetCount} 次以稳定参考资产质量。` : "",
          failedReferenceAssetCount > 0
            ? exhaustedReferenceTargetCount > 0
              ? `${failedReferenceAssetCount} 个生成失败，其中 ${exhaustedReferenceTargetCount} 个已超出自动补图预算并转入 review。`
              : `${failedReferenceAssetCount} 个生成失败，会继续留在自动补齐队列中。`
            : "",
          skippedDependencyCount > 0 ? `${skippedDependencyCount} 个变体因主参考图缺失已跳过，主图成功后会自动进入后续批次。` : "",
        ].filter(Boolean).join(" ")
      : "";
    const fallbackSummary = remainingTargetIds.length > 0
      ? generatedImageUrls.length > 0
        ? `本轮已补齐 ${generatedImageUrls.length} 个参考资产，剩余目标会继续保留待补齐状态。`
        : `本轮未新增可用参考素材，仍有 ${remainingTargetIds.length} 个待补齐目标。`
      : exhaustedReferenceTargetCount > 0
        ? `本轮自动补图已触发 ${exhaustedReferenceTargetCount} 个兜底审阅项，请在 review 中处理这些已耗尽预算的参考资产。`
      : targetIds.length
        ? "当前选中的角色、场景或变体素材已齐备。"
        : "当前角色与场景参考图已齐备，可继续生成分镜图。";
    const resultSummary = [generationSummary || fallbackSummary, qaSummary, smartBatchHint].filter(Boolean).join("\n\n");
    if (!generationSummary && targetIds.length) {
      console.info("[video-reference-assets] skipped", {
        projectId: project.id,
        targetIds,
        forceRegenerate,
        matchedCharacterVariantTargetCount,
        matchedSceneVariantTargetCount,
      });
    }

    const result = await saveVideoProject(
      {
        ...nextProject,
        currentStep: deriveVisibleVideoStep(
          nextProject,
        ),
        analysisSummary: resultSummary,
      },
      resultSummary,
    );
    return generatedImageUrls.length
      ? {
          ...result,
          imageUrls: generatedImageUrls,
          // 多张时去掉版本后缀，避免 UI 显示冗余的"版本01"等
          imageLabels: generatedImageUrls.length > 1
            ? generatedImageLabels.map((l) => l.replace(/\s*·\s*版本\d+$/, ""))
            : generatedImageLabels,
          remainingTargetIds,
        }
      : {
          ...result,
          remainingTargetIds,
        };
  });
}

export async function generateStoryboardFramesAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法生成分镜图。");
  }
  assertReferenceAssetsReady(synchronizeVideoProductionState(project));

  const requestedTargetIds = collectTargetIds(input);
  const smartBatch = input.smartBatch === true;
  const smartBatchLimit = resolveSmartReferenceAssetBatchLimit(input, project);
  const scopedInput = smartBatch && requestedTargetIds.length > smartBatchLimit
    ? {
        ...input,
        targetIds: requestedTargetIds.slice(0, smartBatchLimit),
      }
    : input;

  let selectedScenes = resolveGenerationScenes(
    {
      ...project,
      scenes: project.scenes.filter((scene) => !scene.storyboardUrl || input.forceRegenerate === true),
    },
    scopedInput,
  );
  if (smartBatch && !requestedTargetIds.length) {
    selectedScenes = selectedScenes.slice(0, smartBatchLimit);
  }
  if (!selectedScenes.length) {
    throw new Error("当前没有需要生成分镜图的镜头。");
  }
  const requestedStoryboardCount = requestedTargetIds.length || selectedScenes.length;
  const remainingSmartTargetCount = smartBatch
    ? Math.max(requestedStoryboardCount - selectedScenes.length, 0)
    : 0;

  localStorage.setItem("storyforge_current_project", project.id);

  return runWithVideoAbortSignal(async (abortSignal) => {
    await pauseBeforeMediaSubmission({
      input,
      onProgress,
      kind: "image",
      title:
        selectedScenes.length === 1
          ? "已整理 1 张分镜图生成任务。"
          : `已整理 ${selectedScenes.length} 张分镜图生成任务。`,
      content: buildStoryboardSubmissionContent(selectedScenes),
      requestCount: selectedScenes.length,
      abortSignal,
    });
    const imageGenerationInput = buildScopedImageGenerationInput(input, project, { allowStoryboardMode: true });
    const mediaEventId =
      typeof input.mediaEventId === "string" && input.mediaEventId.trim()
        ? input.mediaEventId.trim()
        : undefined;
    const nextScenes = [...project.scenes];
    const completedImages: Array<{ url: string; label: string } | undefined> = [];
    const generationConcurrency = Math.max(1, smartBatchLimit);
    let generatedCount = 0;
    let failedStoryboardCount = 0;
    await mapWithConcurrency(selectedScenes, generationConcurrency, async (scene, sceneLoopIndex) => {
      const characterDetails = findCharacterDetails(scene, project.characters || []);
      const matchedSetting = findSceneSetting(scene, project.sceneSettings || []);
      const { data, error } = await invokeFunction<{ imageUrl?: string }>(
        "generate-storyboard",
        {
          ...imageGenerationInput,
          description: scene.description,
          characters: scene.characters,
          cameraDirection: scene.cameraDirection,
          sceneName: scene.sceneName,
          dialogue: scene.dialogue,
          style: resolveProjectImagePromptStyle(project),
          characterDescriptions: characterDetails,
          characterImages: characterDetails
            .filter((character) => character.imageUrl)
            .map((character) => ({ name: character.name, imageUrl: character.imageUrl! })),
          sceneDescription: matchedSetting?.description || scene.sceneName,
          sceneImageUrl: findSceneReferenceImage(scene, project.sceneSettings || []),
          assetFileNameStem: buildStoryboardAssetFileStem(scene, {
            variantLabel: matchedSetting?.timeVariants?.find(
              (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
            )?.label,
            version: resolveNextAssetVersion(scene.storyboardUrl, scene.storyboardHistory),
          }),
        },
        { abortSignal: buildPerImageAbortSignal(abortSignal) },
      );
      // 用户手动中止时向上抛出；单张超时则跳过该镜头继续生成其余镜头
      if (error) {
        if (abortSignal?.aborted) throw error;
        failedStoryboardCount += 1;
        console.warn(`[storyboard] 镜头《${scene.sceneName}》生成失败，已跳过:`, error);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
            detail: {
              index: sceneLoopIndex,
              label: scene.sceneName,
              reason: error instanceof Error ? error.message : String(error),
              ...(mediaEventId ? { mediaEventId } : {}),
            },
          }));
        }
        return;
      }

      const imageUrl = await resolveVerifiedGeneratedReferenceImageUrl(data?.imageUrl);
      if (!imageUrl) {
        failedStoryboardCount += 1;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("agent:image-generated-one-failed", {
            detail: {
              index: sceneLoopIndex,
              label: scene.sceneName,
              reason: "图片生成结果不可用，当前镜头会保留待补齐状态。",
              ...(mediaEventId ? { mediaEventId } : {}),
            },
          }));
        }
        return;
      }

      const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
      if (sceneIndex < 0) return;

      nextScenes[sceneIndex] = {
        ...nextScenes[sceneIndex],
        storyboardUrl: imageUrl,
        storyboardHistory: [
          ...(nextScenes[sceneIndex].storyboardHistory || []),
          ...(
            nextScenes[sceneIndex].storyboardUrl &&
            nextScenes[sceneIndex].storyboardUrl !== imageUrl &&
            !(nextScenes[sceneIndex].storyboardHistory || []).includes(nextScenes[sceneIndex].storyboardUrl!)
              ? [nextScenes[sceneIndex].storyboardUrl!]
              : []
          ),
        ],
      };
      const storyboardLabel = buildStoryboardAssetLabel(scene, {
        variantLabel: matchedSetting?.timeVariants?.find(
          (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting?.activeTimeVariantId,
        )?.label,
        version: resolveNextAssetVersion(scene.storyboardUrl, scene.storyboardHistory),
      });
      completedImages[sceneLoopIndex] = { url: imageUrl, label: storyboardLabel };
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("agent:image-generated-one", {
          detail: {
            url: imageUrl,
            label: storyboardLabel,
            index: sceneLoopIndex,
            ...(mediaEventId ? { mediaEventId } : {}),
            action: "generate_storyboard_frames",
            projectId: project.id,
            targetId: scene.id,
            regenerateMode: "generate",
          },
        }));
      }
      generatedCount += 1;
      emitVideoImageProgress(onProgress, { ...project, scenes: nextScenes }, imageUrl, storyboardLabel);
    });

    const { imageUrls: generatedImageUrls, imageLabels: generatedImageLabels } =
      collectOrderedGeneratedImages(completedImages);

    const nextProject = synchronizeVideoProductionState({
      ...project,
      scenes: nextScenes,
      shotPackets: [],
      videoPromptBatch: "",
    });
    const realtimeSummary = buildRealtimeStoryboardSummary(nextProject);
    const generationSummary =
      generatedCount > 0
        ? `已生成 ${generatedCount} 张分镜图。`
        : "当前没有新的分镜图生成结果。";
    const smartBatchHint = smartBatch
      ? [
          `本轮按当前生图模型上限处理 ${selectedScenes.length}/${requestedStoryboardCount} 张分镜图。`,
          remainingSmartTargetCount > 0 ? `还剩 ${remainingSmartTargetCount} 张，继续点击同一个按钮会补下一批。` : "",
          failedStoryboardCount > 0 ? `${failedStoryboardCount} 张生成失败，会继续保留在待补列表里供下次重试。` : "",
        ].filter(Boolean).join(" ")
      : "";
    const resultSummary = [generationSummary, smartBatchHint].filter(Boolean).join("\n\n");
    const result = await saveVideoProject(
      {
        ...nextProject,
        storyboardPlan: realtimeSummary.storyboardPlan,
        currentStep:
          generatedCount > 0 &&
          realtimeSummary.generatableCount === 0 &&
          realtimeSummary.blockedCount === 0
            ? 4
            : 3,
        analysisSummary: resultSummary,
      },
      resultSummary,
    );
    return generatedImageUrls.length
      ? { ...result, imageUrls: generatedImageUrls, imageLabels: generatedImageLabels }
      : result;
  });
}

export async function generateProjectImageAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const imagePrompt =
    (typeof input.imagePrompt === "string" && input.imagePrompt.trim()) ||
    (typeof input.prompt === "string" && input.prompt.trim()) ||
    "";
  if (!imagePrompt) {
    throw new Error("缺少 imagePrompt，无法生成图片。");
  }

  const title = buildVideoTitle(runtime, input);
  const normalizedImagePrefs = resolveEffectiveImageGenerationPrefs(
    input,
    runtime.currentVideoProject,
  );
  const style = resolveVideoImagePromptStyle(
    normalizedImagePrefs,
    (typeof input.artStyle === "string"
      ? input.artStyle
      : runtime.currentVideoProject?.artStyle || "live-action") as ArtStyle,
  );

  const isCharacter = resolveRequestedProjectImageKind(input, imagePrompt) === "character";
  const functionName = isCharacter ? "generate-character" : "generate-scene";
  const imageGenerationInput = buildScopedImageGenerationInput(input, runtime.currentVideoProject, {
    allowReferenceImage: true,
    allowViewMode: true,
  });
  const abortSignal = resolveInputAbortSignal(input);
  await pauseBeforeMediaSubmission({
    input,
    onProgress,
    kind: "image",
    title: "已整理 1 张图片生成任务。",
    content: imagePrompt,
    requestCount: 1,
  });

  const { data, error } = await invokeFunction<{ imageUrl?: string }>(functionName, {
    ...imageGenerationInput,
    name: title || (isCharacter ? "角色" : "Project image"),
    description: imagePrompt,
    style,
  }, { abortSignal });
  if (error) throw error;

  const imageUrl = data?.imageUrl?.trim();
  if (!imageUrl) {
    throw new Error("图片生成未返回可用的 imageUrl。");
  }

  return {
    summary: "已生成图片。",
    imageUrls: [imageUrl],
  };
}

export async function generateVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: import("../types").WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法直接发起出片。");
  }
  let syncedProject = synchronizeVideoProductionState({
    ...project,
    videoGenerationModeNotice: null,
  });
  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const selectedScenes = resolveGenerationScenes(syncedProject, input);
  if (!selectedScenes.length) {
    throw new Error("当前没有可提交出片的镜头，先轮询结果或指定新的镜头范围。");
  }
  assertStoryboardAssetsReadyForScenes(syncedProject, selectedScenes, videoGenerationPrefs.mode);
  await pauseBeforeMediaSubmission({
    input,
    onProgress,
    kind: "video",
    title:
      selectedScenes.length === 1
        ? "已整理 1 条镜头视频生成任务。"
        : `已整理 ${selectedScenes.length} 条镜头视频生成任务。`,
    content: buildSceneVideoSubmissionContent(selectedScenes),
    requestCount: selectedScenes.length,
  });
  const formatSceneVideoProgress = createSceneVideoProgressFormatter(selectedScenes);
  onProgress?.({ summary: formatSceneVideoProgress({ status: "init" }) });


  const transportProviderHint =
    typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : resolveVideoGenerationTransportProviderHint(videoGenerationPrefs, syncedProject);
  const transport = await ensureVideoGenerationTransport({
    ...input,
    ...(transportProviderHint ? { provider: transportProviderHint } : {}),
    videoModelKey: videoGenerationPrefs.modelKey,
    resolution: videoGenerationPrefs.resolution,
    mode: videoGenerationPrefs.mode,
  });
  const generationConcurrency = Math.max(
    1,
    Math.min(selectedScenes.length, getHomeAgentVideoGenerationConcurrencyLimit(videoGenerationPrefs)),
  );
  let nextScenes = [...syncedProject.scenes];
  let submittedCount = 0;
  const failedScenes: string[] = [];
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);
  const submittedTasks: ActiveVideoTaskRef[] = [];
  const detachAbortCancellation = attachAbortDrivenVideoCancellation(
    input,
    () => submittedTasks,
  );
  const mediaEventId =
    typeof input.mediaEventId === "string" && input.mediaEventId.trim()
      ? input.mediaEventId.trim()
      : undefined;
  const allScenesSortedForGen = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const selectedSceneIndexMap = new Map(selectedScenes.map((scene, index) => [scene.id, index]));
  const emitSceneVideoFailure = (sceneId: string, sceneName: string, reason: string) => {
    dispatchSceneVideoGeneratedFailed({
      sceneId,
      sceneName,
      reason,
      index: selectedSceneIndexMap.get(sceneId) ?? 0,
      projectId: syncedProject.id,
      ...(mediaEventId ? { mediaEventId } : {}),
    });
  };

  try {
    await mapWithConcurrency(selectedScenes, generationConcurrency, async (scene) => {
      throwIfInputAborted(input);
      onProgress?.({ summary: formatSceneVideoProgress({ unitKey: scene.id, status: "processing" }) });
      try {
        const genSceneIdx = allScenesSortedForGen.findIndex((s) => s.id === scene.id);
        const prevScene = genSceneIdx > 0 ? allScenesSortedForGen[genSceneIdx - 1] : undefined;
        const nextScene = genSceneIdx < allScenesSortedForGen.length - 1 ? allScenesSortedForGen[genSceneIdx + 1] : undefined;
        const prompt = await buildSceneVideoPrompt(syncedProject, scene, {
          prevDescription: prevScene?.description,
          nextDescription: nextScene?.description,
          excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
          textModel:
            typeof input.textModel === "string" && input.textModel.trim()
              ? input.textModel.trim()
              : undefined,
        });
        const characterDetails = findCharacterDetails(scene, syncedProject.characters || []);
        const referenceImageUrl = findSceneReferenceImage(scene, syncedProject.sceneSettings || [], {
          excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
        });
        const referenceImageUrls = collectSceneReferenceImages(
          scene,
          syncedProject.sceneSettings || [],
          characterDetails,
          {
            excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
          },
        );
        const referenceAudioUrls = collectSceneReferenceAudioUrls(characterDetails);
        const referenceImageDebugInfo = collectSceneReferenceDebugInfo(
          scene,
          syncedProject.sceneSettings || [],
          characterDetails,
          {
            excludeStoryboard: videoGenerationPrefs.mode === "text-to-video",
          },
        );
        const shouldUseReferenceImage = videoGenerationPrefs.mode === "image-to-video";
        if (shouldUseReferenceImage && !referenceImageUrl) {
          throw new Error(`镜头《${scene.sceneName}》缺少参考图，暂时不能走图生视频。`);
        }
        const referencePayload = resolveVideoGenerationReferencePayload({
          mode: videoGenerationPrefs.mode,
          modelKey: videoGenerationPrefs.modelKey,
          primaryReferenceImageUrl: referenceImageUrl,
          referenceImageUrls,
        });
        const nameReplacements = buildVideoSubmissionNameReplacements(
          [scene],
          syncedProject.characters || [],
          [
            prompt.enhanced,
            scene.sceneName,
            scene.description,
          ],
        );
        const submittedPrompt = normalizeVideoSubmissionPrompt(
          applyVideoSubmissionNameReplacements(
            appendExactDialogueLock(stripExactDialogueLockBlock(prompt.enhanced), scene.dialogue),
            nameReplacements,
          ),
          {
            durationSeconds: prompt.duration ?? scene.recommendedDuration ?? scene.duration ?? 5,
          },
        );
        const generationRequest = {
          prompt: submittedPrompt,
          logPrompt: submittedPrompt,
          duration: prompt.duration ?? scene.recommendedDuration ?? scene.duration ?? 5,
          aspectRatio: videoGenerationPrefs.aspectRatio || "16:9",
          resolution: videoGenerationPrefs.resolution,
          model: resolvedModel,
          provider: transport.provider || resolveVideoGenerationProvider(videoGenerationPrefs),
          videoMode: videoGenerationPrefs.mode,
          referenceImageDebugInfo,
          ...(referenceAudioUrls.length ? { audioUrls: referenceAudioUrls } : {}),
          ...referencePayload,
        };
        const { data, error, notice } = await invokeVideoGenerationWithReferenceFailureNotice(
          generationRequest,
          { abortSignal: resolveInputAbortSignal(input) },
          videoGenerationPrefs.mode,
          referencePayload,
        );
        if (notice) {
          syncedProject = {
            ...syncedProject,
            videoGenerationModeNotice: notice,
          };
        }

        if (error) throw error;

        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex < 0) return;

        const taskId = String(data?.task_id || nextScenes[sceneIndex].videoTaskId || "").trim();
        const taskProvider =
          data?.provider || transport.provider || nextScenes[sceneIndex].videoProvider;
        if (!taskId) {
          throw new Error("视频任务已提交但未返回 task_id，无法继续轮询结果。");
        }
        submittedTasks.push({
          taskId,
          provider: taskProvider,
        });

        nextScenes[sceneIndex] = {
          ...nextScenes[sceneIndex],
          videoHistory: appendVideoHistory(nextScenes[sceneIndex]),
          videoUrl: undefined,
          videoTaskId: taskId || nextScenes[sceneIndex].videoTaskId,
          videoProvider: taskProvider,
          videoStatus: normalizeSceneStatus(data?.status),
          videoFailure: undefined,
          recommendedDuration: prompt.duration ?? nextScenes[sceneIndex].recommendedDuration,
        };
        submittedCount += 1;
        logVideoWorkflowSceneEvent("submit", {
          sceneId: nextScenes[sceneIndex].id,
          scene: nextScenes[sceneIndex].sceneName,
          taskId,
          provider: taskProvider,
          status: normalizeSceneStatus(data?.status) || data?.status || "queued",
          mode: videoGenerationPrefs.mode,
        });
        onProgress?.({
          summary: appendVideoProgressDetail(
            formatSceneVideoProgress({ unitKey: scene.id, status: "processing" }),
            buildVideoSubmitProgressDetail({
              provider: taskProvider,
              referencePayload,
              referenceDebugInfo: referenceImageDebugInfo,
            }),
          ),
        });
      } catch (error) {
        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex >= 0) {
          const failureMessage = summarizeVideoGenerationError(error);
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: failureMessage,
              provider: transport.provider,
              stage: "submit",
              updatedAt: new Date().toISOString(),
            },
          };
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            provider: transport.provider,
            message: nextScenes[sceneIndex].videoFailure?.message,
          });
          emitSceneVideoFailure(
            nextScenes[sceneIndex].id,
            nextScenes[sceneIndex].sceneName,
            failureMessage,
          );
        }
        failedScenes.push(scene.sceneName);
        onProgress?.({ summary: formatSceneVideoProgress({ unitKey: scene.id, status: "failed" }) });
      }
    });
  } finally {
    detachAbortCancellation();
  }

  // 自动轮询：提交后持续查询任务状态，直到全部完成/失败或超时
  const completedVideoUrls: string[] = [];
  if (submittedCount > 0) {
    const { maxPollRounds: MAX_POLL_ROUNDS, pollIntervalMs: POLL_INTERVAL_MS } =
      resolveVideoGenerationPollPlan(nextScenes.map((scene) => scene.videoProvider));
    for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
      throwIfInputAborted(input);
      const pendingScenes = nextScenes.filter(
        (s) => s.videoTaskId?.trim() && ["queued", "processing"].includes(normalizeSceneStatus(s.videoStatus)),
      );
      if (!pendingScenes.length) break;

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      throwIfInputAborted(input);

      const pendingStatuses = await mapWithConcurrency(
        pendingScenes,
        generationConcurrency,
        async (scene) => {
          throwIfInputAborted(input);
          const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
            "generate-video",
            { action: "status", taskId: scene.videoTaskId, provider: scene.videoProvider },
            { abortSignal: resolveInputAbortSignal(input) },
          );
          return { scene, data, error };
        },
      );

      for (const { scene, data, error } of pendingStatuses) {
        const sceneIndex = nextScenes.findIndex((s) => s.id === scene.id);
        if (sceneIndex < 0) continue;

        if (error) {
          const failureMessage = summarizeVideoGenerationError(error);
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: failureMessage,
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          emitSceneVideoFailure(
            nextScenes[sceneIndex].id,
            nextScenes[sceneIndex].sceneName,
            failureMessage,
          );
          onProgress?.({ summary: formatSceneVideoProgress({ unitKey: scene.id, status: "failed" }) });
          continue;
        }

        const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
        if (normalizedStatus === "completed" && data?.video_url) {
          const remoteVideoUrl = data.video_url;
          const fileName = `${buildVideoAssetFileStem(nextScenes[sceneIndex])}.mp4`;
          const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, syncedProject.id);
          const persistedVideoUrl = cachedVideo?.localPath ?? remoteVideoUrl;
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoHistory: appendVideoHistory(nextScenes[sceneIndex], persistedVideoUrl),
            videoUrl: persistedVideoUrl,
            videoStatus: "completed",
            videoFailure: undefined,
          };
          completedVideoUrls.push(persistedVideoUrl);
          logVideoWorkflowSceneEvent("result", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: "completed",
            video: persistedVideoUrl,
          });

          // 完成一条即刻保存并通知调用方，素材库可立即归档
          if (onProgress) {
            const partialProject = synchronizeVideoProductionState({
              ...syncedProject,
              scenes: nextScenes,
              videoGenerationPrefs,
            });
            const partialResult = await saveVideoProject(partialProject, "");
            syncedProject = partialResult.data?.videoProject ?? partialProject;
            nextScenes = [...syncedProject.scenes];
            onProgress({
              ...partialResult,
              summary: formatSceneVideoProgress({ unitKey: scene.id, status: "done" }),
              videoUrls: [persistedVideoUrl],
              remainingTargetIds: listGeneratableSceneIds(
                partialResult.data?.videoProject ?? partialProject,
                Number.MAX_SAFE_INTEGER,
              ),
            });
            // 逐条替换聊天框中的占位符
            const sceneIndexInSelected = selectedScenes.findIndex((s) => s.id === scene.id);
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("agent:video-generated-one", {
                detail: {
                  url: persistedVideoUrl,
                  label: nextScenes[sceneIndex].sceneName,
                  index: sceneIndexInSelected >= 0 ? sceneIndexInSelected : completedVideoUrls.length - 1,
                  sceneId: nextScenes[sceneIndex].id,
                  projectId: syncedProject.id,
                  ...(mediaEventId ? { mediaEventId } : {}),
                },
              }));
            }
          }
        } else if (normalizedStatus === "completed") {
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: data?.status || data?.state || "completed",
            message: "状态已完成但未返回 video_url",
          });
        } else if (normalizedStatus === "failed") {
          const failureMessage = buildVideoStatusFailureMessage(
            data,
            "视频生成失败，建议调整提示词后重新提交。",
          );
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: failureMessage,
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: "failed",
            message: failureMessage,
          });
          emitSceneVideoFailure(
            nextScenes[sceneIndex].id,
            nextScenes[sceneIndex].sceneName,
            failureMessage,
          );
          onProgress?.({ summary: formatSceneVideoProgress({ unitKey: scene.id, status: "failed" }) });
        } else {
          nextScenes[sceneIndex] = { ...nextScenes[sceneIndex], videoStatus: normalizedStatus };
          logVideoWorkflowSceneEvent("status", {
            sceneId: nextScenes[sceneIndex].id,
            scene: nextScenes[sceneIndex].sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            status: normalizedStatus,
            round: round + 1,
            maxRounds: MAX_POLL_ROUNDS,
            promptTips: data?.prompt_tips,
          });
          onProgress?.({
            summary: appendVideoProgressDetail(
              formatSceneVideoProgress({ unitKey: scene.id, status: "processing" }),
              buildVideoPollingProgressDetail({
                round: round + 1,
                maxRounds: MAX_POLL_ROUNDS,
                provider: scene.videoProvider,
                status: normalizedStatus,
                promptTips: data?.prompt_tips,
              }),
            ),
          });
        }
      }
    }

    // 轮询结束后仍处于 queued/processing 的镜头视为超时失败
    for (const scene of nextScenes) {
      if (
        scene.videoTaskId?.trim() &&
        ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus))
      ) {
        const sceneIndex = nextScenes.findIndex((s) => s.id === scene.id);
        if (sceneIndex >= 0) {
          const failureMessage = "生成超时，请重新生成。";
          nextScenes[sceneIndex] = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: failureMessage,
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          emitSceneVideoFailure(
            nextScenes[sceneIndex].id,
            nextScenes[sceneIndex].sceneName,
            failureMessage,
          );
          failedScenes.push(scene.sceneName);
          onProgress?.({ summary: formatSceneVideoProgress({ unitKey: scene.id, status: "failed" }) });
        }
      }
    }
  }

  const completedCount = completedVideoUrls.length;

  // 收集本次完成的镜头名称（videoUrl 在 completedVideoUrls 中）
  const completedSceneNames = nextScenes
    .filter((s) => s.videoStatus === "completed" && s.videoUrl && completedVideoUrls.includes(s.videoUrl))
    .map((s) => s.sceneName);

  // 收集所有失败镜头及原因（含提交失败 + 轮询失败 + 超时失败）
  const failedScenesWithReasons = nextScenes
    .filter((s) => normalizeSceneStatus(s.videoStatus) === "failed" && s.videoFailure?.message)
    .map((s) => `${s.sceneName}（${s.videoFailure!.message}）`);

  const summaryParts: string[] = [];
  if (!submittedCount) {
    summaryParts.push("当前没有镜头成功提交出片任务。");
  } else {
    if (completedSceneNames.length) {
      summaryParts.push(`已完成出片（${completedSceneNames.length} 条）：${completedSceneNames.join("、")}`);
    }
    if (failedScenesWithReasons.length) {
      summaryParts.push(`生成失败（${failedScenesWithReasons.length} 条）：${failedScenesWithReasons.join("、")}`);
    }
    if (!completedSceneNames.length && !failedScenesWithReasons.length) {
      summaryParts.push(`已提交 ${submittedCount} 条镜头出片任务，当前优先走 ${transport.providerLabel}。`);
    }
  }
  const summary = summaryParts.filter(Boolean).join("\n");

  const syncedNextProject = synchronizeVideoProductionState({
    ...syncedProject,
    scenes: nextScenes,
    videoGenerationPrefs,
  });
  const nextProject = {
    ...syncedNextProject,
    currentStep: deriveVisibleVideoStep(syncedNextProject),
    analysisSummary: completedCount
      ? `已完成 ${completedCount} 条镜头出片，可继续审阅或补发剩余镜头。`
      : submittedCount
        ? `已发起 ${submittedCount} 条镜头出片任务，可继续补发剩余镜头或进入审阅。`
        : "当前没有成功提交新的出片任务，建议检查镜头素材和提示词。",
  };
  const remainingTargetIds = listGeneratableSceneIds(syncedNextProject, Number.MAX_SAFE_INTEGER);
  const result = await saveVideoProject(nextProject, summary);
  return {
    ...result,
    ...(completedVideoUrls.length ? { videoUrls: completedVideoUrls } : {}),
    remainingTargetIds,
  };
}

export async function refreshVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  const targetIds = collectTargetIds(input);
  const candidates = project.scenes.filter((scene) => {
    if (!scene.videoTaskId?.trim()) return false;
    if (targetIds.length) return sceneTargetMatches(scene, project.id, targetIds);
    return ["queued", "processing"].includes(normalizeSceneStatus(scene.videoStatus));
  });

  if (!candidates.length) {
    throw new Error("当前没有可轮询的出片任务。");
  }

  const nextScenes = [...project.scenes];
  let completedCount = 0;
  let processingCount = 0;
  let failedCount = 0;
  let hasSceneChanges = false;
  const completedVideoUrls: string[] = [];
  const detachAbortCancellation = attachAbortDrivenVideoCancellation(
    input,
    () =>
      candidates.map((scene) => ({
        taskId: scene.videoTaskId || "",
        provider: scene.videoProvider,
      })),
  );

  try {
    for (const scene of candidates) {
      throwIfInputAborted(input);
      const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
        "generate-video",
        {
          action: "status",
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
        },
        { abortSignal: resolveInputAbortSignal(input) },
      );

      if (error) {
        const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
        if (sceneIndex >= 0) {
          const nextScene = {
            ...nextScenes[sceneIndex],
            videoStatus: "failed",
            videoFailure: {
              message: summarizeVideoGenerationError(error),
              provider: scene.videoProvider,
              stage: "status",
              updatedAt: new Date().toISOString(),
            },
          };
          hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
          nextScenes[sceneIndex] = nextScene;
          logVideoWorkflowSceneEvent("warning", {
            sceneId: nextScene.id,
            scene: nextScene.sceneName,
            taskId: scene.videoTaskId,
            provider: scene.videoProvider,
            message: nextScene.videoFailure?.message,
          });
        }
        failedCount += 1;
        continue;
      }

      const sceneIndex = nextScenes.findIndex((item) => item.id === scene.id);
      if (sceneIndex < 0) continue;

      const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
      if (normalizedStatus === "completed" && data?.video_url) {
        const remoteVideoUrl = data.video_url;
        const fileName = `${buildVideoAssetFileStem(nextScenes[sceneIndex])}.mp4`;
        const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, project.id);
        const persistedVideoUrl = cachedVideo?.localPath ?? remoteVideoUrl;
        const nextScene = {
          ...nextScenes[sceneIndex],
          videoHistory: appendVideoHistory(nextScenes[sceneIndex], persistedVideoUrl),
          videoUrl: persistedVideoUrl,
          videoStatus: "completed",
          videoFailure: undefined,
        };
        hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
        nextScenes[sceneIndex] = nextScene;
        completedVideoUrls.push(persistedVideoUrl);
        completedCount += 1;
        logVideoWorkflowSceneEvent("result", {
          sceneId: nextScene.id,
          scene: nextScene.sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: "completed",
          video: persistedVideoUrl,
        });
        continue;
      }

      if (normalizedStatus === "completed") {
        logVideoWorkflowSceneEvent("warning", {
          sceneId: nextScenes[sceneIndex].id,
          scene: nextScenes[sceneIndex].sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: data?.status || data?.state || "completed",
          message: "状态已完成但未返回 video_url",
        });
      }

      if (normalizedStatus === "failed") {
        const nextScene = {
          ...nextScenes[sceneIndex],
          videoStatus: "failed",
          videoFailure: {
            message: "轮询结果显示当前镜头生成失败，建议直接重做或调整提示词后补发。",
            provider: scene.videoProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        };
        hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
        nextScenes[sceneIndex] = nextScene;
        failedCount += 1;
        logVideoWorkflowSceneEvent("warning", {
          sceneId: nextScene.id,
          scene: nextScene.sceneName,
          taskId: scene.videoTaskId,
          provider: scene.videoProvider,
          status: "failed",
          message: nextScene.videoFailure?.message,
        });
        continue;
      }

      const nextScene = {
        ...nextScenes[sceneIndex],
        videoStatus: normalizedStatus,
        videoFailure: undefined,
      };
      hasSceneChanges = hasSceneChanges || !isSameRefreshSceneState(nextScenes[sceneIndex], nextScene);
      nextScenes[sceneIndex] = nextScene;
      processingCount += 1;
      logVideoWorkflowSceneEvent("status", {
        sceneId: nextScene.id,
        scene: nextScene.sceneName,
        taskId: scene.videoTaskId,
        provider: scene.videoProvider,
        status: normalizedStatus,
      });
    }
  } finally {
    detachAbortCancellation();
  }

  const summary = [
    completedCount ? `已完成 ${completedCount} 条镜头出片。` : "",
    processingCount ? `仍有 ${processingCount} 条镜头在后台处理中。` : "",
    failedCount ? `${failedCount} 条镜头出片失败，建议直接发起重做。` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!hasSceneChanges) {
    return {
      summary: summary || "当前出片任务状态未变化。",
    };
  }

  const result = await saveVideoProject(
    (() => {
      const nextProject = {
      ...project,
      scenes: nextScenes,
      currentStep: deriveVisibleVideoStep(
        synchronizeVideoProductionState({
          ...project,
          scenes: nextScenes,
        }),
      ),
      analysisSummary: completedCount
        ? `已回收 ${completedCount} 条镜头结果，可继续审阅或重做。`
        : processingCount
          ? `当前仍有 ${processingCount} 条镜头在出片中，稍后可继续轮询。`
          : "当前轮询已完成，可继续处理失败项或补发新镜头。",
      };
      return nextProject;
    })(),
    summary || "已刷新当前出片任务状态。",
  );
  return completedVideoUrls.length ? { ...result, videoUrls: completedVideoUrls } : result;
}

type VideoReviewQueueItem = NonNullable<PersistedVideoProject["reviewQueue"]>[number];

function videoReviewItemMatches(item: VideoReviewQueueItem, targetIds: string[]): boolean {
  if (!targetIds.length) return true;
  return targetIds.some((targetId) => {
    const normalized = targetId.trim();
    return (
      normalized === item.id ||
      item.targetIds.includes(normalized) ||
      item.targetIds.some((itemTargetId) => normalized.endsWith(`:${itemTargetId}`))
    );
  });
}

function resolveVideoReviewTargets(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
): {
  targetIds: string[];
  selectedReviewIds: Set<string>;
  selectedTargetIds: Set<string>;
  reviewQueue: VideoReviewQueueItem[];
} {
  const targetIds = collectTargetIds(input);
  const reviewQueue = project.reviewQueue ?? [];
  const selectedItems = reviewQueue.filter((item) => videoReviewItemMatches(item, targetIds));
  const selectedReviewIds = new Set(selectedItems.map((item) => item.id));
  const selectedTargetIds = new Set<string>([
    ...targetIds,
    ...selectedItems.flatMap((item) => item.targetIds),
  ]);

  if (!selectedTargetIds.size && project.shotPackets?.length) {
    for (const packet of project.shotPackets) {
      selectedTargetIds.add(packet.id);
    }
  }

  return {
    targetIds,
    selectedReviewIds,
    selectedTargetIds,
    reviewQueue,
  };
}

function ensureReviewItemForPacket(
  project: PersistedVideoProject,
  packet: VideoShotPacket,
  status: string,
  reason: string,
  timestamp: string,
): VideoReviewQueueItem {
  const scene = project.scenes.find((item) => item.id === packet.sceneId);
  return {
    id: `review:${packet.id}`,
    title: packet.title || scene?.sceneName || `镜头 ${packet.sceneNumber}`,
    summary: reason || "镜头已有可审阅素材，确认是否通过或需要重做。",
    targetIds: [packet.id],
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function collectSelectedSegmentLabelsFromReviewTargets(
  selectedTargetIds: Set<string>,
  reviewQueue: VideoReviewQueueItem[],
  selectedReviewIds: Set<string>,
): string[] {
  const labels = new Set<string>();
  selectedTargetIds.forEach((targetId) => {
    const normalized = targetId.trim();
    if (!normalized.startsWith("segment:")) return;
    const label = normalized.slice("segment:".length).trim();
    if (label) labels.add(label);
  });
  reviewQueue.forEach((item) => {
    if (!selectedReviewIds.has(item.id)) return;
    item.targetIds.forEach((targetId) => {
      const normalized = targetId.trim();
      if (!normalized.startsWith("segment:")) return;
      const label = normalized.slice("segment:".length).trim();
      if (label) labels.add(label);
    });
  });
  return [...labels];
}

function collectSelectedReferenceTargetIdsFromReviewTargets(
  selectedTargetIds: Set<string>,
  reviewQueue: VideoReviewQueueItem[],
  selectedReviewIds: Set<string>,
): string[] {
  const targetIds = new Set<string>();
  const collect = (targetId: string) => {
    const normalized = targetId.trim();
    if (normalized.startsWith("reference-")) {
      targetIds.add(normalized);
    }
  };
  selectedTargetIds.forEach(collect);
  reviewQueue.forEach((item) => {
    if (!selectedReviewIds.has(item.id)) return;
    item.targetIds.forEach(collect);
  });
  return [...targetIds];
}

export async function reviewVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const syncedProject = synchronizeVideoProductionState(project);
  const reviewCount = syncedProject.reviewQueue?.length ?? 0;
  return saveVideoProject(
    {
      ...syncedProject,
      currentStep: deriveVisibleVideoStep(syncedProject),
      analysisSummary: reviewCount
        ? `已整理 ${reviewCount} 条待审阅素材。`
        : "当前没有需要审阅的素材。",
    },
    reviewCount ? `已整理 ${reviewCount} 条待审阅素材。` : "当前没有需要审阅的素材。",
  );
}

export async function approveVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  let project = synchronizeVideoProductionState(
    mergeVideoInputContext(await ensureVideoProject(runtime, input), runtime, input),
  );
  const timestamp = new Date().toISOString();
  const { selectedReviewIds, selectedTargetIds, reviewQueue } = resolveVideoReviewTargets(project, input);
  const selectedSegmentLabels = collectSelectedSegmentLabelsFromReviewTargets(
    selectedTargetIds,
    reviewQueue,
    selectedReviewIds,
  );
  const selectedReferenceTargetIds = collectSelectedReferenceTargetIdsFromReviewTargets(
    selectedTargetIds,
    reviewQueue,
    selectedReviewIds,
  );

  const nextReviewQueue = reviewQueue.map((item) =>
    selectedReviewIds.has(item.id) || item.targetIds.some((targetId) => selectedTargetIds.has(targetId))
      ? { ...item, status: "approved", updatedAt: timestamp }
      : item,
  );
  const nextShotPackets = (project.shotPackets ?? []).map((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const selected =
      selectedTargetIds.has(packet.id) ||
      (scene ? sceneTargetMatches(scene, project.id, [...selectedTargetIds]) : false);
    return selected ? { ...packet, reviewStatus: "approved" } : packet;
  });
  const approvedCount = nextShotPackets.filter((packet) => packet.reviewStatus === "approved").length;
  let nextProject: PersistedVideoProject = {
    ...project,
    shotPackets: nextShotPackets,
    reviewQueue: nextReviewQueue,
  };

  for (const segmentLabel of selectedSegmentLabels) {
    const latestRepairTask = getLatestSegmentRepairTask(nextProject, segmentLabel);
    if (latestRepairTask && latestRepairTask.status !== "completed") {
      nextProject = upsertVideoRepairTask(nextProject, {
        ...latestRepairTask,
        status: "completed",
        updatedAt: timestamp,
      });
    }
    nextProject = withVideoAutomationSegmentState(nextProject, segmentLabel, (state) => ({
      ...state,
      exhausted: false,
      latestRepairTaskId: latestRepairTask?.id || state.latestRepairTaskId,
    }));
    const approvedVideoUrl = nextProject.segmentVideos?.[segmentLabel];
    const currentStatus = nextProject.segmentVideoStatuses?.[segmentLabel];
    if (approvedVideoUrl) {
      nextProject = withSegmentVideoStatus(
        nextProject,
        segmentLabel,
        buildSegmentVideoStatus(segmentLabel, "completed", {
          taskId: currentStatus?.taskId,
          provider: currentStatus?.provider,
          submittedPrompt: currentStatus?.submittedPrompt,
          referenceImageUrls: currentStatus?.referenceImageUrls,
          usedContinuityFrame: currentStatus?.usedContinuityFrame,
          usedRelayVideo: currentStatus?.usedRelayVideo,
        }),
      );
      continue;
    }
    const archivedCandidate = getLatestArchivedSegmentVideoCandidate(nextProject, segmentLabel);
    if (archivedCandidate?.id) {
      nextProject = await promoteArchivedSegmentVideoCandidateToOfficialAsset({
        project: nextProject,
        segmentLabel,
        historyEntryId: archivedCandidate.id,
      });
    }
  }
  nextProject = dismissSegmentReviewQueueItems(
    nextProject,
    selectedSegmentLabels,
    "approved",
    "已人工确认通过当前片段，无需继续自动修复。",
  );
  selectedReferenceTargetIds.forEach((targetId) => {
    const targetState = getReferenceTargetState(nextProject, targetId);
    if (!targetState) return;
    const hasResolvedAsset = Boolean(targetState.generatedUrl && hasUsableMediaUrl(targetState.generatedUrl));
    if (!hasResolvedAsset) return;
    nextProject = withReferenceTargetState(nextProject, targetId, (state) => ({
      ...state,
      targetId,
      status: "ready",
      attemptCount: state?.attemptCount || 0,
      retryBudget: state?.retryBudget || 0,
      lastError: undefined,
      lastSucceededAt: timestamp,
      generatedUrl: targetState.generatedUrl,
    }));
    nextProject = dismissReferenceTargetReviewItems(
      nextProject,
      [targetId],
      "approved",
      "已人工确认当前参考资产可继续使用。",
    );
  });
  const totalApprovedCount = approvedCount + selectedSegmentLabels.length + selectedReferenceTargetIds.length;

  return saveVideoProject(
    {
      ...nextProject,
      currentStep: deriveVisibleVideoStep(nextProject),
      analysisSummary: totalApprovedCount
        ? `已通过 ${totalApprovedCount} 条审阅项。`
        : "当前没有匹配到可通过的审阅项。",
    },
    totalApprovedCount
      ? `已通过 ${totalApprovedCount} 条审阅项。`
      : "当前没有匹配到可通过的审阅项。",
  );
}

export async function redoVideoAssetsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  let project = synchronizeVideoProductionState(
    mergeVideoInputContext(await ensureVideoProject(runtime, input), runtime, input),
  );
  const timestamp = new Date().toISOString();
  const reason = typeof input.reason === "string" && input.reason.trim()
    ? input.reason.trim()
    : "用户标记需要重做。";
  const { selectedReviewIds, selectedTargetIds, reviewQueue } = resolveVideoReviewTargets(project, input);
  const selectedSegmentLabels = collectSelectedSegmentLabelsFromReviewTargets(
    selectedTargetIds,
    reviewQueue,
    selectedReviewIds,
  );
  const selectedReferenceTargetIds = collectSelectedReferenceTargetIdsFromReviewTargets(
    selectedTargetIds,
    reviewQueue,
    selectedReviewIds,
  );

  const nextShotPackets = (project.shotPackets ?? []).map((packet) => {
    const scene = project.scenes.find((item) => item.id === packet.sceneId);
    const selected =
      selectedTargetIds.has(packet.id) ||
      (scene ? sceneTargetMatches(scene, project.id, [...selectedTargetIds]) : false);
    return selected ? { ...packet, reviewStatus: "redo" } : packet;
  });

  const nextReviewById = new Map(
    reviewQueue.map((item) => {
      const selected =
        selectedReviewIds.has(item.id) ||
        item.targetIds.some((targetId) => selectedTargetIds.has(targetId));
      return [
        item.id,
        selected
          ? {
              ...item,
              status: "redo",
              summary: reason,
              updatedAt: timestamp,
            }
          : item,
      ] as const;
    }),
  );

  for (const packet of nextShotPackets) {
    if (packet.reviewStatus !== "redo") continue;
    const reviewId = `review:${packet.id}`;
    if (!nextReviewById.has(reviewId)) {
      nextReviewById.set(reviewId, ensureReviewItemForPacket(project, packet, "redo", reason, timestamp));
    }
  }

  const redoCount = nextShotPackets.filter((packet) => packet.reviewStatus === "redo").length;
  let nextProject: PersistedVideoProject = {
    ...project,
    shotPackets: nextShotPackets,
    reviewQueue: [...nextReviewById.values()],
  };
  selectedSegmentLabels.forEach((segmentLabel) => {
    const latestRepairTask = getLatestSegmentRepairTask(nextProject, segmentLabel);
    const repairTask: VideoRepairTask = {
      id: latestRepairTask?.id || `repair:segment:${segmentLabel}`,
      targetType: "segment",
      targetId: `segment:${segmentLabel}`,
      segmentLabel,
      route: "regenerate",
      status: "pending",
      reason,
      auditId: latestRepairTask?.auditId,
      attempts: (latestRepairTask?.attempts || 0) + 1,
      createdAt: latestRepairTask?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    nextProject = upsertVideoRepairTask(nextProject, repairTask);
    nextProject = withVideoAutomationSegmentState(nextProject, segmentLabel, (state) => ({
      totalPasses: 0,
      localRepairCount: 0,
      regenerateCount: 0,
      exhausted: false,
      latestRepairTaskId: repairTask.id,
    }));
    nextProject = removeSegmentVideoOutput(nextProject, segmentLabel);
    const nextPrompts = { ...(nextProject.segmentVideoPrompts || {}) };
    delete nextPrompts[segmentLabel];
    nextProject = {
      ...nextProject,
      segmentVideoPrompts: nextPrompts,
      segmentVideoStatuses: {
        ...(nextProject.segmentVideoStatuses || {}),
        [segmentLabel]: buildSegmentVideoStatus(segmentLabel, "failed", {
          provider: nextProject.segmentVideoStatuses?.[segmentLabel]?.provider,
          failure: {
            message: "人工标记重做，系统会重编该片段提示词并重新出片。",
            provider: nextProject.segmentVideoStatuses?.[segmentLabel]?.provider,
            stage: "status",
            updatedAt: timestamp,
          },
        }),
      },
    };
  });
  nextProject = dismissSegmentReviewQueueItems(nextProject, selectedSegmentLabels, "redo", reason);
  selectedReferenceTargetIds.forEach((targetId) => {
    nextProject = withReferenceTargetState(
      clearReferenceTargetAsset(nextProject, targetId),
      targetId,
      (state) => ({
        ...state,
        targetId,
        status: "pending",
        attemptCount: 0,
        retryBudget: state?.retryBudget || 0,
        lastError: reason,
        lastTriedAt: timestamp,
        lastSucceededAt: undefined,
        generatedUrl: undefined,
        qualityScore: undefined,
        lastQaSummary: undefined,
        lastQaScore: undefined,
        lastQaPassed: undefined,
        lastQaQualityTier: undefined,
        lastQaGoldenSampleVersion: undefined,
        lastQaStrengths: undefined,
        lastQaGoldenSignals: undefined,
        lastQaFixPriorities: undefined,
        lastQaIssues: undefined,
        lastQaAt: undefined,
      }),
    );
    nextProject = dismissReferenceTargetReviewItems(nextProject, [targetId], "redo", reason);
  });
  const totalRedoCount = redoCount + selectedSegmentLabels.length + selectedReferenceTargetIds.length;

  return saveVideoProject(
    {
      ...nextProject,
      currentStep: deriveVisibleVideoStep(nextProject),
      analysisSummary: totalRedoCount
        ? `已有 ${totalRedoCount} 条审阅项被标记为重做。`
        : "当前没有匹配到需要重做的审阅项。",
    },
    totalRedoCount
      ? `已将 ${totalRedoCount} 条审阅项标记为重做。`
      : "当前没有匹配到需要重做的审阅项。",
  );
}

function collectTargetIds(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.targetIds)
    ? input.targetIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];

  if (list.length > 0) return list;
  if (typeof input.targetId === "string" && input.targetId.trim()) {
    return [input.targetId.trim()];
  }
  return [];
}

type SegmentCompileReportLike = {
  compiled: Array<{
    segmentLabel: string;
    outputPath: string;
    sceneCount: number;
    subtitleWarning?: string;
  }>;
  skipped: Array<{ segmentLabel: string; reason: string }>;
};

function resolveStoredSegmentVideoPath(url: string): string {
  if (!url) return "";
  return url.startsWith("file://") ? normalizeLocalVideoPath(url) : url;
}

function buildDirectSegmentVideoCompileReport(
  project: PersistedVideoProject,
  options: { addSubtitles: boolean },
): SegmentCompileReportLike | null {
  if ((project.videoGenerationPrefs?.mode ?? "image-to-video") !== "text-to-video") {
    return null;
  }

  const segmentVideos = project.segmentVideos ?? {};
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  const groupedScenes = new Map<string, Scene[]>();

  [...project.scenes]
    .sort((left, right) => left.sceneNumber - right.sceneNumber)
    .forEach((scene) => {
      const label = scene.segmentLabel?.trim();
      if (!label) return;
      const current = groupedScenes.get(label) ?? [];
      current.push(scene);
      groupedScenes.set(label, current);
    });

  const compiled: SegmentCompileReportLike["compiled"] = [];
  const skipped: SegmentCompileReportLike["skipped"] = [];

  for (const [segmentLabel, scenes] of groupedScenes.entries()) {
    const outputPath = resolveStoredSegmentVideoPath(segmentVideos[segmentLabel] ?? "");
    if (outputPath) {
      compiled.push({
        segmentLabel,
        outputPath,
        sceneCount: scenes.length,
        ...(options.addSubtitles
          ? { subtitleWarning: "片段视频模式暂不追加字幕，已直接导出已生成片段。" }
          : {}),
      });
      continue;
    }

    const status = normalizeSceneStatus(segmentStatuses[segmentLabel]?.status);
    if (status === "failed") {
      skipped.push({ segmentLabel, reason: "片段视频生成失败，已跳过当前片段。" });
      continue;
    }
    if (status === "queued" || status === "processing") {
      skipped.push({ segmentLabel, reason: "片段视频仍在生成中，已跳过当前片段。" });
      continue;
    }
    skipped.push({ segmentLabel, reason: "当前片段还没有已完成的视频结果。" });
  }

  return { compiled, skipped };
}

export async function compileSegmentVideosAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有可合并的分镜视频，先完成出片再执行 AI 自动处理导出。");
  }

  const directSegmentReport = buildDirectSegmentVideoCompileReport(project, {
    addSubtitles: input.addSubtitles === true,
  });
  const completedCount = directSegmentReport
    ? directSegmentReport.compiled.length
    : project.scenes.filter((scene) => scene.videoStatus === "completed" && scene.videoUrl).length;
  if (completedCount === 0) {
    throw new Error(
      directSegmentReport
        ? "当前没有已完成的片段视频，请先完成出片。"
        : "当前没有已完成的分镜视频，请先完成出片。",
    );
  }

  const { compileSegmentVideos, exportSegmentVideosToFolder } = await import("@/lib/home-agent/ffmpeg-segment-service");
  const addSubtitles = input.addSubtitles === true;
  const exportDirectory =
    typeof input.directoryPath === "string" && input.directoryPath.trim()
      ? input.directoryPath.trim()
      : null;

  const report = directSegmentReport ?? await compileSegmentVideos(project, { addSubtitles });

  if (report.compiled.length === 0) {
    const skipReasons = report.skipped.map((s) => `• 片段 ${s.segmentLabel}：${s.reason}`).join("\n");
    throw new Error(`所有片段均未能合并。\n${skipReasons}`);
  }

  // 将合并结果写入 segmentVideos 字段
  const nextSegmentVideos: Record<string, string> = { ...(project.segmentVideos ?? {}) };
  for (const result of report.compiled) {
    nextSegmentVideos[result.segmentLabel] = result.outputPath;
  }

  const summaryLines = [
    directSegmentReport
      ? `已整理 ${report.compiled.length} 个片段视频${addSubtitles ? "（保留原视频，不追加字幕）" : ""}：`
      : `已合并 ${report.compiled.length} 个片段视频${addSubtitles ? "（含字幕）" : ""}：`,
    ...report.compiled.map((r) => `• 片段 ${r.segmentLabel}（${r.sceneCount} 个分镜）→ ${r.outputPath}`),
  ];
  const subtitleWarnings = report.compiled
    .map((item) => item.subtitleWarning?.trim())
    .filter((warning): warning is string => Boolean(warning));
  if (subtitleWarnings.length) {
    summaryLines.push("", ...subtitleWarnings.map((warning) => `• ${warning}`));
  }
  if (exportDirectory) {
    const exportResult = await exportSegmentVideosToFolder(report.compiled, exportDirectory);
    summaryLines.push(
      "",
      `已自动导出到 ${exportDirectory}：`,
      `• 成功 ${exportResult.exportedCount} 个`,
      `• 失败 ${exportResult.failedCount} 个`,
    );
  }
  if (report.skipped.length) {
    summaryLines.push("", `跳过 ${report.skipped.length} 个片段：`);
    summaryLines.push(...report.skipped.map((s) => `• 片段 ${s.segmentLabel}：${s.reason}`));
  }

  return saveVideoProject(
    {
      ...project,
      segmentVideos: nextSegmentVideos,
    },
    summaryLines.join("\n"),
  );
}

export async function exportStoryboardXlsxAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  if (!project.scenes.length) {
    throw new Error("当前还没有可导出的拆镜结果，先完成剧本拆解再导出 xlsx。");
  }

  const { exportScenesToXlsx } = await import("@/lib/export-xlsx");
  await exportScenesToXlsx(
    project.scenes,
    buildVideoTitle(runtime, input),
    project.characters || [],
    project.sceneSettings || [],
  );

  const snapshot = createVideoSnapshot(synchronizeVideoProductionState(project));
  return {
    summary: `已导出《${project.title}》的 storyboard xlsx。`,
    projectSnapshot: snapshot,
    recommendedActions: snapshot.recommendedActions,
    data: {
      videoProject: project,
      projectSnapshot: snapshot,
    },
  };
}

export async function continueVideoStepAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const derivedStep =
    typeof input.targetStep === "number"
      ? Math.min(Math.max(input.targetStep, 1), 5)
      : deriveVisibleVideoStep(synchronizeVideoProductionState(project));

  const stageLabels: Record<number, string> = {
    1: "脚本拆解",
    2: "角色与场景",
    3: "分镜图生成",
    4: "视频生成",
    5: "预览与导出",
  };

  // 计算自然进度步骤（基于已完成数据推导，不受 currentStep 影响）
  const naturalStep = deriveVisibleVideoStep(synchronizeVideoProductionState(project));
  const stepGate = canSwitchToVideoWorkflowStep(
    synchronizeVideoProductionState(project),
    derivedStep,
    project.videoGenerationPrefs?.mode,
  );
  if (!stepGate.allowed) {
    throw new Error(stepGate.reason || "当前项目还没有满足切换到该视频步骤的基础条件。");
  }
  // 用户跳到比自然进度更靠后的步骤时，记录 manualStepOverride 以阻止自动推进；
  // 切回自然进度或更早的步骤时，清除该标记。
  const nextManualStepOverride = derivedStep > naturalStep ? derivedStep : null;

  return saveVideoProject(
    {
      ...project,
      currentStep: derivedStep,
      manualStepOverride: nextManualStepOverride,
      analysisSummary:
        project.analysisSummary ||
        `已把视频项目收口到「${stageLabels[derivedStep]}」阶段，可直接继续推进。`,
    },
    `已将《${project.title}》定位到「${stageLabels[derivedStep]}」阶段。`,
  );
}

async function runVideoContinuationPlan(
  plan: VideoWorkflowContinuationPlan,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  switch (plan.actionKind) {
    case "analyze_script_for_video":
      return analyzeScriptForVideoAction(plan.input, runtime);
    case "extract_video_entities":
      return extractVideoEntitiesAction(plan.input, runtime);
    case "generate_video_reference_assets":
      return generateVideoReferenceAssetsAction(plan.input, runtime);
    case "prepare_storyboard_batch":
      return prepareStoryboardBatchAction(plan.input, runtime);
    case "generate_storyboard_frames":
      return generateStoryboardFramesAction(plan.input, runtime);
    case "compile_video_shot_packets":
      return compileVideoShotPacketsAction(plan.input, runtime);
    case "prepare_video_prompt_batch":
      return prepareVideoPromptBatchAction(plan.input, runtime);
    case "prepare_segment_video_prompt":
      return prepareSegmentVideoPromptAction(plan.input, runtime);
    case "generate_video_assets":
      return generateVideoAssetsAction(plan.input, runtime);
    case "generate_segment_video":
      return generateSegmentVideoAction(plan.input, runtime);
    case "refresh_segment_video":
      return refreshSegmentVideoAction(plan.input, runtime);
    case "review_video_assets":
      return reviewVideoAssetsAction(plan.input, runtime);
    case "export_storyboard_xlsx":
      return exportStoryboardXlsxAction(plan.input, runtime);
    case "create_video_bridge_artifact":
      return createVideoBridgeArtifactAction(plan.input, runtime);
    default:
      throw new Error(`Unsupported video continuation action: ${plan.actionKind}`);
  }
}

function buildRoundStepLabel(plan: VideoWorkflowContinuationPlan): string {
  const labels: Record<VideoWorkflowContinuationPlan["policy"], string> = {
    "bootstrap-analysis": "完成脚本拆镜",
    "bootstrap-entities": "整理角色与场景",
    "bootstrap-reference-assets": "补齐角色与场景参考图",
    "bootstrap-storyboard-text": "整理分镜文本",
    "bootstrap-storyboard-frames": "补齐分镜图",
    "bootstrap-shot-packets": "编译镜头指令包",
    "bootstrap-prompt-batch": "生成视频提示词批次",
    "bootstrap-segment-prompt": "生成片段提示词",
    "refresh-running": "刷新进行中镜头",
    "refresh-running-segments": "刷新进行中片段",
    "repair-failed": "补发失败镜头",
    "repair-failed-segments": "自动修复失败片段",
    "generate-next-batch": "提交下一批镜头出片",
    "generate-next-segment-batch": "提交下一批片段出片",
    "review-escalated": "进入人工兜底审阅",
    "bridge-summary": "整理桥接摘要",
  };

  return labels[plan.policy];
}

export async function advanceVideoWorkflowAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const prepared = await prepareVideoGenerationAction(input, runtime);
  const preparedProject = prepared.data?.videoProject;
  if (!preparedProject) {
    return prepared;
  }

  const preparedRuntime = withVideoProject(runtime, preparedProject);
  const contextSummary = buildVideoContextSummary(preparedProject);

  if (!preparedProject.script?.trim()) {
    return {
      ...prepared,
      summary: [
        prepared.summary,
        contextSummary ? `已记录当前视频意图：\n${contextSummary}` : null,
        "接下来只要把脚本、分集正文或现有项目内容发给我，我就会继续拆镜和出片准备。",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  const plan = planVideoWorkflowContinuation(preparedProject, input);
  const result = await runVideoContinuationPlan(
    plan,
    withVideoProject(preparedRuntime, preparedProject),
  );
  const batchHint = buildVideoContinuationBatchHint(plan);

  return {
    ...result,
    summary: [plan.reason, result.summary, batchHint].filter(Boolean).join("\n\n"),
  };
}

export async function advanceVideoWorkflowRoundAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const prepared = await prepareVideoGenerationAction(input, runtime);
  const preparedProject = prepared.data?.videoProject;
  if (!preparedProject) {
    return prepared;
  }

  if (!preparedProject.script?.trim()) {
    return advanceVideoWorkflowAction(input, runtime);
  }

  let workingRuntime = withVideoProject(runtime, preparedProject);
  let latestResult: WorkflowActionResult = prepared;
  const executedPlans: VideoWorkflowContinuationPlan[] = [];
  const maxSteps =
    typeof input.maxSteps === "number" && Number.isFinite(input.maxSteps)
      ? Math.max(1, Math.min(8, Math.floor(input.maxSteps)))
      : 6;

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    const currentProject = workingRuntime.currentVideoProject;
    if (!currentProject?.script?.trim()) break;

    const plan = planVideoWorkflowContinuation(currentProject, input);
    executedPlans.push(plan);
    latestResult = await runVideoContinuationPlan(plan, workingRuntime);

    const nextProject = latestResult.data?.videoProject ?? workingRuntime.currentVideoProject;
    if (nextProject) {
      workingRuntime = withVideoProject(
        {
          ...workingRuntime,
          currentVideoProject: nextProject,
          currentProjectSnapshot: latestResult.data?.projectSnapshot ?? createVideoSnapshot(nextProject),
        },
        nextProject,
      );
    } else if (latestResult.data?.projectSnapshot) {
      workingRuntime = {
        ...workingRuntime,
        currentProjectSnapshot: latestResult.data.projectSnapshot,
      };
    }

    if (VIDEO_ROUND_TERMINAL_POLICIES.has(plan.policy)) {
      break;
    }
  }

  const roundSummary = executedPlans.length
    ? `本轮连续推进了 ${executedPlans.length} 步：${executedPlans.map(buildRoundStepLabel).join(" -> ")}。`
    : "";
  const finalPlan = executedPlans.at(-1);
  const batchHint = finalPlan ? buildVideoContinuationBatchHint(finalPlan) : "";

  return {
    ...latestResult,
    summary: [roundSummary, latestResult.summary, batchHint].filter(Boolean).join("\n\n"),
  };
}

export async function createVideoBridgeArtifactAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const script = resolveWorkingScript(runtime, project, input);
  const bridge = [
    `项目：${buildVideoTitle(runtime, input)}`,
    `脚本长度：${script.length} 字`,
    `镜头数：${project.scenes.length}`,
    `角色数：${project.characters.length}`,
    `场景数：${project.sceneSettings.length}`,
    `当前阶段：${project.currentStep}`,
    "",
    project.analysisSummary || "视频工作流已接管，等待进一步分析。",
  ].join("\n");
  const synchronizedProject = synchronizeVideoProductionState(project);
  const naturalStep = deriveVisibleVideoStep(synchronizedProject);
  const shouldAdvanceToRoleScene =
    hasVideoBootstrapContext(project) &&
    hasPassedVideoScriptBreakdown(synchronizedProject) &&
    synchronizedProject.scenes.length > 0;

  const nextProject = {
    ...project,
    targetPlatform: project.targetPlatform,
    shotStyle: project.shotStyle,
    outputGoal: project.outputGoal,
    analysisSummary: bridge,
    currentStep: shouldAdvanceToRoleScene ? Math.max(2, naturalStep) : naturalStep,
  };

  return saveVideoProject(
    nextProject,
    `已为《${project.title}》整理视频桥接摘要。`,
  );
}

// ---- 片段提示词生成 ----

function buildSegmentShotRawPrompt(scene: Scene): string {
  const rawPrompt = scene.description?.trim() || scene.sceneName?.trim() || "继续当前镜头动作";
  return softenVideoSubmissionNarrativeCameraCue(rawPrompt) || rawPrompt;
}

function buildSegmentShotCorePrompt(scene: Scene): string {
  const enhancedPrompt = stripExactDialogueLockBlock(scene.enhancedVideoPrompt);
  return enhancedPrompt ? truncate(enhancedPrompt, 900) : buildSegmentShotRawPrompt(scene);
}

function getSegmentShotPromptSource(scene: Scene): "enhanced" | "raw" {
  return stripExactDialogueLockBlock(scene.enhancedVideoPrompt) ? "enhanced" : "raw";
}

export function buildRequiredSegmentCoverageBlock(
  orderedScenes: Scene[],
  targetDuration: number,
): string {
  const shotLines = orderedScenes.map((scene, idx) => {
    const softenedCameraDirection = softenSegmentCameraDirectionHint(scene.cameraDirection?.trim() || "");
    const parts = [
      `镜头${idx + 1}：${scene.sceneName}，${buildSegmentShotRawPrompt(scene)}`,
      softenedCameraDirection,
      scene.dialogue?.trim()
        ? `台词音频 ${scene.dialogue.trim()}，只走音频不上屏`
        : "无台词",
    ].filter(Boolean);
    return parts.join("，");
  });

  return [
    "【镜头锚点补充】",
    `总时长 ${targetDuration}秒，按顺序覆盖全部 ${orderedScenes.length} 个镜头。`,
    "全局限制已在开头统一锁定，后续镜头只补新增变化，不要逐镜重复无字幕或无水印。",
    "这里只补每个镜头最小的可视化锚点，不重复展开规则。",
    ...shotLines,
  ].join("\n");
}

function appendRequiredSegmentCoverage(
  prompt: string,
  orderedScenes: Scene[],
  targetDuration: number,
): string {
  return [
    prompt.trim(),
    buildRequiredSegmentCoverageBlock(orderedScenes, targetDuration),
  ].filter(Boolean).join("\n\n");
}

function hasReadySegmentVideoPrompt(
  prompts: Record<string, SegmentVideoPrompt> | undefined,
  segmentLabel: string,
): boolean {
  return Boolean(prompts?.[segmentLabel]?.prompt?.trim());
}

function buildSegmentContinuitySummary(
  segmentLabel: string,
  scenes: Scene[] | undefined,
): string {
  if (!scenes?.length) return "";
  const orderedScenes = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const firstScene = orderedScenes[0];
  const lastScene = orderedScenes.at(-1);
  return [
    `片段 ${segmentLabel}`,
    firstScene?.sceneName || lastScene?.sceneName
      ? `场景：${[firstScene?.sceneName, lastScene?.sceneName].filter(Boolean).join(" -> ")}`
      : "",
    `镜头：${orderedScenes.map((scene) => `${scene.sceneNumber}.${scene.sceneName}`).join(" / ")}`,
    `内容：${orderedScenes
      .map((scene) => scene.description?.trim())
      .filter(Boolean)
      .join("；")}`,
  ].filter(Boolean).join("\n");
}

function buildSegmentScriptExpansionSkeleton(
  segmentLabel: string,
  scenes: Scene[] | undefined,
): string {
  if (!scenes?.length) return "";
  const orderedScenes = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  return orderedScenes.map((scene, index) => {
    const parts = [
      `分镜${index + 1}`,
      Number.isFinite(scene.duration) && scene.duration > 0 ? `${scene.duration}秒` : "",
      scene.sceneName?.trim() ? `场景：${scene.sceneName.trim()}` : "",
      `剧情：${buildSegmentShotRawPrompt(scene)}`,
      scene.dialogue?.trim() ? `台词：${scene.dialogue.trim()}` : "",
    ].filter(Boolean);
    return parts.join("｜");
  }).join("\n");
}

function buildSegmentShotRelaySkeleton(
  scenes: Scene[] | undefined,
  shotPackets: VideoShotPacket[],
): string {
  if (!scenes?.length) return "";
  const packetBySceneId = new Map(
    (Array.isArray(shotPackets) ? shotPackets : [])
      .filter((packet) => packet?.sceneId)
      .map((packet) => [packet.sceneId, packet] as const),
  );

  return [...scenes]
    .sort((left, right) => left.sceneNumber - right.sceneNumber)
    .map((scene, index) => {
      const packet = packetBySceneId.get(scene.id);
      const openingState = compressSegmentContinuityCue(
        packet?.startState || buildSegmentShotRawPrompt(scene),
        88,
        { stripLeadingTags: true },
      ).replace(/[。！？；]+$/g, "");
      const motionBeat = compressSegmentContinuityCue(
        buildSegmentShotRawPrompt(scene),
        96,
        { stripLeadingTags: true },
      ).replace(/[。！？；]+$/g, "");
      const closingState = compressSegmentContinuityCue(
        packet?.endState || buildSegmentShotRawPrompt(scene),
        88,
        { stripLeadingTags: true },
      ).replace(/[。！？；]+$/g, "");
      const nextHandoff = compressSegmentContinuityCue(packet?.nextAnchor || "", 56, {
        stripLeadingTags: true,
      }).replace(/[。！？；]+$/g, "");
      return [
        `分镜${index + 1}`,
        openingState ? `开场：${openingState}` : "",
        motionBeat ? `推进：${motionBeat}` : "",
        closingState ? `收尾：${closingState}` : "",
        nextHandoff ? `下一接拍：${nextHandoff}` : "",
      ].filter(Boolean).join("｜");
    })
    .join("\n");
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((value) => {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

type ScriptSearchTerm = {
  term: string;
  weight: number;
};

function buildScriptSearchTermsFromScenes(
  scenes: Scene[] | undefined,
  weights?: {
    sceneName?: number;
    description?: number;
    dialogue?: number;
    fragment?: number;
    character?: number;
  },
): ScriptSearchTerm[] {
  if (!scenes?.length) return [];
  const terms: ScriptSearchTerm[] = [];
  const pushTerm = (term: string | undefined, weight: number) => {
    const normalized = String(term || "").trim();
    if (!normalized) return;
    terms.push({ term: normalized, weight });
  };

  scenes.forEach((scene) => {
    pushTerm(scene.sceneName, weights?.sceneName ?? 3);
    pushTerm(scene.description, weights?.description ?? 5);
    (scene.characters || []).forEach((character) => pushTerm(character, weights?.character ?? 2));

    splitExactDialogueLines(scene.dialogue).forEach((line) => {
      const normalizedLine = String(line || "").trim();
      pushTerm(normalizedLine, weights?.dialogue ?? 5);
      const speakerSplit = normalizedLine.split(/[:：]/);
      if (speakerSplit.length > 1) {
        pushTerm(speakerSplit.slice(1).join("：").trim(), Math.max(1, (weights?.dialogue ?? 5) - 1));
      }
    });

    [scene.sceneName, scene.description, scene.dialogue]
      .flatMap((text) => String(text || "").split(/[，,。！？；、\n]/))
      .map((part) => part.trim())
      .filter((part) => part.length >= 3)
      .slice(0, 10)
      .forEach((part) => pushTerm(part, weights?.fragment ?? 2));
  });

  const deduped = new Map<string, number>();
  terms.forEach(({ term, weight }) => {
    const key = term.toLowerCase();
    const existing = deduped.get(key) ?? 0;
    deduped.set(key, Math.max(existing, weight));
  });
  return [...deduped.entries()].map(([term, weight]) => ({ term, weight }));
}

function scoreScriptLine(line: string, terms: ScriptSearchTerm[]): number {
  const normalizedLine = String(line || "").trim();
  if (!normalizedLine) return 0;
  const keywordScore = terms.reduce((score, { term, weight }) => {
    if (!term) return score;
    return normalizedLine.includes(term) || term.includes(normalizedLine)
      ? score + Math.max(weight, Math.min(6, term.length))
      : score;
  }, 0);
  const actionBonusTerms = [
    "猛地", "骤然", "突然", "立刻", "瞬间", "随即", "随后", "继续", "开始", "抬眼", "抬头",
    "后退", "逼近", "压向", "逼向", "俯冲", "翻起", "蜷缩", "锁定", "停在", "定格", "扑向",
    "按进", "擦裂", "震起", "坠落", "抬起", "前压", "后撤",
  ];
  const reactionBonusTerms = [
    "眼底", "视线", "目光", "神情", "呼吸", "指尖", "脸色", "身体", "喉前", "肩背", "额角",
    "杀意", "情绪", "反应", "动摇", "僵住",
  ];
  const resultBonusTerms = [
    "于是", "让", "令", "成为", "保留", "留下", "结果", "停点", "直接结果", "压住", "裂开",
    "染红", "翻出来", "凝成", "扑向", "逼到", "锁住",
  ];
  const actionBonus = actionBonusTerms.reduce((sum, term) => sum + (normalizedLine.includes(term) ? 2 : 0), 0);
  const reactionBonus = reactionBonusTerms.reduce((sum, term) => sum + (normalizedLine.includes(term) ? 2 : 0), 0);
  const resultBonus = resultBonusTerms.reduce((sum, term) => sum + (normalizedLine.includes(term) ? 1 : 0), 0);
  const quoteBonus = /[:：][^：\n]{2,}/.test(normalizedLine) ? 2 : 0;
  return keywordScore + actionBonus + reactionBonus + resultBonus + quoteBonus;
}

function mergeScriptExcerptWindows(
  windows: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (!windows.length) return [];
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 2) {
      last.end = Math.max(last.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function buildPrioritizedScriptReferenceBlock(
  lines: string[],
  matchedLines: Array<{ index: number; line: string; score: number }>,
): string {
  const topLines = matchedLines
    .filter(({ line }) => String(line || "").trim().length >= 6)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .map(({ line }) => line.trim());
  const dedupedTopLines = uniqueNonEmptyStrings(topLines);
  if (!dedupedTopLines.length) return "";

  const contextSet = new Set(lines.map((line) => line.trim()).filter(Boolean));
  const prioritizedLines = dedupedTopLines.filter((line) => contextSet.has(line));
  if (!prioritizedLines.length) return "";

  return `关键补全句：\n${prioritizedLines.join("\n")}`;
}

function buildShotAlignedScriptReferenceBlock(
  scenes: Scene[] | undefined,
  matchedLines: Array<{ index: number; line: string; score: number }>,
): string {
  if (!scenes?.length || !matchedLines.length) return "";
  const usedLineIndexes = new Set<number>();
  const shotLines: string[] = [];

  scenes.forEach((scene, index) => {
    const sceneTerms = buildScriptSearchTermsFromScenes([scene], {
      sceneName: 4,
      description: 7,
      dialogue: 7,
      fragment: 3,
      character: 3,
    });
    if (!sceneTerms.length) return;

    const rankedMatches = matchedLines
      .map((item) => ({
        ...item,
        sceneScore: scoreScriptLine(item.line, sceneTerms),
      }))
      .filter(({ sceneScore }) => sceneScore > 0)
      .sort((a, b) => b.sceneScore - a.sceneScore || b.score - a.score || a.index - b.index);

    const preferredMatches = rankedMatches.filter(({ index: lineIndex }) => !usedLineIndexes.has(lineIndex));
    const selectedMatches = (preferredMatches.length ? preferredMatches : rankedMatches).slice(0, 2);
    const selectedLines = uniqueNonEmptyStrings(selectedMatches.map(({ line }) => line.trim()));
    if (!selectedLines.length) return;

    selectedMatches.forEach(({ index: lineIndex }) => usedLineIndexes.add(lineIndex));
    shotLines.push(`分镜${index + 1}：${selectedLines.join("；")}`);
  });

  return shotLines.length ? `分镜补全指向：\n${shotLines.join("\n")}` : "";
}

function parseScriptEpisodeNumber(raw: string): number | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (trimmed === "十") return 10;
  if (trimmed.startsWith("十")) {
    return 10 + (digitMap[trimmed.slice(1)] ?? 0);
  }
  if (trimmed.endsWith("十")) {
    return (digitMap[trimmed[0]] ?? 0) * 10;
  }
  const tenIndex = trimmed.indexOf("十");
  if (tenIndex > 0) {
    const tens = digitMap[trimmed.slice(0, tenIndex)] ?? 0;
    const ones = digitMap[trimmed.slice(tenIndex + 1)] ?? 0;
    return tens * 10 + ones;
  }

  const collapsed = trimmed.split("").reduce((acc, char) => acc * 10 + (digitMap[char] ?? 0), 0);
  return collapsed > 0 ? collapsed : null;
}

function parseSegmentEpisodeNumber(segmentLabel: string): number | null {
  const normalized = String(segmentLabel || "").trim();
  if (!normalized) return null;
  const match =
    normalized.match(/^(?:EP\s*0*)?(\d+)-/i) ||
    normalized.match(/^(\d+)-/);
  if (!match?.[1]) return null;
  const episodeNumber = Number(match[1]);
  return Number.isFinite(episodeNumber) && episodeNumber > 0 ? episodeNumber : null;
}

function extractEpisodeScriptBlock(script: string, episodeNumber: number | null): string {
  const normalized = String(script || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  if (!episodeNumber) return normalized;

  const lines = normalized.split("\n");
  const headerRe =
    /^\s*(?:#\s*)?(?:EP\s*0*(\d+)|Episode\s+0*(\d+)|第\s*([零一二三四五六七八九十百千万\d]+)\s*[集话期章])(?:\s*[：:\-—].*)?$/i;
  const headers: Array<{ index: number; episodeNumber: number }> = [];

  lines.forEach((line, index) => {
    const match = line.match(headerRe);
    if (!match) return;
    const parsed = parseScriptEpisodeNumber(match[1] || match[2] || match[3] || "");
    if (parsed) headers.push({ index, episodeNumber: parsed });
  });

  if (!headers.length) return normalized;
  const currentHeaderIndex = headers.findIndex((item) => item.episodeNumber === episodeNumber);
  if (currentHeaderIndex < 0) return normalized;
  const start = headers[currentHeaderIndex].index;
  const end = currentHeaderIndex < headers.length - 1 ? headers[currentHeaderIndex + 1].index : lines.length;
  return lines.slice(start, end).join("\n").trim();
}

function buildSegmentScriptSourceExcerpt(
  segmentLabel: string,
  scenes: Scene[] | undefined,
  previousScenes: Scene[] | undefined,
  nextScenes: Scene[] | undefined,
  script: string,
): string {
  const episodeBlock = extractEpisodeScriptBlock(script, parseSegmentEpisodeNumber(segmentLabel));
  if (!episodeBlock) return "";

  const lines = episodeBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const searchTerms = [
    ...buildScriptSearchTermsFromScenes(scenes, {
      sceneName: 4,
      description: 6,
      dialogue: 6,
      fragment: 3,
      character: 3,
    }),
    ...buildScriptSearchTermsFromScenes(previousScenes?.slice(-1), {
      sceneName: 2,
      description: 3,
      dialogue: 3,
      fragment: 1,
      character: 1,
    }),
    ...buildScriptSearchTermsFromScenes(nextScenes?.slice(0, 1), {
      sceneName: 2,
      description: 3,
      dialogue: 3,
      fragment: 1,
      character: 1,
    }),
  ];

  if (!searchTerms.length) return truncate(lines.join("\n"), 1200);

  const scoredLines = lines.map((line, index) => ({
    index,
    line,
    score: scoreScriptLine(line, searchTerms),
  }));
  const matchedLines = scoredLines.filter(({ score }) => score > 0);

  if (!matchedLines.length) return truncate(lines.join("\n"), 1200);

  const matchedIndexes = matchedLines.map(({ index }) => index);
  const firstMatchedIndex = Math.min(...matchedIndexes);
  const lastMatchedIndex = Math.max(...matchedIndexes);
  const compactSpanStart = Math.max(0, firstMatchedIndex - 2);
  const compactSpanEnd = Math.min(lines.length - 1, lastMatchedIndex + 2);
  const shotAlignedBlock = buildShotAlignedScriptReferenceBlock(scenes, matchedLines);

  if (compactSpanEnd - compactSpanStart <= 12) {
    const compactExcerpt = lines.slice(compactSpanStart, compactSpanEnd + 1).join("\n").trim();
    const prioritizedBlock = buildPrioritizedScriptReferenceBlock(
      lines.slice(compactSpanStart, compactSpanEnd + 1),
      matchedLines,
    );
    const combinedCompactExcerpt = [
      shotAlignedBlock,
      prioritizedBlock,
      compactExcerpt ? `上下文参考：\n${compactExcerpt}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return truncate(combinedCompactExcerpt || compactExcerpt || lines.join("\n"), 1500);
  }

  const anchorIndexes = new Set<number>([
    firstMatchedIndex,
    lastMatchedIndex,
    ...matchedLines
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 6)
      .map(({ index }) => index),
  ]);
  const mergedWindows = mergeScriptExcerptWindows(
    [...anchorIndexes].map((index) => ({
      start: Math.max(0, index - 2),
      end: Math.min(lines.length - 1, index + 2),
    })),
  );

  const excerptParts = mergedWindows.map(({ start, end }, index) => {
    const prefix = index === 0 && start > 0 ? "……\n" : "";
    const suffix = index < mergedWindows.length - 1 && end < lines.length - 1 ? "\n……" : "";
    return `${prefix}${lines.slice(start, end + 1).join("\n")}${suffix}`.trim();
  });
  const excerpt = excerptParts.filter(Boolean).join("\n").trim();
  const contextExcerpt = excerpt || lines.join("\n");
  const prioritizedBlock = buildPrioritizedScriptReferenceBlock(lines, matchedLines);
  const combinedExcerpt = [
    shotAlignedBlock,
    prioritizedBlock,
    contextExcerpt ? `上下文参考：\n${contextExcerpt}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return truncate(combinedExcerpt || contextExcerpt || lines.join("\n"), 1500);
}

function countStructuredStoryboardBlocks(prompt: string): number {
  const normalized = String(prompt || "");
  const storyboardMatches = normalized.match(/分镜\s*\d+\s*[（(][^）)]*[）)]\s*[:：]/g);
  if (storyboardMatches?.length) return storyboardMatches.length;
  const timeMatches = normalized.match(/\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?秒\s*[:：]/g);
  if (timeMatches?.length) return timeMatches.length;
  const shotMatches = normalized.match(/镜头\s*\d+\s*[:：]/g);
  return shotMatches?.length ?? 0;
}

function hasCompleteSegmentPromptShotCoverage(
  prompt: string,
  orderedScenes: Scene[],
): boolean {
  const expectedShotCount = Math.max(1, orderedScenes.length);
  return countStructuredStoryboardBlocks(prompt) >= expectedShotCount;
}

type SegmentBeatDirectionIssue = {
  beatIndex: number;
  missingCameraLanguage: boolean;
  missingMotionLanguage: boolean;
};

const SEGMENT_BEAT_CAMERA_LANGUAGE_PATTERN =
  /(镜头|视角|特写|近景|中景|远景|全景|大全景|空镜|俯拍|仰拍|平视|侧拍|背拍|主观|构图|机位|焦点|聚焦|转焦|拉焦|焦距)/;

const SEGMENT_BEAT_MOTION_LANGUAGE_PATTERN =
  /(推进|推近|拉近|拉开|后拉|横移|移向|移至|摇向|摇镜|跟随|跟到|跟拍|切至|切回|切换|转至|转向|转场|逼近|压近|扫过|掠过|抬升|俯冲|盘旋|定格|停在|停留|承接|接拍|回拉|滑向|转入|转回|聚到|对准)/;

function collectSegmentBeatDirectionIssues(prompt: string): SegmentBeatDirectionIssue[] {
  const beatLines = String(prompt || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^分镜\d+/.test(line));

  return beatLines
    .map((line, index) => {
      const description = line.replace(/^分镜\d+(?:（[^）]+）)?：/, "").trim();
      const missingCameraLanguage = !SEGMENT_BEAT_CAMERA_LANGUAGE_PATTERN.test(description);
      const missingMotionLanguage = !SEGMENT_BEAT_MOTION_LANGUAGE_PATTERN.test(description);
      if (!missingCameraLanguage && !missingMotionLanguage) return null;
      return {
        beatIndex: index + 1,
        missingCameraLanguage,
        missingMotionLanguage,
      };
    })
    .filter((issue): issue is SegmentBeatDirectionIssue => Boolean(issue));
}

function buildSegmentBeatDirectionRetryFeedback(
  issues: SegmentBeatDirectionIssue[],
  shots: Array<{ cameraDirection?: string; prompt?: string; index: number }>,
): string {
  if (!issues.length) return "";
  return issues
    .map((issue) => {
      const shot = shots[issue.beatIndex - 1];
      const missingParts = [
        issue.missingCameraLanguage ? "明确镜头语言" : "",
        issue.missingMotionLanguage ? "明确运镜或衔接动作" : "",
      ].filter(Boolean);
      const normalizedCameraHint = softenSegmentCameraDirectionHint(String(shot?.cameraDirection || "").trim());
      const sourcePromptHint = String(shot?.prompt || "").trim();
      const fallbackHint = normalizedCameraHint || sourcePromptHint;
      return [
        `分镜${issue.beatIndex} 缺少${missingParts.join("和")}。`,
        "保留当前剧情事实、角色动作和台词，只补足镜头与运镜描述，不要删减现有分镜内容。",
        fallbackHint ? `优先吸收这条原始镜头提示：${fallbackHint}` : "",
      ].filter(Boolean).join("");
    })
    .join("\n");
}

function buildSegmentSceneEdgeSummary(
  segmentLabel: string,
  scenes: Scene[] | undefined,
  edge: "start" | "end",
): string {
  if (!scenes?.length) return "";
  const orderedScenes = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const scene = edge === "start" ? orderedScenes[0] : orderedScenes.at(-1);
  const description = truncate(scene?.description?.trim() || scene?.sceneName?.trim() || "", 180);
  const sceneLabel = scene?.sceneName?.trim() || `片段 ${segmentLabel}`;
  if (!description) return sceneLabel;
  return `${sceneLabel}：${description}`;
}

function buildSegmentStoryGoalText(scenes: Scene[] | undefined): string {
  if (!scenes?.length) return "";
  const orderedScenes = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const firstSummary = truncate(orderedScenes[0]?.description?.trim() || orderedScenes[0]?.sceneName?.trim() || "", 120);
  const lastSummary = truncate(orderedScenes.at(-1)?.description?.trim() || orderedScenes.at(-1)?.sceneName?.trim() || "", 120);
  if (firstSummary && lastSummary && firstSummary !== lastSummary) {
    return `本段剧情从“${firstSummary}”推进到“${lastSummary}”。`;
  }
  return firstSummary ? `本段剧情聚焦“${firstSummary}”。` : "";
}

function resolveSegmentScenesForSubmission(
  project: PersistedVideoProject,
  segmentLabel: string,
  segmentPrompt: SegmentVideoPrompt,
): Scene[] {
  const projectScenes = Array.isArray(project.scenes) ? project.scenes : [];
  const promptSceneIds = Array.isArray(segmentPrompt.sceneIds)
    ? segmentPrompt.sceneIds.map((sceneId) => String(sceneId || "").trim()).filter(Boolean)
    : [];
  const promptSceneIdSet = new Set(promptSceneIds);
  const matchedByIds = projectScenes.filter((scene) => promptSceneIdSet.has(String(scene.id || "").trim()));
  const fallbackByLabel = projectScenes.filter((scene) => String(scene.segmentLabel || "").trim() === segmentLabel);
  const resolvedScenes = matchedByIds.length >= fallbackByLabel.length && matchedByIds.length
    ? matchedByIds
    : fallbackByLabel;
  return [...resolvedScenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
}

function extractSegmentEndHookText(prompt: string | null | undefined): string {
  const raw = stripExactDialogueLockBlock(prompt);
  if (!raw) return "";
  const sections = extractVideoSubmissionSections(raw);
  const endHookSection = sections.find((section) => section.label === "结尾钩子");
  if (endHookSection?.content) {
    return cleanupVideoSubmissionPrompt(endHookSection.content);
  }
  const matched = raw.match(/结尾钩子[:：]\s*([\s\S]+)$/);
  if (matched?.[1]) {
    return cleanupVideoSubmissionPrompt(matched[1]);
  }
  const tail = raw.split(/[。！？]/).map((part) => part.trim()).filter(Boolean).at(-1) || "";
  return cleanupVideoSubmissionPrompt(tail);
}

function buildSceneSegmentOrderContext(scenes: Scene[]): {
  segmentOrder: string[];
  segmentMap: Map<string, Scene[]>;
} {
  const segmentMap = new Map<string, Scene[]>();
  const segmentOrder: string[] = [];
  const episodeSegmentRe = /^(\d+)-(\d+)$/;

  for (const scene of [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    const key = scene.segmentLabel?.trim();
    if (!key || !episodeSegmentRe.test(key)) continue;
    if (!segmentMap.has(key)) {
      segmentMap.set(key, []);
      segmentOrder.push(key);
    }
    segmentMap.get(key)?.push(scene);
  }

  return { segmentOrder, segmentMap };
}

function buildSegmentSubmissionStartContinuityText(
  previousSegmentEndState: string,
  currentSegmentStartState: string,
  _currentSegmentStoryGoal: string,
  hasPreviousSegmentContext = false,
  hasContinuityFrameReference = false,
  hasContinuityKeyframeSet = false,
  hasContinuityGridReference = false,
  
  referenceUsageSummary = "",
): string {
  if (!hasPreviousSegmentContext) return "";
  const safePreviousSegmentEndState = compressSegmentContinuityCue(previousSegmentEndState, 118, {
    stripLeadingTags: true,
  }).replace(/[。！？；]+$/g, "");
  const safeCurrentSegmentStartState = compressSegmentContinuityCue(currentSegmentStartState, 128, {
    stripLeadingTags: true,
  }).replace(/[。！？；]+$/g, "");
  if (!previousSegmentEndState && !currentSegmentStartState && !referenceUsageSummary) return "";
  const lines: string[] = [];
  if (referenceUsageSummary) {
    lines.push(referenceUsageSummary);
  } else if (hasContinuityKeyframeSet || hasContinuityFrameReference) {
    lines.push("逐图参考：以上一段连续性参考图延续动作关系、站位、视线、轴线、主光和环境状态。");
  }
  if (hasContinuityGridReference) {
    lines.push("六宫格按顺序说明上一段镜头是如何运动到这里的；首镜从图1尾帧画面直接接拍，先对齐尾帧里的姿态、站位、视线、轴线、主光和环境，再继续本段动作。");
  }
  if (safePreviousSegmentEndState) {
    lines.push(`上一停点：${safePreviousSegmentEndState}。`);
  }
  if (safeCurrentSegmentStartState) {
    lines.push(`本段开场：${safeCurrentSegmentStartState}。`);
  }
  return lines.join("\n");
}

function buildSegmentSubmissionFlowContinuityText(
  currentSegmentStoryGoal: string,
  currentSegmentEndState: string,
  nextSegmentStartState: string,
  
): string {
  const safeCurrentSegmentEndState = compressSegmentContinuityCue(currentSegmentEndState, 118, {
    stripLeadingTags: true,
  }).replace(/[。！？；]+$/g, "");
  const safeNextSegmentStartState = compressSegmentContinuityCue(nextSegmentStartState, 118, {
    stripLeadingTags: true,
  }).replace(/[。！？；]+$/g, "");
  const safeCurrentSegmentStoryGoal = compressSegmentContinuityCue(currentSegmentStoryGoal, 96, {
    stripLeadingTags: true,
  }).replace(/[。！？；]+$/g, "");
  const resolvedEndTarget = safeCurrentSegmentEndState || safeNextSegmentStartState || safeCurrentSegmentStoryGoal;
  const lines = [
    "全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。",
    "先按已拆解分镜顺序推进，各分镜按上一结果 -> 当前动作 -> 下一停点接力；缺口只补剧本里明确存在的承接动作、反应或状态变化。",
    resolvedEndTarget ? `本段结尾：${resolvedEndTarget}。` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function buildSegmentPromptContinuityContext(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  segmentOrder: string[];
  segmentMap: Map<string, Scene[]>;
  segmentPrompts: Record<string, SegmentVideoPrompt>;
  script: string;
}): {
  previousSegmentLabel: string;
  nextSegmentLabel: string;
  previousSegmentSummary: string;
  nextSegmentSummary: string;
  previousSegmentPrompt: string;
  previousSegmentEndState: string;
  currentSegmentStartState: string;
  currentSegmentEndState: string;
  nextSegmentStartState: string;
  currentSegmentStoryGoal: string;
  currentSegmentScriptSource: string;
  currentSegmentScriptSkeleton: string;
  currentSegmentShotRelayPlan: string;
  continuityRules: string;
} {
  const currentIndex = params.segmentOrder.indexOf(params.segmentLabel);
  const previousLabel = currentIndex > 0 ? params.segmentOrder[currentIndex - 1] : "";
  const nextLabel =
    currentIndex >= 0 && currentIndex < params.segmentOrder.length - 1
      ? params.segmentOrder[currentIndex + 1]
      : "";
  const previousPrompt = previousLabel
    ? stripExactDialogueLockBlock(params.segmentPrompts[previousLabel]?.prompt ?? "").slice(-800)
    : "";
  const currentScenes = params.segmentMap.get(params.segmentLabel);
  const previousSegmentEndState = previousPrompt
    ? extractSegmentEndHookText(previousPrompt) || buildSegmentSceneEdgeSummary(previousLabel, params.segmentMap.get(previousLabel), "end")
    : buildSegmentSceneEdgeSummary(previousLabel, params.segmentMap.get(previousLabel), "end");
  const currentSegmentStartState = buildSegmentSceneEdgeSummary(
    params.segmentLabel,
    currentScenes,
    "start",
  );
  const currentSegmentEndState = buildSegmentSceneEdgeSummary(
    params.segmentLabel,
    currentScenes,
    "end",
  );
  const currentSegmentScriptSkeleton = buildSegmentScriptExpansionSkeleton(
    params.segmentLabel,
    currentScenes,
  );
  const currentSegmentShotRelayPlan = buildSegmentShotRelaySkeleton(
    currentScenes,
    collectSegmentShotPackets(
      params.project,
      (currentScenes ?? []).map((scene) => scene.id),
    ),
  );
  const currentSegmentScriptSource = buildSegmentScriptSourceExcerpt(
    params.segmentLabel,
    currentScenes,
    params.segmentMap.get(previousLabel),
    params.segmentMap.get(nextLabel),
    params.script,
  );
  const nextSegmentStartState = buildSegmentSceneEdgeSummary(
    nextLabel,
    params.segmentMap.get(nextLabel),
    "start",
  );
  const currentSegmentStoryGoal = buildSegmentStoryGoalText(currentScenes);

  return {
    previousSegmentLabel: previousLabel,
    nextSegmentLabel: nextLabel,
    previousSegmentSummary: previousLabel
      ? buildSegmentContinuitySummary(previousLabel, params.segmentMap.get(previousLabel))
      : "",
    nextSegmentSummary: nextLabel
      ? buildSegmentContinuitySummary(nextLabel, params.segmentMap.get(nextLabel))
      : "",
    previousSegmentPrompt: previousPrompt,
    previousSegmentEndState,
    currentSegmentStartState,
    currentSegmentEndState,
    nextSegmentStartState,
    currentSegmentStoryGoal,
    currentSegmentScriptSource,
    currentSegmentScriptSkeleton,
    currentSegmentShotRelayPlan,
    continuityRules: [
      "保持角色外貌、服装、场景光线、空间关系和关键道具状态连续。",
      "片段开头统一只接上一片段最后的动作结果、角色站位、视线方向、镜头轴线、主光方向和情绪状态，不要重复整段剧情。",
      "第一段第一句直接从上一片段最后一个可见动作结果起拍，不要让人物退回准备态或把动作重新演一遍。",
      "剧情扩写必须先以当前片段已拆解分镜为主骨架；若拆解分镜之间缺少能在对应剧本位置明确找到的关键动作、反应、情绪递进、视线变化或衔接结果，再从对应剧本位置补全到最合适的分镜里，不得改写剧本事件、人物关系、动机、情绪走向或结果。",
      "同时对照上一片段结尾停点、本片段分镜骨架、下一片段开场目标和对应剧本补全参考；若这些衔接处存在剧本里明确写出的缺失内容，优先补进相邻分镜而不是挪到片段外。",
      "若剧本里的明确拍点正好卡在片段边界，可并入最邻近的上一片段结尾或下一片段开场，但在当前片段与相邻片段组成的上下文窗口里不能缺失。",
      "明确让本片段开场画面目标成为上一动作的直接结果，让本片段结尾画面目标成为下一段可直接接拍的起点。",
      "片段内各分镜按“上一分镜结果 -> 当前动作 -> 焦点变化 -> 留给下一分镜的停点”接力推进，不要做互相孤立的拼贴分镜。",
      "优先保证动作链、视线方向、运动方向、镜头轴线、主光方向、环境动势和情绪推进连续，避免动作重置、方向跳变和情绪断层。",
      "不要为了炫技新增非剧情要求的跨地点、跨时间、跨服装、跨光位、跳轴或机位重置。",
      "主体分镜写完后，单独补一个“结尾钩子”区块，停在下一片段可以直接接上的动作、视线、姿态势能或情绪停点。",
      "严格按本段镜头顺序推进剧情，不提前下一片段关键事件，不回补上一片段完整剧情。",
      "台词必须按原文去重，同一句台词若已在更早分镜出现，后续分镜不要重复输出。",
    ].join(" "),
  };
}

export async function prepareSegmentVideoPromptAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  if (!project.scenes.length) {
    throw new Error("当前还没有镜头拆解结果，无法生成片段提示词。");
  }

  const syncedProject = synchronizeVideoProductionState(project);
  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const maxDuration = getVideoModelMaxDuration(videoGenerationPrefs.modelKey);
  const effectiveDuration = Math.min(VIDEO_SEGMENT_DESIGN_DURATION, maxDuration);

  const batchMode = typeof input.batchMode === "string" ? input.batchMode : "all";
  const targetEpisode = typeof input.targetEpisode === "string" ? input.targetEpisode.trim() : null;
  const targetSegmentLabel = typeof input.targetSegmentLabel === "string" ? input.targetSegmentLabel.trim() : null;

  const episodeSegmentRe = /^(\d+)-(\d+)$/;

  // 按 segmentLabel 分组
  const segmentMap = new Map<string, Scene[]>();
  const segmentOrder: string[] = [];
  for (const scene of [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber)) {
    const key = scene.segmentLabel?.trim();
    if (!key || !episodeSegmentRe.test(key)) continue;
    if (!segmentMap.has(key)) {
      segmentMap.set(key, []);
      segmentOrder.push(key);
    }
    segmentMap.get(key)!.push(scene);
  }

  const existingSegmentVideoPrompts = syncedProject.segmentVideoPrompts ?? {};
  const missingSegmentKeys = segmentOrder.filter(
    (segmentLabel) => !hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel),
  );
  const allSegmentPromptsReady = segmentOrder.length > 0 && missingSegmentKeys.length === 0;
  const isBatchRefresh = batchMode === "batch-refresh";
  const persistedRefreshCursor = typeof syncedProject.segmentPromptRefreshCursor === "string"
    ? syncedProject.segmentPromptRefreshCursor.trim()
    : "";
  const refreshCursor =
    persistedRefreshCursor && segmentOrder.includes(persistedRefreshCursor)
      ? persistedRefreshCursor
      : null;
  const refreshStartIndex =
    isBatchRefresh && allSegmentPromptsReady
      ? Math.max(refreshCursor ? segmentOrder.indexOf(refreshCursor) : 0, 0)
      : 0;

  // 过滤目标片段
  let targetKeys: string[];
  if (batchMode === "single" && targetSegmentLabel) {
    targetKeys = segmentOrder.filter((k) => k === targetSegmentLabel);
  } else if (batchMode === "episode" && targetEpisode) {
    targetKeys = segmentOrder.filter((k) => episodeSegmentRe.exec(k)?.[1] === targetEpisode);
  } else if (batchMode === "remaining") {
    targetKeys = missingSegmentKeys;
  } else if (batchMode === "batch-refresh") {
    targetKeys = allSegmentPromptsReady
      ? segmentOrder.slice(refreshStartIndex, refreshStartIndex + 1)
      : missingSegmentKeys.slice(0, 1);
  } else if (batchMode === "batch") {
    targetKeys = missingSegmentKeys.slice(0, 1);
  } else {
    targetKeys = segmentOrder;
  }

  const targetKeySet = new Set(targetKeys);
  const formatSegmentProgress = createSegmentPromptProgressFormatter(
    segmentOrder,
    isBatchRefresh && allSegmentPromptsReady
      ? new Set(segmentOrder.slice(0, refreshStartIndex))
      : new Set(
          segmentOrder.filter(
            (segmentLabel) =>
              hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel) &&
              !targetKeySet.has(segmentLabel),
          ),
        ),
  );

  if (!targetKeys.length) {
    if (batchMode === "remaining" || batchMode === "batch" || batchMode === "batch-refresh") {
      const coveredScenes = segmentOrder
        .filter((segmentLabel) => hasReadySegmentVideoPrompt(existingSegmentVideoPrompts, segmentLabel))
        .flatMap((segmentLabel) => segmentMap.get(segmentLabel) ?? []);
      return saveVideoProject(
        {
          ...syncedProject,
          segmentPromptRefreshCursor: null,
          currentStep: 4,
        },
        [
          batchMode === "remaining"
            ? "补齐剩余片段已完成：当前没有缺失的片段提示词。"
            : batchMode === "batch-refresh"
              ? "重新分批生成片段已完成：当前没有可继续刷新的片段提示词。"
              : "分批生成片段已完成：当前没有缺失的片段提示词。",
          `已覆盖 ${segmentOrder.length - missingSegmentKeys.length} / ${segmentOrder.length} 个片段。`,
          buildPromptBatchSummaryOutline(syncedProject, coveredScenes),
          buildVideoAssetStatusReport(syncedProject, coveredScenes, videoGenerationPrefs.mode),
        ].filter(Boolean).join("\n\n"),
      );
    }
    throw new Error("当前没有可处理的片段，请先完成镜头拆解并确认 segmentLabel 格式正确。");
  }

  onProgress?.({ summary: formatSegmentProgress({ status: "init" }) });

  const nextSegmentVideoPrompts: Record<string, SegmentVideoPrompt> = {
    ...existingSegmentVideoPrompts,
  };

  const processedLabels: string[] = [];
  const processedScenes: Scene[] = [];
  const nextScenes = [...syncedProject.scenes];
  const allScenesSorted = [...syncedProject.scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);

  for (const segmentLabel of targetKeys) {
    throwIfInputAborted(input);
    onProgress?.({ summary: formatSegmentProgress({ segmentLabel, status: "processing" }) });
    try {
      const segmentScenes = segmentMap.get(segmentLabel)!;
      const orderedScenes = [...segmentScenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
      const enrichedOrderedScenes = orderedScenes.map(
        (scene) => nextScenes.find((item) => item.id === scene.id) ?? scene,
      );
      const shotPacketBySceneId = new Map(
        collectSegmentShotPackets(
          syncedProject,
          enrichedOrderedScenes.map((scene) => scene.id),
        ).map((packet) => [packet.sceneId, packet] as const),
      );

      const shotDescriptions = enrichedOrderedScenes.map((scene, idx) => {
        const sceneIdx = allScenesSorted.findIndex((item) => item.id === scene.id);
        const prevScene = sceneIdx > 0 ? allScenesSorted[sceneIdx - 1] : undefined;
        const nextScene = sceneIdx < allScenesSorted.length - 1 ? allScenesSorted[sceneIdx + 1] : undefined;
        const shotPacket = shotPacketBySceneId.get(scene.id);
        return {
          index: idx + 1,
          prompt: buildSegmentShotCorePrompt(scene),
          rawDescription: buildSegmentShotRawPrompt(scene),
          promptSource: getSegmentShotPromptSource(scene),
          prevDescription: prevScene?.description?.trim() || "",
          nextDescription: nextScene?.description?.trim() || "",
          duration: scene.recommendedDuration ?? scene.duration ?? 5,
          sceneName: scene.sceneName,
          cameraDirection: scene.cameraDirection?.trim() || "",
          dialogue: scene.dialogue?.trim() || "",
          startState: shotPacket?.startState || "",
          endState: shotPacket?.endState || "",
          previousAnchor: shotPacket?.previousAnchor || "",
          nextAnchor: shotPacket?.nextAnchor || "",
        };
      });

      const characterDescriptions = (() => {
        const allCharacterNames = new Set(enrichedOrderedScenes.flatMap((s) => s.characters));
        return (syncedProject.characters ?? [])
          .filter((c) => allCharacterNames.has(c.name))
          .map((c) => {
            // 优先使用片段内第一个出现该角色的镜头的场景级服装，回退到角色全局激活服装
            const firstScene = enrichedOrderedScenes.find((s) => s.characters.includes(c.name));
            const sceneCostumeId = firstScene?.characterCostumes?.[c.name];
            const activeCostume = sceneCostumeId
              ? c.costumes?.find((cos) => cos.id === sceneCostumeId)
              : c.costumes?.find((cos) => cos.id === c.activeCostumeId);
            return {
              name: c.name,
              description: activeCostume
                ? `${c.description} [服装：${activeCostume.description}]`
                : c.description,
              imageUrl: activeCostume?.imageUrl?.trim() || c.imageUrl,
            };
          });
      })();

      const sceneSettingDescriptions = enrichedOrderedScenes
        .map((s) => {
          const setting = findSceneSetting(s, syncedProject.sceneSettings || []);
          return setting ? { name: setting.name, description: setting.description, imageUrl: setting.imageUrl } : null;
        })
        .filter((s): s is NonNullable<typeof s> => !!s)
        .filter((s, idx, arr) => arr.findIndex((x) => x.name === s.name) === idx);
      const continuityContext = buildSegmentPromptContinuityContext({
        project: syncedProject,
        segmentLabel,
        segmentOrder,
        segmentMap,
        segmentPrompts: nextSegmentVideoPrompts,
        script: syncedProject.script || "",
      });
      const previousSegmentContinuityFrameUrl = await resolveVerifiedSegmentContinuityFrameUrl(
        syncedProject,
        continuityContext.previousSegmentLabel,
      );
      const previousSegmentContinuityFrameSetUrls = await resolveVerifiedSegmentContinuityFrameSetUrls(
        syncedProject,
        continuityContext.previousSegmentLabel,
      );
      const previousSegmentContinuityGridImage = await resolveVerifiedSegmentContinuityGridImage(
        syncedProject,
        continuityContext.previousSegmentLabel,
      );
      const strictTextToVideoContinuity = shouldKeepStrictSegmentTextToVideoContinuity(
        videoGenerationPrefs.mode,
      );
      const shouldSuppressDirectContinuityFrameReference =
        strictTextToVideoContinuity &&
        hasUsableMediaUrl(previousSegmentContinuityGridImage?.imageUrl);
      const effectiveContinuityFrameUrl = shouldSuppressDirectContinuityFrameReference
        ? undefined
        : previousSegmentContinuityFrameUrl;
      const promptTransportProviderHint =
        typeof input.provider === "string" && input.provider.trim()
          ? input.provider.trim()
          : resolveVideoGenerationTransportProviderHint(videoGenerationPrefs, syncedProject);
      const segmentPromptVideoMode = resolveSegmentContinuationVideoMode({
        requestedMode: videoGenerationPrefs.mode,
        provider: promptTransportProviderHint,
        modelKey: videoGenerationPrefs.modelKey,
        continuityFrameUrl: effectiveContinuityFrameUrl,
        strictTextToVideoContinuity,
      });
      const segmentReferenceBundle = collectSegmentContinuityReferenceBundle({
        modelKey: videoGenerationPrefs.modelKey,
        mode: segmentPromptVideoMode,
        currentScenes: enrichedOrderedScenes,
        previousScenes: continuityContext.previousSegmentLabel
          ? segmentMap.get(continuityContext.previousSegmentLabel)
          : undefined,
        previousSegmentContinuityFrameUrl: effectiveContinuityFrameUrl,
        previousSegmentContinuityGridImage,
        previousSegmentContinuityFrameSetUrls,
        sceneSettings: syncedProject.sceneSettings || [],
        characters: syncedProject.characters || [],
      });
      const submissionReferenceBundle = selectSegmentSubmissionReferenceBundle({
        provider: promptTransportProviderHint,
        continuityFrameUrl: effectiveContinuityFrameUrl,
        mode: segmentPromptVideoMode,
        currentHeadSceneNumber: enrichedOrderedScenes[0]?.sceneNumber ?? null,
        currentTailSceneNumber: enrichedOrderedScenes.at(-1)?.sceneNumber ?? null,
        currentSceneNumbers: enrichedOrderedScenes
          .map((scene) => scene.sceneNumber)
          .filter((value) => Number.isFinite(value)),
        baseBundle: segmentReferenceBundle,
      });
      const promptShouldPreferFirstFrameReference = shouldPreferSegmentOpeningFrameReference({
        strictTextToVideoContinuity,
        provider: promptTransportProviderHint,
        modelKey: videoGenerationPrefs.modelKey,
        continuityFrameUrl: effectiveContinuityFrameUrl,
        continuityKeyframeUrls: previousSegmentContinuityFrameSetUrls,
      });
      const segmentReferencePayload = resolveVideoGenerationReferencePayload({
        mode: segmentPromptVideoMode,
        provider: promptTransportProviderHint,
        modelKey: videoGenerationPrefs.modelKey,
        primaryReferenceImageUrl: submissionReferenceBundle.primaryReferenceImageUrl,
        referenceImageUrls: submissionReferenceBundle.referenceImageUrls,
        preferFirstFrameReference: promptShouldPreferFirstFrameReference,
        strictTextToVideoContinuity,
      });
      const segmentReferenceImageUrls = collectSubmittedReferenceImageUrls(segmentReferencePayload);
      const segmentSubmittedReferenceDebugInfo = filterSubmittedReferenceDebugInfo(
        submissionReferenceBundle.referenceDebugInfo,
        segmentReferenceImageUrls,
      );
      const segmentReferenceUsageText = buildSegmentReferenceUsageSummary(
        segmentSubmittedReferenceDebugInfo,
        enrichedOrderedScenes
          .map((scene) => scene.sceneNumber)
          .filter((value): value is number => Number.isFinite(value)),
        {
          strictTextToVideoContinuity:
            strictTextToVideoContinuity && segmentReferenceImageUrls.length > 0,
        },
      );
      const segmentHasContinuityGridReference = segmentSubmittedReferenceDebugInfo.some(
        (item) => item.kind === "segment-continuity-grid",
      );
      const segmentReferenceImageUrl =
        String(segmentReferencePayload.imageUrl || "").trim() || segmentReferenceImageUrls[0] || "";
      const hasPreviousSegmentContext = Boolean(continuityContext.previousSegmentLabel);

      let finalPrompt = "";
      let finalDuration = effectiveDuration;
      let shotCoverageComplete = false;
      let finalDirectionIssues: SegmentBeatDirectionIssue[] = [];
      let lastPromptGenerationError: unknown = null;
      for (let promptAttempt = 1; promptAttempt <= 3; promptAttempt += 1) {
        const retryFeedback =
          promptAttempt > 1
            ? buildSegmentBeatDirectionRetryFeedback(finalDirectionIssues, shotDescriptions)
            : "";
        const { data, error } = await invokeFunction<{ prompt?: string; duration?: number }>(
          "enhance-video-prompt",
          {
            mode: "segment",
            videoMode: segmentPromptVideoMode,
            segmentLabel,
            shots: shotDescriptions,
            style: resolveProjectImagePromptStyle(syncedProject),
            targetDuration: effectiveDuration,
            maxDuration,
            designDuration: VIDEO_SEGMENT_DESIGN_DURATION,
            characterDescriptions,
            visualStyle: syncedProject.styleLock?.visualStyle || "",
            tone: syncedProject.styleLock?.tone || "",
            characterImages: characterDescriptions
              .filter((c) => c.imageUrl)
              .map((c) => ({ name: c.name, imageUrl: c.imageUrl! })),
            referenceImageUrl: segmentReferenceImageUrl,
            continuityReferenceImageUrl:
              segmentReferenceImageUrls.includes(String(previousSegmentContinuityGridImage?.imageUrl || "").trim())
                ? previousSegmentContinuityGridImage?.imageUrl
                : segmentReferenceImageUrls.includes(String(previousSegmentContinuityFrameUrl || "").trim())
                  ? previousSegmentContinuityFrameUrl
                  : undefined,
            continuityReferenceUsageText: segmentReferenceUsageText || undefined,
            hasContinuityGridReference: segmentHasContinuityGridReference,
            hasRefImage: segmentReferenceImageUrls.length > 0,
            sceneImages: segmentReferenceImageUrls.map((url) => ({ imageUrl: url })),
            sceneDescriptions: sceneSettingDescriptions,
            previousSegmentSummary: hasPreviousSegmentContext
              ? continuityContext.previousSegmentSummary
              : undefined,
            nextSegmentSummary: continuityContext.nextSegmentSummary,
            previousSegmentPrompt: hasPreviousSegmentContext
              ? continuityContext.previousSegmentPrompt
              : undefined,
            previousSegmentEndState: hasPreviousSegmentContext
              ? continuityContext.previousSegmentEndState
              : undefined,
            currentSegmentStartState: continuityContext.currentSegmentStartState,
            currentSegmentEndState: continuityContext.currentSegmentEndState,
            nextSegmentStartState: continuityContext.nextSegmentStartState,
            currentSegmentStoryGoal: continuityContext.currentSegmentStoryGoal,
            currentSegmentScriptSource: continuityContext.currentSegmentScriptSource,
            currentSegmentScriptSkeleton: continuityContext.currentSegmentScriptSkeleton,
            currentSegmentShotRelayPlan: continuityContext.currentSegmentShotRelayPlan,
            continuityRules: hasPreviousSegmentContext ? continuityContext.continuityRules : undefined,
            textModel:
              typeof input.textModel === "string" && input.textModel.trim()
                ? input.textModel.trim()
                : undefined,
            ...(retryFeedback ? { retryFeedback } : {}),
          },
          { abortSignal: resolveInputAbortSignal(input) },
        );
        throwIfInputAborted(input);
        if (error) {
          lastPromptGenerationError = new Error(`segment prompt generation failed for ${segmentLabel}: ${String(error)}`);
          if (promptAttempt >= 3) throw lastPromptGenerationError;
          continue;
        }

        try {
          finalPrompt = formatDetailedSegmentPrompt(
            stripExactDialogueLockBlock(String(data?.prompt || "")).trim(),
            {
              shotDialogueGroups: enrichedOrderedScenes.map((scene) => scene.dialogue || ""),
              shotCameraDirections: enrichedOrderedScenes.map((scene) => scene.cameraDirection || ""),
              referenceUsageText: segmentReferenceUsageText || undefined,
              hasContinuityGridReference: segmentHasContinuityGridReference,
            },
          );
          if (!finalPrompt) {
            throw new Error(`segment prompt generation returned an empty prompt for ${segmentLabel}`);
          }

          finalDuration = Math.min(data?.duration ?? effectiveDuration, maxDuration);
          shotCoverageComplete = hasCompleteSegmentPromptShotCoverage(finalPrompt, enrichedOrderedScenes);
          if (!shotCoverageComplete) {
            throw new Error(`segment prompt generation omitted required storyboard beats for ${segmentLabel}`);
          }

          finalDirectionIssues = collectSegmentBeatDirectionIssues(finalPrompt);
          if (finalDirectionIssues.length) {
            throw new Error(
              `segment prompt missing camera/motion coverage for ${segmentLabel}: ${finalDirectionIssues
                .map((issue) => {
                  const labels = [
                    issue.missingCameraLanguage ? "镜头语言" : "",
                    issue.missingMotionLanguage ? "运镜衔接" : "",
                  ].filter(Boolean);
                  return `分镜${issue.beatIndex}缺少${labels.join("和")}`;
                })
                .join("；")}`,
            );
          }

          lastPromptGenerationError = null;
          break;
        } catch (generationError) {
          lastPromptGenerationError = generationError;
          if (promptAttempt >= 3) throw generationError;
        }
      }
      if (lastPromptGenerationError) {
        throw lastPromptGenerationError;
      }

      nextSegmentVideoPrompts[segmentLabel] = {
        segmentLabel,
        prompt: finalPrompt,
        duration: finalDuration,
        targetDuration: VIDEO_SEGMENT_DESIGN_DURATION,
        modelKey: videoGenerationPrefs.modelKey,
        maxDurationForModel: maxDuration,
        sceneIds: enrichedOrderedScenes.map((s) => s.id),
        generatedAt: new Date().toISOString(),
        debug: {
          source: "model",
          promptLength: finalPrompt.length,
          shotCount: enrichedOrderedScenes.length,
          shotCoverageComplete,
          referenceImageCount: segmentReferenceImageUrls.length,
          videoMode: segmentPromptVideoMode,
          provider: promptTransportProviderHint,
        },
      };

      processedLabels.push(segmentLabel);
      processedScenes.push(...enrichedOrderedScenes);
      onProgress?.({ summary: formatSegmentProgress({ segmentLabel, status: "done" }) });
    } catch (error) {
      onProgress?.({
        summary: formatSegmentProgress({
          segmentLabel,
          status:
            isAbortLikeWorkflowError(error) || resolveInputAbortSignal(input)?.aborted
              ? "cancelled"
              : "failed",
        }),
      });
      throw error;
    }
  }

  const remainingAfter = segmentOrder.filter(
    (segmentLabel) => !hasReadySegmentVideoPrompt(nextSegmentVideoPrompts, segmentLabel),
  );
  const nextRefreshCursor =
    isBatchRefresh && allSegmentPromptsReady && processedLabels.length > 0
      ? segmentOrder[refreshStartIndex + processedLabels.length] ?? null
      : null;
  const refreshProgressCount =
    isBatchRefresh && allSegmentPromptsReady
      ? Math.min(refreshStartIndex + processedLabels.length, segmentOrder.length)
      : 0;
  const isRefreshCycle = isBatchRefresh && allSegmentPromptsReady;
  const behavesLikeBatch = batchMode === "batch" || (isBatchRefresh && !allSegmentPromptsReady);
  const primarySummary =
    batchMode === "remaining"
      ? `已按顺序补齐 ${processedLabels.length} 个剩余片段的合并视频提示词。`
      : isRefreshCycle
        ? `已重新分批生成 ${processedLabels.length} 个片段的合并视频提示词。`
        : behavesLikeBatch
        ? `已分批生成 ${processedLabels.length} 个片段的合并视频提示词。`
        : `已生成 ${processedLabels.length} 个片段的合并视频提示词。`;
  const summary = [
    primarySummary,
    `片段列表：${processedLabels.join("、")}`,
    isRefreshCycle && nextRefreshCursor
      ? `下次点击“重新分批生成片段”会继续处理片段 ${nextRefreshCursor}。`
      : "",
    isRefreshCycle && !nextRefreshCursor
      ? `本轮重新分批已完成，下次点击“重新分批生成片段”会从片段 ${segmentOrder[0]} 重新开始。`
      : "",
    behavesLikeBatch && remainingAfter.length > 0
      ? `下次点击“分批生成片段”会继续处理片段 ${remainingAfter[0]}。`
      : "",
    isRefreshCycle
      ? `本轮重刷进度：${refreshProgressCount} / ${segmentOrder.length}。`
      : "",
    batchMode === "remaining" || behavesLikeBatch
      ? `片段覆盖进度：${segmentOrder.length - remainingAfter.length} / ${segmentOrder.length}。`
      : "",
    `当前模型最大时长：${maxDuration}s（设计规格 ${VIDEO_SEGMENT_DESIGN_DURATION}s）`,
    maxDuration < VIDEO_SEGMENT_DESIGN_DURATION
      ? `注意：当前模型（${videoGenerationPrefs.modelKey}）最大支持 ${maxDuration}s，提示词已按 ${maxDuration}s 适配。`
      : "",
    buildSegmentPromptStabilitySummary({
      segmentLabels: processedLabels,
      prompts: nextSegmentVideoPrompts,
    }),
    buildPromptBatchSummaryOutline(syncedProject, processedScenes),
    buildVideoAssetStatusReport(syncedProject, processedScenes, videoGenerationPrefs.mode),
    buildSegmentPromptLogDisplay({
      project: syncedProject,
      segmentLabels: processedLabels,
      prompts: nextSegmentVideoPrompts,
    }),
  ].filter(Boolean).join("\n");

  return saveVideoProject(
    {
      ...syncedProject,
      scenes: nextScenes,
      segmentVideoPrompts: nextSegmentVideoPrompts,
      segmentPromptRefreshCursor: isRefreshCycle ? nextRefreshCursor : null,
      currentStep: 4,
    },
    summary,
  );
}

// ---- 片段视频生成 ----

function buildSegmentVideoStatus(
  segmentLabel: string,
  status: string,
  options?: {
    taskId?: string;
    provider?: string;
    failure?: SegmentVideoStatus["failure"];
    submittedPrompt?: string;
    referenceImageUrls?: string[];
    usedContinuityFrame?: boolean;
    usedRelayVideo?: boolean;
  },
): SegmentVideoStatus {
  return {
    segmentLabel,
    status: normalizeSceneStatus(status) || status || "processing",
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    ...(options?.provider ? { provider: options.provider } : {}),
    ...(options?.failure ? { failure: options.failure } : {}),
    ...(options?.submittedPrompt ? { submittedPrompt: options.submittedPrompt } : {}),
    ...(options?.referenceImageUrls?.length
      ? { referenceImageUrls: options.referenceImageUrls }
      : {}),
    ...(typeof options?.usedContinuityFrame === "boolean"
      ? { usedContinuityFrame: options.usedContinuityFrame }
      : {}),
    ...(typeof options?.usedRelayVideo === "boolean"
      ? { usedRelayVideo: options.usedRelayVideo }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}

function withSegmentVideoStatus(
  project: PersistedVideoProject,
  segmentLabel: string,
  status: SegmentVideoStatus,
): PersistedVideoProject {
  return {
    ...project,
    segmentVideoStatuses: {
      ...(project.segmentVideoStatuses ?? {}),
      [segmentLabel]: status,
    },
  };
}

function withSegmentContinuityFrame(
  project: PersistedVideoProject,
  segmentLabel: string,
  imageUrl: string | undefined,
): PersistedVideoProject {
  const normalizedUrl = String(imageUrl || "").trim();
  if (!normalizedUrl) return project;
  return {
    ...project,
    segmentContinuityFrames: {
      ...(project.segmentContinuityFrames ?? {}),
      [segmentLabel]: normalizedUrl,
    },
  };
}

function withSegmentContinuityFrameSet(
  project: PersistedVideoProject,
  segmentLabel: string,
  imageUrls: string[] | undefined,
): PersistedVideoProject {
  const normalizedUrls = Array.from(
    new Set((Array.isArray(imageUrls) ? imageUrls : []).map((url) => String(url || "").trim()).filter(Boolean)),
  );
  if (!normalizedUrls.length) return project;
  return {
    ...project,
    segmentContinuityFrameSets: {
      ...(project.segmentContinuityFrameSets ?? {}),
      [segmentLabel]: normalizedUrls,
    },
  };
}

function withSegmentContinuityGridImage(
  project: PersistedVideoProject,
  segmentLabel: string,
  value:
    | {
        imageUrl: string;
        recapText?: string;
        frameUrls?: string[];
      }
    | undefined,
): PersistedVideoProject {
  const normalizedUrl = String(value?.imageUrl || "").trim();
  if (!normalizedUrl) return project;
  const existingGridImage = project.segmentContinuityGridImages?.[segmentLabel];
  const timestamp = new Date().toISOString();
  const recapText = String(value?.recapText || "").trim();
  const frameUrls = Array.from(
    new Set(
      (Array.isArray(value?.frameUrls) ? value?.frameUrls : [])
        .map((url) => String(url || "").trim())
        .filter(Boolean),
    ),
  );
  return {
    ...project,
    segmentContinuityGridImages: {
      ...(project.segmentContinuityGridImages ?? {}),
      [segmentLabel]: {
        imageUrl: normalizedUrl,
        ...(recapText ? { recapText } : {}),
        ...(frameUrls.length ? { frameUrls } : {}),
        createdAt: existingGridImage?.createdAt || timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function applySegmentContinuityArtifacts(
  project: PersistedVideoProject,
  segmentLabel: string,
  continuityFrameUrl: string | undefined,
  continuityFrameSetUrls: string[] | undefined,
  continuityGridImage?:
    | {
        imageUrl: string;
        recapText?: string;
        frameUrls?: string[];
      }
    | undefined,
): PersistedVideoProject {
  const normalizedFrameUrl = String(continuityFrameUrl || "").trim();
  const normalizedFrameSetUrls = Array.from(
    new Set(
      (Array.isArray(continuityFrameSetUrls) ? continuityFrameSetUrls : [])
        .map((url) => String(url || "").trim())
        .filter(Boolean),
    ),
  );
  const normalizedGridImageUrl = String(continuityGridImage?.imageUrl || "").trim();
  const normalizedGridFrameUrls = Array.from(
    new Set(
      (Array.isArray(continuityGridImage?.frameUrls) ? continuityGridImage?.frameUrls : [])
        .map((url) => String(url || "").trim())
        .filter(Boolean),
    ),
  );
  const normalizedGridRecapText = String(continuityGridImage?.recapText || "").trim();

  const nextContinuityFrames = { ...(project.segmentContinuityFrames ?? {}) };
  if (normalizedFrameUrl) {
    nextContinuityFrames[segmentLabel] = normalizedFrameUrl;
  } else {
    delete nextContinuityFrames[segmentLabel];
  }

  const nextContinuityFrameSets = { ...(project.segmentContinuityFrameSets ?? {}) };
  if (normalizedFrameSetUrls.length) {
    nextContinuityFrameSets[segmentLabel] = normalizedFrameSetUrls;
  } else {
    delete nextContinuityFrameSets[segmentLabel];
  }

  const nextContinuityGridImages = { ...(project.segmentContinuityGridImages ?? {}) };
  if (normalizedGridImageUrl) {
    const existingGridImage = project.segmentContinuityGridImages?.[segmentLabel];
    const timestamp = new Date().toISOString();
    nextContinuityGridImages[segmentLabel] = {
      imageUrl: normalizedGridImageUrl,
      ...(normalizedGridRecapText ? { recapText: normalizedGridRecapText } : {}),
      ...(normalizedGridFrameUrls.length ? { frameUrls: normalizedGridFrameUrls } : {}),
      createdAt: existingGridImage?.createdAt || timestamp,
      updatedAt: timestamp,
    };
  } else {
    delete nextContinuityGridImages[segmentLabel];
  }

  return {
    ...project,
    segmentContinuityFrames: Object.keys(nextContinuityFrames).length
      ? nextContinuityFrames
      : undefined,
    segmentContinuityFrameSets: Object.keys(nextContinuityFrameSets).length
      ? nextContinuityFrameSets
      : undefined,
    segmentContinuityGridImages: Object.keys(nextContinuityGridImages).length
      ? nextContinuityGridImages
      : undefined,
  };
}

async function cacheSegmentVideoUrl(
  projectId: string,
  segmentLabel: string,
  remoteVideoUrl: string,
): Promise<string> {
  const rawFileName =
    remoteVideoUrl.split(/[\\/]/).pop()?.split("?")[0] ||
    `segment-${segmentLabel}.mp4`;
  const segmentFileStem = buildSegmentVideoFileStem(segmentLabel);
  const fileName = segmentFileStem ? `${segmentFileStem}.mp4` : decodeVideoFileName(rawFileName);
  const cachedVideo = await cacheProjectVideoSource(remoteVideoUrl, fileName, projectId);
  return cachedVideo?.localPath ?? remoteVideoUrl;
}

type SegmentContinuityFrameCandidate = {
  url: string;
  percent: number;
  score: number;
  signature?: Float32Array;
};

type SegmentContinuityFrameCandidateRequest = {
  slotIndex: number;
  anchorPercent: number;
  percent: number;
};

type SegmentContinuityFrameCandidateAnalysis = {
  score: number;
  signature?: Float32Array;
};

function clampSegmentContinuityFramePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function buildSegmentContinuityFrameCandidateRequests(): SegmentContinuityFrameCandidateRequest[] {
  return SEGMENT_CONTINUITY_REFERENCE_FRAME_PERCENTS.flatMap((anchorPercent, slotIndex) =>
    Array.from(
      new Set(
        SEGMENT_CONTINUITY_REFERENCE_FRAME_NEIGHBOR_OFFSETS.map((offset) =>
          clampSegmentContinuityFramePercent(anchorPercent + offset),
        ),
      ),
    ).map((percent) => ({
      slotIndex,
      anchorPercent,
      percent,
    })),
  );
}

function isContinuityFrameCanvasAnalysisAvailable(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      typeof Image !== "undefined" &&
      window.electronAPI?.storage?.readBase64,
  );
}

async function loadContinuityFrameAnalysisDataUrl(url: string): Promise<string | null> {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return trimmed;
  if (isLocalMediaFilePath(trimmed)) {
    return (await resolveLocalMediaPreviewDataUrl(trimmed)) || null;
  }
  return trimmed;
}

function buildSegmentContinuityFrameSignature(
  grayscale: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const signature = new Float32Array(
    SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE * SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE,
  );
  for (let y = 0; y < SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE; y += 1) {
    const sourceY = Math.min(
      height - 1,
      Math.max(
        0,
        Math.round(((y + 0.5) / SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE) * height - 0.5),
      ),
    );
    for (let x = 0; x < SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE; x += 1) {
      const sourceX = Math.min(
        width - 1,
        Math.max(
          0,
          Math.round(((x + 0.5) / SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE) * width - 0.5),
        ),
      );
      signature[y * SEGMENT_CONTINUITY_REFERENCE_SIGNATURE_SIDE + x] =
        grayscale[sourceY * width + sourceX] / 255;
    }
  }
  return signature;
}

function getSegmentContinuityFrameBand(percent: number): 0 | 1 | 2 {
  if (percent <= 68) return 0;
  if (percent <= 86) return 1;
  return 2;
}

function measureSegmentContinuityFrameVisualDistance(
  left: SegmentContinuityFrameCandidate,
  right: SegmentContinuityFrameCandidate,
): number | null {
  if (!left.signature || !right.signature || left.signature.length !== right.signature.length) {
    return null;
  }

  let totalDistance = 0;
  for (let index = 0; index < left.signature.length; index += 1) {
    totalDistance += Math.abs(left.signature[index] - right.signature[index]);
  }

  return totalDistance / left.signature.length;
}

function isDistinctSegmentContinuityFrameCandidate(
  candidate: SegmentContinuityFrameCandidate,
  selected: SegmentContinuityFrameCandidate[],
): boolean {
  return selected.every((existing) => {
    if (Math.abs(existing.percent - candidate.percent) < SEGMENT_CONTINUITY_REFERENCE_MIN_PERCENT_GAP) {
      return false;
    }
    const visualDistance = measureSegmentContinuityFrameVisualDistance(existing, candidate);
    return visualDistance === null || visualDistance >= SEGMENT_CONTINUITY_REFERENCE_MIN_VISUAL_DISTANCE;
  });
}

async function analyzeSegmentContinuityFrameCandidate(
  url: string,
  percent: number,
): Promise<SegmentContinuityFrameCandidateAnalysis | null> {
  if (!isContinuityFrameCanvasAnalysisAvailable()) return null;

  const src = await loadContinuityFrameAnalysisDataUrl(url);
  if (!src) return null;

  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const nextImage = new Image();
    nextImage.crossOrigin = "anonymous";
    nextImage.onload = () => resolve(nextImage);
    nextImage.onerror = () => resolve(null);
    nextImage.src = src;
  });
  if (!image?.naturalWidth || !image?.naturalHeight) return null;

  const maxSide = 160;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(12, Math.round(image.naturalWidth * scale));
  const height = Math.max(12, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const grayscale = new Float32Array(width * height);
    let luminanceTotal = 0;
    let luminanceSquaredTotal = 0;
    let brightPixels = 0;

    for (let index = 0, pixelIndex = 0; index < data.length; index += 4, pixelIndex += 1) {
      const luminance = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
      grayscale[pixelIndex] = luminance;
      luminanceTotal += luminance;
      luminanceSquaredTotal += luminance * luminance;
      if (luminance > 32) brightPixels += 1;
    }

    const pixelCount = grayscale.length || 1;
    const averageLuminance = luminanceTotal / pixelCount;
    const brightRatio = brightPixels / pixelCount;
    const contrastDeviation = Math.sqrt(
      Math.max(0, luminanceSquaredTotal / pixelCount - averageLuminance * averageLuminance),
    );

    let edgeEnergyTotal = 0;
    let edgeSamples = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const center = grayscale[y * width + x];
        const left = grayscale[y * width + x - 1];
        const right = grayscale[y * width + x + 1];
        const up = grayscale[(y - 1) * width + x];
        const down = grayscale[(y + 1) * width + x];
        edgeEnergyTotal += Math.abs(center - left) + Math.abs(center - right) + Math.abs(center - up) + Math.abs(center - down);
        edgeSamples += 1;
      }
    }

    const averageEdgeEnergy = edgeSamples > 0 ? edgeEnergyTotal / edgeSamples : 0;
    const edgeScore = Math.max(0, Math.min(1, averageEdgeEnergy / 48));
    const contrastScore = Math.max(0, Math.min(1, contrastDeviation / 72));
    const exposureScore = Math.max(0, 1 - Math.abs(averageLuminance - 108) / 108);
    const brightPixelScore = Math.max(0, Math.min(1, brightRatio / 0.085));
    const laterFrameScore = Math.max(0, Math.min(1, percent / 100));
    const darkPenalty = averageLuminance < 16 && brightRatio < 0.012 ? 0.28 : 0;
    const overExposurePenalty = averageLuminance > 238 ? 0.18 : 0;

    return {
      score:
        edgeScore * 0.38 +
        contrastScore * 0.12 +
        exposureScore * 0.18 +
        brightPixelScore * 0.07 +
        laterFrameScore * 0.25 -
        darkPenalty -
        overExposurePenalty,
      signature: buildSegmentContinuityFrameSignature(grayscale, width, height),
    };
  } catch {
    return null;
  }
}

function buildSegmentContinuityFrameFallbackScore(
  percent: number,
  anchorPercent: number,
  analysisScore?: number,
): number {
  const maxOffset =
    Math.max(...SEGMENT_CONTINUITY_REFERENCE_FRAME_NEIGHBOR_OFFSETS.map((offset) => Math.abs(offset))) || 1;
  const closenessScore = Math.max(0, 1 - Math.abs(percent - anchorPercent) / maxOffset);
  const laterFrameScore = Math.max(0, Math.min(1, percent / 100));
  if (typeof analysisScore === "number") {
    return analysisScore * 0.82 + closenessScore * 0.12 + laterFrameScore * 0.06;
  }
  return closenessScore * 0.74 + laterFrameScore * 0.26;
}

function rankSegmentContinuityFrameSlotCandidates(
  candidates: SegmentContinuityFrameCandidate[],
  anchorPercent: number,
): SegmentContinuityFrameCandidate[] {
  return [...candidates].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftDistance = Math.abs(left.percent - anchorPercent);
    const rightDistance = Math.abs(right.percent - anchorPercent);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return right.percent - left.percent;
  });
}

function selectPreferredSegmentContinuityFrameSlotCandidate(
  candidates: SegmentContinuityFrameCandidate[],
  anchorPercent: number,
  slotIndex: number,
  slotCount: number,
  selected: SegmentContinuityFrameCandidate[],
): SegmentContinuityFrameCandidate | undefined {
  const ranked = rankSegmentContinuityFrameSlotCandidates(candidates, anchorPercent);
  if (!ranked.length) return undefined;

  const isBoundarySlot = slotIndex === 0 || slotIndex === Math.max(0, slotCount - 1);
  if (isBoundarySlot) {
    const exactAnchorCandidate = ranked.find(
      (candidate) =>
        candidate.percent === anchorPercent &&
        !selected.some((existing) => existing.url === candidate.url),
    );
    if (exactAnchorCandidate) return exactAnchorCandidate;
  }

  return (
    ranked.find((candidate) => isDistinctSegmentContinuityFrameCandidate(candidate, selected)) ||
    ranked.find((candidate) => !selected.some((existing) => existing.url === candidate.url)) ||
    ranked[0]
  );
}

function pickSegmentContinuityFrameCandidates(
  candidates: SegmentContinuityFrameCandidate[],
): SegmentContinuityFrameCandidate[] {
  if (!candidates.length) return [];

  const orderedByPercent = [...candidates].sort((left, right) => left.percent - right.percent);
  const tailAnchor = orderedByPercent.at(-1);
  const rankedPool = [...orderedByPercent]
    .filter((candidate) => candidate.url !== tailAnchor?.url)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return right.percent - left.percent;
    });
  const nonTailCandidates = orderedByPercent.filter((candidate) => candidate.url !== tailAnchor?.url);
  const bandSeedCandidates = [0, 1, 2]
    .map((band) =>
      nonTailCandidates
        .filter((candidate) => getSegmentContinuityFrameBand(candidate.percent) === band)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.percent - left.percent;
        })[0],
    )
    .filter((candidate): candidate is SegmentContinuityFrameCandidate => Boolean(candidate));

  const selected: SegmentContinuityFrameCandidate[] = [];
  const selectionLimitWithoutTail = Math.max(
    0,
    SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT - (tailAnchor ? 1 : 0),
  );
  const trySelectCandidate = (candidate: SegmentContinuityFrameCandidate) => {
    if (selected.some((existing) => existing.url === candidate.url)) return;
    if (!isDistinctSegmentContinuityFrameCandidate(candidate, selected)) return;
    selected.push(candidate);
  };

  for (const candidate of bandSeedCandidates) {
    trySelectCandidate(candidate);
    if (selected.length >= selectionLimitWithoutTail) break;
  }

  for (const candidate of rankedPool) {
    trySelectCandidate(candidate);
    if (selected.length >= selectionLimitWithoutTail) break;
  }

  if (tailAnchor) {
    selected.push(tailAnchor);
  }

  return selected
    .sort((left, right) => left.percent - right.percent)
    .slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT);
}

async function extractSegmentContinuityReferenceImages(
  videoUrl: string | undefined,
): Promise<SegmentContinuityFrameCandidate[]> {
  const extractFrames = window.electronAPI?.media?.extractVideoFrames;
  const storedVideoPath = resolveStoredSegmentVideoPath(String(videoUrl || "").trim());
  if (!extractFrames || !storedVideoPath || !isLocalMediaFilePath(storedVideoPath)) {
    return [];
  }

  const candidateRequests = buildSegmentContinuityFrameCandidateRequests();
  const result = await extractFrames({
    filePath: storedVideoPath,
    framePercents: candidateRequests.map((request) => request.percent),
  });
  if (!result?.ok || !result.framePaths?.length) return [];

  if (result.framePaths.length <= SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT) {
    const legacyCandidates = await Promise.all(
      result.framePaths.map(async (framePath, index) => {
        const trimmed = String(framePath || "").trim();
        if (!trimmed) return null;
        const verifiedUrl = (await resolveVerifiedGeneratedReferenceImageUrl(trimmed)) || "";
        if (!verifiedUrl) return null;
        const anchorPercent = Number(SEGMENT_CONTINUITY_REFERENCE_FRAME_PERCENTS[index] ?? 100);
        const analysis = await analyzeSegmentContinuityFrameCandidate(verifiedUrl, anchorPercent);
        return {
          url: verifiedUrl,
          percent: anchorPercent,
          score: buildSegmentContinuityFrameFallbackScore(
            anchorPercent,
            anchorPercent,
            analysis?.score,
          ),
          signature: analysis?.signature,
        } satisfies SegmentContinuityFrameCandidate;
      }),
    );

    return legacyCandidates
      .filter((candidate): candidate is SegmentContinuityFrameCandidate => Boolean(candidate))
      .sort((left, right) => left.percent - right.percent)
      .slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT);
  }

  const rawCandidates = await Promise.all(
    result.framePaths.map(async (framePath, index) => {
      const trimmed = String(framePath || "").trim();
      if (!trimmed) return null;
      const verifiedUrl = (await resolveVerifiedGeneratedReferenceImageUrl(trimmed)) || "";
      if (!verifiedUrl) return null;
      const request = candidateRequests[index];
      if (!request) return null;
      const analysis = await analyzeSegmentContinuityFrameCandidate(verifiedUrl, request.percent);
      return {
        url: verifiedUrl,
        percent: request.percent,
        score: buildSegmentContinuityFrameFallbackScore(
          request.percent,
          request.anchorPercent,
          analysis?.score,
        ),
        signature: analysis?.signature,
        slotIndex: request.slotIndex,
      };
    }),
  );

  const candidates = rawCandidates.filter(
    (
      candidate,
    ): candidate is SegmentContinuityFrameCandidate & { slotIndex: number } => Boolean(candidate),
  );
  if (!candidates.length) return [];

  const candidatesBySlot = new Map<number, Array<SegmentContinuityFrameCandidate & { slotIndex: number }>>();
  candidates.forEach((candidate) => {
    const bucket = candidatesBySlot.get(candidate.slotIndex) ?? [];
    bucket.push(candidate);
    candidatesBySlot.set(candidate.slotIndex, bucket);
  });

  const selected: SegmentContinuityFrameCandidate[] = [];
  const totalSlots = SEGMENT_CONTINUITY_REFERENCE_FRAME_PERCENTS.length;
  SEGMENT_CONTINUITY_REFERENCE_FRAME_PERCENTS.forEach((anchorPercent, slotIndex) => {
    const slotCandidates = candidatesBySlot.get(slotIndex) ?? [];
    if (!slotCandidates.length) return;
    const preferred = selectPreferredSegmentContinuityFrameSlotCandidate(
      slotCandidates,
      anchorPercent,
      slotIndex,
      totalSlots,
      selected,
    );
    if (!preferred || selected.some((candidate) => candidate.url === preferred.url)) return;
    selected.push(preferred);
  });

  if (selected.length < SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT) {
    const fallbackCandidates = pickSegmentContinuityFrameCandidates(candidates);
    for (const candidate of fallbackCandidates) {
      if (selected.some((existing) => existing.url === candidate.url)) continue;
      selected.push(candidate);
      if (selected.length >= SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT) break;
    }
  }

  return selected
    .sort((left, right) => left.percent - right.percent)
    .slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT);
}

function buildSegmentContinuityRecapText(
  project: PersistedVideoProject,
  segmentLabel: string,
): string {
  const scenes = project.scenes
    .filter((scene) => String(scene.segmentLabel || "").trim() === segmentLabel)
    .sort((left, right) => left.sceneNumber - right.sceneNumber);
  if (!scenes.length) {
    return `这一段剧情在片段 ${segmentLabel} 的关键节点上被承接下来，人物关系与局势变化会在这里继续推进，最终把故事带向下一段新的冲突。`;
  }

  const cleanNarrativeSentence = (text: string, maxChars: number) =>
    compressSegmentContinuityCue(text, maxChars, { stripLeadingTags: true })
      .replace(/[“”"'`]/g, "")
      .replace(/^(前情提要|本段剧情|这一段剧情)[：:\s]*/g, "")
      .replace(/^片段\s*\S+\s*/g, "")
      .replace(/^聚焦\s*/g, "")
      .replace(/^(最后一帧|最后镜头|最后画面|画面|镜头)\s*(定格在|停在|落在|推进到|对准|聚焦于)\s*/g, "")
      .replace(/^(结尾钩子|通用后缀|环境细节|视觉锚点|起始衔接|衔接原则)[：:\s]*/g, "")
      .replace(/[。！？；，、]+$/g, "")
      .trim();

  const ensureSentence = (text: string) => {
    const normalized = String(text || "").trim().replace(/[。！？；，、]+$/g, "");
    return normalized ? `${normalized}。` : "";
  };

  const opening = cleanNarrativeSentence(
    scenes[0]?.description?.trim() || scenes[0]?.sceneName?.trim() || "",
    72,
  );
  const middleDescriptions = scenes
    .slice(1, -1)
    .map((scene) => cleanNarrativeSentence(String(scene.description || scene.sceneName || ""), 84))
    .filter(Boolean);
  const fallbackDevelopment =
    scenes.length > 1
      ? cleanNarrativeSentence(
          String(scenes[Math.min(1, scenes.length - 1)]?.description || scenes[Math.min(1, scenes.length - 1)]?.sceneName || ""),
          92,
        )
      : "";
  const developmentCore =
    middleDescriptions.join("，") || (fallbackDevelopment && fallbackDevelopment !== opening ? fallbackDevelopment : "");
  const development = developmentCore
    ? `随着${developmentCore.replace(/^随着/g, "").replace(/[。！？；，、]+$/g, "")}。`
    : "随着局势继续收紧，人物动作、情绪压力与危险气息被一步步推高。";

  const promptEndHook = cleanNarrativeSentence(
    extractSegmentEndHookText(project.segmentVideoPrompts?.[segmentLabel]?.prompt),
    88,
  );
  const lastScene = cleanNarrativeSentence(
    scenes.at(-1)?.description?.trim() || scenes.at(-1)?.sceneName?.trim() || "",
    80,
  );
  const storyGoal = scenes.length > 1 ? cleanNarrativeSentence(buildSegmentStoryGoalText(scenes), 88) : "";
  const endingSource = [promptEndHook, lastScene, storyGoal].find(
    (value) => value && value !== opening && value !== developmentCore,
  );
  const ending = endingSource
    ? `最终，${String(endingSource).replace(/^最终[，,\s]*/g, "").replace(/[。！？；，、]+$/g, "")}。`
    : "最终，这一段剧情把人物状态推到下一次爆发或转折发生前的停点。";

  return fitVideoSubmissionTextToNaturalBoundary(
    [ensureSentence(opening) || `这一段剧情从片段 ${segmentLabel} 的关键节点继续推进。`, development, ending]
      .filter(Boolean)
      .join(""),
    168,
  );
}

async function loadSegmentContinuityGridPreviewSource(url: string): Promise<string | null> {
  const trimmed = String(url || "").trim();
  if (!trimmed) return null;
  return (await resolveLocalMediaPreviewDataUrl(trimmed)) || null;
}

function drawSegmentContinuityGridContainImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceWidth = (image as { width?: number; naturalWidth?: number }).naturalWidth ?? (image as { width?: number }).width ?? width;
  const sourceHeight = (image as { height?: number; naturalHeight?: number }).naturalHeight ?? (image as { height?: number }).height ?? height;
  const scale = Math.min(width / Math.max(1, sourceWidth), height / Math.max(1, sourceHeight));
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

export function getSegmentContinuityGridSourceAspectRatio(
  sourceWidth: number,
  sourceHeight: number,
): number {
  const normalizedWidth = Number.isFinite(sourceWidth) ? Math.max(1, sourceWidth) : 1;
  const normalizedHeight = Number.isFinite(sourceHeight) ? Math.max(1, sourceHeight) : 1;
  const aspectRatio = normalizedWidth / normalizedHeight;
  return Math.min(
    SEGMENT_CONTINUITY_GRID_MAX_ASPECT_RATIO,
    Math.max(SEGMENT_CONTINUITY_GRID_MIN_ASPECT_RATIO, aspectRatio),
  );
}

export function getSegmentContinuityGridCanvasHeightForAspectRatio(
  aspectRatio: number,
): number {
  const normalizedAspectRatio = Math.min(
    SEGMENT_CONTINUITY_GRID_MAX_ASPECT_RATIO,
    Math.max(SEGMENT_CONTINUITY_GRID_MIN_ASPECT_RATIO, Number.isFinite(aspectRatio) ? aspectRatio : 16 / 9),
  );
  const cellWidth =
    (SEGMENT_CONTINUITY_GRID_CANVAS_WIDTH -
      SEGMENT_CONTINUITY_GRID_GAP * (SEGMENT_CONTINUITY_GRID_CELL_COLUMNS + 1)) /
    SEGMENT_CONTINUITY_GRID_CELL_COLUMNS;
  const cellHeight = cellWidth / normalizedAspectRatio;
  const gridHeight =
    cellHeight * SEGMENT_CONTINUITY_GRID_CELL_ROWS +
    SEGMENT_CONTINUITY_GRID_GAP * (SEGMENT_CONTINUITY_GRID_CELL_ROWS - 1);
  return Math.ceil(
    gridHeight + SEGMENT_CONTINUITY_GRID_TEXT_PANEL_HEIGHT + SEGMENT_CONTINUITY_GRID_GAP * 2,
  );
}

function wrapSegmentContinuityGridText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  const sentenceChunks = normalized
    .split(/(?<=[。！？；])/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const chunkQueue = sentenceChunks.length ? [...sentenceChunks] : [normalized];
  let currentLine = "";

  const pushLine = (line: string) => {
    if (!line) return;
    lines.push(line);
  };

  while (chunkQueue.length && lines.length < maxLines) {
    const chunk = chunkQueue.shift()!;
    const nextLine = currentLine ? `${currentLine}${chunk}` : chunk;
    if (ctx.measureText(nextLine).width <= maxWidth) {
      currentLine = nextLine;
      continue;
    }

    if (currentLine) {
      pushLine(currentLine);
      currentLine = "";
      chunkQueue.unshift(chunk);
      continue;
    }

    const characters = Array.from(chunk);
    let brokenLine = "";
    for (const character of characters) {
      const candidate = brokenLine + character;
      if (ctx.measureText(candidate).width <= maxWidth || !brokenLine) {
        brokenLine = candidate;
        continue;
      }
      pushLine(brokenLine);
      brokenLine = character;
      if (lines.length >= maxLines) break;
    }

    if (lines.length >= maxLines) break;
    currentLine = brokenLine;
  }

  if (lines.length < maxLines && currentLine) {
    pushLine(currentLine);
  }

  if (chunkQueue.length || (lines.length > maxLines)) {
    const lastLine = lines[Math.min(lines.length, maxLines) - 1] || "";
    lines[Math.min(lines.length, maxLines) - 1] = `${lastLine.replace(/[.。！？；…]+$/g, "")}…`;
  }

  return lines.slice(0, maxLines);
}

async function loadSegmentContinuityGridImageSource(
  src: string,
): Promise<HTMLImageElement | null> {
  return await new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function renderSegmentContinuityGridDataUrl(params: {
  segmentLabel: string;
  recapText: string;
  frameUrls: string[];
}): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const previewSources = (
    await Promise.all(params.frameUrls.map((url) => loadSegmentContinuityGridPreviewSource(url)))
  ).filter((value): value is string => Boolean(value));
  if (!previewSources.length) return null;

  const paddedSources = [...previewSources];
  while (paddedSources.length < SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT) {
    paddedSources.push(paddedSources[paddedSources.length - 1]);
  }

  const images = await Promise.all(
    paddedSources
      .slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT)
      .map((src) => loadSegmentContinuityGridImageSource(src)),
  );
  const validImages = images.filter((image): image is HTMLImageElement => Boolean(image));
  if (!validImages.length) return null;

  const primaryImage = validImages[0];
  const sourceAspectRatio = getSegmentContinuityGridSourceAspectRatio(
    primaryImage?.naturalWidth ?? primaryImage?.width ?? 16,
    primaryImage?.naturalHeight ?? primaryImage?.height ?? 9,
  );

  const canvas = document.createElement("canvas");
  canvas.width = SEGMENT_CONTINUITY_GRID_CANVAS_WIDTH;
  canvas.height = getSegmentContinuityGridCanvasHeightForAspectRatio(sourceAspectRatio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#05070b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cellWidth =
    (canvas.width - SEGMENT_CONTINUITY_GRID_GAP * (SEGMENT_CONTINUITY_GRID_CELL_COLUMNS + 1)) /
    SEGMENT_CONTINUITY_GRID_CELL_COLUMNS;
  const cellHeight = cellWidth / sourceAspectRatio;

  validImages.slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT).forEach((image, index) => {
    const column = index % SEGMENT_CONTINUITY_GRID_CELL_COLUMNS;
    const row = Math.floor(index / SEGMENT_CONTINUITY_GRID_CELL_COLUMNS);
    const x = SEGMENT_CONTINUITY_GRID_GAP + column * (cellWidth + SEGMENT_CONTINUITY_GRID_GAP);
    const y = SEGMENT_CONTINUITY_GRID_GAP + row * (cellHeight + SEGMENT_CONTINUITY_GRID_GAP);
    ctx.save();
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(x, y, cellWidth, cellHeight);
    drawSegmentContinuityGridContainImage(ctx, image, x, y, cellWidth, cellHeight);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
    ctx.fillStyle = "rgba(8,10,18,0.72)";
    ctx.fillRect(x + 14, y + 14, 86, 40);
    ctx.fillStyle = "#f5f7ff";
    ctx.font = '600 22px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.fillText(getSegmentContinuityGridFrameLabel(index, validImages.length), x + 24, y + 40);
    ctx.restore();
  });

  const panelY = canvas.height - SEGMENT_CONTINUITY_GRID_TEXT_PANEL_HEIGHT;
  ctx.fillStyle = "rgba(5, 7, 11, 0.92)";
  ctx.fillRect(0, panelY, canvas.width, SEGMENT_CONTINUITY_GRID_TEXT_PANEL_HEIGHT);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, panelY);
  ctx.lineTo(canvas.width, panelY);
  ctx.stroke();

  ctx.fillStyle = "#9fb6ff";
  ctx.font = '700 28px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillText(`片段 ${params.segmentLabel} 前情六宫格`, 44, panelY + 46);

  ctx.fillStyle = "#f8fbff";
  ctx.font = '600 30px "Microsoft YaHei", "PingFang SC", sans-serif';
  const recapLines = wrapSegmentContinuityGridText(
    ctx,
    formatSegmentContinuityRecapDisplayText(params.recapText),
    canvas.width - 88,
    4,
  );
  recapLines.forEach((line, index) => {
    ctx.fillText(line, 44, panelY + 94 + index * 44);
  });

  return canvas.toDataURL("image/jpeg", 0.9);
}

function stripBase64DataUrlPrefix(dataUrl: string): string {
  const normalized = String(dataUrl || "").trim();
  const match = normalized.match(/^data:[^;]+;base64,(.+)$/);
  return match?.[1] || normalized;
}

async function resolveSegmentContinuityGridOutputPath(
  projectId: string,
  segmentLabel: string,
): Promise<string | null> {
  const projectRoot = await getProjectRootPath(projectId);
  if (!projectRoot) return null;
  const fileStem = buildSegmentVideoFileStem(segmentLabel) || `segment-${segmentLabel}`;
  return `${projectRoot.replace(/[\\/]+$/, "")}\\media\\images\\segment-continuity\\${fileStem}_continuity_grid.jpg`;
}

async function buildSegmentContinuityGridAsset(params: {
  projectId: string;
  segmentLabel: string;
  recapText: string;
  frameUrls: string[];
}): Promise<
  | {
      imageUrl: string;
      recapText: string;
      frameUrls: string[];
    }
  | undefined
> {
  const normalizedFrameUrls = Array.from(
    new Set(params.frameUrls.map((url) => String(url || "").trim()).filter(Boolean)),
  ).slice(0, SEGMENT_CONTINUITY_REFERENCE_CANDIDATE_MAX_COUNT);
  if (!normalizedFrameUrls.length) return undefined;

  const dataUrl = await renderSegmentContinuityGridDataUrl({
    segmentLabel: params.segmentLabel,
    recapText: params.recapText,
    frameUrls: normalizedFrameUrls,
  });
  if (!dataUrl) return undefined;

  const writeBase64File = window.electronAPI?.storage?.writeBase64File;
  const outputPath = await resolveSegmentContinuityGridOutputPath(params.projectId, params.segmentLabel);
  if (writeBase64File && outputPath) {
    const result = await writeBase64File({
      filePath: outputPath,
      base64: stripBase64DataUrlPrefix(dataUrl),
    });
    if (result?.ok && result.filePath?.trim()) {
      return {
        imageUrl: result.filePath.trim(),
        recapText: params.recapText,
        frameUrls: normalizedFrameUrls,
      };
    }
  }

  return {
    imageUrl: dataUrl,
    recapText: params.recapText,
    frameUrls: normalizedFrameUrls,
  };
}

async function collectSegmentContinuityArtifacts(params: {
  projectId: string;
  segmentLabel: string;
  videoUrl?: string;
  providerLastFrameUrl?: string;
  recapText?: string;
  progressPreset?: "default" | "history-backfill";
}): Promise<{
  continuityFrameUrl?: string;
  continuityFrameSetUrls: string[];
  continuityGridImage?: {
    imageUrl: string;
    recapText: string;
    frameUrls: string[];
  };
}> {
  const progressPreset = params.progressPreset ?? "default";
  const shouldBroadcastExtractionProgress = isLocalSegmentVideoLibrarySource(params.videoUrl);
  const emitExtractionProgress = (
    status: "extracting" | "completed" | "failed",
    progress: number,
    message: string,
    frameCount?: number,
  ) => {
    if (typeof window === "undefined" || !shouldBroadcastExtractionProgress) return;
    window.dispatchEvent(
      new CustomEvent("agent:segment-continuity-extraction", {
        detail: {
          projectId: params.projectId,
          segmentLabel: params.segmentLabel,
          status,
          progress,
          message,
          ...(typeof frameCount === "number" ? { frameCount } : {}),
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  };

  const progressMessages =
    progressPreset === "history-backfill"
      ? {
          start: "正在补历史片段六宫格…",
          extracting: (count: number) =>
            count
              ? `已抽取 ${count} 张候选帧，正在生成六宫格…`
              : "未抽到候选帧，正在核对连续性素材…",
          completed: (count: number) => `历史片段补全完成，已保留 ${count} 张参考帧并更新六宫格。`,
          failed: "历史片段缺少连续性素材，无法生成六宫格。",
        }
      : {
          start: "正在从当前片段视频抽取连续性关键帧…",
          extracting: (count: number) =>
            count
              ? `已抽取 ${count} 张候选帧，正在筛选连续性关键帧…`
              : "未抽到候选帧，正在核对可用连续性参考…",
          completed: (count: number) => `关键帧抽取完成，已保留 ${count} 张连续性参考帧。`,
          failed: "当前片段视频未抽到可用关键帧。",
        };

  emitExtractionProgress("extracting", 18, progressMessages.start);
  const extractedFrameCandidates = await extractSegmentContinuityReferenceImages(params.videoUrl);
  emitExtractionProgress(
    "extracting",
    68,
    progressMessages.extracting(extractedFrameCandidates.length),
    extractedFrameCandidates.length,
  );
  let continuityFrameUrl =
    (await resolveVerifiedGeneratedReferenceImageUrl(params.providerLastFrameUrl?.trim())) || undefined;
  let continuityFrameSetUrls = extractedFrameCandidates.map((candidate) => candidate.url);
  const gridFrameUrls = extractedFrameCandidates.map((candidate) => candidate.url);

  if (!continuityFrameUrl && extractedFrameCandidates.length) {
    const tailCandidate = extractedFrameCandidates.at(-1);
    continuityFrameUrl = tailCandidate?.url;
  }

  const continuityGridImage =
    gridFrameUrls.length && String(params.recapText || "").trim()
      ? await buildSegmentContinuityGridAsset({
          projectId: params.projectId,
          segmentLabel: params.segmentLabel,
          recapText: String(params.recapText || "").trim(),
          frameUrls: gridFrameUrls,
        })
      : undefined;

  const totalFrameCount = Array.from(
    new Set([...(continuityFrameSetUrls ?? []), continuityFrameUrl].filter(Boolean)),
  ).length;
  if (totalFrameCount > 0) {
    emitExtractionProgress(
      "completed",
      100,
      progressMessages.completed(totalFrameCount),
      totalFrameCount,
    );
  } else {
    emitExtractionProgress("failed", 100, progressMessages.failed, 0);
  }

  return {
    ...(continuityFrameUrl ? { continuityFrameUrl } : {}),
    continuityFrameSetUrls: continuityFrameSetUrls.slice(0, SEGMENT_CONTINUITY_FRAME_SET_MAX_COUNT),
    ...(continuityGridImage ? { continuityGridImage } : {}),
  };
}

export async function refreshSegmentContinuityArtifactsFromSegmentVideoSource(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  videoUrl?: string;
  providerLastFrameUrl?: string;
  progressPreset?: "default" | "history-backfill";
}): Promise<PersistedVideoProject> {
  const segmentLabel = String(params.segmentLabel || "").trim();
  if (!segmentLabel) return params.project;

  const baseProject = synchronizeVideoProductionState(params.project);
  const sourceVideoUrl = resolveSegmentVideoLibrarySourceUrl(
    baseProject,
    segmentLabel,
    params.videoUrl,
  );
  const continuityArtifacts = await collectSegmentContinuityArtifacts({
    projectId: baseProject.id,
    segmentLabel,
    videoUrl: sourceVideoUrl,
    providerLastFrameUrl: params.providerLastFrameUrl,
    recapText: buildCanonicalSegmentContinuityRecapText(baseProject, segmentLabel),
    progressPreset: params.progressPreset,
  });

  const projectWithSegmentVideo = params.videoUrl
    ? {
        ...baseProject,
        segmentVideos: {
          ...(baseProject.segmentVideos ?? {}),
          [segmentLabel]: params.videoUrl,
        },
      }
    : baseProject;

  return applySegmentContinuityArtifacts(
    projectWithSegmentVideo,
    segmentLabel,
    continuityArtifacts.continuityFrameUrl,
    continuityArtifacts.continuityFrameSetUrls,
    continuityArtifacts.continuityGridImage,
  );
}

export async function promoteArchivedSegmentVideoCandidateToOfficialAsset(params: {
  project: PersistedVideoProject;
  segmentLabel: string;
  historyEntryId: string;
}): Promise<PersistedVideoProject> {
  const segmentLabel = String(params.segmentLabel || "").trim();
  const historyEntryId = String(params.historyEntryId || "").trim();
  if (!segmentLabel || !historyEntryId) {
    throw new Error("缺少历史候选视频标识，无法传递到正式片段栏。");
  }

  const entries = params.project.archivedSegmentVideos?.[segmentLabel] ?? [];
  const targetEntry = entries.find((entry) => entry.id === historyEntryId);
  const videoUrl = String(targetEntry?.videoUrl || "").trim();
  if (!videoUrl) {
    throw new Error(`未找到片段 ${segmentLabel} 对应的历史候选视频。`);
  }

  const timestamp = new Date().toISOString();
  const currentStatus = params.project.segmentVideoStatuses?.[segmentLabel];
  const latestRepairTask = getLatestSegmentRepairTask(params.project, segmentLabel);
  let nextProject: PersistedVideoProject = {
    ...params.project,
    archivedSegmentVideos: {
      ...(params.project.archivedSegmentVideos ?? {}),
      [segmentLabel]: entries.map((entry) =>
        entry.id === historyEntryId
          ? {
              ...entry,
              promotedAt: entry.promotedAt || timestamp,
            }
          : entry,
      ),
    },
    segmentVideoStatuses: {
      ...(params.project.segmentVideoStatuses ?? {}),
      [segmentLabel]: buildSegmentVideoStatus(segmentLabel, "completed", {
        taskId: targetEntry?.taskId || currentStatus?.taskId,
        provider: targetEntry?.provider || currentStatus?.provider,
        submittedPrompt: targetEntry?.submittedPrompt || currentStatus?.submittedPrompt,
        referenceImageUrls: targetEntry?.referenceImageUrls || currentStatus?.referenceImageUrls,
        usedContinuityFrame:
          typeof targetEntry?.usedContinuityFrame === "boolean"
            ? targetEntry.usedContinuityFrame
            : currentStatus?.usedContinuityFrame,
        usedRelayVideo:
          typeof targetEntry?.usedRelayVideo === "boolean"
            ? targetEntry.usedRelayVideo
            : currentStatus?.usedRelayVideo,
      }),
    },
  };
  if (latestRepairTask && latestRepairTask.status !== "completed") {
    nextProject = upsertVideoRepairTask(nextProject, {
      ...latestRepairTask,
      status: "completed",
      updatedAt: timestamp,
    });
  }
  nextProject = withVideoAutomationSegmentState(nextProject, segmentLabel, (state) => ({
    ...state,
    exhausted: false,
    latestRepairTaskId: latestRepairTask?.id || state.latestRepairTaskId,
  }));
  nextProject = dismissSegmentReviewQueueItems(
    nextProject,
    [segmentLabel],
    "approved",
    "已从历史候选视频中接纳当前片段，并同步为正式成片。",
  );

  return refreshSegmentContinuityArtifactsFromSegmentVideoSource({
    project: nextProject,
    segmentLabel,
    videoUrl,
    progressPreset: "history-backfill",
  });
}

function dispatchSceneVideoGeneratedFailed(params: {
  sceneId: string;
  sceneName: string;
  reason: string;
  index?: number;
  projectId?: string;
  mediaEventId?: string;
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("agent:video-generated-one-failed", {
      detail: {
        index: typeof params.index === "number" ? params.index : 0,
        label: params.sceneName,
        sceneId: params.sceneId,
        ...(params.projectId ? { projectId: params.projectId } : {}),
        reason: params.reason,
        ...(params.mediaEventId ? { mediaEventId: params.mediaEventId } : {}),
      },
    }),
  );
}

function dispatchSegmentVideoGenerated(params: {
  videoUrl: string;
  segmentLabel: string;
  projectId: string;
  model: string;
  resolution: string;
  provider?: string;
  mode: string;
  index?: number;
  mediaEventId?: string;
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("agent:video-generated-one", {
      detail: {
        url: params.videoUrl,
        index: typeof params.index === "number" ? params.index : 0,
        label: buildSegmentVideoLabel(params.segmentLabel),
        segmentLabel: params.segmentLabel,
        projectId: params.projectId,
        contentSummary: buildSegmentVideoLabel(params.segmentLabel),
        model: params.model,
        resolution: params.resolution,
        provider: params.provider,
        mode: params.mode,
        ...(params.mediaEventId ? { mediaEventId: params.mediaEventId } : {}),
      },
    }),
  );
}

function dispatchSegmentVideoGeneratedFailed(params: {
  segmentLabel: string;
  reason: string;
  index?: number;
  projectId: string;
  videoUrl?: string;
  mediaEventId?: string;
  failure?: SegmentVideoStatus["failure"];
}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("agent:video-generated-one-failed", {
      detail: {
        index: typeof params.index === "number" ? params.index : 0,
        label: buildSegmentVideoLabel(params.segmentLabel),
        segmentLabel: params.segmentLabel,
        projectId: params.projectId,
        reason: params.reason,
        ...(params.videoUrl ? { url: params.videoUrl } : {}),
        ...(params.failure ? { failure: params.failure } : {}),
        ...(params.failure?.historyEntryId ? { historyEntryId: params.failure.historyEntryId } : {}),
        ...(params.failure?.historySegmentLabel ? { historySegmentLabel: params.failure.historySegmentLabel } : {}),
        ...(params.failure?.previewVideoUrl ? { previewVideoUrl: params.failure.previewVideoUrl } : {}),
        ...(params.mediaEventId ? { mediaEventId: params.mediaEventId } : {}),
      },
    }),
  );
}

type SegmentVideoGenerationRunResult = {
  project: PersistedVideoProject;
  videoUrl?: string;
  continuityImageUrl?: string;
  continuityImageLabel?: string;
  summary: string;
  status: "completed" | "failed" | "submitted";
};

async function generateSingleSegmentVideoRun(
  project: PersistedVideoProject,
  input: Record<string, unknown>,
  segmentLabel: string,
  eventIndex = 0,
  options?: {
    persistCompletion?: boolean;
    onProgress?: (params: {
      segmentLabel: string;
      status: PromptBatchProgressStatus;
      videoUrl?: string;
      detail?: string;
    }) => void | Promise<void>;
  },
): Promise<SegmentVideoGenerationRunResult> {
  let syncedProject = synchronizeVideoProductionState({
    ...project,
    videoGenerationModeNotice: null,
  });
  const segmentPrompt = syncedProject.segmentVideoPrompts?.[segmentLabel];

  if (!segmentPrompt?.prompt?.trim()) {
    throw new Error(
      `片段 ${segmentLabel} 还没有生成片段提示词，请先在"视频提示词生成方式"中运行"片段提示词生成"。`,
    );
  }
  await options?.onProgress?.({ segmentLabel, status: "processing" });

  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const transportProviderHint =
    typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : resolveVideoGenerationTransportProviderHint(videoGenerationPrefs, syncedProject);
  const transport = await ensureVideoGenerationTransport({
    ...input,
    ...(transportProviderHint ? { provider: transportProviderHint } : {}),
    videoModelKey: videoGenerationPrefs.modelKey,
    resolution: videoGenerationPrefs.resolution,
    mode: videoGenerationPrefs.mode,
  });
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);
  const maxDuration = getVideoModelMaxDuration(videoGenerationPrefs.modelKey);
  const effectiveDuration = Math.min(segmentPrompt.duration, maxDuration);

  const orderedSegmentScenes = resolveSegmentScenesForSubmission(syncedProject, segmentLabel, segmentPrompt);
  const segmentScenes = orderedSegmentScenes;
  const currentHeadSceneNumber = orderedSegmentScenes[0]?.sceneNumber ?? null;
  const currentTailSceneNumber = orderedSegmentScenes.at(-1)?.sceneNumber ?? null;
  const currentSceneNumbers = orderedSegmentScenes
    .map((scene) => scene.sceneNumber)
    .filter((value) => Number.isFinite(value));
  const segmentOrderContext = buildSceneSegmentOrderContext(syncedProject.scenes);
  const segmentContinuityContext = buildSegmentPromptContinuityContext({
    project: syncedProject,
    segmentLabel,
    segmentOrder: segmentOrderContext.segmentOrder,
    segmentMap: segmentOrderContext.segmentMap,
    segmentPrompts: syncedProject.segmentVideoPrompts || {},
    script: syncedProject.script || "",
  });
  const resolvedTransportProvider = transport.provider || resolveVideoGenerationProvider(videoGenerationPrefs);
  const previousSegmentContinuityFrameUrl = await resolveVerifiedSegmentContinuityFrameUrl(
    syncedProject,
    segmentContinuityContext.previousSegmentLabel,
  );
  const previousSegmentContinuityFrameSetUrls = await resolveVerifiedSegmentContinuityFrameSetUrls(
    syncedProject,
    segmentContinuityContext.previousSegmentLabel,
  );
  const previousSegmentContinuityGridImage = await resolveVerifiedSegmentContinuityGridImage(
    syncedProject,
    segmentContinuityContext.previousSegmentLabel,
  );
  const strictTextToVideoContinuity = shouldKeepStrictSegmentTextToVideoContinuity(
    videoGenerationPrefs.mode,
  );
  const shouldSuppressDirectContinuityFrameReference =
    strictTextToVideoContinuity &&
    hasUsableMediaUrl(previousSegmentContinuityGridImage?.imageUrl);
  const effectiveContinuityFrameUrl = shouldSuppressDirectContinuityFrameReference
    ? undefined
    : previousSegmentContinuityFrameUrl;
  const submissionVideoMode = resolveSegmentContinuationVideoMode({
    requestedMode: videoGenerationPrefs.mode,
    provider: resolvedTransportProvider,
    modelKey: videoGenerationPrefs.modelKey,
    continuityFrameUrl: effectiveContinuityFrameUrl,
    strictTextToVideoContinuity,
  });
  const segmentReferenceBundle = collectSegmentContinuityReferenceBundle({
    modelKey: videoGenerationPrefs.modelKey,
    mode: submissionVideoMode,
    currentScenes: segmentScenes,
    previousScenes: segmentContinuityContext.previousSegmentLabel
      ? segmentOrderContext.segmentMap.get(segmentContinuityContext.previousSegmentLabel)
      : undefined,
    previousSegmentContinuityFrameUrl: effectiveContinuityFrameUrl,
    previousSegmentContinuityGridImage,
    previousSegmentContinuityFrameSetUrls,
    sceneSettings: syncedProject.sceneSettings || [],
    characters: syncedProject.characters || [],
  });
  const submissionReferenceBundle = selectSegmentSubmissionReferenceBundle({
    provider: resolvedTransportProvider,
    continuityFrameUrl: effectiveContinuityFrameUrl,
    mode: submissionVideoMode,
    currentHeadSceneNumber,
    currentTailSceneNumber,
    currentSceneNumbers,
    baseBundle: segmentReferenceBundle,
  });
  const segmentReferenceDebugInfo = submissionReferenceBundle.referenceDebugInfo;
  const segmentReferenceImageUrls = submissionReferenceBundle.referenceImageUrls;
  const segmentReferenceImageUrl = submissionReferenceBundle.primaryReferenceImageUrl;
  const segmentReferenceAudioUrls = collectSceneReferenceAudioUrls(
    orderedSegmentScenes.flatMap((scene) => findCharacterDetails(scene, syncedProject.characters || [])),
  );
  const shouldPreferFirstFrameReference = shouldPreferSegmentOpeningFrameReference({
    strictTextToVideoContinuity,
    provider: resolvedTransportProvider,
    modelKey: videoGenerationPrefs.modelKey,
    continuityFrameUrl: effectiveContinuityFrameUrl,
    continuityKeyframeUrls: previousSegmentContinuityFrameSetUrls,
  });
  const referencePayload = resolveVideoGenerationReferencePayload({
    mode: submissionVideoMode,
    provider: resolvedTransportProvider,
    modelKey: videoGenerationPrefs.modelKey,
    primaryReferenceImageUrl: segmentReferenceImageUrl,
    referenceImageUrls: segmentReferenceImageUrls,
    preferFirstFrameReference: shouldPreferFirstFrameReference,
    strictTextToVideoContinuity,
  });
  const submittedReferenceImageUrls = collectSubmittedReferenceImageUrls(referencePayload);
  const submittedReferenceDebugInfo = filterSubmittedReferenceDebugInfo(
    segmentReferenceDebugInfo,
    submittedReferenceImageUrls,
  );
  const attachedContinuityReference = submittedReferenceDebugInfo.some(
    (item) =>
      item.kind === "segment-continuity-frame" ||
      item.kind === "segment-continuity-grid" ||
      item.kind === "segment-continuity-keyframe",
  );
  const submittedHasContinuityGridReference = submittedReferenceDebugInfo.some(
    (item) => item.kind === "segment-continuity-grid",
  );
  const referenceUsageSummary = buildSegmentReferenceUsageSummary(
    submittedReferenceDebugInfo,
    currentSceneNumbers,
    {
      strictTextToVideoContinuity:
        strictTextToVideoContinuity && submittedReferenceImageUrls.length > 0,
    },
  );
  let data: VideoGenerationResult | undefined;
  let taskId = "";
  let taskProvider = resolvedTransportProvider;
  let videoUrl: string | undefined;
  let continuityFrameUrl: string | undefined;
  let continuityFrameSetUrls: string[] = [];
  let continuityGridImageUrl: string | undefined;
  let failedStatus: SegmentVideoStatus | null = null;
  let submittedPromptForAudit = "";
  let submittedReferenceImageUrlsForAudit: string[] = [];
  let usedContinuityFrameForAudit = false;
  let usedRelayVideoForAudit = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const nameReplacements = buildVideoSubmissionNameReplacements(
        segmentScenes,
        syncedProject.characters || [],
        [
          segmentPrompt.prompt,
          ...segmentScenes.map((scene) => scene.sceneName),
          ...segmentScenes.map((scene) => scene.description),
        ],
      );
      const promptForLog = applyVideoSubmissionNameReplacements(
        formatDetailedSegmentPrompt(stripExactDialogueLockBlock(segmentPrompt.prompt), {
          shotDialogueGroups: orderedSegmentScenes.map((scene) => scene.dialogue || ""),
          shotCameraDirections: orderedSegmentScenes.map((scene) => scene.cameraDirection || ""),
          referenceUsageText: referenceUsageSummary || undefined,
          hasContinuityGridReference: submittedHasContinuityGridReference,
        }),
        nameReplacements,
      );
      const submittedPrompt = promptForLog;
      submittedPromptForAudit = submittedPrompt;
      submittedReferenceImageUrlsForAudit = submittedReferenceImageUrls;
      usedContinuityFrameForAudit = attachedContinuityReference;
      usedRelayVideoForAudit = false;
      const runningHubImageReferenceCount = taskProvider.startsWith("runninghub")
        ? Array.from(
            new Set(
              [
                referencePayload.imageUrl,
                ...(Array.isArray(referencePayload.referenceImageUrls)
                  ? referencePayload.referenceImageUrls
                  : []),
              ]
                .map((value) => String(value || "").trim())
                .filter(Boolean),
            ),
          ).length
        : 0;
      const runningHubConversionSlots = taskProvider.startsWith("runninghub")
        ? Array.from(
            new Set(
              [
                ...Array.from(
                  { length: Math.min(runningHubImageReferenceCount, 9) },
                  (_, index) => `image${index + 1}`,
                ),
              ].filter(Boolean),
            ),
          )
        : undefined;
      const generationRequest = {
        prompt: submittedPrompt,
        logPrompt: submittedPrompt,
        duration: effectiveDuration,
        aspectRatio: videoGenerationPrefs.aspectRatio || "16:9",
        resolution: videoGenerationPrefs.resolution,
        model: resolvedModel,
        provider: taskProvider,
        videoMode: submissionVideoMode,
        referenceImageDebugInfo: segmentReferenceDebugInfo,
        ...(taskProvider.startsWith("runninghub")
          ? {
              ...(runningHubConversionSlots?.length
                ? { conversionSlots: runningHubConversionSlots }
                : {}),
              returnLastFrame: true,
            }
          : {}),
        ...(segmentReferenceAudioUrls.length ? { audioUrls: segmentReferenceAudioUrls } : {}),
        ...referencePayload,
      };
      const response = await invokeVideoGenerationWithReferenceFailureNotice(
        generationRequest,
        { abortSignal: resolveInputAbortSignal(input) },
        videoGenerationPrefs.mode,
        referencePayload,
      );
      if (response.notice) {
        syncedProject = {
          ...syncedProject,
          videoGenerationModeNotice: response.notice,
        };
      }
      if (response.error) throw response.error;
      data = response.data;
      taskId = String(data?.task_id || data?.taskId || data?.id || "").trim();
      taskProvider = data?.provider || taskProvider;
      if (!taskId) {
        failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
          provider: taskProvider,
          failure: {
            message: "视频任务已提交但未返回 task_id，无法继续轮询结果。",
            provider: taskProvider,
            stage: "submit",
            updatedAt: new Date().toISOString(),
          },
        });
        break;
      }
      failedStatus = null;
      break;
    } catch (error) {
      if (attempt < 3 && isRetryableVideoGenerationError(error)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1500 * attempt));
        continue;
      }
      failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
        provider: taskProvider,
        failure: {
          message: summarizeVideoGenerationError(error),
          provider: taskProvider,
          stage: "submit",
          updatedAt: new Date().toISOString(),
        },
      });
      break;
    }
  }

  if (taskId) {
    syncedProject = withSegmentVideoStatus(
      syncedProject,
      segmentLabel,
      buildSegmentVideoStatus(segmentLabel, normalizeSceneStatus(data?.status) || "queued", {
        taskId,
        provider: taskProvider,
        submittedPrompt: submittedPromptForAudit,
        referenceImageUrls: submittedReferenceImageUrlsForAudit,
        usedContinuityFrame: usedContinuityFrameForAudit,
        usedRelayVideo: usedRelayVideoForAudit,
      }),
    );
    await options?.onProgress?.({
      segmentLabel,
      status: "processing",
      detail: buildVideoSubmitProgressDetail({
        provider: taskProvider,
        referencePayload,
        referenceDebugInfo: segmentReferenceDebugInfo,
      }),
    });
    const { maxPollRounds: MAX_POLL_ROUNDS, pollIntervalMs: POLL_INTERVAL_MS } =
      resolveVideoGenerationPollPlan(taskProvider);
    for (let round = 0; round < MAX_POLL_ROUNDS; round += 1) {
      throwIfInputAborted(input);
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      throwIfInputAborted(input);

      const { data: statusData, error: statusError } = await invokeFunction<VideoGenerationStatusResult>(
        "generate-video",
        { action: "status", taskId, provider: taskProvider },
        { abortSignal: resolveInputAbortSignal(input) },
      );

      if (statusError) {
        failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
          taskId,
          provider: taskProvider,
          failure: {
            message: summarizeVideoGenerationError(statusError),
            provider: taskProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        });
        break;
      }

      const normalizedStatus = normalizeSceneStatus(statusData?.status || statusData?.state) || "processing";
      if (normalizedStatus === "completed" && statusData?.video_url) {
        videoUrl = await cacheSegmentVideoUrl(syncedProject.id, segmentLabel, statusData.video_url);
        continuityFrameUrl =
          (await resolveVerifiedGeneratedReferenceImageUrl(statusData.last_frame_url)) || undefined;
        break;
      }

      if (normalizedStatus === "failed") {
        const failureMessage = buildVideoStatusFailureMessage(
          statusData,
          "片段视频生成失败，建议调整片段提示词后重新提交。",
        );
        failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
          taskId,
          provider: taskProvider,
          submittedPrompt: submittedPromptForAudit,
          referenceImageUrls: submittedReferenceImageUrlsForAudit,
          usedContinuityFrame: usedContinuityFrameForAudit,
          usedRelayVideo: usedRelayVideoForAudit,
          failure: {
            message: failureMessage,
            provider: taskProvider,
            stage: "status",
            updatedAt: new Date().toISOString(),
          },
        });
        break;
      }

      syncedProject = withSegmentVideoStatus(
        syncedProject,
        segmentLabel,
        buildSegmentVideoStatus(segmentLabel, normalizedStatus, {
          taskId,
          provider: taskProvider,
          submittedPrompt: submittedPromptForAudit,
          referenceImageUrls: submittedReferenceImageUrlsForAudit,
          usedContinuityFrame: usedContinuityFrameForAudit,
          usedRelayVideo: usedRelayVideoForAudit,
        }),
      );
      await options?.onProgress?.({
        segmentLabel,
        status: "processing",
        detail: buildVideoPollingProgressDetail({
          round: round + 1,
          maxRounds: MAX_POLL_ROUNDS,
          provider: taskProvider,
          status: normalizedStatus,
          promptTips: statusData?.prompt_tips,
        }),
      });
    }

    if (!videoUrl && !failedStatus) {
      failedStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
        taskId,
        provider: taskProvider,
        submittedPrompt: submittedPromptForAudit,
        referenceImageUrls: submittedReferenceImageUrlsForAudit,
        usedContinuityFrame: usedContinuityFrameForAudit,
        usedRelayVideo: usedRelayVideoForAudit,
        failure: {
          message: "片段视频生成超时，请重新生成。",
          provider: taskProvider,
          stage: "status",
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  let automationRoute: VideoRepairTask["route"] | null = null;
  let archivedCandidate: ArchivedSegmentVideoCandidate | undefined;
  if (submittedPromptForAudit && videoUrl) {
    const visualQualityReport = await analyzeSegmentVideoVisualQuality({
      videoUrl,
      scenes: segmentScenes,
      submittedPrompt: submittedPromptForAudit,
      previousContinuityFrameUrl: previousSegmentContinuityFrameUrl,
      segmentStartContinuityText,
      segmentFlowContinuityText,
    });
    const automationDecision = buildSegmentAutomationAuditOutcome({
      project: syncedProject,
      segmentLabel,
      segmentPrompt,
      segmentScenes,
      segmentContinuityContext,
      provider: taskProvider,
      submittedPrompt: submittedPromptForAudit,
      referenceImageUrls: submittedReferenceImageUrlsForAudit,
      usedContinuityFrame: usedContinuityFrameForAudit,
      usedRelayVideo: usedRelayVideoForAudit,
      segmentStartContinuityText,
      videoUrl,
      continuityFrameUrl,
      taskId,
      failedStatus: null,
      visualQualityReport,
    });
    syncedProject = automationDecision.project;
    automationRoute = automationDecision.route;
    videoUrl = automationDecision.videoUrl;
    continuityFrameUrl = automationDecision.continuityFrameUrl;
    failedStatus = automationDecision.failedStatus;
    archivedCandidate = automationDecision.archivedCandidate;
  }

  if (videoUrl) {
    syncedProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
      project: {
        ...syncedProject,
        segmentVideoStatuses: {
          ...(syncedProject.segmentVideoStatuses ?? {}),
          [segmentLabel]: buildSegmentVideoStatus(segmentLabel, "completed", {
            taskId,
            provider: taskProvider,
          }),
        },
      },
      segmentLabel,
      videoUrl,
      providerLastFrameUrl: continuityFrameUrl,
    });
    continuityFrameUrl = syncedProject.segmentContinuityFrames?.[segmentLabel];
    continuityFrameSetUrls = syncedProject.segmentContinuityFrameSets?.[segmentLabel] ?? [];
    continuityGridImageUrl = syncedProject.segmentContinuityGridImages?.[segmentLabel]?.imageUrl?.trim() || undefined;
    const completionSummary = `片段 ${segmentLabel} 视频已生成完成（${effectiveDuration}s）。`;
    if (options?.persistCompletion !== false) {
      const partialProject = synchronizeVideoProductionState(syncedProject);
      const partialResult = await saveVideoProject(
        partialProject,
        completionSummary,
      );
      syncedProject = partialResult.data?.videoProject ?? partialProject;
    } else {
      syncedProject = synchronizeVideoProductionState(syncedProject);
    }
    dispatchSegmentVideoGenerated({
      videoUrl,
      segmentLabel,
      projectId: syncedProject.id,
      model: resolvedModel,
      resolution: videoGenerationPrefs.resolution,
      provider: taskProvider,
      mode: videoGenerationPrefs.mode,
      index: eventIndex,
      mediaEventId:
        typeof input.mediaEventId === "string" && input.mediaEventId.trim()
          ? input.mediaEventId.trim()
          : undefined,
    });
    await options?.onProgress?.({ segmentLabel, status: "done", videoUrl });
  } else if (failedStatus) {
    syncedProject = withSegmentVideoStatus(syncedProject, segmentLabel, failedStatus);
    dispatchSegmentVideoGeneratedFailed({
      segmentLabel,
      reason:
        archivedCandidate?.failureReason ||
        failedStatus.failure?.message ||
        "片段视频生成失败，请检查提示词和通道配置后重试。",
      index: eventIndex,
      projectId: syncedProject.id,
      videoUrl: archivedCandidate?.videoUrl,
      failure: failedStatus.failure,
      mediaEventId:
        typeof input.mediaEventId === "string" && input.mediaEventId.trim()
          ? input.mediaEventId.trim()
          : undefined,
    });
    await options?.onProgress?.({ segmentLabel, status: "failed" });
  }

  const qaChatSummary = buildSegmentAuditChatSummary(syncedProject, segmentLabel);
  const summary = videoUrl
    ? [
        `片段 ${segmentLabel} 视频已生成完成（${effectiveDuration}s）。`,
        qaChatSummary,
      ]
        .filter(Boolean)
        .join("\n")
    : failedStatus
      ? [
          `片段 ${segmentLabel} ${
            automationRoute && automationRoute !== "pass" ? "自动 QA 未通过" : "视频生成失败"
          }：${failedStatus.failure?.message || "请检查提示词和通道配置后重试。"}`,
          qaChatSummary,
        ]
          .filter(Boolean)
          .join("\n")
      : taskId
        ? `片段 ${segmentLabel} 视频任务已提交（${transport.providerLabel}），可稍后查看结果。`
        : "片段视频提交失败，请检查提示词和通道配置。";

  return {
    project: syncedProject,
    videoUrl,
    continuityImageUrl: continuityGridImageUrl,
    continuityImageLabel: continuityGridImageUrl ? `片段 ${segmentLabel} · 前情六宫格` : undefined,
    summary,
    status: videoUrl ? "completed" : failedStatus ? "failed" : "submitted",
  };
}

export async function generateSegmentVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
  onProgress?: import("../types").WorkflowActionProgressCallback,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );

  const requestedSegmentLabels = collectRequestedSegmentVideoLabels(input);
  const batchLimit = resolveVideoGenerationBatchSize(input, project.videoGenerationPrefs);
  const retryFailed = input.retryFailed === true;
  const batchMode = input.batchMode === "first";
  const singleSegmentLabel =
    typeof input.segmentLabel === "string" ? input.segmentLabel.trim() : "";

  let candidateSegmentLabels: string[] = [];
  let batchSource: "single" | "explicit" | "first" | "failed" = "single";

  if (requestedSegmentLabels.length) {
    candidateSegmentLabels = requestedSegmentLabels;
    batchSource = requestedSegmentLabels.length > 1 ? "explicit" : "single";
  } else if (retryFailed) {
    candidateSegmentLabels = listFailedSegmentVideoLabelsForBatch(project);
    batchSource = "failed";
  } else if (batchMode) {
    candidateSegmentLabels = listGeneratableSegmentVideoLabelsForBatch(project);
    batchSource = "first";
  } else if (singleSegmentLabel) {
    candidateSegmentLabels = [singleSegmentLabel];
  }

  const totalCandidateCount = candidateSegmentLabels.length;
  const targetSegmentLabels = candidateSegmentLabels.slice(0, batchLimit);
  if (!targetSegmentLabels.length) {
    if (retryFailed) {
      throw new Error("当前没有失败的片段视频可补发。");
    }
    if (batchMode || requestedSegmentLabels.length > 1) {
      throw new Error("当前没有可提交的片段视频，请先补齐新的片段提示词。");
    }
    throw new Error("缺少 segmentLabel，无法生成片段视频。");
  }

  const isBatchRun =
    targetSegmentLabels.length > 1 ||
    batchSource === "first" ||
    batchSource === "failed" ||
    batchSource === "explicit";
  await pauseBeforeMediaSubmission({
    input,
    onProgress,
    kind: "video",
    title:
      targetSegmentLabels.length === 1
        ? "已整理 1 个片段视频生成任务。"
        : `已整理 ${targetSegmentLabels.length} 个片段视频生成任务。`,
    content: buildSegmentVideoSubmissionContent(project, targetSegmentLabels),
    requestCount: targetSegmentLabels.length,
  });
  const formatSegmentVideoProgress = createSegmentVideoProgressFormatter(targetSegmentLabels);
  onProgress?.({ summary: formatSegmentVideoProgress({ status: "init" }) });
  let syncedProject = project;
  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const generationConcurrency = Math.max(
    1,
    Math.min(targetSegmentLabels.length, getHomeAgentVideoGenerationConcurrencyLimit(videoGenerationPrefs)),
  );
  const runSegmentVideoTask = async (
    currentProject: PersistedVideoProject,
    segmentLabel: string,
    index: number,
  ) => {
    try {
      return await generateSingleSegmentVideoRun(currentProject, input, segmentLabel, index, {
        persistCompletion: false,
        onProgress: ({ segmentLabel: currentSegmentLabel, status, detail }) => {
          onProgress?.({
            summary: appendVideoProgressDetail(
              formatSegmentVideoProgress({ unitKey: currentSegmentLabel, status }),
              detail,
            ),
          });
        },
      });
    } catch (error) {
      onProgress?.({
        summary: formatSegmentVideoProgress({
          unitKey: segmentLabel,
          status:
            isAbortLikeWorkflowError(error) || resolveInputAbortSignal(input)?.aborted
              ? "cancelled"
              : "failed",
        }),
      });
      throw error;
    }
  };
  const mergeSegmentRunProject = (
    currentProject: PersistedVideoProject,
    segmentLabel: string,
    nextProject: PersistedVideoProject,
  ): PersistedVideoProject => {
    let mergedProject = currentProject;
    const nextStatus = nextProject.segmentVideoStatuses?.[segmentLabel];
    if (nextStatus) {
      mergedProject = withSegmentVideoStatus(mergedProject, segmentLabel, nextStatus);
    }
    if (nextProject.segmentVideos !== undefined) {
      const nextSegmentVideos = { ...(mergedProject.segmentVideos ?? {}) };
      const nextVideoUrl = nextProject.segmentVideos?.[segmentLabel];
      if (nextVideoUrl) {
        nextSegmentVideos[segmentLabel] = nextVideoUrl;
      } else {
        delete nextSegmentVideos[segmentLabel];
      }
      mergedProject = {
        ...mergedProject,
        segmentVideos: nextSegmentVideos,
      };
    }
    if (nextProject.segmentContinuityFrames !== undefined) {
      const nextContinuityFrameUrl = nextProject.segmentContinuityFrames?.[segmentLabel];
      if (nextContinuityFrameUrl) {
        mergedProject = withSegmentContinuityFrame(mergedProject, segmentLabel, nextContinuityFrameUrl);
      } else if (mergedProject.segmentContinuityFrames?.[segmentLabel]) {
        const nextContinuityFrames = { ...(mergedProject.segmentContinuityFrames ?? {}) };
        delete nextContinuityFrames[segmentLabel];
        mergedProject = {
          ...mergedProject,
          segmentContinuityFrames: nextContinuityFrames,
        };
      }
    }
    if (nextProject.segmentContinuityFrameSets !== undefined) {
      const nextContinuityFrameSetUrls = nextProject.segmentContinuityFrameSets?.[segmentLabel];
      if (nextContinuityFrameSetUrls?.length) {
        mergedProject = withSegmentContinuityFrameSet(
          mergedProject,
          segmentLabel,
          nextContinuityFrameSetUrls,
        );
      } else if (mergedProject.segmentContinuityFrameSets?.[segmentLabel]) {
        const nextContinuityFrameSets = { ...(mergedProject.segmentContinuityFrameSets ?? {}) };
        delete nextContinuityFrameSets[segmentLabel];
          mergedProject = {
            ...mergedProject,
            segmentContinuityFrameSets: nextContinuityFrameSets,
          };
        }
      }
    if (nextProject.segmentContinuityGridImages !== undefined) {
      const nextContinuityGridImage = nextProject.segmentContinuityGridImages?.[segmentLabel];
      if (nextContinuityGridImage?.imageUrl?.trim()) {
        mergedProject = withSegmentContinuityGridImage(
          mergedProject,
          segmentLabel,
          nextContinuityGridImage,
        );
      } else if (mergedProject.segmentContinuityGridImages?.[segmentLabel]) {
        const nextContinuityGridImages = { ...(mergedProject.segmentContinuityGridImages ?? {}) };
        delete nextContinuityGridImages[segmentLabel];
        mergedProject = {
          ...mergedProject,
          segmentContinuityGridImages: Object.keys(nextContinuityGridImages).length
            ? nextContinuityGridImages
            : undefined,
        };
      }
    }
    if (nextProject.videoGenerationModeNotice !== undefined) {
      mergedProject = {
        ...mergedProject,
        videoGenerationModeNotice: nextProject.videoGenerationModeNotice,
      };
    }
    if (nextProject.segmentVideoPrompts !== undefined) {
      mergedProject = {
        ...mergedProject,
        segmentVideoPrompts: nextProject.segmentVideoPrompts,
      };
    }
    if (nextProject.videoAuditPackets !== undefined) {
      mergedProject = {
        ...mergedProject,
        videoAuditPackets: nextProject.videoAuditPackets,
      };
    }
    if (nextProject.videoRepairTasks !== undefined) {
      mergedProject = {
        ...mergedProject,
        videoRepairTasks: nextProject.videoRepairTasks,
      };
    }
    if (nextProject.automationState !== undefined) {
      mergedProject = {
        ...mergedProject,
        automationState: nextProject.automationState,
      };
    }
    if (nextProject.reviewQueue !== undefined) {
      mergedProject = {
        ...mergedProject,
        reviewQueue: nextProject.reviewQueue,
      };
    }
    if (nextProject.archivedSegmentVideos !== undefined) {
      const nextArchivedEntries = nextProject.archivedSegmentVideos?.[segmentLabel];
      const mergedArchivedSegmentVideos = { ...(mergedProject.archivedSegmentVideos ?? {}) };
      if (nextArchivedEntries?.length) {
        mergedArchivedSegmentVideos[segmentLabel] = nextArchivedEntries;
      } else {
        delete mergedArchivedSegmentVideos[segmentLabel];
      }
      mergedProject = {
        ...mergedProject,
        archivedSegmentVideos: Object.keys(mergedArchivedSegmentVideos).length
          ? mergedArchivedSegmentVideos
          : undefined,
      };
    }
    return mergedProject;
  };

  const shouldRunSegmentsSequentially = isBatchRun && targetSegmentLabels.length > 1;
  const results = shouldRunSegmentsSequentially
    ? await (async () => {
        const sequentialResults: SegmentVideoGenerationRunResult[] = [];
        let sequentialProject = syncedProject;
        for (let index = 0; index < targetSegmentLabels.length; index += 1) {
          const segmentLabel = targetSegmentLabels[index];
          const result = await runSegmentVideoTask(sequentialProject, segmentLabel, index);
          sequentialResults.push(result);
          sequentialProject = mergeSegmentRunProject(sequentialProject, segmentLabel, result.project);
        }
        return sequentialResults;
      })()
    : isBatchRun
      ? await mapWithConcurrency(
          targetSegmentLabels,
          generationConcurrency,
          async (segmentLabel, index) => runSegmentVideoTask(project, segmentLabel, index),
        )
      : [await runSegmentVideoTask(syncedProject, targetSegmentLabels[0], 0)];

  const videoUrls: string[] = [];
  const summaries: string[] = [];
  let completedCount = 0;
  let failedCount = 0;

  results.forEach((result, index) => {
    const segmentLabel = targetSegmentLabels[index];
    syncedProject = mergeSegmentRunProject(syncedProject, segmentLabel, result.project);
    summaries.push(result.summary);
    if (result.videoUrl) {
      videoUrls.push(result.videoUrl);
    }
    if (result.status === "completed") {
      completedCount += 1;
    } else if (result.status === "failed") {
      failedCount += 1;
    }
  });

  const remainingTargetCount = Math.max(totalCandidateCount - targetSegmentLabels.length, 0);
  const batchAuditPackets = targetSegmentLabels
    .map((segmentLabel) => getLatestSegmentAuditPacket(syncedProject, segmentLabel))
    .filter((packet): packet is VideoAuditPacket => Boolean(packet));
  const batchQaSummary = batchAuditPackets.length
    ? `自动 QA：通过 ${batchAuditPackets.filter((packet) => packet.status === "pass").length} 段，局部修复 ${batchAuditPackets.filter((packet) => packet.status === "local_repair").length} 段，整段重生 ${batchAuditPackets.filter((packet) => packet.status === "regenerate").length} 段，进入 review ${batchAuditPackets.filter((packet) => packet.status === "escalate").length} 段。`
    : "";
  const summary = isBatchRun
    ? [
        completedCount > 0 && failedCount > 0
          ? `本轮已完成 ${completedCount} 个片段视频，${failedCount} 个片段失败。`
          : completedCount > 0
            ? `本轮已完成 ${completedCount} 个片段视频。`
            : failedCount > 0
              ? `本轮处理的 ${targetSegmentLabels.length} 个片段视频均失败了。`
              : `本轮已提交 ${targetSegmentLabels.length} 个片段视频任务。`,
        `本轮按视频批次上限处理 ${targetSegmentLabels.length}/${totalCandidateCount || targetSegmentLabels.length} 个片段。`,
        batchQaSummary,
        remainingTargetCount > 0 ? "继续点击同一个按钮会补下一批。" : "",
        failedCount > 0 ? "失败片段会保留在待补齐列表中，方便下一轮继续补发。" : "",
      ]
        .filter(Boolean)
        .join(" ")
    : summaries[0] || "片段视频提交失败，请检查提示词和通道配置。";

  const result = await saveVideoProject(synchronizeVideoProductionState(syncedProject), summary);
  return {
    ...result,
    ...(videoUrls.length ? { videoUrls } : {}),
    remainingTargetIds: listGeneratableSegmentVideoLabelsForBatch(
      synchronizeVideoProductionState(syncedProject),
    ),
  };
}

export async function refreshSegmentVideoAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = mergeVideoInputContext(
    await ensureVideoProject(runtime, input),
    runtime,
    input,
  );
  const segmentLabel = typeof input.segmentLabel === "string" ? input.segmentLabel.trim() : "";
  if (!segmentLabel) {
    throw new Error("缺少 segmentLabel，无法刷新片段视频任务。");
  }

  let syncedProject = synchronizeVideoProductionState(project);
  const currentStatus = syncedProject.segmentVideoStatuses?.[segmentLabel];
  const taskId = currentStatus?.taskId?.trim();
  if (!taskId) {
    throw new Error(`片段 ${segmentLabel} 没有可刷新的生成任务。`);
  }

  const videoGenerationPrefs = resolveRequestedVideoGenerationPrefs(project, input);
  const provider = currentStatus?.provider || resolveVideoGenerationProvider(videoGenerationPrefs);
  const resolvedModel = resolveVideoGenerationModelName(videoGenerationPrefs);

  const { data, error } = await invokeFunction<VideoGenerationStatusResult>(
    "generate-video",
    { action: "status", taskId, provider },
    { abortSignal: resolveInputAbortSignal(input) },
  );

  let videoUrl: string | undefined;
  let continuityFrameUrl: string | undefined;
  let nextStatus: SegmentVideoStatus;
  if (error) {
    nextStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
      taskId,
      provider,
      submittedPrompt: currentStatus?.submittedPrompt,
      referenceImageUrls: currentStatus?.referenceImageUrls,
      usedContinuityFrame: currentStatus?.usedContinuityFrame,
      usedRelayVideo: currentStatus?.usedRelayVideo,
      failure: {
        message: summarizeVideoGenerationError(error),
        provider,
        stage: "status",
        updatedAt: new Date().toISOString(),
      },
    });
  } else {
    const normalizedStatus = normalizeSceneStatus(data?.status || data?.state) || "processing";
    if (normalizedStatus === "completed" && data?.video_url) {
      videoUrl = await cacheSegmentVideoUrl(syncedProject.id, segmentLabel, data.video_url);
      continuityFrameUrl =
        (await resolveVerifiedGeneratedReferenceImageUrl(data.last_frame_url)) || undefined;
      nextStatus = buildSegmentVideoStatus(segmentLabel, "completed", {
        taskId,
        provider,
        submittedPrompt: currentStatus?.submittedPrompt,
        referenceImageUrls: currentStatus?.referenceImageUrls,
        usedContinuityFrame: currentStatus?.usedContinuityFrame,
        usedRelayVideo: currentStatus?.usedRelayVideo,
      });
    } else if (normalizedStatus === "failed") {
      const failureMessage = buildVideoStatusFailureMessage(
        data,
        "片段视频生成失败，建议调整片段提示词后重新提交。",
      );
      nextStatus = buildSegmentVideoStatus(segmentLabel, "failed", {
        taskId,
        provider,
        submittedPrompt: currentStatus?.submittedPrompt,
        referenceImageUrls: currentStatus?.referenceImageUrls,
        usedContinuityFrame: currentStatus?.usedContinuityFrame,
        usedRelayVideo: currentStatus?.usedRelayVideo,
        failure: {
          message: failureMessage,
          provider,
          stage: "status",
          updatedAt: new Date().toISOString(),
        },
      });
    } else {
      nextStatus = buildSegmentVideoStatus(segmentLabel, normalizedStatus, {
        taskId,
        provider,
        submittedPrompt: currentStatus?.submittedPrompt,
        referenceImageUrls: currentStatus?.referenceImageUrls,
        usedContinuityFrame: currentStatus?.usedContinuityFrame,
        usedRelayVideo: currentStatus?.usedRelayVideo,
      });
    }
  }

  if (videoUrl) {
    const segmentPrompt = syncedProject.segmentVideoPrompts?.[segmentLabel];
    if (segmentPrompt && nextStatus.submittedPrompt) {
      const segmentScenes = syncedProject.scenes
        .filter((scene) => scene.segmentLabel === segmentLabel)
        .sort((left, right) => left.sceneNumber - right.sceneNumber);
      const { segmentOrder, segmentMap } = buildSceneSegmentOrderContext(syncedProject.scenes);
      const segmentContinuityContext = buildSegmentPromptContinuityContext({
        project: syncedProject,
        segmentLabel,
        segmentOrder,
        segmentMap,
        segmentPrompts: syncedProject.segmentVideoPrompts ?? {},
        script: syncedProject.script || "",
      });
      const segmentStartContinuityText = buildSegmentSubmissionStartContinuityText(
        segmentContinuityContext.previousSegmentEndState,
        segmentContinuityContext.currentSegmentStartState,
        segmentContinuityContext.currentSegmentStoryGoal,
        Boolean(segmentContinuityContext.previousSegmentLabel),
        nextStatus.usedContinuityFrame === true,
        (syncedProject.segmentContinuityFrameSets?.[segmentContinuityContext.previousSegmentLabel] || []).length > 0,
        Boolean(
          segmentContinuityContext.previousSegmentLabel &&
            syncedProject.segmentContinuityGridImages?.[segmentContinuityContext.previousSegmentLabel]?.imageUrl?.trim(),
        ),
      );
      const segmentFlowContinuityText = buildSegmentSubmissionFlowContinuityText(
        segmentContinuityContext.currentSegmentStoryGoal,
        segmentContinuityContext.currentSegmentEndState,
        segmentContinuityContext.nextSegmentStartState,
      );
      const previousSegmentContinuityFrameUrl = await resolveVerifiedSegmentContinuityFrameUrl(
        syncedProject,
        segmentContinuityContext.previousSegmentLabel,
      );
      const visualQualityReport = await analyzeSegmentVideoVisualQuality({
        videoUrl,
        scenes: segmentScenes,
        submittedPrompt: nextStatus.submittedPrompt,
        previousContinuityFrameUrl: previousSegmentContinuityFrameUrl,
        segmentStartContinuityText,
        segmentFlowContinuityText,
      });
      const automationDecision = buildSegmentAutomationAuditOutcome({
        project: syncedProject,
        segmentLabel,
        segmentPrompt,
        segmentScenes,
        segmentContinuityContext,
        provider,
        submittedPrompt: nextStatus.submittedPrompt,
        referenceImageUrls: nextStatus.referenceImageUrls ?? [],
        usedContinuityFrame: nextStatus.usedContinuityFrame === true,
        usedRelayVideo: nextStatus.usedRelayVideo === true,
        segmentStartContinuityText,
        videoUrl,
        continuityFrameUrl,
        taskId,
        visualQualityReport,
      });
      syncedProject = automationDecision.project;
      videoUrl = automationDecision.videoUrl;
      continuityFrameUrl = automationDecision.continuityFrameUrl;
      nextStatus = automationDecision.failedStatus ?? buildSegmentVideoStatus(segmentLabel, "completed", {
        taskId,
        provider,
        submittedPrompt: currentStatus?.submittedPrompt,
        referenceImageUrls: currentStatus?.referenceImageUrls,
        usedContinuityFrame: currentStatus?.usedContinuityFrame,
        usedRelayVideo: currentStatus?.usedRelayVideo,
      });
    }
    if (videoUrl) {
      syncedProject = await refreshSegmentContinuityArtifactsFromSegmentVideoSource({
        project: syncedProject,
        segmentLabel,
        videoUrl,
        providerLastFrameUrl: continuityFrameUrl,
      });
      continuityFrameUrl = syncedProject.segmentContinuityFrames?.[segmentLabel];
    }
    syncedProject = withSegmentVideoStatus(syncedProject, segmentLabel, nextStatus);
    if (videoUrl) {
      dispatchSegmentVideoGenerated({
        videoUrl,
        segmentLabel,
        projectId: syncedProject.id,
        model: resolvedModel,
        resolution: videoGenerationPrefs.resolution,
        provider,
        mode: videoGenerationPrefs.mode,
      });
    }
  } else {
    syncedProject = withSegmentVideoStatus(syncedProject, segmentLabel, nextStatus);
  }

  const qaChatSummary = buildSegmentAuditChatSummary(syncedProject, segmentLabel);
  const summary =
    nextStatus.status === "completed"
      ? [`片段 ${segmentLabel} 视频已刷新完成。`, qaChatSummary].filter(Boolean).join("\n")
      : nextStatus.status === "failed"
        ? [
            `片段 ${segmentLabel} 视频刷新失败：${nextStatus.failure?.message || "请稍后重试。"}`,
            qaChatSummary,
          ]
            .filter(Boolean)
            .join("\n")
        : `片段 ${segmentLabel} 仍在生成中（${nextStatus.status}）。`;
  const result = await saveVideoProject(syncedProject, summary);
  return {
    ...result,
    ...(videoUrl ? { videoUrls: [videoUrl] } : {}),
  };
}
const VIDEO_PROJECT_SAVED_EVENT = "home-agent:video-project-saved";
