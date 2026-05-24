const HISTORY_SETTINGS_KEY = "storyforge-history-settings-v1";

export const MIN_HISTORY_PROJECT_COUNT = 5;
export const MAX_HISTORY_PROJECT_COUNT = 2000;
export const DEFAULT_HISTORY_PROJECT_RETENTION_COUNT = 25;

export interface HistorySettings {
  /** 最多保留/显示的历史项目数量。 */
  maxCount: number;
  /** 超出数量时是否自动按时间顺序删除最旧的项目。 */
  autoDelete: boolean;
}

const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  maxCount: DEFAULT_HISTORY_PROJECT_RETENTION_COUNT,
  autoDelete: true,
};

function normalizeMaxCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_HISTORY_SETTINGS.maxCount;
  }
  return Math.min(
    MAX_HISTORY_PROJECT_COUNT,
    Math.max(MIN_HISTORY_PROJECT_COUNT, Math.trunc(value)),
  );
}

export function getHistorySettings(): HistorySettings {
  try {
    const saved = localStorage.getItem(HISTORY_SETTINGS_KEY);
    if (!saved) return { ...DEFAULT_HISTORY_SETTINGS };
    const parsed = JSON.parse(saved) as Partial<HistorySettings>;
    const maxCount = normalizeMaxCount(parsed.maxCount);
    const isPreviousDisplayDefault =
      maxCount === MAX_HISTORY_PROJECT_COUNT && parsed.autoDelete === false;

    return {
      maxCount: isPreviousDisplayDefault ? DEFAULT_HISTORY_SETTINGS.maxCount : maxCount,
      autoDelete: isPreviousDisplayDefault
        ? DEFAULT_HISTORY_SETTINGS.autoDelete
        : typeof parsed.autoDelete === "boolean"
          ? parsed.autoDelete
          : DEFAULT_HISTORY_SETTINGS.autoDelete,
    };
  } catch {
    return { ...DEFAULT_HISTORY_SETTINGS };
  }
}

export function saveHistorySettings(settings: Partial<HistorySettings>): void {
  const current = getHistorySettings();
  const next = { ...current, ...settings };
  localStorage.setItem(
    HISTORY_SETTINGS_KEY,
    JSON.stringify({
      ...next,
      maxCount: normalizeMaxCount(next.maxCount),
    }),
  );
}
