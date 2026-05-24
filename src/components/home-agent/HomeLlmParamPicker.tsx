import * as React from "react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { createPortal } from "react-dom";
import { LLM_PARAM_PRESETS, type LlmParamPreset } from "@/lib/home-agent/llm-params";
import { cn } from "@/lib/utils";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

const { memo, useEffect, useLayoutEffect, useRef, useState } = React;

const PANEL_WIDTH = 260;
const PANEL_HEIGHT = LLM_PARAM_PRESETS.length * 72 + 80;

function buildPopupPosition(anchorRect: DOMRect | null): React.CSSProperties {
  return buildToolbarPopoverPosition(anchorRect, {
    panelWidth: PANEL_WIDTH,
    panelHeight: PANEL_HEIGHT,
  });
}

export interface HomeLlmParamPickerProps {
  activeTheme: boolean;
  selectedKey: string;
  onSelect: (key: string) => void;
}

export const HomeLlmParamPicker = memo(function HomeLlmParamPicker({
  activeTheme,
  selectedKey,
  onSelect,
}: HomeLlmParamPickerProps) {
  const [open, setOpen] = useState(false);
  const [positionReady, setPositionReady] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>(() => buildPopupPosition(null));
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const selectedPreset: LlmParamPreset =
    LLM_PARAM_PRESETS.find((p) => p.key === selectedKey) ?? LLM_PARAM_PRESETS[1];

  const updatePosition = () => {
    const anchorRect = shellRef.current?.getBoundingClientRect() ?? null;
    setPosition(buildPopupPosition(anchorRect));
  };

  useLayoutEffect(() => {
    if (!open) return;

    updatePosition();
    setPositionReady(true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setPositionReady(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (shellRef.current?.contains(target) || panelRef.current?.contains(target)) return;
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
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setPositionReady(false);
          setOpen(true);
        }}
        title={`LLM 参数：${selectedPreset.label}（temperature ${selectedPreset.temperature}，最大 ${selectedPreset.maxOutputTokens} tokens）`}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition sm:h-10",
          "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <SlidersHorizontal className="h-3 w-3 shrink-0 opacity-60" />
        <span className="hidden sm:inline">{selectedPreset.label}</span>
        <span className="hidden sm:inline text-[10px] opacity-50">{selectedPreset.valueSummary}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform opacity-50", open && "rotate-180")} />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="LLM 参数预设"
              className={cn(
                "fixed z-[70] overflow-hidden rounded-[20px] border p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                "border-border bg-card text-foreground",
              )}
              style={{
                ...position,
                width: PANEL_WIDTH,
                visibility: positionReady ? "visible" : "hidden",
              }}
            >
              <div className="px-2.5 pb-1 pt-1">
                <div className="text-[9.5px] uppercase tracking-[0.2em] text-muted-foreground">LLM 参数</div>
                <div className="text-[13px] font-medium tracking-[-0.03em] text-foreground">
                  创作风格预设
                </div>
              </div>

              {/* 参数列头 */}
              <div className="mb-0.5 flex items-center gap-2 px-2.5 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                <span className="flex-1">预设</span>
                <span className="w-[2.4rem] text-right">温度</span>
                <span className="w-[2.4rem] text-right">Token</span>
              </div>

              <div className="space-y-px">
                {LLM_PARAM_PRESETS.map((preset) => {
                  const selected = preset.key === selectedKey;
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      onClick={() => {
                        onSelect(preset.key);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[12px] px-2.5 py-1.5 text-left transition",
                        selected ? "bg-muted" : "hover:bg-muted/60",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="text-[12px] font-medium text-foreground">{preset.label}</span>
                          {preset.badge ? (
                            <span className="rounded-full bg-primary/10 px-1 py-px text-[8.5px] font-medium text-primary">
                              {preset.badge}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[10px] leading-[1.35] text-muted-foreground">
                          {preset.description}
                        </div>
                      </div>
                      {/* 具体数值 */}
                      <span className="w-[2.4rem] shrink-0 text-right text-[10.5px] font-mono text-muted-foreground">
                        {preset.temperature.toFixed(1)}
                      </span>
                      <span className="w-[2.4rem] shrink-0 text-right text-[10.5px] font-mono text-muted-foreground">
                        {preset.maxOutputTokens >= 1000
                          ? `${(preset.maxOutputTokens / 1024).toFixed(0)}K`
                          : preset.maxOutputTokens}
                      </span>
                      <div className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                        {selected ? (
                          <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-2.5 w-2.5" />
                          </div>
                        ) : (
                          <div className="h-4 w-4 rounded-full border border-border" />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
