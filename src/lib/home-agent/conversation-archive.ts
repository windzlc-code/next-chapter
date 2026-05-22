import { getProjectRootPath } from "@/lib/file-cache";
import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import type {
  AutomationMode,
  ConversationProjectKind,
  ConversationProjectSnapshot,
  StudioSessionState,
} from "./types";
import { normalizeAutomationMode } from "./automation-mode";

const ARCHIVE_ROOT_DIR = "conversations";
const MANIFEST_FILE = "history-manifest.json";
const FULL_HISTORY_FILE = "chat-history.full.json";
const LEGACY_HISTORY_FILE = "chat-history.json";
const PROJECT_FILE = "project.json";
const DIR_SEPARATOR = "--";

export interface ConversationArchiveManifest {
  archiveVersion: number;
  projectId: string;
  title: string;
  projectKind: ConversationProjectKind;
  automationMode?: AutomationMode;
  updatedAt: string;
  messageCount: number;
  artifactCount: number;
  currentObjective: string;
  derivedStage: string;
  agentSummary: string;
  recommendedActions: string[];
  dirName: string;
  hasFullHistory: boolean;
}

export interface ConversationArchiveRecord {
  dir: string;
  manifest: ConversationArchiveManifest;
}

type StorageApi = NonNullable<typeof window.electronAPI>["storage"];

let archiveScanCache: ConversationArchiveRecord[] | null = null;

function getStorage(): StorageApi | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI?.storage ?? null;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/[\\/]+/g, "/");
}

function getBaseName(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? value;
}

function safeSegment(value: string): string {
  const cleaned = Array.from(String(value || "").trim())
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f;
    })
    .join("")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "project";
}

function parseProjectIdFromDirName(dirName: string): string | null {
  const index = dirName.lastIndexOf(DIR_SEPARATOR);
  if (index < 0) return dirName.trim() || null;
  const suffix = dirName.slice(index + DIR_SEPARATOR.length).trim();
  return suffix || null;
}

function buildArchiveDirName(projectId: string, title?: string): string {
  return `${safeSegment(title || projectId)}${DIR_SEPARATOR}${projectId}`;
}

function getSnapshotTitle(snapshot: ConversationProjectSnapshot | null | undefined): string {
  return snapshot?.title?.trim() || "";
}

function getProjectTitle(project: unknown): string {
  if (!project || typeof project !== "object") return "";
  const record = project as Record<string, unknown>;
  return (
    (typeof record.title === "string" && record.title.trim()) ||
    (typeof record.dramaTitle === "string" && record.dramaTitle.trim()) ||
    ""
  );
}

function getProjectKindFromValue(value: unknown): ConversationProjectKind | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.projectKind === "script" || record.projectKind === "adaptation" || record.projectKind === "video") {
    return record.projectKind;
  }
  if (record.mode === "adaptation") return "adaptation";
  if (typeof record.currentStep === "number" || Array.isArray(record.scenes)) return "video";
  if (typeof record.currentStep === "string" || Array.isArray(record.episodes)) return "script";
  return null;
}

function getLastMessageAt(session: StudioSessionState): string {
  const last = session.messages?.at(-1)?.createdAt;
  return typeof last === "string" && last.trim() ? last : new Date().toISOString();
}

function cloneManifest(manifest: ConversationArchiveManifest): ConversationArchiveManifest {
  return {
    ...manifest,
    recommendedActions: [...manifest.recommendedActions],
  };
}

