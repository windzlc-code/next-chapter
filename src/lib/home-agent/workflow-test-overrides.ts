import type {
  ConversationArtifact,
  ConversationProjectSnapshot,
  StudioRuntimeState,
  WorkflowActionProgressCallback,
  WorkflowActionResult,
} from "./types";

export const WORKFLOW_TEST_SCENARIO_KEY = "storyforge_home_agent_workflow_test_scenario";
export const WORKFLOW_TEST_TRACE_KEY = "storyforge_home_agent_workflow_test_trace";
const DRAMA_PROJECTS_STORAGE_KEY = "storyforge_drama_projects";
const VIDEO_PROJECTS_STORAGE_KEY = "storyforge_projects";

export const FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO = "full-auto-original-script";
export const FULL_AUTO_ADAPTATION_SMOKE_SCENARIO = "full-auto-adaptation";
export const FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO = "full-auto-video-workflow";

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore localStorage access failures in non-browser test environments.
  }

  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      return globalThis.localStorage ?? null;
    }
  } catch {
    // Ignore localStorage access failures in non-browser test environments.
  }

  return null;
}

function readWorkflowTestScenario(): string | null {
  const storage = getStorage();
  const raw = storage?.getItem(WORKFLOW_TEST_SCENARIO_KEY)?.trim();
  return raw || null;
}

