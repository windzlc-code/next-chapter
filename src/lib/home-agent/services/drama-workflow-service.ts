import {
  buildCharacterTransformPrompt,
  buildCharactersPrompt,
  buildCreativePlanPrompt,
  buildDirectoryPrompt,
  buildEpisodePrompt,
  buildExportPrompt,
  buildOutlinePrompt,
  buildReviewPrompt,
  buildStructureTransformPrompt,
} from "@/lib/drama-prompts";
import { callGeminiStream } from "@/lib/gemini-client";
import { readStoredDecomposeModel } from "@/lib/gemini-text-models";
import { readStoredLlmParams } from "@/lib/home-agent/llm-params";

// 全局细纲生成 AbortController 注册表，支持从 UI 取消
const OUTLINE_GENERATION_ABORT_KEY = "outline-generation";
const activeAbortControllers = new Map<string, AbortController>();

export function abortOutlineGeneration(): void {
  const controller = activeAbortControllers.get(OUTLINE_GENERATION_ABORT_KEY);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(OUTLINE_GENERATION_ABORT_KEY);
  }
}

export function isOutlineGenerationActive(): boolean {
  return activeAbortControllers.has(OUTLINE_GENERATION_ABORT_KEY);
}

const OUTLINE_TIMEOUT_MS = 120_000;
const COMPLIANCE_REVIEW_TEMPERATURE = 0.1;
/** 每 1000 个 token 额外给 15 秒，最少 120 秒，最多 600 秒 */
function calcTimeoutMs(maxOutputTokens: number): number {
  return Math.min(600_000, Math.max(OUTLINE_TIMEOUT_MS, Math.ceil(maxOutputTokens / 1000) * 15_000));
}
import {
  createEmptyDramaProject,
  createEmptyComplianceWorkspace,
  type ComplianceReviewMode,
  type ComplianceStrictness,
  type ComplianceWorkspace,
  type ComplianceWorkspaceModel,
  type ComplianceWorkspaceRiskPhrase,
  type DramaProject,
  type DramaSetup,
  type DramaStep,
  type EpisodeEntry,
  type EpisodeGenerationStatus,
  type EpisodeQualityReviewBatch,
  type EpisodeQualityReviewPacket,
  type EpisodeQualityReviewResult,
  type EpisodeScript,
  type OutlineBatchStatus,
} from "@/types/drama";
import {
  createDramaSnapshot,
  loadStoredDramaProjectById,
  upsertStoredDramaProject,
} from "@/lib/home-agent/project-store";
import type {
  ConversationArtifactEditorField,
  StudioRuntimeState,
  WorkflowActionResult,
} from "@/lib/home-agent/types";
import { emitHomeAgentWorkflowRuntimeDelta } from "@/lib/home-agent/workflow-runtime-events";
import {
  buildExportPatchPlan,
  buildQuickExportMarkdown,
  buildEpisodeReviewRewriteInstruction,
  buildOutlineBatchStatuses,
  formatEpisodeRangeLabel,
  OUTLINE_BATCH_SIZE,
  parseDramaDirectoryText,
  summariseEpisodeReviewPackets,
} from "@/lib/home-agent/script-artifact-helpers";
import {
  applyDialogueReviewMarkers,
  applyComplianceRedo,
  applyComplianceReplacement,
  applyComplianceUndo,
  buildComplianceSourceText,
  deriveComplianceRevisionPackets,
  executeComplianceReview,
  exportCompliancePaletteAsDocx,
  exportCompliancePaletteAsXlsx,
  findRiskRanges,
  locateComplianceRiskSpans,
  normalizeComplianceWorkspace,
  parseComplianceImportFile,
} from "@/lib/home-agent/compliance-workspace";

export interface DramaWorkflowContinuationPlan {
  actionKind:
    | "save_setup"
    | "analyze_reference_script"
    | "generate_creative_plan"
    | "generate_structure_transform"
    | "generate_characters"
    | "generate_character_transform"
    | "confirm_adaptation_episode_count"
    | "confirm_adaptation_target_market"
    | "confirm_adaptation_genres"
    | "generate_directory"
    | "generate_outlines"
    | "generate_episode"
    | "review_episode_quality"
    | "rewrite_episode_from_review"
    | "run_compliance_review"
    | "lock_character_cards"
    | "lock_story_beats"
    | "resolve_compliance_revisions"
    | "reopen_compliance_revisions"
    | "export_project"
    | "refine_export_document"
    | "update_drama_artifact_text";
  input: Record<string, unknown>;
  reason: string;
}

export function extractDramaTitle(plan: string): string {
  const markdownHeading = plan.match(/^#\s+(.+)$/m);
  if (markdownHeading) return markdownHeading[1].trim();
  const quoted = plan.match(/[《「“](.+?)[》」”]/);
  if (quoted) return quoted[1].trim();
  const firstLine = plan
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 32) : "";
}

export function ensureDramaProject(
  runtime: StudioRuntimeState,
  mode: DramaProject["mode"] = "traditional",
  options?: { forceNew?: boolean; projectId?: string },
): DramaProject {
  const requestedProjectId =
    typeof options?.projectId === "string" && options.projectId.trim()
      ? options.projectId.trim()
      : null;

  if (
    !options?.forceNew &&
    runtime.currentDramaProject &&
    (!requestedProjectId || runtime.currentDramaProject.id === requestedProjectId)
  ) {
    return { ...runtime.currentDramaProject };
  }
  if (!options?.forceNew && requestedProjectId) {
    const storedProject = loadStoredDramaProjectById(requestedProjectId);
    if (storedProject) {
      return { ...storedProject };
    }
  }
  const seededProjectId =
    requestedProjectId
      ? requestedProjectId
      : runtime.currentProjectSnapshot?.projectId?.trim() || "";
  return {
    ...createEmptyDramaProject(mode),
    ...(seededProjectId ? { id: seededProjectId } : {}),
    mode,
  };
}

export function buildDramaSetup(
  input: Record<string, unknown>,
  existing: DramaSetup | null,
): DramaSetup {
  return {
    genres: Array.isArray(input.genres)
      ? input.genres.filter((item): item is string => typeof item === "string")
      : existing?.genres ?? [],
    audience:
      typeof input.audience === "string" ? input.audience : existing?.audience ?? "全龄",
    tone: typeof input.tone === "string" ? input.tone : existing?.tone ?? "燃",
    ending:
      typeof input.ending === "string" ? input.ending : existing?.ending ?? "OE",
    totalEpisodes:
      typeof input.totalEpisodes === "number"
        ? input.totalEpisodes
        : existing?.totalEpisodes ?? 60,
    targetMarket:
      typeof input.targetMarket === "string"
        ? input.targetMarket
        : existing?.targetMarket ?? "cn",
    customTopic:
      typeof input.customTopic === "string" ? input.customTopic : existing?.customTopic ?? "",
    setupMode:
      input.setupMode === "creative" || input.setupMode === "topic"
        ? input.setupMode
        : existing?.setupMode,
    creativeInput:
      typeof input.creativeInput === "string"
        ? input.creativeInput
        : existing?.creativeInput ?? "",
  };
}

function hasMeaningfulOriginalSetupSeed(
  input: Record<string, unknown>,
  existing: DramaSetup | null,
): boolean {
  const genres = Array.isArray(input.genres)
    ? input.genres.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : existing?.genres ?? [];
  const customTopic =
    typeof input.customTopic === "string" ? input.customTopic : existing?.customTopic ?? "";
  const creativeInput =
    typeof input.creativeInput === "string" ? input.creativeInput : existing?.creativeInput ?? "";

  return genres.length > 0 || Boolean(customTopic.trim()) || Boolean(creativeInput.trim());
}

const DRAMA_SETUP_INPUT_KEYS = [
  "title",
  "genres",
  "audience",
  "tone",
  "ending",
  "totalEpisodes",
  "targetMarket",
  "customTopic",
  "setupMode",
  "creativeInput",
  "referenceScript",
] as const;

function resolveDramaMode(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): DramaProject["mode"] {
  if (input.projectKind === "adaptation") return "adaptation";
  if (runtime.currentDramaProject?.mode === "adaptation") return "adaptation";
  if (runtime.currentProjectSnapshot?.projectKind === "adaptation") return "adaptation";
  return "traditional";
}

function buildPlanningDramaProject(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): DramaProject {
  const mode = resolveDramaMode(runtime, input);
  const requestedProjectId =
    typeof input.projectId === "string" && input.projectId.trim()
      ? input.projectId.trim()
      : undefined;
  const project = ensureDramaProject(runtime, mode, { projectId: requestedProjectId });
  const snapshotTitle =
    runtime.currentProjectSnapshot &&
    runtime.currentProjectSnapshot.projectKind !== "video" &&
    (!requestedProjectId || runtime.currentProjectSnapshot.projectId === requestedProjectId)
      ? runtime.currentProjectSnapshot.title?.trim()
      : "";

  return {
    ...project,
    mode,
    setup: buildDramaSetup(input, project.setup),
    dramaTitle:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : project.dramaTitle || snapshotTitle,
    referenceScript:
      typeof input.referenceScript === "string"
        ? input.referenceScript
        : project.referenceScript,
    referenceStructure:
      typeof input.referenceStructure === "string"
        ? input.referenceStructure
        : project.referenceStructure,
    frameworkStyle:
      typeof input.frameworkStyle === "string"
        ? input.frameworkStyle
        : project.frameworkStyle,
    creativePlan:
      typeof input.creativePlan === "string" ? input.creativePlan : project.creativePlan,
    characters:
      typeof input.characters === "string" ? input.characters : project.characters,
    structureTransform:
      typeof input.structureTransform === "string"
        ? input.structureTransform
        : project.structureTransform,
  };
}

function findMissingOutlineRange(project: DramaProject): {
  rangeStart: number;
  rangeEnd: number;
} | null {
  const missingEntries = project.directory.filter((entry) => !entry.outline?.trim());
  if (missingEntries.length === 0) return null;

  const rangeStart = missingEntries[0]?.number ?? 1;
  const lastMissing = missingEntries.at(-1)?.number ?? rangeStart;
  return {
    rangeStart,
    rangeEnd: Math.min(rangeStart + 4, lastMissing),
  };
}

function findNextEpisodeNumber(project: DramaProject): number | null {
  const existingEpisodes = new Set(project.episodes.map((episode) => episode.number));
  const nextDirectoryEntry = project.directory.find((entry) => !existingEpisodes.has(entry.number));
  return nextDirectoryEntry?.number ?? null;
}

function hasDramaSetupInput(input: Record<string, unknown>): boolean {
  return DRAMA_SETUP_INPUT_KEYS.some((key) => key in input);
}

function withDramaProject(
  runtime: StudioRuntimeState,
  project: DramaProject,
): StudioRuntimeState {
  return {
    ...runtime,
    currentDramaProject: project,
    currentProjectSnapshot: createDramaSnapshot(project),
  };
}

export function planDramaWorkflowContinuation(
  project: DramaProject,
  input: Record<string, unknown> = {},
): DramaWorkflowContinuationPlan {
  const baseInput: Record<string, unknown> = {
    ...input,
    projectKind: project.mode === "adaptation" ? "adaptation" : "script",
  };

  if (!project.setup) {
    return {
      actionKind: "save_setup",
      input: baseInput,
      reason: "先把当前首页会话里的立项信息写入项目，再继续推进后续创作。",
    };
  }

  if (project.mode === "adaptation") {
    if (!project.referenceScript?.trim()) {
      throw new Error("改编流程还缺少参考文本，先把参考剧本贴给我，我就继续分析和转译。");
    }

    if (!project.referenceStructure?.trim()) {
      return {
        actionKind: "analyze_reference_script",
        input: baseInput,
        reason: "先分析参考文本的结构和冲突骨架，后面才能继续做改编转译。",
      };
    }

    if (!project.adaptationEpisodeCountConfirmed) {
      throw new Error("参考结构已分析完成，请先在首页选择改编集数，再继续结构转换。");
    }

    if (!project.adaptationTargetMarketConfirmed) {
      throw new Error("改编集数已确认，请先在首页选择目标市场，再继续结构转换。");
    }

    if (!project.adaptationGenresConfirmed) {
      throw new Error("目标市场已确认，请先在首页选择方向题材，再继续结构转换。");
    }

    if (!project.structureTransform?.trim()) {
      return {
        actionKind: "generate_structure_transform",
        input: baseInput,
        reason: "参考结构已经拿到，下一步直接生成适配目标市场的新结构方案。",
      };
    }

    if (!project.characterTransform?.trim() || !project.characters?.trim()) {
      return {
        actionKind: "generate_character_transform",
        input: baseInput,
        reason: "结构转译完成后，继续补齐角色改编方案和人物设定。",
      };
    }
  } else {
    if (!project.creativePlan?.trim()) {
      return {
        actionKind: "generate_creative_plan",
        input: baseInput,
        reason: "立项信息已经足够，先生成创作方案，后续目录和分集都会基于它推进。",
      };
    }

    if (!project.characters?.trim()) {
      return {
        actionKind: "generate_characters",
        input: baseInput,
        reason: "创作方案已完成，下一步补齐角色设定，避免后续目录和单集失焦。",
      };
    }
  }

  if (!project.directory.length || !project.directoryRaw?.trim()) {
    return {
      actionKind: "generate_directory",
      input: baseInput,
      reason: "核心世界观和人物已经就位，继续生成完整的分集目录。",
    };
  }

  const missingOutlineRange = findMissingOutlineRange(project);
  if (missingOutlineRange && project.currentStep !== "outlines") {
    return {
      actionKind: "generate_outlines",
      input: {
        ...baseInput,
        ...missingOutlineRange,
      },
      reason: "分集目录已经成型，先把下一批缺失的单集细纲补齐。",
    };
  }

  const episodeNumber = findNextEpisodeNumber(project);
  if (episodeNumber) {
    return {
      actionKind: "generate_episode",
      input: {
        ...baseInput,
        episodeNumber,
      },
      reason: `细纲已经具备，继续生成第 ${episodeNumber} 集正文。`,
    };
  }

  if (project.episodes.length > 0 && !(project.episodeQualityReviewPackets ?? []).length) {
    return {
      actionKind: "review_episode_quality",
      input: {
        ...baseInput,
        defaultReviewCount: 10,
      },
      reason: "正文已具备，先做一轮默认 10 集的批量质检，再决定是否要定向修复或继续合规审查。",
    };
  }

  if (!project.complianceReport?.trim()) {
    return {
      actionKind: "run_compliance_review",
      input: baseInput,
      reason: "正文已具备，下一步做合规审核，帮助首页会话继续安全出片。",
    };
  }

  if (!project.exportDocument?.trim()) {
    return {
      actionKind: "export_project",
      input: baseInput,
      reason: "核心产物已经齐了，继续整理导出文档，方便后续交付和出片。",
    };
  }

  return {
    actionKind: "export_project",
    input: baseInput,
    reason: "当前项目主链路已经完成，我先刷新一版导出文档供你继续润色或衔接视频制作。",
  };
}