function buildManifest(
  session: StudioSessionState,
  dirName: string,
  project?: unknown,
): ConversationArchiveManifest | null {
  const projectId = session.projectId || session.currentProjectSnapshot?.projectId;
  if (!projectId) return null;

  const snapshot = session.currentProjectSnapshot;
  const title = getSnapshotTitle(snapshot) || getProjectTitle(project) || projectId;
  const projectKind =
    snapshot?.projectKind ??
    getProjectKindFromValue(project) ??
    "script";
  const updatedAt = snapshot?.updatedAt || getLastMessageAt(session);
  const automationMode = normalizeAutomationMode(session.automationMode ?? snapshot?.automationMode);

  return {
    archiveVersion: 1,
    projectId,
    title,
    projectKind,
    automationMode,
    updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    artifactCount: Array.isArray(snapshot?.artifacts) ? snapshot.artifacts.length : 0,
    currentObjective: snapshot?.currentObjective || "",
    derivedStage: snapshot?.derivedStage || "",
    agentSummary: snapshot?.agentSummary || "",
    recommendedActions: Array.isArray(snapshot?.recommendedActions)
      ? snapshot.recommendedActions.filter((item): item is string => typeof item === "string")
      : [],
    dirName,
    hasFullHistory: true,
  };
}

function manifestToSnapshot(manifest: ConversationArchiveManifest): ConversationProjectSnapshot {
  return {
    projectId: manifest.projectId,
    projectKind: manifest.projectKind,
    automationMode: normalizeAutomationMode(manifest.automationMode),
    title: manifest.title || manifest.projectId,
    currentObjective: manifest.currentObjective || "继续当前对话",
    derivedStage: manifest.derivedStage || "历史对话",
    agentSummary: manifest.agentSummary || `已识别 ${manifest.messageCount} 条历史消息。`,
    recommendedActions: manifest.recommendedActions.length
      ? manifest.recommendedActions
      : ["继续当前对话"],
    artifacts: [],
    updatedAt: manifest.updatedAt,
  };
}

async function getArchiveRoot(): Promise<string | null> {
  const root = await getResolvedFilesStoragePath();
  if (!root) return null;
  return joinPath(root.replace(/[\\/]+$/, ""), ARCHIVE_ROOT_DIR);
}

