/**
 * Electron 下解析“缓存文件”根目录：固定为应用根目录下的 files。
 * 非 Electron 返回 null。
 */
export async function getResolvedFilesStoragePath(): Promise<string | null> {
  if (
    typeof window !== "undefined" &&
    window.electronAPI?.storage?.getDefaultPath
  ) {
    const p = await window.electronAPI.storage.getDefaultPath();
    return p.files;
  }

  return null;
}
