import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
  ConversationProjectSnapshot,
  MaintenanceReport,
  SkillDraft,
  StudioRuntimeState,
} from "@/lib/home-agent/types";
import { getDurationConstraints } from "@/lib/drama-prompts";
import type { CharacterSetting, Scene, SceneSetting } from "@/types/project";
import { EPISODE_COUNTS, GENRES, TARGET_MARKETS } from "@/types/drama";
import {
  canSwitchToVideoWorkflowStep,
  hasAutoExportableVideoSegments,
} from "@/lib/home-agent/video-workflow-step-gates";
import { getVideoImageGenerationBatchLimit } from "@/lib/home-agent/image-models";
import { buildRecoveryActionRationale, summarizeRecoveryArtifacts } from "./home-agent-session-utils";
import { truncateCopy } from "./home-agent-task-utils";

export function buildVideoAdvanceOption(snapshot: ConversationProjectSnapshot) {
  if (snapshot.projectKind !== "video") return null;
  return {
    id: `${snapshot.projectId}-video-advance`,
    label: "让 Agent 自动推进下一步",
    value: "video:advance",
    rationale: "由 Agent 按当前项目状态自动判断下一步最合适的动作并直接推进。",
  };
}

export function buildVideoAdvanceRoundOption(snapshot: ConversationProjectSnapshot) {
  if (snapshot.projectKind !== "video") return null;
  return {
    id: `${snapshot.projectId}-video-advance-round`,
    label: "让 Agent 连续推进一轮",
    value: "video:advance-round",
    rationale: "由 Agent 在安全边界内连续推进多步，直到进入出片、轮询、审阅或修复前沿。",
  };
}

export function normalizeVideoSceneStatus(status: string | undefined): string {
  const value = String(status || "").trim().toLowerCase();
  if (!value) return "";
  if (/(queued|pending|submitted)/.test(value)) return "queued";
  if (/(completed|success|succeeded|done)/.test(value)) return "completed";
  if (/(failed|error|cancel)/.test(value)) return "failed";
  return "processing";
}

export function compareSceneOrder(a: Scene, b: Scene): number {
  const segmentA = a.segmentLabel ?? "";
  const segmentB = b.segmentLabel ?? "";
  return a.sceneNumber - b.sceneNumber || segmentA.localeCompare(segmentB, "zh-CN");
}

export function formatSceneOptionLabel(scene: Scene): string {
  return `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}`;
}

export function summarizeSceneOption(scene: Scene): string {
  const fragments = [
    scene.videoFailure?.message,
    scene.description,
    scene.cameraDirection,
    scene.dialogue,
  ]
    .map((value) => value?.trim())
    .filter(Boolean);
  return truncateCopy(fragments[0] ?? "使用当前镜头设定继续推进出片。", 88);
}

export function listGeneratableVideoScenes(project: PersistedVideoProject | null | undefined): Scene[] {
  if (!project) return [];
  return [...project.scenes].filter((scene) => {
    const status = normalizeVideoSceneStatus(scene.videoStatus);
    if (status === "queued" || status === "processing") return false;
    return !scene.videoUrl;
  }).sort(compareSceneOrder);
}

export function listFailedVideoScenes(project: PersistedVideoProject | null | undefined): Scene[] {
  if (!project) return [];
  return [...project.scenes].filter((scene) => normalizeVideoSceneStatus(scene.videoStatus) === "failed").sort(compareSceneOrder);
}

export function listRunningVideoScenes(project: PersistedVideoProject | null | undefined): Scene[] {
  if (!project) return [];
  return [...project.scenes].filter((scene) => {
    const status = normalizeVideoSceneStatus(scene.videoStatus);
    return !!scene.videoTaskId && (status === "queued" || status === "processing");
  }).sort(compareSceneOrder);
}

export function listGeneratableVideoSceneIdsForSegment(
  project: PersistedVideoProject | null | undefined,
  segmentKey: string,
): string[] {
  return listGeneratableVideoScenes(project)
    .filter((scene) => getStoryboardSegmentKey(scene) === segmentKey)
    .map((scene) => scene.id);
}

export function listGeneratableSegmentVideoLabels(
  project: PersistedVideoProject | null | undefined,
): string[] {
  if (!project?.scenes.length) return [];

  const segmentPrompts = project.segmentVideoPrompts ?? {};
  const segmentVideos = project.segmentVideos ?? {};
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  const labels: string[] = [];

  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const label = scene.segmentLabel?.trim();
    if (!label) return;
    if (!segmentPrompts[label]?.prompt?.trim()) return;
    if (segmentVideos[label]) return;
    const status = normalizeVideoSceneStatus(segmentStatuses[label]?.status);
    if (status === "queued" || status === "processing") return;
    if (!labels.includes(label)) labels.push(label);
  });

  return labels;
}

export function listFailedSegmentVideoLabels(
  project: PersistedVideoProject | null | undefined,
): string[] {
  if (!project?.scenes.length) return [];
  const labels = listGeneratableSegmentVideoLabels(project);
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  return labels.filter((label) => normalizeVideoSceneStatus(segmentStatuses[label]?.status) === "failed");
}

export function listRunningSegmentVideoLabels(
  project: PersistedVideoProject | null | undefined,
): string[] {
  if (!project?.scenes.length) return [];
  const segmentStatuses = project.segmentVideoStatuses ?? {};
  const labels: string[] = [];
  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const label = scene.segmentLabel?.trim();
    if (!label || labels.includes(label)) return;
    const status = normalizeVideoSceneStatus(segmentStatuses[label]?.status);
    if (
      (status === "queued" || status === "processing") &&
      segmentStatuses[label]?.taskId?.trim()
    ) {
      labels.push(label);
    }
  });
  return labels;
}

export function listRunningVideoSceneIdsForSegment(
  project: PersistedVideoProject | null | undefined,
  segmentKey: string,
): string[] {
  return listRunningVideoScenes(project)
    .filter((scene) => getStoryboardSegmentKey(scene) === segmentKey)
    .map((scene) => scene.id);
}

export function listCompletedVideoScenes(project: PersistedVideoProject | null | undefined): Scene[] {
  if (!project) return [];
  return [...project.scenes].filter((scene) => !!scene.videoUrl).sort(compareSceneOrder);
}

export function countStoryboardedScenes(project: PersistedVideoProject | null | undefined): number {
  if (!project) return 0;
  return project.scenes.filter((scene) => !!scene.storyboardUrl).length;
}

export function countShotPackets(project: PersistedVideoProject | null | undefined): number {
  return project?.shotPackets?.length ?? 0;
}


function filterQuestionOptions(
  question: ComposerQuestion | null,
  predicate: (value: string) => boolean,
): ComposerQuestion | null {
  if (!question) return null;

  const filterOption = (
    option: ComposerQuestion["options"][number],
  ): ComposerQuestion["options"][number] | null => {
    const hasChildOptions = Array.isArray(option.children);
    const children = hasChildOptions
      ? option.children
          ?.map((child) => filterOption(child))
          .filter((child): child is NonNullable<typeof child> => Boolean(child))
      : undefined;

    if (children && children.length > 0) {
      return {
        ...option,
        children,
      };
    }

    if (hasChildOptions) {
      if (option.value.startsWith("video:panel:")) return null;
      const { children: _children, ...optionWithoutChildren } = option;
      return predicate(option.value) ? optionWithoutChildren : null;
    }

    return predicate(option.value) ? option : null;
  };

  const options = question.options
    .map((option) => filterOption(option))
    .filter((option): option is NonNullable<typeof option> => Boolean(option));

  return options.length ? { ...question, options } : null;
}

function parseVideoEpisodeNumber(value: string): number {
  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digitMap[value[tenIndex - 1]] ?? 0;
    const ones = tenIndex === value.length - 1 ? 0 : digitMap[value[tenIndex + 1]] ?? 0;
    return tens * 10 + ones;
  }
  return value.split("").reduce((acc, char) => acc * 10 + (digitMap[char] ?? 0), 0);
}

function listVideoScriptEpisodeNumbers(script: string): number[] {
  const episodeNumbers = new Set<number>();
  const pattern = /(?:^|\n)\s*(?:EP\s*(\d+)|第\s*([零一二三四五六七八九十\d]+)\s*[集话期章]|Episode\s+(\d+))/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    const raw = match[1] || match[2] || match[3] || "";
    const episodeNumber = parseVideoEpisodeNumber(raw);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      episodeNumbers.add(episodeNumber);
    }
  }
  return [...episodeNumbers].sort((a, b) => a - b);
}

function hasIncompleteVideoEpisodeCoverage(project: PersistedVideoProject | null | undefined): boolean {
  if (!project?.scenes.length) return false;
  const scriptEpisodes = listVideoScriptEpisodeNumbers(project.script || "");
  if (scriptEpisodes.length <= 1) return false;

  const sceneEpisodes = new Set<number>();
  for (const scene of project.scenes) {
    const match = String(scene.segmentLabel || "").trim().match(/^(\d+)-/);
    if (!match) continue;
    const episodeNumber = Number(match[1]);
    if (Number.isFinite(episodeNumber) && episodeNumber > 0) {
      sceneEpisodes.add(episodeNumber);
    }
  }

  return scriptEpisodes.some((episodeNumber) => !sceneEpisodes.has(episodeNumber));
}

function shouldShowVideoBridgeOption(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
  value: string,
): boolean {
  const stage = resolveVisibleVideoStageName(snapshot.derivedStage);
  const readyReferenceIds = buildReadyReferenceIdsFromAssets(project);
  const sceneCount = project?.scenes.length ?? 0;
  const characterCount = project?.characters.length ?? 0;
  const sceneAssetCount = project?.sceneSettings.length ?? 0;
  const shotPacketCount = countShotPackets(project);
  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";

  const bootstrapReady = Boolean(
    project?.targetPlatform?.trim() &&
      project?.shotStyle?.trim(),
  );
  const hasEntities = characterCount > 0 || sceneAssetCount > 0;
  const generatableStoryboardSceneCount = countGeneratableStoryboardScenes(project, readyReferenceIds);
  const referencesReady = generatableStoryboardSceneCount > 0;
  const roleAndSceneStage = VIDEO_VISIBLE_STAGE_FLOW[1];

  if (value === "video:step:storyboard") {
    return stage !== roleAndSceneStage || generatableStoryboardSceneCount > 0;
  }

  if (value === "video:step:video") {
    return canSwitchToVideoStep(project, readyReferenceIds, 4, mode);
  }

  if (value === "video:step:preview") {
    return canSwitchToVideoStep(project, readyReferenceIds, 5, mode);
  }

  if (
    value === "video:bridge:storyboard" &&
    stage === roleAndSceneStage &&
    !(sceneCount > 0 && generatableStoryboardSceneCount > 0)
  ) {
    return false;
  }

  switch (value) {
    case "video:bridge:entities":
      return stage !== "脚本拆解" || (sceneCount > 0 && bootstrapReady);
    case "video:bridge:platform":
      return false;
    case "video:bridge:reference-assets":
      return hasEntities;
    case "video:bridge:storyboard":
      return stage !== "角色与场景" || (sceneCount > 0 && referencesReady);
    case "video:bridge:storyboard-frames":
      return countReadyStoryboardFrameScenes(project) < sceneCount;
    case "video:bridge:shots":
      // 只要有镜头拆解结果就可以编译（文生视频/图生视频均支持）
      return sceneCount > 0;
    case "video:bridge:prompts":
      // 只有在编译了镜头指令包后才显示（严格门控：必须先执行过 video:bridge:shots）
      return shotPacketCount > 0 && sceneCount > 0;
    case "video:bridge:prompts:all":
    case "video:bridge:prompts:batch":
    case "video:bridge:prompts:segment":
    case "video:bridge:prompts:segment:all":
    case "video:bridge:prompts:segment:batch":
    case "video:bridge:prompts:segment:remaining":
      // 文生视频子菜单：同样需要镜头包就绪
      return shotPacketCount > 0 && sceneCount > 0;
    default:
      // 片段提示词生成的集数/单片段选项（前缀匹配）
      if (
        value.startsWith("video:bridge:prompts:segment:episode:") ||
        value.startsWith("video:bridge:prompts:segment:label:") ||
        value.startsWith("video:bridge:prompts:segment:ep-group:")
      ) {
        return shotPacketCount > 0 && sceneCount > 0;
      }
      return true;
  }
}

type VideoVisibleStage =
  | "脚本拆解"
  | "角色与场景"
  | "分镜图生成"
  | "视频生成"
  | "预览与导出";

const VIDEO_VISIBLE_STAGE_FLOW: VideoVisibleStage[] = [
  "脚本拆解",
  "角色与场景",
  "分镜图生成",
  "视频生成",
  "预览与导出",
];

// 文生视频模式跳过分镜图生成步骤，只有4步
const TEXT_TO_VIDEO_STAGE_FLOW: VideoVisibleStage[] = [
  "脚本拆解",
  "角色与场景",
  "视频生成",
  "预览与导出",
];

function resolveVisibleVideoStageName(stage: string | null | undefined): VideoVisibleStage {
  switch (String(stage || "").trim()) {
    case "角色与场景":
      return "角色与场景";
    case "分镜图生成":
    case "分镜批次":
    case "镜头指令包":
      return "分镜图生成";
    case "视频生成":
    case "视频提示词":
    case "生成中":
      return "视频生成";
    case "预览与导出":
    case "审阅与修复":
      return "预览与导出";
    case "脚本拆解":
    default:
      return "脚本拆解";
  }
}

function getVideoPanelLayout(
  stage: string | null | undefined,
  mode?: string,
): Pick<ComposerQuestion, "stepIndex" | "totalSteps"> {
  const visibleStage = resolveVisibleVideoStageName(stage);
  const flow = mode === "text-to-video" ? TEXT_TO_VIDEO_STAGE_FLOW : VIDEO_VISIBLE_STAGE_FLOW;
  const idx = flow.indexOf(visibleStage);
  return {
    stepIndex: Math.max(idx >= 0 ? idx : VIDEO_VISIBLE_STAGE_FLOW.indexOf(visibleStage), 0),
    totalSteps: flow.length,
  };
}

function createVideoPanelOption(
  id: string,
  label: string,
  value: string,
  rationale: string,
  extras?: Partial<ComposerQuestionOption>,
): ComposerQuestionOption {
  return createStepQuestionOption(id, label, value, rationale, extras);
}

export function ensureUniqueOptionIds(options: ComposerQuestionOption[]): ComposerQuestionOption[] {
  const seenIds = new Map<string, number>();

  return options.map((option, index) => {
    const baseId = option.id?.trim() || `option-${index + 1}`;
    const duplicateCount = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, duplicateCount + 1);

    const nextId = duplicateCount === 0 ? baseId : `${baseId}--dup-${duplicateCount + 1}`;
    const nextChildren = option.children?.length ? ensureUniqueOptionIds(option.children) : option.children;

    if (nextId === option.id && nextChildren === option.children) {
      return option;
    }

    return {
      ...option,
      id: nextId,
      ...(nextChildren ? { children: nextChildren } : option.children ? { children: nextChildren } : {}),
    };
  });
}

function createVideoPanelGroup(
  snapshot: ConversationProjectSnapshot,
  groupKey: string,
  label: string,
  rationale: string,
  options: Array<ComposerQuestionOption | null | undefined | false>,
): ComposerQuestionOption | null {
  const children = ensureUniqueOptionIds(
    options.filter((option): option is ComposerQuestionOption => Boolean(option)),
  );
  if (!children.length) return null;
  return createVideoPanelOption(
    `${snapshot.projectId}-${groupKey}`,
    label,
    `video:panel:${groupKey}`,
    rationale,
    { children },
  );
}

function buildVideoCharacterReferenceChildren(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  const characters = project?.characters ?? [];
  if (!characters.length) return [];

  const missingCharacters = characters.filter((character) => !character.imageUrl?.trim());
  const primaryTargets = missingCharacters.length ? missingCharacters : characters;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-characters-all`,
      missingCharacters.length ? `补齐全部角色资产（${missingCharacters.length}）` : `刷新全部角色资产（${characters.length}）`,
      "video:bridge:reference-assets:characters",
      missingCharacters.length
        ? "只处理当前缺失角色参考图的角色，减少等待。"
        : "当前角色资产已齐，可按角色维度单独刷新。",
    ),
    ...primaryTargets.slice(0, 8).map((character) =>
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-character-${character.id}`,
        `${character.imageUrl?.trim() ? "刷新" : "生成"} ${character.name}`,
        `video:bridge:reference-assets:character:${character.id}`,
        character.description?.trim() || "单独处理这个角色的主参考图。",
      ),
    ),
  ];
}

function buildVideoSceneReferenceChildren(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  const sceneSettings = project?.sceneSettings ?? [];
  if (!sceneSettings.length) return [];

  const missingSceneSettings = sceneSettings.filter((sceneSetting) => !sceneSetting.imageUrl?.trim());
  const primaryTargets = missingSceneSettings.length ? missingSceneSettings : sceneSettings;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-scenes-all`,
      missingSceneSettings.length ? `补齐全部场景资产（${missingSceneSettings.length}）` : `刷新全部场景资产（${sceneSettings.length}）`,
      "video:bridge:reference-assets:scenes",
      missingSceneSettings.length
        ? "只处理当前缺失场景参考图的场景，方便快速推进。"
        : "当前场景资产已齐，可按场景维度单独刷新。",
    ),
    ...primaryTargets.slice(0, 8).map((sceneSetting) =>
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-scene-${sceneSetting.id}`,
        `${sceneSetting.imageUrl?.trim() ? "刷新" : "生成"} ${sceneSetting.name}`,
        `video:bridge:reference-assets:scene:${sceneSetting.id}`,
        sceneSetting.description?.trim() || "单独处理这个场景的主参考图。",
      ),
    ),
  ];
}

