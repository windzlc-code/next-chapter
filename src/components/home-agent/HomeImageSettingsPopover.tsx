import * as React from "react";
import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  getVideoImageResolutionLabel,
  listHomeAgentImageAspectRatios,
  normalizeVideoImageGenerationPrefs,
  resolveVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  getHomeAgentVideoModelOption,
  getVideoGenerationResolutionLabel,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
} from "@/lib/home-agent/video-models";
import type { HomeAgentImageStyleRecognitionResult } from "@/lib/home-agent/image-style-analysis";
import type { CreationMode } from "@/lib/home-agent/types";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import { cn } from "@/lib/utils";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

const { memo, useEffect, useMemo, useRef, useState } = React;

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 560;

const CREATION_MODE_LABELS: Record<CreationMode, string> = {
  creative: "创作模式",
  fast: "快速模式",
  pro: "pro",
};

const VIDEO_MODE_LABELS: Record<NonNullable<VideoGenerationPrefs["mode"]>, string> = {
  "text-to-video": "文生视频",
  "image-to-video": "图生视频",
};

const STYLE_CATEGORY_LABELS = {
  realistic: "写实类",
  "animation-3d": "三维动画类",
  "animation-2d": "二维动画类",
  custom: "自定义",
} as const;

const STYLE_PRESET_LABELS = {
  "live-action": "真人影视",
  "hyper-cg": "超写实 CG",
  "3d-cartoon": "3D 欧美卡通",
  "2.5d-stylized": "2.5D 绘本风",
  "anime-3d": "三渲二动漫",
  "cel-animation": "传统赛璐璐",
  "retro-comic": "美式复古漫画",
  custom: "自定义",
} as const;

function buildPopupPosition(
  anchorRect: DOMRect | null,
  panelHeight = PANEL_HEIGHT,
): React.CSSProperties {
  return buildToolbarPopoverPosition(anchorRect, {
    panelWidth: PANEL_WIDTH,
    panelHeight,
    align: "center",
  });
}

function buildSyncFallbackDescription(prefs: VideoImageGenerationPrefs): string {
  if (prefs.familyKey !== "nano-banana-2-async") {
    return "当前生图模型走同步生成链路。";
  }

  const syncModel =
    prefs.resolution === "4k"
      ? "gemini-3-pro-image-preview-4k"
      : prefs.resolution === "2k"
        ? "gemini-3-pro-image-preview-2k"
        : "gemini-3-pro-image-preview";

  return `异步投递失败时会自动回退到 ${syncModel}。`;
}

function buildStyleLabel(prefs: VideoImageGenerationPrefs): string {
  const categoryLabel = STYLE_CATEGORY_LABELS[prefs.styleCategory];
  if (prefs.stylePreset === "custom") {
    const customPrompt = prefs.customStylePrompt?.trim();
    return customPrompt ? `${categoryLabel} · ${customPrompt}` : `${categoryLabel} · 自定义`;
  }

  return `${categoryLabel} · ${STYLE_PRESET_LABELS[prefs.stylePreset]}`;
}

export interface HomeImageSettingsPopoverProps {
  activeTheme: boolean;
  value: VideoImageGenerationPrefs;
  onConfirm: (value: VideoImageGenerationPrefs) => void;
  attachedImageCount?: number;
  onRecognizeStyle?: () => Promise<HomeAgentImageStyleRecognitionResult | null>;
  videoPrefs?: VideoGenerationPrefs;
  onConfirmVideoPrefs?: (value: VideoGenerationPrefs) => void;
  creationMode: CreationMode;
  onCreationModeChange: (mode: CreationMode) => void;
}

