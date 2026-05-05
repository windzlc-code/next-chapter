import { getProjectRootPath } from "@/lib/file-cache";
import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type {
  ConversationProjectKind,
  HomeAgentMessage,
  StudioSessionState,
} from "@/lib/home-agent/types";
import type { DramaProject } from "@/types/drama";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import {
  readConversationArchiveFull,
  resolveConversationArchiveDir,
} from "@/lib/home-agent/conversation-archive";

const LAST_EXPORTED_CHAT_HISTORY_KEY = "storyforge-last-exported-chat-history-v1";

export interface ChatHistoryPreview {
  title: string;
  messageCount: number;
  artifactCount: number;
  exportVersion: number;
  projectId?: string;
  isFullVersion: boolean;
}

export interface ExportChatHistoryOptions {
  exportVersion?: number;
  isFullVersion?: boolean;
  dramaProject?: DramaProject;
}

type ExportChatHistoryFailureReason = string;
type ImportChatHistoryFailureReason = string;
type RevealChatHistoryFailureReason = string;

export interface ExportedChatHistoryRecord {
  destDir: string;
  chatHistoryFilePath: string;
}

export type ExportChatHistoryResult =
  | {
      ok: true;
      destDir: string;
      chatHistoryFilePath: string;
      reason?: ExportChatHistoryFailureReason;
      message?: string;
    }
  | {
      ok: false;
      reason: ExportChatHistoryFailureReason;
      message: string;
    };

export type ImportedChatHistoryResult =
  | {
      ok: true;
      session: StudioSessionState;
      importedMediaDir?: string;
      dramaProject?: DramaProject;
      reason?: ImportChatHistoryFailureReason;
      message?: string;
    }
  | {
      ok: false;
      reason: ImportChatHistoryFailureReason;
      message: string;
    };

export type RevealExportedChatHistoryResult =
  | {
      ok: true;
      chatHistoryFilePath: string;
      reason?: RevealChatHistoryFailureReason;
      message?: string;
    }
  | {
      ok: false;
      reason: RevealChatHistoryFailureReason;
      message: string;
    };

function safeSegment(value: string): string {
  const cleaned = Array.from(value.trim())
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f;
    })
    .join("")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return cleaned || "project";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLastExportedChatHistoryMap(): Record<string, ExportedChatHistoryRecord> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAST_EXPORTED_CHAT_HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ExportedChatHistoryRecord>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLastExportedChatHistoryMap(records: Record<string, ExportedChatHistoryRecord>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_EXPORTED_CHAT_HISTORY_KEY, JSON.stringify(records));
  } catch {
    // ignore persistence failure
  }
}

export function recordLastExportedChatHistory(projectId: string, record: ExportedChatHistoryRecord): void {
  if (!projectId) return;
  const records = readLastExportedChatHistoryMap();
  records[projectId] = record;
  writeLastExportedChatHistoryMap(records);
}

export function readLastExportedChatHistory(projectId: string): ExportedChatHistoryRecord | null {
  if (!projectId) return null;
  return readLastExportedChatHistoryMap()[projectId] ?? null;
}

