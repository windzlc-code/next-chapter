import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { Scene } from "@/types/project";

function trimSentenceEnding(text: string): string {
  return String(text || "").trim().replace(/[。！？；，、\s]+$/u, "");
}

function ensureSentence(text: string): string {
  const normalized = trimSentenceEnding(text);
  return normalized ? `${normalized}。` : "";
}

function sentenceCount(text: string): number {
  return String(text || "")
    .split(/(?<=[。！？；])/u)
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function fitToNaturalBoundary(text: string, maxChars: number): string {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;

  const candidate = normalized.slice(0, maxChars);
  const breakpoints = [
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("！"),
    candidate.lastIndexOf("？"),
    candidate.lastIndexOf("；"),
    candidate.lastIndexOf("，"),
    candidate.lastIndexOf("、"),
  ].filter((index) => index >= 0);

  const cutIndex =
    breakpoints.length && Math.max(...breakpoints) >= Math.floor(maxChars * 0.55)
      ? Math.max(...breakpoints) + 1
      : maxChars;

  return `${trimSentenceEnding(candidate.slice(0, cutIndex))}…`;
}

function collapseWhitespace(text: string): string {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

export function formatSegmentContinuityRecapDisplayText(text: string | null | undefined): string {
  const normalized = collapseWhitespace(String(text || ""))
    .replace(/^前情提要[：:\s]*/u, "")
    .trim();
  return normalized ? `前情提要：${normalized}` : "";
}

function stripLeadingRecapScaffolding(text: string): string {
  return collapseWhitespace(String(text || ""))
    .replace(/[“”"'`]/gu, "")
    .replace(/^(前情提要|本段剧情|这一段剧情|片段剧情|剧情概括)[：:\s]*/u, "")
    .replace(/^片段\s*\S+\s*/u, "")
    .replace(/^(结尾钩子|通用后缀|环境细节|视觉锚点|起始衔接|衔接原则)[：:\s]*/u, "")
    .trim();
}

function cleanNarrativeSentence(text: string, maxChars: number): string {
  const normalized = trimSentenceEnding(stripLeadingRecapScaffolding(text));
  if (!normalized) return "";
  return fitToNaturalBoundary(normalized, maxChars).replace(/…$/u, "");
}

function normalizeNarrativeKey(text: string): string {
  return trimSentenceEnding(stripLeadingRecapScaffolding(text))
    .replace(/[\[\]()（）【】]/gu, "")
    .replace(/[，。！？；、\s]/gu, "")
    .toLowerCase();
}

function uniqueNarrativeBeats(items: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    const normalized = String(item || "").trim();
    if (!normalized) continue;
    const key = normalizeNarrativeKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

function extractSegmentEndHookText(prompt: string | null | undefined): string {
  const normalized = String(prompt || "").trim();
  if (!normalized) return "";
  const line = normalized
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => /^(结尾钩子)[：:]/u.test(entry));
  if (!line) return "";
  return line.replace(/^(结尾钩子)[：:]\s*/u, "").trim();
}

function getScenesForSegment(project: PersistedVideoProject, segmentLabel: string): Scene[] {
  return project.scenes
    .filter((scene) => String(scene.segmentLabel || "").trim() === segmentLabel)
    .sort((left, right) => left.sceneNumber - right.sceneNumber);
}

function buildOpeningSentence(scenes: Scene[]): string {
  const openingSource = scenes
    .map((scene) => cleanNarrativeSentence(scene.description || scene.sceneName || "", 56))
    .find(Boolean);
  return ensureSentence(openingSource || "");
}

function buildDevelopmentSentence(scenes: Scene[], openingKey: string): string {
  const middleScenes = scenes.slice(1, -1);
  const fallbackScenes = middleScenes.length ? middleScenes : scenes.slice(1, 3);
  const candidateScenes =
    middleScenes.length >= 2
      ? [middleScenes[0], middleScenes.at(-1)].filter((scene): scene is Scene => Boolean(scene))
      : fallbackScenes;
  const perBeatMaxChars = candidateScenes.length <= 1 ? 92 : 44;
  const beats = uniqueNarrativeBeats(
    candidateScenes
      .map((scene) => cleanNarrativeSentence(scene.description || scene.sceneName || "", perBeatMaxChars))
      .filter((beat) => normalizeNarrativeKey(beat) !== openingKey),
  ).slice(0, 2);

  if (!beats.length) {
    return "随着局势继续收紧，人物动作、情绪压力与危险气息被一步步推高。";
  }

  const [firstBeat, secondBeat] = beats;
  const merged = secondBeat
    ? `${trimSentenceEnding(firstBeat)}，${trimSentenceEnding(secondBeat)}`
    : trimSentenceEnding(firstBeat);
  return `随着${merged.replace(/^随着/u, "")}。`;
}

function buildEndingSentence(
  project: PersistedVideoProject,
  segmentLabel: string,
  scenes: Scene[],
  excludedKeys: Set<string>,
): string {
  const promptEndHook = cleanNarrativeSentence(
    extractSegmentEndHookText(project.segmentVideoPrompts?.[segmentLabel]?.prompt),
    54,
  );
  const lastScene = cleanNarrativeSentence(
    scenes.at(-1)?.description?.trim() || scenes.at(-1)?.sceneName?.trim() || "",
    54,
  );

  const endingSource = [promptEndHook, lastScene].find((candidate) => {
    const key = normalizeNarrativeKey(candidate);
    return key && !excludedKeys.has(key);
  });

  if (!endingSource) {
    return "最终，这一段剧情把人物状态推到下一次爆发或转折发生前的停点。";
  }

  return `最终，${trimSentenceEnding(String(endingSource).replace(/^最终[，,:：\s]*/u, ""))}。`;
}

function stripLeadPhrase(text: string, pattern: RegExp): string {
  return trimSentenceEnding(String(text || "").replace(pattern, "").trim());
}

function buildSceneDescriptionSummary(scenes: Scene[], fallback: string): string {
  const sceneNames = uniqueNarrativeBeats(
    scenes
      .map((scene) => cleanNarrativeSentence(scene.sceneName || "", 18))
      .filter(Boolean),
  ).slice(0, 3);
  if (sceneNames.length) {
    return sceneNames.map((name) => trimSentenceEnding(name)).join("、");
  }
  return trimSentenceEnding(fallback) || "上一段的关键空间";
}

function buildCharacterActionSummary(scenes: Scene[], development: string, ending: string): string {
  const sceneActionBeats = scenes
    .slice(1)
    .map((scene) => cleanNarrativeSentence(scene.description || scene.sceneName || "", 42))
    .filter(Boolean);
  const fallbackActionBeats = [
    cleanNarrativeSentence(stripLeadPhrase(development, /^随着/u), 42),
    cleanNarrativeSentence(stripLeadPhrase(ending, /^最终[，,\s]*/u), 42),
  ].filter(Boolean);
  const actionBeats = uniqueNarrativeBeats([...sceneActionBeats, ...fallbackActionBeats]).slice(0, 2);
  return actionBeats.map((beat) => trimSentenceEnding(beat)).join("；");
}

function hasFixedRecapLabels(text: string): boolean {
  return ["人物状态：", "场景描述：", "人物动作：", "发生事件："].some((label) => text.includes(label));
}

export function buildSegmentContinuityRecapText(
  project: PersistedVideoProject,
  segmentLabel: string,
): string {
  const scenes = getScenesForSegment(project, segmentLabel);
  if (!scenes.length) {
    return "角色处在上一段剧情承接后的关键状态，场景承接上一段的核心空间。人物动作继续推进当前局势，故事被推向下一段新的冲突。";
  }

  const opening = buildOpeningSentence(scenes);
  const openingKey = normalizeNarrativeKey(opening);
  const development = buildDevelopmentSentence(scenes, openingKey);
  const developmentKey = normalizeNarrativeKey(development);
  const ending = buildEndingSentence(project, segmentLabel, scenes, new Set([openingKey, developmentKey]));
  const characterState = cleanNarrativeSentence(opening, 42);
  const sceneDescription = buildSceneDescriptionSummary(scenes, characterState);
  const characterAction = buildCharacterActionSummary(scenes, development, ending);
  const eventDescription = cleanNarrativeSentence(
    stripLeadPhrase(ending, /^最终[，,\s]*/u),
    50,
  );

  return [
    `${trimSentenceEnding(characterState)}，场景位于${trimSentenceEnding(sceneDescription)}。`,
    `${trimSentenceEnding(characterAction || "人物动作继续推进当前局势")}。`,
    `最终，${trimSentenceEnding(eventDescription || "故事被推向下一段新的冲突")}。`,
  ].join("");
}

export function resolveSegmentContinuityRecapText(
  project: PersistedVideoProject,
  segmentLabel: string,
  storedRecapText?: string | null,
): string | undefined {
  const normalizedStored = String(storedRecapText || "").trim();
  const canonical = buildSegmentContinuityRecapText(project, segmentLabel).trim();
  if (!canonical) return normalizedStored || undefined;
  if (!normalizedStored) return canonical;

  const storedSentenceCount = sentenceCount(normalizedStored);
  const canonicalSentenceCount = sentenceCount(canonical);
  const looksLegacyPrefix = /^前情提要[：:]/u.test(normalizedStored);
  const usesFixedRecapLabels = hasFixedRecapLabels(normalizedStored);
  const tooShortComparedWithCanonical =
    normalizedStored.length + 24 < canonical.length ||
    (storedSentenceCount < canonicalSentenceCount && normalizedStored.length + 16 < canonical.length);

  return looksLegacyPrefix || usesFixedRecapLabels || tooShortComparedWithCanonical
    ? canonical
    : normalizedStored;
}
