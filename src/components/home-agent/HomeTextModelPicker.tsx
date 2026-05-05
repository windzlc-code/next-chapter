import * as React from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import type { HomeAgentTextModelGroup } from "@/lib/home-agent/text-models";
import { cn } from "@/lib/utils";

const { memo, useEffect, useMemo, useRef, useState } = React;

type PopupPosition = {
  provider: React.CSSProperties;
  models: React.CSSProperties;
};

const POPUP_GAP = 12;
const PROVIDER_PANEL_WIDTH = 224;
const MODEL_PANEL_WIDTH = 282;
const VIEWPORT_MARGIN = 16;

export interface HomeTextModelPickerProps {
  activeTheme: boolean;
  selectedKey: string;
  selectedLabel: string;
  groups: HomeAgentTextModelGroup[];
  onSelect: (key: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildPopupPosition(anchorRect: DOMRect | null): PopupPosition {
  if (!anchorRect || typeof window === "undefined") {
    return {
    provider: { left: VIEWPORT_MARGIN, bottom: VIEWPORT_MARGIN },
    models: { left: VIEWPORT_MARGIN + PROVIDER_PANEL_WIDTH + 6, bottom: VIEWPORT_MARGIN },
    };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const providerLeft = clamp(
    anchorRect.left,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth - PROVIDER_PANEL_WIDTH - VIEWPORT_MARGIN),
  );
  const providerTop = clamp(
    anchorRect.top - POPUP_GAP - 260,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportHeight - 260 - VIEWPORT_MARGIN),
  );

  let modelsLeft = providerLeft + PROVIDER_PANEL_WIDTH + 6;
  if (modelsLeft + MODEL_PANEL_WIDTH + VIEWPORT_MARGIN > viewportWidth) {
    modelsLeft = providerLeft - MODEL_PANEL_WIDTH - 6;
  }
  modelsLeft = clamp(
    modelsLeft,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth - MODEL_PANEL_WIDTH - VIEWPORT_MARGIN),
  );

  const modelsTop = clamp(
    providerTop,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportHeight - 252 - VIEWPORT_MARGIN),
  );

  return {
    provider: {
      left: providerLeft,
      top: providerTop,
    },
    models: {
      left: modelsLeft,
      top: modelsTop,
    },
  };
}

export const HomeTextModelPicker = memo(function HomeTextModelPicker({
  activeTheme,
  selectedKey,
  selectedLabel,
  groups,
  onSelect,
}: HomeTextModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<HomeAgentTextModelGroup["provider"] | null>(null);
  const [positions, setPositions] = useState<PopupPosition>(() => buildPopupPosition(null));
  const shellRef = useRef<HTMLDivElement | null>(null);
  const providerPanelRef = useRef<HTMLDivElement | null>(null);
  const modelsPanelRef = useRef<HTMLDivElement | null>(null);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.options.some((option) => option.key === selectedKey)) ?? groups[0] ?? null,
    [groups, selectedKey],
  );
  const activeGroup = useMemo(
    () => groups.find((group) => group.provider === activeProvider) ?? selectedGroup,
    [activeProvider, groups, selectedGroup],
  );

  const selectedSummary = useMemo(() => {
    if (!selectedGroup) return selectedLabel;
    const option = selectedGroup.options.find((item) => item.key === selectedKey);
    return option ? `${selectedGroup.supplierLabel} / ${option.shortLabel}` : selectedLabel;
  }, [selectedGroup, selectedKey, selectedLabel]);

  useEffect(() => {
    if (!open || !selectedGroup) return;
    setActiveProvider((current) => current ?? selectedGroup.provider);
  }, [open, selectedGroup]);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const anchorRect = shellRef.current?.getBoundingClientRect() ?? null;
      setPositions(buildPopupPosition(anchorRect));
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
      if (
        shellRef.current?.contains(target) ||
        providerPanelRef.current?.contains(target) ||
        modelsPanelRef.current?.contains(target)
      ) {
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
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex h-8 max-w-[min(40vw,196px)] items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition sm:h-9",
          "border-border bg-muted/50 text-foreground hover:bg-muted",
        )}
      >
        <span className="truncate">{selectedSummary}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                ref={providerPanelRef}
                className={cn(
                  "fixed z-[70] w-[224px] overflow-hidden rounded-[24px] border p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                  "border-border bg-card text-foreground",
                )}
                style={positions.provider}
              >
                <div className="px-2.5 pb-1.5 pt-1 text-muted-foreground">
                  <div className="text-[10px] uppercase tracking-[0.2em]">供应商</div>
                  <div className="mt-1 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                    选择模型系列
                  </div>
                </div>
                <div className="space-y-1">
                  {groups.map((group) => {
                    const selected = group.provider === activeGroup?.provider;
                    const currentOption = group.options.find((option) => option.key === selectedKey) ?? group.options[0];
                    return (
                      <button
                        key={group.provider}
                        type="button"
                        aria-label={`${group.supplierLabel} / ${group.familyLabel}`}
                        onMouseEnter={() => setActiveProvider(group.provider)}
                        onFocus={() => setActiveProvider(group.provider)}
                        onClick={() => setActiveProvider(group.provider)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-[16px] px-3 py-2.5 text-left transition",
                          selected ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        <div className="min-w-0">
                          <div className="text-[13.5px] font-medium text-foreground">
                            {group.familyLabel}
                          </div>
                          <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                            {group.supplierLabel}
                            {currentOption ? ` / ${currentOption.shortLabel}` : ""}
                          </div>
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                      </button>
                    );
                  })}
                </div>
              </div>

              {activeGroup ? (
                <div
                  ref={modelsPanelRef}
                  className={cn(
                    "fixed z-[71] w-[282px] overflow-hidden rounded-[24px] border p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md",
                    "border-border bg-card text-foreground",
                  )}
                  style={positions.models}
                >
                  <div className="px-2.5 pb-1.5 pt-1 text-muted-foreground">
                    <div className="text-[10px] uppercase tracking-[0.2em]">{activeGroup.supplierLabel}</div>
                    <div className="mt-1 text-[17px] font-medium tracking-[-0.04em] text-foreground">
                      {activeGroup.familyLabel}
                    </div>
                  </div>
                  <div className="scrollbar-none max-h-[248px] space-y-1 overflow-y-auto">
                    {activeGroup.options.map((option) => {
                      const selected = option.key === selectedKey;
                      return (
                        <button
                          key={option.key}
                          type="button"
                          aria-label={option.shortLabel}
                          onClick={() => {
                            onSelect(option.key);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-[16px] px-3 py-2 text-left transition",
                            selected ? "bg-muted" : "hover:bg-muted/60",
                          )}
                        >
                          <div className="min-w-0">
                            <div className="text-[14px] font-medium leading-5 text-foreground">
                              {option.shortLabel}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
                              {option.description}
                            </div>
                          </div>
                          <div className="pt-1">
                            {selected ? (
                              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-3.5 w-3.5" />
                              </div>
                            ) : (
                              <div className="h-6 w-6 rounded-full border border-border" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>,
            document.body,
          )
        : null}
    </div>
  );
});
