import { useCallback, useEffect, useRef } from "react";
import type { MessageInput } from "@/lib/agent/types";
import type {
  CreationMode,
  ComposerQuestion,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioRuntimeState,
  WorkflowActionProgressCallback,
  WorkflowActionResult,
} from "@/lib/home-agent/types";
import {
  buildLegacyVideoImageStylePrefs,
  buildVideoImageStyleSummary,
  DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
  getVideoImageGenerationBatchLimit,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
  HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
  normalizeHomeAgentVideoModelKey,
  normalizeVideoGenerationPrefs,
} from "@/lib/home-agent/video-models";
import { normalizeHomeAgentTextModelKey } from "@/lib/home-agent/text-models";
import {
  buildCompactMediaStatusHeading,
  buildMediaContentSummary,
  buildWorkflowMediaTargetLabels,
  localizeMediaSettingValue,
} from "@/lib/home-agent/media-generation-copy";
import { isVideoAssetBundleExportCancelledSummary } from "@/lib/home-agent/video-asset-export";
import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
} from "@/types/project";
import {
  buildWorkflowContinuationPrompt,
  dispatchWorkflowShortcutProgressEvent,
  getWorkflowShortcutProgressLabel,
  runWorkflowShortcut,
  runWorkflowShortcutChain,
} from "@/lib/home-agent/workflow-shortcut-runner";
import type { AutoResearchPlan } from "@/lib/home-agent/auto-research";
import { launchHomeAgentAutoResearchTasks, type HomeAgentApiConfigModule } from "./home-agent-engine-runtime";
import { createWorkflowShortcutUiBridge } from "./home-agent-workflow-ui";
import { buildVideoAnalyzeInterruptQuestion } from "./home-agent-interrupt-recovery";
import {
  buildVideoBridgeRetryQuestion,
  listFailedSegmentVideoLabels,
  listGeneratableSegmentVideoLabels,
  recQuestion,
} from "./home-agent-project-questions";
import {
  buildProjectSuggestionKey,
  resolveSessionProjectIdForSnapshot,
} from "./home-agent-session-utils";
import type { BackgroundResearchGroup } from "./home-agent-task-utils";
import { shouldForceSilentWorkflowShortcut } from "./workflow-shortcut-silence";
import {
  resolveWorkflowImageStartTargets,
  resolveWorkflowSegmentVideoStartTargets,
} from "./workflow-media-events";

type PushMessage = (
  role: HomeAgentMessage["role"],
  content: string,
  artifactIds?: string[],
  attachments?: import("@/lib/agent/chat-attachments").ChatAttachment[],
  artifactSnapshots?: import("@/lib/home-agent/types").ConversationArtifact[],
  messageExtras?: Partial<Pick<HomeAgentMessage, "automationOrigin" | "workflowRefresh">>,
) => void;

type VideoBridgeResearchMode = "all" | "targetPlatform" | "shotStyle" | "outputGoal";

type VideoBridgeResearchProject = Pick<
  NonNullable<StudioRuntimeState["currentVideoProject"]>,
  "artStyle" | "imageGenerationPrefs" | "referenceStyleSummary"
>;

const DEFAULT_BATCH_MEDIA_SUBMISSION_GUARD_DELAY_MS =
  import.meta.env.MODE === "test" ? 0 : 3000;

let dramaWorkflowServiceModulePromise:
  | Promise<typeof import("@/lib/home-agent/services/drama-workflow-service")>
  | null = null;
let videoWorkflowServiceModulePromise:
  | Promise<typeof import("@/lib/home-agent/services/video-workflow-service")>
  | null = null;

function abortOutlineGenerationLazy(): void {
  if (!dramaWorkflowServiceModulePromise) {
    dramaWorkflowServiceModulePromise = import("@/lib/home-agent/services/drama-workflow-service");
  }
  void dramaWorkflowServiceModulePromise
    .then(({ abortOutlineGeneration }) => {
      abortOutlineGeneration();
    })
    .catch(() => undefined);
}

function abortVideoWorkflowGenerationLazy(): void {
  if (!videoWorkflowServiceModulePromise) {
    videoWorkflowServiceModulePromise = import("@/lib/home-agent/services/video-workflow-service");
  }
  void videoWorkflowServiceModulePromise
    .then(({ abortVideoWorkflowGeneration }) => {
      abortVideoWorkflowGeneration();
    })
    .catch(() => undefined);
}

type BatchMediaShortcutSubmissionGuard = {
  delayMs: number;
  startMessage: string;
  progressLabel: string | null;
};

function buildBatchMediaShortcutSubmissionGuard(
  action: string,
  delayMs: number,
  kind: "image" | "video",
): BatchMediaShortcutSubmissionGuard {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return {
    delayMs,
    startMessage:
      kind === "image"
        ? `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生图请求；这段时间内仍可撤回。`
        : `已进入 ${seconds} 秒防误触保护，倒计时结束后才会提交生视频请求；这段时间内仍可撤回。`,
    progressLabel: getWorkflowShortcutProgressLabel(action),
  };
}

function resolveBatchMediaShortcutSubmissionGuard(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  delayMs: number;
  stepCount?: number;
}): BatchMediaShortcutSubmissionGuard | null {
  const { action, delayMs } = params;
  if (delayMs <= 0) return null;

  if (
    action === "generate_project_image" ||
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames"
  ) {
    return buildBatchMediaShortcutSubmissionGuard(action, delayMs, "image");
  }

  if (action === "generate_video_assets") {
    return buildBatchMediaShortcutSubmissionGuard(action, delayMs, "video");
  }

  if (action === "generate_segment_video") {
    return buildBatchMediaShortcutSubmissionGuard(action, delayMs, "video");
  }

  return null;
}

function buildGuardedWorkflowStartProgressText(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  userBubble: string;
  submissionGuard: BatchMediaShortcutSubmissionGuard | null;
}): string | null {
  const { action, input, runtime, userBubble, submissionGuard } = params;
  if (!submissionGuard) return null;

  const startSummary = buildWorkflowMediaStartSummary({
    action,
    input,
    runtime,
    promptText: userBubble,
  });
  return [startSummary, submissionGuard.startMessage].filter(Boolean).join("\n\n");
}

function shouldReopenVideoWorkflowPopover(
  completion: {
    projectSnapshot: ConversationProjectSnapshot | null;
    nextSuggestion: ComposerQuestion | null;
  } | null,
): completion is {
  projectSnapshot: ConversationProjectSnapshot;
  nextSuggestion: ComposerQuestion;
} {
  return Boolean(
    completion?.projectSnapshot?.projectKind === "video" &&
      completion.nextSuggestion,
  );
}

function hasRunningVideoGenerationTasks(
  videoProject: StudioRuntimeState["currentVideoProject"] | null | undefined,
): boolean {
  return Boolean(
    videoProject?.scenes?.some((scene) => {
      const status = String(scene.videoStatus || "").toLowerCase();
      return Boolean(scene.videoTaskId) && (status === "queued" || status === "processing");
    }),
  );
}

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|超时/i.test(message);
}

