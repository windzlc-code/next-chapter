import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type {
  CharacterSetting,
  ProductionAssetManifest,
  ProductionAssetRecord,
  Scene,
  SceneSetting,
  VideoAuditPacket,
  VideoAutomationState,
  VideoAutomationReferenceTargetState,
  VideoRepairTask,
  VideoShotGenerationPolicy,
  VideoShotQaSpec,
  VideoShotReferencePlan,
  VideoShotPacket,
  VideoStyleLock,
  VideoWorldModel,
  VideoWorldModelCharacterState,
  VideoWorldModelProp,
  VideoWorldModelPropState,
  VideoWorldModelRelationship,
  VideoWorldModelStateSnapshot,
  VideoWorldNarrativeConstraint,
} from "@/types/project";
import {
  appendDuplicateLabelSequence,
  buildCharacterAssetLabel,
  buildSceneAssetLabel,
  buildSegmentVideoLabel,
  buildStoryboardAssetLabel,
  buildVideoAssetLabel,
} from "./asset-naming";
import { hasUsableMediaUrl } from "./media-url";

function truncate(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function normalizeName(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

const DEFAULT_VIDEO_AUTOMATION_STATE: VideoAutomationState = {
  strategy: "quality-first",
  segmentPassBudget: 5,
  localRepairBudget: 2,
  regenerateBudget: 2,
  assetPrimaryRetryBudget: 3,
  assetVariantRetryBudget: 2,
  segments: {},
  referenceTargets: {},
  updatedAt: new Date().toISOString(),
};

const DEFAULT_VIDEO_SHOT_QA_SPEC: VideoShotQaSpec = {
  requiresSymbolicPass: true,
  minTotalScore: 85,
  minContinuityScore: 85,
  minIdentityScore: 85,
  minSemanticScore: 80,
  minVisualScore: 80,
};

const DEFAULT_VIDEO_SHOT_GENERATION_POLICY: VideoShotGenerationPolicy = {
  preferredMode: "img2video",
  preferSegmentChain: true,
  preferContinuityFrameAsFirstFrame: true,
  localRepairBudget: DEFAULT_VIDEO_AUTOMATION_STATE.localRepairBudget,
  regenerateBudget: DEFAULT_VIDEO_AUTOMATION_STATE.regenerateBudget,
  totalPassBudget: DEFAULT_VIDEO_AUTOMATION_STATE.segmentPassBudget,
};

const PROP_KEYWORD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /木剑|sword|blade/i, label: "木剑" },
  { pattern: /灵剑|剑光|golden sword/i, label: "灵剑" },
  { pattern: /戒指|ring/i, label: "戒指" },
  { pattern: /玉佩|jade/i, label: "玉佩" },
  { pattern: /卷轴|scroll/i, label: "卷轴" },
  { pattern: /令牌|token/i, label: "令牌" },
  { pattern: /面具|mask/i, label: "面具" },
  { pattern: /枪|spear/i, label: "长枪" },
];

function normalizeLooseText(value: string | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function summarizeTextList(values: string[], fallback: string): string {
  const normalized = values.map((value) => normalizeLooseText(value)).filter(Boolean);
  return normalized.length ? unique(normalized).join("；") : fallback;
}

function findCharacterBySceneName(
  project: PersistedVideoProject,
  rawName: string,
): CharacterSetting | undefined {
  const normalized = normalizeName(rawName);
  return project.characters.find((character) => normalizeName(character.name) === normalized);
}

function findSceneSettingByScene(
  scene: Scene,
  sceneSettings: SceneSetting[],
): SceneSetting | undefined {
  const sceneName = normalizeName(scene.sceneName);
  return sceneSettings.find((sceneSetting) => {
    const candidate = normalizeName(sceneSetting.name);
    return candidate && (sceneName.includes(candidate) || candidate.includes(sceneName));
  });
}

function inferEmotionFromText(...texts: Array<string | undefined>): string {
  const joined = texts.map((text) => normalizeLooseText(text)).join(" ");
  if (!joined) return "克制";
  if (/愤怒|暴怒|rage|furious/i.test(joined)) return "愤怒";
  if (/痛苦|虚弱|injured|pain/i.test(joined)) return "痛苦";
  if (/冷漠|轻蔑|傲慢|cold|smirk/i.test(joined)) return "冷漠";
  if (/危险|杀意|hostile|deadly/i.test(joined)) return "危险";
  if (/惊讶|震惊|surprised|shock/i.test(joined)) return "震惊";
  if (/悲伤|哀伤|sad/i.test(joined)) return "悲伤";
  if (/紧张|警觉|urgent|tense/i.test(joined)) return "警觉";
  return "克制";
}

function inferKnowledgeState(...texts: Array<string | undefined>): string {
  const joined = texts.map((text) => normalizeLooseText(text)).join(" ");
  if (!joined) return "未知";
  if (/知道|发现|识破|reveals|discovers|knows/i.test(joined)) return "已知关键事实";
  if (/怀疑|猜测|suspect/i.test(joined)) return "存在怀疑";
  return "未知";
}

function inferInjuryState(...texts: Array<string | undefined>): string {
  const joined = texts.map((text) => normalizeLooseText(text)).join(" ");
  if (!joined) return "无明显伤势";
  if (/满脸鲜血|鲜血|重伤|伤口|bleed|injured|wounded/i.test(joined)) return "明显受伤";
  if (/虚弱|喘息|跪地|weak|breathless/i.test(joined)) return "体力下降";
  return "无明显伤势";
}

function inferAbilityState(...texts: Array<string | undefined>): string {
  const joined = texts.map((text) => normalizeLooseText(text)).join(" ");
  if (!joined) return "能力未触发";
  if (/觉醒|苏醒|爆发|unlock|awaken/i.test(joined)) return "能力觉醒中";
  if (/系统|蓝光|能量嗡鸣|energy/i.test(joined)) return "能力即将触发";
  return "能力未触发";
}

function inferPositionState(...texts: Array<string | undefined>): string {
  const joined = texts.map((text) => normalizeLooseText(text)).join(" ");
  if (!joined) return "站位未说明";
  if (/躺|深坑|倒地|lying|ground/i.test(joined)) return "低位受压";
  if (/半跪|跪|kneel/i.test(joined)) return "半跪蓄力";
  if (/站在|俯视|踩在|standing/i.test(joined)) return "高位压制";
  if (/冲入|前压|追击|runs|charges/i.test(joined)) return "前压推进";
  return "站位未说明";
}

function inferTimeOfDay(scene: Scene, matchedSetting?: SceneSetting): string {
  const matchedVariant = matchedSetting?.timeVariants?.find(
    (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
  );
  const joined = [
    matchedVariant?.label,
    matchedVariant?.description,
    matchedSetting?.description,
    scene.description,
    scene.sceneName,
  ]
    .map((value) => normalizeLooseText(value))
    .join(" ");
  if (/夜|night|moon/i.test(joined)) return matchedVariant?.label || "夜间";
  if (/晨|黎明|dawn|morning/i.test(joined)) return matchedVariant?.label || "清晨";
  if (/黄昏|傍晚|dusk|sunset/i.test(joined)) return matchedVariant?.label || "黄昏";
  if (/日|烈日|白天|day/i.test(joined)) return matchedVariant?.label || "白天";
  return matchedVariant?.label || "未指定时段";
}

function inferPropsFromScene(
  scene: Scene,
  project: PersistedVideoProject,
): Array<{ label: string; status: string; holderCharacterId?: string }> {
  const source = [scene.sceneName, scene.description, scene.dialogue, scene.cameraDirection]
    .map((value) => normalizeLooseText(value))
    .join(" ");
  const props = PROP_KEYWORD_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ label }) => {
      const holder = scene.characters
        .map((name) => findCharacterBySceneName(project, name))
        .find(Boolean);
      const normalizedLabel = label;
      const status =
        /裂纹|破碎|damaged|broken/i.test(source) && /剑|ring|jade|scroll/i.test(normalizedLabel)
          ? "受损"
          : /金色|发光|glow/i.test(source)
            ? "激活"
            : "完好";
      return {
        label: normalizedLabel,
        status,
        ...(holder ? { holderCharacterId: holder.id } : {}),
      };
    });
  return props;
}

