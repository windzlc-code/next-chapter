import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AudioWaveform,
  ArrowUpRight,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  FolderOpen,
  Play,
  GripHorizontal,
  History,
  Image,
  Images,
  MoreVertical,
  Package,
  Pause,
  Pin,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import BrandMark from "@/components/BrandMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ResizablePanelGroup, ResizablePanel } from "@/components/ui/resizable";
import { PanelResizeHandle } from "react-resizable-panels";
import { useIsMobile } from "@/hooks/use-mobile";
import HomeAgentConfirmDialog from "./HomeAgentConfirmDialog";
import type {
  AutomationMode,
  ConversationProjectSnapshot,
  FullAutoRunStatus,
  StudioSessionState,
} from "@/lib/home-agent/types";
import { cn } from "@/lib/utils";
import { formatSegmentContinuityRecapDisplayText } from "@/lib/home-agent/segment-continuity-recap";
import {
  filterRecentProjectsForAutomationMode,
  mergeRecentProjectsWithSessionSnapshots,
  reconcileRecentProjectsWithStableOrder,
  resolveEffectiveProjectAutomationMode,
} from "./home-agent-session-utils";
import {
  compareSidebarAssetDisplayOrder,
  isLocalSidebarAssetUrl,
  normalizeSidebarAssetPath,
  remapToCurrentFilesRoot,
  getSidebarAudioSrc,
  resolveSidebarAssetPreviewUrl,
  getSidebarVideoSrc,
  SEGMENT_VIDEO_LABEL_PREFIX,
  type SidebarAssetItem,
} from "./home-agent-sidebar-utils";

const { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } = React;

type SidebarCharacterAudioPlaybackSnapshot = {
  targetId: string | null;
  url: string | null;
  isPlaying: boolean;
};

let sidebarCharacterAudioElement: HTMLAudioElement | null = null;
let sidebarCharacterAudioSnapshot: SidebarCharacterAudioPlaybackSnapshot = {
  targetId: null,
  url: null,
  isPlaying: false,
};
const sidebarCharacterAudioListeners = new Set<() => void>();

function emitSidebarCharacterAudioSnapshot() {
  sidebarCharacterAudioListeners.forEach((listener) => listener());
}

function setSidebarCharacterAudioSnapshot(
  next: Partial<SidebarCharacterAudioPlaybackSnapshot>,
) {
  sidebarCharacterAudioSnapshot = {
    ...sidebarCharacterAudioSnapshot,
    ...next,
  };
  emitSidebarCharacterAudioSnapshot();
}

function getSidebarCharacterAudioPlaybackSnapshot(): SidebarCharacterAudioPlaybackSnapshot {
  return sidebarCharacterAudioSnapshot;
}

function subscribeSidebarCharacterAudioPlayback(listener: () => void) {
  sidebarCharacterAudioListeners.add(listener);
  return () => {
    sidebarCharacterAudioListeners.delete(listener);
  };
}

function ensureSidebarCharacterAudioElement() {
  if (sidebarCharacterAudioElement) return sidebarCharacterAudioElement;

  const audio = new Audio();
  audio.addEventListener("play", () => {
    setSidebarCharacterAudioSnapshot({ isPlaying: true });
  });
  audio.addEventListener("pause", () => {
    setSidebarCharacterAudioSnapshot({ isPlaying: false });
  });
  audio.addEventListener("ended", () => {
    setSidebarCharacterAudioSnapshot({ isPlaying: false });
  });
  audio.addEventListener("error", () => {
    setSidebarCharacterAudioSnapshot({ isPlaying: false });
  });
  sidebarCharacterAudioElement = audio;
  return audio;
}

function stopSidebarCharacterAudioPlayback(targetId?: string | null) {
  if (
    targetId &&
    sidebarCharacterAudioSnapshot.targetId &&
    sidebarCharacterAudioSnapshot.targetId !== targetId
  ) {
    return;
  }
  const audio = sidebarCharacterAudioElement;
  if (!audio) {
    setSidebarCharacterAudioSnapshot({
      targetId: targetId ?? null,
      url: null,
      isPlaying: false,
    });
    return;
  }
  audio.pause();
  audio.src = "";
  setSidebarCharacterAudioSnapshot({
    targetId: targetId ?? null,
    url: null,
    isPlaying: false,
  });
}

async function toggleSidebarCharacterAudioPlayback(
  playableUrl: string,
  targetId?: string | null,
) {
  const audio = ensureSidebarCharacterAudioElement();
  const normalizedTargetId = targetId?.trim() || null;
  const isSameSelection =
    sidebarCharacterAudioSnapshot.url === playableUrl &&
    sidebarCharacterAudioSnapshot.targetId === normalizedTargetId;

  if (!isSameSelection) {
    audio.pause();
    audio.src = playableUrl;
    setSidebarCharacterAudioSnapshot({
      targetId: normalizedTargetId,
      url: playableUrl,
      isPlaying: false,
    });
  }

  if (isSameSelection && !audio.paused) {
    audio.pause();
    return;
  }

  try {
    await audio.play();
  } catch {
    setSidebarCharacterAudioSnapshot({ isPlaying: false });
  }
}

const IMAGE_SUB_TABS = [
  "\u89d2\u8272",
  "\u573a\u666f",
  "\u5206\u955c",
  "\u5176\u4ed6",
] as const;
type ImageSubTab = (typeof IMAGE_SUB_TABS)[number];
const OTHER_IMAGE_SUB_TAB: ImageSubTab = IMAGE_SUB_TABS[3];
const VIDEO_EPISODE_LABEL_PATTERN = /\u7b2c(\d+)\u96c6|(?:^\u7247\u6bb5 \u00b7 |\u7247\u6bb5)(\d+)-/;
const OTHER_IMAGE_META_MARKER = "\u5176\u4ed6\u56fe\u7247";
const IMAGE_SUB_TAB_PREFIX_MAP: readonly [ImageSubTab, string][] = [
  [IMAGE_SUB_TABS[0], IMAGE_SUB_TABS[0]],
  [IMAGE_SUB_TABS[1], IMAGE_SUB_TABS[1]],
  [IMAGE_SUB_TABS[2], IMAGE_SUB_TABS[2]],
];
const HISTORY_RENDER_CHUNK = 48;
const HISTORY_SWITCH_SETTLE_GLOBAL_KEY = "__homeAgentHistorySwitchSettleUntil";

function readGlobalHistorySwitchSettleUntil(): number {
  if (typeof window === "undefined") return 0;
  const value = (window as unknown as Record<string, unknown>)[HISTORY_SWITCH_SETTLE_GLOBAL_KEY];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function writeGlobalHistorySwitchSettleUntil(value: number): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>)[HISTORY_SWITCH_SETTLE_GLOBAL_KEY] = value;
}
const ASSET_RENDER_CHUNK = 60;
const SIDEBAR_RENDER_PREFETCH_PX = 180;
const SIDEBAR_BLUE_VIOLET_TEXT = "text-[rgb(156,174,255)]";
const SIDEBAR_BLUE_VIOLET_TEXT_SOFT = "text-[rgba(156,174,255,0.9)]";
const SIDEBAR_BLUE_VIOLET_BG = "bg-[rgba(108,126,210,0.14)]";
const SIDEBAR_BLUE_VIOLET_BG_STRONG = "bg-[rgba(108,126,210,0.18)]";
const SIDEBAR_BLUE_VIOLET_BORDER = "border-[rgba(132,150,236,0.34)]";
const SIDEBAR_BLUE_VIOLET_RING = "ring-[rgba(132,150,236,0.34)]";
const SIDEBAR_BLUE_VIOLET_DOT = "bg-[rgb(146,166,252)]";
const SIDEBAR_BLUE_VIOLET_GLOW = "shadow-[0_0_8px_2px_rgba(138,156,244,0.28)]";
const SIDEBAR_EXTRACTION_EVENT_NAME = "agent:segment-continuity-extraction";
const FULL_AUTO_HISTORY_TITLE_PREFIX_PATTERN =
  /^(?:视频工作流(?:入口)?|参考改编(?:入口)?|原创剧本立项|原创剧本)\s*[：:]\s*/u;

function resolveVisibleCount(
  totalCount: number,
  chunkSize: number,
  priorityIndex: number,
): number {
  if (totalCount <= 0) return 0;
  const baseCount = Math.min(totalCount, chunkSize);
  if (priorityIndex < 0 || priorityIndex < baseCount) return baseCount;
  const requiredChunkCount = Math.floor(priorityIndex / chunkSize) + 1;
  return Math.min(totalCount, requiredChunkCount * chunkSize);
}

function useIncrementalVisibleCount({
  totalCount,
  chunkSize,
  resetKey,
  priorityIndex = -1,
}: {
  totalCount: number;
  chunkSize: number;
  resetKey: string;
  priorityIndex?: number;
}) {
  const [visibleCount, setVisibleCount] = useState(() =>
    resolveVisibleCount(totalCount, chunkSize, priorityIndex),
  );
  const lastResetKeyRef = useRef(resetKey);

  useLayoutEffect(() => {
    const requiredCount = resolveVisibleCount(totalCount, chunkSize, priorityIndex);
    setVisibleCount((current) => {
      if (lastResetKeyRef.current !== resetKey) {
        lastResetKeyRef.current = resetKey;
        return requiredCount;
      }
      const clamped = Math.min(totalCount, current);
      return clamped < requiredCount ? requiredCount : clamped;
    });
  }, [chunkSize, priorityIndex, resetKey, totalCount]);

  const loadMore = useCallback(() => {
    setVisibleCount((current) => Math.min(totalCount, current + chunkSize));
  }, [chunkSize, totalCount]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    if (visibleCount >= totalCount) return;
    const currentTarget = event.currentTarget;
    const distanceToBottom =
      currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight;
    if (distanceToBottom <= SIDEBAR_RENDER_PREFETCH_PX) {
      loadMore();
    }
  }, [loadMore, totalCount, visibleCount]);

  return {
    visibleCount,
    hasMore: visibleCount < totalCount,
    handleScroll,
    loadMore,
  };
}

type SidebarSegmentExtractionVisualState = {
  projectId?: string;
  segmentLabel: string;
  status: "extracting" | "completed" | "failed";
  progress: number;
  message: string;
  updatedAt: string;
  frameCount?: number;
};

function clampSidebarProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function useSidebarSegmentExtractionStates(currentProjectId?: string) {
  const [states, setStates] = useState<Record<string, SidebarSegmentExtractionVisualState>>({});
  const cleanupTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (typeof window === "undefined") return;

    const clearTimer = (segmentLabel: string) => {
      const activeTimer = cleanupTimersRef.current.get(segmentLabel);
      if (activeTimer) {
        window.clearTimeout(activeTimer);
        cleanupTimersRef.current.delete(segmentLabel);
      }
    };

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SidebarSegmentExtractionVisualState>).detail;
      const segmentLabel = String(detail?.segmentLabel || "").trim();
      if (!segmentLabel) return;
      if (currentProjectId && detail?.projectId && detail.projectId !== currentProjectId) return;

      clearTimer(segmentLabel);
      const nextState: SidebarSegmentExtractionVisualState = {
        projectId: detail?.projectId,
        segmentLabel,
        status: detail?.status === "completed" || detail?.status === "failed" ? detail.status : "extracting",
        progress: clampSidebarProgress(detail?.progress ?? 0),
        message: String(detail?.message || "").trim(),
        updatedAt: detail?.updatedAt || new Date().toISOString(),
        ...(Number.isFinite(detail?.frameCount) ? { frameCount: Number(detail.frameCount) } : {}),
      };
      setStates((current) => ({
        ...current,
        [segmentLabel]: nextState,
      }));

      if (nextState.status === "completed" || nextState.status === "failed") {
        const timeoutId = window.setTimeout(() => {
          setStates((current) => {
            if (current[segmentLabel]?.updatedAt !== nextState.updatedAt) return current;
            const next = { ...current };
            delete next[segmentLabel];
            return next;
          });
          cleanupTimersRef.current.delete(segmentLabel);
        }, nextState.status === "completed" ? 8000 : 10000);
        cleanupTimersRef.current.set(segmentLabel, timeoutId);
      }
    };

    window.addEventListener(SIDEBAR_EXTRACTION_EVENT_NAME, handler as EventListener);
    return () => {
      window.removeEventListener(SIDEBAR_EXTRACTION_EVENT_NAME, handler as EventListener);
      cleanupTimersRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      cleanupTimersRef.current.clear();
    };
  }, [currentProjectId]);

  return states;
}

type SidebarAssetRowAction = {
  icon: LucideIcon;
  label: string;
  title: string;
  dataAttribute?: string;
  disabled?: boolean;
  onClick: (asset: SidebarAssetItem) => void | Promise<void>;
};

type SidebarAssetMenuSection = "primary" | "audio" | "secondary" | "file" | "danger";

type SidebarAssetMenuAction = {
  key: string;
  icon: LucideIcon;
  label: string;
  title: string;
  section: SidebarAssetMenuSection;
  disabled?: boolean;
  tone?: "default" | "danger";
  dataAttribute?: string;
  stateAttributes?: Record<string, string>;
  iconClassName?: string;
  closeMenuOnSelect?: boolean;
  onSelect: () => void | Promise<void>;
};

function getImageSubTabForAsset(asset: SidebarAssetItem): ImageSubTab | null {
  if (asset.kind !== "image") return null;
  if (
    asset.origin === "manual" ||
    asset.label.startsWith(OTHER_IMAGE_SUB_TAB) ||
    asset.meta.includes(OTHER_IMAGE_META_MARKER)
  ) {
    return OTHER_IMAGE_SUB_TAB;
  }
  for (const [tab, prefix] of IMAGE_SUB_TAB_PREFIX_MAP) {
    if (asset.label.startsWith(prefix)) {
      return tab;
    }
  }
  return null;
}

type HistoryItemMenuHandlers = {
  onTogglePinProject?: (project: ConversationProjectSnapshot) => void;
  onRenameProject?: (project: ConversationProjectSnapshot) => void;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onCleanExpiredVideos?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  onExportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onImportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onOpenProjectFolder?: (project: ConversationProjectSnapshot) => void;
};

