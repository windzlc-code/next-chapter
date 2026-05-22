import type { EpisodeScript } from "@/types/drama";

export type LocalTextExportResult =
  | { status: "saved"; filePath?: string; filePaths?: string[] }
  | { status: "cancelled" };

function joinPath(base: string, ...segments: string[]): string {
  return [base.replace(/[\\/]+$/, ""), ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""))]
    .filter(Boolean)
    .join("/");
}

export function sanitizeExportFileName(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

export async function exportMarkdownTextLocally(
  fileName: string,
  content: string,
  preferredFilePath?: string,
): Promise<LocalTextExportResult> {
  const storage = window.electronAPI?.storage;
  if (preferredFilePath?.trim() && storage?.writeText) {
    const result = await storage.writeText(preferredFilePath.trim(), content);
    if (!result.ok) {
      throw new Error(result.error || "导出 Markdown 失败。");
    }
    return { status: "saved", filePath: preferredFilePath.trim() };
  }

  if (storage?.saveBinaryFile) {
    const binary = btoa(unescape(encodeURIComponent(content)));
    const result = await storage.saveBinaryFile({
      defaultFileName: fileName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
      base64: binary,
    });
    if (!result.ok) {
      throw new Error(result.error || "导出 Markdown 失败。");
    }
    if (result.cancelled) {
      return { status: "cancelled" };
    }
    return { status: "saved", filePath: result.filePath };
  }

  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return { status: "saved" };
}

export async function exportEpisodeMarkdownFilesLocally(
  episodes: EpisodeScript[],
  preferredDirectoryPath?: string,
): Promise<LocalTextExportResult> {
  if (!episodes.length) {
    return { status: "saved", filePaths: [] };
  }

  const storage = window.electronAPI?.storage;
  const directoryPath =
    preferredDirectoryPath?.trim() ||
    (storage?.selectFolder && storage.writeText ? await storage.selectFolder() : null);
  if (directoryPath && storage?.writeText) {
    const filePaths: string[] = [];
    for (const episode of [...episodes].sort((left, right) => left.number - right.number)) {
      const fileName = sanitizeExportFileName(
        `第${episode.number}集-${episode.title || "未命名"}.md`,
        `episode-${episode.number}.md`,
      );
      const filePath = joinPath(directoryPath, fileName);
      const result = await storage.writeText(filePath, episode.content ?? "");
      if (!result.ok) {
        throw new Error(result.error || `导出第 ${episode.number} 集失败。`);
      }
      filePaths.push(filePath);
    }
    return { status: "saved", filePaths };
  }

  for (const episode of [...episodes].sort((left, right) => left.number - right.number)) {
    const fileName = sanitizeExportFileName(
      `第${episode.number}集-${episode.title || "未命名"}.md`,
      `episode-${episode.number}.md`,
    );
    const blob = new Blob([episode.content ?? ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return { status: "saved" };
}