async function runDramaContinuationPlan(
  plan: DramaWorkflowContinuationPlan,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  switch (plan.actionKind) {
    case "save_setup":
      return saveDramaSetupAction(plan.input, runtime);
    case "analyze_reference_script":
      return analyzeReferenceScriptAction(plan.input, runtime);
    case "generate_creative_plan":
      return generateCreativePlanAction(plan.input, runtime);
    case "generate_structure_transform":
      return generateStructureTransformAction(plan.input, runtime);
    case "generate_characters":
      return generateCharactersAction(plan.input, runtime);
    case "generate_character_transform":
      return generateCharacterTransformAction(plan.input, runtime);
    case "confirm_adaptation_episode_count":
      return confirmAdaptationEpisodeCountAction(plan.input, runtime);
    case "confirm_adaptation_target_market":
      return confirmAdaptationTargetMarketAction(plan.input, runtime);
    case "confirm_adaptation_genres":
      return confirmAdaptationGenresAction(plan.input, runtime);
    case "generate_directory":
      return generateDirectoryAction(plan.input, runtime);
    case "generate_outlines":
      return generateOutlinesAction(plan.input, runtime);
    case "generate_episode":
      return generateEpisodeAction(plan.input, runtime);
    case "review_episode_quality":
      return reviewEpisodeQualityAction(plan.input, runtime);
    case "rewrite_episode_from_review":
      return rewriteEpisodeFromReviewAction(plan.input, runtime);
    case "run_compliance_review":
      return runComplianceReviewAction(plan.input, runtime);
    case "lock_character_cards":
      return lockCharacterCardsAction(plan.input, runtime);
    case "lock_story_beats":
      return lockStoryBeatsAction(plan.input, runtime);
    case "resolve_compliance_revisions":
      return resolveComplianceRevisionsAction(plan.input, runtime);
    case "reopen_compliance_revisions":
      return reopenComplianceRevisionsAction(plan.input, runtime);
    case "export_project":
      return exportDramaProjectAction(plan.input, runtime);
    case "refine_export_document":
      return refineDramaExportAction(plan.input, runtime);
    default:
      throw new Error(`Unsupported drama continuation action: ${plan.actionKind}`);
  }
}

export async function continueDramaStepAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  let effectiveRuntime = runtime;
  let planningProject = buildPlanningDramaProject(runtime, input);
  let setupResult: WorkflowActionResult | null = null;

  if (!runtime.currentDramaProject || !runtime.currentDramaProject.setup || hasDramaSetupInput(input)) {
    setupResult = await saveDramaSetupAction(
      {
        ...input,
        projectKind: planningProject.mode === "adaptation" ? "adaptation" : "script",
      },
      runtime,
    );

    const savedProject = setupResult.data?.dramaProject;
    if (!savedProject) {
      return setupResult;
    }

    effectiveRuntime = withDramaProject(runtime, savedProject);
    planningProject = buildPlanningDramaProject(effectiveRuntime, input);

    if (planningProject.mode === "adaptation" && !planningProject.referenceScript?.trim()) {
      return {
        ...setupResult,
        summary: "已收下当前改编立项信息。接下来把参考剧本贴给我，我会在同一首页会话里继续做结构分析和改编。",
      };
    }
  }

  const plan = planDramaWorkflowContinuation(planningProject, input);
  if (plan.actionKind === "save_setup") {
    return setupResult ?? saveDramaSetupAction(plan.input, effectiveRuntime);
  }

  const result = await runDramaContinuationPlan(
    plan,
    withDramaProject(effectiveRuntime, planningProject),
  );

  return {
    ...result,
    summary: `${plan.reason}\n\n${result.summary}`,
  };
}

function parseDirectory(raw: string): EpisodeEntry[] {
  return parseDramaDirectoryText(raw);
}

function parseEpisodesFromProjectScriptText(
  text: string,
  fallbackEpisodes: EpisodeScript[],
): EpisodeScript[] | null {
  const normalized = applyDialogueReviewMarkers(text, false).paletteText.replace(/\r/g, "").trim();
  if (!normalized) return null;
  const sections = normalized.split(/\n\n---\n\n/).map((section) => section.trim()).filter(Boolean);
  if (!sections.length) return null;
  const fallbackByNumber = new Map(fallbackEpisodes.map((episode) => [episode.number, episode]));
  const parsedEpisodes: EpisodeScript[] = [];

  for (const section of sections) {
    const [header = "", ...bodyLines] = section.split("\n");
    const match = header.match(/^第\s*(\d+)\s*集(?:\s+(.*))?$/);
    if (!match) return null;
    const episodeNumber = Number(match[1]);
    if (!Number.isFinite(episodeNumber)) return null;
    const fallback = fallbackByNumber.get(episodeNumber);
    const content = bodyLines.join("\n").trim();
    parsedEpisodes.push({
      number: episodeNumber,
      title: match[2]?.trim() || fallback?.title || `第${episodeNumber}集`,
      content,
      wordCount: content.length,
    });
  }

  return parsedEpisodes.sort((a, b) => a.number - b.number);
}

function syncComplianceWorkspaceToProjectScript(
  project: DramaProject,
  workspace: ComplianceWorkspace,
): { episodes: EpisodeScript[]; workspace: ComplianceWorkspace } | null {
  const parsedEpisodes = parseEpisodesFromProjectScriptText(
    workspace.paletteText || workspace.sourceText,
    project.episodes,
  );
  if (!parsedEpisodes?.length) return null;

  const syncedSourceText = buildComplianceSourceText(
    {
      ...project,
      episodes: parsedEpisodes,
    },
    { sourceStrategy: "project-script" },
  ).trim();
  const dialogueReview = applyDialogueReviewMarkers(syncedSourceText, workspace.dialogueReviewEnabled);

  return {
    episodes: parsedEpisodes,
    workspace: normalizeComplianceWorkspace({
      ...workspace,
      sourceText: syncedSourceText,
      paletteText: dialogueReview.paletteText,
      dialogueOverLimitLineIndexes: dialogueReview.lineIndexes,
    }),
  };
}

const SMART_COMPLIANCE_FULL_REVIEW_THRESHOLD = 0.4;

type SmartComplianceRerunPlan =
  | { mode: "reuse"; sourceText: string; carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[]; repairedCount: number }
  | { mode: "full"; sourceText: string; changeRatio: number }
  | {
      mode: "incremental";
      sourceText: string;
      incrementalSourceText: string;
      carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[];
      repairedCount: number;
      changeRatio: number;
    };

function normalizeComplianceComparisonText(text: string): string {
  return applyDialogueReviewMarkers(text, false).paletteText.replace(/\s+/g, "").trim().toLowerCase();
}

function anchorComplianceRiskPhrases(
  sourceText: string,
  riskPhrases: ComplianceWorkspaceRiskPhrase[],
): ComplianceWorkspaceRiskPhrase[] {
  return riskPhrases.map((phrase) => {
    const [firstRange] = findRiskRanges(sourceText, phrase.text);
    return {
      ...phrase,
      normalizedText: phrase.normalizedText || normalizeComplianceComparisonText(phrase.text),
      sourceStart: firstRange?.[0] ?? phrase.sourceStart,
      sourceEnd: firstRange?.[1] ?? phrase.sourceEnd,
    };
  });
}

function estimateComplianceSourceChangeRatio(previousSourceText: string, nextSourceText: string): number {
  const previousLines = previousSourceText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nextLines = nextSourceText
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!previousLines.length && !nextLines.length) return 0;

  const previousCounts = new Map<string, number>();
  previousLines.forEach((line) => previousCounts.set(line, (previousCounts.get(line) ?? 0) + 1));
  let sharedCount = 0;
  nextLines.forEach((line) => {
    const count = previousCounts.get(line) ?? 0;
    if (count > 0) {
      sharedCount += 1;
      previousCounts.set(line, count - 1);
    }
  });

  return 1 - sharedCount / Math.max(previousLines.length, nextLines.length, 1);
}

function collectChangedLineWindows(previousSourceText: string, nextSourceText: string): Array<[number, number]> {
  const previousLines = previousSourceText.replace(/\r/g, "").split("\n");
  const nextLines = nextSourceText.replace(/\r/g, "").split("\n");
  const previousCounts = new Map<string, number>();
  previousLines.forEach((line) => {
    const key = line.trim();
    if (!key) return;
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  });

  const changedIndexes: number[] = [];
  nextLines.forEach((line, index) => {
    const key = line.trim();
    if (!key) return;
    const count = previousCounts.get(key) ?? 0;
    if (count > 0) {
      previousCounts.set(key, count - 1);
      return;
    }
    changedIndexes.push(index);
  });
  if (!changedIndexes.length) return [];

  const offsets: number[] = [];
  let cursor = 0;
  nextLines.forEach((line) => {
    offsets.push(cursor);
    cursor += line.length + 1;
  });

  const windows: Array<[number, number]> = [];
  let groupStart = changedIndexes[0];
  let groupEnd = changedIndexes[0];
  for (let index = 1; index < changedIndexes.length; index += 1) {
    const currentIndex = changedIndexes[index];
    if (currentIndex <= groupEnd + 2) {
      groupEnd = currentIndex;
      continue;
    }
    windows.push([Math.max(groupStart - 1, 0), Math.min(groupEnd + 1, nextLines.length - 1)]);
    groupStart = currentIndex;
    groupEnd = currentIndex;
  }
  windows.push([Math.max(groupStart - 1, 0), Math.min(groupEnd + 1, nextLines.length - 1)]);

  return windows.map(([startLine, endLine]) => [
    offsets[startLine] ?? 0,
    (offsets[endLine] ?? 0) + (nextLines[endLine]?.length ?? 0),
  ]);
}