const SidebarHistoryItem = memo(function SidebarHistoryItem({
  project,
  active,
  selected,
  collapsed,
  isSelectMode,
  visibleAutomationMode,
  onPrepareOpenProject,
  onOpenProject,
  onToggleSelect,
  handlers,
}: {
  project: ConversationProjectSnapshot;
  active: boolean;
  selected: boolean;
  collapsed: boolean;
  isSelectMode: boolean;
  visibleAutomationMode: AutomationMode;
  onPrepareOpenProject?: () => void;
  onOpenProject: (id: string) => void;
  onToggleSelect: (id: string) => void;
  handlers: HistoryItemMenuHandlers;
}) {
  const displayTitle = resolveSidebarHistoryProjectTitle(project.title, visibleAutomationMode);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const hasMenu = !collapsed && !isSelectMode && (
    handlers.onTogglePinProject || handlers.onRenameProject || handlers.onDuplicateProject ||
    handlers.onCleanExpiredVideos || handlers.onDeleteProject || handlers.onExportChatHistory || handlers.onImportChatHistory ||
    handlers.onOpenProjectFolder
  );
  const handleMenuAction = React.useCallback(
    (action?: (project: ConversationProjectSnapshot) => void) => (event: Event) => {
      event.preventDefault();
      setMenuOpen(false);
      window.setTimeout(() => {
        action?.(project);
      }, 0);
    },
    [project],
  );

  return (
    <div
      data-sidebar-history-id={project.projectId}
      className={cn(
        "group/hist flex w-full items-center rounded-[12px] py-1.5 transition-colors",
        collapsed ? "justify-center px-0" : "gap-1 pl-3 pr-1.5",
        isSelectMode && selected
          ? `${SIDEBAR_BLUE_VIOLET_BG} ring-1 ring-inset ${SIDEBAR_BLUE_VIOLET_RING}`
          : active && !isSelectMode
            ? `${SIDEBAR_BLUE_VIOLET_BG_STRONG} ring-1 ring-inset ${SIDEBAR_BLUE_VIOLET_RING}`
            : "hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (isSelectMode) {
            onToggleSelect(project.projectId);
          } else {
            onPrepareOpenProject?.();
            onOpenProject(project.projectId);
          }
        }}
        aria-label={displayTitle}
        title={displayTitle}
        className={cn("min-w-0 flex-1 text-left", collapsed && "flex justify-center")}
      >
        {collapsed ? (
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full border text-[10.5px] font-medium",
              active
                ? "border-primary/60 bg-primary/16 text-foreground"
                : "border-border bg-muted/30 text-foreground/70",
            )}
          >
            {compactSidebarLabel(displayTitle)}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            {isSelectMode ? (
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40 bg-transparent",
                )}
              >
                {selected ? <CheckSquare className="h-3 w-3" /> : null}
              </span>
            ) : (
              <span
                data-sidebar-history-status-dot="true"
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full transition-colors",
                  active ? `${SIDEBAR_BLUE_VIOLET_DOT} ${SIDEBAR_BLUE_VIOLET_GLOW}` : "bg-muted-foreground/30",
                )}
              />
            )}
            {project.automationMode === "full-auto" ? (
              <span
                data-sidebar-history-auto-badge="true"
                className={cn(
                  "shrink-0 rounded-[5px] border px-1.5 py-0.5 text-[8.5px] font-semibold leading-none",
                  SIDEBAR_BLUE_VIOLET_BORDER,
                  SIDEBAR_BLUE_VIOLET_BG,
                  SIDEBAR_BLUE_VIOLET_TEXT,
                )}
              >
                AUTO
              </span>
            ) : null}
            <span className="min-w-0 flex-1 pr-1">
              <span
                className={cn(
                  "block truncate text-[13.5px] font-medium leading-5",
                  active ? "text-foreground" : "text-foreground/80",
                )}
              >
                {project.pinned ? "📌 " : ""}
                {displayTitle}
              </span>
              <span
                data-sidebar-history-subtitle="true"
                className={cn("block truncate text-[11.5px] leading-5", active ? SIDEBAR_BLUE_VIOLET_TEXT_SOFT : "text-muted-foreground")}
              >
                {projectKindLabel(project.projectKind)} · {project.derivedStage} · {formatDateLabel(project.updatedAt)}
              </span>
            </span>
          </span>
        )}
      </button>
      {hasMenu ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 self-center items-center justify-center rounded-full border border-transparent bg-primary/20 text-foreground/70 opacity-0 transition hover:bg-primary/30 hover:text-foreground group-hover/hist:opacity-100 data-[state=open]:opacity-100"
              aria-label="会话菜单"
              title="会话菜单"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            avoidCollisions={false}
            className="w-44 rounded-xl border-border bg-card/96 p-1.5 text-foreground shadow-[0_20px_48px_rgba(0,0,0,0.25)] backdrop-blur-xl"
          >
            {handlers.onTogglePinProject ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onTogglePinProject)}
              >
                <Pin className="mr-2 h-4 w-4" />
                {project.pinned ? "取消置顶" : "固定（置顶）"}
              </DropdownMenuItem>
            ) : null}
            {handlers.onRenameProject ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onRenameProject)}
              >
                <Pencil className="mr-2 h-4 w-4" />
                重命名
              </DropdownMenuItem>
            ) : null}
            {handlers.onDuplicateProject ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onDuplicateProject)}
              >
                <Copy className="mr-2 h-4 w-4" />
                复制对话
              </DropdownMenuItem>
            ) : null}
            {handlers.onCleanExpiredVideos && project.projectKind === "video" ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onCleanExpiredVideos)}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                清理过期视频
              </DropdownMenuItem>
            ) : null}
            {(handlers.onExportChatHistory || handlers.onImportChatHistory || handlers.onOpenProjectFolder) ? (
              <DropdownMenuSeparator className="my-1 bg-border/60" />
            ) : null}
            {handlers.onExportChatHistory ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onExportChatHistory)}
              >
                <Download className="mr-2 h-4 w-4" />
                导出聊天记录
              </DropdownMenuItem>
            ) : null}
            {handlers.onImportChatHistory ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onImportChatHistory)}
              >
                <Upload className="mr-2 h-4 w-4" />
                导入聊天记录
              </DropdownMenuItem>
            ) : null}
            {handlers.onOpenProjectFolder ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-foreground focus:bg-muted focus:text-foreground"
                onSelect={handleMenuAction(handlers.onOpenProjectFolder)}
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                聊天记录文件
              </DropdownMenuItem>
            ) : null}
            {handlers.onDeleteProject ? (
              <DropdownMenuItem
                className="h-9 rounded-lg px-2.5 text-[13px] text-rose-600 dark:text-rose-300 focus:bg-rose-500/15 focus:text-rose-600 dark:focus:text-rose-200"
                onSelect={handleMenuAction(handlers.onDeleteProject)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
});


/** 侧边栏面板间可拖拽分隔线 */
function SidebarResizeHandle() {
  return (
    <PanelResizeHandle
      className={cn(
        "group/rh relative flex h-3 cursor-row-resize items-center justify-center mx-2",
        "transition-colors hover:bg-primary/5 data-[resize-handle-active=pointer]:bg-primary/10",
      )}
    >
      <div
        className={cn(
          "h-px w-full bg-border/60 transition-all duration-150",
          "group-hover/rh:h-0.5 group-hover/rh:bg-primary/40",
          "group-data-[resize-handle-active=pointer]/rh:bg-primary/60",
        )}
      />
      <GripHorizontal
        className={cn(
          "absolute h-3 w-4 text-muted-foreground/40 opacity-0 transition-opacity",
          "group-hover/rh:opacity-100",
          "group-data-[resize-handle-active=pointer]/rh:text-primary/60 group-data-[resize-handle-active=pointer]/rh:opacity-100",
        )}
      />
    </PanelResizeHandle>
  );
}

const ASSET_KIND_LABEL: Record<SidebarAssetItem["kind"], string> = {
  image: "image",
  video: "video",
  bundle: "bundle",
};

export type HomeAgentTemplate = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  icon: LucideIcon;
  disabled?: boolean;
  badge?: string;
};

function compactSidebarLabel(value: string): string {
  const trimmed = value.trim();
  return Array.from(trimmed)[0] ?? "•";
}

function resolveSidebarHistoryProjectTitle(value: string, visibleAutomationMode: AutomationMode): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (visibleAutomationMode !== "full-auto") return trimmed;
  const sanitized = trimmed.replace(FULL_AUTO_HISTORY_TITLE_PREFIX_PATTERN, "").trim();
  return sanitized || trimmed;
}

function projectKindLabel(kind?: ConversationProjectSnapshot["projectKind"]): string {
  return kind === "adaptation" ? "参考改编" : kind === "video" ? "视频工作流" : "原创剧本";
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDateLabel(value?: string): string {
  if (!value) return "刚刚整理";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚整理";
  return dateFormatter.format(date);
}

function truncateCopy(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

const SIDEBAR_PREVIEW_CACHE_LIMIT = 180;
const sidebarImagePreviewCache = new Map<string, string>();
const sidebarVideoThumbnailCache = new Map<string, string>();

function getSidebarPreviewCacheKey(url: string, projectId?: string): string {
  return `${projectId ?? "global"}:${url}`;
}

function getSidebarVideoThumbnailCacheKey(url: string): string {
  return `video:v2:${url}`;
}

function rememberSidebarPreview(cache: Map<string, string>, key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size <= SIDEBAR_PREVIEW_CACHE_LIMIT) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey) cache.delete(oldestKey);
}

function useNearViewport<T extends HTMLElement>(enabled: boolean, rootMargin = "240px") {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setNearViewport(false);
      return;
    }

    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return [ref, nearViewport] as const;
}

function getSidebarVideoThumbnailTimes(video: HTMLVideoElement): number[] {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0.2) return [0];
  const latestSafeTime = Math.max(0, duration - 0.05);
  const fixedCandidates = [0.5, 1].map((time) => Math.min(time, latestSafeTime));
  const ratioCandidates = [0.15, 0.3, 0.5].map((ratio) => Math.min(duration * ratio, latestSafeTime));
  return Array.from(new Set([...fixedCandidates, ...ratioCandidates].map((time) => Number(time.toFixed(3)))));
}

function isSidebarVideoFrameMostlyDark(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  let luminanceTotal = 0;
  let brightPixels = 0;
  const pixelCount = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
    luminanceTotal += luminance;
    if (luminance > 32) brightPixels += 1;
  }
  return luminanceTotal / pixelCount < 14 && brightPixels / pixelCount < 0.015;
}

function useSidebarAssetPreview(
  asset: SidebarAssetItem,
  projectId?: string,
  enabled = true,
): string | null {
  const assetUrl = asset.kind === "image" || asset.kind === "video" ? asset.url : "";
  const assetPreviewVersion = asset.kind === "image" ? String(asset.previewVersion || "").trim() : "";
  const cacheKey =
    asset.kind === "image" && assetUrl
      ? getSidebarPreviewCacheKey(
          assetPreviewVersion ? `${assetUrl}::${assetPreviewVersion}` : assetUrl,
          projectId,
        )
      : "";
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => {
    if (asset.kind !== "image" || !assetUrl) return null;
    if (!isLocalSidebarAssetUrl(assetUrl)) return assetUrl;
    return sidebarImagePreviewCache.get(cacheKey) ?? null;
  });

  useEffect(() => {
    if (asset.kind !== "image" || !assetUrl) {
      setPreviewUrl(null);
      return;
    }

    if (!isLocalSidebarAssetUrl(assetUrl)) {
      rememberSidebarPreview(sidebarImagePreviewCache, cacheKey, assetUrl);
      setPreviewUrl(assetUrl);
      return;
    }

    const cachedUrl = sidebarImagePreviewCache.get(cacheKey);
    if (cachedUrl) {
      setPreviewUrl(cachedUrl);
      return;
    }

    if (!enabled) {
      setPreviewUrl(null);
      return;
    }

    setPreviewUrl(null);
    let cancelled = false;

    void resolveSidebarAssetPreviewUrl(
      {
        kind: "image",
        url: assetUrl,
        previewVersion: assetPreviewVersion || undefined,
      },
      projectId,
    ).then((resolvedUrl) => {
      if (!cancelled && resolvedUrl) {
        rememberSidebarPreview(sidebarImagePreviewCache, cacheKey, resolvedUrl);
        setPreviewUrl(resolvedUrl);
      }
    });

    return () => {
      cancelled = true;
    };
  // 只依赖实际影响结果的字段，避免 asset 对象引用变化导致不必要的重新执行
  }, [asset.kind, assetPreviewVersion, assetUrl, cacheKey, enabled, projectId]);

  return previewUrl;
}

async function openSidebarAsset(asset: SidebarAssetItem): Promise<void> {
  if (asset.kind === "bundle") {
    await window.electronAPI?.storage?.openFolder?.(asset.path);
    return;
  }

  const assetUrl = asset.kind === "image" || asset.kind === "video" ? asset.url : "";
  if (isLocalSidebarAssetUrl(assetUrl)) {
    const rawPath = normalizeSidebarAssetPath(assetUrl);
    const localPath = await remapToCurrentFilesRoot(rawPath);
    if (window.electronAPI?.storage?.openPath) {
      await window.electronAPI.storage.openPath(localPath);
      return;
    }
    if (window.electronAPI?.storage?.openFolder) {
      await window.electronAPI.storage.openFolder(localPath);
    }
    return;
  }

  if (asset.kind !== "image") {
    window.open(asset.url, "_blank", "noopener,noreferrer");
  }
}

/** 在文件管理器中定位素材文件（高亮显示） */
async function openAssetInFolder(asset: SidebarAssetItem): Promise<void> {
  if (asset.kind === "bundle") {
    await window.electronAPI?.storage?.openFolder?.(asset.path);
    return;
  }
  if (isLocalSidebarAssetUrl(asset.url)) {
    const rawPath = normalizeSidebarAssetPath(asset.url);
    const localPath = await remapToCurrentFilesRoot(rawPath);
    if (window.electronAPI?.storage?.openPath) {
      await window.electronAPI.storage.openPath(localPath);
      return;
    }
    // fallback：打开所在文件夹
    const folderPath = localPath.replace(/[\\/][^\\/]+$/, "");
    await window.electronAPI?.storage?.openFolder?.(folderPath || localPath);
  }
}

type SidebarMediaAsset = SidebarAssetItem & { kind: "image" | "video" };

/** 视频首帧缩略图：用隐藏 video 元素 seek 到 0 后 canvas 截帧 */
const SidebarVideoThumbnail = memo(function SidebarVideoThumbnail({
  url,
  label,
}: {
  url: string;
  label: string;
}) {
  const cacheKey = getSidebarVideoThumbnailCacheKey(url);
  const [thumb, setThumb] = useState<string | null>(() => sidebarVideoThumbnailCache.get(cacheKey) ?? null);
  const seekAttemptRef = useRef({ key: "", index: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState(url);
  const isLocal = isLocalSidebarAssetUrl(url);
  const [containerRef, nearViewport] = useNearViewport<HTMLSpanElement>(!thumb);

  useEffect(() => {
    seekAttemptRef.current = { key: "", index: 0 };
    setThumb(sidebarVideoThumbnailCache.get(cacheKey) ?? null);
  }, [cacheKey]);

  useEffect(() => {
    if (!isLocal) { setResolvedUrl(url); return; }
    void remapToCurrentFilesRoot(url.startsWith("file://") ? normalizeSidebarAssetPath(url) : url)
      .then((remapped) => {
        const mapped = getSidebarVideoSrc(remapped);
        // 本地文件不存在时不设置 src，避免浏览器报 ERR_FILE_NOT_FOUND
        const rawPath = mapped.startsWith("file://") ? normalizeSidebarAssetPath(mapped) : remapped;
        const exists = window.electronAPI?.storage?.exists;
        if (typeof exists === "function" && !exists(rawPath)) return;
        setResolvedUrl(mapped);
      });
  }, [url, isLocal]);

  const captureThumbnail = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || sidebarVideoThumbnailCache.has(cacheKey)) return false;
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;
    const scale = Math.min(1, 200 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      if (isSidebarVideoFrameMostlyDark(ctx, canvas.width, canvas.height)) return false;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
      rememberSidebarPreview(sidebarVideoThumbnailCache, cacheKey, dataUrl);
      setThumb(dataUrl);
      return true;
    } catch { return false; }
  }, [cacheKey]);

  const handleSeeked = useCallback(() => {
    if (captureThumbnail()) return;
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    // 复用 canvas，避免每次 seeked 都分配新对象
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;
    const scale = Math.min(1, 200 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      if (isSidebarVideoFrameMostlyDark(ctx, canvas.width, canvas.height)) {
        const times = getSidebarVideoThumbnailTimes(video);
        const attempt = seekAttemptRef.current.key === cacheKey
          ? seekAttemptRef.current
          : { key: cacheKey, index: 0 };
        const nextIndex = attempt.index + 1;
        if (nextIndex < times.length) {
          seekAttemptRef.current = { key: cacheKey, index: nextIndex };
          video.currentTime = times[nextIndex];
        }
        return;
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
      rememberSidebarPreview(sidebarVideoThumbnailCache, cacheKey, dataUrl);
      setThumb(dataUrl);
    } catch { /* ignore */ }
  }, [cacheKey, captureThumbnail]);

  // 卸载时释放 canvas 引用，防止内存泄漏
  useEffect(() => {
    return () => { canvasRef.current = null; };
  }, []);

  return (
    <span ref={containerRef} className="flex h-full w-full items-center justify-center">
      {!thumb && nearViewport ? (
        <video
          ref={videoRef}
          src={resolvedUrl}
          preload="metadata"
          muted
          playsInline
          className="hidden"
          crossOrigin={isLocal ? undefined : "anonymous"}
          onLoadedMetadata={() => {
            const video = videoRef.current;
            if (!video || sidebarVideoThumbnailCache.has(cacheKey)) return;
            const targetTime = getSidebarVideoThumbnailTimes(video)[0] ?? 0;
            seekAttemptRef.current = { key: cacheKey, index: 0 };
            if (Math.abs(video.currentTime - targetTime) <= 0.05) {
              handleSeeked();
              return;
            }
            try {
              video.currentTime = targetTime;
            } catch { /* ignore */ }
          }}
          onLoadedData={handleSeeked}
          onSeeked={handleSeeked}
        />
      ) : null}
      {thumb ? (
        <img src={thumb} alt={label} className="h-full w-full object-cover" />
      ) : (
        <Clapperboard className="h-5 w-5 text-foreground/70" />
      )}
    </span>
  );
});

