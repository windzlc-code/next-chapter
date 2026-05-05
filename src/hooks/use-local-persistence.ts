import { useCallback, useRef } from "react";
import type {
  Scene,
  CharacterSetting,
  SceneSetting,
  ArtStyle,
  ProductionAssetManifest,
  VideoShotPacket,
  VideoProductionBundleMeta,
  VideoStyleLock,
  VideoWorldModel,
  VideoGenerationPrefs,
  VideoImageGenerationPrefs,
  SegmentVideoPrompt,
  SegmentVideoStatus,
} from "@/types/project";
import { getProjectsFilePath, readJsonFile, writeJsonFile, scanProjectDirectoryIds, readProjectManifest, remapLocalPathToCurrentRoot } from "@/lib/file-cache";
import { writeConversationArchiveProject } from "@/lib/home-agent/conversation-archive";
import {
  buildLegacyVideoImageStylePrefs,
  normalizeVideoImageGenerationPrefs,
  resolveVideoImageProjectArtStyle,
} from "@/lib/home-agent/image-models";
import { isExpiredRemoteSignedMediaUrl } from "@/lib/home-agent/media-url";
import { normalizeVideoGenerationPrefs } from "@/lib/home-agent/video-models";

interface ProjectData {
  title: string;
  script: string;
  targetPlatform?: string;
  shotStyle?: string;
  outputGoal?: string;
  productionNotes?: string;
  scenes: Scene[];
  characters: CharacterSetting[];
  sceneSettings: SceneSetting[];
  artStyle: ArtStyle;
  currentStep: number;
  systemPrompt: string;
  analysisSummary?: string;
  storyboardPlan?: string;
  videoPromptBatch?: string;
  segmentVideoPrompts?: Record<string, SegmentVideoPrompt>;
  segmentVideos?: Record<string, string>; // segmentLabel → localPath/url
  segmentVideoStatuses?: Record<string, SegmentVideoStatus>;
  sourceProjectId?: string;
  styleLock?: VideoStyleLock | null;
  worldModel?: VideoWorldModel | null;
  assetManifest?: ProductionAssetManifest | null;
  shotPackets?: VideoShotPacket[];
  reviewQueue?: Array<{
    id: string;
    title: string;
    summary: string;
    targetIds: string[];
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  productionStateBundle?: VideoProductionBundleMeta | null;
  imageGenerationPrefs?: VideoImageGenerationPrefs;
  videoGenerationPrefs?: VideoGenerationPrefs;
  preferredEpisodeDurationSeconds?: number | null;
  /** 用户通过步骤切换手动跳到的目标步骤（>自然进度步骤时生效），用于阻止自动推进 */
  manualStepOverride?: number | null;
}

const STORAGE_KEY = "storyforge_projects";
const CURRENT_PROJECT_KEY = "storyforge_current_project";

// getProjects() 结果缓存，saveProjects() 时失效，避免每次切换项目都重复扫描文件系统
let projectsCachePromise: Promise<StoredProject[]> | null = null;
let projectsFastCachePromise: Promise<StoredProject[]> | null = null;
export function invalidateProjectsCache(): void {
  projectsCachePromise = null;
  projectsFastCachePromise = null;
}

interface StoredProject extends ProjectData {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type PersistedVideoProject = StoredProject;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function collectMediaUrlKeys(value: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (typeof value !== "string") return keys;
  const trimmed = value.trim();
  if (!trimmed) return keys;
  keys.add(trimmed.toLowerCase());
  const withoutQuery = trimmed.split("?")[0] || trimmed;
  keys.add(withoutQuery.toLowerCase());
  const withoutFileScheme = withoutQuery.replace(/^file:\/*/i, "");
  keys.add(withoutFileScheme.toLowerCase());
  const baseName = decodeURIComponent(withoutFileScheme.split(/[\\/]/).pop() || "").trim();
  if (baseName) {
    keys.add(baseName.toLowerCase());
  }
  return keys;
}

function matchesHistoricalVideoUrl(historyUrls: Set<string>, candidateUrl: string | undefined): boolean {
  for (const key of collectMediaUrlKeys(candidateUrl)) {
    if (historyUrls.has(key)) return true;
  }
  return false;
}

function normalizeNestedVariantIds<T extends { id: string }>(
  variants: T[] | undefined,
  ownerId: string,
  kind: "costume" | "time-variant",
): T[] | undefined {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;

  const seenIds = new Set<string>();
  let changed = false;

  const normalized = variants.map((variant, index) => {
    const currentId = typeof variant.id === "string" ? variant.id.trim() : "";
    let nextId = currentId;

    if (!nextId || seenIds.has(nextId)) {
      nextId = `${kind}-${ownerId}-${index + 1}-${generateId()}`;
    }

    if (nextId !== currentId) {
      changed = true;
    }

    seenIds.add(nextId);
    return nextId === variant.id ? variant : { ...variant, id: nextId };
  });

  return changed ? normalized : variants;
}

export function pruneExpiredVideoReferencesFromProject(
  project: StoredProject,
  now: number = Date.now(),
): StoredProject {
  let changed = false;

  const scenes = (project.scenes ?? []).map((scene) => {
    const currentVideoExpired = isExpiredRemoteSignedMediaUrl(scene.videoUrl, now);
    const nextHistory = (scene.videoHistory ?? []).filter(
      (entry) => !isExpiredRemoteSignedMediaUrl(entry.videoUrl, now),
    );
    const historyChanged = nextHistory.length !== (scene.videoHistory ?? []).length;

    if (!currentVideoExpired && !historyChanged) {
      return scene;
    }

    changed = true;
    return {
      ...scene,
      ...(currentVideoExpired
        ? {
            videoUrl: undefined,
            videoTaskId: undefined,
            videoProvider: undefined,
            videoStatus: undefined,
            videoFailure: undefined,
          }
        : {}),
      ...(historyChanged
        ? {
            videoHistory: nextHistory.length ? nextHistory : undefined,
          }
        : {}),
    };
  });

  const historicalVideoUrls = new Set<string>();
  scenes.forEach((scene) => {
    (scene.videoHistory ?? []).forEach((entry) => {
      collectMediaUrlKeys(entry.videoUrl).forEach((key) => historicalVideoUrls.add(key));
    });
  });

  const nextAssetManifest = project.assetManifest
    ? {
        ...project.assetManifest,
        items: project.assetManifest.items.filter(
          (item) =>
            Boolean(item.url?.trim()) &&
            !isExpiredRemoteSignedMediaUrl(item.url, now) &&
            !(
              item.kind === "video-segment" &&
              item.origin === "manual" &&
              matchesHistoricalVideoUrl(historicalVideoUrls, item.url)
            ),
        ),
      }
    : project.assetManifest;

  if (
    nextAssetManifest &&
    project.assetManifest &&
    nextAssetManifest.items.length !== project.assetManifest.items.length
  ) {
    changed = true;
  }

  return changed
    ? {
        ...project,
        scenes,
        assetManifest: nextAssetManifest,
      }
    : project;
}

export function normalizeStoredVideoProject(project: StoredProject): StoredProject {
  const artStyle = project.artStyle || "live-action";
  const imageGenerationPrefs = normalizeVideoImageGenerationPrefs({
    ...buildLegacyVideoImageStylePrefs(artStyle),
    ...project.imageGenerationPrefs,
  });
  const videoGenerationPrefs = normalizeVideoGenerationPrefs(project.videoGenerationPrefs);
  const characters = (project.characters ?? []).map((character, index) => {
    const characterId = typeof character.id === "string" && character.id.trim()
      ? character.id.trim()
      : `character-${index + 1}`;
    const costumes = normalizeNestedVariantIds(character.costumes, characterId, "costume");
    const activeCostumeId = costumes?.some((costume) => costume.id === character.activeCostumeId)
      ? character.activeCostumeId
      : undefined;

    return {
      ...character,
      ...(costumes ? { costumes } : character.costumes ? { costumes: undefined } : {}),
      ...(activeCostumeId
        ? { activeCostumeId }
        : character.activeCostumeId
          ? { activeCostumeId: undefined }
          : {}),
    };
  });
  const sceneSettings = (project.sceneSettings ?? []).map((sceneSetting, index) => {
    const sceneSettingId = typeof sceneSetting.id === "string" && sceneSetting.id.trim()
      ? sceneSetting.id.trim()
      : `scene-setting-${index + 1}`;
    const timeVariants = normalizeNestedVariantIds(
      sceneSetting.timeVariants,
      sceneSettingId,
      "time-variant",
    );
    const activeTimeVariantId = timeVariants?.some((variant) => variant.id === sceneSetting.activeTimeVariantId)
      ? sceneSetting.activeTimeVariantId
      : undefined;

    return {
      ...sceneSetting,
      ...(timeVariants ? { timeVariants } : sceneSetting.timeVariants ? { timeVariants: undefined } : {}),
      ...(activeTimeVariantId
        ? { activeTimeVariantId }
        : sceneSetting.activeTimeVariantId
          ? { activeTimeVariantId: undefined }
          : {}),
    };
  });

  return {
    ...project,
    characters,
    sceneSettings,
    artStyle: resolveVideoImageProjectArtStyle(imageGenerationPrefs, artStyle),
    imageGenerationPrefs,
    videoGenerationPrefs,
  };
}

function getProjectsFromLocalStorage(): StoredProject[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data
      ? (JSON.parse(data) as StoredProject[]).map((project) =>
          normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
        )
      : [];
  } catch {
    return [];
  }
}

function saveProjectsToLocalStorage(projects: StoredProject[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    return true;
  } catch {
    return false;
  }
}

/** 将项目内所有本地路径重映射到当前 files 根目录 */
async function remapProjectPaths(project: StoredProject): Promise<StoredProject> {
  const remap = remapLocalPathToCurrentRoot;
  const remapUrl = async (url?: string | null) => {
    if (!url || url.startsWith("data:") || url.startsWith("http") || url.startsWith("file://")) return url;
    if (!/^[A-Za-z]:[\\/]/.test(url)) return url;
    return remap(url);
  };

  const characters = await Promise.all(
    (project.characters || []).map(async (c) => ({
      ...c,
      imageUrl: await remapUrl(c.imageUrl) ?? c.imageUrl,
    })),
  );
  const sceneSettings = await Promise.all(
    (project.sceneSettings || []).map(async (s) => ({
      ...s,
      imageUrl: await remapUrl(s.imageUrl) ?? s.imageUrl,
    })),
  );
  const scenes = await Promise.all(
    (project.scenes || []).map(async (s) => ({
      ...s,
      storyboardUrl: await remapUrl(s.storyboardUrl) ?? s.storyboardUrl,
      videoUrl: await remapUrl(s.videoUrl) ?? s.videoUrl,
    })),
  );
  const segmentVideos = project.segmentVideos
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(project.segmentVideos).map(async ([label, url]) => [
            label,
            await remapUrl(url) ?? url,
          ]),
        ),
      )
    : project.segmentVideos;
  return { ...project, characters, sceneSettings, scenes, segmentVideos };
}

async function getProjects(): Promise<StoredProject[]> {
  if (!projectsCachePromise) {
    projectsCachePromise = loadProjectsFromDisk();
  }
  return (await projectsCachePromise).slice();
}

async function getProjectsFast(): Promise<StoredProject[]> {
  if (!projectsFastCachePromise) {
    projectsFastCachePromise = loadProjectsFromDisk({ skipRepair: true });
  }
  return (await projectsFastCachePromise).slice();
}

async function loadProjectsFromDisk(options?: { skipRepair?: boolean }): Promise<StoredProject[]> {
  const skipRepair = options?.skipRepair === true;
  const filePath = await getProjectsFilePath();
  let fileProjects: StoredProject[] = [];
  let rawFileProjects: StoredProject[] | null = null;

  if (filePath) {
    const fromFile = await readJsonFile<StoredProject[]>(filePath);
    if (fromFile) {
      rawFileProjects = fromFile;
      fileProjects = fromFile.map((project) =>
        normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
      );
      // 合并 localStorage 中存在但文件里没有的项目（兼容旧数据）
      const localProjects = getProjectsFromLocalStorage();
      const fileIds = new Set(fileProjects.map((p) => p.id));
      const localOnly = localProjects.filter((p) => !fileIds.has(p.id));
      if (localOnly.length > 0) {
        fileProjects = [...fileProjects, ...localOnly];
      }
    } else {
      fileProjects = getProjectsFromLocalStorage();
    }
  } else {
    fileProjects = getProjectsFromLocalStorage();
  }

  if (skipRepair) {
    return fileProjects;
  }

  // 扫描文件系统目录，补全孤立项目（有目录但不在 projects.json 里的）
  try {
    const dirIds = await scanProjectDirectoryIds();
    const knownIds = new Set(fileProjects.map((p) => p.id));
    const orphanIds = dirIds.filter((id) => !knownIds.has(id));
    if (orphanIds.length > 0) {
      const orphanProjects = await Promise.all(
        orphanIds.map(async (id) => {
          const manifest = await readProjectManifest(id);
          if (!manifest) return null;
          const stub: StoredProject = {
            id,
            title: manifest.title || "未命名项目",
            script: "",
            scenes: [],
            characters: [],
            sceneSettings: [],
            artStyle: "live-action",
            currentStep: 0,
            systemPrompt: "",
            createdAt: manifest.updatedAt,
            updatedAt: manifest.updatedAt,
          };
          return normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(stub));
        }),
      );
      const validOrphans = orphanProjects.filter((p): p is StoredProject => p !== null);
      if (validOrphans.length > 0) {
        fileProjects = [...fileProjects, ...validOrphans];
      }
    }
  } catch {
    // 目录扫描失败时静默忽略，不影响正常加载
  }