function buildIncrementalComplianceSourceText(sourceText: string, windows: Array<[number, number]>): string {
  return windows
    .map(([start, end]) => sourceText.slice(start, end).trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function buildSmartComplianceRerunPlan(
  currentSourceText: string,
  workspace: ComplianceWorkspace,
): SmartComplianceRerunPlan {
  const currentComparable = normalizeComplianceComparisonText(currentSourceText);
  const syncedWorkspaceSourceText = workspace.sourceText.trim();
  const syncedWorkspaceComparable = syncedWorkspaceSourceText
    ? normalizeComplianceComparisonText(syncedWorkspaceSourceText)
    : "";
  if (syncedWorkspaceComparable && syncedWorkspaceComparable === currentComparable) {
    const anchoredWorkspaceRiskPhrases = anchorComplianceRiskPhrases(currentSourceText, workspace.riskPhrases);
    const carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[] = [];
    let repairedCount = 0;

    anchoredWorkspaceRiskPhrases.forEach((phrase) => {
      const phraseComparable = phrase.normalizedText || normalizeComplianceComparisonText(phrase.text);
      if (phraseComparable && currentComparable.includes(phraseComparable)) {
        carriedRiskPhrases.push({ ...phrase, status: "pending" });
        return;
      }
      const replacementComparable = phrase.replacement
        ? normalizeComplianceComparisonText(phrase.replacement)
        : "";
      if (replacementComparable && currentComparable.includes(replacementComparable)) {
        repairedCount += 1;
        return;
      }
      if (phrase.status === "resolved") {
        repairedCount += 1;
      }
    });

    return { mode: "reuse", sourceText: currentSourceText, carriedRiskPhrases, repairedCount };
  }
  const storedBaselineSourceText = (workspace.reviewBaselineSourceText || workspace.sourceText).trim();
  const baselineSourceText =
    syncedWorkspaceSourceText &&
    normalizeComplianceComparisonText(syncedWorkspaceSourceText) === currentComparable
      ? syncedWorkspaceSourceText
      : storedBaselineSourceText;
  const anchoredRiskPhrases = anchorComplianceRiskPhrases(baselineSourceText, workspace.riskPhrases);
  if (!baselineSourceText || !anchoredRiskPhrases.length) {
    return { mode: "full", sourceText: currentSourceText, changeRatio: 1 };
  }

  const changeRatio = estimateComplianceSourceChangeRatio(baselineSourceText, currentSourceText);
  if (changeRatio >= SMART_COMPLIANCE_FULL_REVIEW_THRESHOLD) {
    return { mode: "full", sourceText: currentSourceText, changeRatio };
  }

  const carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[] = [];
  let repairedCount = 0;

  anchoredRiskPhrases.forEach((phrase) => {
    const phraseComparable = phrase.normalizedText || normalizeComplianceComparisonText(phrase.text);
    if (phraseComparable && currentComparable.includes(phraseComparable)) {
      carriedRiskPhrases.push({ ...phrase, status: "pending" });
      return;
    }
    const replacementComparable = phrase.replacement
      ? normalizeComplianceComparisonText(phrase.replacement)
      : "";
    if (replacementComparable && currentComparable.includes(replacementComparable)) {
      repairedCount += 1;
      return;
    }
    if (phrase.status === "resolved") {
      repairedCount += 1;
    }
  });

  const changedWindows = collectChangedLineWindows(baselineSourceText, currentSourceText);
  if (!changedWindows.length) {
    return { mode: "reuse", sourceText: currentSourceText, carriedRiskPhrases, repairedCount };
  }

  return {
    mode: "incremental",
    sourceText: currentSourceText,
    incrementalSourceText: buildIncrementalComplianceSourceText(currentSourceText, changedWindows),
    carriedRiskPhrases,
    repairedCount,
    changeRatio,
  };
}

function pushComplianceHistory(workspace: ComplianceWorkspace, value: string): Pick<ComplianceWorkspace, "history" | "historyIndex"> {
  const nextHistory = workspace.history.slice(0, Math.max(workspace.historyIndex + 1, 0));
  if (!nextHistory.length || nextHistory[nextHistory.length - 1] !== value) nextHistory.push(value);
  return {
    history: nextHistory.slice(-20),
    historyIndex: Math.min(nextHistory.length - 1, 19),
  };
}

function buildComplianceWorkspaceFromReview(
  workspace: ComplianceWorkspace,
  sourceText: string,
  riskPhrases: ComplianceWorkspaceRiskPhrase[],
  report: string,
  segmentCount: number,
): ComplianceWorkspace {
  const anchoredRiskPhrases = anchorComplianceRiskPhrases(sourceText, riskPhrases);
  const dialogueReview = applyDialogueReviewMarkers(sourceText, workspace.dialogueReviewEnabled);
  const history = pushComplianceHistory(workspace, dialogueReview.paletteText);
  return normalizeComplianceWorkspace({
    ...workspace,
    sourceText,
    paletteText: dialogueReview.paletteText,
    reviewBaselineSourceText: sourceText,
    reviewBaselineReviewedAt: new Date().toISOString(),
    riskPhrases: anchoredRiskPhrases,
    riskSpans: locateComplianceRiskSpans(sourceText, anchoredRiskPhrases),
    segments: workspace.segments,
    progress: workspace.progress,
    latestReview: {
      reviewedAt: new Date().toISOString(),
      segmentCount,
      sourceLength: sourceText.length,
      reportLength: report.length,
      skippedAt: null,
    },
    history: history.history,
    historyIndex: history.historyIndex,
    dialogueOverLimitLineIndexes: dialogueReview.lineIndexes,
  });
}

function mergeComplianceRiskPhrases(
  carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[],
  incrementalRiskPhrases: ComplianceWorkspaceRiskPhrase[],
): ComplianceWorkspaceRiskPhrase[] {
  const merged = new Map<string, ComplianceWorkspaceRiskPhrase>();
  carriedRiskPhrases.forEach((phrase) => {
    const key = phrase.normalizedText || normalizeComplianceComparisonText(phrase.text) || phrase.id;
    merged.set(key, phrase);
  });
  incrementalRiskPhrases.forEach((phrase) => {
    const key = phrase.normalizedText || normalizeComplianceComparisonText(phrase.text) || phrase.id;
    merged.set(key, phrase);
  });
  return [...merged.values()];
}

function buildSmartComplianceReport(
  repairedCount: number,
  carriedRiskPhrases: ComplianceWorkspaceRiskPhrase[],
  incrementalRiskCount: number,
  incrementalReport: string,
): string {
  const header = [
    "# 智能重审摘要",
    `- 已确认修复：${repairedCount}`,
    `- 继续保留：${carriedRiskPhrases.length}`,
    `- 增量新增：${incrementalRiskCount}`,
  ].join("\n");
  return incrementalReport.trim() ? `${header}\n\n## 增量复核\n${incrementalReport}` : header;
}

/**
 * 去掉 AI 误在对话/旁白行前加的 △ 符号。
 * 判断依据：行以 △ 开头，去掉 △ 后紧跟"角色名："格式（中文/英文/数字 + 全角或半角冒号）。
 */
function removeTriangleFromDialogue(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (!line.startsWith("△")) return line;
      const withoutTriangle = line.slice(1).trimStart();
      // 对话格式：角色名：（...）台词 或 角色名：台词，角色名不含空格/△/#
      if (/^[^\s△#\n]+[：:]/.test(withoutTriangle)) {
        return withoutTriangle;
      }
      return line;
    })
    .join("\n");
}

const OUTLINE_MAX_VISIBLE_CHARS = 340;
const OUTLINE_COMPACT_BODY_VISIBLE_CHARS = 160;
const OUTLINE_COMPACT_SECTION_LIMITS = [
  { label: "场景转换", max: 58 },
  { label: "情感走向", max: 32 },
  { label: "结尾钩子", max: 38 },
  { label: "衔接", max: 32 },
] as const;
const OUTLINE_TIGHT_BODY_VISIBLE_CHARS = 135;
const OUTLINE_TIGHT_SECTION_LIMITS = [
  { label: "场景转换", max: 45 },
  { label: "情感走向", max: 28 },
  { label: "结尾钩子", max: 30 },
  { label: "衔接", max: 28 },
] as const;

function countVisibleChars(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

function trimVisibleChars(text: string, maxChars: number): string {
  if (countVisibleChars(text) <= maxChars) return text.trim();

  let visibleCount = 0;
  let result = "";
  for (const char of Array.from(text)) {
    if (/\s/.test(char)) {
      if (result) result += char;
      continue;
    }
    if (visibleCount >= maxChars) break;
    result += char;
    visibleCount += 1;
  }

  return result.trim().replace(/[，,。；;、：:\-—]+$/u, "");
}

function splitOutlineSections(outline: string): { body: string; sections: Map<string, string> } | null {
  const sectionPattern = /^(场景转换|情感走向|结尾钩子|衔接)：/gm;
  const matches = [...outline.matchAll(sectionPattern)];
  if (!matches.length || matches[0].index == null) return null;

  const sections = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const label = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? outline.length;
    sections.set(label, outline.slice(start, end).trim());
  }

  return {
    body: outline.slice(0, matches[0].index).trim(),
    sections,
  };
}

function compactOutlineWithLimits(
  outline: string,
  bodyMax: number,
  sectionLimits: readonly { label: string; max: number }[],
): string {
  const split = splitOutlineSections(outline);
  if (!split) return trimVisibleChars(outline, OUTLINE_MAX_VISIBLE_CHARS);

  const lines = [trimVisibleChars(split.body, bodyMax)].filter(Boolean);
  for (const { label, max } of sectionLimits) {
    const section = split.sections.get(label);
    if (section == null) continue;
    lines.push(`${label}：${trimVisibleChars(section, max)}`);
  }
  return lines.join("\n").trim();
}

function enforceOutlineLength(outline: string): string {
  const cleaned = outline.trim();
  if (countVisibleChars(cleaned) <= OUTLINE_MAX_VISIBLE_CHARS) return cleaned;

  const compact = compactOutlineWithLimits(
    cleaned,
    OUTLINE_COMPACT_BODY_VISIBLE_CHARS,
    OUTLINE_COMPACT_SECTION_LIMITS,
  );
  if (countVisibleChars(compact) <= OUTLINE_MAX_VISIBLE_CHARS) return compact;

  return compactOutlineWithLimits(
    cleaned,
    OUTLINE_TIGHT_BODY_VISIBLE_CHARS,
    OUTLINE_TIGHT_SECTION_LIMITS,
  );
}

function parseOutlines(text: string, options: { enforceLength?: boolean } = {}): Map<number, string> {
  const map = new Map<number, string>();
  const blocks = text.split(/【第(\d+)集细纲】/);
  for (let index = 1; index < blocks.length; index += 2) {
    const episodeNumber = Number(blocks[index]);
    const body = (blocks[index + 1] ?? "")
      .replace(/\r/g, "")
      .replace(/---\s*$/, "")
      .trim();
    const lines = body
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const outline = (lines.length > 1 ? lines.slice(1).join("\n") : lines[0] ?? "").trim();
    if (episodeNumber && outline) {
      map.set(episodeNumber, options.enforceLength ? enforceOutlineLength(outline) : outline);
    }
  }
  return map;
}

function mergeDirectoryWithExistingOutlines(
  nextDirectory: EpisodeEntry[],
  existingDirectory: EpisodeEntry[],
): EpisodeEntry[] {
  const existingByEpisode = new Map(
    existingDirectory.map((entry) => [entry.number, entry]),
  );

  return nextDirectory.map((entry) => {
    const existing = existingByEpisode.get(entry.number);
    return existing?.outline?.trim()
      ? { ...entry, outline: existing.outline }
      : entry;
  });
}

function applyOutlineEditsToDirectory(
  directory: EpisodeEntry[],
  outlineMap: Map<number, string>,
): EpisodeEntry[] {
  return directory.map((entry) => ({
    ...entry,
    outline: outlineMap.get(entry.number)?.trim() || undefined,
  }));
}

function isLogographicText(text: string): boolean {
  const sample = text.slice(0, 2000);
  const cjkCount = (
    sample.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g) || []
  ).length;
  return cjkCount / Math.max(sample.length, 1) > 0.15;
}

function getReferenceChunkSize(text: string): number {
  return isLogographicText(text) ? 10000 : 25000;
}