function normalizeVideoEntityName(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function findStoryboardSceneSetting(
  scene: Scene,
  sceneSettings: SceneSetting[],
): SceneSetting | undefined {
  const normalizedSceneName = normalizeVideoEntityName(scene.sceneName);
  return sceneSettings.find((sceneSetting) => {
    const normalizedSettingName = normalizeVideoEntityName(sceneSetting.name);
    return (
      normalizedSettingName === normalizedSceneName ||
      normalizedSceneName.includes(normalizedSettingName) ||
      normalizedSettingName.includes(normalizedSceneName)
    );
  });
}

function buildReadyReferenceIds(project: PersistedVideoProject | null | undefined) {
  const readyCharacterIds = new Set<string>();
  const readySceneIds = new Set<string>();

  (project?.characters ?? []).forEach((character) => {
    if (character.imageUrl?.trim()) readyCharacterIds.add(character.id);
  });
  (project?.sceneSettings ?? []).forEach((sceneSetting) => {
    if (sceneSetting.imageUrl?.trim()) readySceneIds.add(sceneSetting.id);
  });
  (project?.assetManifest?.items ?? []).forEach((item) => {
    if (item.kind === "character-reference" && item.status === "ready" && item.sourceEntityId) {
      readyCharacterIds.add(item.sourceEntityId);
    }
    if (item.kind === "scene-reference" && item.status === "ready" && item.sourceEntityId) {
      readySceneIds.add(item.sourceEntityId);
    }
  });

  return { readyCharacterIds, readySceneIds };
}

function buildStoryboardSceneRequirement(
  scene: Scene,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIds>,
) {
  const matchedSetting = findStoryboardSceneSetting(scene, sceneSettings);
  const hasExistingStoryboard = Boolean(scene.storyboardUrl?.trim());
  const hasPanoramaReference = Boolean(scene.panoramaUrl?.trim());

  if (hasExistingStoryboard) {
    return {
      disabled: false,
      rationale: "已有这张分镜图，可直接单独重生成这一张。",
    };
  }

  const characterMap = new Map(characters.map((character) => [normalizeVideoEntityName(character.name), character]));
  const missingCharacterRefs = (scene.characters ?? []).filter((name) => {
    const matchedCharacter = characterMap.get(normalizeVideoEntityName(name));
    return !matchedCharacter || !readyReferenceIds.readyCharacterIds.has(matchedCharacter.id);
  });

  const sceneReferenceReady = hasPanoramaReference || (matchedSetting ? readyReferenceIds.readySceneIds.has(matchedSetting.id) : false);
  const missingParts: string[] = [];

  if (missingCharacterRefs.length > 0) {
    missingParts.push(`缺少角色参考图：${missingCharacterRefs.join("、")}`);
  }
  if (!sceneReferenceReady) {
    missingParts.push(`缺少场景参考图：${matchedSetting?.name || scene.sceneName}`);
  }

  if (missingParts.length > 0) {
    return {
      disabled: true,
      rationale: `${missingParts.join("；")}。先去《角色和场景》补齐后再回来生成。`,
    };
  }

  return {
    disabled: false,
    rationale: scene.description?.trim()
      ? truncateCopy(scene.description.trim(), 88)
      : "基础角色和场景素材已齐，可以单独生成这一张分镜图。",
  };
}

function buildStoryboardFrameSceneChildren(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  if (!project?.scenes.length) return [];

  const readyReferenceIds = buildReadyReferenceIds(project);
  const sceneGroups = new Map<string, Scene[]>();

  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const groupLabel = scene.segmentLabel?.trim() ? `片段 ${scene.segmentLabel.trim()}` : "未分组镜头";
    const group = sceneGroups.get(groupLabel) ?? [];
    group.push(scene);
    sceneGroups.set(groupLabel, group);
  });

  return Array.from(sceneGroups.entries()).map(([groupLabel, scenes]) => {
    const blockedCount = scenes.filter((scene) => buildStoryboardSceneRequirement(
      scene,
      project.characters ?? [],
      project.sceneSettings ?? [],
      readyReferenceIds,
    ).disabled).length;

    return createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-storyboard-frames-group-${groupLabel}`,
      `${groupLabel}（${scenes.length}）`,
      `video:bridge:storyboard-frames:group:${encodeURIComponent(groupLabel)}`,
      blockedCount > 0
        ? `共 ${scenes.length} 个镜头，其中 ${blockedCount} 个还缺基础素材。`
        : `共 ${scenes.length} 个镜头，均可单独生成或重生成。`,
      {
        children: scenes.map((scene) => {
          const requirement = buildStoryboardSceneRequirement(
            scene,
            project.characters ?? [],
            project.sceneSettings ?? [],
            readyReferenceIds,
          );

          return createVideoPanelOption(
            `${snapshot.projectId}-video-bridge-storyboard-frame-${scene.id}`,
            `${scene.storyboardUrl?.trim() ? "重生成" : "生成"} ${formatSceneOptionLabel(scene)}`,
            `video:bridge:storyboard-frame:scene:${scene.id}`,
            requirement.rationale,
            { disabled: requirement.disabled },
          );
        }),
      },
    );
  });
}

function buildReadyReferenceIdsFromAssets(project: PersistedVideoProject | null | undefined) {
  const readyCharacterIds = new Set<string>();
  const readySceneIds = new Set<string>();

  (project?.characters ?? []).forEach((character) => {
    const activeCostume = character.costumes?.find((costume) => costume.id === character.activeCostumeId);
    if (character.imageUrl?.trim() || activeCostume?.imageUrl?.trim()) {
      readyCharacterIds.add(character.id);
    }
  });

  (project?.sceneSettings ?? []).forEach((sceneSetting) => {
    const activeTimeVariant = sceneSetting.timeVariants?.find((variant) => variant.id === sceneSetting.activeTimeVariantId);
    if (sceneSetting.imageUrl?.trim() || activeTimeVariant?.imageUrl?.trim()) {
      readySceneIds.add(sceneSetting.id);
    }
  });

  (project?.assetManifest?.items ?? []).forEach((item) => {
    if (
      (item.kind === "character-reference" || item.kind === "costume-reference")
      && item.status === "ready"
      && item.sourceEntityId
    ) {
      readyCharacterIds.add(item.sourceEntityId);
    }

    if (
      (item.kind === "scene-reference" || item.kind === "time-variant")
      && item.status === "ready"
      && item.sourceEntityId
    ) {
      readySceneIds.add(item.sourceEntityId);
    }
  });

  return { readyCharacterIds, readySceneIds };
}

function hasPrimaryCharacterReference(
  project: PersistedVideoProject | null | undefined,
  character: CharacterSetting,
): boolean {
  if (character.imageUrl?.trim()) return true;
  return Boolean(
    project?.assetManifest?.items.some((item) =>
      item.kind === "character-reference" &&
      item.status === "ready" &&
      item.sourceEntityId === character.id,
    ),
  );
}

function hasPrimarySceneReference(
  project: PersistedVideoProject | null | undefined,
  sceneSetting: SceneSetting,
): boolean {
  if (sceneSetting.imageUrl?.trim()) return true;
  return Boolean(
    project?.assetManifest?.items.some((item) =>
      item.kind === "scene-reference" &&
      item.status === "ready" &&
      item.sourceEntityId === sceneSetting.id,
    ),
  );
}

export function listVideoReferenceAssetTargetIds(
  project: PersistedVideoProject | null | undefined,
  options?: { includeReady?: boolean; includeVariants?: boolean },
): string[] {
  const includeReady = options?.includeReady === true;
  const includeVariants = options?.includeVariants !== false;
  const targetIds: string[] = [];

  for (const character of project?.characters ?? []) {
    const hasPrimaryReference = hasPrimaryCharacterReference(project, character);
    if (includeReady || !hasPrimaryReference) {
      targetIds.push(`reference-character:${character.id}`);
    }

    if (includeVariants) {
      for (const variant of character.costumes ?? []) {
        if (includeReady || !variant.imageUrl?.trim()) {
          targetIds.push(`reference-character-variant:${character.id}:${variant.id}`);
        }
      }
    }
  }

  for (const sceneSetting of project?.sceneSettings ?? []) {
    const hasPrimaryReference = hasPrimarySceneReference(project, sceneSetting);
    if (includeReady || !hasPrimaryReference) {
      targetIds.push(`reference-scene:${sceneSetting.id}`);
    }

    if (includeVariants) {
      for (const variant of sceneSetting.timeVariants ?? []) {
        if (includeReady || !variant.imageUrl?.trim()) {
          targetIds.push(`reference-scene-variant:${sceneSetting.id}:${variant.id}`);
        }
      }
    }
  }

  return targetIds;
}

function buildCharacterVariantChildren(
  snapshot: ConversationProjectSnapshot,
  character: CharacterSetting,
  hasPrimaryReference: boolean,
): ComposerQuestionOption[] {
  const variants = character.costumes ?? [];
  if (!variants.length) return [];

  const missingVariantCount = variants.filter((variant) => !variant.imageUrl?.trim()).length;
  const allVariantsReady = missingVariantCount === 0;
  const baseWarning = `缺少角色主参考图《${character.name}》，先生成主参考图后再处理变体。`;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-character-main-${character.id}`,
      hasPrimaryReference ? "重新生成主参考图" : "先生成主参考图",
      `video:bridge:reference-assets:character-main:${character.id}`,
      hasPrimaryReference
        ? "角色主参考图已生成，可继续重新生成。"
        : "先补角色主参考图，再去生成或重生成下方变体。",
    ),
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-character-variants-${character.id}`,
      allVariantsReady ? `重新生成全部角色变体（${variants.length}）` : `补齐全部角色变体（${missingVariantCount}）`,
      `video:bridge:reference-assets:character-variants:${character.id}`,
      hasPrimaryReference
        ? (allVariantsReady ? "当前角色变体已齐，可整组重新生成。" : "只补当前缺图的角色变体。")
        : baseWarning,
      { disabled: !hasPrimaryReference },
    ),
    ...variants.map((variant) =>
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-character-variant-${character.id}-${variant.id}`,
        (variant.imageUrl?.trim() ? "重生成 " : "") + (variant.label?.trim() || "未命名角色变体"),
        `video:bridge:reference-assets:character-variant:${character.id}:${variant.id}`,
        hasPrimaryReference
          ? [
              variant.imageUrl?.trim() ? "该角色变体已生成，可继续重新生成。" : "单独生成这个角色变体。",
              variant.description?.trim() || "",
            ].filter(Boolean).join(" ")
          : baseWarning,
        { disabled: !hasPrimaryReference },
      ),
    ),
  ];
}