function rewriteAttachmentPath(value: string | undefined, targetProjectDir: string): string | undefined {
  if (!value || !targetProjectDir) return value;
  const projectsMatch = value.match(/[/\\]projects[/\\][^/\\]+([/\\].*)?$/);
  if (projectsMatch) {
    const suffix = projectsMatch[1] ?? "";
    return `${targetProjectDir}${suffix}`.replace(/\//g, "\\");
  }
  const mediaMatch = value.match(/[/\\]media([/\\].*)?$/);
  if (mediaMatch) {
    const suffix = mediaMatch[1] ?? "";
    return `${targetProjectDir}${suffix}`.replace(/\//g, "\\");
  }
  return value;
}

function rewriteAttachments(attachments: ChatAttachment[] | undefined, targetProjectDir: string): ChatAttachment[] | undefined {
  if (!attachments?.length) return attachments;
  return attachments.map((attachment) => ({
    ...attachment,
    localPath: rewriteAttachmentPath(attachment.localPath, targetProjectDir),
    previewUrl: attachment.previewUrl?.startsWith("file://")
      ? `file://${rewriteAttachmentPath(attachment.previewUrl.slice("file://".length), targetProjectDir)?.replace(/\\/g, "/")}`
      : rewriteAttachmentPath(attachment.previewUrl, targetProjectDir),
    history: attachment.history?.map((entry) => ({
      ...entry,
      localPath: rewriteAttachmentPath(entry.localPath, targetProjectDir),
      previewUrl: entry.previewUrl?.startsWith("file://")
        ? `file://${rewriteAttachmentPath(entry.previewUrl.slice("file://".length), targetProjectDir)?.replace(/\\/g, "/")}`
        : rewriteAttachmentPath(entry.previewUrl, targetProjectDir),
    })),
  }));
}

function rewriteImportedMessages(messages: HomeAgentMessage[], targetProjectDir: string): HomeAgentMessage[] {
  return messages.map((message) => ({
    ...message,
    attachments: rewriteAttachments(message.attachments, targetProjectDir),
  }));
}

/**
 * 导出聊天记录到用户选择的文件夹。
 * 结构：{destRoot}/{title}-{id8}-{date}/chat-history.json + media/
 */
export async function exportChatHistory(
  session: StudioSessionState,
  projectTitle: string,
  options?: ExportChatHistoryOptions,
): Promise<ExportChatHistoryResult> {
  const storage = window.electronAPI?.storage;
  if (!storage) {
    return { ok: false, reason: "unknown", message: "当前环境不支持导出聊天记录。" };
  }

  if (!session.messages?.length) {
    return { ok: false, reason: "no-session", message: "没有可导出的聊天记录。" };
  }

  const destRoot = await storage.selectFolder();
  if (!destRoot) {
    return { ok: false, reason: "cancelled", message: "已取消选择导出目录。" };
  }

  const id8 = (session.projectId ?? "unknown").slice(0, 8);
  const folderName = `${safeSegment(projectTitle)}-${id8}-${todayStr()}`;
  const destDir = `${destRoot.replace(/[\\/]+$/, "")}/${folderName}`;

  const sourceDir = session.projectId ? await getProjectRootPath(session.projectId) : null;

  const sessionWithMeta = {
    exportVersion: options?.exportVersion ?? 2,
    isFullVersion: options?.isFullVersion ?? true,
    ...session,
    ...(options?.dramaProject ? { dramaProject: options.dramaProject } : {}),
  };

  const result = await storage.exportChatHistory({
    sourceDir: sourceDir ?? "",
    destDir,
    sessionJson: JSON.stringify(sessionWithMeta, null, 2),
    fileName: "chat-history",
  });

  if (!result.ok || !result.destDir || !result.chatHistoryFilePath) {
    console.error("[chat-history-io] 导出失败:", result.error);
    return {
      ok: false,
      reason: result.reason ?? "write-failed",
      message: result.error || "导出聊天记录失败，请稍后重试。",
    };
  }
  return {
    ok: true,
    destDir: result.destDir,
    chatHistoryFilePath: result.chatHistoryFilePath,
  };
}

/**
 * 解析已选择的 chat-history.json 文件，返回内容摘要供导入前预览。
 * 解析失败时返回 null。
 */
export async function parseChatHistoryPreview(filePath: string): Promise<ChatHistoryPreview | null> {
  const storage = window.electronAPI?.storage;
  if (!storage) return null;
  try {
    const result = await storage.importChatHistory({ filePath, targetProjectDir: undefined });
    if (!result.ok || !result.content) return null;
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    if (!Array.isArray(parsed.messages)) return null;
    const snapshot = parsed.currentProjectSnapshot as Record<string, unknown> | undefined;
    return {
      title: (snapshot?.title as string | undefined) || "未命名项目",
      messageCount: (parsed.messages as unknown[]).length,
      artifactCount: Array.isArray(snapshot?.artifacts) ? (snapshot.artifacts as unknown[]).length : 0,
      exportVersion: typeof parsed.exportVersion === "number" ? parsed.exportVersion : 1,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
      isFullVersion: parsed.isFullVersion === true,
    };
  } catch {
    return null;
  }
}

function parseImportedSession(
  content: string,
  targetProjectId: string | undefined,
  targetProjectDir: string | null,
): { session: StudioSessionState; dramaProject?: DramaProject } | { error: string } {
  try {
    const parsed = JSON.parse(content) as StudioSessionState & { dramaProject?: DramaProject };
    if (!Array.isArray(parsed.messages)) {
      return { error: "chat-history.json 格式无效。" };
    }
    const rewrittenMessages = targetProjectDir
      ? rewriteImportedMessages(parsed.messages, targetProjectDir)
      : parsed.messages;
    const resolvedProjectId = targetProjectId ?? parsed.projectId;
    const { dramaProject, ...sessionData } = parsed;
    const session: StudioSessionState = {
      ...sessionData,
      projectId: resolvedProjectId,
      messages: rewrittenMessages,
      currentProjectSnapshot: parsed.currentProjectSnapshot
        ? { ...parsed.currentProjectSnapshot, projectId: resolvedProjectId }
        : parsed.currentProjectSnapshot,
    };
    return { session, dramaProject };
  } catch {
    return { error: "chat-history.json 解析失败。" };
  }
}

/**
 * 让用户选择 chat-history.json 文件并解析为 StudioSessionState。
 * 若提供 targetProjectId，会把 media/ 回填到当前项目目录，并重写导入消息里的本地路径。
 * 若提供 filePath，跳过文件选择对话框直接使用该路径。
 */
export async function importChatHistory(targetProjectId?: string, filePath?: string): Promise<ImportedChatHistoryResult> {
  const storage = window.electronAPI?.storage;
  if (!storage) {
    return { ok: false, reason: "unknown", message: "当前环境不支持导入聊天记录。" };
  }

  const resolvedFilePath = filePath ?? await storage.selectFile({
    filters: [{ name: "聊天记录", extensions: ["json"] }],
  });
  if (!resolvedFilePath) {
    return { ok: false, reason: "cancelled", message: "已取消选择导入文件。" };
  }

  const targetProjectDir = targetProjectId ? await getProjectRootPath(targetProjectId) : null;
  const result = await storage.importChatHistory({
    filePath: resolvedFilePath,
    targetProjectDir: targetProjectDir ?? undefined,
  });
  if (!result.ok || !result.content) {
    console.error("[chat-history-io] 读取失败:", result.error);
    return {
      ok: false,
      reason: result.reason ?? "unknown",
      message: result.error || "导入聊天记录失败，请检查导出目录。",
    };
  }

  const parsed = parseImportedSession(result.content, targetProjectId, targetProjectDir);
  if ("error" in parsed) {
    console.error("[chat-history-io] JSON 解析失败");
    return { ok: false, reason: "json-invalid", message: parsed.error };
  }
  return {
    ok: true,
    session: parsed.session,
    importedMediaDir: result.importedMediaDir,
    dramaProject: parsed.dramaProject,
  };
}

export type ImportChatHistoryAsNewProjectResult =
  | {
      ok: true;
      session: StudioSessionState;
      newProjectId: string;
      importedMediaDir?: string;
      dramaProject?: DramaProject;
      reason?: ImportChatHistoryFailureReason;
      message?: string;
    }
  | {
      ok: false;
      reason: ImportChatHistoryFailureReason;
      message: string;
    };

export type MaterializedConversationArchiveProjectResult =
  | {
      ok: true;
      session: StudioSessionState;
      importedMediaDir?: string;
      dramaProject?: DramaProject;
      videoProject?: PersistedVideoProject;
      projectKind?: ConversationProjectKind;
      reason?: ImportChatHistoryFailureReason;
      message?: string;
    }
  | {
      ok: false;
      reason: ImportChatHistoryFailureReason;
      message: string;
    };

function inferArchiveProjectKind(
  project: unknown,
  fallback?: ConversationProjectKind,
): ConversationProjectKind | undefined {
  if (fallback) return fallback;
  if (!project || typeof project !== "object") return undefined;
  const record = project as Record<string, unknown>;
  if (
    record.projectKind === "script" ||
    record.projectKind === "adaptation" ||
    record.projectKind === "video"
  ) {
    return record.projectKind;
  }
  if (record.mode === "adaptation") return "adaptation";
  if (typeof record.currentStep === "number" || Array.isArray(record.scenes)) return "video";
  if (typeof record.currentStep === "string" || Array.isArray(record.episodes)) return "script";
  return undefined;
}

async function resolveArchiveHistoryFilePath(archiveDir: string): Promise<string | null> {
  const storage = window.electronAPI?.storage;
  if (!storage?.readText) return null;

  for (const fileName of ["chat-history.full.json", "chat-history.json"]) {
    const filePath = `${archiveDir.replace(/[\\/]+$/, "")}/${fileName}`;
    const result = await storage.readText(filePath);
    if (result.ok && result.exists && result.content) {
      return filePath;
    }
  }

  return null;
}

export async function materializeConversationArchiveProject(
  projectId: string,
): Promise<MaterializedConversationArchiveProjectResult> {
  const storage = window.electronAPI?.storage;
  if (!storage) {
    return { ok: false, reason: "unknown", message: "当前环境不支持自动导入存档。" };
  }

  const archive = await readConversationArchiveFull(projectId);
  if (!archive) {
    return { ok: false, reason: "chat-history-missing", message: "未找到可导入的存档目录。" };
  }

  const archiveDir = await resolveConversationArchiveDir(projectId);
  if (!archiveDir) {
    return { ok: false, reason: "chat-history-missing", message: "未找到可导入的存档目录。" };
  }

  const historyFilePath = await resolveArchiveHistoryFilePath(archiveDir);
  if (!historyFilePath) {
    return { ok: false, reason: "chat-history-missing", message: "存档目录中缺少聊天记录文件。" };
  }

  const targetProjectDir = await getProjectRootPath(projectId);
  const imported = await storage.importChatHistory({
    filePath: historyFilePath,
    targetProjectDir: targetProjectDir ?? undefined,
  });
  if (!imported.ok || !imported.content) {
    return {
      ok: false,
      reason: imported.reason ?? "unknown",
      message: imported.error || "自动导入存档失败，请检查存档内容。",
    };
  }

  const parsed = parseImportedSession(imported.content, projectId, targetProjectDir);
  if ("error" in parsed) {
    return { ok: false, reason: "json-invalid", message: parsed.error };
  }

  const projectKind = inferArchiveProjectKind(archive.project, archive.manifest?.projectKind);
  const dramaProject =
    projectKind === "script" || projectKind === "adaptation"
      ? ((archive.project as DramaProject | null | undefined) ?? parsed.dramaProject)
      : undefined;
  const videoProject =
    projectKind === "video" ? ((archive.project as PersistedVideoProject | null | undefined) ?? undefined) : undefined;

  if (projectKind === "video" && !videoProject) {
    return {
      ok: false,
      reason: "unknown",
      message: "视频项目存档缺少 project.json，无法自动恢复为完整项目。",
    };
  }

  if ((projectKind === "script" || projectKind === "adaptation") && !dramaProject) {
    return {
      ok: false,
      reason: "unknown",
      message: "剧本项目存档缺少可恢复的项目数据，无法自动恢复为完整项目。",
    };
  }

  return {
    ok: true,
    session: parsed.session,
    importedMediaDir: imported.importedMediaDir,
    dramaProject: dramaProject ? { ...dramaProject, id: projectId } : undefined,
    videoProject: videoProject ? { ...videoProject, id: projectId } : undefined,
    projectKind,
  };
}

/**
 * 全局导入：选择 chat-history.json，以全新 projectId 创建独立对话历史条目。
 * 媒体文件会复制到新项目目录，路径自动重写。
 * 若提供 filePath，跳过文件选择对话框直接使用该路径。
 */
export async function importChatHistoryAsNewProject(filePath?: string): Promise<ImportChatHistoryAsNewProjectResult> {
  const storage = window.electronAPI?.storage;
  if (!storage) {
    return { ok: false, reason: "unknown", message: "当前环境不支持导入聊天记录。" };
  }

  const resolvedFilePath = filePath ?? await storage.selectFile({
    filters: [{ name: "聊天记录", extensions: ["json"] }],
  });
  if (!resolvedFilePath) {
    return { ok: false, reason: "cancelled", message: "已取消选择导入文件。" };
  }

  const newProjectId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  const targetProjectDir = await getProjectRootPath(newProjectId);

  const result = await storage.importChatHistory({
    filePath: resolvedFilePath,
    targetProjectDir: targetProjectDir ?? undefined,
  });

  if (!result.ok || !result.content) {
    return {
      ok: false,
      reason: result.reason ?? "unknown",
      message: result.error || "导入聊天记录失败，请检查文件格式。",
    };
  }

  const parsed = parseImportedSession(result.content, newProjectId, targetProjectDir);
  if ("error" in parsed) {
    return { ok: false, reason: "json-invalid", message: parsed.error };
  }
  return {
    ok: true,
    session: parsed.session,
    newProjectId,
    importedMediaDir: result.importedMediaDir,
    dramaProject: parsed.dramaProject,
  };
}

export async function revealExportedChatHistoryFile(projectId: string): Promise<RevealExportedChatHistoryResult> {
  const storage = window.electronAPI?.storage;
  if (!storage) {
    return { ok: false, reason: "unknown", message: "当前环境不支持定位聊天记录文件。" };
  }

  const record = readLastExportedChatHistory(projectId);
  if (!record?.chatHistoryFilePath) {
    const archive = await readConversationArchiveFull(projectId);
    const archiveDir = archive ? await resolveConversationArchiveDir(projectId) : null;
    if (archiveDir) {
      const fullHistoryPath = `${archiveDir.replace(/[\\/]+$/, "")}/chat-history.full.json`;
      const archiveReadResult = await storage.readText(fullHistoryPath);
      const targetPath = archiveReadResult.ok && archiveReadResult.exists ? fullHistoryPath : archiveDir;
      const archiveOpenResult = await storage.openPath(targetPath);
      if (typeof archiveOpenResult === "string" && archiveOpenResult.trim()) {
        return {
          ok: false,
          reason: "open-failed",
          message: archiveOpenResult,
        };
      }
      return {
        ok: true,
        chatHistoryFilePath: targetPath,
      };
    }
    return {
      ok: false,
      reason: "never-exported",
      message: "当前项目还没有可定位的聊天记录导出文件，请先导出一次。",
    };
  }

  const readResult = await storage.readText(record.chatHistoryFilePath);
  if (!readResult.ok || !readResult.exists) {
    return {
      ok: false,
      reason: "missing-file",
      message: "最近一次导出的聊天记录文件不存在，请重新导出一次。",
    };
  }

  const openResult = await storage.openPath(record.chatHistoryFilePath);
  if (typeof openResult === "string" && openResult.trim()) {
    return {
      ok: false,
      reason: "open-failed",
      message: openResult,
    };
  }

  return {
    ok: true,
    chatHistoryFilePath: record.chatHistoryFilePath,
  };
}