function splitReferenceScriptIntoChunks(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", maxSize);
    if (splitIndex < maxSize * 0.5) {
      splitIndex = remaining.lastIndexOf("\n", maxSize);
    }
    if (splitIndex < maxSize * 0.5) {
      splitIndex = maxSize;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

function normalizeTargetMarketToCode(input: unknown): string {
  if (input == null) return "";
  const raw = String(input).trim();
  if (!raw) return "";

  const lower = raw.toLowerCase();
  if (["cn", "jp", "west", "kr", "sea"].includes(lower)) {
    return lower;
  }

  if (/东南亚|东盟|泰国|越南|印尼|菲律宾|新加坡|马来西亚|southeast\s*asia|(^|\b)sea\b/i.test(raw)) {
    return "sea";
  }
  if (/韩国|韩语|korea|korean|(^|\b)kr(\b|$)/i.test(raw)) return "kr";
  if (/日本|日语|japan|japanese|(^|\b)jp(\b|$)/i.test(raw)) return "jp";
  if (/欧美|西方|英文|英语|western|europe|america|american|usa|uk|(^|\b)west(\b|$)/i.test(raw)) {
    return "west";
  }
  if (/国内|中国|中文|大陆|简体|(^|\b)cn(\b|$)|chinese|china|mandarin/i.test(raw)) {
    return "cn";
  }

  return "";
}

function parseJsonBlock<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function buildOutlineRangeTarget(
  entries: EpisodeEntry[],
  fallbackStart: number,
  fallbackEnd: number,
): OutlineBatchStatus[] {
  if (!entries.length) return [];
  const startEp = entries[0].number;
  const endEp = entries[entries.length - 1].number;
  const label = startEp === endEp ? `第${startEp}集` : `第${startEp}-${endEp}集`;
  return [
    {
      index: -2000 - fallbackStart * 1000 - fallbackEnd,
      label,
      startEp,
      endEp,
      status: "pending" as const,
    },
  ];
}

function buildOutlineContinuityContext(
  directory: EpisodeEntry[],
  startEp: number,
  endEp: number,
  radius = 2,
): string {
  const contextEntries = directory.filter(
    (entry) =>
      entry.number >= startEp - radius &&
      entry.number <= endEp + radius &&
      (entry.number < startEp || entry.number > endEp),
  );

  return contextEntries
    .map((entry) => {
      const outline = entry.outline?.trim();
      const body = outline ? `已生成细纲：${outline}` : `目录摘要：${entry.summary}`;
      return `第${entry.number}集：${entry.title}\n${body}`;
    })
    .join("\n\n");
}

function resolveOutlineBatchStatuses(project: DramaProject): OutlineBatchStatus[] {
  const existing = project.outlineBatchStatuses ?? [];
  const shouldRebuild =
    existing.length === 0 ||
    existing.some((batch) => batch.endEp - batch.startEp + 1 > OUTLINE_BATCH_SIZE);

  const batches = shouldRebuild ? buildOutlineBatchStatuses(project.directory) : existing;
  return batches.map((batch) => {
    const entries = project.directory.filter(
      (entry) => entry.number >= batch.startEp && entry.number <= batch.endEp,
    );
    const allHaveOutline = entries.length > 0 && entries.every((entry) => entry.outline?.trim());
    if (allHaveOutline) {
      return { ...batch, status: "done" as const, error: undefined };
    }
    return batch.status === "done"
      ? { ...batch, status: "pending" as const, error: undefined }
      : batch;
  });
}

function buildOutlineBatchTargets(
  project: DramaProject,
  input: Record<string, unknown>,
): OutlineBatchStatus[] {
  const existing = resolveOutlineBatchStatuses(project);
  const regenerateAll = input.regenerateAll === true;
  const fillMissingOutlines = input.fillMissingOutlines === true;
  const hasRequestedEpisodeNumbers = Array.isArray(input.episodeNumbers);
  const requestedEpisodeNumbers = Array.isArray(input.episodeNumbers)
    ? [...new Set(input.episodeNumbers.filter((value): value is number => typeof value === "number" && Number.isFinite(value)))]
        .sort((a, b) => a - b)
    : [];
  const rangeStart =
    typeof input.rangeStart === "number" && Number.isFinite(input.rangeStart)
      ? input.rangeStart
      : null;
  const rangeEnd =
    typeof input.rangeEnd === "number" && Number.isFinite(input.rangeEnd)
      ? input.rangeEnd
      : null;

  const autoFillMissingOutlines =
    !fillMissingOutlines &&
    !regenerateAll &&
    !hasRequestedEpisodeNumbers &&
    rangeStart == null &&
    rangeEnd == null &&
    project.directory.some((entry) => entry.outline?.trim());

  if (fillMissingOutlines || autoFillMissingOutlines) {
    const missingEpisodeNumbers = project.directory
      .filter((entry) => !entry.outline?.trim())
      .map((entry) => entry.number);
    if (!missingEpisodeNumbers.length) return [];
    return buildOutlineBatchTargets(project, { episodeNumbers: missingEpisodeNumbers });
  }

  if (requestedEpisodeNumbers.length) {
    const targets: OutlineBatchStatus[] = [];
    let rangeStart = requestedEpisodeNumbers[0];
    let previous = rangeStart;

    for (const episodeNumber of requestedEpisodeNumbers.slice(1)) {
      if (episodeNumber === previous + 1) {
        previous = episodeNumber;
        continue;
      }

      targets.push(
        ...buildOutlineRangeTarget(
          project.directory.filter(
            (entry) => entry.number >= rangeStart && entry.number <= previous,
          ),
          rangeStart,
          previous,
        ),
      );
      rangeStart = episodeNumber;
      previous = episodeNumber;
    }

    targets.push(
      ...buildOutlineRangeTarget(
        project.directory.filter(
          (entry) => entry.number >= rangeStart && entry.number <= previous,
        ),
        rangeStart,
        previous,
      ),
    );

    return targets;
  }

  if (rangeStart != null && rangeEnd != null) {
    const targetStart = Math.min(rangeStart, rangeEnd);
    const targetEnd = Math.max(rangeStart, rangeEnd);
    return buildOutlineRangeTarget(
      project.directory.filter((entry) => entry.number >= targetStart && entry.number <= targetEnd),
      targetStart,
      targetEnd,
    );
  }

  if (regenerateAll) {
    return [...existing].sort((a, b) => a.startEp - b.startEp);
  }

  return existing
    .filter((batch) => batch.status !== "done")
    .sort((a, b) => a.startEp - b.startEp);
}

function parseReviewResult(text: string): EpisodeQualityReviewResult | null {
  return parseJsonBlock<EpisodeQualityReviewResult>(text);
}

function buildReferenceConfigSetup(
  input: Record<string, unknown>,
  existing: DramaSetup,
  detected: {
    targetMarket?: unknown;
    audience?: unknown;
    tone?: unknown;
    ending?: unknown;
    suggestedEpisodes?: unknown;
  } | null,
): DramaSetup {
  const normalizedMarket = normalizeTargetMarketToCode(detected?.targetMarket);
  return {
    ...existing,
    targetMarket: normalizedMarket || existing.targetMarket,
    audience:
      typeof detected?.audience === "string" && detected.audience.trim()
        ? detected.audience.trim()
        : existing.audience,
    tone:
      typeof detected?.tone === "string" && detected.tone.trim()
        ? detected.tone.trim()
        : existing.tone,
    ending:
      typeof detected?.ending === "string" && detected.ending.trim()
        ? detected.ending.trim()
        : existing.ending,
    totalEpisodes:
      typeof detected?.suggestedEpisodes === "number" && Number.isFinite(detected.suggestedEpisodes)
        ? detected.suggestedEpisodes
        : typeof detected?.suggestedEpisodes === "string" && Number.isFinite(Number(detected.suggestedEpisodes))
          ? Number(detected.suggestedEpisodes)
          : existing.totalEpisodes,
  };
}

async function generateDramaText(
  prompt: string,
  abortSignal?: AbortSignal,
  maxOutputTokens?: number,
  modelOverride?: string,
  onChunk?: (text: string) => void,
  temperatureOverride?: number,
): Promise<string> {
  const storedParams = readStoredLlmParams();
  const resolvedMaxTokens = maxOutputTokens ?? storedParams.maxOutputTokens;
  const model = modelOverride ?? readStoredDecomposeModel();
  const timeoutMs = calcTimeoutMs(resolvedMaxTokens);
  const timeoutAbort = new AbortController();
  let didTimeout = false;
  const timer = window.setTimeout(() => {
    didTimeout = true;
    timeoutAbort.abort();
  }, timeoutMs);

  const onOuterAbort = () => timeoutAbort.abort();
  abortSignal?.addEventListener("abort", onOuterAbort, { once: true });
  if (abortSignal?.aborted) timeoutAbort.abort();

  try {
    return await callGeminiStream(
      model,
      [{ role: "user", parts: [{ text: prompt }] }],
      onChunk ?? (() => {}),
      {
        maxOutputTokens: resolvedMaxTokens,
        temperature: temperatureOverride ?? storedParams.temperature,
      },
      timeoutAbort.signal,
    );
  } catch (error) {
    if (didTimeout) {
      throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}秒），请检查网络后重试`);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function buildPreviousEpisodesText(
  episodes: EpisodeScript[],
  episodeNumber: number,
): string {
  return episodes
    .filter((episode) => episode.number < episodeNumber)
    .sort((a, b) => a.number - b.number)
    .slice(-2)
    .map((episode) => `第${episode.number}集 ${episode.title}\n${episode.content}`)
    .join("\n\n---\n\n");
}

function buildNextEpisodesText(
  directory: EpisodeEntry[],
  episodeNumber: number,
): string {
  return directory
    .filter((entry) => entry.number > episodeNumber)
    .slice(0, 2)
    .map((entry) => `第${entry.number}集 ${entry.title}\n${entry.summary}`)
    .join("\n\n");
}

function isEpisodeContentComplete(episode: EpisodeScript | undefined): boolean {
  return Boolean(episode?.content?.trim());
}

function listPendingEpisodeNumbers(project: DramaProject): number[] {
  const completedEpisodes = new Set(
    project.episodes
      .filter(isEpisodeContentComplete)
      .map((episode) => episode.number),
  );
  return project.directory
    .filter((entry) => !completedEpisodes.has(entry.number))
    .map((entry) => entry.number)
    .sort((a, b) => a - b);
}

function normalizeEpisodeNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((item): item is number => Number.isInteger(item) && item > 0),
  )].sort((a, b) => a - b);
}

function clearLastEpisodeQualityReviewBatch(
  batch: EpisodeQualityReviewBatch | null | undefined,
  episodeNumbers: number[],
): EpisodeQualityReviewBatch | null {
  if (!batch) return null;
  const removedNumbers = new Set(episodeNumbers);
  return batch.episodeNumbers.some((episodeNumber) => removedNumbers.has(episodeNumber))
    ? null
    : batch;
}

function assertEpisodeNumbersExistInDirectory(
  project: DramaProject,
  episodeNumbers: number[],
): void {
  const directoryEpisodeNumbers = new Set(project.directory.map((entry) => entry.number));
  const invalidEpisodeNumbers = episodeNumbers.filter(
    (episodeNumber) => !directoryEpisodeNumbers.has(episodeNumber),
  );
  if (invalidEpisodeNumbers.length) {
    throw new Error(`以下集数不在当前分集目录里，无法生成正文：${formatEpisodeRangeLabel(invalidEpisodeNumbers)}。`);
  }
}

function assertSequentialEpisodeAvailable(
  project: DramaProject,
  episodeNumber: number,
): void {
  if (episodeNumber <= 1) return;

  const completedEpisodeNumbers = new Set(
    project.episodes
      .filter(isEpisodeContentComplete)
      .map((episode) => episode.number),
  );
  if (completedEpisodeNumbers.has(episodeNumber)) return;
  if (!completedEpisodeNumbers.has(episodeNumber - 1)) {
    throw new Error(
      `第 ${episodeNumber} 集正文前，需先完成第 ${episodeNumber - 1} 集正文。`,
    );
  }
}

function assertBatchEpisodeDependencies(
  project: DramaProject,
  episodeNumbers: number[],
): void {
  const completedEpisodeNumbers = new Set(
    project.episodes
      .filter(isEpisodeContentComplete)
      .map((episode) => episode.number),
  );
  const requestedEpisodeNumbers = new Set(episodeNumbers);
  const blockedEpisodes: Array<{ episodeNumber: number; previousEpisodeNumber: number }> = [];

  episodeNumbers.forEach((episodeNumber) => {
    if (episodeNumber <= 1 || completedEpisodeNumbers.has(episodeNumber)) return;
    const previousEpisodeNumber = episodeNumber - 1;
    if (
      completedEpisodeNumbers.has(previousEpisodeNumber) ||
      requestedEpisodeNumbers.has(previousEpisodeNumber)
    ) {
      return;
    }
    blockedEpisodes.push({ episodeNumber, previousEpisodeNumber });
  });

  if (!blockedEpisodes.length) return;

  throw new Error(
    `以下集数缺少上一集正文，无法批量生成：${blockedEpisodes
      .map(
        ({ episodeNumber, previousEpisodeNumber }) =>
          `第 ${episodeNumber} 集（缺少第 ${previousEpisodeNumber} 集）`,
      )
      .join("、")}。`,
  );
}

function parseRequestedCount(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function selectEpisodesForReviewByCount(
  project: DramaProject,
  requestedCount: number,
): EpisodeScript[] {
  const completedEpisodes = [...project.episodes].sort((a, b) => a.number - b.number);
  const reviewedEpisodeNumbers = new Set(
    (project.episodeQualityReviewPackets ?? []).map((packet) => packet.episodeNumber),
  );
  const unreviewedEpisodes = completedEpisodes.filter(
    (episode) => !reviewedEpisodeNumbers.has(episode.number),
  );

  if (unreviewedEpisodes.length) {
    return unreviewedEpisodes.slice(0, requestedCount);
  }

  return completedEpisodes.slice(Math.max(completedEpisodes.length - requestedCount, 0));
}

function resolveEpisodeReviewTargets(
  project: DramaProject,
  input: Record<string, unknown>,
): {
  batch: EpisodeQualityReviewBatch;
  targetEpisodes: EpisodeScript[];
} {
  const completedEpisodes = [...project.episodes].sort((a, b) => a.number - b.number);
  if (!completedEpisodes.length) {
    throw new Error("当前还没有可用于批量质检的分集正文。");
  }

  const completedEpisodeNumbers = new Set(completedEpisodes.map((episode) => episode.number));
  const requestedEpisodeNumbers = normalizeEpisodeNumberList(input.episodeNumbers);
  const hasEpisodeNumberSelection = Array.isArray(input.episodeNumbers);
  const hasCustomCount = Object.prototype.hasOwnProperty.call(input, "reviewCount");
  const reviewRemainingOnly = input.reviewRemaining === true;

  if (hasEpisodeNumberSelection) {
    if (!requestedEpisodeNumbers.length) {
      throw new Error("未识别到可审查的集号，请重新输入要审查的集数或范围。");
    }
    const missingEpisodes = requestedEpisodeNumbers.filter(
      (episodeNumber) => !completedEpisodeNumbers.has(episodeNumber),
    );
    if (missingEpisodes.length) {
      throw new Error(
        `以下集数还没有正文，无法质检：${formatEpisodeRangeLabel(missingEpisodes)}。`,
      );
    }
    return {
      batch: {
        mode: "episodes",
        episodeNumbers: requestedEpisodeNumbers,
        reviewedAt: new Date().toISOString(),
        requestedCount: null,
      },
      targetEpisodes: completedEpisodes.filter((episode) =>
        requestedEpisodeNumbers.includes(episode.number),
      ),
    };
  }

  if (hasCustomCount) {
    const requestedCount = parseRequestedCount(input.reviewCount);
    if (!requestedCount || requestedCount > completedEpisodes.length) {
      throw new Error(`自定义审查数量必须是 1 到 ${completedEpisodes.length} 之间的整数。`);
    }
    const targetEpisodes = selectEpisodesForReviewByCount(project, requestedCount);
    return {
      batch: {
        mode: "custom-count",
        episodeNumbers: targetEpisodes.map((episode) => episode.number),
        reviewedAt: new Date().toISOString(),
        requestedCount,
      },
      targetEpisodes,
    };
  }

  const fallbackRequestedCount = parseRequestedCount(input.defaultReviewCount) ?? 10;
  const requestedCount = Math.min(fallbackRequestedCount, completedEpisodes.length);
  if (reviewRemainingOnly) {
    const reviewedEpisodeNumbers = new Set(
      (project.episodeQualityReviewPackets ?? []).map((packet) => packet.episodeNumber),
    );
    const targetEpisodes = completedEpisodes
      .filter((episode) => !reviewedEpisodeNumbers.has(episode.number))
      .slice(0, requestedCount);
    if (!targetEpisodes.length) {
      throw new Error("当前没有剩余未质检的已完成集数。");
    }
    return {
      batch: {
        mode: "default-count",
        episodeNumbers: targetEpisodes.map((episode) => episode.number),
        reviewedAt: new Date().toISOString(),
        requestedCount,
      },
      targetEpisodes,
    };
  }

  const targetEpisodes = selectEpisodesForReviewByCount(project, requestedCount);
  return {
    batch: {
      mode: "default-count",
      episodeNumbers: targetEpisodes.map((episode) => episode.number),
      reviewedAt: new Date().toISOString(),
      requestedCount,
    },
    targetEpisodes,
  };
}

function buildEpisodeReviewBatchSummary(
  packets: EpisodeQualityReviewPacket[],
): string {
  const summary = summariseEpisodeReviewPackets(packets);
  if (!summary.reviewedCount) {
    return "本轮质检没有拿到有效结果。";
  }
  const episodeLabel = formatEpisodeRangeLabel(packets.map((packet) => packet.episodeNumber));

  const episodeRanking =
    summary.highestEpisodeNumber != null && summary.lowestEpisodeNumber != null
      ? `最高第 ${summary.highestEpisodeNumber} 集，最低第 ${summary.lowestEpisodeNumber} 集。`
      : "";

  return [
    `本轮质检 ${summary.reviewedCount} 集（${episodeLabel}），平均分 ${summary.averageTotal.toFixed(1)}。`,
    episodeRanking,
    `风险项：阻断 ${summary.riskCounts.blocking} 条、警告 ${summary.riskCounts.warning} 条、建议 ${summary.riskCounts.suggestion} 条。`,
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveEpisodeDurationSeconds(
  input: Record<string, unknown>,
  project: DramaProject,
): number {
  if (typeof input.durationSeconds === "number") return input.durationSeconds;
  if (typeof project.preferredEpisodeDurationSeconds === "number") return project.preferredEpisodeDurationSeconds;
  return 60;
}

function saveDramaProject(project: DramaProject): WorkflowActionResult {
  const saved = upsertStoredDramaProject(project);
  const snapshot = createDramaSnapshot(saved);
  return {
    summary: `已更新项目《${saved.dramaTitle || "未命名项目"}》。`,
    projectSnapshot: snapshot,
    data: {
      dramaProject: saved,
      projectSnapshot: snapshot,
    },
  };
}

function emitDramaRuntimeDelta(
  action: string,
  project: DramaProject,
  summary?: string,
): DramaProject {
  const saved = upsertStoredDramaProject(project);
  emitHomeAgentWorkflowRuntimeDelta({
    action,
    projectId: saved.id,
    summary,
    data: {
      dramaProject: saved,
      projectSnapshot: createDramaSnapshot(saved),
    },
  });
  return saved;
}

function resolveWorkflowAbortSignal(input: Record<string, unknown>): AbortSignal | undefined {
  const signal = input.abortSignal as AbortSignal | undefined;
  return signal && typeof signal.aborted === "boolean" ? signal : undefined;
}

function updateEpisodeGenerationStatuses(
  statuses: EpisodeGenerationStatus[] | undefined,
  episodeNumbers: number | number[],
  next?: Omit<EpisodeGenerationStatus, "episodeNumber">,
): EpisodeGenerationStatus[] {
  const numbers = Array.isArray(episodeNumbers) ? episodeNumbers : [episodeNumbers];
  const removeSet = new Set(numbers);
  const remaining = (statuses ?? []).filter((status) => !removeSet.has(status.episodeNumber));
  return next
    ? [...remaining, { episodeNumber: numbers[0], ...next }].sort((a, b) => a.episodeNumber - b.episodeNumber)
    : remaining;
}

function emitEpisodeGenerationStatus(
  action: string,
  project: DramaProject,
  episodeNumber: number,
  title: string | undefined,
  status: EpisodeGenerationStatus["status"] | null,
  summary: string,
  error?: string,
): DramaProject {
  return emitDramaRuntimeDelta(
    action,
    {
      ...project,
      currentStep: "episodes",
      episodeGenerationStatuses: updateEpisodeGenerationStatuses(
        project.episodeGenerationStatuses,
        episodeNumber,
        status ? { title: title || `Episode ${episodeNumber}`, status, error } : undefined,
      ),
    },
    summary,
  );
}

function resolveCustomInstruction(input: Record<string, unknown>): string | undefined {
  const customInstruction = typeof input.customInstruction === "string" ? input.customInstruction.trim() : "";
  const fillMissingInstruction =
    input.fillMissingEpisodes === true
      ? "这是自动批量补齐任务：只生成当前目标集正文，严格承接已完成前文和后续目录/细纲，避免重复已写内容，保持人物动机、伏笔回收、情绪节奏和结尾钩子的连续性。"
      : "";

  return [fillMissingInstruction, customInstruction].filter(Boolean).join("\n\n") || undefined;
}

function generateEpisodeRawContent(
  setup: DramaSetup,
  project: DramaProject,
  episodeNumber: number,
  previousEpisodes: EpisodeScript[],
  input: Record<string, unknown>,
  durationSeconds: number,
  abortSignal?: AbortSignal,
): Promise<string> {
  return generateDramaText(
    buildEpisodePrompt(
      setup,
      project.characters,
      project.directory,
      episodeNumber,
      buildPreviousEpisodesText(previousEpisodes, episodeNumber),
      buildNextEpisodesText(project.directory, episodeNumber),
      resolveCustomInstruction(input),
      durationSeconds,
    ),
    abortSignal,
    8192,
  );
}

function isComplianceStrictness(value: unknown): value is ComplianceStrictness {
  return value === "standard" || value === "strict" || value === "extreme";
}

function isComplianceWorkspaceModel(value: unknown): value is ComplianceWorkspaceModel {
  return (
    value === "gemini-3.1-pro-preview" ||
    value === "gemini-3-pro-preview" ||
    value === "gemini-3-flash-preview"
  );
}

function resolveComplianceReviewMode(
  input: Record<string, unknown>,
  project: DramaProject,
  workspace: ComplianceWorkspace,
): ComplianceReviewMode {
  if (input.reviewMode === "script") return "script";
  if (input.reviewMode === "text") return "text";
  if (workspace.reviewMode === "script") return "script";
  if (project.complianceReviewMode === "script") return "script";
  return "text";
}

function resolveComplianceStrictness(
  input: Record<string, unknown>,
  workspace: ComplianceWorkspace,
): ComplianceStrictness {
  return isComplianceStrictness(input.strictness) ? input.strictness : workspace.strictness;
}

function resolveComplianceModel(
  input: Record<string, unknown>,
  workspace: ComplianceWorkspace,
): ComplianceWorkspaceModel {
  return isComplianceWorkspaceModel(input.model) ? input.model : workspace.model;
}

function syncCompliancePacketsWithWorkspace(
  project: DramaProject,
  workspace: ComplianceWorkspace,
): DramaProject {
  return {
    ...project,
    complianceWorkspace: workspace,
    complianceRevisionPackets: deriveComplianceRevisionPackets(
      workspace.riskPhrases,
      workspace.phraseReplacements,
    ),
  };
}

function formatComplianceProgressSummary(workspace: ComplianceWorkspace): string {
  const progress = workspace.progress;
  if (!progress) return "正在同步合规工作台状态。";
  if (progress.status === "processing") {
    return `正在执行完整版合规审查：第 ${Math.max(progress.current, 1)}/${Math.max(progress.total, 1)} 段。`;
  }
  if (progress.status === "done") {
    return `完整版合规审查已完成，共处理 ${progress.completed}/${Math.max(progress.total, 1)} 段。`;
  }
  return "合规工作台状态已更新。";
}

function isSupportedStep(step: unknown): step is DramaStep {
  return [
    "setup",
    "creative-plan",
    "characters",
    "reference-script",
    "structure-transform",
    "character-transform",
    "directory",
    "outlines",
    "episodes",
    "compliance",
    "export",
  ].includes(String(step));
}

export async function enterDramaStepAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const step = input.step;

  if (!isSupportedStep(step)) {
    throw new Error("缺少有效的剧本步骤，无法进入目标阶段。");
  }

  const nextProject: DramaProject = {
    ...project,
    outlineBatchStatuses:
      step === "outlines"
        ? project.outlineBatchStatuses?.length
          ? project.outlineBatchStatuses
          : buildOutlineBatchStatuses(project.directory)
        : project.outlineBatchStatuses,
    preferredEpisodeDurationSeconds:
      step === "episodes" && typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds)
        ? Math.max(1, Math.round(input.durationSeconds))
        : project.preferredEpisodeDurationSeconds,
    currentStep: step,
  };
  const saved = saveDramaProject(nextProject);

  return {
    ...saved,
    summary:
      step === "outlines"
        ? "已进入单集细纲步骤，预览卡已经就绪。接下来请选择细纲生成方式。"
        : step === "episodes"
          ? "已进入分集撰写步骤，预览卡已经就绪。接下来请选择分集生成方式。"
          : saved.summary,
  };
}

export async function setEpisodeDurationPreferenceAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const durationSeconds =
    typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds)
      ? Math.max(1, Math.round(input.durationSeconds))
      : null;

  const saved = saveDramaProject({
    ...project,
    preferredEpisodeDurationSeconds: durationSeconds,
    currentStep: "episodes",
  });

  return {
    ...saved,
    summary: durationSeconds
      ? `已将单集时长设为 ${durationSeconds} 秒。现在可以继续选择要生成的集数或直接${project.episodes.some(isEpisodeContentComplete) ? "自动批量补齐" : "自动批量续写"}。`
      : "已清除单集时长设置。",
  };
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

export async function saveDramaSetupAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const forceNewProject = input.forceNewProject === true;
  const targetProjectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const mode =
    input.projectKind === "adaptation"
      ? "adaptation"
      : runtime.currentProjectSnapshot?.projectKind === "adaptation"
        ? "adaptation"
        : "traditional";
  const project = ensureDramaProject(runtime, mode, {
    forceNew: forceNewProject,
    ...(targetProjectId ? { projectId: targetProjectId } : {}),
  });
  const setup = buildDramaSetup(input, project.setup);
  const title = typeof input.title === "string" ? input.title : project.dramaTitle;
  const referenceScript =
    typeof input.referenceScript === "string"
      ? input.referenceScript
      : project.referenceScript;
  const hasExistingSetup = Boolean(project.setup);
  const hasSetupSeed = hasMeaningfulOriginalSetupSeed(input, project.setup);

  if (mode !== "adaptation" && !hasExistingSetup && !hasSetupSeed) {
    const saved = upsertStoredDramaProject({
      ...project,
      mode,
      dramaTitle: title,
      referenceScript,
      currentStep: "setup",
    });
    const snapshot = createDramaSnapshot(saved);
    return {
      summary: `已记录《${saved.dramaTitle || "未命名项目"}》的会话入口，接下来先确认原创立项方向，再进入创作方案。`,
      projectSnapshot: snapshot,
      data: {
        dramaProject: saved,
        projectSnapshot: snapshot,
      },
    };
  }

  return saveDramaProject({
    ...project,
    mode,
    setup,
    dramaTitle: title,
    referenceScript,
    adaptationEpisodeCountConfirmed:
      mode === "adaptation" ? false : project.adaptationEpisodeCountConfirmed,
    adaptationTargetMarketConfirmed:
      mode === "adaptation" ? false : project.adaptationTargetMarketConfirmed,
    adaptationGenresConfirmed:
      mode === "adaptation" ? false : project.adaptationGenresConfirmed,
    currentStep:
      mode === "adaptation"
        ? "reference-script"
        : "creative-plan",
  });
}

export async function analyzeReferenceScriptAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  const setup = buildDramaSetup(input, project.setup);
  const referenceScript =
    typeof input.referenceScript === "string"
      ? input.referenceScript
      : project.referenceScript ?? "";
  if (!referenceScript.trim()) {
    throw new Error("改编链路需要先提供参考剧本或参考文本。");
  }

  const configPrompt = `你是一位专业的短剧编辑。请分析以下剧本/故事文本，识别其基本属性。

## 剧本文本（前3000字）
${referenceScript.slice(0, 3000)}

## 请以 JSON 格式输出以下字段：
{
  "targetMarket": "cn",
  "audience": "女频|男频|全龄",
  "tone": "甜|虐|甜虐|爽|燃|搞笑",
  "ending": "HE|BE|OE",
  "suggestedEpisodes": 60,
  "reason": "简短说明判断依据"
}

只输出 JSON，不要输出其他任何内容。`;
  const detectedConfig = parseJsonBlock<{
    targetMarket?: unknown;
    audience?: unknown;
    tone?: unknown;
    ending?: unknown;
    suggestedEpisodes?: unknown;
  }>(await generateDramaText(configPrompt, undefined, 2048));
  const mergedSetup = buildReferenceConfigSetup(input, setup, detectedConfig);

  const chunks = splitReferenceScriptIntoChunks(
    referenceScript,
    getReferenceChunkSize(referenceScript),
  );
  const structureParts: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunkPrompt = [
      "你是一位专业的剧本分析师。请提炼以下剧本片段的叙事结构。",
      index === 0 || !structureParts.length
        ? ""
        : `## 前文结构概要\n${structureParts.join("\n\n").slice(-2000)}\n---`,
      `## 剧本片段（第 ${index + 1}/${chunks.length} 段）`,
      chunks[index],
      "",
      "## 提取要求",
      "1. 情节骨架：按叙事顺序列出关键情节点",
      "2. 核心冲突：本段出现的主要矛盾冲突",
      "3. 人物关系变化：本段人物关系的关键变动",
      "4. 转折点/高潮：如有重要转折或高潮点请标注",
      "5. 悬念/伏笔：未解决的悬念或埋下的伏笔",
      index === chunks.length - 1 ? "6. 结局走向：故事的最终走向和结局" : "",
      "",
      "用 Markdown 格式输出，简洁精炼，每个要点不超过两句话。",
    ]
      .filter(Boolean)
      .join("\n");
    const chunkStructure = await generateDramaText(chunkPrompt, undefined, 4096);
    structureParts.push(`### 第 ${index + 1} 段结构\n${chunkStructure}`);
  }

  const referenceStructure =
    structureParts.length === 1
      ? structureParts[0].replace(/^###.*\n/, "").trim()
      : await generateDramaText(
          [
            "你是一位专业的剧本分析师。以下是一部长剧本分段提取的叙事结构，请将它们合并为一份完整、连贯的结构分析报告。",
            "",
            structureParts.join("\n\n---\n\n"),
            "",
            "## 合并要求",
            "1. 故事主线概要（200字以内）",
            "2. 完整情节骨架（按叙事顺序编号列出关键情节点）",
            "3. 核心矛盾冲突（主线冲突 + 副线冲突）",
            "4. 人物关系网（列出主要人物及其关系）",
            "5. 三幕结构拆解（起承转合的集数范围和核心事件）",
            "6. 转折点与高潮标注",
            "7. 悬念/伏笔清单",
            "8. 结局走向",
            "",
            "用 Markdown 格式输出，清晰分区。",
          ].join("\n"),
          undefined,
          6144,
        );

  return saveDramaProject({
    ...project,
    mode: "adaptation",
    setup: mergedSetup,
    referenceScript,
    referenceStructure,
    adaptationEpisodeCountConfirmed: false,
    adaptationTargetMarketConfirmed: false,
    adaptationGenresConfirmed: false,
    currentStep: "structure-transform",
  });
}

export async function confirmAdaptationEpisodeCountAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  const totalEpisodes =
    typeof input.totalEpisodes === "number" && Number.isFinite(input.totalEpisodes)
      ? Math.max(1, Math.round(input.totalEpisodes))
      : null;
  if (!totalEpisodes) {
    throw new Error("请选择有效的改编集数。");
  }

  const setup = buildDramaSetup({ ...input, totalEpisodes }, project.setup);
  return {
    ...saveDramaProject({
      ...project,
      mode: "adaptation",
      setup,
      adaptationEpisodeCountConfirmed: true,
      currentStep: "structure-transform",
    }),
    summary: `已将改编集数设为 ${totalEpisodes} 集。接下来请选择目标市场。`,
  };
}

export async function confirmAdaptationTargetMarketAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  const targetMarket = normalizeTargetMarketToCode(input.targetMarket);
  if (!targetMarket) {
    throw new Error("请选择有效的目标市场。");
  }

  const setup = buildDramaSetup({ ...input, targetMarket }, project.setup);
  return {
    ...saveDramaProject({
      ...project,
      mode: "adaptation",
      setup,
      adaptationTargetMarketConfirmed: true,
      adaptationGenresConfirmed: false,
      currentStep: "structure-transform",
    }),
    summary: "目标市场已确认。接下来请选择方向题材。",
  };
}