function readTrace(): Array<Record<string, unknown>> {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(WORKFLOW_TEST_TRACE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendTrace(entry: Record<string, unknown>): void {
  const storage = getStorage();
  if (!storage) return;
  const trace = readTrace();
  trace.push(entry);
  storage.setItem(WORKFLOW_TEST_TRACE_KEY, JSON.stringify(trace));
}

function persistProjectToWorkflowTestStorage(
  storageKey: string,
  project: Record<string, unknown> | null | undefined,
): void {
  const storage = getStorage();
  if (!storage || !project) return;

  const projectId = trimString(project.id);
  if (!projectId) return;

  try {
    const raw = storage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    const projects = Array.isArray(parsed) ? parsed.filter((item) => item?.id !== projectId) : [];
    projects.unshift(project);
    storage.setItem(storageKey, JSON.stringify(projects));
  } catch {
    // Ignore localStorage write failures in workflow smoke overrides.
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function coerceTotalEpisodes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 40;
}

function buildArtifact(
  id: string,
  kind: ConversationArtifact["kind"],
  label: string,
  summary: string,
): ConversationArtifact {
  return {
    id,
    kind,
    label,
    summary,
    updatedAt: nowIso(),
  };
}

function sanitizeTitleCandidate(value: string): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/[《》"'`“”]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "";
}

function resolveProjectTitle(input: Record<string, unknown>, runtime: StudioRuntimeState): string {
  const candidates = [
    trimString(input.title),
    trimString(
      typeof input.creativeInput === "string"
        ? String(input.creativeInput).split(/[。！？!?]/u)[0]
        : "",
    ),
    trimString(runtime.currentDramaProject?.dramaTitle),
    trimString(runtime.currentProjectSnapshot?.title),
  ];

  for (const candidate of candidates) {
    const sanitized = sanitizeTitleCandidate(candidate);
    if (!sanitized || /^(未命名项目|未命名剧本项目)$/u.test(sanitized)) continue;
    return sanitized.length > 24 ? sanitized.slice(0, 24).trim() : sanitized;
  }

  return "原创剧本全自动烟测项目";
}

function resolveScriptProjectId(input: Record<string, unknown>, runtime: StudioRuntimeState): string {
  return (
    trimString(input.projectId) ||
    trimString(runtime.currentDramaProject?.id) ||
    trimString(runtime.currentProjectSnapshot?.projectId) ||
    `full-auto-script-${Date.now()}`
  );
}

function resolveVideoProjectId(runtime: StudioRuntimeState, sourceProjectId: string): string {
  return trimString(runtime.currentVideoProject?.id) || `${sourceProjectId}-video`;
}

function buildScriptSnapshot(params: {
  projectId: string;
  title: string;
  derivedStage: string;
  currentObjective: string;
  agentSummary: string;
  recommendedActions: string[];
  artifacts?: ConversationArtifact[];
  projectKind?: ConversationProjectSnapshot["projectKind"];
}): ConversationProjectSnapshot {
  return {
    projectId: params.projectId,
    projectKind: params.projectKind ?? "script",
    title: params.title,
    currentObjective: params.currentObjective,
    derivedStage: params.derivedStage,
    agentSummary: params.agentSummary,
    recommendedActions: params.recommendedActions,
    artifacts: params.artifacts ?? [],
    updatedAt: nowIso(),
  };
}

function buildVideoSnapshot(params: {
  projectId: string;
  sourceProjectId: string;
  title: string;
  derivedStage: string;
  currentObjective: string;
  agentSummary: string;
  recommendedActions: string[];
  artifacts?: ConversationArtifact[];
  shotPackets?: unknown[];
  videoScenes?: Array<{
    id: string;
    sceneNumber: number;
    sceneName: string;
    segmentLabel?: string;
    videoStatus?: string;
    videoTaskId?: string;
    videoUrl?: string;
  }>;
}): ConversationProjectSnapshot {
  return {
    projectId: params.projectId,
    projectKind: "video",
    sourceProjectId: params.sourceProjectId,
    title: params.title,
    currentObjective: params.currentObjective,
    derivedStage: params.derivedStage,
    agentSummary: params.agentSummary,
    recommendedActions: params.recommendedActions,
    artifacts: params.artifacts ?? [],
    updatedAt: nowIso(),
    memory: {
      shotPackets: (params.shotPackets ?? []) as ConversationProjectSnapshot["memory"]["shotPackets"],
      videoScenes: (params.videoScenes ?? []) as ConversationProjectSnapshot["memory"]["videoScenes"],
      reviewQueue: [],
    },
  };
}

function buildDramaProject(params: {
  projectId: string;
  title: string;
  input: Record<string, unknown>;
  creativePlan?: string;
  characters?: unknown[];
  directory?: unknown[];
  outlines?: unknown[];
  episodes?: unknown[];
  projectKind?: ConversationProjectSnapshot["projectKind"];
  referenceScript?: string;
  referenceStructure?: string;
  structureTransform?: string;
  characterTransform?: string;
}): Record<string, unknown> {
  const projectKind = params.projectKind === "adaptation" ? "adaptation" : "script";
  return {
    id: params.projectId,
    dramaTitle: params.title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    currentStep: "creative-plan",
    mode: projectKind === "adaptation" ? "adaptation" : "traditional",
    setup: {
      projectKind,
      setupMode: trimString(params.input.setupMode) || "creative",
      genres: Array.isArray(params.input.genres)
        ? params.input.genres
        : [trimString(params.input.genres)].filter(Boolean),
      audience: trimString(params.input.audience) || "女频",
      tone: trimString(params.input.tone) || "甜虐",
      ending: trimString(params.input.ending) || "HE",
      totalEpisodes: coerceTotalEpisodes(params.input.totalEpisodes),
      targetMarket: trimString(params.input.targetMarket) || "cn",
      customTopic: trimString(params.input.customTopic),
      creativeInput: trimString(params.input.creativeInput),
    },
    creativePlan: params.creativePlan ?? "",
    characters: params.characters ?? [],
    directory: params.directory ?? [],
    outlines: params.outlines ?? [],
    episodes: params.episodes ?? [],
    referenceScript: params.referenceScript ?? "",
    referenceStructure: params.referenceStructure ?? "",
    structureTransform: params.structureTransform ?? "",
    characterTransform: params.characterTransform ?? "",
    adaptationEpisodeCountConfirmed: projectKind === "adaptation",
    adaptationTargetMarketConfirmed: projectKind === "adaptation",
    adaptationGenresConfirmed: projectKind === "adaptation",
  };
}

function buildVideoProject(params: {
  projectId: string;
  sourceProjectId: string;
  title: string;
  shotPackets?: unknown[];
  scenes?: unknown[];
  characters?: unknown[];
  sceneSettings?: unknown[];
  segmentVideoPrompts?: Record<string, unknown>;
  segmentVideos?: Record<string, string>;
  segmentVideoStatuses?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: params.projectId,
    title: params.title,
    script:
      "雨夜小巷里，女主发现旧案线索，转身时与冷面投资人再次相遇，两人决定联手反击幕后操盘者。",
    targetPlatform: "抖音",
    shotStyle: "电影感都市悬爱",
    outputGoal: "自动产出预告短片",
    productionNotes: "保持都市夜景、冷色霓虹和强情绪拉扯。",
    currentStep: 6,
    sourceProjectId: params.sourceProjectId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    scenes: params.scenes ?? [],
    characters: params.characters ?? [],
    sceneSettings: params.sceneSettings ?? [],
    shotPackets: params.shotPackets ?? [],
    reviewQueue: [],
    segmentVideoPrompts: params.segmentVideoPrompts ?? {},
    segmentVideos: params.segmentVideos ?? {},
    segmentVideoStatuses: params.segmentVideoStatuses ?? {},
    assetManifest: { items: [] },
  };
}

function buildResult(params: {
  summary: string;
  projectSnapshot: ConversationProjectSnapshot;
  dramaProject?: Record<string, unknown> | null;
  videoProject?: Record<string, unknown> | null;
  videoUrls?: string[];
}): WorkflowActionResult {
  persistProjectToWorkflowTestStorage(DRAMA_PROJECTS_STORAGE_KEY, params.dramaProject);
  persistProjectToWorkflowTestStorage(VIDEO_PROJECTS_STORAGE_KEY, params.videoProject);

  return {
    summary: params.summary,
    projectSnapshot: params.projectSnapshot,
    videoUrls: params.videoUrls,
    data: {
      projectSnapshot: params.projectSnapshot,
      dramaProject: (params.dramaProject ?? null) as never,
      videoProject: (params.videoProject ?? null) as never,
    },
  };
}

function buildSmokeScenes() {
  return [
    {
      id: "scene-1",
      sceneNumber: 1,
      sceneName: "雨夜旧案重逢",
      segmentLabel: "EP01-01",
      description: "女主在雨夜小巷里截住掌握旧案线索的关键人物。",
      characters: ["沈昭", "顾承砚"],
      dialogue: "你到底站在哪一边？",
      cameraDirection: "中近景跟拍后推近停顿。",
      duration: 90,
      recommendedDuration: 90,
      storyboardText: "雨夜、霓虹、情绪拉扯。",
      videoStatus: "completed",
      videoTaskId: "smoke-segment-task-1",
      videoUrl: "https://example.com/full-auto-smoke/segment-1.mp4",
    },
  ];
}

function buildSmokeCharacters() {
  return [
    {
      id: "char-1",
      name: "沈昭",
      description: "外柔内刚的女主，背着旧案伤痕继续追查真相。",
      imageUrl: "",
      isAIGenerated: false,
      source: "auto",
    },
    {
      id: "char-2",
      name: "顾承砚",
      description: "冷面投资人，表面克制，实则一直暗中布局保护女主。",
      imageUrl: "",
      isAIGenerated: false,
      source: "auto",
    },
  ];
}

function buildSmokeSceneSettings() {
  return [
    {
      id: "setting-1",
      name: "雨夜小巷",
      description: "冷色霓虹与积水反光叠加的都市巷道。",
      imageUrl: "",
      isAIGenerated: false,
      source: "auto",
    },
  ];
}

function buildSmokeShotPackets() {
  return [
    {
      id: "packet-1",
      sceneId: "scene-1",
      sceneNumber: 1,
      title: "雨夜旧案重逢",
      durationSec: 8,
      renderMode: "text2video",
      reviewStatus: "pending",
    },
  ];
}

function summarizeTraceInput(input: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "projectId",
    "automationMode",
    "directoryPath",
    "batchMode",
    "episodeDuration",
    "videoPace",
    "reviewMode",
    "strictness",
  ] as const;
  return Object.fromEntries(
    keys
      .map((key) => [key, input[key]])
      .filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function runFullAutoOriginalScriptSmokeOverride(
  actionKind: string,
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): WorkflowActionResult {
  const scriptProjectId = resolveScriptProjectId(input, runtime);
  const title = resolveProjectTitle(input, runtime);
  const smokeCharacters = buildSmokeCharacters();
  const smokeScenes = buildSmokeScenes();
  const smokeSceneSettings = buildSmokeSceneSettings();
  const smokeShotPackets = buildSmokeShotPackets();
  const sourceDramaProject =
    (runtime.currentDramaProject as Record<string, unknown> | null | undefined) ??
    buildDramaProject({ projectId: scriptProjectId, title, input });

  switch (actionKind) {
    case "save_setup": {
      const dramaProject = buildDramaProject({ projectId: scriptProjectId, title, input });
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "创意方案",
        currentObjective: "继续生成创意方案，并准备进入角色开发。",
        agentSummary: "已接收原创剧本立项设定，下一步进入创意方案。",
        recommendedActions: ["生成创意方案"],
        artifacts: [buildArtifact("setup-1", "setup", "项目设定", "原创剧本立项参数已保存。")],
      });
      return buildResult({
        summary: "已保存原创剧本立项参数，准备进入创意方案。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_creative_plan": {
      const dramaProject = {
        ...sourceDramaProject,
        creativePlan:
          "都市悬爱主线叠加旧案追凶，围绕雨夜重逢、身份博弈和情感反转推进。",
        updatedAt: nowIso(),
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "创意方案",
        currentObjective: "创意方案已成型，下一步进入角色开发。",
        agentSummary: "都市悬爱 + 旧案追凶的主创意方案已生成。",
        recommendedActions: ["进入角色设计"],
        artifacts: [buildArtifact("plan-1", "plan", "创意方案", "已生成主创意、卖点和反转结构。 ")],
      });
      return buildResult({
        summary: "已生成创意方案，准备进入角色设计。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_characters": {
      const dramaProject = {
        ...sourceDramaProject,
        creativePlan:
          trimString(sourceDramaProject.creativePlan) ||
          "都市悬爱主线叠加旧案追凶，围绕雨夜重逢、身份博弈和情感反转推进。",
        characters: smokeCharacters,
        updatedAt: nowIso(),
        currentStep: "characters",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "角色开发",
        currentObjective: "核心角色已定稿，下一步整理分集目录。",
        agentSummary: "主角关系、冲突和人设标签已成型。",
        recommendedActions: ["生成分集目录"],
        artifacts: [buildArtifact("characters-1", "characters", "角色设定", "双主角与关键反派设定已完成。 ")],
      });
      return buildResult({
        summary: "角色设定已完成，准备进入分集目录。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_directory": {
      const directory = [
        { episodeNumber: 1, title: "雨夜重逢" },
        { episodeNumber: 2, title: "旧案浮出" },
        { episodeNumber: 3, title: "身份反咬" },
      ];
      const dramaProject = {
        ...sourceDramaProject,
        characters:
          Array.isArray(sourceDramaProject.characters) && sourceDramaProject.characters.length
            ? sourceDramaProject.characters
            : smokeCharacters,
        directory,
        updatedAt: nowIso(),
        currentStep: "directory",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "分集目录",
        currentObjective: "分集目录已就绪，下一步批量生成单集细纲。",
        agentSummary: "核心情节点已拆成分集目录，可继续推进细纲。",
        recommendedActions: ["生成单集细纲"],
        artifacts: [buildArtifact("directory-1", "directory", "分集目录", "已整理前三集主事件和反转节点。 ")],
      });
      return buildResult({
        summary: "分集目录已生成，准备批量输出单集细纲。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_outlines": {
      const outlines = [
        { episodeNumber: 1, title: "雨夜重逢", summary: "旧案线索和人物关系同时被点燃。" },
        { episodeNumber: 2, title: "旧案浮出", summary: "双方开始交换筹码并各自试探。" },
      ];
      const dramaProject = {
        ...sourceDramaProject,
        outlines,
        updatedAt: nowIso(),
        currentStep: "outlines",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "单集细纲",
        currentObjective: "细纲已准备完毕，下一步连续撰写正文。",
        agentSummary: "关键单集细纲已生成，可直接进入正文。",
        recommendedActions: ["撰写分集正文"],
        artifacts: [buildArtifact("outline-1", "outline", "单集细纲", "首批细纲已完成，冲突与反转节奏清晰。 ")],
      });
      return buildResult({
        summary: "首批单集细纲已完成，准备进入正文撰写。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_episode_batch": {
      const episodes = [
        { episodeNumber: 1, title: "雨夜重逢", content: "沈昭在雨夜小巷截住证人，却被顾承砚抢先一步带走。", status: "done" },
        { episodeNumber: 2, title: "旧案浮出", content: "两人联手拆解幕后盘局，但互相之间依旧不信任。", status: "done" },
      ];
      const dramaProject = {
        ...sourceDramaProject,
        episodes,
        updatedAt: nowIso(),
        currentStep: "episodes",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "分集撰写",
        currentObjective: "正文已批量完成，下一步进入合规审查或直接桥接视频。",
        agentSummary: "首批正文已写完，可直接桥接视频工作流。",
        recommendedActions: ["跳过合规审查", "执行合规审查"],
        artifacts: [buildArtifact("episode-1", "episode", "分集正文", "首批正文已撰写完成。 ")],
      });
      return buildResult({
        summary: "正文批量撰写完成，可以进入合规审查。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "skip_compliance_review": {
      const dramaProject = {
        ...sourceDramaProject,
        updatedAt: nowIso(),
        currentStep: "compliance",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "合规审核",
        currentObjective: "已跳过合规审查，准备桥接视频工作流。",
        agentSummary: "本轮跳过合规审查，直接进入视频工作流。",
        recommendedActions: ["继续视频工作流"],
        artifacts: [buildArtifact("compliance-1", "compliance", "合规处理", "本轮已按策略跳过合规审查。 ")],
      });
      return buildResult({
        summary: "已按策略跳过合规审查，继续进入视频工作流。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "run_compliance_review": {
      const dramaProject = {
        ...sourceDramaProject,
        updatedAt: nowIso(),
        currentStep: "compliance",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        title,
        derivedStage: "合规审核",
        currentObjective: "合规审查已完成，准备桥接视频工作流。",
        agentSummary: "已完成合规审查，未发现阻断项。",
        recommendedActions: ["继续视频工作流"],
        artifacts: [buildArtifact("compliance-2", "compliance", "合规报告", "文本合规审查已通过。 ")],
      });
      return buildResult({
        summary: "合规审查已完成，可继续进入视频工作流。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "analyze_script_for_video": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: smokeScenes,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "剧本拆解",
        currentObjective: "已按烟测策略完成剧本拆解，下一步提取角色与场景。",
        agentSummary: "剧本拆解已完成，镜头节奏与片段结构已建立。",
        recommendedActions: ["提取角色与场景"],
        artifacts: [buildArtifact("video-brief-1", "video-brief", "剧本拆解", "已生成视频拆解摘要与片段规划。 ")],
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "已完成剧本拆解，继续提取角色与场景。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "extract_video_entities": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: smokeScenes,
        characters: smokeCharacters,
        sceneSettings: smokeSceneSettings,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "角色与场景",
        currentObjective: "角色、场景已提取完成，下一步进入视频工作流。",
        agentSummary: "视频角色与场景实体已提取完成。",
        recommendedActions: ["进入视频工作流"],
        artifacts: [buildArtifact("world-model-1", "world-model", "角色与场景", "角色、场景和关系实体已整理。 ")],
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "角色与场景实体已整理完成，继续进入视频工作流。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "create_video_bridge_artifact": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const targetPlatform =
        trimString(input.targetPlatform) || trimString(String(existingVideoProject?.targetPlatform || "")) || "抖音";
      const shotStyle =
        trimString(input.shotStyle) ||
        trimString(String(existingVideoProject?.shotStyle || "")) ||
        "电影感都市悬爱";
      const outputGoal =
        trimString(input.outputGoal) ||
        trimString(String(existingVideoProject?.outputGoal || "")) ||
        "自动产出预告短片";
      const productionNotes =
        trimString(input.productionNotes) ||
        trimString(String(existingVideoProject?.productionNotes || "")) ||
        "保持都市夜景、冷色霓虹和强情绪拉扯。";
      const videoProject = {
        ...buildVideoProject({
          projectId: videoProjectId,
          sourceProjectId: scriptProjectId,
          title,
          scenes: (existingVideoProject?.scenes as unknown[]) ?? smokeScenes,
          characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
          sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
          shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
          segmentVideoPrompts:
            (existingVideoProject?.segmentVideoPrompts as Record<string, unknown>) ?? {},
          segmentVideos:
            (existingVideoProject?.segmentVideos as Record<string, string>) ?? {},
          segmentVideoStatuses:
            (existingVideoProject?.segmentVideoStatuses as Record<string, unknown>) ?? {},
        }),
        targetPlatform,
        shotStyle,
        outputGoal,
        productionNotes,
      };
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "视频工作流",
        currentObjective: "平台与镜头偏好已补齐，下一步编译镜头指令包。",
        agentSummary: "目标平台、镜头风格和出片目标已写入视频项目。",
        recommendedActions: ["编译镜头指令包"],
        artifacts: [
          buildArtifact(
            "video-bridge-prefs-1",
            "video-brief",
            "平台与镜头偏好",
            "目标平台、镜头风格与出片目标已同步到视频工作流。",
          ),
        ],
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "平台与镜头偏好已补齐，继续编译镜头指令包。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "prepare_video_generation": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: (existingVideoProject?.scenes as unknown[]) ?? smokeScenes,
        characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
        sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "视频工作流",
        currentObjective: "已接入视频工作流，下一步编译镜头指令包。",
        agentSummary: "视频工作流上下文已就绪。",
        recommendedActions: ["编译镜头指令包"],
        artifacts: [buildArtifact("video-prepare-1", "video-brief", "视频工作流接入", "脚本项目已接入视频工作流。 ")],
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "视频工作流已接入完成，准备编译镜头指令包。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "compile_video_shot_packets": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: (existingVideoProject?.scenes as unknown[]) ?? smokeScenes,
        characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
        sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
        shotPackets: smokeShotPackets,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "镜头指令包",
        currentObjective: "镜头指令包已完成，下一步批量生成视频提示词。",
        agentSummary: "镜头指令包已编译完成。",
        recommendedActions: ["生成视频提示词"],
        artifacts: [buildArtifact("shot-packet-1", "shot-packet", "镜头指令包", "已生成首批镜头指令与约束。 ")],
        shotPackets: smokeShotPackets,
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "镜头指令包已编译完成，准备生成视频提示词。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "prepare_video_prompt_batch":
    case "prepare_segment_video_prompt": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const segmentVideoPrompts = {
        "EP01-01": {
          segmentLabel: "EP01-01",
          prompt:
            "Rainy alley reunion, neon reflections, emotionally tense live-action look, medium pacing, cinematic pressure.",
          duration: 8,
          targetDuration: 8,
        },
      };
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: (existingVideoProject?.scenes as unknown[]) ?? smokeScenes,
        characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
        sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        segmentVideoPrompts,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "视频提示词",
        currentObjective: "提示词批次已准备完成，下一步开始自动生成视频片段。",
        agentSummary: "片段提示词与批次规划已生成。",
        recommendedActions: ["生成视频片段"],
        artifacts: [buildArtifact("prompt-batch-1", "video-prompt-batch", "视频提示词", "首批片段提示词已生成。 ")],
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "视频提示词已准备完成，继续自动生成视频片段。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    case "generate_segment_video":
    case "generate_video_assets": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const videoUrl = "https://example.com/full-auto-smoke/segment-1.mp4";
      const segmentVideos = { "EP01-01": videoUrl };
      const segmentVideoStatuses = {
        "EP01-01": { status: "completed", taskId: "smoke-segment-task-1" },
      };
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: smokeScenes,
        characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
        sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        segmentVideoPrompts:
          (existingVideoProject?.segmentVideoPrompts as Record<string, unknown>) ?? {
            "EP01-01": { segmentLabel: "EP01-01" },
          },
        segmentVideos,
        segmentVideoStatuses,
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "视频生成",
        currentObjective: "首批片段视频已完成，下一步进入预览与导出。",
        agentSummary: "片段视频生成已完成。",
        recommendedActions: ["导出视频成果"],
        artifacts: [buildArtifact("video-generate-1", "review", "视频生成", "首批片段视频已生成。 ")],
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "首批视频片段已生成完成，准备进入预览与导出。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
        videoUrls: [videoUrl],
      });
    }
    case "compile_segment_videos":
    case "export_video_asset_bundle": {
      const videoProjectId = resolveVideoProjectId(runtime, scriptProjectId);
      const existingVideoProject = runtime.currentVideoProject as Record<string, unknown> | null | undefined;
      const videoProject = buildVideoProject({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        scenes: smokeScenes,
        characters: (existingVideoProject?.characters as unknown[]) ?? smokeCharacters,
        sceneSettings: (existingVideoProject?.sceneSettings as unknown[]) ?? smokeSceneSettings,
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        segmentVideoPrompts:
          (existingVideoProject?.segmentVideoPrompts as Record<string, unknown>) ?? {
            "EP01-01": { segmentLabel: "EP01-01" },
          },
        segmentVideos:
          (existingVideoProject?.segmentVideos as Record<string, string>) ?? {
            "EP01-01": "https://example.com/full-auto-smoke/segment-1.mp4",
          },
        segmentVideoStatuses:
          (existingVideoProject?.segmentVideoStatuses as Record<string, unknown>) ?? {
            "EP01-01": { status: "completed", taskId: "smoke-segment-task-1" },
          },
      });
      const projectSnapshot = buildVideoSnapshot({
        projectId: videoProjectId,
        sourceProjectId: scriptProjectId,
        title,
        derivedStage: "预览与导出",
        currentObjective: "全自动视频导出链路已完成。",
        agentSummary: "烟测视频链路已自动完成并进入导出阶段。",
        recommendedActions: ["打开导出目录", "查看生成片段"],
        artifacts: [buildArtifact("video-export-1", "export", "视频导出", "自动导出流程已完成。 ")],
        shotPackets: (existingVideoProject?.shotPackets as unknown[]) ?? smokeShotPackets,
        videoScenes: smokeScenes,
      });
      return buildResult({
        summary: "视频导出流程已完成。",
        projectSnapshot,
        dramaProject: sourceDramaProject,
        videoProject,
      });
    }
    default:
      throw new Error(
        `Unsupported workflow smoke override action for ${FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO}: ${actionKind}`,
      );
  }
}

function runFullAutoAdaptationSmokeOverride(
  actionKind: string,
  input: Record<string, unknown>,
  runtime: StudioRuntimeState,
): WorkflowActionResult {
  const scriptProjectId = resolveScriptProjectId(input, runtime);
  const title = resolveProjectTitle(input, runtime);
  const referenceScript =
    trimString(input.referenceScript) ||
    trimString((runtime.currentDramaProject as Record<string, unknown> | null | undefined)?.referenceScript) ||
    "参考剧本：雨夜重逢后，女主与冷面投资人联手追查旧案真相。";
  const sourceDramaProject =
    (runtime.currentDramaProject as Record<string, unknown> | null | undefined) ??
    buildDramaProject({
      projectId: scriptProjectId,
      title,
      input,
      projectKind: "adaptation",
      referenceScript,
    });

  switch (actionKind) {
    case "save_setup": {
      const dramaProject = buildDramaProject({
        projectId: scriptProjectId,
        title,
        input,
        projectKind: "adaptation",
        referenceScript,
      });
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "参考改编立项",
        currentObjective: "参考文本已写入，下一步进入参考剧本分析。",
        agentSummary: "已接收参考文本和改编立项参数，准备分析原作结构。",
        recommendedActions: ["分析参考剧本"],
        artifacts: [buildArtifact("adaptation-setup-1", "setup", "参考改编立项", "参考文本已写入改编项目。")],
      });
      return buildResult({
        summary: "已保存参考改编立项参数，准备分析参考剧本。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "analyze_reference_script": {
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        referenceScript,
        referenceStructure:
          "原作以雨夜追凶为主线，围绕旧案线索、身份博弈和情感反转推进，适合转成短剧强钩子节奏。",
        updatedAt: nowIso(),
        currentStep: "structure-transform",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "参考剧本分析",
        currentObjective: "原作结构已分析完成，下一步确认改编集数。",
        agentSummary: "已提炼原作结构、冲突和改编抓手，准备锁定改编参数。",
        recommendedActions: ["确认改编集数"],
        artifacts: [buildArtifact("adaptation-analysis-1", "plan", "参考分析", "已提炼原作结构、冲突和改编抓手。")],
      });
      return buildResult({
        summary: "已完成参考剧本分析，下一步确认改编集数。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "confirm_adaptation_episode_count": {
      const totalEpisodes =
        typeof input.totalEpisodes === "number" && Number.isFinite(input.totalEpisodes)
          ? input.totalEpisodes
          : 60;
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        setup: {
          ...((sourceDramaProject.setup as Record<string, unknown> | undefined) ?? {}),
          projectKind: "adaptation",
          totalEpisodes,
        },
        adaptationEpisodeCountConfirmed: true,
        updatedAt: nowIso(),
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "改编参数确认",
        currentObjective: "改编集数已确认，下一步确认目标市场。",
        agentSummary: `改编集数已锁定为 ${totalEpisodes} 集。`,
        recommendedActions: ["确认目标市场"],
        artifacts: [buildArtifact("adaptation-episodes-1", "setup", "改编集数", `已确认改编为 ${totalEpisodes} 集。`)],
      });
      return buildResult({
        summary: `已确认改编集数为 ${totalEpisodes} 集，下一步锁定目标市场。`,
        projectSnapshot,
        dramaProject,
      });
    }
    case "confirm_adaptation_target_market": {
      const targetMarket = trimString(input.targetMarket) || "cn";
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        setup: {
          ...((sourceDramaProject.setup as Record<string, unknown> | undefined) ?? {}),
          projectKind: "adaptation",
          targetMarket,
        },
        adaptationTargetMarketConfirmed: true,
        updatedAt: nowIso(),
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "改编参数确认",
        currentObjective: "目标市场已确认，下一步确认方向题材。",
        agentSummary: `目标市场已锁定为 ${targetMarket}。`,
        recommendedActions: ["确认方向题材"],
        artifacts: [buildArtifact("adaptation-market-1", "setup", "目标市场", `已确认目标市场为 ${targetMarket}。`)],
      });
      return buildResult({
        summary: "目标市场已确认，下一步锁定方向题材。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "confirm_adaptation_genres": {
      const genres = Array.isArray(input.genres)
        ? input.genres.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        : [trimString(input.genres)].filter(Boolean);
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        setup: {
          ...((sourceDramaProject.setup as Record<string, unknown> | undefined) ?? {}),
          projectKind: "adaptation",
          genres,
        },
        adaptationGenresConfirmed: true,
        updatedAt: nowIso(),
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "改编参数确认",
        currentObjective: "方向题材已确认，下一步开始结构转译。",
        agentSummary: `方向题材已确认：${genres.join("、") || "都市悬爱"}。`,
        recommendedActions: ["生成结构转译"],
        artifacts: [buildArtifact("adaptation-genre-1", "setup", "方向题材", `已确认方向题材：${genres.join("、") || "都市悬爱"}。`)],
      });
      return buildResult({
        summary: "方向题材已确认，下一步进入结构转译。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_structure_transform": {
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        structureTransform:
          "将原作长线追凶压缩成强钩子短剧结构，强化每集反转、身份试探和情感对抗。",
        creativePlan:
          "将原作长线追凶压缩成强钩子短剧结构，强化每集反转、身份试探和情感对抗。",
        updatedAt: nowIso(),
        currentStep: "character-transform",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "结构转译",
        currentObjective: "结构转译已完成，下一步进入角色转译。",
        agentSummary: "已完成长线原作到短剧节奏的结构转译。",
        recommendedActions: ["生成角色转译"],
        artifacts: [buildArtifact("adaptation-structure-1", "plan", "结构转译", "已生成短剧化结构转译方案。")],
      });
      return buildResult({
        summary: "结构转译已完成，下一步进入角色转译。",
        projectSnapshot,
        dramaProject,
      });
    }
    case "generate_character_transform": {
      const smokeCharacters = buildSmokeCharacters();
      const dramaProject = {
        ...sourceDramaProject,
        mode: "adaptation",
        characterTransform:
          "保留原作双主角核心关系，强化短剧节奏下的对抗张力、身份误导和情感拉扯。",
        characters: smokeCharacters,
        updatedAt: nowIso(),
        currentStep: "character-transform",
      };
      const projectSnapshot = buildScriptSnapshot({
        projectId: scriptProjectId,
        projectKind: "adaptation",
        title,
        derivedStage: "角色转译",
        currentObjective: "角色转译已完成，下一步生成分集目录。",
        agentSummary: "主要角色已转成短剧化人设和冲突关系。",
        recommendedActions: ["生成分集目录"],
        artifacts: [buildArtifact("adaptation-characters-1", "characters", "角色转译", "主要角色已完成短剧化转译。")],
      });
      return buildResult({
        summary: "角色转译已完成，下一步生成分集目录。",
        projectSnapshot,
        dramaProject,
      });
    }
    default:
      return runFullAutoOriginalScriptSmokeOverride(actionKind, input, {
        ...runtime,
        currentDramaProject: sourceDramaProject as never,
      });
  }
}

export async function maybeRunWorkflowTestOverride(params: {
  actionKind: string;
  input: Record<string, unknown>;
  runtime: StudioRuntimeState;
  onProgress?: WorkflowActionProgressCallback;
}): Promise<WorkflowActionResult | null> {
  const scenario = readWorkflowTestScenario();
  if (!scenario) return null;

  appendTrace({
    at: nowIso(),
    scenario,
    actionKind: params.actionKind,
    input: summarizeTraceInput(params.input),
    currentProjectId: params.runtime.currentProjectSnapshot?.projectId ?? null,
    currentProjectKind: params.runtime.currentProjectSnapshot?.projectKind ?? null,
  });

  if (scenario === FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO) {
    return runFullAutoOriginalScriptSmokeOverride(
      params.actionKind,
      params.input,
      params.runtime,
    );
  }

  if (scenario === FULL_AUTO_ADAPTATION_SMOKE_SCENARIO) {
    return runFullAutoAdaptationSmokeOverride(
      params.actionKind,
      params.input,
      params.runtime,
    );
  }

  if (scenario === FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO) {
    return runFullAutoOriginalScriptSmokeOverride(
      params.actionKind,
      params.input,
      params.runtime,
    );
  }

  return null;
}
