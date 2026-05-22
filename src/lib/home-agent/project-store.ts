import {
  createEmptyComplianceWorkspace,
  createEmptyDramaProject,
  DRAMA_STEP_LABELS,
  type DramaProject,
  type DramaProjectArtifactPreferences,
  type DramaSetup,
  type DramaStep,
  type EpisodeEntry,
  type EpisodeGenerationStatus,
  type EpisodeQualityReviewBatch,
  type EpisodeQualityReviewPacket,
  type ExportPatchPlan,
} from "@/types/drama";
import type {
  ConversationArtifact,
  ConversationArtifactAction,
  ConversationArtifactEditor,
  ConversationProjectSnapshot,
  MaintenanceReport,
  ScriptArtifactPayload,
  SkillDraft,
  StudioSessionState,
} from "./types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import type { VideoAutomationState, VideoStyleLock, VideoWorldModel } from "@/types/project";
import { synchronizeVideoProductionState } from "./video-production-memory";
import {
  canSwitchToVideoWorkflowStep,
  deriveNaturalVideoStep,
  hasPassedVideoScriptBreakdown,
} from "./video-workflow-step-gates";
import { getHomeAgentVideoGenerationBatchLimit } from "./video-models";
import { synchronizeDramaProductionState } from "./drama-production-memory";
import {
  normalizeComplianceWorkspace,
  resolveComplianceStatus,
} from "./compliance-workspace";
import {
  buildExportPatchPlan,
  buildExportPatchSignature,
  buildOutlineBatchActionLabel,
  buildOutlineBatchRangeLabel,
  buildOutlineBatchStatuses,
  buildQuickExportMarkdown,
  countComplianceFlags,
  extractDetailedMermaidCode,
  extractMermaidCode,
  findNextOutlineBatchStatus,
  formatEpisodeRangeLabel,
  getCompletedEpisodeNumbers,
  mergeCompliancePacketsByStatus,
  parseDramaDirectoryText,
  repairDramaDirectoryFromRaw,
  stripMermaidCodeBlocks,
  summariseEpisodeReviewPackets,
} from "./script-artifact-helpers";
import {
  clearStudioSession,
  hasSessionResetMarkerForProject,
  readSessionResetMarkers,
  pruneExpiredMediaFromSession,
  readProjectStudioSession,
  readProjectSessionFromFile,
  readStudioProjectSession,
  readStudioSession,
  listStudioProjectSessions,
  removeProjectStudioSession,
  sessionHasFullAutoLineage,
  writeStudioSession,
  writeProjectStudioSession,
} from "./session-store";
import { normalizeAutomationMode } from "./automation-mode";
import { isExpiredRemoteSignedMediaUrl } from "./media-url";
import {
  deleteConversationArchive,
  listConversationArchiveSnapshots,
  readConversationArchiveFull,
  scanConversationArchives,
  writeConversationArchiveProject,
} from "./conversation-archive";
import { materializeConversationArchiveProject } from "./chat-history-io";

export {
  clearStudioSession,
  readProjectStudioSession,
  readStudioProjectSession,
  readStudioSession,
  removeProjectStudioSession,
  writeStudioSession,
};

const DRAMA_PROJECTS_KEY = "storyforge_drama_projects";
const SKILL_DRAFTS_KEY = "storyforge-skill-drafts-v1";
const MAINTENANCE_REPORTS_KEY = "storyforge-maintenance-reports-v1";
const CONVERSATION_PROJECT_META_KEY = "storyforge-home-agent-project-meta-v1";
const inferredConversationAutomationModeCache = new Map<string, "manual" | "full-auto">();
const pendingConversationArchiveBackfillProjectIds = new Set<string>();

type ConversationProjectMeta = {
  pinned?: boolean;
  customTitle?: string;
  automationMode?: "manual" | "full-auto";
};

type VideoPersistenceModule = typeof import("@/hooks/use-local-persistence");
let videoPersistencePromise: Promise<VideoPersistenceModule> | null = null;

function loadVideoPersistenceModule(): Promise<VideoPersistenceModule> {
  if (!videoPersistencePromise) {
    videoPersistencePromise = import("@/hooks/use-local-persistence");
  }
  return videoPersistencePromise;
}

async function cleanupResetMarkedConversationArchives(): Promise<void> {
  const resetProjectIds = new Set(readSessionResetMarkers());
  if (!resetProjectIds.size) return;

  const archiveRecords = await scanConversationArchives({ refresh: true });
  const staleArchiveIds = [...new Set(
    archiveRecords
      .map((record) => record.manifest.projectId)
      .filter((projectId) => resetProjectIds.has(projectId)),
  )];
  if (!staleArchiveIds.length) return;

  await Promise.all(staleArchiveIds.map((projectId) => deleteConversationArchive(projectId)));
}

async function materializeConversationArchiveProjectById(projectId: string): Promise<{
  snapshot: ConversationProjectSnapshot | null;
  dramaProject: DramaProject | null;
  videoProject: PersistedVideoProject | null;
  materialized: boolean;
}> {
  if (hasSessionResetMarkerForProject(projectId)) {
    return {
      snapshot: null,
      dramaProject: null,
      videoProject: null,
      materialized: false,
    };
  }

  const { loadStoredVideoProjectById, upsertStoredVideoProject } = await loadVideoPersistenceModule();
  const existingDramaProject = loadStoredDramaProjectById(projectId);
  const existingVideoProject = await loadStoredVideoProjectById(projectId, { fast: true });
  const existingSession = readProjectStudioSession(projectId);

  if (existingDramaProject || existingVideoProject) {
    if (!existingSession) {
      const archiveOnly = await materializeConversationArchiveProject(projectId);
      if (archiveOnly.ok) {
        await writeProjectStudioSession(archiveOnly.session);
      }
    }

    return {
      snapshot: existingDramaProject
        ? createDramaSnapshot(existingDramaProject)
        : existingVideoProject
          ? createVideoSnapshot(existingVideoProject)
          : null,
      dramaProject: existingDramaProject,
      videoProject: existingVideoProject,
      materialized: false,
    };
  }

  const imported = await materializeConversationArchiveProject(projectId);
  if (!imported.ok) {
    return {
      snapshot: null,
      dramaProject: null,
      videoProject: null,
      materialized: false,
    };
  }

  await writeProjectStudioSession(imported.session);

  if (imported.videoProject) {
    const savedVideoProject = await upsertStoredVideoProject(imported.videoProject);
    return {
      snapshot: createVideoSnapshot(savedVideoProject),
      dramaProject: null,
      videoProject: savedVideoProject,
      materialized: true,
    };
  }

  if (imported.dramaProject) {
    const savedDramaProject = upsertStoredDramaProject(imported.dramaProject);
    return {
      snapshot: createDramaSnapshot(savedDramaProject),
      dramaProject: savedDramaProject,
      videoProject: null,
      materialized: true,
    };
  }

  return {
    snapshot: imported.session.currentProjectSnapshot ?? null,
    dramaProject: null,
    videoProject: null,
    materialized: false,
  };
}

export async function materializeConversationArchives(): Promise<number> {
  await cleanupResetMarkedConversationArchives();
  const archiveRecords = await scanConversationArchives({ refresh: true });
  let importedCount = 0;

  for (const record of archiveRecords) {
    if (hasSessionResetMarkerForProject(record.manifest.projectId)) {
      continue;
    }
    const imported = await materializeConversationArchiveProjectById(record.manifest.projectId);
    if (imported.materialized) {
      importedCount += 1;
    }
  }

  return importedCount;
}

function safeReadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;

  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

function readConversationProjectMetaMap(): Record<string, ConversationProjectMeta> {
  const raw = safeReadJson<Record<string, ConversationProjectMeta | null>>(CONVERSATION_PROJECT_META_KEY, {});
  return Object.entries(raw).reduce<Record<string, ConversationProjectMeta>>((acc, [projectId, meta]) => {
    if (!meta || typeof meta !== "object") return acc;
    const normalized: ConversationProjectMeta = {};
    if (typeof meta.customTitle === "string" && meta.customTitle.trim()) {
      normalized.customTitle = meta.customTitle.trim().slice(0, 120);
    }
    if (typeof meta.pinned === "boolean") {
      normalized.pinned = meta.pinned;
    }
    if (meta.automationMode === "full-auto" || meta.automationMode === "manual") {
      normalized.automationMode = normalizeAutomationMode(meta.automationMode);
    }
    if (
      normalized.customTitle ||
      typeof normalized.pinned === "boolean" ||
      normalized.automationMode
    ) {
      acc[projectId] = normalized;
    }
    return acc;
  }, {});
}

function writeConversationProjectMetaMap(map: Record<string, ConversationProjectMeta>): void {
  safeWriteJson(CONVERSATION_PROJECT_META_KEY, map);
}

function applyConversationProjectMeta(snapshot: ConversationProjectSnapshot): ConversationProjectSnapshot {
  const meta = readConversationProjectMetaMap()[snapshot.projectId];
  if (!meta) return { ...snapshot, automationMode: normalizeAutomationMode(snapshot.automationMode), pinned: false };
  return {
    ...snapshot,
    automationMode: normalizeAutomationMode(meta.automationMode ?? snapshot.automationMode),
    title: meta.customTitle || snapshot.title,
    pinned: Boolean(meta.pinned),
  };
}

function applyConversationProjectMetaFromMap(
  snapshot: ConversationProjectSnapshot,
  metaMap: Record<string, ConversationProjectMeta>,
): ConversationProjectSnapshot {
  const meta = metaMap[snapshot.projectId];
  if (!meta) return { ...snapshot, automationMode: normalizeAutomationMode(snapshot.automationMode), pinned: false };
  return {
    ...snapshot,
    automationMode: normalizeAutomationMode(meta.automationMode ?? snapshot.automationMode),
    title: meta.customTitle || snapshot.title,
    pinned: Boolean(meta.pinned),
  };
}

async function inferConversationProjectAutomationMode(
  snapshot: ConversationProjectSnapshot,
): Promise<"manual" | "full-auto"> {
  const cached = inferredConversationAutomationModeCache.get(snapshot.projectId);
  if (cached) return cached;

  const snapshotMode = normalizeAutomationMode(snapshot.automationMode);
  if (snapshotMode === "full-auto") {
    inferredConversationAutomationModeCache.set(snapshot.projectId, snapshotMode);
    return snapshotMode;
  }

  const localSession = readStudioProjectSession(snapshot.projectId);
  if (sessionHasFullAutoLineage(localSession)) {
    inferredConversationAutomationModeCache.set(snapshot.projectId, "full-auto");
    return "full-auto";
  }

  const fileSession = await readProjectSessionFromFile(snapshot.projectId);
  if (sessionHasFullAutoLineage(fileSession)) {
    inferredConversationAutomationModeCache.set(snapshot.projectId, "full-auto");
    return "full-auto";
  }

  inferredConversationAutomationModeCache.set(snapshot.projectId, snapshotMode);
  return snapshotMode;
}

function getConversationProjectSnapshotFromSession(
  session: StudioSessionState | null | undefined,
  projectId: string,
): ConversationProjectSnapshot | null {
  const snapshot = session?.currentProjectSnapshot;
  if (!snapshot || snapshot.projectId !== projectId) return null;
  return snapshot;
}

async function inferConversationProjectSessionSnapshot(
  snapshot: ConversationProjectSnapshot,
): Promise<ConversationProjectSnapshot | null> {
  const localSnapshot = getConversationProjectSnapshotFromSession(
    readStudioProjectSession(snapshot.projectId),
    snapshot.projectId,
  );
  if (localSnapshot) return localSnapshot;

  const fileSnapshot = getConversationProjectSnapshotFromSession(
    await readProjectSessionFromFile(snapshot.projectId),
    snapshot.projectId,
  );
  return fileSnapshot;
}

async function repairConversationSnapshotAutomationModes(
  snapshots: ConversationProjectSnapshot[],
  metaMap: Record<string, ConversationProjectMeta>,
): Promise<ConversationProjectSnapshot[]> {
  let nextMetaMap: Record<string, ConversationProjectMeta> | null = null;

  const repairedSnapshots = await Promise.all(
    snapshots.map(async (snapshot) => {
      const meta = metaMap[snapshot.projectId];
      const sessionSnapshot = await inferConversationProjectSessionSnapshot(snapshot);
      const mergedSnapshot = sessionSnapshot
        ? {
            ...snapshot,
            ...sessionSnapshot,
            projectId: snapshot.projectId,
            title: meta?.customTitle || sessionSnapshot.title || snapshot.title,
            pinned: typeof meta?.pinned === "boolean" ? meta.pinned : Boolean(snapshot.pinned),
          }
        : snapshot;

      const inferredAutomationMode = await inferConversationProjectAutomationMode(mergedSnapshot);
      if (inferredAutomationMode === normalizeAutomationMode(mergedSnapshot.automationMode)) {
        return mergedSnapshot;
      }

      nextMetaMap ??= { ...metaMap };
      nextMetaMap[snapshot.projectId] = {
        ...(nextMetaMap[snapshot.projectId] ?? {}),
        automationMode: inferredAutomationMode,
      };
      return {
        ...mergedSnapshot,
        automationMode: inferredAutomationMode,
      };
    }),
  );

  if (nextMetaMap) {
    writeConversationProjectMetaMap(nextMetaMap);
  }

  return repairedSnapshots;
}

async function listSessionBackedConversationSnapshots(
  existingProjectIds: Set<string>,
): Promise<ConversationProjectSnapshot[]> {
  if (typeof window === "undefined") return [];

  const snapshotsById = new Map<string, ConversationProjectSnapshot>();
  const addSessionSnapshot = (session: StudioSessionState | null | undefined) => {
    const snapshot = session?.currentProjectSnapshot;
    if (!snapshot?.projectId) return;

    const sessionProjectId =
      typeof session?.projectId === "string" && session.projectId.trim()
        ? session.projectId.trim()
        : "";
    const shouldProjectVideoOntoSessionShell =
      snapshot.projectKind === "video" &&
      sessionProjectId &&
      snapshot.sourceProjectId === sessionProjectId;
    const projectId = shouldProjectVideoOntoSessionShell ? sessionProjectId : snapshot.projectId;
    if (!projectId || existingProjectIds.has(projectId) || hasSessionResetMarkerForProject(projectId)) {
      return;
    }

    const normalizedSnapshot: ConversationProjectSnapshot = {
      ...snapshot,
      projectId,
      automationMode: normalizeAutomationMode(session?.automationMode ?? snapshot.automationMode),
    };
    const previous = snapshotsById.get(projectId);
    if (
      !previous ||
      new Date(getSnapshotUpdatedAt(normalizedSnapshot)).getTime() >=
        new Date(getSnapshotUpdatedAt(previous)).getTime()
    ) {
      snapshotsById.set(projectId, normalizedSnapshot);
    }
  };

  for (const session of listStudioProjectSessions()) {
    addSessionSnapshot(session);
  }

  if (!window.electronAPI?.storage?.getDefaultPath || !window.electronAPI?.storage?.listDir) {
    return [...snapshotsById.values()];
  }

  try {
    const paths = await window.electronAPI.storage.getDefaultPath();
    const dir = `${paths.db}/sessions`;
    const result = await window.electronAPI.storage.listDir(dir);
    if (!result.ok || !Array.isArray(result.entries)) return [];

    const projectIds = result.entries
      .filter((entry) => !entry.isDirectory && entry.name.endsWith(".json") && entry.name !== "_last.json")
      .map((entry) => entry.name.slice(0, -5))
      .filter((projectId) =>
        projectId &&
        !existingProjectIds.has(projectId) &&
        !hasSessionResetMarkerForProject(projectId),
      );
    if (!projectIds.length) return [...snapshotsById.values()];

    const sessions = await Promise.all(projectIds.map((projectId) => readProjectSessionFromFile(projectId)));
    for (const session of sessions) {
      addSessionSnapshot(session);
    }

    return [...snapshotsById.values()];
  } catch {
    return [...snapshotsById.values()];
  }
}

function createArchiveBackfillSession(
  snapshot: ConversationProjectSnapshot,
  baseSession?: StudioSessionState | null,
): StudioSessionState {
  const createdAt = snapshot.updatedAt || new Date().toISOString();
  const fallbackSummary =
    snapshot.agentSummary?.trim() ||
    snapshot.currentObjective?.trim() ||
    `${snapshot.title} 历史归档补建`;

  return {
    sessionId:
      baseSession?.sessionId ||
      `archive-backfill-${snapshot.projectId}`,
    compactedMessageCount: baseSession?.compactedMessageCount ?? 0,
    mode: baseSession?.mode ?? "active",
    creationMode: baseSession?.creationMode ?? "fast",
    automationMode: normalizeAutomationMode(baseSession?.automationMode ?? snapshot.automationMode),
    devMode: baseSession?.devMode ?? false,
    suppressHistoricalMemory: baseSession?.suppressHistoricalMemory ?? true,
    messages:
      Array.isArray(baseSession?.messages) && baseSession.messages.length > 0
        ? baseSession.messages
        : [
            {
              id: `archive-backfill-message-${snapshot.projectId}`,
              role: "assistant",
              content: fallbackSummary,
              createdAt,
            },
          ],
    currentProjectSnapshot: snapshot,
    recentMessageSummary: baseSession?.recentMessageSummary || fallbackSummary,
    projectId: snapshot.projectId,
    selectedTextModelKey: baseSession?.selectedTextModelKey,
    selectedImageModelFamily: baseSession?.selectedImageModelFamily,
    imageGenerationPrefs: baseSession?.imageGenerationPrefs,
    selectedVideoModelKey: baseSession?.selectedVideoModelKey,
    videoGenerationPrefs: baseSession?.videoGenerationPrefs,
    draft: baseSession?.draft ?? "",
    qState: baseSession?.qState ?? null,
    deferredQuestionState: baseSession?.deferredQuestionState ?? null,
    pendingWorkflowUploadKind: baseSession?.pendingWorkflowUploadKind ?? null,
    pendingChoiceQuestion: baseSession?.pendingChoiceQuestion ?? null,
    interruptedChoiceQuestion: baseSession?.interruptedChoiceQuestion ?? null,
    selectedValues: baseSession?.selectedValues ?? [],
    deferredSelectedValues: baseSession?.deferredSelectedValues ?? [],
    deferredDraft: baseSession?.deferredDraft ?? "",
    surfacedTaskIds: baseSession?.surfacedTaskIds ?? [],
    surfacedTaskFollowupKeys: baseSession?.surfacedTaskFollowupKeys ?? [],
    surfacedProjectSuggestionKeys: baseSession?.surfacedProjectSuggestionKeys ?? [],
    fullAutoRun: baseSession?.fullAutoRun ?? null,
  };
}