  // 路径重映射：修正因项目目录迁移导致的本地路径失效
  const remapped = await Promise.all(fileProjects.map(remapProjectPaths));

  // 如果有路径变化，回写到 projects.json 保持同步
  if (filePath) {
    const rawSerialized = rawFileProjects ? JSON.stringify(rawFileProjects) : null;
    const sanitizedSerialized = JSON.stringify(fileProjects);
    const remappedSerialized = JSON.stringify(remapped);
    const sanitizedFileChanged = rawSerialized !== null && rawSerialized !== sanitizedSerialized;
    const remappedChanged = remappedSerialized !== sanitizedSerialized;
    const persistedCount = (await readJsonFile<StoredProject[]>(filePath))?.length;
    if (sanitizedFileChanged || remappedChanged || remapped.length !== persistedCount) {
      await writeJsonFile(filePath, remapped).catch(() => {});
    }
  }

  return remapped;
}

async function saveProjects(projects: StoredProject[]): Promise<boolean> {
  projectsCachePromise = null;
  projectsFastCachePromise = null;
  const sanitizedProjects = projects.map((project) =>
    normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject(project)),
  );
  const filePath = await getProjectsFilePath();
  if (filePath) {
    const ok = await writeJsonFile(filePath, sanitizedProjects);
    if (ok) return true;
  }
  return saveProjectsToLocalStorage(sanitizedProjects);
}