export const HomeImageSettingsPopover = memo(function HomeImageSettingsPopover({
  value,
  onConfirm,
  videoPrefs,
  creationMode,
}: HomeImageSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VideoImageGenerationPrefs>(() =>
    normalizeVideoImageGenerationPrefs(value),
  );
  const [position, setPosition] = useState<React.CSSProperties>(() =>
    buildPopupPosition(null),
  );
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const normalizedValue = useMemo(
    () => normalizeVideoImageGenerationPrefs(value),
    [value],
  );
  const normalizedVideoPrefs = useMemo(
    () => normalizeVideoGenerationPrefs(videoPrefs),
    [videoPrefs],
  );
  const resolvedDraft = useMemo(() => resolveVideoImageGenerationPrefs(draft), [draft]);
  const aspectRatios = useMemo(() => listHomeAgentImageAspectRatios(), []);
  const summary = useMemo(
    () => `${getVideoImageResolutionLabel(normalizedValue.resolution)} · ${normalizedValue.aspectRatio}`,
    [normalizedValue],
  );
  const creationModeLabel = CREATION_MODE_LABELS[creationMode];
  const videoModeLabel = VIDEO_MODE_LABELS[normalizedVideoPrefs.mode];
  const currentVideoModelLabel = getHomeAgentVideoModelOption(normalizedVideoPrefs.modelKey).label;
  const styleLabel = buildStyleLabel(draft);
  const imageOutputLabel = `${getVideoImageResolutionLabel(draft.resolution)} / ${resolvedDraft.providerAspectRatio}`;
  const videoOutputLabel = getVideoGenerationResolutionLabel(normalizedVideoPrefs.resolution);

  useEffect(() => {
    if (!open) return;

    setDraft(normalizeVideoImageGenerationPrefs(value));

    const updatePosition = () => {
      const measuredHeight = panelRef.current?.getBoundingClientRect().height ?? PANEL_HEIGHT;
      setPosition(
        buildPopupPosition(
          shellRef.current?.getBoundingClientRect() ?? null,
          measuredHeight,
        ),
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (shellRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={shellRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="home-image-settings-trigger"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex h-8 max-w-[min(30vw,144px)] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition sm:h-9",
          "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              data-testid="home-image-settings-panel"
              className={cn(
                "fixed z-[73] max-h-[min(82vh,600px)] w-[280px] overflow-y-auto rounded-[24px] border p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                "border-border bg-card text-foreground",
              )}
              style={position}
            >
              <div className="space-y-3">
                <div className="px-2.5 pb-0.5 pt-1 text-muted-foreground">
                  <div className="text-[10px] uppercase tracking-[0.2em]">参数概览</div>
                  <div className="mt-1 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                    图像高级参数
                  </div>
                </div>

                <section className="space-y-1.5 px-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">画面比例</div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {aspectRatios.map((aspectRatio) => {
                      const selected = draft.aspectRatio === aspectRatio;
                      return (
                        <button
                          key={aspectRatio}
                          type="button"
                          data-testid={`home-image-aspect-${aspectRatio.replace(":", "-")}`}
                          onClick={() => {
                            const nextDraft = normalizeVideoImageGenerationPrefs({
                              ...draft,
                              aspectRatio,
                            });
                            setDraft(nextDraft);
                            onConfirm(nextDraft);
                          }}
                          className={cn(
                            "rounded-[12px] border px-1 py-1.5 text-[11px] transition",
                            selected
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border bg-muted/30 text-foreground/80 hover:bg-muted/60",
                          )}
                        >
                          {aspectRatio}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="mx-1 rounded-[16px] border border-border/70 bg-muted/35 px-3 py-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">当前参数</div>
                  <div className="mt-2 grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-[1.5]">
                    <div className="text-foreground/80">创作模式</div>
                    <div data-testid="home-image-preview-creation-mode" className="min-w-0 truncate text-muted-foreground">{creationModeLabel}</div>

                    <div className="text-foreground/80">视频模式</div>
                    <div data-testid="home-image-preview-video-mode" className="min-w-0 truncate text-muted-foreground">{videoModeLabel}</div>

                    <div className="text-foreground/80">风格类型</div>
                    <div data-testid="home-image-preview-style" className="min-w-0 truncate text-muted-foreground">{styleLabel}</div>

                    <div className="text-foreground/80">生图模型</div>
                    <div data-testid="home-image-success-preview" className="min-w-0 truncate text-muted-foreground">{resolvedDraft.family.label}</div>

                    <div className="text-foreground/80">视频模型</div>
                    <div data-testid="home-image-preview-video-model" className="min-w-0 truncate text-muted-foreground">{currentVideoModelLabel}</div>

                    <div className="text-foreground/80">生图输出</div>
                    <div data-testid="home-image-output-preview" className="min-w-0 truncate text-muted-foreground">{imageOutputLabel}</div>

                    <div className="text-foreground/80">视频输出</div>
                    <div data-testid="home-image-preview-video-output" className="min-w-0 truncate text-muted-foreground">{videoOutputLabel}</div>

                    <div className="text-foreground/80">生图提交</div>
                    <div data-testid="home-image-transport-preview" className="min-w-0 truncate text-muted-foreground">{resolvedDraft.transportModel}</div>

                    <div className="text-foreground/80">视频提交</div>
                    <div data-testid="home-image-preview-video-transport" className="min-w-0 truncate text-muted-foreground">{resolveVideoGenerationModelName(normalizedVideoPrefs)}</div>

                    <div className="text-foreground/80">回退说明</div>
                    <div data-testid="home-image-preview-fallback" className="min-w-0 break-words text-muted-foreground">{buildSyncFallbackDescription(resolvedDraft.prefs)}</div>
                  </div>
                </section>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