/** 灯箱内容体，单独组件以便安全调用 hook */
const SidebarLightboxBody = memo(function SidebarLightboxBody({
  assets,
  currentIndex,
  onPrev,
  onNext,
  onJump,
  currentProjectId,
}: {
  assets: SidebarMediaAsset[];
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (idx: number) => void;
  currentProjectId?: string;
}) {
  const asset = assets[currentIndex];
  const total = assets.length;
  const previewUrl = useSidebarAssetPreview(asset, currentProjectId);
  const continuityRecapTitle =
    asset.subKind === "continuity-grid"
      ? asset.segmentLabel?.trim()
        ? `片段 ${asset.segmentLabel.trim()} 前情六宫格`
        : asset.label
      : null;
  const continuityRecapText =
    asset.subKind === "continuity-grid" && asset.recapText?.trim()
      ? formatSegmentContinuityRecapDisplayText(asset.recapText)
      : null;
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheelCbRef = useRef({ total, onNext, onPrev });
  wheelCbRef.current = { total, onNext, onPrev };
  useEffect(() => {
    if (asset.kind !== "video") { setVideoSrc(null); return; }
    const raw = asset.url;
    if (!isLocalSidebarAssetUrl(raw)) { setVideoSrc(raw); return; }
    void remapToCurrentFilesRoot(raw.startsWith("file://") ? normalizeSidebarAssetPath(raw) : raw)
      .then((remapped) => {
        const mapped = getSidebarVideoSrc(remapped);
        const rawPath = mapped.startsWith("file://") ? normalizeSidebarAssetPath(mapped) : remapped;
        const exists = window.electronAPI?.storage?.exists;
        if (typeof exists === "function" && !exists(rawPath)) return;
        setVideoSrc(mapped);
      });
  }, [asset]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const { total: t, onNext: next, onPrev: prev } = wheelCbRef.current;
      if (t <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY > 0) next(); else prev();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);
  return (
    <>
      <div className="flex items-center border-b border-border px-5 py-3 pr-12">
        <DialogPrimitive.Title className="flex-1 truncate text-left text-[13px] font-medium leading-snug text-foreground">
          {asset.label}
        </DialogPrimitive.Title>
        {total > 1 && (
          <span className="ml-3 shrink-0 text-[11px] text-muted-foreground">{currentIndex + 1} / {total}</span>
        )}
        <DialogPrimitive.Description className="sr-only">媒体素材预览</DialogPrimitive.Description>
      </div>
      <div
        ref={scrollRef}
        className="relative scrollbar-none flex max-h-[min(84vh,860px)] items-center justify-center overflow-auto bg-muted/30 p-4"
      >
        {asset.kind === "video" && videoSrc ? (
          <video
            key={asset.id}
            src={videoSrc}
            controls
            className="max-h-[min(78vh,800px)] max-w-full rounded-xl shadow-lg"
          />
        ) : previewUrl ? (
          <img
            key={asset.id}
            src={previewUrl}
            alt={asset.label}
            className="max-h-[min(78vh,800px)] max-w-full rounded-xl object-contain shadow-lg"
          />
        ) : (
          <p className="text-sm text-muted-foreground">正在加载预览…</p>
        )}
        {total > 1 && (
          <>
            <button
              type="button"
              onClick={onPrev}
              className="absolute left-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus:outline-none"
              aria-label="上一个"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={onNext}
              className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60 focus:outline-none"
              aria-label="下一个"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
      {/* 多图缩略图条 */}
      {total > 1 && (
        <SidebarThumbnailStrip
          assets={assets}
          currentIndex={currentIndex}
          onJump={onJump}
          currentProjectId={currentProjectId}
        />
      )}
      {continuityRecapText ? (
        <div className="border-t border-border bg-[#090b10] px-6 py-5">
          <div className="mx-auto w-full max-w-[min(92vw,1080px)]">
            <h3 className="text-[15px] font-semibold text-foreground">
              {continuityRecapTitle}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-foreground/88">
              {continuityRecapText}
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
});

/** 缩略图条子项，单独组件以便安全调用 hook */
const SidebarThumbnailItem = memo(function SidebarThumbnailItem({
  asset,
  active,
  onClick,
  currentProjectId,
}: {
  asset: SidebarMediaAsset;
  active: boolean;
  onClick: () => void;
  currentProjectId?: string;
}) {
  const previewUrl = useSidebarAssetPreview(asset, currentProjectId);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition",
        active ? "border-primary" : "border-transparent opacity-60 hover:opacity-90",
      )}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={asset.label}
          className={cn(
            "h-full w-full",
            asset.subKind === "continuity-grid" ? "object-contain bg-[#05070b]" : "object-cover",
          )}
        />
      ) : asset.kind === "video" ? (
        <SidebarVideoThumbnail url={asset.url} label={asset.label} />
      ) : (
        <div className="h-full w-full bg-muted/50" />
      )}
      {asset.kind === "video" && (
        <span className="pointer-events-none absolute bottom-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/50">
          <Play className="h-2.5 w-2.5 fill-white text-white" />
        </span>
      )}
    </button>
  );
});

const SidebarThumbnailStrip = memo(function SidebarThumbnailStrip({
  assets,
  currentIndex,
  onJump,
  currentProjectId,
}: {
  assets: SidebarMediaAsset[];
  currentIndex: number;
  onJump: (idx: number) => void;
  currentProjectId?: string;
}) {
  return (
    <div
      className="flex items-center gap-2 overflow-x-auto border-t border-border px-4 py-2.5 scrollbar-none"
      onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
    >
      {assets.map((item, idx) => (
        <SidebarThumbnailItem
          key={item.id}
          asset={item}
          active={idx === currentIndex}
          onClick={() => onJump(idx)}
          currentProjectId={currentProjectId}
        />
      ))}
    </div>
  );
});

