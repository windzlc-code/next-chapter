import type { ComposerQuestion, ComposerQuestionOption } from "@/lib/home-agent/types";

const GENSHIN_PRESET_MANIFEST_ASSET_URL = new URL(
  "../../../genshin-cn-voice-presets-merged/manifest.json",
  import.meta.url,
).href;
const GENSHIN_PRESET_MANIFEST_FALLBACK_PATH =
  "E:\\Other\\work\\22\\next-chapter_0.4.3_007\\genshin-cn-voice-presets-merged\\manifest.json";

const PRESET_GROUP_ORDER = [
  "基础音色",
  "角色气质型",
  "角色状态型",
  "表演质感型",
] as const;

export const CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY =
  "video-bridge-preset-audio-panel";
export const CHARACTER_AUDIO_PRESET_PICKER_VALUE_PREFIX =
  "video:bridge:reference-audio:preset-picker:character:";
export const CHARACTER_AUDIO_PRESET_BIND_VALUE_PREFIX =
  "video:bridge:reference-audio:preset-bind:character:";

type RawPresetManifestEntry = {
  category_group_path?: string;
  category_title?: string;
  duration_seconds?: number;
  folder?: string;
  row_idx?: number;
  saved_path?: string;
  speaker?: string;
  transcription?: string;
};

export interface CharacterAudioPresetEntry {
  id: string;
  audioPath: string;
  categoryGroupPath: string;
  categoryLabel: string;
  durationSeconds: number;
  fileName: string;
  folder: string;
  label: string;
  rowIndex: number;
  speaker: string;
  transcription: string;
}

export interface CharacterAudioPresetCategory {
  id: string;
  groupKey: string;
  groupLabel: string;
  label: string;
  optionLabel: string;
  entries: CharacterAudioPresetEntry[];
}

export interface CharacterAudioPresetGroup {
  id: string;
  label: string;
  categories: CharacterAudioPresetCategory[];
}

export interface CharacterAudioPresetLibrary {
  groups: CharacterAudioPresetGroup[];
  totalEntryCount: number;
}

export interface CharacterAudioPresetBindSelection {
  audioPath: string;
  categoryLabel?: string;
  characterId: string;
  fileName?: string;
}

let cachedPresetLibrary: CharacterAudioPresetLibrary | null = null;
let presetLibraryPromise: Promise<CharacterAudioPresetLibrary> | null = null;

function extractFileName(filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/u);
  return parts[parts.length - 1] || normalized;
}