function parseAdaptationGenreInput(input: unknown): string[] {
  return String(input ?? "")
    .split(/\n|\/|,|，/)
    .map((item) => item.replace(/^补充[:：]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 2);
}

export async function confirmAdaptationGenresAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  const genres = Array.isArray(input.genres)
    ? input.genres.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 2)
    : parseAdaptationGenreInput(input.genres);
  if (!genres.length) {
    throw new Error("请至少选择 1 个方向题材。");
  }

  const setup = buildDramaSetup({ ...input, genres }, project.setup);
  return {
    ...saveDramaProject({
      ...project,
      mode: "adaptation",
      setup,
      adaptationGenresConfirmed: true,
      currentStep: "structure-transform",
    }),
    summary: `方向题材已确认：${genres.join("、")}。现在可以继续进入结构转换。`,
  };
}

export async function generateCreativePlanAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "traditional");
  const setup = buildDramaSetup(input, project.setup);
  const creativePlan = await generateDramaText(buildCreativePlanPrompt(setup));
  return saveDramaProject({
    ...project,
    mode: "traditional",
    setup,
    creativePlan,
    dramaTitle:
      typeof input.title === "string"
        ? input.title
        : extractDramaTitle(creativePlan) || project.dramaTitle,
    currentStep: "characters",
  });
}

export async function generateStructureTransformAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  if (!project.adaptationEpisodeCountConfirmed) {
    throw new Error("请先确认改编集数，再进入结构转换。");
  }
  if (!project.adaptationTargetMarketConfirmed) {
    throw new Error("请先确认目标市场，再进入结构转换。");
  }
  if (!project.adaptationGenresConfirmed) {
    throw new Error("请先确认方向题材，再进入结构转换。");
  }
  const setup = buildDramaSetup(input, project.setup);
  const referenceScript =
    typeof input.referenceScript === "string"
      ? input.referenceScript
      : project.referenceScript ?? "";
  const frameworkStyle =
    typeof input.frameworkStyle === "string"
      ? input.frameworkStyle
      : project.frameworkStyle ?? "";
  const transformed = await generateDramaText(
    buildStructureTransformPrompt(
      setup,
      referenceScript,
      frameworkStyle,
      typeof input.targetMarket === "string" ? input.targetMarket : undefined,
    ),
  );
  return saveDramaProject({
    ...project,
    mode: "adaptation",
    setup,
    referenceScript,
    frameworkStyle,
    structureTransform: transformed,
    creativePlan: transformed,
    dramaTitle: extractDramaTitle(transformed) || project.dramaTitle,
    currentStep: "character-transform",
  });
}

export async function generateCharactersAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const creativePlan =
    typeof input.creativePlan === "string"
      ? input.creativePlan
      : project.creativePlan || project.structureTransform;
  const characters = await generateDramaText(
    buildCharactersPrompt(setup, creativePlan),
  );
  return saveDramaProject({
    ...project,
    setup,
    creativePlan,
    characters,
    currentStep: "characters",
  });
}

