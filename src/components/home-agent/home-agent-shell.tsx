import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Menu,
  Paperclip,
  PencilLine,
  Play,
  RefreshCw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
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
} from "@/lib/home-agent/types";
import type { Task as RuntimeTask } from "@/lib/agent/tools/task-tools";
import { cn } from "@/lib/utils";
import { AssistantCreationGuideBody } from "./AssistantCreationGuideBody";
import { cloneConversationArtifact } from "@/lib/home-agent/message-artifact-snapshots";
import ComposerChoiceModal, {
  type ComposerWorkflowProgress,
} from "./ComposerChoiceModal";
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
const { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
const LazyScriptArtifactPanel = React.lazy(async () => {
  const mod = await import("./ScriptArtifactPanel");
  return { default: mod.ScriptArtifactPanel };
});

function isLocalMediaPreviewUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  return url.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(url) || /^\\\\/.test(url);
}

function normalizeLocalMediaPreviewPath(url: string): string {
  if (!url.startsWith("file://")) return url;
  let normalized = decodeURIComponent(url.replace(/^file:\/\/+/, ""));
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.replace(/\//g, "\\");
}

function getRenderableMediaPreviewUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  if (!isLocalMediaPreviewUrl(url)) return url;
  const exists = window.electronAPI?.storage?.exists;
  if (typeof exists !== "function") return url;
  try {
    return exists(normalizeLocalMediaPreviewPath(url)) ? url : undefined;
  } catch {
    return undefined;
  }
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
}: {
  progress: ComposerWorkflowProgress;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <div className="w-full space-y-1 pt-1.5">
      {/* 展开时：标题行 */}
      {!collapsed && (
        <div className="flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin text-foreground/40 shrink-0" />
          <span className="text-[12px] font-medium text-foreground/80">{progress.title}</span>
        </div>
      )}

      {/* 进度行（始终显示） */}
      <div className="flex items-center gap-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground tabular-nums">
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

  useEffect(() => {
    if (!editing) setEditDraft(message.content);
  }, [message.content, editing]);

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
  const hideAssistantRegenerateForMedia =
    message.role === "assistant" &&
    Boolean(message.attachments?.some((attachment) => attachment.kind === "image" || attachment.kind === "video"));

  const canSubmitUserEdit =
    editDraft.trim().length > 0 && editDraft.trim() !== message.content.trim();

  const handleCopyUserMessage = () => {
    void navigator.clipboard.writeText(message.content).catch(() => {});
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
              <AssistantCreationGuideBody
                messageId={message.id}
                autoOpenPresetPicker={Boolean(autoOpenCreationGuidePicker)}
                content={message.content}
                onCreationGuidePick={onCreationGuidePick}
                picksDisabled={Boolean(editsDisabled)}
                className="text-foreground/82"
              />
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
                  <span>{message.streamLabel}</span>
                  <span className="inline-flex gap-1">
                    <span className="h-1 w-1 rounded-full bg-foreground/28" />
                    <span className="h-1 w-1 rounded-full bg-foreground/22" />
                    <span className="h-1 w-1 rounded-full bg-foreground/16" />
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
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="group flex max-w-[min(100%,720px)] items-center justify-end gap-1 sm:max-w-[min(92%,680px)]">
          {editing ? (
            <div
              className="pointer-events-none flex shrink-0 select-none items-center gap-px pr-0.5 opacity-0"
              aria-hidden
            >
              <span className="h-8 w-8" />
              <span className="h-8 w-8" />
            </div>
          ) : showUserActions ? (
            <div className="flex shrink-0 items-center gap-px pr-0.5 text-muted-foreground opacity-[0.85] transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
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
            ref={editing ? undefined : bubbleRef}
            className={cn(
              "min-w-0",
              editing
                ? "border-0 bg-transparent p-0 shadow-none"
                : "max-w-[68%] rounded-[18px] border border-border bg-muted/40 px-3.5 py-2 text-[12.5px] leading-[1.62] text-foreground/80 sm:max-w-[60%] sm:text-[13px] sm:leading-[1.68]",
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
              <div className="space-y-1.5">
                {isFullAutoProxyMessage ? (
                  <div className="flex justify-end">
                    <span className="inline-flex h-5 items-center rounded-full border border-primary/35 bg-primary/12 px-2 text-[10px] font-semibold text-primary">
                      AI代理
                    </span>
                  </div>
                ) : null}
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
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
      )}
    </motion.div>
  );
});

const TIMELINE_INITIAL_VISIBLE = 40;
const TIMELINE_LOAD_MORE_STEP = 40;

function ArtifactPanelFallback() {
  return (
    <div className="mt-2 rounded-2xl border border-border/70 bg-muted/20 px-4 py-3 text-[12px] text-muted-foreground">
      正在加载步骤面板…
    </div>
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  messages,
  endRef,
  streaming,
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
}: {
  messages: HomeAgentMessage[];
  endRef: RefObject<HTMLDivElement | null>;
  streaming?: boolean;
  hasFloatingDock?: boolean;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
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
}) {
  const reduceMotion = useReducedMotion();
  const [visibleCount, setVisibleCount] = useState(TIMELINE_INITIAL_VISIBLE);

  // 切换项目时重置可见数量（通过检测第一条消息 id 变化）
  const firstMessageId = messages[0]?.id;
  const prevFirstMessageIdRef = useRef(firstMessageId);
  if (prevFirstMessageIdRef.current !== firstMessageId) {
    prevFirstMessageIdRef.current = firstMessageId;
    if (visibleCount !== TIMELINE_INITIAL_VISIBLE) setVisibleCount(TIMELINE_INITIAL_VISIBLE);
  }

  const hasPendingAssistantMessage = messages.some(
    (message) => message.role === "assistant" && message.status === "pending",
  );
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const syntheticStreamingMessage =
    streaming && !hasPendingAssistantMessage
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
              onClick={() => setVisibleCount((c) => c + TIMELINE_LOAD_MORE_STEP)}
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
            snapshot?.projectKind,
          );
          const messageArtifacts = shouldUseLiveScriptProgress
            ? mergeLiveScriptProgressArtifact(scopedArtifacts, liveScriptProgressArtifact)
            : scopedArtifacts;
          const isDirectReviewTarget =
            directBatchReviewTrigger?.targetMessageId === message.id ||
            directSingleReviewTrigger?.targetMessageId === message.id;
          const shouldPassBatchReviewTrigger =
            isLatestAssistantMessage && directBatchReviewTrigger?.targetMessageId === message.id;
          const shouldPassSingleReviewTrigger =
            isLatestAssistantMessage && directSingleReviewTrigger?.targetMessageId === message.id;
          const reviewWorkspaceOnly =
            isDirectReviewWorkspaceMessage(message) || isDirectReviewTarget;

          const filteredSnapshot =
            messageArtifacts.length && snapshot
              ? { ...snapshot, artifacts: messageArtifacts }
              : null;

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
                      onArtifactAction={onArtifactAction}
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
              allConversationImages={allConversationImages}
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
                        onArtifactAction={onArtifactAction}
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
  messages,
  tasks,
  onStopTask,
  endRef,
  streaming,
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
}: {
  messages: HomeAgentMessage[];
  tasks: RuntimeTask[];
  onStopTask: (taskId: string) => void;
  endRef: RefObject<HTMLDivElement | null>;
  streaming: boolean;
  trackClassName: string;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
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
}) {
  const isMobile = useIsMobile();
  const showFloatingTaskDock = tasks.length > 0 && !isMobile;
  const showMobileTaskDock = tasks.length > 0 && isMobile;

  return (
    <div className={cn("relative mx-auto w-full flex-1 overflow-visible", trackClassName)}>
      {tasks.length ? (
        <>
          {showMobileTaskDock ? (
            <div className="mb-2.5">
              <BackgroundTaskDock tasks={tasks} onStopTask={onStopTask} />
            </div>
          ) : null}
          {showFloatingTaskDock ? (
            <div className="pointer-events-none fixed right-3 top-3 z-30 md:right-5 md:top-4">
              <div className="pointer-events-auto">
                <BackgroundTaskDock tasks={tasks} onStopTask={onStopTask} floating />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <ConversationTimeline
        messages={messages}
        endRef={endRef}
        streaming={streaming}
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
                className="pointer-events-none absolute inset-x-4 -top-2 h-[2px] rounded-full bg-primary shadow-[0_0_18px_hsl(var(--primary)/0.65)]"
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
  const steps = run.plan?.steps ?? [];
  const currentIndex = Math.max(0, run.currentStepIndex);

  if (!steps.length) return null;

  return (
    <aside className="pointer-events-none fixed right-5 top-1/2 z-30 hidden w-[190px] -translate-y-1/2 xl:block">
      <div className="pointer-events-auto rounded-[8px] border border-border/80 bg-background/88 px-3 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="truncate text-[11px] font-medium text-foreground">全自动执行</span>
          {onStop ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-2 text-[11px]"
              onClick={onStop}
            >
              <Square className="mr-1 h-3 w-3" />
              停止
            </Button>
          ) : null}
        </div>
        <div className="max-h-[58vh] space-y-1.5 overflow-hidden">
          {steps.map((step, index) => {
            const done = index < currentIndex || run.status === "completed";
            const active = index === currentIndex && run.status !== "completed";
            const stopped = (run.status === "stopped" && index === currentIndex) || step.status === "stopped";
            return (
              <div key={step.id} className="grid grid-cols-[14px_1fr] gap-2">
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "mt-1 h-2.5 w-2.5 rounded-full border transition-colors",
                      stopped
                        ? "border-red-400 bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.55)]"
                        : done
                        ? "border-primary bg-primary"
                        : active
                          ? "animate-pulse border-primary bg-primary/70 shadow-[0_0_12px_hsl(var(--primary)/0.65)]"
                          : "border-border bg-muted",
                    )}
                  />
                  {index < steps.length - 1 ? (
                    <span className={cn("mt-1 h-4 w-px", done ? "bg-primary/55" : "bg-border")} />
                  ) : null}
                </div>
                <div className="min-w-0">
                  <div className={cn("truncate text-[11px]", active ? "text-foreground" : "text-muted-foreground")}>
                    {step.label}
                  </div>
                  {active ? (
                    <div className="truncate text-[9.5px] text-primary">
                      {run.status === "stopped"
                        ? "已停止"
                        : run.status === "retrying"
                          ? "重试中"
                          : run.status === "paused"
                            ? "已暂停"
                            : "执行中"}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
});

export const ActiveConversationShell = memo(function ActiveConversationShell({
  messages,
  tasks,
  onStopTask,
  endRef,
  composer,
  streaming,
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
  onStopFullAuto,
}: {
  messages: HomeAgentMessage[];
  tasks: RuntimeTask[];
  onStopTask: (taskId: string) => void;
  endRef: RefObject<HTMLDivElement | null>;
  composer: ReactNode;
  streaming: boolean;
  trackClassName: string;
  snapshot?: ConversationProjectSnapshot | null;
  workflowProgress?: ComposerWorkflowProgress | null;
  onArtifactAction?: (
    value: string,
    label: string,
    input?: Record<string, unknown>,
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
  onStopFullAuto?: () => void;
}) {
  const latestMessage = messages[messages.length - 1];
  const latestMessageHasMedia = Boolean(
    latestMessage?.attachments?.some((attachment) => attachment.kind === "image" || attachment.kind === "video"),
  );

  const showFullAutoRail = Boolean(
    fullAutoRun?.plan &&
      fullAutoRun.status !== "idle" &&
      fullAutoRun.status !== "completed",
  );

  return (
    <div className="mx-auto flex min-h-[calc(100vh-112px)] w-full flex-col overflow-visible">
      {showFullAutoRail ? (
        <FullAutoProgressRail run={fullAutoRun!} onStop={onStopFullAuto} />
      ) : null}
      <ActiveConversationViewport
        messages={messages}
        tasks={tasks}
        onStopTask={onStopTask}
        endRef={endRef}
        streaming={streaming}
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
  qState: unknown | null;
  selectedValues: string[];
  streaming: boolean;
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
  onSelectVideoModel: (key: string) => void;
  onConfirmVideoResolution: (prefs: VideoGenerationPrefs) => void;
  onDevVideoGenerationModeChange?: (mode: VideoGenerationPrefs["mode"]) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
  onSelectChoice: (value: string, label: string) => void;
  onConfirmQuestion?: () => void;
  onBackQuestion?: () => void;
  onDismissQuestion?: () => void;
  onLaunchAction?: (actionId: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  creationMode: CreationMode;
  onCreationModeChange: (mode: CreationMode) => void;
  devMode?: boolean;
  onDevModeChange?: (enabled: boolean) => void;
  /** 外部控制的已附加文件列表 */
  attachedFiles?: File[];
  onAttachedFilesChange?: (files: File[]) => void;
  /** 会话中已生成的图片/视频附件，用于媒体收纳抽屉 */
  conversationMediaItems?: import("@/lib/agent/chat-attachments").ChatAttachment[];
}

// 媒体收纳抽屉单项组件
const MediaDrawerItem = memo(function MediaDrawerItem({
  item,
  activeTheme,
  onClick,
}: {
  item: import("@/lib/agent/chat-attachments").ChatAttachment;
  activeTheme: boolean;
  onClick: () => void;
}) {
  const isVideo = item.kind === "video";
  const previewUrl = getRenderableMediaPreviewUrl(item.previewUrl);

  const handleDragStart = (e: React.DragEvent) => {
    if (previewUrl) {
      e.dataTransfer.setData(
        "application/x-infinio-sidebar-image",
        JSON.stringify({ url: previewUrl, label: item.fileName, kind: isVideo ? "video" : "image" }),
      );
      e.dataTransfer.setData(
        "application/x-infinio-image",
        JSON.stringify({ url: previewUrl, fileName: item.fileName, kind: isVideo ? "video" : "image" }),
      );
      e.dataTransfer.effectAllowed = "copy";
    }
  };

  return (
    <div
      draggable={!!previewUrl}
      onDragStart={handleDragStart}
      onClick={() => {
        if (!previewUrl) return;
        onClick();
      }}
      className={cn(
        "group relative overflow-hidden rounded-xl border transition-colors",
        previewUrl ? "cursor-pointer" : "cursor-default",
        activeTheme
          ? "border-white/[0.08] bg-white/[0.04] hover:border-white/[0.16]"
          : "border-border/60 bg-muted/30 hover:border-border",
      )}
      title={item.fileName}
    >
      {/* 缩略图 — 固定 16:9 比例 */}
      <div className="relative aspect-video w-full overflow-hidden">
        {isVideo && previewUrl ? (
          <>
            <video
              src={previewUrl}
              className="h-full w-full object-cover"
              muted
              preload="metadata"
            />
            <span className="pointer-events-none absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded bg-black/50">
              <Play className="h-3 w-3 fill-white text-white" />
            </span>
          </>
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={item.fileName}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className={cn("flex h-full w-full items-center justify-center text-[11px]", activeTheme ? "text-white/30" : "text-muted-foreground/50")}>
            {isVideo ? "视频" : "图片"}
          </div>
        )}
      </div>
      {/* 文件名 */}
      <div className={cn(
        "truncate px-2 py-1.5 text-[10px]",
        activeTheme ? "text-white/50" : "text-muted-foreground/70",
      )}>
        {item.fileName}
      </div>
    </div>
  );
});

export const HomeComposer = memo(function HomeComposer({
  idle,
  maintenanceHint,
  launchNotice,
  initialDraft,
  draftResetVersion,
  draftPresence,
  onDraftChange,
  placeholder,
  question,
  workflowProgress = null,
  qState,
  selectedValues,
  streaming,
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
  onSelectVideoModel,
  onConfirmVideoResolution,
  onDevVideoGenerationModeChange,
  onDevImageViewModeChange,
  onSelectChoice,
  onConfirmQuestion,
  onBackQuestion,
  onDismissQuestion,
  onLaunchAction,
  onSubmit,
  onInterrupt,
  creationMode,
  onCreationModeChange,
  devMode = false,
  onDevModeChange,
  attachedFiles: externalAttachedFiles,
  onAttachedFilesChange,
  conversationMediaItems = [],
}: HomeComposerProps) {
  const [draft, setLocalDraft] = useState(initialDraft);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mediaDrawerOpen, setMediaDrawerOpen] = useState(false);
  const [imageLightboxIndex, setImageLightboxIndex] = useState<number | null>(null);
  const [videoLightboxIndex, setVideoLightboxIndex] = useState<number | null>(null);

  const imageItems = useMemo(() => conversationMediaItems.filter((i) => i.kind !== "video"), [conversationMediaItems]);
  const videoItems = useMemo(() => conversationMediaItems.filter((i) => i.kind === "video"), [conversationMediaItems]);

  // 监听来自素材库按钮的 toggle 事件
  React.useEffect(() => {
    const handler = () => setMediaDrawerOpen((v) => !v);
    window.addEventListener("media-drawer:toggle", handler);
    return () => window.removeEventListener("media-drawer:toggle", handler);
  }, []);

  // 广播当前状态给素材库按钮
  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent("media-drawer:state", {
      detail: { open: mediaDrawerOpen, count: conversationMediaItems.length },
    }));
  }, [mediaDrawerOpen, conversationMediaItems.length]);

  // 图片灯箱键盘导航
  React.useEffect(() => {
    if (imageLightboxIndex === null) return;
    const total = imageItems.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setImageLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
      else if (e.key === "ArrowRight") setImageLightboxIndex((i) => ((i ?? 0) + 1) % total);
      else if (e.key === "Escape") setImageLightboxIndex(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imageLightboxIndex, imageItems.length]);

  // 视频灯箱键盘导航
  React.useEffect(() => {
    if (videoLightboxIndex === null) return;
    const total = videoItems.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setVideoLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
      else if (e.key === "ArrowRight") setVideoLightboxIndex((i) => ((i ?? 0) + 1) % total);
      else if (e.key === "Escape") setVideoLightboxIndex(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [videoLightboxIndex, videoItems.length]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachedFiles = externalAttachedFiles ?? [];
  const attachedImageCount = attachedFiles.filter(isSupportedImageFile).length;

  useEffect(() => {
    setLocalDraft(initialDraft);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [initialDraft, draftResetVersion]);

  // 从聊天消息/侧边栏拖拽媒体到输入框
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

    // 处理从侧边栏/媒体收纳拖入的媒体文件
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
      {/* 媒体收纳抽屉 — fixed 定位，紧贴输入框左侧，不遮挡聊天内容 */}
      <AnimatePresence>
        {mediaDrawerOpen && conversationMediaItems.length > 0 ? (
          <motion.div
            key="media-drawer"
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -20, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              "fixed bottom-[calc(env(safe-area-inset-bottom)+10px+1rem)] left-3.5 z-30 flex w-[260px] flex-col overflow-hidden rounded-2xl border shadow-2xl sm:left-4 md:left-8 lg:left-[calc(var(--home-sidebar-offset,0px)+2rem)]",
              activeTheme
                ? "border-white/[0.1] bg-[#13131f]/96 backdrop-blur-xl"
                : "border-border bg-card/96 backdrop-blur-xl",
            )}
            style={{ top: "calc(env(safe-area-inset-top) + 56px)", maxHeight: "calc(100vh - env(safe-area-inset-top) - 56px - env(safe-area-inset-bottom) - 10px - 1rem)" }}
          >
            {/* 抽屉头部 */}
            <div className={cn(
              "flex shrink-0 items-center justify-between px-3.5 py-2.5 border-b",
              activeTheme ? "border-white/[0.08]" : "border-border/60",
            )}>
              <span className={cn("text-[12px] font-medium", activeTheme ? "text-white/70" : "text-foreground/70")}>
                媒体记录 · {conversationMediaItems.length}
              </span>
              <button
                type="button"
                onClick={() => setMediaDrawerOpen(false)}
                className={cn(
                  "rounded-full p-0.5 transition-colors",
                  activeTheme ? "text-white/40 hover:text-white/70" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* 缩略图列表 — 单列，固定 16:9 比例，可滚动 */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5 sidebar-scrollbar">
              <div className="flex flex-col gap-2">
                {conversationMediaItems.map((item) => (
                  <MediaDrawerItem
                    key={item.id}
                    item={item}
                    activeTheme={activeTheme}
                    onClick={() => {
                      if (item.kind === "video") {
                        const idx = videoItems.findIndex((v) => v.id === item.id);
                        if (idx >= 0) setVideoLightboxIndex(idx);
                      } else {
                        const idx = imageItems.findIndex((v) => v.id === item.id);
                        if (idx >= 0) setImageLightboxIndex(idx);
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 图片灯箱 */}
      {imageLightboxIndex !== null && imageItems[imageLightboxIndex] ? (() => {
        const total = imageItems.length;
        const item = imageItems[imageLightboxIndex];
        return (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80"
            onClick={() => setImageLightboxIndex(null)}
          >
            <div
              className="relative flex w-[min(96vw,900px)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                if (total <= 1) return;
                e.stopPropagation();
                if (e.deltaY > 0) setImageLightboxIndex((i) => ((i ?? 0) + 1) % total);
                else setImageLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
              }}
            >
              <div className="flex shrink-0 items-center border-b border-border px-5 py-3 pr-12">
                <span className="flex-1 truncate text-[13px] font-medium text-foreground">{item.fileName}</span>
                {total > 1 && (
                  <span className="ml-3 shrink-0 text-[11px] text-muted-foreground">{imageLightboxIndex + 1} / {total}</span>
                )}
                <button
                  type="button"
                  onClick={() => setImageLightboxIndex(null)}
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div
                className="relative flex max-h-[min(78vh,720px)] items-center justify-center overflow-auto bg-muted/30 p-4"
                onWheel={(e) => {
                  if (total <= 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.deltaY > 0) setImageLightboxIndex((i) => ((i ?? 0) + 1) % total);
                  else setImageLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
                }}
              >
                {item.previewUrl ? (
                  <img
                    key={item.id}
                    src={item.previewUrl}
                    alt={item.fileName}
                    className="max-h-[min(72vh,680px)] max-w-full rounded-xl object-contain shadow-lg"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">暂无预览</p>
                )}
                {total > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setImageLightboxIndex((i) => ((i ?? 0) - 1 + total) % total)}
                      className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                      aria-label="上一个"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setImageLightboxIndex((i) => ((i ?? 0) + 1) % total)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                      aria-label="下一个"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
              </div>
              {total > 1 && (
                <div
                  className="flex items-center gap-2 overflow-x-auto border-t border-border px-4 py-2.5"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "hsl(var(--border)) transparent" }}
                  onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
                >
                  {imageItems.map((thumb, idx) => (
                    <button
                      key={thumb.id}
                      type="button"
                      onClick={() => setImageLightboxIndex(idx)}
                      className={cn(
                        "relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition",
                        idx === imageLightboxIndex ? "border-primary" : "border-transparent opacity-60 hover:opacity-90",
                      )}
                    >
                      {thumb.previewUrl ? (
                        <img src={thumb.previewUrl} alt={thumb.fileName} className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full bg-muted/50" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })() : null}

      {/* 视频灯箱 */}
      {videoLightboxIndex !== null && videoItems[videoLightboxIndex] ? (() => {
        const total = videoItems.length;
        const item = videoItems[videoLightboxIndex];
        const previewUrl = getRenderableMediaPreviewUrl(item.previewUrl);
        return (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80"
            onClick={() => setVideoLightboxIndex(null)}
          >
            <div
              className="relative flex w-[min(96vw,900px)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              onWheel={(e) => {
                if (total <= 1) return;
                e.stopPropagation();
                if (e.deltaY > 0) setVideoLightboxIndex((i) => ((i ?? 0) + 1) % total);
                else setVideoLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
              }}
            >
              <div className="flex shrink-0 items-center border-b border-border px-5 py-3 pr-12">
                <span className="flex-1 truncate text-[13px] font-medium text-foreground">{item.fileName}</span>
                {total > 1 && (
                  <span className="ml-3 shrink-0 text-[11px] text-muted-foreground">{videoLightboxIndex + 1} / {total}</span>
                )}
                <button
                  type="button"
                  onClick={() => setVideoLightboxIndex(null)}
                  className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div
                className="relative flex max-h-[min(78vh,720px)] items-center justify-center overflow-auto bg-muted/30 p-4"
                onWheel={(e) => {
                  if (total <= 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.deltaY > 0) setVideoLightboxIndex((i) => ((i ?? 0) + 1) % total);
                  else setVideoLightboxIndex((i) => ((i ?? 0) - 1 + total) % total);
                }}
              >
                {previewUrl ? (
                  <video
                    key={item.id}
                    src={previewUrl}
                    controls
                    className="max-h-[min(72vh,680px)] max-w-full rounded-xl shadow-lg"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">暂无预览</p>
                )}
                {total > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setVideoLightboxIndex((i) => ((i ?? 0) - 1 + total) % total)}
                      className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                      aria-label="上一个"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setVideoLightboxIndex((i) => ((i ?? 0) + 1) % total)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                      aria-label="下一个"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </>
                )}
              </div>
              {total > 1 && (
                <div
                  className="flex items-center gap-2 overflow-x-auto border-t border-border px-4 py-2.5"
                  style={{ scrollbarWidth: "thin", scrollbarColor: "hsl(var(--border)) transparent" }}
                  onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
                >
                  {videoItems.map((thumb, idx) => (
                    <button
                      key={thumb.id}
                      type="button"
                      onClick={() => setVideoLightboxIndex(idx)}
                      className={cn(
                        "relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition",
                        idx === videoLightboxIndex ? "border-primary" : "border-transparent opacity-60 hover:opacity-90",
                      )}
                    >
                      {getRenderableMediaPreviewUrl(thumb.previewUrl) ? (
                        <video src={getRenderableMediaPreviewUrl(thumb.previewUrl)} className="h-full w-full object-cover" muted preload="metadata" />
                      ) : (
                        <div className="h-full w-full bg-muted/50" />
                      )}
                      <span className="pointer-events-none absolute bottom-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/50">
                        <Play className="h-2.5 w-2.5 fill-white text-white" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })() : null}

      <ComposerChoiceModal
        question={question}
        progress={workflowProgress}
        onSelect={onSelectChoice}
        onConfirm={onConfirmQuestion}
        onBack={onBackQuestion}
        onDismiss={onDismissQuestion}
        canConfirm={selectedValues.length > 0 || draftPresence || !!draft.trim() || attachedFiles.length > 0}
        tone={activeTheme ? "dark" : "light"}
        devMode={devMode}
        devVideoGenerationMode={videoGenerationPrefs.mode}
        devImageViewMode={imageGenerationPrefs.viewMode}
        onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
        onDevImageViewModeChange={onDevImageViewModeChange}
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
          composerShellClass,
          isDragOver && "ring-2 ring-primary/50 ring-offset-1",
        )}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-primary/5">
            <span className="rounded-full bg-primary/10 px-3 py-1 text-[12px] text-primary/80">
              拖放媒体到输入框
            </span>
          </div>
        )}
        {idle ? null : maintenanceHint ? (
          <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-0 pt-1 md:px-6">
            {maintenanceHint ? (
              <div className="hidden max-w-[200px] truncate rounded-full border border-border/30 bg-muted/20 px-2 py-1 text-[9px] text-muted-foreground/40 xl:block">
                {maintenanceHint}
              </div>
            ) : null}
          </div>
        ) : null}
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
          <Textarea
            value={draft}
            onChange={(e) => {
              const nextValue = e.target.value;
              setLocalDraft(nextValue);
              onDraftChange(nextValue);
            }}
            placeholder={placeholder}
            rows={idle ? 3 : 3}
            className={cn(
              "h-[88px] resize-none overflow-y-auto border-none bg-transparent px-0 pb-2 pt-1.5 text-[13.5px] leading-6.5 shadow-none outline-none ring-0 ring-offset-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:h-[96px] sm:text-[14px]",
              activeTheme
                ? "text-white placeholder:text-white/28"
                : "text-foreground placeholder:text-muted-foreground/50",
              idle && "h-[112px] sm:h-[120px] md:h-[128px]",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn(
                  "h-9 w-9 rounded-full sm:h-10 sm:w-10",
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
                creationMode={creationMode}
                onCreationModeChange={onCreationModeChange}
              />
            </div>
            <div className="flex items-center gap-1.5">
              {streaming && !qState ? (
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
                  onClick={onInterrupt}
                >
                  <Square className="h-4 w-4 fill-current" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon"
                disabled={(!(draftPresence || draft.trim() || attachedFiles.length > 0) && !(qState && selectedValues.length > 0)) || (streaming && !qState)}
                className={cn(
                  "h-9 w-9 rounded-full shadow-none sm:h-10 sm:w-10",
                  activeTheme ? "bg-white text-slate-950 hover:bg-white/90" : "bg-foreground text-background hover:bg-foreground/90",
                )}
                onClick={onSubmit}
              >
                {streaming && !qState ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
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
