import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_PROJECT_RETENTION_COUNT,
  getHistorySettings,
  saveHistorySettings,
} from "./history-settings";

const HISTORY_SETTINGS_KEY = "storyforge-history-settings-v1";

describe("history-settings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to automatic deletion with 25 retained projects", () => {
    expect(getHistorySettings()).toEqual({
      autoDelete: true,
      maxCount: DEFAULT_HISTORY_PROJECT_RETENTION_COUNT,
    });
  });

  it("migrates the previous 2000-item display default back to retention defaults", () => {
    localStorage.setItem(
      HISTORY_SETTINGS_KEY,
      JSON.stringify({
        autoDelete: false,
        maxCount: 2000,
      }),
    );

    expect(getHistorySettings()).toEqual({
      autoDelete: true,
      maxCount: DEFAULT_HISTORY_PROJECT_RETENTION_COUNT,
    });
  });

  it("still clamps explicitly saved retention values to supported bounds", () => {
    saveHistorySettings({ autoDelete: true, maxCount: 3 });
    expect(getHistorySettings()).toEqual({
      autoDelete: true,
      maxCount: 5,
    });
  });
});