export async function generateCharacterTransformAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = ensureDramaProject(runtime, "adaptation");
  const setup = buildDramaSetup(input, project.setup);
  const referenceScript =
    typeof input.referenceScript === "string"
      ? input.referenceScript
      : project.referenceScript ?? "";
  const frameworkStyle =
    typeof input.frameworkStyle === "string"
      ? input.frameworkStyle
      : project.frameworkStyle ?? "";
  const structureTransform =
    typeof input.structureTransform === "string"
      ? input.structureTransform
      : project.structureTransform ?? "";
  const characters = await generateDramaText(
    buildCharacterTransformPrompt(
      setup,
      referenceScript,
      frameworkStyle,
      structureTransform,
    ),
  );
  return saveDramaProject({
    ...project,
    setup,
    referenceScript,
    frameworkStyle,
    structureTransform,
    characterTransform: characters,
    characters,
    currentStep: "character-transform",
  });
}

export async function generateDirectoryAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const creativePlan =
    typeof input.creativePlan === "string"
      ? input.creativePlan
      : project.creativePlan || project.structureTransform;
  const characters =
    typeof input.characters === "string" ? input.characters : project.characters;
  const directoryRaw = await generateDramaText(
    buildDirectoryPrompt(setup, creativePlan, characters),
  );
  const directory = parseDirectory(directoryRaw);
  if (directory.length !== setup.totalEpisodes) {
    throw new Error(
      `生成集数不匹配：期望 ${setup.totalEpisodes} 集，实际解析到 ${directory.length} 集。请重新生成分集目录。`,
    );
  }
  return saveDramaProject({
    ...project,
    setup,
    creativePlan,
    characters,
    directoryRaw,
    directory,
    outlineBatchStatuses: buildOutlineBatchStatuses(directory),
    episodeQualityReviewPackets: [],
    currentStep: "directory",
  });
}

export async function generateOutlinesAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const creativePlan =
    typeof input.creativePlan === "string"
      ? input.creativePlan
      : project.creativePlan || project.structureTransform;
  const characters =
    typeof input.characters === "string" ? input.characters : project.characters;
  const keepCurrentStep = input.keepCurrentStep === true;
  const customInstruction =
    typeof input.customInstruction === "string" && input.customInstruction.trim()
      ? input.customInstruction.trim()
      : undefined;
  const targets = buildOutlineBatchTargets(project, input);
  if (!targets.length) {
    return saveDramaProject({
      ...project,
      setup,
      creativePlan,
      characters,
      outlineBatchStatuses: resolveOutlineBatchStatuses(project),
      currentStep:
        keepCurrentStep || !project.directory.every((entry) => entry.outline?.trim())
          ? "outlines"
          : "episodes",
    });
  }

  const batchStatuses =
    resolveOutlineBatchStatuses(project).map((status) => ({ ...status }));
  let updatedDirectory = [...project.directory];

  // 注册全局 AbortController，支持从 UI 取消
  const abortController = new AbortController();
  activeAbortControllers.set(OUTLINE_GENERATION_ABORT_KEY, abortController);
  const { signal } = abortController;

  try {
  for (const target of targets) {
    if (signal.aborted) break;
    const batchIndex = batchStatuses.findIndex((batch) => batch.index === target.index);
    // 对于单集/范围模式（index < 0），找到覆盖该集号范围的真实批次
    const coveringBatchIndex = batchIndex >= 0
      ? batchIndex
      : batchStatuses.findIndex(
          (batch) => batch.startEp <= target.startEp && batch.endEp >= target.endEp,
        );

    if (coveringBatchIndex >= 0) {
      batchStatuses[coveringBatchIndex] = { ...batchStatuses[coveringBatchIndex], status: "processing", error: undefined };
      emitDramaRuntimeDelta(
        "generate_outlines",
        {
          ...project,
          setup,
          creativePlan,
          characters,
          directory: updatedDirectory,
          outlineBatchStatuses: [...batchStatuses],
          currentStep: "outlines",
        },
        `正在生成 ${target.label}`,
      );
    }

    const batchEpisodes = updatedDirectory.filter(
      (entry) => entry.number >= target.startEp && entry.number <= target.endEp,
    );
    if (!batchEpisodes.length) continue;

    const prompt = buildOutlinePrompt(
      setup,
      creativePlan,
      characters,
      batchEpisodes.map((entry) => ({
        number: entry.number,
        title: entry.title,
        summary: entry.summary,
        hookType: entry.hookType,
      })),
      project.directoryRaw,
      customInstruction,
      buildOutlineContinuityContext(updatedDirectory, target.startEp, target.endEp),
    );

    try {
      const outlineText = await generateDramaText(prompt, signal, 6144);
      const outlineMap = parseOutlines(outlineText, { enforceLength: true });

      // 逐集写回并实时同步进度条
      for (const ep of batchEpisodes) {
        const outline = outlineMap.get(ep.number);
        if (outline?.trim()) {
          updatedDirectory = updatedDirectory.map((entry) =>
            entry.number === ep.number ? { ...entry, outline } : entry,
          );
          if (coveringBatchIndex >= 0) {
            emitDramaRuntimeDelta(
              "generate_outlines",
              {
                ...project,
                setup,
                creativePlan,
                characters,
                directory: updatedDirectory,
                outlineBatchStatuses: [...batchStatuses],
                currentStep: "outlines",
              },
              `第 ${ep.number} 集细纲已生成`,
            );
          }
        }
      }

      const missingEntries = batchEpisodes.filter((entry) => {
        const current = updatedDirectory.find((candidate) => candidate.number === entry.number);
        return !current?.outline?.trim();
      });

      for (const missing of missingEntries) {
        const singleText = await generateDramaText(
          buildOutlinePrompt(
            setup,
            creativePlan,
            characters,
            [
              {
                number: missing.number,
                title: missing.title,
                summary: missing.summary,
                hookType: missing.hookType,
              },
            ],
            project.directoryRaw,
            customInstruction,
            buildOutlineContinuityContext(updatedDirectory, missing.number, missing.number),
          ),
          signal,
          4096,
        );
        const singleOutline = parseOutlines(singleText, { enforceLength: true }).get(missing.number);
        if (singleOutline?.trim()) {
          updatedDirectory = updatedDirectory.map((entry) =>
            entry.number === missing.number ? { ...entry, outline: singleOutline } : entry,
          );
          if (coveringBatchIndex >= 0) {
            emitDramaRuntimeDelta(
              "generate_outlines",
              {
                ...project,
                setup,
                creativePlan,
                characters,
                directory: updatedDirectory,
                outlineBatchStatuses: [...batchStatuses],
                currentStep: "outlines",
              },
              `第 ${missing.number} 集细纲已生成`,
            );
          }
        }
      }

      const stillMissing = batchEpisodes
        .map((entry) => entry.number)
        .filter((number) => !updatedDirectory.find((entry) => entry.number === number)?.outline?.trim());

      // 对于覆盖批次，检查该批次内所有集是否都已完成，再决定状态
      const effectiveBatchIndex = coveringBatchIndex;
      if (effectiveBatchIndex >= 0) {
        const coveringBatch = batchStatuses[effectiveBatchIndex];
        const allEpsInCoveringBatch = updatedDirectory.filter(
          (entry) => entry.number >= coveringBatch.startEp && entry.number <= coveringBatch.endEp,
        );
        const coveringBatchDone = allEpsInCoveringBatch.every((entry) => entry.outline?.trim());
        batchStatuses[effectiveBatchIndex] = coveringBatchDone
          ? { ...coveringBatch, status: "done", error: undefined }
          : stillMissing.length === 0
            ? { ...coveringBatch, status: "pending", error: undefined }
            : { ...coveringBatch, status: "pending", error: undefined };
        emitDramaRuntimeDelta(
          "generate_outlines",
          {
            ...project,
            setup,
            creativePlan,
            characters,
            directory: updatedDirectory,
            outlineBatchStatuses: [...batchStatuses],
            currentStep: "outlines",
          },
          coveringBatchDone
            ? `${coveringBatch.label} 已完成`
            : `${target.label} 已生成`,
        );
      }
    } catch (error) {
      const isAborted = signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.message === "请求已取消"));
      if (coveringBatchIndex >= 0) {
        batchStatuses[coveringBatchIndex] = isAborted
          ? { ...batchStatuses[coveringBatchIndex], status: "pending", error: undefined }
          : {
              ...batchStatuses[coveringBatchIndex],
              status: "failed",
              error: error instanceof Error ? error.message : "细纲批次生成失败",
            };
        emitDramaRuntimeDelta(
          "generate_outlines",
          {
            ...project,
            setup,
            creativePlan,
            characters,
            directory: updatedDirectory,
            outlineBatchStatuses: [...batchStatuses],
            currentStep: "outlines",
          },
          isAborted
            ? `${batchStatuses[coveringBatchIndex].label} 已停止`
            : `${batchStatuses[coveringBatchIndex].label} 生成失败`,
        );
      }
    }
  }
  } finally {
    activeAbortControllers.delete(OUTLINE_GENERATION_ABORT_KEY);
  }

  const refreshedStatuses = batchStatuses.map((status) => {
    const batchEpisodes = updatedDirectory.filter(
      (entry) => entry.number >= status.startEp && entry.number <= status.endEp,
    );
    if (batchEpisodes.length && batchEpisodes.every((entry) => entry.outline?.trim())) {
      return { ...status, status: "done" as const, error: undefined };
    }
    if (status.status === "done") {
      return { ...status, status: "pending" as const };
    }
    return status;
  });

  return saveDramaProject({
    ...project,
    setup,
    creativePlan,
    characters,
    directory: updatedDirectory,
    outlineBatchStatuses: refreshedStatuses,
    currentStep:
      keepCurrentStep || !updatedDirectory.every((entry) => entry.outline?.trim())
        ? "outlines"
        : "episodes",
  });
}

export async function generateEpisodeAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const durationSeconds = resolveEpisodeDurationSeconds(input, project);
  const episodeNumber =
    typeof input.episodeNumber === "number"
      ? input.episodeNumber
      : project.directory.find(
        (entry) =>
            !project.episodes.some((episode) => episode.number === entry.number),
        )?.number ?? 1;
  if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error("目标集号无效，请先确认要生成的分集编号。");
  }
  assertEpisodeNumbersExistInDirectory(project, [episodeNumber]);
  assertSequentialEpisodeAvailable(project, episodeNumber);
  const entry = project.directory.find((item) => item.number === episodeNumber);
  const abortSignal = resolveWorkflowAbortSignal(input);
  let workingProject = emitEpisodeGenerationStatus(
    "generate_episode",
    { ...project, setup, preferredEpisodeDurationSeconds: durationSeconds },
    episodeNumber,
    entry?.title,
    "processing",
    `Generating episode ${episodeNumber}`,
  );

  let rawContent: string;
  try {
    rawContent = await generateEpisodeRawContent(
      setup,
      project,
      episodeNumber,
      project.episodes,
      input,
      durationSeconds,
      abortSignal,
    );
  } catch (error) {
    workingProject = emitEpisodeGenerationStatus(
      "generate_episode",
      workingProject,
      episodeNumber,
      entry?.title,
      abortSignal?.aborted ? null : "failed",
      abortSignal?.aborted
        ? `Episode ${episodeNumber} generation stopped`
        : `Episode ${episodeNumber} generation failed`,
      error instanceof Error ? error.message : "分集正文生成失败",
    );
    throw error;
  }

  const content = removeTriangleFromDialogue(rawContent);
  const nextEpisode: EpisodeScript = {
    number: episodeNumber,
    title: entry?.title || `第${episodeNumber}集`,
    content,
    wordCount: content.length,
  };
  const episodes = [
    ...project.episodes.filter((episode) => episode.number !== episodeNumber),
    nextEpisode,
  ].sort((a, b) => a.number - b.number);
  return saveDramaProject({
    ...workingProject,
    setup,
    episodes,
    complianceReport: "",
    complianceRevisionPackets: [],
    exportDocument: "",
    preferredEpisodeDurationSeconds: durationSeconds,
    episodeQualityReviewPackets: (project.episodeQualityReviewPackets ?? []).filter(
      (packet) => packet.episodeNumber !== episodeNumber,
    ),
    lastEpisodeQualityReviewBatch: clearLastEpisodeQualityReviewBatch(
      workingProject.lastEpisodeQualityReviewBatch,
      [episodeNumber],
    ),
    episodeGenerationStatuses: updateEpisodeGenerationStatuses(
      workingProject.episodeGenerationStatuses,
      episodeNumber,
    ),
    currentStep: "episodes",
  });
}

