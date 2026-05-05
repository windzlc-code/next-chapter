import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { Scene } from "@/types/project";
import { getProjectRootPath } from "@/lib/file-cache";
import { normalizeLocalVideoPath } from "@/lib/home-agent/video-cache";
import { invokeFunction } from "@/lib/invoke-with-key";

export interface SegmentCompileResult {
  segmentLabel: string;
  outputPath: string;
  sceneCount: number;
  subtitleWarning?: string;
}

export interface SegmentCompileReport {
  compiled: SegmentCompileResult[];
  skipped: Array<{ segmentLabel: string; reason: string }>;
}

// xfade 支持的转场类型
const XFADE_TRANSITIONS = [
  "fade", "fadeblack", "fadewhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circlecrop", "rectcrop", "distance", "radial",
  "dissolve", "pixelize", "diagtl", "diagtr", "diagbl", "diagbr",
  "hlslice", "hrslice", "vuslice", "vdslice",
  "hblur", "fadegrays", "squeezev", "squeezeh",
  "zoomin", "hlwind", "hrwind", "vuwind", "vdwind",
  "coverleft", "coverright", "coverup", "coverdown",
  "revealleft", "revealright", "revealup", "revealdown",
] as const;

type XfadeTransition = typeof XFADE_TRANSITIONS[number];

interface TransitionDecision {
  type: XfadeTransition;
  duration: number;
  reason: string;
}

// AI 分析分镜情绪/节奏，决定每个转场类型
async function decideTransitions(
  scenes: Scene[],
  project: PersistedVideoProject,
): Promise<TransitionDecision[]> {
  if (scenes.length <= 1) return [];

  const shotSummaries = scenes.map((s, i) => ({
    index: i + 1,
    description: s.description?.trim() || s.sceneName,
    dialogue: s.dialogue?.trim() || "",
    cameraDirection: s.cameraDirection?.trim() || "",
    duration: s.recommendedDuration ?? s.duration ?? 5,
  }));

  const availableTransitions = [
    "fade（淡入淡出，通用）",
    "fadeblack（淡黑，场景切换）",
    "fadewhite（淡白，梦境/回忆）",
    "wipeleft/wiperight（横扫，动作/追逐）",
    "slideleft/slideright（滑动，时间推进）",
    "smoothleft/smoothright（平滑滑动，情感过渡）",
    "dissolve（溶解，时间流逝）",
    "zoomin（推进，强调/高潮）",
    "radial（放射，震撼/转折）",
    "pixelize（像素化，科技/特殊效果）",
    "circlecrop（圆形裁切，聚焦）",
    "hblur（水平模糊，快速切换）",
    "fadegrays（灰度淡出，回忆/闪回）",
  ].join("\n");

  const prompt = `你是专业影视剪辑师。根据以下分镜内容，为每个相邻分镜之间选择最合适的 ffmpeg xfade 转场效果。

## 分镜列表
${shotSummaries.map((s) => `分镜${s.index}（${s.duration}s）：${s.description}${s.dialogue ? `【台词：${s.dialogue}】` : ""}${s.cameraDirection ? `【镜头：${s.cameraDirection}】` : ""}`).join("\n")}

## 可用转场类型
${availableTransitions}

## 要求
- 共需要 ${scenes.length - 1} 个转场（分镜1→2, 2→3, ...）
- 转场时长建议 0.3~0.8 秒，情感强烈的场景可用 0.8~1.0 秒
- 根据情绪节奏、场景切换类型选择最合适的转场
- 输出严格 JSON 格式

## 输出格式
{"transitions":[{"type":"fade","duration":0.5,"reason":"简短理由"},...]}`;

  try {
    const { data, error } = await invokeFunction<{ transitions?: Array<{ type: string; duration: number; reason: string }> }>(
      "enhance-video-prompt",
      {
        mode: "transition-decision",
        _rawPrompt: prompt,
        artStyle: project.artStyle || "",
      },
    );

    if (error || !data?.transitions?.length) {
      return buildDefaultTransitions(scenes);
    }

    return data.transitions.slice(0, scenes.length - 1).map((t) => ({
      type: (XFADE_TRANSITIONS.includes(t.type as XfadeTransition) ? t.type : "fade") as XfadeTransition,
      duration: Math.min(Math.max(t.duration || 0.5, 0.3), 1.0),
      reason: t.reason || "",
    }));
  } catch {
    return buildDefaultTransitions(scenes);
  }
}

function buildDefaultTransitions(scenes: Scene[]): TransitionDecision[] {
  return scenes.slice(0, -1).map(() => ({
    type: "fade" as XfadeTransition,
    duration: 0.5,
    reason: "默认淡入淡出",
  }));
}

function resolveLocalPath(url: string): string {
  if (!url) return "";
  if (url.startsWith("file://")) return normalizeLocalVideoPath(url);
  return url;
}

