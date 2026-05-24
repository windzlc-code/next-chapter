import * as React from "react";
import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  applyVideoImageViewModeConstraints,
  getVideoImageResolutionLabel,
  listHomeAgentImageAspectRatios,
  listHomeAgentImageAspectRatiosForViewMode,
  resolveVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import {
  getHomeAgentVideoModelOption,
  getVideoGenerationResolutionLabel,
  listHomeAgentVideoAspectRatios,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
  videoModelSupportsAspectRatio,
} from "@/lib/home-agent/video-models";
import type { HomeAgentImageStyleRecognitionResult } from "@/lib/home-agent/image-style-analysis";
import type { CreationMode } from "@/lib/home-agent/types";
import type { VideoGenerationPrefs, VideoImageGenerationPrefs } from "@/types/project";
import { cn } from "@/lib/utils";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

const { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;

const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 560;

const VIDEO_MODE_LABELS: Record<NonNullable<VideoGenerationPrefs["mode"]>, string> = {
  "text-to-video": "文生视频",
  "image-to-video": "图生视频",
};

const VIEW_MODE_LABELS: Record<NonNullable<VideoImageGenerationPrefs["viewMode"]>, string> = {
  three: "三视图",
  single: "单图",
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
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
}

export const HomeImageSettingsPopover = memo(function HomeImageSettingsPopover({
  value,
  onConfirm,
  videoPrefs,
  onConfirmVideoPrefs,
  onDevImageViewModeChange,
}: HomeImageSettingsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [positionReady, setPositionReady] = useState(false);
  const [draft, setDraft] = useState<VideoImageGenerationPrefs>(() =>
    applyVideoImageViewModeConstraints(value),
  );
  const [position, setPosition] = useState<React.CSSProperties>(() =>
    buildPopupPosition(null),
  );
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const normalizedValue = useMemo(
    () => applyVideoImageViewModeConstraints(value),
    [value],
  );
  const normalizedVideoPrefs = useMemo(
    () => normalizeVideoGenerationPrefs(videoPrefs),
    [videoPrefs],
  );
  const constrainedDraft = useMemo(
    () => applyVideoImageViewModeConstraints(draft),
    [draft],
  );
  const resolvedDraft = useMemo(
    () => resolveVideoImageGenerationPrefs(constrainedDraft),
    [constrainedDraft],
  );
  const imageAspectRatios = useMemo(() => listHomeAgentImageAspectRatios(), []);
  const videoAspectRatios = useMemo(() => listHomeAgentVideoAspectRatios(), []);
  const aspectRatios = useMemo(
    () => Array.from(new Set([...imageAspectRatios, ...videoAspectRatios])),
    [imageAspectRatios, videoAspectRatios],
  );
  const currentViewMode = constrainedDraft.viewMode ?? "three";
  const viewModeAspectRatios = useMemo(
    () => new Set(listHomeAgentImageAspectRatiosForViewMode(currentViewMode)),
    [currentViewMode],
  );
  const videoOnlyAspectRatios = useMemo(
    () => new Set(videoAspectRatios.filter((aspectRatio) => !imageAspectRatios.includes(aspectRatio as never))),
    [imageAspectRatios, videoAspectRatios],
  );
  const supportedAspectRatios = useMemo(
    () =>
      new Set(
        aspectRatios.filter((aspectRatio) =>
          videoModelSupportsAspectRatio(normalizedVideoPrefs.modelKey, aspectRatio) &&
          (viewModeAspectRatios.has(aspectRatio as never) || videoOnlyAspectRatios.has(aspectRatio as never)),
        ),
      ),
    [aspectRatios, normalizedVideoPrefs.modelKey, videoOnlyAspectRatios, viewModeAspectRatios],
  );
  const effectiveAspectRatio = useMemo(() => {
    const preferredVideoAspectRatio = normalizedVideoPrefs.aspectRatio;
    if (preferredVideoAspectRatio && supportedAspectRatios.has(preferredVideoAspectRatio as never)) {
      return preferredVideoAspectRatio;
    }
    if (supportedAspectRatios.has(constrainedDraft.aspectRatio as never)) {
      return constrainedDraft.aspectRatio;
    }
    return (
      aspectRatios.find((aspectRatio) => supportedAspectRatios.has(aspectRatio)) ??
      constrainedDraft.aspectRatio
    );
  }, [
    aspectRatios,
    constrainedDraft.aspectRatio,
    normalizedVideoPrefs.aspectRatio,
    supportedAspectRatios,
  ]);
  const summary = useMemo(
    () =>
      `${getVideoImageResolutionLabel(normalizedValue.resolution)} · ${normalizedValue.aspectRatio}`,
    [normalizedValue],
  );
  const effectiveSummary = useMemo(
    () => `${getVideoImageResolutionLabel(normalizedValue.resolution)} / ${effectiveAspectRatio}`,
    [effectiveAspectRatio, normalizedValue.resolution],
  );
  const triggerSummary = effectiveSummary || summary;
  const videoModeLabel = VIDEO_MODE_LABELS[normalizedVideoPrefs.mode];
  const currentVideoModelLabel = getHomeAgentVideoModelOption(normalizedVideoPrefs.modelKey).label;
  const styleLabel = buildStyleLabel(constrainedDraft);
  const viewModeLabel = VIEW_MODE_LABELS[currentViewMode];
  const imageOutputLabel = `${getVideoImageResolutionLabel(constrainedDraft.resolution)} / ${resolvedDraft.providerAspectRatio}`;
  const videoOutputLabel = getVideoGenerationResolutionLabel(normalizedVideoPrefs.resolution);
  const effectiveVideoOutputLabel = `${getVideoGenerationResolutionLabel(normalizedVideoPrefs.resolution)} / ${effectiveAspectRatio}`;
  const previewVideoOutputLabel = effectiveVideoOutputLabel || videoOutputLabel;

  const updatePosition = () => {
    setPosition(
      buildPopupPosition(
        shellRef.current?.getBoundingClientRect() ?? null,
        panelRef.current?.getBoundingClientRect().height ?? PANEL_HEIGHT,
      ),
    );
  };

  useLayoutEffect(() => {
    if (!open) return;

    setDraft(applyVideoImageViewModeConstraints(value));

    updatePosition();
    setPositionReady(true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, value]);

  useEffect(() => {
    if (!open) {
      setPositionReady(false);
    }
  }, [open]);

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
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setPositionReady(false);
          setOpen(true);
        }}
        className={cn(
          "inline-flex h-8 max-w-[min(30vw,144px)] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition sm:h-9",
          "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">{triggerSummary}</span>
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
              style={{
                ...position,
                visibility: positionReady ? "visible" : "hidden",
              }}
            >
              <div className="space-y-2.5">
                <div className="px-2.5 pb-0 pt-1 text-muted-foreground">
                  <div className="text-[10px] uppercase tracking-[0.2em]">参数概览</div>
                  <div className="mt-0.5 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                    图像高级参数
                  </div>
                </div>

                <section className="space-y-1.5 px-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">
                    画面比例
                  </div>
                  <div className="grid grid-cols-5 gap-1.5">
                    {aspectRatios.map((aspectRatio) => {
                      const selected = effectiveAspectRatio === aspectRatio;
                      const supported = supportedAspectRatios.has(aspectRatio);
                      return (
                        <button
                          key={aspectRatio}
                          type="button"
                          data-testid={`home-image-aspect-${aspectRatio.replace(":", "-")}`}
                          disabled={!supported}
                          onClick={() => {
                            if (!supported) return;
                            if (viewModeAspectRatios.has(aspectRatio as never)) {
                              const nextDraft = applyVideoImageViewModeConstraints({
                                ...constrainedDraft,
                                aspectRatio: aspectRatio as never,
                              });
                              setDraft(nextDraft);
                              onConfirm(nextDraft);
                            }
                            onConfirmVideoPrefs?.(
                              normalizeVideoGenerationPrefs({
                                ...normalizedVideoPrefs,
                                aspectRatio,
                              }),
                            );
                          }}
                          className={cn(
                            "rounded-[12px] border px-1 py-1.5 text-[11px] transition",
                            selected
                              ? "border-primary bg-primary/15 text-foreground"
                              : supported
                                ? "border-border bg-muted/30 text-foreground/80 hover:bg-muted/60"
                                : "cursor-not-allowed border-border/70 bg-muted/15 text-foreground/30",
                          )}
                        >
                          {aspectRatio}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-1.5 px-2.5">
                  <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">
                    视图模式
                  </div>
                  <div
                    data-testid="home-image-view-mode-toggle"
                    className="grid grid-cols-2 gap-1.5"
                  >
                    {(["three", "single"] as const).map((viewMode) => {
                      const selected = currentViewMode === viewMode;
                      return (
                        <button
                          key={viewMode}
                          type="button"
                          data-testid={`home-image-view-mode-${viewMode}`}
                          aria-pressed={selected}
                          onClick={() => {
                            const nextDraft = applyVideoImageViewModeConstraints({
                              ...constrainedDraft,
                              viewMode,
                            });
                            const nextViewModeAspectRatios = new Set(
                              listHomeAgentImageAspectRatiosForViewMode(viewMode),
                            );
                            const nextSupportedAspectRatios = new Set(
                              aspectRatios.filter((aspectRatio) =>
                                videoModelSupportsAspectRatio(normalizedVideoPrefs.modelKey, aspectRatio) &&
                                (nextViewModeAspectRatios.has(aspectRatio as never) ||
                                  videoOnlyAspectRatios.has(aspectRatio as never)),
                              ),
                            );
                            const nextAspectRatio =
                              normalizedVideoPrefs.aspectRatio &&
                              nextSupportedAspectRatios.has(normalizedVideoPrefs.aspectRatio as never)
                                ? normalizedVideoPrefs.aspectRatio
                                : nextSupportedAspectRatios.has(nextDraft.aspectRatio as never)
                                  ? nextDraft.aspectRatio
                                  : aspectRatios.find((aspectRatio) =>
                                      nextSupportedAspectRatios.has(aspectRatio),
                                    ) ?? nextDraft.aspectRatio;
                            const nextImageAspectRatio =
                              nextViewModeAspectRatios.has(nextAspectRatio as never)
                                ? nextAspectRatio
                                : aspectRatios.find((aspectRatio) =>
                                    nextViewModeAspectRatios.has(aspectRatio as never),
                                  ) ?? nextDraft.aspectRatio;
                            const nextResolvedDraft = applyVideoImageViewModeConstraints({
                              ...nextDraft,
                              aspectRatio: nextImageAspectRatio as never,
                            });
                            setDraft(nextResolvedDraft);
                            onConfirm(nextResolvedDraft);
                            onConfirmVideoPrefs?.(
                              normalizeVideoGenerationPrefs({
                                ...normalizedVideoPrefs,
                                aspectRatio: nextAspectRatio,
                              }),
                            );
                            onDevImageViewModeChange?.(nextResolvedDraft.viewMode ?? "three");
                          }}
                          className={cn(
                            "rounded-[12px] border px-2 py-2 text-[11px] transition",
                            selected
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border bg-muted/30 text-foreground/80 hover:bg-muted/60",
                          )}
                        >
                          {VIEW_MODE_LABELS[viewMode]}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="mx-1 rounded-[16px] border border-border/70 bg-muted/35 px-3 py-2">
                  <div className="text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">
                    当前参数
                  </div>
                  <div className="mt-1.5 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] leading-[1.45]">
                    <div className="text-foreground/80">视频模式</div>
                    <div
                      data-testid="home-image-preview-video-mode"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {videoModeLabel}
                    </div>

                    <div className="text-foreground/80">风格类型</div>
                    <div
                      data-testid="home-image-preview-style"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {styleLabel}
                    </div>

                    <div className="text-foreground/80">生图模型</div>
                    <div
                      data-testid="home-image-success-preview"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {resolvedDraft.family.label}
                    </div>

                    <div className="text-foreground/80">视频模型</div>
                    <div
                      data-testid="home-image-preview-video-model"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {currentVideoModelLabel}
                    </div>

                    <div className="text-foreground/80">生图输出</div>
                    <div
                      data-testid="home-image-output-preview"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {imageOutputLabel}
                    </div>

                    <div className="text-foreground/80">视图模式</div>
                    <div
                      data-testid="home-image-preview-view-mode"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {viewModeLabel}
                    </div>

                    <div className="text-foreground/80">视频输出</div>
                    <div
                      data-testid="home-image-preview-video-output"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {previewVideoOutputLabel}
                    </div>

                    <div className="text-foreground/80">生图提交</div>
                    <div
                      data-testid="home-image-transport-preview"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {resolvedDraft.transportModel}
                    </div>

                    <div className="text-foreground/80">视频提交</div>
                    <div
                      data-testid="home-image-preview-video-transport"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {resolveVideoGenerationModelName(normalizedVideoPrefs)}
                    </div>
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
