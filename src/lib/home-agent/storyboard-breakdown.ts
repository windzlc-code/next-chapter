import type { CharacterSetting, Scene, SceneSetting } from "@/types/project";
import {
  getCharacterDisplayName,
  getSceneDisplayName,
  getSegmentCharacterDisplayNames,
  getSegmentSceneDisplayName,
} from "@/lib/workspace-labels";

export interface StoryboardBreakdownShot {
  index: number;
  content: string;
  links: number;
}

export interface StoryboardBreakdownClip {
  id: string;
  title?: string;
  duration: string;
  tags: string[];
  shots: StoryboardBreakdownShot[];
  footer_info?: string;
}

export interface StoryboardBreakdownEpisode {
  episode: string;
  summary: {
    clips_count: number;
    total_duration: string;
  };
  clips: StoryboardBreakdownClip[];
}

export interface StoryboardBreakdownRoot {
  summary: {
    total_episodes: number;
    total_clips: number;
    total_duration: string;
  };
  episodes: StoryboardBreakdownEpisode[];
}

const EPISODE_SEGMENT_RE = /^(\d+)-(\d+)$/;
const DEFAULT_SEGMENT_LABEL = "未分组";
const DEFAULT_FOOTER_INFO = "无字幕、无水印、无背景音";

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeSegmentLabel(scene: Scene): string {
  return scene.segmentLabel?.trim() || DEFAULT_SEGMENT_LABEL;
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds || 0));
  return `${safeSeconds}s`;
}

function buildShotContent(
  scene: Scene,
  characters: CharacterSetting[],
): string {
  const description = scene.description?.trim() || scene.sceneName?.trim() || `镜头 ${scene.sceneNumber}`;
  const namedCharacters = uniqueStrings(
    (scene.characters || []).map((characterName) =>
      getCharacterDisplayName(String(characterName || ""), scene, characters),
    ),
  );

  const parts = [description];
  if (scene.dialogue?.trim()) {
    parts.push(`对白：${scene.dialogue.trim()}`);
  }
  if (namedCharacters.length) {
    parts.push(`角色：${namedCharacters.map((name) => `[${name}]`).join(" ")}`);
  }
  if (scene.cameraDirection?.trim()) {
    parts.push(`镜头：${scene.cameraDirection.trim()}`);
  }

  return parts.join(" | ");
}

function buildClip(
  segmentLabel: string,
  scenes: Scene[],
  index: number,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
): StoryboardBreakdownClip {
  const durationSeconds = scenes.reduce(
    (sum, scene) => sum + (typeof scene.duration === "number" ? scene.duration : 0),
    0,
  );

  const sceneNames = uniqueStrings(
    [
      getSegmentSceneDisplayName(scenes, sceneSettings),
      ...scenes.map((scene) => getSceneDisplayName(scene, sceneSettings) || scene.sceneName),
    ],
  );
  const characterNames = uniqueStrings([
    ...getSegmentCharacterDisplayNames(scenes, characters),
    ...scenes.flatMap((scene) =>
      (scene.characters || []).map((characterName) =>
        getCharacterDisplayName(String(characterName || ""), scene, characters),
      ),
    ),
  ]);

  return {
    id: `segment-${segmentLabel}-${index + 1}`,
    title: `片段 ${segmentLabel}`,
    duration: formatDuration(durationSeconds),
    tags: uniqueStrings([...sceneNames, ...characterNames]),
    shots: scenes.map((scene, shotIndex) => ({
      index: shotIndex + 1,
      content: buildShotContent(scene, characters),
      links: 0,
    })),
    footer_info: DEFAULT_FOOTER_INFO,
  };
}

function buildEpisodeLabel(projectTitle: string, episodeNumber?: string): string {
  if (episodeNumber) {
    return `第 ${episodeNumber} 集`;
  }
  return `《${projectTitle || "未命名项目"}》拆镜结果`;
}

export function buildStoryboardBreakdownRoot(params: {
  title: string;
  scenes: Scene[];
  characters?: CharacterSetting[];
  sceneSettings?: SceneSetting[];
}): StoryboardBreakdownRoot | null {
  const {
    title,
    scenes,
    characters = [],
    sceneSettings = [],
  } = params;

  if (!scenes.length) return null;

  const segmentOrder: string[] = [];
  const segmentMap = new Map<string, Scene[]>();
  for (const scene of scenes) {
    const segmentLabel = normalizeSegmentLabel(scene);
    if (!segmentMap.has(segmentLabel)) {
      segmentOrder.push(segmentLabel);
      segmentMap.set(segmentLabel, []);
    }
    segmentMap.get(segmentLabel)?.push(scene);
  }

  const hasEpisodeSegments = segmentOrder.some((label) => EPISODE_SEGMENT_RE.test(label));
  const episodeOrder: string[] = [];
  const episodeClips = new Map<string, StoryboardBreakdownClip[]>();

  segmentOrder.forEach((segmentLabel, index) => {
    const groupedScenes = segmentMap.get(segmentLabel) || [];
    const clip = buildClip(segmentLabel, groupedScenes, index, characters, sceneSettings);
    const episodeNumber = hasEpisodeSegments
      ? segmentLabel.match(EPISODE_SEGMENT_RE)?.[1] || "1"
      : "__single__";

    if (!episodeClips.has(episodeNumber)) {
      episodeOrder.push(episodeNumber);
      episodeClips.set(episodeNumber, []);
    }
    episodeClips.get(episodeNumber)?.push(clip);
  });

  const episodes = episodeOrder.map((episodeNumber) => {
    const clips = episodeClips.get(episodeNumber) || [];
    const totalDurationSeconds = clips.reduce((sum, clip) => {
      const seconds = Number.parseInt(clip.duration.replace(/s$/i, ""), 10);
      return sum + (Number.isFinite(seconds) ? seconds : 0);
    }, 0);

    return {
      episode: buildEpisodeLabel(title, episodeNumber === "__single__" ? undefined : episodeNumber),
      summary: {
        clips_count: clips.length,
        total_duration: formatDuration(totalDurationSeconds),
      },
      clips,
    };
  });

  const totalDurationSeconds = scenes.reduce(
    (sum, scene) => sum + (typeof scene.duration === "number" ? scene.duration : 0),
    0,
  );

  return {
    summary: {
      total_episodes: episodes.length,
      total_clips: segmentOrder.length,
      total_duration: formatDuration(totalDurationSeconds),
    },
    episodes,
  };
}

export function buildStoryboardBreakdownMessage(params: {
  title: string;
  scenes: Scene[];
  characters?: CharacterSetting[];
  sceneSettings?: SceneSetting[];
}): string {
  const root = buildStoryboardBreakdownRoot(params);
  if (!root) return "";

  return [
    "以下按导出拆镜 xlsx 的分段结构展示：",
    "",
    "```json",
    JSON.stringify(root),
    "```",
  ].join("\n");
}