function groupScenesBySegment(scenes: Scene[]): Map<string, Scene[]> {
  const map = new Map<string, Scene[]>();
  const sorted = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  for (const scene of sorted) {
    const key = scene.segmentLabel?.trim() || "__single__";
    const group = map.get(key) ?? [];
    group.push(scene);
    map.set(key, group);
  }
  return map;
}

// 把分镜台词 + 时长转成精确的字幕条目（不依赖语音识别）
function buildSubtitleEntriesFromScenes(
  scenes: Scene[],
  transitions: Array<{ duration: number }>,
): Array<{ startMs: number; endMs: number; text: string }> {
  const entries: Array<{ startMs: number; endMs: number; text: string }> = [];
  let cursorMs = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneDurSec = scene.recommendedDuration ?? scene.duration ?? 5;
    const sceneDurMs = Math.round(sceneDurSec * 1000);
    const transitionMs = i < transitions.length ? Math.round(transitions[i].duration * 1000) : 0;

    const dialogue = scene.dialogue?.trim();
    if (dialogue) {
      // 字幕显示在分镜时长的 10%~90% 区间，留出转场缓冲
      const paddingMs = Math.min(300, Math.round(sceneDurMs * 0.1));
      const startMs = cursorMs + paddingMs;
      const endMs = cursorMs + sceneDurMs - paddingMs - transitionMs;
      if (endMs > startMs + 200) {
        entries.push({ startMs, endMs: Math.max(startMs + 500, endMs), text: dialogue });
      }
    }

    // 下一分镜的起始时间 = 当前时间 + 时长 - 转场重叠
    cursorMs += sceneDurMs - transitionMs;
  }
  return entries;
}

export async function compileSegmentVideos(
  project: PersistedVideoProject,
  options: { addSubtitles: boolean },
): Promise<SegmentCompileReport> {
  if (!window.electronAPI?.ffmpeg) {
    throw new Error("ffmpeg API 不可用，请确认在 Electron 环境中运行。");
  }

  const projectRoot = await getProjectRootPath(project.id);
  if (!projectRoot) throw new Error("无法获取项目根目录。");

  const segmentsDir = `${projectRoot.replace(/[\\/]+$/, "")}\\segments`;
  const groups = groupScenesBySegment(project.scenes);
  const compiled: SegmentCompileResult[] = [];
  const skipped: Array<{ segmentLabel: string; reason: string }> = [];

  let idx = 0;
  for (const [segmentLabel, scenes] of groups) {
    idx += 1;
    const displayLabel = segmentLabel === "__single__" ? "全集" : segmentLabel;

    const hasFailure = scenes.some((s) => !s.videoUrl || s.videoStatus === "failed");
    if (hasFailure) {
      skipped.push({ segmentLabel: displayLabel, reason: "片段内存在未完成或失败的分镜，已跳过" });
      continue;
    }

    const inputPaths = scenes
      .map((s) => resolveLocalPath(s.videoUrl ?? ""))
      .filter(Boolean);

    if (inputPaths.length === 0) {
      skipped.push({ segmentLabel: displayLabel, reason: "没有可用的视频文件路径" });
      continue;
    }

    const safeLabel = segmentLabel.replace(/[^\w\-]/g, "_");
    const finalOutput = `${segmentsDir}\\segment-${safeLabel}.mp4`;

    // AI 决定转场
    const transitions = await decideTransitions(scenes, project);

    // 用分镜台词生成字幕条目（精确时间戳，不依赖 whisper 语音识别）
    const subtitleEntries = options.addSubtitles
      ? buildSubtitleEntriesFromScenes(scenes, transitions)
      : [];

    const result = await window.electronAPI.ffmpeg.smartConcat({
      inputPaths,
      outputPath: finalOutput,
      transitions,
      addSubtitles: options.addSubtitles,
      language: "zh",
    });

    if (!result.ok) {
      skipped.push({ segmentLabel: displayLabel, reason: result.error ?? "智能拼接失败" });
      continue;
    }

    compiled.push({
      segmentLabel: displayLabel,
      outputPath: result.outputPath ?? finalOutput,
      sceneCount: scenes.length,
    });
  }

  return { compiled, skipped };
}

export async function exportSegmentVideosToFolder(
  compiledResults: SegmentCompileResult[],
  destFolder: string,
): Promise<{ exportedCount: number; failedCount: number }> {
  let exportedCount = 0;
  let failedCount = 0;

  for (const result of compiledResults) {
    const fileName = `segment-${result.segmentLabel.replace(/[^\w\-]/g, "_")}.mp4`;
    const destPath = `${destFolder.replace(/[\\/]+$/, "")}\\${fileName}`;
    const copyResult = await window.electronAPI!.storage.copyFile(result.outputPath, destPath);
    if (copyResult.ok) {
      exportedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return { exportedCount, failedCount };
}
