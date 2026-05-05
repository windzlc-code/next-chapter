import type * as React from "react";

export const TOOLBAR_POPOVER_VIEWPORT_MARGIN = 16;
export const TOOLBAR_POPOVER_GAP = 12;

type ToolbarPopoverAlign = "start" | "center" | "end";

interface ToolbarPopoverPositionOptions {
  panelWidth: number;
  panelHeight: number;
  align?: ToolbarPopoverAlign;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function buildToolbarPopoverPosition(
  anchorRect: DOMRect | null,
  {
    panelWidth,
    panelHeight,
    align = "start",
  }: ToolbarPopoverPositionOptions,
): React.CSSProperties {
  if (!anchorRect || typeof window === "undefined") {
    return {
      left: TOOLBAR_POPOVER_VIEWPORT_MARGIN,
      bottom: TOOLBAR_POPOVER_VIEWPORT_MARGIN,
    };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft =
    align === "end"
      ? anchorRect.right - panelWidth
      : align === "center"
        ? anchorRect.left + anchorRect.width / 2 - panelWidth / 2
        : anchorRect.left;
  const left = clamp(
    preferredLeft,
    TOOLBAR_POPOVER_VIEWPORT_MARGIN,
    Math.max(
      TOOLBAR_POPOVER_VIEWPORT_MARGIN,
      viewportWidth - panelWidth - TOOLBAR_POPOVER_VIEWPORT_MARGIN,
    ),
  );
  const top = clamp(
    anchorRect.top - panelHeight - TOOLBAR_POPOVER_GAP,
    TOOLBAR_POPOVER_VIEWPORT_MARGIN,
    Math.max(
      TOOLBAR_POPOVER_VIEWPORT_MARGIN,
      viewportHeight - panelHeight - TOOLBAR_POPOVER_VIEWPORT_MARGIN,
    ),
  );

  return { left, top };
}