export async function loadStoredVideoProjectById(
  id: string,
  options?: { fast?: boolean },
): Promise<PersistedVideoProject | null> {
  const projects = options?.fast ? await getProjectsFast() : await getProjects();
  return projects.find((project) => project.id === id) || null;
}

export async function listStoredVideoProjects(options?: { fast?: boolean }): Promise<PersistedVideoProject[]> {
  const projects = options?.fast ? await getProjectsFast() : await getProjects();
  return [...projects].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export async function deleteStoredVideoProjectById(id: string): Promise<boolean> {
  const projects = await getProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;
  const ok = await saveProjects(filtered);
  if (ok && typeof window !== "undefined") {
    try {
      const current = localStorage.getItem(CURRENT_PROJECT_KEY);
      if (current === id) {
        localStorage.removeItem(CURRENT_PROJECT_KEY);
      }
    } catch {
      /* ignore */
    }
  }
  return ok;
}

export async function createStoredVideoProject(data: Partial<ProjectData>): Promise<PersistedVideoProject> {
  const projects = await getProjects();
  const now = new Date().toISOString();
  const project: StoredProject = pruneExpiredVideoReferencesFromProject({
    id: generateId(),
    title: data.title || "未命名视频项目",
    script: data.script || "",
    targetPlatform: data.targetPlatform || "",
    shotStyle: data.shotStyle || "",
    outputGoal: data.outputGoal || "",
    productionNotes: data.productionNotes || "",
    scenes: data.scenes || [],
    characters: data.characters || [],
    sceneSettings: data.sceneSettings || [],
    artStyle: data.artStyle || "live-action",
    currentStep: data.currentStep || 1,
    systemPrompt: data.systemPrompt || "",
    analysisSummary: data.analysisSummary || "",
    storyboardPlan: data.storyboardPlan || "",
    videoPromptBatch: data.videoPromptBatch || "",
    segmentVideoPrompts: data.segmentVideoPrompts,
    segmentVideos: data.segmentVideos,
    segmentVideoStatuses: data.segmentVideoStatuses,
    sourceProjectId: data.sourceProjectId,
    styleLock: data.styleLock || null,
    worldModel: data.worldModel || null,
    assetManifest: data.assetManifest || null,
    shotPackets: data.shotPackets || [],
    productionStateBundle: data.productionStateBundle || null,
    imageGenerationPrefs: normalizeVideoImageGenerationPrefs({
      ...buildLegacyVideoImageStylePrefs(data.artStyle || "live-action"),
      ...data.imageGenerationPrefs,
    }),
    videoGenerationPrefs: normalizeVideoGenerationPrefs(data.videoGenerationPrefs),
    createdAt: now,
    updatedAt: now,
  });
  const normalizedProject = normalizeStoredVideoProject(project);
  projects.unshift(normalizedProject);
  await saveProjects(projects);
  void writeConversationArchiveProject(normalizedProject.id, normalizedProject.title, "video", normalizedProject);
  return normalizedProject;
}

export async function upsertStoredVideoProject(project: PersistedVideoProject): Promise<PersistedVideoProject> {
  const projects = await getProjects();
  const nextProject: StoredProject = normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject({
    ...project,
    script: project.script || "",
    targetPlatform: project.targetPlatform || "",
    shotStyle: project.shotStyle || "",
    outputGoal: project.outputGoal || "",
    productionNotes: project.productionNotes || "",
    analysisSummary: project.analysisSummary || "",
    storyboardPlan: project.storyboardPlan || "",
    videoPromptBatch: project.videoPromptBatch || "",
    segmentVideoPrompts: project.segmentVideoPrompts,
    segmentVideos: project.segmentVideos,
    segmentVideoStatuses: project.segmentVideoStatuses,
    styleLock: project.styleLock || null,
    worldModel: project.worldModel || null,
    assetManifest: project.assetManifest || null,
    shotPackets: project.shotPackets || [],
    productionStateBundle: project.productionStateBundle || null,
    updatedAt: new Date().toISOString(),
  }));
  const index = projects.findIndex((item) => item.id === project.id);
  if (index >= 0) {
    projects[index] = nextProject;
  } else {
    projects.unshift(nextProject);
  }
  await saveProjects(projects);
  void writeConversationArchiveProject(nextProject.id, nextProject.title, "video", nextProject);
  return nextProject;
}