const SidebarAssetImageLightbox = memo(function SidebarAssetImageLightbox({
  assets,
  initialIndex,
  onOpenChange,
  currentProjectId,
}: {
  assets: SidebarMediaAsset[];
  initialIndex: number | null;
  onOpenChange: (open: boolean) => void;
  currentProjectId?: string;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex ?? 0);
  const total = assets.length;

  useEffect(() => {
    if (initialIndex !== null) setCurrentIndex(initialIndex);
  }, [initialIndex]);

  const prev = useCallback(() => setCurrentIndex((i) => (i - 1 + total) % total), [total]);
  const next = useCallback(() => setCurrentIndex((i) => (i + 1) % total), [total]);

  useEffect(() => {
    if (initialIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [initialIndex, prev, next]);

  const asset = assets[currentIndex] ?? null;

  return (
    <DialogPrimitive.Root open={initialIndex !== null} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[60] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-0 z-[60] flex items-center justify-center duration-200",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
          onClick={() => onOpenChange(false)}
        >
          <div
            className="relative flex w-[min(96vw,1200px)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {asset ? (
              <SidebarLightboxBody
                assets={assets}
                currentIndex={currentIndex}
                onPrev={prev}
                onNext={next}
                onJump={setCurrentIndex}
                currentProjectId={currentProjectId}
              />
            ) : null}
            <DialogPrimitive.Close
              type="button"
              aria-label="关闭"
              className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});

const SidebarFooter = memo(function SidebarFooter({
  onOpenSettings,
  collapsed = false,
}: {
  onOpenSettings: () => void;
  collapsed?: boolean;
}) {
  return (
    <div className={cn("border-t border-border pb-3 pt-2", collapsed ? "px-2" : "px-2.5")}>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="打开或关闭设置"
        title="打开或关闭设置"
        className={cn(
          "flex w-full items-center rounded-[12px] px-2.5 py-1 text-left text-[13px] text-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground",
          collapsed ? "justify-center" : "gap-2",
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[9px] bg-muted/40 text-foreground/70">
          <Settings2 className="h-3.25 w-3.25" />
        </span>
        {!collapsed ? (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">设置</span>
        ) : null}
      </button>
    </div>
  );
});

const SidebarAssetRow = memo(function SidebarAssetRow({
  asset,
  onOpen,
  onDelete,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
  currentProjectId,
  collapsed = false,
  highlighted = false,
  highlightMessage,
  extractionState,
  extraAction,
}: {
  asset: SidebarAssetItem;
  onOpen: (asset: SidebarAssetItem) => void;
  onDelete?: (asset: SidebarAssetItem) => void;
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  currentProjectId?: string;
  collapsed?: boolean;
  highlighted?: boolean;
  highlightMessage?: string | null;
  extractionState?: SidebarSegmentExtractionVisualState | null;
  extraAction?: SidebarAssetRowAction;
}) {
  const isMobile = useIsMobile();
  const kindLabel = ASSET_KIND_LABEL[asset.kind];
  const isImage = asset.kind === "image";
  const isVideo = asset.kind === "video";
  const extractionProgress = clampSidebarProgress(extractionState?.progress ?? 0);
  const isSegmentRefreshAction = extraAction?.dataAttribute === "data-sidebar-segment-refresh";
  const isSegmentRefreshActive = isSegmentRefreshAction && extractionState?.status === "extracting";
  const showsContinuityReadyBadge =
    asset.subKind === "segment" && asset.continuityGridReady === true && !extractionState;
  const showsContinuityMissingBadge =
    asset.subKind === "segment" && asset.continuityGridReady !== true && !extractionState;
  const extractionToneClass =
    extractionState?.status === "failed"
      ? "bg-[rgba(239,68,68,0.18)]"
      : extractionState?.status === "completed"
        ? "bg-[rgba(34,197,94,0.18)]"
        : "bg-[rgba(108,126,210,0.18)]";
  const extractionTextClass =
    extractionState?.status === "failed"
      ? "text-red-400"
      : extractionState?.status === "completed"
        ? "text-emerald-300"
        : SIDEBAR_BLUE_VIOLET_TEXT;
  const showsFailedBadge = asset.status === "failed";
  const [previewViewportRef, nearPreviewViewport] = useNearViewport<HTMLButtonElement>(isImage);
  const previewUrl = useSidebarAssetPreview(asset, currentProjectId, !isImage || nearPreviewViewport);
  const [sharedCharacterAudioSnapshot, setSharedCharacterAudioSnapshot] =
    useState<SidebarCharacterAudioPlaybackSnapshot>(
      getSidebarCharacterAudioPlaybackSnapshot(),
    );
  const [confirmingDeleteTarget, setConfirmingDeleteTarget] = useState<
    "asset" | "audio" | null
  >(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirmRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmingDeleteTarget) return;
    const handler = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmingDeleteTarget(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmingDeleteTarget]);
  const isDraggable = isImage || isVideo;
  // 是否为本地路径（可定位）
  const isLocatable =
    (asset.kind === "image" || asset.kind === "video") && isLocalSidebarAssetUrl(asset.url);
  // 图片加载失败时回退到图标占位
  const showsCharacterAudioUploadAction = Boolean(
    asset.kind === "image" &&
      asset.characterAudioTargetId &&
      onUploadCharacterAudioReference,
  );
  const playableCharacterAudioUrl = asset.characterAudioUrl?.trim()
    ? getSidebarAudioSrc(asset.characterAudioUrl.trim())
    : null;
  const showsCharacterAudioPlayAction = Boolean(playableCharacterAudioUrl);
  const isCharacterAudioPlaying = Boolean(
    playableCharacterAudioUrl &&
      asset.characterAudioTargetId &&
      sharedCharacterAudioSnapshot.isPlaying &&
      sharedCharacterAudioSnapshot.targetId === asset.characterAudioTargetId &&
      sharedCharacterAudioSnapshot.url === playableCharacterAudioUrl,
  );
  const characterAudioActionLabel = asset.characterAudioReferenceReady
    ? "更新音频参考"
    : "上传音频参考";
  const characterAudioActionTitle = asset.characterAudioTargetName?.trim()
    ? `${characterAudioActionLabel}《${asset.characterAudioTargetName.trim()}》`
    : characterAudioActionLabel;
  const characterAudioStatusTitle = asset.characterAudioTargetName?.trim()
    ? asset.characterAudioReferenceReady
      ? `已上传《${asset.characterAudioTargetName.trim()}》的音频参考`
      : `未上传《${asset.characterAudioTargetName.trim()}》的音频参考`
    : asset.characterAudioReferenceReady
      ? "已上传音频参考"
      : "未上传音频参考";
  const characterAudioPlayTitle = asset.characterAudioTargetName?.trim()
    ? `${isCharacterAudioPlaying ? "暂停" : "播放"}《${asset.characterAudioTargetName.trim()}》的音频参考${asset.characterAudioFileName?.trim() ? `（${asset.characterAudioFileName.trim()}）` : ""}`
    : `${isCharacterAudioPlaying ? "暂停" : "播放"}音频参考${asset.characterAudioFileName?.trim() ? `（${asset.characterAudioFileName.trim()}）` : ""}`;
  const assetMenuTriggerLabel = asset.label?.trim()
    ? `素材菜单：${asset.label.trim()}`
    : "素材菜单";
  useEffect(
    () =>
      subscribeSidebarCharacterAudioPlayback(() => {
        setSharedCharacterAudioSnapshot(getSidebarCharacterAudioPlaybackSnapshot());
      }),
    [],
  );

  useEffect(() => {
    if (!asset.characterAudioTargetId || playableCharacterAudioUrl) return;
    stopSidebarCharacterAudioPlayback(asset.characterAudioTargetId);
  }, [asset.characterAudioTargetId, playableCharacterAudioUrl]);

  const toggleCharacterAudioPlayback = React.useCallback(async () => {
    if (!playableCharacterAudioUrl) return;
    await toggleSidebarCharacterAudioPlayback(
      playableCharacterAudioUrl,
      asset.characterAudioTargetId,
    );
  }, [asset.characterAudioTargetId, playableCharacterAudioUrl]);
  const handleToggleCharacterAudioPlayback = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void toggleCharacterAudioPlayback();
    },
    [toggleCharacterAudioPlayback],
  );
  const assetMenuActions = useMemo<SidebarAssetMenuAction[]>(() => {
    const actions: SidebarAssetMenuAction[] = [
      {
        key: "open",
        icon: asset.kind === "bundle" ? FolderOpen : ArrowUpRight,
        label: asset.kind === "bundle" ? "打开素材文件夹" : "打开素材",
        title: asset.label,
        section: "primary",
        onSelect: () => onOpen(asset),
      },
    ];

    if (showsCharacterAudioUploadAction && asset.characterAudioTargetId && onUploadCharacterAudioReference) {
      actions.push({
        key: "upload-character-audio",
        icon: asset.characterAudioReferenceReady ? AudioWaveform : Upload,
        label: characterAudioActionTitle,
        title: asset.characterAudioFileName?.trim()
          ? `${characterAudioStatusTitle}（当前：${asset.characterAudioFileName.trim()}，点击可重新上传）`
          : characterAudioActionTitle,
        section: "audio",
        dataAttribute: "data-sidebar-asset-upload-audio",
        onSelect: () => {
          onUploadCharacterAudioReference(
            asset.characterAudioTargetId!,
            asset.characterAudioTargetName,
          );
        },
      });
    }

    if (showsCharacterAudioPlayAction) {
      actions.push({
        key: "play-character-audio",
        icon: isCharacterAudioPlaying ? Pause : Play,
        label: characterAudioPlayTitle,
        title: characterAudioPlayTitle,
        section: "audio",
        dataAttribute: "data-sidebar-asset-play-audio",
        closeMenuOnSelect: false,
        onSelect: toggleCharacterAudioPlayback,
      });
    }

    if (
      asset.characterAudioReferenceReady &&
      asset.characterAudioTargetId &&
      onRemoveCharacterAudioReference
    ) {
      actions.push({
        key: "remove-character-audio",
        icon: Trash2,
        label: asset.characterAudioTargetName?.trim()
          ? `删除《${asset.characterAudioTargetName.trim()}》音频参考`
          : "删除音频参考",
        title: asset.characterAudioFileName?.trim()
          ? `移除当前音频参考：${asset.characterAudioFileName.trim()}`
          : "移除当前角色音频参考",
        section: "audio",
        tone: "danger",
        dataAttribute: "data-sidebar-asset-remove-audio",
        onSelect: () => setConfirmingDeleteTarget("audio"),
      });
    }

    if (extraAction) {
      actions.push({
        key: `extra-${extraAction.dataAttribute ?? extraAction.label}`,
        icon: extraAction.icon,
        label: extraAction.label,
        title: extraAction.title,
        section: "secondary",
        disabled: extraAction.disabled,
        dataAttribute: extraAction.dataAttribute,
        stateAttributes: isSegmentRefreshAction
          ? { "data-sidebar-segment-refresh-state": isSegmentRefreshActive ? "extracting" : "idle" }
          : undefined,
        iconClassName: isSegmentRefreshActive ? "animate-spin" : undefined,
        onSelect: () => extraAction.onClick(asset),
      });
    }

    if (isLocatable) {
      actions.push({
        key: "open-in-folder",
        icon: FolderOpen,
        label: `在文件夹中显示 ${asset.label}`,
        title: "在文件夹中显示",
        section: "file",
        onSelect: () => openAssetInFolder(asset),
      });
    }

    if (onDelete) {
      actions.push({
        key: "delete",
        icon: Trash2,
        label: `删除 ${asset.label}`,
        title: "从素材库移除",
        section: "danger",
        tone: "danger",
        onSelect: () => setConfirmingDeleteTarget("asset"),
      });
    }

    return actions;
  }, [
    asset,
    characterAudioActionTitle,
    characterAudioPlayTitle,
    characterAudioStatusTitle,
    extraAction,
    isCharacterAudioPlaying,
    isLocatable,
    isSegmentRefreshAction,
    isSegmentRefreshActive,
    onDelete,
    onOpen,
    onRemoveCharacterAudioReference,
    onUploadCharacterAudioReference,
    showsCharacterAudioPlayAction,
    showsCharacterAudioUploadAction,
    toggleCharacterAudioPlayback,
  ]);
  const handleMenuAction = React.useCallback(
    (
      action: () => void | Promise<void>,
      options?: { closeMenuOnSelect?: boolean },
    ) => (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (options?.closeMenuOnSelect !== false) {
        setMenuOpen(false);
      }
      window.setTimeout(() => {
        void action();
      }, 0);
    },
    [],
  );
  const [imgError, setImgError] = useState(false);
  useEffect(() => { setImgError(false); }, [previewUrl]);

  return (
    <div
      data-sidebar-asset-id={asset.id}
      data-sidebar-asset-segment-label={asset.segmentLabel}
      data-sidebar-asset-extraction-status={extractionState?.status || ""}
      className={cn(
        "group relative flex w-full items-center overflow-hidden rounded-[14px] transition-colors hover:bg-muted/40",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
        confirmingDeleteTarget && "bg-muted/40",
        highlighted && "bg-primary/8 ring-2 ring-primary/45",
      )}
    >
      {extractionState ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[14px]">
          <div
            data-sidebar-asset-extraction-progress="true"
            className={cn(
              "absolute inset-y-0 left-0 rounded-[14px] transition-[width] duration-300 ease-out",
              extractionToneClass,
              extractionState.status === "extracting" && "animate-pulse",
            )}
            style={{ width: `${extractionProgress}%` }}
          />
        </div>
      ) : null}
      {/* 删除确认覆盖层：与整行齐平 */}
      {confirmingDeleteTarget && (
        <div
          ref={confirmRef}
          className="absolute inset-0 z-50 flex items-center justify-between rounded-[12px] border border-border bg-popover px-2.5 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-[10.5px] text-foreground">
            {confirmingDeleteTarget === "audio"
              ? "确认移除当前音频参考？"
              : "确认移除此素材？"}
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (confirmingDeleteTarget === "audio") {
                  stopSidebarCharacterAudioPlayback(asset.characterAudioTargetId);
                  if (asset.characterAudioTargetId && onRemoveCharacterAudioReference) {
                    onRemoveCharacterAudioReference(
                      asset.characterAudioTargetId,
                      asset.characterAudioTargetName,
                    );
                  }
                  setConfirmingDeleteTarget(null);
                  return;
                }
                setConfirmingDeleteTarget(null);
                onDelete?.(asset);
              }}
              className="rounded-lg bg-destructive px-2.5 py-1 text-[10px] font-medium text-destructive-foreground transition-opacity hover:opacity-90"
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDeleteTarget(null)}
              className="rounded-lg bg-muted px-2.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/70"
            >
              取消
            </button>
          </div>
        </div>
      )}
      {/* 主体按钮（点击打开） */}
      <button
        ref={isImage ? previewViewportRef : undefined}
        type="button"
        onClick={() => onOpen(asset)}
        aria-label={asset.label}
        title={asset.label}
        draggable={isDraggable}
        onDragStart={
          isDraggable
            ? (e) => {
                const url = previewUrl ?? (asset as { url: string }).url;
                // 拖到输入框
                e.dataTransfer.setData(
                  "application/x-infinio-sidebar-image",
                  JSON.stringify({ url, label: asset.label, kind: asset.kind }),
                );
                // 拖到素材库（视频也支持）
                e.dataTransfer.setData(
                  "application/x-infinio-image",
                  JSON.stringify({ url, fileName: asset.label, kind: asset.kind }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }
            : undefined
        }
        className={cn(
          "flex min-w-0 flex-1 items-center text-left",
          collapsed ? "justify-center" : "gap-2",
          isDraggable && "cursor-grab active:cursor-grabbing",
        )}
      >
        {asset.kind === "image" && previewUrl && !imgError ? (
          <span className="relative size-16 shrink-0 overflow-hidden rounded-[12px] bg-muted/40">
            <img
              src={previewUrl}
              alt={asset.label}
              className={cn(
                "h-full w-full max-h-full max-w-full",
                asset.subKind === "continuity-grid" ? "object-contain bg-[#05070b]" : "object-cover",
              )}
              loading="lazy"
              onError={() => setImgError(true)}
            />
            <span className="pointer-events-none absolute inset-0 rounded-[12px] ring-1 ring-inset ring-border/50" />
          </span>
        ) : asset.kind === "image" ? (
          <span className="flex size-16 shrink-0 items-center justify-center rounded-[12px] bg-muted/40 text-foreground/70">
            <Image className="h-5.5 w-5.5" />
          </span>
        ) : asset.kind === "video" ? (
          <span className="relative size-16 shrink-0 overflow-hidden rounded-[12px] bg-muted/30">
            <span className={cn("block h-full w-full", showsFailedBadge && "grayscale brightness-75")}>
              <SidebarVideoThumbnail url={asset.url} label={asset.label} />
            </span>
            <span className="pointer-events-none absolute inset-0 rounded-[12px] ring-1 ring-inset ring-border/50" />
            <span className="pointer-events-none absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded bg-black/50">
              <Play className="h-3 w-3 fill-white text-white" />
            </span>
          </span>
        ) : (
          <span className="flex size-16 shrink-0 items-center justify-center rounded-[12px] bg-muted/40 text-foreground ring-1 ring-inset ring-border/40">
            <FolderOpen className="h-5.5 w-5.5" />
          </span>
        )}
        {!collapsed ? (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="block min-w-0 flex-1 truncate text-[12px] font-medium leading-5 text-foreground">
                {asset.label}
              </span>
              {showsContinuityReadyBadge ? (
                <span
                  data-sidebar-asset-continuity-badge="true"
                  className="shrink-0 rounded-[6px] border border-emerald-400/30 bg-emerald-500/12 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-emerald-300"
                >
                  已组六格
                </span>
                ) : showsContinuityMissingBadge ? (
                  <span
                    data-sidebar-asset-continuity-missing="true"
                    className="shrink-0 rounded-[6px] border border-amber-400/30 bg-amber-500/12 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-amber-200"
                  >
                    待组六格
                  </span>
                ) : showsFailedBadge ? (
                <span
                  data-sidebar-asset-failed-badge="true"
                  className="shrink-0 rounded-[6px] border border-rose-400/30 bg-rose-500/12 px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-rose-300"
                >
                  QA FAIL
                </span>
              ) : null}
            </span>
            {extractionState?.message ? (
              <span
                data-sidebar-asset-extraction-message="true"
                className={cn("block truncate text-[10px] leading-4.5", extractionTextClass)}
              >
                {extractionState.message}
              </span>
            ) : highlighted && highlightMessage ? (
              <span className="block truncate text-[10px] leading-4.5 text-primary">{highlightMessage}</span>
            ) : null}
            {asset.kind !== "image" ? (
              <span className="mt-0.5 flex items-center gap-1 text-[10px] leading-4.5 text-muted-foreground">
                <span className="uppercase tracking-[0.16em] text-foreground/50">{kindLabel}</span>
                <span className="h-1 w-1 rounded-full bg-border" />
                {extractionState ? (
                  <>
                    <span>{extractionProgress}%</span>
                    <span className="h-1 w-1 rounded-full bg-border" />
                  </>
                ) : null}
                <span className="truncate">{asset.meta}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {/* 操作按钮组（悬停显示） */}
      {!collapsed ? (
        <>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-sidebar-asset-menu-trigger="true"
                aria-label={assetMenuTriggerLabel}
                title={assetMenuTriggerLabel}
                onClick={(event) => event.stopPropagation()}
                className="flex h-8 w-8 shrink-0 self-center items-center justify-center rounded-full border border-transparent bg-primary/20 text-foreground/75 opacity-90 transition hover:bg-primary/30 hover:text-foreground data-[state=open]:bg-primary/30 data-[state=open]:text-foreground"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isMobile ? "bottom" : "left"}
              align={isMobile ? "end" : "center"}
              sideOffset={10}
              collisionPadding={16}
              className="w-52 rounded-xl border-border bg-card/96 p-1.5 text-foreground shadow-[0_20px_48px_rgba(0,0,0,0.25)] backdrop-blur-xl"
            >
              {assetMenuActions.map((action, index) => {
                const previousAction = index > 0 ? assetMenuActions[index - 1] : null;
                return (
                  <React.Fragment key={action.key}>
                    {previousAction && previousAction.section !== action.section ? (
                      <DropdownMenuSeparator className="my-1 bg-border/60" />
                    ) : null}
                    <DropdownMenuItem
                      disabled={action.disabled}
                      title={action.title}
                      onSelect={handleMenuAction(action.onSelect, {
                        closeMenuOnSelect: action.closeMenuOnSelect,
                      })}
                      {...(action.dataAttribute ? { [action.dataAttribute]: "true" } : {})}
                      {...(action.stateAttributes ?? {})}
                      className={cn(
                        "min-h-9 rounded-lg px-2.5 py-2 text-[13px] focus:bg-muted",
                        action.tone === "danger"
                          ? "text-rose-600 dark:text-rose-300 focus:bg-rose-500/15 focus:text-rose-600 dark:focus:text-rose-200"
                          : "text-foreground focus:text-foreground",
                      )}
                    >
                      <action.icon className={cn("mr-2 h-4 w-4 shrink-0", action.iconClassName)} />
                      <span className="min-w-0 flex-1 whitespace-normal break-words leading-5">{action.label}</span>
                    </DropdownMenuItem>
                  </React.Fragment>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="hidden">
          {showsCharacterAudioUploadAction ? (
            <button
              type="button"
              data-sidebar-asset-upload-audio="true"
              onClick={(e) => {
                e.stopPropagation();
                if (!asset.characterAudioTargetId || !onUploadCharacterAudioReference) return;
                onUploadCharacterAudioReference(
                  asset.characterAudioTargetId,
                  asset.characterAudioTargetName,
                );
              }}
              aria-label={characterAudioActionTitle}
              title={
                asset.characterAudioFileName?.trim()
                  ? `${characterAudioStatusTitle}（当前：${asset.characterAudioFileName.trim()}，点击可重新上传）`
                  : characterAudioActionTitle
              }
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
                asset.characterAudioReferenceReady
                  ? "border-[rgba(132,150,236,0.28)] bg-[rgba(108,126,210,0.16)] text-[rgb(156,174,255)] hover:bg-[rgba(108,126,210,0.24)] hover:text-[rgb(182,195,255)]"
                  : "border-white/[0.08] bg-white/[0.05] text-slate-300 hover:bg-white/[0.1] hover:text-slate-100",
              )}
            >
              {asset.characterAudioReferenceReady ? (
                <AudioWaveform className="h-3.5 w-3.5" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {showsCharacterAudioPlayAction ? (
            <button
              type="button"
              data-sidebar-asset-play-audio="true"
              onClick={handleToggleCharacterAudioPlayback}
              aria-label={characterAudioPlayTitle}
              title={characterAudioPlayTitle}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[rgba(132,150,236,0.24)] bg-[rgba(108,126,210,0.1)] text-[rgb(156,174,255)] transition-colors hover:bg-[rgba(108,126,210,0.2)] hover:text-[rgb(182,195,255)]"
            >
              {isCharacterAudioPlaying ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          {asset.characterAudioReferenceReady &&
          asset.characterAudioTargetId &&
          onRemoveCharacterAudioReference ? (
            <button
              type="button"
              data-sidebar-asset-remove-audio="true"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingDeleteTarget("audio");
              }}
              aria-label={
                asset.characterAudioTargetName?.trim()
                  ? `删除《${asset.characterAudioTargetName.trim()}》音频参考`
                  : "删除音频参考"
              }
              title={
                asset.characterAudioFileName?.trim()
                  ? `移除当前音频参考：${asset.characterAudioFileName.trim()}`
                  : "移除当前角色音频参考"
              }
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/10 text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {extraAction ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (extraAction.disabled) return;
                extraAction.onClick(asset);
              }}
              disabled={extraAction.disabled}
              {...(extraAction.dataAttribute
                ? { [extraAction.dataAttribute]: "true" }
                : {})}
              {...(isSegmentRefreshAction
                ? { "data-sidebar-segment-refresh-state": isSegmentRefreshActive ? "extracting" : "idle" }
                : {})}
              aria-label={extraAction.label}
              title={extraAction.title}
              className={cn(
                "rounded-full p-1.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-primary disabled:cursor-not-allowed disabled:opacity-40",
                isSegmentRefreshActive && "text-primary",
              )}
            >
              <extraAction.icon className={cn("h-3.5 w-3.5", isSegmentRefreshActive && "animate-spin")} />
            </button>
          ) : null}
          {/* 定位文件夹按钮 */}
          {isLocatable ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void openAssetInFolder(asset); }}
              aria-label={`在文件夹中显示 ${asset.label}`}
              title="在文件夹中显示"
              className="rounded-full p-1.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-primary"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {/* 删除按钮 */}
          {onDelete ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setConfirmingDeleteTarget("asset"); }}
              aria-label={`删除 ${asset.label}`}
              title="从素材库移除"
              className="rounded-full p-1.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
});

const SidebarBrandHeader = memo(function SidebarBrandHeader({
  idle,
  brandLabel,
  collapsed = false,
  onToggleCollapse,
}: {
  idle: boolean;
  brandLabel: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  return (
    <div
      className={cn(
        "relative flex h-[72px] items-center border-b border-border",
        collapsed ? "justify-center px-2" : "px-5",
      )}
    >
      {!collapsed ? (
        <>
          <div className="flex min-w-0 flex-1 items-center">
            <BrandMark className="h-8" />
            <div className="ml-3 min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-[0.02em] text-foreground">{brandLabel}</div>
              <div className="truncate text-[11px] text-muted-foreground">{idle ? "开始一段新会话" : "当前首页会话"}</div>
            </div>
          </div>
          {onToggleCollapse ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="收起侧栏"
              title="收起侧栏"
              className="ml-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
        </>
      ) : onToggleCollapse ? (
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label="展开侧栏"
          title="展开侧栏"
          className="flex h-12 w-12 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
});

const SidebarPrimaryAction = memo(function SidebarPrimaryAction({
  idle,
  onClick,
  collapsed = false,
}: {
  idle: boolean;
  onClick: () => void;
  collapsed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={idle ? "开始新项目" : "新建项目"}
      title={idle ? "开始新项目" : "新建项目"}
      className={cn(
        "mb-3 flex w-full items-center rounded-[16px] py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted/40",
        collapsed ? "justify-center px-0" : "gap-3.5 px-3.5",
      )}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background">
        <Plus className="h-4.5 w-4.5 shrink-0" />
      </span>
      {!collapsed ? <span>{idle ? "开始新项目" : "新建项目"}</span> : null}
    </button>
  );
});

const SidebarQuickTasks = memo(function SidebarQuickTasks({
  templates,
  onLaunch,
  bordered = false,
  collapsed = false,
}: {
  templates: HomeAgentTemplate[];
  onLaunch: (template: HomeAgentTemplate) => void;
  bordered?: boolean;
  collapsed?: boolean;
}) {
  return (
    <section className={cn("px-2 pb-2", bordered && "border-b border-border")}>
      <div
        className={cn(
          "mb-2 px-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground",
          collapsed && "flex items-center justify-center px-0",
        )}
      >
        {collapsed ? <Sparkles className="h-5.5 w-5.5 text-foreground/50" aria-hidden="true" /> : "快捷任务"}
      </div>
      <div className="space-y-px">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => {
              if (!template.disabled) onLaunch(template);
            }}
            disabled={template.disabled}
            aria-label={template.title}
            title={template.disabled ? `${template.title} · 待定` : template.title}
            className={cn(
              "flex w-full items-center rounded-[14px] py-2 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
              collapsed ? "justify-center px-0" : "justify-between gap-3.5 px-3.5",
            )}
          >
            {collapsed ? (
              <template.icon className="h-6.5 w-6.5 shrink-0 text-foreground/60" />
            ) : (
              <>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium leading-5 text-foreground">{template.title}</span>
                  <span className="block truncate text-[12px] leading-5 text-muted-foreground">
                    {template.badge ? `${template.badge} · ` : ""}
                    {truncateCopy(template.description, 28)}
                  </span>
                </span>
                <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
              </>
            )}
          </button>
        ))}
      </div>
    </section>
  );
});

const SidebarProjectHistory = memo(function SidebarProjectHistory({
  recentProjects,
  recentProjectSessions = [],
  recentProjectsReady,
  currentProjectId,
  currentProjectSnapshot,
  onOpenProject,
  onTogglePinProject,
  onRenameProject,
  onDuplicateProject,
  onCleanExpiredVideos,
  onDeleteProject,
  onBulkDeleteProjects,
  onExportChatHistory,
  onImportChatHistory,
  onOpenProjectFolder,
  onRefresh,
  isRefreshing = false,
  onGlobalImportChatHistory,
  emptyClassName,
  bordered = false,
  collapsed = false,
  fillHeight = false,
  automationMode = "manual",
  fullAutoRunStatus,
}: {
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  recentProjectsReady: boolean;
  currentProjectId?: string;
  currentProjectSnapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null;
  onOpenProject: (projectId: string) => void;
  onTogglePinProject?: (project: ConversationProjectSnapshot) => void;
  onRenameProject?: (project: ConversationProjectSnapshot) => void;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onCleanExpiredVideos?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  onBulkDeleteProjects?: (snapshots: ConversationProjectSnapshot[]) => Promise<void>;
  onExportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onImportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onOpenProjectFolder?: (project: ConversationProjectSnapshot) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  onGlobalImportChatHistory?: () => void;
  emptyClassName?: string;
  bordered?: boolean;
  collapsed?: boolean;
  fillHeight?: boolean;
  automationMode?: AutomationMode;
  fullAutoRunStatus?: FullAutoRunStatus | null;
}) {
  // 稳定列表顺序：只有项目集合（增删）变化时才重排，避免点击后因 updatedAt 变化导致条目跳位
  const displayProjects = useMemo(
    () =>
      mergeRecentProjectsWithSessionSnapshots({
        recentProjects,
        recentProjectSessions,
        currentProjectSnapshot,
        currentSessionProjectId: currentProjectId,
      }),
    [automationMode, currentProjectId, currentProjectSnapshot, recentProjectSessions, recentProjects],
  );
  const [stableProjects, setStableProjects] = useState<ConversationProjectSnapshot[]>(displayProjects);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const historySwitchSettleUntilRef = React.useRef(0);
  const previousCurrentProjectIdRef = React.useRef(
    typeof currentProjectId === "string" ? currentProjectId.trim() : "",
  );
  const normalizedCurrentProjectIdForRender =
    typeof currentProjectId === "string" ? currentProjectId.trim() : "";
  if (previousCurrentProjectIdRef.current !== normalizedCurrentProjectIdForRender) {
    const settleUntil = Date.now() + 1800;
    historySwitchSettleUntilRef.current = settleUntil;
    writeGlobalHistorySwitchSettleUntil(settleUntil);
    previousCurrentProjectIdRef.current = normalizedCurrentProjectIdForRender;
  }
  const historySwitchSettleUntil = Math.max(
    historySwitchSettleUntilRef.current,
    readGlobalHistorySwitchSettleUntil(),
  );
  const isHistorySwitchSettling = Date.now() < historySwitchSettleUntil;
  const stableHistoryContextSnapshot = isHistorySwitchSettling ? null : currentProjectSnapshot;

  useEffect(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  }, [automationMode]);

  useEffect(() => {
    const stableIds = stableProjects.map((p) => p.projectId);
    const newIds = displayProjects.map((p) => p.projectId);
    // 用 Set 做 O(1) 查找，避免 O(n²) 的 includes/find
    const stableIdSet = new Set(stableIds);
    const newIdSet = new Set(newIds);
    const normalizedCurrentProjectId =
      typeof currentProjectId === "string" ? currentProjectId.trim() : "";
    const sameSet =
      stableIds.length === newIds.length && stableIds.every((id) => newIdSet.has(id));

    if (Date.now() < Math.max(historySwitchSettleUntilRef.current, readGlobalHistorySwitchSettleUntil())) {
      return;
    }

    if (!sameSet) {
      // 项目集合有变化（新增/删除），保留现有卡片相对顺序，只把真正的新卡放到前面
      const addedProjects = displayProjects.filter((project) => !stableIdSet.has(project.projectId));
      const shouldDeferTransientAdditions =
        addedProjects.length > 0 &&
        Date.now() < Math.max(historySwitchSettleUntilRef.current, readGlobalHistorySwitchSettleUntil()) &&
        addedProjects.every((project) => project.projectId !== normalizedCurrentProjectId);
      if (shouldDeferTransientAdditions) {
        return;
      }
      setStableProjects((prev) => reconcileRecentProjectsWithStableOrder(prev, displayProjects));
    } else {
      // 集合不变，只更新各项数据（标题、阶段等），保持顺序
      if (Date.now() < Math.max(historySwitchSettleUntilRef.current, readGlobalHistorySwitchSettleUntil())) {
        return;
      }
      const newMap = new Map(displayProjects.map((r) => [r.projectId, r]));
      setStableProjects((prev) => {
        const next = prev.map((p) => newMap.get(p.projectId) ?? p);
        return next.every((project, index) => project === prev[index]) ? prev : next;
      });
    }
  }, [currentProjectId, displayProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  // 稳定 handlers 对象引用，避免每次父组件渲染都导致所有 item 重渲染
  const handlers = useMemo<HistoryItemMenuHandlers>(() => ({
    onTogglePinProject,
    onRenameProject,
    onDuplicateProject,
    onCleanExpiredVideos,
    onDeleteProject,
    onExportChatHistory,
    onImportChatHistory,
    onOpenProjectFolder,
  }), [onTogglePinProject, onRenameProject, onDuplicateProject, onCleanExpiredVideos, onDeleteProject, onExportChatHistory, onImportChatHistory, onOpenProjectFolder]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const handlePrepareOpenProject = useCallback(() => {
    const settleUntil = Date.now() + 1800;
    historySwitchSettleUntilRef.current = settleUntil;
    writeGlobalHistorySwitchSettleUntil(settleUntil);
  }, []);
  const effectiveModeProjects = useMemo(
    () =>
      stableProjects.map((project) => {
        const effectiveAutomationMode = resolveEffectiveProjectAutomationMode({
          snapshot: project,
          recentProjectSessions,
          currentProjectSnapshot: stableHistoryContextSnapshot,
        });
        return effectiveAutomationMode === project.automationMode
          ? project
          : { ...project, automationMode: effectiveAutomationMode };
      }),
    [recentProjectSessions, stableHistoryContextSnapshot, stableProjects],
  );
  const manualProjects = useMemo(
    () =>
      filterRecentProjectsForAutomationMode({
        recentProjects: effectiveModeProjects,
        recentProjectSessions,
        currentProjectSnapshot: stableHistoryContextSnapshot,
        currentSessionProjectId: currentProjectId,
        mode: "manual",
      }),
    [currentProjectId, effectiveModeProjects, recentProjectSessions, stableHistoryContextSnapshot],
  );
  const fullAutoProjects = useMemo(
    () =>
      filterRecentProjectsForAutomationMode({
        recentProjects: effectiveModeProjects,
        recentProjectSessions,
        currentProjectSnapshot: stableHistoryContextSnapshot,
        currentSessionProjectId: currentProjectId,
        mode: "full-auto",
      }),
    [currentProjectId, effectiveModeProjects, recentProjectSessions, stableHistoryContextSnapshot],
  );
  const computedVisibleProjects = automationMode === "full-auto" ? fullAutoProjects : manualProjects;
  const [stableVisibleProjects, setStableVisibleProjects] =
    useState<ConversationProjectSnapshot[]>(computedVisibleProjects);
  useEffect(() => {
    if (Date.now() < Math.max(historySwitchSettleUntilRef.current, readGlobalHistorySwitchSettleUntil())) {
      return;
    }
    setStableVisibleProjects((prev) => {
      const same =
        prev.length === computedVisibleProjects.length &&
        prev.every((project, index) => {
          const next = computedVisibleProjects[index];
          return (
            next &&
            project.projectId === next.projectId &&
            project.projectKind === next.projectKind &&
            project.title === next.title &&
            project.derivedStage === next.derivedStage &&
            project.updatedAt === next.updatedAt
          );
        });
      return same ? prev : computedVisibleProjects;
    });
  }, [computedVisibleProjects]);
  const visibleProjects = isHistorySwitchSettling ? stableVisibleProjects : computedVisibleProjects;
  const activeProjectIndex = useMemo(
    () => visibleProjects.findIndex((project) => project.projectId === currentProjectId),
    [currentProjectId, visibleProjects],
  );
  const historyRenderState = useIncrementalVisibleCount({
    totalCount: visibleProjects.length,
    chunkSize: HISTORY_RENDER_CHUNK,
    resetKey: `${automationMode}:${collapsed ? "collapsed" : "expanded"}:${fillHeight ? "fill" : "fixed"}`,
    priorityIndex: activeProjectIndex,
  });
  const renderedProjects = useMemo(
    () => visibleProjects.slice(0, historyRenderState.visibleCount),
    [historyRenderState.visibleCount, visibleProjects],
  );
  const historyModeFrameClass =
    automationMode === "full-auto"
      ? cn(
          "rounded-[18px]",
          fullAutoRunStatus === "stopped"
            ? "home-agent-full-auto-frame-stopped"
            : "home-agent-full-auto-frame-active",
        )
      : bordered
        ? "border-b border-border"
        : "";
  return (
    <section
      data-automation-mode={automationMode}
      className={cn(
        "px-2 py-2.5 transition-colors",
        fillHeight && "flex h-full flex-col",
        historyModeFrameClass,
      )}
    >
      <div
        className={cn(
          "mb-2 flex items-center gap-2 px-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground",
          collapsed && "justify-center px-0",
        )}
      >
        <History className="h-4 w-4" />
        {!collapsed ? "对话历史" : null}
        {!collapsed ? (
          <span
            data-sidebar-history-count="true"
            className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium tracking-normal text-foreground/80"
          >
            {recentProjectsReady ? visibleProjects.length : "…"}
          </span>
        ) : null}
        {!collapsed && onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-muted/60 hover:text-muted-foreground disabled:opacity-40"
            title="刷新对话历史"
            aria-label="刷新对话历史"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
          </button>
        ) : null}
        {!collapsed && onGlobalImportChatHistory ? (
          <button
            type="button"
            onClick={onGlobalImportChatHistory}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-muted/60 hover:text-muted-foreground",
              !onRefresh && "ml-auto",
            )}
            title="导入聊天记录"
            aria-label="导入聊天记录"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {!collapsed && onBulkDeleteProjects && visibleProjects.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setIsSelectMode((v) => !v);
              setSelectedIds(new Set());
            }}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition",
              onRefresh ? "" : "ml-auto",
              isSelectMode
                ? "text-primary hover:bg-primary/10"
                : "text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground",
            )}
            title={isSelectMode ? "退出多选" : "多选删除"}
            aria-label={isSelectMode ? "退出多选" : "多选删除"}
          >
            {isSelectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
      {/* History tabs removed: settings mode now fully determines the visible history stream.
        <div className="mb-1 flex gap-0.5 px-2">
          <button
            type="button"
            onClick={() => { setActiveHistoryTab("manual"); setSelectedIds(new Set()); }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded-[8px] py-1 text-[10px] font-medium transition-colors",
              activeHistoryTab === "manual" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            普通
            {manualProjects.length > 0 ? (
              <span className="rounded-full bg-primary/15 px-1 text-[9px] text-primary">{manualProjects.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => { setActiveHistoryTab("full-auto"); setSelectedIds(new Set()); }}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded-[8px] py-1 text-[10px] font-medium transition-colors",
              activeHistoryTab === "full-auto" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            全自动
            {fullAutoProjects.length > 0 ? (
              <span className="rounded-full bg-primary/15 px-1 text-[9px] text-primary">{fullAutoProjects.length}</span>
            ) : null}
          </button>
        </div>
      */}
      <div
        data-sidebar-history-list="true"
        data-sidebar-history-total-count={visibleProjects.length}
        data-sidebar-history-rendered-count={renderedProjects.length}
        className={cn("sidebar-scrollbar space-y-px", fillHeight ? "flex-1 overflow-y-auto" : "max-h-[400px] overflow-y-auto")}
        onScroll={historyRenderState.handleScroll}
      >
        {renderedProjects.map((project) => (
          <SidebarHistoryItem
            key={project.projectId}
            project={project}
            active={currentProjectId === project.projectId}
            selected={selectedIds.has(project.projectId)}
            collapsed={collapsed ?? false}
            isSelectMode={isSelectMode}
            visibleAutomationMode={automationMode}
            onPrepareOpenProject={handlePrepareOpenProject}
            onOpenProject={onOpenProject}
            onToggleSelect={handleToggleSelect}
            handlers={handlers}
          />
        ))}
        {historyRenderState.hasMore ? (
          <div className="px-2 py-2 text-center">
            <button
              type="button"
              data-sidebar-load-more="history"
              onClick={historyRenderState.loadMore}
              className="rounded-full border border-border/70 px-3.5 py-1.5 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
            >
              加载更多会话
            </button>
          </div>
        ) : null}
        {!visibleProjects.length ? (
          <div
            className={cn(
              "px-3 py-1.5 text-[12px] leading-5.5 text-muted-foreground",
              emptyClassName,
              collapsed && "px-0 text-center text-[10.5px] leading-5",
            )}
          >
            {recentProjectsReady ? (collapsed ? "暂无" : "还没有历史项目。") : collapsed ? "整理中" : "正在整理最近项目…"}
          </div>
        ) : null}
      </div>
      {/* 批量操作栏 */}
      {isSelectMode && selectedIds.size > 0 && !collapsed ? (
        <div className="mt-1.5 flex items-center justify-between rounded-[10px] border border-rose-400/20 bg-rose-500/8 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">已选 {selectedIds.size} 项</span>
          <button
            type="button"
            onClick={() => setBulkDeleteConfirmOpen(true)}
            className="flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1 text-[11px] font-medium text-white transition hover:bg-rose-700"
          >
            <Trash2 className="h-3 w-3" />
            删除所选
          </button>
        </div>
      ) : null}
      {/* 批量删除确认弹窗 */}
      <HomeAgentConfirmDialog
        open={bulkDeleteConfirmOpen}
        title={`删除 ${selectedIds.size} 个会话`}
        description={`即将永久删除所选的 ${selectedIds.size} 个会话记录，此操作不可撤销。`}
        confirmLabel="确认删除"
        pending={bulkDeletePending}
        onOpenChange={(open) => {
          if (!open && !bulkDeletePending) setBulkDeleteConfirmOpen(false);
        }}
        onConfirm={async () => {
          if (!onBulkDeleteProjects) return;
          setBulkDeletePending(true);
          try {
            const toDelete = visibleProjects.filter((p) => selectedIds.has(p.projectId));
            await onBulkDeleteProjects(toDelete);
            setSelectedIds(new Set());
            setIsSelectMode(false);
          } finally {
            setBulkDeletePending(false);
            setBulkDeleteConfirmOpen(false);
          }
        }}
      />
    </section>
  );
});

const SidebarAssetLibrary = memo(function SidebarAssetLibrary({
  assets,
  onOpenAsset,
  onDeleteAsset,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
  onRefreshSegmentContinuity,
  currentProjectId,
  emptyClassName,
  collapsed = false,
  fillHeight = false,
  externalDragOver = false,
  onDropHandled,
  highlightedAssetId,
  highlightedAssetMessage,
}: {
  assets: SidebarAssetItem[];
  onOpenAsset: (asset: SidebarAssetItem) => void;
  onDeleteAsset?: (asset: SidebarAssetItem) => void;
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRefreshSegmentContinuity?: (asset: SidebarAssetItem) => void | Promise<void>;
  currentProjectId?: string;
  emptyClassName?: string;
  collapsed?: boolean;
  fillHeight?: boolean;
  externalDragOver?: boolean;
  onDropHandled?: () => void;
  highlightedAssetId?: string | null;
  highlightedAssetMessage?: string | null;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const showDragOver = isDragOver || externalDragOver;
  const [activeTab, setActiveTab] = useState<"image" | "video">("image");
  const [activeSpecialPanel, setActiveSpecialPanel] = useState<"continuity" | "history-video" | "bundle" | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [imageSubTab, setImageSubTab] = useState<ImageSubTab>(IMAGE_SUB_TABS[0]);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);
  const [videoSubTab, setVideoSubTab] = useState<"镜头" | "片段">("镜头");
  // 记录用户是否曾主动操作过集数（点击展开/收起），操作后不再自动展开
  const userDidSelectEpisodeRef = React.useRef(false);
  const dragCounterRef = React.useRef(0);

  const segmentExtractionStates = useSidebarSegmentExtractionStates(currentProjectId);

  const handleDeleteWithUndo = useCallback((asset: SidebarAssetItem) => {
    if (!onDeleteAsset) return;
    onDeleteAsset(asset);
  }, [onDeleteAsset]);

  const showBundlePanel = activeSpecialPanel === "bundle";
  const showContinuityPanel = activeSpecialPanel === "continuity";
  const showHistoryVideoPanel = activeSpecialPanel === "history-video";
  const continuityGridAssets = React.useMemo(
    () =>
      assets
        .filter((a) => a.kind === "image" && a.subKind === "continuity-grid")
        .sort(compareSidebarAssetDisplayOrder),
    [assets],
  );
  const imageAssets = React.useMemo(
    () => assets.filter((a) => a.kind === "image" && a.subKind !== "continuity-grid"),
    [assets],
  );
  const historyVideoAssets = React.useMemo(
    () =>
      assets
        .filter((a) => a.kind === "video" && a.subKind === "history-video")
        .sort(compareSidebarAssetDisplayOrder),
    [assets],
  );
  const videoAssets = React.useMemo(
    () =>
      assets
        .filter((a) => a.kind === "video" && a.subKind !== "history-video")
        .sort(compareSidebarAssetDisplayOrder),
    [assets],
  );
  const bundleAssets = React.useMemo(() => assets.filter((a) => a.kind === "bundle"), [assets]);
  const matchesImageSubTab = useCallback(
    (asset: SidebarAssetItem, tab: ImageSubTab) => getImageSubTabForAsset(asset) === tab,
    [],
  );
  const visibleImageSubTabs = React.useMemo(
    () => IMAGE_SUB_TABS.filter((tab) => imageAssets.some((asset) => matchesImageSubTab(asset, tab))),
    [imageAssets, matchesImageSubTab],
  );

  const filteredImageAssets = React.useMemo(
    () => imageAssets.filter((a) => matchesImageSubTab(a, imageSubTab)),
    [imageAssets, imageSubTab, matchesImageSubTab],
  );

  const filteredEpisodeVideoAssets = React.useMemo(
    () =>
      selectedEpisode !== null
        ? videoAssets.filter((a) => {
            const match = a.label.match(VIDEO_EPISODE_LABEL_PATTERN);
            const ep = match ? parseInt(match[1] ?? match[2] ?? "1", 10) : 1;
            return ep === selectedEpisode;
          })
        : [],
    [videoAssets, selectedEpisode],
  );

  const filteredVideoAssets = React.useMemo(
    () =>
      filteredEpisodeVideoAssets.filter((a) =>
        videoSubTab === "片段"
          ? a.subKind === "segment"
          : a.subKind !== "segment",
      ),
    [filteredEpisodeVideoAssets, videoSubTab],
  );


  const episodeShotCount = React.useMemo(
    () => filteredEpisodeVideoAssets.filter((a) => a.subKind !== "segment").length,
    [filteredEpisodeVideoAssets],
  );

  const episodeSegmentCount = React.useMemo(
    () => filteredEpisodeVideoAssets.filter((a) => a.subKind === "segment").length,
    [filteredEpisodeVideoAssets],
  );

  const videoEpisodeGroups = React.useMemo(() => {
    const groups = new Map<number, SidebarAssetItem[]>();
    videoAssets.forEach((asset) => {
      const match = asset.label.match(VIDEO_EPISODE_LABEL_PATTERN);
      const ep = match ? parseInt(match[1] ?? match[2] ?? "1", 10) : 1;
      if (!groups.has(ep)) groups.set(ep, []);
      groups.get(ep)!.push(asset);
    });
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [videoAssets]);

  // 首次有视频时自动展开第一集；用户主动操作后不再干预
  React.useEffect(() => {
    if (videoEpisodeGroups.length > 0 && selectedEpisode === null && !userDidSelectEpisodeRef.current) {
      setSelectedEpisode(videoEpisodeGroups[0][0]);
    }
  }, [videoEpisodeGroups, selectedEpisode]);

  // 当前子选项卡无内容时自动切换到有内容的那个
  React.useEffect(() => {
    if (videoSubTab === "镜头" && episodeShotCount === 0 && episodeSegmentCount > 0) {
      setVideoSubTab("片段");
    } else if (videoSubTab === "片段" && episodeSegmentCount === 0 && episodeShotCount > 0) {
      setVideoSubTab("镜头");
    }
  }, [episodeShotCount, episodeSegmentCount, videoSubTab]);

  const activeList = React.useMemo(
    () =>
      activeSpecialPanel
        ? []
        : activeTab === "image"
          ? filteredImageAssets
          : filteredVideoAssets,
    [activeSpecialPanel, activeTab, filteredImageAssets, filteredVideoAssets],
  );
  const collapsedHighlightedAssetIndex = useMemo(
    () => (highlightedAssetId ? assets.findIndex((asset) => asset.id === highlightedAssetId) : -1),
    [assets, highlightedAssetId],
  );
  const collapsedRenderState = useIncrementalVisibleCount({
    totalCount: assets.length,
    chunkSize: ASSET_RENDER_CHUNK,
    resetKey: `collapsed:${fillHeight ? "fill" : "fixed"}`,
    priorityIndex: collapsedHighlightedAssetIndex,
  });
  const renderedCollapsedAssets = useMemo(
    () => assets.slice(0, collapsedRenderState.visibleCount),
    [assets, collapsedRenderState.visibleCount],
  );
  const highlightedImageIndex = useMemo(
    () =>
      activeTab === "image" && highlightedAssetId
        ? filteredImageAssets.findIndex((asset) => asset.id === highlightedAssetId)
        : -1,
    [activeTab, filteredImageAssets, highlightedAssetId],
  );
  const imageRenderState = useIncrementalVisibleCount({
    totalCount: filteredImageAssets.length,
    chunkSize: ASSET_RENDER_CHUNK,
    resetKey: `image:${imageSubTab}:${fillHeight ? "fill" : "fixed"}`,
    priorityIndex: highlightedImageIndex,
  });
  const renderedImageAssets = useMemo(
    () => filteredImageAssets.slice(0, imageRenderState.visibleCount),
    [filteredImageAssets, imageRenderState.visibleCount],
  );
  const highlightedVideoIndex = useMemo(
    () =>
      activeTab === "video" && highlightedAssetId
        ? filteredVideoAssets.findIndex((asset) => asset.id === highlightedAssetId)
        : -1,
    [activeTab, filteredVideoAssets, highlightedAssetId],
  );
  const videoRenderState = useIncrementalVisibleCount({
    totalCount: filteredVideoAssets.length,
    chunkSize: ASSET_RENDER_CHUNK,
    resetKey: `video:${selectedEpisode ?? "none"}:${videoSubTab}:${fillHeight ? "fill" : "fixed"}`,
    priorityIndex: highlightedVideoIndex,
  });
  const renderedVideoAssets = useMemo(
    () => filteredVideoAssets.slice(0, videoRenderState.visibleCount),
    [filteredVideoAssets, videoRenderState.visibleCount],
  );

  React.useEffect(() => {
    if (activeTab !== "image") return;
    const hasCurrentTab = imageAssets.some((a) => matchesImageSubTab(a, imageSubTab));
    if (!hasCurrentTab) {
      const first = IMAGE_SUB_TABS.find((tab) => imageAssets.some((a) => matchesImageSubTab(a, tab)));
      if (first) setImageSubTab(first);
    }
  }, [activeTab, imageAssets, imageSubTab, matchesImageSubTab]);

  React.useEffect(() => {
    if (!highlightedAssetId) return;
    const asset = assets.find((item) => item.id === highlightedAssetId);
    if (!asset || asset.kind === "bundle") return;

    if (asset.subKind === "continuity-grid") {
      setActiveSpecialPanel("continuity");
      return;
    }

    if (asset.subKind === "history-video") {
      setActiveSpecialPanel("history-video");
      return;
    }

    if (asset.kind === "video") {
      setActiveSpecialPanel(null);
      setActiveTab("video");
      const match = asset.label.match(VIDEO_EPISODE_LABEL_PATTERN);
      setSelectedEpisode(match ? parseInt(match[1] ?? match[2] ?? "1", 10) : 1);
      setVideoSubTab(asset.subKind === "segment" ? "片段" : "镜头");
      return;
    }

    setActiveSpecialPanel(null);
    setActiveTab("image");
    setImageSubTab(getImageSubTabForAsset(asset) ?? IMAGE_SUB_TABS[0]);
  }, [activeSpecialPanel, assets, highlightedAssetId]);

  React.useEffect(() => {
    if (!highlightedAssetId) return;
    const timer = window.setTimeout(() => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-asset-id]"));
      const target = rows.find((row) => row.dataset.sidebarAssetId === highlightedAssetId);
      target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [filteredImageAssets, filteredVideoAssets, highlightedAssetId]);

  const handlePromoteHistoryVideo = useCallback((asset: SidebarAssetItem) => {
    if (asset.kind !== "video" || !asset.segmentLabel || !asset.historyEntryId) return;
    window.dispatchEvent(
      new CustomEvent("agent:add-to-assets", {
        detail: {
          url: asset.url,
          ...(isLocalSidebarAssetUrl(asset.url) ? { localPath: normalizeSidebarAssetPath(asset.url) } : {}),
          fileName: asset.label,
          kind: "video" as const,
          historyEntryId: asset.historyEntryId,
          target: {
            action: "replace_segment_video" as const,
            ...(currentProjectId ? { projectId: currentProjectId } : {}),
            targetId: asset.segmentLabel,
          },
          isHistoricalVersion: true,
        },
      }),
    );
  }, [currentProjectId]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/x-infinio-image") ||
      e.dataTransfer.types.includes("Files")
    ) {
      dragCounterRef.current++;
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes("application/x-infinio-image") ||
      e.dataTransfer.types.includes("Files")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }, []);

const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    onDropHandled?.();
    const imageData = e.dataTransfer.getData("application/x-infinio-image");
    if (imageData) {
      try {
        const payload = JSON.parse(imageData) as Record<string, unknown>;
        window.dispatchEvent(new CustomEvent("agent:add-to-assets", {
          detail: {
            ...payload,
            preferredTab: activeTab,
            preferredImageSubTab: activeTab === "image" ? imageSubTab : undefined,
          },
        }));
      } catch {
        // 忽略解析错误
      }
      return;
    }
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
    );
    if (droppedFiles.length) {
      window.dispatchEvent(new CustomEvent("agent:add-to-assets", {
        detail: {
          files: droppedFiles,
          preferredTab: activeTab,
          preferredImageSubTab: activeTab === "image" ? imageSubTab : undefined,
        },
      }));
    }
  }, [activeTab, imageSubTab, onDropHandled]);

  const toggleSelectMode = useCallback(() => {
    setIsSelectMode((v) => !v);
    setSelectedIds(new Set());
  }, []);

  const toggleSelectId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === activeList.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(activeList.map((a) => a.id)));
    }
  }, [activeList, selectedIds.size]);

  const handleBulkDelete = useCallback(() => {
    if (!onDeleteAsset) return;
    const toDelete = assets.filter((a) => selectedIds.has(a.id));
    toDelete.forEach((a) => handleDeleteWithUndo(a));
    setSelectedIds(new Set());
    setIsSelectMode(false);
  }, [assets, handleDeleteWithUndo, onDeleteAsset, selectedIds]);

  // 折叠态：不分栏，直接列出所有素材
  if (collapsed) {
    return (
      <section
        className={cn("px-2 pb-2 pt-2.5 transition-colors", showDragOver && "rounded-xl bg-primary/5 ring-1 ring-primary/30")}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="mb-1.5 flex justify-center px-0 text-[9.5px] uppercase tracking-[0.2em] text-muted-foreground">
          <Image className="h-3.5 w-3.5" />
        </div>
        <div
          data-sidebar-asset-list="collapsed"
          className="sidebar-scrollbar max-h-[calc(100vh-200px)] overflow-y-auto space-y-px"
          onScroll={collapsedRenderState.handleScroll}
        >
          {assets.length ? (
            renderedCollapsedAssets.map((asset) => (
              <SidebarAssetRow
                key={asset.id}
                asset={asset}
                onOpen={onOpenAsset}
                onDelete={onDeleteAsset}
                onUploadCharacterAudioReference={onUploadCharacterAudioReference}
                onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
                currentProjectId={currentProjectId}
                collapsed
                highlighted={asset.id === highlightedAssetId}
                highlightMessage={asset.id === highlightedAssetId ? highlightedAssetMessage : null}
                extractionState={
                  asset.kind === "video" && asset.subKind === "segment" && asset.segmentLabel
                    ? segmentExtractionStates[asset.segmentLabel] || null
                    : null
                }
              />
            ))
          ) : (
            <div className={cn("px-0 text-center text-[10.5px] leading-5 text-muted-foreground", showDragOver && "text-primary/70")}>
              {showDragOver ? "放" : "暂无"}
            </div>
          )}
          {collapsedRenderState.hasMore ? (
            <div className="px-0 py-2 text-center">
              <button
                type="button"
                data-sidebar-load-more="collapsed-assets"
                onClick={collapsedRenderState.loadMore}
                className="rounded-full border border-border/70 px-3 py-1 text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
              >
                加载更多素材
              </button>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "pb-2 pt-2.5 transition-colors",
        fillHeight && "flex h-full flex-col",
        showDragOver && "rounded-xl bg-primary/5 ring-1 ring-primary/30",
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 标题行 */}
      <div
        data-sidebar-special-shell="true"
        className="mb-2 flex items-center gap-2 rounded-xl border border-border/50 bg-gradient-to-r from-muted/45 via-muted/25 to-transparent px-3 py-2 text-[12px] uppercase tracking-[0.18em] text-muted-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        <span className="mr-1 flex items-center gap-2 text-foreground/80">
          <Image className="h-4 w-4" />
          素材库
        </span>
        {/* 多选删除按钮 */}
        {onDeleteAsset && !showBundlePanel && !showContinuityPanel && !showHistoryVideoPanel && (
          <button
            type="button"
            onClick={toggleSelectMode}
            title={isSelectMode ? "退出多选" : "多选删除"}
            aria-label={isSelectMode ? "退出多选" : "多选删除"}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              isSelectMode
                ? "text-primary hover:bg-primary/10"
                : "text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground",
            )}
          >
            {isSelectMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
          </button>
        )}
        <div
          data-sidebar-special-group="true"
          className="ml-auto flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/60 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-sm"
        >
          <button
            type="button"
            data-sidebar-special-toggle="continuity"
            onClick={() => setActiveSpecialPanel((current) => (current === "continuity" ? null : "continuity"))}
            title={showContinuityPanel ? "返回素材库" : "查看前情六宫格"}
            aria-label={showContinuityPanel ? "返回素材库" : "查看前情六宫格"}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showContinuityPanel
                ? "bg-background text-primary shadow-sm ring-1 ring-primary/15"
                : continuityGridAssets.length > 0
                  ? "text-foreground/60 hover:bg-background/80 hover:text-foreground"
                  : "text-muted-foreground/40 hover:bg-muted/40 hover:text-muted-foreground",
            )}
          >
            <Images className="h-3.5 w-3.5" />
            {continuityGridAssets.length > 0 && !showContinuityPanel ? (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            ) : null}
          </button>
          {/* 生产状态包切换按钮 */}
          <button
            type="button"
            data-sidebar-special-toggle="history-video"
            onClick={() => setActiveSpecialPanel((current) => (current === "history-video" ? null : "history-video"))}
            title={showHistoryVideoPanel ? "返回素材库" : "查看历史视频"}
            aria-label={showHistoryVideoPanel ? "返回素材库" : "查看历史视频"}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showHistoryVideoPanel
                ? "bg-background text-primary shadow-sm ring-1 ring-primary/15"
                : historyVideoAssets.length > 0
                  ? "text-foreground/60 hover:bg-background/80 hover:text-foreground"
                  : "text-muted-foreground/40 hover:bg-muted/40 hover:text-muted-foreground",
            )}
          >
            <History className="h-3.5 w-3.5" />
            {historyVideoAssets.length > 0 && !showHistoryVideoPanel ? (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            ) : null}
          </button>
          <button
            type="button"
            data-sidebar-special-toggle="bundle"
            onClick={() => setActiveSpecialPanel((current) => (current === "bundle" ? null : "bundle"))}
            title={showBundlePanel ? "返回素材库" : "查看生产状态包"}
            aria-label={showBundlePanel ? "返回素材库" : "查看生产状态包"}
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              showBundlePanel
                ? "bg-background text-primary shadow-sm ring-1 ring-primary/15"
                : bundleAssets.length > 0
                  ? "text-foreground/60 hover:bg-background/80 hover:text-foreground"
                  : "text-muted-foreground/40 hover:bg-muted/40 hover:text-muted-foreground",
            )}
          >
            <Package className="h-3.5 w-3.5" />
            {bundleAssets.length > 0 && !showBundlePanel && (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </button>
        </div>
      </div>

      {showBundlePanel ? (
        /* ── 生产状态包分栏 ── */
        <div className={cn("sidebar-scrollbar overflow-y-auto px-2", fillHeight ? "flex-1" : "max-h-[240px]")}>
          {bundleAssets.length > 0 ? (
            <div className="space-y-1">
              {bundleAssets.map((asset) => (
                <div
                  key={asset.id}
                  className="group flex w-full flex-col gap-0.5 rounded-[12px] px-2 py-2 transition-colors hover:bg-muted/40"
                >
                  <button
                    type="button"
                    onClick={() => onOpenAsset(asset)}
                    className="flex w-full items-center gap-2 text-left"
                    aria-label={asset.label}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
                      <Package className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10.5px] font-medium text-foreground">{asset.label}</span>
                      <span className="block truncate text-[9px] text-muted-foreground">{asset.meta}</span>
                    </span>
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-[11.5px] leading-5 text-muted-foreground">
              暂无生产状态包。完成视频工作流后可导出生产状态包，用于续接或归档。
            </div>
          )}
        </div>
      ) : showContinuityPanel ? (
        <div
          data-sidebar-special-panel="continuity"
          className={cn("sidebar-scrollbar overflow-y-auto px-2", fillHeight ? "flex-1" : "max-h-[240px]")}
        >
          <div className="px-2 pb-2 pt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {"\u524d\u60c5\u516d\u5bab\u683c"}
          </div>
          {continuityGridAssets.length > 0 ? (
            <div className="space-y-1">
              {continuityGridAssets.map((asset) => (
                <SidebarAssetRow
                  key={asset.id}
                  asset={asset}
                  onOpen={onOpenAsset}
                  onDelete={onDeleteAsset}
                  onUploadCharacterAudioReference={onUploadCharacterAudioReference}
                  onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
                  currentProjectId={currentProjectId}
                  highlighted={asset.id === highlightedAssetId}
                  highlightMessage={asset.id === highlightedAssetId ? highlightedAssetMessage : null}
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-[11.5px] leading-5 text-muted-foreground">
              {"\u6682\u65e0\u524d\u60c5\u516d\u5bab\u683c\u3002\u7247\u6bb5\u751f\u6210\u5b8c\u6210\u540e\u4f1a\u81ea\u52a8\u5f52\u6863\u5230\u8fd9\u91cc\uff0c\u5e76\u5b9e\u65f6\u5237\u65b0\u3002"}
            </div>
          )}
        </div>
      ) : showHistoryVideoPanel ? (
        <div
          data-sidebar-special-panel="history-video"
          className={cn("sidebar-scrollbar overflow-y-auto px-2", fillHeight ? "flex-1" : "max-h-[240px]")}
        >
          <div className="px-2 pb-2 pt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {"\u5386\u53f2\u89c6\u9891"}
          </div>
          {historyVideoAssets.length > 0 ? (
            <div className="space-y-1">
              {historyVideoAssets.map((asset) => (
                <SidebarAssetRow
                  key={asset.id}
                  asset={asset}
                  onOpen={onOpenAsset}
                  onDelete={onDeleteAsset}
                  onUploadCharacterAudioReference={onUploadCharacterAudioReference}
                  onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
                  currentProjectId={currentProjectId}
                  highlighted={asset.id === highlightedAssetId}
                  highlightMessage={asset.id === highlightedAssetId ? highlightedAssetMessage : null}
                  extraAction={
                    asset.kind === "video" && asset.segmentLabel
                      ? {
                          icon: ArrowUpRight,
                          label: asset.promotedAt
                            ? `\u5df2\u4f20\u9012 ${asset.label}`
                            : `\u4f20\u9012 ${asset.label}`,
                          title: asset.promotedAt
                            ? "\u8be5\u5386\u53f2\u89c6\u9891\u5df2\u4f20\u9012\u5230\u6b63\u5f0f\u89c6\u9891\u680f"
                            : "\u4f20\u9012\u5230\u6b63\u5f0f\u89c6\u9891\u680f",
                          dataAttribute: "data-sidebar-history-transfer",
                          disabled: Boolean(asset.promotedAt),
                          onClick: handlePromoteHistoryVideo,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-[11.5px] leading-5 text-muted-foreground">
              {"\u6682\u65e0\u5386\u53f2\u89c6\u9891\u3002\u88ab QA \u62e6\u622a\u7684\u7247\u6bb5\u4f1a\u4f18\u5148\u5f52\u6863\u5230\u8fd9\u91cc\uff0c\u786e\u8ba4\u6ee1\u610f\u540e\u518d\u4f20\u9012\u5230\u6b63\u5f0f\u89c6\u9891\u680f\u3002"}
            </div>
          )}
        </div>
      ) : (
        /* ── 素材库（图片 / 视频）分栏 ── */
        <>
          {/* 图片 / 视频 标签页 */}
          <div className="mb-1 flex gap-0.5 px-2">
            <button
              type="button"
              onClick={() => { setActiveTab("image"); setSelectedIds(new Set()); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-[10px] py-2 text-[13px] font-medium transition-colors",
                activeTab === "image" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Image className="h-4 w-4" />
              图片
              {imageAssets.length > 0 && (
                <span
                  data-sidebar-accent-count="true"
                  className={cn("rounded-full px-1.5 text-[11px]", SIDEBAR_BLUE_VIOLET_BG, SIDEBAR_BLUE_VIOLET_TEXT)}
                >
                  {imageAssets.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab("video"); setSelectedIds(new Set()); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-[10px] py-2 text-[13px] font-medium transition-colors",
                activeTab === "video" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Clapperboard className="h-4 w-4" />
              视频
              {videoAssets.length > 0 && (
                <span
                  data-sidebar-accent-count="true"
                  className={cn("rounded-full px-1.5 text-[11px]", SIDEBAR_BLUE_VIOLET_BG, SIDEBAR_BLUE_VIOLET_TEXT)}
                >
                  {videoAssets.length}
                </span>
              )}
            </button>
          </div>

          {activeTab === "image" ? (
            /* ── 图片分栏：左侧子标签 + 右侧列表 ── */
            <>
              {/* 多选操作栏 */}
              {isSelectMode && filteredImageAssets.length > 0 && (
                <div className="mb-1 flex items-center gap-1.5 px-2">
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    {selectedIds.size === filteredImageAssets.length ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                    {selectedIds.size === filteredImageAssets.length ? "取消全选" : "全选"}
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={handleBulkDelete}
                      className="ml-auto flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-rose-700"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                      删除 {selectedIds.size} 项
                    </button>
                  )}
                </div>
              )}
              <div className={cn("flex", fillHeight && "flex-1 overflow-hidden")}>
                {/* 左侧子标签：仅在有对应素材时显示 */}
                {visibleImageSubTabs.length > 0 && (
                  <div className="flex shrink-0 flex-col gap-1 pl-2 pr-1.5 pt-0.5">
                    {visibleImageSubTabs.map((tab) => {
                      const count = imageAssets.filter((a) => matchesImageSubTab(a, tab)).length;
                      if (count === 0) return null;
                      return (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => { setImageSubTab(tab); setSelectedIds(new Set()); }}
                          className={cn(
                            "flex min-h-[60px] w-[30px] flex-col items-center justify-center gap-0.5 rounded-[8px] py-2 text-[12px] font-medium transition-colors",
                            imageSubTab === tab
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {tab.split("").map((char, i) => <span key={i} className="leading-[1.3]">{char}</span>)}
                          <span
                            data-sidebar-accent-count="true"
                            className={cn("mt-0.5 rounded-full px-0.5 text-[9px] leading-3.5", SIDEBAR_BLUE_VIOLET_BG, SIDEBAR_BLUE_VIOLET_TEXT)}
                          >
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div
                  data-sidebar-asset-list="image"
                  className={cn("sidebar-scrollbar flex-1 overflow-y-auto pr-2", fillHeight ? "" : "max-h-[240px]")}
                  onScroll={imageRenderState.handleScroll}
                >
                  <div className="space-y-px">
                    {filteredImageAssets.length ? (
                      renderedImageAssets.map((asset) => {
                        const selected = selectedIds.has(asset.id);
                        return (
                          <div
                            key={asset.id}
                            className={cn(
                              "relative rounded-[12px] transition-colors",
                              isSelectMode && selected && "bg-primary/10 ring-1 ring-inset ring-primary/30",
                            )}
                          >
                            {isSelectMode && (
                              <button
                                type="button"
                                onClick={() => toggleSelectId(asset.id)}
                                className="absolute left-1 top-1/2 z-10 -translate-y-1/2"
                                aria-label={selected ? "取消选择" : "选择"}
                              >
                                <span className={cn(
                                  "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                                  selected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/40 bg-background",
                                )}>
                                  {selected ? <CheckSquare className="h-3 w-3" /> : null}
                                </span>
                              </button>
                            )}
                            <div
                              className={cn(isSelectMode && "pl-6")}
                              onClick={isSelectMode ? () => toggleSelectId(asset.id) : undefined}
                              style={isSelectMode ? { cursor: "pointer" } : undefined}
                            >
                              <SidebarAssetRow
                                asset={asset}
                                onOpen={isSelectMode ? () => toggleSelectId(asset.id) : onOpenAsset}
                                onDelete={!isSelectMode ? handleDeleteWithUndo : undefined}
                                onUploadCharacterAudioReference={!isSelectMode ? onUploadCharacterAudioReference : undefined}
                                onRemoveCharacterAudioReference={!isSelectMode ? onRemoveCharacterAudioReference : undefined}
                                currentProjectId={currentProjectId}
                                collapsed={false}
                                highlighted={asset.id === highlightedAssetId}
                                highlightMessage={asset.id === highlightedAssetId ? highlightedAssetMessage : null}
                                extractionState={
                                  asset.kind === "video" && asset.subKind === "segment" && asset.segmentLabel
                                    ? segmentExtractionStates[asset.segmentLabel] || null
                                    : null
                                }
                              />
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className={cn("px-2 py-1.5 text-[12px] leading-5 text-muted-foreground", showDragOver && "text-primary/70")}>
                        {showDragOver ? "拖放到此处加入素材库" : `暂无${imageSubTab}素材`}
                      </div>
                    )}
                    {showDragOver && filteredImageAssets.length > 0 && (
                      <div className="mt-1 rounded-lg border border-dashed border-primary/40 py-2 text-center text-[10.5px] text-primary/60">
                        放开以加入素材库
                      </div>
                    )}
                    {imageRenderState.hasMore ? (
                      <div className="px-2 py-2 text-center">
                        <button
                          type="button"
                          data-sidebar-load-more="image-assets"
                          onClick={imageRenderState.loadMore}
                          className="rounded-full border border-border/70 px-3 py-1 text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                        >
                          加载更多素材
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* ── 视频分栏：集数标签网格 + 纵向列表 ── */
            <div className={cn(fillHeight && "flex flex-1 flex-col overflow-hidden")}>
              {videoAssets.length > 0 ? (
                <>
                  {/* 集数标签（网格，每行四集） */}
                  <div
                    data-sidebar-episode-grid="true"
                    className="mb-1 grid grid-cols-4 px-2 pb-0.5"
                  >
                    {videoEpisodeGroups.map(([ep, clips]) => (
                      <button
                        key={ep}
                        type="button"
                        onClick={() => { userDidSelectEpisodeRef.current = true; setSelectedEpisode(selectedEpisode === ep ? null : ep); setSelectedIds(new Set()); setVideoSubTab("镜头"); }}
                        className={cn(
                          "rounded-[8px] px-1 py-1.5 text-[12px] font-medium transition-colors",
                          selectedEpisode === ep
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        第{ep}集
                        <span
                          data-sidebar-accent-count="true"
                          className={cn("ml-1 rounded-full px-1 text-[10px]", SIDEBAR_BLUE_VIOLET_BG, SIDEBAR_BLUE_VIOLET_TEXT)}
                        >
                          {clips.length}
                        </span>
                      </button>
                    ))}
                  </div>
                  {selectedEpisode !== null ? (
                    /* 已选集数：左侧子标签（镜头/片段）+ 右侧列表 + 多选删除 */
                    <>
                      {isSelectMode && filteredVideoAssets.length > 0 && (
                        <div className="mb-1 flex items-center gap-1.5 px-2">
                          <button
                            type="button"
                            onClick={handleSelectAll}
                            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                          >
                            {selectedIds.size === filteredVideoAssets.length ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                            {selectedIds.size === filteredVideoAssets.length ? "取消全选" : "全选"}
                          </button>
                          {selectedIds.size > 0 && (
                            <button
                              type="button"
                              onClick={handleBulkDelete}
                              className="ml-auto flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-rose-700"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                              删除 {selectedIds.size} 项
                            </button>
                          )}
                        </div>
                      )}
                      <div className={cn("flex", fillHeight && "flex-1 overflow-hidden")}>
                        {/* 左侧子标签：始终显示，有哪种类型就显示哪个标签 */}
                        <div className="flex shrink-0 flex-col gap-1 pl-2 pr-1.5 pt-0.5">
                          {(["镜头", "片段"] as const).map((tab) => {
                            const count = tab === "片段" ? episodeSegmentCount : episodeShotCount;
                            if (count === 0) return null;
                            return (
                              <button
                                key={tab}
                                type="button"
                                onClick={() => { setVideoSubTab(tab); setSelectedIds(new Set()); }}
                                className={cn(
                                  "flex min-h-[60px] w-[30px] flex-col items-center justify-center gap-0.5 rounded-[8px] py-2 text-[12px] font-medium transition-colors",
                                  videoSubTab === tab
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground hover:text-foreground",
                                )}
                              >
                                {tab.split("").map((char, i) => <span key={i} className="leading-[1.3]">{char}</span>)}
                                <span
                                  data-sidebar-accent-count="true"
                                  className={cn("mt-0.5 rounded-full px-0.5 text-[9px] leading-3.5", SIDEBAR_BLUE_VIOLET_BG, SIDEBAR_BLUE_VIOLET_TEXT)}
                                >
                                  {count}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        {/* 右侧视频列表 */}
                        <div
                          data-sidebar-asset-list="video"
                          className={cn(
                            "sidebar-scrollbar overflow-y-auto pb-2 flex-1 pr-2",
                            !fillHeight && "max-h-[200px]",
                          )}
                          onScroll={videoRenderState.handleScroll}
                        >
                          <div className="space-y-px">
                            {renderedVideoAssets.map((asset) => {
                              const selected = selectedIds.has(asset.id);
                              return (
                                <div
                                  key={asset.id}
                                  className={cn(
                                    "relative rounded-[12px] transition-colors",
                                    isSelectMode && selected && "bg-primary/10 ring-1 ring-inset ring-primary/30",
                                  )}
                                >
                                  {isSelectMode && (
                                    <button
                                      type="button"
                                      onClick={() => toggleSelectId(asset.id)}
                                      className="absolute left-1 top-1/2 z-10 -translate-y-1/2"
                                      aria-label={selected ? "取消选择" : "选择"}
                                    >
                                      <span className={cn(
                                        "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                                        selected
                                          ? "border-primary bg-primary text-primary-foreground"
                                          : "border-muted-foreground/40 bg-background",
                                      )}>
                                        {selected ? <CheckSquare className="h-3 w-3" /> : null}
                                      </span>
                                    </button>
                                  )}
                                  <div
                                    className={cn(isSelectMode && "pl-6")}
                                    onClick={isSelectMode ? () => toggleSelectId(asset.id) : undefined}
                                    style={isSelectMode ? { cursor: "pointer" } : undefined}
                                  >
                                    <SidebarAssetRow
                                      asset={asset}
                                      onOpen={isSelectMode ? () => toggleSelectId(asset.id) : onOpenAsset}
                                      onDelete={!isSelectMode ? handleDeleteWithUndo : undefined}
                                      onUploadCharacterAudioReference={!isSelectMode ? onUploadCharacterAudioReference : undefined}
                                      onRemoveCharacterAudioReference={!isSelectMode ? onRemoveCharacterAudioReference : undefined}
                                      extraAction={
                                        !isSelectMode &&
                                        asset.kind === "video" &&
                                        asset.subKind === "segment" &&
                                        onRefreshSegmentContinuity
                                          ? {
                                              icon: RefreshCw,
                                              label: asset.continuityGridReady ? `更新 ${asset.label} 六宫格` : `生成 ${asset.label} 六宫格`,
                                              title: asset.continuityGridReady ? "更新六格" : "组六格",
                                              dataAttribute: "data-sidebar-segment-refresh",
                                              disabled:
                                                asset.kind === "video" &&
                                                asset.subKind === "segment" &&
                                                asset.segmentLabel
                                                  ? segmentExtractionStates[asset.segmentLabel]?.status === "extracting"
                                                  : false,
                                              onClick: onRefreshSegmentContinuity,
                                            }
                                          : undefined
                                      }
                                      currentProjectId={currentProjectId}
                                      collapsed={false}
                                      highlighted={asset.id === highlightedAssetId}
                                      highlightMessage={asset.id === highlightedAssetId ? highlightedAssetMessage : null}
                                      extractionState={
                                        asset.kind === "video" && asset.subKind === "segment" && asset.segmentLabel
                                          ? segmentExtractionStates[asset.segmentLabel] || null
                                          : null
                                      }
                                    />
                                  </div>
                                </div>
                              );
                            })}
                            {videoRenderState.hasMore ? (
                              <div className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  data-sidebar-load-more="video-assets"
                                  onClick={videoRenderState.loadMore}
                                  className="rounded-full border border-border/70 px-3 py-1 text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                                >
                                  加载更多素材
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className={cn("px-3 py-1.5 text-[11.5px] leading-5 text-muted-foreground", emptyClassName)}>
                      点击集数标签查看该集的所有视频片段
                    </div>
                  )}
                </>
              ) : (
                <div className={cn("px-3 py-1.5 text-[12px] leading-5.5 text-muted-foreground", emptyClassName, showDragOver && "text-primary/70")}>
                  {showDragOver ? "拖放到此处加入素材库" : "素材库中还没有视频。当前项目里新生成的视频会自动出现在这里，也可以手动拖入。"}
                </div>
              )}
              {showDragOver && videoAssets.length > 0 && (
                <div className="mx-2 mt-1 rounded-lg border border-dashed border-primary/40 py-2 text-center text-[10.5px] text-primary/60">
                  放开以加入素材库
                </div>
              )}
            </div>
          )}
        </>
      )}

    </section>
  );
});

export const DesktopSidebar = memo(function DesktopSidebar({
  idle,
  recentProjects,
  recentProjectSessions = [],
  recentProjectsReady,
  templates,
  assets,
  currentProjectId,
  currentProjectSnapshot,
  collapsed = false,
  brandLabel,
  expandedWidth,
  collapsedWidth,
  onTemplateLaunch,
  onOpenProject,
  onTogglePinProject,
  onRenameProject,
  onDuplicateProject,
  onCleanExpiredVideos,
  onDeleteProject,
  onBulkDeleteProjects,
  onExportChatHistory,
  onImportChatHistory,
  onOpenProjectFolder,
  onNewProject,
  onOpenSettings,
  onToggleCollapse,
  onWidthChange,
  onRefreshProjects,
  isRefreshingProjects,
  onGlobalImportChatHistory,
  onDeleteAsset,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
  onRefreshSegmentContinuity,
  highlightedAssetId,
  highlightedAssetMessage,
  automationMode = "manual",
  fullAutoRunStatus,
}: {
  idle: boolean;
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  recentProjectsReady: boolean;
  templates: HomeAgentTemplate[];
  assets: SidebarAssetItem[];
  currentProjectId?: string;
  currentProjectSnapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null;
  collapsed?: boolean;
  brandLabel: string;
  expandedWidth: number;
  collapsedWidth: number;
  onTemplateLaunch: (templateId: string, prompt: string, title: string) => void;
  onOpenProject: (projectId: string) => void;
  onTogglePinProject?: (project: ConversationProjectSnapshot) => void;
  onRenameProject?: (project: ConversationProjectSnapshot) => void;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onCleanExpiredVideos?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  onBulkDeleteProjects?: (snapshots: ConversationProjectSnapshot[]) => Promise<void>;
  onExportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onImportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onOpenProjectFolder?: (project: ConversationProjectSnapshot) => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  onToggleCollapse: () => void;
  onWidthChange?: (width: number) => void;
  onRefreshProjects?: () => void;
  isRefreshingProjects?: boolean;
  onGlobalImportChatHistory?: () => void;
  onDeleteAsset?: (asset: SidebarAssetItem) => void;
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRefreshSegmentContinuity?: (asset: SidebarAssetItem) => void | Promise<void>;
  highlightedAssetId?: string | null;
  highlightedAssetMessage?: string | null;
  automationMode?: AutomationMode;
  fullAutoRunStatus?: FullAutoRunStatus | null;
}) {
  useEffect(() => () => stopSidebarCharacterAudioPlayback(), []);
  const mediaAssets = React.useMemo(
    () => assets.filter((a): a is SidebarMediaAsset => a.kind === "image" || a.kind === "video"),
    [assets],
  );
  const [mediaLightboxIndex, setMediaLightboxIndex] = useState<number | null>(null);
  const [isDragOverAssets, setIsDragOverAssets] = useState(false);
  const assetDragCounterRef = React.useRef(0);

  const handleAssetPanelDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-infinio-image") || e.dataTransfer.types.includes("Files")) {
      assetDragCounterRef.current++;
      setIsDragOverAssets(true);
    }
  }, []);

  const handleAssetPanelDragLeave = useCallback(() => {
    assetDragCounterRef.current = Math.max(0, assetDragCounterRef.current - 1);
    if (assetDragCounterRef.current === 0) setIsDragOverAssets(false);
  }, []);

  const handleAssetPanelDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-infinio-image") || e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

const handleAssetPanelDrop = useCallback((e: React.DragEvent) => {
    assetDragCounterRef.current = 0;
    setIsDragOverAssets(false);
    e.preventDefault();
    const imageData = e.dataTransfer.getData("application/x-infinio-image");
    if (imageData) {
      try {
        const payload = JSON.parse(imageData) as Record<string, unknown>;
        window.dispatchEvent(new CustomEvent("agent:add-to-assets", { detail: payload }));
      } catch { /* ignore */ }
      return;
    }
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
    );
    if (droppedFiles.length) {
      window.dispatchEvent(new CustomEvent("agent:add-to-assets", { detail: { files: droppedFiles } }));
    }
  }, []);

  const handleResetAssetDrag = useCallback(() => {
    assetDragCounterRef.current = 0;
    setIsDragOverAssets(false);
  }, []);

  const handleOpenAsset = useCallback((asset: SidebarAssetItem) => {
    if (asset.kind === "image" || asset.kind === "video") {
      const idx = mediaAssets.findIndex((a) => a.id === asset.id);
      setMediaLightboxIndex(idx >= 0 ? idx : 0);
      return;
    }
    void openSidebarAsset(asset);
  }, [mediaAssets]);

  const handleLaunchTemplate = useCallback(
    (template: HomeAgentTemplate) => {
      onTemplateLaunch(template.id, template.prompt, template.title);
    },
    [onTemplateLaunch],
  );

  // 右侧边界拖拽调整宽度
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (!onWidthChange || collapsed) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: expandedWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newWidth = Math.max(200, Math.min(480, dragRef.current.startWidth + delta));
      onWidthChange(newWidth);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [collapsed, expandedWidth, onWidthChange]);

  return (
    <aside className="hidden lg:block" data-home-desktop-sidebar="true">
      <SidebarAssetImageLightbox
        assets={mediaAssets}
        initialIndex={mediaLightboxIndex}
        onOpenChange={(next) => {
          if (!next) setMediaLightboxIndex(null);
        }}
        currentProjectId={currentProjectId}
      />
      <div
        className="fixed inset-y-0 left-0 z-40 border-r border-border bg-background [contain:layout_paint] transition-[width] duration-200"
        style={{
          width: collapsed ? collapsedWidth : expandedWidth,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "width",
        }}
      >
        {/* 右侧可拖拽边界手柄 */}
        {!collapsed && onWidthChange && (
          <div
            className="group/resize absolute inset-y-0 right-0 z-50 w-2 cursor-col-resize"
            onMouseDown={handleResizeStart}
          >
            <div className="absolute inset-y-0 right-0 w-px bg-border transition-all duration-150 group-hover/resize:w-0.5 group-hover/resize:bg-primary/50" />
            <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col gap-[3px] opacity-0 transition-opacity group-hover/resize:opacity-100">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-1 w-1 rounded-full bg-primary/50" />
              ))}
            </div>
          </div>
        )}
        <SidebarBrandHeader
          idle={idle}
          brandLabel={brandLabel}
          collapsed={collapsed}
          onToggleCollapse={onToggleCollapse}
        />

        <div className="flex h-[calc(100vh-72px)] flex-col">
          {/* 折叠状态：单一滚动区 */}
          {collapsed ? (
            <div className="sidebar-scrollbar flex-1 overflow-y-auto py-4 px-2.5">
              <SidebarPrimaryAction idle={idle} onClick={onNewProject} collapsed />
              {idle ? (
                <SidebarQuickTasks templates={templates} onLaunch={handleLaunchTemplate} collapsed />
              ) : null}
            </div>
          ) : idle ? (
            /* 展开 + 空闲（无素材库）：快捷任务收缩在上，历史区吃满剩余高度 */
            <div className="flex flex-1 min-h-0 flex-col py-4 px-3">
              <div className="shrink-0">
                <SidebarPrimaryAction idle={idle} onClick={onNewProject} collapsed={false} />
                <SidebarQuickTasks templates={templates} onLaunch={handleLaunchTemplate} collapsed={false} />
              </div>
              <div className="min-h-0 flex-1">
                <SidebarProjectHistory
                  recentProjects={recentProjects}
                  recentProjectSessions={recentProjectSessions}
                  recentProjectsReady={recentProjectsReady}
                  currentProjectId={currentProjectId}
                  currentProjectSnapshot={currentProjectSnapshot}
                  onOpenProject={onOpenProject}
                  onTogglePinProject={onTogglePinProject}
                  onRenameProject={onRenameProject}
                  onDuplicateProject={onDuplicateProject}
                  onCleanExpiredVideos={onCleanExpiredVideos}
                  onDeleteProject={onDeleteProject}
                  onBulkDeleteProjects={onBulkDeleteProjects}
                  onExportChatHistory={onExportChatHistory}
                  onImportChatHistory={onImportChatHistory}
                  onOpenProjectFolder={onOpenProjectFolder}
                  onRefresh={onRefreshProjects}
                  isRefreshing={isRefreshingProjects}
                  onGlobalImportChatHistory={onGlobalImportChatHistory}
                  collapsed={false}
                  automationMode={automationMode}
                  fullAutoRunStatus={fullAutoRunStatus}
                  fillHeight
                />
              </div>
            </div>
          ) : (
            /* 展开 + 活跃（有素材库）：可拖拽双面板 */
            <>
              <div className="shrink-0 py-4 px-3">
                <SidebarPrimaryAction idle={idle} onClick={onNewProject} collapsed={false} />
              </div>
              <ResizablePanelGroup
                direction="vertical"
                className="flex-1 min-h-0"
                autoSaveId="infinio-sidebar-panels"
              >
                <ResizablePanel defaultSize={55} minSize={15} className="overflow-hidden">
                  <div className="sidebar-scrollbar h-full overflow-y-auto px-3">
                    <SidebarProjectHistory
                      recentProjects={recentProjects}
                      recentProjectSessions={recentProjectSessions}
                      recentProjectsReady={recentProjectsReady}
                      currentProjectId={currentProjectId}
                      currentProjectSnapshot={currentProjectSnapshot}
                      onOpenProject={onOpenProject}
                      onTogglePinProject={onTogglePinProject}
                      onRenameProject={onRenameProject}
                      onDuplicateProject={onDuplicateProject}
                      onCleanExpiredVideos={onCleanExpiredVideos}
                      onDeleteProject={onDeleteProject}
                      onBulkDeleteProjects={onBulkDeleteProjects}
                      onExportChatHistory={onExportChatHistory}
                      onImportChatHistory={onImportChatHistory}
                      onOpenProjectFolder={onOpenProjectFolder}
                      onRefresh={onRefreshProjects}
                      isRefreshing={isRefreshingProjects}
                      onGlobalImportChatHistory={onGlobalImportChatHistory}
                      collapsed={false}
                      automationMode={automationMode}
                      fullAutoRunStatus={fullAutoRunStatus}
                      fillHeight
                    />
                  </div>
                </ResizablePanel>
                <SidebarResizeHandle />
                <ResizablePanel defaultSize={45} minSize={15} className="overflow-hidden">
                  <div
                    className={cn(
                      "sidebar-scrollbar h-full overflow-y-auto px-3 transition-colors",
                      isDragOverAssets && "rounded-xl bg-primary/5 ring-1 ring-inset ring-primary/30",
                    )}
                    onDragEnter={handleAssetPanelDragEnter}
                    onDragLeave={handleAssetPanelDragLeave}
                    onDragOver={handleAssetPanelDragOver}
                    onDrop={handleAssetPanelDrop}
                  >
                    <SidebarAssetLibrary
                      assets={assets}
                      onOpenAsset={handleOpenAsset}
                      onDeleteAsset={onDeleteAsset}
                      onUploadCharacterAudioReference={onUploadCharacterAudioReference}
                      onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
                      onRefreshSegmentContinuity={onRefreshSegmentContinuity}
                      currentProjectId={currentProjectId}
                      collapsed={false}
                      fillHeight
                      externalDragOver={isDragOverAssets}
                      onDropHandled={handleResetAssetDrag}
                      highlightedAssetId={highlightedAssetId}
                      highlightedAssetMessage={highlightedAssetMessage}
                    />
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          )}
          <SidebarFooter
            onOpenSettings={onOpenSettings}
            collapsed={collapsed}
          />
        </div>
      </div>
    </aside>
  );
});

export const MobileSidebarSheet = memo(function MobileSidebarSheet({
  open,
  onOpenChange,
  idle,
  recentProjects,
  recentProjectSessions = [],
  recentProjectsReady,
  templates,
  assets,
  currentProjectId,
  currentProjectSnapshot,
  brandLabel,
  sheetClassName,
  onTemplateLaunch,
  onOpenProject,
  onTogglePinProject,
  onRenameProject,
  onDuplicateProject,
  onCleanExpiredVideos,
  onDeleteProject,
  onBulkDeleteProjects,
  onExportChatHistory,
  onImportChatHistory,
  onOpenProjectFolder,
  onNewProject,
  onOpenSettings,
  onRefreshProjects,
  isRefreshingProjects,
  onGlobalImportChatHistory,
  onDeleteAsset,
  onUploadCharacterAudioReference,
  onRemoveCharacterAudioReference,
  onRefreshSegmentContinuity,
  highlightedAssetId,
  highlightedAssetMessage,
  automationMode = "manual",
  fullAutoRunStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idle: boolean;
  recentProjects: ConversationProjectSnapshot[];
  recentProjectSessions?: StudioSessionState[];
  recentProjectsReady: boolean;
  templates: HomeAgentTemplate[];
  assets: SidebarAssetItem[];
  currentProjectId?: string;
  currentProjectSnapshot?: Pick<ConversationProjectSnapshot, "projectId" | "automationMode"> | null;
  brandLabel: string;
  sheetClassName: string;
  onTemplateLaunch: (templateId: string, prompt: string, title: string) => void;
  onOpenProject: (projectId: string) => void;
  onTogglePinProject?: (project: ConversationProjectSnapshot) => void;
  onRenameProject?: (project: ConversationProjectSnapshot) => void;
  onDuplicateProject?: (project: ConversationProjectSnapshot) => void;
  onCleanExpiredVideos?: (project: ConversationProjectSnapshot) => void;
  onDeleteProject?: (project: ConversationProjectSnapshot) => void;
  onBulkDeleteProjects?: (snapshots: ConversationProjectSnapshot[]) => Promise<void>;
  onExportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onImportChatHistory?: (project: ConversationProjectSnapshot) => void;
  onOpenProjectFolder?: (project: ConversationProjectSnapshot) => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  onRefreshProjects?: () => void;
  isRefreshingProjects?: boolean;
  onGlobalImportChatHistory?: () => void;
  onDeleteAsset?: (asset: SidebarAssetItem) => void;
  onUploadCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRemoveCharacterAudioReference?: (characterId: string, characterName?: string) => void;
  onRefreshSegmentContinuity?: (asset: SidebarAssetItem) => void | Promise<void>;
  highlightedAssetId?: string | null;
  highlightedAssetMessage?: string | null;
  automationMode?: AutomationMode;
  fullAutoRunStatus?: FullAutoRunStatus | null;
}) {
  useEffect(() => () => stopSidebarCharacterAudioPlayback(), []);
  const handleLaunchTemplate = useCallback(
    (template: HomeAgentTemplate) => {
      onTemplateLaunch(template.id, template.prompt, template.title);
      onOpenChange(false);
    },
    [onOpenChange, onTemplateLaunch],
  );

  const handleOpenProjectFromSheet = useCallback(
    (projectId: string) => {
      onOpenChange(false);
      window.setTimeout(() => {
        onOpenProject(projectId);
      }, 0);
    },
    [onOpenChange, onOpenProject],
  );

  const handleNewProjectFromSheet = useCallback(() => {
    onNewProject();
    onOpenChange(false);
  }, [onNewProject, onOpenChange]);

  const handleDeleteProjectFromSheet = useCallback(
    (project: ConversationProjectSnapshot) => {
      onOpenChange(false);
      onDeleteProject?.(project);
    },
    [onDeleteProject, onOpenChange],
  );
  const handlePinProjectFromSheet = useCallback(
    (project: ConversationProjectSnapshot) => {
      onOpenChange(false);
      onTogglePinProject?.(project);
    },
    [onOpenChange, onTogglePinProject],
  );
  const handleRenameProjectFromSheet = useCallback(
    (project: ConversationProjectSnapshot) => {
      onOpenChange(false);
      onRenameProject?.(project);
    },
    [onOpenChange, onRenameProject],
  );
  const handleDuplicateProjectFromSheet = useCallback(
    (project: ConversationProjectSnapshot) => {
      onOpenChange(false);
      onDuplicateProject?.(project);
    },
    [onOpenChange, onDuplicateProject],
  );
  const handleCleanExpiredVideosFromSheet = useCallback(
    (project: ConversationProjectSnapshot) => {
      onOpenChange(false);
      onCleanExpiredVideos?.(project);
    },
    [onCleanExpiredVideos, onOpenChange],
  );

  const mobileMediaAssets = React.useMemo(
    () => assets.filter((a): a is SidebarMediaAsset => a.kind === "image" || a.kind === "video"),
    [assets],
  );
  const [imageLightboxIndex, setImageLightboxIndex] = useState<number | null>(null);

  const handleOpenAsset = useCallback(
    (asset: SidebarAssetItem) => {
      if (asset.kind === "image" || asset.kind === "video") {
        const idx = mobileMediaAssets.findIndex((a) => a.id === asset.id);
        setImageLightboxIndex(idx >= 0 ? idx : 0);
        return;
      }
      void openSidebarAsset(asset);
      onOpenChange(false);
    },
    [onOpenChange, mobileMediaAssets],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SidebarAssetImageLightbox
        assets={mobileMediaAssets}
        initialIndex={imageLightboxIndex}
        onOpenChange={(next) => {
          if (!next) setImageLightboxIndex(null);
        }}
        currentProjectId={currentProjectId}
      />
      <SheetContent side="left" className={cn(sheetClassName, "lg:hidden")}>
        <SheetHeader className="sr-only">
          <SheetTitle>导航</SheetTitle>
          <SheetDescription>当前首页会话的导航、历史项目和素材库。</SheetDescription>
        </SheetHeader>
        <SidebarBrandHeader idle={idle} brandLabel={brandLabel} />

        <div className="flex h-[calc(100vh-72px)] flex-col">
          <div className={cn("px-3 py-4", idle ? "flex min-h-0 flex-1 flex-col" : "sidebar-scrollbar flex-1 overflow-y-auto")}>
            <SidebarPrimaryAction idle={idle} onClick={handleNewProjectFromSheet} />

            {idle ? (
              <>
                <div className="shrink-0">
                  <SidebarQuickTasks templates={templates} onLaunch={handleLaunchTemplate} bordered />
                </div>
                <div className="min-h-0 flex-1">
                  <SidebarProjectHistory
                    recentProjects={recentProjects}
                    recentProjectSessions={recentProjectSessions}
                    recentProjectsReady={recentProjectsReady}
                    currentProjectId={currentProjectId}
                    currentProjectSnapshot={currentProjectSnapshot}
                    onOpenProject={handleOpenProjectFromSheet}
                    onTogglePinProject={onTogglePinProject ? handlePinProjectFromSheet : undefined}
                    onRenameProject={onRenameProject ? handleRenameProjectFromSheet : undefined}
                    onDuplicateProject={onDuplicateProject ? handleDuplicateProjectFromSheet : undefined}
                    onCleanExpiredVideos={onCleanExpiredVideos ? handleCleanExpiredVideosFromSheet : undefined}
                    onDeleteProject={onDeleteProject ? handleDeleteProjectFromSheet : undefined}
                    onBulkDeleteProjects={onBulkDeleteProjects}
                    onRefresh={onRefreshProjects}
                    isRefreshing={isRefreshingProjects}
                    onExportChatHistory={onExportChatHistory}
                    onImportChatHistory={onImportChatHistory}
                    onOpenProjectFolder={onOpenProjectFolder}
                    onGlobalImportChatHistory={onGlobalImportChatHistory}
                    emptyClassName="py-2.5 text-[13px]"
                    bordered
                    automationMode={automationMode}
                    fullAutoRunStatus={fullAutoRunStatus}
                    fillHeight
                  />
                </div>
              </>
            ) : (
              <>
                <SidebarProjectHistory
                  recentProjects={recentProjects}
                  recentProjectSessions={recentProjectSessions}
                  recentProjectsReady={recentProjectsReady}
                  currentProjectId={currentProjectId}
                  currentProjectSnapshot={currentProjectSnapshot}
                  onOpenProject={handleOpenProjectFromSheet}
                  onTogglePinProject={onTogglePinProject ? handlePinProjectFromSheet : undefined}
                  onRenameProject={onRenameProject ? handleRenameProjectFromSheet : undefined}
                  onDuplicateProject={onDuplicateProject ? handleDuplicateProjectFromSheet : undefined}
                  onCleanExpiredVideos={onCleanExpiredVideos ? handleCleanExpiredVideosFromSheet : undefined}
                  onDeleteProject={onDeleteProject ? handleDeleteProjectFromSheet : undefined}
                  onBulkDeleteProjects={onBulkDeleteProjects}
                  onRefresh={onRefreshProjects}
                  isRefreshing={isRefreshingProjects}
                  onExportChatHistory={onExportChatHistory}
                  onImportChatHistory={onImportChatHistory}
                  onOpenProjectFolder={onOpenProjectFolder}
                  onGlobalImportChatHistory={onGlobalImportChatHistory}
                  emptyClassName="py-2.5 text-[13px]"
                  bordered
                  automationMode={automationMode}
                  fullAutoRunStatus={fullAutoRunStatus}
                />

                <SidebarAssetLibrary
                  assets={assets}
                  onOpenAsset={handleOpenAsset}
                  onDeleteAsset={onDeleteAsset}
                  onUploadCharacterAudioReference={onUploadCharacterAudioReference}
                  onRemoveCharacterAudioReference={onRemoveCharacterAudioReference}
                  onRefreshSegmentContinuity={onRefreshSegmentContinuity}
                  currentProjectId={currentProjectId}
                  emptyClassName="py-2.5 text-[13px]"
                  highlightedAssetId={highlightedAssetId}
                  highlightedAssetMessage={highlightedAssetMessage}
                />
              </>
            )}
          </div>
          <SidebarFooter
            onOpenSettings={() => {
              onOpenSettings();
              onOpenChange(false);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
});