function queueConversationArchiveBackfill(snapshot: ConversationProjectSnapshot): void {
  const projectId = snapshot.projectId;
  if (!projectId || pendingConversationArchiveBackfillProjectIds.has(projectId)) return;

  pendingConversationArchiveBackfillProjectIds.add(projectId);
  const baseSession = readProjectStudioSession(projectId);
  const backfillSession = createArchiveBackfillSession(snapshot, baseSession);

  void writeProjectStudioSession(backfillSession).finally(() => {
    pendingConversationArchiveBackfillProjectIds.delete(projectId);
  });
}

function stripConversationDuplicateSuffix(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\s*-\s*副本\d*\s*$/u, "").trim();
}

async function buildNextDuplicateConversationTitle(sourceTitle: string): Promise<string> {
  const metaMap = readConversationProjectMetaMap();
  const applyMetaTitle = (projectId: string, fallbackTitle: string) =>
    metaMap[projectId]?.customTitle?.trim() || fallbackTitle.trim();

  const baseTitle = stripConversationDuplicateSuffix(sourceTitle) || sourceTitle.trim() || "未命名项目";
  const existingTitles = new Set<string>();

  for (const project of listStoredDramaProjects()) {
    existingTitles.add(applyMetaTitle(project.id, project.dramaTitle || "未命名项目"));
  }

  const { listStoredVideoProjects } = await loadVideoPersistenceModule();
  for (const project of await listStoredVideoProjects({ fast: true })) {
    existingTitles.add(applyMetaTitle(project.id, project.title || "未命名视频项目"));
  }

  for (const snapshot of await listConversationArchiveSnapshots()) {
    existingTitles.add(applyMetaTitle(snapshot.projectId, snapshot.title || "未命名项目"));
  }

  const firstCopyTitle = `${baseTitle} - 副本`;
  if (!existingTitles.has(firstCopyTitle)) return firstCopyTitle;

  let index = 2;
  while (existingTitles.has(`${baseTitle} - 副本${index}`)) {
    index += 1;
  }
  return `${baseTitle} - 副本${index}`;
}

function removeConversationProjectMeta(projectId: string): void {
  const map = readConversationProjectMetaMap();
  if (!map[projectId]) return;
  delete map[projectId];
  writeConversationProjectMetaMap(map);
}

function normalizeDramaSetup(setup: DramaSetup | null | undefined): DramaSetup | null {
  if (!setup || typeof setup !== "object") {
    return null;
  }

  return {
    genres: Array.isArray(setup.genres)
      ? setup.genres.filter((genre): genre is string => typeof genre === "string")
      : [],
    audience: typeof setup.audience === "string" ? setup.audience : "",
    tone: typeof setup.tone === "string" ? setup.tone : "",
    ending: typeof setup.ending === "string" ? setup.ending : "",
    totalEpisodes: typeof setup.totalEpisodes === "number" ? setup.totalEpisodes : 0,
    targetMarket: typeof setup.targetMarket === "string" ? setup.targetMarket : "",
    customTopic: typeof setup.customTopic === "string" ? setup.customTopic : "",
    setupMode:
      setup.setupMode === "creative" || setup.setupMode === "topic"
        ? setup.setupMode
        : undefined,
    creativeInput: typeof setup.creativeInput === "string" ? setup.creativeInput : "",
  };
}

function normalizeExportPatchPlan(plan: ExportPatchPlan | null | undefined): ExportPatchPlan | null {
  if (!plan || typeof plan !== "object") {
    return null;
  }

  const entries = Array.isArray(plan.entries)
    ? plan.entries
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          id: typeof entry.id === "string" ? entry.id : "",
          kind:
            entry.kind === "missing-outline" ||
            entry.kind === "missing-episode" ||
            entry.kind === "episode-review" ||
            entry.kind === "compliance" ||
            entry.kind === "export-refresh"
              ? entry.kind
              : "export-refresh",
          title: typeof entry.title === "string" ? entry.title : "",
          priority:
            entry.priority === "high" || entry.priority === "medium" || entry.priority === "low"
              ? entry.priority
              : "low",
          summary: typeof entry.summary === "string" ? entry.summary : "",
          episodeNumbers: Array.isArray(entry.episodeNumbers)
            ? entry.episodeNumbers.filter(
                (episodeNumber): episodeNumber is number =>
                  typeof episodeNumber === "number" && Number.isFinite(episodeNumber),
              )
            : undefined,
          action:
            entry.action &&
            typeof entry.action === "object" &&
            typeof entry.action.label === "string" &&
            typeof entry.action.value === "string"
              ? {
                  label: entry.action.label,
                  value: entry.action.value,
                }
              : undefined,
        }))
        .filter((entry) => entry.id && entry.title)
    : [];

  return {
    generatedAt:
      typeof plan.generatedAt === "string" && plan.generatedAt.trim()
        ? plan.generatedAt
        : new Date().toISOString(),
    signature: typeof plan.signature === "string" ? plan.signature : "",
    readyForExport: Boolean(plan.readyForExport),
    summary: typeof plan.summary === "string" ? plan.summary : "",
    counts: {
      high: typeof plan.counts?.high === "number" ? plan.counts.high : 0,
      medium: typeof plan.counts?.medium === "number" ? plan.counts.medium : 0,
      low: typeof plan.counts?.low === "number" ? plan.counts.low : 0,
    },
    recommendedAction:
      plan.recommendedAction &&
      typeof plan.recommendedAction === "object" &&
      typeof plan.recommendedAction.label === "string" &&
      typeof plan.recommendedAction.value === "string"
        ? {
            label: plan.recommendedAction.label,
            value: plan.recommendedAction.value,
          }
        : undefined,
    entries,
  };
}

function normalizeDramaArtifactPreferences(
  preferences: DramaProjectArtifactPreferences | null | undefined,
): DramaProjectArtifactPreferences {
  return {
    relationshipDiagramCollapsed: Boolean(preferences?.relationshipDiagramCollapsed),
  };
}

function normalizeEpisodeQualityReviewBatch(
  batch: DramaProject["lastEpisodeQualityReviewBatch"],
): EpisodeQualityReviewBatch | null {
  if (!batch || typeof batch !== "object") return null;

  const mode =
    batch.mode === "custom-count" || batch.mode === "episodes"
      ? batch.mode
      : "default-count";
  const episodeNumbers = Array.isArray(batch.episodeNumbers)
    ? [...new Set(
        batch.episodeNumbers.filter(
          (episodeNumber): episodeNumber is number =>
            Number.isInteger(episodeNumber) && episodeNumber > 0,
        ),
      )].sort((a, b) => a - b)
    : [];
  const reviewedAt = typeof batch.reviewedAt === "string" ? batch.reviewedAt : "";
  const requestedCount =
    typeof batch.requestedCount === "number" &&
    Number.isInteger(batch.requestedCount) &&
    batch.requestedCount > 0
      ? batch.requestedCount
      : null;

  if (!reviewedAt) return null;

  return {
    mode,
    episodeNumbers,
    reviewedAt,
    requestedCount,
  };
}

function normalizeDramaProject(project: DramaProject): DramaProject {
  const mode = project?.mode === "adaptation" ? "adaptation" : "traditional";
  const base = createEmptyDramaProject(mode);
  const normalizedDirectory = Array.isArray(project?.directory) ? project.directory : [];
  const normalizedDirectoryRaw = typeof project?.directoryRaw === "string" ? project.directoryRaw : "";
  const repairedDirectory = repairDramaDirectoryFromRaw(normalizedDirectoryRaw, normalizedDirectory);

  return {
    ...base,
    ...project,
    mode,
    setup: normalizeDramaSetup(project?.setup),
    creativePlan: typeof project?.creativePlan === "string" ? project.creativePlan : "",
    characters: typeof project?.characters === "string" ? project.characters : "",
    directory: repairedDirectory,
    directoryRaw: normalizedDirectoryRaw,
    episodes: Array.isArray(project?.episodes) ? project.episodes : [],
    complianceReport:
      typeof project?.complianceReport === "string" ? project.complianceReport : "",
    currentStep:
      typeof project?.currentStep === "string" ? project.currentStep : base.currentStep,
    dramaTitle: typeof project?.dramaTitle === "string" ? project.dramaTitle : "",
    createdAt: typeof project?.createdAt === "string" ? project.createdAt : base.createdAt,
    updatedAt: typeof project?.updatedAt === "string" ? project.updatedAt : base.updatedAt,
    referenceScript:
      typeof project?.referenceScript === "string" ? project.referenceScript : "",
    referenceStructure:
      typeof project?.referenceStructure === "string" ? project.referenceStructure : "",
    frameworkStyle:
      typeof project?.frameworkStyle === "string" ? project.frameworkStyle : "",
    structureTransform:
      typeof project?.structureTransform === "string" ? project.structureTransform : "",
    characterTransform:
      typeof project?.characterTransform === "string" ? project.characterTransform : "",
    adaptationEpisodeCountConfirmed: project?.adaptationEpisodeCountConfirmed === true,
    adaptationTargetMarketConfirmed: project?.adaptationTargetMarketConfirmed === true,
    adaptationGenresConfirmed: project?.adaptationGenresConfirmed === true,
    exportDocument:
      typeof project?.exportDocument === "string" ? project.exportDocument : "",
    styleLock: project?.styleLock ?? null,
    worldModel: project?.worldModel ?? null,
    characterStateCards: Array.isArray(project?.characterStateCards) ? project.characterStateCards : [],
    storyBeatPackets: Array.isArray(project?.storyBeatPackets) ? project.storyBeatPackets : [],
    complianceRevisionPackets: Array.isArray(project?.complianceRevisionPackets)
      ? project.complianceRevisionPackets
      : [],
    outlineBatchStatuses: Array.isArray(project?.outlineBatchStatuses)
      ? project.outlineBatchStatuses
      : [],
    episodeGenerationStatuses: Array.isArray(project?.episodeGenerationStatuses)
      ? project.episodeGenerationStatuses
      : [],
    preferredEpisodeDurationSeconds:
      typeof project?.preferredEpisodeDurationSeconds === "number" &&
      Number.isFinite(project.preferredEpisodeDurationSeconds)
        ? project.preferredEpisodeDurationSeconds
        : null,
    complianceReviewMode:
      project?.complianceReviewMode === "script" ? "script" : "text",
    complianceWorkspace: normalizeComplianceWorkspace(
      project?.complianceWorkspace ?? createEmptyComplianceWorkspace(),
    ),
    complianceSkippedAt:
      typeof project?.complianceSkippedAt === "string" ? project.complianceSkippedAt : null,
    episodeQualityReviewPackets: Array.isArray(project?.episodeQualityReviewPackets)
      ? project.episodeQualityReviewPackets
      : [],
    lastEpisodeQualityReviewBatch: normalizeEpisodeQualityReviewBatch(
      project?.lastEpisodeQualityReviewBatch ?? null,
    ),
    exportPatchPlan: normalizeExportPatchPlan(project?.exportPatchPlan),
    artifactPreferences: normalizeDramaArtifactPreferences(project?.artifactPreferences),
  };
}

function firstNonEmptyText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.trim()) return value;
  }
  return "";
}

function truncate(text: unknown, max = 180): string {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function buildArtifact(
  id: string,
  kind: ConversationArtifact["kind"],
  label: string,
  content: string,
  updatedAt: string,
  options?: {
    summary?: string;
    presentation?: ConversationArtifact["presentation"];
    payload?: ScriptArtifactPayload;
    actions?: ConversationArtifactAction[];
    editor?: ConversationArtifactEditor;
  },
): ConversationArtifact {
  return {
    id,
    kind,
    label,
    content,
    summary: options?.summary ?? truncate(content),
    updatedAt,
    presentation: options?.presentation,
    payload: options?.payload,
    actions: options?.actions,
    editor: options?.editor,
  };
}

function mapTargetMarket(value: string): string {
  const labels: Record<string, string> = {
    cn: "中国大陆",
    jp: "日本",
    west: "欧美",
    kr: "韩国",
    sea: "东南亚",
  };

  return labels[value] ?? value;
}

function buildDramaSetupSummary(setup: DramaSetup | null): string {
  if (!setup) return "";

  const lines = [
    `目标市场：${setup.targetMarket ? mapTargetMarket(setup.targetMarket) : "未设定"}`,
    `受众：${setup.audience || "未设定"}`,
    `风格：${setup.tone || "未设定"}`,
    `结局：${setup.ending || "未设定"}`,
    `总集数：${setup.totalEpisodes || "未设定"}`,
  ];

  if (setup.genres.length > 0) {
    lines.push(`题材：${setup.genres.join("、")}`);
  }
  if (setup.customTopic?.trim()) {
    lines.push(`主题补充：${setup.customTopic.trim()}`);
  }
  if (setup.creativeInput?.trim()) {
    lines.push(`创意输入：${setup.creativeInput.trim()}`);
  }

  return lines.join("\n");
}

function deriveDramaStyleLock(project: DramaProject): VideoStyleLock | null {
  if (!project.setup) return null;

  const genres = project.setup.genres.length
    ? project.setup.genres
    : project.setup.customTopic.trim()
      ? [project.setup.customTopic.trim()]
      : [];

  return {
    genre: genres.length ? genres : ["待补充题材"],
    tone: project.setup.tone || "待补充调性",
    visualStyle:
      project.mode === "adaptation"
        ? `${project.frameworkStyle || "参考改编"} 的结构转译质感`
        : `${project.setup.targetMarket ? mapTargetMarket(project.setup.targetMarket) : "当前市场"} 短剧叙事质感`,
    colorMood: project.setup.tone ? `${project.setup.tone}向情绪光影` : "高识别度主情绪氛围",
    cinematography:
      project.mode === "adaptation"
        ? "保留参考骨架，但重做人物与事件呈现"
        : "高钩子、快入题、人物关系驱动",
    forbidden: [
      "不要偏离已锁定的目标市场和受众取向",
      "不要破坏主卖点与核心人物关系",
      project.setup.ending ? `不要把结局方向改出 ${project.setup.ending}` : "",
    ].filter(Boolean),
    referencePromptTemplate: [
      "{核心人物}，{关系冲突}，{关键卖点}，",
      `${project.setup.tone || "高情绪"}，${genres.join("、") || "短剧创作"}，`,
      `${project.setup.audience || "目标受众"}向短剧节奏，保持市场一致性。`,
    ].join(""),
  };
}

function deriveDramaWorldModel(project: DramaProject): VideoWorldModel | null {
  const synopsisSource = firstNonEmptyText(
    project.creativePlan,
    project.structureTransform,
    project.referenceStructure,
    project.setup?.creativeInput,
    project.setup?.customTopic,
  );

  if (!synopsisSource.trim() && !project.directory.length && !project.episodes.length) {
    return null;
  }

  const beatSources = project.directory.slice(0, 8).map((entry) => ({
    id: `ep-${entry.number}`,
    name: `第 ${entry.number} 集 · ${entry.title}`,
    description: entry.summary || entry.outline || "等待补充分集推进",
  }));

  const primaryCharacterDescription = firstNonEmptyText(project.characters, project.characterTransform);
  if (typeof project.characters !== "string" || typeof project.characterTransform !== "string") {
    project = {
      ...project,
      characters: typeof project.characters === "string" ? project.characters : primaryCharacterDescription,
      characterTransform: typeof project.characterTransform === "string" ? project.characterTransform : "",
    };
  }

  return {
    version: `drama-world-${project.updatedAt || new Date().toISOString()}`,
    synopsis: truncate(synopsisSource || "项目已进入持续创作阶段。", 220),
    continuityRules: [
      "保持主要人物关系与反转逻辑连续",
      "分集钩子和高潮位置需要逐步升级",
      "创作输出应服从当前市场、受众和结局方向",
    ],
    characters: [
      {
        id: `${project.id}-protagonists`,
        name: "主角群",
        description: truncate(project.characters || project.characterTransform || "待补充角色设定。", 220),
        aliases: [],
        currentState:
          project.currentStep === "characters" || project.currentStep === "character-transform"
            ? "正在继续完善人物弧光与冲突"
            : "角色基调已进入后续创作流",
        constraints: [
          project.setup?.audience ? `受众指向：${project.setup.audience}` : "",
          project.setup?.tone ? `调性：${project.setup.tone}` : "",
        ].filter(Boolean),
        referenceAssetIds: [],
      },
    ],
    scenes: beatSources.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: truncate(entry.description, 140),
      timeVariantLabels: [],
      referenceAssetIds: [],
    })),
  };
}

function buildOutlinePreview(project: DramaProject): string {
  return project.directory
    .filter((entry) => entry.outline?.trim())
    .slice(0, 4)
    .map(
      (entry) =>
        `第 ${entry.number} 集 · ${entry.title}\n${entry.outline?.trim() || ""}`,
    )
    .join("\n\n---\n\n");
}

function buildOutlineEditableText(project: DramaProject): string {
  return buildOutlineEditorText(project.directory);
}