function buildSceneVariantChildren(
  snapshot: ConversationProjectSnapshot,
  sceneSetting: SceneSetting,
  hasPrimaryReference: boolean,
): ComposerQuestionOption[] {
  const variants = sceneSetting.timeVariants ?? [];
  if (!variants.length) return [];

  const missingVariantCount = variants.filter((variant) => !variant.imageUrl?.trim()).length;
  const allVariantsReady = missingVariantCount === 0;
  const baseWarning = `缺少场景主参考图《${sceneSetting.name}》，先生成主参考图后再处理变体。`;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-scene-main-${sceneSetting.id}`,
      hasPrimaryReference ? "重新生成主参考图" : "先生成主参考图",
      `video:bridge:reference-assets:scene-main:${sceneSetting.id}`,
      hasPrimaryReference
        ? "场景主参考图已生成，可继续重新生成。"
        : "先补场景主参考图，再去生成或重生成下方变体。",
    ),
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-scene-variants-${sceneSetting.id}`,
      allVariantsReady ? `重新生成全部场景变体（${variants.length}）` : `补齐全部场景变体（${missingVariantCount}）`,
      `video:bridge:reference-assets:scene-variants:${sceneSetting.id}`,
      hasPrimaryReference
        ? (allVariantsReady ? "当前场景变体已齐，可整组重新生成。" : "只补当前缺图的场景变体。")
        : baseWarning,
      { disabled: !hasPrimaryReference },
    ),
    ...variants.map((variant) =>
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-scene-variant-${sceneSetting.id}-${variant.id}`,
        (variant.imageUrl?.trim() ? "重生成 " : "") + (variant.label?.trim() || "未命名场景变体"),
        `video:bridge:reference-assets:scene-variant:${sceneSetting.id}:${variant.id}`,
        hasPrimaryReference
          ? [
              variant.imageUrl?.trim() ? "该场景变体已生成，可继续重新生成。" : "单独生成这个场景变体。",
              variant.description?.trim() || "",
            ].filter(Boolean).join(" ")
          : baseWarning,
        { disabled: !hasPrimaryReference },
      ),
    ),
  ];
}

function buildVideoCharacterReferenceChildrenV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
): ComposerQuestionOption[] {
  const characters = project?.characters ?? [];
  if (!characters.length) return [];

  const missingCharacters = characters.filter((character) => !readyReferenceIds.readyCharacterIds.has(character.id));
  const totalCount = missingCharacters.length ? missingCharacters.length : characters.length;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-characters-all`,
      missingCharacters.length ? `补齐全部角色素材（${totalCount}）` : `刷新全部角色素材（${totalCount}）`,
      "video:bridge:reference-assets:characters",
      missingCharacters.length ? "只处理缺图角色。" : "批量刷新角色素材。",
    ),
    ...characters.slice(0, 8).map((character) => {
      const hasPrimaryReference = hasPrimaryCharacterReference(project, character);
      const variants = buildCharacterVariantChildren(snapshot, character, hasPrimaryReference);
      const variantCount = character.costumes?.length ?? 0;

      return createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-character-${character.id}`,
        (hasPrimaryReference ? "重生成 " : "") + (character.name?.trim() || "Unnamed character"),
        `video:bridge:reference-assets:character:${character.id}`,
        variantCount
          ? hasPrimaryReference
            ? `角色主参考图已就绪；识别到 ${variantCount} 个角色变体，进入后可继续选择主图或变体生成。`
            : `尚未生成角色主参考图；已识别到 ${variantCount} 个角色变体，进入后会提示先生成主参考图。`
          : hasPrimaryReference
            ? "角色主参考图已生成，可继续重新生成。"
            : (character.description?.trim() || "单独生成这个角色的主参考图。"),
        variants.length ? { children: variants } : undefined,
      );
    }),
  ];
}

function buildVideoSceneReferenceChildrenV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
): ComposerQuestionOption[] {
  const sceneSettings = project?.sceneSettings ?? [];
  if (!sceneSettings.length) return [];

  const missingSceneSettings = sceneSettings.filter((sceneSetting) => !readyReferenceIds.readySceneIds.has(sceneSetting.id));
  const totalCount = missingSceneSettings.length ? missingSceneSettings.length : sceneSettings.length;

  return [
    createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-reference-assets-scenes-all`,
      missingSceneSettings.length ? `补齐全部场景素材（${totalCount}）` : `刷新全部场景素材（${totalCount}）`,
      "video:bridge:reference-assets:scenes",
      missingSceneSettings.length ? "只处理缺图场景。" : "批量刷新场景素材。",
    ),
    ...sceneSettings.slice(0, 8).map((sceneSetting) => {
      const hasPrimaryReference = hasPrimarySceneReference(project, sceneSetting);
      const variants = buildSceneVariantChildren(snapshot, sceneSetting, hasPrimaryReference);
      const variantCount = sceneSetting.timeVariants?.length ?? 0;

      return createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-reference-assets-scene-${sceneSetting.id}`,
        (hasPrimaryReference ? "重生成 " : "") + (sceneSetting.name?.trim() || "Unnamed scene"),
        `video:bridge:reference-assets:scene:${sceneSetting.id}`,
        variantCount
          ? hasPrimaryReference
            ? `场景主参考图已就绪；识别到 ${variantCount} 个场景变体，进入后可继续选择主图或变体生成。`
            : `尚未生成场景主参考图；已识别到 ${variantCount} 个场景变体，进入后会提示先生成主参考图。`
          : hasPrimaryReference
            ? "场景主参考图已生成，可继续重新生成。"
            : (sceneSetting.description?.trim() || "单独生成这个场景的主参考图。"),
        variants.length ? { children: variants } : undefined,
      );
    }),
  ];
}

const UNGROUPED_STORYBOARD_SEGMENT_KEY = "__ungrouped__";

export function getStoryboardSegmentKey(scene: Pick<Scene, "segmentLabel">): string {
  const segmentLabel = scene.segmentLabel?.trim();
  return segmentLabel || UNGROUPED_STORYBOARD_SEGMENT_KEY;
}

function formatStoryboardSegmentLabel(segmentKey: string): string {
  return segmentKey === UNGROUPED_STORYBOARD_SEGMENT_KEY ? "未分组镜头" : `片段 ${segmentKey}`;
}

const EPISODE_SEGMENT_RE = /^(\d+)-(\d+)$/;

function buildSegmentPromptChildren(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  if (!project?.scenes.length) return [];

  const segmentVideoPrompts = project.segmentVideoPrompts ?? {};

  const episodeMap = new Map<string, string[]>();
  const episodeOrder: string[] = [];

  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const segKey = scene.segmentLabel?.trim();
    if (!segKey || !EPISODE_SEGMENT_RE.test(segKey)) return;
    const episodeKey = EPISODE_SEGMENT_RE.exec(segKey)![1];
    if (!episodeMap.has(episodeKey)) {
      episodeMap.set(episodeKey, []);
      episodeOrder.push(episodeKey);
    }
    const segs = episodeMap.get(episodeKey)!;
    if (!segs.includes(segKey)) segs.push(segKey);
  });

  return episodeOrder.map((episodeKey) => {
    const segKeys = episodeMap.get(episodeKey)!;
    const encodedEpisode = encodeURIComponent(episodeKey);
    const allDone = segKeys.every((k) => Boolean(segmentVideoPrompts[k]?.prompt?.trim()));

    const segmentChildren: ComposerQuestionOption[] = [
      {
        id: `${snapshot.projectId}-seg-prompt-ep-${episodeKey}-all`,
        label: `第 ${episodeKey} 集全部片段`,
        value: `video:bridge:prompts:segment:episode:${encodedEpisode}`,
        rationale: `生成第 ${episodeKey} 集所有片段的合并提示词。`,
      },
      ...segKeys.map((segKey) => {
        const hasPrompt = Boolean(segmentVideoPrompts[segKey]?.prompt?.trim());
        const sceneCount = project.scenes.filter((s) => s.segmentLabel?.trim() === segKey).length;
        return {
          id: `${snapshot.projectId}-seg-prompt-label-${segKey}`,
          label: hasPrompt ? `片段 ${segKey}（重新生成）` : `片段 ${segKey}（${sceneCount} 个分镜）`,
          value: `video:bridge:prompts:segment:label:${encodeURIComponent(segKey)}`,
          rationale: hasPrompt
            ? `重新生成片段 ${segKey} 的合并提示词。`
            : `生成片段 ${segKey} 的合并提示词（含 ${sceneCount} 个分镜）。`,
        };
      }),
    ];

    return {
      id: `${snapshot.projectId}-seg-prompt-ep-${episodeKey}`,
      label: allDone ? `第 ${episodeKey} 集（已全部生成）` : `第 ${episodeKey} 集`,
      value: `video:bridge:prompts:segment:ep-group:${encodedEpisode}`,
      rationale: `展开查看第 ${episodeKey} 集的片段提示词生成选项。`,
      children: segmentChildren,
    };
  });
}

function buildStoryboardSceneRequirementV2(
  scene: Scene,
  characters: CharacterSetting[],
  sceneSettings: SceneSetting[],
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
) {
  const matchedSetting = findStoryboardSceneSetting(scene, sceneSettings);
  const hasExistingStoryboard = Boolean(scene.storyboardUrl?.trim());
  const hasPanoramaReference = Boolean(scene.panoramaUrl?.trim());

  if (hasExistingStoryboard) {
    return { disabled: false, rationale: "" };
  }

  const characterMap = new Map(characters.map((character) => [normalizeVideoEntityName(character.name), character]));
  const missingCharacterRefs = (scene.characters ?? []).filter((name) => {
    const matchedCharacter = characterMap.get(normalizeVideoEntityName(name));
    return !matchedCharacter || !readyReferenceIds.readyCharacterIds.has(matchedCharacter.id);
  });

  const sceneReferenceReady =
    hasPanoramaReference || (matchedSetting ? readyReferenceIds.readySceneIds.has(matchedSetting.id) : false);
  const missingParts: string[] = [];

  if (missingCharacterRefs.length > 0) {
    missingParts.push(`角色主参考图《${missingCharacterRefs.join("》《")}》`);
  }

  if (!sceneReferenceReady) {
    missingParts.push(`场景主参考图《${matchedSetting?.name || scene.sceneName}》`);
  }

  if (missingParts.length > 0) {
    return {
      disabled: true,
      rationale: `缺失必要素材：${missingParts.join("；")}`,
    };
  }

  return { disabled: false, rationale: "" };
}

export function listGeneratableStoryboardSceneIdsForSegment(
  project: PersistedVideoProject | null | undefined,
  segmentKey: string,
): string[] {
  if (!project?.scenes.length) return [];

  const readyReferenceIds = buildReadyReferenceIdsFromAssets(project);
  return [...project.scenes]
    .filter((scene) => getStoryboardSegmentKey(scene) === segmentKey)
    .filter((scene) => !buildStoryboardSceneRequirementV2(
      scene,
      project.characters ?? [],
      project.sceneSettings ?? [],
      readyReferenceIds,
    ).disabled)
    .sort(compareSceneOrder)
    .map((scene) => scene.id);
}

function buildStoryboardFrameSceneChildrenV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
): ComposerQuestionOption[] {
  if (!project?.scenes.length) return [];

  // 按集号分组，再按片段分组，对齐片段提示词生成的层级结构
  const episodeMap = new Map<string, string[]>();
  const episodeOrder: string[] = [];
  const segmentScenes = new Map<string, Scene[]>();

  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const segmentKey = getStoryboardSegmentKey(scene);
    const match = EPISODE_SEGMENT_RE.exec(segmentKey);
    const episodeKey = match ? match[1] : segmentKey;
    if (!episodeMap.has(episodeKey)) {
      episodeMap.set(episodeKey, []);
      episodeOrder.push(episodeKey);
    }
    const segs = episodeMap.get(episodeKey)!;
    if (!segs.includes(segmentKey)) segs.push(segmentKey);
    const group = segmentScenes.get(segmentKey) ?? [];
    group.push(scene);
    segmentScenes.set(segmentKey, group);
  });

  return episodeOrder.map((episodeKey) => {
    const segKeys = episodeMap.get(episodeKey)!;
    const encodedEpisode = encodeURIComponent(episodeKey);

    const allEpisodeScenes = segKeys.flatMap((k) => segmentScenes.get(k) ?? []);
    const allEpisodeRequirements = allEpisodeScenes.map((scene) => ({
      scene,
      requirement: buildStoryboardSceneRequirementV2(
        scene,
        project.characters ?? [],
        project.sceneSettings ?? [],
        readyReferenceIds,
      ),
    }));
    const episodeSelectable = allEpisodeRequirements.filter(({ requirement }) => !requirement.disabled);
    const episodeBlocked = allEpisodeRequirements.length - episodeSelectable.length;

    const segmentChildren: ComposerQuestionOption[] = [
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-storyboard-ep-all-${episodeKey}`,
        episodeSelectable.length
          ? `生成第 ${episodeKey} 集全部可选分镜（${episodeSelectable.length}）`
          : `第 ${episodeKey} 集暂无可生成分镜`,
        `video:bridge:storyboard-frames:episode:${encodedEpisode}`,
        episodeBlocked > 0 ? `缺素材 ${episodeBlocked} 个` : "",
        { disabled: episodeSelectable.length === 0 },
      ),
      ...segKeys.map((segmentKey) => {
        const scenes = segmentScenes.get(segmentKey) ?? [];
        const groupLabel = formatStoryboardSegmentLabel(segmentKey);
        const sceneRequirements = scenes.map((scene) => ({
          scene,
          requirement: buildStoryboardSceneRequirementV2(
            scene,
            project.characters ?? [],
            project.sceneSettings ?? [],
            readyReferenceIds,
          ),
        }));
        const selectableScenes = sceneRequirements.filter(({ requirement }) => !requirement.disabled);
        const blockedCount = sceneRequirements.length - selectableScenes.length;

        return createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-storyboard-frames-group-${groupLabel}`,
          `${groupLabel}（${scenes.length}）`,
          `video:bridge:storyboard-frames:group:${encodeURIComponent(segmentKey)}`,
          blockedCount > 0 ? `缺素材 ${blockedCount} 个` : "",
          {
            children: [
              createVideoPanelOption(
                `${snapshot.projectId}-video-bridge-storyboard-segment-generate-${segmentKey}`,
                selectableScenes.length
                  ? `生成本片段全部可选分镜（${selectableScenes.length}）`
                  : "本片段暂无可生成分镜",
                `video:bridge:storyboard-frames:segment:${encodeURIComponent(segmentKey)}`,
                blockedCount > 0 ? `缺素材 ${blockedCount} 个` : "",
                { disabled: selectableScenes.length === 0 },
              ),
              ...sceneRequirements.map(({ scene, requirement }) => createVideoPanelOption(
                `${snapshot.projectId}-video-bridge-storyboard-frame-${scene.id}`,
                `${scene.storyboardUrl?.trim() ? "重生成" : "生成"} ${formatSceneOptionLabel(scene)}`,
                `video:bridge:storyboard-frame:scene:${scene.id}`,
                requirement.disabled ? requirement.rationale : "",
                { disabled: requirement.disabled },
              )),
            ],
          },
        );
      }),
    ];

    const episodeAllDone = segKeys.every((k) => {
      const scenes = segmentScenes.get(k) ?? [];
      return scenes.every((s) => Boolean(s.storyboardUrl?.trim()));
    });

    return createVideoPanelOption(
      `${snapshot.projectId}-video-bridge-storyboard-ep-${episodeKey}`,
      episodeAllDone ? `第 ${episodeKey} 集（已全部生成）` : `第 ${episodeKey} 集`,
      `video:bridge:storyboard-frames:ep-group:${encodedEpisode}`,
      episodeBlocked > 0 ? `缺素材 ${episodeBlocked} 个` : "",
      { children: segmentChildren },
    );
  });
}

function buildVideoSceneActionChildrenV2(
  snapshot: ConversationProjectSnapshot,
  scenes: Scene[],
  params: {
    optionIdPrefix: string;
    groupValuePrefix: string;
    segmentValuePrefix: string;
    sceneValuePrefix: string;
    groupRationale: (count: number) => string;
    segmentLabel: (count: number) => string;
    segmentRationale: (count: number) => string;
    sceneActionLabel: string;
  },
): ComposerQuestionOption[] {
  if (!scenes.length) return [];

  const sceneGroups = new Map<string, Scene[]>();

  [...scenes].sort(compareSceneOrder).forEach((scene) => {
    const segmentKey = getStoryboardSegmentKey(scene);
    const group = sceneGroups.get(segmentKey) ?? [];
    group.push(scene);
    sceneGroups.set(segmentKey, group);
  });

  return Array.from(sceneGroups.entries()).map(([segmentKey, groupedScenes]) => {
    const encodedSegmentKey = encodeURIComponent(segmentKey);
    const groupLabel = formatStoryboardSegmentLabel(segmentKey);

    return createVideoPanelOption(
      `${snapshot.projectId}-${params.optionIdPrefix}-group-${segmentKey}`,
      `${groupLabel}\uFF08${groupedScenes.length}\uFF09`,
      `${params.groupValuePrefix}${encodedSegmentKey}`,
      params.groupRationale(groupedScenes.length),
      {
        children: [
          createVideoPanelOption(
            `${snapshot.projectId}-${params.optionIdPrefix}-segment-${segmentKey}`,
            params.segmentLabel(groupedScenes.length),
            `${params.segmentValuePrefix}${encodedSegmentKey}`,
            params.segmentRationale(groupedScenes.length),
          ),
          ...groupedScenes.map((scene) => createVideoPanelOption(
            `${snapshot.projectId}-${params.optionIdPrefix}-scene-${scene.id}`,
            `${params.sceneActionLabel} ${formatSceneOptionLabel(scene)}`,
            `${params.sceneValuePrefix}${scene.id}`,
            summarizeSceneOption(scene),
          )),
        ],
      },
    );
  });
}

function buildGeneratableVideoSceneChildrenV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  return buildVideoSceneActionChildrenV2(snapshot, listGeneratableVideoScenes(project), {
    optionIdPrefix: "video-generate",
    groupValuePrefix: "video:generate:group:",
    segmentValuePrefix: "video:generate:segment:",
    sceneValuePrefix: "video:generate:scene:",
    groupRationale: (count) => `\u5f53\u524d\u7247\u6bb5\u6709 ${count} \u4e2a\u53ef\u7ee7\u7eed\u51fa\u7247\u7684\u955c\u5934\u3002`,
    segmentLabel: (count) => `\u51fa\u7247\u672c\u7247\u6bb5\u5168\u90e8\u53ef\u9009\u955c\u5934\uFF08${count}\uFF09`,
    segmentRationale: () => "\u53ea\u4f1a\u63d0\u4ea4\u5f53\u524d\u7247\u6bb5\u91cc\u53ef\u7ee7\u7eed\u51fa\u7247\u7684\u955c\u5934\u3002",
    sceneActionLabel: "\u51fa\u7247",
  });
}


function hasReadyStoryboardFrameSceneV2(
  project: PersistedVideoProject | null | undefined,
  scene: Scene,
): boolean {
  if (scene.storyboardUrl?.trim()) return true;

  return (project?.assetManifest?.items ?? []).some(
    (item) => item.kind === "storyboard-frame" && item.status === "ready" && item.sceneId === scene.id,
  );
}

function buildVideoGenerationSceneRequirementV2(
  scene: Scene,
  project: PersistedVideoProject | null | undefined,
) {
  const status = normalizeVideoSceneStatus(scene.videoStatus);

  if (status === "queued" || status === "processing") {
    return {
      disabled: true,
      rationale: "当前镜头正在生成中，请先轮询这一条的最新结果。",
    };
  }

  if (!hasReadyStoryboardFrameSceneV2(project, scene)) {
    // 有视频提示词时降级为文生视频，无需分镜图
    if (scene.enhancedVideoPrompt?.trim()) {
      return {
        disabled: false,
        rationale: "文生视频模式：将使用视频提示词直接出片。",
      };
    }
    return {
      disabled: true,
      rationale: `缺失必要素材：分镜图《${scene.sceneName || `镜头 ${scene.sceneNumber}`}》`,
    };
  }

  if (scene.videoUrl?.trim()) {
    return {
      disabled: false,
      rationale: "已有已生成视频，可继续重新生成。",
    };
  }

  if (status === "failed") {
    return {
      disabled: false,
      rationale: scene.videoFailure?.message?.trim() || "当前镜头上次出片失败，可直接重新生成。",
    };
  }

  return {
    disabled: false,
    rationale: summarizeSceneOption(scene),
  };
}

function buildVideoGenerationActionLabel(scene: Scene): string {
  const status = normalizeVideoSceneStatus(scene.videoStatus);
  if (status === "queued" || status === "processing") return "生成中";
  if (scene.videoUrl?.trim() || status === "failed") return "重新生成";
  return "出片";
}

export function listSelectableVideoSceneIdsForSegment(
  project: PersistedVideoProject | null | undefined,
  segmentKey: string,
): string[] {
  if (!project?.scenes.length) return [];

  return [...project.scenes]
    .filter((scene) => getStoryboardSegmentKey(scene) === segmentKey)
    .filter((scene) => !buildVideoGenerationSceneRequirementV2(scene, project).disabled)
    .sort(compareSceneOrder)
    .map((scene) => scene.id);
}

function buildTargetedVideoGenerationChildrenV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption[] {
  if (!project?.scenes.length) return [];

  const segmentVideoPrompts = project.segmentVideoPrompts ?? {};

  // 按集号分组，再按片段分组，对齐片段提示词生成的层级结构
  const episodeMap = new Map<string, string[]>();
  const episodeOrder: string[] = [];
  const segmentScenes = new Map<string, Scene[]>();

  [...project.scenes].sort(compareSceneOrder).forEach((scene) => {
    const segmentKey = getStoryboardSegmentKey(scene);
    const match = EPISODE_SEGMENT_RE.exec(segmentKey);
    const episodeKey = match ? match[1] : segmentKey;
    if (!episodeMap.has(episodeKey)) {
      episodeMap.set(episodeKey, []);
      episodeOrder.push(episodeKey);
    }
    const segs = episodeMap.get(episodeKey)!;
    if (!segs.includes(segmentKey)) segs.push(segmentKey);
    const group = segmentScenes.get(segmentKey) ?? [];
    group.push(scene);
    segmentScenes.set(segmentKey, group);
  });

  return episodeOrder.map((episodeKey) => {
    const segKeys = episodeMap.get(episodeKey)!;
    const encodedEpisode = encodeURIComponent(episodeKey);

    const allEpisodeScenes = segKeys.flatMap((k) => segmentScenes.get(k) ?? []);
    const allEpisodeRequirements = allEpisodeScenes.map((scene) => ({
      scene,
      requirement: buildVideoGenerationSceneRequirementV2(scene, project),
    }));
    const episodeSelectable = allEpisodeRequirements.filter(({ requirement }) => !requirement.disabled);
    const episodeBlocked = allEpisodeRequirements.length - episodeSelectable.length;

    const segmentChildren: ComposerQuestionOption[] = [
      createVideoPanelOption(
        `${snapshot.projectId}-video-generate-ep-all-${episodeKey}`,
        episodeSelectable.length
          ? `出片第 ${episodeKey} 集全部可选镜头（${episodeSelectable.length}）`
          : `第 ${episodeKey} 集暂无可出片镜头`,
        `video:generate:episode:${encodedEpisode}`,
        episodeBlocked > 0 ? `缺素材 ${episodeBlocked} 个` : "",
        { disabled: episodeSelectable.length === 0 },
      ),
      ...segKeys.map((segmentKey) => {
        const groupedScenes = segmentScenes.get(segmentKey) ?? [];
        const encodedSegmentKey = encodeURIComponent(segmentKey);
        const groupLabel = formatStoryboardSegmentLabel(segmentKey);
        const sceneRequirements = groupedScenes.map((scene) => ({
          scene,
          requirement: buildVideoGenerationSceneRequirementV2(scene, project),
        }));
        const selectableScenes = sceneRequirements.filter(({ requirement }) => !requirement.disabled);
        const blockedCount = sceneRequirements.length - selectableScenes.length;

        const segmentPrompt = segmentVideoPrompts[segmentKey];
        const hasSegmentPrompt = Boolean(segmentPrompt?.prompt?.trim());
        const effectiveDuration = segmentPrompt?.duration ?? 15;
        const hasSegmentVideo = Boolean(project.segmentVideos?.[segmentKey]);

        return createVideoPanelOption(
          `${snapshot.projectId}-video-generate-group-${segmentKey}`,
          `${groupLabel}（${groupedScenes.length}）`,
          `video:generate:group:${encodedSegmentKey}`,
          blockedCount > 0 ? `缺素材 ${blockedCount} 个` : "",
          {
            children: [
              createVideoPanelOption(
                `${snapshot.projectId}-video-generate-segment-${segmentKey}`,
                selectableScenes.length
                  ? `出片本片段全部可选镜头（${selectableScenes.length}）`
                  : "本片段暂无可出片镜头",
                `video:generate:segment:${encodedSegmentKey}`,
                blockedCount > 0 ? `缺素材 ${blockedCount} 个` : "",
                { disabled: selectableScenes.length === 0 },
              ),
              createVideoPanelOption(
                `${snapshot.projectId}-video-generate-segment-video-${segmentKey}`,
                hasSegmentVideo
                  ? `重新生成片段视频（${segmentKey}，${effectiveDuration}s）`
                  : hasSegmentPrompt
                    ? `生成片段视频（${segmentKey}，${effectiveDuration}s）`
                    : `生成片段视频（${segmentKey}，需先生成片段提示词）`,
                `video:generate:segment-video:${encodedSegmentKey}`,
                !hasSegmentPrompt ? "缺片段提示词" : "",
                { disabled: !hasSegmentPrompt },
              ),
              ...sceneRequirements.map(({ scene, requirement }) =>
                createVideoPanelOption(
                  `${snapshot.projectId}-video-generate-scene-${scene.id}`,
                  `${buildVideoGenerationActionLabel(scene)} ${formatSceneOptionLabel(scene)}`,
                  `video:generate:scene:${scene.id}`,
                  requirement.disabled ? requirement.rationale : "",
                  { disabled: requirement.disabled },
                ),
              ),
            ],
          },
        );
      }),
    ];

    const episodeAllDone = segKeys.every((k) => {
      const scenes = segmentScenes.get(k) ?? [];
      return scenes.every((s) => Boolean(s.videoUrl?.trim()));
    });

    return createVideoPanelOption(
      `${snapshot.projectId}-video-generate-ep-${episodeKey}`,
      episodeAllDone ? `第 ${episodeKey} 集（已全部出片）` : `第 ${episodeKey} 集`,
      `video:generate:ep-group:${encodedEpisode}`,
      episodeBlocked > 0 ? `缺素材 ${episodeBlocked} 个` : "",
      { children: segmentChildren },
    );
  });
}

function countGeneratableStoryboardScenes(
  project: PersistedVideoProject | null | undefined,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
): number {
  if (!project?.scenes.length) return 0;

  return project.scenes.filter((scene) => !buildStoryboardSceneRequirementV2(
    scene,
    project.characters ?? [],
    project.sceneSettings ?? [],
    readyReferenceIds,
  ).disabled).length;
}

function countReadyStoryboardFrameScenes(project: PersistedVideoProject | null | undefined): number {
  if (!project?.scenes.length) return 0;

  const readySceneIds = new Set(
    project.scenes
      .filter((scene) => Boolean(scene.storyboardUrl?.trim()))
      .map((scene) => scene.id),
  );

  (project.assetManifest?.items ?? []).forEach((item) => {
    if (item.kind === "storyboard-frame" && item.status === "ready" && item.sceneId) {
      readySceneIds.add(item.sceneId);
    }
  });

  return project.scenes.filter((scene) => readySceneIds.has(scene.id)).length;
}

function hasReachedVideoExport(project: PersistedVideoProject | null | undefined): boolean {
  return Boolean(
    project?.productionStateBundle?.directoryPath ||
      project?.scenes.some((scene) =>
        Boolean(scene.videoUrl?.trim()) || normalizeVideoSceneStatus(scene.videoStatus) === "failed",
      ),
  );
}

function canSwitchToVideoStep(
  project: PersistedVideoProject | null | undefined,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
  targetStep: 3 | 4 | 5,
  mode?: string,
): boolean {
  const gate = canSwitchToVideoWorkflowStep(project, targetStep, mode);
  if (!gate.allowed) return false;
  const isDirectStoryboardSwitch = targetStep === 3;
  if (!isDirectStoryboardSwitch) return true;

  const isTextToVideo = mode === "text-to-video";

  // 打通到预览导出阶段后，除第一步外可任意切换
  if (hasReachedVideoExport(project)) {
    if (isTextToVideo && targetStep === 3) return false; // 文生视频无分镜图步骤
    return true;
  }

  if (targetStep === 3) {
    if (isTextToVideo) return false;
    return countGeneratableStoryboardScenes(project, readyReferenceIds) > 0;
  }

  if (targetStep === 4) {
    if (isTextToVideo) {
      return Boolean(project.shotPackets?.length);
    }
    return Boolean(project.storyboardPlan?.trim()) && countReadyStoryboardFrameScenes(project) >= project.scenes.length;
  }

  return hasReachedVideoExport(project);
}

function buildVideoStepSwitchOption(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
  targetStep: 3 | 4 | 5,
  readyReferenceIds: ReturnType<typeof buildReadyReferenceIdsFromAssets>,
  mode?: string,
): ComposerQuestionOption | null {
  if (!canSwitchToVideoStep(project, readyReferenceIds, targetStep, mode)) {
    return null;
  }

  const currentStep = VIDEO_VISIBLE_STAGE_FLOW.indexOf(resolveVisibleVideoStageName(snapshot.derivedStage)) + 1;
  const stepLabels: Record<3 | 4 | 5, string> = {
    3: "分镜图生成",
    4: "视频生成",
    5: "预览与导出",
  };
  const targetLabel = stepLabels[targetStep];
  const actionLabel = targetStep < currentStep ? "切回" : "切到";
  const targetValue =
    targetStep === 3 ? "video:step:storyboard" : targetStep === 4 ? "video:step:video" : "video:step:preview";

  return createVideoPanelOption(
    `${snapshot.projectId}-video-step-${targetStep}`,
    `${actionLabel}《${targetLabel}》`,
    targetValue,
    `当前素材条件已满足，可直接${actionLabel}《${targetLabel}》继续处理。`,
  );
}

function createVideoPanelQuestion(params: {
  snapshot: ConversationProjectSnapshot;
  stage: string | null | undefined;
  answerKey: string;
  title: string;
  description: string;
  recommended: Array<ComposerQuestionOption | null | undefined>;
  bulk: Array<ComposerQuestionOption | null | undefined>;
  single: Array<ComposerQuestionOption | null | undefined>;
  automation: Array<ComposerQuestionOption | null | undefined>;
  statusBadges?: ComposerQuestion["statusBadges"];
  mode?: string;
}): ComposerQuestion | null {
  const {
    snapshot,
    stage,
    answerKey,
    title,
    description,
    recommended,
    bulk,
    single,
    automation,
    statusBadges,
    mode,
  } = params;
  const layout = getVideoPanelLayout(stage, mode);
  const options = [
    createVideoPanelGroup(snapshot, `${answerKey}-recommended`, "推荐动作", "优先从最应该立即推进的动作开始。", recommended),
    createVideoPanelGroup(snapshot, `${answerKey}-bulk`, "批量执行", "适合一口气推进一批镜头、素材或状态刷新。", bulk),
    createVideoPanelGroup(snapshot, `${answerKey}-single`, "单项处理", "先挑具体镜头或条目处理，避免一次动太多。", single),
    createVideoPanelGroup(snapshot, `${answerKey}-automation`, "自动推进/导出", "让 Agent 继续推进，或直接做预览与导出。", automation),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));

  if (!options.length) return null;

  return {
    id: `${answerKey}-${snapshot.projectId}${mode === "text-to-video" ? "-t2v" : ""}`,
    title,
    description,
    options,
    presentation: "card",
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: layout.stepIndex,
    totalSteps: layout.totalSteps,
    answerKey,
    ...(statusBadges?.length ? { statusBadges } : {}),
  };
}

function buildVideoBridgePanelQuestionV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (snapshot.projectKind !== "video") return null;

  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
  const isTextToVideo = mode === "text-to-video";

  const stage = resolveVisibleVideoStageName(snapshot.derivedStage);

  // 文生视频模式：分镜图阶段不存在，回退到角色与场景面板
  const effectiveStage = isTextToVideo && stage === "分镜图生成" ? "角色与场景" : stage;

  if (!["脚本拆解", "角色与场景", "分镜图生成"].includes(effectiveStage)) {
    return null;
  }

  const readyReferenceIds = buildReadyReferenceIdsFromAssets(project);
  const sceneCount = project?.scenes.length ?? 0;
  const characterCount = project?.characters.length ?? 0;
  const sceneAssetCount = project?.sceneSettings.length ?? 0;
  const missingCharacterRefs = (project?.characters ?? []).filter(
    (item) => !readyReferenceIds.readyCharacterIds.has(item.id),
  ).length;
  const missingSceneRefs = (project?.sceneSettings ?? []).filter(
    (item) => !readyReferenceIds.readySceneIds.has(item.id),
  ).length;
  const missingStoryboardCount = project?.scenes.filter((scene) => !scene.storyboardUrl).length ?? 0;
  const storyboardedSceneCount = countStoryboardedScenes(project);
  const shotPacketCount = countShotPackets(project);
  const advanceOption = buildVideoAdvanceOption(snapshot);
  const advanceRoundOption = buildVideoAdvanceRoundOption(snapshot);
  const hasIncompleteEpisodeCoverage = hasIncompleteVideoEpisodeCoverage(project);
  const hasEntities = false;
  const characterReferenceChildren: ComposerQuestionOption[] = [];
  const sceneReferenceChildren: ComposerQuestionOption[] = [];

  if (effectiveStage === "脚本拆解") {
    return createVideoPanelQuestion({
      snapshot,
      stage: effectiveStage,
      answerKey: "video-bridge-panel",
      title: `《${snapshot.title}》正在完成脚本拆解`,
      description: sceneCount
        ? `当前已有 ${sceneCount} 个镜头草案，可以继续补角色与场景信息。`
        : "先把脚本拆成可执行的镜头序列，再继续后面的角色、场景和分镜资产。",
      recommended: [
        hasIncompleteEpisodeCoverage
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-analyze-retry-missing`,
              "继续补拆缺失集",
              "video:bridge:analyze:retry-missing",
              "保留已经拆好的集数，只重试脚本里尚未覆盖的集数，再合并成完整分镜。",
            )
          : null,
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-analyze`,
          sceneCount ? "刷新拆解结果" : "完成剧本拆解",
          "video:bridge:analyze",
          "把剧本整理成稳定的镜头序列，给后续实体、分镜和视频生成打底。",
        ),
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-entities`,
          "提取角色与场景",
          "video:bridge:entities",
          "继续抽取角色与场景实体，避免后续参考图和分镜图缺资产。",
        ),
      ],
      bulk: [
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-entities-bulk`,
          "批量抽取角色与场景",
          "video:bridge:entities",
          "把拆好的镜头继续推进到角色与场景层，形成后续生图输入。",
        ),
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-platform`,
          "补平台与镜头偏好",
          "video:bridge:platform",
          "补齐平台、风格和目标约束，减少后续镜头语言漂移。",
        ),
      ],
      single: [
        hasEntities && characterReferenceChildren.length
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-reference-assets-characters-single`,
              "单独整理角色资产",
              "video:bridge:reference-assets:characters",
              "把角色资产拆成单独入口，可只生成或刷新指定角色。",
              { children: characterReferenceChildren },
            )
          : null,
        hasEntities && sceneReferenceChildren.length
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-reference-assets-scenes-single`,
              "单独整理场景资产",
              "video:bridge:reference-assets:scenes",
              "把场景资产拆成单独入口，可只生成或刷新指定场景。",
              { children: sceneReferenceChildren },
            )
          : null,
      ],
      automation: [advanceOption, advanceRoundOption],
      statusBadges: [
        ...(sceneCount > 0 ? [{ label: "镜头草案", value: sceneCount, tone: "default" as const }] : []),
      ],
      mode,
    });
  }

  if (effectiveStage === "角色与场景") {
    const hasEntities = characterCount > 0 || sceneAssetCount > 0;
    const missingReferenceCount = missingCharacterRefs + missingSceneRefs;
    const characterReferenceChildren = buildVideoCharacterReferenceChildrenV2(snapshot, project, readyReferenceIds);
    const sceneReferenceChildren = buildVideoSceneReferenceChildrenV2(snapshot, project, readyReferenceIds);

    if (isTextToVideo) {
      const missingFullReferenceTargetIds = listVideoReferenceAssetTargetIds(project);
      const allFullReferenceTargetIds = listVideoReferenceAssetTargetIds(project, { includeReady: true });
      const fullReferenceBatchLimit = getVideoImageGenerationBatchLimit(project?.imageGenerationPrefs);
      const missingFullReferenceBatchCount = Math.min(missingFullReferenceTargetIds.length, fullReferenceBatchLimit);
      const allFullReferenceBatchCount = Math.min(allFullReferenceTargetIds.length, fullReferenceBatchLimit);
      const fullReferenceAssetOption = hasEntities && allFullReferenceTargetIds.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-bridge-reference-assets-full-t2v`,
            missingFullReferenceTargetIds.length
              ? `智能补图 ${missingFullReferenceBatchCount}/${missingFullReferenceTargetIds.length}`
              : `刷新素材 ${allFullReferenceBatchCount}/${allFullReferenceTargetIds.length}`,
            "video:bridge:reference-assets:full",
            missingFullReferenceTargetIds.length
              ? "按当前生图模型上限分批补齐；重复点击同一个按钮会继续下一批，主参考图优先于对应变体图。"
              : "所有主参考图和变体图都已齐备，可按当前生图模型上限分批刷新。",
          )
        : null;
      const t2vAllSegmentLabels = [
        ...new Set(
          (project?.scenes ?? [])
            .map((s) => s.segmentLabel?.trim())
            .filter((label): label is string => !!label && EPISODE_SEGMENT_RE.test(label)),
        ),
      ];
      const t2vMissingSegmentLabels = t2vAllSegmentLabels.filter(
        (label) => !project?.segmentVideoPrompts?.[label]?.prompt?.trim(),
      );
      // 文生视频分支：第2步显示编译+提示词，跳过分镜图
      const promptSubChildren: ComposerQuestionOption[] = [
        {
          id: `${snapshot.projectId}-video-bridge-prompts-segment`,
          label: "片段提示词生成",
          value: "video:bridge:prompts:segment",
          rationale: "将同一片段内的所有分镜合并成一个连贯的商业化视频提示词（最高 15s 规格，自动适配当前模型时长）。",
          children: [
            t2vMissingSegmentLabels.length
              ? {
                  id: `${snapshot.projectId}-video-bridge-prompts-segment-remaining`,
                  label: `补齐剩余片段（${t2vMissingSegmentLabels.length}）`,
                  value: "video:bridge:prompts:segment:remaining",
                  rationale: "按片段顺序自动补齐尚未生成的合并提示词，并参考前后片段保持内容连贯。",
                }
              : null,
            {
              id: `${snapshot.projectId}-video-bridge-prompts-segment-batch`,
              label: "分批生成片段",
              value: "video:bridge:prompts:segment:batch",
              rationale: "每次按顺序生成下一个未完成片段，适合长项目逐步推进，已生成片段不会被覆盖。",
            },
            ...buildSegmentPromptChildren(snapshot, project),
          ].filter(Boolean) as ComposerQuestionOption[],
        },
        {
          id: `${snapshot.projectId}-video-bridge-prompts-shot`,
          label: "镜头提示词生成",
          value: "video:bridge:prompts",
          rationale: "为单个镜头生成视频提示词，支持按集或按片段顺序分批推进。",
          children: [
            {
              id: `${snapshot.projectId}-video-bridge-prompts-all`,
              label: "按集分批生成",
              value: "video:bridge:prompts:all",
              rationale: "生成当前集内所有镜头的视频提示词，后续点击每次补齐一集。",
            },
            {
              id: `${snapshot.projectId}-video-bridge-prompts-batch`,
              label: "按片段分批生成",
              value: "video:bridge:prompts:batch",
              rationale: "每次按顺序生成一个片段内的所有分镜提示词，已覆盖的镜头持续叠加更新，点击一次推进一个片段。",
            },
          ],
        },
      ];
      const promptsWithSubMenu = createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-prompts-t2v`,
        shotPacketCount ? "准备视频提示词" : "准备视频提示词（先编译镜头包）",
        "video:bridge:prompts",
        "选择生成方式：片段提示词生成或镜头提示词生成。",
        { children: promptSubChildren, disabled: !shotPacketCount },
      );
      const compileShotPacketsOption = hasEntities
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-bridge-shots-t2v`,
            shotPacketCount ? "刷新镜头指令包" : "编译镜头指令包",
            "video:bridge:shots",
            "文生视频模式：直接从角色与场景实体编译镜头指令包，跳过分镜图生成。",
          )
        : null;
      const t2vSegmentPromptCount = t2vAllSegmentLabels.filter(
        (label) => !!project?.segmentVideoPrompts?.[label]?.prompt?.trim(),
      ).length;
      const t2vShotPromptCount = (project?.scenes ?? []).filter((s) => !!s.enhancedVideoPrompt?.trim()).length;
      const t2vBaseDescription = !hasEntities
        ? "先把角色与场景实体整理出来，再编译镜头指令包，最后准备视频提示词进入出片。"
        : shotPacketCount
          ? "镜头指令包已就绪，选择生成范围准备视频提示词批次。"
          : "角色和场景实体已就绪，先编译镜头指令包，再准备视频提示词。";
      return createVideoPanelQuestion({
        snapshot,
        stage: effectiveStage,
        answerKey: "video-bridge-panel",
        title: `《${snapshot.title}》文生视频 — 补角色与场景`,
        description: t2vBaseDescription,
        recommended: [
          !hasEntities
            ? createVideoPanelOption(
                `${snapshot.projectId}-video-bridge-entities-t2v`,
                "整理角色和场景资产",
                "video:bridge:entities",
                "先把镜头里的角色和场景实体抽出来，后续镜头包和出片才会稳定。",
              )
            : missingFullReferenceTargetIds.length
              ? fullReferenceAssetOption
              : !shotPacketCount
              ? compileShotPacketsOption
              : promptsWithSubMenu,
          hasEntities && missingFullReferenceTargetIds.length && !shotPacketCount
            ? compileShotPacketsOption
            : null,
          hasEntities && missingFullReferenceTargetIds.length && shotPacketCount
            ? promptsWithSubMenu
            : null,
        ],
        bulk: [
          createVideoPanelOption(
            `${snapshot.projectId}-video-bridge-entities-refresh-t2v`,
            hasEntities ? "刷新角色与场景提取" : "批量提取角色与场景",
            "video:bridge:entities",
            hasEntities
              ? "重新整理角色、场景和关联信息，确保主资产和剧情实体一致。"
              : "先把这批镜头里的角色、场景和关联关系一起抽出来，形成后续资产入口。",
          ),
          fullReferenceAssetOption,
          shotPacketCount ? compileShotPacketsOption : null,
          shotPacketCount ? promptsWithSubMenu : null,
        ],
        single: [
          hasEntities && characterReferenceChildren.length
            ? createVideoPanelOption(
                `${snapshot.projectId}-video-bridge-reference-assets-characters-single`,
                "单独整理角色资产",
                "video:bridge:reference-assets:characters",
                "把角色资产拆成单独入口，可只生成或刷新指定角色。",
                { children: characterReferenceChildren },
              )
            : null,
          hasEntities && sceneReferenceChildren.length
            ? createVideoPanelOption(
                `${snapshot.projectId}-video-bridge-reference-assets-scenes-single`,
                "单独整理场景资产",
                "video:bridge:reference-assets:scenes",
                "把场景资产拆成单独入口，可只生成或刷新指定场景。",
                { children: sceneReferenceChildren },
              )
            : null,
        ],
        automation: [
          buildVideoStepSwitchOption(snapshot, project, 4, readyReferenceIds, mode),
          buildVideoStepSwitchOption(snapshot, project, 5, readyReferenceIds, mode),
          advanceOption,
          advanceRoundOption,
        ],
        statusBadges: [
          ...(characterCount > 0 ? [{ label: "角色", value: characterCount, tone: "default" as const }] : []),
          ...(sceneAssetCount > 0 ? [{ label: "场景", value: sceneAssetCount, tone: "default" as const }] : []),
          ...(missingFullReferenceTargetIds.length > 0
            ? [{ label: "缺资产", value: missingFullReferenceTargetIds.length, tone: "warning" as const }]
            : []),
          ...(shotPacketCount > 0 ? [{ label: "镜头包", value: shotPacketCount, tone: "default" as const }] : []),
          ...(t2vAllSegmentLabels.length > 0
            ? [{
                label: t2vSegmentPromptCount < t2vAllSegmentLabels.length ? "缺片段词" : "片段词",
                value: t2vSegmentPromptCount < t2vAllSegmentLabels.length ? t2vAllSegmentLabels.length - t2vSegmentPromptCount : t2vSegmentPromptCount,
                tone: t2vSegmentPromptCount < t2vAllSegmentLabels.length ? "warning" as const : "default" as const,
              }]
            : []),
          ...(shotPacketCount > 0 && (t2vShotPromptCount > 0 || t2vAllSegmentLabels.length === 0)
            ? [{
                label: t2vShotPromptCount < sceneCount ? "缺镜头词" : "镜头词",
                value: t2vShotPromptCount < sceneCount ? sceneCount - t2vShotPromptCount : t2vShotPromptCount,
                tone: t2vShotPromptCount < sceneCount ? "warning" as const : "default" as const,
              }]
            : []),
        ],
        mode,
      });
    }

    // 图生视频模式：正常主链路
    const switchToStoryboardOption = createVideoPanelOption(
      `${snapshot.projectId}-video-step-storyboard`,
      "切到《生成分镜图》",
      "video:step:storyboard",
      "快速切到分镜图步骤，继续查看缺口、指定镜头和推进状态。",
    );
    return createVideoPanelQuestion({
      snapshot,
      stage: effectiveStage,
      answerKey: "video-bridge-panel",
      title: `《${snapshot.title}》正在补角色与场景`,
      description: !hasEntities
        ? "平台和镜头偏好已经写回，下一步先把角色与场景实体整理出来，再继续后面的镜头包和出片。"
        : shotPacketCount
          ? "镜头指令包已就绪，可以直接准备视频提示词批次进入出片。"
          : "角色和场景实体已就绪，可以继续生成参考图和分镜图。",
      recommended: [
        !hasEntities
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-entities-primary`,
              "先整理角色和场景资产",
              "video:bridge:entities",
              "先把镜头里的角色和场景实体抽出来，后续镜头包和出片才会稳定。",
            )
          : createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-reference-assets-primary`,
              "批量补参考图",
              "video:bridge:reference-assets",
              "把缺失的角色主参考图、场景主参考图一次补齐，为分镜图生成打底。",
            ),
      ],
      bulk: [
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-entities-refresh`,
          hasEntities ? "刷新角色与场景提取" : "批量提取角色与场景",
          "video:bridge:entities",
          hasEntities
            ? "重新整理角色、场景和关联信息，确保主资产和剧情实体一致。"
            : "先把这批镜头里的角色、场景和关联关系一起抽出来，形成后续资产入口。",
        ),
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-reference-assets-bulk`,
          "批量补参考图",
          "video:bridge:reference-assets",
          "把缺失的角色主参考图、场景主参考图一次补齐。",
        ),
        createVideoPanelOption(
          `${snapshot.projectId}-video-bridge-storyboard-bulk`,
          "推进到分镜批次",
          "video:bridge:storyboard",
          "整理分镜文本计划，给下一步真实分镜图生成铺路。",
        ),
      ],
      single: [
        hasEntities && characterReferenceChildren.length
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-reference-assets-characters-single`,
              "单独整理角色资产",
              "video:bridge:reference-assets:characters",
              "把角色资产拆成单独入口，可只生成或刷新指定角色。",
              { children: characterReferenceChildren },
            )
          : null,
        hasEntities && sceneReferenceChildren.length
          ? createVideoPanelOption(
              `${snapshot.projectId}-video-bridge-reference-assets-scenes-single`,
              "单独整理场景资产",
              "video:bridge:reference-assets:scenes",
              "把场景资产拆成单独入口，可只生成或刷新指定场景。",
              { children: sceneReferenceChildren },
            )
          : null,
      ],
      automation: [
        switchToStoryboardOption,
        buildVideoStepSwitchOption(snapshot, project, 4, readyReferenceIds, mode),
        buildVideoStepSwitchOption(snapshot, project, 5, readyReferenceIds, mode),
        advanceOption,
        advanceRoundOption,
      ],
      statusBadges: [
        ...(characterCount > 0 ? [{ label: "角色", value: characterCount, tone: "default" as const }] : []),
        ...(sceneAssetCount > 0 ? [{ label: "场景", value: sceneAssetCount, tone: "default" as const }] : []),
        ...(missingReferenceCount > 0
          ? [{ label: "缺参考图", value: missingReferenceCount, tone: "warning" as const }]
          : []),
      ],
    });
  }

  const storyboardFrameChildren = buildStoryboardFrameSceneChildrenV2(snapshot, project, readyReferenceIds);
  const targetedStoryboardOption = storyboardFrameChildren.length
    ? createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-storyboard-frames-single`,
        "指定生成分镜图",
        "video:bridge:storyboard-frames:list",
        "按片段目录展开单个镜头，缺素材的镜头会置灰并在右侧直接说明缺什么。",
        { children: storyboardFrameChildren },
      )
    : null;
  const switchToEntitiesOption = createVideoPanelOption(
    `${snapshot.projectId}-video-step-entities`,
    "切回《角色和场景》",
    "video:step:entities",
    "需要补角色或场景基础素材时，可以直接切回去继续补齐。",
  );
  const switchToVideoOption = buildVideoStepSwitchOption(snapshot, project, 4, readyReferenceIds, mode);
  const switchToPreviewOption = buildVideoStepSwitchOption(snapshot, project, 5, readyReferenceIds, mode);

  return createVideoPanelQuestion({
    snapshot,
    stage,
    answerKey: "video-bridge-panel",
    title: `《${snapshot.title}》正在生成分镜图`,
    description: missingStoryboardCount
      ? `当前还有 ${missingStoryboardCount} 个镜头缺真正的分镜图，补齐后再进入视频生成会更稳。`
      : "分镜图已基本齐备，可以继续编译镜头包和视频提示词。",
    recommended: [
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-storyboard-frames`,
        missingStoryboardCount ? "补齐分镜图" : "刷新分镜图",
        "video:bridge:storyboard-frames",
        "真正落地 scene.storyboardUrl，而不是只停留在文本分镜计划。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-shots-next`,
        shotPacketCount ? "刷新镜头指令包" : "编译镜头指令包",
        "video:bridge:shots",
        "把分镜和主资产整理成可直接服务视频生成的 shot packet。",
      ),
    ],
    bulk: [
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-storyboard-plan`,
        "刷新分镜文本批次",
        "video:bridge:storyboard",
        "先整理分镜文本计划，再决定是否需要重生成分镜图。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-storyboard-frames-bulk`,
        "批量生成分镜图",
        "video:bridge:storyboard-frames",
        "把缺失的 scene.storyboardUrl 一次补齐，避免后续卡在文本分镜阶段。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-shots-bulk`,
        shotPacketCount ? "重建镜头指令包" : "编译镜头指令包",
        "video:bridge:shots",
        "统一刷新镜头指令包，让后续视频提示词建立在最新分镜之上。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-bridge-prompts-bulk`,
        "准备视频提示词批次",
        "video:bridge:prompts",
        "把镜头包继续推进到视频提示词阶段，准备开始出片。",
      ),
    ],
    single: [targetedStoryboardOption],
    automation: [switchToEntitiesOption, switchToVideoOption, switchToPreviewOption, advanceOption, advanceRoundOption],
    statusBadges: [
      ...(storyboardedSceneCount > 0
        ? [{ label: "已出分镜图", value: storyboardedSceneCount, tone: "default" as const }]
        : []),
      ...(missingStoryboardCount > 0
        ? [{ label: "缺分镜图", value: missingStoryboardCount, tone: "warning" as const }]
        : []),
      ...(shotPacketCount > 0 ? [{ label: "镜头包", value: shotPacketCount, tone: "default" as const }] : []),
    ],
    mode,
  });
}

