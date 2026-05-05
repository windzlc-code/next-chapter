import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  getVideoGenerationResolutionLabel,
  listHomeAgentVideoResolutions,
  type HomeAgentVideoModelOption,
  videoModelSupportsResolution,
} from "@/lib/home-agent/video-models";
import type { VideoGenerationResolution } from "@/types/project";
import { cn } from "@/lib/utils";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

const { memo, useEffect, useMemo, useRef, useState } = React;

const PANEL_WIDTH = 288;
const PANEL_HEIGHT = 356;

function buildPopupPosition(anchorRect: DOMRect | null, panelHeight = PANEL_HEIGHT): React.CSSProperties {
  return buildToolbarPopoverPosition(anchorRect, {
    panelWidth: PANEL_WIDTH,
    panelHeight,
    align: "center",
  });
}

export interface HomeVideoModelPickerProps {
  activeTheme: boolean;
  selectedKey: string;
  selectedLabel: string;
  selectedResolution: VideoGenerationResolution;
  options: HomeAgentVideoModelOption[];
  onSelect: (key: HomeAgentVideoModelOption["key"]) => void;
  onSelectResolution: (resolution: VideoGenerationResolution) => void;
}

export const HomeVideoModelPicker = memo(function HomeVideoModelPicker({
  activeTheme,
  selectedKey,
  selectedLabel,
  selectedResolution,
  options = [],
  onSelect,
  onSelectResolution,
}: HomeVideoModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>(() => buildPopupPosition(null));
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = useMemo(
    () => options.find((option) => option.key === selectedKey) ?? options[0] ?? null,
    [options, selectedKey],
  );
  const resolutions = useMemo(() => listHomeAgentVideoResolutions(), []);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const measuredHeight = panelRef.current?.getBoundingClientRect().height ?? PANEL_HEIGHT;
      setPosition(buildPopupPosition(shellRef.current?.getBoundingClientRect() ?? null, measuredHeight));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
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
        data-testid="home-video-model-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex h-8 max-w-[min(34vw,168px)] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition sm:h-9",
          "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">
          {selectedOption?.label ?? selectedLabel} · {getVideoGenerationResolutionLabel(selectedResolution)}
        </span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              data-testid="home-video-model-picker-panel"
              className={cn(
                "fixed z-[74] w-[240px] overflow-hidden rounded-[24px] border p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                "border-border bg-card text-foreground",
              )}
              style={position}
            >
              <div className="px-2.5 pb-1.5 pt-1 text-muted-foreground">
                <div className="text-[10px] uppercase tracking-[0.2em]">Video</div>
                <div className="mt-1 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                  选择视频模型
                </div>
              </div>
              <div className="space-y-1">
                {options.map((option) => {
                  const selected = option.key === selectedKey;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      data-testid={`home-video-model-option-${option.key}`}
                      onClick={() => {
                        onSelect(option.key);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-[16px] px-3 py-2 text-left transition",
                        selected ? "bg-muted" : "hover:bg-muted/60",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium text-foreground">
                          {option.label}
                        </div>
                        <div className="mt-0.5 line-clamp-1 text-[10.5px] leading-[1.4] text-muted-foreground">
                          {option.description}
                        </div>
                      </div>
                      {selected ? (
                        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-3 w-3" />
                        </div>
                      ) : (
                        <div className="h-5 w-5 shrink-0 rounded-full border border-border" />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 border-t border-border/70 px-2 pb-1.5 pt-2">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-foreground/60">分辨率</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {resolutions.map((resolution) => {
                    const selected = selectedResolution === resolution.value;
                    const supported = videoModelSupportsResolution(selectedKey, resolution.value);
                    return (
                      <button
                        key={resolution.value}
                        type="button"
                        data-testid={`home-video-resolution-${resolution.value}`}
                        disabled={!supported}
                        title={supported ? resolution.description : resolution.disabledLabel}
                        onClick={() => {
                          if (!supported) return;
                          onSelectResolution(resolution.value);
                        }}
                        className={cn(
                          "rounded-[12px] border px-2 py-1.5 text-[11.5px] transition",
                          selected
                            ? "border-primary bg-primary/15 text-foreground"
                            : supported
                              ? "border-border bg-muted/30 text-foreground/80 hover:bg-muted/60"
                              : "cursor-not-allowed border-border/60 bg-muted/20 text-muted-foreground/45",
                        )}
                      >
                        <div className="font-medium">{resolution.label}</div>
                        {!supported ? (
                          <div className="mt-0.5 text-[9.5px] leading-[1.2] opacity-80">不可用</div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