function buildSceneStateSnapshot(
  scene: Scene,
  project: PersistedVideoProject,
  propStates: VideoWorldModelPropState[],
): VideoWorldModelStateSnapshot {
  const matchedSetting = findSceneSettingByScene(scene, project.sceneSettings);
  const characterStates: VideoWorldModelCharacterState[] = scene.characters
    .map((name) => {
      const character = findCharacterBySceneName(project, name);
      const costumeId = scene.characterCostumes?.[name] || character?.activeCostumeId;
      const costumeLabel = costumeId
        ? character?.costumes?.find((costume) => costume.id === costumeId)?.label
        : undefined;
      return {
        characterId: character?.id || `unknown:${name}`,
        name,
        ...(costumeId ? { costumeId } : {}),
        ...(costumeLabel ? { costumeLabel } : {}),
        position: inferPositionState(scene.description, scene.cameraDirection),
        emotion: inferEmotionFromText(scene.description, scene.dialogue),
        knowledgeState: inferKnowledgeState(scene.description, scene.dialogue),
        injuryState: inferInjuryState(scene.description, scene.dialogue),
        abilityState: inferAbilityState(scene.description, scene.dialogue),
      };
    })
    .filter((state) => Boolean(state.characterId));

  return {
    id: `snapshot:${scene.id}`,
    sceneId: scene.id,
    sceneNumber: scene.sceneNumber,
    segmentLabel: scene.segmentLabel,
    location: matchedSetting?.name || scene.sceneName || "未指定场景",
    timeOfDay: inferTimeOfDay(scene, matchedSetting),
    openingHook: truncate(scene.description || scene.sceneName || "开场画面"),
    closingHook: truncate(scene.cameraDirection || scene.description || scene.sceneName || "结尾画面"),
    keyAction: truncate(
      summarizeTextList([scene.description, scene.cameraDirection, scene.dialogue], scene.sceneName || "镜头推进"),
      120,
    ),
    characterStates,
    propStates,
  };
}

function buildSceneRelationships(
  scene: Scene,
  project: PersistedVideoProject,
): VideoWorldModelRelationship[] {
  const characters = scene.characters
    .map((name) => findCharacterBySceneName(project, name))
    .filter((value): value is CharacterSetting => Boolean(value));
  const relationships: VideoWorldModelRelationship[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < characters.length; nextIndex += 1) {
      const source = characters[index];
      const target = characters[nextIndex];
      if (!source || !target) continue;
      const conflictLike = /踩|追|战|杀|嘲笑|压制|fight|chase|attack/i.test(
        `${scene.description} ${scene.dialogue}`,
      );
      relationships.push({
        id: `rel:${scene.id}:${source.id}:${target.id}`,
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        label: conflictLike ? "冲突对峙" : "同场互动",
        strength: conflictLike ? 90 : 70,
        derivedFromSceneIds: [scene.id],
      });
    }
  }
  return relationships;
}

function buildNarrativeConstraints(
  project: PersistedVideoProject,
  snapshots: VideoWorldModelStateSnapshot[],
  props: VideoWorldModelProp[],
): VideoWorldNarrativeConstraint[] {
  const constraints: VideoWorldNarrativeConstraint[] = [];
  project.characters.forEach((character) => {
    constraints.push({
      id: `constraint:character:${character.id}:identity`,
      type: "continuity",
      statement: `${character.name} 的外貌、体型、发型与主服装识别点在连续片段中不得突然变化。`,
      appliesToSceneIds: project.scenes.map((scene) => scene.id),
    });
  });
  snapshots.forEach((snapshot) => {
    snapshot.characterStates.forEach((state) => {
      if (state.injuryState !== "无明显伤势") {
        constraints.push({
          id: `constraint:${snapshot.sceneId}:${state.characterId}:injury`,
          type: "injury",
          statement: `${state.name} 在 ${snapshot.segmentLabel || snapshot.sceneNumber} 段保持 ${state.injuryState}，后续镜头不得无因恢复。`,
          appliesToSceneIds: [snapshot.sceneId],
        });
      }
      if (state.knowledgeState !== "未知") {
        constraints.push({
          id: `constraint:${snapshot.sceneId}:${state.characterId}:knowledge`,
          type: "knowledge",
          statement: `${state.name} 在 ${snapshot.segmentLabel || snapshot.sceneNumber} 段已进入“${state.knowledgeState}”，前序镜头不得提前知晓，后续镜头不得重置为未知。`,
          appliesToSceneIds: [snapshot.sceneId],
        });
      }
    });
  });
  props.forEach((prop) => {
    constraints.push({
      id: `constraint:prop:${prop.id}`,
      type: "prop",
      statement: `${prop.label} 当前状态为 ${prop.status}，镜头衔接时必须保持道具状态连续。`,
      appliesToSceneIds: prop.sceneIds,
    });
  });
  return constraints;
}

function hasUsableAssetUrl(url: string | undefined): boolean {
  return hasUsableMediaUrl(url);
}

function isDerivedAssetId(id: string | undefined): boolean {
  if (!id) return false;
  return /^(char|scene|shot):/i.test(id);
}

function collectPreservedManualAssets(
  project: PersistedVideoProject,
): ProductionAssetRecord[] {
  return (project.assetManifest?.items ?? [])
    .filter((item) => {
      if (!hasUsableAssetUrl(item.url)) return false;
      if (item.origin === "manual") return true;
      return !isDerivedAssetId(item.id);
    })
    .map((item) => ({
      ...item,
      origin: "manual" as const,
    }));
}