function buildOutlineEditorText(entries: EpisodeEntry[]): string {
  return entries
    .filter((entry) => entry.outline?.trim())
    .map(
      (entry) =>
        [
          `【第${entry.number}集细纲】`,
          `标题：${entry.title}`,
          entry.outline?.trim() || "",
        ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function parseDirectoryEditorText(raw: string): EpisodeEntry[] {
  return parseDramaDirectoryText(raw);
}

function parseOutlineEditorText(text: string): Map<number, { title?: string; outline: string }> {
  const blocks = text.replace(/\r/g, "").split(/【第(\d+)集细纲】/);
  const map = new Map<number, { title?: string; outline: string }>();

  for (let index = 1; index < blocks.length; index += 2) {
    const episodeNumber = Number(blocks[index]);
    const block = (blocks[index + 1] ?? "").trim();
    if (!episodeNumber || !block) continue;

    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (!lines.length) continue;

    let title: string | undefined;
    let outlineLines = lines;
    const firstLine = lines[0]?.trim() ?? "";

    if (/^标题[:：]\s*/.test(firstLine)) {
      title = firstLine.replace(/^标题[:：]\s*/, "").trim() || undefined;
      outlineLines = lines.slice(1);
    }

    const outline = outlineLines.join("\n").replace(/---\s*$/, "").trim();
    if (!outline) continue;

    map.set(episodeNumber, { title, outline });
  }

  return map;
}

function buildArtifactEditor(field: ConversationArtifactEditor["field"], text: string): ConversationArtifactEditor {
  return {
    field,
    text,
  };
}

function createArtifactAction(
  id: string,
  label: string,
  value = label,
  variant: ConversationArtifactAction["variant"] = "secondary",
  description?: string,
): ConversationArtifactAction {
  return {
    id,
    label,
    value,
    variant,
    description,
  };
}

function createStepPanelAction(
  project: DramaProject,
  step: DramaStep,
  label = `打开${DRAMA_STEP_LABELS[step]}面板`,
): ConversationArtifactAction {
  return createArtifactAction(
    `${project.id}-step-panel-${step}`,
    label,
    `script:step-enter-${step}`,
    "primary",
    `通过首页工作流面板继续处理${DRAMA_STEP_LABELS[step]}`,
  );
}

function buildSetupPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "setup")];
}

function buildCharactersPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "characters")];
}

function buildCharacterTransformPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "character-transform")];
}

function buildDirectoryPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "directory")];
}

function buildOutlinePanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "outlines")];
}

function buildEpisodesPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "episodes")];
}

function buildCompliancePanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "compliance", "打开合规工作台面板")];
}

function buildExportPanelActions(project: DramaProject): ConversationArtifactAction[] {
  return [createStepPanelAction(project, "export", "打开导出面板")];
}

function buildSetupPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  if (!project.setup) return undefined;
  return {
    type: "setup",
    mode: project.mode,
    marketLabel: project.setup.targetMarket ? mapTargetMarket(project.setup.targetMarket) : "未设置",
    audience: project.setup.audience || "未设置",
    tone: project.setup.tone || "未设置",
    ending: project.setup.ending || "未设置",
    totalEpisodes: project.setup.totalEpisodes || 0,
    genres: project.setup.genres,
    targetMarket: project.setup.targetMarket,
    customTopic: project.setup.customTopic,
    referenceStructure: project.referenceStructure?.trim() || undefined,
    adaptationEpisodeCountConfirmed: project.adaptationEpisodeCountConfirmed === true,
    adaptationTargetMarketConfirmed: project.adaptationTargetMarketConfirmed === true,
    adaptationGenresConfirmed: project.adaptationGenresConfirmed === true,
  };
}

function buildCharactersPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  const body = stripMermaidCodeBlocks(project.characterTransform || project.characters || "");
  if (!body.trim()) return undefined;
  const rawText = project.characterTransform || project.characters || "";
  const mermaidCode = extractMermaidCode(rawText)?.trim();
  const detailedMermaidCode = extractDetailedMermaidCode(rawText)?.trim();

  if (!mermaidCode || !detailedMermaidCode || mermaidCode === detailedMermaidCode) {
    return undefined;
  }

  return {
    type: "characters+mermaid",
    body,
    mermaidCode,
    detailedMermaidCode,
    characterCards: project.characterStateCards ?? [],
    diagramCollapsed: Boolean(project.artifactPreferences?.relationshipDiagramCollapsed),
  };
}

function hasHomepageReadyCharacters(project: DramaProject): boolean {
  return Boolean(buildCharactersPayload(project));
}

function buildDirectoryPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  if (!project.directory.length) return undefined;
  const completedEpisodes = getCompletedEpisodeNumbers(project);
  return {
    type: "directory+stats",
    entries: project.directory.map((entry) => ({
      number: entry.number,
      title: entry.title,
      summary: entry.summary,
      hookType: entry.hookType,
      isKey: entry.isKey,
      isClimax: entry.isClimax,
      isPaywall: entry.isPaywall,
      emotionLevel: entry.emotionLevel,
    })),
    stats: {
      totalEpisodes: project.setup?.totalEpisodes || project.directory.length,
      outlinedEpisodes: project.directory.filter((entry) => entry.outline?.trim()).length,
      writtenEpisodes: project.directory.filter((entry) => completedEpisodes.has(entry.number)).length,
      keyEpisodes: project.directory.filter((entry) => entry.isKey).length,
      climaxEpisodes: project.directory.filter((entry) => entry.isClimax).length,
      paywallEpisodes: project.directory.filter((entry) => entry.isPaywall).length,
    },
  };
}

function buildOutlinePayload(project: DramaProject): ScriptArtifactPayload | undefined {
  if (!project.directory.length) return undefined;
  // 仅在进入单集细纲步骤后才创建细纲 artifact，避免在分集目录阶段提前出现
  if (project.currentStep === "directory") return undefined;
  const fallbackBatches = buildOutlineBatchStatuses(project.directory);
  const batches =
    project.outlineBatchStatuses && project.outlineBatchStatuses.length
      ? project.outlineBatchStatuses
      : fallbackBatches;
  const done = batches.filter((batch) => batch.status === "done").length;
  const failed = batches.filter((batch) => batch.status === "failed").length;
  const processing = batches.filter((batch) => batch.status === "processing").length;
  const total = batches.length;
  const visibleProgressUnits = done + processing * 0.5;

  return {
    type: "outlines+batchProgress",
    totalEpisodes: project.directory.length,
    // 包含全部分集条目（含待生成），方便在进入步骤时展示完整待生成列表
    entries: project.directory.map((entry) => ({
      number: entry.number,
      title: entry.title,
      summary: entry.summary,
      outline: entry.outline,
      hookType: entry.hookType,
      isKey: entry.isKey,
      isClimax: entry.isClimax,
      isPaywall: entry.isPaywall,
      emotionLevel: entry.emotionLevel,
    })),
    batchProgress: {
      total,
      done,
      failed,
      processing,
      percent: total ? Math.round((visibleProgressUnits / total) * 100) : 0,
      batches,
    },
    editorText: buildOutlineEditorText(project.directory),
  };
}

function buildEpisodeBatchPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  const totalEpisodes = project.setup?.totalEpisodes || project.directory.length || project.episodes.length;
  if (!totalEpisodes || (project.currentStep !== "episodes" && !project.episodes.length)) {
    return undefined;
  }

  const episodeMap = new Map(project.episodes.map((episode) => [episode.number, episode]));
  const statusMap = new Map(
    (project.episodeGenerationStatuses ?? []).map((status) => [status.episodeNumber, status] as const),
  );
  const resolveEntryStatus = (entryNumber: number): EpisodeGenerationStatus["status"] => {
    const episode = episodeMap.get(entryNumber);
    if (episode?.content?.trim()) return "done";
    const status = statusMap.get(entryNumber);
    if (status?.status === "processing" || status?.status === "failed") return status.status;
    return "pending";
  };
  const entries =
    project.directory.length > 0
      ? project.directory.map((entry) => {
          const episode = episodeMap.get(entry.number);
          return {
            number: entry.number,
            title: entry.title,
            summary: entry.summary,
            outline: entry.outline,
            status: resolveEntryStatus(entry.number),
            wordCount: episode?.wordCount,
            content: episode?.content,
          };
        })
      : project.episodes.map((episode) => ({
          number: episode.number,
          title: episode.title,
          summary: "",
          outline: undefined,
          status: "done" as const,
          wordCount: episode.wordCount,
          content: episode.content,
        }));
  const done = entries.filter((entry) => entry.status === "done").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const processing = entries.filter((entry) => entry.status === "processing").length;
  const visibleProgressUnits = done + processing * 0.5;

  return {
    type: "episodes+batchProgress",
    totalEpisodes,
    durationSeconds: project.preferredEpisodeDurationSeconds ?? null,
    entries,
    batchProgress: {
      total: totalEpisodes,
      done,
      failed,
      processing,
      percent: totalEpisodes ? Math.round((visibleProgressUnits / totalEpisodes) * 100) : 0,
    },
  };
}

function buildEpisodeReviewPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  const allPackets = [...(project.episodeQualityReviewPackets ?? [])].sort(
    (a, b) => a.episodeNumber - b.episodeNumber,
  );
  if (!allPackets.length) return undefined;

  const packetByEpisodeNumber = new Map(
    allPackets.map((packet) => [packet.episodeNumber, packet] as const),
  );
  const batch = normalizeEpisodeQualityReviewBatch(project.lastEpisodeQualityReviewBatch ?? null);
  const batchPackets =
    batch?.episodeNumbers.length
      ? batch.episodeNumbers
          .map((episodeNumber) => packetByEpisodeNumber.get(episodeNumber))
          .filter((packet): packet is EpisodeQualityReviewPacket => Boolean(packet))
      : [];
  const isBatchUsable =
    Boolean(batch?.episodeNumbers.length) && batchPackets.length === batch?.episodeNumbers.length;
  const packets = isBatchUsable ? batchPackets : allPackets;
  const summary = summariseEpisodeReviewPackets(packets);

  return {
    type: "episodeReview",
    packets,
    batch: isBatchUsable ? batch : null,
    allPacketsCount: allPackets.length,
    episodes: project.episodes.map((episode) => ({
      number: episode.number,
      title: episode.title,
      wordCount: episode.wordCount,
    })),
    summary,
  };
}

function buildCompliancePayload(project: DramaProject): ScriptArtifactPayload | undefined {
  const workspace = normalizeComplianceWorkspace(project.complianceWorkspace);
  const hasWorkspace =
    Boolean(project.complianceReport.trim()) ||
    Boolean(workspace.sourceText.trim()) ||
    Boolean(workspace.paletteText.trim()) ||
    project.currentStep === "compliance";
  if (!hasWorkspace) return undefined;
  const counts = countComplianceFlags(project.complianceReport);
  const packetCounts = mergeCompliancePacketsByStatus(project.complianceRevisionPackets ?? []);
  return {
    type: "complianceSummary",
    mode: project.complianceReviewMode ?? "text",
    strictness: workspace.strictness,
    report: project.complianceReport,
    packets: project.complianceRevisionPackets ?? [],
    workspace,
    skippedAt: project.complianceSkippedAt ?? null,
    counts: {
      ...counts,
      pendingPackets: packetCounts.pendingPackets,
    },
  };
}

function buildExportPayload(project: DramaProject): ScriptArtifactPayload | undefined {
  if (!project.exportDocument?.trim() && !project.episodes.length) return undefined;
  const complianceStatus = resolveComplianceStatus(project);
  const patchPlan =
    project.exportPatchPlan?.signature === buildExportPatchSignature(project)
      ? project.exportPatchPlan
      : buildExportPatchPlan(project);
  return {
    type: "exportSummary",
    dramaTitle: project.dramaTitle,
    completedEpisodes: project.episodes.length,
    totalEpisodes: project.setup?.totalEpisodes || project.directory.length,
    totalWordCount: project.episodes.reduce((sum, episode) => sum + episode.wordCount, 0),
    quickExportMarkdown: buildQuickExportMarkdown(
      project.setup,
      project.dramaTitle,
      project.creativePlan || project.structureTransform || "",
      project.characters,
      project.episodes,
    ),
    exportDocument: project.exportDocument || undefined,
    creativePlan: project.creativePlan || project.structureTransform || "",
    characters: project.characters,
    episodes: project.episodes,
    setup: project.setup,
    patchPlan,
    complianceStatus,
    skippedAt: project.complianceSkippedAt ?? null,
  };
}

function buildSetupActions(project: DramaProject): ConversationArtifactAction[] {
  if (project.mode === "adaptation") {
    if (!project.referenceScript?.trim()) {
      return [];
    }
    if (!project.referenceStructure?.trim()) {
      return [
        createArtifactAction(
          `${project.id}-setup-analyze-reference`,
          "识别参考文本结构",
          "继续分析参考内容，生成结构转译",
          "primary",
        ),
      ];
    }
    if (
      !project.adaptationEpisodeCountConfirmed ||
      !project.adaptationTargetMarketConfirmed ||
      !project.adaptationGenresConfirmed
    ) {
      return [];
    }
    if (!project.structureTransform?.trim()) {
      return [
        createArtifactAction(
          `${project.id}-setup-structure-transform`,
          "生成结构转译",
          "生成结构转译",
          "primary",
        ),
      ];
    }
    if (!hasHomepageReadyCharacters(project)) {
      return [
        createArtifactAction(
          `${project.id}-setup-character-transform`,
          "确认方案，进入角色转译",
          "进入角色开发",
          "primary",
        ),
      ];
    }
  }

  if (!project.creativePlan?.trim()) {
    return [
      createArtifactAction(`${project.id}-setup-plan`, "确认方案", "生成创作方案", "primary"),
    ];
  }
  if (!hasHomepageReadyCharacters(project)) {
    return [
      createArtifactAction(
        `${project.id}-setup-characters`,
        "确认角色方向",
        "进入角色开发",
        "primary",
      ),
    ];
  }
  if (!project.directory.length) {
    return [
      createArtifactAction(
        `${project.id}-setup-directory`,
        "生成目录",
        "生成分集目录",
        "primary",
      ),
    ];
  }
  return [];
}

function buildCharactersActions(project: DramaProject): ConversationArtifactAction[] {
  if (project.directory.length) {
    return [
      createArtifactAction(
        `${project.id}-characters-directory`,
        "继续完善目录",
        "继续完善分集目录",
        "primary",
      ),
    ];
  }
  return [
    createArtifactAction(
      `${project.id}-characters-directory`,
      "确认角色，生成目录",
      "生成分集目录",
      "primary",
    ),
  ];
}

function buildDirectoryActions(project: DramaProject): ConversationArtifactAction[] {
  if (!project.directory.length) return [];
  return [
    createArtifactAction(
      `${project.id}-directory-enter-outlines`,
      "进入单集细纲",
      "script:step-enter-outlines",
      "primary",
    ),
  ];
  return [
    createArtifactAction(
      `${project.id}-directory-outlines-all`,
      "生成全部细纲",
      "script:outline-generate-all",
      "primary",
    ),
    createArtifactAction(
      `${project.id}-directory-outlines-regenerate`,
      "重新生成细纲",
      "script:outline-regenerate-all",
    ),
  ];
}

function buildOutlineActions(project: DramaProject): ConversationArtifactAction[] {
  const hasMissingOutlines = project.directory.some((entry) => !entry.outline?.trim());
  if (hasMissingOutlines) {
    const nextBatchLabel = buildNextOutlineBatchLabel(project) ?? "生成下一批次细纲";
    const nextBatchValue = buildNextOutlineBatchActionValue(project) ?? "script:outline-generate-all";
    return [
      createArtifactAction(
        `${project.id}-outlines-generate-all`,
        nextBatchLabel,
        nextBatchValue,
        "primary",
      ),
      createArtifactAction(
        `${project.id}-outlines-regenerate`,
        "重新生成全部细纲",
        "script:outline-regenerate-all",
      ),
    ];
  }
  return [
    createArtifactAction(
      `${project.id}-outlines-enter-episodes`,
      "进入分集撰写",
      "script:step-enter-episodes",
      "primary",
    ),
  ];

  const nextEpisodeNumber = findNextEpisodeNumber(project);
  const actions: ConversationArtifactAction[] = [];
  if (nextEpisodeNumber) {
    actions.push(
      createArtifactAction(
        `${project.id}-outlines-episode`,
        `继续生成第 ${nextEpisodeNumber} 集正文`,
        `继续生成第 ${nextEpisodeNumber} 集正文`,
        "primary",
      ),
    );
  }
  if (project.directory.some((entry) => !entry.outline?.trim())) {
    actions.push(
      createArtifactAction(
        `${project.id}-outlines-retry`,
        "继续补齐缺失细纲",
        "生成单集细纲",
      ),
    );
  }
  return actions;
}

function buildEpisodeActions(project: DramaProject): ConversationArtifactAction[] {
  const totalEpisodes = project.setup?.totalEpisodes || project.directory.length || project.episodes.length;
  const hasPendingEpisodes = project.episodes.length < totalEpisodes;
  const actions: ConversationArtifactAction[] = [];
  const batchEpisodeLabel = project.episodes.some((episode) => episode.content?.trim())
    ? "自动批量补齐"
    : "自动批量续写";

  if (hasPendingEpisodes) {
    actions.push(
      createArtifactAction(
        `${project.id}-episode-batch-generate`,
        batchEpisodeLabel,
        "script:episode-generate-batch",
        "primary",
      ),
    );
  }

  if (project.episodes.length > 0) {
    actions.push(...buildEpisodeReviewActions(project));
  }

  return actions;
}

function buildEpisodeReviewActions(project: DramaProject): ConversationArtifactAction[] {
  const actions: ConversationArtifactAction[] = [
    createArtifactAction(
      `${project.id}-episode-review-refresh`,
      "批量质量审查",
      "script:episode-review",
      "primary",
    ),
    createArtifactAction(
      `${project.id}-episode-review-compliance`,
      "准备合规审查",
      "script:step-enter-compliance",
    ),
    createArtifactAction(
      `${project.id}-episode-review-skip-compliance`,
      "跳过合规进入导出",
      "script:skip-compliance-review",
    ),
  ];
  return actions;
}