function buildVideoGenerationPanelQuestionV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (snapshot.projectKind !== "video") return null;

  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
  const isTextToVideo = mode === "text-to-video";

  // 文生视频模式：只有有 enhancedVideoPrompt 的镜头才可出片
  const allCandidates = listGeneratableVideoScenes(project);
  const candidates = isTextToVideo
    ? allCandidates.filter((scene) => !!scene.enhancedVideoPrompt?.trim())
    : allCandidates;
  const segmentVideoCandidates = isTextToVideo
    ? listGeneratableSegmentVideoLabels(project)
    : [];
  const failedSegmentVideoCandidates = isTextToVideo
    ? listFailedSegmentVideoLabels(project)
    : [];
  const runningSegmentVideoCandidates = isTextToVideo
    ? listRunningSegmentVideoLabels(project)
    : [];

  const failedScenes = listFailedVideoScenes(project);
  const runningScenes = listRunningVideoScenes(project);
  const completedScenes = listCompletedVideoScenes(project);
  const advanceOption = buildVideoAdvanceOption(snapshot);
  const advanceRoundOption = buildVideoAdvanceRoundOption(snapshot);
  const productionBundleOption = buildVideoProductionBundleOption(snapshot);
  const productionFollowups = buildVideoProductionBundleFollowupOptions(snapshot);
  const readyReferenceIds = buildReadyReferenceIdsFromAssets(project);
  // 文生视频模式隐藏回退到分镜图步骤的选项
  const switchToStoryboardOption = isTextToVideo
    ? null
    : buildVideoStepSwitchOption(snapshot, project, 3, readyReferenceIds, mode);
  const switchToPreviewOption = buildVideoStepSwitchOption(snapshot, project, 5, readyReferenceIds, mode);
  // 文生视频模式：回退到角色与场景
  const switchToEntitiesOption = isTextToVideo
    ? createVideoPanelOption(
        `${snapshot.projectId}-video-step-entities-t2v`,
        "切回《角色和场景》",
        "video:step:entities",
        "返回补齐角色场景资产或继续准备视频提示词批次。",
      )
    : null;

  const hasSegmentPrompts = Object.keys(project?.segmentVideoPrompts ?? {}).length > 0;
  if (
    !candidates.length &&
    !segmentVideoCandidates.length &&
    !failedSegmentVideoCandidates.length &&
    !runningSegmentVideoCandidates.length &&
    !failedScenes.length &&
    !runningScenes.length &&
    !completedScenes.length &&
    !hasSegmentPrompts
  ) {
    return null;
  }

  const firstBatchSize = Math.min(3, candidates.length);
  const firstSegmentBatchSize = Math.min(3, segmentVideoCandidates.length);
  const targetedGenerationChildren = buildTargetedVideoGenerationChildrenV2(snapshot, project);

  return createVideoPanelQuestion({
    snapshot,
    stage: "视频生成",
    answerKey: "video-generation-panel",
    title: `《${snapshot.title}》可以继续推进视频生成`,
    description: [
      segmentVideoCandidates.length ? `待生成片段 ${segmentVideoCandidates.length} 个` : null,
      runningSegmentVideoCandidates.length ? `片段生成中 ${runningSegmentVideoCandidates.length} 个` : null,
      failedSegmentVideoCandidates.length ? `失败片段 ${failedSegmentVideoCandidates.length} 个` : null,
      candidates.length ? `待生成镜头 ${candidates.length} 个` : null,
      runningScenes.length ? `生成中 ${runningScenes.length} 个` : null,
      completedScenes.length ? `已出片 ${completedScenes.length} 个` : null,
      failedScenes.length ? `失败待补 ${failedScenes.length} 个` : null,
    ]
      .filter(Boolean)
      .join("，") || "可以继续生成和检查视频结果。",
    recommended: [
      runningSegmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-refresh-segments`,
            `刷新 ${runningSegmentVideoCandidates.length} 个进行中片段`,
            "video:generate:segments:refresh",
            "先回收当前片段视频任务的最新状态，避免重复提交。",
          )
        : null,
      failedSegmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-segments-failed`,
            `补发 ${Math.min(failedSegmentVideoCandidates.length, 3)} 个失败片段`,
            "video:generate:segments:failed",
            "优先回补失败片段，保持片段成片队列连续。",
          )
        : null,
      segmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-segments-first`,
            segmentVideoCandidates.length === 1
              ? `生成片段视频（${segmentVideoCandidates[0]}）`
              : `先生成前 ${firstSegmentBatchSize} 个片段`,
            "video:generate:segments:first",
            segmentVideoCandidates.length === 1
              ? "直接把当前最靠前的片段提示词送去生成片段视频。"
              : `优先验证最靠前的 ${firstSegmentBatchSize} 个片段，快速拿到第一批片段视频结果。`,
          )
        : null,
      candidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-first`,
            candidates.length === 1 ? `生成 ${formatSceneOptionLabel(candidates[0])}` : `先生成前 ${firstBatchSize} 个镜头`,
            "video:generate:first",
            candidates.length === 1
              ? "直接把当前最靠前的镜头送去生成。"
              : `优先验证最靠前的 ${firstBatchSize} 个镜头，快速拿到第一批视频结果。`,
          )
        : null,
      failedScenes.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-failed`,
            `补发 ${Math.min(failedScenes.length, 3)} 个失败镜头`,
            "video:generate:failed",
            "优先回补失败镜头，避免导出被缺口卡住。",
          )
        : null,
    ],
    bulk: [
      runningSegmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-refresh-segments-bulk`,
            "批量刷新进行中片段",
            "video:generate:segments:refresh",
            "统一刷新片段视频任务状态，完成的会直接写入片段视频。",
          )
        : null,
      failedSegmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-segments-failed-bulk`,
            "批量补发失败片段",
            "video:generate:segments:failed",
            "把失败片段按片段顺序重新提交，减少来回切换。",
          )
        : null,
      segmentVideoCandidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-segments-first-bulk`,
            segmentVideoCandidates.length === 1 ? "生成当前片段" : `批量生成前 ${firstSegmentBatchSize} 个片段`,
            "video:generate:segments:first",
            "按当前片段顺序直接发起第一批片段视频生成。",
          )
        : null,
      candidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-first-bulk`,
            candidates.length === 1 ? "生成当前镜头" : `批量生成前 ${firstBatchSize} 个镜头`,
            "video:generate:first",
            "按当前排序直接发起第一批视频生成。",
          )
        : null,
      failedScenes.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-failed-bulk`,
            "批量补发失败镜头",
            "video:generate:failed",
            "把失败镜头统一重新提交，减少来回切换。",
          )
        : null,
    ],
    single: [
      targetedGenerationChildren.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-video-generate-list`,
            isTextToVideo && segmentVideoCandidates.length ? "指定片段或镜头出片" : "指定镜头出片",
            "video:generate:list",
            isTextToVideo && segmentVideoCandidates.length
              ? "先挑具体片段或镜头，再只提交这一小批。"
              : "先挑具体镜头，再只提交这一小批。",
            { children: targetedGenerationChildren },
          )
        : null,
    ],
    automation: [
      switchToEntitiesOption,
      switchToStoryboardOption,
      switchToPreviewOption,
      advanceOption,
      advanceRoundOption,
      productionBundleOption,
      ...productionFollowups,
    ],
    statusBadges: [
      ...(candidates.length ? [{ label: "待生成", value: candidates.length, tone: "default" as const }] : []),
      ...(runningScenes.length ? [{ label: "生成中", value: runningScenes.length, tone: "warning" as const }] : []),
      ...(failedScenes.length ? [{ label: "失败", value: failedScenes.length, tone: "danger" as const }] : []),
    ],
    mode,
  });
}

function buildVideoPreviewExportPanelQuestionV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (snapshot.projectKind !== "video") return null;

  const mode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
  const isTextToVideo = mode === "text-to-video";

  const completedScenes = listCompletedVideoScenes(project);
  const runningScenes = listRunningVideoScenes(project);
  const candidates = listGeneratableVideoScenes(project);
  const productionBundleOption = buildVideoProductionBundleOption(snapshot);
  const productionFollowups = buildVideoProductionBundleFollowupOptions(snapshot);
  const assetExportGroup = buildVideoAssetExportGroupOption(snapshot, project);
  const targetedGenerationChildren = buildTargetedVideoGenerationChildrenV2(snapshot, project);
  const readyReferenceIds = buildReadyReferenceIdsFromAssets(project);
  // 文生视频模式隐藏回退到分镜图步骤的选项，改为显示切回角色与场景
  const switchToStoryboardOption = isTextToVideo
    ? null
    : buildVideoStepSwitchOption(snapshot, project, 3, readyReferenceIds, mode);
  const switchToVideoOption = buildVideoStepSwitchOption(snapshot, project, 4, readyReferenceIds, mode);
  // 文生视频模式：预览导出阶段提供切回角色与场景的选项
  const switchToEntitiesOption = isTextToVideo
    ? createVideoPanelOption(
        `${snapshot.projectId}-preview-step-entities-t2v`,
        "切回《角色和场景》",
        "video:step:entities",
        "返回补齐角色场景资产或继续准备视频提示词批次。",
      )
    : null;

  return createVideoPanelQuestion({
    snapshot,
    stage: "预览与导出",
    answerKey: "review-stage-panel",
    title: `《${snapshot.title}》进入预览与导出阶段`,
    description: [
      completedScenes.length ? `已出片 ${completedScenes.length} 个` : null,
      runningScenes.length ? `生成中 ${runningScenes.length} 个` : null,
    ]
      .filter(Boolean)
      .join("，") || "可以继续出片或导出生产状态包。",
    recommended: [
      !runningScenes.length && candidates.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-preview-generate-first`,
            "继续补生成剩余镜头",
            "video:generate:first",
            "如果还有未出片镜头，可以继续补发。",
          )
        : null,
    ],
    bulk: [],
    single: [
      targetedGenerationChildren.length
        ? createVideoPanelOption(
            `${snapshot.projectId}-preview-generate-list-single`,
            "指定镜头继续出片",
            "video:generate:list",
            "如果还有未出片镜头，可以先补最关键的那几个。",
            { children: targetedGenerationChildren },
          )
        : null,
    ],
    automation: [
      switchToEntitiesOption,
      switchToStoryboardOption,
      switchToVideoOption,
      assetExportGroup,
      productionBundleOption,
      ...productionFollowups,
    ],
    statusBadges: [
      ...(completedScenes.length ? [{ label: "已出片", value: completedScenes.length, tone: "default" as const }] : []),
    ],
    mode,
  });
}

