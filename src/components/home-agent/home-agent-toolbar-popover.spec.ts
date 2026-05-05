import { describe, expect, it } from "vitest";
import { buildToolbarPopoverPosition } from "./home-agent-toolbar-popover";

describe("buildToolbarPopoverPosition", () => {
  it("anchors the panel to the trigger's left edge by default", () => {
    window.innerWidth = 1280;
    window.innerHeight = 900;

    const position = buildToolbarPopoverPosition(
      {
        left: 320,
        right: 440,
        top: 760,
      } as DOMRect,
      {
        panelWidth: 288,
        panelHeight: 392,
      },
    );

    expect(position).toEqual({
      left: 320,
      top: 356,
    });
  });

  it("can center the panel over the trigger", () => {
    window.innerWidth = 1280;
    window.innerHeight = 900;

    const position = buildToolbarPopoverPosition(
      {
        left: 320,
        right: 440,
        width: 120,
        top: 760,
      } as DOMRect,
      {
        panelWidth: 288,
        panelHeight: 392,
        align: "center",
      },
    );

    expect(position).toEqual({
      left: 236,
      top: 356,
    });
  });

  it("clamps oversized panels back into the viewport", () => {
    window.innerWidth = 640;
    window.innerHeight = 520;

    const position = buildToolbarPopoverPosition(
      {
        left: 520,
        right: 620,
        top: 120,
      } as DOMRect,
      {
        panelWidth: 380,
        panelHeight: 640,
      },
    );

    expect(position).toEqual({
      left: 244,
      top: 16,
    });
  });

  it("supports right-edge anchoring when a secondary layout needs it", () => {
    window.innerWidth = 1280;
    window.innerHeight = 900;

    const position = buildToolbarPopoverPosition(
      {
        left: 320,
        right: 440,
        top: 760,
      } as DOMRect,
      {
        panelWidth: 320,
        panelHeight: 248,
        align: "end",
      },
    );

    expect(position).toEqual({
      left: 120,
      top: 500,
    });
  });
});