function buildComplianceActions(project: DramaProject): ConversationArtifactAction[] {
  const workspace = normalizeComplianceWorkspace(project.complianceWorkspace);
  const actions: ConversationArtifactAction[] = [
    createArtifactAction(
      `${project.id}-compliance-text`,
      "重新文字审核",
      "script:compliance-mode:text",
      project.complianceReviewMode === "text" ? "primary" : "secondary",
    ),
    createArtifactAction(
      `${project.id}-compliance-script`,
      "重新情节审核",
      "script:compliance-mode:script",
      project.complianceReviewMode === "script" ? "primary" : "secondary",
    ),
    createArtifactAction(
      `${project.id}-compliance-auto-adjust`,
      "批量自动改写",
      "script:compliance-auto-adjust",
    ),
    createArtifactAction(
      `${project.id}-compliance-export-palette`,
      workspace.tableSnapshot ? "导出风险表格" : "导出调色盘对比",
      workspace.tableSnapshot ? "script:compliance-export:xlsx" : "script:compliance-export:docx",
    ),
  ];
  if ((project.complianceRevisionPackets ?? []).some((packet) => packet.status === "pending")) {
    actions.push(
      createArtifactAction(
        `${project.id}-compliance-high`,
        "先处理高风险项",
        "script:compliance-resolve-high",
      ),
    );
  }
  actions.push(
    createArtifactAction(
      `${project.id}-compliance-export`,
      project.exportDocument?.trim() ? "修改导出稿" : "导出整合文档",
      project.exportDocument?.trim() ? "script:export-refine" : "script:export-document",
    ),
    createArtifactAction(
      `${project.id}-compliance-skip`,
      "跳过并进入导出",
      "script:skip-compliance-review",
    ),
  );
  return actions;
}

function buildExportActions(project: DramaProject): ConversationArtifactAction[] {
  const complianceStatus = resolveComplianceStatus(project);
  return [
    ...(complianceStatus !== "reviewed"
      ? [
          createArtifactAction(
            `${project.id}-export-compliance`,
            complianceStatus === "skipped" ? "重新进入合规审查" : "进入完整版合规",
            "script:step-enter-compliance",
          ),
        ]
      : []),
    createArtifactAction(
      `${project.id}-export-ai`,
      project.exportDocument?.trim() ? "AI 重新整合导出" : "AI 整合导出",
      "script:export-document",
      "primary",
    ),
    createArtifactAction(
      `${project.id}-export-refine`,
      "修改导出稿",
      "script:export-refine",
    ),
    createArtifactAction(
      `${project.id}-export-patch`,
      "检查补写缺口",
      "script:export-patch",
    ),
    createArtifactAction(
      `${project.id}-export-video`,
      "接入视频工作流",
      "script:export-video",
    ),
  ];
}