function buildWorkflowMediaStartSummary(params: {
  action: string;
  input: Record<string, unknown>;
  runtime?: StudioRuntimeState;
  promptText?: string;
}): string | null {
  const { action, input, runtime, promptText } = params;

  if (
    action === "generate_project_image" ||
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames"
  ) {
    const { count, targetIds } = resolveWorkflowImageStartTargets({ action, input, runtime });
    const targetLabel =
      action === "generate_storyboard_frames"
        ? "分镜图"
        : action === "generate_video_reference_assets"
          ? "视频参考素材"
          : "图片";
    const contentSummary = buildMediaContentSummary({
      action,
      promptText: String(input.imagePrompt || input.prompt || promptText || ""),
      imageKind: String(input.imageKind || ""),
      runtime,
      targetIds,
    });
    return [
      buildCompactMediaStatusHeading({
        phase: "start",
        fallbackLabel: targetLabel,
        contentSummary,
      }),
      [
        `数量 ${count}`,
        contentSummary ? `内容 ${contentSummary}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "generate_video_assets") {
    const count = Array.isArray(input.targetIds) && input.targetIds.length ? input.targetIds.length : 1;
    const model =
      String(input.selectedVideoModelKey || input.videoModelKey || "").trim() ||
      (typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "modelKey" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.modelKey || "").trim()
        : "");
    const resolution =
      typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "resolution" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.resolution || "").trim()
        : "";
    const mode =
      typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "mode" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.mode || "").trim()
        : "";
    const contentSummary = buildMediaContentSummary({
      action,
      promptText: String(input.prompt || input.userBubble || promptText || ""),
      runtime,
      targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(String) : undefined,
    });
    return [
      "开始生成视频。",
      [
        `数量 ${count}`,
        contentSummary ? `内容 ${contentSummary}` : "",
        mode ? `模式 ${localizeMediaSettingValue(mode, "mode")}` : "",
        model ? `模型 ${model}` : "",
        resolution ? `分辨率 ${localizeMediaSettingValue(resolution, "resolution")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "generate_segment_video") {
    const { count, segmentLabels, targetLabels } = resolveWorkflowSegmentVideoStartTargets({
      input,
      runtime,
    });
    const contentSummary = targetLabels?.slice(0, 3).join(" 路 ");
    const model =
      String(input.selectedVideoModelKey || input.videoModelKey || "").trim() ||
      (typeof input.videoGenerationPrefs === "object" &&
      input.videoGenerationPrefs &&
      "modelKey" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.modelKey || "").trim()
        : "");
    return [
      buildCompactMediaStatusHeading({
        phase: "start",
        fallbackLabel: "片段视频",
        contentSummary,
      }),
      [
        `数量 ${count}`,
        contentSummary ? `内容 ${contentSummary}` : "",
        model ? `模型 ${model}` : "",
        segmentLabels?.length ? `片段 ${segmentLabels.join(" / ")}` : "",
      ]
        .filter(Boolean)
        .join(" 路 "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (action === "generate_segment_video") {
    const segmentLabel = typeof input.segmentLabel === "string" ? input.segmentLabel : "";
    const model =
      String(input.selectedVideoModelKey || input.videoModelKey || "").trim() ||
      (typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "modelKey" in input.videoGenerationPrefs
        ? String(input.videoGenerationPrefs.modelKey || "").trim()
        : "");
    return [
      `开始生成片段${segmentLabel}视频。`,
      model ? `模型 ${model}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return null;
}

function buildWorkflowMediaDoneSummary(params: {
  action: string;
  imageUrls?: string[];
  videoUrls?: string[];
  imageDetail?: {
    modelFamily?: string;
    resolution?: string;
    aspectRatio?: string;
    contentSummary?: string;
  };
  videoDetail?: {
    model?: string;
    resolution?: string;
    mode?: string;
    provider?: string;
    contentSummary?: string;
  };
}): string | null {
  const { action, imageUrls, videoUrls, imageDetail, videoDetail } = params;

  if (imageUrls?.length) {
    const targetLabel =
      action === "generate_storyboard_frames"
        ? "分镜图"
        : action === "generate_video_reference_assets"
          ? "视频参考素材"
          : "图片";
    return [
      buildCompactMediaStatusHeading({
        phase: "done",
        fallbackLabel: targetLabel,
        contentSummary: imageDetail?.contentSummary,
      }),
      [
        `共 ${imageUrls.length} 张`,
        imageDetail?.contentSummary ? `内容 ${imageDetail.contentSummary}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (videoUrls?.length) {
    return [
      "视频已生成。",
      [
        `共 ${videoUrls.length} 条`,
        videoDetail?.contentSummary ? `内容 ${videoDetail.contentSummary}` : "",
        videoDetail?.mode ? `模式 ${localizeMediaSettingValue(videoDetail.mode, "mode")}` : "",
        videoDetail?.model ? `模型 ${videoDetail.model}` : "",
        videoDetail?.resolution ? `分辨率 ${localizeMediaSettingValue(videoDetail.resolution, "resolution")}` : "",
        videoDetail?.provider ? `通道 ${localizeMediaSettingValue(videoDetail.provider, "provider")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]
      .filter(Boolean)
      .join("\n");
  }

  return null;
}

function getVideoBridgeResearchAction(mode: VideoBridgeResearchMode): string {
  switch (mode) {
    case "targetPlatform":
      return "video:bridge:prefix:target-platform";
    case "shotStyle":
      return "video:bridge:prefix:shot-style";
    case "outputGoal":
      return "video:bridge:prefix:output-goal";
    default:
      return "video:bridge:platform";
  }
}

export function buildVideoBridgeResearchPlan(
  snapshot: ConversationProjectSnapshot | null,
  mode: VideoBridgeResearchMode,
  project?: VideoBridgeResearchProject | null,
): AutoResearchPlan {
  const resolvedStyleSummary = project
    ? buildVideoImageStyleSummary({
        ...(project.artStyle ? buildLegacyVideoImageStylePrefs(project.artStyle) : {}),
        ...(project.imageGenerationPrefs ?? {}),
      })
    : "";
  const referenceStyleSummary =
    typeof project?.referenceStyleSummary === "string" && project.referenceStyleSummary.trim()
      ? project.referenceStyleSummary.trim()
      : "";
  const visualContext = [
    resolvedStyleSummary ? `当前已经确认的画面风格偏好是 ${resolvedStyleSummary}` : null,
    referenceStyleSummary ? `参考图风格摘要：${referenceStyleSummary}` : null,
  ]
    .filter(Boolean)
    .join("。");
  const projectContext = snapshot
    ? `当前视频项目《${snapshot.title}》，当前阶段是 ${snapshot.derivedStage}，当前目标是 ${snapshot.currentObjective || snapshot.agentSummary}。`
    : "当前正在补齐一个视频项目的前置桥接参数。";

  const effectiveProjectContext = visualContext ? `${projectContext}${visualContext}銆?` : projectContext;
  void effectiveProjectContext;

  const specs: Record<Exclude<VideoBridgeResearchMode, "all">, { id: string; title: string; prompt: string }> = {
    targetPlatform: {
      id: "target-platform",
      title: "平台偏好",
      prompt:
        `${projectContext}请只补齐目标平台偏好，并给出更完整的发布建议。` +
        " 输出时至少包含：1. 最优发布平台；2. 目标受众与推荐原因；3. 首页包装与节奏提醒；4. 不建议优先投放的平台或限制。",
    },
    shotStyle: {
      id: "shot-style",
      title: "镜头风格",
      prompt:
        `${projectContext}请只补齐镜头风格，并给出可直接执行的镜头语言建议。` +
        " 输出时至少包含：1. 核心镜头风格；2. 取景/景别建议；3. 运镜节奏建议；4. 色调或氛围关键词；5. 需要避开的镜头问题。",
    },
    outputGoal: {
      id: "output-goal",
      title: "出片目标",
      prompt:
        `${projectContext}请只补齐出片目标，并明确后续剧本拆解要服务的产出方向。` +
        " 输出时至少包含：1. 最终出片形态；2. 本轮拆解的核心目标；3. 优先验证的内容；4. 成片侧重点；5. 后续分镜阶段应围绕什么来推进。",
    },
  };

  const tasks =
    mode === "all"
      ? [specs.targetPlatform, specs.shotStyle, specs.outputGoal]
      : [specs[mode]];

  return {
    reason: "video-bridge-platform",
    kickoff:
      mode === "all"
        ? "我先在后台补齐平台偏好、镜头风格和出片目标，完成后会自动写回并继续推进到剧本拆解。"
        : `我先在后台补齐${tasks[0]?.title ?? "前置字段"}，完成后会自动写回当前项目。`,
    tasks,
  };
}

function buildVideoBridgeResearchPromptPrefix(
  project: VideoBridgeResearchProject | null | undefined,
): string {
  if (!project) return "";

  const styleSummary = buildVideoImageStyleSummary({
    ...(project.artStyle ? buildLegacyVideoImageStylePrefs(project.artStyle) : {}),
    ...(project.imageGenerationPrefs ?? {}),
  });
  const referenceStyleSummary =
    typeof project.referenceStyleSummary === "string" && project.referenceStyleSummary.trim()
      ? project.referenceStyleSummary.trim()
      : "";

  const lines = [
    styleSummary ? `当前已经确认的画面风格偏好：${styleSummary}` : "",
    referenceStyleSummary ? `参考图风格摘要：${referenceStyleSummary}` : "",
    "请在补平台、镜头风格与出片目标时显式结合以上视觉线索，不要忽略已经确认的参考图风格。",
  ].filter(Boolean);

  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

function dispatchWorkflowMediaEvents(params: {
  imageUrls?: string[];
  videoUrls?: string[];
  mediaEventId?: string;
  actionLabel?: string;
  imageDetail?: {
    action?: string;
    count?: number;
    modelFamily?: string;
    resolution?: string;
    aspectRatio?: string;
    contentSummary?: string;
    imageLabels?: string[];
  };
  videoDetail?: {
    action?: string;
    count?: number;
    model?: string;
    resolution?: string;
    provider?: string;
    mode?: string;
    contentSummary?: string;
  };
}) {
  if (typeof window === "undefined") return;

  const { imageUrls, videoUrls, mediaEventId, actionLabel, imageDetail, videoDetail } = params;
  // 有图片任务时始终 dispatch，即使全部失败（imageUrls 为空），让 handleImageGenerated 负责 finalize
  if (imageDetail?.action && (
    imageDetail.action === "generate_project_image" ||
    imageDetail.action === "generate_video_reference_assets" ||
    imageDetail.action === "generate_storyboard_frames"
  ) || imageUrls?.length) {
    window.dispatchEvent(
      new CustomEvent("agent:image-generated", {
        detail: {
          imageUrls,
          ...(mediaEventId ? { mediaEventId } : {}),
          ...(actionLabel ? { actionLabel } : {}),
          ...(imageDetail ? imageDetail : {}),
        },
      }),
    );
  }

  if (videoUrls?.length) {
    window.dispatchEvent(
      new CustomEvent("agent:video-generated", {
        detail: {
          videoUrls,
          ...(mediaEventId ? { mediaEventId } : {}),
          ...(videoDetail ? videoDetail : {}),
        },
      }),
    );
  }
}

function dispatchWorkflowMediaStartEvent(params: {
  action: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  promptText?: string;
  mediaEventId?: string;
}) {
  if (typeof window === "undefined") return;

  const { action, input, runtime, promptText, mediaEventId } = params;
  const targetCount = Array.isArray(input.targetIds) ? input.targetIds.length : 0;

  if (
    action === "generate_project_image" ||
    action === "generate_video_reference_assets" ||
    action === "generate_storyboard_frames"
  ) {
    const { count, targetIds } = resolveWorkflowImageStartTargets({ action, input, runtime });

    window.dispatchEvent(
      new CustomEvent("agent:image-generating-start", {
        detail: {
          count,
          ...(mediaEventId ? { mediaEventId } : {}),
          action,
          modelFamily: String(input.selectedImageModelFamily || input.modelFamily || ""),
          resolution: typeof input.resolution === "string"
            ? input.resolution
            : typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs && "resolution" in input.imageGenerationPrefs
              ? String(input.imageGenerationPrefs.resolution || "")
              : "",
          aspectRatio: typeof input.aspectRatio === "string"
            ? input.aspectRatio
            : typeof input.imageGenerationPrefs === "object" && input.imageGenerationPrefs && "aspectRatio" in input.imageGenerationPrefs
              ? String(input.imageGenerationPrefs.aspectRatio || "")
              : "",
          contentSummary: buildMediaContentSummary({
            action,
            promptText: String(input.imagePrompt || input.prompt || promptText || ""),
            imageKind: String(input.imageKind || ""),
            runtime,
            targetIds,
          }),
          targetLabels: buildWorkflowMediaTargetLabels({
            action,
            runtime,
            targetIds,
          }),
        },
      }),
    );
    return;
  }

  if (action === "generate_video_assets") {
    const fallbackCount = runtime.currentVideoProject?.scenes.length ?? 1;
    const count = Math.max(1, targetCount || fallbackCount || 1);
    window.dispatchEvent(
      new CustomEvent("agent:video-generating-start", {
        detail: {
          count,
          sceneCount: count,
          ...(mediaEventId ? { mediaEventId } : {}),
          action,
          model: typeof input.selectedVideoModelKey === "string"
            ? input.selectedVideoModelKey
            : typeof input.videoModelKey === "string"
              ? input.videoModelKey
              : typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "modelKey" in input.videoGenerationPrefs
                ? String(input.videoGenerationPrefs.modelKey || "")
                : "",
          resolution: typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "resolution" in input.videoGenerationPrefs
            ? String(input.videoGenerationPrefs.resolution || "")
            : "",
          mode: typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "mode" in input.videoGenerationPrefs
            ? String(input.videoGenerationPrefs.mode || "")
            : "",
          provider: typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "provider" in input.videoGenerationPrefs
            ? String((input.videoGenerationPrefs as { provider?: string }).provider || "")
            : "",
          contentSummary: buildMediaContentSummary({
            action,
            promptText: String(input.prompt || promptText || ""),
            runtime,
            targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(String) : undefined,
          }),
          targetLabels: buildWorkflowMediaTargetLabels({
            action,
            runtime,
            targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(String) : undefined,
          }),
        },
      }),
    );
  }

  if (action === "generate_segment_video") {
    const { count, segmentLabels, targetLabels } = resolveWorkflowSegmentVideoStartTargets({
      input,
      runtime,
    });
    const contentSummary = targetLabels?.slice(0, 3).join(" 路 ");
    window.dispatchEvent(
      new CustomEvent("agent:video-generating-start", {
        detail: {
          count,
          sceneCount: count,
          ...(mediaEventId ? { mediaEventId } : {}),
          action,
          model: typeof input.selectedVideoModelKey === "string"
            ? input.selectedVideoModelKey
            : typeof input.videoGenerationPrefs === "object" &&
                input.videoGenerationPrefs &&
                "modelKey" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.modelKey || "")
              : "",
          resolution:
            typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "resolution" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.resolution || "")
              : "",
          mode:
            typeof input.videoGenerationPrefs === "object" &&
            input.videoGenerationPrefs &&
            "mode" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.mode || "")
              : "",
          contentSummary,
          targetLabels,
        },
      }),
    );
    return;
  }

  if (action === "generate_segment_video") {
    const segmentLabel = typeof input.segmentLabel === "string" ? input.segmentLabel : "";
    window.dispatchEvent(
      new CustomEvent("agent:video-generating-start", {
        detail: {
          count: 1,
          sceneCount: 1,
          ...(mediaEventId ? { mediaEventId } : {}),
          action,
          model: typeof input.selectedVideoModelKey === "string"
            ? input.selectedVideoModelKey
            : typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "modelKey" in input.videoGenerationPrefs
              ? String(input.videoGenerationPrefs.modelKey || "")
              : "",
          resolution: typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "resolution" in input.videoGenerationPrefs
            ? String(input.videoGenerationPrefs.resolution || "")
            : "",
          mode: typeof input.videoGenerationPrefs === "object" && input.videoGenerationPrefs && "mode" in input.videoGenerationPrefs
            ? String(input.videoGenerationPrefs.mode || "")
            : "",
          contentSummary: segmentLabel ? `片段${segmentLabel}` : undefined,
          targetLabels: segmentLabel ? [`片段${segmentLabel}`] : undefined,
        },
      }),
    );
  }
}

function dispatchWorkflowMediaCancelledEvent() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("agent:image-generating-cancelled"));
  window.dispatchEvent(new CustomEvent("agent:video-generating-cancelled"));
}

export function useHomeAgentWorkflowShortcuts(params: {
  runtimeRef: React.MutableRefObject<StudioRuntimeState>;
  backgroundResearchGroupsRef?: React.MutableRefObject<BackgroundResearchGroup[]>;
  surfacedProjectSuggestionKeysRef: React.MutableRefObject<Set<string>>;
  dismissedProjectSuggestionKeysRef?: React.MutableRefObject<Set<string>>;
  loadApiConfigModule?: () => Promise<HomeAgentApiConfigModule>;
  loadWorkflowActionsModule: () => Promise<{
    runWorkflowAction: (
      action: string,
      input: Record<string, unknown>,
      runtime: StudioRuntimeState,
      onProgress?: WorkflowActionProgressCallback,
    ) => Promise<unknown>;
  }>;
  push: PushMessage;
  setPopoverOverride: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setSuggested: React.Dispatch<React.SetStateAction<ComposerQuestion | null>>;
  setMode: React.Dispatch<React.SetStateAction<"idle" | "active" | "recovering" | "maintenance-review">>;
  resetComposerDraft: (value?: string) => void;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntime: React.Dispatch<React.SetStateAction<StudioRuntimeState>>;
  setActiveProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  activeProjectId?: string;
  setActiveWorkflowAction: React.Dispatch<React.SetStateAction<string | null>>;
  send?: (
    value: MessageInput,
    shown?: string,
    opts?: { skipUserBubble?: boolean; disableAutoResearch?: boolean },
  ) => Promise<void>;
  creationMode?: CreationMode;
  selectedTextModelKey?: string;
  selectedImageModelFamily?: VideoImageModelFamilyKey;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  selectedVideoModelKey?: VideoGenerationModelKey;
  videoGenerationPrefs?: VideoGenerationPrefs;
  restoreInterruptedChoiceQuestion?: (question: ComposerQuestion | null) => boolean;
  batchMediaSubmissionGuardDelayMs?: number;
}) {
  const fallbackBackgroundResearchGroupsRef = useRef<BackgroundResearchGroup[]>([]);
  const {
    runtimeRef,
    backgroundResearchGroupsRef = fallbackBackgroundResearchGroupsRef,
    surfacedProjectSuggestionKeysRef,
    dismissedProjectSuggestionKeysRef,
    loadApiConfigModule = async () => ({} as HomeAgentApiConfigModule),
    loadWorkflowActionsModule,
    push,
    setPopoverOverride,
    setSuggested,
    setMode,
    resetComposerDraft,
    setStreaming,
    setRuntime,
    setActiveProjectId,
    activeProjectId,
    setActiveWorkflowAction,
    send,
    creationMode = "fast",
    selectedTextModelKey = "",
    selectedImageModelFamily = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey,
    imageGenerationPrefs = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    selectedVideoModelKey = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey,
    videoGenerationPrefs = DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    restoreInterruptedChoiceQuestion,
    batchMediaSubmissionGuardDelayMs = DEFAULT_BATCH_MEDIA_SUBMISSION_GUARD_DELAY_MS,
  } = params;
  const workflowShortcutInFlightRef = useRef(false);
  const wasInterruptedRef = useRef(false);
  const interruptRestoreQuestionRef = useRef<ComposerQuestion | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  const decorateWorkflowInput = useCallback(
    (input: Record<string, unknown>, abortSignal?: AbortSignal) => {
      const normalizedImagePrefs = normalizeVideoImageGenerationPrefs({
        ...imageGenerationPrefs,
        familyKey: selectedImageModelFamily,
      });
      const normalizedVideoPrefs = normalizeVideoGenerationPrefs({
        ...videoGenerationPrefs,
        modelKey: normalizeHomeAgentVideoModelKey(selectedVideoModelKey),
      });

      return {
        ...input,
        textModel: normalizeHomeAgentTextModelKey(selectedTextModelKey),
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

  const rememberActiveSuggestion = useCallback(() => {
    const snapshot = runtimeRef.current.currentProjectSnapshot;
    if (!snapshot) return;
    const activeSuggestion = recQuestion(snapshot, runtimeRef.current.currentVideoProject);
    const suggestionKey = buildProjectSuggestionKey(snapshot, activeSuggestion);
    if (suggestionKey) {
      surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
    }
  }, [runtimeRef, surfacedProjectSuggestionKeysRef]);

  const clearChoiceUi = useCallback(() => {
    rememberActiveSuggestion();
    setPopoverOverride(null);
    setSuggested(null);
  }, [rememberActiveSuggestion, setPopoverOverride, setSuggested]);

  const setWorkflowPopoverQuestion = useCallback(
    (question: ComposerQuestion | null, snapshot?: ConversationProjectSnapshot | null) => {
      if (question && hasRunningVideoGenerationTasks(runtimeRef.current.currentVideoProject)) {
        return;
      }
      const suggestionKey = buildProjectSuggestionKey(
        snapshot ?? runtimeRef.current.currentProjectSnapshot,
        question,
      );
      if (suggestionKey) {
        dismissedProjectSuggestionKeysRef?.current.delete(suggestionKey);
        surfacedProjectSuggestionKeysRef.current.add(suggestionKey);
      }
      setPopoverOverride(question);
    },
    [dismissedProjectSuggestionKeysRef, runtimeRef, setPopoverOverride, surfacedProjectSuggestionKeysRef],
  );

  const activateConversation = useCallback(() => {
    setMode("active");
  }, [setMode]);

  const surfaceWorkflowShortcutStartUi = useCallback(
    (
      action: string,
      userBubble: string,
      options?: {
        skipUserBubble?: boolean;
        skipProgress?: boolean;
        progressText?: string | null;
      },
    ) => {
      if (!options?.skipUserBubble && userBubble.trim()) {
        push("user", userBubble);
      }
      if (!options?.skipProgress) {
        const shortcutProgressLabel = options?.progressText ?? getWorkflowShortcutProgressLabel(action);
        if (shortcutProgressLabel) {
          dispatchWorkflowShortcutProgressEvent(action, "start", shortcutProgressLabel);
          return true;
        }
      }
      return false;
    },
    [push],
  );

  const commitWorkflowRuntime = useCallback(
    (nextRuntime: StudioRuntimeState, nextProjectId?: string) => {
      runtimeRef.current = nextRuntime;
      setRuntime(nextRuntime);
      const nextSessionProjectId = resolveSessionProjectIdForSnapshot({
        currentSessionProjectId: activeProjectIdRef.current,
        snapshot: nextRuntime.currentProjectSnapshot,
        fallbackProjectId: nextProjectId,
      });
      if (nextSessionProjectId) {
        setActiveProjectId(nextSessionProjectId);
      }
    },
    [runtimeRef, setActiveProjectId, setRuntime],
  );

  const getSuggestedQuestion = useCallback(
    (snapshot: ConversationProjectSnapshot | null, runtime: StudioRuntimeState) =>
      snapshot ? recQuestion(snapshot, runtime.currentVideoProject) : null,
    [],
  );

  const isWorkflowOriginActive = useCallback(
    (originProjectId?: string | null) => {
      if (!originProjectId) return true;
      const currentProjectId =
        runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectIdRef.current;
      return currentProjectId === originProjectId;
    },
    [runtimeRef],
  );

  const scopeWorkflowUiToOriginProject = useCallback(
    (
      ui: ReturnType<typeof createWorkflowShortcutUiBridge>,
      originProjectId?: string | null,
    ): ReturnType<typeof createWorkflowShortcutUiBridge> => {
      const canMutateActiveConversation = () =>
        !wasInterruptedRef.current && isWorkflowOriginActive(originProjectId);

      return {
        ...ui,
        activateConversation: () => {
          if (canMutateActiveConversation()) ui.activateConversation();
        },
        clearChoiceUi: () => {
          if (canMutateActiveConversation()) ui.clearChoiceUi();
        },
        commitRuntime: (nextRuntime, nextProjectId) => {
          if (canMutateActiveConversation()) ui.commitRuntime(nextRuntime, nextProjectId);
        },
        pushAssistant: (content, artifactIds, artifactSnapshots) => {
          if (canMutateActiveConversation()) ui.pushAssistant(content, artifactIds, artifactSnapshots);
        },
        pushUser: (content) => {
          if (canMutateActiveConversation()) ui.pushUser(content);
        },
        resetComposerDraft: () => {
          if (canMutateActiveConversation()) ui.resetComposerDraft();
        },
        setPopoverQuestion: (question, snapshot) => {
          if (canMutateActiveConversation()) ui.setPopoverQuestion(question, snapshot);
        },
        setStreaming: (streaming) => {
          if (canMutateActiveConversation()) ui.setStreaming(streaming);
        },
        setSuggested: (question) => {
          if (canMutateActiveConversation()) ui.setSuggested(question);
        },
      };
    },
    [isWorkflowOriginActive],
  );

  const restoreCurrentInterruptQuestion = useCallback(() => {
    const storedRestoreQuestion = interruptRestoreQuestionRef.current;
    let restoreQuestion = storedRestoreQuestion;
    if (
      storedRestoreQuestion &&
      (storedRestoreQuestion.answerKey === "video-analyze-resume" ||
        storedRestoreQuestion.answerKey === "video-analyze-retry-missing")
    ) {
      restoreQuestion =
        buildVideoAnalyzeInterruptQuestion(
          runtimeRef.current.currentProjectSnapshot,
          runtimeRef.current.currentVideoProject,
        ) ?? storedRestoreQuestion;
    }
    if (!restoreQuestion) return false;
    if (restoreInterruptedChoiceQuestion) {
      return restoreInterruptedChoiceQuestion(restoreQuestion);
    }
    setMode("active");
    setPopoverOverride(restoreQuestion);
    setSuggested(null);
    resetComposerDraft("");
    return true;
  }, [
    resetComposerDraft,
    restoreInterruptedChoiceQuestion,
    runtimeRef,
    setMode,
    setPopoverOverride,
    setSuggested,
  ]);

  const continueWorkflowInLlmMode = useCallback(
    async (params: {
      action: string;
      summary: string;
      runtime: StudioRuntimeState;
      projectSnapshot: ConversationProjectSnapshot | null;
    }) => {
      if (creationMode !== "creative") return;
      if (!send) return;

      await send(
        buildWorkflowContinuationPrompt({
          action: params.action,
          summary: params.summary,
          projectSnapshot: params.projectSnapshot ?? params.runtime.currentProjectSnapshot,
        }),
        undefined,
        { skipUserBubble: true },
      );
    },
    [creationMode, send],
  );

  const runBackgroundVideoBridgeResearch = useCallback(
    async (userBubble: string, mode: VideoBridgeResearchMode = "all") => {
      if (workflowShortcutInFlightRef.current) {
        push("assistant", "当前已有一步前置补齐在执行，请等待当前流程完成后再继续。");
        return;
      }

      workflowShortcutInFlightRef.current = true;
      wasInterruptedRef.current = false;
      interruptRestoreQuestionRef.current = null;
      clearChoiceUi();
      activateConversation();
      resetComposerDraft();
      push("user", userBubble);
      setActiveWorkflowAction(getVideoBridgeResearchAction(mode));
      setStreaming(true);

      let launchedGroup = false;
      try {
        const snapshot = runtimeRef.current.currentProjectSnapshot;
        const planOverride = buildVideoBridgeResearchPlan(snapshot, mode);
        const taskPromptPrefix = buildVideoBridgeResearchPromptPrefix(
          runtimeRef.current.currentVideoProject,
        );
        const launched = await launchHomeAgentAutoResearchTasks({
          prompt: planOverride.kickoff,
          runtime: runtimeRef.current,
          loadApiConfigModule,
          selectedTextModelKey,
          planOverride,
          taskPromptPrefix,
        });

        if (!launched?.taskIds.length) {
          push("assistant", "当前没能启动后台整理，请先检查文本模型配置后再试。");
          setSuggested(null);
          setPopoverOverride(buildVideoBridgeRetryQuestion(snapshot));
          return;
        }

        launchedGroup = true;
        let settled = false;
        const finishGroup = () => {
          if (settled) return;
          settled = true;
          workflowShortcutInFlightRef.current = false;
          setActiveWorkflowAction(null);
          setStreaming(false);
        };

        backgroundResearchGroupsRef.current = [
          ...backgroundResearchGroupsRef.current.filter(
            (group) =>
              !(
                group.kind === "video-bridge-platform" &&
                group.projectId === snapshot?.projectId
              ),
          ),
          {
            id: crypto.randomUUID(),
            kind: "video-bridge-platform",
            projectId: snapshot?.projectId,
            taskIds: launched.taskIds,
            status: "pending",
            onFinish: finishGroup,
          },
        ];
      } catch (error) {
        push("assistant", error instanceof Error ? error.message : "后台整理启动失败，请稍后重试。");
        setSuggested(null);
        setPopoverOverride(buildVideoBridgeRetryQuestion(runtimeRef.current.currentProjectSnapshot));
      } finally {
        if (!launchedGroup) {
          workflowShortcutInFlightRef.current = false;
          setActiveWorkflowAction(null);
          setStreaming(false);
        }
      }
    },
    [
      activateConversation,
      backgroundResearchGroupsRef,
      clearChoiceUi,
      loadApiConfigModule,
      push,
      resetComposerDraft,
      runtimeRef,
      selectedTextModelKey,
      setActiveWorkflowAction,
      setPopoverOverride,
      setSuggested,
      setStreaming,
    ],
  );

  const runWorkflowActionShortcut = useCallback(
    (
      action: string,
      input: Record<string, unknown>,
      userBubble: string,
      options?: {
        restoreQuestionOnInterrupt?: ComposerQuestion | null;
        restoreQuestionOnCancel?: ComposerQuestion | null;
        restoreQuestionOnError?: ComposerQuestion | null;
        restoreQuestionAfterRun?: ComposerQuestion | null;
        skipUserBubble?: boolean;
        skipAssistantSummary?: boolean;
      },
    ) => {
      if (workflowShortcutInFlightRef.current) {
        push("assistant", "当前已有步骤在执行，请等待当前流程完成后再继续。");
        return;
      }
      workflowShortcutInFlightRef.current = true;
      wasInterruptedRef.current = false;
      interruptRestoreQuestionRef.current = options?.restoreQuestionOnInterrupt ?? null;
      const restoreQuestionOnCancel = options?.restoreQuestionOnCancel ?? null;
      const restoreQuestionOnError = options?.restoreQuestionOnError ?? null;
      const restoreQuestionAfterRun = options?.restoreQuestionAfterRun ?? null;
      const abortController = new AbortController();
      activeAbortControllerRef.current = abortController;
      const originProjectId = runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectIdRef.current;
      const deferRecentProjectUpsert = !originProjectId;
      const forceSilent = shouldForceSilentWorkflowShortcut(action);
      const skipUserBubble = forceSilent || Boolean(options?.skipUserBubble);
      const skipAssistantSummary = forceSilent || Boolean(options?.skipAssistantSummary);
      const skipSilentLlmContinuation = skipUserBubble && skipAssistantSummary;
      const submissionGuard = resolveBatchMediaShortcutSubmissionGuard({
        action,
        input,
        runtime: runtimeRef.current,
        delayMs: batchMediaSubmissionGuardDelayMs,
      });
      const guardedStartProgressText = buildGuardedWorkflowStartProgressText({
        action,
        input,
        runtime: runtimeRef.current,
        userBubble,
        submissionGuard,
      });
      clearChoiceUi();
      activateConversation();
      setActiveWorkflowAction(action);
      setStreaming(true);
      const surfacedShortcutProgress = surfaceWorkflowShortcutStartUi(action, userBubble, {
        skipUserBubble,
        skipProgress: forceSilent,
        progressText: guardedStartProgressText,
      });
      void (async () => {
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];
        const generatedVideoUrls: string[] = [];
        let shortcutProgressDelegated = false;
        try {
          const contentSummary = buildMediaContentSummary({
            action,
            promptText: userBubble,
            imageKind: String(input.imageKind || ""),
            runtime: runtimeRef.current,
            targetIds:
              action === "generate_segment_video"
                ? resolveWorkflowSegmentVideoStartTargets({
                    input,
                    runtime: runtimeRef.current,
                  }).segmentLabels
                : Array.isArray(input.targetIds)
                  ? input.targetIds.map(String)
                  : undefined,
          });
          const batchMediaEventId =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `workflow-media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const workflow = await loadWorkflowActionsModule();
          const runActionAndCapture = async (
            nextAction: string,
            nextInput: Record<string, unknown>,
            nextRuntime: StudioRuntimeState,
            nextOnProgress?: import("@/lib/home-agent/types").WorkflowActionProgressCallback,
          ) => {
            const preparedInput = {
              ...decorateWorkflowInput(nextInput, abortController.signal),
              mediaEventId: batchMediaEventId,
            };
            dispatchWorkflowMediaStartEvent({
              action: nextAction,
              input: preparedInput,
              runtime: nextRuntime,
              promptText: userBubble,
              mediaEventId: batchMediaEventId,
            });
            const result = (await workflow.runWorkflowAction(
              nextAction,
              preparedInput,
              nextRuntime,
              nextOnProgress,
            )) as WorkflowActionResult;
            if (result.imageUrls?.length) {
              generatedImageUrls.push(...result.imageUrls);
            }
            if (result.imageLabels?.length) {
              generatedImageLabels.push(...result.imageLabels);
            }
            if (result.videoUrls?.length) {
              generatedVideoUrls.push(...result.videoUrls);
            }
            return result;
          };
          const ui = scopeWorkflowUiToOriginProject(createWorkflowShortcutUiBridge({
            activateConversation,
            clearChoiceUi,
            commitRuntime: commitWorkflowRuntime,
            getSuggestedQuestion,
            getAssistantMessageExtras: () => ({
              workflowRefresh: {
                mode: "shortcut",
                action,
                input: { ...input },
                userBubble,
                projectId: originProjectId ?? null,
              },
            }),
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          }), originProjectId);

          shortcutProgressDelegated = surfacedShortcutProgress;
          let finalCompletion = await runWorkflowShortcut({
            action,
            input: decorateWorkflowInput(input, abortController.signal),
            runtime: runtimeRef.current,
            deferRecentProjectUpsert,
            runAction: runActionAndCapture,
            ui,
            userBubble: "",
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: true,
            skipAssistantSummary,
            skipInitialProgressEvent: surfacedShortcutProgress,
            onErrorMessage: (_message, error) => {
              if (isTimeoutLikeError(error)) {
                restoreCurrentInterruptQuestion();
              }
            },
          });
          if (
            finalCompletion &&
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted
          ) {
            if (
              action === "export_video_asset_bundle" &&
              restoreQuestionOnCancel &&
              isVideoAssetBundleExportCancelledSummary(finalCompletion.summary)
            ) {
              if (restoreInterruptedChoiceQuestion?.(restoreQuestionOnCancel)) {
                return;
              }
              setMode("active");
              setPopoverOverride(restoreQuestionOnCancel);
              setSuggested(null);
              resetComposerDraft("");
              return;
            }
            if (finalCompletion.pendingFollowup) {
              finalCompletion = await runWorkflowShortcut({
                action: finalCompletion.pendingFollowup.action,
                input: decorateWorkflowInput(finalCompletion.pendingFollowup.input, abortController.signal),
                runtime: finalCompletion.runtime,
                deferRecentProjectUpsert,
                runAction: runActionAndCapture,
                ui,
                userBubble: "",
                allowAutoFollowup: creationMode === "fast",
                surfaceNextSuggestion: true,
                onErrorMessage: (_message, error) => {
                  if (isTimeoutLikeError(error)) {
                    restoreCurrentInterruptQuestion();
                  }
                },
              });
            } else if (!finalCompletion.nextSuggestion && !skipSilentLlmContinuation) {
              await continueWorkflowInLlmMode(finalCompletion);
            }
          } else if (
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted &&
            restoreQuestionOnError
          ) {
            setMode("active");
            setPopoverOverride(restoreQuestionOnError);
            setSuggested(null);
          }
          if (isWorkflowOriginActive(originProjectId)) {
            dispatchWorkflowMediaEvents({
              imageUrls: generatedImageUrls,
              videoUrls: generatedVideoUrls,
              mediaEventId: batchMediaEventId,
              actionLabel: userBubble.trim() || action,
              imageDetail: {
                action,
                count: generatedImageUrls.length,
                modelFamily: selectedImageModelFamily,
                resolution: imageGenerationPrefs.resolution,
                aspectRatio: imageGenerationPrefs.aspectRatio,
                contentSummary,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
              },
              videoDetail: {
                action,
                count: generatedVideoUrls.length,
                model: selectedVideoModelKey,
                resolution: videoGenerationPrefs.resolution,
                mode: videoGenerationPrefs.mode,
                aspectRatio: videoGenerationPrefs.aspectRatio || imageGenerationPrefs.aspectRatio,
                provider: "",
                contentSummary,
              },
            });
          }
          if (
            finalCompletion &&
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted
          ) {
            if (restoreQuestionAfterRun) {
              setMode("active");
              setPopoverOverride(restoreQuestionAfterRun);
              setSuggested(null);
            } else if (
              shouldReopenVideoWorkflowPopover(finalCompletion) &&
              !hasRunningVideoGenerationTasks(finalCompletion?.runtime?.currentVideoProject ?? runtimeRef.current.currentVideoProject)
            ) {
              setWorkflowPopoverQuestion(finalCompletion.nextSuggestion, finalCompletion.projectSnapshot);
              setSuggested(null);
            }
          }
        } finally {
          if (surfacedShortcutProgress && !shortcutProgressDelegated) {
            dispatchWorkflowShortcutProgressEvent(action, "complete", "");
          }
          const ownsActiveExecution = activeAbortControllerRef.current === abortController;
          if (ownsActiveExecution) {
            activeAbortControllerRef.current = null;
            workflowShortcutInFlightRef.current = false;
            setActiveWorkflowAction(null);
            setStreaming(false);
            if (wasInterruptedRef.current) {
              if (!interruptRestoreQuestionRef.current && isWorkflowOriginActive(originProjectId)) {
                setPopoverOverride(null);
              }
            } else {
              interruptRestoreQuestionRef.current = null;
            }
          }
        }
      })();
    },
    [
      activateConversation,
      clearChoiceUi,
      commitWorkflowRuntime,
      getSuggestedQuestion,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      setActiveWorkflowAction,
      setPopoverOverride,
      setStreaming,
      setSuggested,
      workflowShortcutInFlightRef,
      decorateWorkflowInput,
      creationMode,
      continueWorkflowInLlmMode,
      interruptRestoreQuestionRef,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      restoreInterruptedChoiceQuestion,
      restoreCurrentInterruptQuestion,
      surfaceWorkflowShortcutStartUi,
      scopeWorkflowUiToOriginProject,
      isWorkflowOriginActive,
      setMode,
      setWorkflowPopoverQuestion,
      batchMediaSubmissionGuardDelayMs,
    ],
  );

  const runWorkflowActionShortcutChain = useCallback(
    (
      steps: Array<{ action: string; input: Record<string, unknown> }>,
      userBubble: string,
      options?: {
        restoreQuestionOnInterrupt?: ComposerQuestion | null;
        restoreQuestionOnCancel?: ComposerQuestion | null;
        restoreQuestionOnError?: ComposerQuestion | null;
        restoreQuestionAfterRun?: ComposerQuestion | null;
        skipUserBubble?: boolean;
      },
    ) => {
      if (workflowShortcutInFlightRef.current) {
        push("assistant", "当前已有步骤在执行，请等待当前流程完成后再继续。");
        return;
      }
      workflowShortcutInFlightRef.current = true;
      wasInterruptedRef.current = false;
      interruptRestoreQuestionRef.current = options?.restoreQuestionOnInterrupt ?? null;
      const restoreQuestionOnError = options?.restoreQuestionOnError ?? null;
      const restoreQuestionAfterRun = options?.restoreQuestionAfterRun ?? null;
      const abortController = new AbortController();
      activeAbortControllerRef.current = abortController;
      const originProjectId = runtimeRef.current.currentProjectSnapshot?.projectId ?? activeProjectIdRef.current;
      const deferRecentProjectUpsert = !originProjectId;
      const finalAction = steps.at(-1)?.action ?? "workflow";
      const submissionGuard = resolveBatchMediaShortcutSubmissionGuard({
        action: finalAction,
        input: steps.at(-1)?.input ?? {},
        runtime: runtimeRef.current,
        delayMs: batchMediaSubmissionGuardDelayMs,
        stepCount: steps.length,
      });
      const chainedSegmentLabels =
        finalAction === "generate_segment_video"
          ? steps
              .filter((step) => step.action === "generate_segment_video")
              .map((step) =>
                typeof step.input.segmentLabel === "string" ? step.input.segmentLabel.trim() : "",
              )
              .filter(Boolean)
          : [];
      const chainedStartInput =
        finalAction === "generate_segment_video" && chainedSegmentLabels.length > 1
          ? {
              ...(steps.at(-1)?.input ?? {}),
              targetSegmentLabels: chainedSegmentLabels,
            }
          : (steps.at(-1)?.input ?? {});
      const guardedStartProgressText = buildGuardedWorkflowStartProgressText({
        action: finalAction,
        input: chainedStartInput,
        runtime: runtimeRef.current,
        userBubble,
        submissionGuard,
      });
      clearChoiceUi();
      activateConversation();
      setActiveWorkflowAction(steps.at(-1)?.action ?? null);
      setStreaming(true);
      const surfacedShortcutProgress = surfaceWorkflowShortcutStartUi(finalAction, userBubble, {
        skipUserBubble: Boolean(options?.skipUserBubble),
        skipProgress: false,
        progressText: guardedStartProgressText,
      });
      void (async () => {
        const generatedImageUrls: string[] = [];
        const generatedImageLabels: string[] = [];
        const generatedVideoUrls: string[] = [];
        let shortcutProgressDelegated = false;
        try {
          const contentSummary = buildMediaContentSummary({
            action: finalAction,
            promptText: userBubble,
            imageKind: String(steps.at(-1)?.input?.imageKind || ""),
            runtime: runtimeRef.current,
            targetIds:
              finalAction === "generate_segment_video"
                ? resolveWorkflowSegmentVideoStartTargets({
                    input: steps.at(-1)?.input ?? {},
                    runtime: runtimeRef.current,
                  }).segmentLabels
                : Array.isArray(steps.at(-1)?.input?.targetIds)
                  ? (steps.at(-1)?.input?.targetIds as unknown[]).map(String)
                  : undefined,
          });
          const batchMediaEventId =
            typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `workflow-media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const workflow = await loadWorkflowActionsModule();
          const runActionAndCapture = async (
            nextAction: string,
            nextInput: Record<string, unknown>,
            nextRuntime: StudioRuntimeState,
            nextOnProgress?: import("@/lib/home-agent/types").WorkflowActionProgressCallback,
          ) => {
            const preparedInput = {
              ...decorateWorkflowInput(nextInput, abortController.signal),
              mediaEventId: batchMediaEventId,
            };
            dispatchWorkflowMediaStartEvent({
              action: nextAction,
              input: preparedInput,
              runtime: nextRuntime,
              promptText: userBubble,
              mediaEventId: batchMediaEventId,
            });
            const result = (await workflow.runWorkflowAction(
              nextAction,
              preparedInput,
              nextRuntime,
              nextOnProgress,
            )) as WorkflowActionResult;
            if (result.imageUrls?.length) {
              generatedImageUrls.push(...result.imageUrls);
            }
            if (result.imageLabels?.length) {
              generatedImageLabels.push(...result.imageLabels);
            }
            if (result.videoUrls?.length) {
              generatedVideoUrls.push(...result.videoUrls);
            }
            return result;
          };
          const ui = scopeWorkflowUiToOriginProject(createWorkflowShortcutUiBridge({
            activateConversation,
            clearChoiceUi,
            commitRuntime: commitWorkflowRuntime,
            getSuggestedQuestion,
            getAssistantMessageExtras: () => ({
              workflowRefresh: {
                mode: "chain",
                steps: steps.map((step) => ({ action: step.action, input: { ...step.input } })),
                userBubble,
                projectId: originProjectId ?? null,
              },
            }),
            push,
            resetComposerDraft,
            setPopoverQuestion: setWorkflowPopoverQuestion,
            setStreaming,
            setSuggested,
          }), originProjectId);

          shortcutProgressDelegated = surfacedShortcutProgress;
          let finalCompletion = await runWorkflowShortcutChain({
            runtime: runtimeRef.current,
            deferRecentProjectUpsert,
            runAction: runActionAndCapture,
            skipInitialProgressEvent: surfacedShortcutProgress,
            steps: steps.map((step) => ({
              ...step,
              input: decorateWorkflowInput(step.input, abortController.signal),
            })),
            ui,
            userBubble: options?.skipUserBubble ? "" : userBubble,
            allowAutoFollowup: creationMode === "fast",
            surfaceNextSuggestion: true,
            onErrorMessage: (_message, error) => {
              if (isTimeoutLikeError(error)) {
                restoreCurrentInterruptQuestion();
              }
            },
          });
          if (
            finalCompletion &&
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted
          ) {
            if (finalCompletion.pendingFollowup) {
              finalCompletion = await runWorkflowShortcut({
                action: finalCompletion.pendingFollowup.action,
                input: decorateWorkflowInput(finalCompletion.pendingFollowup.input, abortController.signal),
                runtime: finalCompletion.runtime,
                deferRecentProjectUpsert,
                runAction: runActionAndCapture,
                ui,
                userBubble: "",
                allowAutoFollowup: creationMode === "fast",
                surfaceNextSuggestion: true,
                onErrorMessage: (_message, error) => {
                  if (isTimeoutLikeError(error)) {
                    restoreCurrentInterruptQuestion();
                  }
                },
              });
            } else if (!finalCompletion.nextSuggestion) {
              await continueWorkflowInLlmMode(finalCompletion);
            }
          } else if (
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted &&
            restoreQuestionOnError
          ) {
            setMode("active");
            setPopoverOverride(restoreQuestionOnError);
            setSuggested(null);
          }
          if (isWorkflowOriginActive(originProjectId)) {
            dispatchWorkflowMediaEvents({
              imageUrls: generatedImageUrls,
              videoUrls: generatedVideoUrls,
              mediaEventId: batchMediaEventId,
              actionLabel: userBubble.trim() || steps.at(-1)?.action || "workflow",
              imageDetail: {
                action: steps.at(-1)?.action || "workflow",
                count: generatedImageUrls.length,
                modelFamily: selectedImageModelFamily,
                resolution: imageGenerationPrefs.resolution,
                aspectRatio: imageGenerationPrefs.aspectRatio,
                contentSummary,
                imageLabels: generatedImageLabels.length ? generatedImageLabels : undefined,
              },
              videoDetail: {
                action: steps.at(-1)?.action || "workflow",
                count: generatedVideoUrls.length,
                model: selectedVideoModelKey,
                resolution: videoGenerationPrefs.resolution,
                mode: videoGenerationPrefs.mode,
                aspectRatio: videoGenerationPrefs.aspectRatio || imageGenerationPrefs.aspectRatio,
                provider: "",
                contentSummary,
              },
            });
          }
          if (
            finalCompletion &&
            isWorkflowOriginActive(originProjectId) &&
            !wasInterruptedRef.current &&
            !abortController.signal.aborted
          ) {
            if (restoreQuestionAfterRun) {
              setMode("active");
              setPopoverOverride(restoreQuestionAfterRun);
              setSuggested(null);
            } else if (
              shouldReopenVideoWorkflowPopover(finalCompletion) &&
              !hasRunningVideoGenerationTasks(finalCompletion?.runtime?.currentVideoProject ?? runtimeRef.current.currentVideoProject)
            ) {
              setWorkflowPopoverQuestion(finalCompletion.nextSuggestion, finalCompletion.projectSnapshot);
              setSuggested(null);
            }
          }
        } finally {
          if (surfacedShortcutProgress && !shortcutProgressDelegated) {
            dispatchWorkflowShortcutProgressEvent(finalAction, "complete", "");
          }
          const ownsActiveExecution = activeAbortControllerRef.current === abortController;
          if (ownsActiveExecution) {
            activeAbortControllerRef.current = null;
            workflowShortcutInFlightRef.current = false;
            setActiveWorkflowAction(null);
            setStreaming(false);
            if (wasInterruptedRef.current) {
              if (!interruptRestoreQuestionRef.current && isWorkflowOriginActive(originProjectId)) {
                setPopoverOverride(null);
              }
            } else {
              interruptRestoreQuestionRef.current = null;
            }
          }
        }
      })();
    },
    [
      activateConversation,
      clearChoiceUi,
      commitWorkflowRuntime,
      getSuggestedQuestion,
      loadWorkflowActionsModule,
      push,
      resetComposerDraft,
      runtimeRef,
      setActiveWorkflowAction,
      setPopoverOverride,
      setStreaming,
      setSuggested,
      workflowShortcutInFlightRef,
      decorateWorkflowInput,
      creationMode,
      continueWorkflowInLlmMode,
      selectedImageModelFamily,
      imageGenerationPrefs,
      selectedVideoModelKey,
      videoGenerationPrefs,
      restoreCurrentInterruptQuestion,
      surfaceWorkflowShortcutStartUi,
      scopeWorkflowUiToOriginProject,
      isWorkflowOriginActive,
      setMode,
      setWorkflowPopoverQuestion,
      batchMediaSubmissionGuardDelayMs,
    ],
  );

  // 静默切换视频步骤：不发消息、不调用 agent，直接更新 runtime 并刷新弹窗
  const switchVideoStep = useCallback(
    (projectId: string, targetStep: number, statusText: string) => {
      void (async () => {
        try {
          const workflow = await loadWorkflowActionsModule();
          const result = await workflow.runWorkflowAction(
            "continue_video_step",
            { projectId, targetStep },
            runtimeRef.current,
          ) as import("@/lib/home-agent/types").WorkflowActionResult;
          if (result.data) {
            const { mergeRuntimeWithWorkflowDelta } = await import("@/lib/home-agent/workflow-shortcut-runner");
            const nextRuntime = mergeRuntimeWithWorkflowDelta(runtimeRef.current, result.data);
            const nextSnapshot = result.data.projectSnapshot ?? null;
            commitWorkflowRuntime(nextRuntime, nextSnapshot?.projectId);
            const nextSuggestion = nextSnapshot ? getSuggestedQuestion(nextSnapshot, nextRuntime) : null;
            setWorkflowPopoverQuestion(nextSuggestion, nextSnapshot);
            setSuggested(null);
          }
        } catch {
          // 静默失败，不影响 UI
        }
      })();
    },
    [commitWorkflowRuntime, getSuggestedQuestion, loadWorkflowActionsModule, runtimeRef, setSuggested, setWorkflowPopoverQuestion],
  );

  const interruptWorkflowShortcut = useCallback(() => {
    workflowShortcutInFlightRef.current = false;
    wasInterruptedRef.current = true;
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = null;
    backgroundResearchGroupsRef.current.forEach((group) => {
      group.status = "cancelled";
    });
    abortOutlineGenerationLazy();
    abortVideoWorkflowGenerationLazy();
    dispatchWorkflowMediaCancelledEvent();
    setActiveWorkflowAction(null);
    setStreaming(false);
    if (interruptRestoreQuestionRef.current) {
      restoreCurrentInterruptQuestion();
    }
  }, [
    backgroundResearchGroupsRef,
    restoreCurrentInterruptQuestion,
    setActiveWorkflowAction,
    setStreaming,
  ]);

  return {
    runBackgroundVideoBridgeResearch,
    runWorkflowActionShortcut,
    runWorkflowActionShortcutChain,
    interruptWorkflowShortcut,
    switchVideoStep,
  };
}