function trimPresetText(value: string | undefined): string {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function normalizeTranscript(value: string | undefined): string {
  return trimPresetText(value)
    .replace(/^#+/u, "")
    .replace(/\{[^}]+\}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function humanizeFolderLabel(folder: string, fallbackLabel: string): string {
  const normalizedFolder = trimPresetText(folder);
  if (!normalizedFolder) return fallbackLabel;
  return normalizedFolder
    .replace(/^\d+_/u, "")
    .replace(/_/gu, " · ");
}

function formatDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}秒`;
}

function parsePresetGroupOrder(label: string): number {
  const index = PRESET_GROUP_ORDER.indexOf(label as (typeof PRESET_GROUP_ORDER)[number]);
  return index >= 0 ? index : PRESET_GROUP_ORDER.length;
}

function buildCategoryOptionLabel(category: CharacterAudioPresetCategory): string {
  const groupSuffix = category.groupLabel ? `${category.groupLabel} · ` : "";
  return `${groupSuffix}${category.label}（${category.entries.length}）`;
}

function buildPresetEntryLabel(entry: CharacterAudioPresetEntry, index: number): string {
  const prefix = String(index + 1).padStart(2, "0");
  const duration = formatDurationLabel(entry.durationSeconds);
  return `${prefix}-${duration || "未知秒"}`;
}

async function readPresetManifestText(): Promise<string | null> {
  try {
    const response = await fetch(GENSHIN_PRESET_MANIFEST_ASSET_URL, {
      cache: "force-cache",
    });
    if (response.ok) {
      return await response.text();
    }
  } catch {
    // Fall through to the desktop filesystem fallback.
  }

  const reader = window.electronAPI?.storage?.readText;
  if (!reader) return null;

  try {
    const result = await reader(GENSHIN_PRESET_MANIFEST_FALLBACK_PATH);
    if (result?.ok && result.content) {
      return result.content;
    }
  } catch {
    // Ignore and let the caller handle the empty state.
  }

  return null;
}

function buildPresetLibrary(
  manifestEntries: RawPresetManifestEntry[],
): CharacterAudioPresetLibrary {
  const categories = new Map<string, CharacterAudioPresetCategory>();

  manifestEntries.forEach((entry, entryIndex) => {
    const audioPath = trimPresetText(entry.saved_path);
    if (!audioPath) return;

    const categoryGroupPath = trimPresetText(entry.category_group_path);
    const [groupKey = "未分类", ...groupRemainder] = categoryGroupPath.split("/").filter(Boolean);
    const groupLabel = groupRemainder.join(" / ");
    const categoryTitle = trimPresetText(entry.category_title) || "未命名分类";
    const folder = trimPresetText(entry.folder) || categoryTitle;
    const rowIndex =
      typeof entry.row_idx === "number" && Number.isFinite(entry.row_idx)
        ? entry.row_idx
        : entryIndex;
    const speaker = trimPresetText(entry.speaker) || "未命名音色";
    const transcription = normalizeTranscript(entry.transcription);
    const fileName = extractFileName(audioPath);
    const durationSeconds =
      typeof entry.duration_seconds === "number" && Number.isFinite(entry.duration_seconds)
        ? entry.duration_seconds
        : 0;
    const categoryLabel = humanizeFolderLabel(folder, categoryTitle);
    const categoryId = `${groupKey}::${folder}`;
    const presetEntry: CharacterAudioPresetEntry = {
      id: `genshin-preset-entry-${rowIndex}`,
      audioPath,
      categoryGroupPath,
      categoryLabel,
      durationSeconds,
      fileName,
      folder,
      label: buildPresetEntryLabel(
        {
          id: "",
          audioPath,
          categoryGroupPath,
          categoryLabel,
          durationSeconds,
          fileName,
          folder,
          label: "",
          rowIndex,
          speaker,
          transcription,
        },
        (categories.get(categoryId)?.entries.length ?? 0),
      ),
      rowIndex,
      speaker,
      transcription,
    };

    if (!categories.has(categoryId)) {
      categories.set(categoryId, {
        id: `genshin-preset-category-${categoryId}`,
        groupKey,
        groupLabel,
        label: categoryLabel,
        optionLabel: "",
        entries: [],
      });
    }

    categories.get(categoryId)!.entries.push(presetEntry);
  });

  const groups = new Map<string, CharacterAudioPresetGroup>();

  Array.from(categories.values())
    .sort((left, right) => {
      const groupOrderDiff =
        parsePresetGroupOrder(left.groupKey) - parsePresetGroupOrder(right.groupKey);
      if (groupOrderDiff !== 0) return groupOrderDiff;
      if (left.groupKey !== right.groupKey) return left.groupKey.localeCompare(right.groupKey, "zh-CN");
      return left.label.localeCompare(right.label, "zh-CN");
    })
    .forEach((category) => {
      category.entries.sort((left, right) => left.rowIndex - right.rowIndex);
      category.entries = category.entries.map((entry, index) => ({
        ...entry,
        label: buildPresetEntryLabel(entry, index),
      }));
      category.optionLabel = buildCategoryOptionLabel(category);

      const groupId = `genshin-preset-group-${category.groupKey}`;
      if (!groups.has(groupId)) {
        groups.set(groupId, {
          id: groupId,
          label: category.groupKey,
          categories: [],
        });
      }
      groups.get(groupId)!.categories.push(category);
    });

  return {
    groups: Array.from(groups.values()),
    totalEntryCount: Array.from(categories.values()).reduce(
      (total, category) => total + category.entries.length,
      0,
    ),
  };
}

export async function loadCharacterAudioPresetLibrary(): Promise<CharacterAudioPresetLibrary> {
  if (cachedPresetLibrary) return cachedPresetLibrary;
  if (presetLibraryPromise) return presetLibraryPromise;

  presetLibraryPromise = (async () => {
    const manifestText = await readPresetManifestText();
    if (!manifestText) {
      return { groups: [], totalEntryCount: 0 };
    }

    const parsed = JSON.parse(manifestText) as RawPresetManifestEntry[];
    return buildPresetLibrary(Array.isArray(parsed) ? parsed : []);
  })();

  try {
    cachedPresetLibrary = await presetLibraryPromise;
    return cachedPresetLibrary;
  } finally {
    presetLibraryPromise = null;
  }
}

export function buildCharacterAudioPresetPickerValue(characterId: string): string {
  return `${CHARACTER_AUDIO_PRESET_PICKER_VALUE_PREFIX}${encodeURIComponent(characterId)}`;
}

export function parseCharacterAudioPresetPickerValue(value: string): string | null {
  if (!value.startsWith(CHARACTER_AUDIO_PRESET_PICKER_VALUE_PREFIX)) return null;
  const encodedCharacterId = value.slice(CHARACTER_AUDIO_PRESET_PICKER_VALUE_PREFIX.length).trim();
  if (!encodedCharacterId) return null;
  try {
    return decodeURIComponent(encodedCharacterId);
  } catch {
    return encodedCharacterId;
  }
}

export function buildCharacterAudioPresetBindValue(
  selection: CharacterAudioPresetBindSelection,
): string {
  const params = new URLSearchParams();
  params.set("path", selection.audioPath);
  if (selection.fileName?.trim()) params.set("name", selection.fileName.trim());
  if (selection.categoryLabel?.trim()) params.set("category", selection.categoryLabel.trim());
  return `${CHARACTER_AUDIO_PRESET_BIND_VALUE_PREFIX}${encodeURIComponent(
    selection.characterId,
  )}?${params.toString()}`;
}

export function parseCharacterAudioPresetBindValue(
  value: string,
): CharacterAudioPresetBindSelection | null {
  if (!value.startsWith(CHARACTER_AUDIO_PRESET_BIND_VALUE_PREFIX)) return null;

  const remainder = value.slice(CHARACTER_AUDIO_PRESET_BIND_VALUE_PREFIX.length);
  const [encodedCharacterId, queryString = ""] = remainder.split("?", 2);
  if (!encodedCharacterId.trim()) return null;

  let characterId = encodedCharacterId.trim();
  try {
    characterId = decodeURIComponent(characterId);
  } catch {
    // Keep the original value if decodeURIComponent fails.
  }

  const searchParams = new URLSearchParams(queryString);
  const audioPath = trimPresetText(searchParams.get("path") || "");
  if (!audioPath) return null;

  return {
    audioPath,
    categoryLabel: trimPresetText(searchParams.get("category") || "") || undefined,
    characterId,
    fileName: trimPresetText(searchParams.get("name") || "") || undefined,
  };
}

function buildCharacterAudioPresetCategoryOptions(
  category: CharacterAudioPresetCategory,
  characterId: string,
): ComposerQuestionOption {
  return {
    id: category.id,
    label: category.optionLabel,
    value: `video:bridge:reference-audio:preset-category:${category.id}`,
    rationale: `${category.groupKey} · ${category.entries.length} 条候选音频`,
    children: category.entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      value: buildCharacterAudioPresetBindValue({
        audioPath: entry.audioPath,
        categoryLabel: `${category.groupKey} / ${category.label}`,
        characterId,
        fileName: entry.fileName,
      }),
      menuSection: "single",
    })),
  };
}

export function buildCharacterAudioPresetPickerQuestion(params: {
  characterId: string;
  characterName?: string;
  library: CharacterAudioPresetLibrary;
  projectId?: string | null;
  stepIndex?: number;
  totalSteps?: number;
}): ComposerQuestion {
  const {
    characterId,
    characterName,
    library,
    projectId,
    stepIndex = 0,
    totalSteps = 1,
  } = params;

  return {
    id: `${CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY}-${projectId || "project"}-${characterId}`,
    title: characterName?.trim()
      ? `为《${characterName.trim()}》选择预设参考音频`
      : "使用预设参考音频",
    description:
      "从当前预设库中选择 1 条音频绑定到角色。左上角可直接退出并回到原工作链路。",
    answerKey: CHARACTER_AUDIO_PRESET_PICKER_ANSWER_KEY,
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    preserveExactOnRestore: true,
    presentation: "card",
    stepIndex,
    totalSteps,
    options: library.groups.map((group) => ({
      id: group.id,
      label: `${group.label}（${group.categories.length} 类）`,
      value: `video:bridge:reference-audio:preset-group:${group.id}`,
      rationale: `${group.categories.reduce(
        (total, category) => total + category.entries.length,
        0,
      )} 条预设音频`,
      children: group.categories.map((category) =>
        buildCharacterAudioPresetCategoryOptions(category, characterId),
      ),
    })),
  };
}