export function useProjectPersistence() {
  const projectIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ProjectData>>({});

  const setProjectId = (id: string | null) => {
    projectIdRef.current = id;
    if (id) {
      localStorage.setItem(CURRENT_PROJECT_KEY, id);
    } else {
      localStorage.removeItem(CURRENT_PROJECT_KEY);
    }
  };

  const getProjectId = () => projectIdRef.current;

  const createProject = useCallback(async (data: Partial<ProjectData>) => {
    const newProject = await createStoredVideoProject(data);
    setProjectId(newProject.id);
    return newProject.id;
  }, []);

  const saveProject = useCallback(async (data: Partial<ProjectData>) => {
    const id = projectIdRef.current;
    if (!id) return;
    Object.assign(pendingRef.current, data);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const projects = await getProjects();
      const index = projects.findIndex((p) => p.id === id);
      if (index === -1) return;
      const update = { ...pendingRef.current };
      pendingRef.current = {};
      projects[index] = normalizeStoredVideoProject(pruneExpiredVideoReferencesFromProject({
        ...projects[index],
        ...update,
        updatedAt: new Date().toISOString(),
      }));
      await saveProjects(projects);
    }, 500);
  }, []);

  const loadProject = useCallback(async (id: string) => {
    const projects = await getProjects();
    const project = projects.find((p) => p.id === id);
    if (!project) return null;
    setProjectId(id);
    return {
      title: project.title,
      script: project.script,
      targetPlatform: project.targetPlatform,
      shotStyle: project.shotStyle,
      outputGoal: project.outputGoal,
      productionNotes: project.productionNotes,
      scenes: project.scenes,
      characters: project.characters,
      sceneSettings: project.sceneSettings,
      artStyle: project.artStyle,
      currentStep: project.currentStep,
      systemPrompt: project.systemPrompt,
      analysisSummary: project.analysisSummary,
      storyboardPlan: project.storyboardPlan,
      videoPromptBatch: project.videoPromptBatch,
      segmentVideoPrompts: project.segmentVideoPrompts,
      segmentVideos: project.segmentVideos,
      segmentVideoStatuses: project.segmentVideoStatuses,
      sourceProjectId: project.sourceProjectId,
      styleLock: project.styleLock,
      worldModel: project.worldModel,
      assetManifest: project.assetManifest,
      shotPackets: project.shotPackets,
      productionStateBundle: project.productionStateBundle,
      imageGenerationPrefs: normalizeVideoImageGenerationPrefs(project.imageGenerationPrefs),
      videoGenerationPrefs: normalizeVideoGenerationPrefs(project.videoGenerationPrefs),
    };
  }, []);

  const listProjects = useCallback(async () => {
    const projects = await getProjects();
    return projects
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, 20)
      .map((p) => ({
        id: p.id,
        title: p.title,
        current_step: p.currentStep,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      }));
  }, []);

  const deleteProject = useCallback(async (id: string) => {
    const projects = await getProjects();
    const filtered = projects.filter((p) => p.id !== id);
    await saveProjects(filtered);
    if (projectIdRef.current === id) {
      setProjectId(null);
    }
    return true;
  }, []);

  useCallback(async () => {
    const lastId = localStorage.getItem(CURRENT_PROJECT_KEY);
    if (!lastId) return;
    const projects = await getProjects();
    if (projects.some((p) => p.id === lastId)) {
      projectIdRef.current = lastId;
    }
  }, []);

  return {
    createProject,
    saveProject,
    loadProject,
    listProjects,
    deleteProject,
    setProjectId,
    getProjectId,
  };
}