function buildVideoContinuationQuestionV2(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (snapshot.projectKind !== "video") return null;

  const stage = resolveVisibleVideoStageName(snapshot.derivedStage);

  switch (stage) {
    case "脚本拆解":
    case "角色与场景":
    case "分镜图生成":
      return buildVideoBridgeQuestion(snapshot, project);
    case "视频生成": {
      const genPanel = buildVideoGenerationPanelQuestionV2(snapshot, project);
      if (genPanel) return genPanel;
      // 文生视频模式：没有可出片镜头时，回退到角色与场景面板（引导准备视频提示词）
      const videoMode = project?.videoGenerationPrefs?.mode ?? "image-to-video";
      if (videoMode === "text-to-video") {
        const bridgePanel = buildVideoBridgeQuestion(
          { ...snapshot, derivedStage: "角色与场景" },
          project,
        );
        if (bridgePanel) return bridgePanel;
      }
      return buildVideoPreviewExportPanelQuestionV2(snapshot, project);
    }
    case "预览与导出":
      return (
        buildVideoPreviewExportPanelQuestionV2(snapshot, project) ??
        buildVideoGenerationPanelQuestionV2(snapshot, project)
      );
    default:
      return null;
  }
}

export function buildVideoBridgePrefixQuestion(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestion | null {
  if (snapshot.projectKind !== "video") return null;
  if (resolveVisibleVideoStageName(snapshot.derivedStage) !== VIDEO_VISIBLE_STAGE_FLOW[0]) return null;

  const targetPlatform = project?.targetPlatform?.trim() ?? "";
  const shotStyle = project?.shotStyle?.trim() ?? "";
  const outputGoal = project?.outputGoal?.trim() ?? "";
  const completedCount = [targetPlatform, shotStyle, outputGoal].filter(Boolean).length;

  if (completedCount >= 3) return null;

  const layout = getVideoPanelLayout(snapshot.derivedStage);
  const options: ComposerQuestionOption[] = [];

  if (!targetPlatform) {
    options.push({
      id: `${snapshot.projectId}-video-bridge-prefix-target-platform`,
      label: "\u8865\u9f50\u76ee\u6807\u5e73\u53f0",
      value: "video:bridge:prefix:target-platform",
      rationale: "\u70b9\u51fb\u540e\u76f4\u63a5\u5728\u540e\u53f0\u8865\u9f50\u5e73\u53f0\u504f\u597d\uff0c\u5199\u5165 `targetPlatform`\u3002",
    });
  }

  if (!shotStyle) {
    options.push({
      id: `${snapshot.projectId}-video-bridge-prefix-shot-style`,
      label: "\u8865\u9f50\u955c\u5934\u98ce\u683c",
      value: "video:bridge:prefix:shot-style",
      rationale: "\u70b9\u51fb\u540e\u76f4\u63a5\u5728\u540e\u53f0\u8865\u9f50\u955c\u5934\u8bed\u8a00\uff0c\u5199\u5165 `shotStyle`\u3002",
    });
  }

  if (!outputGoal) {
    options.push({
      id: `${snapshot.projectId}-video-bridge-prefix-output-goal`,
      label: "\u8865\u9f50\u51fa\u7247\u76ee\u6807",
      value: "video:bridge:prefix:output-goal",
      rationale: "\u70b9\u51fb\u540e\u76f4\u63a5\u5728\u540e\u53f0\u8865\u9f50\u51fa\u7247\u76ee\u6807\uff0c\u5199\u5165 `outputGoal`\u3002",
    });
  }

  if (completedCount === 0) {
    options.push({
      id: `${snapshot.projectId}-video-bridge-prefix-auto`,
      label: "\u4e00\u952e\u8865\u9f50\u5e73\u53f0\u4e0e\u955c\u5934\u504f\u597d",
      value: "video:bridge:platform",
      rationale: "\u76f4\u63a5\u5728\u540e\u53f0\u4e00\u6b21\u8865\u9f50\u4e09\u4e2a\u5b57\u6bb5\uff0c\u5199\u5165\u540e\u7acb\u5373\u8fdb\u5165\u5267\u672c\u62c6\u89e3\u3002",
    });
  }

  return {
    id: `video-bridge-prefix-${snapshot.projectId}`,
    title: "\u5148\u8865\u9f50\u89c6\u9891\u5de5\u4f5c\u6d41\u524d\u7f6e\u53c2\u6570",
    description:
      completedCount > 0
        ? `\u5df2\u5199\u5165 ${completedCount}/3 \u9879\u3002\u8865\u9f50\u5269\u4f59\u5b57\u6bb5\u540e\uff0c\u5c31\u4f1a\u6b63\u5f0f\u8fdb\u5165\u89c6\u9891\u5267\u672c\u5de5\u4f5c\u6d41\u3002`
        : "\u8bf7\u5148\u8865\u9f50\u76ee\u6807\u5e73\u53f0\u3001\u955c\u5934\u98ce\u683c\u548c\u51fa\u7247\u76ee\u6807\u3002\u4e5f\u53ef\u4ee5\u76f4\u63a5\u70b9\u51fb\u4e00\u952e\u8865\u9f50\u3002",
    options,
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: layout.stepIndex,
    totalSteps: layout.totalSteps,
    answerKey: "video-bridge-prefix",
    statusBadges: [
      { label: "\u5df2\u5199\u5165", value: `${completedCount}/3`, tone: completedCount > 0 ? "warning" : "default" },
    ],
  };
}

export function buildVideoBridgeRetryQuestion(
  snapshot: ConversationProjectSnapshot | null | undefined,
): ComposerQuestion | null {
  if (!snapshot || snapshot.projectKind !== "video") return null;

  return {
    id: `video-bridge-retry-${snapshot.projectId}`,
    title: "补平台与镜头偏好未完成",
    description: "自动补齐没有成功执行完。你可以重新发起一次平台与镜头偏好补齐，然后继续原来的视频工作流。",
    options: [
      {
        id: `${snapshot.projectId}-video-bridge-retry-all`,
        label: "继续补齐平台与镜头偏好",
        value: "video:bridge:platform",
        rationale: "重新自动补齐目标平台、镜头风格和出片目标。",
      },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "video-bridge-retry",
  };
}

function buildVideoAnalyzeDurationEntryQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion {
  return {
    id: `video-analyze-duration-${snapshot.projectId}`,
    title: "请选择单集时长",
    description: "前置参数已经写入完成，先确认单集时长，再正式进入剧本拆解。",
    options: [
      { id: "dur-60", label: "60 秒", value: "video:bridge:analyze:dur:60", rationale: "快节奏短剧，每集约 60 秒" },
      { id: "dur-90", label: "90 秒", value: "video:bridge:analyze:dur:90", rationale: "标准时长，适合大多数短剧类型" },
      { id: "dur-120", label: "120 秒", value: "video:bridge:analyze:dur:120", rationale: "较长时长，适合情感戏或复杂剧情" },
      {
        id: "dur-custom",
        label: "自定义",
        value: "video:bridge:analyze:dur:custom",
        rationale: "手动输入自定义时长",
        childInput: {
          type: "number",
          actionPrefix: "video:bridge:analyze:dur:n:",
          min: 15,
          max: 600,
          placeholder: "输入时长（秒）",
          suffix: "秒",
          buttonLabel: "确认",
        },
      },
    ],
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 2,
    answerKey: "video-analyze-duration",
  };
}

export function buildVideoBridgeQuestion(snapshot: ConversationProjectSnapshot, project: PersistedVideoProject | null | undefined): ComposerQuestion | null {
  return filterQuestionOptions(
    buildVideoBridgePanelQuestionV2(snapshot, project),
    (value) => shouldShowVideoBridgeOption(snapshot, project, value),
  );
}

export function buildVideoGenerationQuestion(snapshot: ConversationProjectSnapshot, project: PersistedVideoProject | null | undefined): ComposerQuestion | null {
  return buildVideoGenerationPanelQuestionV2(snapshot, project);
}

export function buildVideoGenerationSceneListQuestion(snapshot: ConversationProjectSnapshot, project: PersistedVideoProject | null | undefined): ComposerQuestion | null {
  const options = buildTargetedVideoGenerationChildrenV2(snapshot, project);
  if (!options.length) return null;
  const layout = getVideoPanelLayout(snapshot.derivedStage);
  return {
    id: `video-generate-list-${snapshot.projectId}`,
    title: `先发《${snapshot.title}》里的哪条镜头？`,
    description: "按片段展开后，只会提交你选中的镜头。",
    options,
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: layout.stepIndex,
    totalSteps: layout.totalSteps,
    answerKey: "video-generate-list",
  };
}

export const buildVideoRefreshSceneListQuestion = buildVideoGenerationSceneListQuestion;

export function buildVideoContinuationQuestion(snapshot: ConversationProjectSnapshot, project: PersistedVideoProject | null | undefined): ComposerQuestion | null {
  return buildVideoContinuationQuestionV2(snapshot, project);
}


export function listUnlockedCharacterCards(snapshot: ConversationProjectSnapshot) {
  return snapshot.memory?.characterStateCards?.filter((card) => card.status !== "locked") ?? [];
}

export function findCharacterCard(snapshot: ConversationProjectSnapshot, cardId: string) {
  return snapshot.memory?.characterStateCards?.find((card) => card.id === cardId) ?? null;
}

export function buildCharacterCardQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (!snapshot.derivedStage.includes("角色")) return null;
  const cards = listUnlockedCharacterCards(snapshot);
  if (!cards.length) return null;
  const nextCard = cards[0];
  return { id: `script-character-${snapshot.projectId}`, title: `《${snapshot.title}》还有 ${cards.length} 张角色状态卡待收口。`, description: nextCard ? `建议先锁定 ${nextCard.name}。` : "也可以直接输入要求。", options: [{ id: `${snapshot.projectId}-character-next`, label: nextCard ? `锁定 ${nextCard.name}` : "锁定下一张角色卡", value: "script:character-lock-next", rationale: "先锁定最关键的角色状态卡，保持人物关系稳定。" }, { id: `${snapshot.projectId}-character-list`, label: "逐张检查角色卡", value: "script:character-list", rationale: "展开逐张入口，再决定锁定或继续完善。" }], allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-character" };
}

export function buildCharacterCardListQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  const cards = listUnlockedCharacterCards(snapshot);
  if (!cards.length) return null;
  return { id: `script-character-list-${snapshot.projectId}`, title: `先处理《${snapshot.title}》里的哪张角色状态卡？`, description: "选中后可直接锁定或继续深化。", options: cards.slice(0, 5).map((card) => ({ id: card.id, label: card.name, value: `script:character-item:${card.id}`, rationale: `${card.role} · ${card.coreConflict}` })), allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-character-list" };
}

export function buildCharacterCardDecisionQuestion(snapshot: ConversationProjectSnapshot, cardId: string): ComposerQuestion | null {
  const card = findCharacterCard(snapshot, cardId);
  if (!card) return null;
  return { id: `script-character-item-${snapshot.projectId}-${cardId}`, title: `《${card.name}》这张角色状态卡怎么处理？`, description: `${card.coreConflict} / 目标：${card.desire}`, options: [{ id: `${cardId}-lock`, label: "锁定这张角色卡", value: `script:character-lock:${cardId}`, rationale: "确认这张角色卡已经稳定，后续剧情按它推进。" }, { id: `${cardId}-refine`, label: "继续深化这个角色", value: `script:character-refine:${cardId}`, rationale: "继续围绕这张角色卡补充人物动机、冲突和关系。" }], allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-character-decision" };
}

export function listPendingCompliancePackets(snapshot: ConversationProjectSnapshot) {
  return snapshot.memory?.complianceRevisionPackets?.filter((item) => item.status !== "resolved") ?? [];
}

export function listUnlockedBeatPackets(snapshot: ConversationProjectSnapshot) {
  return snapshot.memory?.storyBeatPackets?.filter((item) => item.status !== "locked") ?? [];
}

export function findCompliancePacket(snapshot: ConversationProjectSnapshot, packetId: string) {
  return snapshot.memory?.complianceRevisionPackets?.find((item) => item.id === packetId) ?? null;
}

export function findBeatPacket(snapshot: ConversationProjectSnapshot, packetId: string) {
  return snapshot.memory?.storyBeatPackets?.find((item) => item.id === packetId) ?? null;
}

export function findRecommendedAction(snapshot: ConversationProjectSnapshot, predicate: (action: string) => boolean) {
  return snapshot.recommendedActions.find((action) => predicate(action)) ?? null;
}

function getOutlineBatchPayload(snapshot: ConversationProjectSnapshot) {
  const outlineArtifact = snapshot.artifacts.find(
    (artifact) =>
      artifact.kind === "outline" &&
      artifact.payload?.type === "outlines+batchProgress",
  );

  return outlineArtifact?.payload?.type === "outlines+batchProgress"
    ? outlineArtifact.payload
    : null;
}

function getNextPendingOutlineBatch(snapshot: ConversationProjectSnapshot) {
  const payload = getOutlineBatchPayload(snapshot);
  if (!payload) return null;

  return payload.batchProgress.batches.find((batch) => batch.status !== "done") ?? null;
}

function buildOutlineBatchOptionLabel(_batchIndex: number): string {
  return "批次细纲生成";
}

function buildEpisodeDurationHint(durationSeconds?: number | null): string | null {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return null;
  }

  const constraints = getDurationConstraints(durationSeconds);
  return `场景 ${constraints.sceneMin}-${constraints.sceneMax} 个 · △ ${constraints.triangleMin}-${constraints.triangleMax} 个 · 台词≤${constraints.maxDialogues} 句 · 正文字量约 ${constraints.cjkWordsMin}-${constraints.cjkWordsMax} 字`;
}

export function buildEpisodeDurationGateQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video") return null;

  return {
    id: `script-episode-duration-gate-${snapshot.projectId}`,
    title: `先确认《${snapshot.title}》的单集目标时长`,
    description:
      "这是进入分集撰写前的最后一步。时长会写入后续正文生成规格，影响每集场景数量、单场字数、冲突节拍和结尾钩子密度。确认一个时长后，才会创建分集撰写预览卡并进入正文生成方式选择。",
    options: [
      {
        id: `${snapshot.projectId}-episode-duration-gate-60`,
        label: "60 秒（默认）",
        value: "script:episode-duration-gate:60",
        rationale: "默认短剧规格，节奏更快，适合强钩子和短平快推进；确认后会进入分集撰写并按 60 秒生成正文。",
      },
      {
        id: `${snapshot.projectId}-episode-duration-gate-90`,
        label: "90 秒",
        value: "script:episode-duration-gate:90",
        rationale: "标准短剧规格，能兼顾情绪停顿、转折铺垫和单集爽点，适合大多数商业短剧项目。",
      },
      {
        id: `${snapshot.projectId}-episode-duration-gate-120`,
        label: "120 秒",
        value: "script:episode-duration-gate:120",
        rationale: "较完整的单集篇幅，适合信息量更大、情绪戏更重或需要复杂反转铺垫的项目。",
      },
      {
        id: `${snapshot.projectId}-episode-duration-gate-custom`,
        label: "自定义时长",
        value: "script:episode-duration-gate:custom",
        rationale: "按项目实际交付规格输入 30-600 秒的单集目标时长，确认后进入分集撰写。",
        childInput: {
          type: "number" as const,
          actionPrefix: "script:episode-duration-gate:custom:",
          buttonLabel: "确认并进入分集撰写",
          labelTemplate: "自定义 {value} 秒",
          min: 30,
          max: 600,
          placeholder: "输入秒数",
          suffix: "秒",
        },
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-episode-duration-gate",
  };
}

function buildEpisodeReviewOptions(snapshot: ConversationProjectSnapshot, doneEpisodeNumbers: number[]) {
  if (!doneEpisodeNumbers.length) return [];

  const projectId = snapshot.projectId;
  const reviewArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "episode-review" && artifact.payload?.type === "episodeReview",
  );
  const reviewedPackets =
    reviewArtifact?.payload?.type === "episodeReview" ? reviewArtifact.payload.packets : [];
  const reviewedEpisodeNumbers = new Set(reviewedPackets.map((packet) => packet.episodeNumber));
  const hasReviewedEpisodes = reviewedEpisodeNumbers.size > 0;
  const hasRemainingEpisodes =
    hasReviewedEpisodes && doneEpisodeNumbers.some((episodeNumber) => !reviewedEpisodeNumbers.has(episodeNumber));

  const episodeChildren = doneEpisodeNumbers.map((epNum) => {
    const actions = [
      {
        id: `${projectId}-episode-review-single-${epNum}-rerun`,
        label: "重新自检",
        value: `script:episode-review:single:${epNum}`,
      },
    ];
    if (reviewedEpisodeNumbers.has(epNum)) {
      actions.push({
        id: `${projectId}-episode-review-single-${epNum}-repair`,
        label: "一键修复",
        value: `script:episode-review:repair:${epNum}`,
      });
    }
    return {
      id: `${projectId}-episode-review-single-${epNum}`,
      label: `第 ${epNum} 集`,
      value: `script:episode-review:single-group:${epNum}`,
      children: actions,
    };
  });

  return [
    {
      id: `${projectId}-episode-review-default`,
      label: "批量质量审查",
      value: hasReviewedEpisodes ? "script:episode-review:batch-group" : "script:episode-review",
      children: hasReviewedEpisodes
        ? [
            {
              id: `${projectId}-episode-review-rerun-batch`,
              label: "重新批量审查",
              value: "script:episode-review",
            },
            hasRemainingEpisodes
              ? {
                  id: `${projectId}-episode-review-remaining`,
                  label: "补齐剩余批量审查",
                  value: "script:episode-review:remaining",
                }
              : null,
            {
              id: `${projectId}-episode-review-repair-worst`,
              label: "一键修复最差集",
              value: "script:episode-review:repair-worst",
            },
          ].filter((option): option is ComposerQuestionOption => Boolean(option))
        : undefined,
    },
    {
      id: `${projectId}-episode-review-single`,
      label: "质量自检",
      value: "script:episode-review:single",
      children: episodeChildren,
    },
    hasReviewedEpisodes
      ? {
          id: `${projectId}-episode-review-repair-all`,
          label: "一键修复全部",
          value: "script:episode-review:repair-all",
        }
      : null,
  ].filter((option): option is NonNullable<typeof option> => Boolean(option));
}

export function buildVideoProductionBundleOption(snapshot: ConversationProjectSnapshot) {
  const exportAction = findRecommendedAction(snapshot, (action) => action.includes("导出生产状态包"));
  if (!exportAction) return null;
  return {
    id: `${snapshot.projectId}-video-production-bundle`,
    label: exportAction,
    value: exportAction,
    rationale: "把当前风格锁、世界模型、资产清单、镜头指令包和审阅状态导出成可续接的生产状态包。",
  };
}

export function buildVideoProductionBundleFollowupOptions(snapshot: ConversationProjectSnapshot) {
  const previewAction = findRecommendedAction(snapshot, (action) => action.includes("预览生产状态摘要"));
  const openAction = findRecommendedAction(snapshot, (action) => action.includes("打开生产状态目录"));
  return [
    previewAction
      ? {
          id: `${snapshot.projectId}-video-production-preview`,
          label: previewAction,
          value: previewAction,
          rationale: "先在首页里核对这份生产状态包会收纳哪些资产和状态，再决定是否继续搬运或审计。",
        }
      : null,
    openAction
      ? {
          id: `${snapshot.projectId}-video-production-open`,
          label: openAction,
          value: openAction,
          rationale: "直接打开本地生产状态目录，查看导出的 JSON、README 和镜头状态文件。",
        }
      : null,
].filter((option): option is NonNullable<typeof option> => Boolean(option));
}

function buildVideoAssetExportGroupOption(
  snapshot: ConversationProjectSnapshot,
  project: PersistedVideoProject | null | undefined,
): ComposerQuestionOption {
  return createVideoPanelGroup(
    snapshot,
    "review-stage-panel-export",
    "导出",
    "把当前素材库里的图片和视频归档导出到本地，方便继续整理或导入剪辑软件。",
    [
      hasAutoExportableVideoSegments(project) &&
        createVideoPanelOption(
        `${snapshot.projectId}-video-export-ai-auto`,
        "AI 自动处理导出",
        "video:export:ai-auto",
        "AI 智能调用 ffmpeg，将片段内分镜按剧本顺序自动拼接成连续视频，可选烧录字幕，完成后选择本地路径导出。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-export-all`,
        "全部导出",
        "video:export:all",
        "按“剧本名 / 图片 / 视频”目录结构导出当前素材库里的本地图片和视频文件。",
      ),
      createVideoPanelOption(
        `${snapshot.projectId}-video-export-nle-placeholder`,
        "导入到剪辑软件",
        "video:export:nle-placeholder",
        "预留入口，后续可直接桥接剪辑软件；当前可以先使用“全部导出”。",
      ),
    ],
  ) as ComposerQuestionOption;
}

export function extractEpisodeNumberFromAction(action: string | null | undefined): number | null {
  if (!action) return null;
  const match = action.match(/第\s*(\d+)\s*集/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildComplianceQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  const packets = listPendingCompliancePackets(snapshot);
  const highRiskCount = packets.filter((packet) => packet.riskLevel === "high").length;
  const complianceArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "compliance");
  const reviewMode =
    complianceArtifact?.payload?.type === "complianceSummary"
      ? complianceArtifact.payload.mode
      : "text";

  if (!packets.length && snapshot.derivedStage !== "合规审查") return null;

  const options = [
    packets.length
      ? {
          id: `${snapshot.projectId}-compliance-high`,
          label: highRiskCount ? "先处理高风险项" : "逐条处理修订包",
          value: highRiskCount ? "script:compliance-resolve-high" : "script:compliance-list",
          rationale: highRiskCount ? "先把高风险项收口，再继续后续导出。" : "先展开待处理修订包，再逐条确认。",
        }
      : null,
    packets.length
      ? {
          id: `${snapshot.projectId}-compliance-list`,
          label: "逐条处理修订包",
          value: "script:compliance-list",
          rationale: "展开逐条处理入口，保留首页单会话体验。",
        }
      : null,
    {
      id: `${snapshot.projectId}-compliance-rerun-text`,
      label: reviewMode === "text" ? "重新文字审核" : "切换到文字审核",
      value: "script:compliance-mode:text",
      rationale: "按文字违规口径重新审查当前剧本。",
    },
    {
      id: `${snapshot.projectId}-compliance-rerun-script`,
      label: reviewMode === "script" ? "重新情节审核" : "切换到情节审核",
      value: "script:compliance-mode:script",
      rationale: "按情节和画面风险口径重新审查当前剧本。",
    },
  ].filter((option): option is NonNullable<typeof option> => Boolean(option));

  return {
    id: `script-compliance-${snapshot.projectId}`,
    title: packets.length
      ? `《${snapshot.title}》还有 ${packets.length} 条合规修订包待处理。`
      : `《${snapshot.title}》当前已进入合规审查阶段。`,
    description: highRiskCount
      ? `其中 ${highRiskCount} 条为高风险。`
      : "也可以直接输入修订要求。",
    options,
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-compliance",
  };
}

export function buildComplianceListQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  const packets = listPendingCompliancePackets(snapshot);
  if (!packets.length) return null;
  return { id: `script-compliance-list-${snapshot.projectId}`, title: `先处理《${snapshot.title}》里的哪条修订包？`, description: "选中后可直接处理或继续改写。", options: packets.slice(0, 5).map((packet) => ({ id: packet.id, label: packet.issueTitle, value: `script:compliance-item:${packet.id}`, rationale: `风险：${packet.riskLevel} · ${packet.recommendation}` })), allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-compliance-list" };
}

export function buildComplianceDecisionQuestion(snapshot: ConversationProjectSnapshot, packetId: string): ComposerQuestion | null {
  const packet = findCompliancePacket(snapshot, packetId);
  if (!packet) return null;
  return { id: `script-compliance-item-${snapshot.projectId}-${packetId}`, title: `《${packet.issueTitle}》这条修订包怎么处理？`, description: packet.recommendation, options: [{ id: `${packetId}-resolve`, label: "标记已处理", value: `script:compliance-resolve:${packetId}`, rationale: "确认这条修订已经落地，不再反复提示。" }, { id: `${packetId}-rewrite`, label: "继续按这条改写", value: `script:compliance-rewrite:${packetId}`, rationale: "让 Agent 继续围绕这条修订推进文本改写。" }], allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-compliance-decision" };
}

export function buildBeatPacketQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  const packets = listUnlockedBeatPackets(snapshot);
  if (!packets.length) return null;
  const nextPacket = packets[0];
  return { id: `script-beat-${snapshot.projectId}`, title: `《${snapshot.title}》还有 ${packets.length} 条剧情 beat 可以继续收口。`, description: nextPacket ? `建议先处理第 ${nextPacket.episodeNumber} 集。` : "也可以直接输入推进要求。", options: [{ id: `${snapshot.projectId}-beat-next`, label: nextPacket ? `锁定第 ${nextPacket.episodeNumber} 集 beat` : "锁定下一条 beat", value: "script:beat-lock-next", rationale: "先把最靠前的一条剧情 beat 收口，保持节奏连续。" }, { id: `${snapshot.projectId}-beat-drafted`, label: "批量锁定已成型 beat", value: "script:beat-lock-drafted", rationale: "把已有细纲支撑的 beat 先锁住，减少反复。" }, { id: `${snapshot.projectId}-beat-list`, label: "逐条检查剧情 beat", value: "script:beat-list", rationale: "展开逐条入口，再决定锁定或继续扩写。" }], allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-beat" };
}

export function buildBeatPacketListQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  const packets = listUnlockedBeatPackets(snapshot);
  if (!packets.length) return null;
  return { id: `script-beat-list-${snapshot.projectId}`, title: `先处理《${snapshot.title}》里的哪条剧情 beat？`, description: "选中后可直接锁定或继续写。", options: packets.slice(0, 5).map((packet) => ({ id: packet.id, label: `第 ${packet.episodeNumber} 集 · ${packet.title}`, value: `script:beat-item:${packet.id}`, rationale: packet.beatSummary })), allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-beat-list" };
}

export function buildBeatPacketDecisionQuestion(snapshot: ConversationProjectSnapshot, packetId: string): ComposerQuestion | null {
  const packet = findBeatPacket(snapshot, packetId);
  if (!packet) return null;
  return { id: `script-beat-item-${snapshot.projectId}-${packetId}`, title: `第 ${packet.episodeNumber} 集 · ${packet.title} 这条 beat 怎么处理？`, description: packet.beatSummary, options: [{ id: `${packetId}-lock`, label: "锁定这条 beat", value: `script:beat-lock:${packetId}`, rationale: "确认这条剧情节点已经成型，后续按它推进。" }, { id: `${packetId}-write`, label: `继续写第 ${packet.episodeNumber} 集`, value: `script:beat-write:${packet.episodeNumber}`, rationale: "直接用当前 beat 去推进这一集正文。" }], allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-beat-decision" };
}

export function buildCreativePlanWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video") return null;
  if (snapshot.derivedStage !== "创意方案" && snapshot.derivedStage !== "创作方案") return null;

  const hasCreativePlanArtifact = snapshot.artifacts.some(
    (artifact) => artifact.kind === "plan" && Boolean(artifact.summary?.trim() || artifact.content?.trim()),
  );
  const enterCharactersAction = findRecommendedAction(
    snapshot,
    (a) =>
      a.includes("进入角色开发") ||
      a.includes("进入角色设计") ||
      a.includes("推进角色设计") ||
      a.includes("继续角色设定") ||
      a.includes("继续角色开发"),
  );
  const modifyConflictAction = findRecommendedAction(snapshot, (a) => a.includes("修改创作冲突"));
  const generatePlanAction = findRecommendedAction(snapshot, (a) => a.includes("生成创作方案"));
  const resolvedEnterCharactersAction = enterCharactersAction ?? (hasCreativePlanArtifact ? "进入角色开发" : null);
  const resolvedGeneratePlanAction = generatePlanAction ?? (!hasCreativePlanArtifact ? "生成创作方案" : null);

  if (!resolvedEnterCharactersAction && !modifyConflictAction && !resolvedGeneratePlanAction) return null;

  if (resolvedEnterCharactersAction || modifyConflictAction) {
    return {
      id: `script-creative-plan-${snapshot.projectId}`,
      title: `《${snapshot.title}》创作方案已生成，下一步怎么走？`,
      description: "可以直接进入角色开发，或先调整创作方案中的核心冲突。",
      options: [
        resolvedEnterCharactersAction ? {
          id: `${snapshot.projectId}-enter-characters`,
          label: resolvedEnterCharactersAction,
          value: resolvedEnterCharactersAction,
          rationale: "创作方案已就绪，直接开始生成主要角色设定。",
        } : null,
        modifyConflictAction ? {
          id: `${snapshot.projectId}-modify-conflict`,
          label: modifyConflictAction,
          value: modifyConflictAction,
          rationale: "告诉我你想调整的冲突方向，我会重新生成创作方案。",
        } : null,
      ].filter((o): o is NonNullable<typeof o> => Boolean(o)),
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "creative-plan"),
      answerKey: "script-creative-plan",
    };
  }

  return {
    id: `script-creative-plan-${snapshot.projectId}`,
    title: `下一步：${resolvedGeneratePlanAction}`,
    description: "确认后直接生成创作方案。",
    options: [{
      id: `${snapshot.projectId}-generate-plan`,
      label: resolvedGeneratePlanAction!,
      value: resolvedGeneratePlanAction!,
      rationale: "根据立项设定生成创作冲突与方案。",
    }],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    ...getScriptFlowLayout(snapshot, "creative-plan"),
    answerKey: "script-creative-plan",
  };
}

export function buildCharactersWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video") return null;
  if (
    snapshot.derivedStage !== "角色开发" &&
    snapshot.derivedStage !== "角色转译" &&
    snapshot.derivedStage !== "角色设定"
  ) return null;

  const hasCharactersArtifact = snapshot.artifacts.some(
    (a) => a.kind === "characters" && a.summary?.trim(),
  );

  // 角色已生成 → 推进到分集目录
  if (hasCharactersArtifact) {
    const directoryAction = findRecommendedAction(snapshot, (a) =>
      a.includes("生成分集目录") || a.includes("完善分集目录"),
    ) ?? "生成分集目录";
    return {
      id: `script-characters-${snapshot.projectId}`,
      title: `《${snapshot.title}》角色设定已完成，下一步生成分集目录？`,
      description: "角色设定已就绪，可以直接推进到分集目录阶段。",
      options: [{
        id: `${snapshot.projectId}-generate-directory`,
        label: directoryAction,
        value: directoryAction,
        rationale: "基于角色设定和创作方案，生成完整的分集目录结构。",
      }],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "characters"),
      answerKey: "script-characters",
    };
  }

  // 角色未生成 → 提示生成角色
  const generateCharactersAction = findRecommendedAction(
    snapshot,
    (a) =>
      a.includes("进入角色开发") ||
      a.includes("进入角色设计") ||
      a.includes("推进角色设计") ||
      a.includes("继续角色设定") ||
      a.includes("继续角色开发"),
  ) ?? "进入角色开发";
  return {
    id: `script-characters-${snapshot.projectId}`,
    title: `下一步：${generateCharactersAction}`,
    description: "确认后直接开始角色开发。",
    options: [{
      id: `${snapshot.projectId}-enter-characters`,
      label: generateCharactersAction,
      value: generateCharactersAction,
      rationale: "开始生成主要角色设定。",
    }],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    ...getScriptFlowLayout(snapshot, "characters"),
    answerKey: "script-characters",
  };
}