function getSnapshotUpdatedAt(snapshot: ConversationProjectSnapshot): string {
  const timestamps = snapshot.artifacts
    .map((artifact) => artifact.updatedAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  return timestamps[0] ?? snapshot.updatedAt ?? "";
}

function deriveDramaStage(project: DramaProject): string {
  if (project.currentStep === "outlines") {
    return "单集细纲";
  }
  if (project.currentStep === "episodes") {
    return "分集撰写";
  }
  switch (project.currentStep as DramaStep) {
    case "setup":
      return "立项设定";
    case "reference-script":
      return "参考拆解";
    case "creative-plan":
      return "创意方案";
    case "structure-transform":
      return "结构转译";
    case "characters":
      return "角色开发";
    case "character-transform":
      return "角色转译";
    case "directory":
      return "分集目录";
    case "outlines":
      return "生成单集细纲";
    case "episodes":
      return "剧本撰写";
    case "compliance":
      return "合规审查";
    case "export":
      return "导出与出片";
    default:
      return "立项设定";
  }
}

function deriveDramaObjective(project: DramaProject): string {
  if (project.currentStep === "directory") {
    return project.directory.length > 0
      ? "分集目录已生成，先进入单集细纲并创建 0% 预览。"
      : "生成分集目录，安排节奏、钩子和高潮。";
  }
  if (project.currentStep === "outlines") {
    return project.directory.length > 0 && project.directory.every((entry) => entry.outline?.trim())
      ? "单集细纲已生成完成，下一步进入分集撰写。"
      : "先展示单集细纲 0% 预览，再按所选方式生成细纲。";
  }
  if (project.currentStep === "episodes") {
    return "先配置分集撰写方式，再按集数或顺序生成正文。";
  }
  switch (project.currentStep as DramaStep) {
    case "setup":
      return "补齐目标市场、受众、风格和核心题材。";
    case "reference-script":
      return "分析参考内容，提炼可复用的结构骨架。";
    case "creative-plan":
      return "收束创意方案，锁定主卖点与人物关系。";
    case "structure-transform":
      return "把参考结构转译成新的创作框架。";
    case "characters":
    case "character-transform":
      return "继续完善角色弧光、关系冲突与人物口吻。";
    case "directory":
      return project.directory.length > 0
        ? "分集目录已生成，选择细纲生成方式。"
        : "生成分集目录，安排节奏、钩子和高潮。";
    case "outlines":
      return project.directory.length > 0 && project.directory.every((entry) => entry.outline?.trim())
        ? "单集细纲已生成，准备进入分集撰写。"
        : "补全单集细纲，细化每集推进节点。";
    case "episodes":
      return "继续撰写分集正文，推进可导出的剧本稿。";
    case "compliance":
      return "完成合规审查，并修订潜在风险点。";
    case "export":
      return "整理导出文档，并衔接后续视频工作流。";
    default:
      return "继续推进当前剧本创作。";
  }
}

function listMissingDramaSetupFields(setup: DramaSetup | null): string[] {
  if (!setup) return ["目标市场", "受众", "风格", "结局", "总集数", "题材"];

  const missing: string[] = [];
  if (!setup.targetMarket.trim()) missing.push("目标市场");
  if (!setup.audience.trim()) missing.push("受众");
  if (!setup.tone.trim()) missing.push("风格");
  if (!setup.ending.trim()) missing.push("结局");
  if (!setup.totalEpisodes) missing.push("总集数");
  if (!setup.genres.length && !setup.customTopic.trim()) missing.push("题材");
  return missing;
}

function findNextOutlineEpisode(project: DramaProject): number | null {
  const nextEntry = project.directory
    .filter((entry) => !entry.outline?.trim())
    .sort((a, b) => a.number - b.number)[0];

  return nextEntry?.number ?? null;
}

function buildNextOutlineBatchLabel(project: DramaProject): string | null {
  const batches =
    project.outlineBatchStatuses?.length
      ? project.outlineBatchStatuses
      : buildOutlineBatchStatuses(project.directory);
  const nextBatch = findNextOutlineBatchStatus(batches);
  if (!nextBatch) return null;
  return buildOutlineBatchActionLabel(nextBatch);
}

function buildNextOutlineBatchActionValue(project: DramaProject): string | null {
  const batches =
    project.outlineBatchStatuses?.length
      ? project.outlineBatchStatuses
      : buildOutlineBatchStatuses(project.directory);
  const nextBatch = findNextOutlineBatchStatus(batches);
  if (!nextBatch) return null;
  return `script:outline-generate-batch:${nextBatch.startEp}:${nextBatch.endEp}`;
}

function findNextEpisodeNumber(project: DramaProject): number | null {
  const completed = new Set(project.episodes.map((episode) => episode.number));
  const nextDirectoryEntry = project.directory
    .filter((entry) => !completed.has(entry.number))
    .sort((a, b) => a.number - b.number)[0];

  if (nextDirectoryEntry) return nextDirectoryEntry.number;
  if (project.directory.length) return project.directory.length + 1;
  return project.episodes.length ? project.episodes.length + 1 : null;
}

function summarizeArtifactLabels(labels: string[], limit = 2): string {
  const visible = labels.filter(Boolean).slice(0, limit);
  if (!visible.length) return "";
  return visible.join("、");
}

function buildDramaRecommendations(project: DramaProject): string[] {
  const missingSetup = listMissingDramaSetupFields(project.setup);
  const nextOutlineEpisode = findNextOutlineEpisode(project);
  const nextEpisodeNumber = findNextEpisodeNumber(project);
  const pendingCompliancePackets = (project.complianceRevisionPackets ?? []).filter((p) => p.status === "pending");
  const completedEpisodeCount = project.episodes.length;
  const hasExport = Boolean(project.exportDocument?.trim());
  const totalEpisodes = project.setup?.totalEpisodes || project.directory.length || project.episodes.length;

  if (project.currentStep === "directory") {
    return project.directory.length > 0 ? ["进入单集细纲"] : ["生成分集目录"];
  }

  if (project.currentStep === "outlines") {
    if (!project.directory.length) return ["生成单集细纲"];
    if (project.directory.every((entry) => entry.outline?.trim())) {
      return ["进入分集撰写"];
    }
    return [
      buildNextOutlineBatchLabel(project) ?? "生成下一批次细纲",
      "重新生成全部细纲",
    ];
  }

  if (project.currentStep === "episodes" && completedEpisodeCount < totalEpisodes) {
    const batchEpisodeLabel = project.episodes.some((episode) => episode.content?.trim())
      ? "自动批量补齐"
      : "自动批量续写";
    return [
      typeof project.preferredEpisodeDurationSeconds === "number"
        ? `设定单集时长（当前 ${project.preferredEpisodeDurationSeconds} 秒）`
        : "设定单集时长",
      nextEpisodeNumber ? `选择生成集数（下一集建议第 ${nextEpisodeNumber} 集）` : "选择生成集数",
      batchEpisodeLabel,
    ];
  }

  switch (project.currentStep as DramaStep) {
    case "setup":
      return [
        missingSetup.length
          ? `补齐${missingSetup.slice(0, 2).join("和")}后继续`
          : "确认立项设定，直接生成创作方案",
      ];
    case "reference-script":
      return [
        project.referenceScript.trim() ? "继续分析参考内容，生成结构转译" : "先补充参考文本",
      ];
    case "creative-plan":
      return project.creativePlan.trim()
        ? ["修改创作冲突", "进入角色开发"]
        : ["生成创作方案"];
    case "structure-transform":
      return [
        project.structureTransform.trim() ? "结构转译完成，继续生成角色转译" : "生成结构转译",
      ];
    case "characters":
      return [
        hasHomepageReadyCharacters(project)
          ? project.directory.length
            ? "角色设定完成，继续完善分集目录"
            : "角色设定完成，生成分集目录"
          : "进入角色开发",
      ];
    case "character-transform":
      return [
        hasHomepageReadyCharacters(project)
          ? project.directory.length
            ? "角色转译完成，继续完善分集目录"
            : "角色转译完成，生成分集目录"
          : "进入角色开发",
      ];
    case "directory":
      return [
        project.directory.length > 0
          ? "生成全部细纲"
          : "生成分集目录",
        ...(project.directory.length > 0 ? ["重新生成细纲"] : []),
      ];
    case "outlines":
      return [
        project.directory.length > 0 && project.directory.some((entry) => !entry.outline?.trim())
          ? "生成全部细纲"
          : project.directory.some((e) => e.outline)
            ? nextEpisodeNumber
              ? `细纲已就绪，生成第 ${nextEpisodeNumber} 集正文`
              : "细纲已就绪，开始撰写分集正文"
            : nextOutlineEpisode
              ? `生成第 ${nextOutlineEpisode} 集细纲`
              : "生成单集细纲",
        ...(project.directory.length > 0 && project.directory.some((entry) => !entry.outline?.trim())
          ? ["重新生成细纲"]
          : []),
      ];
    case "episodes":
      return [
        nextEpisodeNumber ? `继续生成第 ${nextEpisodeNumber} 集` : "所有集数完成，运行合规审查",
        "批量质量审查",
        "准备合规审查",
      ];
    case "compliance":
      return [
        pendingCompliancePackets.length
          ? `处理 ${pendingCompliancePackets.length} 条合规修订后导出`
          : hasExport
            ? "修改导出稿"
            : "导出整合文档",
        project.complianceReviewMode === "script" ? "重新跑情节审核" : "重新跑文字审核",
        project.complianceReviewMode === "script" ? "重新跑文字审核" : "重新跑情节审核",
      ];
    case "export":
      return [
        hasExport ? "修改导出稿" : "导出整合文档",
        "接入视频工作流",
        "回头补写缺失章节或集数",
      ];
    default:
      return ["继续当前任务"];
  }
}

function deriveUnifiedDramaObjective(project: DramaProject): string {
  switch (project.currentStep as DramaStep) {
    case "setup":
      return "补齐立项信息后，通过首页面板进入下一步创作。";
    case "reference-script":
      return "分析参考文本，抽取可复用结构并回流到首页工作流。";
    case "creative-plan":
      return "确认创作方案后进入角色开发，并保持首页单链路推进。";
    case "structure-transform":
      return "完成结构转译后继续角色转化与目录搭建。";
    case "characters":
    case "character-transform":
      return "完善角色关系与人设弧光，再进入分集目录。";
    case "directory":
      return "目录完成后先生成 0% 细纲预览，再选择细纲推进方式。";
    case "outlines":
      return "优先用批量细纲路径推进，再补单集或回炉重生。";
    case "episodes":
      return "正文阶段优先展示批量、范围和单集写作路径，并可直接衔接质检与合规。";
    case "compliance":
      return project.complianceSkippedAt
        ? "本轮已跳过合规审查，可直接导出，也可随时返回完整版合规工作台。"
        : "在首页完成完整版合规审查、风险定位、改写与导出前确认。";
    case "export":
      return resolveComplianceStatus(project) === "skipped"
        ? "导出区会明确显示“已跳过合规审查”，并保留重新进入合规的入口。"
        : "整理导出文档，完成补写检查，并衔接视频桥接。";
    default:
      return "继续通过首页工作流面板推进当前剧本项目。";
  }
}

function buildUnifiedDramaRecommendations(project: DramaProject): string[] {
  const totalEpisodes = project.setup?.totalEpisodes || project.directory.length || project.episodes.length;
  const nextEpisodeNumber = findNextEpisodeNumber(project);
  const hasExport = Boolean(project.exportDocument?.trim());
  const complianceStatus = resolveComplianceStatus(project);
  const pendingCompliancePackets = (project.complianceRevisionPackets ?? []).filter((packet) => packet.status === "pending");

  switch (project.currentStep as DramaStep) {
    case "setup":
      return [project.mode === "adaptation" ? "进入参考剧本步骤" : "生成创作方案"];
    case "reference-script":
      return ["分析参考内容，生成结构转译"];
    case "creative-plan":
      return [project.creativePlan.trim() ? "进入角色开发" : "生成创作方案"];
    case "structure-transform":
      return [project.structureTransform.trim() ? "进入角色转化" : "生成结构转译"];
    case "characters":
      return [project.characters.trim() ? (project.directory.length ? "继续完善分集目录" : "生成分集目录") : "进入角色开发"];
    case "character-transform":
      return [project.directory.length ? "继续完善分集目录" : "生成分集目录"];
    case "directory":
      return [project.directory.length ? "进入单集细纲" : "生成分集目录"];
    case "outlines":
      return project.directory.every((entry) => entry.outline?.trim())
        ? ["进入分集撰写"]
        : [buildNextOutlineBatchLabel(project) ?? "生成下一批细纲", "重新生成全部细纲"];
    case "episodes":
      if (project.episodes.length < totalEpisodes) {
        const batchEpisodeLabel = project.episodes.some((episode) => episode.content?.trim())
          ? "自动批量补齐"
          : "自动批量续写";
        return [
          batchEpisodeLabel,
          nextEpisodeNumber ? `生成第 ${nextEpisodeNumber} 集正文` : "生成指定集正文",
          "进入合规审查",
          "跳过合规，直接进入导出",
        ];
      }
      return [
        "批量质量审查",
        "进入合规审查",
        "跳过合规，直接进入导出",
      ];
    case "compliance":
      return [
        pendingCompliancePackets.length
          ? `处理 ${pendingCompliancePackets.length} 条合规风险后导出`
          : hasExport
            ? "修改导出稿"
            : "导出整合文档",
        "重新运行完整版合规审查",
        "跳过合规，直接进入导出",
      ];
    case "export":
      return [
        hasExport ? "修改导出稿" : "导出整合文档",
        ...(complianceStatus !== "reviewed"
          ? [complianceStatus === "skipped" ? "重新进入合规审查" : "进入合规审查"]
          : []),
        "检查补写缺口",
        "用于视频创作",
      ];
    default:
      return ["继续当前任务"];
  }
}
export function listStoredDramaProjects(): DramaProject[] {
  return safeReadJson<DramaProject[]>(DRAMA_PROJECTS_KEY, [])
    .map(normalizeDramaProject)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function loadStoredDramaProjectById(id: string): DramaProject | null {
  return listStoredDramaProjects().find((project) => project.id === id) ?? null;
}

export function upsertStoredDramaProject(project: DramaProject): DramaProject {
  const projects = listStoredDramaProjects();
  const normalizedProject = normalizeDramaProject(project);
  const nextProject = {
    ...synchronizeDramaProductionState(
      normalizedProject,
      deriveDramaStyleLock(normalizedProject),
      deriveDramaWorldModel(normalizedProject),
    ),
    updatedAt: new Date().toISOString(),
  };
  const index = projects.findIndex((item) => item.id === normalizedProject.id);

  if (index >= 0) {
    projects[index] = nextProject;
  } else {
    projects.unshift(nextProject);
  }

  safeWriteJson(DRAMA_PROJECTS_KEY, projects);
  void writeConversationArchiveProject(
    nextProject.id,
    nextProject.dramaTitle || nextProject.id,
    nextProject.mode === "adaptation" ? "adaptation" : "script",
    nextProject,
  );
  return nextProject;
}

export function updateStoredDramaProjectArtifactEditor(
  projectId: string,
  editor: ConversationArtifactEditor,
): { dramaProject: DramaProject; projectSnapshot: ConversationProjectSnapshot } | null {
  const project = loadStoredDramaProjectById(projectId);
  if (!project) return null;

  const normalizedText = editor.text.replace(/\r/g, "").trim();
  let nextProject: DramaProject = project;

  switch (editor.field) {
    case "creativePlan":
      nextProject = { ...project, creativePlan: normalizedText };
      break;
    case "structureTransform":
      nextProject = { ...project, structureTransform: normalizedText };
      break;
    case "characters":
      nextProject = { ...project, characters: normalizedText };
      break;
    case "characterTransform":
      nextProject = { ...project, characterTransform: normalizedText };
      break;
    case "directoryRaw": {
      const parsedDirectory = parseDirectoryEditorText(normalizedText);
      if (normalizedText && parsedDirectory.length === 0) {
        throw new Error("未识别到可保存的分集目录格式，请保持“第X集 - 标题 - 简介”结构。");
      }
      nextProject = {
        ...project,
        directoryRaw: normalizedText,
        directory: parsedDirectory,
      };
      break;
    }
    case "outlines": {
      const outlineMap = parseOutlineEditorText(normalizedText);
      if (normalizedText && outlineMap.size === 0) {
        throw new Error("未识别到可保存的细纲格式，请使用“【第X集细纲】”分段。");
      }

      const matchedEntries = project.directory.filter((entry) => outlineMap.has(entry.number));
      if (normalizedText && matchedEntries.length === 0) {
        throw new Error("细纲集数未匹配到当前项目目录，请先确认分集编号。");
      }

      nextProject = {
        ...project,
        directory: project.directory.map((entry) => {
          const nextOutline = outlineMap.get(entry.number);
          if (!nextOutline) return entry;
          return {
            ...entry,
            title: nextOutline.title || entry.title,
            outline: nextOutline.outline,
          };
        }),
      };
      break;
    }
  }

  const saved = upsertStoredDramaProject(nextProject);
  return {
    dramaProject: saved,
    projectSnapshot: createDramaSnapshot(saved),
  };
}

export function updateStoredDramaProjectArtifactPreferences(
  projectId: string,
  patch: Partial<DramaProjectArtifactPreferences>,
): { dramaProject: DramaProject; projectSnapshot: ConversationProjectSnapshot } | null {
  const project = loadStoredDramaProjectById(projectId);
  if (!project) return null;

  const saved = upsertStoredDramaProject({
    ...project,
    artifactPreferences: {
      ...normalizeDramaArtifactPreferences(project.artifactPreferences),
      ...patch,
    },
  });

  return {
    dramaProject: saved,
    projectSnapshot: createDramaSnapshot(saved),
  };
}

export function deleteStoredDramaProject(projectId: string): boolean {
  const projects = listStoredDramaProjects();
  const next = projects.filter((item) => item.id !== projectId);
  if (next.length === projects.length) return false;
  safeWriteJson(DRAMA_PROJECTS_KEY, next);
  return true;
}

export function readSkillDrafts(): SkillDraft[] {
  return safeReadJson<SkillDraft[]>(SKILL_DRAFTS_KEY, []).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function writeSkillDrafts(drafts: SkillDraft[]): void {
  safeWriteJson(SKILL_DRAFTS_KEY, drafts);
}

export function readMaintenanceReports(): MaintenanceReport[] {
  return safeReadJson<MaintenanceReport[]>(MAINTENANCE_REPORTS_KEY, []).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function writeMaintenanceReports(reports: MaintenanceReport[]): void {
  safeWriteJson(MAINTENANCE_REPORTS_KEY, reports);
}

export function createDramaSnapshot(project: DramaProject): ConversationProjectSnapshot {
  const normalizedProject = normalizeDramaProject(project);
  const syncedProject = synchronizeDramaProductionState(
    normalizedProject,
    normalizedProject.styleLock ?? deriveDramaStyleLock(normalizedProject),
    normalizedProject.worldModel ?? deriveDramaWorldModel(normalizedProject),
  );
  const projectKind = syncedProject.mode === "adaptation" ? "adaptation" : "script";
  const updatedAt = syncedProject.updatedAt || new Date().toISOString();
  const artifacts: ConversationArtifact[] = [];
  const setupSummary = buildDramaSetupSummary(syncedProject.setup);
  const outlinePreview = buildOutlinePreview(syncedProject);
  const outlineEditableText = buildOutlineEditableText(syncedProject);
  const styleLock = syncedProject.styleLock ?? null;
  const worldModel = syncedProject.worldModel ?? null;
  const setupPayload = buildSetupPayload(syncedProject);
  const charactersPayload = buildCharactersPayload(syncedProject);
  const directoryPayload = buildDirectoryPayload(syncedProject);
  const outlinePayload = buildOutlinePayload(syncedProject);
  const episodeBatchPayload = buildEpisodeBatchPayload(syncedProject);
  const episodeReviewPayload = buildEpisodeReviewPayload(syncedProject);
  const compliancePayload = buildCompliancePayload(syncedProject);
  const exportPayload = buildExportPayload(syncedProject);

  if (setupSummary) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-setup`,
        "setup",
        "项目设定",
        setupSummary,
        updatedAt,
        {
          presentation: "script-rich",
          payload: setupPayload,
          actions: buildSetupPanelActions(syncedProject),
        },
      ),
    );
  }

  if (syncedProject.referenceScript.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-reference`,
        "reference",
        "参考文本",
        syncedProject.referenceScript,
        updatedAt,
      ),
    );
  }

  if (syncedProject.referenceStructure.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-reference-structure`,
        "reference",
        "参考结构分析",
        syncedProject.referenceStructure,
        updatedAt,
      ),
    );
  }

  if (styleLock) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-style-lock`,
        "style-lock",
        "风格锁定",
        [
          `题材：${styleLock.genre.join("、")}`,
          `调性：${styleLock.tone}`,
          `视觉：${styleLock.visualStyle}`,
          `镜头：${styleLock.cinematography}`,
          `禁止项：${styleLock.forbidden.join("；")}`,
        ].join("\n"),
        updatedAt,
      ),
    );
  }

  if (worldModel) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-world-model`,
        "world-model",
        "世界模型",
        [
          worldModel.synopsis,
          `核心角色节点：${worldModel.characters.length}`,
          `剧情节点：${worldModel.scenes.length}`,
          `连续性规则：${worldModel.continuityRules.join("；")}`,
        ].join("\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.creativePlan.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-plan`,
        "plan",
        "创意方案",
        syncedProject.creativePlan,
        updatedAt,
        {
          editor: {
            field:
              syncedProject.mode === "adaptation" && syncedProject.structureTransform?.trim()
                ? "structureTransform"
                : "creativePlan",
            text: syncedProject.creativePlan,
          },
        },
      ),
    );
  }

  if (
    syncedProject.structureTransform.trim() &&
    syncedProject.structureTransform.trim() !== syncedProject.creativePlan.trim()
  ) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-structure-transform`,
        "plan",
        "结构转译",
        syncedProject.structureTransform,
        updatedAt,
        {
          editor: {
            field: "structureTransform",
            text: syncedProject.structureTransform,
          },
        },
      ),
    );
  }

  if (
    charactersPayload &&
    syncedProject.characters.trim() &&
    !(syncedProject.mode === "adaptation" && syncedProject.characterTransform.trim())
  ) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-characters`,
        "characters",
        "角色设定",
        syncedProject.characters,
        updatedAt,
        {
          presentation: "script-rich",
          payload: charactersPayload,
          actions: buildCharactersPanelActions(syncedProject),
          editor: {
            field:
              syncedProject.mode === "adaptation" && syncedProject.characterTransform?.trim()
                ? "characterTransform"
                : "characters",
            text: syncedProject.characters,
          },
        },
      ),
    );
  }

  if (syncedProject.characterTransform.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-character-transform`,
        "characters",
        "角色转译",
        syncedProject.characterTransform,
        updatedAt,
        charactersPayload
          ? {
              presentation: "script-rich",
              payload: charactersPayload,
              actions: buildCharacterTransformPanelActions(syncedProject),
              editor: {
                field: "characterTransform",
                text: syncedProject.characterTransform,
              },
            }
          : {
              actions: buildCharacterTransformPanelActions(syncedProject),
              editor: {
                field: "characterTransform",
                text: syncedProject.characterTransform,
              },
            },
      ),
    );
  }

  if (syncedProject.directoryRaw.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-directory`,
        "directory",
        "分集目录",
        syncedProject.directoryRaw,
        updatedAt,
        {
          presentation: "script-rich",
          payload: directoryPayload,
          actions: buildDirectoryPanelActions(syncedProject),
          editor: {
            field: "directoryRaw",
            text: syncedProject.directoryRaw,
          },
        },
      ),
    );
  }

  if (syncedProject.characterStateCards?.length) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-character-cards`,
        "character-card",
        `角色状态卡 ${syncedProject.characterStateCards.length} 张`,
        syncedProject.characterStateCards
          .slice(0, 6)
          .map(
            (card) =>
              `${card.name} · ${card.role}\n冲突：${card.coreConflict}\n目标：${card.desire}\n关注：${card.stageFocus}`,
          )
          .join("\n\n---\n\n"),
        updatedAt,
      ),
    );
  }

  if (outlinePreview || outlinePayload?.type === "outlines+batchProgress") {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-outline-preview`,
        "outline",
        "细纲预览",
        outlinePreview || "细纲批次尚未完成，继续按批次推进。",
        updatedAt,
        {
          presentation: "script-rich",
          payload: outlinePayload,
          actions: buildOutlinePanelActions(syncedProject),
          editor: {
            field: "outlines",
            text: outlineEditableText,
          },
        },
      ),
    );
  }

  if (episodeBatchPayload?.type === "episodes+batchProgress" && syncedProject.currentStep !== "compliance") {
    const episodePreviewText = episodeBatchPayload.entries
      .slice(0, 3)
      .map((entry) =>
        `第 ${entry.number} 集 · ${entry.title}\n${
          entry.content || entry.outline || entry.summary || "尚未开始生成"
        }`,
      )
      .join("\n\n---\n\n");

    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-episode-preview`,
        "episode",
        "分集撰写",
        episodePreviewText || "分集撰写预览已创建，当前还未开始生成。",
        updatedAt,
        {
          presentation: "script-rich",
          payload: episodeBatchPayload,
          actions: buildEpisodesPanelActions(syncedProject),
        },
      ),
    );
  }

  if (syncedProject.storyBeatPackets?.length) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-beat-packets`,
        "beat-packet",
        `剧情 beat 包 ${syncedProject.storyBeatPackets.length} 条`,
        syncedProject.storyBeatPackets
          .slice(0, 8)
          .map(
            (packet) =>
              `第 ${packet.episodeNumber} 集 · ${packet.title}\n${packet.beatSummary}\n状态：${packet.status}`,
          )
          .join("\n\n---\n\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.episodes.length > 0) {
    const episodeText = syncedProject.episodes
      .slice(0, 3)
      .map((episode) => `第 ${episode.number} 集 · ${episode.title}\n${episode.content}`)
      .join("\n\n---\n\n");

    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-episodes`,
        "episode",
        `已完成 ${syncedProject.episodes.length} 集正文`,
        episodeText,
        updatedAt,
        {
          actions: buildEpisodesPanelActions(syncedProject),
        },
      ),
    );
  }

  if (syncedProject.episodeQualityReviewPackets?.length) {
    const reviewPackets =
      episodeReviewPayload?.type === "episodeReview"
        ? episodeReviewPayload.packets
        : syncedProject.episodeQualityReviewPackets;
    const reviewSummary = reviewPackets
      .slice(0, 5)
      .map(
        (packet) =>
          `第 ${packet.episodeNumber} 集 · ${packet.title}\n总分：${packet.result.total} / 50 · ${packet.result.grade}`,
      )
      .join("\n\n---\n\n");
    const batchLabel =
      episodeReviewPayload?.type === "episodeReview" && episodeReviewPayload.batch?.episodeNumbers.length
        ? `本轮质检 ${episodeReviewPayload.summary.reviewedCount} 集（${formatEpisodeRangeLabel(episodeReviewPayload.batch.episodeNumbers)}）`
        : `批量质量审查 ${reviewPackets.length} 集`;
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-episode-review`,
        "episode-review",
        batchLabel,
        reviewSummary,
        updatedAt,
        {
          presentation: "script-rich",
          payload: episodeReviewPayload,
          actions: buildEpisodesPanelActions(syncedProject),
        },
      ),
    );
  }

  if (compliancePayload) {
    const complianceContent =
      syncedProject.complianceReport.trim() ||
      compliancePayload.workspace.paletteText.trim() ||
      compliancePayload.workspace.sourceText.trim() ||
      (compliancePayload.skippedAt ? "本轮已跳过合规审查。" : "完整版合规工作台已就绪。");
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-compliance-workspace`,
        "compliance",
        "合规工作台",
        complianceContent,
        updatedAt,
        {
          presentation: "script-rich",
          payload: compliancePayload,
          actions: buildCompliancePanelActions(syncedProject),
        },
      ),
    );
  }

  if (syncedProject.complianceReport.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-compliance`,
        "compliance",
        "合规审查",
        syncedProject.complianceReport,
        updatedAt,
        {
          presentation: "script-rich",
          payload: compliancePayload,
          actions: buildCompliancePanelActions(syncedProject),
        },
      ),
    );
  }

  if (syncedProject.complianceRevisionPackets?.length) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-compliance-revisions`,
        "compliance-revision",
        `合规修订包 ${syncedProject.complianceRevisionPackets.length} 条`,
        syncedProject.complianceRevisionPackets
          .slice(0, 8)
          .map(
            (packet) =>
              `${packet.issueTitle}\n风险：${packet.riskLevel}\n建议：${packet.recommendation}`,
          )
          .join("\n\n---\n\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.exportDocument?.trim() || syncedProject.currentStep === "export") {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-export`,
        "export",
        "导出文档",
        syncedProject.exportDocument || exportPayload?.quickExportMarkdown || "",
        updatedAt,
        {
          presentation: "script-rich",
          payload: exportPayload,
          actions: buildExportPanelActions(syncedProject),
        },
      ),
    );
  }

  const title =
    syncedProject.dramaTitle ||
    (syncedProject.mode === "adaptation" ? "未命名改编项目" : "未命名剧本项目");
  const stage = deriveDramaStage(syncedProject);
  const artifactLabels = summarizeArtifactLabels(artifacts.map((artifact) => artifact.label));
  const baseRecommendedActions = buildUnifiedDramaRecommendations(syncedProject);
  const homepageReadyCharacters = hasHomepageReadyCharacters(syncedProject);
  const hasCharacterSource = Boolean((syncedProject.characterTransform || syncedProject.characters || "").trim());
  const recommendedActions =
    (syncedProject.currentStep === "characters" || syncedProject.currentStep === "character-transform") &&
    hasCharacterSource &&
    !homepageReadyCharacters
      ? ["进入角色开发"]
      : baseRecommendedActions;
  const currentObjective =
    (syncedProject.currentStep === "characters" || syncedProject.currentStep === "character-transform") &&
    hasCharacterSource &&
    !homepageReadyCharacters
      ? "继续完善角色关系图，确认简单版和详细版都已生成且可切换后，再放出到首页并进入分集目录。"
      : deriveUnifiedDramaObjective(syncedProject);
  const nextAction = recommendedActions[0];

  return {
    projectId: syncedProject.id,
    projectKind,
    title,
    currentObjective,
    derivedStage: stage,
    agentSummary:
      artifacts.length > 0
        ? `项目当前位于“${stage}”，已整理出 ${artifacts.length} 份关键产物${artifactLabels ? `，包括${artifactLabels}` : ""}。${syncedProject.characterStateCards?.length ? `当前有 ${syncedProject.characterStateCards.length} 张角色状态卡。` : ""}${syncedProject.storyBeatPackets?.length ? `已锁定 ${syncedProject.storyBeatPackets.length} 条剧情 beat。` : ""}${syncedProject.episodeQualityReviewPackets?.length ? `批量质检结果覆盖 ${syncedProject.episodeQualityReviewPackets.length} 集。` : ""}${syncedProject.complianceRevisionPackets?.length ? `合规修订包 ${syncedProject.complianceRevisionPackets.length} 条。` : ""}建议下一步先${nextAction}。`
        : `项目当前位于“${stage}”，但还缺少第一份可复用产物。建议先${nextAction}。`,
    recommendedActions,
    artifacts,
    updatedAt,
    memory: {
      styleLock,
      worldModel,
      assetManifest: null,
      shotPackets: [],
      characterStateCards: syncedProject.characterStateCards || [],
      storyBeatPackets: syncedProject.storyBeatPackets || [],
      complianceRevisionPackets: syncedProject.complianceRevisionPackets || [],
      episodeQualityReviewPackets: syncedProject.episodeQualityReviewPackets || [],
    },
  };
}

function deriveVideoStage(project: PersistedVideoProject): string {
  if (!hasPassedVideoScriptBreakdown(project)) {
    return "脚本拆解";
  }
  const hasReviewableOutputs = project.scenes.some(
    (scene) => !!scene.videoUrl || scene.videoStatus === "failed",
  );
  const hasRunningTasks = project.scenes.some(
    (scene) => !!scene.videoTaskId && ["queued", "processing"].includes(String(scene.videoStatus || "").toLowerCase()),
  );
  if (
    hasReviewableOutputs &&
    project.scenes.some((scene) => scene.videoStatus === "failed")
  ) {
    return "审阅与修复";
  }
  if (hasRunningTasks) return "生成中";
  if (project.videoPromptBatch?.trim()) {
    return "视频提示词";
  }
  if (project.shotPackets?.length) {
    return "镜头指令包";
  }
  if (project.storyboardPlan?.trim()) {
    return "分镜批次";
  }
  if (project.characters.length || project.sceneSettings.length) {
    return "角色与场景";
  }
  return "脚本拆解";
}