export async function generateEpisodeBatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const durationSeconds = resolveEpisodeDurationSeconds(input, project);
  const requestedEpisodeNumbers = normalizeEpisodeNumberList(input.episodeNumbers);
  const hasRequestedEpisodeNumbers = Array.isArray(input.episodeNumbers);
  const autoFillMissingEpisodes =
    !hasRequestedEpisodeNumbers && project.episodes.some(isEpisodeContentComplete);
  const fillMissingEpisodes = input.fillMissingEpisodes === true || autoFillMissingEpisodes;
  const generationInput =
    fillMissingEpisodes && input.fillMissingEpisodes !== true
      ? { ...input, fillMissingEpisodes: true }
      : input;
  const targetEpisodeNumbers = (
    requestedEpisodeNumbers.length ? requestedEpisodeNumbers : listPendingEpisodeNumbers(project)
  ).sort((a, b) => a - b);

  if (hasRequestedEpisodeNumbers && !requestedEpisodeNumbers.length) {
    throw new Error("未识别到可生成的集号，请重新输入目录内的集数或范围。");
  }
  assertEpisodeNumbersExistInDirectory(project, targetEpisodeNumbers);
  assertBatchEpisodeDependencies(project, targetEpisodeNumbers);

  if (!targetEpisodeNumbers.length) {
    return {
      ...saveDramaProject({
        ...project,
        setup,
        currentStep: "episodes",
      }),
      summary: "当前没有待生成的分集正文。",
    };
  }

  const abortSignal = resolveWorkflowAbortSignal(input);
  let nextEpisodes = [...project.episodes].sort((a, b) => a.number - b.number);
  let workingProject: DramaProject = {
    ...project,
    setup,
    currentStep: "episodes",
    preferredEpisodeDurationSeconds: durationSeconds,
  };
  for (const episodeNumber of targetEpisodeNumbers) {
    const entry = project.directory.find((item) => item.number === episodeNumber);
    workingProject = emitEpisodeGenerationStatus(
      "generate_episode_batch",
      { ...workingProject, episodes: nextEpisodes },
      episodeNumber,
      entry?.title,
      "processing",
      `Generating episode ${episodeNumber}`,
    );

    let rawContent: string;
    try {
      rawContent = await generateEpisodeRawContent(
        setup,
        project,
        episodeNumber,
        nextEpisodes,
        generationInput,
        durationSeconds,
        abortSignal,
      );
    } catch (error) {
      workingProject = emitEpisodeGenerationStatus(
        "generate_episode_batch",
        workingProject,
        episodeNumber,
        entry?.title,
        abortSignal?.aborted ? null : "failed",
        abortSignal?.aborted
          ? `Episode ${episodeNumber} generation stopped`
          : `Episode ${episodeNumber} generation failed`,
        error instanceof Error ? error.message : "分集正文生成失败",
      );
      throw error;
    }
    const content = removeTriangleFromDialogue(rawContent);
    const nextEpisode: EpisodeScript = {
      number: episodeNumber,
      title: entry?.title || `第 ${episodeNumber} 集`,
      content,
      wordCount: content.length,
    };
    nextEpisodes = [
      ...nextEpisodes.filter((episode) => episode.number !== episodeNumber),
      nextEpisode,
    ].sort((a, b) => a.number - b.number);
    workingProject = emitDramaRuntimeDelta(
      "generate_episode_batch",
      {
        ...workingProject,
        episodes: nextEpisodes,
        episodeGenerationStatuses: updateEpisodeGenerationStatuses(
          workingProject.episodeGenerationStatuses,
          episodeNumber,
        ),
      },
      `Episode ${episodeNumber} generated`,
    );
  }

  const saved = saveDramaProject({
    ...workingProject,
    setup,
    episodes: nextEpisodes,
    complianceReport: "",
    complianceRevisionPackets: [],
    exportDocument: "",
    episodeQualityReviewPackets: (project.episodeQualityReviewPackets ?? []).filter(
      (packet) => !targetEpisodeNumbers.includes(packet.episodeNumber),
    ),
    lastEpisodeQualityReviewBatch: clearLastEpisodeQualityReviewBatch(
      workingProject.lastEpisodeQualityReviewBatch,
      targetEpisodeNumbers,
    ),
    episodeGenerationStatuses: updateEpisodeGenerationStatuses(
      workingProject.episodeGenerationStatuses,
      targetEpisodeNumbers,
    ),
    currentStep: "episodes",
  });

  return {
    ...saved,
    summary: fillMissingEpisodes
      ? `已按目录顺序补齐 ${targetEpisodeNumbers.length} 集剩余分集正文。`
      : `已按顺序完成 ${targetEpisodeNumbers.length} 集分集撰写。`,
  };
}

export async function reviewEpisodeQualityAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const { batch, targetEpisodes } = resolveEpisodeReviewTargets(project, input);
  const batchReviewedAt = batch.reviewedAt;

  const packetMap = new Map(
    (project.episodeQualityReviewPackets ?? []).map((packet) => [packet.episodeNumber, packet] as const),
  );
  const completedPackets: EpisodeQualityReviewPacket[] = [];
  let workingProject: DramaProject = {
    ...project,
    setup,
    currentStep: "episodes",
  };
  let nextEpisodeIndex = 0;
  let firstError: unknown = null;

  const persistCompletedReviewPacket = (packet: EpisodeQualityReviewPacket) => {
    packetMap.set(packet.episodeNumber, packet);
    completedPackets.push(packet);
    const reviewedEpisodeNumbers = completedPackets
      .map((item) => item.episodeNumber)
      .sort((left, right) => left - right);
    workingProject = emitDramaRuntimeDelta(
      "review_episode_quality",
      {
        ...workingProject,
        setup,
        episodeQualityReviewPackets: [...packetMap.values()].sort((a, b) => a.episodeNumber - b.episodeNumber),
        lastEpisodeQualityReviewBatch: {
          ...batch,
          reviewedAt: batchReviewedAt,
          episodeNumbers: reviewedEpisodeNumbers,
          requestedCount:
            batch.mode === "episodes" ? reviewedEpisodeNumbers.length : batch.requestedCount ?? null,
        },
        currentStep: "episodes",
      },
      `Episode ${packet.episodeNumber} reviewed`,
    );
  };

  const workerCount = Math.min(2, targetEpisodes.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (firstError == null) {
        const currentIndex = nextEpisodeIndex;
        nextEpisodeIndex += 1;
        if (currentIndex >= targetEpisodes.length) return;

        const episode = targetEpisodes[currentIndex];
        const previousEpisode = project.episodes.find((item) => item.number === episode.number - 1);
        const nextEpisode = project.episodes.find((item) => item.number === episode.number + 1);

        try {
          const reviewText = await generateDramaText(
            buildReviewPrompt(
              setup,
              project.characters,
              project.directory,
              episode.number,
              episode.content,
              previousEpisode?.content,
              nextEpisode?.content,
            ),
            undefined,
            3072,
          );
          const reviewResult = parseReviewResult(reviewText);
          if (!reviewResult) continue;
          const packet: EpisodeQualityReviewPacket = {
            id: `${project.id}-episode-review-${episode.number}`,
            episodeNumber: episode.number,
            title: episode.title,
            reviewedAt: batchReviewedAt,
            result: reviewResult,
            rewriteInstruction: "",
          };
          packet.rewriteInstruction = buildEpisodeReviewRewriteInstruction(packet);
          persistCompletedReviewPacket(packet);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    }),
  );

  if (!completedPackets.length) {
    if (firstError) throw firstError;
    throw new Error("本轮质检没有拿到可解析的结构化结果。");
  }

  const mergedPackets = [...packetMap.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const reviewedEpisodeNumbers = completedPackets
    .map((packet) => packet.episodeNumber)
    .sort((left, right) => left - right);
  const saved = saveDramaProject({
    ...workingProject,
    setup,
    episodeQualityReviewPackets: mergedPackets,
    lastEpisodeQualityReviewBatch: {
      ...batch,
      reviewedAt: batchReviewedAt,
      episodeNumbers: reviewedEpisodeNumbers,
      requestedCount:
        batch.mode === "episodes" ? reviewedEpisodeNumbers.length : batch.requestedCount ?? null,
    },
    currentStep: "episodes",
  });

  // 将质检结果写入学习存储，供后续同类项目参考
  try {
    const { recordQualityPattern } = await import("@/lib/home-agent/agent-learning-store");
    completedPackets.forEach((packet) => recordQualityPattern(project, packet));
  } catch {
    /* 学习存储写入失败不影响主流程 */
  }

  if (firstError) throw firstError;

  return {
    ...saved,
    summary: buildEpisodeReviewBatchSummary(completedPackets),
  };
}

export async function rewriteEpisodeFromReviewAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const packets = [...(project.episodeQualityReviewPackets ?? [])].sort(
    (a, b) => a.result.total - b.result.total,
  );
  if (input.repairAll === true) {
    const repairLimit = Math.min(parseRequestedCount(input.repairLimit) ?? 10, 10);
    const targetPackets = [...packets]
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
      .slice(0, repairLimit);
    if (!targetPackets.length) {
      throw new Error("当前没有可用于批量修复的质检结果。");
    }

    let workingProject = project;
    let lastResult: WorkflowActionResult | null = null;
    for (const packet of targetPackets) {
      lastResult = await generateEpisodeAction(
        {
          ...input,
          episodeNumber: packet.episodeNumber,
          customInstruction: packet.rewriteInstruction,
        },
        {
          ...runtime,
          currentDramaProject: workingProject,
        },
      );
      workingProject = lastResult.data?.dramaProject ?? workingProject;
    }

    const repairedEpisodeNumbers = new Set(targetPackets.map((packet) => packet.episodeNumber));
    const saved = saveDramaProject({
      ...workingProject,
      episodeQualityReviewPackets: (workingProject.episodeQualityReviewPackets ?? []).filter(
        (packet) => !repairedEpisodeNumbers.has(packet.episodeNumber),
      ),
      currentStep: "episodes",
    });
    return {
      ...saved,
      summary: `已按质检结果修复 ${targetPackets.length} 集。`,
    };
  }

  const requestedEpisodeNumber =
    typeof input.episodeNumber === "number" && Number.isFinite(input.episodeNumber)
      ? input.episodeNumber
      : null;
  const targetPacket =
    requestedEpisodeNumber != null
      ? packets.find((packet) => packet.episodeNumber === requestedEpisodeNumber)
      : packets[0];

  if (!targetPacket) {
    throw new Error("当前没有可用于定向修复的质检结果。");
  }

  const generated = await generateEpisodeAction(
    {
      ...input,
      episodeNumber: targetPacket.episodeNumber,
      customInstruction:
        typeof input.customInstruction === "string" && input.customInstruction.trim()
          ? input.customInstruction.trim()
          : targetPacket.rewriteInstruction,
    },
    runtime,
  );
  const nextProject = generated.data?.dramaProject;
  if (!nextProject) return generated;

  return saveDramaProject({
    ...nextProject,
    episodeQualityReviewPackets: (nextProject.episodeQualityReviewPackets ?? []).filter(
      (packet) => packet.episodeNumber !== targetPacket.episodeNumber,
    ),
    currentStep: "episodes",
  });
}

export async function runComplianceReviewAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const reviewMode = resolveComplianceReviewMode(input, project, workspace);
  const strictness = resolveComplianceStrictness(input, workspace);
  const model = resolveComplianceModel(input, workspace);
  const sourceText = buildComplianceSourceText(project, input).trim();
  const dialogueReviewEnabled =
    typeof input.dialogueReviewEnabled === "boolean"
      ? input.dialogueReviewEnabled
      : workspace.dialogueReviewEnabled;

  if (!sourceText) {
    throw new Error("缺少待审文本，无法启动完整版合规审查。");
  }

  const smartRerunPlan = input.smartRerun === true ? buildSmartComplianceRerunPlan(sourceText, workspace) : null;
  if (smartRerunPlan?.mode === "reuse") {
    const carriedRiskPhrases = anchorComplianceRiskPhrases(sourceText, smartRerunPlan.carriedRiskPhrases);
    const report = buildSmartComplianceReport(
      smartRerunPlan.repairedCount,
      carriedRiskPhrases,
      0,
      "",
    );
    const finalWorkspace = buildComplianceWorkspaceFromReview(
      normalizeComplianceWorkspace({
        ...workspace,
        sourceText,
        reviewMode,
        strictness,
        model,
        dialogueReviewEnabled,
        segments: [],
        progress: null,
      }),
      sourceText,
      carriedRiskPhrases,
      report,
      0,
    );
    return saveDramaProject({
      ...project,
      complianceReport: report,
      complianceWorkspace: finalWorkspace,
      complianceReviewMode: reviewMode,
      complianceRevisionPackets: deriveComplianceRevisionPackets(
        finalWorkspace.riskPhrases,
        finalWorkspace.phraseReplacements,
      ),
      complianceSkippedAt: null,
      currentStep: "compliance",
    });
  }

  const reviewSourceText =
    smartRerunPlan?.mode === "incremental" ? smartRerunPlan.incrementalSourceText : sourceText;

  const freshWorkspace = normalizeComplianceWorkspace({
    ...workspace,
    sourceText: reviewSourceText,
    reviewMode,
    strictness,
    model,
    paletteText: reviewSourceText,
    riskPhrases: [],
    riskSpans: [],
    phraseReplacements: {},
    segments: [],
    progress: null,
    latestReview: null,
    history: [],
    historyIndex: -1,
    dialogueReviewEnabled,
    dialogueOverLimitLineIndexes: [],
  });

  let workingProject: DramaProject = {
    ...project,
    complianceReport: "",
    complianceRevisionPackets: [],
    complianceReviewMode: reviewMode,
    complianceSkippedAt: null,
    currentStep: "compliance" as const,
    complianceWorkspace: freshWorkspace,
  };

  workingProject = emitDramaRuntimeDelta(
    "run_compliance_review",
    workingProject,
    "正在启动完整版合规审查。",
  );

  const result = await executeComplianceReview({
    sourceText: reviewSourceText,
    workspace: normalizeComplianceWorkspace(workingProject.complianceWorkspace),
    reviewMode,
    strictness,
    model,
    generateSegment: (prompt) =>
      generateDramaText(prompt, undefined, 6144, model, undefined, COMPLIANCE_REVIEW_TEMPERATURE),
    onProgress: (nextWorkspace) => {
      workingProject = emitDramaRuntimeDelta(
        "run_compliance_review",
        {
          ...workingProject,
          complianceWorkspace: nextWorkspace,
          complianceReviewMode: reviewMode,
          complianceSkippedAt: null,
          currentStep: "compliance",
        },
        formatComplianceProgressSummary(nextWorkspace),
      );
    },
  });
  const finalReport =
    smartRerunPlan?.mode === "incremental"
      ? buildSmartComplianceReport(
          smartRerunPlan.repairedCount,
          smartRerunPlan.carriedRiskPhrases,
          result.workspace.riskPhrases.length,
          result.report,
        )
      : result.report;
  const finalWorkspace =
    smartRerunPlan?.mode === "incremental"
      ? buildComplianceWorkspaceFromReview(
          normalizeComplianceWorkspace({
            ...result.workspace,
            sourceText,
            reviewMode,
            strictness,
            model,
            dialogueReviewEnabled,
          }),
          sourceText,
          mergeComplianceRiskPhrases(
            anchorComplianceRiskPhrases(sourceText, smartRerunPlan.carriedRiskPhrases),
            anchorComplianceRiskPhrases(sourceText, result.workspace.riskPhrases),
          ),
          finalReport,
          result.workspace.latestReview?.segmentCount ?? result.workspace.segments.length,
        )
      : buildComplianceWorkspaceFromReview(
          normalizeComplianceWorkspace({
            ...result.workspace,
            sourceText,
            reviewMode,
            strictness,
            model,
            dialogueReviewEnabled,
          }),
          sourceText,
          result.workspace.riskPhrases,
          finalReport,
          result.workspace.latestReview?.segmentCount ?? result.workspace.segments.length,
        );
  const finalPackets = deriveComplianceRevisionPackets(
    finalWorkspace.riskPhrases,
    finalWorkspace.phraseReplacements,
  );

  return saveDramaProject({
    ...workingProject,
    complianceReport: finalReport,
    complianceWorkspace: finalWorkspace,
    complianceReviewMode: reviewMode,
    complianceRevisionPackets: finalPackets,
    complianceSkippedAt: null,
    currentStep: "compliance",
  });
}