function inferGenres(project: PersistedVideoProject): string[] {
  const joined = [
    project.title,
    project.outputGoal,
    project.productionNotes,
    project.analysisSummary,
    project.script,
  ]
    .filter(Boolean)
    .join("\n");

  const checks: Array<[RegExp, string]> = [
    [/都市|职场|总裁|婚姻/, "都市"],
    [/悬疑|反转|推理|调查/, "悬疑"],
    [/古装|仙侠|王朝|江湖/, "古风"],
    [/玄幻|异兽|修炼|灵兽/, "玄幻"],
    [/校园|青春|成长/, "青春"],
    [/喜剧|搞笑|沙雕/, "喜剧"],
  ];

  const hits = checks
    .filter(([pattern]) => pattern.test(joined))
    .map(([, label]) => label);

  return hits.length ? hits : ["短视频叙事"];
}

function buildPromptTemplate(project: PersistedVideoProject): string {
  return [
    "{镜头主体}，{角色状态}，{场景氛围}",
    `${project.artStyle || "live-action"} 风格，${project.shotStyle || "电影化镜头语言"}`,
    `${project.targetPlatform || "短视频"} 节奏，保持角色一致性与场景连续性。`,
  ].join(" ");
}

export function deriveVideoStyleLock(project: PersistedVideoProject): VideoStyleLock {
  return {
    genre: inferGenres(project),
    tone: project.outputGoal?.trim() || "高信息密度、强钩子、对话推动",
    visualStyle:
      project.artStyle === "anime-3d"
        ? "三渲二动画质感"
        : project.artStyle === "retro-comic"
          ? "复古漫画质感"
          : project.artStyle === "hyper-cg"
            ? "超写实 CG"
            : "电影化短剧质感",
    colorMood: project.productionNotes?.includes("冷")
      ? "冷暖对冲"
      : "高对比、主体突出、镜头焦点明确",
    cinematography: project.shotStyle?.trim() || "中近景驱动、关键反应镜头优先",
    forbidden: unique([
      "不要改变主角脸型与服装识别点",
      "不要在相邻镜头中无故改变时间段",
      "不要弱化已锁定的情绪和剧情钩子",
    ]),
    referencePromptTemplate: buildPromptTemplate(project),
  };
}

function buildCharacterAssetRefs(
  character: CharacterSetting,
  items: ProductionAssetRecord[],
): string[] {
  return items
    .filter(
      (item) =>
        item.sourceEntityId === character.id &&
        (item.kind === "character-reference" || item.kind === "costume-reference"),
    )
    .map((item) => item.id);
}

function findSceneSetting(scene: Scene, sceneSettings: SceneSetting[]): SceneSetting | undefined {
  const sceneName = normalizeName(scene.sceneName);
  return sceneSettings.find((sceneSetting) => {
    const candidate = normalizeName(sceneSetting.name);
    return candidate && (sceneName.includes(candidate) || candidate.includes(sceneName));
  });
}

