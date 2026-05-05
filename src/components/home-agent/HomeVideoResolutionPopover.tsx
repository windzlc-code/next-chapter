import * as React from "react";
import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  buildVideoGenerationSummary,
  getHomeAgentVideoModelOption,
  listHomeAgentVideoResolutions,
  normalizeVideoGenerationPrefs,
  resolveVideoGenerationModelName,
} from "@/lib/home-agent/video-models";
import type { VideoGenerationPrefs } from "@/types/project";
import { cn } from "@/lib/utils";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

const { memo, useEffect, useMemo, useRef, useState } = React;

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 248;

function buildPopupPosition(anchorRect: DOMRect | null): React.CSSProperties {
  return buildToolbarPopoverPosition(anchorRect, {
    panelWidth: PANEL_WIDTH,
    panelHeight: PANEL_HEIGHT,
  });
}

export interface HomeVideoResolutionPopoverProps {
  activeTheme: boolean;
  value: VideoGenerationPrefs;
  onConfirm: (value: VideoGenerationPrefs) => void;
}

export const HomeVideoResolutionPopover = memo(function HomeVideoResolutionPopover({
  activeTheme,
  value,
  onConfirm,
}: HomeVideoResolutionPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VideoGenerationPrefs>(() =>
    normalizeVideoGenerationPrefs(value),
  );
  const [position, setPosition] = useState<React.CSSProperties>(() => buildPopupPosition(null));
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const summary = useMemo(() => buildVideoGenerationSummary(value), [value]);
  const resolutions = useMemo(() => listHomeAgentVideoResolutions(), []);
  const selectedModel = useMemo(
    () => getHomeAgentVideoModelOption(draft.modelKey),
    [draft.modelKey],
  );

  useEffect(() => {
    if (!open) return;

    setDraft(normalizeVideoGenerationPrefs(value));

    const updatePosition = () => {
      setPosition(buildPopupPosition(shellRef.current?.getBoundingClientRect() ?? null));
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
        data-testid="home-video-resolution-trigger"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex h-9 max-w-[min(30vw,128px)] items-center gap-2 rounded-full border px-3 text-[12px] transition sm:h-10",
          activeTheme
            ? "border-white/[0.08] bg-white/[0.05] text-white/80 hover:bg-white/[0.1] hover:text-white"
            : "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">{draft.resolution}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              data-testid="home-video-resolution-panel"
              className={cn(
                "fixed z-[75] w-[320px] overflow-hidden rounded-[24px] border p-4 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                activeTheme
                  ? "border-white/[0.08] bg-zinc-950/95 text-white"
                  : "border-border bg-card text-foreground",
              )}
              style={position}
            >
              <div className="space-y-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Resolution
                  </div>
                  <div className="mt-1 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                    视频分辨率
                  </div>
                  <div className="mt-1 text-[11.5px] leading-[1.6] text-muted-foreground">
                    分辨率与视频模型分离保存，后续扩展新模型时可以单独调整。
                  </div>
                </div>

                <section className="space-y-2">
                  <div className="text-[11px] font-medium text-foreground/80">输出分辨率</div>
                  <div className="grid grid-cols-1 gap-2">
                    {resolutions.map((resolution) => {
                      const selected = draft.resolution === resolution.value;
                      return (
                        <button
                          key={resolution.value}
                          type="button"
                          data-testid={`home-video-resolution-${resolution.value}`}
                          onClick={() => setDraft((current) => ({ ...current, resolution: resolution.value }))}
                          className={cn(
                            "rounded-2xl border px-3 py-2 text-left text-[12px] transition",
                            selected
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border bg-muted/30 text-foreground/80 hover:bg-muted/60",
                          )}
                        >
                          <div className="font-medium">{resolution.label}</div>
                          <div className={cn("mt-1 text-[10.5px] leading-[1.5]", selected ? "opacity-80" : "text-muted-foreground")}>
                            {resolution.description}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="rounded-[18px] border border-border bg-muted/40 px-3.5 py-3">
                  <div className="text-[11px] font-medium text-foreground/80">当前模型预览</div>
                  <div className="mt-2 space-y-1 text-[11.5px] leading-[1.6] text-muted-foreground">
                    <div data-testid="home-video-current-preview">当前组合：{summary}</div>
                    <div data-testid="home-video-model-preview">前端显示：{selectedModel.label}</div>
                    <div data-testid="home-video-transport-preview">提交模型：{resolveVideoGenerationModelName(draft)}</div>
                  </div>
                </section>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="home-video-resolution-cancel"
                    onClick={() => setOpen(false)}
                    className="rounded-full bg-muted/50 px-4 py-2 text-[12px] text-muted-foreground transition hover:bg-muted"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    data-testid="home-video-resolution-confirm"
                    onClick={() => {
                      onConfirm(normalizeVideoGenerationPrefs(draft));
                      setOpen(false);
                    }}
                    className="rounded-full bg-foreground px-4 py-2 text-[12px] text-background transition hover:bg-foreground/90"
                  >
                    确定
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