export function buildDirectoryWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || snapshot.derivedStage !== "分集目录") return null;

  const hasDirectoryArtifact = snapshot.artifacts.some(
    (a) => a.kind === "directory" && a.summary?.trim(),
  );

  if (hasDirectoryArtifact) {
    return {
      id: `script-directory-${snapshot.projectId}`,
      title: `《${snapshot.title}》分集目录已完成，进入单集细纲？`,
      description: "先创建单集细纲的 0% 预览卡，再选择具体的细纲生成方式。",
      options: [{
        id: `${snapshot.projectId}-enter-outlines`,
        label: "进入单集细纲",
        value: "script:step-enter-outlines",
        rationale: "进入下一步后会先展示单集细纲预览，再弹出细纲生成方式面板。",
      }],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "directory"),
      answerKey: "script-directory",
    };
  }

  // 目录未生成 → 提示生成目录
  const generateDirAction = findRecommendedAction(snapshot, (a) => a.includes("生成分集目录") || a === "生成分集目录");
  if (!generateDirAction) return null;
  return {
    id: `script-directory-${snapshot.projectId}`,
    title: `下一步：${generateDirAction}`,
    description: "确认后直接生成分集目录。",
    options: [{
      id: `${snapshot.projectId}-generate-directory`,
      label: generateDirAction,
      value: generateDirAction,
      rationale: "基于角色设定和创作方案，生成完整的分集目录结构。",
    }],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    ...getScriptFlowLayout(snapshot, "directory"),
    answerKey: "script-directory",
  };
}

export function buildOutlinesWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind === "video" ||
    (snapshot.derivedStage !== "单集细纲" && snapshot.derivedStage !== "生成单集细纲")
  ) return null;

  const directoryArtifact = snapshot.artifacts.find((artifact) => artifact.kind === "directory");
  const outlineArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "outline" && artifact.payload?.type === "outlines+batchProgress",
  );
  const hasDirectoryArtifact = Boolean(directoryArtifact?.summary?.trim());
  const outlinePayload =
    outlineArtifact?.payload?.type === "outlines+batchProgress" ? outlineArtifact.payload : null;
  const outlineProgress =
    directoryArtifact?.payload?.type === "directory+stats"
      ? {
          totalEpisodes: directoryArtifact.payload.stats.totalEpisodes,
          outlinedEpisodes: directoryArtifact.payload.stats.outlinedEpisodes,
        }
      : outlinePayload
        ? {
            totalEpisodes: outlinePayload.totalEpisodes,
            outlinedEpisodes: outlinePayload.entries.filter((entry) => entry.outline?.trim()).length,
          }
        : null;
  const hasPendingOutlineGeneration =
    outlineProgress !== null
      ? outlineProgress.totalEpisodes > 0 && outlineProgress.outlinedEpisodes < outlineProgress.totalEpisodes
      : false;
  const hasOutlineArtifact = snapshot.artifacts.some((artifact) => {
    if (artifact.kind !== "outline") return false;
    if (artifact.payload?.type === "outlines+batchProgress") {
      return artifact.payload.entries.some((entry) => entry.outline?.trim());
    }
    return Boolean(artifact.summary?.trim());
  });

  if (hasDirectoryArtifact && hasPendingOutlineGeneration) {
    const totalEpisodes = outlineProgress?.totalEpisodes ?? 0;
    const outlinedEpisodes = outlineProgress?.outlinedEpisodes ?? 0;
    const nextPendingBatch = getNextPendingOutlineBatch(snapshot);

    // 判断是否已有任何细纲（区分"首次生成"和"继续生成"）
    const hasAnyOutline = outlinedEpisodes > 0;

    // 获取已完成的批次数，用于判断是否显示下一批选项
    const outlineBatchPayload = getOutlineBatchPayload(snapshot);
    const doneBatchCount = outlineBatchPayload
      ? outlineBatchPayload.batchProgress.batches.filter((b) => b.status === "done").length
      : 0;

    // 只有在有已完成批次时才显示"下一批"选项（避免首次进入就显示"第2批"）
    const showNextBatchOption = hasAnyOutline && nextPendingBatch !== null && doneBatchCount > 0;

    const options: ComposerQuestionOption[] = [];

    if (showNextBatchOption && nextPendingBatch) {
      options.push({
        id: `${snapshot.projectId}-generate-next-outline-batch`,
        label: buildOutlineBatchOptionLabel(nextPendingBatch.index),
        value: `script:outline-generate-batch:${nextPendingBatch.startEp}:${nextPendingBatch.endEp}`,
        rationale: `先生成第 ${nextPendingBatch.startEp}-${nextPendingBatch.endEp} 集，并实时刷新单集细纲预览进度。`,
      });
    } else if (!hasAnyOutline) {
      // 首次：只显示生成第一批
      const firstBatch = outlineBatchPayload?.batchProgress.batches[0] ?? nextPendingBatch;
      if (firstBatch) {
        options.push({
          id: `${snapshot.projectId}-generate-first-outline-batch`,
          label: buildOutlineBatchOptionLabel(0),
          value: `script:outline-generate-batch:${firstBatch.startEp}:${firstBatch.endEp}`,
          rationale: `先生成第 ${firstBatch.startEp}-${firstBatch.endEp} 集，并实时刷新单集细纲预览进度。`,
        });
      }
    }

    // 生成全部 / 重新生成全部
    options.push({
      id: `${snapshot.projectId}-generate-all-outlines`,
      label: hasAnyOutline ? "重新生成全部细纲" : "生成全部细纲",
      value: hasAnyOutline ? "script:outline-regenerate-all" : "script:outline-generate-all",
      rationale: hasAnyOutline
        ? "基于当前目录重跑整套细纲，用最新结果覆盖当前预览表。"
        : "一次性生成所有集的细纲，按批次顺序推进并实时更新预览。",
    });

    // 有细纲时额外提供进入分集撰写的快捷入口
    if (hasAnyOutline) {
      options.push({
        id: `${snapshot.projectId}-enter-episodes-from-outlines`,
        label: "进入分集撰写",
        value: "script:step-enter-episodes",
        rationale: "当前已有部分细纲，可以直接进入分集撰写阶段。",
      });
    }

    // 生成单集细纲：按顺序找到下一个未生成的集号
    const nextSingleEpisode = outlinePayload?.entries.find((entry) => !entry.outline?.trim())?.number ?? 1;
    options.push({
      id: `${snapshot.projectId}-generate-single-outline`,
      label: "生成单集细纲",
      value: `script:outline-generate-single:${nextSingleEpisode}`,
      rationale: `按顺序生成第 ${nextSingleEpisode} 集细纲，并实时刷新预览进度。`,
      devOnly: true,
    });

    return {
      id: `script-outlines-${snapshot.projectId}`,
      title: `《${snapshot.title}》单集细纲预览已创建，选择生成方式`,
      description:
        totalEpisodes > 0
          ? `当前已完成 ${outlinedEpisodes}/${totalEpisodes} 集细纲。优先补齐下一批次，再继续推进。`
          : "0% 预览卡已经就绪，先按批次生成细纲，再继续推进。",
      options,
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "outlines"),
      answerKey: "script-outlines",
    };
  }

  if (hasOutlineArtifact) {
    return {
      id: `script-outlines-${snapshot.projectId}`,
      title: `《${snapshot.title}》单集细纲已完成，进入分集撰写？`,
      description: "先创建分集撰写的 0% 预览卡，再选择分集生成方式。",
      options: [
        {
          id: `${snapshot.projectId}-enter-episodes`,
          label: "进入分集撰写",
          value: "script:step-enter-episodes",
          rationale: "进入下一步后会先展示分集撰写预览，再弹出撰写方式面板。",
        },
        {
          id: `${snapshot.projectId}-regenerate-all-outlines`,
          label: "重新生成全部细纲",
          value: "script:outline-regenerate-all",
          rationale: "基于当前目录重跑整套细纲，用最新结果覆盖当前预览表。",
        },
      ],
      allowCustomInput: true,
      submissionMode: "confirm",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "outlines"),
      answerKey: "script-outlines",
    };
  }

  // 细纲未生成 → 提示生成细纲
  const generateOutlineAction = findRecommendedAction(snapshot, (a) =>
    (a.includes("生成第") && a.includes("集细纲")) || a.includes("生成单集细纲"),
  );
  if (!generateOutlineAction) return null;
  const episodeMatch = generateOutlineAction.match(/第\s*(\d+)\s*集/);
  const episodeNum = episodeMatch ? episodeMatch[1] : null;
  return {
    id: `script-outlines-${snapshot.projectId}`,
    title: `下一步：${generateOutlineAction}`,
    description: episodeNum ? `先生成第 ${episodeNum} 集细纲，再推进正文。` : "确认后直接生成单集细纲。",
    options: [{
      id: `${snapshot.projectId}-generate-outline`,
      label: generateOutlineAction,
      value: generateOutlineAction,
      rationale: episodeNum ? `先生成第 ${episodeNum} 集细纲，为正文撰写做准备。` : "开始生成单集细纲。",
    }],
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: false,
    ...getScriptFlowLayout(snapshot, "outlines"),
    answerKey: "script-outlines",
  };
}

export function buildEpisodeWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || resolveScriptWorkflowStage(snapshot.derivedStage) !== "episodes") {
    return null;
  }

  const episodeArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "episode" && artifact.payload?.type === "episodes+batchProgress",
  );
  const episodePayload =
    episodeArtifact?.payload?.type === "episodes+batchProgress" ? episodeArtifact.payload : null;
  const nextEpisodeAction = findRecommendedAction(snapshot, (action) => /^继续(?:生成|写)第\s*\d+\s*集$/.test(action) || action === "继续生成下一集");
  const reviewAction = findRecommendedAction(
    snapshot,
    (action) => action.includes("批量质检") || action.includes("质量审查"),
  );
  const complianceAction = findRecommendedAction(snapshot, (action) => action.includes("合规审查"));
  const pendingEntries =
    episodePayload?.entries.filter((entry) => entry.status !== "done") ?? [];

  if (episodePayload) {
    const durationLabel =
      typeof episodePayload.durationSeconds === "number"
        ? `当前 ${episodePayload.durationSeconds} 秒`
        : "当前未设定";
    const doneEpisodeNumbers = episodePayload.entries
      .filter((e) => e.status === "done" && e.content)
      .map((e) => e.number)
      .sort((a, b) => a - b);
    const doneEpisodes = doneEpisodeNumbers.length;
    const durationHint = buildEpisodeDurationHint(episodePayload.durationSeconds);
    const nextPendingEntry = pendingEntries[0] ?? null;

    return {
      id: `script-episode-${snapshot.projectId}`,
      title: pendingEntries.length
        ? `《${snapshot.title}》分集撰写预览已创建，选择生成方式`
        : `《${snapshot.title}》正文已全部完成，选择下一步`,
      description: [
        `当前已完成 ${doneEpisodes}/${episodePayload.totalEpisodes} 集正文，${durationLabel}。`,
        durationHint ? `当前规格：${durationHint}。` : "当前还没有固定单集规格，建议先设定时长后再继续。",
      ].join(" "),
      options: [
        {
          id: `${snapshot.projectId}-episode-duration`,
          label:
            typeof episodePayload.durationSeconds === "number"
              ? `设定单集时长（当前 ${episodePayload.durationSeconds} 秒）`
              : "设定单集时长（默认 60 秒）",
          value: "script:episode-duration",
          devOnly: true,
          rationale: "先统一单集目标时长，后续逐集或批量生成都会沿用这个规格。",
          children: [
            {
              id: `${snapshot.projectId}-episode-duration-60`,
              label: "60秒",
              value: "script:episode-duration:60",
              rationale: "适合更快节奏的短平快推进。",
            },
            {
              id: `${snapshot.projectId}-episode-duration-90`,
              label: "90秒",
              value: "script:episode-duration:90",
              rationale: "兼顾推进速度与情绪停顿。",
            },
            {
              id: `${snapshot.projectId}-episode-duration-120`,
              label: "120秒",
              value: "script:episode-duration:120",
              rationale: "适合信息量更完整的单集篇幅。",
            },
          ],
          childInput: {
            type: "number" as const,
            actionPrefix: "script:episode-duration:custom:",
            buttonLabel: "设定自定义时长",
            labelTemplate: "自定义 {value} 秒",
            min: 30,
            max: 600,
            placeholder: "输入秒数",
            suffix: "秒",
          },
        },
        pendingEntries.length && nextPendingEntry
          ? {
              id: `${snapshot.projectId}-episode-write`,
              label: "开始撰写",
              value: "script:episode-write",
              rationale: "选择撰写方式，逐集推进或批量自动撰写。",
              children: [
                {
                  id: `${snapshot.projectId}-episode-next-fixed`,
                  label: `续写第 ${nextPendingEntry.number} 集`,
                  value: `script:episode-generate:${nextPendingEntry.number}`,
                  rationale: truncateCopy(
                    [nextPendingEntry.title, nextPendingEntry.summary]
                      .filter(Boolean)
                      .join(" · ") || `继续按顺序补齐第 ${nextPendingEntry.number} 集正文。`,
                    72,
                  ),
                },
                {
                  id: `${snapshot.projectId}-episode-batch`,
                  label: "批量自动撰写",
                  value: "script:episode-generate-batch",
                  rationale: "按目录顺序从前到后自动生成剩余集数。为保证上下文连贯，累计正文超过 15000 字时会自动分批，每批不超过 15000 字，以此类推。",
                },
                doneEpisodes > 0 && pendingEntries.length > 0
                  ? {
                      id: `${snapshot.projectId}-episode-fill-missing`,
                      label: "批量自动撰写补齐",
                      value: "script:episode-fill-missing",
                      rationale: "自动识别剩余未撰写正文，按集数顺序补齐，并沿用已完成正文作为上下文，保持前后连贯和质量稳定。",
                    }
                  : null,
              ].filter((option): option is NonNullable<typeof option> => Boolean(option)),
            }
          : null,
        doneEpisodes > 0
          ? {
              id: `${snapshot.projectId}-episode-review-group`,
              label: "质量审查",
              value: "script:episode-review-group",
              rationale: "对已完成正文进行质量审查，选择审查方式。",
              children: buildEpisodeReviewOptions(snapshot, doneEpisodeNumbers),
            }
          : null,
        complianceAction && doneEpisodes > 0
          ? {
              id: `${snapshot.projectId}-episode-compliance`,
              label: complianceAction,
              value: "script:step-enter-compliance",
              rationale: "进入合规审查步骤。",
            }
          : null,
        complianceAction && doneEpisodes > 0
          ? {
              id: `${snapshot.projectId}-episode-skip-compliance`,
              label: "直接跳过审核",
              value: "script:episode-skip-compliance",
              rationale: "暂时跳过合规阶段，直接切到导出与出片。",
              devOnly: true,
            }
          : null,
      ].filter((option): option is NonNullable<typeof option> => Boolean(option)),
      allowCustomInput: true,
      submissionMode: "immediate",
      multiSelect: false,
      ...getScriptFlowLayout(snapshot, "episodes"),
      answerKey: "script-episode",
    };
  }

  if (!nextEpisodeAction && !reviewAction && !complianceAction) return null;
  const nextEpisodeNumber = extractEpisodeNumberFromAction(nextEpisodeAction);
  const directoryArtifact = snapshot.artifacts.find(
    (a) => a.kind === "directory" && a.payload?.type === "directory+stats",
  );
  const nonPayloadDoneEpisodes =
    directoryArtifact?.payload?.type === "directory+stats"
      ? directoryArtifact.payload.stats.writtenEpisodes
      : 0;
  return {
    id: `script-episode-${snapshot.projectId}`,
    title: `《${snapshot.title}》已经进入正文推进阶段。`,
    description: nextEpisodeNumber
      ? `建议先接上第 ${nextEpisodeNumber} 集。`
      : "可继续写下一集、先质检、进入合规审核，或直接跳过审核。",
    options: [
      nextEpisodeAction
        ? {
            id: `${snapshot.projectId}-episode-next`,
            label: nextEpisodeAction,
            value: `script:episode-generate:${nextEpisodeNumber ?? "auto"}`,
            rationale: nextEpisodeNumber
              ? `继续补齐第 ${nextEpisodeNumber} 集正文，让首页会话保持单链路推进。`
              : "继续沿着当前目录补写下一集正文。",
          }
        : null,
      reviewAction
        ? {
            id: `${snapshot.projectId}-episode-review`,
            label: "批量质量审查",
            value: "script:episode-review",
            rationale: "分批质检所有已完成集数（每批最多 10 集），审查完毕后生成详细批量质量审查报告。",
          }
        : null,
      complianceAction && nonPayloadDoneEpisodes > 0
        ? {
            id: `${snapshot.projectId}-episode-compliance`,
            label: complianceAction,
            value: "script:step-enter-compliance",
            rationale: "进入合规审查步骤。",
          }
        : null,
      complianceAction && nonPayloadDoneEpisodes > 0
        ? {
            id: `${snapshot.projectId}-episode-skip-compliance`,
            label: "直接跳过审核",
            value: "script:episode-skip-compliance",
            rationale: "暂时跳过合规阶段，直接切到导出与出片。",
            devOnly: true,
          }
        : null,
    ].filter((option): option is NonNullable<typeof option> => Boolean(option)),
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    ...getScriptFlowLayout(snapshot, "episodes"),
    answerKey: "script-episode",
  };
}

