import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type {
  CharacterSetting,
  ProductionAssetManifest,
  ProductionAssetRecord,
  Scene,
  SceneSetting,
  VideoShotPacket,
  VideoStyleLock,
  VideoWorldModel,
} from "@/types/project";
import {
  appendDuplicateLabelSequence,
  buildCharacterAssetLabel,
  buildSceneAssetLabel,
  buildStoryboardAssetLabel,
  buildVideoAssetLabel,
} from "./asset-naming";
import { isExpiredRemoteSignedMediaUrl } from "./media-url";

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

function hasUsableAssetUrl(url: string | undefined): boolean {
  return Boolean(url?.trim()) && !isExpiredRemoteSignedMediaUrl(url);
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

  const pushAsset = (
    asset: Omit<ProductionAssetRecord, "id" | "version" | "createdAt"> & {
      key: string;
      version?: number;
      createdAt?: string;
    },
  ) => {
    if (!hasUsableAssetUrl(asset.url) || seen.has(asset.key)) return;
    seen.add(asset.key);
    items.push({
      id: asset.key,
      kind: asset.kind,
      label: asset.label,
      url: asset.url,
      meta: asset.meta,
      reusable: asset.reusable,
      status: asset.status,
      origin: "derived",
      sourceEntityId: asset.sourceEntityId,
      sceneId: asset.sceneId,
      sceneNumber: asset.sceneNumber,
      version: asset.version ?? 1,
      createdAt: asset.createdAt ?? project.updatedAt ?? new Date().toISOString(),
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

export function deriveVideoShotPackets(project: PersistedVideoProject): VideoShotPacket[] {
  const manifest = project.assetManifest || deriveVideoAssetManifest(project);

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
    shotPackets: project.shotPackets || [],
    reviewQueue: deriveVideoReviewQueue(project),
  };
}