function resolveSceneVariantLabel(
  scene: Scene,
  sceneSettings: SceneSetting[],
): string | undefined {
  const matchedSetting = findSceneSetting(scene, sceneSettings);
  return matchedSetting?.timeVariants?.find(
    (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
  )?.label;
}

export function deriveVideoAssetManifest(project: PersistedVideoProject): ProductionAssetManifest {
  const items: ProductionAssetRecord[] = [];
  const seen = new Set<string>();
  const preservedManualAssets = collectPreservedManualAssets(project);
  const previousDerivedAssetByKey = new Map(
    (project.assetManifest?.items ?? [])
      .filter((item) => item.origin !== "manual")
      .map((item) => [item.id, item] as const),
  );

  const pushAsset = (
    asset: Omit<ProductionAssetRecord, "id"> & {
      key: string;
      source?: string;
    },
  ) => {
    if (!hasUsableAssetUrl(asset.url) || seen.has(asset.key)) return;
    seen.add(asset.key);
    const previousAsset = previousDerivedAssetByKey.get(asset.key);
    const shouldPreserveTimestamps = Boolean(
      previousAsset && previousAsset.url === asset.url,
    );
    items.push({
      id: asset.key,
      kind: asset.kind,
      label: asset.label,
      url: asset.url,
      meta: asset.meta,
      reusable: asset.reusable,
      status: asset.status,
      source: asset.source,
      origin: "derived",
      sourceEntityId: asset.sourceEntityId,
      sceneId: asset.sceneId,
      sceneNumber: asset.sceneNumber,
      version: asset.version ?? 1,
      variantLabel: asset.variantLabel,
      view: asset.view,
      emotion: asset.emotion,
      stateTag: asset.stateTag,
      continuityRole: asset.continuityRole,
      qualityScore: asset.qualityScore,
      sourceRefs: asset.sourceRefs,
      createdAt:
        asset.createdAt ??
        (shouldPreserveTimestamps ? previousAsset?.createdAt : undefined) ??
        project.updatedAt ??
        new Date().toISOString(),
      updatedAt:
        asset.updatedAt ??
        (shouldPreserveTimestamps ? previousAsset?.updatedAt : undefined),
    });
  };

  project.characters.forEach((character) => {
    pushAsset({
      key: `char:${character.id}:primary`,
      kind: "character-reference",
      label: buildCharacterAssetLabel(character.name),
      url: character.imageUrl || "",
      meta: "角色主参考",
      reusable: true,
      status: "ready",
      sourceEntityId: character.id,
      continuityRole: "primary",
      qualityScore: 92,
      sourceRefs: [character.id],
    });

    Object.entries(character.threeViewUrls ?? {}).forEach(([view, url], index) => {
      pushAsset({
        key: `char:${character.id}:view:${view}`,
        kind: "character-reference",
        label: buildCharacterAssetLabel(character.name, { view }),
        url: url || "",
        meta: "三视图",
        reusable: true,
        status: "ready",
        sourceEntityId: character.id,
        version: index + 1,
        view,
        continuityRole: "supporting",
        qualityScore: 90,
        sourceRefs: [`char:${character.id}:primary`],
      });
    });

    character.costumes?.forEach((costume, index) => {
      pushAsset({
        key: `char:${character.id}:costume:${costume.id}`,
        kind: "costume-reference",
        label: buildCharacterAssetLabel(character.name, { variantLabel: costume.label }),
        url: costume.imageUrl || "",
        meta: "角色变体",
        reusable: true,
        status: "ready",
        sourceEntityId: character.id,
        version: index + 1,
        variantLabel: costume.label,
        stateTag: costume.label,
        continuityRole: character.activeCostumeId === costume.id ? "primary" : "supporting",
        qualityScore: character.activeCostumeId === costume.id ? 91 : 88,
        sourceRefs: [`char:${character.id}:primary`],
      });
    });
  });

  project.sceneSettings.forEach((sceneSetting) => {
    pushAsset({
      key: `scene:${sceneSetting.id}:primary`,
      kind: "scene-reference",
      label: buildSceneAssetLabel(sceneSetting.name),
      url: sceneSetting.imageUrl || "",
      meta: "场景主参考",
      reusable: true,
      status: "ready",
      sourceEntityId: sceneSetting.id,
      continuityRole: "primary",
      qualityScore: 91,
      sourceRefs: [sceneSetting.id],
    });

    sceneSetting.timeVariants?.forEach((variant, index) => {
      pushAsset({
        key: `scene:${sceneSetting.id}:time:${variant.id}`,
        kind: "time-variant",
        label: buildSceneAssetLabel(sceneSetting.name, { variantLabel: variant.label }),
        url: variant.imageUrl || "",
        meta: "场景变体",
        reusable: true,
        status: "ready",
        sourceEntityId: sceneSetting.id,
        version: index + 1,
        variantLabel: variant.label,
        stateTag: variant.label,
        continuityRole: sceneSetting.activeTimeVariantId === variant.id ? "primary" : "supporting",
        qualityScore: sceneSetting.activeTimeVariantId === variant.id ? 90 : 87,
        sourceRefs: [`scene:${sceneSetting.id}:primary`],
      });
    });
  });

  project.scenes.forEach((scene) => {
    const variantLabel = resolveSceneVariantLabel(scene, project.sceneSettings);

    pushAsset({
      key: `shot:${scene.id}:storyboard`,
      kind: "storyboard-frame",
      label: buildStoryboardAssetLabel(scene, { variantLabel }),
      url: scene.storyboardUrl || "",
      meta: scene.segmentLabel ? `分镜 / ${scene.segmentLabel}` : "分镜",
      reusable: false,
      status: "ready",
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      continuityRole: scene.sceneNumber === 1 ? "opening-anchor" : "supporting",
      qualityScore: 89,
      sourceRefs: scene.characters
        .map((name) => findCharacterBySceneName(project, name))
        .filter((value): value is CharacterSetting => Boolean(value))
        .map((character) => `char:${character.id}:primary`),
    });

    pushAsset({
      key: `shot:${scene.id}:video`,
      kind: "video-segment",
      label: buildVideoAssetLabel(scene, { variantLabel }),
      url: scene.videoUrl || "",
      meta: scene.videoStatus || "视频片段",
      reusable: false,
      status: scene.videoStatus === "failed" ? "failed" : "needs-review",
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      continuityRole: "relay",
      qualityScore: scene.videoStatus === "failed" ? 40 : 86,
      sourceRefs: [`shot:${scene.id}:storyboard`],
    });
  });

  Object.entries(project.segmentVideos ?? {}).forEach(([segmentLabel, url]) => {
    const relatedScenes = project.scenes
      .filter((scene) => scene.segmentLabel === segmentLabel)
      .sort((left, right) => left.sceneNumber - right.sceneNumber);

    pushAsset({
      key: `segment:${segmentLabel}:video`,
      kind: "video-segment",
      label: buildSegmentVideoLabel(segmentLabel),
      url: url || "",
      meta: "片段视频",
      reusable: false,
      status: "ready",
      source: "segment-video",
      sourceEntityId: segmentLabel,
      sceneId: relatedScenes[0]?.id,
      sceneNumber: relatedScenes[0]?.sceneNumber,
      continuityRole: "relay",
      qualityScore: 90,
      sourceRefs: relatedScenes.length
        ? relatedScenes.map((scene) => `shot:${scene.id}:storyboard`)
        : undefined,
    });
  });

  Object.entries(project.segmentContinuityGridImages ?? {}).forEach(([segmentLabel, grid]) => {
    const gridUrl = String(grid?.imageUrl || "").trim();
    if (!gridUrl) return;
    const relatedScenes = project.scenes
      .filter((scene) => scene.segmentLabel === segmentLabel)
      .sort((left, right) => left.sceneNumber - right.sceneNumber);

    pushAsset({
      key: `segment:${segmentLabel}:continuity-grid`,
      kind: "segment-continuity-grid",
      label: buildSegmentVideoLabel(segmentLabel),
      url: gridUrl,
      meta: "前情六宫格",
      reusable: true,
      status: "ready",
      source: "segment-continuity-grid",
      sourceEntityId: segmentLabel,
      sceneId: relatedScenes[0]?.id,
      sceneNumber: relatedScenes[0]?.sceneNumber,
      continuityRole: "relay",
      qualityScore: 89,
      sourceRefs: [
        `segment:${segmentLabel}:video`,
        ...relatedScenes.map((scene) => `shot:${scene.id}:storyboard`),
      ],
      createdAt: grid.createdAt,
      updatedAt: grid.updatedAt ?? grid.createdAt,
    });
  });

  preservedManualAssets.forEach((item) => {
    if (!hasUsableAssetUrl(item.url) || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  });

  const dedupedItems = appendDuplicateLabelSequence(items);
  const reusableCount = dedupedItems.filter((item) => item.reusable).length;
  return {
    version: `manifest-${project.updatedAt || new Date().toISOString()}`,
    summary: `已整理 ${dedupedItems.length} 份素材资产，其中 ${reusableCount} 份可直接复用。`,
    items: dedupedItems,
  };
}

function mustPreserve(character: CharacterSetting): string[] {
  const items = [character.name];
  if (character.description) {
    items.push(truncate(character.description, 48));
  }
  if (character.activeCostumeId) {
    const activeCostume = character.costumes?.find((costume) => costume.id === character.activeCostumeId);
    if (activeCostume?.label) items.push(activeCostume.label);
  }
  return unique(items.filter(Boolean));
}

function collectPropReferenceAssetIds(
  prop: VideoWorldModelProp,
  items: ProductionAssetRecord[],
): string[] {
  const normalizedLabel = normalizeName(prop.label);
  return items
    .filter((item) => {
      const haystacks = [item.label, item.meta, item.sourceEntityId]
        .map((value) => normalizeName(value))
        .filter(Boolean);
      return haystacks.some((value) => value.includes(normalizedLabel) || normalizedLabel.includes(value));
    })
    .map((item) => item.id);
}

function buildContinuityInvariants(project: PersistedVideoProject): string[] {
  const invariants = [
    "Keep character identity, costume silhouette, and face anchors stable across adjacent segments.",
    "Keep scene geography, screen direction, and primary lighting direction stable unless the script explicitly changes them.",
    "Preserve the visible state of key props, wounds, and power-up progress from one segment to the next.",
  ];
  if (project.styleLock?.visualStyle) {
    invariants.push(`Visual style anchor: ${project.styleLock.visualStyle}`);
  }
  if (project.styleLock?.tone) {
    invariants.push(`Tone anchor: ${project.styleLock.tone}`);
  }
  return unique(invariants);
}

function buildAdvancedVideoWorldModel(
  project: PersistedVideoProject,
  manifest: ProductionAssetManifest,
  synopsisSource: string,
): VideoWorldModel {
  const relationships = unique(project.scenes.flatMap((scene) => buildSceneRelationships(scene, project))).map(
    (relationship, index) => ({
      ...relationship,
      id: relationship.id || `relationship:${index + 1}`,
    }),
  );

  const propsById = new Map<string, VideoWorldModelProp>();
  const stateTimeline: VideoWorldModelStateSnapshot[] = [];
  for (const scene of [...project.scenes].sort((left, right) => left.sceneNumber - right.sceneNumber)) {
    const propStates = inferPropsFromScene(scene, project).map((prop, index) => ({
      propId: `prop:${normalizeName(prop.label).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-") || index + 1}`,
      label: prop.label,
      status: prop.status,
      ...(prop.holderCharacterId ? { holderCharacterId: prop.holderCharacterId } : {}),
    }));
    const snapshot = buildSceneStateSnapshot(scene, project, propStates);
    stateTimeline.push(snapshot);
    for (const propState of snapshot.propStates) {
      const existing = propsById.get(propState.propId);
      if (existing) {
        existing.status = propState.status || existing.status;
        existing.holderCharacterId = propState.holderCharacterId || existing.holderCharacterId;
        existing.sceneIds = unique([...existing.sceneIds, scene.id]);
        continue;
      }
      propsById.set(propState.propId, {
        id: propState.propId,
        label: propState.label,
        status: propState.status,
        holderCharacterId: propState.holderCharacterId,
        sceneIds: [scene.id],
        referenceAssetIds: [],
      });
    }
  }

  const props = [...propsById.values()].map((prop) => ({
    ...prop,
    referenceAssetIds: collectPropReferenceAssetIds(prop, manifest.items),
  }));

  const narrativeConstraints = buildNarrativeConstraints(project, stateTimeline, props);

  return {
    version: `world-${project.updatedAt || new Date().toISOString()}`,
    synopsis: truncate(synopsisSource, 220),
    continuityRules: unique([
      "Reuse approved character, scene, and storyboard assets before inventing new visual states.",
      "Carry action momentum, screen direction, lighting direction, and prop state across neighboring segments.",
      "Treat each segment as part of one continuous long-form sequence instead of isolated promo shots.",
    ]),
    characters: project.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description || "Pending character brief.",
      aliases: [],
      currentState:
        stateTimeline
          .flatMap((snapshot) => snapshot.characterStates)
          .reverse()
          .find((state) => state.characterId === character.id)
          ?.emotion || "Maintain approved anchor look.",
      constraints: mustPreserve(character),
      referenceAssetIds: buildCharacterAssetRefs(character, manifest.items),
    })),
    scenes: project.sceneSettings.map((sceneSetting) => ({
      id: sceneSetting.id,
      name: sceneSetting.name,
      description: sceneSetting.description || "Pending scene brief.",
      timeVariantLabels: (sceneSetting.timeVariants || []).map((variant) => variant.label),
      referenceAssetIds: manifest.items
        .filter(
          (item) =>
            item.sourceEntityId === sceneSetting.id &&
            (item.kind === "scene-reference" || item.kind === "time-variant"),
        )
        .map((item) => item.id),
    })),
    relationships,
    props,
    stateTimeline,
    narrativeConstraints,
    continuityInvariants: buildContinuityInvariants(project),
  };
}

