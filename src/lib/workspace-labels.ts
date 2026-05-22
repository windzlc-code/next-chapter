import type {
  CharacterSetting,
  Scene,
  SceneSetting,
  TimeVariantSetting,
} from "@/types/project";

export function normalizeBracketWrappedLabel(value: string): string {
  let normalized = String(value || "").trim();
  while (
    (normalized.startsWith("[") && normalized.endsWith("]")) ||
    (normalized.startsWith("【") && normalized.endsWith("】")) ||
    (normalized.startsWith("(") && normalized.endsWith(")")) ||
    (normalized.startsWith("（") && normalized.endsWith("）"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function normalizeCharacterName(name: string): string {
  return normalizeBracketWrappedLabel(name);
}

export function normalizeSceneName(name: string): string {
  return normalizeBracketWrappedLabel(name)
    .replace(/\u3010\s*([^\u3010\u3011]+?)\s*\u3011/gu, "$1")
    .replace(/\[\s*([^\]]+?)\s*\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function simplifySceneNameForMatch(name: string): string {
  return normalizeSceneName(name)
    .replace(/(窗边|窗前|窗外|窗内|门口|入口|出口|楼梯|走廊|储物间|储藏间|外景|内景)$/u, "")
    .replace(/(设施|設施|舱|艙|仓|室内|室外|内部|外部|边)$/u, "")
    .trim();
}

function scoreSceneNameSimilarity(left: string, right: string): number {
  const a = simplifySceneNameForMatch(left);
  const b = simplifySceneNameForMatch(right);
  if (!a || !b) return 0;
  if (a === b) return Math.max(a.length, b.length) + 200;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) + 120;

  const sharedChars = [...new Set(a.split(""))].filter((char) => b.includes(char)).length;
  const overlapScore = (sharedChars / Math.max(a.length, b.length)) * 100;
  return overlapScore >= 45 ? overlapScore : 0;
}

function findCharacterByName(
  characterName: string,
  characters: CharacterSetting[],
): CharacterSetting | undefined {
  const normalizedTarget = normalizeCharacterName(characterName);
  return characters.find(
    (item) => normalizeCharacterName(item.name) === normalizedTarget,
  );
}

function getCharacterCostumeAssignment(
  assignments: Record<string, string> | undefined,
  characterName: string,
): string | undefined {
  if (!assignments) return undefined;
  const normalizedTarget = normalizeCharacterName(characterName);
  for (const [key, value] of Object.entries(assignments)) {
    if (normalizeCharacterName(key) === normalizedTarget) {
      return value;
    }
  }
  return undefined;
}

function resolveCostumeLabelFromAssignment(
  character: CharacterSetting,
  assignment: string | undefined,
): string | null {
  if (!assignment || !character.costumes?.length) return null;

  const normalizedAssignment = assignment.trim().toLowerCase();
  const byId = character.costumes.find((item) => item.id === assignment);
  if (byId?.label?.trim()) return byId.label.trim();

  const byLabel = character.costumes.find(
    (item) => item.label?.trim().toLowerCase() === normalizedAssignment,
  );
  if (byLabel?.label?.trim()) return byLabel.label.trim();

  const byPartial = character.costumes.find(
    (item) =>
      item.label?.trim() &&
      (normalizedAssignment.includes(item.label.trim().toLowerCase()) ||
        item.label.trim().toLowerCase().includes(normalizedAssignment)),
  );
  return byPartial?.label?.trim() || null;
}

function collectExplicitSegmentCostumeLabels(
  character: CharacterSetting,
  segmentScenes: Scene[],
): string[] {
  return segmentScenes
    .map((scene) =>
      resolveCostumeLabelFromAssignment(
        character,
        getCharacterCostumeAssignment(scene.characterCostumes, character.name),
      ),
    )
    .filter((value): value is string => !!value);
}

function pickDominantLabel(labels: string[]): string | null {
  if (!labels.length) return null;
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  labels.forEach((label, index) => {
    counts.set(label, (counts.get(label) || 0) + 1);
    if (!firstSeen.has(label)) firstSeen.set(label, index);
  });

  return [...counts.entries()]
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) return countDiff;
      return (firstSeen.get(a[0]) || 0) - (firstSeen.get(b[0]) || 0);
    })[0]?.[0] || null;
}

function splitLabelParts(label: string): string[] {
  return label
    .split(/[/,，、\s]+/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function scoreLabelAgainstText(label: string, text: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedLabel = label.trim().toLowerCase();
  if (!normalizedLabel) return 0;

  if (normalizedText.includes(normalizedLabel)) {
    return normalizedLabel.length + 100;
  }

  const parts = splitLabelParts(label);
  let componentScore = 0;
  let matchedParts = 0;
  for (const part of parts) {
    if (normalizedText.includes(part)) {
      componentScore += part.length;
      matchedParts++;
    }
  }

  return matchedParts > 0 ? componentScore + matchedParts * 10 : 0;
}

export function buildSceneContextText(scene: Scene): string {
  return [
    normalizeSceneName(scene.sceneName || ""),
    scene.description,
    scene.dialogue,
    scene.cameraDirection,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildSegmentContextText(segmentScenes: Scene[]): string {
  return segmentScenes.map(buildSceneContextText).filter(Boolean).join(" ");
}

export function findSceneSetting(
  scene: Scene,
  sceneSettings: SceneSetting[],
): SceneSetting | null {
  const baseSceneName = normalizeSceneName(scene.sceneName || "");
  if (!baseSceneName) return null;
  const exactMatch =
    sceneSettings.find(
      (item) => normalizeSceneName(item.name || "") === baseSceneName,
    ) || null;
  if (exactMatch) return exactMatch;

  let bestMatch: SceneSetting | null = null;
  let bestScore = 0;
  for (const item of sceneSettings) {
    const score = scoreSceneNameSimilarity(baseSceneName, item.name || "");
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

export function findSegmentSceneSetting(
  segmentScenes: Scene[],
  sceneSettings: SceneSetting[],
): SceneSetting | null {
  if (!segmentScenes.length) return null;

  const counts = new Map<string, { setting: SceneSetting; count: number; firstIndex: number }>();
  segmentScenes.forEach((scene, index) => {
    const matched = findSceneSetting(scene, sceneSettings);
    if (!matched) return;
    const current = counts.get(matched.id);
    if (current) {
      current.count += 1;
      return;
    }
    counts.set(matched.id, { setting: matched, count: 1, firstIndex: index });
  });

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)[0]?.setting || null;
}

export function matchCharacterCostume(
  character: CharacterSetting,
  scene: Scene,
): string | null {
  return matchCharacterCostumeForText(
    character,
    buildSceneContextText(scene),
    getCharacterCostumeAssignment(scene.characterCostumes, character.name),
  );
}

export function matchCharacterCostumeForText(
  character: CharacterSetting,
  text: string,
  explicitCostumeId?: string,
): string | null {
  if (!character.costumes?.length) return null;

  if (explicitCostumeId) {
    // Try matching by id first
    const byId = character.costumes.find((item) => item.id === explicitCostumeId);
    if (byId?.label?.trim()) return byId.label.trim();
    // Also try matching by label (AI decomposition stores label, not id)
    const byLabel = character.costumes.find(
      (item) => item.label?.trim().toLowerCase() === explicitCostumeId.trim().toLowerCase(),
    );
    if (byLabel?.label?.trim()) return byLabel.label.trim();
    // Partial label match (e.g. "青年·战甲" contains "战甲")
    const byPartial = character.costumes.find(
      (item) =>
        item.label?.trim() &&
        (explicitCostumeId.includes(item.label.trim()) || item.label.trim().includes(explicitCostumeId.trim())),
    );
    if (byPartial?.label?.trim()) return byPartial.label.trim();
  }

  if (character.costumes.length <= 1) return null;

  let bestLabel: string | null = null;
  let bestScore = 0;
  for (const costume of character.costumes) {
    const label = costume.label?.trim();
    if (!label) continue;
    const score = scoreLabelAgainstText(label, text);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  return bestLabel;
}

export function matchCharacterCostumeForSegment(
  character: CharacterSetting,
  segmentScenes: Scene[],
): string | null {
  const explicitLabel = pickDominantLabel(
    collectExplicitSegmentCostumeLabels(character, segmentScenes),
  );
  if (explicitLabel) return explicitLabel;

  const explicitCostumeId = segmentScenes
    .map((scene) =>
      getCharacterCostumeAssignment(scene.characterCostumes, character.name),
    )
    .find(Boolean);
  return matchCharacterCostumeForText(
    character,
    buildSegmentContextText(segmentScenes),
    explicitCostumeId,
  );
}

export function getPreferredCharacterCostumeLabel(
  character: CharacterSetting,
  scene: Scene,
): string | null {
  const matchedLabel = matchCharacterCostume(character, scene);
  if (matchedLabel) return matchedLabel;

  const activeCostumeId = character.activeCostumeId;
  if (!activeCostumeId || !character.costumes?.length) return null;

  const activeCostume = character.costumes.find(
    (item) => item.id === activeCostumeId,
  );
  return activeCostume?.label?.trim() || null;
}

export function getPreferredCharacterCostumeLabelForSegment(
  character: CharacterSetting,
  segmentScenes: Scene[],
): string | null {
  const matchedLabel = matchCharacterCostumeForSegment(character, segmentScenes);
  if (matchedLabel) return matchedLabel;

  const activeCostumeId = character.activeCostumeId;
  if (!activeCostumeId || !character.costumes?.length) return null;

  const activeCostume = character.costumes.find(
    (item) => item.id === activeCostumeId,
  );
  return activeCostume?.label?.trim() || null;
}

export function getCharacterDisplayName(
  characterName: string,
  scene: Scene,
  characters: CharacterSetting[],
): string {
  const normalizedCharacterName = normalizeCharacterName(characterName);
  const character = findCharacterByName(normalizedCharacterName, characters);
  if (!character) return normalizedCharacterName;

  const costumeLabel = getPreferredCharacterCostumeLabel(character, scene);
  return costumeLabel
    ? `${normalizeCharacterName(character.name)} ${costumeLabel}`
    : normalizeCharacterName(character.name);
}

export function getSegmentCharacterDisplayNames(
  segmentScenes: Scene[],
  characters: CharacterSetting[],
): string[] {
  const names = new Set<string>();

  for (const scene of segmentScenes) {
    for (const rawName of scene.characters || []) {
      const characterName = normalizeCharacterName(String(rawName || "").trim());
      if (!characterName) continue;

      const character = findCharacterByName(characterName, characters);
      if (!character) {
        names.add(characterName);
        continue;
      }

      const costumeLabel = getPreferredCharacterCostumeLabelForSegment(
        character,
        segmentScenes,
      );
      const normalizedStoredName = normalizeCharacterName(character.name);
      names.add(
        costumeLabel
          ? `${normalizedStoredName} ${costumeLabel}`
          : normalizedStoredName,
      );
    }
  }

  return [...names];
}

export function matchSceneTimeVariant(
  scene: Scene,
  sceneSettings: SceneSetting[],
): TimeVariantSetting | null {
  return matchSceneTimeVariantForText(
    findSceneSetting(scene, sceneSettings),
    buildSceneContextText(scene),
    scene.sceneTimeVariantId,
  );
}

export function matchSceneTimeVariantForText(
  matchedScene: SceneSetting | null,
  text: string,
  explicitTimeVariantId?: string,
): TimeVariantSetting | null {
  if (!matchedScene?.timeVariants?.length) {
    return null;
  }

  if (explicitTimeVariantId) {
    // Try by id first
    const byId = matchedScene.timeVariants.find((item) => item.id === explicitTimeVariantId);
    if (byId) return byId;
    // Try by label (in case the stored value is a label, not an id)
    const byLabel = matchedScene.timeVariants.find(
      (item) => item.label?.trim().toLowerCase() === explicitTimeVariantId.trim().toLowerCase(),
    );
    if (byLabel) return byLabel;
    // Partial label match
    const byPartial = matchedScene.timeVariants.find(
      (item) =>
        item.label?.trim() &&
        (explicitTimeVariantId.includes(item.label.trim()) || item.label.trim().includes(explicitTimeVariantId.trim())),
    );
    if (byPartial) return byPartial;
  }

  if (matchedScene.timeVariants.length <= 1) {
    return null;
  }

  let bestVariant: TimeVariantSetting | null = null;
  let bestScore = 0;

  for (const variant of matchedScene.timeVariants) {
    const label = variant.label?.trim();
    if (!label) continue;
    const score = scoreLabelAgainstText(label, text);
    if (score > bestScore) {
      bestScore = score;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

export function matchSceneTimeVariantForSegment(
  segmentScenes: Scene[],
  sceneSettings: SceneSetting[],
): TimeVariantSetting | null {
  const firstScene = segmentScenes[0];
  if (!firstScene) return null;
  const matchedScene = findSceneSetting(firstScene, sceneSettings);
  const explicitTimeVariantId = segmentScenes
    .map((scene) => scene.sceneTimeVariantId)
    .find(Boolean);

  return matchSceneTimeVariantForText(
    matchedScene,
    buildSegmentContextText(segmentScenes),
    explicitTimeVariantId,
  );
}

export function getSceneDisplayName(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string {
  const matchedScene = findSceneSetting(scene, sceneSettings);
  const baseSceneName = normalizeSceneName(matchedScene?.name || scene.sceneName || "");
  if (!baseSceneName) return "";

  const variant = matchSceneTimeVariant(scene, sceneSettings);
  if (!variant?.label?.trim()) return baseSceneName;

  const variantLabel = variant.label.trim();
  if (baseSceneName.includes(variantLabel)) return baseSceneName;
  return `${baseSceneName} ${variantLabel}`;
}

export function getSegmentSceneDisplayName(
  segmentScenes: Scene[],
  sceneSettings: SceneSetting[],
): string {
  const matchedScene = findSegmentSceneSetting(segmentScenes, sceneSettings);
  const baseSceneName = normalizeSceneName(
    matchedScene?.name ||
      segmentScenes
        .map((scene) => normalizeSceneName(scene.sceneName || ""))
        .find(Boolean) ||
      "",
  );
  if (!baseSceneName) return "";

  const variant = matchSceneTimeVariantForSegment(segmentScenes, sceneSettings);
  if (!variant?.label?.trim()) return baseSceneName;

  const variantLabel = variant.label.trim();
  if (baseSceneName.includes(variantLabel)) return baseSceneName;
  return `${baseSceneName} ${variantLabel}`;
}
