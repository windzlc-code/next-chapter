const HISTORY_SETTINGS_KEY = "storyforge-history-settings-v1";

export interface HistorySettings {
  /** 最多保留的历史项目数量，默认 20 */
  maxCount: number;
  /** 超出数量时是否自动按时间顺序删除最旧的项目，默认 true */
  autoDelete: boolean;
}

const DEFAULT_HISTORY_SETTINGS: HistorySettings = {
  maxCount: 50,
  autoDelete: true,
};

export function getHistorySettings(): HistorySettings {
  try {
    const saved = localStorage.getItem(HISTORY_SETTINGS_KEY);
    if (!saved) return { ...DEFAULT_HISTORY_SETTINGS };
    const parsed = JSON.parse(saved) as Partial<HistorySettings>;
    return {
      maxCount:
        typeof parsed.maxCount === "number" && parsed.maxCount >= 5 && parsed.maxCount <= 200
          ? parsed.maxCount
          : DEFAULT_HISTORY_SETTINGS.maxCount,
      autoDelete:
        typeof parsed.autoDelete === "boolean" ? parsed.autoDelete : DEFAULT_HISTORY_SETTINGS.autoDelete,
    };
  } catch {
    return { ...DEFAULT_HISTORY_SETTINGS };
  }
}

export function saveHistorySettings(settings: Partial<HistorySettings>): void {
  const current = getHistorySettings();
  localStorage.setItem(HISTORY_SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
}