function buildAdvancedVideoShotPackets(
  project: PersistedVideoProject,
  manifest: ProductionAssetManifest,
): VideoShotPacket[] {
  const worldModel = buildAdvancedVideoWorldModel(
    project,
    manifest,
    project.analysisSummary || project.outputGoal || project.productionNotes || project.script || "Pending synopsis.",
  );
  const stateBySceneId = new Map(worldModel.stateTimeline?.map((snapshot) => [snapshot.sceneId, snapshot]) ?? []);
  const propIdsBySceneId = new Map(
    [...(worldModel.stateTimeline || [])].map((snapshot) => [
      snapshot.sceneId,
      snapshot.propStates.map((propState) => propState.propId),
    ]),
  );
  const orderedScenes = [...project.scenes].sort((left, right) => left.sceneNumber - right.sceneNumber);
  return orderedScenes.map((scene, index) => {
    const matchedSetting = findSceneSetting(scene, project.sceneSettings);
    const previousScene = index > 0 ? orderedScenes[index - 1] : undefined;
    const nextScene = index < orderedScenes.length - 1 ? orderedScenes[index + 1] : undefined;
    const startSnapshot = stateBySceneId.get(scene.id);
    const endSnapshot = stateBySceneId.get(scene.id);
    const previousSnapshot = previousScene ? stateBySceneId.get(previousScene.id) : undefined;
    const nextSnapshot = nextScene ? stateBySceneId.get(nextScene.id) : undefined;

    const characterRefs = project.characters
      .filter((character) =>
        scene.characters.some((name) => normalizeName(name) === normalizeName(character.name)),
      )
      .map((character) => ({
        characterId: character.id,
        name: character.name,
        assetIds: buildCharacterAssetRefs(character, manifest.items),
        mustPreserve: mustPreserve(character),
      }));

    const backgroundAssetIds = matchedSetting
      ? manifest.items
          .filter(
            (item) =>
              item.sourceEntityId === matchedSetting.id &&
              (item.kind === "scene-reference" || item.kind === "time-variant"),
          )
          .map((item) => item.id)
      : [];

    const storyboardAssetIds = manifest.items
      .filter((item) => item.sceneId === scene.id)
      .map((item) => item.id);
    const sourceAssetIds = unique([
      ...characterRefs.flatMap((item) => item.assetIds),
      ...backgroundAssetIds,
      ...storyboardAssetIds,
      ...(previousScene
        ? manifest.items
            .filter((item) => item.sceneId === previousScene.id && item.kind === "video-segment")
            .map((item) => item.id)
        : []),
    ]);

    const requiredEntities = unique([
      ...scene.characters
        .map((name) => findCharacterBySceneName(project, name)?.id || "")
        .filter(Boolean),
      ...(matchedSetting ? [matchedSetting.id] : []),
    ]);
    const requiredProps = unique(propIdsBySceneId.get(scene.id) ?? []);
    const orderedReferenceAssetIds = unique([
      ...(previousScene
        ? manifest.items
            .filter((item) => item.sceneId === previousScene.id && item.kind === "video-segment")
            .map((item) => item.id)
        : []),
      ...(previousScene
        ? manifest.items
            .filter((item) => item.sceneId === previousScene.id && item.kind === "storyboard-frame")
            .map((item) => item.id)
        : []),
      ...storyboardAssetIds,
      ...characterRefs.flatMap((item) => item.assetIds),
      ...backgroundAssetIds,
      ...requiredProps.flatMap((propId) =>
        worldModel.props?.find((prop) => prop.id === propId)?.referenceAssetIds || [],
      ),
    ]);

    const promptSeedParts = [
      scene.description || "Continue the current dramatic action.",
      scene.dialogue ? `Dialogue audio: ${scene.dialogue}` : "",
      scene.cameraDirection ? `Camera: ${scene.cameraDirection}` : "",
      startSnapshot?.openingHook ? `Opening hook: ${startSnapshot.openingHook}` : "",
      endSnapshot?.closingHook ? `Ending hook: ${endSnapshot.closingHook}` : "",
    ].filter(Boolean);

    return {
      id: `packet:${project.id}:${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: scene.recommendedDuration || scene.duration || 5,
      camera: {
        shotSize: scene.segmentLabel ? `Segment ${scene.segmentLabel}` : "Standard shot",
        movement: scene.cameraDirection || "Carry forward the previous motion line.",
      },
      characterRefs,
      backgroundRef: matchedSetting
        ? {
            sceneSettingId: matchedSetting.id,
            name: matchedSetting.name,
            assetIds: backgroundAssetIds,
            timeVariant:
              matchedSetting.timeVariants?.find(
                (variant) =>
                  variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
              )?.label || undefined,
          }
        : undefined,
      sourceAssetIds,
      promptSeed: promptSeedParts.join("\n"),
      forbiddenChanges: unique([
        "Do not reset character identity, costume state, or prop state.",
        scene.sceneTimeVariantId ? "Do not change time-of-day or lighting continuity without story cause." : "",
      ]).filter(Boolean),
      renderMode:
        scene.storyboardUrl || backgroundAssetIds.length || characterRefs.some((item) => item.assetIds.length)
          ? "img2video"
          : "text2video",
      startState: startSnapshot
        ? `${startSnapshot.location}; ${startSnapshot.keyAction}; ${summarizeTextList(
            startSnapshot.characterStates.map((state) => `${state.name}:${state.position}/${state.emotion}`),
            "Maintain current blocking.",
          )}`
        : scene.description || scene.sceneName,
      endState: endSnapshot
        ? `${endSnapshot.closingHook || endSnapshot.keyAction}; ${summarizeTextList(
            endSnapshot.characterStates.map((state) => `${state.name}:${state.position}/${state.emotion}`),
            "Hold the strongest dramatic stop point.",
          )}`
        : scene.description || scene.sceneName,
      previousAnchor:
        previousSnapshot?.closingHook || previousScene?.description || previousScene?.sceneName || undefined,
      nextAnchor: nextSnapshot?.openingHook || nextScene?.description || nextScene?.sceneName || undefined,
      requiredEntities,
      requiredProps,
      referencePlan: {
        summary: `Prefer continuity relay, then storyboard anchors, then stable character and scene assets for scene ${scene.sceneNumber}.`,
        orderedAssetIds: orderedReferenceAssetIds,
        orderedKinds: orderedReferenceAssetIds
          .map((assetId) => manifest.items.find((item) => item.id === assetId)?.kind)
          .filter((kind): kind is string => Boolean(kind)),
        continuityFrameFirst: true,
        relayVideoPreferred: true,
      },
      generationPolicy: {
        ...DEFAULT_VIDEO_SHOT_GENERATION_POLICY,
        preferredMode:
          scene.storyboardUrl || backgroundAssetIds.length || characterRefs.some((item) => item.assetIds.length)
            ? "img2video"
            : "text2video",
      },
      qaSpec: { ...DEFAULT_VIDEO_SHOT_QA_SPEC },
      derivedConstraints: unique([
        ...(worldModel.continuityInvariants || []),
        ...(worldModel.narrativeConstraints
          ?.filter((constraint) => constraint.appliesToSceneIds.includes(scene.id))
          .map((constraint) => constraint.statement) || []),
      ]),
    };
  });
}

export function deriveVideoShotPackets(project: PersistedVideoProject): VideoShotPacket[] {
  const manifest = project.assetManifest || deriveVideoAssetManifest(project);
  if (project.scenes.length) {
    return buildAdvancedVideoShotPackets(project, manifest);
  }

  return project.scenes.map((scene) => {
    const matchedSetting = findSceneSetting(scene, project.sceneSettings);
    const characterRefs = project.characters
      .filter((character) =>
        scene.characters.some((name) => normalizeName(name) === normalizeName(character.name)),
      )
      .map((character) => ({
        characterId: character.id,
        name: character.name,
        assetIds: buildCharacterAssetRefs(character, manifest.items),
        mustPreserve: mustPreserve(character),
      }));

    const backgroundAssetIds = matchedSetting
      ? manifest.items
          .filter(
            (item) =>
              item.sourceEntityId === matchedSetting.id &&
              (item.kind === "scene-reference" || item.kind === "time-variant"),
          )
          .map((item) => item.id)
      : [];

    const sourceAssetIds = unique([
      ...characterRefs.flatMap((item) => item.assetIds),
      ...backgroundAssetIds,
      ...manifest.items
        .filter((item) => item.sceneId === scene.id)
        .map((item) => item.id),
    ]);

    return {
      id: `packet:${project.id}:${scene.id}`,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      title: scene.sceneName,
      durationSec: scene.recommendedDuration || scene.duration || 5,
      camera: {
        shotSize: scene.segmentLabel ? `片段 ${scene.segmentLabel}` : "标准镜头",
        movement: scene.cameraDirection || "待补充镜头语言",
      },
      characterRefs,
      backgroundRef: matchedSetting
        ? {
            sceneSettingId: matchedSetting.id,
            name: matchedSetting.name,
            assetIds: backgroundAssetIds,
            timeVariant:
              matchedSetting.timeVariants?.find(
                (variant) => variant.id === scene.sceneTimeVariantId || variant.id === matchedSetting.activeTimeVariantId,
              )?.label || undefined,
          }
        : undefined,
      sourceAssetIds,
      promptSeed: [
        scene.description || "待补充画面描述",
        scene.dialogue ? `对白：${scene.dialogue}` : "",
        scene.cameraDirection ? `镜头语言：${scene.cameraDirection}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      forbiddenChanges: unique([
        "不要改变主角的识别特征和服装连续性",
        scene.sceneTimeVariantId ? "不要无故修改当前镜头时间氛围" : "",
      ]).filter(Boolean),
      renderMode: scene.storyboardUrl || backgroundAssetIds.length || characterRefs.some((item) => item.assetIds.length)
        ? "img2video"
        : "text2video",
    };
  });
}