function buildVideoRecommendations(project: PersistedVideoProject): string[] {
  const stage = deriveVideoStage(project);
  const breakdownPassed = hasPassedVideoScriptBreakdown(project);
  const generatedVideoCount = project.scenes.filter((scene) => scene.videoUrl).length;
  const failedVideoCount = project.scenes.filter((scene) => scene.videoStatus === "failed").length;
  const storyboardedSceneCount = project.scenes.filter((scene) => scene.storyboardUrl).length;
  const shotPacketCount = project.shotPackets?.length ?? 0;
  const runningTasks = project.scenes.filter(
    (scene) => !!scene.videoTaskId && ["queued", "processing"].includes(String(scene.videoStatus || "").toLowerCase()),
  ).length;
  const bundleFollowups = project.productionStateBundle
    ? ["预览生产状态摘要", "打开生产状态目录"]
    : [];

  switch (stage) {
    case "脚本拆解":
      return [
        project.script?.trim()
          ? breakdownPassed
            ? "梳理脚本拆解结果"
            : "完成剧本拆解并通过内部检查"
          : "导入脚本开始拆解",
        project.targetPlatform?.trim() ? "补充镜头风格偏好" : "先补充目标平台",
        breakdownPassed ? "继续提取角色与场景" : "先完成第一轮镜头拆解",
      ];
    case "角色与场景":
      return [
        project.characters.length || project.sceneSettings.length ? "完善角色和场景资产" : "先生成角色和场景资产",
        storyboardedSceneCount ? "继续整理分镜批次" : "开始整理分镜批次",
        "补充额外镜头要求",
      ];
    case "分镜批次":
      return [
        storyboardedSceneCount ? `继续补齐剩余分镜批次` : "继续生成分镜批次",
        shotPacketCount ? "更新镜头指令包" : "编译镜头指令包",
        "整理镜头说明",
      ];
    case "镜头指令包":
      return [
        shotPacketCount ? `复核 ${shotPacketCount} 个镜头指令包` : "编译镜头指令包",
        project.videoPromptBatch?.trim() ? "微调视频提示词" : "视频提示词生成方式",
        ...bundleFollowups,
        "导出生产状态包",
      ];
    case "视频提示词":
      return [
        failedVideoCount ? `补发 ${failedVideoCount} 条失败镜头` : "开始第一轮出片",
        project.videoPromptBatch?.trim() ? "继续微调视频提示词" : "回到对话里补充出片要求",
        ...bundleFollowups,
        "导出生产状态包",
      ];
    case "生成中":
      return [
        failedVideoCount ? `补发 ${failedVideoCount} 条失败镜头` : "轮询当前出片结果",
        runningTasks ? `等待剩余 ${runningTasks} 条镜头完成` : "继续等待当前批次",
        ...bundleFollowups,
        "导出生产状态包",
      ];
    case "审阅与修复":
      return [
        failedVideoCount ? `补发 ${failedVideoCount} 条失败镜头` : "整理当前出片结论",
        "对需要重做的镜头发起修复",
        ...bundleFollowups,
        "导出生产状态包",
      ];
    default:
      return [
        generatedVideoCount ? "预览并继续出片" : "检查导出前缺失的镜头",
        "导出当前视频资产",
        "回到对话里继续微调",
      ];
  }
}

export function createVideoSnapshotLite(project: PersistedVideoProject): ConversationProjectSnapshot {
  const updatedAt = project.updatedAt || new Date().toISOString();
  const stage = deriveVisibleVideoStage(project);
  const recommendedActions = buildVisibleVideoRecommendations(project);
  const nextAction = recommendedActions[0] || "继续推进当前项目";
  const breakdownPassed = hasPassedVideoScriptBreakdown(project);
  const generatedVideoCount = project.scenes.filter((scene) => Boolean(scene.videoUrl)).length;
  const failedVideoCount = countFailedVideoScenes(project);
  const progressSummary = [
    breakdownPassed && project.scenes.length ? `${project.scenes.length} 个镜头` : null,
    project.characters.length ? `${project.characters.length} 个角色` : null,
    project.sceneSettings.length ? `${project.sceneSettings.length} 个场景` : null,
    generatedVideoCount ? `${generatedVideoCount} 条已生成视频` : null,
    failedVideoCount ? `${failedVideoCount} 条失败` : null,
    project.referenceStyleSummary?.trim()
      ? `参考图风格摘要：${project.referenceStyleSummary.trim()}`
      : null,
  ]
    .filter(Boolean)
    .join("，");

  return {
    projectId: project.id,
    projectKind: "video",
    sourceProjectId: project.sourceProjectId,
    title: project.title || "未命名视频项目",
    currentObjective: `先${nextAction}`,
    derivedStage: stage,
    agentSummary: progressSummary
      ? `视频项目当前位于“${stage}”，已整理 ${progressSummary}，建议下一步先${nextAction}。`
      : `视频项目当前位于“${stage}”，建议下一步先${nextAction}。`,
    recommendedActions,
    artifacts: [],
    updatedAt,
  };
}

function buildVideoSceneArtifactText(scenes: PersistedVideoProject["scenes"]): string {
  return (scenes || [])
    .map((scene) => {
      const detailLines = [
        scene.description?.trim() || "",
        scene.dialogue?.trim() ? `对白：${scene.dialogue.trim()}` : "",
        scene.characters?.length ? `角色：${scene.characters.join("、")}` : "",
        scene.cameraDirection?.trim() ? `镜头：${scene.cameraDirection.trim()}` : "",
      ].filter(Boolean);

      return [
        `${scene.sceneNumber}. ${scene.sceneName}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""}`,
        detailLines.join("\n") || "等待补充镜头描述",
      ].join("\n");
    })
    .join("\n\n");
}

function resolveSegmentPromptSourceLabel(
  source: "model" | undefined,
): string {
  switch (source) {
    case "model":
      return "模型直出";
    default:
      return "未记录";
  }
}

function buildSegmentPromptArtifactText(project: PersistedVideoProject): string {
  const prompts = Object.values(project.segmentVideoPrompts ?? {})
    .filter((entry) => entry?.prompt?.trim())
    .sort((left, right) => String(left.segmentLabel).localeCompare(String(right.segmentLabel), "zh-CN"));
  if (!prompts.length) return "";

  const sceneById = new Map((project.scenes ?? []).map((scene) => [scene.id, scene] as const));
  const coveragePassed = prompts.filter((prompt) => prompt.debug?.shotCoverageComplete !== false).length;
  const header = [
    `已记录 ${prompts.length} 个片段的最终提示词。`,
    `镜头覆盖校验通过 ${coveragePassed} / ${prompts.length}。`,
    "提示词链路：仅保留模型直出 + 同一份规范化整理，不再使用本地回退模板。",
  ].join("\n");

  const sections = prompts.map((prompt) => {
    const sceneNumbers = prompt.sceneIds
      .map((sceneId) => sceneById.get(sceneId)?.sceneNumber)
      .filter((sceneNumber): sceneNumber is number => Number.isFinite(sceneNumber))
      .join("、");
    return [
      `### 片段 ${prompt.segmentLabel} 最终提示词`,
      `镜头：${sceneNumbers || "未记录"}`,
      `时长：${prompt.duration}s / 模型上限 ${prompt.maxDurationForModel}s`,
      `来源：${resolveSegmentPromptSourceLabel(prompt.debug?.source)}`,
      `镜头覆盖校验：${prompt.debug?.shotCoverageComplete === false ? "待关注" : "通过"}`,
      "",
      prompt.prompt.trim(),
    ].join("\n");
  });

  return [header, ...sections].join("\n\n====================\n\n");
}

