import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;

describe("character-audio-preset-library", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("formats preset audio option labels as index-duration without speaker or file names", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify([
          {
            category_group_path: "表演质感型/怒意爆发",
            category_title: "怒意爆发",
            duration_seconds: 5.48,
            folder: "20_怒意爆发_高张力喊话",
            row_idx: 1,
            saved_path: "E:\\presets\\01_The_Knave_voice.wav",
            speaker: "The Knave",
            transcription: "测试台词一",
          },
          {
            category_group_path: "表演质感型/怒意爆发",
            category_title: "怒意爆发",
            duration_seconds: 12,
            folder: "20_怒意爆发_高张力喊话",
            row_idx: 2,
            saved_path: "E:\\presets\\02_Clorinde_voice.wav",
            speaker: "Clorinde",
            transcription: "测试台词二",
          },
        ]),
    })) as typeof fetch;

    const {
      buildCharacterAudioPresetPickerQuestion,
      loadCharacterAudioPresetLibrary,
    } = await import("./character-audio-preset-library");

    const library = await loadCharacterAudioPresetLibrary();
    const question = buildCharacterAudioPresetPickerQuestion({
      characterId: "char-1",
      characterName: "陆沉",
      library,
      projectId: "project-1",
      stepIndex: 1,
      totalSteps: 4,
    });
    const entries = question.options[0]?.children?.[0]?.children || [];

    expect(entries.map((entry) => entry.label)).toEqual(["01-5.5秒", "02-12秒"]);
    expect(entries.map((entry) => entry.rationale)).toEqual([undefined, undefined]);
    expect(entries.map((entry) => entry.label).join(" ")).not.toContain("The Knave");
    expect(entries.map((entry) => entry.label).join(" ")).not.toContain("Clorinde");
    expect(entries[0]?.value).toContain("name=01_The_Knave_voice.wav");
  });
});