async function readText(filePath: string): Promise<string | null> {
  const storage = getStorage();
  if (!storage?.readText) return null;
  const result = await storage.readText(filePath);
  if (!result.ok || !result.exists || !result.content) return null;
  return result.content;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  const content = await readText(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<boolean> {
  const storage = getStorage();
  if (!storage?.writeText) return false;
  const result = await storage.writeText(filePath, JSON.stringify(value, null, 2));
  return !!result.ok;
}

async function listArchiveDirectories(): Promise<Array<{ name: string; dir: string }>> {
  const root = await getArchiveRoot();
  const storage = getStorage();
  if (!root || !storage?.listDir) return [];
  const result = await storage.listDir(root);
  if (!result.ok) return [];
  return result.entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => ({
      name: entry.name,
      dir: joinPath(root, entry.name),
    }));
}

async function findArchiveDirs(projectId: string): Promise<Array<{ name: string; dir: string }>> {
  const dirs = await listArchiveDirectories();
  return dirs.filter((entry) => parseProjectIdFromDirName(entry.name) === projectId);
}

async function findArchiveDir(projectId: string, title?: string): Promise<{ name: string; dir: string } | null> {
  const matches = await findArchiveDirs(projectId);
  if (!matches.length) return null;
  if (title) {
    const desiredName = buildArchiveDirName(projectId, title);
    return matches.find((entry) => entry.name === desiredName) ?? matches[0];
  }
  return matches[0];
}

async function readArchiveSessionAt(dir: string): Promise<StudioSessionState | null> {
  return (
    (await readJson<StudioSessionState>(joinPath(dir, FULL_HISTORY_FILE))) ??
    (await readJson<StudioSessionState>(joinPath(dir, LEGACY_HISTORY_FILE)))
  );
}

async function readManifestAt(name: string, dir: string): Promise<ConversationArchiveManifest | null> {
  const manifest = await readJson<ConversationArchiveManifest>(joinPath(dir, MANIFEST_FILE));
  if (manifest?.projectId) {
    return {
      ...manifest,
      automationMode: normalizeAutomationMode(manifest.automationMode),
      dirName: manifest.dirName || name,
      recommendedActions: Array.isArray(manifest.recommendedActions) ? manifest.recommendedActions : [],
      hasFullHistory: manifest.hasFullHistory !== false,
    };
  }

  const session = await readArchiveSessionAt(dir);
  const recoveredManifest = session ? buildManifest(session, name) : null;
  if (recoveredManifest) {
    void writeJson(joinPath(dir, MANIFEST_FILE), recoveredManifest);
  }
  return recoveredManifest;
}

export function invalidateConversationArchiveScanCache(): void {
  archiveScanCache = null;
}

async function copyArchiveDirectory(sourceDir: string, destDir: string): Promise<boolean> {
  const storage = getStorage();
  if (!storage?.listDir || !storage.copyFile) return false;
  const result = await storage.listDir(sourceDir);
  if (!result.ok) return false;

  for (const entry of result.entries) {
    const sourcePath = joinPath(sourceDir, entry.name);
    const destPath = joinPath(destDir, entry.name);
    if (entry.isDirectory) {
      const copied = await copyArchiveDirectory(sourcePath, destPath);
      if (!copied) return false;
    } else {
      const copied = await storage.copyFile(sourcePath, destPath);
      if (!copied.ok) return false;
    }
  }
  return true;
}

async function migrateArchiveDirToTitle(
  projectId: string,
  title: string,
  existing: { name: string; dir: string },
): Promise<{ name: string; dir: string }> {
  const desiredName = buildArchiveDirName(projectId, title);
  if (existing.name === desiredName) return existing;

  const root = await getArchiveRoot();
  const storage = getStorage();
  if (!root || !storage?.deleteDir) return existing;

  const desiredDir = joinPath(root, desiredName);
  const copied = await copyArchiveDirectory(existing.dir, desiredDir);
  if (!copied) return existing;

  const deleted = await storage.deleteDir(existing.dir);
  if (!deleted.ok) return existing;

  invalidateConversationArchiveScanCache();
  return { name: desiredName, dir: desiredDir };
}

export async function resolveConversationArchiveDir(
  projectId: string,
  title?: string,
): Promise<string | null> {
  if (!projectId) return null;
  const existing = await findArchiveDir(projectId, title);
  if (existing) {
    if (title) {
      return (await migrateArchiveDirToTitle(projectId, title, existing)).dir;
    }
    return existing.dir;
  }

  const root = await getArchiveRoot();
  if (!root) return null;
  return joinPath(root, buildArchiveDirName(projectId, title));
}

export async function writeConversationArchiveFull(
  session: StudioSessionState,
  project?: unknown,
  options?: { copyLegacyProjectMedia?: boolean },
): Promise<boolean> {
  const projectId = session.projectId || session.currentProjectSnapshot?.projectId;
  if (!projectId) return false;

  const title = getSnapshotTitle(session.currentProjectSnapshot) || getProjectTitle(project) || projectId;
  const dir = await resolveConversationArchiveDir(projectId, title);
  if (!dir) return false;

  const dirName = getBaseName(dir);
  const manifest = buildManifest(
    {
      ...session,
      projectId,
      currentProjectSnapshot: session.currentProjectSnapshot
        ? { ...session.currentProjectSnapshot, projectId }
        : session.currentProjectSnapshot,
    },
    dirName,
    project,
  );
  if (!manifest) return false;

  const storage = getStorage();
  const fullSession = {
    exportVersion: 3,
    isFullVersion: true,
    ...session,
    projectId,
  };

  let wroteHistory = false;
  if (options?.copyLegacyProjectMedia && storage?.exportChatHistory) {
    const sourceDir = await getProjectRootPath(projectId);
    const result = await storage.exportChatHistory({
      sourceDir: sourceDir ?? "",
      destDir: dir,
      sessionJson: JSON.stringify(fullSession, null, 2),
      fileName: "chat-history.full",
    });
    wroteHistory = !!result.ok;
  }

  if (!wroteHistory) {
    wroteHistory = await writeJson(joinPath(dir, FULL_HISTORY_FILE), fullSession);
  }
  if (!wroteHistory) return false;

  await writeJson(joinPath(dir, MANIFEST_FILE), manifest);
  if (project) {
    await writeJson(joinPath(dir, PROJECT_FILE), project);
  }
  invalidateConversationArchiveScanCache();
  return true;
}

export async function writeConversationArchiveProject(
  projectId: string,
  title: string,
  projectKind: ConversationProjectKind,
  project: unknown,
): Promise<boolean> {
  if (!projectId) return false;
  const dir = await resolveConversationArchiveDir(projectId, title || projectId);
  if (!dir) return false;
  const wroteProject = await writeJson(joinPath(dir, PROJECT_FILE), project);
  const existing = await readManifestAt(getBaseName(dir), dir);
  const manifest: ConversationArchiveManifest =
    existing ??
    {
      archiveVersion: 1,
      projectId,
      title: title || projectId,
      projectKind,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      artifactCount: 0,
      currentObjective: "",
      derivedStage: "",
      agentSummary: "",
      recommendedActions: [],
      dirName: getBaseName(dir),
      hasFullHistory: false,
    };
  await writeJson(joinPath(dir, MANIFEST_FILE), {
    ...manifest,
    title: title || manifest.title,
    projectKind,
    updatedAt: new Date().toISOString(),
    dirName: getBaseName(dir),
  });
  invalidateConversationArchiveScanCache();
  return wroteProject;
}

export async function readConversationArchiveFull(projectId: string): Promise<{
  session: StudioSessionState | null;
  project: unknown | null;
  manifest: ConversationArchiveManifest | null;
} | null> {
  const found = await findArchiveDir(projectId);
  if (!found) return null;
  const [session, project, manifest] = await Promise.all([
    readArchiveSessionAt(found.dir),
    readJson<unknown>(joinPath(found.dir, PROJECT_FILE)),
    readManifestAt(found.name, found.dir),
  ]);
  return { session, project, manifest };
}

export async function readLatestConversationArchiveSession(): Promise<StudioSessionState | null> {
  const records = await scanConversationArchives();
  for (const record of records) {
    const archive = await readConversationArchiveFull(record.manifest.projectId);
    if (archive?.session) return archive.session;
  }
  return null;
}

export async function scanConversationArchives(options?: { refresh?: boolean }): Promise<ConversationArchiveRecord[]> {
  if (archiveScanCache && !options?.refresh) {
    return archiveScanCache.map((record) => ({
      dir: record.dir,
      manifest: cloneManifest(record.manifest),
    }));
  }

  const dirs = await listArchiveDirectories();
  const manifests = await Promise.all(
    dirs.map(async (entry) => ({
      dir: entry.dir,
      manifest: await readManifestAt(entry.name, entry.dir),
    })),
  );
  const records: ConversationArchiveRecord[] = [];
  const seen = new Set<string>();

  for (const entry of manifests) {
    if (!entry.manifest?.projectId || seen.has(entry.manifest.projectId)) continue;
    seen.add(entry.manifest.projectId);
    records.push({ dir: entry.dir, manifest: entry.manifest });
  }

  records.sort(
    (a, b) =>
      new Date(b.manifest.updatedAt || 0).getTime() -
      new Date(a.manifest.updatedAt || 0).getTime(),
  );
  archiveScanCache = records.map((record) => ({
    dir: record.dir,
    manifest: cloneManifest(record.manifest),
  }));
  return records;
}

export async function listConversationArchiveSnapshots(): Promise<ConversationProjectSnapshot[]> {
  const records = await scanConversationArchives();
  return records.map((record) => manifestToSnapshot(record.manifest));
}

export async function deleteConversationArchive(projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const storage = getStorage();
  if (!storage?.deleteDir) return false;
  const matches = await findArchiveDirs(projectId);
  let deleted = false;
  for (const match of matches) {
    const result = await storage.deleteDir(match.dir);
    deleted = !!result.ok || deleted;
  }
  if (deleted) invalidateConversationArchiveScanCache();
  return deleted;
}