export function createVideoSnapshot(project: PersistedVideoProject): ConversationProjectSnapshot {
  const syncedProject = synchronizeVideoProductionState(project);
  const updatedAt = syncedProject.updatedAt || new Date().toISOString();
  const breakdownPassed = hasPassedVideoScriptBreakdown(syncedProject);
  const sceneArtifactText = breakdownPassed ? buildVideoSceneArtifactText(syncedProject.scenes) : "";
  const characterArtifactText = (syncedProject.characters || [])
    .slice(0, 6)
    .map((character) => `${character.name}: ${character.description || "已创建角色设定"}`)
    .join("\n");
  const sceneSettingsText = (syncedProject.sceneSettings || [])
    .slice(0, 6)
    .map((sceneSetting) => `${sceneSetting.name}: ${sceneSetting.description || "已创建场景设定"}`)
    .join("\n");
  const characterArtifactDisplayText = (syncedProject.characters || [])
    .slice(0, 6)
    .map((character, index) => {
      const variantLines = (character.costumes || [])
        .map((variant) => variant.label.trim())
        .filter(Boolean)
        .map((label) => `   - ${label}`);
      return [
        `${index + 1}. ${character.name}`,
        ...(variantLines.length ? ["   角色变体：", ...variantLines] : []),
      ].join("\n");
    })
    .join("\n");
  const sceneSettingsDisplayText = (syncedProject.sceneSettings || [])
    .slice(0, 6)
    .map((sceneSetting, index) => {
      const variantLines = (sceneSetting.timeVariants || [])
        .map((variant) => variant.label.trim())
        .filter(Boolean)
        .map((label) => `   - ${label}`);
      return [
        `${index + 1}. ${sceneSetting.name}`,
        ...(variantLines.length ? ["   场景变体：", ...variantLines] : []),
      ].join("\n");
    })
    .join("\n");
  const videoBriefText = [
    syncedProject.targetPlatform?.trim() ? `目标平台：${syncedProject.targetPlatform.trim()}` : null,
    syncedProject.shotStyle?.trim() ? `镜头风格：${syncedProject.shotStyle.trim()}` : null,
    syncedProject.outputGoal?.trim() ? `出片目标：${syncedProject.outputGoal.trim()}` : null,
    syncedProject.productionNotes?.trim() ? `补充说明：${syncedProject.productionNotes.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const artifacts: ConversationArtifact[] = [];

  if (videoBriefText.trim()) {
    artifacts.push(
      buildArtifact(
        `${project.id}-video-brief`,
        "video-brief",
        "视频简报",
        videoBriefText,
        updatedAt,
      ),
    );
  }

  if (syncedProject.analysisSummary?.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-analysis`,
        "video-brief",
        "桥接分析",
        syncedProject.analysisSummary,
        updatedAt,
      ),
    );
  }

  if (syncedProject.script?.trim()) {
    artifacts.push(
      buildArtifact(`${syncedProject.id}-script`, "plan", "视频脚本", syncedProject.script, updatedAt),
    );
  }

  if (sceneArtifactText.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-scenes`,
        "video-brief",
        `已拆解 ${syncedProject.scenes.length} 个镜头`,
        sceneArtifactText,
        updatedAt,
      ),
    );
  }

  if (characterArtifactDisplayText.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-characters`,
        "characters",
        `已整理 ${syncedProject.characters.length} 个角色`,
        characterArtifactDisplayText,
        updatedAt,
      ),
    );
  }

  if (sceneSettingsDisplayText.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-scene-settings`,
        "scene-settings",
        `已整理 ${syncedProject.sceneSettings.length} 个场景`,
        sceneSettingsDisplayText,
        updatedAt,
      ),
    );
  }

  if (syncedProject.styleLock) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-style-lock`,
        "style-lock",
        "风格锁定",
        [
          `题材：${syncedProject.styleLock.genre.join("、")}`,
          `调性：${syncedProject.styleLock.tone}`,
          `视觉：${syncedProject.styleLock.visualStyle}`,
          `镜头：${syncedProject.styleLock.cinematography}`,
          `禁止项：${syncedProject.styleLock.forbidden.join("；")}`,
        ].join("\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.worldModel) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-world-model`,
        "world-model",
        "世界模型",
        [
          syncedProject.worldModel.synopsis,
          `角色数：${syncedProject.worldModel.characters.length}`,
          `场景数：${syncedProject.worldModel.scenes.length}`,
          `连续性规则：${syncedProject.worldModel.continuityRules.join("；")}`,
        ].join("\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.assetManifest?.items.length) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-asset-manifest`,
        "asset-manifest",
        "资产清单",
        syncedProject.assetManifest.items
          .slice(0, 10)
          .map((item) => `${item.label} · ${item.meta} · ${item.reusable ? "可复用" : "当前镜头"}`)
          .join("\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.storyboardPlan?.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-storyboard-plan`,
        "storyboard-plan",
        "分镜批次",
        syncedProject.storyboardPlan,
        updatedAt,
      ),
    );
  }

  if (syncedProject.videoPromptBatch?.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-video-prompt-batch`,
        "video-prompt-batch",
        "视频提示词批次",
        syncedProject.videoPromptBatch,
        updatedAt,
      ),
    );
  }

  const segmentPromptArtifactText = buildSegmentPromptArtifactText(syncedProject);
  if (segmentPromptArtifactText.trim()) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-segment-video-prompts`,
        "report",
        "片段最终提示词日志",
        segmentPromptArtifactText,
        updatedAt,
        {
          summary: `已记录 ${Object.keys(syncedProject.segmentVideoPrompts ?? {}).length} 个片段的最终提示词。`,
        },
      ),
    );
  }

  if (syncedProject.shotPackets?.length) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-shot-packets`,
        "shot-packet",
        `已编译 ${syncedProject.shotPackets.length} 个镜头指令包`,
        syncedProject.shotPackets
          .slice(0, 8)
          .map((packet) => `镜头 ${packet.sceneNumber} · ${packet.title}\n${packet.promptSeed}`)
          .join("\n\n---\n\n"),
        updatedAt,
      ),
    );
  }

  if (syncedProject.productionStateBundle?.directoryPath) {
    artifacts.push(
      buildArtifact(
        `${syncedProject.id}-production-state-bundle`,
        "report",
        "生产状态包",
        [
          `导出目录：${syncedProject.productionStateBundle.directoryPath}`,
          `索引文件：${syncedProject.productionStateBundle.overviewPath}`,
          `文件数：${syncedProject.productionStateBundle.exportedCount}`,
          `导出时间：${syncedProject.productionStateBundle.exportedAt}`,
        ].join("\n"),
        syncedProject.productionStateBundle.exportedAt || updatedAt,
      ),
    );
  }

  const stage = deriveVisibleVideoStage(syncedProject);
  const hasReviewableOutputs = hasReviewableVideoOutputs(syncedProject);
  const contextSummary = [
    syncedProject.targetPlatform?.trim() ? `目标平台是 ${syncedProject.targetPlatform.trim()}` : null,
    syncedProject.shotStyle?.trim() ? `镜头风格为 ${syncedProject.shotStyle.trim()}` : null,
    syncedProject.outputGoal?.trim() ? `出片目标是 ${syncedProject.outputGoal.trim()}` : null,
  ]
    .filter(Boolean)
    .join("，");
  const artifactLabels = summarizeArtifactLabels(artifacts.map((artifact) => artifact.label));
  const nextAction = buildVisibleVideoRecommendations(syncedProject)[0];
  const referenceAutomationSummary = summarizeReferenceAutomationState(syncedProject);
  const failedScenes = syncedProject.scenes.filter((scene) => scene.videoStatus === "failed");
  const failedSceneSummary = failedScenes
    .slice(0, 2)
    .map((scene) => `镜头 ${scene.sceneNumber}「${scene.sceneName}」${scene.videoFailure?.message ? `：${scene.videoFailure.message}` : "生成失败"}`)
    .join("；");

  const currentObjective =
    stage === "脚本拆解"
      ? "导入脚本并完成第一轮镜头拆解，建立后续五阶段视频生产的基础。"
      : stage === "角色与场景"
        ? hasExtractedVideoEntities(syncedProject)
          ? countMissingReferenceAssets(syncedProject) > 0
            ? "先补齐角色与场景基础参考图，再进入分镜图生成。"
            : "角色与场景已经齐备，可以开始整理分镜文本。"
          : "先从脚本中提取角色与场景，建立稳定的参考资产入口。"
        : stage === "分镜图生成"
          ? hasStoryboardText(syncedProject)
            ? "继续补齐分镜图并检查镜头连续性，准备进入视频生成。"
            : "先整理分镜文本，再逐镜生成分镜图。"
          : stage === "视频生成"
            ? countRunningVideoTasks(syncedProject) > 0
              ? "继续轮询当前出片任务，并在第 4 步内完成准备、提交和刷新。"
              : syncedProject.videoPromptBatch?.trim()
                ? "视频提示词批次已经就绪，可以继续提交新一轮出片任务。"
                : syncedProject.shotPackets?.length
                  ? "继续选择视频提示词生成方式，再开始提交视频生成。"
                  : "先编译镜头指令包，收口第 4 步内部准备链路。"
            : hasReviewableOutputs
                ? "继续预览、返工和导出当前视频结果，完成最后出片收口。"
                : "整理当前视频生产状态，准备预览和导出。";

  return {
    projectId: syncedProject.id,
    projectKind: "video",
    sourceProjectId: syncedProject.sourceProjectId,
    title: syncedProject.title || "未命名视频项目",
    currentObjective,
    derivedStage: stage,
    agentSummary:
      artifacts.length > 0
        ? `视频项目当前位于“${stage}”，已整理 ${breakdownPassed ? syncedProject.scenes.length : 0} 个镜头、${syncedProject.characters.length} 个角色和 ${syncedProject.sceneSettings.length} 个场景${artifactLabels ? `，当前可直接使用${artifactLabels}` : ""}。${syncedProject.assetManifest ? `已建立 ${syncedProject.assetManifest.items.length} 项资产清单。` : ""}${failedSceneSummary ? `当前失败项：${failedSceneSummary}。` : ""}${contextSummary ? `当前${contextSummary}。` : ""}${referenceAutomationSummary ? `${referenceAutomationSummary}。` : ""}建议下一步先${nextAction}。`
        : `视频项目当前位于“${stage}”，适合先${nextAction}。${failedSceneSummary ? `当前失败项：${failedSceneSummary}。` : ""}${contextSummary ? `当前${contextSummary}。` : ""}${referenceAutomationSummary ? `${referenceAutomationSummary}。` : ""}`,
    recommendedActions: buildVisibleVideoRecommendations(syncedProject),
    artifacts,
    updatedAt,
    memory: {
      styleLock: syncedProject.styleLock,
      referenceImageStyleSummary: syncedProject.referenceStyleSummary,
      worldModel: syncedProject.worldModel,
      assetManifest: syncedProject.assetManifest,
      automationState: syncedProject.automationState as VideoAutomationState | null,
      videoScenes: syncedProject.scenes.map((scene) => ({
        id: scene.id,
        sceneNumber: scene.sceneNumber,
        sceneName: scene.sceneName,
        segmentLabel: scene.segmentLabel,
        videoStatus: scene.videoStatus,
        videoTaskId: scene.videoTaskId,
        videoUrl: scene.videoUrl,
        videoFailureMessage: scene.videoFailure?.message,
      })),
      shotPackets: syncedProject.shotPackets || [],
      videoAuditPackets: syncedProject.videoAuditPackets || [],
      videoRepairTasks: syncedProject.videoRepairTasks || [],
      reviewQueue: syncedProject.reviewQueue || [],
    },
  };
}

function getVideoManifestItems(project: PersistedVideoProject) {
  return project.assetManifest?.items ?? [];
}

function hasExtractedVideoEntities(project: PersistedVideoProject): boolean {
  return project.characters.length > 0 && project.sceneSettings.length > 0;
}

function countMissingReferenceAssets(project: PersistedVideoProject): number {
  const items = getVideoManifestItems(project);
  const readyCharacterIds = new Set(
    items
      .filter((item) => item.kind === "character-reference" && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );
  const readySceneIds = new Set(
    items
      .filter((item) => item.kind === "scene-reference" && item.sourceEntityId)
      .map((item) => item.sourceEntityId!),
  );

  const missingCharacterRefs = project.characters.filter((character) => !readyCharacterIds.has(character.id)).length;
  const missingSceneRefs = project.sceneSettings.filter((scene) => !readySceneIds.has(scene.id)).length;
  return missingCharacterRefs + missingSceneRefs;
}

function summarizeReferenceAutomationState(project: PersistedVideoProject): string {
  const referenceTargets = Object.values(project.automationState?.referenceTargets || {});
  if (!referenceTargets.length) return "";
  const readyCount = referenceTargets.filter((target) => target.status === "ready").length;
  const pendingCount = referenceTargets.filter(
    (target) => target.status === "pending" || target.status === "retryable",
  ).length;
  const blockedCount = referenceTargets.filter((target) => target.status === "blocked").length;
  const exhaustedCount = referenceTargets.filter((target) => target.status === "exhausted").length;

  return [
    readyCount > 0 ? `已就绪 ${readyCount} 个参考资产目标` : "",
    pendingCount > 0 ? `${pendingCount} 个仍在自动补齐队列中` : "",
    blockedCount > 0 ? `${blockedCount} 个因依赖主参考图暂时阻塞` : "",
    exhaustedCount > 0 ? `${exhaustedCount} 个已转入 review 兜底` : "",
  ]
    .filter(Boolean)
    .join("，");
}

function hasMinimumReferenceAssets(project: PersistedVideoProject): boolean {
  if (!hasExtractedVideoEntities(project)) return false;

  const items = getVideoManifestItems(project);
  const readyCharacterCount = items.filter(
    (item) => item.kind === "character-reference" && item.sourceEntityId,
  ).length;
  const readySceneCount = items.filter(
    (item) => item.kind === "scene-reference" && item.sourceEntityId,
  ).length;

  const characterRequirementMet =
    project.characters.length === 0 || readyCharacterCount > 0;
  const sceneRequirementMet =
    project.sceneSettings.length === 0 || readySceneCount > 0;

  return characterRequirementMet && sceneRequirementMet;
}

function hasStoryboardText(project: PersistedVideoProject): boolean {
  return Boolean(project.storyboardPlan?.trim());
}

function countMissingStoryboardFrames(project: PersistedVideoProject): number {
  const readyStoryboardSceneIds = new Set(
    getVideoManifestItems(project)
      .filter((item) => item.kind === "storyboard-frame" && item.sceneId)
      .map((item) => item.sceneId!),
  );

  return project.scenes.filter((scene) => !readyStoryboardSceneIds.has(scene.id)).length;
}

function hasMinimumStoryboardFrames(project: PersistedVideoProject): boolean {
  return project.scenes.length > 0 && countMissingStoryboardFrames(project) === 0;
}

function countRunningVideoTasks(project: PersistedVideoProject): number {
  return project.scenes.filter(
    (scene) =>
      !!scene.videoTaskId &&
      ["queued", "processing"].includes(String(scene.videoStatus || "").toLowerCase()),
  ).length;
}

function countFailedVideoScenes(project: PersistedVideoProject): number {
  return project.scenes.filter((scene) => String(scene.videoStatus || "").toLowerCase() === "failed").length;
}

function listOrderedSegmentLabels(project: PersistedVideoProject): string[] {
  const labels: string[] = [];
  [...project.scenes]
    .sort((a, b) => a.sceneNumber - b.sceneNumber)
    .forEach((scene) => {
      const label = scene.segmentLabel?.trim();
      if (label && !labels.includes(label)) labels.push(label);
    });
  return labels;
}

function countFailedSegmentVideos(project: PersistedVideoProject): number {
  const statuses = project.segmentVideoStatuses ?? {};
  return listOrderedSegmentLabels(project).filter(
    (label) => String(statuses[label]?.status || "").toLowerCase() === "failed" && !project.segmentVideos?.[label],
  ).length;
}

function countRunningSegmentVideos(project: PersistedVideoProject): number {
  const statuses = project.segmentVideoStatuses ?? {};
  return listOrderedSegmentLabels(project).filter((label) => {
    const status = String(statuses[label]?.status || "").toLowerCase();
    return Boolean(statuses[label]?.taskId) && (status === "queued" || status === "processing");
  }).length;
}

function countGeneratableSegmentVideos(project: PersistedVideoProject): number {
  const statuses = project.segmentVideoStatuses ?? {};
  return listOrderedSegmentLabels(project).filter((label) => {
    if (!project.segmentVideoPrompts?.[label]?.prompt?.trim()) return false;
    if (project.segmentVideos?.[label]) return false;
    const status = String(statuses[label]?.status || "").toLowerCase();
    return status !== "queued" && status !== "processing";
  }).length;
}

function hasVideoBootstrapContext(project: PersistedVideoProject): boolean {
  return Boolean(
    project.targetPlatform?.trim() &&
      project.shotStyle?.trim() &&
      project.outputGoal?.trim(),
  );
}

function hasReviewableVideoOutputs(project: PersistedVideoProject): boolean {
  const hasSegmentOutputs =
    (project.videoGenerationPrefs?.mode ?? "image-to-video") === "text-to-video" &&
    [...new Set(
      project.scenes
        .map((scene) => scene.segmentLabel?.trim())
        .filter((label): label is string => Boolean(label)),
    )].some((label) => {
      const status = String(project.segmentVideoStatuses?.[label]?.status || "").toLowerCase();
      return Boolean(project.segmentVideos?.[label]?.trim()) || status === "failed";
    });
  return Boolean(
    project.productionStateBundle?.directoryPath ||
      project.scenes.some(
        (scene) => !!scene.videoUrl || String(scene.videoStatus || "").toLowerCase() === "failed",
      ) ||
      hasSegmentOutputs,
  );
}

function deriveVisibleVideoStage(project: PersistedVideoProject): string {
  if (project.currentStep >= 2 && project.currentStep <= 5) {
    const manualStageLabels: Record<number, string> = {
      2: "角色与场景",
      3: "分镜图生成",
      4: "视频生成",
      5: "预览与导出",
    };
    const manualStage = manualStageLabels[project.currentStep];
    if (manualStage && canSwitchToVideoWorkflowStep(project, project.currentStep).allowed) {
      return manualStage;
    }
  }

  if (hasReviewableVideoOutputs(project)) {
    return "\u9884\u89c8\u4e0e\u5bfc\u51fa";
  }

  if (project.videoPromptBatch?.trim()) {
    return "\u89c6\u9891\u751f\u6210";
  }

  switch (deriveNaturalVideoStep(project)) {
    case 5:
      return "\u9884\u89c8\u4e0e\u5bfc\u51fa";
    case 4:
      return "\u89c6\u9891\u751f\u6210";
    case 3:
      return "\u5206\u955c\u56fe\u751f\u6210";
    case 2:
      return "\u89d2\u8272\u4e0e\u573a\u666f";
    case 1:
    default:
      return "\u811a\u672c\u62c6\u89e3";
  }
}

function buildVisibleVideoRecommendations(project: PersistedVideoProject): string[] {
  const stage = deriveVisibleVideoStage(project);
  const breakdownPassed = hasPassedVideoScriptBreakdown(project);
  const generatedVideoCount = project.scenes.filter((scene) => scene.videoUrl).length;
  const failedVideoCount = countFailedVideoScenes(project);
  const storyboardedSceneCount = project.scenes.length - countMissingStoryboardFrames(project);
  const shotPacketCount = project.shotPackets?.length ?? 0;
  const runningTasks = countRunningVideoTasks(project);
  const missingReferenceCount = countMissingReferenceAssets(project);
  const missingStoryboardFrames = countMissingStoryboardFrames(project);
  const bundleFollowups = project.productionStateBundle
    ? ["预览生产状态摘要", "打开生产状态目录"]
    : [];

  switch (stage) {
    case "脚本拆解":
      return [
        breakdownPassed ? "复核剧本拆解结果" : "完成第一轮剧本拆解",
        project.targetPlatform?.trim() ? "补充镜头风格偏好" : "补充平台与镜头偏好",
        breakdownPassed ? "确认出片目标" : "等待拆解通过内部检查",
      ];
    case "角色与场景":
      return [
        !hasExtractedVideoEntities(project)
          ? "提取角色与场景"
          : missingReferenceCount > 0
            ? `补齐 ${missingReferenceCount} 个角色或场景参考图`
            : "检查角色与场景设定",
        hasMinimumReferenceAssets(project) ? "准备分镜文本" : "先补齐基础参考图",
        "补充额外镜头要求",
      ];
    case "分镜图生成":
      return [
        !hasStoryboardText(project)
          ? "整理分镜文本计划"
          : missingStoryboardFrames > 0
            ? `补齐剩余 ${missingStoryboardFrames} 张分镜图`
            : storyboardedSceneCount > 0
              ? `复核 ${storyboardedSceneCount} 张分镜图`
              : "生成第一批分镜图",
        missingStoryboardFrames > 0 ? "继续生成分镜图" : "准备进入视频生成",
        "检查镜头连续性",
      ];
    case "视频生成":
      if (project.videoGenerationPrefs?.mode === "text-to-video") {
        const videoBatchLimit = getHomeAgentVideoGenerationBatchLimit(project.videoGenerationPrefs);
        const runningSegmentCount = countRunningSegmentVideos(project);
        const failedSegmentCount = countFailedSegmentVideos(project);
        const generatableSegmentCount = countGeneratableSegmentVideos(project);
        if (runningSegmentCount || failedSegmentCount || generatableSegmentCount) {
          return [
            runningSegmentCount > 0
              ? `刷新 ${runningSegmentCount} 个进行中片段`
              : failedSegmentCount > 0
                ? `补发 ${Math.min(failedSegmentCount, videoBatchLimit)} 个失败片段`
                : generatableSegmentCount === 1
                  ? "生成当前片段"
                  : `先生成前 ${Math.min(generatableSegmentCount, videoBatchLimit)} 个片段`,
            project.videoPromptBatch?.trim()
              ? "提交第一批视频生成"
              : shotPacketCount > 0
                ? `复核 ${shotPacketCount} 个镜头指令包`
                : "编译镜头指令包",
            runningTasks > 0 ? `刷新 ${runningTasks} 条进行中任务` : "检查视频生成状态",
          ].filter(Boolean);
        }
      }
      if (project.videoPromptBatch?.trim()) {
        return [
          runningTasks > 0 ? `刷新 ${runningTasks} 条进行中任务` : "提交第一批视频生成",
          "继续微调视频提示词",
          shotPacketCount > 0 ? `复核 ${shotPacketCount} 个镜头指令包` : "编译镜头指令包",
        ];
      }
      return [
        shotPacketCount > 0 ? `复核 ${shotPacketCount} 个镜头指令包` : "编译镜头指令包",
        project.videoPromptBatch?.trim() ? "提交第一批视频生成" : "视频提示词生成方式",
        runningTasks > 0 ? `刷新 ${runningTasks} 条进行中任务` : "开始第一轮视频生成",
      ];
    case "预览与导出":
      return [
        failedVideoCount > 0
          ? `补发 ${failedVideoCount} 条失败镜头`
          : generatedVideoCount > 0
            ? `预览已生成的 ${generatedVideoCount} 条视频`
            : "整理预览结果",
        "导出生产状态包",
        ...bundleFollowups,
      ];
    default:
      return ["继续推进视频工作流"];
  }
}

export async function loadConversationSnapshotById(
  projectId: string,
): Promise<ConversationProjectSnapshot | null> {
  if (hasSessionResetMarkerForProject(projectId)) return null;
  const dramaProject = loadStoredDramaProjectById(projectId);
  if (dramaProject) {
    const repaired = await repairConversationSnapshotAutomationModes(
      [applyConversationProjectMeta(createDramaSnapshot(dramaProject))],
      readConversationProjectMetaMap(),
    );
    return repaired[0] ?? null;
  }

  const { loadStoredVideoProjectById } = await loadVideoPersistenceModule();
  const videoProject = await loadStoredVideoProjectById(projectId);
  if (videoProject) {
    const repaired = await repairConversationSnapshotAutomationModes(
      [applyConversationProjectMeta(createVideoSnapshot(videoProject))],
      readConversationProjectMetaMap(),
    );
    return repaired[0] ?? null;
  }

  const archive = await readConversationArchiveFull(projectId);
  const archiveSnapshot = archive?.session?.currentProjectSnapshot;
  if (archiveSnapshot) {
    const repaired = await repairConversationSnapshotAutomationModes(
      [applyConversationProjectMeta(archiveSnapshot)],
      readConversationProjectMetaMap(),
    );
    return repaired[0] ?? null;
  }

  const fileSnapshot = (await readProjectSessionFromFile(projectId))?.currentProjectSnapshot ?? null;
  if (fileSnapshot) {
    const repaired = await repairConversationSnapshotAutomationModes(
      [applyConversationProjectMeta(fileSnapshot)],
      readConversationProjectMetaMap(),
    );
    return repaired[0] ?? null;
  }

  return null;
}

export async function loadConversationSourceById(
  projectId: string,
  options?: { includeSnapshot?: boolean; fastVideoLoad?: boolean },
): Promise<{
  snapshot: ConversationProjectSnapshot | null;
  dramaProject: DramaProject | null;
  videoProject: PersistedVideoProject | null;
}> {
  if (hasSessionResetMarkerForProject(projectId)) {
    return {
      snapshot: null,
      dramaProject: null,
      videoProject: null,
    };
  }

  const includeSnapshot = options?.includeSnapshot !== false;
  const dramaProject = loadStoredDramaProjectById(projectId);
  if (dramaProject) {
    const snapshot = includeSnapshot ? applyConversationProjectMeta(createDramaSnapshot(dramaProject)) : null;
    const repairedSnapshot = snapshot
      ? (await repairConversationSnapshotAutomationModes([snapshot], readConversationProjectMetaMap()))[0] ?? null
      : null;
    return {
      snapshot: repairedSnapshot,
      dramaProject,
      videoProject: null,
    };
  }

  const { loadStoredVideoProjectById } = await loadVideoPersistenceModule();
  const videoProject = await loadStoredVideoProjectById(projectId, {
    fast: options?.fastVideoLoad === true,
  });
  if (videoProject) {
    const snapshot = includeSnapshot ? applyConversationProjectMeta(createVideoSnapshot(videoProject)) : null;
    const repairedSnapshot = snapshot
      ? (await repairConversationSnapshotAutomationModes([snapshot], readConversationProjectMetaMap()))[0] ?? null
      : null;
    return {
      snapshot: repairedSnapshot,
      dramaProject: null,
      videoProject,
    };
  }

  const materialized = await materializeConversationArchiveProjectById(projectId);
  if (materialized.dramaProject || materialized.videoProject) {
    const snapshot = includeSnapshot && materialized.snapshot ? applyConversationProjectMeta(materialized.snapshot) : null;
    const repairedSnapshot = snapshot
      ? (await repairConversationSnapshotAutomationModes([snapshot], readConversationProjectMetaMap()))[0] ?? null
      : null;
    return {
      snapshot: repairedSnapshot,
      dramaProject: materialized.dramaProject,
      videoProject: materialized.videoProject,
    };
  }
  const archive = await readConversationArchiveFull(projectId);
  const archiveSnapshot = archive?.session?.currentProjectSnapshot ?? null;
  if (archiveSnapshot) {
    const snapshot = includeSnapshot ? applyConversationProjectMeta(archiveSnapshot) : null;
    const repairedSnapshot = snapshot
      ? (await repairConversationSnapshotAutomationModes([snapshot], readConversationProjectMetaMap()))[0] ?? null
      : null;
    return {
      snapshot: repairedSnapshot,
      dramaProject: null,
      videoProject: null,
    };
  }

  const fileSnapshot = (await readProjectSessionFromFile(projectId))?.currentProjectSnapshot ?? null;
  if (fileSnapshot) {
    const snapshot = includeSnapshot ? applyConversationProjectMeta(fileSnapshot) : null;
    const repairedSnapshot = snapshot
      ? (await repairConversationSnapshotAutomationModes([snapshot], readConversationProjectMetaMap()))[0] ?? null
      : null;
    return {
      snapshot: repairedSnapshot,
      dramaProject: null,
      videoProject: null,
    };
  }

  return {
    snapshot: null,
    dramaProject: null,
    videoProject: null,
  };
}

export async function listRecentConversationSnapshots(
  limit = 8,
  options?: { fast?: boolean },
): Promise<ConversationProjectSnapshot[]> {
  await cleanupResetMarkedConversationArchives();
  const metaMap = readConversationProjectMetaMap();
  const applyMeta = (snapshot: ConversationProjectSnapshot) =>
    applyConversationProjectMetaFromMap(snapshot, metaMap);
  const archiveSnapshots = (await listConversationArchiveSnapshots())
    .filter((snapshot) => !hasSessionResetMarkerForProject(snapshot.projectId))
    .map(applyMeta);
  const archiveProjectIds = new Set(archiveSnapshots.map((snapshot) => snapshot.projectId));
  const dramaSnapshots = listStoredDramaProjects()
    .filter((project) => !hasSessionResetMarkerForProject(project.id))
    .map((project) => applyMeta(createDramaSnapshot(project)));
  const { listStoredVideoProjects } = await loadVideoPersistenceModule();
  const videoSnapshots = (await listStoredVideoProjects({ fast: options?.fast }))
    .filter((project) => !hasSessionResetMarkerForProject(project.id))
    .map((project) =>
      applyMeta(options?.fast ? createVideoSnapshotLite(project) : createVideoSnapshot(project)),
    );
  const snapshotsById = new Map<string, ConversationProjectSnapshot>();
  for (const snapshot of archiveSnapshots) {
    snapshotsById.set(snapshot.projectId, snapshot);
  }
  for (const snapshot of [...dramaSnapshots, ...videoSnapshots]) {
    snapshotsById.set(snapshot.projectId, snapshot);
  }
  const sessionFallbackSnapshots = await listSessionBackedConversationSnapshots(
    new Set(snapshotsById.keys()),
  );
  for (const snapshot of sessionFallbackSnapshots) {
    snapshotsById.set(snapshot.projectId, applyMeta(snapshot));
  }
  const repairedSnapshots = await repairConversationSnapshotAutomationModes(
    [...snapshotsById.values()],
    metaMap,
  );

  if (!options?.fast) {
    for (const snapshot of repairedSnapshots) {
      if (archiveProjectIds.has(snapshot.projectId)) continue;
      queueConversationArchiveBackfill(snapshot);
    }
  }

  return repairedSnapshots
    .sort((a, b) => {
      const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinnedDelta !== 0) return pinnedDelta;
      const aDate = getSnapshotUpdatedAt(a);
      const bDate = getSnapshotUpdatedAt(b);
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    })
    .slice(0, limit);
}

export async function setConversationProjectPinned(projectId: string, pinned: boolean): Promise<void> {
  const map = readConversationProjectMetaMap();
  const current = map[projectId] ?? {};
  map[projectId] = { ...current, pinned };
  writeConversationProjectMetaMap(map);
}

export async function renameConversationProject(projectId: string, title: string): Promise<void> {
  const nextTitle = title.trim().slice(0, 120);
  if (!nextTitle) return;

  const dramaProject = loadStoredDramaProjectById(projectId);
  if (dramaProject) {
    upsertStoredDramaProject({
      ...dramaProject,
      dramaTitle: nextTitle,
    });
  } else {
    const { loadStoredVideoProjectById, upsertStoredVideoProject } = await loadVideoPersistenceModule();
    const videoProject = await loadStoredVideoProjectById(projectId);
    if (videoProject) {
      await upsertStoredVideoProject({
        ...videoProject,
        title: nextTitle,
      });
    }
  }

  const map = readConversationProjectMetaMap();
  const current = map[projectId] ?? {};
  map[projectId] = { ...current, customTitle: nextTitle };
  writeConversationProjectMetaMap(map);
}

export async function setConversationProjectAutomationMode(
  projectId: string,
  automationMode: "manual" | "full-auto",
): Promise<void> {
  inferredConversationAutomationModeCache.set(projectId, normalizeAutomationMode(automationMode));
  const map = readConversationProjectMetaMap();
  const current = map[projectId] ?? {};
  map[projectId] = { ...current, automationMode: normalizeAutomationMode(automationMode) };
  writeConversationProjectMetaMap(map);
}

function countExpiredProjectVideoReferences(project: PersistedVideoProject): number {
  let count = 0;

  for (const scene of project.scenes ?? []) {
    if (isExpiredRemoteSignedMediaUrl(scene.videoUrl)) {
      count += 1;
    }
    for (const entry of scene.videoHistory ?? []) {
      if (isExpiredRemoteSignedMediaUrl(entry.videoUrl)) {
        count += 1;
      }
    }
  }

  for (const item of project.assetManifest?.items ?? []) {
    if (item.kind === "video-segment" && isExpiredRemoteSignedMediaUrl(item.url)) {
      count += 1;
    }
  }

  return count;
}

export async function cleanupConversationProjectExpiredVideoMedia(
  projectId: string,
): Promise<{
  snapshot: ConversationProjectSnapshot | null;
  videoProject: PersistedVideoProject | null;
  session: StudioSessionState | null;
  removedProjectVideoRefs: number;
  removedSessionMediaRefs: number;
}> {
  const session = readProjectStudioSession(projectId);
  const prunedSession = session ? pruneExpiredMediaFromSession(session) : null;
  if (prunedSession?.changed) {
    await writeProjectStudioSession(prunedSession.session);
  }

  const {
    loadStoredVideoProjectById,
    pruneExpiredVideoReferencesFromProject,
    upsertStoredVideoProject,
  } = await loadVideoPersistenceModule();
  const videoProject = await loadStoredVideoProjectById(projectId);
  if (!videoProject) {
    return {
      snapshot: null,
      videoProject: null,
      session: prunedSession?.session ?? session ?? null,
      removedProjectVideoRefs: 0,
      removedSessionMediaRefs: prunedSession?.removedCount ?? 0,
    };
  }

  const removedProjectVideoRefs = countExpiredProjectVideoReferences(videoProject);
  const nextVideoProject =
    removedProjectVideoRefs > 0
      ? await upsertStoredVideoProject(pruneExpiredVideoReferencesFromProject(videoProject))
      : videoProject;

  return {
    snapshot: applyConversationProjectMeta(createVideoSnapshot(nextVideoProject)),
    videoProject: nextVideoProject,
    session: prunedSession?.session ?? session ?? null,
    removedProjectVideoRefs,
    removedSessionMediaRefs: prunedSession?.removedCount ?? 0,
  };
}

/** Remove drama/video project storage and per-project studio session for one conversation. */
type ConversationProjectDeletionTarget = Pick<ConversationProjectSnapshot, "projectId" | "projectKind">;

async function resolveConversationProjectDeletionTargets(
  snapshot: Pick<ConversationProjectSnapshot, "projectId" | "projectKind" | "sourceProjectId">,
): Promise<ConversationProjectDeletionTarget[]> {
  const requestedProjectId = snapshot.projectId.trim();
  if (!requestedProjectId) return [];

  const targets = new Map<string, ConversationProjectDeletionTarget>();
  const addTarget = (projectId: string, projectKind: ConversationProjectSnapshot["projectKind"]) => {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) return;
    targets.set(normalizedProjectId, {
      projectId: normalizedProjectId,
      projectKind,
    });
  };

  addTarget(requestedProjectId, snapshot.projectKind);

  const { listStoredVideoProjects, loadStoredVideoProjectById } = await loadVideoPersistenceModule();

  if (snapshot.projectKind === "video") {
    const storedVideoProject = await loadStoredVideoProjectById(requestedProjectId, { fast: true });
    let sourceProjectId =
      typeof snapshot.sourceProjectId === "string" ? snapshot.sourceProjectId.trim() : "";
    if (!sourceProjectId) {
      sourceProjectId =
        typeof storedVideoProject?.sourceProjectId === "string"
          ? storedVideoProject.sourceProjectId.trim()
          : "";
    }
    if (!sourceProjectId) {
      return [...targets.values()];
    }

    const linkedVideoProjects = (await listStoredVideoProjects({ fast: true })).filter(
      (project) =>
        typeof project.sourceProjectId === "string" &&
        project.sourceProjectId.trim() === sourceProjectId,
    );

    // Bridged "use current script" cards project the live video snapshot onto the
    // source script session shell. When the card is deleted we need to map that
    // shell back to the underlying script/video pair instead of treating the
    // script id like a real stored video id.
    if (!storedVideoProject && sourceProjectId === requestedProjectId) {
      targets.delete(requestedProjectId);
      if (loadStoredDramaProjectById(sourceProjectId)) {
        addTarget(sourceProjectId, "script");
      }
      if (linkedVideoProjects.length === 1) {
        addTarget(linkedVideoProjects[0].id, "video");
      }
      return [...targets.values()];
    }

    const siblingVideoProjects = linkedVideoProjects.filter(
      (project) => project.id !== requestedProjectId,
    );
    if (!siblingVideoProjects.length && loadStoredDramaProjectById(sourceProjectId)) {
      addTarget(sourceProjectId, "script");
    }
    return [...targets.values()];
  }

  const linkedVideoProjects = (await listStoredVideoProjects({ fast: true })).filter(
    (project) =>
      typeof project.sourceProjectId === "string" &&
      project.sourceProjectId.trim() === requestedProjectId,
  );
  if (linkedVideoProjects.length === 1) {
    addTarget(linkedVideoProjects[0].id, "video");
  }

  return [...targets.values()];
}

export async function deleteConversationProject(
  snapshot: Pick<ConversationProjectSnapshot, "projectId" | "projectKind" | "sourceProjectId">,
): Promise<{ deletedProjectIds: string[] }> {
  const deletionTargets = await resolveConversationProjectDeletionTargets(snapshot);
  const { deleteStoredVideoProjectById } = await loadVideoPersistenceModule();
  const { getProjectRootPath } = await import("@/lib/file-cache");

  for (const target of deletionTargets) {
    removeProjectStudioSession(target.projectId);
    removeConversationProjectMeta(target.projectId);
    if (target.projectKind === "video") {
      await deleteStoredVideoProjectById(target.projectId);
    } else {
      deleteStoredDramaProject(target.projectId);
    }
    await deleteConversationArchive(target.projectId);
    // Remove cached media files for the deleted project as well.
    const legacyDir = await getProjectRootPath(target.projectId);
    if (legacyDir) {
      await window.electronAPI?.storage?.deleteDir?.(legacyDir);
    }
  }

  return {
    deletedProjectIds: deletionTargets.map((target) => target.projectId),
  };
  /*
  for (const target of deletionTargets) {
  // 删除项目文件目录（图片、视频等缓存文件）
  const { getProjectRootPath } = await import("@/lib/file-cache");
    removeProjectStudioSession(target.projectId);
  if (legacyDir) {
    await window.electronAPI?.storage?.deleteDir?.(legacyDir);
  }
  */
}

/** 原地复制一个对话项目（含会话消息），返回新项目的快照。 */
export async function duplicateConversationProject(
  snapshot: ConversationProjectSnapshot,
): Promise<ConversationProjectSnapshot | null> {
  const now = new Date().toISOString();
  const nextTitle = await buildNextDuplicateConversationTitle(snapshot.title);
  // 优先从文件系统读取完整会话（无截断），回退到 localStorage 的压缩版本
  const fileSession = await readProjectSessionFromFile(snapshot.projectId);
  const localSession = readProjectStudioSession(snapshot.projectId);
  const srcSession =
    fileSession && (!localSession || fileSession.messages.length >= localSession.messages.length)
      ? fileSession
      : localSession;
  const duplicateSessionOnlyConversation = async (): Promise<ConversationProjectSnapshot | null> => {
    if (!srcSession) return null;
    const newId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const duplicatedSnapshot: ConversationProjectSnapshot = {
      ...(srcSession.currentProjectSnapshot ?? snapshot),
      projectId: newId,
      title: nextTitle,
      updatedAt: now,
      automationMode: normalizeAutomationMode(
        srcSession.currentProjectSnapshot?.automationMode ??
          srcSession.automationMode ??
          snapshot.automationMode,
      ),
    };
    await writeProjectStudioSession({
      ...srcSession,
      automationMode: normalizeAutomationMode(srcSession.automationMode ?? snapshot.automationMode),
      projectId: newId,
      sessionId: undefined,
      currentProjectSnapshot: duplicatedSnapshot,
    });
    const metaMap = readConversationProjectMetaMap();
    metaMap[newId] = {
      ...metaMap[newId],
      customTitle: nextTitle,
      automationMode: normalizeAutomationMode(duplicatedSnapshot.automationMode),
    };
    writeConversationProjectMetaMap(metaMap);
    await setConversationProjectAutomationMode(newId, normalizeAutomationMode(duplicatedSnapshot.automationMode));
    return (await loadConversationSnapshotById(newId))?.snapshot ?? applyConversationProjectMeta(duplicatedSnapshot);
  };

  if (snapshot.projectKind === "video") {
    const { loadStoredVideoProjectById, upsertStoredVideoProject } = await loadVideoPersistenceModule();
    const src = await loadStoredVideoProjectById(snapshot.projectId);
    if (!src) return duplicateSessionOnlyConversation();
    const newId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await upsertStoredVideoProject({
      ...src,
      id: newId,
      title: nextTitle,
      createdAt: now,
      updatedAt: now,
    });
    if (srcSession) {
      await writeProjectStudioSession({
        ...srcSession,
        automationMode: normalizeAutomationMode(srcSession.automationMode ?? snapshot.automationMode),
        projectId: newId,
        sessionId: undefined,
        currentProjectSnapshot: srcSession.currentProjectSnapshot
          ? {
              ...srcSession.currentProjectSnapshot,
              projectId: newId,
              title: nextTitle,
              automationMode: normalizeAutomationMode(srcSession.currentProjectSnapshot.automationMode ?? snapshot.automationMode),
            }
          : srcSession.currentProjectSnapshot,
      });
    }
    const metaMap = readConversationProjectMetaMap();
    metaMap[newId] = {
      ...metaMap[newId],
      customTitle: nextTitle,
      automationMode: normalizeAutomationMode(snapshot.automationMode),
    };
    writeConversationProjectMetaMap(metaMap);
    await setConversationProjectAutomationMode(newId, normalizeAutomationMode(snapshot.automationMode));
    return loadConversationSnapshotById(newId);
  }

  const src = loadStoredDramaProjectById(snapshot.projectId);
  if (!src) return duplicateSessionOnlyConversation();
  const newId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  upsertStoredDramaProject({
    ...src,
    id: newId,
    dramaTitle: nextTitle,
    createdAt: now,
    updatedAt: now,
  });
  if (srcSession) {
    await writeProjectStudioSession({
      ...srcSession,
      automationMode: normalizeAutomationMode(srcSession.automationMode ?? snapshot.automationMode),
      projectId: newId,
      sessionId: undefined,
      currentProjectSnapshot: srcSession.currentProjectSnapshot
        ? {
            ...srcSession.currentProjectSnapshot,
            projectId: newId,
            title: nextTitle,
            automationMode: normalizeAutomationMode(srcSession.currentProjectSnapshot.automationMode ?? snapshot.automationMode),
          }
        : srcSession.currentProjectSnapshot,
    });
  }
  const metaMap = readConversationProjectMetaMap();
  metaMap[newId] = {
    ...metaMap[newId],
    customTitle: nextTitle,
    automationMode: normalizeAutomationMode(snapshot.automationMode),
  };
  writeConversationProjectMetaMap(metaMap);
  await setConversationProjectAutomationMode(newId, normalizeAutomationMode(snapshot.automationMode));
  return loadConversationSnapshotById(newId);
}

/**
 * 若自动删除开关开启且总项目数超过上限，按时间从旧到新删除多余项目（置顶项目不参与自动删除）。
 */
export async function pruneHistoryIfNeeded(): Promise<void> {
  const { getHistorySettings } = await import("./history-settings");
  const { autoDelete, maxCount } = getHistorySettings();
  if (!autoDelete) return;

  const dramaProjects = listStoredDramaProjects();
  const { listStoredVideoProjects, deleteStoredVideoProjectById } = await loadVideoPersistenceModule();
  const videoProjects = await listStoredVideoProjects();

  type Entry = { id: string; kind: "script" | "video"; updatedAt: string; pinned: boolean };
  const metaMap = readConversationProjectMetaMap();

  const all: Entry[] = [
    ...dramaProjects.map((p) => ({
      id: p.id,
      kind: "script" as const,
      updatedAt: p.updatedAt,
      pinned: !!metaMap[p.id]?.pinned,
    })),
    ...videoProjects.map((p) => ({
      id: p.id,
      kind: "video" as const,
      updatedAt: p.updatedAt ?? "",
      pinned: !!metaMap[p.id]?.pinned,
    })),
  ];

  if (all.length <= maxCount) return;

  // 置顶优先保留，其余按时间降序排列，超出部分从末尾（最旧）删除
  const sorted = [...all].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const toDelete = sorted.slice(maxCount).filter((e) => !e.pinned);
  const { getProjectRootPath } = await import("@/lib/file-cache");
  for (const entry of toDelete) {
    removeProjectStudioSession(entry.id);
    removeConversationProjectMeta(entry.id);
    if (entry.kind === "video") {
      await deleteStoredVideoProjectById(entry.id);
    } else {
      deleteStoredDramaProject(entry.id);
    }
    await deleteConversationArchive(entry.id);
    const legacyDir = await getProjectRootPath(entry.id);
    if (legacyDir) {
      await window.electronAPI?.storage?.deleteDir?.(legacyDir);
    }
  }
}
