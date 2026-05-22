import { startTransition, useCallback, useRef } from "react";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { Message, MessageInput } from "@/lib/agent/types";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import { getAllTasks, stopTask, type Task as BackgroundTask } from "@/lib/agent/tools/task-tools";
import { useState } from "react";
import { useEffect } from "react";
import { readStudioProjectSession } from "@/lib/home-agent/session-store";
import {
  buildOriginalScriptKickoffIntro,
  buildOriginalScriptKickoffRequest,
  ORIGINAL_SCRIPT_TEMPLATE_ID,
  type OriginalScriptKickoffCompletion,
} from "@/lib/home-agent/original-script-kickoff";
import {
  buildAdaptationUploadInstruction,
  buildAdaptationUploadExtractionSummary,
  buildAdaptationWorkflowKickoffIntro,
  buildAdaptationWorkflowKickoffRequest,
  buildAdaptationWorkflowStartDialogPrompt,
  buildAdaptationWorkflowUploadSuggestionRequest,
  extractAdaptationReferenceUpload,
} from "@/lib/home-agent/adaptation-workflow-kickoff";
import {
  VIDEO_WORKFLOW_TEMPLATE_ID,
  buildVideoUploadExtractionSummary,
  buildVideoWorkflowUploadInstruction,
  buildVideoWorkflowKickoffIntro,
  buildVideoWorkflowKickoffRequest,
  buildVideoWorkflowStartPrompt,
  extractVideoWorkflowUploadScript,
  hasEpisodeScriptBody,
  recognizeVideoWorkflowUploadScript,
} from "@/lib/home-agent/video-workflow-kickoff";
import type {
  ComposerQuestion,
  ConversationProjectSnapshot,
  AutomationMode,
  FullAutoRunPlan,
  FullAutoRunState,
  FullAutoRunStep,
  HomeAgentMessage,
  PendingWorkflowUploadKind,
  StudioQuestionState,
  StudioRuntimeState,
  WorkflowActionResult,
} from "@/lib/home-agent/types";
import type { AutoResearchPlan } from "@/lib/home-agent/auto-research";
import {
  buildAutoResearchChoiceQuestion,
  buildAutoResearchPlan,
  buildAutoResearchStepQuestion,
} from "@/lib/home-agent/auto-research";
import {
  applyAllOverlaysParallel,
  appendTextOverlayToInput,
  beginSendFlow,
  collectChangedArtifactsFromSdkUserMessage,
  createArtifactSignatureMap,
  handleSendEngineEvent,
  resolveBlockedWorkflowMediaAction,
  resolveDirectProjectImageIntent,
  resolveDirectStoryboardGenerationIntent,
  resolveDirectVideoGenerationIntent,
} from "./home-agent-send-flow";
import { createWorkflowShortcutUiBridge } from "./home-agent-workflow-ui";
import { parseTaskHeading } from "./home-agent-task-utils";
import { buildVideoBridgeResearchPlan } from "./use-home-agent-workflow-shortcuts";
import {
  buildVideoBridgeResearchInput,
  buildVideoBridgeResearchMessage,
} from "./video-bridge-research-utils";
import {
  getOrCreateHomeAgentEngine,
  launchHomeAgentAutoResearchTasks,
  type HomeAgentApiConfigModule,
  type HomeAgentEngineDeps,
} from "./home-agent-engine-runtime";
import { answerHomeAgentQuestion, launchTemplateConversation, resetHomeAgentConversation, resetRuntimeState } from "./home-agent-session-actions";
import {
  buildWorkflowAssistantMessagePayload,
  buildWorkflowContinuationPrompt,
  mergeRuntimeWithWorkflowDelta,
  runWorkflowShortcut,
} from "@/lib/home-agent/workflow-shortcut-runner";
import {
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  getHomeAgentVideoGenerationBatchLimit,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
  resolveVideoGenerationProvider,
} from "@/lib/home-agent/video-models";
import {
  applyFullAutoStrategyAnswer,
  buildFullAutoExecutionSteps,
  buildFullAutoExecutionUserMessage as buildSharedFullAutoExecutionUserMessage,
  buildFullAutoProxyUserMessage as buildSharedFullAutoProxyUserMessage,
  canRewindFullAutoStrategyPlan,
  createFullAutoAdaptationRunPlan,
  createFullAutoOriginalScriptRunPlan,
  createFullAutoVideoWorkflowRunPlan,
  getFullAutoEpisodeDurationSeconds,
  getFullAutoExportDirectoryPath,
  getFullAutoScriptDocumentExportDirectoryPath,
  getFullAutoStoryboardXlsxExportDirectoryPath,
  getFullAutoPromptBatchMode,
  getResolvedFullAutoStrategyValue,
  getFullAutoStrategyValue,
  getFullAutoVideoAnalyzePrefs,
  getFullAutoVideoImagePrefs,
  getFullAutoVideoMode,
  getFullAutoVideoResolution,
  getNextFullAutoStrategyQuestion,
  isFullAutoStrategyQuestion,
  markFullAutoSteps,
  resetFullAutoStrategyPlan,
  rewindFullAutoStrategyPlan,
  shouldAutoRetryFullAutoGenerationStep,
  syncFullAutoPlanSteps,
  updateFullAutoStepStrategy,
} from "@/lib/home-agent/full-auto-run-plan";
import { buildQuickExportMarkdown } from "@/lib/home-agent/script-artifact-helpers";
import {
  exportEpisodeMarkdownFilesLocally,
  exportMarkdownTextLocally,
  sanitizeExportFileName,
} from "@/lib/home-agent/local-text-export";
import {
  buildMediaContentSummary,
  buildWorkflowMediaTargetLabels,
  localizeMediaSettingValue,
} from "@/lib/home-agent/media-generation-copy";
import {
  buildAutoSessionProjectTitle,
  extractAssistantProjectTitle,
} from "@/lib/home-agent/project-title";
import {
  buildEpisodeWorkflowQuestion,
  buildOutlinesWorkflowQuestion,
  buildVideoBridgeRetryQuestion,
  listFailedSegmentVideoLabels,
  listGeneratableSegmentVideoLabels,
  buildVideoWorkflowTaskBoard,
  buildVideoContinuationQuestion,
  listGeneratableStoryboardSceneIdsForEpisode,
  listGeneratableStoryboardSceneIdsForSegment,
  listSmartStoryboardFrameTargetIds,
  listVideoReferenceAssetTargetIds,
  recQuestion,
  resolveScriptWorkflowStage,
} from "./home-agent-project-questions";
import {
  mergeRecentProjects,
  resolveSessionProjectIdForSnapshot,
} from "./home-agent-session-utils";
import {
  buildVideoUploadScriptFollowupQuestion,
} from "./home-agent-video-choice-handlers";
import {
  normalizeWorkflowBoundAskUserQuestionRequest,
  resolveWorkflowBoundComposerQuestion,
} from "./home-agent-ask-user-question-guard";
import type {
  AskUserQuestionModule,
  ConversationMemoryModule,
  ProjectStoreModule,
  StructuredQuestionParserModule,
} from "./use-home-agent-module-loaders";
import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
} from "@/types/project";
import { resolveArtifactSnapshots } from "@/lib/home-agent/message-artifact-snapshots";
import {
  dispatchWorkflowMediaEvents,
  dispatchWorkflowMediaStartEvent,
  resolveWorkflowImageStartTargets,
  resolveWorkflowSegmentVideoStartTargets,
  resolveWorkflowVideoAssetStartTargets,
} from "./workflow-media-events";

const STREAMING_DELTA_DRAIN_FRAMES = 18;
const STREAMING_DELTA_MAX_CHARS_PER_FRAME = 8;

let invokeWithKeyModulePromise: Promise<typeof import("@/lib/invoke-with-key")> | null = null;

function loadInvokeWithKeyModule() {
  if (!invokeWithKeyModulePromise) {
    invokeWithKeyModulePromise = import("@/lib/invoke-with-key");
  }
  return invokeWithKeyModulePromise;
}

async function invokeFunctionLazy<T>(
  channel: string,
  input?: Record<string, unknown>,
  options?: { abortSignal?: AbortSignal },
) {
  const { invokeFunction } = await loadInvokeWithKeyModule();
  return invokeFunction<T>(channel, input, options);
}

function resolveStreamingDeltaChunkSize(buffer: string): number {
  const remaining = buffer.length;
  if (remaining <= 1) return remaining;
  return Math.max(
    1,
    Math.min(STREAMING_DELTA_MAX_CHARS_PER_FRAME, Math.ceil(remaining / STREAMING_DELTA_DRAIN_FRAMES)),
  );
}

type DirectVideoGenerationTaskResult = {
  task_id?: string;
  status?: string;
  provider?: string;
};

type DirectVideoGenerationStatusResult = {
  status?: string;
  video_url?: string;
};

type ActiveRemoteVideoTask = {
  taskId: string;
  provider?: string;
};

const DIRECT_VIDEO_POLL_INTERVAL_MS = 10_000;
const DIRECT_VIDEO_MAX_POLL_ROUNDS = 72;
const DIRECT_MEDIA_SUBMISSION_GUARD_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 3000;

