import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOME_AGENT_AUTOMATION_MODE_EVENT,
  normalizeAutomationMode,
  readStoredAutomationMode,
  writeStoredAutomationMode,
} from "./automation-mode";

describe("automation-mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes unknown values to manual mode", () => {
    expect(normalizeAutomationMode("full-auto")).toBe("full-auto");
    expect(normalizeAutomationMode("manual")).toBe("manual");
    expect(normalizeAutomationMode("unknown")).toBe("manual");
    expect(normalizeAutomationMode(null)).toBe("manual");
  });

  it("persists the current automation mode and emits an update event", () => {
    const listener = vi.fn();
    window.addEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, listener);

    writeStoredAutomationMode("full-auto");

    expect(readStoredAutomationMode()).toBe("full-auto");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { mode: "full-auto" },
      }),
    );

    window.removeEventListener(HOME_AGENT_AUTOMATION_MODE_EVENT, listener);
  });

  it("falls back to manual mode for corrupted stored settings", () => {
    localStorage.setItem("storyforge-home-agent-automation-mode-v1", "broken");

    expect(readStoredAutomationMode()).toBe("manual");
  });
});