export function buildExportWorkflowQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || snapshot.derivedStage !== "导出与出片") return null;
  const exportAction = findRecommendedAction(snapshot, (action) => action.includes("导出整合文档") || action.includes("修改导出稿"));
  const videoAction = findRecommendedAction(snapshot, (action) => action.includes("视频工作流"));
  const patchAction = findRecommendedAction(snapshot, (action) => action.includes("补写"));
  if (!exportAction && !videoAction && !patchAction) return null;
  const hasExportArtifact = snapshot.artifacts.some((artifact) => artifact.kind === "export");
  return { id: `script-export-${snapshot.projectId}`, title: `《${snapshot.title}》已经进入导出与出片阶段。`, description: hasExportArtifact ? "导出稿已在当前会话里。" : "可先导出，再接视频工作流。", options: [exportAction ? { id: `${snapshot.projectId}-export-document`, label: exportAction, value: exportAction.includes("修改导出稿") ? "script:export-refine" : "script:export-document", rationale: exportAction.includes("修改导出稿") ? "继续围绕当前导出稿润色结构、语气和交付格式。" : "先整理一份完整导出稿，方便后续交付和出片。" } : null, videoAction ? { id: `${snapshot.projectId}-export-video`, label: videoAction, value: "script:export-video", rationale: "把当前剧本直接桥接到首页视频工作流，不再跳出当前会话。" } : null, patchAction ? { id: `${snapshot.projectId}-export-patch`, label: patchAction, value: "script:export-patch", rationale: "先定位缺失章节或集数，再决定补写哪一块。" } : null].filter((option): option is NonNullable<typeof option> => Boolean(option)), allowCustomInput: true, submissionMode: "immediate", multiSelect: false, stepIndex: 0, totalSteps: 1, answerKey: "script-export" };
}

function resolveScriptWorkflowStageLegacy(stage: string): "creative-plan" | "characters" | "directory" | "outlines" | "episodes" | "compliance" | "export" | null {
  switch (stage) {
    case "创意方案":
    case "创作方案":
      return "creative-plan";
    case "角色开发":
    case "角色转译":
    case "角色设定":
      return "characters";
    case "分集目录":
      return "directory";
    case "单集细纲":
    case "生成单集细纲":
      return "outlines";
    case "分集撰写":
    case "剧本撰写":
      return "episodes";
    case "合规审查":
      return "compliance";
    case "导出与出片":
      return "export";
    default:
      return null;
  }
}

function buildScriptPacketQuestionLegacy(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  switch (resolveScriptWorkflowStage(snapshot.derivedStage)) {
    case "creative-plan":
      return buildCreativePlanWorkflowQuestion(snapshot);
    case "characters":
      return buildCharactersWorkflowQuestion(snapshot);
    case "directory":
      return buildDirectoryWorkflowQuestion(snapshot);
    case "outlines":
      return buildOutlinesWorkflowQuestion(snapshot);
    case "episodes":
      return buildEpisodeWorkflowQuestion(snapshot);
    case "compliance":
      return buildComplianceQuestion(snapshot);
    case "export":
      return buildExportWorkflowQuestion(snapshot);
    default:
      return null;
  }
}

type ScriptWorkflowStep =
  | "setup"
  | "reference-script"
  | "creative-plan"
  | "structure-transform"
  | "characters"
  | "character-transform"
  | "directory"
  | "outlines"
  | "episodes"
  | "compliance"
  | "export";

const TRADITIONAL_SCRIPT_FLOW: ScriptWorkflowStep[] = [
  "setup",
  "creative-plan",
  "characters",
  "directory",
  "outlines",
  "episodes",
  "compliance",
  "export",
];

const ADAPTATION_SCRIPT_FLOW: ScriptWorkflowStep[] = [
  "reference-script",
  "structure-transform",
  "character-transform",
  "directory",
  "outlines",
  "episodes",
  "compliance",
  "export",
];

const SCRIPT_STAGE_ALIASES: Record<ScriptWorkflowStep, string[]> = {
  setup: ["选题立项", "立项设定"],
  "reference-script": ["参考剧本", "参考拆解"],
  "creative-plan": ["创作方案", "创意方案"],
  "structure-transform": ["结构转换", "结构转译"],
  characters: ["角色开发", "角色设定"],
  "character-transform": ["角色转换", "角色转译"],
  directory: ["分集目录"],
  outlines: ["单集细纲", "生成单集细纲"],
  episodes: ["分集撰写", "剧本撰写"],
  compliance: ["合规审查", "合规审核"],
  export: ["导出", "导出与出片"],
};

function createStepQuestionOption(
  id: string,
  label: string,
  value: string,
  rationale: string,
  extras?: Partial<ComposerQuestionOption>,
): ComposerQuestionOption {
  return {
    id,
    label,
    value,
    rationale,
    ...extras,
  };
}

function getScriptFlowLayout(
  snapshot: ConversationProjectSnapshot,
  step: ScriptWorkflowStep,
): Pick<ComposerQuestion, "stepIndex" | "totalSteps"> {
  const flow =
    snapshot.projectKind === "adaptation" ? ADAPTATION_SCRIPT_FLOW : TRADITIONAL_SCRIPT_FLOW;
  const stepIndex = Math.max(flow.indexOf(step), 0);
  return {
    stepIndex,
    totalSteps: flow.length,
  };
}

function createScriptWorkflowQuestion(
  snapshot: ConversationProjectSnapshot,
  step: ScriptWorkflowStep,
  answerKey: string,
  title: string,
  description: string,
  options: ComposerQuestionOption[],
  extra?: Partial<Pick<ComposerQuestion, "statusBadges">>,
): ComposerQuestion | null {
  if (!options.length) return null;
  const layout = getScriptFlowLayout(snapshot, step);
  return {
    id: `${answerKey}-${snapshot.projectId}`,
    title,
    description,
    options,
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: layout.stepIndex,
    totalSteps: layout.totalSteps,
    answerKey,
    ...extra,
  };
}

function getSetupPayload(snapshot: ConversationProjectSnapshot) {
  const setupArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "setup" && artifact.payload?.type === "setup",
  );
  return setupArtifact?.payload?.type === "setup" ? setupArtifact.payload : null;
}

function hasReferenceTextArtifact(snapshot: ConversationProjectSnapshot): boolean {
  return snapshot.artifacts.some(
    (artifact) =>
      artifact.kind === "reference" &&
      artifact.label.includes("参考文本") &&
      Boolean(artifact.content?.trim()),
  );
}

function hasReferenceStructureArtifact(snapshot: ConversationProjectSnapshot): boolean {
  const setupPayload = getSetupPayload(snapshot);
  return Boolean(setupPayload?.referenceStructure?.trim()) ||
    snapshot.artifacts.some(
      (artifact) =>
        artifact.kind === "reference" &&
        artifact.label.includes("参考结构") &&
        (Boolean(artifact.content?.trim()) || Boolean(artifact.summary?.trim())),
    );
}

function hasStructureTransformArtifact(snapshot: ConversationProjectSnapshot): boolean {
  return snapshot.artifacts.some(
    (artifact) =>
      artifact.kind === "plan" &&
      (artifact.label.includes("结构") || artifact.summary?.includes("结构")),
  );
}

function buildSetupWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || resolveScriptWorkflowStage(snapshot.derivedStage) !== "setup") {
    return null;
  }

  const options: ComposerQuestionOption[] = snapshot.projectKind === "adaptation"
    ? [
        createStepQuestionOption(
          `${snapshot.projectId}-setup-enter-reference`,
          "进入参考剧本步骤",
          "script:step-enter-reference-script",
          "改编链路会先分析参考剧本，再继续后续结构与角色转换。",
        ),
      ]
    : [
        createStepQuestionOption(
          `${snapshot.projectId}-setup-generate-plan`,
          "生成创作方案",
          "script:generate-creative-plan",
          "确认首页立项信息后，直接生成创作方案与核心冲突。",
        ),
      ];

  return createScriptWorkflowQuestion(
    snapshot,
    "setup",
    "script-setup-v2",
    `《${snapshot.title}》当前处于立项阶段`,
    "先确认首页立项配置，再从步骤面板推进到下一步。",
    options,
  );
}

function buildReferenceScriptWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind === "video" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "reference-script"
  ) {
    return null;
  }

  if (!hasReferenceTextArtifact(snapshot)) {
    return null;
  }

  const hasReferenceStructure = hasReferenceStructureArtifact(snapshot);
  const options = [
    createStepQuestionOption(
      `${snapshot.projectId}-reference-analyze`,
      hasReferenceStructure ? "重新分析参考剧本" : "分析参考剧本",
      "script:analyze-reference-script",
      "提取可复用结构、桥段节奏和改编边界，再回流首页工作流。",
    ),
    hasReferenceStructure
      ? createStepQuestionOption(
          `${snapshot.projectId}-reference-enter-structure`,
          "进入结构转换",
          "script:step-enter-structure-transform",
          "参考结构已经可用，继续把骨架改写成当前项目方案。",
        )
      : null,
  ].filter((option): option is ComposerQuestionOption => Boolean(option));

  return createScriptWorkflowQuestion(
    snapshot,
    "reference-script",
    "script-reference-v2",
    `《${snapshot.title}》先处理参考剧本`,
    hasReferenceStructure
      ? "你可以重新分析参考内容，或直接进入结构转换。"
      : "先把参考剧本拆成可复用结构，再继续改编链路。",
    options,
  );
}

function buildAdaptationEpisodeCountQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind !== "adaptation" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "structure-transform" ||
    !hasReferenceStructureArtifact(snapshot) ||
    hasStructureTransformArtifact(snapshot)
  ) {
    return null;
  }

  const setupPayload = getSetupPayload(snapshot);
  if (setupPayload?.adaptationEpisodeCountConfirmed) {
    return null;
  }

  const recommendedCount =
    typeof setupPayload?.totalEpisodes === "number" && Number.isFinite(setupPayload.totalEpisodes)
      ? Math.max(1, Math.round(setupPayload.totalEpisodes))
      : null;
  const standardOptions = EPISODE_COUNTS
    .filter((item) => item.value > 0 && item.value !== recommendedCount)
    .map((item) =>
      createStepQuestionOption(
        `${snapshot.projectId}-adaptation-episode-count-${item.value}`,
        item.label,
        `script:adaptation-total-episodes:${item.value}`,
        "按该集数规格继续后续结构转换、目录和分集撰写。",
      ),
    );
  const options: ComposerQuestionOption[] = [
    recommendedCount
      ? createStepQuestionOption(
          `${snapshot.projectId}-adaptation-episode-count-ai`,
          `AI 推荐（${recommendedCount}集）`,
          `script:adaptation-total-episodes:${recommendedCount}`,
          "采用参考剧本分析后给出的推荐集数。",
        )
      : null,
    ...standardOptions,
    createStepQuestionOption(
      `${snapshot.projectId}-adaptation-episode-count-custom`,
      "自定义",
      "script:adaptation-total-episodes:custom",
      "手动输入改编后的总集数。",
      {
        childInput: {
          type: "number",
          actionPrefix: "script:adaptation-total-episodes:custom:",
          min: 1,
          max: 1000,
          placeholder: "输入总集数",
          suffix: "集",
          buttonLabel: "确认集数",
          labelTemplate: "自定义 {value} 集",
        },
      },
    ),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));
  const layout = getScriptFlowLayout(snapshot, "structure-transform");

  return {
    id: `script-adaptation-episode-count-${snapshot.projectId}`,
    title: "请选择改编集数",
    description: "参考剧本已经分析完成。先确认改编后的总集数，再确认目标市场，然后进入结构转换。",
    options,
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    ...layout,
    answerKey: "script-adaptation-episode-count",
  };
}

function buildAdaptationTargetMarketQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind !== "adaptation" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "structure-transform" ||
    !hasReferenceStructureArtifact(snapshot) ||
    hasStructureTransformArtifact(snapshot)
  ) {
    return null;
  }

  const setupPayload = getSetupPayload(snapshot);
  if (!setupPayload?.adaptationEpisodeCountConfirmed || setupPayload.adaptationTargetMarketConfirmed) {
    return null;
  }

  const currentMarket = setupPayload.targetMarket;
  const layout = getScriptFlowLayout(snapshot, "structure-transform");
  return {
    id: `script-adaptation-target-market-${snapshot.projectId}`,
    title: "请选择目标市场",
    description: "目标市场会写入结构转换提示词，影响语言、节奏、审美和后续分集生成约束。",
    options: TARGET_MARKETS.map((market) =>
      createStepQuestionOption(
        `${snapshot.projectId}-adaptation-target-market-${market.value}`,
        currentMarket === market.value ? `AI 推荐：${market.label}` : market.label,
        `script:adaptation-target-market:${market.value}`,
        market.desc,
        { selected: currentMarket === market.value },
      ),
    ),
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    ...layout,
    answerKey: "script-adaptation-target-market",
  };
}

function buildGenreRationale(genre: (typeof GENRES)[number]): string {
  return `${genre.category} · ${genre.desc} · 受众：${genre.audience}`;
}

function buildAdaptationGenresQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind !== "adaptation" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "structure-transform" ||
    !hasReferenceStructureArtifact(snapshot) ||
    hasStructureTransformArtifact(snapshot)
  ) {
    return null;
  }

  const setupPayload = getSetupPayload(snapshot);
  if (
    !setupPayload?.adaptationEpisodeCountConfirmed ||
    !setupPayload.adaptationTargetMarketConfirmed ||
    setupPayload.adaptationGenresConfirmed
  ) {
    return null;
  }

  const targetMarket = setupPayload.targetMarket || "cn";
  const genreOptions = GENRES.filter((genre) =>
    (genre.markets as readonly string[]).includes(targetMarket),
  );
  const visibleOptions =
    genreOptions.length > 0
      ? genreOptions
      : GENRES.filter((genre) => (genre.markets as readonly string[]).includes("cn")).slice(0, 12);
  const layout = getScriptFlowLayout(snapshot, "structure-transform");

  return {
    id: `script-adaptation-genres-${snapshot.projectId}:genres`,
    title: "请选择方向题材",
    description:
      genreOptions.length > 0
        ? "参考原创剧本面板，最多选 2 个更贴近这次改编方向的题材。"
        : "这个市场暂时没有完整预设，我先给你一组通用题材，也可以直接自定义输入。",
    options: visibleOptions.map((genre) =>
      createStepQuestionOption(
        `${snapshot.projectId}-adaptation-genre-${genre.value}`,
        genre.label,
        genre.value,
        buildGenreRationale(genre),
      ),
    ),
    allowCustomInput: true,
    submissionMode: "confirm",
    multiSelect: true,
    ...layout,
    answerKey: "题材选择",
  };
}

function buildStructureTransformWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind === "video" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "structure-transform"
  ) {
    return null;
  }

  const hasStructureTransform = hasStructureTransformArtifact(snapshot);
  const options = [
    createStepQuestionOption(
      `${snapshot.projectId}-structure-generate`,
      hasStructureTransform ? "重新生成结构转换" : "生成结构转换",
      "script:generate-structure-transform",
      "把参考结构改写成适合当前项目的原创骨架，避免直接照搬。",
    ),
    hasStructureTransform
      ? createStepQuestionOption(
          `${snapshot.projectId}-structure-enter-character-transform`,
          "进入角色转换",
          "script:step-enter-character-transform",
          "结构转换已完成，可以继续完成人设与关系迁移。",
        )
      : null,
  ].filter((option): option is ComposerQuestionOption => Boolean(option));

  return createScriptWorkflowQuestion(
    snapshot,
    "structure-transform",
    "script-structure-transform-v2",
    `《${snapshot.title}》正在做结构转换`,
    hasStructureTransform
      ? "结构稿已经可用，可以直接进入角色转换。"
      : "先把参考结构转成当前剧本的叙事框架。",
    options,
  );
}

function buildCharacterTransformWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (
    snapshot.projectKind === "video" ||
    resolveScriptWorkflowStage(snapshot.derivedStage) !== "character-transform"
  ) {
    return null;
  }

  const hasCharacterTransform = snapshot.artifacts.some(
    (artifact) =>
      artifact.kind === "characters" &&
      (artifact.label.includes("角色转") || artifact.summary?.includes("角色")),
  );
  const options = [
    createStepQuestionOption(
      `${snapshot.projectId}-character-transform-generate`,
      hasCharacterTransform ? "重新生成角色转换" : "生成角色转换",
      "script:generate-character-transform",
      "把参考人物功能重组为当前项目的人设、关系轴与核心冲突。",
    ),
    hasCharacterTransform
      ? createStepQuestionOption(
          `${snapshot.projectId}-character-transform-enter-directory`,
          "进入分集目录",
          "script:step-enter-directory",
          "角色转换已收口，可以继续规划分集目录。",
        )
      : null,
  ].filter((option): option is ComposerQuestionOption => Boolean(option));

  return createScriptWorkflowQuestion(
    snapshot,
    "character-transform",
    "script-character-transform-v2",
    `《${snapshot.title}》已进入角色转换阶段`,
    hasCharacterTransform
      ? "人物转换结果已可用，可以继续推进到目录阶段。"
      : "先把改编链路的人设和关系网整理完整。",
    options,
  );
}

function buildComplianceWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || resolveScriptWorkflowStage(snapshot.derivedStage) !== "compliance") {
    return null;
  }

  const complianceArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "compliance" && artifact.payload?.type === "complianceSummary",
  );
  const payload =
    complianceArtifact?.payload?.type === "complianceSummary" ? complianceArtifact.payload : null;
  const workspace = payload?.workspace;
  const progress = workspace?.progress;
  const latestReview = workspace?.latestReview;
  const sourceLength = workspace?.sourceText.trim().length ?? 0;
  const paletteLength = workspace?.paletteText.trim().length ?? 0;
  const importedFileName = workspace?.lastImportedFileName;
  const exportedFormat = workspace?.exportMeta?.lastExportFormat;
  const pendingRiskCount = workspace?.riskPhrases.filter((p) => p.status !== "resolved").length ?? 0;

  const options = [
    createStepQuestionOption(
      `${snapshot.projectId}-compliance-run`,
      latestReview ? "重新合规审查" : "开始完整合规审查",
      "script:compliance-run:text",
      latestReview
        ? "保留当前工作台状态，重新跑完整审核并继续更新风险定位。"
        : "从首页直接运行完整版合规审查，产出风险报告、调色盘与修订包。",
      {
        children: [
          createStepQuestionOption(
            `${snapshot.projectId}-compliance-run-text`,
            "文字审核",
            "script:compliance-run:text",
            "优先检查措辞、敏感表达和文本层面的风险。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-compliance-run-script`,
            "情节审核",
            "script:compliance-run:script",
            "连同情节推进、桥段呈现和画面风险一起审查。",
          ),
        ],
      },
    ),
    createStepQuestionOption(
      `${snapshot.projectId}-compliance-strictness`,
      `严格度：${{ standard: "标准", strict: "严格", extreme: "极限" }[workspace?.strictness ?? "standard"] ?? "标准"}`,
      `script:compliance-set-strictness:${workspace?.strictness ?? "standard"}`,
      "标准、严格、极限三档都会持久化保存到当前项目。",
      {
        children: [
          createStepQuestionOption(
            `${snapshot.projectId}-compliance-strictness-standard`,
            "标准",
            "script:compliance-set-strictness:standard",
            "平衡效率与覆盖面，适合大多数常规项目。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-compliance-strictness-strict`,
            "严格",
            "script:compliance-set-strictness:strict",
            "提高敏感片段抓取力度，适合交付前复核。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-compliance-strictness-extreme`,
            "极限",
            "script:compliance-set-strictness:extreme",
            "最保守口径，优先扩大风险覆盖范围。",
          ),
        ],
      },
    ),
    workspace
      ? createStepQuestionOption(
          `${snapshot.projectId}-compliance-ops`,
          "工作台快捷操作",
          "script:compliance-auto-adjust",
          "批量自动改写、台词超限复核和调色盘导出都在这里继续。",
          {
            children: [
              ...(latestReview && pendingRiskCount > 0
                ? [
                    createStepQuestionOption(
                      `${snapshot.projectId}-compliance-auto-adjust`,
                      "批量自动改写",
                      "script:compliance-auto-adjust",
                      "自动为未解决风险生成更安全的替代表达并回写调色盘。",
                    ),
                  ]
                : []),
              createStepQuestionOption(
                `${snapshot.projectId}-compliance-toggle-dialogue`,
                workspace.dialogueReviewEnabled ? "关闭台词超限审查" : "开启台词超限审查",
                workspace.dialogueReviewEnabled
                  ? "script:compliance-toggle-dialogue:off"
                  : "script:compliance-toggle-dialogue:on",
                workspace.dialogueReviewEnabled
                  ? "保留当前风险结果，关闭台词长度超限复核。"
                  : "把台词超限审查纳入下一次完整合规审查。",
              ),
              ...(paletteLength > 0
                ? [
                    createStepQuestionOption(
                      `${snapshot.projectId}-compliance-export`,
                      "导出调色盘",
                      exportedFormat === "xlsx" ? "script:compliance-export:xlsx" : "script:compliance-export:docx",
                      "把调色盘文本对比结果导出为文件，并回写到当前项目。",
                    ),
                  ]
                : []),
            ],
          },
        )
      : null,
    latestReview
      ? createStepQuestionOption(
          `${snapshot.projectId}-compliance-export-step`,
          "进入导出与出片",
          "script:step-enter-export",
          "本轮合规审查已完成，确认后进入导出与出片。",
        )
      : null,
    latestReview
      ? null
      : createStepQuestionOption(
          `${snapshot.projectId}-compliance-skip`,
          "跳过审查",
          "script:skip-compliance-review",
          "跳过第 7 步合规审查，直接进入第 8 步导出，导出区会标记为已跳过。",
        ),
  ].filter((option): option is ComposerQuestionOption => Boolean(option));

  const progressSummary = progress
    ? `当前进度 ${progress.completed}/${progress.total}，状态 ${progress.status}。`
    : latestReview
      ? `最近一次审查切分 ${latestReview.segmentCount} 段。`
      : "尚未运行完整版审查。";

  const description = [
    progressSummary,
    sourceLength ? `待审文本 ${sourceLength.toLocaleString()} 字。` : "待审文本尚未准备好。",
    paletteLength ? `调色盘 ${paletteLength.toLocaleString()} 字。` : null,
    importedFileName ? `已导入文件：${importedFileName}。` : null,
    workspace?.tableSnapshot ? `当前表格快照 ${workspace.tableSnapshot.rows.length} 行。` : null,
    workspace?.dialogueOverLimitLineIndexes.length
      ? `台词超限命中 ${workspace.dialogueOverLimitLineIndexes.length} 处。`
      : null,
    payload?.skippedAt ? `本轮曾跳过合规：${payload.skippedAt}。` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return createScriptWorkflowQuestion(
    snapshot,
    "compliance",
    "script-compliance-workspace",
    `《${snapshot.title}》合规审查`,
    description,
    options,
    {
      statusBadges: [
        ...(pendingRiskCount > 0 ? [{ label: "风险片段", value: pendingRiskCount, tone: "danger" as const }] : []),
      ],
    },
  );
}

function buildExportWorkflowQuestionV2(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  if (snapshot.projectKind === "video" || resolveScriptWorkflowStage(snapshot.derivedStage) !== "export") {
    return null;
  }

  const exportArtifact = snapshot.artifacts.find(
    (artifact) => artifact.kind === "export" && artifact.payload?.type === "exportSummary",
  );
  const payload = exportArtifact?.payload?.type === "exportSummary" ? exportArtifact.payload : null;
  const complianceStatus = payload?.complianceStatus ?? "pending";
  const hasExportDocument = Boolean(payload?.exportDocument?.trim());

  const options: ComposerQuestionOption[] = [
    // 一级：用于视频创作
    createStepQuestionOption(
      `${snapshot.projectId}-export-video`,
      "用于视频创作",
      "script:export-video",
      "把当前剧本直接桥接到首页视频工作流，不切出独立页面。",
    ),
    // 一级：快速拼接（二级：复制 / 下载.md）
    createStepQuestionOption(
      `${snapshot.projectId}-export-quick-splice`,
      "快速拼接",
      "script:export-quick-splice",
      "不走 AI，直接在前端组装导出文本，包含封面、角色表、创作方案和分集剧本。",
      {
        children: [
          createStepQuestionOption(
            `${snapshot.projectId}-export-copy`,
            "复制",
            "script:export-copy",
            "把快速拼接结果复制到系统剪贴板。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-export-download-md`,
            "下载.md",
            "script:export-download-md",
            "把快速拼接结果下载为 Markdown 文件。",
          ),
        ],
      },
    ),
    // 一级：导出（二级：AI整合导出 / 导出Word / 分集下载）
    createStepQuestionOption(
      `${snapshot.projectId}-export-group`,
      "导出",
      "script:export-group",
      "选择导出格式：AI 整合导出、Word 文档或分集下载。",
      {
        children: [
          createStepQuestionOption(
            `${snapshot.projectId}-export-document`,
            hasExportDocument ? "重新AI整合导出" : "AI整合导出",
            hasExportDocument ? "script:export-refine" : "script:export-document",
            hasExportDocument
              ? "沿用当前导出稿继续调整结构、语气和交付格式。"
              : "整理完整交付稿，供后续下载、导出和出片衔接。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-export-word`,
            "导出Word",
            "script:export-word",
            "把当前剧本导出为 .docx Word 文档。",
          ),
          createStepQuestionOption(
            `${snapshot.projectId}-export-episodes-download`,
            "分集下载",
            "script:export-episodes-download",
            "逐集下载为多个 Markdown 文件。",
          ),
        ],
      },
    ),
    // devOnly：合规审查入口
    ...(complianceStatus !== "reviewed"
      ? [createStepQuestionOption(
          `${snapshot.projectId}-export-compliance`,
          complianceStatus === "skipped" ? "重新进入合规审查" : "进入完整合规审查",
          "script:step-enter-compliance",
          complianceStatus === "skipped"
            ? "本轮已主动跳过合规；这里可以随时回到完整工作台继续审核。"
            : "在导出前回到完整合规工作台，继续审查、改写或导出调色盘。",
          { devOnly: true },
        )]
      : []),
  ];

  const description =
    complianceStatus === "reviewed"
      ? "当前项目已完成合规审查，可以直接导出和桥接视频。"
      : complianceStatus === "skipped"
        ? `本次已跳过合规审查${payload?.skippedAt ? `（${payload.skippedAt}）` : ""}，导出区会持续保留该提示。`
        : "当前导出仍处于待审查状态，你也可以先回到完整合规工作台。";

  return createScriptWorkflowQuestion(
    snapshot,
    "export",
    "script-export-v2",
    `《${snapshot.title}》导出与桥接面板`,
    description,
    options,
  );
}

export function resolveScriptWorkflowStage(stage: string): ScriptWorkflowStep | null {
  const normalizedStage = stage.trim();
  if (!normalizedStage) return null;

  for (const [step, aliases] of Object.entries(SCRIPT_STAGE_ALIASES) as Array<
    [ScriptWorkflowStep, string[]]
  >) {
    if (aliases.includes(normalizedStage)) {
      return step;
    }
  }

  return resolveScriptWorkflowStageLegacy(stage);
}

export function buildScriptPacketQuestion(snapshot: ConversationProjectSnapshot): ComposerQuestion | null {
  switch (resolveScriptWorkflowStage(snapshot.derivedStage)) {
    case "setup":
      return buildSetupWorkflowQuestionV2(snapshot);
    case "reference-script":
      return buildReferenceScriptWorkflowQuestionV2(snapshot);
    case "creative-plan":
      return buildCreativePlanWorkflowQuestion(snapshot);
    case "structure-transform":
      return buildAdaptationEpisodeCountQuestion(snapshot) ??
        buildAdaptationTargetMarketQuestion(snapshot) ??
        buildAdaptationGenresQuestion(snapshot) ??
        buildStructureTransformWorkflowQuestionV2(snapshot);
    case "characters":
      return buildCharactersWorkflowQuestion(snapshot);
    case "character-transform":
      return buildCharacterTransformWorkflowQuestionV2(snapshot);
    case "directory":
      return buildDirectoryWorkflowQuestion(snapshot);
    case "outlines":
      return buildOutlinesWorkflowQuestion(snapshot);
    case "episodes":
      return buildEpisodeWorkflowQuestion(snapshot);
    case "compliance":
      return buildComplianceWorkflowQuestionV2(snapshot) ?? buildComplianceQuestion(snapshot);
    case "export":
      return buildExportWorkflowQuestionV2(snapshot) ?? buildExportWorkflowQuestion(snapshot);
    default:
      return buildScriptPacketQuestionLegacy(snapshot);
  }
}

export const brief = (snapshot: ConversationProjectSnapshot) =>
  [
    `已恢复项目《${snapshot.title}》。`,
    `当前阶段：${snapshot.derivedStage}`,
    `当前目标：${snapshot.currentObjective}`,
    summarizeRecoveryArtifacts(snapshot),
    snapshot.agentSummary,
    snapshot.recommendedActions.length ? `建议下一步：\n${snapshot.recommendedActions.slice(0, 3).map((action) => `- ${action}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

export const recQuestion = (snapshot: ConversationProjectSnapshot, videoProject?: PersistedVideoProject | null): ComposerQuestion | null => {
  const setupArtifact = snapshot.artifacts.find((a) => a.label === "项目设定");
  const setupSummary = setupArtifact?.summary?.trim();
  const scriptWorkflowStage =
    snapshot.projectKind === "script" || snapshot.projectKind === "adaptation"
      ? resolveScriptWorkflowStage(snapshot.derivedStage)
      : null;
  const scriptPacketQuestion = buildScriptPacketQuestion(snapshot);

  if (scriptWorkflowStage) {
    return scriptPacketQuestion;
  }

  return buildVideoContinuationQuestion(snapshot, videoProject) ??
  scriptPacketQuestion ??
  ((snapshot.projectKind === "script" || snapshot.projectKind === "adaptation") && resolveScriptWorkflowStage(snapshot.derivedStage)
    ? null
    : snapshot.recommendedActions.length
    ? {
        id: `r-${snapshot.projectId}`,
        title: snapshot.recommendedActions.length === 1
          ? `下一步：${snapshot.recommendedActions[0]}`
          : snapshot.recommendedActions.includes("修改创作冲突")
            ? "创作方案已生成，下一步怎么走？"
            : `我已分析《${snapshot.title}》的当前状态，下一步先推进哪一块？`,
        description: snapshot.recommendedActions.length === 1
          ? setupSummary
            ? `当前配置：${setupSummary.replace(/\n/g, " · ")} 确认后直接执行。`
            : `${summarizeRecoveryArtifacts(snapshot)} 确认后直接执行。`
          : snapshot.recommendedActions.includes("修改创作冲突")
            ? "可以直接进入角色开发，或先调整创作方案中的核心冲突。"
            : `${summarizeRecoveryArtifacts(snapshot)} 你也可以直接输入自定义指令。`,
        options: snapshot.recommendedActions.slice(0, 3).map((action, index) => ({
          id: `${snapshot.projectId}-${index}`,
          label: action,
          value: action,
          rationale: buildRecoveryActionRationale(snapshot, action, index),
        })),
        allowCustomInput: true,
        submissionMode: snapshot.recommendedActions.length === 1 ? "confirm" : "immediate",
        multiSelect: false,
        stepIndex: 0,
        totalSteps: 1,
        answerKey: "recovery",
      }
    : null);
};

export function isVideoIntentPrompt(prompt: string, snapshot?: ConversationProjectSnapshot | null): boolean {
  if (snapshot?.projectKind === "video") return true;
  const lowered = prompt.trim().toLowerCase();
  if (!lowered) return false;
  return ["视频", "分镜", "镜头", "出片", "提示词批次", "seedance", "dreamina", "即梦", "text2video", "image2video"].some((keyword) => lowered.includes(keyword));
}

export function buildDreaminaCapabilityOverlay(message?: string): string {
  const capabilitySummary = message?.trim() || "已检测到本机 Dreamina CLI 登录态";
  return [
    "当前运行环境附加能力：",
    `${capabilitySummary}，可直接使用官方 Dreamina CLI 继续 Seedance 2.0 / Seedance 2.0 Fast 视频生成。`,
    "当用户进入视频工作流、镜头出片、提示词批次或资产续接时，你应把这项能力纳入分析，并优先给出基于当前本机能力可直接执行的建议。",
  ].join("\n");
}

export function listPendingSkillDrafts(drafts: SkillDraft[]): SkillDraft[] {
  return drafts.filter((draft) => draft.status === "pending");
}

export function listApprovedSkillDrafts(drafts: SkillDraft[]): SkillDraft[] {
  return drafts.filter((draft) => draft.status === "approved");
}

export function findSkillDraft(drafts: SkillDraft[], draftId: string): SkillDraft | null {
  return drafts.find((draft) => draft.id === draftId) ?? null;
}

export function buildMaintenanceReviewQuestion(
  runtime: Pick<StudioRuntimeState, "skillDrafts" | "maintenanceReports">,
): ComposerQuestion | null {
  const pendingDrafts = listPendingSkillDrafts(runtime.skillDrafts);
  const approvedDrafts = listApprovedSkillDrafts(runtime.skillDrafts);
  const latestReport = runtime.maintenanceReports[0] ?? null;
  if (!pendingDrafts.length && !approvedDrafts.length && !latestReport) return null;

  const options = [
    latestReport
      ? {
          id: "maintenance-report-latest",
          label: "查看最近维护结论",
          value: "maintenance:report:latest",
          rationale: "先看最近一次静默压缩和本地整理结论，再决定是否继续处理。",
        }
      : null,
    pendingDrafts.length
      ? {
          id: "maintenance-skill-drafts",
          label: `查看 ${pendingDrafts.length} 份待审核技能草案`,
          value: "maintenance:skills",
          rationale: "先浏览待审核草案，决定哪些值得继续沉淀成正式能力。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-drafts",
          label: `查看 ${approvedDrafts.length} 份已批准技能草案`,
          value: "maintenance:skills:approved",
          rationale: "回看已经批准的候选能力，确认后续整理优先级。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-drafts-export",
          label: "导出已批准技能候选",
          value: "maintenance:skills:export-approved",
          rationale: "把已批准草案导出到本地候选目录，方便后续整理正式 skills。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-drafts-preview",
          label: "预览已批准 Bundle 摘要",
          value: "maintenance:skills:preview-approved",
          rationale: "先在首页里查看已批准草案的合并摘要，再决定是否导出正式 bundle 文件。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-drafts-open",
          label: "打开技能候选目录",
          value: "maintenance:skills:open-approved-dir",
          rationale: "直接打开本地候选目录，查看已导出的技能草案和 bundle 文件。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-install-candidates",
          label: "生成正式 Skill 安装候选",
          value: "maintenance:skills:package-install-candidates",
          rationale: "把已批准草案整理成不会自动生效的正式 Skill 候选文件，方便后续人工审核和搬运。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-install-candidates-preview",
          label: "预览安装候选摘要",
          value: "maintenance:skills:preview-install-candidates",
          rationale: "先在首页查看正式 Skill 候选会怎么组织，再决定是否导出到本地审核目录。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-install-candidates-open",
          label: "打开安装候选目录",
          value: "maintenance:skills:open-install-candidates-dir",
          rationale: "直接打开正式 Skill 候选目录，查看待审核的候选文件和审核清单。",
        }
      : null,
    approvedDrafts.length
      ? {
          id: "maintenance-approved-skill-drafts-bundle",
          label: "导出 Bundle 文件",
          value: "maintenance:skills:bundle-approved",
          rationale: "把已批准草案写成本地 bundle 文件，便于后续正式打包和归档。",
        }
      : null,
    {
      id: "maintenance-run",
      label: "执行一次维护检查",
      value: "maintenance:run",
      rationale: "重新整理长会话、草案队列和维护状态，生成新的本地报告。",
    },
  ].filter((option): option is NonNullable<typeof option> => Boolean(option));

  return {
    id: "maintenance-review-home",
    title: pendingDrafts.length
      ? `我已整理出 ${pendingDrafts.length} 份待审核技能草案${approvedDrafts.length ? `，另有 ${approvedDrafts.length} 份已批准候选` : ""}${latestReport ? "，并带着最近维护结论" : ""}。`
      : approvedDrafts.length
        ? `当前已有 ${approvedDrafts.length} 份已批准技能草案${latestReport ? "，并带着最近维护结论" : ""}。`
        : "我已整理出最近一次首页维护结论。",
    description: latestReport
      ? `${latestReport.summary} 你也可以直接输入新的创作或维护指令。`
      : "你也可以直接输入新的创作或维护指令。",
    options,
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "maintenance-review",
  };
}

export function buildSkillDraftListQuestion(drafts: SkillDraft[]): ComposerQuestion | null {
  const pendingDrafts = listPendingSkillDrafts(drafts);
  if (!pendingDrafts.length) return null;

  return {
    id: "maintenance-skill-drafts-list",
    title: "先看哪一份待审核技能草案？",
    description: "只会在首页展开草案摘要，不会自动生效。",
    options: pendingDrafts.slice(0, 5).map((draft) => ({
      id: draft.id,
      label: draft.proposedSkillName,
      value: `maintenance:skill:${draft.id}`,
      rationale: draft.reason || "查看这份草案的来源和建议内容。",
    })),
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "maintenance-skill-drafts",
  };
}

export function buildApprovedSkillDraftListQuestion(drafts: SkillDraft[]): ComposerQuestion | null {
  const approvedDrafts = listApprovedSkillDrafts(drafts);
  if (!approvedDrafts.length) return null;

  return {
    id: "maintenance-approved-skill-drafts-list",
    title: "先看哪一份已批准技能草案？",
    description: "这些草案已经通过人工确认，可以作为后续正式技能整理候选。",
    options: approvedDrafts.slice(0, 6).map((draft) => ({
      id: draft.id,
      label: draft.proposedSkillName,
      value: `maintenance:skill-approved:${draft.id}`,
      rationale: draft.reason || "查看这份已批准草案的摘要和候选内容。",
    })),
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "maintenance-approved-skill-drafts",
  };
}

export function buildApprovedSkillDraftBundlePreviewMessage(drafts: SkillDraft[]): string {
  const approvedDrafts = listApprovedSkillDrafts(drafts);
  if (!approvedDrafts.length) {
    return "当前还没有已批准技能草案可预览。";
  }

  return [
    `当前共有 ${approvedDrafts.length} 份已批准技能草案，可继续整理成正式 skills。`,
    ...approvedDrafts.slice(0, 3).flatMap((draft, index) => [
      `${index + 1}. ${draft.proposedSkillName}`,
      `原因：${truncateCopy(draft.reason || "未提供原因", 80)}`,
      draft.proposedContent.trim()
        ? `候选内容：${truncateCopy(draft.proposedContent, 160)}`
        : "候选内容：未提供候选内容",
    ]),
    approvedDrafts.length > 3 ? `其余 ${approvedDrafts.length - 3} 份草案已保留在已批准列表中。` : "",
    "如果需要，我也可以继续把这些已批准草案导出到本地候选目录或生成 bundle 文件。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildApprovedSkillInstallCandidatePreviewMessage(drafts: SkillDraft[]): string {
  const approvedDrafts = listApprovedSkillDrafts(drafts);
  if (!approvedDrafts.length) {
    return "当前还没有已批准技能草案可整理为正式 Skill 候选。";
  }

  return [
    `我会把 ${approvedDrafts.length} 份已批准草案整理成待审核的正式 Skill 候选文件。`,
    "这些候选不会自动写入 .claude/skills，也不会被当前 loader 自动启用。",
    ...approvedDrafts.slice(0, 3).flatMap((draft, index) => [
      `${index + 1}. ${draft.proposedSkillName}`,
      `候选文件：${draft.proposedSkillName.trim() ? draft.proposedSkillName.trim().replace(/\s+/g, "-").toLowerCase() : "skill-draft"}.md`,
      `审核重点：${truncateCopy(draft.reason || "先确认它是否值得进入正式能力集合。", 90)}`,
    ]),
    approvedDrafts.length > 3 ? `其余 ${approvedDrafts.length - 3} 份会继续保留在同一候选目录中。` : "",
    "导出后还会附带 INSTALL-REVIEW.md，方便人工逐条核对再搬运。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSkillDraftDecisionQuestion(draft: SkillDraft): ComposerQuestion {
  return {
    id: `maintenance-skill-draft-${draft.id}`,
    title: `《${draft.proposedSkillName}》这份技能草案怎么处理？`,
    description: "只有你确认后才会写入正式状态；也可以先返回草案列表继续查看别的草案。",
    options: [
      {
        id: `${draft.id}-approve`,
        label: "批准这份草案",
        value: `maintenance:skill-approve:${draft.id}`,
        rationale: "将这份草案标记为已批准，后续可进入正式 skill 整理流程。",
      },
      {
        id: `${draft.id}-reject`,
        label: "驳回这份草案",
        value: `maintenance:skill-reject:${draft.id}`,
        rationale: "将这份草案标记为已拒绝，避免它继续出现在待审核列表里。",
      },
      {
        id: `${draft.id}-back`,
        label: "返回草案列表",
        value: "maintenance:skills",
        rationale: "继续查看其他待审核技能草案。",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "maintenance-skill-decision",
  };
}

export function buildMaintenanceReportMessage(report: MaintenanceReport): string {
  return [
    `最近一次维护已完成：${report.summary}`,
    `压缩会话 ${report.compressedConversationCount} 条，归档项目 ${report.archivedProjectCount} 条，归并重复草案 ${report.mergedDraftCount} 条。`,
    report.notes.length ? `维护备注：${report.notes.slice(0, 3).join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSkillDraftSummaryMessage(draft: SkillDraft): string {
  return [
    `${draft.status === "approved" ? "已批准技能草案" : draft.status === "rejected" ? "已驳回技能草案" : "待审核技能草案"}《${draft.proposedSkillName}》`,
    `来源：${draft.sourceConversationIds.length} 条会话`,
    `原因：${draft.reason}`,
    draft.proposedContent.trim() ? `草案内容：${truncateCopy(draft.proposedContent, 220)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
