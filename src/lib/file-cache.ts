import { getResolvedFilesStoragePath } from "@/lib/storage-path";

export async function getProjectsFilePath(): Promise<string | null> {
  const root = await getResolvedFilesStoragePath();
  if (!root) return null;
  return `${root.replace(/[\\/]+$/, "")}\\projects\\projects.json`;
}

export async function getProjectRootPath(projectId: string): Promise<string | null> {
  const root = await getResolvedFilesStoragePath();
  if (!root) return null;
  return `${root.replace(/[\\/]+$/, "")}\\projects\\${projectId}`;
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  if (!window.electronAPI?.storage?.readText) return null;
  const result = await window.electronAPI.storage.readText(filePath);
  if (!result.ok || !result.exists || !result.content) return null;
  try {
    return JSON.parse(result.content) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<boolean> {
  if (!window.electronAPI?.storage?.writeText) return false;
  const result = await window.electronAPI.storage.writeText(
    filePath,
    JSON.stringify(value, null, 2),
  );
  return !!result.ok;
}

/** 扫描 files/projects/ 目录，返回所有项目子目录 ID */
export async function scanProjectDirectoryIds(): Promise<string[]> {
  const root = await getResolvedFilesStoragePath();
  if (!root || !window.electronAPI?.storage?.listDir) return [];
  const projectsDir = `${root.replace(/[\\/]+$/, "")}\\projects`;
  const result = await window.electronAPI.storage.listDir(projectsDir);
  if (!result.ok) return [];
  return result.entries
    .filter((e) => e.isDirectory && e.name !== "codex-image-smoke")
    .map((e) => e.name);
}

/** 从 manifest.json 读取项目基础信息（用于重建孤立项目条目） */
export async function readProjectManifest(projectId: string): Promise<{
  projectId: string;
  title: string;
  updatedAt: string;
} | null> {
  const root = await getResolvedFilesStoragePath();
  if (!root) return null;
  const manifestPath = `${root.replace(/[\\/]+$/, "")}\\projects\\${projectId}\\texts\\manifest.json`;
  return readJsonFile(manifestPath);
}

/**
 * 将存储的本地路径重映射到当前运行时的 files 根目录。
 * 解决项目目录迁移后路径失效的问题。
 */
let cachedFilesRoot: string | null | undefined = undefined;
export async function remapLocalPathToCurrentRoot(localPath: string): Promise<string> {
  if (!localPath) return localPath;
  const projMatch = localPath.match(/[/\\]projects[/\\]/);
  if (!projMatch) return localPath;

  if (cachedFilesRoot === undefined) {
    cachedFilesRoot = await getResolvedFilesStoragePath();
  }
  if (!cachedFilesRoot) return localPath;

  const projIdx = localPath.search(/[/\\]projects[/\\]/);
  const relPart = localPath.substring(projIdx).replace(/\\/g, "/");
  const newPath = cachedFilesRoot.replace(/[\\/]+$/, "") + relPart;
  return newPath.replace(/\//g, "\\");
}
