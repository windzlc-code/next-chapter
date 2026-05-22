import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Menu,
  Paperclip,
  PencilLine,
  RefreshCw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { DraftAttachmentList, MessageAttachmentList } from "@/components/chat/attachment-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import type { CreationGuideDimensionId } from "@/lib/home-agent/creation-guide-presets";
import type {
  ConversationArtifact,
  HomeAgentMessage,
  ComposerQuestion,
  ConversationProjectSnapshot,
  CreationMode,
  FullAutoRunState,
  VideoWorkflowTaskBoard,
} from "@/lib/home-agent/types";
import type { Task as RuntimeTask } from "@/lib/agent/tools/task-tools";
import { cn } from "@/lib/utils";
import { cloneConversationArtifact } from "@/lib/home-agent/message-artifact-snapshots";
import ComposerChoiceModal, {
  type ComposerWorkflowProgress,
} from "./ComposerChoiceModal";
import {
  getComposerCustomCaptureDescriptor,
  resolveComposerCustomCaptureAction,
} from "./composer-custom-capture";
import { HomeTextModelPicker } from "./HomeTextModelPicker";
import { HomeImageModelPicker } from "./HomeImageModelPicker";
import { HomeImageSettingsPopover } from "./HomeImageSettingsPopover";
import { HomeVideoModelPicker } from "./HomeVideoModelPicker";
import {
  isSupportedImageFile,
  type HomeAgentImageStyleRecognitionResult,
} from "@/lib/home-agent/image-style-analysis";
import type { HomeAgentTextModelGroup } from "@/lib/home-agent/text-models";
import type { HomeAgentImageModelFamilyOption } from "@/lib/home-agent/image-models";
import type { HomeAgentVideoModelOption } from "@/lib/home-agent/video-models";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import {
  formatTaskDockTimestamp,
  isTerminalTask,
  parseTaskHeading,
  parseTaskPreview,
  taskStatusClass,
  taskStatusLabel,
  truncateCopy,
} from "./home-agent-task-utils";
import {
  buildFullAutoProgressDisplaySteps,
  buildFullAutoVisualChecklist,
} from "@/lib/home-agent/full-auto-run-plan";
const { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
const LazyScriptArtifactPanel = React.lazy(async () => {
  const mod = await import("./ScriptArtifactPanel");
  return { default: mod.ScriptArtifactPanel };
});
const LazyAssistantCreationGuideBody = React.lazy(async () => {
  const mod = await import("./AssistantCreationGuideBody");
  return { default: mod.AssistantCreationGuideBody };
});

const USER_ACTION_RAIL_HIDE_DELAY_MS = 450;
const DESKTOP_UTILITY_COLUMN_LAYOUT_EVENT = "home-agent:desktop-utility-column-layout";
export const HOME_AGENT_DESKTOP_LAYOUT_INVALIDATE_EVENT = "home-agent:desktop-layout-invalidate";

type DesktopUtilityColumnLayoutDetail = {
  left: number;
  width: number;
} | null;

function AssistantCreationGuideFallback({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn("whitespace-pre-wrap text-[14px] leading-[1.8] text-white/82", className)}>
      {content}
    </div>
  );
}

type ScriptProgressArtifact = ConversationArtifact & {
  payload: Extract<
    NonNullable<ConversationArtifact["payload"]>,
    { type: "outlines+batchProgress" } | { type: "episodes+batchProgress" }
  >;
};

function isScriptProgressArtifact(artifact: ConversationArtifact): artifact is ScriptProgressArtifact {
  return (
    (artifact.kind === "outline" && artifact.payload?.type === "outlines+batchProgress") ||
    (artifact.kind === "episode" && artifact.payload?.type === "episodes+batchProgress")
  );
}

const PRIMARY_SCRIPT_ARTIFACT_KINDS = new Set<ConversationArtifact["kind"]>([
  "setup",
  "dramaSetup",
  "reference",
  "plan",
  "characters",
  "directory",
  "outline",
  "episode",
  "episode-review",
  "compliance",
  "export",
]);

const SCRIPT_ONLY_ARTIFACT_KINDS = new Set<ConversationArtifact["kind"]>([
  "setup",
  "dramaSetup",
  "reference",
  "directory",
  "outline",
  "episode",
  "episode-review",
  "compliance",
  "export",
]);

const VIDEO_ONLY_ARTIFACT_KINDS = new Set<ConversationArtifact["kind"]>([
  "video-brief",
  "scene-settings",
  "style-lock",
  "world-model",
  "asset-manifest",
  "shot-packet",
]);

function isVideoScriptArtifact(artifact: ConversationArtifact): boolean {
  return artifact.kind === "plan" && artifact.label.trim() === "视频脚本";
}

function resolveVisibleVideoArtifactStage(
  stage: string | null | undefined,
): "脚本拆解" | "角色与场景" | "分镜图生成" | "视频生成" | "预览与导出" {
  switch (String(stage || "").trim()) {
    case "角色与场景":
      return "角色与场景";
    case "分镜图生成":
    case "分镜批次":
    case "镜头指令包":
      return "分镜图生成";
    case "视频生成":
    case "视频提示词":
    case "生成中":
      return "视频生成";
    case "预览与导出":
    case "审阅与修复":
      return "预览与导出";
    case "脚本拆解":
    default:
      return "脚本拆解";
  }
}

function filterArtifactsForSnapshotStage(
  artifacts: ConversationArtifact[],
  snapshot: ConversationProjectSnapshot | null | undefined,
): ConversationArtifact[] {
  if (snapshot?.projectKind !== "video") return artifacts;
  if (resolveVisibleVideoArtifactStage(snapshot.derivedStage) === "脚本拆解") return artifacts;
  return artifacts.filter((artifact) => !isVideoScriptArtifact(artifact));
}

const SCRIPT_MESSAGE_ARTIFACT_SCOPES: Array<{
  patterns: string[];
  kinds: ConversationArtifact["kind"][];
}> = [
  { patterns: ["单集时长", "分集撰写", "分集生成", "批量生成", "正文"], kinds: ["episode"] },
  { patterns: ["质量审查", "质检"], kinds: ["episode-review"] },
  { patterns: ["单集细纲", "细纲"], kinds: ["outline"] },
  { patterns: ["分集目录", "目录"], kinds: ["directory"] },
  { patterns: ["角色"], kinds: ["characters"] },
  { patterns: ["创意方案"], kinds: ["plan"] },
  { patterns: ["项目设定", "立项"], kinds: ["setup", "dramaSetup"] },
  { patterns: ["合规"], kinds: ["compliance"] },
  { patterns: ["导出", "出版"], kinds: ["export"] },
];

function inferArtifactPanelProjectKind(
  artifacts: ConversationArtifact[],
  snapshot: ConversationProjectSnapshot | null | undefined,
): ConversationProjectSnapshot["projectKind"] | null {
  if (!artifacts.length) return null;
  if (snapshot?.projectKind === "script" || snapshot?.projectKind === "adaptation") {
    return snapshot.projectKind;
  }

  const hasVideoHints = artifacts.some(
    (artifact) => VIDEO_ONLY_ARTIFACT_KINDS.has(artifact.kind) || isVideoScriptArtifact(artifact),
  );
  const hasScriptOnlyHints = artifacts.some((artifact) => SCRIPT_ONLY_ARTIFACT_KINDS.has(artifact.kind));

  if (snapshot?.projectKind === "video") {
    if (hasVideoHints) return "video";
    if (hasScriptOnlyHints) return "script";
    return "video";
  }

  if (hasVideoHints) return "video";
  return artifacts.some((artifact) => PRIMARY_SCRIPT_ARTIFACT_KINDS.has(artifact.kind)) ? "script" : null;
}

function resolveHistoricalArtifactProjectId(params: {
  inferredProjectKind: ConversationProjectSnapshot["projectKind"];
  snapshot: ConversationProjectSnapshot | null | undefined;
  message: HomeAgentMessage;
  fallbackArtifactId: string;
}): string {
  const { inferredProjectKind, snapshot, message, fallbackArtifactId } = params;
  const workflowProjectId =
    typeof message.workflowRefresh?.projectId === "string" ? message.workflowRefresh.projectId.trim() : "";
  if (workflowProjectId) {
    return workflowProjectId;
  }
  if (
    snapshot?.projectKind === inferredProjectKind &&
    typeof snapshot.projectId === "string" &&
    snapshot.projectId.trim()
  ) {
    return snapshot.projectId.trim();
  }
  return `historical-artifact:${fallbackArtifactId}`;
}

function buildHistoricalArtifactPanelSnapshot(params: {
  artifacts: ConversationArtifact[];
  snapshot: ConversationProjectSnapshot | null | undefined;
  message: HomeAgentMessage;
}): ConversationProjectSnapshot | null {
  const { artifacts, snapshot, message } = params;
  if (!artifacts.length) return null;

  const inferredProjectKind = inferArtifactPanelProjectKind(artifacts, snapshot);
  if (!inferredProjectKind) return null;

  if (snapshot && snapshot.projectKind === inferredProjectKind) {
    return { ...snapshot, artifacts };
  }

  const firstArtifact = artifacts[0];
  const resolvedProjectId = resolveHistoricalArtifactProjectId({
    inferredProjectKind,
    snapshot,
    message,
    fallbackArtifactId: firstArtifact?.id || message.id,
  });
  const canReuseSnapshotMeta = snapshot?.projectId === resolvedProjectId;
  return {
    projectId: resolvedProjectId,
    projectKind: inferredProjectKind,
    title: canReuseSnapshotMeta ? snapshot?.title || "历史项目" : "历史项目",
    currentObjective: message.content.trim() || "查看历史产物",
    derivedStage: firstArtifact?.label || "历史记录",
    agentSummary: "历史消息绑定的产物快照",
    recommendedActions: [],
    artifacts,
    ...(canReuseSnapshotMeta && snapshot?.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
  };
}

function scopeAssistantScriptArtifactsToMessage(
  artifacts: ConversationArtifact[],
  content: string,
  projectKind: ConversationProjectSnapshot["projectKind"] | undefined,
): ConversationArtifact[] {
  if (
    artifacts.length <= 1 ||
    (projectKind !== "script" && projectKind !== "adaptation") ||
    artifacts.filter((artifact) => PRIMARY_SCRIPT_ARTIFACT_KINDS.has(artifact.kind)).length <= 1
  ) {
    return artifacts;
  }

  const scope = SCRIPT_MESSAGE_ARTIFACT_SCOPES.find((item) =>
    item.patterns.some((pattern) => content.includes(pattern)),
  );
  if (!scope) return artifacts;

  const kindSet = new Set(scope.kinds);
  const scopedArtifacts = artifacts.filter((artifact) => kindSet.has(artifact.kind));
  return scopedArtifacts.length ? scopedArtifacts : artifacts;
}

function resolveLiveScriptProgressArtifact(
  snapshot: ConversationProjectSnapshot | null | undefined,
): ConversationArtifact | null {
  const artifacts = snapshot?.artifacts ?? [];
  const artifact =
    artifacts.find((item) => isScriptProgressArtifact(item) && item.payload.batchProgress.processing > 0) ??
    artifacts.find(isScriptProgressArtifact);
  return artifact ? cloneConversationArtifact(artifact) : null;
}

function mergeLiveScriptProgressArtifact(
  artifacts: ConversationArtifact[],
  liveArtifact: ConversationArtifact | null,
): ConversationArtifact[] {
  if (!liveArtifact) return artifacts;
  if (!artifacts.length) return [liveArtifact];

  let replaced = false;
  const merged: ConversationArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.id === liveArtifact.id || isScriptProgressArtifact(artifact)) {
      if (!replaced) {
        merged.push(liveArtifact);
      }
      replaced = true;
      continue;
    }
    merged.push(artifact);
  }

  return replaced ? merged : [...artifacts, liveArtifact];
}

function isDirectReviewWorkspaceMessage(message: HomeAgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return (
    (message.content.includes("质量自检") && message.content.includes("结果会在这条最新消息下方更新")) ||
    (message.content.includes("批量质量审查") && message.content.includes("结果会在这条最新消息下方更新"))
  );
}

function messageHasConversationLightboxImages(message: HomeAgentMessage): boolean {
  return Boolean(
    message.attachments?.some((attachment) => attachment.kind === "image" && attachment.previewUrl && !attachment.pending),
  );
}

// 平滑动画进度 hook（参照 Automatic-script/StepOutlines.tsx）
function useAnimatedProgress(ceilPercent: number, floorPercent: number, hasProcessing: boolean) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>();
  const lastTimeRef = useRef(performance.now());
  const prevCeilRef = useRef(ceilPercent);
  const displayRef = useRef(0);
  const ceilDropped = ceilPercent < prevCeilRef.current;

  useEffect(() => { prevCeilRef.current = ceilPercent; }, [ceilPercent]);
  useEffect(() => { displayRef.current = display; }, [display]);

  useEffect(() => {
    const isSettled = (value: number) => {
      const target = !hasProcessing && !ceilDropped ? floorPercent : Math.max(0, ceilPercent - 0.1);
      return Math.abs(value - target) <= 0.1;
    };

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    if (isSettled(displayRef.current)) {
      return;
    }

    lastTimeRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      let nextValue = displayRef.current;
      setDisplay((prev) => {
        const hardCap = Math.max(0, ceilPercent - 0.1);
        if (!hasProcessing && !ceilDropped) {
          if (prev > floorPercent) {
            const rollSpeed = Math.max(1, (prev - floorPercent) * 0.08) * 12;
            nextValue = Math.max(prev - rollSpeed * dt, floorPercent);
            displayRef.current = nextValue;
            return nextValue;
          }
          nextValue = floorPercent;
          displayRef.current = nextValue;
          return nextValue;
        }
        if (prev > hardCap) {
          const rollSpeed = Math.max(1, (prev - hardCap) * 0.08) * 12;
          nextValue = Math.max(prev - rollSpeed * dt, hardCap);
          displayRef.current = nextValue;
          return nextValue;
        }
        const base = Math.max(prev, floorPercent);
        const gap = hardCap - base;
        if (gap <= 0) {
          nextValue = hardCap;
          displayRef.current = nextValue;
          return nextValue;
        }
        const chunkRange = ceilPercent - floorPercent;
        const baseSpeed = chunkRange > 0 ? chunkRange / 75 : 0.2;
        const ratio = gap / (chunkRange || 1);
        const speed = baseSpeed * Math.max(0.05, ratio);
        nextValue = Math.min(base + speed * dt, hardCap);
        displayRef.current = nextValue;
        return nextValue;
      });
      if (isSettled(nextValue)) {
        rafRef.current = undefined;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
    };
  }, [ceilPercent, floorPercent, hasProcessing, ceilDropped]);

  useEffect(() => {
    setDisplay((prev) => {
      const nextValue = Math.max(prev, floorPercent);
      displayRef.current = nextValue;
      return nextValue;
    });
  }, [floorPercent]);
  return Math.round(display * 10) / 10;
}

// 内联进度组件：嵌入 agent 消息气泡，无独立边框
function OutlineProgressInline({
  progress,
  collapsed,
  onToggleCollapse,
  shimmerStyle,
  progressStatusRef,
}: {
  progress: ComposerWorkflowProgress;
  collapsed: boolean;
  onToggleCollapse: () => void;
  shimmerStyle?: React.CSSProperties;
  progressStatusRef?: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="w-full space-y-1 pt-1.5">
      {/* 展开时：标题行 */}
      {!collapsed && (
        <div className="flex items-center gap-2">
          <span data-testid="agent-progress-title" className="text-[12px] font-medium text-foreground/80">
            {progress.title}
          </span>
        </div>
      )}

      {/* 进度行（始终显示） */}
      <div className="flex items-center gap-2 text-[12px]">
        <span
          ref={progressStatusRef}
          data-text={progress.statusLabel}
          data-testid="agent-progress-status"
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-muted-foreground tabular-nums",
            progress.hasProcessing && "agent-status-shimmer-text",
          )}
          style={progress.hasProcessing ? shimmerStyle : undefined}
        >
          {progress.statusLabel}
        </span>
        {progress.onRegenerate && !progress.onStop && (
          <button
            type="button"
            onClick={progress.onRegenerate}
            className="text-muted-foreground hover:text-foreground/60 transition-colors"
          >
            重新生成
          </button>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="ml-auto text-muted-foreground/60 hover:text-muted-foreground transition-colors p-0.5"
          title={collapsed ? "展开详情" : "收起详情"}
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform duration-200", collapsed && "-rotate-90")}
          />
        </button>
      </div>

      {/* 进度条（始终显示） */}

      {/* 当前批次（仅展开时显示） */}
      {null}
    </div>
  );
}