export function deriveVideoWorldModel(project: PersistedVideoProject): VideoWorldModel {
  const manifest = project.assetManifest || deriveVideoAssetManifest(project);
  const advancedSynopsisSource =
    project.analysisSummary ||
    project.outputGoal ||
    project.productionNotes ||
    project.script ||
    "Pending project synopsis.";
  if (project.sceneSettings.length || project.scenes.length || project.characters.length) {
    return buildAdvancedVideoWorldModel(project, manifest, advancedSynopsisSource);
  }
  const synopsisSource =
    project.analysisSummary ||
    project.outputGoal ||
    project.productionNotes ||
    project.script ||
    "等待补充项目概述。";

  return {
    version: `world-${project.updatedAt || new Date().toISOString()}`,
    synopsis: truncate(synopsisSource, 220),
    continuityRules: unique([
      "同一角色在连续镜头里保持外观与服装锚点一致",
      "相邻镜头沿用已确认的场景与时间变体",
      "优先复用已存在的角色图、场景图和分镜图",
    ]),
    characters: project.characters.map((character) => ({
      id: character.id,
      name: character.name,
      description: character.description || "待补充角色设定",
      aliases: [],
      currentState:
        character.activeCostumeId
          ? `当前服装：${character.costumes?.find((costume) => costume.id === character.activeCostumeId)?.label || "已锁定"}`
          : "当前以主参考形象为准",
      constraints: mustPreserve(character),
      referenceAssetIds: buildCharacterAssetRefs(character, manifest.items),
    })),
    scenes: project.sceneSettings.map((sceneSetting) => ({
      id: sceneSetting.id,
      name: sceneSetting.name,
      description: sceneSetting.description || "待补充场景设定",
      timeVariantLabels: (sceneSetting.timeVariants || []).map((variant) => variant.label),
      referenceAssetIds: manifest.items
        .filter(
          (item) =>
            item.sourceEntityId === sceneSetting.id &&
            (item.kind === "scene-reference" || item.kind === "time-variant"),
        )
        .map((item) => item.id),
    })),
  };
}

