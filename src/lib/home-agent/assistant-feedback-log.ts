const STORAGE_KEY = "storyforge-home-agent-assistant-feedback-v1";
const MAX_ENTRIES = 500;

export type AssistantFeedbackLogAction = "up" | "down" | "clear";

export type AssistantFeedbackLogEntry = {
  ts: string;
  messageId: string;
  action: AssistantFeedbackLogAction;
  contentPreview: string;
};

function readEntries(): AssistantFeedbackLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is AssistantFeedbackLogEntry =>
        Boolean(row) &&
        typeof row === "object" &&
        typeof (row as AssistantFeedbackLogEntry).ts === "string" &&
        typeof (row as AssistantFeedbackLogEntry).messageId === "string" &&
        ((row as AssistantFeedbackLogEntry).action === "up" ||
          (row as AssistantFeedbackLogEntry).action === "down" ||
          (row as AssistantFeedbackLogEntry).action === "clear"),
    );
  } catch {
    return [];
  }
}

/**
 * Append a feedback event for local training / analytics (localStorage, capped).
 * Safe to call from the UI layer on every toggle.
 */
export function recordAssistantFeedbackLog(
  entry: Omit<AssistantFeedbackLogEntry, "ts">,
): void {
  if (typeof window === "undefined") return;

  try {
    const next: AssistantFeedbackLogEntry = {
      ts: new Date().toISOString(),
      ...entry,
    };
    const merged = [...readEntries(), next].slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

    if (entry.action === "up" || entry.action === "down") {
      import("@/lib/home-agent/agent-learning-store")
        .then(({ recordUserPreference }) => recordUserPreference(entry))
        .catch(() => {
          // Learning store failures should not affect the main UI flow.
        });
    }
  } catch {
    // Ignore quota/privacy mode issues.
  }
}