/** Assistant avatar in the conversation stream (static asset in /public). */
function HomeAgentAiAvatar({
  className,
  glowing,
  reduceMotion,
}: {
  className?: string;
  glowing?: boolean;
  reduceMotion?: boolean;
}) {
  const wantsGlow = Boolean(glowing);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-visible",
        className,
      )}
    >
      <img
        src="/home-agent-ai-avatar.png"
        alt=""
        className={cn(
          "h-full w-full object-contain select-none",
          wantsGlow && "home-agent-ai-avatar-breath",
        )}
        draggable={false}
        aria-hidden
      />
    </div>
  );
}

type ReactNode = React.ReactNode;
type RefObject<T> = React.RefObject<T>;

export interface HomeComposerVideoTransportHint {
  label: string;
  detail: string;
  tone?: "neutral" | "ready" | "warning";
}

export interface HomeComposerLaunchNotice {
  level: "warning" | "critical";
  title: string;
  description: string;
  actions: Array<{
    id: string;
    label: string;
  }>;
}

const ConversationMessageRow = memo(function ConversationMessageRow({
  message,
  shouldAnimate,
  reduceMotion,
  editsDisabled,
  onEditUserMessage,
  onAssistantFeedback,
  onRegenerateAssistant,
  assistantAvatarGlowing,
  autoOpenCreationGuidePicker,
  onCreationGuidePick,
  artifactPanel,
  inlineProgress,
  allConversationImages,
}: {
  message: HomeAgentMessage;
  shouldAnimate: boolean;
  reduceMotion: boolean;
  editsDisabled?: boolean;
  onEditUserMessage?: (messageId: string, newContent: string) => void | Promise<void>;
  onAssistantFeedback?: (messageId: string, vote: "up" | "down" | null) => void;
  onRegenerateAssistant?: (messageId: string, attachmentId?: string) => void | Promise<void>;
  /** True when this assistant row is the latest and a reply is still streaming in. */
  assistantAvatarGlowing?: boolean;
  /** Latest assistant message when idle — allows auto-opening the creation-guide preset modal once. */
  autoOpenCreationGuidePicker?: boolean;
  onCreationGuidePick?: (dimension: CreationGuideDimensionId, value: string, label: string) => void;
  /** Artifact panel to render inside the last assistant message. */
  artifactPanel?: React.ReactNode;
  /** Inline outline generation progress (shown inside the message bubble). */
  inlineProgress?: ComposerWorkflowProgress | null;
  /** All generated images in the conversation for cross-message lightbox navigation */
  allConversationImages?: import("@/lib/agent/chat-attachments").ChatAttachment[];
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [editLayout, setEditLayout] = useState<{
    width: number;
    bubbleMinHeight: number;
  } | null>(null);
  const [inlineProgressCollapsed, setInlineProgressCollapsed] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const userActionRailHideTimeoutRef = useRef<number | null>(null);
  const streamLabelRef = useRef<HTMLSpanElement>(null);
  const progressStatusRef = useRef<HTMLSpanElement>(null);
  const [streamShimmerWidth, setStreamShimmerWidth] = useState(120);
  const [shimmerTrackWidth, setShimmerTrackWidth] = useState(220);
  const [userActionRailVisible, setUserActionRailVisible] = useState(false);
  useLayoutEffect(() => {
    const updateTrackWidth = () => {
      const streamWidth = Math.max(streamLabelRef.current?.offsetWidth ?? 0, 120);
      const nextWidth = Math.max(streamWidth, progressStatusRef.current?.offsetWidth ?? 0, 120);
      setStreamShimmerWidth((prev) => (Math.abs(prev - streamWidth) < 1 ? prev : streamWidth));
      setShimmerTrackWidth((prev) => (Math.abs(prev - nextWidth) < 1 ? prev : nextWidth));
    };

    updateTrackWidth();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(updateTrackWidth);
    if (streamLabelRef.current) observer.observe(streamLabelRef.current);
    if (progressStatusRef.current) observer.observe(progressStatusRef.current);
    return () => observer.disconnect();
  }, [inlineProgress, message.status, message.streamLabel]);
  const shimmerSyncStyle = useMemo<React.CSSProperties>(
    () => {
      const bandSpan = 240;
      const baseStart = Math.max(streamShimmerWidth + 56, 180);
      const sharedStart = Math.max(shimmerTrackWidth + 56, 180);
      const baseTravel = baseStart + bandSpan;
      const sharedTravel = sharedStart + bandSpan;
      const duration = Math.round(3000* (sharedTravel / Math.max(baseTravel, 1)));

      return {
        ["--agent-shimmer-band-span" as const]: `${bandSpan}px`,
        ["--agent-shimmer-start" as const]: `-${bandSpan}px`,
        ["--agent-shimmer-end" as const]: `${sharedStart}px`,
        ["--agent-shimmer-duration" as const]: `${duration}ms`,
        ["--agent-shimmer-sync-delay" as const]: `${-(Date.now() % duration)}ms`,
      };
    },
    [shimmerTrackWidth, streamShimmerWidth],
  );

  useEffect(() => {
    if (!editing) setEditDraft(message.content);
  }, [message.content, editing]);

  useEffect(() => {
    return () => {
      if (userActionRailHideTimeoutRef.current !== null) {
        window.clearTimeout(userActionRailHideTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!editing || !editLayout) return;
    const ta = editTextareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const next = Math.max(editLayout.bubbleMinHeight, ta.scrollHeight);
    ta.style.height = `${next}px`;
  }, [editing, editDraft, editLayout]);

  const beginUserEdit = () => {
    const el = bubbleRef.current;
    if (el) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const stretched = Math.min(Math.round(w * 1.32 + 56), 620);
      setEditLayout({ width: stretched, bubbleMinHeight: h });
    } else {
      setEditLayout(null);
    }
    setEditDraft(message.content);
    setEditing(true);
  };

  const endUserEdit = () => {
    setEditing(false);
    setEditLayout(null);
  };

  const showUserEdit = message.role === "user" && onEditUserMessage && !editsDisabled;
  const showUserActions = message.role === "user" && !editing;
  const isFullAutoProxyMessage = message.role === "user" && message.automationOrigin === "full-auto";
  const isStructuredUserSelectionSummary =
    message.role === "user" &&
    !editing &&
    !message.attachments?.length &&
    /^(?:原创剧本立项|项目设定|确认项目设定|创作方式|目标市场|题材选择|创意内容|创作配置|目标受众|故事基调|结局类型|集数规模|补充描述)\s*[：:]/u.test(
      message.content.trim(),
    );
  const pinUserActionsToBubbleBottom = message.role === "user" && !editing && isFullAutoProxyMessage;
  const isAdaptiveSingleLineUserBubble =
    message.role === "user" &&
    !editing &&
    !message.content.includes("\n") &&
    !message.attachments?.length &&
    message.content.trim().length > 0 &&
    (isFullAutoProxyMessage || message.content.trim().length <= 28);
  const isActiveAssistantExecution = Boolean(assistantAvatarGlowing);
  const hideAssistantRegenerateForMedia =
    message.role === "assistant" &&
    Boolean(message.attachments?.some((attachment) => attachment.kind === "image" || attachment.kind === "video"));
  const shouldUseStreamingTextFallback =
    message.role === "assistant" &&
    message.status === "pending" &&
    message.content.trim().length > 0;

  const canSubmitUserEdit =
    editDraft.trim().length > 0 && editDraft.trim() !== message.content.trim();

  const handleCopyUserMessage = () => {
    void navigator.clipboard.writeText(message.content).catch(() => {});
  };

  const clearUserActionRailHideTimeout = () => {
    if (userActionRailHideTimeoutRef.current === null) return;
    window.clearTimeout(userActionRailHideTimeoutRef.current);
    userActionRailHideTimeoutRef.current = null;
  };

  const revealUserActionRail = () => {
    clearUserActionRailHideTimeout();
    setUserActionRailVisible(true);
  };

  const scheduleHideUserActionRail = () => {
    clearUserActionRailHideTimeout();
    userActionRailHideTimeoutRef.current = window.setTimeout(() => {
      setUserActionRailVisible(false);
      userActionRailHideTimeoutRef.current = null;
    }, USER_ACTION_RAIL_HIDE_DELAY_MS);
  };

  return (
    <motion.div
      data-home-agent-message-row={message.id}
      data-home-agent-message-role={message.role}
      initial={reduceMotion || !shouldAnimate ? false : { opacity: 0, y: 10 }}
      animate={reduceMotion || !shouldAnimate ? undefined : { opacity: 1, y: 0 }}
      transition={
        reduceMotion || !shouldAnimate
          ? undefined
          : {
              duration: 0.16,
              ease: [0.22, 1, 0.36, 1],
            }
      }
      className={cn("flex overflow-visible", message.role === "user" ? "justify-end" : "justify-start")}
    >
      {message.role === "assistant" ? (
        <div className="group w-full max-w-[820px] min-w-0 overflow-visible">
          {/* gap-3.5: breathing room; -mt aligns 32px icon center with first line box (12.5/1.74 & 13/1.8) */}
          <div className="flex items-start gap-3.5 overflow-visible">
            <div className="-mt-[5px] flex shrink-0 flex-col items-center gap-1 overflow-visible pl-3 pr-1 sm:-mt-1">
              <HomeAgentAiAvatar
                className="h-8 w-8"
                glowing={assistantAvatarGlowing}
                reduceMotion={reduceMotion}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden pr-3 sm:pr-4">
              <div data-home-agent-assistant-body="true">
                {shouldUseStreamingTextFallback ? (
                  <AssistantCreationGuideFallback
                    content={message.content}
                    className="text-foreground/82"
                  />
                ) : (
                  <React.Suspense
                    fallback={
                      <AssistantCreationGuideFallback
                        content={message.content}
                        className="text-foreground/82"
                      />
                    }
                  >
                    <LazyAssistantCreationGuideBody
                      messageId={message.id}
                      autoOpenPresetPicker={Boolean(autoOpenCreationGuidePicker)}
                      content={message.content}
                      onCreationGuidePick={onCreationGuidePick}
                      picksDisabled={Boolean(editsDisabled)}
                      className="text-foreground/82"
                    />
                  </React.Suspense>
                )}
              </div>
              {message.attachments?.length ? (
                <MessageAttachmentList
                  attachments={message.attachments}
                  allConversationImages={allConversationImages}
                  onRegenerateAttachment={
                    onRegenerateAssistant
                      ? (attachmentId) => onRegenerateAssistant(message.id, attachmentId)
                      : undefined
                  }
                />
              ) : null}
              {message.status === "pending" && message.streamLabel ? (
                <div className="inline-flex items-center gap-2 pl-0.5 text-[11.5px] leading-5 text-muted-foreground sm:text-[12px]">
                  <span
                    ref={streamLabelRef}
                    data-text={message.streamLabel}
                    data-testid="agent-streaming-label"
                    className={cn(
                      "font-medium tracking-[0.01em]",
                      isActiveAssistantExecution && "agent-status-shimmer-text",
                      "drop-shadow-[0_0_10px_rgba(255,255,255,0.05)]",
                    )}
                    style={isActiveAssistantExecution ? shimmerSyncStyle : undefined}
                  >
                    {message.streamLabel}
                  </span>
                  <span className="inline-flex gap-1">
                    <span
                      className={cn(
                        "h-1 w-1 rounded-full bg-foreground/28",
                        isActiveAssistantExecution && "animate-dot-pulse-0",
                      )}
                    />
                    <span
                      className={cn(
                        "h-1 w-1 rounded-full bg-foreground/22",
                        isActiveAssistantExecution && "animate-dot-pulse-1",
                      )}
                    />
                    <span
                      className={cn(
                        "h-1 w-1 rounded-full bg-foreground/16",
                        isActiveAssistantExecution && "animate-dot-pulse-2",
                      )}
                    />
                  </span>
                </div>
              ) : null}
              {artifactPanel ? <div className="w-full min-w-0">{artifactPanel}</div> : null}
              {onAssistantFeedback ? (
                <div className="flex items-center gap-px pl-0.5 opacity-[0.85] transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                  <button
                    type="button"
                    title="好"
                    aria-label="评价为好"
                    aria-pressed={message.feedback === "up"}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                      message.feedback === "up"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() =>
                      onAssistantFeedback(message.id, message.feedback === "up" ? null : "up")
                    }
                  >
                    <ThumbsUp className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title="不好"
                    aria-label="评价为不好"
                    aria-pressed={message.feedback === "down"}
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                      message.feedback === "down"
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() =>
                      onAssistantFeedback(message.id, message.feedback === "down" ? null : "down")
                    }
                  >
                    <ThumbsDown className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  {onRegenerateAssistant && !hideAssistantRegenerateForMedia ? (
                    <button
                      type="button"
                      title="重新生成"
                      aria-label="重新生成此条回复"
                      disabled={Boolean(editsDisabled)}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                        editsDisabled
                          ? "cursor-not-allowed text-muted-foreground/40"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() => {
                        if (editsDisabled) return;
                        void onRegenerateAssistant(message.id);
                      }}
                    >
                      <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {inlineProgress ? (
                <OutlineProgressInline
                  progress={inlineProgress}
                  collapsed={inlineProgressCollapsed}
                  onToggleCollapse={() => setInlineProgressCollapsed((v) => !v)}
                  shimmerStyle={shimmerSyncStyle}
                  progressStatusRef={progressStatusRef}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "group relative flex max-w-[min(100%,840px)] justify-end sm:max-w-[min(94%,780px)]",
            pinUserActionsToBubbleBottom ? "items-end" : "items-center",
          )}
          onMouseEnter={showUserActions ? revealUserActionRail : undefined}
          onMouseLeave={showUserActions ? scheduleHideUserActionRail : undefined}
        >
          {editing ? (
            <div
              className={cn(
                "pointer-events-none absolute right-full mr-1 flex select-none items-center gap-px pr-0.5 opacity-0",
                pinUserActionsToBubbleBottom ? "bottom-0" : "top-1/2 -translate-y-1/2",
              )}
              aria-hidden
            >
              <span className="h-8 w-8" />
              <span className="h-8 w-8" />
            </div>
          ) : showUserActions ? (
            <div
              className={cn(
                "pointer-events-none absolute right-full mr-1 flex items-center gap-px pr-0.5 text-muted-foreground opacity-[0.85] transition-opacity sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100",
                userActionRailVisible && "pointer-events-auto opacity-[0.85] sm:opacity-100",
                pinUserActionsToBubbleBottom ? "bottom-0" : "top-1/2 -translate-y-1/2",
              )}
              onMouseEnter={revealUserActionRail}
              onMouseLeave={scheduleHideUserActionRail}
            >
              <button
                type="button"
                title="复制"
                aria-label="复制消息"
                className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleCopyUserMessage}
              >
                <Copy className="h-4 w-4" strokeWidth={1.75} />
              </button>
              {showUserEdit ? (
                <button
                  type="button"
                  title="编辑并从此条重新生成"
                  aria-label="编辑并从此条重新生成"
                  className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted hover:text-foreground"
                  onClick={beginUserEdit}
                >
                  <PencilLine className="h-4 w-4" strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          ) : null}
          <div
            className={cn(
              "flex min-w-0 flex-col items-end",
              !editing && isFullAutoProxyMessage ? "gap-1.5" : null,
            )}
          >
            {!editing && isFullAutoProxyMessage ? (
              <span
                data-full-auto-proxy-badge="true"
                className="inline-flex min-w-fit items-center self-end whitespace-nowrap rounded-full border border-[rgba(118,146,255,0.42)] bg-[rgba(118,146,255,0.14)] px-2.5 py-1 text-[11px] font-semibold leading-none tracking-[0.02em] text-[rgb(118,146,255)]"
              >
                AI代理
              </span>
            ) : null}
            <div
              ref={editing ? undefined : bubbleRef}
              data-home-agent-user-bubble={!editing ? "true" : undefined}
              className={cn(
                "min-w-0 self-end",
                editing
                  ? "border-0 bg-transparent p-0 shadow-none"
                  : "w-fit max-w-[min(84vw,700px)] rounded-[18px] border border-border bg-muted/40 px-4 py-2.5 text-[12.5px] leading-[1.62] text-foreground/80 sm:max-w-[min(76vw,624px)] sm:text-[13px] sm:leading-[1.68]",
                !editing && isAdaptiveSingleLineUserBubble
                  ? "inline-flex w-fit max-w-full items-center justify-center px-4 sm:max-w-full sm:px-5"
                  : null,
              )}
              style={
                editing && editLayout
                  ? { width: editLayout.width, minWidth: editLayout.width, maxWidth: editLayout.width }
                  : undefined
              }
            >
              {editing ? (
                <div className="flex w-full min-w-0 flex-col gap-2">
                  <Textarea
                    ref={editTextareaRef}
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={1}
                    spellCheck={false}
                    className={cn(
                      "box-border min-h-0 w-full resize-none overflow-hidden rounded-[22px] border px-3.5 py-2 text-[12.5px] leading-[1.62] text-foreground/80 shadow-none outline-none transition-[border-color,box-shadow] sm:text-[13px] sm:leading-[1.68]",
                      "border-primary/60 bg-muted/30 placeholder:text-muted-foreground",
                      "whitespace-pre-wrap break-words scrollbar-none",
                      "focus-visible:border-primary focus-visible:ring-0 focus-visible:ring-offset-0",
                    )}
                  />
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    <button
                      type="button"
                      className="text-[13px] font-medium text-primary transition-opacity hover:opacity-90"
                      onClick={() => {
                        endUserEdit();
                        setEditDraft(message.content);
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      title={canSubmitUserEdit ? "更新并从此条重新生成" : undefined}
                      disabled={!canSubmitUserEdit}
                      className={cn(
                        "rounded-full px-5 py-2 text-[13px] font-medium transition-colors",
                        "bg-muted",
                        canSubmitUserEdit
                          ? "text-primary hover:bg-muted/80"
                          : "cursor-not-allowed text-muted-foreground",
                      )}
                      onClick={() => {
                        if (!canSubmitUserEdit) return;
                        void onEditUserMessage?.(message.id, editDraft.trim());
                        endUserEdit();
                      }}
                    >
                      更新
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  data-full-auto-proxy-layout={isFullAutoProxyMessage ? "true" : undefined}
                  className={cn(
                    isFullAutoProxyMessage
                      ? "whitespace-nowrap"
                      : "space-y-1.5",
                  )}
                >
                  {message.content.trim() ? (
                    <div
                      data-full-auto-proxy-content={isFullAutoProxyMessage ? "true" : undefined}
                      className={cn(
                        isAdaptiveSingleLineUserBubble
                          ? "whitespace-nowrap text-center"
                          : "whitespace-pre-wrap break-words",
                        !isAdaptiveSingleLineUserBubble && isStructuredUserSelectionSummary ? "text-right" : null,
                      )}
                    >
                      {message.content}
                    </div>
                  ) : null}
                  <MessageAttachmentList
                    attachments={message.attachments}
                    allConversationImages={allConversationImages}
                    onRegenerateAttachment={
                      onRegenerateAssistant
                        ? (attachmentId) => onRegenerateAssistant(message.id, attachmentId)
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
});

const TIMELINE_INITIAL_VISIBLE = 80;
const TIMELINE_LOAD_MORE_STEP = 80;
const TIMELINE_AUTO_LOAD_TOP_THRESHOLD_PX = 120;

function ArtifactPanelFallback() {
  return (
    <div className="mt-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-[12px] text-muted-foreground">
      正在加载步骤面板…
    </div>
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  conversationId,
  messages,
  endRef,
  scrollContainerRef,
  streaming,
  suppressSyntheticStreamingMessage,
  hasFloatingDock,
  snapshot,
  workflowProgress,
  onArtifactAction,
  onSaveArtifactText,
  onRelationshipDiagramCollapsedChange,
  onEditUserMessage,
  onAssistantFeedback,
  onRegenerateAssistant,
  onCreationGuidePick,
  directBatchReviewTrigger,
  directSingleReviewTrigger,
  onRequestOlderHistory,
}: {
  conversationId?: string;
  messages: HomeAgentMessage[];
  endRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  streaming?: boolean;
  suppressSyntheticStreamingMessage?: boolean;
  hasFloatingDock?: boolean;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
    sourceSnapshot?: ConversationProjectSnapshot | null,
  ) => void;
  onSaveArtifactText?: (
    field: "creativePlan" | "structureTransform" | "characters" | "characterTransform" | "directoryRaw" | "outlines",
    label: string,
    text: string,
  ) => void | Promise<void>;
  onRelationshipDiagramCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
  onEditUserMessage?: (messageId: string, newContent: string) => void | Promise<void>;
  onAssistantFeedback?: (messageId: string, vote: "up" | "down" | null) => void;
  onRegenerateAssistant?: (messageId: string, attachmentId?: string) => void | Promise<void>;
  onCreationGuidePick?: (dimension: CreationGuideDimensionId, value: string, label: string) => void;
  directBatchReviewTrigger?: { count: number; targetMessageId: string };
  directSingleReviewTrigger?: { count: number; epNum: number; targetMessageId: string };
  onRequestOlderHistory?: () => Promise<boolean> | boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [visibleCount, setVisibleCount] = useState(TIMELINE_INITIAL_VISIBLE);
  const pendingScrollAnchorRef = useRef<{ previousScrollHeight: number; previousScrollTop: number } | null>(null);
  const olderHistoryRequestInFlightRef = useRef(false);

  const resolvedConversationId = conversationId ?? snapshot?.projectId ?? "__home-agent-conversation__";

  useEffect(() => {
    setVisibleCount(TIMELINE_INITIAL_VISIBLE);
    pendingScrollAnchorRef.current = null;
    olderHistoryRequestInFlightRef.current = false;
  }, [resolvedConversationId]);

  const latestTimelineMessage = messages.at(-1) ?? null;
  const hasLiveAssistantHostMessage =
    latestTimelineMessage?.role === "assistant" &&
    latestTimelineMessage.status === "pending";
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const syntheticStreamingMessage =
    streaming && !suppressSyntheticStreamingMessage && !hasLiveAssistantHostMessage
      ? ({
          id: "streaming-workflow-placeholder",
          role: "assistant" as const,
          content: "正在生成，请稍候…",
          createdAt: new Date().toISOString(),
          status: "pending" as const,
          streamLabel: lastUserMessage?.content?.trim()
            ? `Agent 正在处理「${truncateCopy(lastUserMessage.content.trim(), 28)}」`
            : "Agent 正在生成内容",
        })
      : null;

  const artifactMap = useMemo(() => {
    if (!snapshot) return new Map<string, ConversationProjectSnapshot["artifacts"][number]>();
    return new Map(snapshot.artifacts.map((a) => [a.id, a]));
  }, [snapshot]);
  const liveScriptProgressArtifact = useMemo(
    () => resolveLiveScriptProgressArtifact(snapshot),
    [snapshot],
  );

  const timelineMessages = messages;

  // 收集会话中所有已生成图片（有 previewUrl 的），用于跨消息灯箱导航
  const allConversationImages = useMemo(() => {
    const imgs: import("@/lib/agent/chat-attachments").ChatAttachment[] = [];
    for (const msg of timelineMessages) {
      if (!msg.attachments?.length) continue;
      for (const att of msg.attachments) {
        if (att.kind === "image" && att.previewUrl && !att.pending) {
          imgs.push(att);
        }
      }
    }
    return imgs;
  }, [timelineMessages]);

  const hasMoreHistory = timelineMessages.length > visibleCount;
  const visibleMessages = hasMoreHistory ? timelineMessages.slice(-visibleCount) : timelineMessages;
  const indexOffset = timelineMessages.length - visibleMessages.length;
  const requestVisibleCountExpansion = useCallback(() => {
    const scrollHost = scrollContainerRef?.current;
    if (scrollHost) {
      pendingScrollAnchorRef.current = {
        previousScrollHeight: scrollHost.scrollHeight,
        previousScrollTop: scrollHost.scrollTop,
      };
    } else {
      pendingScrollAnchorRef.current = null;
    }
    setVisibleCount((current) => Math.min(timelineMessages.length, current + TIMELINE_LOAD_MORE_STEP));
  }, [scrollContainerRef, timelineMessages.length]);

  useLayoutEffect(() => {
    const scrollHost = scrollContainerRef?.current;
    const pendingAnchor = pendingScrollAnchorRef.current;
    if (!scrollHost || !pendingAnchor) return;

    pendingScrollAnchorRef.current = null;
    const nextScrollHeight = scrollHost.scrollHeight;
    const scrollDelta = nextScrollHeight - pendingAnchor.previousScrollHeight;
    if (scrollDelta <= 0) return;
    scrollHost.scrollTop = pendingAnchor.previousScrollTop + scrollDelta;
  }, [scrollContainerRef, visibleMessages.length]);

  useEffect(() => {
    const scrollHost = scrollContainerRef?.current;
    if (!scrollHost) return;

    const maybeLoadOlderHistory = () => {
      if (scrollHost.scrollTop > TIMELINE_AUTO_LOAD_TOP_THRESHOLD_PX) return;
      if (hasMoreHistory) {
        requestVisibleCountExpansion();
        return;
      }
      if (!onRequestOlderHistory || olderHistoryRequestInFlightRef.current) return;
      olderHistoryRequestInFlightRef.current = true;
      void Promise.resolve(onRequestOlderHistory())
        .then((didHydrate) => {
          if (didHydrate) {
            pendingScrollAnchorRef.current = {
              previousScrollHeight: scrollHost.scrollHeight,
              previousScrollTop: scrollHost.scrollTop,
            };
            setVisibleCount((current) => current + TIMELINE_LOAD_MORE_STEP);
          }
        })
        .finally(() => {
          olderHistoryRequestInFlightRef.current = false;
        });
    };

    scrollHost.addEventListener("scroll", maybeLoadOlderHistory, { passive: true });
    return () => {
      scrollHost.removeEventListener("scroll", maybeLoadOlderHistory);
    };
  }, [hasMoreHistory, onRequestOlderHistory, requestVisibleCountExpansion, scrollContainerRef]);

  return (
    <div
      className={cn(
        "flex min-h-[calc(100vh-254px)] flex-col justify-end overflow-visible",
      )}
    >
      <div className="space-y-3.5 overflow-x-visible overflow-y-visible pb-5 pt-2 sm:space-y-4 sm:pb-6 sm:pt-3">
        {hasMoreHistory && (
          <div className="flex justify-center py-2">
            <button
              onClick={requestVisibleCountExpansion}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-md hover:bg-muted"
            >
              加载更多历史消息（还有 {timelineMessages.length - visibleCount} 条）
            </button>
          </div>
        )}
        {visibleMessages.map((message, index) => {
          const globalIndex = index + indexOffset;
          const isLatestAssistantMessage =
            message.role === "assistant" && globalIndex === timelineMessages.length - 1;
          const shouldUseLiveScriptProgress =
            Boolean(workflowProgress) && isLatestAssistantMessage;
          const frozenOrReferencedArtifacts = message.role === "assistant"
            ? (
                message.artifactSnapshots?.length
                  ? message.artifactSnapshots.map((artifact) => cloneConversationArtifact(artifact))
                  : [...new Set(message.artifactIds ?? [])].flatMap((id) => {
                      const artifact = artifactMap.get(id);
                      return artifact ? [cloneConversationArtifact(artifact)] : [];
                    })
              )
            : [];
          const scopedArtifacts = scopeAssistantScriptArtifactsToMessage(
            frozenOrReferencedArtifacts,
            message.content,
            inferArtifactPanelProjectKind(frozenOrReferencedArtifacts, snapshot) ?? snapshot?.projectKind,
          );
          const stageScopedArtifacts = filterArtifactsForSnapshotStage(scopedArtifacts, snapshot);
          const messageArtifacts = shouldUseLiveScriptProgress
            ? mergeLiveScriptProgressArtifact(stageScopedArtifacts, liveScriptProgressArtifact)
            : stageScopedArtifacts;
          const isDirectReviewTarget =
            directBatchReviewTrigger?.targetMessageId === message.id ||
            directSingleReviewTrigger?.targetMessageId === message.id;
          const shouldPassBatchReviewTrigger =
            isLatestAssistantMessage && directBatchReviewTrigger?.targetMessageId === message.id;
          const shouldPassSingleReviewTrigger =
            isLatestAssistantMessage && directSingleReviewTrigger?.targetMessageId === message.id;
          const reviewWorkspaceOnly =
            isDirectReviewWorkspaceMessage(message) || isDirectReviewTarget;

          const filteredSnapshot = buildHistoricalArtifactPanelSnapshot({
            artifacts: messageArtifacts,
            snapshot,
            message,
          });

          return (
            <ConversationMessageRow
              key={message.id}
              message={message}
              shouldAnimate={globalIndex >= Math.max(timelineMessages.length - 4, 0)}
              reduceMotion={Boolean(reduceMotion)}
              editsDisabled={Boolean(streaming)}
              onEditUserMessage={onEditUserMessage}
              onAssistantFeedback={onAssistantFeedback}
              onRegenerateAssistant={
                message.role === "assistant" && globalIndex === timelineMessages.length - 1
                  ? onRegenerateAssistant
                  : undefined
              }
              assistantAvatarGlowing={
                Boolean(streaming) &&
                message.role === "assistant" &&
                globalIndex === timelineMessages.length - 1
              }
              autoOpenCreationGuidePicker={
                message.role === "assistant" &&
                globalIndex === timelineMessages.length - 1 &&
                !streaming
              }
              onCreationGuidePick={onCreationGuidePick}
              inlineProgress={
                workflowProgress &&
                message.role === "assistant" &&
                globalIndex === timelineMessages.length - 1 &&
                !syntheticStreamingMessage
                  ? workflowProgress
                  : null
              }
              artifactPanel={
                filteredSnapshot ? (
                  <React.Suspense fallback={<ArtifactPanelFallback />}>
                    <LazyScriptArtifactPanel
                      snapshot={filteredSnapshot}
                      onArtifactAction={
                        onArtifactAction
                          ? (value, label, input) =>
                              onArtifactAction(value, label, input, filteredSnapshot)
                          : undefined
                      }
                      onSaveArtifactText={onSaveArtifactText}
                      onRelationshipDiagramCollapsedChange={onRelationshipDiagramCollapsedChange}
                      directBatchReviewTrigger={
                        shouldPassBatchReviewTrigger ? directBatchReviewTrigger : undefined
                      }
                      directSingleReviewTrigger={
                        shouldPassSingleReviewTrigger ? directSingleReviewTrigger : undefined
                      }
                      reviewWorkspaceOnly={reviewWorkspaceOnly}
                    />
                  </React.Suspense>
                ) : undefined
              }
              allConversationImages={
                messageHasConversationLightboxImages(message) ? allConversationImages : undefined
              }
            />
          );
        })}
        {syntheticStreamingMessage ? (
          (() => {
            const liveProgressSnapshot =
              workflowProgress && liveScriptProgressArtifact && snapshot
                ? { ...snapshot, artifacts: [liveScriptProgressArtifact] }
                : null;
            return (
              <ConversationMessageRow
                key={syntheticStreamingMessage.id}
                message={syntheticStreamingMessage}
                shouldAnimate
                reduceMotion={Boolean(reduceMotion)}
                editsDisabled
                assistantAvatarGlowing
                inlineProgress={workflowProgress ?? null}
                artifactPanel={
                  liveProgressSnapshot ? (
                    <React.Suspense fallback={<ArtifactPanelFallback />}>
                      <LazyScriptArtifactPanel
                        snapshot={liveProgressSnapshot}
                        onArtifactAction={
                          onArtifactAction
                            ? (value, label, input) =>
                                onArtifactAction(value, label, input, liveProgressSnapshot)
                            : undefined
                        }
                        onSaveArtifactText={onSaveArtifactText}
                        onRelationshipDiagramCollapsedChange={onRelationshipDiagramCollapsedChange}
                        directBatchReviewTrigger={undefined}
                        directSingleReviewTrigger={undefined}
                        reviewWorkspaceOnly={false}
                      />
                    </React.Suspense>
                  ) : undefined
                }
              />
            );
          })()
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
});

const BackgroundTaskDock = memo(function BackgroundTaskDock({
  tasks,
  onStopTask,
  floating = false,
}: {
  tasks: RuntimeTask[];
  onStopTask: (taskId: string) => void;
  floating?: boolean;
}) {
  const { visibleTasks, collapsedTerminalTasks, runningCount } = useMemo(() => {
    const sortedTasks = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    const activeTasks = sortedTasks.filter((task) => !isTerminalTask(task));
    const terminalTasks = sortedTasks.filter((task) => isTerminalTask(task));
    const activeLimit = Math.min(activeTasks.length, 3);
    const terminalLimit = Math.max(0, 4 - activeLimit);

    return {
      visibleTasks: [...activeTasks.slice(0, 3), ...terminalTasks.slice(0, terminalLimit)].slice(0, 4),
      collapsedTerminalTasks: terminalTasks.slice(terminalLimit),
      runningCount: tasks.filter((task) => task.status === "running").length,
    };
  }, [tasks]);

  // 默认折叠：无进行中任务时自动收起
  const [collapsed, setCollapsed] = React.useState(() => runningCount === 0);

  // 当前正在执行的工作流步骤标签
  const [activeStep, setActiveStep] = React.useState<string | null>(null);

  // 有新的运行中任务时自动展开
  React.useEffect(() => {
    if (runningCount > 0) setCollapsed(false);
  }, [runningCount]);

  // 监听工作流进度事件，实时显示当前步骤
  React.useEffect(() => {
    if (runningCount === 0) {
      setActiveStep(null);
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; status: string; content: string }>).detail;
      if (detail.status === "start" || detail.status === "progress" || detail.status === "update") {
        setActiveStep(detail.content.replace(/^Agent 正在执行[：:]\s*/, ""));
      } else if (detail.status === "complete" || detail.status === "error") {
        setActiveStep(null);
      }
    };
    window.addEventListener("agent:workflow-progress", handler);
    return () => window.removeEventListener("agent:workflow-progress", handler);
  }, [runningCount]);

  const headerLabel = runningCount > 0 ? `${runningCount} 项处理中` : `${tasks.length} 项任务`;

  if (collapsed) {
    return (
      <div className={cn(floating ? "w-full max-w-[280px]" : "mb-2")}>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-1.5 rounded-full border border-border bg-background/80 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-border hover:text-foreground/70"
        >
          <Bot className="h-3 w-3" />
          <span>Agent · {headerLabel}</span>
          <ChevronDown className="h-3 w-3 rotate-180" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", floating ? "w-full max-w-[280px]" : "mb-2")}>
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
          <Bot className="h-3 w-3" />
          Agent 任务
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-muted-foreground"
        >
          <span>{headerLabel}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
      <div className="space-y-0.5">
        {visibleTasks.map((task) => (
          <div key={task.id} className="rounded-[12px] border border-border bg-muted/20 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[9px] tracking-[0.06em]",
                  taskStatusClass(task.status),
                )}
              >
                {taskStatusLabel(task.status)}
              </div>
              <div className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/80">
                {parseTaskHeading(task.prompt) ?? truncateCopy(task.prompt, 60)}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {isTerminalTask(task) ? (
                  <span className="text-[9.5px] text-muted-foreground/40">{formatTaskDockTimestamp(task.updatedAt)}</span>
                ) : null}
                {task.status === "running" ? (
                  <button
                    type="button"
                    onClick={() => onStopTask(task.id)}
                    className="rounded-full px-1.5 py-0.5 text-[9.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  >
                    停止
                  </button>
                ) : null}
              </div>
            </div>
            {task.status === "running" && activeStep ? (
              <div className="mt-1 truncate text-[9.5px] text-muted-foreground/70">{activeStep}</div>
            ) : null}
          </div>
        ))}
        {collapsedTerminalTasks.length ? (
          <div className="px-2.5 py-1 text-[9.5px] text-muted-foreground/50">
            另有 {collapsedTerminalTasks.length} 条较早记录
          </div>
        ) : null}
      </div>
    </div>
  );
});

const ActiveConversationViewport = memo(function ActiveConversationViewport({
  conversationId,
  messages,
  tasks,
  onStopTask,
  endRef,
  scrollContainerRef,
  streaming,
  suppressSyntheticStreamingMessage,
  trackClassName,
  snapshot,
  workflowProgress,
  onArtifactAction,
  onSaveArtifactText,
  onRelationshipDiagramCollapsedChange,
  onEditUserMessage,
  onAssistantFeedback,
  onRegenerateAssistant,
  onCreationGuidePick,
  directBatchReviewTrigger,
  directSingleReviewTrigger,
  onRequestOlderHistory,
}: {
  conversationId?: string;
  messages: HomeAgentMessage[];
  tasks: RuntimeTask[];
  onStopTask: (taskId: string) => void;
  endRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  streaming: boolean;
  suppressSyntheticStreamingMessage?: boolean;
  trackClassName: string;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
    sourceSnapshot?: ConversationProjectSnapshot | null,
  ) => void;
  onSaveArtifactText?: (
    field: "creativePlan" | "structureTransform" | "characters" | "characterTransform" | "directoryRaw" | "outlines",
    label: string,
    text: string,
  ) => void | Promise<void>;
  onRelationshipDiagramCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
  onEditUserMessage?: (messageId: string, newContent: string) => void | Promise<void>;
  onAssistantFeedback?: (messageId: string, vote: "up" | "down" | null) => void;
  onRegenerateAssistant?: (messageId: string, attachmentId?: string) => void | Promise<void>;
  onCreationGuidePick?: (dimension: CreationGuideDimensionId, value: string, label: string) => void;
  directBatchReviewTrigger?: { count: number; targetMessageId: string };
  directSingleReviewTrigger?: { count: number; epNum: number; targetMessageId: string };
  onRequestOlderHistory?: () => Promise<boolean> | boolean;
}) {
  const showFloatingTaskDock = false;

  return (
    <div className={cn("relative mx-auto w-full flex-1 overflow-visible", trackClassName)}>
      <ConversationTimeline
        conversationId={conversationId}
        messages={messages}
        endRef={endRef}
        scrollContainerRef={scrollContainerRef}
        streaming={streaming}
        suppressSyntheticStreamingMessage={suppressSyntheticStreamingMessage}
        hasFloatingDock={showFloatingTaskDock}
        snapshot={snapshot}
        workflowProgress={workflowProgress}
        onArtifactAction={onArtifactAction}
        onSaveArtifactText={onSaveArtifactText}
        onRelationshipDiagramCollapsedChange={onRelationshipDiagramCollapsedChange}
        onEditUserMessage={onEditUserMessage}
        onAssistantFeedback={onAssistantFeedback}
        onRegenerateAssistant={onRegenerateAssistant}
        onCreationGuidePick={onCreationGuidePick}
        directBatchReviewTrigger={directBatchReviewTrigger}
        directSingleReviewTrigger={directSingleReviewTrigger}
        onRequestOlderHistory={onRequestOlderHistory}
      />
    </div>
  );
});

const ActiveComposerDock = memo(function ActiveComposerDock({
  composer,
  trackClassName,
  hasUnreadMessage = false,
  compactBottomReserve = false,
}: {
  composer: ReactNode;
  trackClassName: string;
  hasUnreadMessage?: boolean;
  compactBottomReserve?: boolean;
}) {
  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = React.useState(0);

  React.useLayoutEffect(() => {
    if (!compactBottomReserve) return;
    const dock = dockRef.current;
    if (!dock) return;

    const updateDockHeight = () => {
      const nextHeight = Math.ceil(dock.getBoundingClientRect().height);
      setDockHeight((currentHeight) =>
        currentHeight > 0 && Math.abs(currentHeight - nextHeight) < 4 ? currentHeight : nextHeight,
      );
    };
    updateDockHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateDockHeight);
      return () => window.removeEventListener("resize", updateDockHeight);
    }

    const observer = new ResizeObserver(updateDockHeight);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [compactBottomReserve]);

  return (
    <>
      {/* Keep composer always docked to viewport bottom. */}
      <div
        ref={dockRef}
        className="pointer-events-none fixed bottom-0 left-0 right-0 z-20 px-3.5 pb-[calc(10px+env(safe-area-inset-bottom))] pt-3 transition-[left,padding-left] duration-300 motion-reduce:transition-none sm:px-4 md:px-8 lg:left-[var(--home-sidebar-offset)]"
        style={{
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "left,padding-left",
        }}
      >
        <div className="composer-dock-fade pointer-events-none absolute inset-x-0 bottom-0 h-28" />
        <div className={cn("pointer-events-auto relative mx-auto w-full", trackClassName)}>
          <AnimatePresence>
            {hasUnreadMessage ? (
              <motion.div
                aria-hidden
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.18 }}
                className="home-agent-unread-composer-line pointer-events-none absolute inset-x-4 -top-2 h-[2px] rounded-full motion-reduce:animate-none"
              />
            ) : null}
          </AnimatePresence>
          {composer}
        </div>
      </div>
      {/* Reserve room so the latest message can settle above the visual center. */}
      <div
        aria-hidden
        className={compactBottomReserve ? "h-[176px]" : "h-[max(224px,52vh)]"}
        style={compactBottomReserve && dockHeight > 0 ? { height: dockHeight } : undefined}
      />
    </>
  );
});

const FullAutoProgressRail = memo(function FullAutoProgressRail({
  run,
  onStop,
}: {
  run: FullAutoRunState;
  onStop?: () => void;
}) {
  const steps = run.plan
    ? buildFullAutoProgressDisplaySteps(run.plan, Math.max(0, run.currentStepIndex), run.status)
    : [];

  if (!steps.length) return null;

  const frameClassName =
    run.status === "stopped"
      ? "home-agent-full-auto-frame-stopped"
      : "home-agent-full-auto-frame-active";

  return (
    <div className="pointer-events-auto w-[210px] self-end">
      <div
        className={cn(
          "rounded-[13px] bg-background/88 px-2.5 py-3 backdrop-blur-xl",
          frameClassName,
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">全自动执行</span>
        </div>
        <div className="max-h-[calc(100vh-4.75rem)] space-y-1.5 overflow-y-auto pr-0.5">
          {steps.map((step, index) => {
            const done = step.status === "completed" || run.status === "completed";
            const active =
              step.current &&
              run.status !== "completed" &&
              step.status !== "stopped" &&
              step.status !== "failed";
            const stopped = step.status === "stopped";
            const showStepState = step.current && run.status !== "completed";
            const stepStateLabel =
              run.status === "collecting"
                ? "待执行"
                : run.status === "stopped"
                ? "已停止"
                : run.status === "retrying"
                  ? "重试中"
                  : run.status === "paused"
                    ? "已暂停"
                    : run.status === "failed"
                      ? "失败"
                      : "执行中";
            return (
              <div key={step.id} className="grid grid-cols-[14px_1fr] gap-2.5">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "mt-0.5 h-2.5 w-2.5 rounded-full border transition-colors",
                      stopped
                        ? "border-red-400 bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.55)]"
                        : done
                        ? "border-primary bg-primary"
                        : active
                          ? "animate-pulse border-[rgb(118,146,255)] bg-[rgb(118,146,255)] shadow-[0_0_18px_rgba(118,146,255,0.92)]"
                          : "border-border bg-muted",
                    )}
                  />
                  {index < steps.length - 1 ? (
                    <span className={cn("mt-1 h-4 w-px", done ? "bg-primary/55" : "bg-border")} />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className={cn(
                        "min-w-0 flex-1 text-[13.5px] font-medium leading-5 whitespace-normal break-words",
                        active ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                    </div>
                    {showStepState ? (
                      <div className="shrink-0 pt-[1px] text-[12px] font-semibold leading-4 text-[rgb(118,146,255)] drop-shadow-[0_0_10px_rgba(118,146,255,0.5)]">
                        {stepStateLabel}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

const FullAutoMessageChecklistPanel = memo(function FullAutoMessageChecklistPanel({
  run,
  collapsed,
  onToggleCollapsed,
}: {
  run: FullAutoRunState;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const items = useMemo(
    () =>
      run.plan
        ? buildFullAutoVisualChecklist(run.plan, Math.max(0, run.currentStepIndex), run.status)
        : [],
    [run.currentStepIndex, run.plan, run.status],
  );

  const completedCount = items.filter((item) => item.status === "completed").length;
  const focusItemId = useMemo(() => {
    if (!run.plan) return null;
    if (run.status === "collecting") {
      const choiceKeys = Object.keys(run.plan.stageStrategies ?? {}).filter(
        (key) => key !== "videoGeneration" && key !== "defaultVideoMode" && key !== "defaultVideoResolution",
      );
      const latestChoiceKey = choiceKeys[choiceKeys.length - 1];
      return latestChoiceKey ? `full-auto-checklist-item-choice:${latestChoiceKey}` : null;
    }

    const currentStep = run.plan.steps[Math.max(0, run.currentStepIndex)];
    if (currentStep) return `full-auto-checklist-item-step:${currentStep.id}`;

    const latestCompleted = [...items].reverse().find((item) => item.status === "completed");
    return latestCompleted ? `full-auto-checklist-item-${latestCompleted.id}` : null;
  }, [items, run.currentStepIndex, run.plan, run.status]);

  useEffect(() => {
    if (collapsed || !focusItemId) return undefined;
    const target = itemRefs.current.get(focusItemId);
    if (!target) return undefined;

    const frame = window.requestAnimationFrame(() => {
      target.scrollIntoView({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [collapsed, focusItemId, reduceMotion]);

  if (!items.length) return null;

  return (
    <aside className="pointer-events-none fixed left-3.5 top-4 z-30 hidden lg:block lg:left-[calc(var(--home-sidebar-offset,0px)+2rem)]">
      <motion.div
        layout={!reduceMotion}
        data-testid="full-auto-message-checklist-panel"
        className="pointer-events-auto w-[284px] overflow-hidden rounded-[18px] border border-white/10 bg-[#101522] shadow-[0_24px_60px_rgba(0,0,0,0.22)]"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开待发消息清单" : "收起待发消息清单"}
          data-testid="full-auto-message-checklist-toggle"
          className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-white/[0.03]"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-white/92">执行清单</div>
            <div className="pt-0.5 text-[10.5px] text-white/42">
              共 {items.length} 条 · 已完成 {completedCount} 条
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-white/72 transition-transform", collapsed ? "" : "rotate-180")}
          />
        </button>
        <AnimatePresence initial={false}>
          {!collapsed ? (
            <motion.div
              key="full-auto-checklist-body"
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={reduceMotion ? { opacity: 1, height: "auto" } : { opacity: 1, height: "auto" }}
              exit={reduceMotion ? { opacity: 0, height: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduceMotion ? 0.12 : 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="border-t border-white/6"
            >
              <div
                ref={scrollViewportRef}
                className="scrollbar-none max-h-[calc(50vh-3.5rem)] space-y-1.5 overflow-y-auto px-2.5 pb-2.5 pt-2"
                data-testid="full-auto-message-checklist"
              >
                <AnimatePresence initial={false}>
                  {items.map((item, index) => {
                    const completed = item.status === "completed";
                    const selected = item.status === "selected";
                    const active = item.status === "running" || item.status === "retrying";
                    const stopped = item.status === "stopped" || item.status === "failed";
                    const completedChoice = completed && item.kind === "choice";
                    const completedStep = completed && item.kind === "step";

                    return (
                      <motion.div
                        key={item.id}
                        layout={!reduceMotion}
                        initial={reduceMotion ? false : { opacity: 0, y: -12, filter: "blur(6px)" }}
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, filter: "blur(6px)" }}
                        transition={{ duration: reduceMotion ? 0.12 : 0.24, ease: [0.22, 1, 0.36, 1] }}
                        >
                        <div
                          ref={(node) => {
                            const mapKey = `full-auto-checklist-item-${item.id}`;
                            if (node) {
                              itemRefs.current.set(mapKey, node);
                            } else {
                              itemRefs.current.delete(mapKey);
                            }
                          }}
                          data-testid={`full-auto-checklist-item-${item.id}`}
                          data-full-auto-checklist-status={item.status}
                          className={cn(
                            "grid grid-cols-[18px_1fr] gap-2 rounded-[11px] border px-2.5 py-[7px]",
                            selected
                              ? "border-[rgba(88,150,255,0.18)] bg-[rgba(74,118,214,0.12)]"
                              : completedChoice
                                ? "border-[rgba(88,150,255,0.09)] bg-[rgba(56,82,130,0.09)]"
                              : stopped
                                ? "border-[rgba(255,120,132,0.18)] bg-[rgba(255,120,132,0.07)]"
                                : active
                                  ? "border-[rgba(132,139,255,0.2)] bg-[rgba(124,132,255,0.1)] shadow-[0_0_0_1px_rgba(124,132,255,0.08)]"
                                  : completedStep
                                    ? "border-white/6 bg-white/[0.025]"
                                    : "border-white/8 bg-white/[0.035]",
                          )}
                        >
                          <div className="flex items-start justify-center pt-[1px]">
                            <span
                              className={cn(
                                "flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[9px] font-semibold",
                                completedChoice
                                  ? "border-[rgba(88,150,255,0.12)] bg-[rgba(56,82,130,0.12)] text-[rgb(126,154,212)]"
                                  : completedStep
                                    ? "border-white/10 bg-white/[0.04] text-white/36"
                                  : selected
                                    ? "border-[rgba(88,150,255,0.24)] bg-[rgba(74,118,214,0.16)] text-[rgb(177,208,255)]"
                                    : stopped
                                      ? "border-[rgba(255,120,132,0.2)] bg-[rgba(255,120,132,0.12)] text-[rgb(255,177,184)]"
                                      : active
                                        ? "border-[rgba(138,145,255,0.24)] bg-[rgba(138,145,255,0.14)] text-[rgb(203,208,255)]"
                                        : "border-white/10 bg-white/[0.04] text-white/56",
                              )}
                            >
                              {completed ? <Check className="h-3.5 w-3.5" /> : index + 1}
                            </span>
                          </div>
                          <div className="min-w-0 flex items-center gap-2">
                            <div
                              className={cn(
                                "min-w-0 flex-1 truncate text-[12.75px] font-medium leading-5 transition-colors",
                                completedChoice
                                  ? "text-[rgb(124,146,196)]"
                                  : completedStep
                                    ? "text-white/32 line-through decoration-white/24"
                                  : selected
                                    ? "text-[rgb(226,236,255)]"
                                    : active
                                      ? "text-white/96"
                                      : stopped
                                        ? "text-white/56"
                                        : "text-white/76",
                              )}
                            >
                              {item.label}
                            </div>
                            <div
                              className={cn(
                                "shrink-0 text-[9.5px]",
                                item.kind === "choice" ? "text-white/38" : "text-[rgb(118,146,255)]",
                              )}
                            >
                              {item.kind === "choice" ? "选项" : "代理"}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </aside>
  );
});

function sortByIsoDesc<T>(items: T[], getIso: (item: T) => string | undefined): T[] {
  return [...items].sort((left, right) => String(getIso(right) || "").localeCompare(String(getIso(left) || "")));
}

function formatSegmentQaRoute(status: string | undefined): string {
  switch (status) {
    case "pass":
      return "通过";
    case "local_repair":
      return "局部修复";
    case "regenerate":
      return "整段重生";
    case "escalate":
      return "转人工";
    default:
      return "待确认";
  }
}

function formatReferenceQaStatus(status: string | undefined): string {
  switch (status) {
    case "ready":
      return "通过";
    case "retryable":
      return "待重试";
    case "blocked":
      return "阻塞";
    case "exhausted":
      return "转人工";
    default:
      return "待处理";
  }
}

function formatQaTierLabel(tier: string | undefined): string {
  switch (tier) {
    case "golden":
      return "黄金样本";
    case "usable":
      return "可交付";
    case "borderline":
      return "临界";
    case "fail":
      return "未达标";
    default:
      return "";
  }
}

function localizeQaFeedbackText(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/\bsubmit\s+prompt\b/gi, "提交提示词")
    .replace(/\bprompt\b/gi, "提示词")
    .replace(/\breview\b/gi, "复核")
    .replace(/\bQA\b/g, "质检");
}

function resolveQaReviewTitle(
  snapshot: ConversationProjectSnapshot,
  targetId: string,
): string {
  const matched = snapshot.memory?.reviewQueue?.find((item) => item.targetIds.includes(targetId));
  if (matched?.title?.trim()) return matched.title.trim();
  if (targetId.startsWith("reference-character:")) {
    return `角色参考 · ${targetId.slice("reference-character:".length)}`;
  }
  if (targetId.startsWith("reference-scene:")) {
    return `场景参考 · ${targetId.slice("reference-scene:".length)}`;
  }
  return targetId;
}

const VideoQaFeedbackRail = memo(function VideoQaFeedbackRail({
  snapshot,
  stretchToColumn = false,
}: {
  snapshot?: ConversationProjectSnapshot | null;
  stretchToColumn?: boolean;
}) {
  const qaModel = useMemo(() => {
    if (!snapshot || snapshot.projectKind !== "video") return null;

    const latestSegmentAudit = sortByIsoDesc(
      snapshot.memory?.videoAuditPackets?.filter((packet) => packet.targetType === "segment") || [],
      (packet) => packet.updatedAt || packet.createdAt,
    )[0];
    const referenceItems = sortByIsoDesc(
      Object.values(snapshot.memory?.automationState?.referenceTargets || {}).filter(
        (item) => item.lastQaAt || item.status === "retryable" || item.status === "exhausted" || item.status === "blocked",
      ),
      (item) => item.lastQaAt || item.lastTriedAt || item.lastSucceededAt,
    ).slice(0, 3);
    const pendingReviewCount =
      snapshot.memory?.reviewQueue?.filter((item) => item.status === "pending").length ?? 0;
    const activeRepairCount =
      snapshot.memory?.videoRepairTasks?.filter((item) => item.status === "pending" || item.status === "exhausted").length ?? 0;

    if (!latestSegmentAudit && !referenceItems.length && pendingReviewCount === 0 && activeRepairCount === 0) {
      return null;
    }

    return {
      latestSegmentAudit,
      referenceItems,
      pendingReviewCount,
      activeRepairCount,
    };
  }, [snapshot]);

  const [collapsed, setCollapsed] = useState(false);
  const qaUpdateFingerprint = [
    qaModel?.latestSegmentAudit?.updatedAt || qaModel?.latestSegmentAudit?.createdAt || "",
    qaModel?.referenceItems[0]?.lastQaAt || qaModel?.referenceItems[0]?.lastTriedAt || "",
    qaModel?.pendingReviewCount ?? 0,
    qaModel?.activeRepairCount ?? 0,
  ].join("|");

  useEffect(() => {
    if (!qaModel) return;
    setCollapsed(false);
  }, [qaUpdateFingerprint, qaModel]);

  if (!snapshot || !qaModel) return null;

  const latestSegmentLabel = qaModel.latestSegmentAudit?.segmentLabel?.trim() || "最新结果";
  const latestSegmentRoute = qaModel.latestSegmentAudit
    ? formatSegmentQaRoute(qaModel.latestSegmentAudit.status)
    : "";
  const railPrimarySummary = qaModel.latestSegmentAudit
    ? `片段 ${latestSegmentLabel} · ${latestSegmentRoute}`
    : qaModel.referenceItems.length
      ? `参考图 ${qaModel.referenceItems.length} 项`
      : "等待最新质检反馈";
  const railSecondarySummary = `待复核 ${qaModel.pendingReviewCount} · 待修复 ${qaModel.activeRepairCount}`;
  const headerHintLabel = "右侧专用";

  return (
    <aside
      data-testid="video-qa-feedback-rail"
      className={cn(
        "pointer-events-auto self-end overflow-hidden rounded-[22px] border border-white/10 bg-[#0f1726]/94 shadow-[0_24px_60px_rgba(0,0,0,0.26)] backdrop-blur-xl",
        stretchToColumn ? "w-full" : "w-[280px]",
      )}
    >
      <button
        type="button"
        data-testid="video-qa-feedback-rail-toggle"
        aria-expanded={!collapsed}
        aria-controls="video-qa-feedback-rail-body"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-start justify-between gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-white/94">视频质检回传</span>
          <span className="mt-1 block text-[11px] leading-4 text-white/48">
            {collapsed ? railPrimarySummary : "生成与质检反馈已从聊天区移到这里。"}
          </span>
          {collapsed ? (
            <span className="mt-1 block text-[10.5px] leading-4 text-white/38">{railSecondarySummary}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          <span className="rounded-full border border-[rgba(109,138,255,0.3)] bg-[rgba(91,111,255,0.16)] px-2 py-0.5 text-[10px] font-medium text-[rgb(210,220,255)]">
            {headerHintLabel}
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-white/72 transition-transform duration-200",
              collapsed ? "-rotate-90" : "rotate-180",
            )}
          />
        </span>
      </button>

      {!collapsed ? (
        <div id="video-qa-feedback-rail-body" className="space-y-3 border-t border-white/8 px-3.5 py-3">
        {qaModel.latestSegmentAudit ? (
          <section data-testid="video-qa-feedback-segment" className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[12.5px] font-semibold text-white/92">
                  片段 {qaModel.latestSegmentAudit.segmentLabel || "最新结果"}
                </div>
                <div className="pt-0.5 text-[10.5px] text-white/46">
                  {formatQaTierLabel(qaModel.latestSegmentAudit.visualInspection?.qualityTier) || "自动质检"}
                </div>
              </div>
              <div className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10.5px] text-white/78">
                {formatSegmentQaRoute(qaModel.latestSegmentAudit.status)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-white/72">
              <div>总分 {qaModel.latestSegmentAudit.totalScore}</div>
              <div>连续 {qaModel.latestSegmentAudit.scores.continuity.score}</div>
              <div>身份 {qaModel.latestSegmentAudit.scores.identity.score}</div>
              <div>语义 {qaModel.latestSegmentAudit.scores.semantic.score}</div>
            </div>
            <div className="rounded-[12px] border border-white/8 bg-white/[0.03] px-2.5 py-2 text-[11.5px] leading-5 text-white/78">
              {localizeQaFeedbackText(
                qaModel.latestSegmentAudit.visualInspection?.summary ||
                  qaModel.latestSegmentAudit.issues?.[0] ||
                  "最新片段质检已完成。",
              )}
            </div>
            {(qaModel.latestSegmentAudit.visualInspection?.goldenSignals?.length ||
              qaModel.latestSegmentAudit.visualInspection?.fixPriorities?.length ||
              qaModel.latestSegmentAudit.issues?.length) ? (
              <div className="space-y-1 text-[11px] leading-4 text-white/62">
                {(qaModel.latestSegmentAudit.visualInspection?.goldenSignals || []).slice(0, 2).map((item) => (
                  <div key={`signal-${item}`}>命中：{localizeQaFeedbackText(item)}</div>
                ))}
                {(qaModel.latestSegmentAudit.visualInspection?.fixPriorities || []).slice(0, 2).map((item) => (
                  <div key={`fix-${item}`}>修复：{localizeQaFeedbackText(item)}</div>
                ))}
                {!(qaModel.latestSegmentAudit.visualInspection?.fixPriorities?.length) &&
                !(qaModel.latestSegmentAudit.visualInspection?.goldenSignals?.length)
                  ? qaModel.latestSegmentAudit.issues.slice(0, 2).map((item) => (
                      <div key={`issue-${item}`}>问题：{localizeQaFeedbackText(item)}</div>
                    ))
                  : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {qaModel.referenceItems.length ? (
          <section data-testid="video-qa-feedback-reference" className="space-y-2">
            <div className="text-[12.5px] font-semibold text-white/90">参考图质检</div>
            <div className="space-y-2">
              {qaModel.referenceItems.map((item) => (
                <div
                  key={item.targetId}
                  className="rounded-[12px] border border-white/8 bg-white/[0.03] px-2.5 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11.5px] font-medium text-white/82">
                        {resolveQaReviewTitle(snapshot, item.targetId)}
                      </div>
                      <div className="pt-0.5 text-[10px] text-white/45">
                        {formatQaTierLabel(item.lastQaQualityTier) || "参考素材质检"}
                      </div>
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/72">
                      {formatReferenceQaStatus(item.status)}
                    </div>
                  </div>
                  <div className="pt-1 text-[11px] text-white/72">
                    {typeof item.lastQaScore === "number" ? `分数 ${item.lastQaScore}` : "等待质检分数"}
                  </div>
                  <div className="pt-1 text-[11px] leading-4 text-white/62">
                    {localizeQaFeedbackText(item.lastQaSummary || item.lastError || "等待最新质检反馈。")}
                  </div>
                  {(item.lastQaFixPriorities?.[0] || item.lastQaGoldenSignals?.[0] || item.lastQaIssues?.[0]) ? (
                    <div className="pt-1 text-[10.5px] leading-4 text-white/52">
                      {item.lastQaFixPriorities?.[0]
                        ? `修复：${localizeQaFeedbackText(item.lastQaFixPriorities[0])}`
                        : item.lastQaGoldenSignals?.[0]
                          ? `命中：${localizeQaFeedbackText(item.lastQaGoldenSignals[0])}`
                          : `问题：${localizeQaFeedbackText(item.lastQaIssues?.[0])}`}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-2 gap-2 text-[10.5px] text-white/46">
          <div>待复核 {qaModel.pendingReviewCount}</div>
          <div>待修复 {qaModel.activeRepairCount}</div>
        </div>
        </div>
      ) : null}
    </aside>
  );
});

export const ActiveConversationShell = memo(function ActiveConversationShell({
  conversationId,
  messages,
  tasks,
  onStopTask,
  endRef,
  scrollContainerRef,
  composer,
  streaming,
  suppressSyntheticStreamingMessage,
  trackClassName,
  snapshot,
  onArtifactAction,
  onSaveArtifactText,
  onRelationshipDiagramCollapsedChange,
  onEditUserMessage,
  onAssistantFeedback,
  onRegenerateAssistant,
  onCreationGuidePick,
  workflowProgress,
  directBatchReviewTrigger,
  directSingleReviewTrigger,
  hasUnreadMessage,
  fullAutoRun,
  fullAutoChecklistCollapsed,
  onFullAutoChecklistCollapsedChange,
  onStopFullAuto,
  onRequestOlderHistory,
}: {
  conversationId?: string;
  messages: HomeAgentMessage[];
  tasks: RuntimeTask[];
  onStopTask: (taskId: string) => void;
  endRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  composer: ReactNode;
  streaming: boolean;
  suppressSyntheticStreamingMessage?: boolean;
  trackClassName: string;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
    sourceSnapshot?: ConversationProjectSnapshot | null,
  ) => void;
  onSaveArtifactText?: (
    field: "creativePlan" | "structureTransform" | "characters" | "characterTransform" | "directoryRaw" | "outlines",
    label: string,
    text: string,
  ) => void | Promise<void>;
  onRelationshipDiagramCollapsedChange?: (collapsed: boolean) => void | Promise<void>;
  onEditUserMessage?: (messageId: string, newContent: string) => void | Promise<void>;
  onAssistantFeedback?: (messageId: string, vote: "up" | "down" | null) => void;
  onRegenerateAssistant?: (messageId: string, attachmentId?: string) => void | Promise<void>;
  onCreationGuidePick?: (dimension: CreationGuideDimensionId, value: string, label: string) => void;
  directBatchReviewTrigger?: { count: number; targetMessageId: string };
  directSingleReviewTrigger?: { count: number; epNum: number; targetMessageId: string };
  hasUnreadMessage?: boolean;
  fullAutoRun?: FullAutoRunState | null;
  fullAutoChecklistCollapsed?: boolean;
  onFullAutoChecklistCollapsedChange?: (collapsed: boolean) => void;
  onStopFullAuto?: () => void;
  onRequestOlderHistory?: () => Promise<boolean> | boolean;
}) {
  const [internalFullAutoChecklistCollapsed, setInternalFullAutoChecklistCollapsed] = useState(
    fullAutoChecklistCollapsed ?? true,
  );
  const [desktopUtilityColumnLayout, setDesktopUtilityColumnLayout] = useState<DesktopUtilityColumnLayoutDetail>(null);
  const latestMessage = messages[messages.length - 1];
  const latestMessageHasMedia = Boolean(
    latestMessage?.attachments?.some((attachment) => attachment.kind === "image" || attachment.kind === "video"),
  );

  useEffect(() => {
    setInternalFullAutoChecklistCollapsed(fullAutoChecklistCollapsed ?? true);
  }, [fullAutoChecklistCollapsed, fullAutoRun?.plan?.id]);

  const resolvedFullAutoChecklistCollapsed = fullAutoChecklistCollapsed ?? internalFullAutoChecklistCollapsed;
  const handleFullAutoChecklistCollapsedChange = (collapsed: boolean) => {
    setInternalFullAutoChecklistCollapsed(collapsed);
    onFullAutoChecklistCollapsedChange?.(collapsed);
  };

  const showFullAutoRail = Boolean(
    fullAutoRun?.plan &&
      fullAutoRun.status !== "idle" &&
      fullAutoRun.status !== "completed",
  );

  const showFullAutoChecklist = Boolean(fullAutoRun?.plan && fullAutoRun.status !== "idle");
  const showVideoQaRail = Boolean(snapshot?.projectKind === "video");

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DesktopUtilityColumnLayoutDetail>).detail;
      if (!detail || typeof detail.left !== "number" || typeof detail.width !== "number") {
        setDesktopUtilityColumnLayout(null);
        return;
      }
      setDesktopUtilityColumnLayout(detail);
    };
    window.addEventListener(DESKTOP_UTILITY_COLUMN_LAYOUT_EVENT, handler as EventListener);
    return () => window.removeEventListener(DESKTOP_UTILITY_COLUMN_LAYOUT_EVENT, handler as EventListener);
  }, []);

  return (
    <div className="mx-auto flex min-h-[calc(100vh-112px)] w-full flex-col overflow-visible">
      {showFullAutoChecklist ? (
        <FullAutoMessageChecklistPanel
          run={fullAutoRun!}
          collapsed={resolvedFullAutoChecklistCollapsed}
          onToggleCollapsed={() => handleFullAutoChecklistCollapsedChange(!resolvedFullAutoChecklistCollapsed)}
        />
      ) : null}
      {showFullAutoRail || showVideoQaRail ? (
        <div
          data-testid="conversation-utility-rail"
          className={cn(
            "pointer-events-none fixed top-4 z-30 hidden xl:flex xl:flex-col xl:gap-3",
            desktopUtilityColumnLayout ? "xl:items-stretch" : "xl:items-end",
          )}
          style={
            desktopUtilityColumnLayout
              ? {
                  left: desktopUtilityColumnLayout.left,
                  width: desktopUtilityColumnLayout.width,
                }
              : {
                  right: 8,
                }
          }
        >
          {showFullAutoRail ? <FullAutoProgressRail run={fullAutoRun!} onStop={onStopFullAuto} /> : null}
          {showVideoQaRail ? (
            <VideoQaFeedbackRail
              snapshot={snapshot}
              stretchToColumn={Boolean(desktopUtilityColumnLayout)}
            />
          ) : null}
        </div>
      ) : null}
      <ActiveConversationViewport
        conversationId={conversationId}
        messages={messages}
        tasks={tasks}
        onStopTask={onStopTask}
        endRef={endRef}
        scrollContainerRef={scrollContainerRef}
        streaming={streaming}
        suppressSyntheticStreamingMessage={suppressSyntheticStreamingMessage}
        trackClassName={trackClassName}
        snapshot={snapshot}
        workflowProgress={workflowProgress}
        onArtifactAction={onArtifactAction}
        onSaveArtifactText={onSaveArtifactText}
        onRelationshipDiagramCollapsedChange={onRelationshipDiagramCollapsedChange}
        onEditUserMessage={onEditUserMessage}
        onAssistantFeedback={onAssistantFeedback}
        onRegenerateAssistant={onRegenerateAssistant}
        onCreationGuidePick={onCreationGuidePick}
        directBatchReviewTrigger={directBatchReviewTrigger}
        directSingleReviewTrigger={directSingleReviewTrigger}
        onRequestOlderHistory={onRequestOlderHistory}
      />
      <ActiveComposerDock
        composer={composer}
        trackClassName={trackClassName}
        hasUnreadMessage={hasUnreadMessage}
        compactBottomReserve={latestMessageHasMedia}
      />
    </div>
  );
});

export const HomeSurfaceBackdrop = memo(function HomeSurfaceBackdrop({ idle }: { idle: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {idle ? (
        <>
          <div className="absolute left-[-8%] top-[-10%] h-[24rem] w-[24rem] rounded-full bg-[radial-gradient(circle,rgba(76,94,255,0.12),rgba(76,94,255,0))]" />
          <div className="absolute right-[-6%] top-[14%] h-[20rem] w-[20rem] rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.04),rgba(255,255,255,0))]" />
        </>
      ) : (
        <>
          <div className="absolute inset-x-0 top-0 h-32 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]" />
          <div className="absolute right-[-8%] top-[18%] h-[22rem] w-[22rem] rounded-full bg-[radial-gradient(circle,rgba(91,111,255,0.1),rgba(91,111,255,0))]" />
        </>
      )}
    </div>
  );
});

export const MobileTopbar = memo(function MobileTopbar({
  idle,
  brandLabel,
  onOpenNavigation,
}: {
  idle: boolean;
  brandLabel: string;
  onOpenNavigation: () => void;
}) {
  return (
    <header
      className={cn(
        "px-4 md:px-8 lg:pl-[320px] lg:hidden",
        idle ? "flex items-center justify-between pb-2 pt-4" : "flex items-center justify-between pb-0 pt-2.5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <BrandMark className="h-8" />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-[0.02em] text-foreground">{brandLabel}</div>
          <div className="hidden truncate text-[11px] text-muted-foreground sm:block">首页主控会话</div>
        </div>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 rounded-full bg-muted/50 text-foreground hover:bg-muted sm:h-10 sm:w-10"
        onClick={onOpenNavigation}
      >
        <Menu className="h-4.5 w-4.5" />
      </Button>
    </header>
  );
});

export interface HomeComposerProps {
  idle: boolean;
  currentProjectTitle?: string;
  currentProjectStage?: string;
  maintenanceHint?: string | null;
  videoTransportHint?: HomeComposerVideoTransportHint | null;
  launchNotice?: HomeComposerLaunchNotice | null;
  initialDraft: string;
  draftResetVersion: number;
  draftPresence: boolean;
  onDraftChange: (value: string) => void;
  placeholder: string;
  question: ComposerQuestion | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  videoWorkflowTaskBoard?: VideoWorkflowTaskBoard | null;
  suppressFloatingTaskBoard?: boolean;
  qState: unknown | null;
  selectedValues: string[];
  streaming: boolean;
  isMediaGenerating?: boolean;
  isAwaitingWorkflowDocumentUpload?: boolean;
  reduceMotion: boolean;
  composerShellClass: string;
  activeTheme: boolean;
  selectedTextModelKey: string;
  selectedTextModelLabel: string;
  textModelGroups: HomeAgentTextModelGroup[];
  onSelectTextModel: (key: string) => void;
  selectedImageModelKey: string;
  selectedImageModelLabel: string;
  imageModelOptions: HomeAgentImageModelFamilyOption[];
  imageGenerationPrefs: VideoImageGenerationPrefs;
  onSelectImageModel: (key: string) => void;
  onConfirmImageSettings: (prefs: VideoImageGenerationPrefs) => void;
  onRecognizeImageStyle?: () => Promise<HomeAgentImageStyleRecognitionResult | null>;
  selectedVideoModelKey: string;
  selectedVideoModelLabel: string;
  videoModelOptions: HomeAgentVideoModelOption[];
  videoGenerationPrefs: VideoGenerationPrefs;
  showVideoModeBadge?: boolean;
  onSelectVideoModel: (key: string) => void;
  onConfirmVideoResolution: (prefs: VideoGenerationPrefs) => void;
  onConfirmVideoPrefs?: (prefs: VideoGenerationPrefs) => void;
  onDevVideoGenerationModeChange?: (mode: VideoGenerationPrefs["mode"]) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
  onSelectChoice: (value: string, label: string) => void;
  onConfirmQuestion?: () => void;
  onBackQuestion?: () => void;
  onResetQuestion?: () => void;
  onDismissQuestion?: () => void;
  styleRecognitionProgress?: {
    progress: number;
    label: string;
  } | null;
  onLaunchAction?: (actionId: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  fullAutoRun?: FullAutoRunState | null;
  onStopFullAuto?: () => void;
  creationMode: CreationMode;
  onCreationModeChange: (mode: CreationMode) => void;
  devMode?: boolean;
  onDevModeChange?: (enabled: boolean) => void;
  /** 外部控制的已附加文件列表 */
  attachedFiles?: File[];
  onAttachedFilesChange?: (files: File[]) => void;
}

const VideoWorkflowTaskBoardPanel = memo(function VideoWorkflowTaskBoardPanel({
  board,
  activeTheme,
  expanded,
  onToggleExpanded,
  heightClassName,
  showAllItems = false,
}: {
  board: VideoWorkflowTaskBoard;
  activeTheme: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  heightClassName: string;
  showAllItems?: boolean;
}) {
  const usesPendingTaskBoardTreatment = (item: VideoWorkflowTaskBoard["items"][number]) =>
    item.state === "pending" ||
    item.id === "missing-assets" ||
    item.id === "missing-references" ||
    item.id === "segment-prompts" ||
    (item.id === "shot-prompts" && item.state === "attention");
  const hasElevatedAttention = board.items.some(
    (item) => item.state === "attention" && !usesPendingTaskBoardTreatment(item),
  );
  const completedCount = board.items.filter((item) => item.state === "completed").length;
  const collapsedBoardTitle = "任务板";
  const boardTitle = "任务板";
  const boardHeaderHint = String(board.headerHint || "").trim();
  const boardSummary = `共 ${board.items.length} 条 · 已完成 ${completedCount} 条`;

  if (!expanded) {
    return (
      <button
        type="button"
        data-testid="video-workflow-task-board-toggle"
        aria-expanded="false"
        onClick={onToggleExpanded}
        className={cn(
          "flex w-full items-center justify-between rounded-[18px] border px-3 py-2 text-left shadow-[0_12px_28px_rgba(0,0,0,0.14)] transition-colors",
          activeTheme
            ? hasElevatedAttention
              ? "border-orange-400/25 bg-orange-500/[0.08] text-orange-100 hover:bg-orange-500/[0.12]"
              : "border-white/[0.08] bg-white/[0.04] text-white/78 hover:bg-white/[0.08]"
            : hasElevatedAttention
              ? "border-orange-300/70 bg-orange-50 text-orange-700 hover:bg-orange-100"
              : "border-border/70 bg-muted/40 text-foreground/80 hover:bg-muted/70",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-semibold">{collapsedBoardTitle}</span>
          <span className="text-[11px] text-inherit/80">{boardSummary}</span>
        </span>
        {boardHeaderHint ? (
          <span
            data-testid="video-workflow-task-board-header-hint"
            className={cn(
              "line-clamp-2 max-w-[132px] min-w-0 flex-1 self-center text-right text-[11px] font-medium leading-[1.35] tracking-[0.01em]",
              activeTheme ? "text-sky-200/78" : "text-sky-700/80",
            )}
          >
            {boardHeaderHint}
          </span>
        ) : null}
        <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 opacity-70 transition-transform duration-200" />
      </button>
    );
  }

  return (
    <div
      data-testid="video-workflow-task-board"
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[22px] border px-3 py-2 shadow-[0_18px_42px_rgba(0,0,0,0.18)]",
        heightClassName,
        activeTheme
          ? "border-white/[0.08] bg-white/[0.04]"
          : "border-border/70 bg-muted/35",
      )}
    >
      <button
        type="button"
        data-testid="video-workflow-task-board-trigger"
        aria-expanded="true"
        onClick={onToggleExpanded}
        className={cn(
          "-mx-1 flex w-auto items-start justify-between gap-3 rounded-[16px] px-1 py-1 text-left transition-colors",
          activeTheme ? "hover:bg-white/[0.04]" : "hover:bg-background/60",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className={cn("block text-[13px] font-semibold", activeTheme ? "text-white/92" : "text-foreground/92")}>
            {boardTitle}
          </span>
          <span className={cn("mt-0.5 block text-[11px]", activeTheme ? "text-white/62" : "text-muted-foreground")}>
            {boardSummary}
          </span>
        </span>
        {boardHeaderHint ? (
          <span
            data-testid="video-workflow-task-board-header-hint"
            className={cn(
              "line-clamp-2 max-w-[132px] min-w-0 flex-1 self-center text-right text-[11px] font-medium leading-[1.35] tracking-[0.01em]",
              activeTheme ? "text-sky-200/78" : "text-sky-700/80",
            )}
          >
            {boardHeaderHint}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 opacity-70 transition-transform duration-200",
            activeTheme ? "text-white/72" : "text-foreground/70",
            "rotate-180",
          )}
        />
      </button>
      <div
        className={cn(
          "mt-2 border-t pt-2 pr-1",
          activeTheme ? "border-white/[0.08]" : "border-border/70",
          showAllItems ? "overflow-visible" : "min-h-0 flex-1 overflow-y-auto",
        )}
      >
        <ul className="space-y-1.5">
          {board.items.map((item) => {
            const isCompleted = item.state === "completed";
            const isPending = item.state === "pending";
            const isDanger = item.tone === "danger";
            const isWarning = item.tone === "warning";
            const usesPendingTreatment = usesPendingTaskBoardTreatment(item);
            const titleClassName =
              isCompleted
                ? activeTheme
                  ? "text-white/15 line-through"
                  : "text-muted-foreground/66 line-through"
                : isDanger
                  ? activeTheme
                    ? "text-red-300"
                    : "text-red-600"
                  : usesPendingTreatment
                    ? activeTheme
                      ? "text-white"
                      : "text-foreground"
                    : isWarning
                      ? activeTheme
                        ? "text-orange-200"
                        : "text-orange-700"
                    : activeTheme
                      ? "text-white/78"
                      : "text-foreground/82";
            const detailClassName =
              isCompleted
                ? activeTheme
                  ? "text-white/12"
                  : "text-muted-foreground/70"
                : isDanger
                  ? activeTheme
                    ? "text-white/12"
                    : "text-red-500/90"
                  : usesPendingTreatment
                    ? activeTheme
                      ? "text-white/12"
                      : "text-foreground/72"
                    : isWarning
                      ? activeTheme
                        ? "text-white/12"
                        : "text-orange-600/90"
                    : activeTheme
                      ? "text-white/12"
                      : "text-muted-foreground";

            return (
              <li
                key={item.id}
                className={cn(
                  "flex items-start gap-2 rounded-xl px-2 py-1.5",
                  isCompleted
                    ? activeTheme
                      ? "bg-white/[0.01]"
                      : "bg-background/70"
                    : isDanger
                      ? activeTheme
                        ? "bg-red-500/[0.08]"
                        : "bg-red-50"
                      : usesPendingTreatment
                        ? activeTheme
                          ? "bg-white/[0.09] ring-1 ring-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_10px_22px_rgba(0,0,0,0.18)]"
                          : "bg-background ring-1 ring-border/80 shadow-sm"
                        : isWarning
                          ? activeTheme
                            ? "bg-orange-500/[0.08]"
                            : "bg-orange-50"
                          : "bg-transparent",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full",
                    isCompleted
                      ? activeTheme
                        ? "bg-white/[0.045] text-white/28"
                        : "bg-muted text-muted-foreground"
                      : isDanger
                        ? activeTheme
                          ? "bg-red-500/20 text-red-300"
                          : "bg-red-100 text-red-600"
                        : usesPendingTreatment
                          ? activeTheme
                            ? "bg-white/[0.18] text-white/92"
                            : "bg-foreground/8 text-foreground/78"
                          : isWarning
                            ? activeTheme
                              ? "bg-orange-500/20 text-orange-200"
                              : "bg-orange-100 text-orange-700"
                          : activeTheme
                            ? "bg-white/[0.08] text-white/60"
                            : "bg-muted text-muted-foreground",
                  )}
                >
                  {isCompleted ? <Check className="h-3 w-3" /> : <span className="text-[9px]">•</span>}
                </span>
                <div className="min-w-0 flex flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className={cn("text-[12.5px] leading-5", titleClassName)}>
                    {item.label} {item.value}
                  </span>
                  <span className={cn("whitespace-normal break-words text-[11.5px] leading-5", detailClassName)}>
                    {item.detail ?? `${item.label} ${item.value}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
});

export const HomeComposer = memo(function HomeComposer({
  idle,
  launchNotice,
  initialDraft,
  draftResetVersion,
  draftPresence,
  onDraftChange,
  placeholder,
  question,
  workflowProgress = null,
  videoWorkflowTaskBoard = null,
  suppressFloatingTaskBoard = false,
  qState,
  selectedValues,
  streaming,
  isMediaGenerating = false,
  isAwaitingWorkflowDocumentUpload = false,
  reduceMotion,
  composerShellClass,
  activeTheme,
  selectedTextModelKey,
  selectedTextModelLabel,
  textModelGroups,
  onSelectTextModel,
  selectedImageModelKey,
  selectedImageModelLabel,
  imageModelOptions,
  imageGenerationPrefs,
  onSelectImageModel,
  onConfirmImageSettings,
  onRecognizeImageStyle,
  selectedVideoModelKey,
  selectedVideoModelLabel,
  videoModelOptions,
  videoGenerationPrefs,
  showVideoModeBadge = false,
  onSelectVideoModel,
  onConfirmVideoResolution,
  onConfirmVideoPrefs,
  onDevVideoGenerationModeChange,
  onDevImageViewModeChange,
  onSelectChoice,
  onConfirmQuestion,
  onBackQuestion,
  onResetQuestion,
  onDismissQuestion,
  styleRecognitionProgress = null,
  onLaunchAction,
  onSubmit,
  onInterrupt,
  fullAutoRun = null,
  onStopFullAuto,
  creationMode,
  onCreationModeChange,
  devMode = false,
  onDevModeChange,
  attachedFiles: externalAttachedFiles,
  onAttachedFilesChange,
}: HomeComposerProps) {
  const isMobile = useIsMobile();
  const [draft, setLocalDraft] = useState(initialDraft);
  const isFullAutoInterruptAvailable =
    fullAutoRun?.status === "collecting" ||
    fullAutoRun?.status === "running" ||
    fullAutoRun?.status === "retrying" ||
    fullAutoRun?.status === "paused" ||
    fullAutoRun?.status === "failed";
  const showInterruptButton = !qState && (streaming || isFullAutoInterruptAvailable);
  const handleStopCurrentExecution = () => {
    if (isFullAutoInterruptAvailable && onStopFullAuto) {
      onStopFullAuto();
      return;
    }
    onInterrupt();
  };
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [desktopTaskBoardPosition, setDesktopTaskBoardPosition] = useState<{
    bottom: number;
    left: number;
    width: number;
  } | null>(null);
  const localDraftRef = useRef(initialDraft);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taskBoardAnchorRef = useRef<HTMLDivElement>(null);
  const isComposerComposingRef = useRef(false);
  const composerDraftResetAtRef = useRef(0);
  const awaitFreshComposerInputRef = useRef(false);
  const lastClearedDraftRef = useRef("");
  const attachedFiles = externalAttachedFiles ?? [];
  const attachedImageCount = attachedFiles.filter(isSupportedImageFile).length;
  const composerCustomCapture = useMemo(
    () => getComposerCustomCaptureDescriptor(question),
    [question],
  );
  const composerPrimaryAction = useMemo(
    () =>
      resolveComposerCustomCaptureAction({
        question,
        draft,
        attachedFiles,
        isAwaitingWorkflowDocumentUpload,
      }),
    [question, draft, attachedFiles, isAwaitingWorkflowDocumentUpload],
  );
  const isVideoStyleCaptureMode = Boolean(composerCustomCapture);
  const isOriginalKickoffWordCountQuestion =
    Boolean(question?.id.startsWith("original-script-kickoff:")) &&
    Boolean(question?.id.includes(":word-count"));
  const shouldHighlightComposerForCustomInput =
    Boolean(composerCustomCapture) || isOriginalKickoffWordCountQuestion;
  const isStyleRecognitionPending = Boolean(styleRecognitionProgress);
  const resolvedPlaceholder =
    composerCustomCapture?.placeholder ??
    (isOriginalKickoffWordCountQuestion
      ? "可直接输入 10 或 10集，我会按集数规模识别"
      : isAwaitingWorkflowDocumentUpload
        ? "可直接粘贴剧本文本，无关内容我会提示"
        : placeholder);
  const isTextEntryLocked =
    isMediaGenerating || isStyleRecognitionPending;
  const isFilePickerLocked = isMediaGenerating || isStyleRecognitionPending;
  const hasComposerPayload =
    attachedFiles.length > 0 || Boolean(draftPresence || draft.trim());
  const resolvedComposerShellClass = cn(
    composerShellClass,
    shouldHighlightComposerForCustomInput && "composer-shell-style-capture",
    isTextEntryLocked && "composer-shell-media-locked",
  );
  const taskBoardStageKey = videoWorkflowTaskBoard
    ? `${videoWorkflowTaskBoard.stage}:${videoWorkflowTaskBoard.items.map((item) => item.id).join("|")}`
    : "";
  const allTaskBoardItemsCompleted = Boolean(
    videoWorkflowTaskBoard?.items.length &&
      videoWorkflowTaskBoard.items.every((item) => item.state === "completed"),
  );
  const previousTaskBoardCompletionRef = useRef(allTaskBoardItemsCompleted);
  const [taskBoardExpanded, setTaskBoardExpanded] = useState(!allTaskBoardItemsCompleted);
  const composerTextAreaHeightClassName = idle
    ? "h-[112px] sm:h-[120px] md:h-[128px]"
    : "h-[88px] sm:h-[96px]";
  const isSubmitDisabled =
    isMediaGenerating ||
    isStyleRecognitionPending ||
    ((!hasComposerPayload &&
      !(qState && selectedValues.length > 0)) ||
      (streaming && !qState));
  const desktopTaskBoardGap = 24;
  const desktopTaskBoardViewportPadding = 16;
  const desktopTaskBoardMinWidth = 200;
  const desktopTaskBoardMaxWidth = 320;
  const [desktopLayoutInvalidationTick, setDesktopLayoutInvalidationTick] = useState(0);

  useEffect(() => {
    localDraftRef.current = draft;
  }, [draft]);

  const clearComposerDraftForImmediateSubmit = () => {
    if (draft.length === 0) return;
    const previousDraft = draft;
    setLocalDraft("");
    localDraftRef.current = previousDraft;
    composerDraftResetAtRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    lastClearedDraftRef.current = previousDraft;
    awaitFreshComposerInputRef.current = true;
  };

  const handleComposerSubmit = () => {
    clearComposerDraftForImmediateSubmit();
    onSubmit();
  };

  useLayoutEffect(() => {
    const previousDraft = localDraftRef.current;
    const awaitingFreshInput = initialDraft.length === 0 && previousDraft.length > 0;
    setLocalDraft(initialDraft);
    composerDraftResetAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    lastClearedDraftRef.current = awaitingFreshInput ? previousDraft : "";
    localDraftRef.current = initialDraft;
    awaitFreshComposerInputRef.current = awaitingFreshInput;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [initialDraft, draftResetVersion]);

  // 从聊天消息/侧边栏拖拽媒体到输入框
  useEffect(() => {
    if (!videoWorkflowTaskBoard?.items.length) return;
    setTaskBoardExpanded(!allTaskBoardItemsCompleted);
  }, [taskBoardStageKey, allTaskBoardItemsCompleted, videoWorkflowTaskBoard?.items.length]);

  useEffect(() => {
    if (!videoWorkflowTaskBoard?.items.length) {
      previousTaskBoardCompletionRef.current = false;
      return;
    }
    if (allTaskBoardItemsCompleted && !previousTaskBoardCompletionRef.current) {
      setTaskBoardExpanded(false);
    }
    previousTaskBoardCompletionRef.current = allTaskBoardItemsCompleted;
  }, [allTaskBoardItemsCompleted, videoWorkflowTaskBoard?.items.length]);

  useEffect(() => {
    if (isStyleRecognitionPending) {
      setFilesCollapsed(false);
    }
  }, [isStyleRecognitionPending]);

  useLayoutEffect(() => {
    if (isMobile || !videoWorkflowTaskBoard?.items.length) {
      setDesktopTaskBoardPosition(null);
      return;
    }

    const updateDesktopTaskBoardPosition = () => {
      const anchor = taskBoardAnchorRef.current;
      if (!anchor) {
        setDesktopTaskBoardPosition(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const preferredLeft = rect.right + desktopTaskBoardGap;
      const preferredWidth = Math.round(rect.width * 0.36);
      const nextWidth = Math.max(
        desktopTaskBoardMinWidth,
        Math.min(
          desktopTaskBoardMaxWidth,
          preferredWidth,
          window.innerWidth - desktopTaskBoardViewportPadding * 2,
        ),
      );
      const preferredLeftSide = rect.left - nextWidth - desktopTaskBoardGap;
      const maxLeft = window.innerWidth - nextWidth - desktopTaskBoardViewportPadding;
      const canPlaceRight = preferredLeft <= maxLeft;
      const canPlaceLeft = preferredLeftSide >= desktopTaskBoardViewportPadding;
      const nextLeft = canPlaceRight
        ? preferredLeft
        : canPlaceLeft
          ? preferredLeftSide
          : Math.max(desktopTaskBoardViewportPadding, Math.min(preferredLeft, maxLeft));
      setDesktopTaskBoardPosition({
        bottom: Math.max(
          desktopTaskBoardViewportPadding,
          window.innerHeight - rect.bottom,
        ),
        left: nextLeft,
        width: nextWidth,
      });
    };

    updateDesktopTaskBoardPosition();
    let animationFrameId: number | null = null;
    const animationWindowStart = performance.now();
    const keepPositionInSync = () => {
      updateDesktopTaskBoardPosition();
      if (performance.now() - animationWindowStart < 500) {
        animationFrameId = requestAnimationFrame(keepPositionInSync);
      } else {
        animationFrameId = null;
      }
    };
    animationFrameId = requestAnimationFrame(keepPositionInSync);
    window.addEventListener("resize", updateDesktopTaskBoardPosition);
    window.addEventListener("scroll", updateDesktopTaskBoardPosition, true);

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
        }
        window.removeEventListener("resize", updateDesktopTaskBoardPosition);
        window.removeEventListener("scroll", updateDesktopTaskBoardPosition, true);
      };
    }

    const observer = new ResizeObserver(updateDesktopTaskBoardPosition);
    if (taskBoardAnchorRef.current) {
      observer.observe(taskBoardAnchorRef.current);
    }

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      observer.disconnect();
      window.removeEventListener("resize", updateDesktopTaskBoardPosition);
      window.removeEventListener("scroll", updateDesktopTaskBoardPosition, true);
    };
  }, [
    isMobile,
    videoWorkflowTaskBoard?.items.length,
    taskBoardStageKey,
    draft,
    attachedFiles.length,
    filesCollapsed,
    taskBoardExpanded,
    desktopLayoutInvalidationTick,
  ]);

  useEffect(() => {
    const handleInvalidate = () => {
      setDesktopLayoutInvalidationTick((value) => value + 1);
    };
    window.addEventListener(HOME_AGENT_DESKTOP_LAYOUT_INVALIDATE_EVENT, handleInvalidate);
    return () => window.removeEventListener(HOME_AGENT_DESKTOP_LAYOUT_INVALIDATE_EVENT, handleInvalidate);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const detail: DesktopUtilityColumnLayoutDetail =
      !isMobile && !suppressFloatingTaskBoard && desktopTaskBoardPosition
        ? {
            left: desktopTaskBoardPosition.left,
            width: desktopTaskBoardPosition.width,
          }
        : null;
    window.dispatchEvent(
      new CustomEvent<DesktopUtilityColumnLayoutDetail>(DESKTOP_UTILITY_COLUMN_LAYOUT_EVENT, {
        detail,
      }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent<DesktopUtilityColumnLayoutDetail>(DESKTOP_UTILITY_COLUMN_LAYOUT_EVENT, {
          detail: null,
        }),
      );
    };
  }, [desktopTaskBoardPosition, isMobile, suppressFloatingTaskBoard]);

  const draftAttachmentProgressByIndex = useMemo(() => {
    if (!styleRecognitionProgress || !isVideoStyleCaptureMode || !attachedFiles.length) {
      return undefined;
    }
    const entries = attachedFiles.flatMap((file, index) =>
      isSupportedImageFile(file)
        ? [[index, { progress: styleRecognitionProgress.progress, label: styleRecognitionProgress.label }] as const]
        : [],
    );
    return entries.length ? Object.fromEntries(entries) : undefined;
  }, [attachedFiles, isVideoStyleCaptureMode, styleRecognitionProgress]);

  const handleComposerDragOver = (e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/x-infinio-sidebar-image") ||
      e.dataTransfer.types.includes("application/x-infinio-image") ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOver(true);
    }
  };

  const handleComposerDragLeave = () => setIsDragOver(false);

  const handleComposerDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    // 处理从侧边栏拖入的媒体文件
    const sidebarData = e.dataTransfer.getData("application/x-infinio-sidebar-image");
    const imageData = e.dataTransfer.getData("application/x-infinio-image");
    const rawData = sidebarData || imageData;
    if (rawData) {
      try {
        const parsed = JSON.parse(rawData) as { url: string; label?: string; fileName?: string; kind?: string };
        const url = parsed.url;
        const rawFileName = parsed.label || parsed.fileName || url.split(/[\\/]/).pop() || "media";
        // 优先从 URL 中提取扩展名（label 通常是中文显示名，无扩展名）
        const urlExt = url.match(/\.(mp4|mov|webm|avi|mkv|jpg|jpeg|png|gif|webp)$/i)?.[1]?.toLowerCase();
        const isVideo =
          /\.(mp4|mov|webm|avi|mkv)$/i.test(rawFileName) ||
          /\.(mp4|mov|webm|avi|mkv)$/i.test(url) ||
          parsed.kind === "video";
        // 确保 fileName 带扩展名，否则浏览器/Electron 无法识别 MIME
        const fileName = urlExt && !rawFileName.includes(".") ? `${rawFileName}.${urlExt}` : rawFileName;
        const fallbackMime = isVideo ? "video/mp4" : "image/jpeg";
        let file: File | null = null;
        if (url.startsWith("data:")) {
          const [header, base64] = url.split(",");
          const mimeType = header.match(/:(.*?);/)?.[1] ?? fallbackMime;
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          file = new File([bytes], fileName, { type: mimeType });
        } else if (url.startsWith("http://") || url.startsWith("https://")) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            file = new File([blob], fileName, { type: blob.type || fallbackMime });
          } catch { /* 忽略 */ }
        } else {
          // 本地文件路径：先尝试 fetch file:// URL（对大视频更友好），再回退 readBase64
          const normalizedPath = url.startsWith("file://")
            ? decodeURIComponent(url.replace(/^file:\/\/+/, "")).replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\")
            : url;
          const fileUrl = url.startsWith("file://")
            ? url
            : `file:///${normalizedPath.replace(/\\/g, "/")}`;
          try {
            const res = await fetch(fileUrl);
            if (res.ok) {
              const blob = await res.blob();
              // blob.type 在 file:// 下可能为空或 application/octet-stream，以扩展名为准
              const effectiveMime =
                blob.type && blob.type !== "application/octet-stream" ? blob.type : fallbackMime;
              file = new File([blob], fileName, { type: effectiveMime });
            }
          } catch { /* ignore */ }
          if (!file && window.electronAPI?.storage?.readBase64) {
            try {
              const result = await window.electronAPI.storage.readBase64(normalizedPath);
              if (result?.ok && result?.base64) {
                const mimeType = result.mimeType || fallbackMime;
                const binary = atob(result.base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                file = new File([bytes], fileName, { type: mimeType });
              }
            } catch { /* ignore */ }
          }
        }
        if (file) {
          onAttachedFilesChange?.([...attachedFiles, file]);
        }
      } catch { /* 忽略解析错误 */ }
      return;
    }

    // 处理直接拖入的文件
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onAttachedFilesChange?.([...attachedFiles, ...droppedFiles]);
    }
  };

  return (
    <div className="relative w-full">
      <ComposerChoiceModal
        question={question}
        progress={workflowProgress}
        onSelect={onSelectChoice}
        onConfirm={onConfirmQuestion}
        onBack={onBackQuestion}
        onReset={onResetQuestion}
        onDismiss={onDismissQuestion}
        canConfirm={selectedValues.length > 0 || draftPresence || !!draft.trim() || attachedFiles.length > 0}
        tone={activeTheme ? "dark" : "light"}
        devMode={devMode}
        showVideoModeBadge={showVideoModeBadge}
        devVideoGenerationMode={videoGenerationPrefs.mode}
        onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
      />
      <motion.div
        layoutId="home-studio-composer"
        transition={
          reduceMotion
            ? { duration: 0 }
            : idle
              ? {
                  type: "spring",
                  stiffness: 340,
                  damping: 34,
                  mass: 0.9,
                }
              : {
                  duration: 0.14,
                  ease: [0.22, 1, 0.36, 1],
                }
        }
        className="pointer-events-auto relative w-full"
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={(e) => void handleComposerDrop(e)}
      >
      <div className="relative w-full overflow-visible">
      <motion.div
        initial={reduceMotion ? false : idle ? { opacity: 0.92 } : false}
        animate={reduceMotion ? undefined : idle ? { opacity: 1 } : undefined}
        transition={
          reduceMotion
            ? undefined
            : {
                duration: idle ? 0.16 : 0.12,
                ease: [0.22, 1, 0.36, 1],
              }
        }
        className={cn(
          "relative min-w-0 flex-1",
          resolvedComposerShellClass,
          isDragOver && "ring-2 ring-primary/50 ring-offset-1",
        )}
        data-style-capture-mode={isVideoStyleCaptureMode ? "true" : "false"}
      >
        <div ref={taskBoardAnchorRef} aria-hidden className="pointer-events-none absolute inset-0" />
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-primary/5">
            <span className="rounded-full bg-primary/10 px-3 py-1 text-[12px] text-primary/80">
              拖放媒体到输入框
            </span>
          </div>
        )}
        {launchNotice ? (
          <div
            className={cn(
              "mx-3.5 mt-2 rounded-[18px] border px-3.5 py-3 md:mx-6",
              launchNotice.level === "critical"
                ? "border-amber-300/18 bg-amber-300/[0.06]"
                : "border-border/30 bg-muted/20",
            )}
          >
            <div className="text-[12px] font-medium text-foreground">{launchNotice.title}</div>
            <div className="mt-1 text-[11px] leading-[1.6] text-muted-foreground">{launchNotice.description}</div>
            {launchNotice.actions.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {launchNotice.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[10.5px] transition",
                      launchNotice.level === "critical"
                        ? "bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30"
                        : "bg-muted text-foreground hover:bg-muted/80",
                    )}
                    onClick={() => onLaunchAction?.(action.id)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={cn("px-3.5 pb-3 pt-1 sm:px-4 sm:pb-3.5 md:px-6 md:pb-3.5", !idle && "pt-1")}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            disabled={isFilePickerLocked}
            className="hidden"
            onChange={(e) => {
              const newFiles = Array.from(e.target.files ?? []);
              if (newFiles.length > 0) {
                onAttachedFilesChange?.([...attachedFiles, ...newFiles]);
              }
              // 重置input以允许重复选择同一文件
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <DraftAttachmentList
            files={attachedFiles}
            activeTheme={activeTheme}
            collapsed={filesCollapsed}
            onToggleCollapsed={() => setFilesCollapsed((value) => !value)}
            onRemove={(index) =>
              onAttachedFilesChange?.(attachedFiles.filter((_, fileIndex) => fileIndex !== index))
            }
            progressByIndex={draftAttachmentProgressByIndex}
            disableRemove={isStyleRecognitionPending}
          />
          {/* 已附加文件列表 */}
          {attachedFiles.length > Number.POSITIVE_INFINITY ? (
            <div className={cn(
              "mb-2 rounded-xl border px-3 py-2",
              activeTheme ? "border-white/[0.08] bg-white/[0.04]" : "border-black/[0.08] bg-black/[0.03]",
            )}>
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-[11.5px] font-medium", activeTheme ? "text-white/60" : "text-slate-500")}>
                  已附加 {attachedFiles.length} 个文件
                </span>
                <button
                  type="button"
                  className={cn("text-[11px] transition", activeTheme ? "text-white/40 hover:text-white/70" : "text-slate-400 hover:text-slate-600")}
                  onClick={() => setFilesCollapsed((v) => !v)}
                >
                  {filesCollapsed ? "展开" : "收起"}
                </button>
              </div>
              {!filesCollapsed ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  {attachedFiles.map((file, idx) => (
                    <div key={`${file.name}-${idx}`} className="flex items-center gap-2">
                      <Paperclip className={cn("h-3 w-3 shrink-0", activeTheme ? "text-white/40" : "text-slate-400")} />
                      <span className={cn("flex-1 truncate text-[11.5px]", activeTheme ? "text-white/80" : "text-slate-700")}>
                        {file.name}
                      </span>
                      <span className={cn("shrink-0 text-[10.5px]", activeTheme ? "text-white/30" : "text-slate-400")}>
                        {(file.size / 1024).toFixed(0)}KB
                      </span>
                      <button
                        type="button"
                        className={cn("shrink-0 text-[11px] transition", activeTheme ? "text-white/30 hover:text-red-400" : "text-slate-400 hover:text-red-500")}
                        onClick={() => onAttachedFilesChange?.(attachedFiles.filter((_, i) => i !== idx))}
                        aria-label={`移除 ${file.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="relative overflow-visible">
            <Textarea
              value={draft}
              disabled={isTextEntryLocked}
              onCompositionStart={() => {
                isComposerComposingRef.current = true;
                awaitFreshComposerInputRef.current = false;
              }}
              onCompositionEnd={() => {
                isComposerComposingRef.current = false;
              }}
              onPaste={() => {
                awaitFreshComposerInputRef.current = false;
              }}
              onChange={(e) => {
                const nextValue = e.target.value;
                if (awaitFreshComposerInputRef.current) {
                  const staleClearedDraft = lastClearedDraftRef.current;
                  const isDeletingRevivedDraft =
                    staleClearedDraft.length > 0 &&
                    nextValue.length < staleClearedDraft.length &&
                    staleClearedDraft.startsWith(nextValue);
                  if (isDeletingRevivedDraft) {
                    awaitFreshComposerInputRef.current = false;
                  } else {
                    return;
                  }
                }
                setLocalDraft(nextValue);
                localDraftRef.current = nextValue;
                onDraftChange(nextValue);
              }}
              placeholder={resolvedPlaceholder}
              rows={idle ? 3 : 3}
              className={cn(
                "resize-none overflow-y-auto border-none bg-transparent px-0 pb-2 pt-1.5 text-[13.5px] leading-6.5 shadow-none outline-none ring-0 ring-offset-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:text-[14px]",
                composerTextAreaHeightClassName,
                isTextEntryLocked && "disabled:!opacity-100",
                activeTheme
                  ? "text-white placeholder:text-white/28"
                  : "text-foreground placeholder:text-muted-foreground/50",
              )}
              onKeyDown={(e) => {
                if (isTextEntryLocked) {
                  if (e.key === "Enter") {
                    e.preventDefault();
                  }
                  return;
                }
                if (
                  awaitFreshComposerInputRef.current &&
                  e.timeStamp > composerDraftResetAtRef.current &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  e.key !== "Enter" &&
                  e.key !== "Shift" &&
                  e.key !== "Control" &&
                  e.key !== "Alt" &&
                  e.key !== "Meta"
                ) {
                  awaitFreshComposerInputRef.current = false;
                }
                if (e.nativeEvent.isComposing || isComposerComposingRef.current) {
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleComposerSubmit();
                }
              }}
            />
            {videoWorkflowTaskBoard?.items.length ? (
              <>
                {isMobile ? (
                  <div className="mt-3">
                    <VideoWorkflowTaskBoardPanel
                      board={videoWorkflowTaskBoard}
                      activeTheme={activeTheme}
                      expanded={taskBoardExpanded}
                      onToggleExpanded={() => setTaskBoardExpanded((value) => !value)}
                      heightClassName={composerTextAreaHeightClassName}
                    />
                  </div>
                ) : !suppressFloatingTaskBoard && desktopTaskBoardPosition && typeof document !== "undefined" ? (
                  createPortal(
                    <div
                      data-testid="video-workflow-task-board-desktop-layer"
                      className="pointer-events-none fixed z-[10]"
                      style={{
                        bottom: desktopTaskBoardPosition.bottom,
                        left: desktopTaskBoardPosition.left,
                        width: desktopTaskBoardPosition.width,
                      }}
                    >
                      <div className="pointer-events-auto">
                        <VideoWorkflowTaskBoardPanel
                          board={videoWorkflowTaskBoard}
                          activeTheme={activeTheme}
                          expanded={taskBoardExpanded}
                          onToggleExpanded={() => setTaskBoardExpanded((value) => !value)}
                          heightClassName=""
                          showAllItems
                        />
                      </div>
                    </div>,
                    document.body,
                  )
                ) : null}
              </>
            ) : null}
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={isFilePickerLocked}
                className={cn(
                  "h-9 w-9 rounded-full sm:h-10 sm:w-10",
                  composerPrimaryAction === "upload" && !isFilePickerLocked && "composer-shell-style-capture-action",
                  isFilePickerLocked && "composer-shell-media-locked disabled:!opacity-100",
                  activeTheme
                    ? attachedFiles.length > 0
                      ? "bg-white/[0.12] text-white hover:bg-white/[0.18]"
                      : "bg-white/[0.04] text-white/78 hover:bg-white/[0.1] hover:text-white"
                    : attachedFiles.length > 0
                      ? "bg-primary/10 text-primary hover:bg-primary/20"
                      : "bg-muted/50 text-foreground/70 hover:bg-muted",
                )}
                title={attachedFiles.length > 0 ? `已附加 ${attachedFiles.length} 个文件，点击继续添加` : "上传文件，支持图片、txt、csv、xls、xlsx、pdf、doc、docx"}
                aria-label={attachedFiles.length > 0 ? `已附加 ${attachedFiles.length} 个文件` : "上传文件"}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <HomeTextModelPicker
                activeTheme={activeTheme}
                selectedKey={selectedTextModelKey}
                selectedLabel={selectedTextModelLabel}
                groups={textModelGroups}
                onSelect={onSelectTextModel}
              />
              <HomeImageModelPicker
                activeTheme={activeTheme}
                selectedKey={selectedImageModelKey}
                selectedLabel={selectedImageModelLabel}
                selectedResolution={imageGenerationPrefs.resolution}
                options={imageModelOptions}
                onSelect={onSelectImageModel}
                onSelectResolution={(resolution) =>
                  onConfirmImageSettings({
                    ...imageGenerationPrefs,
                    resolution,
                  })
                }
              />
              <HomeVideoModelPicker
                activeTheme={activeTheme}
                selectedKey={selectedVideoModelKey}
                selectedLabel={selectedVideoModelLabel}
                selectedResolution={videoGenerationPrefs.resolution}
                options={videoModelOptions}
                onSelect={onSelectVideoModel}
                onSelectResolution={(resolution) =>
                  onConfirmVideoResolution({
                    ...videoGenerationPrefs,
                    resolution,
                  })
                }
              />
              <HomeImageSettingsPopover
                activeTheme={activeTheme}
                value={imageGenerationPrefs}
                onConfirm={onConfirmImageSettings}
                videoPrefs={videoGenerationPrefs}
                onConfirmVideoPrefs={onConfirmVideoPrefs}
                creationMode={creationMode}
                onCreationModeChange={onCreationModeChange}
                onDevImageViewModeChange={onDevImageViewModeChange}
              />
            </div>
            <div className="flex items-center gap-1.5">
              {showInterruptButton ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "h-9 w-9 rounded-full sm:h-10 sm:w-10",
                    activeTheme
                      ? "bg-white/[0.06] text-white hover:bg-white/[0.1]"
                      : "bg-muted/50 text-foreground/70 hover:bg-muted",
                  )}
                  aria-label="停止当前执行"
                  title="停止当前执行"
                  onClick={handleStopCurrentExecution}
                >
                  <Square className="h-4 w-4 fill-current" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon"
                disabled={isSubmitDisabled}
                className={cn(
                  "h-9 w-9 rounded-full shadow-none sm:h-10 sm:w-10",
                  composerPrimaryAction === "send" && !isSubmitDisabled && "composer-shell-style-capture-action",
                  isTextEntryLocked && "disabled:!opacity-100",
                  activeTheme
                    ? "bg-white text-slate-950 hover:bg-white/90 disabled:bg-white/[0.14] disabled:text-white/34 disabled:hover:bg-white/[0.14]"
                    : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground",
                )}
                aria-label="发送消息"
                title="发送消息"
                onClick={handleComposerSubmit}
              >
                {streaming && !qState ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
      </div>
      <div className="flex justify-center pt-1">
        <button
          type="button"
          onClick={() => {
            onDevModeChange?.(!devMode);
          }}
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[9.5px] font-medium tracking-wider uppercase transition-colors",
            devMode
              ? "border-amber-400/40 bg-amber-400/10 text-amber-400/80 hover:bg-amber-400/15"
              : "border-border/30 bg-transparent text-foreground/20 hover:border-border/50 hover:text-foreground/35",
          )}
          title={devMode ? "关闭开发者模式" : "开启开发者模式"}
        >
          {devMode ? "● DEV" : "DEV"}
        </button>
      </div>
    </motion.div>
    </div>
  );
});

export const IdleLanding = memo(function IdleLanding({
  composer,
  reduceMotion,
  title,
  trackClassName,
}: {
  composer: ReactNode;
  reduceMotion: boolean;
  title: string;
  trackClassName: string;
}) {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-100px)] w-full max-w-[1060px] flex-col justify-center pb-14 pt-4 sm:pb-[4.5rem]">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto w-full max-w-[760px]"
      >
        <div className="mb-4 space-y-1.5 text-center">
          <h1 className="text-[21px] font-medium tracking-[-0.045em] text-foreground md:text-[28px]">{title}</h1>
          <p className="mx-auto max-w-[520px] text-[12.5px] leading-5.5 text-muted-foreground sm:text-[13px]">
            直接开始说目标。会话启动后，同一个输入框会在这一页自然沉到底部，继续推进完整工作流。
          </p>
        </div>
        <div className={cn("mx-auto w-full", trackClassName)}>{composer}</div>
      </motion.div>
    </div>
  );
});