function deriveVideoReviewQueue(
  project: PersistedVideoProject,
): NonNullable<PersistedVideoProject["reviewQueue"]> {
  const existingById = new Map((project.reviewQueue ?? []).map((item) => [item.id, item]));
  const existingByTarget = new Map<string, NonNullable<PersistedVideoProject["reviewQueue"]>[number]>();
  for (const item of project.reviewQueue ?? []) {
    for (const targetId of item.targetIds) {
      existingByTarget.set(targetId, item);
    }
  }

  const now = project.updatedAt || new Date().toISOString();
  const generated = (project.shotPackets ?? [])
    .map((packet) => {
      const scene = project.scenes.find((item) => item.id === packet.sceneId);
      const hasReviewableOutput = Boolean(scene?.videoUrl?.trim()) || Boolean(packet.reviewStatus?.trim());
      if (!hasReviewableOutput) return null;

      const id = `review:${packet.id}`;
      const existing = existingById.get(id) || existingByTarget.get(packet.id);
      return {
        id,
        title: existing?.title || packet.title || scene?.sceneName || `镜头 ${packet.sceneNumber}`,
        summary:
          existing?.summary ||
          (scene?.videoUrl?.trim()
            ? "镜头已有可审阅素材，确认是否通过或需要重做。"
            : "镜头已进入审阅队列。"),
        targetIds: existing?.targetIds?.length ? existing.targetIds : [packet.id],
        status: existing?.status || packet.reviewStatus || "pending",
        createdAt: existing?.createdAt || now,
        updatedAt: existing?.updatedAt || now,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const generatedIds = new Set(generated.map((item) => item.id));
  const generatedTargets = new Set(generated.flatMap((item) => item.targetIds));
  const preserved = (project.reviewQueue ?? []).filter(
    (item) => !generatedIds.has(item.id) && !item.targetIds.some((targetId) => generatedTargets.has(targetId)),
  );

  return [...generated, ...preserved];
}

function findReferenceManifestItem(
  manifest: ProductionAssetManifest,
  params: {
    kind: ProductionAssetRecord["kind"];
    sourceEntityId: string;
    variantLabel?: string;
  },
): ProductionAssetRecord | undefined {
  return manifest.items.find((item) =>
    item.kind === params.kind &&
    item.status === "ready" &&
    item.sourceEntityId === params.sourceEntityId &&
    (!params.variantLabel || item.variantLabel === params.variantLabel) &&
    hasUsableMediaUrl(item.url),
  );
}

function deriveReferenceTargetAutomationState(
  project: PersistedVideoProject,
  manifest: ProductionAssetManifest,
  automationState: VideoAutomationState | null | undefined,
): Record<string, VideoAutomationReferenceTargetState> {
  const existingTargets = automationState?.referenceTargets || {};
  const nextTargets: Record<string, VideoAutomationReferenceTargetState> = {};
  const primaryRetryBudget = automationState?.assetPrimaryRetryBudget ?? DEFAULT_VIDEO_AUTOMATION_STATE.assetPrimaryRetryBudget;
  const variantRetryBudget = automationState?.assetVariantRetryBudget ?? DEFAULT_VIDEO_AUTOMATION_STATE.assetVariantRetryBudget;

  const resolveStatus = (
    existingState: VideoAutomationReferenceTargetState | undefined,
    params: {
      ready: boolean;
      blocked?: boolean;
    },
  ): VideoAutomationReferenceTargetState["status"] => {
    if (params.ready) return "ready";
    if (params.blocked) return "blocked";
    if (existingState?.status === "exhausted") return "exhausted";
    if (existingState?.status === "retryable") return "retryable";
    return "pending";
  };

  for (const character of project.characters) {
    const primaryTargetId = `reference-character:${character.id}`;
    const primaryManifestItem = findReferenceManifestItem(manifest, {
      kind: "character-reference",
      sourceEntityId: character.id,
    });
    const primaryUrl = hasUsableMediaUrl(character.imageUrl) ? character.imageUrl?.trim() : primaryManifestItem?.url?.trim();
    const primaryState = existingTargets[primaryTargetId];
    nextTargets[primaryTargetId] = {
      targetId: primaryTargetId,
      targetType: "character-primary",
      entityId: character.id,
      status: resolveStatus(primaryState, { ready: Boolean(primaryUrl) }),
      attemptCount: primaryState?.attemptCount || 0,
      retryBudget: primaryRetryBudget,
      dependencyTargetIds: undefined,
      lastError: primaryState?.lastError,
      lastTriedAt: primaryState?.lastTriedAt,
      lastSucceededAt: primaryUrl ? (primaryState?.lastSucceededAt || project.updatedAt) : primaryState?.lastSucceededAt,
      generatedUrl: primaryUrl || primaryState?.generatedUrl,
      qualityScore: primaryManifestItem?.qualityScore ?? primaryState?.qualityScore,
      sourceRefs: primaryManifestItem?.sourceRefs ?? primaryState?.sourceRefs,
      lastQaSummary: primaryState?.lastQaSummary,
      lastQaScore: primaryState?.lastQaScore,
      lastQaPassed: primaryState?.lastQaPassed,
      lastQaQualityTier: primaryState?.lastQaQualityTier,
      lastQaGoldenSampleVersion: primaryState?.lastQaGoldenSampleVersion,
      lastQaStrengths: primaryState?.lastQaStrengths,
      lastQaGoldenSignals: primaryState?.lastQaGoldenSignals,
      lastQaFixPriorities: primaryState?.lastQaFixPriorities,
      lastQaIssues: primaryState?.lastQaIssues,
      lastQaAt: primaryState?.lastQaAt,
    };

    for (const costume of character.costumes ?? []) {
      const targetId = `reference-character-variant:${character.id}:${costume.id}`;
      const manifestItem = findReferenceManifestItem(manifest, {
        kind: "costume-reference",
        sourceEntityId: character.id,
        variantLabel: costume.label,
      });
      const readyUrl = hasUsableMediaUrl(costume.imageUrl) ? costume.imageUrl?.trim() : manifestItem?.url?.trim();
      const existingState = existingTargets[targetId];
      const blocked = !primaryUrl;
      nextTargets[targetId] = {
        targetId,
        targetType: "character-variant",
        entityId: character.id,
        variantId: costume.id,
        status: resolveStatus(existingState, { ready: Boolean(readyUrl), blocked }),
        attemptCount: existingState?.attemptCount || 0,
        retryBudget: variantRetryBudget,
        dependencyTargetIds: [primaryTargetId],
        lastError: existingState?.lastError,
        lastTriedAt: existingState?.lastTriedAt,
        lastSucceededAt: readyUrl ? (existingState?.lastSucceededAt || project.updatedAt) : existingState?.lastSucceededAt,
        generatedUrl: readyUrl || existingState?.generatedUrl,
        qualityScore: manifestItem?.qualityScore ?? existingState?.qualityScore,
        sourceRefs: manifestItem?.sourceRefs ?? existingState?.sourceRefs ?? (primaryUrl ? [primaryUrl] : undefined),
        lastQaSummary: existingState?.lastQaSummary,
        lastQaScore: existingState?.lastQaScore,
        lastQaPassed: existingState?.lastQaPassed,
        lastQaQualityTier: existingState?.lastQaQualityTier,
        lastQaGoldenSampleVersion: existingState?.lastQaGoldenSampleVersion,
        lastQaStrengths: existingState?.lastQaStrengths,
        lastQaGoldenSignals: existingState?.lastQaGoldenSignals,
        lastQaFixPriorities: existingState?.lastQaFixPriorities,
        lastQaIssues: existingState?.lastQaIssues,
        lastQaAt: existingState?.lastQaAt,
      };
    }
  }

  for (const sceneSetting of project.sceneSettings) {
    const primaryTargetId = `reference-scene:${sceneSetting.id}`;
    const primaryManifestItem = findReferenceManifestItem(manifest, {
      kind: "scene-reference",
      sourceEntityId: sceneSetting.id,
    });
    const primaryUrl = hasUsableMediaUrl(sceneSetting.imageUrl) ? sceneSetting.imageUrl?.trim() : primaryManifestItem?.url?.trim();
    const primaryState = existingTargets[primaryTargetId];
    nextTargets[primaryTargetId] = {
      targetId: primaryTargetId,
      targetType: "scene-primary",
      entityId: sceneSetting.id,
      status: resolveStatus(primaryState, { ready: Boolean(primaryUrl) }),
      attemptCount: primaryState?.attemptCount || 0,
      retryBudget: primaryRetryBudget,
      dependencyTargetIds: undefined,
      lastError: primaryState?.lastError,
      lastTriedAt: primaryState?.lastTriedAt,
      lastSucceededAt: primaryUrl ? (primaryState?.lastSucceededAt || project.updatedAt) : primaryState?.lastSucceededAt,
      generatedUrl: primaryUrl || primaryState?.generatedUrl,
      qualityScore: primaryManifestItem?.qualityScore ?? primaryState?.qualityScore,
      sourceRefs: primaryManifestItem?.sourceRefs ?? primaryState?.sourceRefs,
      lastQaSummary: primaryState?.lastQaSummary,
      lastQaScore: primaryState?.lastQaScore,
      lastQaPassed: primaryState?.lastQaPassed,
      lastQaQualityTier: primaryState?.lastQaQualityTier,
      lastQaGoldenSampleVersion: primaryState?.lastQaGoldenSampleVersion,
      lastQaStrengths: primaryState?.lastQaStrengths,
      lastQaGoldenSignals: primaryState?.lastQaGoldenSignals,
      lastQaFixPriorities: primaryState?.lastQaFixPriorities,
      lastQaIssues: primaryState?.lastQaIssues,
      lastQaAt: primaryState?.lastQaAt,
    };

    for (const variant of sceneSetting.timeVariants ?? []) {
      const targetId = `reference-scene-variant:${sceneSetting.id}:${variant.id}`;
      const manifestItem = findReferenceManifestItem(manifest, {
        kind: "time-variant",
        sourceEntityId: sceneSetting.id,
        variantLabel: variant.label,
      });
      const readyUrl = hasUsableMediaUrl(variant.imageUrl) ? variant.imageUrl?.trim() : manifestItem?.url?.trim();
      const existingState = existingTargets[targetId];
      const blocked = !primaryUrl;
      nextTargets[targetId] = {
        targetId,
        targetType: "scene-variant",
        entityId: sceneSetting.id,
        variantId: variant.id,
        status: resolveStatus(existingState, { ready: Boolean(readyUrl), blocked }),
        attemptCount: existingState?.attemptCount || 0,
        retryBudget: variantRetryBudget,
        dependencyTargetIds: [primaryTargetId],
        lastError: existingState?.lastError,
        lastTriedAt: existingState?.lastTriedAt,
        lastSucceededAt: readyUrl ? (existingState?.lastSucceededAt || project.updatedAt) : existingState?.lastSucceededAt,
        generatedUrl: readyUrl || existingState?.generatedUrl,
        qualityScore: manifestItem?.qualityScore ?? existingState?.qualityScore,
        sourceRefs: manifestItem?.sourceRefs ?? existingState?.sourceRefs ?? (primaryUrl ? [primaryUrl] : undefined),
        lastQaSummary: existingState?.lastQaSummary,
        lastQaScore: existingState?.lastQaScore,
        lastQaPassed: existingState?.lastQaPassed,
        lastQaQualityTier: existingState?.lastQaQualityTier,
        lastQaGoldenSampleVersion: existingState?.lastQaGoldenSampleVersion,
        lastQaStrengths: existingState?.lastQaStrengths,
        lastQaGoldenSignals: existingState?.lastQaGoldenSignals,
        lastQaFixPriorities: existingState?.lastQaFixPriorities,
        lastQaIssues: existingState?.lastQaIssues,
        lastQaAt: existingState?.lastQaAt,
      };
    }
  }

  return nextTargets;
}

export function synchronizeVideoProductionState(
  project: PersistedVideoProject,
): PersistedVideoProject {
  const assetManifest = deriveVideoAssetManifest(project);
  const styleLock = project.styleLock || deriveVideoStyleLock(project);
  const worldModel = deriveVideoWorldModel({
    ...project,
    assetManifest,
  });

  return {
    ...project,
    assetManifest,
    styleLock,
    worldModel,
    shotPackets: project.shotPackets?.length
      ? deriveVideoShotPackets({
          ...project,
          assetManifest,
          styleLock,
          worldModel,
        })
      : [],
    reviewQueue: deriveVideoReviewQueue(project),
    videoAuditPackets: project.videoAuditPackets || [],
    videoRepairTasks: project.videoRepairTasks || [],
    automationState: project.automationState
      ? {
          ...DEFAULT_VIDEO_AUTOMATION_STATE,
          ...project.automationState,
          segments: {
            ...DEFAULT_VIDEO_AUTOMATION_STATE.segments,
            ...(project.automationState.segments || {}),
          },
          referenceTargets: deriveReferenceTargetAutomationState(project, assetManifest, project.automationState),
          updatedAt: project.automationState.updatedAt || new Date().toISOString(),
        }
      : {
          ...DEFAULT_VIDEO_AUTOMATION_STATE,
          referenceTargets: deriveReferenceTargetAutomationState(project, assetManifest, DEFAULT_VIDEO_AUTOMATION_STATE),
          updatedAt: new Date().toISOString(),
        },
  };
}
