import type { AutomationMode } from "./types";

export const HOME_AGENT_AUTOMATION_MODE_EVENT = "storyforge:home-agent-automation-mode";

const AUTOMATION_MODE_KEY = "storyforge-home-agent-automation-mode-v1";
const AUTOMATION_MODES = new Set<AutomationMode>(["manual", "full-auto"]);

export function normalizeAutomationMode(value: unknown): AutomationMode {
  return value === "full-auto" ? "full-auto" : "manual";
}

export function readStoredAutomationMode(): AutomationMode {
  if (typeof window === "undefined") return "manual";
  try {
    return normalizeAutomationMode(localStorage.getItem(AUTOMATION_MODE_KEY));
  } catch {
    return "manual";
  }
}

export function writeStoredAutomationMode(mode: AutomationMode): AutomationMode {
  const normalized = normalizeAutomationMode(mode);
  if (typeof window === "undefined") return normalized;
  try {
    localStorage.setItem(AUTOMATION_MODE_KEY, normalized);
  } catch {
    // Keep the in-memory caller state even if persistence is unavailable.
  }
  window.dispatchEvent(
    new CustomEvent(HOME_AGENT_AUTOMATION_MODE_EVENT, { detail: { mode: normalized } }),
  );
  return normalized;
}

export function isAutomationMode(value: unknown): value is AutomationMode {
  return typeof value === "string" && AUTOMATION_MODES.has(value as AutomationMode);
}