function createMediaEventId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `media:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }
}

function dispatchMediaGenerationCancelledEvent(kind: "image" | "video", mediaEventId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(
      kind === "image" ? "agent:image-generating-cancelled" : "agent:video-generating-cancelled",
      {
        detail: mediaEventId ? { mediaEventId } : undefined,
      },
    ),
  );
}

function dispatchMediaGenerationFailedEvent(
  kind: "image" | "video",
  reason: string,
  mediaEventId?: string,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(
      kind === "image" ? "agent:image-generating-failed" : "agent:video-generating-failed",
      {
        detail: {
          reason,
          ...(mediaEventId ? { mediaEventId } : {}),
        },
      },
    ),
  );
}

function normalizeWorkflowTargetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
}

function resolveFullAutoVideoBatchSize(input: Record<string, unknown>): number {
  const requestedPrefs =
    typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs
      ? (input.videoGenerationPrefs as Partial<VideoGenerationPrefs>)
      : null;
  const modelKey =
    typeof input.selectedVideoModelKey === "string"
      ? input.selectedVideoModelKey
      : typeof input.videoModelKey === "string"
        ? input.videoModelKey
        : null;
  const batchLimit = getHomeAgentVideoGenerationBatchLimit({
    ...(requestedPrefs ?? {}),
    ...(modelKey ? { modelKey } : {}),
    ...(typeof input.resolution === "string" ? { resolution: input.resolution } : {}),
    ...(typeof input.mode === "string" ? { mode: input.mode } : {}),
  });
  const requestedBatchSize =
    typeof input.batchSize === "number" && Number.isFinite(input.batchSize)
      ? Math.floor(input.batchSize)
      : batchLimit;
  return Math.max(1, Math.min(batchLimit, requestedBatchSize));
}

function resolveFullAutoReferenceAssetCandidateIds(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): string[] {
  const explicitTargetIds = normalizeWorkflowTargetIds(input.targetIds);
  if (explicitTargetIds.length) return explicitTargetIds;
  if (!runtime.currentVideoProject) return [];
  return listVideoReferenceAssetTargetIds(runtime.currentVideoProject, {
    includeReady: input.forceRegenerate === true,
  });
}

function resolveFullAutoStoryboardCandidateIds(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): string[] {
  const explicitTargetIds = normalizeWorkflowTargetIds(input.targetIds);
  if (explicitTargetIds.length) return explicitTargetIds;
  if (!runtime.currentVideoProject) return [];
  if (input.smartBatch === true) {
    return listSmartStoryboardFrameTargetIds(runtime.currentVideoProject);
  }
  return runtime.currentVideoProject.scenes
    .filter((scene) => input.forceRegenerate === true || !scene.storyboardUrl?.trim())
    .map((scene) => scene.id);
}

function resolveFullAutoSegmentCandidateLabels(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): string[] {
  const explicitSegmentLabels = normalizeWorkflowTargetIds(input.targetSegmentLabels);
  if (explicitSegmentLabels.length) return explicitSegmentLabels;
  if (!runtime.currentVideoProject) return [];
  if (input.retryFailed === true) {
    return listFailedSegmentVideoLabels(runtime.currentVideoProject);
  }
  if (input.batchMode === "first") {
    return listGeneratableSegmentVideoLabels(runtime.currentVideoProject);
  }
  const singleSegmentLabel =
    typeof input.segmentLabel === "string" ? input.segmentLabel.trim() : "";
  return singleSegmentLabel ? [singleSegmentLabel] : [];
}

function resolveFullAutoVideoSceneCandidateIds(
  runtime: StudioRuntimeState,
  input: Record<string, unknown>,
): string[] {
  const explicitTargetIds = normalizeWorkflowTargetIds(input.targetIds);
  if (explicitTargetIds.length) return explicitTargetIds;
  const project = runtime.currentVideoProject;
  if (!project) return [];
  const start = typeof input.sceneStart === "number" ? input.sceneStart : null;
  const end = typeof input.sceneEnd === "number" ? input.sceneEnd : null;
  if (start !== null || end !== null) {
    const lower = start ?? project.scenes[0]?.sceneNumber ?? 1;
    const upper = end ?? lower;
    return project.scenes
      .filter((scene) => scene.sceneNumber >= lower && scene.sceneNumber <= upper)
      .map((scene) => scene.id);
  }
  const forceRegenerate = input.forceRegenerate === true;
  return project.scenes
    .filter((scene) => {
      if (forceRegenerate) return true;
      const status = String(scene.videoStatus || "").trim().toLowerCase();
      if (status === "queued" || status === "processing") return false;
      return !scene.videoUrl;
    })
    .map((scene) => scene.id);
}

export function resolveFullAutoBatchExecutionState(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
}): {
  batchable: boolean;
  selectedCount: number;
  remainingCount: number;
  signature: string | null;
  targetIds?: string[];
  targetLabels?: string[];
  contentSummary?: string;
} {
  const { action, input, runtime } = params;

  if (action === "generate_video_reference_assets") {
    const candidateTargetIds = resolveFullAutoReferenceAssetCandidateIds(runtime, input);
    const selected = resolveWorkflowImageStartTargets({ action, input, runtime });
    const selectedTargetIds = selected.targetIds ?? candidateTargetIds.slice(0, selected.count);
    return {
      batchable: input.smartBatch === true && candidateTargetIds.length > selected.count,
      selectedCount: selected.count,
      remainingCount: Math.max(candidateTargetIds.length - selected.count, 0),
      signature: selectedTargetIds.length ? `image:${selectedTargetIds.join("|")}` : null,
      ...(selectedTargetIds.length ? { targetIds: selectedTargetIds } : {}),
      ...(selectedTargetIds.length
        ? {
            targetLabels: buildWorkflowMediaTargetLabels({
              action,
              runtime,
              targetIds: selectedTargetIds,
            }),
          }
        : {}),
      contentSummary: buildMediaContentSummary({
        action,
        runtime,
        targetIds: selectedTargetIds,
      }),
    };
  }

  if (action === "generate_storyboard_frames") {
    const candidateTargetIds = resolveFullAutoStoryboardCandidateIds(runtime, input);
    const selected = resolveWorkflowImageStartTargets({ action, input, runtime });
    const selectedTargetIds = selected.targetIds ?? candidateTargetIds.slice(0, selected.count);
    return {
      batchable: input.smartBatch === true && candidateTargetIds.length > selected.count,
      selectedCount: selected.count,
      remainingCount: Math.max(candidateTargetIds.length - selected.count, 0),
      signature: selectedTargetIds.length ? `storyboard:${selectedTargetIds.join("|")}` : null,
      ...(selectedTargetIds.length ? { targetIds: selectedTargetIds } : {}),
      ...(selectedTargetIds.length
        ? {
            targetLabels: buildWorkflowMediaTargetLabels({
              action,
              runtime,
              targetIds: selectedTargetIds,
            }),
          }
        : {}),
      contentSummary: buildMediaContentSummary({
        action,
        runtime,
        targetIds: selectedTargetIds,
      }),
    };
  }

  if (action === "generate_segment_video") {
    const candidateSegmentLabels = resolveFullAutoSegmentCandidateLabels(runtime, input);
    const selected = resolveWorkflowSegmentVideoStartTargets({ input, runtime });
    const selectedSegmentLabels =
      selected.segmentLabels ?? candidateSegmentLabels.slice(0, selected.count);
    return {
      batchable: candidateSegmentLabels.length > selected.count,
      selectedCount: selected.count,
      remainingCount: Math.max(candidateSegmentLabels.length - selected.count, 0),
      signature: selectedSegmentLabels.length ? `segment:${selectedSegmentLabels.join("|")}` : null,
      ...(selectedSegmentLabels.length ? { targetIds: selectedSegmentLabels } : {}),
      ...(selected.targetLabels?.length ? { targetLabels: selected.targetLabels } : {}),
      contentSummary: buildMediaContentSummary({
        action,
        runtime,
        targetIds: selectedSegmentLabels,
      }),
    };
  }

  if (action === "generate_video_assets") {
    const candidateSceneIds = resolveFullAutoVideoSceneCandidateIds(runtime, input);
    const selected = resolveWorkflowVideoAssetStartTargets({ input, runtime });
    const selectedSceneIds = selected.targetIds ?? candidateSceneIds.slice(0, selected.count);
    const explicitScoped =
      normalizeWorkflowTargetIds(input.targetIds).length > 0 ||
      typeof input.sceneStart === "number" ||
      typeof input.sceneEnd === "number";
    return {
      batchable: !explicitScoped && candidateSceneIds.length > selected.count,
      selectedCount: selected.count,
      remainingCount: Math.max(candidateSceneIds.length - selected.count, 0),
      signature: selectedSceneIds.length ? `video:${selectedSceneIds.join("|")}` : null,
      ...(selectedSceneIds.length ? { targetIds: selectedSceneIds } : {}),
      ...(selected.targetLabels?.length ? { targetLabels: selected.targetLabels } : {}),
      contentSummary: buildMediaContentSummary({
        action,
        runtime,
        targetIds: selectedSceneIds,
      }),
    };
  }

  return {
    batchable: false,
    selectedCount: 0,
    remainingCount: 0,
    signature: null,
  };
}

export function shouldContinueFullAutoBatchExecution(params: {
  currentBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "signature">
    | null
    | undefined;
  nextBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "selectedCount" | "signature">
    | null
    | undefined;
}): boolean {
  const { currentBatchState, nextBatchState } = params;
  return Boolean(
    nextBatchState?.selectedCount &&
      nextBatchState.signature &&
      nextBatchState.signature !== currentBatchState?.signature,
  );
}

export function isStalledFullAutoReferenceAssetBatch(params: {
  action: string;
  currentBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "signature">
    | null
    | undefined;
  nextBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "selectedCount" | "signature">
    | null
    | undefined;
}): boolean {
  const { action, currentBatchState, nextBatchState } = params;
  return Boolean(
    action === "generate_video_reference_assets" &&
      nextBatchState?.selectedCount &&
      currentBatchState?.signature &&
      nextBatchState.signature &&
      nextBatchState.signature === currentBatchState.signature,
  );
}

export function isStalledFullAutoVideoGenerationBatch(params: {
  action: string;
  currentBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "signature">
    | null
    | undefined;
  nextBatchState:
    | Pick<ReturnType<typeof resolveFullAutoBatchExecutionState>, "selectedCount" | "signature">
    | null
    | undefined;
}): boolean {
  const { action, currentBatchState, nextBatchState } = params;
  return Boolean(
    (action === "generate_video_assets" || action === "generate_segment_video") &&
      nextBatchState?.selectedCount &&
      currentBatchState?.signature &&
      nextBatchState.signature &&
      nextBatchState.signature === currentBatchState.signature,
  );
}

function resolveFullAutoBatchUnitLabel(action: string): string {
  switch (action) {
    case "generate_video_reference_assets":
      return "个资产";
    case "generate_storyboard_frames":
      return "张分镜";
    case "generate_segment_video":
      return "个片段";
    case "generate_video_assets":
      return "条镜头";
    default:
      return "项";
  }
}

function isWorkflowMediaAction(action: string): boolean {
  return [
    "generate_project_image",
    "generate_video_reference_assets",
    "generate_storyboard_frames",
    "generate_video_assets",
    "generate_segment_video",
  ].includes(action);
}

function resolveWorkflowMediaKind(action: string): "image" | "video" | null {
  if (
    action === "generate_project_image" ||
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames"
  ) {
    return "image";
  }
  if (action === "generate_video_assets" || action === "generate_segment_video") {
    return "video";
  }
  return null;
}

const FULL_AUTO_STEP_ATTEMPT_LIMIT = 3;
const FULL_AUTO_RECOVERABLE_STEP_RETRY_DELAY_MS = 1200;
const FULL_AUTO_VIDEO_ANALYZE_RETRY_PROMPT_HEADING = "【全自动视频拆解重试补充】";
const FULL_AUTO_REFERENCE_ASSET_STALL_BATCH_RETRY_LIMIT = 2;
const FULL_AUTO_REFERENCE_ASSET_STALL_ERROR_PREFIX = "参考资产自动补齐未取得进展";
const FULL_AUTO_VIDEO_BATCH_STALL_BATCH_RETRY_LIMIT = 2;
const FULL_AUTO_VIDEO_BATCH_STALL_ERROR_PREFIX = "视频批次自动续跑未取得进展";
const FULL_AUTO_RECOVERABLE_STEP_RETRY_LIMITS: Partial<Record<FullAutoRunStep["id"], number>> = {
  "video-analyze": 8,
  "video-reference-assets": 3,
  "video-generate": 3,
};

export function buildFullAutoBatchExecutionUserMessage(params: {
  baseMessage: string;
  action: string;
  batchIndex: number;
  selectedCount: number;
  remainingCount: number;
}): string {
  const { baseMessage, action, batchIndex, selectedCount, remainingCount } = params;
  if (batchIndex <= 1) return baseMessage;
  const unitLabel = resolveFullAutoBatchUnitLabel(action);
  return remainingCount > 0
    ? `${baseMessage}（第 ${batchIndex} 批，本批 ${selectedCount}${unitLabel}，后续还剩 ${remainingCount}${unitLabel}）`
    : `${baseMessage}（第 ${batchIndex} 批，本批 ${selectedCount}${unitLabel}）`;
}

function normalizeFullAutoRetryReason(error: unknown, max = 180): string {
  const message = String(error instanceof Error ? error.message : error || "未知错误")
    .replace(/\s+/g, " ")
    .trim();
  return truncateOverlayLine(message || "未知错误", max);
}

function isFatalFullAutoRetryError(message: string): boolean {
  return /(^|\D)(401|403)(\D|$)/.test(message) ||
    /quota|insufficient|forbidden|unauthorized|apikey|api key|invalid key|密钥|未配置/.test(message.toLowerCase());
}

function isRecoverableVideoAnalyzeError(message: string): boolean {
  if (!message.trim()) return false;
  if (isFatalFullAutoRetryError(message)) return false;
  return (
    message.includes("剧本拆解") ||
    message.includes("拆解结果") ||
    message.includes("对白字数超限") ||
    message.includes("对白条数超限") ||
    /timeout|timed out|超时/i.test(message) ||
    message.includes("AI 未返回内容")
  );
}

export function buildFullAutoRetryUserMessage(params: {
  baseMessage: string;
  attempt: number;
}): string {
  const { baseMessage, attempt } = params;
  if (attempt <= 1) return baseMessage;
  return `${baseMessage}（第 ${attempt} 次尝试）`;
}

export function buildFullAutoRetryAssistantMessage(params: {
  stepLabel: string;
  error: unknown;
  nextAttempt: number;
  stage: "attempt" | "round";
}): string {
  const { stepLabel, error, nextAttempt, stage } = params;
  const reason = normalizeFullAutoRetryReason(error, 160);
  if (stage === "attempt") {
    return `${stepLabel}失败：${reason}。AI 代理会继续发起第 ${nextAttempt} 次尝试。`;
  }
  return `${stepLabel}连续多次尝试后仍未通过：${reason}。AI 代理会重新发送这一步并继续第 ${nextAttempt} 轮自动重试。`;
}

function buildFullAutoVideoAnalyzeRetrySystemPrompt(error: unknown, retryLabel: string): string {
  return [
    FULL_AUTO_VIDEO_ANALYZE_RETRY_PROMPT_HEADING,
    `当前处于${retryLabel}。上一轮失败原因：${normalizeFullAutoRetryReason(error, 200)}`,
    "这一轮请优先满足对白硬限制：任何单条对白只要超过当前节奏允许的字数上限，必须直接拆到下一个 segmentLabel。",
    "宁可增加 segmentLabel，也不要把超长对白压回当前片段；description 里不得混入对白、旁白或心声。",
    "输出前必须逐条自检每个 segmentLabel 的对白条数和每条对白字数，确保没有任何超限项。",
  ].join("\n");
}

function mergeFullAutoVideoAnalyzeRetrySystemPrompt(
  basePrompt: unknown,
  error: unknown,
  retryLabel: string,
): string {
  const trimmedBase = typeof basePrompt === "string" ? basePrompt.trim() : "";
  const headingIndex = trimmedBase.indexOf(FULL_AUTO_VIDEO_ANALYZE_RETRY_PROMPT_HEADING);
  const cleanBase = headingIndex >= 0 ? trimmedBase.slice(0, headingIndex).trim() : trimmedBase;
  return [cleanBase, buildFullAutoVideoAnalyzeRetrySystemPrompt(error, retryLabel)]
    .filter(Boolean)
    .join("\n\n");
}

export function shouldAutoRetryRecoverableFullAutoStep(params: {
  plan: FullAutoRunPlan;
  step: FullAutoRunStep | undefined;
  error: unknown;
}): boolean {
  const { plan, step, error } = params;
  if (!step) return false;
  const limit = FULL_AUTO_RECOVERABLE_STEP_RETRY_LIMITS[step.id] ?? 0;
  if (limit <= 0) return false;
  if ((plan.retryCounts?.[step.id] ?? 0) >= limit) return false;
  const message = normalizeFullAutoRetryReason(error, 240);
  if (step.id === "video-analyze") {
    return isRecoverableVideoAnalyzeError(message);
  }
  if (step.id === "video-reference-assets") {
    return message.includes(FULL_AUTO_REFERENCE_ASSET_STALL_ERROR_PREFIX);
  }
  if (step.id === "video-generate") {
    return message.includes(FULL_AUTO_VIDEO_BATCH_STALL_ERROR_PREFIX);
  }
  return false;
}

type StopActiveExecutionResult = {
  hadActiveExecution: boolean;
  cancelledRemoteVideoTaskCount: number;
};

function isTextModelConfigErrorMessage(message: string): boolean {
  return message.includes("当前未配置") && message.includes("文本模型密钥");
}

function hasRecentAssistantMessage(messages: HomeAgentMessage[], content: string, limit = 10): boolean {
  return messages
    .slice(-limit)
    .some((message) => message.role === "assistant" && message.content.trim() === content.trim());
}

function createAbortError(message = "请求已取消"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export function shouldIgnoreFullAutoExecutionUpdate(params: {
  executionEpoch: number;
  currentExecutionEpoch: number;
  signal?: AbortSignal | null;
  userStopped?: boolean;
}): boolean {
  const { executionEpoch, currentExecutionEpoch, signal, userStopped = false } = params;
  return executionEpoch !== currentExecutionEpoch || Boolean(signal?.aborted) || userStopped;
}

export function waitForAbortableDelay(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildMediaSubmissionGuardLine(
  kind: "image" | "video",
  delayMs = DIRECT_MEDIA_SUBMISSION_GUARD_DELAY_MS,
): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return kind === "image"
    ? `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生图请求；这段时间内仍可撤回。`
    : `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生视频请求；这段时间内仍可撤回。`;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === "请求已取消" ||
    error.message === "任务已取消"
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|超时/i.test(message);
}

function truncateOverlayLine(value: string | undefined, max = 200): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

const DIRECT_MEDIA_ACTION_LABELS = {
  image: "图片生成",
  storyboard: "分镜生成",
  video: "视频生成",
} as const;

type DirectMediaActionKind = keyof typeof DIRECT_MEDIA_ACTION_LABELS;

function normalizeDirectMediaActionLabel(mediaAction: DirectMediaActionKind | string): string {
  return DIRECT_MEDIA_ACTION_LABELS[mediaAction as DirectMediaActionKind] ?? mediaAction;
}

export function isBlockedScriptWorkflowMediaAction(
  snapshot: ConversationProjectSnapshot | null | undefined,
): snapshot is ConversationProjectSnapshot {
  if (!snapshot) return false;
  if (snapshot.projectKind !== "script" && snapshot.projectKind !== "adaptation") return false;
  return Boolean(resolveScriptWorkflowStage(snapshot.derivedStage));
}

function isVideoWorkflowSourceSnapshot(
  snapshot:
    | Pick<ConversationProjectSnapshot, "projectId" | "projectKind">
    | null
    | undefined,
): boolean {
  return Boolean(snapshot?.projectId && snapshot.projectKind && snapshot.projectKind !== "video");
}

export function isBridgeableVideoWorkflowSourceSnapshot(
  snapshot: ConversationProjectSnapshot | null | undefined,
): snapshot is ConversationProjectSnapshot {
  return isVideoWorkflowSourceSnapshot(snapshot) && !isHomepageConversationPlaceholderSnapshot(snapshot);
}

export function resolveFullAutoRuntimeProjectId(params: {
  runtime: StudioRuntimeState;
  setupInput?: Record<string, unknown> | null | undefined;
}): string | undefined {
  const { runtime } = params;
  const setupInput = params.setupInput ?? {};
  const currentVideoProjectId = runtime.currentVideoProject?.id?.trim();
  if (currentVideoProjectId) return currentVideoProjectId;

  const configuredProjectId =
    typeof setupInput.projectId === "string" && setupInput.projectId.trim()
      ? setupInput.projectId.trim()
      : undefined;
  if (configuredProjectId) return configuredProjectId;

  const currentDramaProjectId = runtime.currentDramaProject?.id?.trim();
  if (currentDramaProjectId) return currentDramaProjectId;

  const configuredSourceProjectId =
    typeof setupInput.sourceProjectId === "string" && setupInput.sourceProjectId.trim()
      ? setupInput.sourceProjectId.trim()
      : undefined;
  if (configuredSourceProjectId) return configuredSourceProjectId;

  const snapshotProjectId = runtime.currentProjectSnapshot?.projectId?.trim();
  if (!snapshotProjectId) return undefined;

  const hasSetupScript =
    typeof setupInput.script === "string" && setupInput.script.trim().length > 0;
  if (hasSetupScript && isHomepageConversationPlaceholderSnapshot(runtime.currentProjectSnapshot)) {
    return undefined;
  }

  return snapshotProjectId;
}

function buildScriptWorkflowQuestionSummary(question: ComposerQuestion | null | undefined): string | null {
  if (!question) return null;
  const title = truncateOverlayLine(question.title, 80);
  const description = truncateOverlayLine(question.description, 140);
  if (title && description && description !== title) {
    return `当前最该完成的是「${title}」：${description}`;
  }
  if (title) {
    return `当前最该完成的是「${title}」`;
  }
  if (description) {
    return `当前最该完成的是：${description}`;
  }
  return null;
}

function buildScriptWorkflowNextStepGuidance(
  snapshot: ConversationProjectSnapshot,
  question: ComposerQuestion | null | undefined,
): string {
  const optionLabels = question?.options
    ?.map((option) => truncateOverlayLine(option.label, 28))
    .filter(Boolean) ?? [];
  if (optionLabels.length) {
    const scopedTitle = truncateOverlayLine(question?.title, 48);
    return `下一步建议：先完成当前步骤${scopedTitle ? `「${scopedTitle}」` : ""}，你可以直接选择 ${optionLabels.slice(0, 3).join(" / ")}。`;
  }

  const nextAction = snapshot.recommendedActions.find((action) => action.trim())?.trim();
  if (nextAction) {
    return `下一步建议：先继续当前阶段，优先推进：${truncateOverlayLine(nextAction, 120)}。`;
  }

  const objective = snapshot.currentObjective.trim();
  if (objective) {
    return `下一步建议：先围绕当前目标继续推进：${truncateOverlayLine(objective, 120)}。`;
  }

  const stageLabel = snapshot.derivedStage.trim() || "当前阶段";
  return `下一步建议：先完成「${stageLabel}」这一步，我再继续帮你衔接后面的动作。`;
}

export function buildScriptWorkflowSkipAheadReply(params: {
  snapshot: ConversationProjectSnapshot;
  mediaAction: DirectMediaActionKind | string;
  question?: ComposerQuestion | null;
}): string {
  const { snapshot, mediaAction, question = null } = params;
  const stageLabel = snapshot.derivedStage.trim() || "当前阶段";
  const objective = truncateOverlayLine(snapshot.currentObjective, 160);
  const summary = truncateOverlayLine(snapshot.agentSummary, 220);
  const mediaActionLabel = normalizeDirectMediaActionLabel(mediaAction);
  const questionSummary = buildScriptWorkflowQuestionSummary(question);

  return [
    `现在还在「${stageLabel}」阶段，我先不直接执行${mediaActionLabel}。这一步属于后续媒体制作流程，当前工作流不允许跳步。`,
    objective ? `当前阶段目标：${objective}。` : null,
    summary && summary !== objective ? `前面已经整理出的内容：${summary}。` : null,
    questionSummary ? `${questionSummary}。` : null,
    `等当前阶段完成后，我会继续沿着同一条工作流帮你衔接${mediaActionLabel}。`,
    buildScriptWorkflowNextStepGuidance(snapshot, question),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildScriptWorkflowBlockedMediaActionReplyPrompt(params: {
  snapshot: ConversationProjectSnapshot;
  userInput: string;
  mediaAction: DirectMediaActionKind | string;
  question?: ComposerQuestion | null;
}): string {
  const { snapshot, userInput, mediaAction, question = null } = params;
  const stageLabel = snapshot.derivedStage.trim() || "当前阶段";
  const objective = truncateOverlayLine(snapshot.currentObjective, 160);
  const summary = truncateOverlayLine(snapshot.agentSummary, 180);
  const questionSummary = buildScriptWorkflowQuestionSummary(question);
  const mediaActionLabel = normalizeDirectMediaActionLabel(mediaAction);
  const clippedInput = truncateOverlayLine(userInput, 220);

  return [
    "你正在继续当前工作流对话，请只基于当前未完成步骤来回答。",
    `用户刚才输入的是：${clippedInput || "（空）"}`,
    `当前项目处于「${stageLabel}」阶段。`,
    objective ? `当前阶段目标：${objective}` : null,
    questionSummary ? `${questionSummary}。` : null,
    summary ? `如有必要，可简短参考这条当前摘要：${summary}。` : null,
    `用户提到了${mediaActionLabel}或后续制作意图，但这个动作现在不能执行。`,
    "请用中文自然回复，控制在 2 到 4 句。",
    "先判断用户这次输入和当前步骤的关系：如果里面有对当前步骤有用的信息，就吸收并明确说明会按当前步骤使用；如果没有，就简短说明当前不能执行该后续动作。",
    "不要建议跳过、绕过、提前进入后续阶段，不要给出任何变相跳步方案。",
    "不要回顾一大串已完成步骤、资产清单或历史摘要，除非当前步骤确实只缺其中一个关键信息。",
    "结尾必须用一句“下一步建议：...”收口，并且只能指向当前这一步。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFreeConversationProjectSnapshot(params: {
  projectId: string;
  userPrompt: string;
  latestAssistantText?: string;
  automationMode: AutomationMode;
  updatedAt?: string;
}): ConversationProjectSnapshot {
  const {
    projectId,
    userPrompt,
    latestAssistantText,
    automationMode,
    updatedAt,
  } = params;
  const title =
    extractAssistantProjectTitle(latestAssistantText || "") ??
    buildAutoSessionProjectTitle(userPrompt);
  const summarySource = truncateOverlayLine(
    (latestAssistantText || userPrompt).replace(/\s+/g, " ").trim(),
    180,
  );

  return {
    projectId,
    projectKind: "script",
    title,
    currentObjective: "继续当前对话",
    derivedStage: "历史对话",
    agentSummary: summarySource || "继续当前对话",
    recommendedActions: [],
    artifacts: [],
    updatedAt: updatedAt || new Date().toISOString(),
    automationMode,
  };
}

export function buildFullAutoCollectionPlaceholderSnapshot(params: {
  sessionId: string;
  userPrompt: string;
  projectKind?: ConversationProjectSnapshot["projectKind"];
}): ConversationProjectSnapshot {
  const snapshot = buildFreeConversationProjectSnapshot({
    projectId: params.sessionId,
    userPrompt: params.userPrompt,
    automationMode: "full-auto",
    updatedAt: new Date().toISOString(),
  });
  return params.projectKind ? { ...snapshot, projectKind: params.projectKind } : snapshot;
}

export function shouldResetForFullAutoTemplateLaunch(params: {
  automationMode: AutomationMode;
  currentProjectSnapshot: ConversationProjectSnapshot | null | undefined;
  activeProjectId?: string;
  messages: HomeAgentMessage[];
}): boolean {
  const { automationMode, currentProjectSnapshot, activeProjectId, messages } = params;
  if (automationMode !== "full-auto") return false;
  if (currentProjectSnapshot?.automationMode === "full-auto") return false;
  return Boolean(currentProjectSnapshot?.projectId || activeProjectId || messages.length);
}

export function isHomepageConversationPlaceholderSnapshot(
  snapshot: ConversationProjectSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  return (
    snapshot.currentObjective === "继续当前对话" &&
    snapshot.derivedStage === "历史对话" &&
    snapshot.artifacts.length === 0 &&
    snapshot.recommendedActions.length === 0
  );
}

export function replacePlaceholderRecentProject(params: {
  recentProjects: ConversationProjectSnapshot[];
  previousSnapshot: ConversationProjectSnapshot | null | undefined;
  nextSnapshot: ConversationProjectSnapshot | null | undefined;
  pruneStaleFullAutoPlaceholders?: boolean;
}): ConversationProjectSnapshot[] {
  const {
    recentProjects,
    previousSnapshot,
    nextSnapshot,
    pruneStaleFullAutoPlaceholders = true,
  } = params;
  if (!nextSnapshot?.projectId) return recentProjects;

  const shouldReplacePlaceholder =
    previousSnapshot?.projectId &&
    previousSnapshot.projectId !== nextSnapshot.projectId &&
    isHomepageConversationPlaceholderSnapshot(previousSnapshot);

  const shouldPruneStaleFullAutoPlaceholder =
    pruneStaleFullAutoPlaceholders &&
    nextSnapshot.automationMode === "full-auto" &&
    !isHomepageConversationPlaceholderSnapshot(nextSnapshot);

  let didPruneProject = false;
  const baselineProjects = recentProjects.filter((project) => {
    if (shouldReplacePlaceholder && project.projectId === previousSnapshot?.projectId) {
      didPruneProject = true;
      return false;
    }

    if (
      shouldPruneStaleFullAutoPlaceholder &&
      project.projectId !== nextSnapshot.projectId &&
      project.automationMode === "full-auto" &&
      isHomepageConversationPlaceholderSnapshot(project)
    ) {
      didPruneProject = true;
      return false;
    }

    return true;
  });

  return mergeRecentProjects(didPruneProject ? baselineProjects : recentProjects, nextSnapshot);
}

export function buildHomepageConversationSnapshotFromMessages(params: {
  currentProjectSnapshot: ConversationProjectSnapshot | null | undefined;
  messages: HomeAgentMessage[];
  projectId: string;
  userPrompt: string;
  automationMode: AutomationMode;
}): ConversationProjectSnapshot | null {
  const {
    currentProjectSnapshot,
    messages,
    projectId,
    userPrompt,
    automationMode,
  } = params;
  if (currentProjectSnapshot?.projectId) return null;

  const latestAssistantMessage =
    [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          message.status === "complete" &&
          message.content.trim(),
      ) ?? null;

  if (!latestAssistantMessage) return null;

  return buildFreeConversationProjectSnapshot({
    projectId,
    userPrompt,
    latestAssistantText: latestAssistantMessage.content,
    automationMode,
    updatedAt: latestAssistantMessage.createdAt,
  });
}

function isOriginalScriptDirectKickoffPrompt(text: string): boolean {
  if (!text.trim()) return false;
  if (/(视频|分镜|镜头|素材|海报|参考剧本|改编|上传|图像|图片)/.test(text)) return false;
  return /(短剧|剧本|原创|故事|剧情|角色|人物|题材|设定|立项|反转|女频|男频|集数|创意)/.test(text);
}

function hasReadyOriginalScriptSetup(runtime: StudioRuntimeState): boolean {
  const project = runtime.currentDramaProject;
  if (!project || project.mode !== "traditional" || !project.setup) return false;
  const { setup } = project;
  return Boolean(
    setup.targetMarket?.trim() &&
      setup.audience.trim() &&
      setup.tone.trim() &&
      setup.ending.trim() &&
      setup.totalEpisodes > 0 &&
      (setup.genres.length > 0 ||
        Boolean(setup.customTopic?.trim()) ||
        Boolean(setup.creativeInput?.trim())),
  );
}

export function applyVideoKickoffFollowupQuestion(params: {
  workflowCompletion?: {
    projectSnapshot?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[0];
    data?: { videoProject?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[1] } | null;
    runtime?: { currentVideoProject?: Parameters<typeof buildVideoUploadScriptFollowupQuestion>[1] } | null;
  } | null;
  setSuggested: (question: ComposerQuestion | null) => void;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
  push?: (role: HomeAgentMessage["role"], content: string) => void;
}): boolean {
  const videoProject =
    params.workflowCompletion?.data?.videoProject ?? params.workflowCompletion?.runtime?.currentVideoProject;
  const followupQuestion = buildVideoUploadScriptFollowupQuestion(
    params.workflowCompletion?.projectSnapshot,
    videoProject,
  );
  if (!followupQuestion) return false;
  params.setSuggested(null);
  if (
    videoProject?.targetPlatform?.trim() &&
    videoProject?.shotStyle?.trim() &&
    videoProject?.outputGoal?.trim()
  ) {
    params.push?.(
      "assistant",
      "\u524d\u7f6e\u53c2\u6570\u5df2\u5199\u5165\uff0c\u8fdb\u5165\u89c6\u9891\u5de5\u4f5c\u6d41\u3002",
    );
  }
  params.setPopoverOverride(followupQuestion);
  return true;
}

function hasVideoBridgePrefs(
  videoProject: Pick<NonNullable<StudioRuntimeState["currentVideoProject"]>, "targetPlatform" | "shotStyle" | "outputGoal"> | null | undefined,
): boolean {
  return Boolean(
    videoProject?.targetPlatform?.trim() &&
      videoProject?.shotStyle?.trim() &&
      videoProject?.outputGoal?.trim(),
  );
}

async function waitForBackgroundTasks(
  taskIds: string[],
  signal: AbortSignal,
  pollMs = 400,
): Promise<BackgroundTask[]> {
  while (true) {
    if (signal.aborted) throw createAbortError();

    const taskMap = new Map(getAllTasks().map((task) => [task.id, task]));
    const tasks = taskIds
      .map((taskId) => taskMap.get(taskId))
      .filter((task): task is BackgroundTask => Boolean(task));

    if (
      tasks.length === taskIds.length &&
      tasks.every((task) => ["completed", "failed", "cancelled"].includes(task.status))
    ) {
      return tasks;
    }

    await waitForAbortableDelay(pollMs, signal);
  }
}

export function applyWorkflowMediaFollowupQuestion(params: {
  projectSnapshot?: ConversationProjectSnapshot | null;
  runtime?: Pick<StudioRuntimeState, "currentVideoProject"> | null;
  preferredQuestion?: ComposerQuestion | null;
  setSuggested: (question: ComposerQuestion | null) => void;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
}): boolean {
  const hasRunningVideoScenes = hasRunningVideoGenerationTasks(params.runtime?.currentVideoProject);
  if (hasRunningVideoScenes) return false;

  const nextQuestion =
    params.preferredQuestion ??
    (params.projectSnapshot ? recQuestion(params.projectSnapshot, params.runtime?.currentVideoProject ?? null) : null);

  if (!nextQuestion) return false;

  params.setSuggested(null);
  params.setPopoverOverride(nextQuestion);
  return true;
}

const FULL_AUTO_RESUME_VALUE = "full-auto:resume-current-task";
const FULL_AUTO_COMPLETION_VALUE = "full-auto:completed-summary";

function findFullAutoStepIndexById(plan: FullAutoRunPlan, stepId: string | null | undefined): number {
  if (!stepId) return -1;
  return buildFullAutoExecutionSteps(plan).findIndex((step) => step.id === stepId);
}

function findFirstExistingFullAutoStepId(plan: FullAutoRunPlan, stepIds: string[]): string | null {
  const steps = buildFullAutoExecutionSteps(plan);
  return stepIds.find((stepId) => steps.some((step) => step.id === stepId)) ?? null;
}

function resolveFullAutoResumeStepIdFromRuntime(params: {
  plan: FullAutoRunPlan;
  runtime?: Pick<StudioRuntimeState, "currentProjectSnapshot" | "currentVideoProject"> | null;
  fallbackIndex?: number;
}): string | null {
  const { plan, runtime, fallbackIndex = 0 } = params;
  const steps = buildFullAutoExecutionSteps(plan);
  const directResumeStepId =
    plan.resumeFromStepId ??
    plan.stoppedStepId ??
    steps[Math.max(0, Math.min(fallbackIndex, Math.max(steps.length - 1, 0)))]?.id ??
    null;
  const snapshot = runtime?.currentProjectSnapshot ?? null;
  if (!snapshot) return directResumeStepId;

  if (snapshot.projectKind === "video") {
    const board = buildVideoWorkflowTaskBoard(snapshot, runtime?.currentVideoProject ?? null);
    const hasPendingBoardItems = Boolean(board?.items.some((item) => item.state !== "completed"));
    if (!hasPendingBoardItems) return directResumeStepId;

    if (board?.stage === "脚本拆解") {
      return findFirstExistingFullAutoStepId(plan, ["video-analyze"]) ?? directResumeStepId;
    }
    if (board?.stage === "角色与场景") {
      return (
        findFirstExistingFullAutoStepId(plan, [
          "video-entities",
          "video-bridge-prefs",
          "video-reference-assets",
          "video-shot-packets",
          "video-prompts",
        ]) ?? directResumeStepId
      );
    }
    if (board?.stage === "分镜图生成") {
      return (
        findFirstExistingFullAutoStepId(plan, [
          "video-storyboard",
          "video-storyboard-frames",
          "video-shot-packets",
          "video-prompts",
        ]) ?? directResumeStepId
      );
    }
    if (board?.stage === "视频生成" || board?.stage === "预览与导出") {
      return (
        findFirstExistingFullAutoStepId(plan, [
          "video-prompts",
          "video-generate",
          "video-export",
        ]) ?? directResumeStepId
      );
    }

    return directResumeStepId;
  }

  const scriptStage = resolveScriptWorkflowStage(snapshot.derivedStage);
  switch (scriptStage) {
    case "setup":
      return findFirstExistingFullAutoStepId(plan, ["setup"]) ?? directResumeStepId;
    case "creative-plan":
      return findFirstExistingFullAutoStepId(plan, ["creative-plan"]) ?? directResumeStepId;
    case "characters":
      return findFirstExistingFullAutoStepId(plan, ["characters"]) ?? directResumeStepId;
    case "directory":
      return findFirstExistingFullAutoStepId(plan, ["directory"]) ?? directResumeStepId;
    case "outlines":
      return findFirstExistingFullAutoStepId(plan, ["outlines"]) ?? directResumeStepId;
    case "episodes":
      return findFirstExistingFullAutoStepId(plan, ["episodes", "episode-review"]) ?? directResumeStepId;
    case "compliance":
      return findFirstExistingFullAutoStepId(plan, ["compliance"]) ?? directResumeStepId;
    case "export":
      return findFirstExistingFullAutoStepId(plan, ["script-export", "video-export"]) ?? directResumeStepId;
    default:
      return directResumeStepId;
  }
}

function buildFullAutoCompletedSummary(plan: FullAutoRunPlan): string {
  const labels = Array.from(
    new Set(
      buildFullAutoExecutionSteps(plan)
        .map((step) => step.label.trim())
        .filter(Boolean),
    ),
  );
  return labels.join(" / ");
}

function buildFullAutoResumeQuestion(params: {
  run: Pick<FullAutoRunState, "status" | "plan" | "currentStepIndex">;
  runtime?: Pick<StudioRuntimeState, "currentProjectSnapshot" | "currentVideoProject"> | null;
}): ComposerQuestion | null {
  const plan = params.run.plan;
  if (!plan) return null;
  const resumeStepId = resolveFullAutoResumeStepIdFromRuntime({
    plan,
    runtime: params.runtime,
    fallbackIndex: params.run.currentStepIndex,
  });
  const resumeIndex = findFullAutoStepIndexById(plan, resumeStepId);
  const steps = buildFullAutoExecutionSteps(plan);
  const resumeStep = steps[resumeIndex >= 0 ? resumeIndex : Math.max(0, params.run.currentStepIndex)] ?? null;
  if (!resumeStep) return null;

  return {
    id: `full-auto-resume-${plan.id}-${resumeStep.id}`,
    title: "继续当前任务",
    description: `AI 会先检查当前仍未完成的内容，并从「${resumeStep.label}」开始按工作流顺序继续自动补齐。`,
    options: [
      {
        id: `full-auto-resume-option-${resumeStep.id}`,
        label: "继续当前任务",
        value: FULL_AUTO_RESUME_VALUE,
        rationale: `从「${resumeStep.label}」开始续跑，自动跳过已完成内容。`,
      },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: Math.max(0, resumeIndex),
    totalSteps: Math.max(steps.length, 1),
    answerKey: "full-auto-resume",
    statusBadges: [
      {
        label: params.run.status === "completed" ? "检测到遗漏" : "已暂停",
        value: resumeStep.label,
        tone: "warning",
      },
    ],
  };
}

function buildFullAutoCompletedQuestion(run: Pick<FullAutoRunState, "plan">): ComposerQuestion | null {
  if (!run.plan) return null;
  const completedSummary = buildFullAutoCompletedSummary(run.plan);
  return {
    id: `full-auto-complete-${run.plan.id}`,
    title: "已完成全部任务",
    description: "当前项目没有待补齐内容，全部全自动步骤都已完成。",
    options: [
      {
        id: `full-auto-complete-option-${run.plan.id}`,
        label: "已完成全部任务",
        value: FULL_AUTO_COMPLETION_VALUE,
        rationale: completedSummary || "当前全自动链路已全部执行完成。",
        disabled: true,
      },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: Math.max((buildFullAutoExecutionSteps(run.plan).length || 1) - 1, 0),
    totalSteps: Math.max(buildFullAutoExecutionSteps(run.plan).length, 1),
    answerKey: "full-auto-completed",
    statusBadges: [{ label: "已完成", value: "全部任务", tone: "default" }],
  };
}

export function buildFullAutoWorkflowFollowupQuestion(params: {
  run?: Pick<FullAutoRunState, "status" | "plan" | "currentStepIndex"> | null;
  runtime?: Pick<StudioRuntimeState, "currentProjectSnapshot" | "currentVideoProject"> | null;
}): ComposerQuestion | null {
  const run = params.run ?? null;
  if (run?.plan) {
    if (run.status === "stopped" || run.status === "paused" || run.status === "failed") {
      return buildFullAutoResumeQuestion({
        run,
        runtime: params.runtime,
      });
    }

    if (run.status === "completed") {
      const snapshot = params.runtime?.currentProjectSnapshot ?? null;
      if (snapshot?.projectKind === "video") {
        const board = buildVideoWorkflowTaskBoard(snapshot, params.runtime?.currentVideoProject ?? null);
        if (board?.items.some((item) => item.state !== "completed")) {
          return buildFullAutoResumeQuestion({
            run,
            runtime: params.runtime,
          });
        }
      }
      return buildFullAutoCompletedQuestion(run);
    }
  }

  const snapshot = params.runtime?.currentProjectSnapshot ?? null;
  return snapshot
    ? recQuestion(snapshot, params.runtime?.currentVideoProject ?? null)
    : null;
}

export function normalizeFullAutoRunStateForRestore(params: {
  run?: Pick<FullAutoRunState, "status" | "plan" | "currentStepIndex" | "currentStepLabel" | "lastError" | "stoppedByUser"> | null;
  runtime?: Pick<StudioRuntimeState, "currentProjectSnapshot" | "currentVideoProject"> | null;
  hasActiveExecution: boolean;
}): Pick<FullAutoRunState, "status" | "plan" | "currentStepIndex" | "currentStepLabel" | "lastError" | "stoppedByUser"> | null {
  const run = params.run ?? null;
  if (!run?.plan) return run;
  if (params.hasActiveExecution) return run;
  if (run.status !== "running" && run.status !== "retrying") return run;

  const normalizedPlan = syncFullAutoPlanSteps(run.plan);
  const resumeStepId = resolveFullAutoResumeStepIdFromRuntime({
    plan: normalizedPlan,
    runtime: params.runtime,
    fallbackIndex: run.currentStepIndex,
  });
  const steps = buildFullAutoExecutionSteps(normalizedPlan);
  const resumeIndex = Math.max(
    0,
    findFullAutoStepIndexById(normalizedPlan, resumeStepId) >= 0
      ? findFullAutoStepIndexById(normalizedPlan, resumeStepId)
      : run.currentStepIndex,
  );
  const resumeStep = steps[resumeIndex] ?? null;

  return {
    ...run,
    status: "stopped",
    currentStepIndex: resumeIndex,
    currentStepLabel: resumeStep?.label ?? run.currentStepLabel,
    plan: {
      ...markFullAutoSteps(normalizedPlan, resumeIndex, "stopped"),
      stoppedStepId: resumeStep?.id ?? normalizedPlan.stoppedStepId,
      resumeFromStepId: resumeStep?.id ?? normalizedPlan.resumeFromStepId,
    },
  };
}

export function applyFullAutoWorkflowFollowupQuestion(params: {
  run?: Pick<FullAutoRunState, "status" | "plan" | "currentStepIndex"> | null;
  runtime?: Pick<StudioRuntimeState, "currentProjectSnapshot" | "currentVideoProject"> | null;
  setSuggested: (question: ComposerQuestion | null) => void;
  setPopoverOverride: (question: ComposerQuestion | null) => void;
  forcePopover?: boolean;
}): boolean {
  const nextQuestion = buildFullAutoWorkflowFollowupQuestion({
    run: params.run,
    runtime: params.runtime,
  });

  if (!nextQuestion) return false;

  if (params.forcePopover) {
    params.setSuggested(null);
    params.setPopoverOverride(nextQuestion);
    return true;
  }

  params.setPopoverOverride(null);
  params.setSuggested(nextQuestion);
  return true;
}

export const buildFullAutoProxyUserMessage = buildSharedFullAutoProxyUserMessage;
export const buildFullAutoExecutionUserMessage = buildSharedFullAutoExecutionUserMessage;

function buildFullAutoDirectoryConfirmQuestion(
  question: ComposerQuestion,
  folder: string,
  params: {
    optionLabel: string;
    valuePrefix: string;
  },
): ComposerQuestion {
  const encodedFolder = encodeURIComponent(folder);
  return {
    ...question,
    id: `${question.id}:confirm-path`,
    description: "目录已选择，确认后才会写入当前预采集策略。",
    options: [
      {
        id: `${question.id}:confirm-path-option`,
        label: params.optionLabel,
        value: `${params.valuePrefix}${encodedFolder}`,
        rationale: folder,
      },
    ],
  };
}

export function buildFullAutoVideoExportPathConfirmQuestion(
  question: ComposerQuestion,
  folder: string,
): ComposerQuestion {
  return buildFullAutoDirectoryConfirmQuestion(question, folder, {
    optionLabel: "确认使用该导出目录",
    valuePrefix: "video:export:path:",
  });
}

export function buildFullAutoScriptExportPathConfirmQuestion(
  question: ComposerQuestion,
  folder: string,
): ComposerQuestion {
  return buildFullAutoDirectoryConfirmQuestion(question, folder, {
    optionLabel: "确认使用该剧本文档目录",
    valuePrefix: "script:export:path:",
  });
}

export function buildFullAutoStoryboardXlsxExportPathConfirmQuestion(
  question: ComposerQuestion,
  folder: string,
): ComposerQuestion {
  return buildFullAutoDirectoryConfirmQuestion(question, folder, {
    optionLabel: "确认使用该分镜 xlsx 目录",
    valuePrefix: "video:bridge:export-xlsx:path:",
  });
}

function buildFullAutoScriptExportBaseName(title: string | undefined, extension: string): string {
  const stem = sanitizeExportFileName(title?.trim() ? title.trim() : "script", "script");
  return `${stem}${extension}`;
}

function buildFullAutoExportPath(directoryPath: string, fileName: string): string {
  return `${directoryPath.replace(/[\\/]+$/, "")}/${fileName}`;
}

async function exportFullAutoScriptDocumentToDirectory(params: {
  plan: FullAutoRunPlan;
  runtime: StudioRuntimeState;
  directoryPath: string;
}): Promise<string | null> {
  const project = params.runtime.currentDramaProject;
  const exportMode = getFullAutoStrategyValue(params.plan, "scriptDocumentExport");
  if (!project || !project.setup || !exportMode || exportMode === "script:export-local:skip") {
    return null;
  }

  if (exportMode === "script:export-download-md") {
    const markdown =
      project.exportDocument?.trim() ||
      buildQuickExportMarkdown(
        project.setup,
        project.dramaTitle,
        project.creativePlan || project.structureTransform || "",
        project.characters,
        project.episodes,
      );
    const fileName = buildFullAutoScriptExportBaseName(project.dramaTitle, ".md");
    const filePath = buildFullAutoExportPath(params.directoryPath, fileName);
    await exportMarkdownTextLocally(fileName, markdown, filePath);
    return `已自动导出剧本文档：${filePath}`;
  }

  if (exportMode === "script:export-word") {
    const fileName = buildFullAutoScriptExportBaseName(project.dramaTitle, ".docx");
    const filePath = buildFullAutoExportPath(params.directoryPath, fileName);
    const { exportToDocx } = await import("@/lib/export-docx");
    await exportToDocx(
      project.setup,
      project.dramaTitle,
      project.creativePlan || project.structureTransform || "",
      project.characters,
      project.episodes,
      { preferredFilePath: filePath },
    );
    return `已自动导出 Word 文档：${filePath}`;
  }

  if (exportMode === "script:export-episodes-download") {
    const exportDir = buildFullAutoExportPath(
      params.directoryPath,
      sanitizeExportFileName(`${project.dramaTitle || "script"}-分集`, "script-episodes"),
    );
    const result = await exportEpisodeMarkdownFilesLocally(project.episodes, exportDir);
    const count = result.status === "saved" ? result.filePaths?.length ?? project.episodes.length : 0;
    return `已自动导出 ${count} 份分集 Markdown：${exportDir}`;
  }

  return null;
}

async function exportFullAutoSkippedScriptBundleToDirectory(params: {
  runtime: StudioRuntimeState;
  directoryPath: string;
}): Promise<string[]> {
  const project = params.runtime.currentDramaProject;
  if (!project?.setup) return [];

  const bundleDir = buildFullAutoExportPath(
    params.directoryPath,
    sanitizeExportFileName(`${project.dramaTitle || "script"}-剧本文档`, "script-documents"),
  );
  const markdown =
    project.exportDocument?.trim() ||
    buildQuickExportMarkdown(
      project.setup,
      project.dramaTitle,
      project.creativePlan || project.structureTransform || "",
      project.characters,
      project.episodes,
    );

  const markdownName = buildFullAutoScriptExportBaseName(project.dramaTitle, ".md");
  await exportMarkdownTextLocally(markdownName, markdown, buildFullAutoExportPath(bundleDir, markdownName));

  const { exportToDocx } = await import("@/lib/export-docx");
  const docxName = buildFullAutoScriptExportBaseName(project.dramaTitle, ".docx");
  await exportToDocx(
    project.setup,
    project.dramaTitle,
    project.creativePlan || project.structureTransform || "",
    project.characters,
    project.episodes,
    {
      preferredFilePath: buildFullAutoExportPath(bundleDir, docxName),
    },
  );

  await exportEpisodeMarkdownFilesLocally(
    project.episodes,
    buildFullAutoExportPath(bundleDir, "分集Markdown"),
  );

  return [
    `已在最终导出目录补齐剧本文档：${bundleDir}`,
  ];
}

async function exportFullAutoStoryboardXlsxToDirectory(params: {
  runtime: StudioRuntimeState;
  directoryPath: string;
}): Promise<string | null> {
  const videoProject = params.runtime.currentVideoProject;
  if (!videoProject?.scenes?.length) return null;
  const { exportScenesToXlsx } = await import("@/lib/export-xlsx");
  const result = await exportScenesToXlsx(
    videoProject.scenes,
    videoProject.title,
    videoProject.characters || [],
    videoProject.sceneSettings || [],
    { directoryPath: params.directoryPath },
  );
  return result?.filePath ? `已自动导出分镜 xlsx：${result.filePath}` : null;
}

async function runFullAutoPostStepLocalExports(params: {
  step: FullAutoRunStep;
  plan: FullAutoRunPlan;
  runtime: StudioRuntimeState;
}): Promise<string[]> {
  const messages: string[] = [];

  if (params.step.id === "script-export") {
    const directoryPath = getFullAutoScriptDocumentExportDirectoryPath(params.plan);
    if (directoryPath) {
      const message = await exportFullAutoScriptDocumentToDirectory({
        plan: params.plan,
        runtime: params.runtime,
        directoryPath,
      });
      if (message) messages.push(message);
    }
  }

  if (params.step.id === "video-entities") {
    const directoryPath = getFullAutoStoryboardXlsxExportDirectoryPath(params.plan);
    if (directoryPath) {
      const message = await exportFullAutoStoryboardXlsxToDirectory({
        runtime: params.runtime,
        directoryPath,
      });
      if (message) messages.push(message);
    }
  }

  if (params.step.id === "video-export") {
    const finalDirectoryPath = getFullAutoExportDirectoryPath(params.plan);
    if (finalDirectoryPath) {
      if (getFullAutoStrategyValue(params.plan, "scriptDocumentExport") === "script:export-local:skip") {
        messages.push(...await exportFullAutoSkippedScriptBundleToDirectory({
          runtime: params.runtime,
          directoryPath: finalDirectoryPath,
        }));
      }
      if (getFullAutoStrategyValue(params.plan, "storyboardXlsxExport") === "video:bridge:export-xlsx:skip") {
        const message = await exportFullAutoStoryboardXlsxToDirectory({
          runtime: params.runtime,
          directoryPath: finalDirectoryPath,
        });
        if (message) messages.push(message);
      }
    }
  }

  return messages;
}

function applyHiddenFullAutoStrategyAnswer(params: {
  plan: FullAutoRunPlan;
  key: string;
  phase: string;
  value: string;
  label: string;
}): FullAutoRunPlan {
  return syncFullAutoPlanSteps({
    ...params.plan,
    answers: {
      ...params.plan.answers,
      [params.key]: params.value,
    },
    displayAnswers: {
      ...params.plan.displayAnswers,
      [params.key]: params.label,
    },
    collectedAnswers: {
      ...(params.plan.collectedAnswers ?? {}),
      [params.key]: params.value,
    },
    stageStrategies: {
      ...(params.plan.stageStrategies ?? {}),
      [params.key]: {
        key: params.key,
        phase: params.phase,
        value: params.value,
        label: params.label,
      },
    },
  });
}

function hasRunningVideoGenerationTasks(
  videoProject: Pick<StudioRuntimeState, "currentVideoProject">["currentVideoProject"] | null | undefined,
): boolean {
  return Boolean(
    videoProject?.scenes?.some((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return Boolean(scene.videoTaskId) && (status === "queued" || status === "processing");
    }),
  );
}

function shouldSuppressRunningVideoRefreshPanel(
  question: ComposerQuestion | null | undefined,
  runtime: Pick<StudioRuntimeState, "currentVideoProject"> | null | undefined,
): boolean {
  return (
    question?.answerKey === "video-refresh-panel" &&
    hasRunningVideoGenerationTasks(runtime?.currentVideoProject)
  );
}

function formatQuestionOptionLines(
  options: ComposerQuestion["options"],
  remaining: { count: number },
  depth = 0,
): string[] {
  const lines: string[] = [];

  for (const option of options) {
    if (remaining.count <= 0) break;

    const prefix = `${"  ".repeat(depth)}- `;
    const rationale = truncateOverlayLine(option.rationale, 120);
    const inputHint = option.childInput ? ` [input:${option.childInput.type}]` : "";
    const disabledHint = option.disabled ? " [disabled]" : "";
    lines.push(
      `${prefix}${truncateOverlayLine(option.label, 120)} -> ${option.value}${inputHint}${disabledHint}${rationale ? ` (${rationale})` : ""}`,
    );
    remaining.count -= 1;

    if (option.children?.length && remaining.count > 0) {
      lines.push(...formatQuestionOptionLines(option.children, remaining, depth + 1));
    }
  }

  return lines;
}

function formatComposerQuestionBlueprint(
  label: string,
  question: ComposerQuestion | null | undefined,
): string | null {
  if (!question?.options?.length) return null;

  const remaining = { count: 12 };
  const optionLines = formatQuestionOptionLines(question.options, remaining);
  if (!optionLines.length) return null;

  return [
    `[${label}]`,
    `Prompt: ${truncateOverlayLine(question.title, 220)}`,
    question.description ? `Context: ${truncateOverlayLine(question.description, 240)}` : "",
    `Submission: ${question.submissionMode}; custom_input=${question.allowCustomInput ? "yes" : "no"}`,
    "Suggested options:",
    ...optionLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAskUserRequestBlueprint(
  label: string,
  request: AskUserQuestionRequest | null | undefined,
): string | null {
  if (!request?.questions?.length) return null;

  const lines = request.questions.slice(0, 2).flatMap((question, index) => {
    const options = (question.options ?? []).slice(0, index === 0 ? 8 : 4).map((option) => {
      const rationale = truncateOverlayLine(option.rationale ?? option.description, 120);
      return `- ${option.label} -> ${option.value}${rationale ? ` (${rationale})` : ""}`;
    });

    return [
      `Question ${index + 1}: ${truncateOverlayLine(question.question, 220)}`,
      ...options,
    ];
  });

  return [
    `[${label}]`,
    request.title ? `Prompt: ${truncateOverlayLine(request.title, 220)}` : "",
    request.description ? `Context: ${truncateOverlayLine(request.description, 240)}` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseFullAutoEpisodeNumberSelection(raw: string): number[] {
  return raw
    .split(/[,+，]/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
        const lower = Math.min(start, end);
        const upper = Math.max(start, end);
        return Array.from({ length: upper - lower + 1 }, (_, index) => lower + index);
      }
      const number = Number(trimmed);
      return Number.isFinite(number) ? [number] : [];
    })
    .filter((number, index, list) => number > 0 && list.indexOf(number) === index);
}

function questionHasOptionValue(
  question: ComposerQuestion | null | undefined,
  targetValue: string,
): boolean {
  if (!question) return false;

  const stack = [...question.options];
  while (stack.length) {
    const option = stack.shift();
    if (!option) continue;
    if (option.value === targetValue) return true;
    if (option.children?.length) {
      stack.push(...option.children);
    }
  }

  return false;
}

function buildStageQuestionBlueprints(runtime: StudioRuntimeState): string[] {
  const snapshot = runtime.currentProjectSnapshot;
  if (!snapshot) {
    const kickoffBlueprint = formatAskUserRequestBlueprint(
      "Original script kickoff popup schema",
      buildOriginalScriptKickoffRequest(),
    );
    return kickoffBlueprint ? [kickoffBlueprint] : [];
  }

  const primaryQuestion = recQuestion(snapshot, runtime.currentVideoProject);
  const candidates = [
    formatComposerQuestionBlueprint("Primary next-step popup schema", primaryQuestion),
    snapshot.projectKind !== "video"
      ? formatComposerQuestionBlueprint(
          "Script outline detail schema",
          buildOutlinesWorkflowQuestion(snapshot),
        )
      : null,
    snapshot.projectKind !== "video"
      ? formatComposerQuestionBlueprint(
          "Script episode detail schema",
          buildEpisodeWorkflowQuestion(snapshot),
        )
      : null,
    snapshot.projectKind === "video"
      ? formatComposerQuestionBlueprint(
          "Video continuation schema",
          buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject),
        )
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (questionHasOptionValue(primaryQuestion, "script:export-video")) {
    candidates.push(
      [
        "[Script to Video Bridge Guidance]",
        "If the user is ready to leave script export, include the bridge-to-video choice in AskUserQuestion instead of leaving it as plain text.",
        "After the bridge is chosen, keep guiding inside the same conversation through video analysis -> entity extraction -> storyboard -> prompt batch -> generation -> review.",
      ].join("\n"),
    );
  }

  if (snapshot.projectKind === "video") {
    candidates.push(
      [
        "[Video Workflow Guidance]",
        "Ask missing video details step by step through AskUserQuestion, especially platform goal, shot/style lock, prompt batch scope, generation batch, refresh, and review.",
        "Do not collapse script-to-video continuation into a single broad question when a finer popup already exists.",
      ].join("\n"),
    );
  }

  return candidates;
}

function buildAdaptationResearchLlmOverlay(plan: AutoResearchPlan): string {
  return [
    "[Adaptation Research Guidance]",
    `用户正在启动改编研究，涉及 ${plan.tasks.map((t) => t.title).join("、")} 三个方向。`,
    "请依次通过 AskUserQuestion 工具询问用户对每个方向的偏好，每次只问一个方向，等用户回答后再问下一个。",
    "改编路线：询问用户想保留原内容的哪些部分、重做哪些部分（建议选项：保留原结构重做人物 / 保留人物重做结构 / 全面本地化改写 / 暂不确定先给建议）。",
    "受众适配：询问用户目标受众和市场方向（建议选项：中文市场 / 海外英文市场 / 日韩市场 / 全球多语 / 暂不确定先给建议）。",
    "角色重塑：询问用户想如何重塑人物关系（建议选项：保留原角色关系 / 重塑主角设定 / 全面重设人物关系 / 暂不确定先给建议）。",
    "收集完三个方向的偏好后，整合用户选择并给出改编研究方向总结。",
  ].join("\n");
}

export function buildLlmConversationOverlay(params: {
  runtime: StudioRuntimeState;
  deferredQuestionState: StudioQuestionState | null;
  automationMode?: AutomationMode;
}): string {
  const { runtime, deferredQuestionState, automationMode = "manual" } = params;
  const snapshot = runtime.currentProjectSnapshot;
  const scriptWorkflowStage =
    snapshot && (snapshot.projectKind === "script" || snapshot.projectKind === "adaptation")
      ? resolveScriptWorkflowStage(snapshot.derivedStage)
      : null;

  const lines = [
    "[Workflow Context Overlay]",
    snapshot
      ? `当前项目: ${snapshot.title} / ${snapshot.projectKind} / ${snapshot.derivedStage}`
      : "当前项目: 暂无",
    snapshot?.currentObjective
      ? `当前目标: ${truncateOverlayLine(snapshot.currentObjective, 240)}`
      : "当前目标: 暂无",
  ];

  if (deferredQuestionState?.request?.questions?.length) {
    const activeQuestion =
      deferredQuestionState.request.questions[deferredQuestionState.currentIndex] ??
      deferredQuestionState.request.questions[0];
    lines.push(
      `挂起问题: ${truncateOverlayLine(activeQuestion?.header || activeQuestion?.question, 200) || "未命名问题"}`,
    );
    lines.push(
      `规则: 当前有一个已挂起的标准弹窗，本轮只允许先用自然语言回应，再恢复同一个弹窗：${truncateOverlayLine(activeQuestion?.question || activeQuestion?.header || "未命名问题", 220)}。不要新建任何 AskUserQuestion、编号选项列表、Markdown 伪弹窗或替代问卷。`,
    );
    lines.push(
      "Rule: While a suspended popup exists, do not replace it with a different question even if another question seems helpful. Answer the user's clarification in plain text and then restore the suspended popup unchanged.",
    );
  } else {
    lines.push("挂起问题: 无");
  }

  if (!snapshot) {
    lines.push(
      "规则: 当前没有活动项目时，视为从零开始的新对话。先用自然语言理解用户要做什么、手里已有的素材，以及希望最终拿到什么，再逐步把用户带入对应工作流；在这些信息明确前，不要假设项目类型，也不要直接执行工作流动作。",
    );
    lines.push(
      automationMode === "full-auto"
        ? "规则: 当前处于全自动模式，首页空白对话最终只从原创剧本主链路启动；但如果用户只是寒暄、试探、让你先介绍，或暂时还没想清楚，不要立刻弹 AskUserQuestion，先自然回复并说明你会如何一步步帮他收敛到原创剧本入口。"
        : "规则: 当前处于普通模式，首页空白对话可以先自然聊天和缩小范围；只有当用户已经明确要进入 原创剧本 / 参考改编 / 视频工作流，或当前回复确实需要用户在几个入口之间做明确选择时，才使用 AskUserQuestion 或标准入口问卷。",
    );
    lines.push(
      "规则: 对于“你好”“你先带我一下”“我还没想好怎么开始”这类首页首轮输入，先给出正常、具体、有帮助的自然语言回复，再用一句简短追问把范围缩小；不要一上来就弹结构化问题。",
    );
  }

  lines.push(
    "规则: 如果用户这次输入与挂起问题或当前流程无关，先正常回答用户当前问题，不要把自由输入或附件隐式当成步骤答案。",
  );
  lines.push(
    "规则: 若回答后仍适合继续流程，先明确你识别到的当前阶段，再恢复当前步骤；不要强行拉回，也不要自动执行下一步。",
  );

  const deferredQuestionBlueprint = deferredQuestionState?.request
    ? formatAskUserRequestBlueprint("Suspended workflow question schema", deferredQuestionState.request)
    : null;
  const questionBlueprints = buildStageQuestionBlueprints(runtime);
  const blueprints = [
    ...(questionBlueprints.length ? questionBlueprints : []),
    ...(deferredQuestionBlueprint ? [deferredQuestionBlueprint] : []),
  ];
  if (blueprints.length) {
    lines.splice(3, 0, ...blueprints);
  }

  lines.push(
    "规则: 如果用户只是寒暄、确认收到、询问规则、让你解释选项，绝不要把这类句子改写成步骤答案，也不要替用户套用默认值。",
  );
  lines.push(
    "Rule: First identify the current workflow stage from the snapshot above before you answer. All follow-ups and suggestions must stay inside that current stage.",
  );
  lines.push(
    "Rule: Every reply must end with forward guidance. Either end with a short '下一步建议：...' line, or call AskUserQuestion for the current step after you explain the context in text.",
  );
  lines.push(
    "Rule: Use AskUserQuestion only when the current step genuinely has a structured decision point. Otherwise, use one short plain-text follow-up for the next missing detail.",
  );
  lines.push(
    "Rule: Greetings, acknowledgements, meta questions, and requests to explain options are not structured workflow answers. Do not rewrite them into step values, and do not silently apply defaults for the user.",
  );
  lines.push(
    "Rule: If the user asks who you are or what this product does, answer from the InFinio product role first. Describe yourself as the homepage creative/workflow agent that keeps script creation, adaptation, video production, asset accumulation, review, and export inside one conversation. Do not lead with the underlying model vendor or model id unless the user explicitly asks for that technical detail.",
  );
  lines.push(
    "Rule: If a standard popup for the current step is already on screen and the user asks you to compare or explain its options, answer in text first and then restore that same popup. Do not swap it for a new generic AskUserQuestion unless the original popup is no longer applicable.",
  );
  lines.push(
    "Rule: The LLM should guide the workflow without sounding robotic. Natural-language explanation, brainstorming, comparison, and concise examples are allowed when they help the current step.",
  );
  lines.push(
    "Rule: Do not pretend that workflow-only artifacts, downstream media, or later-stage execution already happened in plain text. For real execution, either call HomeStudioWorkflow when the current step is ready or explain the missing prerequisite first.",
  );
  lines.push(
    "Rule: Proactively collect the next missing structured detail for the current stage instead of asking only broad open-ended questions.",
  );
  lines.push(
    "Rule: Stay focused on the single current unfinished step. Do not repeat outputs or details from already-completed steps unless the user explicitly asks to review them or the current step is blocked without one specific detail from them.",
  );
  lines.push(
    "Rule: In a fresh conversation, collect the minimum information needed for the current workflow step first, then clearly anchor the user to that step before moving on.",
  );
  lines.push(
    "Rule: Never suggest, collect, or execute a later-stage action when the current stage has not been completed yet. No step skipping.",
  );
  lines.push(
    "Rule: If the user asks for something you cannot truly complete in the current workflow state, do not promise execution, do not propose workaround generations, and do not discuss completed earlier steps. Briefly explain that it is not executable now, then guide the user back to the current unfinished step only.",
  );
  lines.push(
    "Rule: HomeStudioWorkflow is allowed, but only for real executable actions inside the current unfinished step after the required inputs are already complete. If that condition is not met, stay in guidance mode and ask for the missing current-step input instead.",
  );
  if (scriptWorkflowStage) {
    lines.push(
      "Rule: In script/adaptation workflow stages, never execute or promise image generation, storyboard generation, video generation, or any other media-production action, because those belong to later workflows.",
    );
    lines.push(
      "Rule: If the user asks for a later media step anyway, reply in Chinese with only the current stage, why the requested media step is blocked right now, and the exact unfinished step the user should complete next. Do not recap already-completed step content unless the user explicitly asks for review.",
    );
    lines.push(
      "Rule: If the user gives off-step information while asking for a later media step, analyze whether that information is useful for the current step and say so briefly, but do not turn it into permission to skip ahead.",
    );
    lines.push(
      "Rule: Keep blocked later-step replies concise. Do not output long inventories of completed work, preset status recaps, or multi-paragraph workflow summaries.",
    );
  }
  const candidate = snapshot?.recommendedActions?.[0];
  if (candidate) {
    lines.push(`下一步：${truncateOverlayLine(candidate, 240)}`);
  }
  lines.push(
    "Rule: Never expose internal reasoning or chain-of-thought in the reply. Output conclusions and actions only.",
  );
  lines.push(
    "Rule: If the user's input is vague or says '随便'/'都行'/'你决定', call AskUserQuestion with 2-4 concrete options immediately instead of guessing.",
  );

  return lines.join("\n");
}

export function useHomeAgentRuntimeActions(params: {
  runtime: StudioRuntimeState;
  systemPrompt: string;
  creationMode: import("@/lib/home-agent/types").CreationMode;
  automationMode: AutomationMode;
  qState: StudioQuestionState | null;
  deferredQuestionState: StudioQuestionState | null;
  engineRef: React.MutableRefObject<Awaited<ReturnType<typeof getOrCreateHomeAgentEngine>> | null>;
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  messagesRef: React.MutableRefObject<HomeAgentMessage[]>;
  compactedMessageCountRef: React.MutableRefObject<number>;
  surfacedTaskIdsRef: React.MutableRefObject<Set<string>>;
  surfacedTaskFollowupIdsRef: React.MutableRefObject<Set<string>>;
  loadEngineDeps: () => Promise<HomeAgentEngineDeps>;
  loadApiConfigModule: () => Promise<HomeAgentApiConfigModule>;
  loadStructuredQuestionParser: () => Promise<StructuredQuestionParserModule>;
  loadConversationMemoryModule: () => Promise<ConversationMemoryModule>;
  loadProjectStore: () => Promise<ProjectStoreModule>;
  loadAskUserQuestionModule: () => Promise<AskUserQuestionModule>;
  loadWorkflowActionsModule: () => Promise<{
    runWorkflowAction: (
      action: string,
      input: Record<string, unknown>,
      runtime: StudioRuntimeState,
      onProgress?: import("@/lib/home-agent/types").WorkflowActionProgressCallback,
    ) => Promise<import("@/lib/home-agent/types").WorkflowActionResult>;
  }>;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  resetComposerDraft: (value?: string) => void;
  buildResearchPromptOverlay: (plan: AutoResearchPlan, taskIds: string[]) => string;
  createQuestionState: (
    request: AskUserQuestionRequest,
    source?: StudioQuestionState["source"],
  ) => StudioQuestionState;
  toQuery: (messages: HomeAgentMessage[]) => Message[];
  textOf: (value: unknown) => string;
  qStepKey: (index: number, question: { header?: string }) => string;
  push: (
    role: HomeAgentMessage["role"],
    content: string,
    artifactIds?: string[],
    attachments?: ChatAttachment[],
  ) => void;
  selectedTextModelKey: string;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setMode: React.Dispatch<React.SetStateAction<"idle" | "active" | "recovering" | "maintenance-review">>;
  setQState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setDeferredQuestionState: React.Dispatch<React.SetStateAction<StudioQuestionState | null>>;
  setSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setDeferredSelectedValues: React.Dispatch<React.SetStateAction<string[]>>;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setCompactedMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setMessages: React.Dispatch<React.SetStateAction<HomeAgentMessage[]>>;
  setMetaReady: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveWorkflowAction: React.Dispatch<React.SetStateAction<string | null>>;
  setFullAutoChecklistCollapsed?: React.Dispatch<React.SetStateAction<boolean>>;
  activeProjectId?: string;
  pendingWorkflowUploadKind?: PendingWorkflowUploadKind | null;
  setPendingWorkflowUploadKind?: React.Dispatch<React.SetStateAction<PendingWorkflowUploadKind | null>>;
  setDeferredDraft: React.Dispatch<React.SetStateAction<string>>;
  lastSuggestedRef: React.MutableRefObject<ComposerQuestion | null>;
  backgroundResearchGroupsRef: React.MutableRefObject<import("./home-agent-task-utils").BackgroundResearchGroup[]>;
  selectedImageModelFamily?: VideoImageModelFamilyKey;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  selectedVideoModelKey?: VideoGenerationModelKey;
  videoGenerationPrefs?: VideoGenerationPrefs;
  restoreInterruptedChoiceQuestion?: (question: ComposerQuestion | null) => boolean;
  setInterruptedChoiceQuestion?: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  requestScrollToBottom?: () => void;
  preferredVideoWorkflowSourceSnapshotRef?: React.MutableRefObject<ConversationProjectSnapshot | null>;
}) {
  const {
    runtime,
    systemPrompt,
    creationMode,
    automationMode,
    qState,
    deferredQuestionState,
    engineRef,
    runtimeRef,
    messagesRef,
    compactedMessageCountRef,
    surfacedTaskIdsRef,
    surfacedTaskFollowupIdsRef,
    loadEngineDeps,
    loadApiConfigModule,
    loadStructuredQuestionParser,
    loadConversationMemoryModule,
    loadProjectStore,
    loadAskUserQuestionModule,
    loadWorkflowActionsModule,
    flashMaintenanceHint,
    resetComposerDraft,
    buildResearchPromptOverlay,
    createQuestionState,
    toQuery,
    textOf,
    qStepKey,
    push,
    selectedTextModelKey,
    setPopoverOverride,
    setSuggested,
    setMode,
    setQState,
    setDeferredQuestionState,
    setSelectedValues,
    setDeferredSelectedValues,
    setStreaming,
    setRuntime,
    setCompactedMessageCount,
    setMessages,
    setMetaReady,
    setActiveProjectId,
    setActiveWorkflowAction,
    setFullAutoChecklistCollapsed,
    activeProjectId,
    pendingWorkflowUploadKind = null,
    setPendingWorkflowUploadKind,
    setDeferredDraft,
    lastSuggestedRef,
    backgroundResearchGroupsRef,
    selectedImageModelFamily = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
    imageGenerationPrefs = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    selectedVideoModelKey = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
    videoGenerationPrefs = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    restoreInterruptedChoiceQuestion,
    setInterruptedChoiceQuestion,
    requestScrollToBottom,
    preferredVideoWorkflowSourceSnapshotRef,
  } = params;
  const sendRunIdRef = useRef(0);
  const pendingAutoResearchPlanRef = useRef<AutoResearchPlan | null>(null);
  const pendingAutoResearchSelectionsRef = useRef<Record<string, string>>({});
  const streamingMessageIdRef = useRef<string | null>(null);
  const pendingStreamingDeltaRef = useRef("");
  const streamingDeltaRafRef = useRef<number | null>(null);
  const hasStreamedVisibleTextRef = useRef(false);
  const pendingStreamingFinalizeRef = useRef<{
    finalText?: string;
    artifactIds?: string[];
    artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[];
  } | null>(null);
  const pendingAdaptationUploadRef = useRef(false);
  const pendingVideoUploadRef = useRef(false);
  const pendingFullAutoWorkflowUploadRef = useRef<PendingWorkflowUploadKind | null>(null);
  const activeFullAutoShortcutRef = useRef<"script" | "adaptation" | "video" | null>(null);
  const fullAutoUserStoppedRef = useRef(false);
  const fullAutoExecutionEpochRef = useRef(0);
  const [isAwaitingWorkflowDocumentUpload, setIsAwaitingWorkflowDocumentUpload] = useState(
    Boolean(pendingWorkflowUploadKind),
  );
  const activeExecutionAbortRef = useRef<AbortController | null>(null);
  const activeRemoteVideoTasksRef = useRef<Map<string, ActiveRemoteVideoTask>>(new Map());
  const restoredFullAutoFollowupKeyRef = useRef<string | null>(null);

  const cancelPendingStreamingDeltaFlush = useCallback(() => {
    if (streamingDeltaRafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(streamingDeltaRafRef.current);
    }
    streamingDeltaRafRef.current = null;
  }, []);

  const resetPendingStreamingDelta = useCallback(() => {
    pendingStreamingDeltaRef.current = "";
    pendingStreamingFinalizeRef.current = null;
    hasStreamedVisibleTextRef.current = false;
    cancelPendingStreamingDeltaFlush();
  }, [cancelPendingStreamingDeltaFlush]);

  const syncPendingWorkflowUploadState = useCallback((nextKind: PendingWorkflowUploadKind | null) => {
    pendingAdaptationUploadRef.current = nextKind === "adaptation";
    pendingVideoUploadRef.current = nextKind === "video";
    setIsAwaitingWorkflowDocumentUpload(Boolean(nextKind));
  }, []);

  const setPendingWorkflowUploadState = useCallback((nextKind: PendingWorkflowUploadKind | null) => {
    syncPendingWorkflowUploadState(nextKind);
    setPendingWorkflowUploadKind?.(nextKind);
  }, [setPendingWorkflowUploadKind, syncPendingWorkflowUploadState]);

  const setPendingAdaptationUpload = useCallback((next: boolean) => {
    setPendingWorkflowUploadState(next ? "adaptation" : (pendingVideoUploadRef.current ? "video" : null));
  }, [setPendingWorkflowUploadState]);

  const setPendingVideoUpload = useCallback((next: boolean) => {
    setPendingWorkflowUploadState(next ? "video" : (pendingAdaptationUploadRef.current ? "adaptation" : null));
  }, [setPendingWorkflowUploadState]);

  const clearPendingWorkflowUploads = useCallback(() => {
    pendingFullAutoWorkflowUploadRef.current = null;
    setPendingWorkflowUploadState(null);
  }, [setPendingWorkflowUploadState]);

  const resolvePreferredVideoWorkflowSourceSnapshot = useCallback(() => {
    const currentSnapshot = runtimeRef.current.currentProjectSnapshot;
    if (isBridgeableVideoWorkflowSourceSnapshot(currentSnapshot)) {
      return currentSnapshot;
    }

    const preservedSnapshot = preferredVideoWorkflowSourceSnapshotRef?.current;
    if (isBridgeableVideoWorkflowSourceSnapshot(preservedSnapshot)) {
      return preservedSnapshot;
    }

    return null;
  }, [preferredVideoWorkflowSourceSnapshotRef, runtimeRef]);

  const syncActiveProjectIdWithSnapshot = useCallback(
    (
      snapshot?: Pick<ConversationProjectSnapshot, "projectId" | "projectKind" | "sourceProjectId"> | null,
      fallbackProjectId?: string | null,
    ) => {
      const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: activeProjectId,
        snapshot,
        fallbackProjectId,
      });
      if (nextSessionProjectId) {
        setActiveProjectId(nextSessionProjectId);
      }
    },
    [activeProjectId, setActiveProjectId],
  );

  useEffect(() => {
    syncPendingWorkflowUploadState(pendingWorkflowUploadKind ?? null);
  }, [activeProjectId, pendingWorkflowUploadKind, syncPendingWorkflowUploadState]);

  const trackActiveRemoteVideoTask = useCallback((task: ActiveRemoteVideoTask) => {
    const taskId = task.taskId.trim();
    if (!taskId) return;
    const provider = task.provider?.trim() || "jimeng";
    activeRemoteVideoTasksRef.current.set(`${provider}:${taskId}`, {
      taskId,
      provider,
    });
  }, []);

  const untrackActiveRemoteVideoTask = useCallback((taskId: string, provider?: string) => {
    const trimmedTaskId = taskId.trim();
    if (!trimmedTaskId) return;
    const trimmedProvider = provider?.trim();
    if (trimmedProvider) {
      activeRemoteVideoTasksRef.current.delete(`${trimmedProvider}:${trimmedTaskId}`);
      return;
    }

    for (const [key, task] of activeRemoteVideoTasksRef.current.entries()) {
      if (task.taskId === trimmedTaskId) {
        activeRemoteVideoTasksRef.current.delete(key);
      }
    }
  }, []);

  const syncTrackedRemoteVideoTasksFromRuntime = useCallback((runtime: StudioRuntimeState) => {
    const nextTasks = new Map<string, ActiveRemoteVideoTask>();
    for (const scene of runtime.currentVideoProject?.scenes || []) {
      const taskId = String(scene.videoTaskId || "").trim();
      const status = String(scene.videoStatus || "").trim().toLowerCase();
      if (!taskId || (status !== "queued" && status !== "processing")) continue;
      const provider = String(scene.videoProvider || "jimeng").trim() || "jimeng";
      nextTasks.set(`${provider}:${taskId}`, {
        taskId,
        provider,
      });
    }
    activeRemoteVideoTasksRef.current = nextTasks;
  }, []);

  const cancelTrackedRemoteVideoTasks = useCallback((): number => {
    const tasks = [...activeRemoteVideoTasksRef.current.values()];
    activeRemoteVideoTasksRef.current.clear();

    for (const task of tasks) {
      void invokeFunctionLazy("generate-video", {
        action: "cancel",
        taskId: task.taskId,
        provider: task.provider,
      });
    }

    return tasks.length;
  }, []);

  const getRuntimeWithGenerationPrefs = useCallback((): StudioRuntimeState => {
    const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
      ...videoGenerationPrefs,
      modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
    });
    const runtime = runtimeRef.current;
    if (!runtime.currentVideoProject) {
      return runtime;
    }

    return {
      ...runtime,
      currentVideoProject: {
        ...runtime.currentVideoProject,
        videoGenerationPrefs: normalizedVideoPrefs,
      },
    };
  }, [runtimeRef, selectedVideoModelKey, videoGenerationPrefs]);

  const setWorkflowPopoverQuestion = useCallback(
    (question: ComposerQuestion | null) => {
      if (shouldSuppressRunningVideoRefreshPanel(question, runtimeRef.current)) {
        return;
      }
      setPopoverOverride(question);
    },
    [runtimeRef, setPopoverOverride],
  );

  const decorateFullAutoWorkflowInput = useCallback(
    (input: Record<string, unknown>, abortSignal?: AbortSignal) => {
      const inputImagePrefs =
        typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs
          ? input.imageGenerationPrefs
          : {};
      const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
        ...imageGenerationPrefs,
        familyKey: selectedImageModelFamily,
        ...inputImagePrefs,
      });
      const inputVideoPrefs =
        typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs
          ? input.videoGenerationPrefs
          : {};
      const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
        ...videoGenerationPrefs,
        modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
        ...inputVideoPrefs,
      });

      return {
        ...input,
        selectedImageModelFamily: normalizedImagePrefs.familyKey,
        modelFamily: normalizedImagePrefs.familyKey,
        imageGenerationPrefs: normalizedImagePrefs,
        selectedVideoModelKey: normalizedVideoPrefs.modelKey,
        videoModelKey: normalizedVideoPrefs.modelKey,
        videoGenerationPrefs: normalizedVideoPrefs,
        ...(abortSignal ? { abortSignal } : {}),
      };
    },
    [imageGenerationPrefs, selectedImageModelFamily, selectedVideoModelKey, videoGenerationPrefs],
  );

  const commitFullAutoRunState = useCallback(
    (state: FullAutoRunState) => {
      setRuntime((prev) => {
        const nextSnapshot = prev.currentProjectSnapshot
          ? { ...prev.currentProjectSnapshot, automationMode: "full-auto" as const }
          : prev.currentProjectSnapshot;
        const nextRuntime = {
          ...prev,
          currentProjectSnapshot: nextSnapshot,
          fullAutoRun: state,
        };
        runtimeRef.current = nextRuntime;
        return nextRuntime;
      });
    },
    [runtimeRef, setRuntime],
  );

  useEffect(() => {
    if (automationMode !== "full-auto") {
      restoredFullAutoFollowupKeyRef.current = null;
      return;
    }
    if (qState || deferredQuestionState || pendingWorkflowUploadKind) return;

    const snapshot = runtime.currentProjectSnapshot;
    const run = runtime.fullAutoRun;
    if (!snapshot?.projectId || snapshot.automationMode !== "full-auto" || !run?.plan) return;

    const restoredRun = normalizeFullAutoRunStateForRestore({
      run,
      runtime,
      hasActiveExecution: Boolean(activeExecutionAbortRef.current),
    });
    const followupQuestion = buildFullAutoWorkflowFollowupQuestion({
      run: restoredRun,
      runtime,
    });
    if (!followupQuestion) return;
    if (followupQuestion.answerKey !== "full-auto-resume" && followupQuestion.answerKey !== "full-auto-completed") {
      return;
    }

    const restoreKey = [
      snapshot.projectId,
      restoredRun?.status ?? "",
      restoredRun?.currentStepIndex ?? "",
      restoredRun?.plan?.resumeFromStepId ?? "",
      followupQuestion.answerKey,
    ].join(":");
    if (restoredFullAutoFollowupKeyRef.current === restoreKey) return;
    restoredFullAutoFollowupKeyRef.current = restoreKey;

    if (
      restoredRun &&
      (restoredRun.status !== run.status ||
        restoredRun.currentStepIndex !== run.currentStepIndex ||
        restoredRun.plan !== run.plan)
    ) {
      commitFullAutoRunState(restoredRun as FullAutoRunState);
    }

    setSuggested(null);
    setPopoverOverride(followupQuestion);
  }, [
    automationMode,
    commitFullAutoRunState,
    deferredQuestionState,
    pendingWorkflowUploadKind,
    qState,
    runtime,
    setPopoverOverride,
    setSuggested,
  ]);

  const pushFullAutoUserMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const message: HomeAgentMessage = {
        id: globalThis.crypto?.randomUUID?.() ?? `full-auto-user-${Date.now()}`,
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
        automationOrigin: "full-auto",
      };
      setMessages((prev) => {
        const next = [...prev, message];
        messagesRef.current = next;
        return next;
      });
    },
    [messagesRef, setMessages],
  );

  const runFullAutoVideoBridgeResearchStep = useCallback(
    async (params: {
      runtime: StudioRuntimeState;
      signal: AbortSignal;
      projectId?: string | null;
      runAction: (
        action: string,
        input: Record<string, unknown>,
        runtime: StudioRuntimeState,
      ) => Promise<WorkflowActionResult>;
    }): Promise<{
      completion: WorkflowActionResult;
      assistantMessage: string;
      persistedInput: {
        targetPlatform: string;
        shotStyle: string;
        outputGoal: string;
        productionNotes: string;
      };
    }> => {
      const currentVideoProject = params.runtime.currentVideoProject;
      const persistedInput = {
        targetPlatform: currentVideoProject?.targetPlatform?.trim() ?? "",
        shotStyle: currentVideoProject?.shotStyle?.trim() ?? "",
        outputGoal: currentVideoProject?.outputGoal?.trim() ?? "",
        productionNotes: currentVideoProject?.productionNotes?.trim() ?? "",
      };

      if (!hasVideoBridgePrefs(currentVideoProject)) {
        const launched = await launchHomeAgentAutoResearchTasks({
          prompt: "",
          runtime: params.runtime,
          loadApiConfigModule,
          selectedTextModelKey,
          planOverride: buildVideoBridgeResearchPlan(
            params.runtime.currentProjectSnapshot ?? null,
            "all",
            currentVideoProject ?? undefined,
          ),
        });
        const taskIds = launched?.taskIds ?? [];
        if (!taskIds.length) {
          throw new Error("当前没能启动平台与镜头偏好补齐，请先检查文本模型配置后再试。");
        }

        try {
          const settledTasks = await waitForBackgroundTasks(taskIds, params.signal);
          taskIds.forEach((taskId) => surfacedTaskIdsRef.current.add(taskId));

          const completedTasks = settledTasks.filter((task) => task.status === "completed");
          if (!completedTasks.length) {
            throw new Error("平台与镜头偏好的自动补齐没有成功完成。");
          }

          const parsedInput = buildVideoBridgeResearchInput({
            tasks: completedTasks,
            parseTaskHeading,
          });
          persistedInput.targetPlatform ||= parsedInput.targetPlatform.trim();
          persistedInput.shotStyle ||= parsedInput.shotStyle.trim();
          persistedInput.outputGoal ||= parsedInput.outputGoal.trim();
          persistedInput.productionNotes = [persistedInput.productionNotes, parsedInput.productionNotes.trim()]
            .filter(Boolean)
            .join("\n\n");
        } catch (error) {
          if (params.signal.aborted) {
            taskIds.forEach((taskId) => stopTask(taskId));
          }
          throw error;
        }
      }

      const completion = await params.runAction(
        "create_video_bridge_artifact",
        {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...persistedInput,
        },
        params.runtime,
      );

      return {
        completion,
        assistantMessage: buildVideoBridgeResearchMessage(persistedInput),
        persistedInput,
      };
    },
    [loadApiConfigModule, selectedTextModelKey, surfacedTaskIdsRef],
  );

  const runFullAutoOriginalScriptPlan = useCallback(
    async (initialPlan: FullAutoRunPlan, options?: { startIndex?: number }) => {
      let runPlan = syncFullAutoPlanSteps(initialPlan);
      const runId = runPlan.id;
      const abortController = new AbortController();
      const executionEpoch = fullAutoExecutionEpochRef.current + 1;
      fullAutoExecutionEpochRef.current = executionEpoch;
      fullAutoUserStoppedRef.current = false;
      activeExecutionAbortRef.current?.abort();
      activeExecutionAbortRef.current = abortController;
      clearPendingWorkflowUploads();

      const getSteps = () => buildFullAutoExecutionSteps(runPlan);
      const initialSteps = getSteps();
      const startIndex = initialSteps.length
        ? Math.max(0, Math.min(options?.startIndex ?? runPlan.currentStepIndex ?? 0, initialSteps.length - 1))
        : 0;

      const makeRunState = (
        status: FullAutoRunState["status"],
        currentStepIndex: number,
        extra?: Partial<FullAutoRunState>,
      ): FullAutoRunState => ({
        status,
        plan: markFullAutoSteps(
          runPlan,
          currentStepIndex,
          status === "completed"
            ? "completed"
            : status === "retrying"
              ? "retrying"
              : status === "stopped"
                ? "stopped"
                : status === "failed"
                ? "failed"
                : "running",
        ),
        currentStepIndex,
        currentStepLabel: getSteps()[currentStepIndex]?.label,
        ...extra,
      });

      const commitFullAutoState = (state: FullAutoRunState) => {
        if (state.plan) runPlan = state.plan;
        commitFullAutoRunState(state);
      };

      const setStep = (index: number, status: FullAutoRunState["status"] = "running") => {
        const next = makeRunState(status, index);
        commitFullAutoState(next);
        const currentStep = getSteps()[index];
        setActiveWorkflowAction(currentStep?.workflowAction ?? "full-auto");
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:workflow-progress", {
              detail: {
                id: `full-auto-${runId}`,
                status: status === "completed" ? "complete" : status === "retrying" ? "progress" : "start",
                content: currentStep?.label ?? "全自动执行",
              },
            }),
          );
        }
      };

      const inputForStep = (
        step: FullAutoRunStep,
        runtime: StudioRuntimeState,
      ): Record<string, unknown> => {
        const action = step.workflowAction;
        const setupInput = runPlan.setupInput ?? {};
        const configuredSourceProjectId =
          typeof setupInput.sourceProjectId === "string" && setupInput.sourceProjectId.trim()
            ? setupInput.sourceProjectId.trim()
            : undefined;
        const projectId = resolveFullAutoRuntimeProjectId({ runtime, setupInput });
        const videoProject = runtime.currentVideoProject;
        const fullAutoVideoPrefs = {
          mode: getFullAutoVideoMode(runPlan),
          resolution: getFullAutoVideoResolution(runPlan),
        };
        if (action === "save_setup") {
          return {
            ...setupInput,
            ...(projectId ? { projectId } : {}),
            automationMode: "full-auto",
          };
        }
        if (action === "analyze_reference_script") {
          return {
            ...setupInput,
            ...(projectId ? { projectId } : {}),
            automationMode: "full-auto",
          };
        }
        if (action === "confirm_adaptation_episode_count") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "adaptationEpisodeCount");
          const match = value?.match(/^script:adaptation-total-episodes:(?:custom:)?(\d+)$/);
          return {
            ...(projectId ? { projectId } : {}),
            ...(match ? { totalEpisodes: Number(match[1]) } : {}),
          };
        }
        if (action === "confirm_adaptation_target_market") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "adaptationTargetMarket");
          const match = value?.match(/^script:adaptation-target-market:([^:]+)$/);
          return {
            ...(projectId ? { projectId } : {}),
            ...(match ? { targetMarket: match[1] } : {}),
          };
        }
        if (action === "confirm_adaptation_genres") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "adaptationGenres");
          const match = value?.match(/^script:adaptation-genres:([\s\S]+)$/);
          return {
            ...(projectId ? { projectId } : {}),
            ...(match ? { genres: [decodeURIComponent(match[1])] } : {}),
          };
        }
        if (action === "generate_structure_transform" || action === "generate_character_transform") {
          return {
            ...setupInput,
            ...(projectId ? { projectId } : {}),
          };
        }
        if (!projectId) return { ...setupInput, automationMode: "full-auto" };
        if (action === "generate_creative_plan") {
          return { projectId, automationMode: "full-auto" };
        }
        if (action === "generate_outlines") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "outlineGeneration");
          const batch = value?.match(/^script:outline-generate-batch:(\d+):(\d+)$/);
          const range = value?.match(/^script:outline-generate-range:([\d,+，-]+)$/);
          const single = value?.match(/^script:outline-generate-single:(\d+)$/);
          const regenerate = value?.match(/^script:outline-regenerate:(\d+)(?::([\s\S]+))?$/);
          return {
            projectId,
            keepCurrentStep: true,
            ...(value === "script:outline-fill-missing" ? { fillMissingOutlines: true } : {}),
            ...(value === "script:outline-regenerate-all" ? { regenerateAll: true } : {}),
            ...(batch ? { rangeStart: Number(batch[1]), rangeEnd: Number(batch[2]) } : {}),
            ...(range ? { episodeNumbers: parseFullAutoEpisodeNumberSelection(range[1]) } : {}),
            ...(single ? { episodeNumbers: [Number(single[1])] } : {}),
            ...(regenerate ? { episodeNumbers: [Number(regenerate[1])] } : {}),
            ...(regenerate?.[2] ? { customInstruction: decodeURIComponent(regenerate[2]).trim() } : {}),
          };
        }
        if (action === "generate_episode_batch") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "episodeWriting");
          const range = value?.match(/^script:episode-generate-range:([\d,+，-]+)$/);
          return {
            projectId,
            durationSeconds: getFullAutoEpisodeDurationSeconds(runPlan),
            ...(value === "script:episode-fill-missing" ? { fillMissingEpisodes: true } : {}),
            ...(range ? { episodeNumbers: parseFullAutoEpisodeNumberSelection(range[1]) } : {}),
          };
        }
        if (action === "generate_episode") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "episodeWriting");
          const match = value?.match(/^script:episode-generate:(\d+)$/);
          return {
            projectId,
            durationSeconds: getFullAutoEpisodeDurationSeconds(runPlan),
            ...(match ? { episodeNumber: Number(match[1]) } : {}),
          };
        }
        if (action === "review_episode_quality") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "episodeReview");
          const single = value?.match(/^script:episode-review:single:(\d+)$/);
          const count = value?.match(/^script:episode-review:count:(?:custom:)?(\d+)$/);
          const selectedEpisodes = value?.match(/^script:episode-review:episodes:([\d,+，-]+)$/);
          return {
            projectId,
            defaultReviewCount: 10,
            ...(value === "script:episode-review:remaining" ? { reviewRemaining: true } : {}),
            ...(single ? { episodeNumbers: [Number(single[1])] } : {}),
            ...(count ? { reviewCount: Number(count[1]) } : {}),
            ...(selectedEpisodes ? { episodeNumbers: parseFullAutoEpisodeNumberSelection(selectedEpisodes[1]) } : {}),
          };
        }
        if (action === "rewrite_episode_from_review") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "episodeReview");
          const repairSingle = value?.match(/^script:episode-review:repair:(\d+)$/);
          return {
            projectId,
            ...(value === "script:episode-review:repair-all" ? { repairAll: true, repairLimit: 10 } : {}),
            ...(repairSingle ? { episodeNumber: Number(repairSingle[1]) } : {}),
          };
        }
        if (action === "run_compliance_review") {
          const value = getFullAutoStrategyValue(runPlan, "complianceReview");
          const strictnessValue = getFullAutoStrategyValue(runPlan, "complianceReviewStrictness");
          const dialogueValue = getFullAutoStrategyValue(runPlan, "complianceReviewDialogue");
          return {
            projectId,
            reviewMode: value?.endsWith(":script") ? "script" : "text",
            ...(strictnessValue?.startsWith("script:compliance-set-strictness:")
              ? {
                  strictness: strictnessValue.replace("script:compliance-set-strictness:", ""),
                }
              : {}),
            ...(dialogueValue === "script:compliance-toggle-dialogue:on"
              ? { dialogueReviewEnabled: true }
              : dialogueValue === "script:compliance-toggle-dialogue:off"
                ? { dialogueReviewEnabled: false }
                : {}),
          };
        }
        if (action === "skip_compliance_review") {
          return { projectId };
        }
        if (action === "prepare_video_generation") {
          const fullAutoImagePrefs = getFullAutoVideoImagePrefs(runPlan);
          return {
            ...setupInput,
            ...(projectId ? { projectId } : {}),
            automationMode: "full-auto",
            ...(configuredSourceProjectId ? { sourceProjectId: configuredSourceProjectId } : {}),
            videoGenerationPrefs: fullAutoVideoPrefs,
            ...(fullAutoImagePrefs ? { imageGenerationPrefs: fullAutoImagePrefs } : {}),
          };
        }
        if (action === "analyze_script_for_video") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "videoAnalyze");
          const match = value?.match(
            /^video:bridge:analyze:(?:pace|execute|resume):(slow|medium|fast):(\d+)(?::retry-missing)?$/,
          );
          return {
            ...setupInput,
            ...(projectId ? { projectId } : {}),
            ...(match
              ? {
                  videoPace: match[1],
                  episodeDuration: Number(match[2]),
                  ...(value?.endsWith(":retry-missing") ? { retryMissingEpisodes: true } : {}),
                }
              : getFullAutoVideoAnalyzePrefs(runPlan)),
          };
        }
        if (action === "extract_video_entities") {
          return {
            projectId,
            ...(selectedTextModelKey ? { model: selectedTextModelKey } : {}),
          };
        }
        if (action === "generate_video_reference_assets") {
          const value = getFullAutoStrategyValue(runPlan, "referenceAssets");
          const allTargets = (includeReady = false) =>
            listVideoReferenceAssetTargetIds(videoProject, { includeReady });
          const characterTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-character:") || targetId.startsWith("reference-character-variant:"));
          const characterMainTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-character:"));
          const characterVariantTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-character-variant:"));
          const sceneTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-scene:") || targetId.startsWith("reference-scene-variant:"));
          const sceneMainTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-scene:"));
          const sceneVariantTargets = (includeReady = false) =>
            allTargets(includeReady).filter((targetId) => targetId.startsWith("reference-scene-variant:"));
          const directCharacter = value?.match(/^video:bridge:reference-assets:character(?:-main)?:([^:]+)$/);
          const directCharacterVariants = value?.match(/^video:bridge:reference-assets:character-variants:([^:]+)$/);
          const directCharacterVariant = value?.match(/^video:bridge:reference-assets:character-variant:([^:]+):([^:]+)$/);
          const directScene = value?.match(/^video:bridge:reference-assets:scene(?:-main)?:([^:]+)$/);
          const directSceneVariants = value?.match(/^video:bridge:reference-assets:scene-variants:([^:]+)$/);
          const directSceneVariant = value?.match(/^video:bridge:reference-assets:scene-variant:([^:]+):([^:]+)$/);
          if (value === "video:bridge:reference-assets:full") {
            return {
              projectId,
              smartBatch: true,
            };
          }
          if (value === "video:bridge:reference-assets:characters") {
            const targetIds = characterTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : characterTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (value === "video:bridge:reference-assets:characters-main") {
            const targetIds = characterMainTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : characterMainTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (value === "video:bridge:reference-assets:characters-variants") {
            const targetIds = characterVariantTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : characterVariantTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (value === "video:bridge:reference-assets:scenes") {
            const targetIds = sceneTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : sceneTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (value === "video:bridge:reference-assets:scenes-main") {
            const targetIds = sceneMainTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : sceneMainTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (value === "video:bridge:reference-assets:scenes-variants") {
            const targetIds = sceneVariantTargets();
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : sceneVariantTargets(true),
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (directCharacter) {
            const characterId = directCharacter[1];
            const shouldRefresh = Boolean(videoProject?.characters.find((item) => item.id === characterId)?.imageUrl?.trim());
            return {
              projectId,
              targetIds: [`reference-character:${characterId}`],
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          if (directCharacterVariants) {
            const characterId = directCharacterVariants[1];
            const targetIds = (videoProject?.characters.find((item) => item.id === characterId)?.costumes ?? [])
              .filter((item) => !item.imageUrl?.trim())
              .map((item) => `reference-character-variant:${characterId}:${item.id}`);
            const fallbackTargetIds = (videoProject?.characters.find((item) => item.id === characterId)?.costumes ?? [])
              .map((item) => `reference-character-variant:${characterId}:${item.id}`);
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : fallbackTargetIds,
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (directCharacterVariant) {
            const [, characterId, variantId] = directCharacterVariant;
            const shouldRefresh = Boolean(
              videoProject?.characters
                .find((item) => item.id === characterId)
                ?.costumes?.find((item) => item.id === variantId)
                ?.imageUrl?.trim(),
            );
            return {
              projectId,
              targetIds: [`reference-character-variant:${characterId}:${variantId}`],
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          if (directScene) {
            const sceneSettingId = directScene[1];
            const shouldRefresh = Boolean(videoProject?.sceneSettings.find((item) => item.id === sceneSettingId)?.imageUrl?.trim());
            return {
              projectId,
              targetIds: [`reference-scene:${sceneSettingId}`],
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          if (directSceneVariants) {
            const sceneSettingId = directSceneVariants[1];
            const targetIds = (videoProject?.sceneSettings.find((item) => item.id === sceneSettingId)?.timeVariants ?? [])
              .filter((item) => !item.imageUrl?.trim())
              .map((item) => `reference-scene-variant:${sceneSettingId}:${item.id}`);
            const fallbackTargetIds = (videoProject?.sceneSettings.find((item) => item.id === sceneSettingId)?.timeVariants ?? [])
              .map((item) => `reference-scene-variant:${sceneSettingId}:${item.id}`);
            return {
              projectId,
              targetIds: targetIds.length ? targetIds : fallbackTargetIds,
              ...(targetIds.length ? {} : { forceRegenerate: true }),
            };
          }
          if (directSceneVariant) {
            const [, sceneSettingId, variantId] = directSceneVariant;
            const shouldRefresh = Boolean(
              videoProject?.sceneSettings
                .find((item) => item.id === sceneSettingId)
                ?.timeVariants?.find((item) => item.id === variantId)
                ?.imageUrl?.trim(),
            );
            return {
              projectId,
              targetIds: [`reference-scene-variant:${sceneSettingId}:${variantId}`],
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          return {
            projectId,
            smartBatch: true,
          };
        }
        if (action === "prepare_storyboard_batch") {
          return { projectId };
        }
        if (action === "generate_storyboard_frames") {
          const value = getFullAutoStrategyValue(runPlan, "storyboardPrep");
          if (value === "video:bridge:storyboard-frames") {
            return {
              projectId,
              smartBatch: true,
              targetIds: listSmartStoryboardFrameTargetIds(videoProject),
            };
          }
          if (value?.startsWith("video:bridge:storyboard-frames:episode:")) {
            const episodeKey = decodeURIComponent(value.replace("video:bridge:storyboard-frames:episode:", ""));
            const targetIds = listGeneratableStoryboardSceneIdsForEpisode(videoProject, episodeKey);
            const shouldRefresh = (videoProject?.scenes ?? []).some(
              (scene) => targetIds.includes(scene.id) && Boolean(scene.storyboardUrl?.trim()),
            );
            return {
              projectId,
              targetIds,
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          if (value?.startsWith("video:bridge:storyboard-frames:segment:")) {
            const segmentKey = decodeURIComponent(value.replace("video:bridge:storyboard-frames:segment:", ""));
            const targetIds = listGeneratableStoryboardSceneIdsForSegment(videoProject, segmentKey);
            const shouldRefresh = (videoProject?.scenes ?? []).some(
              (scene) => targetIds.includes(scene.id) && Boolean(scene.storyboardUrl?.trim()),
            );
            return {
              projectId,
              targetIds,
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          if (value?.startsWith("video:bridge:storyboard-frame:scene:")) {
            const sceneId = value.replace("video:bridge:storyboard-frame:scene:", "");
            const shouldRefresh = Boolean(videoProject?.scenes.find((scene) => scene.id === sceneId)?.storyboardUrl?.trim());
            return {
              projectId,
              targetIds: [sceneId],
              ...(shouldRefresh ? { forceRegenerate: true } : {}),
            };
          }
          return { projectId };
        }
        if (action === "prepare_segment_video_prompt") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "videoPrompts");
          if (value?.startsWith("video:bridge:prompts:segment:episode:")) {
            return {
              projectId,
              batchMode: "episode",
              targetEpisode: decodeURIComponent(value.replace("video:bridge:prompts:segment:episode:", "")),
            };
          }
          if (value?.startsWith("video:bridge:prompts:segment:label:")) {
            return {
              projectId,
              batchMode: "single",
              targetSegmentLabel: decodeURIComponent(value.replace("video:bridge:prompts:segment:label:", "")),
            };
          }
          return { projectId, batchMode: getFullAutoPromptBatchMode(runPlan) };
        }
        if (action === "prepare_video_prompt_batch") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "videoPrompts");
          return {
            projectId,
            batchMode: value?.endsWith(":all") ? "all" : "batch",
          };
        }
        if (action === "generate_segment_video" || action === "generate_video_assets") {
          const value = getFullAutoStrategyValue(runPlan, "videoGeneration");
          return {
            projectId,
            videoGenerationPrefs: fullAutoVideoPrefs,
            ...(value === "video:generate:segments:failed" ? { retryFailed: true } : {}),
            ...(value === "video:generate:segments:refresh" ? { refreshRunning: true } : {}),
            ...(value === "video:generate:segments:first" ? { batchMode: "first" } : {}),
          };
        }
        if (action === "compile_segment_videos") {
          const value = getResolvedFullAutoStrategyValue(runPlan, "videoExport");
          return {
            projectId,
            addSubtitles: value === "video:export:ai-auto:subtitle:yes",
            directoryPath: getFullAutoExportDirectoryPath(runPlan),
          };
        }
        if (action === "export_video_asset_bundle") {
          return {
            projectId,
            directoryPath: getFullAutoExportDirectoryPath(runPlan),
          };
        }
        return {
          projectId,
          ...(action === "compile_video_shot_packets" ? { videoMode: getFullAutoVideoMode(runPlan) } : {}),
        };
      };

      const workflow = await loadWorkflowActionsModule();
      setMode("active");
      setPopoverOverride(null);
      setSuggested(null);
      setSelectedValues([]);
      resetComposerDraft("");
      setStreaming(true);
      push(
        "assistant",
        startIndex > 0
          ? `继续全自动链路，将从“${getSteps()[startIndex]?.label ?? "当前步骤"}”接上执行。`
          : runPlan.mode === "adaptation-v1"
            ? "策略已收集完毕。接下来我会以 AI 代理身份按顺序执行参考改编到视频导出链路；你可以随时点击停止。"
            : runPlan.mode === "video-workflow-v1"
              ? "策略已收集完毕。接下来我会以 AI 代理身份按顺序执行视频拆解到出片导出链路；你可以随时点击停止。"
              : "策略已收集完毕。接下来我会以 AI 代理身份按顺序执行原创剧本到视频导出链路；你可以随时点击停止。",
      );
      commitFullAutoState(makeRunState("running", startIndex));

      let nextRuntime = {
        ...runtimeRef.current,
        fullAutoRun: makeRunState("running", startIndex),
      };
      const shouldIgnoreExecutionUpdate = () =>
        shouldIgnoreFullAutoExecutionUpdate({
          executionEpoch,
          currentExecutionEpoch: fullAutoExecutionEpochRef.current,
          signal: abortController.signal,
          userStopped: fullAutoUserStoppedRef.current,
        });

      try {
        for (let index = startIndex; ; index += 1) {
          if (shouldIgnoreExecutionUpdate()) {
            return;
          }
          const steps = getSteps();
          if (index >= steps.length) break;
          const step = steps[index];
          if (abortController.signal.aborted) {
            if (!fullAutoUserStoppedRef.current) {
              commitFullAutoState(makeRunState("stopped", index, {
                stoppedByUser: true,
                plan: {
                  ...markFullAutoSteps(runPlan, index, "stopped"),
                  stoppedStepId: step.id,
                  resumeFromStepId: step.id,
                },
              }));
              push("assistant", "全自动执行已停止。点击“继续当前任务”后，AI 会从当前未完成步骤继续自动补齐。");
              applyFullAutoWorkflowFollowupQuestion({
                run: {
                  status: "stopped",
                  plan: {
                    ...markFullAutoSteps(runPlan, index, "stopped"),
                    stoppedStepId: step.id,
                    resumeFromStepId: step.id,
                  },
                  currentStepIndex: index,
                },
                runtime: nextRuntime,
                setSuggested,
                setPopoverOverride,
                forcePopover: true,
              });
            }
            return;
          }

          setStep(index);
          const stepAction = step.workflowAction ?? "";
          const baseUserMessage = buildFullAutoExecutionUserMessage(runPlan, step);
          let batchIndex = 0;
          let stalledReferenceAssetBatchCount = 0;
          let stalledVideoGenerationBatchCount = 0;
          let pendingBatchTargetIdsOverride: string[] | null = null;

          for (;;) {
            batchIndex += 1;
            let attempt = 0;
            let result: Awaited<ReturnType<typeof workflow.runWorkflowAction>> | null = null;
            let lastAttemptError: unknown = null;
            const batchMediaEventId =
              stepAction && isWorkflowMediaAction(stepAction)
                ? `media:${runId}:${step.id}:${batchIndex}:${Date.now()}`
                : undefined;
            const applyBatchActionInput = (baseInput: Record<string, unknown>) => {
              let nextInput = baseInput;
              if (
                (stepAction === "generate_video_reference_assets" || stepAction === "generate_video_assets") &&
                pendingBatchTargetIdsOverride?.length
              ) {
                nextInput = { ...nextInput, targetIds: pendingBatchTargetIdsOverride };
              } else if (stepAction === "generate_segment_video" && pendingBatchTargetIdsOverride?.length) {
                nextInput = { ...nextInput, targetSegmentLabels: pendingBatchTargetIdsOverride };
              }
              if (batchMediaEventId) {
                nextInput = { ...nextInput, mediaEventId: batchMediaEventId };
              }
              return nextInput;
            };
            let actionInput = applyBatchActionInput(inputForStep(step, nextRuntime));
            let preparedActionInput = decorateFullAutoWorkflowInput(actionInput, abortController.signal);
            let customAssistantMessage: string | null = null;
            let batchState = stepAction
              ? resolveFullAutoBatchExecutionState({
                  action: stepAction,
                  input: actionInput,
                  runtime: nextRuntime,
                })
              : {
                  batchable: false,
                  selectedCount: 0,
                  remainingCount: 0,
                  signature: null,
                };
            const currentUserMessage = buildFullAutoBatchExecutionUserMessage({
              baseMessage: baseUserMessage,
              action: stepAction,
              batchIndex,
              selectedCount: batchState.selectedCount,
              remainingCount: batchState.remainingCount,
            });
            pushFullAutoUserMessage(currentUserMessage);

            if (isWorkflowMediaAction(stepAction)) {
              dispatchWorkflowMediaStartEvent({
                action: stepAction,
                input: preparedActionInput,
                runtime: nextRuntime,
              });
            }

            while (!result && attempt < FULL_AUTO_STEP_ATTEMPT_LIMIT) {
              attempt += 1;
              try {
                if (attempt > 1) {
                  commitFullAutoState(makeRunState("retrying", index, {
                    currentStepLabel: `${step.label}（第 ${attempt} 次尝试）`,
                  }));
                  pushFullAutoUserMessage(
                    buildFullAutoRetryUserMessage({
                      baseMessage: currentUserMessage,
                      attempt,
                    }),
                  );
                }
                actionInput = applyBatchActionInput(inputForStep(step, nextRuntime));
                if (stepAction === "analyze_script_for_video" && lastAttemptError) {
                  actionInput = {
                    ...actionInput,
                    systemPrompt: mergeFullAutoVideoAnalyzeRetrySystemPrompt(
                      actionInput.systemPrompt,
                      lastAttemptError,
                      `第 ${attempt} 次尝试`,
                    ),
                  };
                }
                preparedActionInput = decorateFullAutoWorkflowInput(actionInput, abortController.signal);
                batchState = stepAction
                  ? resolveFullAutoBatchExecutionState({
                      action: stepAction,
                      input: actionInput,
                      runtime: nextRuntime,
                    })
                  : batchState;
                if (step.workflowAction === "auto_fill_video_bridge_prefs") {
                  const bridgeResult = await runFullAutoVideoBridgeResearchStep({
                    runtime: nextRuntime,
                    signal: abortController.signal,
                    projectId:
                      typeof actionInput.projectId === "string" && actionInput.projectId.trim()
                        ? actionInput.projectId.trim()
                        : undefined,
                    runAction: (nextAction, nextInput, nextStepRuntime) =>
                      workflow.runWorkflowAction(nextAction, nextInput, nextStepRuntime),
                  });
                  result = bridgeResult.completion;
                  customAssistantMessage = bridgeResult.assistantMessage;
                  actionInput = {
                    ...actionInput,
                    ...bridgeResult.persistedInput,
                  };
                  preparedActionInput = decorateFullAutoWorkflowInput(actionInput, abortController.signal);
                } else {
                  result = await workflow.runWorkflowAction(
                    stepAction,
                    preparedActionInput,
                    nextRuntime,
                    (partial) => {
                      if (shouldIgnoreExecutionUpdate()) return;
                      if (partial.summary?.trim() && typeof window !== "undefined") {
                        window.dispatchEvent(
                          new CustomEvent("agent:workflow-progress", {
                            detail: {
                              id: `full-auto-${runId}`,
                              status: "progress",
                              content: partial.summary.trim(),
                            },
                          }),
                        );
                      }
                      if (partial.data) {
                        const previousSnapshot = nextRuntime.currentProjectSnapshot;
                        const normalizedPartialSnapshot = partial.data.projectSnapshot
                          ? {
                              ...partial.data.projectSnapshot,
                              automationMode: "full-auto" as const,
                            }
                          : null;
                        const partialRuntime = mergeRuntimeWithWorkflowDelta(nextRuntime, {
                          ...partial.data,
                          ...(normalizedPartialSnapshot
                            ? { projectSnapshot: normalizedPartialSnapshot }
                            : {}),
                        });
                        nextRuntime = {
                          ...partialRuntime,
                          recentProjects: replacePlaceholderRecentProject({
                            recentProjects: partialRuntime.recentProjects,
                            previousSnapshot,
                            nextSnapshot:
                              normalizedPartialSnapshot ?? partialRuntime.currentProjectSnapshot,
                          }),
                          fullAutoRun: makeRunState("running", index),
                        };
                        runtimeRef.current = nextRuntime;
                        setRuntime(nextRuntime);
                        if (normalizedPartialSnapshot?.projectId) {
                          syncActiveProjectIdWithSnapshot(
                            normalizedPartialSnapshot,
                            normalizedPartialSnapshot.projectId,
                          );
                        }
                      }
                    },
                  );
                }
              } catch (error) {
                if (abortController.signal.aborted) throw error;
                lastAttemptError = error;
                if (attempt >= FULL_AUTO_STEP_ATTEMPT_LIMIT) throw error;
                push(
                  "assistant",
                  buildFullAutoRetryAssistantMessage({
                    stepLabel: step.label,
                    error,
                    nextAttempt: attempt + 1,
                    stage: "attempt",
                  }),
                );
              }
            }

            if (!result) break;
            if (shouldIgnoreExecutionUpdate()) {
              applyFullAutoWorkflowFollowupQuestion({
                run: nextRuntime.fullAutoRun,
                runtime: nextRuntime,
                setSuggested,
                setPopoverOverride,
                forcePopover: true,
              });
              return;
            }
            const nextSnapshot = result.projectSnapshot ?? result.data?.projectSnapshot ?? null;
            const previousSnapshot = nextRuntime.currentProjectSnapshot;
            nextRuntime = result.data ? mergeRuntimeWithWorkflowDelta(nextRuntime, result.data) : nextRuntime;
            if (nextSnapshot) {
              nextRuntime = {
                ...nextRuntime,
                currentProjectSnapshot: {
                  ...nextSnapshot,
                  automationMode: "full-auto",
                },
                recentProjects: replacePlaceholderRecentProject({
                  recentProjects: nextRuntime.recentProjects,
                  previousSnapshot,
                  nextSnapshot: {
                    ...nextSnapshot,
                    automationMode: "full-auto",
                  },
                }),
              };
            }
            nextRuntime = {
              ...nextRuntime,
              fullAutoRun: makeRunState("running", index),
            };
            runtimeRef.current = nextRuntime;
            setRuntime(nextRuntime);
            const nextProjectId = resolveFullAutoRuntimeProjectId({
              runtime: nextRuntime,
              setupInput: runPlan.setupInput ?? {},
            });
            if (nextProjectId) {
              syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, nextProjectId);
              void loadProjectStore()
                .then((store) => store.setConversationProjectAutomationMode?.(nextProjectId, "full-auto"))
                .catch(() => undefined);
            }
            if (abortController.signal.aborted && fullAutoUserStoppedRef.current) {
              applyFullAutoWorkflowFollowupQuestion({
                run: nextRuntime.fullAutoRun,
                runtime: nextRuntime,
                setSuggested,
                setPopoverOverride,
                forcePopover: true,
              });
              return;
            }

            if (isWorkflowMediaAction(stepAction)) {
              dispatchWorkflowMediaEvents({
                imageUrls: result.imageUrls,
                videoUrls: result.videoUrls,
                mediaEventId: batchMediaEventId,
                actionLabel: currentUserMessage,
                imageDetail: {
                  action: stepAction,
                  count: batchState.selectedCount || result.imageUrls?.length || 0,
                  modelFamily: String(
                    preparedActionInput.selectedImageModelFamily || preparedActionInput.modelFamily || "",
                  ),
                  resolution:
                    typeof preparedActionInput.imageGenerationPrefs === "object" &&
                    preparedActionInput.imageGenerationPrefs &&
                    "resolution" in preparedActionInput.imageGenerationPrefs
                      ? String(preparedActionInput.imageGenerationPrefs.resolution || "")
                      : "",
                  aspectRatio:
                    typeof preparedActionInput.imageGenerationPrefs === "object" &&
                    preparedActionInput.imageGenerationPrefs &&
                    "aspectRatio" in preparedActionInput.imageGenerationPrefs
                      ? String(preparedActionInput.imageGenerationPrefs.aspectRatio || "")
                      : "",
                  contentSummary: batchState.contentSummary,
                  imageLabels: result.imageLabels?.length ? result.imageLabels : batchState.targetLabels,
                },
                videoDetail: {
                  action: stepAction,
                  count: batchState.selectedCount || result.videoUrls?.length || 0,
                  model: String(
                    preparedActionInput.selectedVideoModelKey || preparedActionInput.videoModelKey || "",
                  ),
                  resolution:
                    typeof preparedActionInput.videoGenerationPrefs === "object" &&
                    preparedActionInput.videoGenerationPrefs &&
                    "resolution" in preparedActionInput.videoGenerationPrefs
                      ? String(preparedActionInput.videoGenerationPrefs.resolution || "")
                      : "",
                  provider:
                    typeof preparedActionInput.videoGenerationPrefs === "object" &&
                    preparedActionInput.videoGenerationPrefs &&
                    "provider" in preparedActionInput.videoGenerationPrefs
                      ? String((preparedActionInput.videoGenerationPrefs as { provider?: string }).provider || "")
                      : resolveVideoGenerationProvider(
                          typeof preparedActionInput.videoGenerationPrefs === "object"
                            ? preparedActionInput.videoGenerationPrefs
                            : null,
                        ),
                  mode:
                    typeof preparedActionInput.videoGenerationPrefs === "object" &&
                    preparedActionInput.videoGenerationPrefs &&
                    "mode" in preparedActionInput.videoGenerationPrefs
                      ? String(preparedActionInput.videoGenerationPrefs.mode || "")
                      : "",
                  aspectRatio:
                    typeof preparedActionInput.aspectRatio === "string"
                      ? preparedActionInput.aspectRatio
                      : typeof preparedActionInput.videoGenerationPrefs === "object" &&
                          preparedActionInput.videoGenerationPrefs &&
                          "aspectRatio" in preparedActionInput.videoGenerationPrefs
                        ? String((preparedActionInput.videoGenerationPrefs as { aspectRatio?: string }).aspectRatio || "")
                        : "",
                  contentSummary: batchState.contentSummary,
                },
              });
            }

            if (
              stepAction === "generate_video_reference_assets" ||
              stepAction === "generate_video_assets" ||
              stepAction === "generate_segment_video"
            ) {
              const nextPendingTargetIds = normalizeWorkflowTargetIds(result.remainingTargetIds);
              pendingBatchTargetIdsOverride = nextPendingTargetIds.length ? nextPendingTargetIds : null;
            }

            if (customAssistantMessage?.trim()) {
              push("assistant", customAssistantMessage.trim());
            } else if (result.summary?.trim()) {
              const assistantPayload = buildWorkflowAssistantMessagePayload({
                action: stepAction,
                input: actionInput,
                previousSnapshot,
                nextSnapshot,
                summary: result.summary.trim(),
              });
              if (assistantPayload) {
                push(
                  "assistant",
                  assistantPayload.content,
                  assistantPayload.artifactIds,
                  undefined,
                  assistantPayload.artifactSnapshots,
                );
              }
            }
            const localExportMessages = await runFullAutoPostStepLocalExports({
              step,
              plan: runPlan,
              runtime: nextRuntime,
            });
            for (const message of localExportMessages) {
              push("assistant", message);
            }

            const nextBatchState = stepAction
              ? resolveFullAutoBatchExecutionState({
                  action: stepAction,
                  input:
                    (stepAction === "generate_video_reference_assets" || stepAction === "generate_video_assets") &&
                      pendingBatchTargetIdsOverride?.length
                      ? {
                          ...inputForStep(step, nextRuntime),
                          targetIds: pendingBatchTargetIdsOverride,
                        }
                      : stepAction === "generate_segment_video" && pendingBatchTargetIdsOverride?.length
                        ? {
                            ...inputForStep(step, nextRuntime),
                            targetSegmentLabels: pendingBatchTargetIdsOverride,
                          }
                        : inputForStep(step, nextRuntime),
                  runtime: nextRuntime,
                })
              : null;
            if (
              isStalledFullAutoReferenceAssetBatch({
                action: stepAction,
                currentBatchState: batchState,
                nextBatchState,
              })
            ) {
              stalledReferenceAssetBatchCount += 1;
              const pendingCount =
                (nextBatchState?.selectedCount ?? 0) + (nextBatchState?.remainingCount ?? 0);
              if (stalledReferenceAssetBatchCount <= FULL_AUTO_REFERENCE_ASSET_STALL_BATCH_RETRY_LIMIT) {
                push(
                  "assistant",
                  `参考资产补齐这一批还没有完成，当前还有 ${pendingCount} 个待补齐目标，AI 代理会继续自动补齐。`,
                );
                continue;
              }
              throw new Error(
                `${FULL_AUTO_REFERENCE_ASSET_STALL_ERROR_PREFIX}，当前还有 ${pendingCount} 个待补齐目标。`,
              );
            }
            stalledReferenceAssetBatchCount = 0;
            if (
              isStalledFullAutoVideoGenerationBatch({
                action: stepAction,
                currentBatchState: batchState,
                nextBatchState,
              })
            ) {
              stalledVideoGenerationBatchCount += 1;
              const pendingCount =
                (nextBatchState?.selectedCount ?? 0) + (nextBatchState?.remainingCount ?? 0);
              if (stalledVideoGenerationBatchCount <= FULL_AUTO_VIDEO_BATCH_STALL_BATCH_RETRY_LIMIT) {
                push(
                  "assistant",
                  `视频生成这一批还没有完成，当前还有 ${pendingCount} 个待处理目标，AI 代理会继续自动补发。`,
                );
                continue;
              }
              throw new Error(
                `${FULL_AUTO_VIDEO_BATCH_STALL_ERROR_PREFIX}，当前还有 ${pendingCount} 个待处理目标。`,
              );
            }
            stalledVideoGenerationBatchCount = 0;
            const shouldContinueBatch = shouldContinueFullAutoBatchExecution({
              currentBatchState: batchState,
              nextBatchState,
            });
            if (!shouldContinueBatch) {
              break;
            }
          }
        }

        const finalSteps = getSteps();
        if (shouldIgnoreExecutionUpdate()) {
          return;
        }
        const completedState = makeRunState("completed", Math.max(0, finalSteps.length - 1));
        const followupQuestion = buildFullAutoWorkflowFollowupQuestion({
          run: completedState,
          runtime: nextRuntime,
        });
        if (followupQuestion?.answerKey === "full-auto-resume") {
          const resumeQuestion = followupQuestion;
          const resumeStepId = resolveFullAutoResumeStepIdFromRuntime({
            plan: completedState.plan ?? runPlan,
            runtime: nextRuntime,
            fallbackIndex: completedState.currentStepIndex,
          });
          const resumeIndex = findFullAutoStepIndexById(completedState.plan ?? runPlan, resumeStepId);
          const effectiveResumeIndex = Math.max(
            0,
            resumeIndex >= 0 ? resumeIndex : completedState.currentStepIndex,
          );
          const resumePlan = {
            ...(completedState.plan ?? runPlan),
            resumeFromStepId:
              buildFullAutoExecutionSteps(completedState.plan ?? runPlan)[effectiveResumeIndex]?.id ??
              resumeStepId ??
              undefined,
          };
          commitFullAutoState({
            status: "stopped",
            plan: {
              ...markFullAutoSteps(resumePlan, effectiveResumeIndex, "stopped"),
              stoppedStepId:
                buildFullAutoExecutionSteps(resumePlan)[effectiveResumeIndex]?.id ?? resumePlan.stoppedStepId,
              resumeFromStepId:
                buildFullAutoExecutionSteps(resumePlan)[effectiveResumeIndex]?.id ?? resumePlan.resumeFromStepId,
            },
            currentStepIndex: effectiveResumeIndex,
            currentStepLabel:
              buildFullAutoExecutionSteps(resumePlan)[effectiveResumeIndex]?.label ?? completedState.currentStepLabel,
          });
          setSuggested(null);
          setPopoverOverride(resumeQuestion);
          push("assistant", "检测到当前项目还有未完成内容。点击“继续当前任务”后，AI 会自动从缺口步骤继续补齐。");
          return;
        }

        commitFullAutoState(completedState);
        setSuggested(null);
        setPopoverOverride(followupQuestion);
        push("assistant", "全自动链路已完成。历史记录已标记为全自动模式。");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "全自动执行失败，请稍后重试。";
        const stoppedByUser = abortController.signal.aborted;
        if (stoppedByUser && fullAutoUserStoppedRef.current) {
          return;
        }
        if (
          shouldIgnoreFullAutoExecutionUpdate({
            executionEpoch,
            currentExecutionEpoch: fullAutoExecutionEpochRef.current,
            signal: abortController.signal,
          })
        ) {
          return;
        }
        const failedSteps = getSteps();
        const failedIndex = failedSteps.length
          ? Math.max(0, Math.min(runPlan.currentStepIndex ?? startIndex, failedSteps.length - 1))
          : 0;
        const failedStep = failedSteps[failedIndex];
        const failedMediaKind = failedStep?.workflowAction
          ? resolveWorkflowMediaKind(failedStep.workflowAction)
          : null;
        if (failedMediaKind) {
          dispatchMediaGenerationCancelledEvent(failedMediaKind);
        }
        if (!stoppedByUser && shouldAutoRetryFullAutoGenerationStep(runPlan, failedStep)) {
          const retryLabel =
            failedStep?.id === "outlines" ? "自动补齐缺失细纲" : "自动补齐缺失正文";
          const retryMessage =
            failedStep?.id === "outlines"
              ? "本轮细纲生成未完全成功，AI 会自动改为补齐缺失细纲后继续。"
              : "本轮正文生成未完全成功，AI 会自动改为补齐缺失正文后继续。";
          const nextPlan = syncFullAutoPlanSteps({
            ...updateFullAutoStepStrategy(runPlan, failedStep, failedStep?.strategyKey === "outlineGeneration" ? "script:outline-fill-missing" : "script:episode-fill-missing", retryLabel),
            retryCounts: {
              ...(runPlan.retryCounts ?? {}),
              ...(failedStep?.id ? { [failedStep.id]: (runPlan.retryCounts?.[failedStep.id] ?? 0) + 1 } : {}),
            },
          });
          push("assistant", retryMessage);
          void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: failedIndex });
          return;
        }
        if (
          !stoppedByUser &&
          shouldAutoRetryRecoverableFullAutoStep({
            plan: runPlan,
            step: failedStep,
            error,
          })
        ) {
          const nextRetryCount = failedStep?.id
            ? (runPlan.retryCounts?.[failedStep.id] ?? 0) + 1
            : 1;
          const nextPlan = syncFullAutoPlanSteps({
            ...runPlan,
            setupInput:
              failedStep?.id === "video-analyze"
                ? {
                    ...(runPlan.setupInput ?? {}),
                    systemPrompt: mergeFullAutoVideoAnalyzeRetrySystemPrompt(
                      runPlan.setupInput?.systemPrompt,
                      error,
                      `第 ${nextRetryCount} 轮自动重试`,
                    ),
                  }
                : runPlan.setupInput,
            retryCounts: {
              ...(runPlan.retryCounts ?? {}),
              ...(failedStep?.id ? { [failedStep.id]: nextRetryCount } : {}),
            },
          });
          commitFullAutoState(
            makeRunState("retrying", failedIndex, {
              currentStepLabel: `${failedStep?.label || "当前步骤"}（第 ${nextRetryCount} 轮自动重试）`,
              lastError: message,
              plan: nextPlan,
            }),
          );
          push(
            "assistant",
            buildFullAutoRetryAssistantMessage({
              stepLabel: failedStep?.label || "当前步骤",
              error,
              nextAttempt: nextRetryCount,
              stage: "round",
            }),
          );
          try {
            await waitForAbortableDelay(FULL_AUTO_RECOVERABLE_STEP_RETRY_DELAY_MS, abortController.signal);
          } catch {
            return;
          }
          if (abortController.signal.aborted) {
            return;
          }
          void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: failedIndex });
          return;
        }
        const failedRunState = makeRunState(stoppedByUser ? "stopped" : "failed", failedIndex, {
          stoppedByUser,
          lastError: message,
          plan: {
            ...markFullAutoSteps(runPlan, failedIndex, stoppedByUser ? "stopped" : "failed"),
            stoppedStepId: stoppedByUser ? failedSteps[failedIndex]?.id : runPlan.stoppedStepId,
            resumeFromStepId: failedSteps[failedIndex]?.id,
          },
        });
        commitFullAutoState(failedRunState);
        const restoreQuestion = buildFullAutoWorkflowFollowupQuestion({
          run: failedRunState,
          runtime: nextRuntime,
        });
        if (restoreQuestion) {
          setPopoverOverride(restoreQuestion);
          setSuggested(null);
        }
        push(
          "assistant",
          stoppedByUser
            ? "全自动执行已停止。点击“继续当前任务”后，AI 会从未完成步骤继续自动补齐。"
            : `全自动执行遇到问题：${message}。点击“继续当前任务”后，AI 会从未完成步骤继续自动补齐。`,
        );
      } finally {
        const isCurrentExecution = executionEpoch === fullAutoExecutionEpochRef.current;
        if (isCurrentExecution) {
          fullAutoUserStoppedRef.current = false;
        }
        if (activeExecutionAbortRef.current === abortController) {
          activeExecutionAbortRef.current = null;
        }
        if (isCurrentExecution) {
          setActiveWorkflowAction(null);
          setStreaming(false);
        }
      }
    },
    [
      clearPendingWorkflowUploads,
      commitFullAutoRunState,
      decorateFullAutoWorkflowInput,
      loadProjectStore,
      loadWorkflowActionsModule,
      push,
      pushFullAutoUserMessage,
      resetComposerDraft,
      runtimeRef,
      setActiveProjectId,
      setActiveWorkflowAction,
      setMode,
      setPopoverOverride,
      setRuntime,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const beginFullAutoCollection = useCallback(
    async (plan: FullAutoRunPlan, introMessage: string) => {
      activeFullAutoShortcutRef.current = null;
      pendingFullAutoWorkflowUploadRef.current = null;
      setFullAutoChecklistCollapsed?.(true);
      const firstQuestion = getNextFullAutoStrategyQuestion(plan);
      const collectingState: FullAutoRunState = {
        status: "collecting",
        plan,
        currentStepIndex: 0,
        currentStepLabel: firstQuestion?.title ?? "全自动策略预采集",
      };

      commitFullAutoRunState(collectingState);
      const currentSnapshot = runtimeRef.current.currentProjectSnapshot;
      if (!currentSnapshot?.projectId || currentSnapshot.automationMode !== "full-auto") {
        const placeholderSnapshot = buildFullAutoCollectionPlaceholderSnapshot({
          sessionId: runtimeRef.current.sessionId,
          userPrompt: plan.userBubble,
          projectKind: plan.projectKind,
        });
        startTransition(() => {
          setRuntime((prev) => {
            if (
              prev.currentProjectSnapshot?.projectId &&
              prev.currentProjectSnapshot.automationMode === "full-auto"
            ) {
              return prev;
            }
            const nextRuntime = {
              ...prev,
              currentProjectSnapshot: placeholderSnapshot,
              recentProjects: mergeRecentProjects(prev.recentProjects, placeholderSnapshot),
            };
            runtimeRef.current = nextRuntime;
            return nextRuntime;
          });
          syncActiveProjectIdWithSnapshot(placeholderSnapshot, placeholderSnapshot.projectId);
        });
      }
      setMode("active");
      setSuggested(null);
      setSelectedValues([]);
      resetComposerDraft("");
      push("assistant", introMessage);
      if (firstQuestion) {
        setPopoverOverride(firstQuestion);
      } else {
        await runFullAutoOriginalScriptPlan(plan, { startIndex: 0 });
      }
    },
    [
      commitFullAutoRunState,
      push,
      resetComposerDraft,
      runFullAutoOriginalScriptPlan,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setFullAutoChecklistCollapsed,
      setSelectedValues,
      setSuggested,
      setRuntime,
    ],
  );

  const beginFullAutoOriginalScriptCollection = useCallback(
    async (completion: OriginalScriptKickoffCompletion) => {
      const plan = createFullAutoOriginalScriptRunPlan(completion, videoGenerationPrefs);
      await beginFullAutoCollection(
        plan,
        "项目设定已确认。全自动模式会先一次性收集后续批量生成、质检、视频和导出策略，全部确认后再开始连续执行。",
      );
    },
    [beginFullAutoCollection, videoGenerationPrefs],
  );

  const beginFullAutoAdaptationCollection = useCallback(
    async (seed: { referenceScript: string; title?: string; userBubble: string }) => {
      const plan = createFullAutoAdaptationRunPlan(seed, videoGenerationPrefs);
      await beginFullAutoCollection(
        plan,
        "参考文本已确认。全自动模式会先一次性收集改编、质检、视频和导出策略，全部确认后再连续执行到出片。",
      );
    },
    [beginFullAutoCollection, videoGenerationPrefs],
  );

  const beginFullAutoVideoWorkflowCollection = useCallback(
    async (seed: {
      source: "upload-document" | "use-current-project" | "start-fresh";
      userBubble: string;
      title?: string;
      script?: string;
      projectId?: string;
      sourceProjectId?: string;
    }) => {
      const plan = createFullAutoVideoWorkflowRunPlan(seed, videoGenerationPrefs);
      await beginFullAutoCollection(
        plan,
        "视频入口已确认。全自动模式会先一次性收集拆解、分镜、生成和导出策略，全部确认后再连续执行到出片。",
      );
    },
    [beginFullAutoCollection, videoGenerationPrefs],
  );

  const commitFullAutoCollectedPlan = useCallback(
    (nextPlan: FullAutoRunPlan) => {
      const nextQuestion = getNextFullAutoStrategyQuestion(nextPlan);
      const nextState: FullAutoRunState = {
        status: nextQuestion ? "collecting" : "running",
        plan: nextPlan,
        currentStepIndex: 0,
        currentStepLabel: nextQuestion?.title ?? "准备执行",
      };
      commitFullAutoRunState(nextState);
      setSelectedValues([]);
      resetComposerDraft("");
      if (nextQuestion) {
        setPopoverOverride(nextQuestion);
        setSuggested(null);
      } else {
        setPopoverOverride(null);
        setSuggested(null);
        void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: 0 });
      }
    },
    [
      commitFullAutoRunState,
      resetComposerDraft,
      runFullAutoOriginalScriptPlan,
      setPopoverOverride,
      setSelectedValues,
      setSuggested,
    ],
  );

  const handleFullAutoQuestionBack = useCallback((): boolean => {
    const run = runtimeRef.current.fullAutoRun;
    if (run?.status !== "collecting" || !run.plan || !canRewindFullAutoStrategyPlan(run.plan)) {
      return false;
    }

    const nextPlan = rewindFullAutoStrategyPlan(run.plan);
    if (!nextPlan) return false;
    const nextQuestion = getNextFullAutoStrategyQuestion(nextPlan);
    if (!nextQuestion) return false;

    commitFullAutoRunState({
      status: "collecting",
      plan: nextPlan,
      currentStepIndex: 0,
      currentStepLabel: nextQuestion.title,
    });
    setSelectedValues([]);
    resetComposerDraft("");
    setSuggested(null);
    setPopoverOverride(nextQuestion);
    return true;
  }, [
    commitFullAutoRunState,
    resetComposerDraft,
    runtimeRef,
    setPopoverOverride,
    setSelectedValues,
    setSuggested,
  ]);

  const handleFullAutoQuestionReset = useCallback((): boolean => {
    const run = runtimeRef.current.fullAutoRun;
    if (run?.status !== "collecting" || !run.plan || !canRewindFullAutoStrategyPlan(run.plan)) {
      return false;
    }

    const nextPlan = resetFullAutoStrategyPlan(run.plan);
    const nextQuestion = getNextFullAutoStrategyQuestion(nextPlan);
    if (!nextQuestion) return false;

    commitFullAutoRunState({
      status: "collecting",
      plan: nextPlan,
      currentStepIndex: 0,
      currentStepLabel: nextQuestion.title,
    });
    setSelectedValues([]);
    resetComposerDraft("");
    setSuggested(null);
    setPopoverOverride(nextQuestion);
    return true;
  }, [
    commitFullAutoRunState,
    resetComposerDraft,
    runtimeRef,
    setPopoverOverride,
    setSelectedValues,
    setSuggested,
  ]);

  const handleFullAutoChoiceSelect = useCallback(
    (value: string, label: string, question?: ComposerQuestion | null): boolean => {
      const run = runtimeRef.current.fullAutoRun;
      if (!run?.plan) return false;

      if (value === FULL_AUTO_RESUME_VALUE) {
        const nextPlan = syncFullAutoPlanSteps(run.plan);
        const resumeStepId = resolveFullAutoResumeStepIdFromRuntime({
          plan: nextPlan,
          runtime: runtimeRef.current,
          fallbackIndex: run.currentStepIndex,
        });
        const resumeIndex = findFullAutoStepIndexById(nextPlan, resumeStepId);
        const startIndex = Math.max(0, resumeIndex >= 0 ? resumeIndex : run.currentStepIndex);
        setSelectedValues([]);
        resetComposerDraft("");
        setPopoverOverride(null);
        setSuggested(null);
        void runFullAutoOriginalScriptPlan(nextPlan, { startIndex });
        return true;
      }

      if (run.status === "collecting" && isFullAutoStrategyQuestion(question)) {
        if (
          question?.answerKey === "full-auto-preflight:scriptDocumentExport" &&
          value !== "script:export-local:skip"
        ) {
          void (async () => {
            const folder = await window.electronAPI?.storage?.selectFolder?.();
            if (!folder) return;
            const answeredPlan = applyFullAutoStrategyAnswer(run.plan, value, label, question);
            if (!answeredPlan) return;
            const nextPlan = applyHiddenFullAutoStrategyAnswer({
              plan: answeredPlan,
              key: "scriptDocumentExportPath",
              phase: "剧本导出",
              value: `script:export:path:${encodeURIComponent(folder)}`,
              label: folder,
            });
            commitFullAutoCollectedPlan(nextPlan);
          })();
          return true;
        }

        if (
          question?.answerKey === "full-auto-preflight:storyboardXlsxExport" &&
          value !== "video:bridge:export-xlsx:skip"
        ) {
          void (async () => {
            const folder = await window.electronAPI?.storage?.selectFolder?.();
            if (!folder) return;
            const answeredPlan = applyFullAutoStrategyAnswer(run.plan, value, label, question);
            if (!answeredPlan) return;
            const nextPlan = applyHiddenFullAutoStrategyAnswer({
              plan: answeredPlan,
              key: "storyboardXlsxExportPath",
              phase: "剧本拆解",
              value: `video:bridge:export-xlsx:path:${encodeURIComponent(folder)}`,
              label: folder,
            });
            commitFullAutoCollectedPlan(nextPlan);
          })();
          return true;
        }

        if (
          question?.answerKey === "full-auto-preflight:videoExportPath" &&
          value === "video:export:path:pick"
        ) {
          void (async () => {
            const folder = await window.electronAPI?.storage?.selectFolder?.();
            if (!folder) return;
            const nextPlan = applyFullAutoStrategyAnswer(
              run.plan,
              `video:export:path:${encodeURIComponent(folder)}`,
              folder,
              question,
            );
            if (!nextPlan) return;
            setSelectedValues([]);
            resetComposerDraft("");
            setSuggested(null);
            setPopoverOverride(null);
            commitFullAutoCollectedPlan(nextPlan);
          })();
          return true;
        }

        const nextPlan = applyFullAutoStrategyAnswer(run.plan, value, label, question);
        if (!nextPlan) return false;
        commitFullAutoCollectedPlan(nextPlan);
        return true;
      }

      if (run.status === "stopped" || run.status === "paused" || run.status === "failed") {
        const steps = buildFullAutoExecutionSteps(run.plan);
        const currentStepIndex = Math.max(0, Math.min(run.currentStepIndex, steps.length - 1));
        const nextPlan = updateFullAutoStepStrategy(run.plan, steps[currentStepIndex], value, label);
        setSelectedValues([]);
        setPopoverOverride(null);
        setSuggested(null);
        void runFullAutoOriginalScriptPlan(nextPlan, { startIndex: currentStepIndex });
        return true;
      }

      return false;
    },
    [
      commitFullAutoCollectedPlan,
      runFullAutoOriginalScriptPlan,
      runtimeRef,
      setPopoverOverride,
      setSelectedValues,
      setSuggested,
    ],
  );

  const stopFullAutoExecution = useCallback(
    (): StopActiveExecutionResult => {
      const run = runtimeRef.current.fullAutoRun;
      const cancelledRemoteVideoTaskCount = cancelTrackedRemoteVideoTasks();
      const hadActiveExecution =
        Boolean(activeExecutionAbortRef.current) ||
        run?.status === "collecting" ||
        run?.status === "running" ||
        run?.status === "retrying";

      fullAutoUserStoppedRef.current = true;
      fullAutoExecutionEpochRef.current += 1;
      activeExecutionAbortRef.current?.abort();
      activeExecutionAbortRef.current = null;
      engineRef.current?.interrupt();
      engineRef.current = null;
      streamingMessageIdRef.current = null;
      resetPendingStreamingDelta();
      setStreaming(false);
      setActiveWorkflowAction(null);

      if (run?.plan) {
        const currentStepIndex = Math.max(0, Math.min(run.currentStepIndex, run.plan.steps.length - 1));
        const step = run.plan.steps[currentStepIndex];
        const stoppedPlan = {
          ...markFullAutoSteps(run.plan, currentStepIndex, "stopped"),
          stoppedStepId: step?.id,
          resumeFromStepId: step?.id,
        };
        commitFullAutoRunState({
          status: "stopped",
          plan: stoppedPlan,
          currentStepIndex,
          currentStepLabel: step?.label,
          stoppedByUser: true,
        });
        if (applyFullAutoWorkflowFollowupQuestion({
          run: {
            status: "stopped",
            plan: stoppedPlan,
            currentStepIndex,
          },
          runtime: runtimeRef.current,
          setSuggested,
          setPopoverOverride,
          forcePopover: true,
        })) {
          setMode("active");
        }
        push(
          "assistant",
          cancelledRemoteVideoTaskCount > 0
            ? `全自动执行已停止，并已向视频生成服务发起 ${cancelledRemoteVideoTaskCount} 条撤销请求。点击“继续当前任务”后，AI 会从未完成步骤继续自动补齐。`
            : "全自动执行已停止。点击“继续当前任务”后，AI 会从未完成步骤继续自动补齐，模式仍保持全自动。",
        );
      }

      return {
        hadActiveExecution,
        cancelledRemoteVideoTaskCount,
      };
    },
    [
      commitFullAutoRunState,
      engineRef,
      push,
      resetPendingStreamingDelta,
      runtimeRef,
      setMode,
      setActiveWorkflowAction,
      setPopoverOverride,
      setStreaming,
      setSuggested,
    ],
  );

  const updateStreamingMessage = useCallback((updater: (message: HomeAgentMessage | null) => HomeAgentMessage) => {
    const targetId = streamingMessageIdRef.current;
    setMessages((prev) => {
      const sid = targetId;
      if (!sid) {
        const next = updater(null);
        streamingMessageIdRef.current = next.id;
        const nextMessages = [...prev, next];
        messagesRef.current = nextMessages;
        return nextMessages;
      }

      const index = prev.findIndex((message) => message.id === sid);
      if (index === -1) {
        const next = updater(null);
        streamingMessageIdRef.current = next.id;
        const nextMessages = [...prev, next];
        messagesRef.current = nextMessages;
        return nextMessages;
      }

      const current = prev[index] ?? null;
      const next = updater(current);
      if (next.id !== sid) {
        streamingMessageIdRef.current = next.id;
      }
      const nextMessages = [...prev.slice(0, index), next, ...prev.slice(index + 1)];
      messagesRef.current = nextMessages;
      return nextMessages;
    });
  }, [messagesRef, setMessages]);

  const flushPendingStreamingDelta = useCallback((forceAll = false) => {
    const pending = pendingStreamingDeltaRef.current;
    if (!pending) return "";

    const nextChunk = forceAll
      ? pending
      : pending.slice(0, resolveStreamingDeltaChunkSize(pending));
    pendingStreamingDeltaRef.current = pending.slice(nextChunk.length);
    if (!nextChunk) return "";
    hasStreamedVisibleTextRef.current = true;

    updateStreamingMessage((message) => {
      if (message) {
        return {
          ...message,
          content: message.content + nextChunk,
          status: "pending",
          streamLabel: "继续分析中",
        };
      }

      return {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: nextChunk,
        createdAt: new Date().toISOString(),
        status: "pending",
        streamLabel: "继续分析中",
      };
    });

    return nextChunk;
  }, [updateStreamingMessage]);

  const completePendingStreamingFinalize = useCallback(() => {
    const pendingFinalize = pendingStreamingFinalizeRef.current;
    if (!pendingFinalize || pendingStreamingDeltaRef.current) return;
    pendingStreamingFinalizeRef.current = null;

    const resolvedArtifactSnapshots =
      pendingFinalize.artifactSnapshots?.length
        ? pendingFinalize.artifactSnapshots
        : resolveArtifactSnapshots(runtimeRef.current.currentProjectSnapshot, pendingFinalize.artifactIds);

    if (!streamingMessageIdRef.current) {
      const fallbackText = pendingFinalize.finalText?.trim() || "";
      if (fallbackText || pendingFinalize.artifactIds?.length) {
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: fallbackText,
              createdAt: new Date().toISOString(),
              status: "complete",
              ...(pendingFinalize.artifactIds?.length ? { artifactIds: pendingFinalize.artifactIds } : {}),
              ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
            },
          ];
          messagesRef.current = next;
          return next;
        });
      }
      hasStreamedVisibleTextRef.current = false;
      return;
    }

    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      content: pendingFinalize.finalText?.trim() || message?.content || "",
      status: "complete",
      streamLabel: undefined,
      ...(pendingFinalize.artifactIds?.length ? { artifactIds: pendingFinalize.artifactIds } : {}),
      ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
    }));
    streamingMessageIdRef.current = null;
    hasStreamedVisibleTextRef.current = false;
  }, [messagesRef, runtimeRef, setMessages, updateStreamingMessage]);

  const schedulePendingStreamingDeltaFlush = useCallback(() => {
    if (streamingDeltaRafRef.current !== null) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      flushPendingStreamingDelta(true);
      if (!pendingStreamingDeltaRef.current) {
        completePendingStreamingFinalize();
      }
      return;
    }

    streamingDeltaRafRef.current = window.requestAnimationFrame(() => {
      streamingDeltaRafRef.current = null;
      flushPendingStreamingDelta(false);
      if (pendingStreamingDeltaRef.current) {
        schedulePendingStreamingDeltaFlush();
        return;
      }
      completePendingStreamingFinalize();
    });
  }, [completePendingStreamingFinalize, flushPendingStreamingDelta]);

  const discardStreamingMessage = useCallback(() => {
    resetPendingStreamingDelta();
    const targetId = streamingMessageIdRef.current;
    if (!targetId) return;
    streamingMessageIdRef.current = null;
    setMessages((prev) => {
      const next = prev.filter((message) => message.id !== targetId);
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, resetPendingStreamingDelta, setMessages]);

  const appendStreamingDelta = useCallback((delta: string) => {
    if (!delta) return;
    pendingStreamingDeltaRef.current += delta;
    schedulePendingStreamingDeltaFlush();
  }, [schedulePendingStreamingDeltaFlush]);

  const updateStreamingLabel = useCallback((label?: string) => {
    if (!streamingMessageIdRef.current) return;
    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      status: "pending",
      streamLabel: label || "继续分析中",
    }));
  }, [updateStreamingMessage]);

  const finalizeStreamingMessage = useCallback((
    finalText?: string,
    artifactIds?: string[],
    artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
  ) => {
    const trimmedFinalText = typeof finalText === "string" ? finalText.trim() : undefined;
    const bufferedTail = pendingStreamingDeltaRef.current;
    const queuedFinalText = trimmedFinalText ?? bufferedTail.trim();
    if (
      streamingMessageIdRef.current &&
      queuedFinalText &&
      !hasStreamedVisibleTextRef.current
    ) {
      pendingStreamingFinalizeRef.current = {
        finalText: trimmedFinalText,
        artifactIds,
        artifactSnapshots,
      };
      pendingStreamingDeltaRef.current = trimmedFinalText ?? bufferedTail;
      cancelPendingStreamingDeltaFlush();
      schedulePendingStreamingDeltaFlush();
      return;
    }
    resetPendingStreamingDelta();
    const resolvedArtifactSnapshots =
      artifactSnapshots?.length
        ? artifactSnapshots
        : resolveArtifactSnapshots(runtimeRef.current.currentProjectSnapshot, artifactIds);

    if (!streamingMessageIdRef.current) {
      const fallbackText =
        typeof finalText === "string"
          ? finalText.trim()
          : bufferedTail.trim();
      if (fallbackText || artifactIds?.length) {
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant" as const,
              content: fallbackText,
              createdAt: new Date().toISOString(),
              status: "complete",
              ...(artifactIds?.length ? { artifactIds } : {}),
              ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
            },
          ];
          messagesRef.current = next;
          return next;
        });
      }
      return;
    }

    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: `streaming-${Date.now()}`,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      content:
        typeof finalText === "string"
          ? finalText.trim()
          : `${message?.content ?? ""}${bufferedTail}`,
      status: "complete",
      streamLabel: undefined,
      ...(artifactIds?.length ? { artifactIds } : {}),
      ...(resolvedArtifactSnapshots.length ? { artifactSnapshots: resolvedArtifactSnapshots } : {}),
    }));
    streamingMessageIdRef.current = null;
    hasStreamedVisibleTextRef.current = false;
  }, [
    cancelPendingStreamingDeltaFlush,
    messagesRef,
    resetPendingStreamingDelta,
    runtimeRef,
    schedulePendingStreamingDeltaFlush,
    setMessages,
    updateStreamingMessage,
  ]);

  const ensureStreamingMessage = useCallback((label = "正在分析") => {
    const reservedId = streamingMessageIdRef.current ?? `streaming-${Date.now()}`;
    streamingMessageIdRef.current = reservedId;
    updateStreamingMessage((message) => ({
      ...(message ?? {
        id: reservedId,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
      }),
      status: "pending",
      streamLabel: message?.streamLabel || label,
    }));
  }, [updateStreamingMessage]);

  const getEngine = useCallback(async () => {
    engineRef.current = await getOrCreateHomeAgentEngine({
      existingEngine: engineRef.current,
      loadEngineDeps,
      loadApiConfigModule,
      messages: messagesRef.current,
      compactedMessageCount: compactedMessageCountRef.current,
      recentMessageSummary: runtimeRef.current.recentMessageSummary,
      systemPrompt,
      toQuery,
      getAppState: getRuntimeWithGenerationPrefs,
      setRuntime,
      setCompactedMessageCount: (count) => {
        compactedMessageCountRef.current = count;
        setCompactedMessageCount(count);
      },
      selectedTextModelKey,
    });
    return engineRef.current;
  }, [
    compactedMessageCountRef,
    engineRef,
    loadApiConfigModule,
    loadEngineDeps,
    messagesRef,
    systemPrompt,
    runtimeRef,
    selectedTextModelKey,
    getRuntimeWithGenerationPrefs,
    setCompactedMessageCount,
    setRuntime,
    toQuery,
  ]);

  const getEngineResult = useCallback(async () => {
    try {
      return {
        ok: true as const,
        engine: await getEngine(),
      };
    } catch (error) {
      return {
        ok: false as const,
        error,
      };
    }
  }, [getEngine]);

  const launchAutoResearchTasks = useCallback(
    async (nextPrompt: string) =>
      launchHomeAgentAutoResearchTasks({
        prompt: nextPrompt,
        runtime: runtimeRef.current,
        loadApiConfigModule,
        selectedTextModelKey,
      }),
    [loadApiConfigModule, runtimeRef, selectedTextModelKey],
  );

  const runDirectProjectImageGeneration = useCallback(
    async (
      imagePrompt: string,
      userBubble: string,
      batchCount = 1,
      imageKind: "character" | "scene" = "scene",
      abortSignal?: AbortSignal,
    ) => {
      let hasPendingImagePlaceholder = false;
      const mediaEventId = createMediaEventId();
      try {
        throwIfAborted(abortSignal);
        setStreaming(true);
        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const baseUi = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, projectId);
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];
        const totalImageCount = Math.max(1, Math.min(8, Math.floor(batchCount)));
        let lastCompletion: Awaited<ReturnType<typeof runWorkflowShortcut>> | null = null;
        const contentSummary = buildMediaContentSummary({
          action: "generate_project_image",
          promptText: imagePrompt,
          imageKind,
          runtime: runtimeRef.current,
        });

        // 根据项目阶段生成简洁动态回复
        {
          const snapshot = runtimeRef.current.currentProjectSnapshot;
          const batchSuffix = totalImageCount > 1 ? ` ×${totalImageCount}` : "";
          let reply: string;
          if (snapshot) {
            const stage = snapshot.derivedStage ?? "";
            const actionLabel =
              stage.includes("分镜") || stage.includes("storyboard") ? "分镜图" :
              stage.includes("角色") || stage.includes("character") ? "角色图" :
              stage.includes("场景") || stage.includes("scene") ? "场景图" :
              stage.includes("概念") || stage.includes("concept") ? "概念图" : "图片";
            reply = `${actionLabel}生成中${batchSuffix}：《${snapshot.title}》${contentSummary ? `\n内容 ${contentSummary}` : ""}`;
          } else {
            reply = `图片生成中${batchSuffix}${contentSummary ? `\n内容 ${contentSummary}` : ""}`;
          }
          push("assistant", [reply, buildMediaSubmissionGuardLine("image")].filter(Boolean).join("\n"));
        }

        const workflow = await loadWorkflowActionsModule();

        // 触发生成中 pending 状态（shimmer 动画 + 文本提示）
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generating-start", {
              detail: {
                count: totalImageCount,
                action: "generate_project_image",
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary,
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_project_image",
                  runtime: runtimeRef.current,
                }),
                mediaEventId,
              },
            }),
          );
          hasPendingImagePlaceholder = true;
        }

        for (let index = 0; index < totalImageCount; index += 1) {
          throwIfAborted(abortSignal);
          const completion = await runWorkflowShortcut({
            action: "generate_project_image",
            input: {
              imagePrompt,
              prompt: imagePrompt,
              imageKind,
              selectedImageModelFamily,
              modelFamily: selectedImageModelFamily,
              imageGenerationPrefs: normalizedImagePrefs,
              aspectRatio: normalizedImagePrefs.aspectRatio,
              resolution: normalizedImagePrefs.resolution,
              batchIndex: index + 1,
              batchCount: totalImageCount,
              mediaEventId,
              abortSignal,
            },
            runtime: runtimeRef.current,
            deferRecentProjectUpsert: true,
            runAction: async (nextAction, nextInput, nextRuntime) => {
              const result = await workflow.runWorkflowAction(nextAction, nextInput, nextRuntime);
              if (result.imageUrls?.length) {
                generatedImageUrls.push(...result.imageUrls);
                if (result.imageLabels?.length) {
                  generatedImageLabels.push(...result.imageLabels);
                }
                return { ...result, summary: "" };
              }
              return result;
            },
            ui: {
              ...baseUi,
              pushUser: () => undefined,
            },
            userBubble,
            allowAutoFollowup: false,
            surfaceNextSuggestion: false,
            onErrorMessage: () => {
              restoreInterruptedChoiceQuestion?.(null);
            },
          });
          lastCompletion = completion;
          if (!completion) {
            break;
          }
        }

        if (generatedImageUrls.length && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generated", {
              detail: {
                imageUrls: generatedImageUrls,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
                action: "generate_project_image",
                count: generatedImageUrls.length,
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary,
                mediaEventId,
              },
            }),
          );
        }
        if (generatedImageUrls.length) {
          applyWorkflowMediaFollowupQuestion({
            projectSnapshot: lastCompletion?.projectSnapshot,
            runtime: lastCompletion?.runtime,
            preferredQuestion: lastCompletion?.nextSuggestion,
            setSuggested,
            setPopoverOverride,
          });
        }
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) {
          if (hasPendingImagePlaceholder) {
            dispatchMediaGenerationCancelledEvent("image", mediaEventId);
          }
          return;
        }
        if (hasPendingImagePlaceholder) {
          dispatchMediaGenerationFailedEvent(
            "image",
            error instanceof Error ? error.message : String(error),
            mediaEventId,
          );
        }
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        setStreaming(false);
        push("assistant", error instanceof Error ? error.message : String(error));
      } finally {
        setStreaming(false);
      }
    },
    [
      imageGenerationPrefs,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      selectedImageModelFamily,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setRuntime,
      setStreaming,
      setSuggested,
      restoreInterruptedChoiceQuestion,
    ],
  );

  const runDirectVideoGeneration = useCallback(
    async (
      userBubble: string,
      promptText: string,
      mode: VideoGenerationPrefs["mode"],
      targetIds?: string[],
      abortSignal?: AbortSignal,
    ) => {
      let hasPendingVideoPlaceholder = false;
      const mediaEventId = createMediaEventId();
      try {
        throwIfAborted(abortSignal);
        setStreaming(true);

        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
          ...videoGenerationPrefs,
          modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
          mode,
        });
        const projectId =
          runtimeRef.current.currentProjectSnapshot?.projectKind === "video"
            ? runtimeRef.current.currentProjectSnapshot.projectId
            : runtimeRef.current.currentVideoProject?.id;
        const contentSummary = buildMediaContentSummary({
          action: "generate_video_assets",
          promptText,
          runtime: runtimeRef.current,
          targetIds,
        });

        if (!projectId) {
          if (mode === "image-to-video") {
            push("assistant", "当前这条请求缺少参考图，暂时不能直接走图生视频。请上传参考图，或改成文生视频。");
            return;
          }

          const directPrompt = String(promptText || "").trim();
          if (!directPrompt) {
            push("assistant", "这条视频请求还缺少明确的画面描述。请直接告诉我要生成什么视频。");
            return;
          }

          const resolvedModel = resolveVideoGenerationModelName(normalizedVideoPrefs);
          const provider = resolveVideoGenerationProvider(normalizedVideoPrefs);
          push(
            "assistant",
            [
              "开始生成视频。",
              contentSummary ? `内容 ${contentSummary}` : "",
              mode ? `模式 ${localizeMediaSettingValue(mode, "mode")}` : "",
              resolvedModel ? `模型 ${resolvedModel}` : "",
              normalizedVideoPrefs.resolution
                ? `分辨率 ${localizeMediaSettingValue(normalizedVideoPrefs.resolution, "resolution")}`
                : "",
              buildMediaSubmissionGuardLine("video"),
            ]
              .filter(Boolean)
              .join("\n"),
          );
          throwIfAborted(abortSignal);
          const submitResult = await invokeFunctionLazy<DirectVideoGenerationTaskResult>(
            "generate-video",
            {
              prompt: directPrompt,
              duration: 4,
              aspectRatio:
                normalizedVideoPrefs.aspectRatio ||
                normalizedImagePrefs.aspectRatio ||
                "16:9",
              resolution: normalizedVideoPrefs.resolution,
              model: resolvedModel,
              provider,
            },
            { abortSignal },
          );
          if (submitResult.error) throw submitResult.error;
          throwIfAborted(abortSignal);

          const taskId = String(submitResult.data?.task_id || "").trim();
          const resolvedProvider = submitResult.data?.provider || provider;
          if (!taskId) {
            throw new Error("视频任务已提交，但没有返回任务 ID。");
          }

          trackActiveRemoteVideoTask({
            taskId,
            provider: resolvedProvider,
          });

          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("agent:video-generating-start", {
                detail: {
                  action: "generate-video",
                  mediaEventId,
                  model: resolvedModel,
                  resolution: normalizedVideoPrefs.resolution,
                  mode,
                  provider: resolvedProvider,
                  sceneCount: 1,
                  count: 1,
                  contentSummary,
                  targetLabels: buildWorkflowMediaTargetLabels({
                    action: "generate_video_assets",
                    runtime: runtimeRef.current,
                    targetIds,
                  }),
                },
              }),
            );
            hasPendingVideoPlaceholder = true;
          }

          for (let attempt = 0; attempt < DIRECT_VIDEO_MAX_POLL_ROUNDS; attempt += 1) {
            if (attempt > 0) {
              await waitForAbortableDelay(DIRECT_VIDEO_POLL_INTERVAL_MS, abortSignal);
            }
            throwIfAborted(abortSignal);

            const statusResult = await invokeFunctionLazy<DirectVideoGenerationStatusResult>(
              "generate-video",
              {
                action: "status",
                taskId,
                provider: resolvedProvider,
              },
              { abortSignal },
            );
            if (statusResult.error) throw statusResult.error;
            throwIfAborted(abortSignal);

            const normalizedStatus = String(statusResult.data?.status || "").trim().toLowerCase();
            const videoUrl = String(statusResult.data?.video_url || "").trim();

            if ((normalizedStatus === "succeeded" || normalizedStatus === "completed") && videoUrl) {
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("agent:video-generated", {
                    detail: {
                      videoUrls: [videoUrl],
                      mediaEventId,
                      action: "generate-video",
                      count: 1,
                      model: resolvedModel,
                      resolution: normalizedVideoPrefs.resolution,
                      provider: resolvedProvider,
                      mode,
                      contentSummary,
                    },
                  }),
                );
              }
              untrackActiveRemoteVideoTask(taskId, resolvedProvider);
              return;
            }

            if (
              normalizedStatus === "failed" ||
              normalizedStatus === "error" ||
              normalizedStatus === "cancelled"
            ) {
              untrackActiveRemoteVideoTask(taskId, resolvedProvider);
              throw new Error("视频生成失败，请换一个描述或稍后重试。");
            }
          }

          untrackActiveRemoteVideoTask(taskId, resolvedProvider);
          throw new Error(
            `视频生成超时（>${Math.round((DIRECT_VIDEO_MAX_POLL_ROUNDS * DIRECT_VIDEO_POLL_INTERVAL_MS) / 60_000)}分钟），请稍后重试。`,
          );
        }

        push(
          "assistant",
          [
            "开始生成视频。",
            contentSummary ? `内容 ${contentSummary}` : "",
            mode ? `模式 ${localizeMediaSettingValue(mode, "mode")}` : "",
            normalizedVideoPrefs.modelKey ? `模型 ${normalizedVideoPrefs.modelKey}` : "",
            normalizedVideoPrefs.resolution
              ? `分辨率 ${localizeMediaSettingValue(normalizedVideoPrefs.resolution, "resolution")}`
              : "",
            buildMediaSubmissionGuardLine("video"),
          ]
            .filter(Boolean)
            .join("\n"),
        );
        const workflow = await loadWorkflowActionsModule();
        const workflowInput = {
          projectId,
          ...(targetIds?.length ? { targetIds } : {}),
          selectedImageModelFamily,
          imageGenerationPrefs: normalizedImagePrefs,
          selectedVideoModelKey: normalizedVideoPrefs.modelKey,
          videoModelKey: normalizedVideoPrefs.modelKey,
          videoGenerationPrefs: normalizedVideoPrefs,
          mediaEventId,
        };

        let nextRuntime = runtimeRef.current;
        const applyWorkflowResult = (
          result: Awaited<ReturnType<typeof workflow.runWorkflowAction>>,
          pushSummary = true,
        ) => {
          if (result.data) {
            nextRuntime = mergeRuntimeWithWorkflowDelta(nextRuntime, result.data, {
              deferRecentProjectUpsert: true,
            });
            syncTrackedRemoteVideoTasksFromRuntime(nextRuntime);
            startTransition(() => {
              setRuntime(nextRuntime);
              syncActiveProjectIdWithSnapshot(
                nextRuntime.currentProjectSnapshot,
                nextRuntime.currentProjectSnapshot?.projectId,
              );
            });
          }

          if (pushSummary && result.summary.trim()) {
            push("assistant", result.summary.trim());
          }

          if (result.videoUrls?.length && typeof window !== "undefined") {
            const matchingSceneIds = (nextRuntime.currentVideoProject?.scenes ?? [])
              .filter((s) => result.videoUrls!.includes(s.videoUrl ?? ""))
              .map((s) => s.id);
            const contentSummary = buildMediaContentSummary({
              action: "generate_video_assets",
              runtime: nextRuntime,
              targetIds: matchingSceneIds.length ? matchingSceneIds : undefined,
            });
            window.dispatchEvent(
              new CustomEvent("agent:video-generated", {
                detail: {
                  videoUrls: result.videoUrls,
                  mediaEventId,
                  ...(contentSummary ? { contentSummary } : {}),
                },
              }),
            );
          }

          return result;
        };

        const assetStatus = await workflow.runWorkflowAction(
          "query_asset_status",
          { ...workflowInput, abortSignal },
          nextRuntime,
        );
        applyWorkflowResult(assetStatus, false);
        throwIfAborted(abortSignal);

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:video-generating-start", {
              detail: {
                action: "generate_video_assets",
                mediaEventId,
                model: normalizedVideoPrefs.modelKey,
                resolution: normalizedVideoPrefs.resolution,
                mode,
                provider: normalizedVideoPrefs.provider,
                sceneCount: Math.max(1, targetIds?.length ?? 1),
                count: Math.max(1, targetIds?.length ?? 1),
                aspectRatio: normalizedVideoPrefs.aspectRatio,
                contentSummary,
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_video_assets",
                  runtime: runtimeRef.current,
                  targetIds,
                }),
              },
            }),
          );
          hasPendingVideoPlaceholder = true;
        }

        const generateResult = await workflow.runWorkflowAction(
          "generate_video_assets",
          { ...workflowInput, abortSignal },
          nextRuntime,
          (partial) => applyWorkflowResult(partial, false),
        );
        applyWorkflowResult(generateResult, false);
        throwIfAborted(abortSignal);

        applyWorkflowMediaFollowupQuestion({
          projectSnapshot: nextRuntime.currentProjectSnapshot,
          runtime: nextRuntime,
          setSuggested,
          setPopoverOverride,
        });

      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) {
          if (hasPendingVideoPlaceholder) {
            dispatchMediaGenerationCancelledEvent("video", mediaEventId);
          }
          return;
        }
        if (hasPendingVideoPlaceholder) {
          dispatchMediaGenerationFailedEvent(
            "video",
            error instanceof Error ? error.message : String(error),
            mediaEventId,
          );
        }
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        push("assistant", error instanceof Error ? error.message : String(error));
      } finally {
        setStreaming(false);
      }
    },
    [
      imageGenerationPrefs,
      loadWorkflowActionsModule,
      push,
      runtimeRef,
      syncTrackedRemoteVideoTasksFromRuntime,
      selectedImageModelFamily,
      selectedVideoModelKey,
      setActiveProjectId,
      setPopoverOverride,
      restoreInterruptedChoiceQuestion,
      setRuntime,
      setStreaming,
      setSuggested,
      trackActiveRemoteVideoTask,
      untrackActiveRemoteVideoTask,
      videoGenerationPrefs,
    ],
  );

  const runDirectStoryboardGeneration = useCallback(
    async (
      userBubble: string,
      targetIds?: string[],
      abortSignal?: AbortSignal,
    ) => {
      let hasPendingImagePlaceholder = false;
      const mediaEventId = createMediaEventId();
      try {
        throwIfAborted(abortSignal);
        const projectId =
          runtimeRef.current.currentProjectSnapshot?.projectKind === "video"
            ? runtimeRef.current.currentProjectSnapshot.projectId
            : runtimeRef.current.currentVideoProject?.id;

        if (!projectId) {
          push("assistant", "当前还没有可用的视频项目，暂时不能直接生成分镜图。");
          return;
        }
        setStreaming(true);

        const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
          ...imageGenerationPrefs,
          familyKey: selectedImageModelFamily,
        });
        const baseUi = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, nextProjectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, nextProjectId);
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];
        const contentSummary = buildMediaContentSummary({
          action: "generate_storyboard_frames",
          promptText: userBubble,
          runtime: runtimeRef.current,
          targetIds,
        });

        push(
          "assistant",
          [
            "开始生成分镜图。",
            contentSummary ? `内容 ${contentSummary}` : "",
            buildMediaSubmissionGuardLine("image"),
          ]
            .filter(Boolean)
            .join("\n"),
        );
        const workflow = await loadWorkflowActionsModule();

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generating-start", {
              detail: {
                count: 1,
                mediaEventId,
                action: "generate_storyboard_frames",
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary,
                targetLabels: buildWorkflowMediaTargetLabels({
                  action: "generate_storyboard_frames",
                  runtime: runtimeRef.current,
                  targetIds,
                }),
              },
            }),
          );
          hasPendingImagePlaceholder = true;
        }

        const completion = await runWorkflowShortcut({
          action: "generate_storyboard_frames",
          input: {
            projectId,
            ...(targetIds?.length ? { targetIds } : {}),
            selectedImageModelFamily,
            modelFamily: selectedImageModelFamily,
            imageGenerationPrefs: normalizedImagePrefs,
            aspectRatio: normalizedImagePrefs.aspectRatio,
            resolution: normalizedImagePrefs.resolution,
            mediaEventId,
            abortSignal,
          },
          runtime: runtimeRef.current,
          deferRecentProjectUpsert: true,
          runAction: async (nextAction, nextInput, nextRuntime) => {
            const result = await workflow.runWorkflowAction(nextAction, nextInput, nextRuntime);
            if (result.imageUrls?.length) {
              generatedImageUrls.push(...result.imageUrls);
            }
            if (result.imageLabels?.length) {
              generatedImageLabels.push(...result.imageLabels);
            }
            return result;
          },
          ui: {
            ...baseUi,
            pushUser: () => undefined,
          },
          userBubble,
          allowAutoFollowup: false,
          surfaceNextSuggestion: false,
          onErrorMessage: () => {
            restoreInterruptedChoiceQuestion?.(null);
          },
        });

        if (generatedImageUrls.length && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("agent:image-generated", {
              detail: {
                imageUrls: generatedImageUrls,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
                action: "generate_storyboard_frames",
                count: generatedImageUrls.length,
                mediaEventId,
                modelFamily: selectedImageModelFamily,
                resolution: normalizedImagePrefs.resolution,
                aspectRatio: normalizedImagePrefs.aspectRatio,
                contentSummary,
              },
            }),
          );
        }

        if (generatedImageUrls.length) {
          applyWorkflowMediaFollowupQuestion({
            projectSnapshot: completion?.projectSnapshot,
            runtime: completion?.runtime,
            preferredQuestion: completion?.nextSuggestion,
            setSuggested,
            setPopoverOverride,
          });
        }
      } catch (error) {
        if (isAbortLikeError(error) || abortSignal?.aborted) {
          if (hasPendingImagePlaceholder) {
            dispatchMediaGenerationCancelledEvent("image", mediaEventId);
          }
          return;
        }
        if (hasPendingImagePlaceholder) {
          dispatchMediaGenerationFailedEvent(
            "image",
            error instanceof Error ? error.message : String(error),
            mediaEventId,
          );
        }
        if (isTimeoutLikeError(error)) {
          restoreInterruptedChoiceQuestion?.(null);
        }
        setStreaming(false);
        push("assistant", error instanceof Error ? error.message : String(error));
      } finally {
        setStreaming(false);
      }
    },
    [
      imageGenerationPrefs,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      selectedImageModelFamily,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setRuntime,
      setStreaming,
      setSuggested,
      restoreInterruptedChoiceQuestion,
    ],
  );

  const send = useCallback(
    async (
      rawPrompt: MessageInput,
      shown?: string,
      sendOpts?: {
        skipUserBubble?: boolean;
        attachments?: ChatAttachment[];
        workflowAttachments?: ChatAttachment[];
        disableAutoResearch?: boolean;
      },
    ) => {
      const runId = sendRunIdRef.current + 1;
      sendRunIdRef.current = runId;
      const executionController = new AbortController();
      activeExecutionAbortRef.current = executionController;
      const prepared = beginSendFlow({
        prompt: rawPrompt,
        shown,
        push,
        setPopoverOverride,
        setSuggested,
        setMode,
        resetComposerDraft,
        attachments: sendOpts?.attachments,
        skipUserBubble: sendOpts?.skipUserBubble,
      });
      if (!prepared) {
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }
      const cleaned = prepared.cleanedText;
      const startedWithoutProject = !runtimeRef.current.currentProjectSnapshot?.projectId && !activeProjectId;
      const currentSnapshot = runtimeRef.current.currentProjectSnapshot;
      const shouldTreatCurrentSnapshotAsProjectlessForKickoff =
        isHomepageConversationPlaceholderSnapshot(currentSnapshot);
      const shouldFallbackToOriginalScriptKickoff =
        !sendOpts?.skipUserBubble &&
        !pendingAdaptationUploadRef.current &&
        !pendingVideoUploadRef.current &&
        (!currentSnapshot || shouldTreatCurrentSnapshotAsProjectlessForKickoff) &&
        isOriginalScriptDirectKickoffPrompt((shown || cleaned).trim() || cleaned);
      const fallbackOriginalScriptKickoffRequest = shouldFallbackToOriginalScriptKickoff
        ? buildOriginalScriptKickoffRequest()
        : null;
      const currentWorkflowQuestion = currentSnapshot
        ? recQuestion(currentSnapshot, runtimeRef.current.currentVideoProject)
        : null;
      const shouldBlockWorkflowMediaAction = isBlockedScriptWorkflowMediaAction(currentSnapshot);
      const blockedWorkflowMediaAction =
        shouldBlockWorkflowMediaAction && !sendOpts?.skipUserBubble && !sendOpts?.attachments?.length
          ? resolveBlockedWorkflowMediaAction(cleaned)
          : null;
      if (blockedWorkflowMediaAction && currentWorkflowQuestion) {
        setSuggested(null);
        setPopoverOverride(currentWorkflowQuestion);
      }

      const directImageIntent = resolveDirectProjectImageIntent(cleaned);
      if (
        directImageIntent &&
        !blockedWorkflowMediaAction &&
        !sendOpts?.skipUserBubble &&
        !sendOpts?.attachments?.length
      ) {
        await runDirectProjectImageGeneration(
          directImageIntent.imagePrompt,
          (shown || cleaned).trim(),
          directImageIntent.batchCount,
          directImageIntent.imageKind,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const directStoryboardIntent = resolveDirectStoryboardGenerationIntent(cleaned, {
        hasActiveVideoProject: Boolean(runtimeRef.current.currentVideoProject),
        snapshot: runtimeRef.current.currentProjectSnapshot,
        videoProject: runtimeRef.current.currentVideoProject,
      });
      if (
        directStoryboardIntent &&
        !blockedWorkflowMediaAction &&
        !sendOpts?.skipUserBubble &&
        !sendOpts?.attachments?.length
      ) {
        await runDirectStoryboardGeneration(
          (shown || cleaned).trim(),
          directStoryboardIntent.targetIds,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const directVideoIntent = resolveDirectVideoGenerationIntent(cleaned, {
        hasActiveVideoProject: Boolean(runtimeRef.current.currentVideoProject),
        snapshot: runtimeRef.current.currentProjectSnapshot,
        videoProject: runtimeRef.current.currentVideoProject,
      });
      if (
        directVideoIntent &&
        !blockedWorkflowMediaAction &&
        !sendOpts?.skipUserBubble &&
        !sendOpts?.attachments?.length
      ) {
        await runDirectVideoGeneration(
          (shown || cleaned).trim(),
          cleaned,
          directVideoIntent.mode,
          directVideoIntent.targetIds,
          executionController.signal,
        );
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const adaptationWorkflowAttachments =
        sendOpts?.workflowAttachments?.length ? sendOpts.workflowAttachments : sendOpts?.attachments;

      if (pendingAdaptationUploadRef.current && (adaptationWorkflowAttachments?.length || cleaned.trim())) {
        setPendingAdaptationUpload(false);
        const uploadReference =
          (adaptationWorkflowAttachments?.length
            ? extractAdaptationReferenceUpload(adaptationWorkflowAttachments)
            : null) ??
          (cleaned.trim()
            ? {
                referenceScript: cleaned.trim(),
                title: undefined,
                fileNames: ["pasted-reference.txt"],
              }
            : null);

        if (!uploadReference?.referenceScript.trim()) {
          push(
            "assistant",
            "已收到文档，但暂时没有提取到可用的参考文本。请改传可解析正文的 txt、docx 或 pdf，或先把参考文本粘贴到输入框后再继续参考改编。",
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        push("assistant", buildAdaptationUploadExtractionSummary(uploadReference));
        if (pendingFullAutoWorkflowUploadRef.current === "adaptation") {
          pendingFullAutoWorkflowUploadRef.current = null;
          await beginFullAutoAdaptationCollection({
            referenceScript: uploadReference.referenceScript,
            title: uploadReference.title,
            userBubble: uploadReference.title
              ? `参考改编：${uploadReference.title}`
              : "参考改编：已提供参考文本",
          });
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        const workflow = await loadWorkflowActionsModule();
        const ui = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, projectId);
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });

        const workflowCompletion = await runWorkflowShortcut({
          action: "save_setup",
          input: {
            projectKind: "adaptation",
            referenceScript: uploadReference.referenceScript,
            ...(uploadReference.title ? { title: uploadReference.title } : {}),
          },
          runtime: runtimeRef.current,
          deferRecentProjectUpsert: true,
          runAction: (nextAction, nextInput, nextRuntime) =>
            workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
          ui: {
            ...ui,
            pushUser: () => undefined,
          },
          userBubble: "",
          allowAutoFollowup: false,
          surfaceNextSuggestion: true,
        });

        if (workflowCompletion?.nextSuggestion) {
          setPopoverOverride(workflowCompletion.nextSuggestion);
          setSuggested(null);
        }

        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const workflowAttachments =
        sendOpts?.workflowAttachments?.length ? sendOpts.workflowAttachments : sendOpts?.attachments;

      if (pendingVideoUploadRef.current && !workflowAttachments?.length && !cleaned.trim()) {
        setPendingVideoUpload(false);
      }

      if (pendingVideoUploadRef.current && (workflowAttachments?.length || cleaned.trim())) {
        const rawUploadScript =
          (workflowAttachments?.length ? extractVideoWorkflowUploadScript(workflowAttachments) : null) ??
          (cleaned.trim()
            ? {
                script: cleaned.trim(),
                title: undefined,
                fileNames: ["pasted-script.txt"],
              }
            : null);

        if (!rawUploadScript?.script.trim()) {
          push(
            "assistant",
            "已收到文档，但暂时没有提取到可用的剧本文本。请改传可解析正文的 txt、docx 或 pdf，或先把脚本文本粘贴到输入框后再继续视频工作流。",
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        let uploadScript = rawUploadScript;
        push("assistant", "已收到文档，正在识别可用于视频拆解的剧本正文...");
        try {
          uploadScript = await recognizeVideoWorkflowUploadScript(rawUploadScript, {
            abortSignal: executionController.signal,
            model: selectedTextModelKey,
          });
        } catch (error) {
          if (hasEpisodeScriptBody(rawUploadScript.script)) {
            uploadScript = rawUploadScript;
          } else {
            push(
              "assistant",
              `已收到文档，但暂时没有识别到可用于拆解的剧本正文：${error instanceof Error ? error.message : String(error)}。请改传包含正文的 txt、docx 或 pdf，或把正文粘贴到输入框后继续。`,
            );
            if (activeExecutionAbortRef.current === executionController) {
              activeExecutionAbortRef.current = null;
            }
            return;
          }
        }

        if (!hasEpisodeScriptBody(uploadScript.script)) {
          push(
            "assistant",
            `已收到文档，但其中没有识别到可继续拆解的分集正文。目前只支持按入口 A 的正文剧本链路推进视频工作流；如果你上传的是创意方案、结构转译或分集简介，请改传包含"1-1"这类分场编号正文的剧本格式后再继续。`,
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        setPendingVideoUpload(false);

        push(
          "assistant",
          [buildVideoUploadExtractionSummary(uploadScript), uploadScript.extractionSummary?.trim()]
            .filter(Boolean)
            .join("；"),
        );

        if (pendingFullAutoWorkflowUploadRef.current === "video") {
          pendingFullAutoWorkflowUploadRef.current = null;
          await beginFullAutoVideoWorkflowCollection({
            source: "upload-document",
            userBubble: uploadScript.title
              ? `视频工作流：${uploadScript.title}`
              : "视频工作流：已提供剧本文本",
            title: uploadScript.title,
            script: uploadScript.script,
          });
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        const workflow = await loadWorkflowActionsModule();
        const ui = createWorkflowShortcutUiBridge({
          activateConversation: () => setMode("active"),
          clearChoiceUi: () => {
            setPopoverOverride(null);
            setSuggested(null);
          },
          commitRuntime: (nextRuntime, projectId) => {
            startTransition(() => {
              setRuntime(nextRuntime);
              syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, projectId);
            });
          },
          getSuggestedQuestion: (snapshot, nextRuntime) =>
            snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
          push,
          resetComposerDraft,
          setPopoverQuestion: setWorkflowPopoverQuestion,
          setStreaming,
          setSuggested,
        });

        const workflowCompletion = await runWorkflowShortcut({
          action: "prepare_video_generation",
          input: {
            projectKind: "video",
            script: uploadScript.script,
            ...(uploadScript.title ? { title: uploadScript.title } : {}),
            abortSignal: executionController.signal,
          },
          runtime: runtimeRef.current,
          deferRecentProjectUpsert: true,
          runAction: (nextAction, nextInput, nextRuntime) =>
            workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
          ui: {
            ...ui,
            pushUser: () => undefined,
          },
          userBubble: "",
          allowAutoFollowup: creationMode === "fast",
          surfaceNextSuggestion: true,
          onError: () => {
            if (qState) {
              setQState(qState);
            }
          },
        });

        if (creationMode === "creative" && workflowCompletion && !workflowCompletion.nextSuggestion) {
          await send(
            buildWorkflowContinuationPrompt({
              action: workflowCompletion.action,
              summary: workflowCompletion.summary,
              projectSnapshot: workflowCompletion.projectSnapshot,
            }),
            undefined,
            { skipUserBubble: true },
          );
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }

        if (applyVideoKickoffFollowupQuestion({
          workflowCompletion,
          setSuggested,
          setPopoverOverride,
          push,
        })) {
          if (activeExecutionAbortRef.current === executionController) {
            activeExecutionAbortRef.current = null;
          }
          return;
        }
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        return;
      }

      const autoResearchPlan = sendOpts?.disableAutoResearch
        ? null
        : buildAutoResearchPlan(cleaned, runtimeRef.current.currentProjectSnapshot);
      const canOfferQuickResearchChoice =
        !runtimeRef.current.currentProjectSnapshot && messagesRef.current.length <= 1;
      const hasTrackKeyword = /市场|风格|卖点|路线|平台|受众|改编|角色|出片/.test(cleaned);
      // 改编研究（改编路线 / 受众适配 / 角色重塑）暂时隐藏，不触发气泡框也不走 LLM overlay
      // 发附件时也不触发，避免附件内容被误判为研究意图
      if (autoResearchPlan && autoResearchPlan.reason !== "adaptation-research" && canOfferQuickResearchChoice && hasTrackKeyword && !sendOpts?.attachments?.length) {
        pendingAutoResearchPlanRef.current = autoResearchPlan;
        pendingAutoResearchSelectionsRef.current = {};
        push(
          "assistant",
          `我已整理出 3 个快捷研究任务：${autoResearchPlan.tasks.map((t) => t.title).join("、")}。现在按顺序确认：${autoResearchPlan.tasks.map((t) => t.title).join(" → ")}。`,
        );
        setPopoverOverride(null);
        setSuggested(buildAutoResearchChoiceQuestion(autoResearchPlan));
        setMode("active");
        return;
      }

      // engine 创建前把 overlay 数据获取并行执行。这里不能裸露 reject，
      // 否则 overlay 还没跑完时浏览器会先触发 unhandledrejection。
      const enginePromise = getEngineResult();

      // 有附件时不触发任何研究任务，避免附件内容被误判为研究意图
      const effectiveLaunchAutoResearchTasks = sendOpts?.attachments?.length || sendOpts?.disableAutoResearch
        ? async () => null
        : launchAutoResearchTasks;
      const overlayResult = await applyAllOverlaysParallel({
        cleaned,
        launchAutoResearchTasks: effectiveLaunchAutoResearchTasks,
        push,
        buildResearchPromptOverlay,
        runtime: runtimeRef.current,
        loadConversationMemoryModule,
        loadProjectStore,
        readProjectSession: readStudioProjectSession,
        flashMaintenanceHint,
        currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot,
        loadLearningOverlayModule: () => import("@/lib/home-agent/agent-learning-overlay"),
      });
      let promptForEngine =
        typeof prepared.promptForEngine === "string"
          ? overlayResult.promptForEngine
          : appendTextOverlayToInput(
              prepared.promptForEngine,
              overlayResult.promptForEngine.startsWith(cleaned)
                ? overlayResult.promptForEngine.slice(cleaned.length).trim()
                : overlayResult.promptForEngine.trim(),
            );
      if (creationMode === "creative") {
        promptForEngine = appendTextOverlayToInput(
          promptForEngine,
          buildLlmConversationOverlay({
            runtime: runtimeRef.current,
            deferredQuestionState,
            automationMode,
          }),
        );
      }
      if (blockedWorkflowMediaAction && currentSnapshot) {
        promptForEngine = appendTextOverlayToInput(
          promptForEngine,
          buildScriptWorkflowBlockedMediaActionReplyPrompt({
            snapshot: currentSnapshot,
            userInput: (shown || cleaned).trim() || cleaned,
            mediaAction: blockedWorkflowMediaAction,
            question: currentWorkflowQuestion,
          }),
        );
      }

      setStreaming(true);
      resetPendingStreamingDelta();
      streamingMessageIdRef.current = null;
      ensureStreamingMessage();
      const workflowArtifactSignatures = createArtifactSignatureMap(
        runtimeRef.current.currentProjectSnapshot,
      );
      let pendingArtifacts: import("@/lib/home-agent/types").ConversationArtifact[] = [];
      let surfacedStructuredQuestion = false;

      try {
        const engineResult = await enginePromise;
        if (!engineResult.ok) {
          throw engineResult.error;
        }
        const activeEngine = engineResult.engine;
        throwIfAborted(executionController.signal);
        const sendSessionId = runtimeRef.current.sessionId;
        for await (const event of activeEngine.submitMessage(promptForEngine)) {
          if (sendRunIdRef.current !== runId) break;
          if (engineRef.current !== activeEngine) break;
          if (runtimeRef.current.sessionId !== sendSessionId) break;

          const changedArtifacts = collectChangedArtifactsFromSdkUserMessage(
            event,
            workflowArtifactSignatures,
          );
          if (changedArtifacts.length) {
            const pendingArtifactMap = new Map(
              pendingArtifacts.map((artifact) => [artifact.id, artifact]),
            );
            changedArtifacts.forEach((artifact) => {
              pendingArtifactMap.set(artifact.id, artifact);
            });
            pendingArtifacts = [...pendingArtifactMap.values()];
          }

          await handleSendEngineEvent({
            event,
            loadStructuredQuestionParser,
            getCurrentProjectSnapshot: () => runtimeRef.current.currentProjectSnapshot,
            textOf,
            push,
            appendStreamingDelta,
            updateStreamingLabel,
            finalizeStreamingMessage,
            setQuestionRequest: (request) => {
              surfacedStructuredQuestion = true;
              const normalizedRequest = normalizeWorkflowBoundAskUserQuestionRequest(
                request,
                runtimeRef.current,
              );
              const workflowQuestion = resolveWorkflowBoundComposerQuestion(
                normalizedRequest,
                runtimeRef.current,
              );
              if (workflowQuestion) {
                setSelectedValues([]);
                resetComposerDraft("");
                setSuggested(null);
                setPopoverOverride(workflowQuestion);
                setQState(null);
                return;
              }
              resetComposerDraft("");
              setQState(createQuestionState(normalizedRequest));
            },
            getFallbackQuestionRequest: () => fallbackOriginalScriptKickoffRequest,
            consumePendingArtifacts: () => {
              if (!pendingArtifacts.length) return undefined;
              const nextArtifacts = [...pendingArtifacts];
              pendingArtifacts = [];
              return nextArtifacts;
            },
          });
        }

        if (
          shouldFallbackToOriginalScriptKickoff &&
          !surfacedStructuredQuestion &&
          !hasReadyOriginalScriptSetup(runtimeRef.current)
        ) {
          if (streamingMessageIdRef.current) {
            finalizeStreamingMessage();
          }
          setQState(
            createQuestionState(
              fallbackOriginalScriptKickoffRequest ?? buildOriginalScriptKickoffRequest(),
            ),
          );
        }

        if (
          startedWithoutProject &&
          !sendOpts?.skipUserBubble &&
          !shouldFallbackToOriginalScriptKickoff &&
          !surfacedStructuredQuestion &&
          !runtimeRef.current.currentProjectSnapshot?.projectId
        ) {
          const snapshot = buildHomepageConversationSnapshotFromMessages({
            currentProjectSnapshot: runtimeRef.current.currentProjectSnapshot,
            messages: messagesRef.current,
            projectId: runtimeRef.current.sessionId,
            userPrompt: (shown || cleaned).trim() || cleaned,
            automationMode,
          });

          if (snapshot) {
            startTransition(() => {
              setRuntime((prev) => {
                if (prev.currentProjectSnapshot?.projectId) return prev;
                const nextRuntime = {
                  ...prev,
                  currentProjectSnapshot: snapshot,
                  recentProjects: mergeRecentProjects(prev.recentProjects, snapshot),
                };
                runtimeRef.current = nextRuntime;
                return nextRuntime;
              });
              syncActiveProjectIdWithSnapshot(snapshot, snapshot.projectId);
            });
          }
        }
      } catch (error) {
        if (sendRunIdRef.current === runId) {
          if (isAbortLikeError(error) || executionController.signal.aborted) {
            resetPendingStreamingDelta();
            return;
          }
          if (isTimeoutLikeError(error)) {
            restoreInterruptedChoiceQuestion?.(null);
          }
          const message = error instanceof Error ? error.message : String(error);
          const isRepeatedConfigError =
            isTextModelConfigErrorMessage(message) &&
            hasRecentAssistantMessage(messagesRef.current, message);
          if (isRepeatedConfigError) {
            discardStreamingMessage();
          } else if (streamingMessageIdRef.current) {
            finalizeStreamingMessage(message);
          } else {
            push("assistant", message);
          }
          if (lastSuggestedRef.current) {
            setSuggested(lastSuggestedRef.current);
          }
        }
      } finally {
        resetPendingStreamingDelta();
        if (activeExecutionAbortRef.current === executionController) {
          activeExecutionAbortRef.current = null;
        }
        if (sendRunIdRef.current === runId) {
          setStreaming(false);
        }
      }
    },
    [
      activeProjectId,
      appendStreamingDelta,
      automationMode,
      beginFullAutoAdaptationCollection,
      beginFullAutoVideoWorkflowCollection,
      buildResearchPromptOverlay,
      createQuestionState,
      engineRef,
      ensureStreamingMessage,
      discardStreamingMessage,
      finalizeStreamingMessage,
      flashMaintenanceHint,
      getEngineResult,
      launchAutoResearchTasks,
      loadConversationMemoryModule,
      loadProjectStore,
      loadStructuredQuestionParser,
      loadWorkflowActionsModule,
      push,
      qState,
      resetComposerDraft,
      runDirectProjectImageGeneration,
      runDirectStoryboardGeneration,
      runDirectVideoGeneration,
      messagesRef,
      runtimeRef,
      creationMode,
      deferredQuestionState,
      resetPendingStreamingDelta,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setStreaming,
      setSuggested,
      setWorkflowPopoverQuestion,
      sendRunIdRef,
      textOf,
      updateStreamingLabel,
      lastSuggestedRef,
      restoreInterruptedChoiceQuestion,
      setPendingAdaptationUpload,
      setPendingVideoUpload,
    ],
  );

  const stopCurrentExecution = useCallback((): StopActiveExecutionResult => {
    const hadActiveExecution =
      Boolean(activeExecutionAbortRef.current) ||
      Boolean(engineRef.current) ||
      pendingAdaptationUploadRef.current ||
      pendingVideoUploadRef.current;
    const cancelledRemoteVideoTaskCount = cancelTrackedRemoteVideoTasks();
    sendRunIdRef.current += 1;
    clearPendingWorkflowUploads();
    activeExecutionAbortRef.current?.abort();
    activeExecutionAbortRef.current = null;
    engineRef.current?.interrupt();
    engineRef.current = null;
    streamingMessageIdRef.current = null;
    resetPendingStreamingDelta();
    setStreaming(false);
    return {
      hadActiveExecution,
      cancelledRemoteVideoTaskCount,
    };
  }, [
    activeExecutionAbortRef,
    clearPendingWorkflowUploads,
    engineRef,
    pendingAdaptationUploadRef,
    pendingVideoUploadRef,
    resetPendingStreamingDelta,
    sendRunIdRef,
    setStreaming,
  ]);

  const reset = useCallback(() => {
    stopCurrentExecution();
    activeFullAutoShortcutRef.current = null;
    clearPendingWorkflowUploads();
    resetPendingStreamingDelta();
    resetHomeAgentConversation({
      activeProjectId,
      qState,
      rejectQuestion: (requestId) => {
        void loadAskUserQuestionModule().then((mod) => {
          mod.rejectAskUserQuestion(requestId, "User reset conversation");
        });
      },
      interruptEngine: () => {
        engineRef.current?.interrupt();
        engineRef.current = null;
      },
      clearSurfacedTasks: () => {
        surfacedTaskIdsRef.current.clear();
        surfacedTaskFollowupIdsRef.current.clear();
      },
      setQState,
      setDeferredQuestionState,
      setPopoverOverride,
      setSuggested,
      setSelectedValues,
      setDeferredSelectedValues,
      setMode,
      setMessages,
      resetComposerDraft,
      setDeferredDraft,
      setCompactedMessageCount,
      setActiveProjectId,
      resetRuntime: () => resetRuntimeState(setRuntime, runtimeRef),
      setMetaReady,
    });
  }, [
    activeProjectId,
    clearPendingWorkflowUploads,
    engineRef,
    loadAskUserQuestionModule,
    qState,
    resetPendingStreamingDelta,
    resetComposerDraft,
    runtimeRef,
    setActiveProjectId,
    setCompactedMessageCount,
    setDeferredDraft,
    setDeferredQuestionState,
    setDeferredSelectedValues,
    setMessages,
    setMetaReady,
    setMode,
    setPopoverOverride,
    setQState,
    setRuntime,
    setSelectedValues,
    setSuggested,
    stopCurrentExecution,
    surfacedTaskFollowupIdsRef,
    surfacedTaskIdsRef,
  ]);

  const answer = useCallback(
    (value: string, label?: string) => {
      answerHomeAgentQuestion({
        qState,
        value,
        label,
        qStepKey,
        setSuggested,
        send,
        push,
        resolveQuestion: async (requestId, output) => {
          try {
            const mod = await loadAskUserQuestionModule();
            return mod.resolveAskUserQuestion(requestId, output);
          } catch {
            return false;
          }
        },
        completeOriginalScriptKickoff: async (completion) => {
          if (automationMode === "full-auto") {
            await beginFullAutoOriginalScriptCollection(completion);
            return;
          }

          const workflow = await loadWorkflowActionsModule();
          const ui = createWorkflowShortcutUiBridge({
            activateConversation: () => setMode("active"),
            clearChoiceUi: () => {
              setPopoverOverride(null);
              setSuggested(null);
            },
            commitRuntime: (nextRuntime, projectId) => {
              startTransition(() => {
                setRuntime(nextRuntime);
                syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, projectId);
              });
            },
            getSuggestedQuestion: (snapshot, nextRuntime) =>
              snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          });

          const workflowCompletion = await runWorkflowShortcut({
            action: "save_setup",
            input: completion.setupInput,
            runtime: runtimeRef.current,
            runAction: (nextAction, nextInput, nextRuntime) =>
              workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
            ui,
            userBubble: completion.userBubble,
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: true,
            deferRecentProjectUpsert: true,
            onError: () => {
              if (qState) {
                setQState(qState);
              }
            },
          });
          if (creationMode === "creative" && workflowCompletion) {
            await send(
              buildWorkflowContinuationPrompt({
                action: workflowCompletion.action,
                summary: workflowCompletion.summary,
                projectSnapshot: workflowCompletion.projectSnapshot,
              }),
              undefined,
              { skipUserBubble: true },
            );
          }
        },
        completeAdaptationWorkflowKickoff: async (completion) => {
          if (completion.source === "upload-document") {
            push("user", completion.userBubble);
            push("assistant", buildAdaptationUploadInstruction());
            setPopoverOverride(null);
            setSuggested(null);
            setInterruptedChoiceQuestion?.(null);
            if (activeFullAutoShortcutRef.current === "adaptation") {
              pendingFullAutoWorkflowUploadRef.current = "adaptation";
            }
            setPendingAdaptationUpload(true);
            return;
          }

          if (activeFullAutoShortcutRef.current === "adaptation") {
            clearPendingWorkflowUploads();
            push("user", completion.userBubble);
            push(
              "assistant",
              "全自动参考改编需要先拿到参考文本。你可以直接把参考剧本粘贴到输入框，或上传参考文档；收到后我会继续采集策略并自动执行到出片。",
            );
            setPopoverOverride(null);
            setSuggested(null);
            setInterruptedChoiceQuestion?.(null);
            pendingFullAutoWorkflowUploadRef.current = "adaptation";
            setPendingAdaptationUpload(true);
            return;
          }

          clearPendingWorkflowUploads();
          await send(buildAdaptationWorkflowStartDialogPrompt(), completion.userBubble);
          setQState(
            createQuestionState(
              buildAdaptationWorkflowUploadSuggestionRequest(),
              "restored",
            ),
          );
        },
        completeVideoWorkflowKickoff: async (completion) => {
          if (completion.source === "upload-document") {
            push("user", completion.userBubble);
            push("assistant", buildVideoWorkflowUploadInstruction());
            setPopoverOverride(null);
            setSuggested(null);
            setInterruptedChoiceQuestion?.(null);
            if (activeFullAutoShortcutRef.current === "video") {
              pendingFullAutoWorkflowUploadRef.current = "video";
            }
            setPendingVideoUpload(true);
            return;
          }

          const workflow = await loadWorkflowActionsModule();
          const currentSourceSnapshot =
            automationMode === "full-auto"
              ? resolvePreferredVideoWorkflowSourceSnapshot()
              : (
                  runtimeRef.current.currentProjectSnapshot?.projectKind &&
                  runtimeRef.current.currentProjectSnapshot.projectKind !== "video"
                )
                ? runtimeRef.current.currentProjectSnapshot
                : null;
          const currentScriptProjectId =
            runtimeRef.current.currentDramaProject?.id ||
            currentSourceSnapshot?.projectId;
          const currentScriptProjectTitle =
            runtimeRef.current.currentDramaProject?.dramaTitle?.trim() ||
            currentSourceSnapshot?.title?.trim();

          if (activeFullAutoShortcutRef.current === "video" && completion.source === "use-current-project") {
            await beginFullAutoVideoWorkflowCollection({
              source: "use-current-project",
              userBubble: completion.userBubble,
              ...(currentScriptProjectTitle ? { title: currentScriptProjectTitle } : {}),
              ...(currentScriptProjectId
                ? {
                    projectId: currentScriptProjectId,
                    sourceProjectId: currentScriptProjectId,
                  }
                : {}),
              ...(runtimeRef.current.currentDramaProject?.exportDocument?.trim()
                ? { script: runtimeRef.current.currentDramaProject.exportDocument.trim() }
                : {}),
            });
            return;
          }

          // 当使用当前剧本项目接入视频工作流时，保持 activeProjectId 不变，
          // 避免在侧边栏产生额外的视频会话条目
          const isUseCurrentProject = completion.source === "use-current-project";
          const ui = createWorkflowShortcutUiBridge({
            activateConversation: () => setMode("active"),
            clearChoiceUi: () => {
              setPopoverOverride(null);
              setSuggested(null);
            },
            commitRuntime: (nextRuntime, projectId) => {
              startTransition(() => {
                setRuntime(nextRuntime);
                const nextSourceProjectId = nextRuntime.currentProjectSnapshot?.sourceProjectId?.trim();
                const isVideoTakingOverCurrentScript =
                  isUseCurrentProject &&
                  nextSourceProjectId &&
                  nextSourceProjectId === currentScriptProjectId;
                if (!isVideoTakingOverCurrentScript) {
                  syncActiveProjectIdWithSnapshot(nextRuntime.currentProjectSnapshot, projectId);
                }
              });
            },
            getSuggestedQuestion: (snapshot, nextRuntime) =>
              snapshot ? recQuestion(snapshot, nextRuntime.currentVideoProject) : null,
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          });

          const workflowCompletion = await runWorkflowShortcut({
            action: "prepare_video_generation",
            input: {
              projectKind: "video",
              ...(completion.source === "use-current-project" && currentScriptProjectId
                ? {
                    projectId: currentScriptProjectId,
                    sourceProjectId: currentScriptProjectId,
                    ...(currentScriptProjectTitle ? { title: currentScriptProjectTitle } : {}),
                  }
                : {}),
            },
            runtime: runtimeRef.current,
            deferRecentProjectUpsert: true,
            runAction: (nextAction, nextInput, nextRuntime) =>
              workflow.runWorkflowAction(nextAction, nextInput, nextRuntime),
            ui,
            userBubble: completion.userBubble,
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: true,
            onError: () => {
              if (qState) {
                setQState(qState);
              }
            },
          });

          if (applyVideoKickoffFollowupQuestion({
            workflowCompletion,
            setSuggested,
            setPopoverOverride,
            push,
          })) {
            return;
          }

          if (creationMode === "creative" && workflowCompletion && !workflowCompletion.nextSuggestion) {
            if (completion.source === "use-current-project") {
              await send(
                buildWorkflowContinuationPrompt({
                  action: workflowCompletion.action,
                  summary: workflowCompletion.summary,
                  projectSnapshot: workflowCompletion.projectSnapshot,
                }),
                undefined,
                { skipUserBubble: true },
              );
              return;
            }

            const scriptTitle = runtimeRef.current.currentProjectSnapshot?.title;
            const prompt = buildVideoWorkflowStartPrompt(completion.source, scriptTitle);
            await send(prompt, undefined, { skipUserBubble: true });
          }
        },
        setQState,
        setSelectedValues,
        resetComposerDraft,
      });
    },
    [      flashMaintenanceHint,
      loadAskUserQuestionModule,
      loadWorkflowActionsModule,
      automationMode,
      beginFullAutoAdaptationCollection,
      beginFullAutoVideoWorkflowCollection,
      clearPendingWorkflowUploads,
      push,
      qState,
      qStepKey,
      resetComposerDraft,
      runtimeRef,
      send,
      creationMode,
      beginFullAutoOriginalScriptCollection,
      setPendingAdaptationUpload,
      setPendingVideoUpload,
      resolvePreferredVideoWorkflowSourceSnapshot,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setSelectedValues,
      setStreaming,
      setSuggested,
    ],
  );

  const handleTemplateLaunch = useCallback(
    (templateId: string, templatePrompt: string, title: string) => {
      const isFullAuto = automationMode === "full-auto";
      const currentProjectSnapshot = runtimeRef.current.currentProjectSnapshot;
      const shouldStartFreshQuickTaskSurface = isFullAuto && Boolean(
        currentProjectSnapshot?.projectId ||
        activeProjectId ||
        messagesRef.current.length,
      );
      const currentVideoSourceSnapshot =
        isFullAuto &&
        templateId === VIDEO_WORKFLOW_TEMPLATE_ID &&
        isBridgeableVideoWorkflowSourceSnapshot(currentProjectSnapshot)
          ? currentProjectSnapshot
          : null;

      if (preferredVideoWorkflowSourceSnapshotRef) {
        if (templateId === VIDEO_WORKFLOW_TEMPLATE_ID) {
          if (currentVideoSourceSnapshot) {
            preferredVideoWorkflowSourceSnapshotRef.current = currentVideoSourceSnapshot;
          }
        } else {
          preferredVideoWorkflowSourceSnapshotRef.current = null;
        }
      }

      if (templateId === ORIGINAL_SCRIPT_TEMPLATE_ID) {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched original script quick task");
          });
        }
        if (shouldStartFreshQuickTaskSurface) {
          reset();
        }
        clearPendingWorkflowUploads();
        activeFullAutoShortcutRef.current = isFullAuto ? "script" : null;
        push("user", title);
        push(
          "assistant",
          automationMode === "full-auto"
            ? "已切换为全自动原创剧本。请先一次性确认立项参数；确认完毕后我会代替用户连续发送指令并自动执行到视频导出。"
            : buildOriginalScriptKickoffIntro(),
        );
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        setQState(createQuestionState(buildOriginalScriptKickoffRequest(), "restored"));
        requestScrollToBottom?.();
        return;
      }

      if (templateId === VIDEO_WORKFLOW_TEMPLATE_ID) {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched video workflow quick task");
          });
        }
        if (shouldStartFreshQuickTaskSurface) {
          reset();
        }
        clearPendingWorkflowUploads();
        activeFullAutoShortcutRef.current = isFullAuto ? "video" : null;
        pendingFullAutoWorkflowUploadRef.current = isFullAuto ? "video" : null;
        push("user", title);
        push(
          "assistant",
          automationMode === "full-auto"
            ? "已切换为全自动视频工作流。先确认脚本来源和后续拆解、出片策略；确认完毕后我会连续执行到最终出片。"
            : buildVideoWorkflowKickoffIntro(),
        );
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        // Homepage quick-task entry should always start from a fresh video-workflow kickoff.
        // Script-to-video bridging is handled by dedicated in-workflow actions instead.
        setQState(createQuestionState(buildVideoWorkflowKickoffRequest(false), "restored"));
        requestScrollToBottom?.();
        return;
      }

      if (templateId === "adaptation") {
        if (qState?.source === "live") {
          void loadAskUserQuestionModule().then((mod) => {
            mod.rejectAskUserQuestion(qState.request.id, "User launched adaptation quick task");
          });
        }
        if (shouldStartFreshQuickTaskSurface) {
          reset();
        }
        clearPendingWorkflowUploads();
        activeFullAutoShortcutRef.current = isFullAuto ? "adaptation" : null;
        pendingFullAutoWorkflowUploadRef.current = isFullAuto ? "adaptation" : null;
        push("user", title);
        push(
          "assistant",
          automationMode === "full-auto"
            ? "已切换为全自动参考改编。先确认参考文本来源和后续改编、视频、导出策略；确认完毕后我会连续执行到最终出片。"
            : buildAdaptationWorkflowKickoffIntro(),
        );
        setPopoverOverride(null);
        setSuggested(null);
        setSelectedValues([]);
        setMode("active");
        resetComposerDraft("");
        setQState(createQuestionState(buildAdaptationWorkflowKickoffRequest(), "restored"));
        requestScrollToBottom?.();
        return;
      }

      activeFullAutoShortcutRef.current = null;
      launchTemplateConversation({
        prompt: templatePrompt,
        title,
        send,
      });
    },
    [
      clearPendingWorkflowUploads,
      createQuestionState,
      loadAskUserQuestionModule,
      loadWorkflowActionsModule,
      push,
      qState,
      resetComposerDraft,
      runtimeRef,
      messagesRef,
      reset,
      send,
      activeProjectId,
      preferredVideoWorkflowSourceSnapshotRef,
      setActiveProjectId,
      setMode,
      setPopoverOverride,
      setQState,
      setRuntime,
      setSelectedValues,
      setSuggested,      automationMode,
      resolvePreferredVideoWorkflowSourceSnapshot,
      requestScrollToBottom,
    ],
  );

  const autoResearchChoiceHandler = useCallback(
    async (value: string, _label: string): Promise<boolean> => {
      if (!value.startsWith("auto-research:")) return false;
      const plan = pendingAutoResearchPlanRef.current;
      if (!plan) return true;
      const stepMatch = value.match(/^auto-research:step:(\d+):pick:(.+)$/);
      if (!stepMatch) return true;
      const [, stepIndexRaw] = stepMatch;
      const stepIndex = Number.parseInt(stepIndexRaw, 10);
      if (!Number.isFinite(stepIndex)) return true;
      const currentTask = plan.tasks[stepIndex];
      if (!currentTask) return true;

      pendingAutoResearchSelectionsRef.current[currentTask.id] = _label;

      const nextStepIndex = stepIndex + 1;
      const nextQuestion = buildAutoResearchStepQuestion(plan, nextStepIndex);
      if (nextQuestion) {
        setSuggested(nextQuestion);
        return true;
      }

      const selectedSummary = plan.tasks.map((task) => {
        const chosen = pendingAutoResearchSelectionsRef.current[task.id] ?? "暂不确定（默认建议）";
        return `${task.title}：${chosen}`;
      });
      const planOverride: AutoResearchPlan = {
        ...plan,
        tasks: plan.tasks.map((task) => {
          const chosen = pendingAutoResearchSelectionsRef.current[task.id] ?? "暂不确定（请先给默认建议）";
          return {
            ...task,
            prompt: `${task.prompt}\n\n用户已完成前置选择：${selectedSummary.join("；")}。\n当前任务重点选择：${task.title}=${chosen}。请严格围绕该选择给结论。`,
          };
        }),
      };
      const taskIdFilter = plan.tasks.map((task) => task.id);
      const selectedTitles = plan.tasks.map((task) => task.title);

      try {
        const launched = await launchHomeAgentAutoResearchTasks({
          prompt: "",
          runtime: runtimeRef.current,
          loadApiConfigModule,
          selectedTextModelKey,
          planOverride,
          taskIdFilter,
          sequential: true,
        });
        if (!launched) {
          push("assistant", "未能启动研究任务，请稍后重试。");
          return true;
        }
        push(
          "assistant",
          `已按顺序启动：${selectedTitles.join("、")}。你可以继续补充要求，结果会自动回流到当前会话。`,
        );
      } catch (error) {
        push("assistant", error instanceof Error ? error.message : "启动研究任务失败。");
      } finally {
        pendingAutoResearchPlanRef.current = null;
        pendingAutoResearchSelectionsRef.current = {};
        setSuggested(null);
        setPopoverOverride(null);
      }

      return true;
    },
    [loadApiConfigModule, push, runtimeRef, selectedTextModelKey, setPopoverOverride, setSuggested],
  );

  return {
    send,
    reset,
    answer,
    handleTemplateLaunch,
    autoResearchChoiceHandler,
    handleFullAutoChoiceSelect,
    handleFullAutoQuestionBack,
    handleFullAutoQuestionReset,
    stopFullAutoExecution,
    isAwaitingWorkflowDocumentUpload,
    stopActiveExecution: stopCurrentExecution,
  };
}
