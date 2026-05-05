import "@testing-library/jest-dom/vitest";
import { Fragment, createElement, type ReactNode } from "react";
import { vi } from "vitest";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  writable: true,
  value: true,
});

const MOTION_PROPS = new Set([
  "animate",
  "exit",
  "initial",
  "layout",
  "layoutId",
  "transition",
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileInView",
  "viewport",
  "drag",
  "dragConstraints",
  "dragElastic",
  "dragMomentum",
]);

function createMotionTag(tag: string) {
  return ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => {
    const filteredProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_PROPS.has(key)),
    );
    return createElement(tag, filteredProps, children);
  };
}

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  LayoutGroup: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  motion: new Proxy(
    {},
    {
      get: (_target, key) => createMotionTag(typeof key === "string" ? key : "div"),
    },
  ),
  useReducedMotion: () => true,
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

Object.defineProperty(window, "requestAnimationFrame", {
  writable: true,
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
});

Object.defineProperty(window, "cancelAnimationFrame", {
  writable: true,
  value: (handle: number) => window.clearTimeout(handle),
});

Object.defineProperty(window, "requestIdleCallback", {
  writable: true,
  value: (callback: IdleRequestCallback) =>
    window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline), 0),
});

Object.defineProperty(window, "cancelIdleCallback", {
  writable: true,
  value: (handle: number) => window.clearTimeout(handle),
});

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `test-${Math.random().toString(36).slice(2)}`,
    },
  });
}