export async function skipComplianceReviewAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const skippedAt = new Date().toISOString();
  return saveDramaProject({
    ...project,
    complianceWorkspace: normalizeComplianceWorkspace({
      ...workspace,
      latestReview: {
        reviewedAt: workspace.latestReview?.reviewedAt ?? skippedAt,
        segmentCount: workspace.latestReview?.segmentCount ?? workspace.segments.length,
        sourceLength:
          workspace.latestReview?.sourceLength ??
          (workspace.sourceText || buildComplianceSourceText(project, input)).length,
        reportLength: workspace.latestReview?.reportLength ?? project.complianceReport.length,
        skippedAt,
      },
      progress: workspace.progress
        ? { ...workspace.progress, status: "idle", updatedAt: skippedAt }
        : workspace.progress,
    }),
    complianceSkippedAt: skippedAt,
    currentStep: "export",
  });
}

export async function updateComplianceWorkspaceAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  let workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const operation = typeof input.operation === "string" ? input.operation : null;

  if (operation === "undo") {
    workspace = applyComplianceUndo(workspace);
  } else if (operation === "redo") {
    workspace = applyComplianceRedo(workspace);
  } else {
    const importFile =
      typeof File !== "undefined" && input.file instanceof File ? input.file : null;
    if (importFile) {
      const imported = await parseComplianceImportFile(importFile);
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        sourceText: imported.sourceText,
        paletteText: workspace.paletteText.trim() || imported.sourceText,
        tableSnapshot: imported.tableSnapshot,
        lastImportedFileName: importFile.name,
        lastImportedAt: new Date().toISOString(),
      });
    }

    if (typeof input.sourceText === "string") {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        sourceText: input.sourceText,
      });
    }

    if (typeof input.paletteText === "string") {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        paletteText: input.paletteText,
      });
    }

    if (input.reviewMode === "text" || input.reviewMode === "script") {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        reviewMode: input.reviewMode,
      });
    }

    if (isComplianceStrictness(input.strictness)) {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        strictness: input.strictness,
      });
    }

    if (isComplianceWorkspaceModel(input.model)) {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        model: input.model,
      });
    }

    if (typeof input.dialogueReviewEnabled === "boolean") {
      workspace = normalizeComplianceWorkspace({
        ...workspace,
        dialogueReviewEnabled: input.dialogueReviewEnabled,
      });
    }
  }

  if (!workspace.paletteText.trim() && workspace.sourceText.trim()) {
    workspace = normalizeComplianceWorkspace({
      ...workspace,
      paletteText: workspace.sourceText,
      history: workspace.history.length ? workspace.history : [workspace.sourceText],
      historyIndex: workspace.history.length ? workspace.historyIndex : 0,
    });
  }

  const dialogueReview = applyDialogueReviewMarkers(
    workspace.paletteText || workspace.sourceText,
    workspace.dialogueReviewEnabled,
  );
  workspace = normalizeComplianceWorkspace({
    ...workspace,
    paletteText: dialogueReview.paletteText,
    dialogueOverLimitLineIndexes: dialogueReview.lineIndexes,
    history: workspace.history.length
      ? workspace.history.map((entry, index) =>
          index === workspace.historyIndex ? dialogueReview.paletteText : entry,
        )
      : workspace.history,
  });

  const nextProject = syncCompliancePacketsWithWorkspace(
    {
      ...project,
      complianceWorkspace: workspace,
      complianceReviewMode: workspace.reviewMode,
      currentStep: "compliance",
    },
    workspace,
  );

  return saveDramaProject(nextProject);
}

export async function applyComplianceAdjustmentAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const riskId =
    typeof input.riskId === "string"
      ? input.riskId
      : typeof input.workspaceRiskId === "string"
        ? input.workspaceRiskId
        : null;

  if (!riskId) {
    throw new Error("缺少需要处理的合规风险项。");
  }

  const replacement =
    typeof input.replacement === "string"
      ? input.replacement
      : typeof input.text === "string"
        ? input.text
        : "";

  const nextWorkspace = replacement.trim()
    ? applyComplianceReplacement({
        workspace,
        riskId,
        replacement,
      })
    : normalizeComplianceWorkspace({
        ...workspace,
        riskPhrases: workspace.riskPhrases.map((phrase) =>
          phrase.id === riskId ? { ...phrase, status: "resolved" } : phrase,
        ),
      });

  return saveDramaProject(
    syncCompliancePacketsWithWorkspace(
      {
        ...project,
        complianceWorkspace: nextWorkspace,
        complianceReviewMode: nextWorkspace.reviewMode,
        currentStep: "compliance",
      },
      nextWorkspace,
    ),
  );
}

export async function autoAdjustComplianceAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  let workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const pendingPhrases = workspace.riskPhrases.filter((phrase) => phrase.status !== "resolved");

  if (!pendingPhrases.length) {
    return saveDramaProject({
      ...project,
      complianceWorkspace: workspace,
      currentStep: "compliance",
    });
  }

  const response = await generateDramaText(
    [
      "你是短剧合规改写助手。请为每一条风险片段生成更安全、语义尽量等效的替代表达。",
      "只返回 JSON，不要解释。",
      '输出格式：{"items":[{"id":"risk-id","replacement":"改写文本"}]}',
      "",
      "风险列表：",
      ...pendingPhrases.map(
        (phrase) =>
          `- id: ${phrase.id}\n  text: ${phrase.text}\n  reason: ${phrase.reason || "请弱化敏感表达并保留剧情功能"}`,
      ),
    ].join("\n"),
    undefined,
    4096,
    workspace.model,
  );

  const parsed = parseJsonBlock<{ items?: Array<{ id?: string; replacement?: string }> }>(response);
  const replacements = Array.isArray(parsed?.items) ? parsed.items : [];

  replacements.forEach((item) => {
    if (!item?.id || typeof item.replacement !== "string" || !item.replacement.trim()) return;
    workspace = applyComplianceReplacement({
      workspace,
      riskId: item.id,
      replacement: item.replacement,
    });
  });

  // 将所有仍处于 pending 状态的风险片段标记为已解决（一键修复）
  let nextProject = project;
  if (input.sourceStrategy === "project-script") {
    const synced = syncComplianceWorkspaceToProjectScript(project, workspace);
    if (synced) {
      workspace = synced.workspace;
      nextProject = {
        ...project,
        episodes: synced.episodes,
      };
    }
  }

  return saveDramaProject(
    syncCompliancePacketsWithWorkspace(
      {
        ...nextProject,
        complianceWorkspace: workspace,
        complianceReviewMode: workspace.reviewMode,
        currentStep: "compliance",
      },
      workspace,
    ),
  );
}

export async function exportCompliancePaletteAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const project = buildPlanningDramaProject(runtime, input);
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const format =
    input.format === "xlsx" || input.format === "docx"
      ? input.format
      : workspace.tableSnapshot
        ? "xlsx"
        : "docx";

  const fileName =
    format === "xlsx" && workspace.tableSnapshot
      ? await exportCompliancePaletteAsXlsx({
          dramaTitle: project.dramaTitle,
          tableSnapshot: workspace.tableSnapshot,
          riskPhrases: workspace.riskPhrases,
        })
      : await exportCompliancePaletteAsDocx({
          dramaTitle: project.dramaTitle,
          sourceText: workspace.sourceText,
          paletteText: workspace.paletteText || workspace.sourceText,
          riskPhrases: workspace.riskPhrases,
        });

  return saveDramaProject({
    ...project,
    complianceWorkspace: normalizeComplianceWorkspace({
      ...workspace,
      exportMeta: {
        lastExportedAt: new Date().toISOString(),
        lastExportFormat: format,
        lastExportFileName: fileName,
      },
    }),
    currentStep: "compliance",
  });
}

export async function analyzeExportPatchAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const exportPatchPlan = buildExportPatchPlan({
    ...project,
    setup,
  });
  const saved = saveDramaProject({
    ...project,
    setup,
    exportPatchPlan,
  });

  const topEntries = exportPatchPlan.entries
    .slice(0, 3)
    .map((entry) => `- [${entry.priority}] ${entry.title}: ${entry.summary}`)
    .join("\n");

  return {
    ...saved,
    summary: topEntries
      ? `${exportPatchPlan.summary}\n\n${topEntries}`
      : exportPatchPlan.summary,
  };
}

export async function updateDramaArtifactTextAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const field =
    typeof input.field === "string" ? (input.field as ConversationArtifactEditorField) : null;
  const text = typeof input.text === "string" ? input.text : "";
  const mode = resolveDramaMode(runtime, input);
  const project = ensureDramaProject(runtime, mode);

  if (!field) {
    throw new Error("缺少可编辑产物字段，无法保存文本。");
  }

  const trimmedText = text.trim();

  if (field === "creativePlan") {
    return saveDramaProject({
      ...project,
      creativePlan: trimmedText,
      structureTransform:
        project.mode === "adaptation" && project.structureTransform?.trim()
          ? trimmedText
          : project.structureTransform,
    });
  }

  if (field === "structureTransform") {
    return saveDramaProject({
      ...project,
      structureTransform: trimmedText,
      creativePlan: trimmedText,
    });
  }

  if (field === "characters") {
    return saveDramaProject({
      ...project,
      characters: trimmedText,
      characterTransform:
        project.mode === "adaptation" && project.characterTransform?.trim()
          ? trimmedText
          : project.characterTransform,
    });
  }

  if (field === "characterTransform") {
    return saveDramaProject({
      ...project,
      characterTransform: trimmedText,
      characters: trimmedText,
    });
  }

  if (field === "directoryRaw") {
    const parsedDirectory = parseDirectory(trimmedText);
    if (trimmedText && parsedDirectory.length === 0) {
      throw new Error("分集目录文本无法识别，请按“第1集 - 标题 - 简介”这类格式保存。");
    }
    const nextDirectory = mergeDirectoryWithExistingOutlines(parsedDirectory, project.directory);
    return saveDramaProject({
      ...project,
      directoryRaw: trimmedText,
      directory: nextDirectory,
      outlineBatchStatuses: buildOutlineBatchStatuses(nextDirectory),
    });
  }

  if (field === "outlines") {
    const outlineMap = parseOutlines(trimmedText);
    if (trimmedText && outlineMap.size === 0) {
      throw new Error("单集细纲文本无法识别，请保留“【第X集细纲】”这样的分节标题。");
    }
    const nextDirectory = applyOutlineEditsToDirectory(project.directory, outlineMap);
    return saveDramaProject({
      ...project,
      directory: nextDirectory,
      outlineBatchStatuses: buildOutlineBatchStatuses(nextDirectory),
    });
  }

  throw new Error(`不支持保存该产物字段：${field}`);
}

export async function refineDramaExportAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const baseExport =
    project.exportDocument?.trim() ||
    buildQuickExportMarkdown(
      setup,
      project.dramaTitle,
      project.creativePlan || project.structureTransform || "",
      project.characters,
      project.episodes,
    );
  const prompt = [
    "你是一位短剧交付编辑。请在不破坏原始结构的前提下，对下面的导出稿做精修。",
    "",
    "## 目标",
    "1. 统一章节和标题格式",
    "2. 提高可读性和交付规范度",
    "3. 保留后续衔接视频工作流需要的角色、场景、分集信息",
    "4. 不要删减关键剧情内容",
    "",
    "## 当前导出稿",
    baseExport,
  ].join("\n");
  const exportDocument = await generateDramaText(prompt, undefined, 12288);
  return saveDramaProject({
    ...project,
    setup,
    exportDocument,
    currentStep: "export",
  });
}

export async function lockCharacterCardsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const targetIds = collectTargetIds(input);
  const characterStateCards = (project.characterStateCards ?? []).map((card) =>
    !targetIds.length || targetIds.includes(card.id)
      ? { ...card, status: "locked" as const }
      : card,
  );

  return saveDramaProject({
    ...project,
    setup,
    characterStateCards,
    currentStep:
      project.currentStep === "creative-plan" || project.currentStep === "characters" || project.currentStep === "character-transform"
        ? "directory"
        : project.currentStep,
  });
}

export async function lockStoryBeatsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const targetIds = collectTargetIds(input);
  const storyBeatPackets = (project.storyBeatPackets ?? []).map((packet) =>
    !targetIds.length || targetIds.includes(packet.id)
      ? { ...packet, status: "locked" as const }
      : packet,
  );

  return saveDramaProject({
    ...project,
    setup,
    storyBeatPackets,
    currentStep: project.currentStep === "directory" ? "outlines" : project.currentStep,
  });
}

export async function resolveComplianceRevisionsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const targetIds = collectTargetIds(input);
  const complianceRevisionPackets = (project.complianceRevisionPackets ?? []).map((packet) =>
    !targetIds.length || targetIds.includes(packet.id)
      ? { ...packet, status: "resolved" as const }
      : packet,
  );
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const resolvedRiskIds = new Set(
    complianceRevisionPackets
      .filter((packet) => packet.status === "resolved")
      .map((packet) => packet.workspaceRiskId)
      .filter((value): value is string => typeof value === "string"),
  );

  return saveDramaProject({
    ...project,
    setup,
    complianceWorkspace: normalizeComplianceWorkspace({
      ...workspace,
      riskPhrases: workspace.riskPhrases.map((phrase) =>
        resolvedRiskIds.has(phrase.id) ? { ...phrase, status: "resolved" } : phrase,
      ),
    }),
    complianceRevisionPackets,
    currentStep: "export",
  });
}

export async function reopenComplianceRevisionsAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const targetIds = collectTargetIds(input);
  const complianceRevisionPackets = (project.complianceRevisionPackets ?? []).map((packet) =>
    !targetIds.length || targetIds.includes(packet.id)
      ? { ...packet, status: "pending" as const }
      : packet,
  );
  const workspace = normalizeComplianceWorkspace(
    project.complianceWorkspace ?? createEmptyComplianceWorkspace(),
  );
  const reopenedRiskIds = new Set(
    complianceRevisionPackets
      .filter((packet) => packet.status === "pending")
      .map((packet) => packet.workspaceRiskId)
      .filter((value): value is string => typeof value === "string"),
  );

  return saveDramaProject({
    ...project,
    setup,
    complianceWorkspace: normalizeComplianceWorkspace({
      ...workspace,
      riskPhrases: workspace.riskPhrases.map((phrase) =>
        reopenedRiskIds.has(phrase.id) ? { ...phrase, status: "pending" } : phrase,
      ),
    }),
    complianceRevisionPackets,
    currentStep: "compliance",
  });
}

export async function exportDramaProjectAction(
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): Promise<WorkflowActionResult> {
  const mode =
    runtime.currentProjectSnapshot?.projectKind === "adaptation"
      ? "adaptation"
      : "traditional";
  const project = ensureDramaProject(runtime, mode);
  const setup = buildDramaSetup(input, project.setup);
  const exportText = await generateDramaText(
    buildExportPrompt(
      setup,
      project.dramaTitle,
      project.creativePlan || project.structureTransform || "",
      project.characters,
      project.episodes,
    ),
    undefined,
    12288,
  );
  return saveDramaProject({
    ...project,
    setup,
    exportDocument: exportText,
    currentStep: "export",
  });
}
