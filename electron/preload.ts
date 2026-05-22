/**
 * electron/preload.ts
 *
 * 安全桥接：通过 contextBridge 向渲染进程暴露 electronAPI，
 * 仅暴露当前产品仍在使用的最小必要接口。
 */

import { contextBridge, ipcRenderer } from "electron";
import fs from "node:fs";
import path from "node:path";

type BuiltinApiBundle = {
  geminiEndpoint?: string;
  geminiKey?: string;
  gptEndpoint?: string;
  gptKey?: string;
  claudeEndpoint?: string;
  claudeKey?: string;
  grokEndpoint?: string;
  grokKey?: string;
  seedreamEndpoint?: string;
  seedreamKey?: string;
  jimengEndpoint?: string;
  jimengKey?: string;
  tuziEndpoint?: string;
  tuziKey?: string;
  modelMappings?: Record<string, string>;
};

export interface JimengAPI {
  writeFile: (
    filePath: string,
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export interface StorageAPI {
  getDefaultPath: () => Promise<{ files: string; db: string }>;
  selectFolder: () => Promise<string | null>;
  openFolder: (folderPath: string) => Promise<void>;
  openPath: (targetPath: string) => Promise<string>;
  exists: (filePath: string) => boolean;
  writeText: (
    filePath: string,
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  saveBinaryFile: (params: {
    defaultFileName: string;
    filters?: { name: string; extensions: string[] }[];
    base64: string;
  }) => Promise<
    | { ok: true; cancelled: false; filePath: string }
    | { ok: true; cancelled: true; filePath: null }
    | { ok: false; cancelled: false; filePath: null; error?: string }
  >;
  writeBase64File: (params: {
    filePath: string;
    base64: string;
  }) => Promise<
    | { ok: true; filePath: string; error?: string }
    | { ok: false; filePath: null; error?: string }
  >;
  copyFile: (
    sourcePath: string,
    destPath: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readText: (filePath: string) => Promise<{
    ok: boolean;
    exists?: boolean;
    content?: string;
    error?: string;
  }>;
  readBase64: (filePath: string) => Promise<{
    ok: boolean;
    exists?: boolean;
    base64?: string;
    mimeType?: string;
    error?: string;
  }>;
  listDir: (dirPath: string) => Promise<{
    ok: boolean;
    entries: Array<{ name: string; isDirectory: boolean }>;
    error?: string;
  }>;
  deleteFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  deleteDir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
  selectFile: (params: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  exportChatHistory: (params: { sourceDir: string; destDir: string; sessionJson: string; fileName: string }) => Promise<
    | { ok: true; destDir: string; chatHistoryFilePath: string }
    | { ok: false; reason?: "write-failed" | "unknown"; destDir: string; chatHistoryFilePath: string; error?: string }
  >;
  importChatHistory: (params: { filePath: string; targetProjectDir?: string }) => Promise<
    | { ok: true; content?: string; importedMediaDir?: string }
    | {
        ok: false;
        reason?: "chat-history-missing" | "import-copy-failed" | "unknown";
        content?: string;
        importedMediaDir?: string;
        error?: string;
      }
  >;
}

export interface MediaAPI {
  extractVideoFrames: (params: {
    filePath: string;
    framePercents?: number[];
  }) => Promise<{
    ok: boolean;
    framePaths?: string[];
    error?: string;
  }>;
}

export interface FfmpegAPI {
  concatSegments: (params: {
    inputPaths: string[];
    outputPath: string;
  }) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
  burnSubtitles: (params: {
    inputPath: string;
    outputPath: string;
    subtitleEntries: Array<{ startMs: number; endMs: number; text: string }>;
  }) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
  smartConcat: (params: {
    inputPaths: string[];
    outputPath: string;
    transitions: Array<{ type: string; duration: number }>;
    addSubtitles: boolean;
    whisperModelPath?: string;
    language?: string;
  }) => Promise<{ ok: boolean; outputPath?: string; error?: string; subtitleWarning?: string }>;
}

export interface RuntimeAPI {
  builtinApiBundle: BuiltinApiBundle | null;
  builtinApiBundlePath: string;
  verifyBuiltinApiAdminPassword: (password: string) => Promise<boolean>;
}

function getEmbeddedBuiltinApiBundlePath(): string {
  if (process.defaultApp) {
    return path.resolve(__dirname, "..", "config", "builtin-api.json");
  }
  return path.join(path.dirname(process.execPath), "config", "builtin-api.json");
}

function getPortableBuiltinApiBundlePath(): string | null {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (!portableDir) return null;
  return path.join(portableDir, "config", "builtin-api.json");
}

function getBuiltinApiBundlePath(): string {
  return getPortableBuiltinApiBundlePath() || getEmbeddedBuiltinApiBundlePath();
}

function getBuiltinApiBundleCandidatePaths(): string[] {
  const portablePath = getPortableBuiltinApiBundlePath();
  const embeddedPath = getEmbeddedBuiltinApiBundlePath();
  const resourcesPath = path.join(process.resourcesPath, "config", "builtin-api.json");
  return portablePath ? [portablePath, embeddedPath, resourcesPath] : [embeddedPath, resourcesPath];
}

function readBuiltinApiBundle(): BuiltinApiBundle | null {
  for (const filePath of getBuiltinApiBundleCandidatePaths()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as BuiltinApiBundle;
    } catch {
      continue;
    }
  }
  return null;
}

const builtinApiBundle = readBuiltinApiBundle();
const builtinApiBundlePath = getBuiltinApiBundlePath();

const runtimeAPI: RuntimeAPI = {
  builtinApiBundle,
  builtinApiBundlePath,
  verifyBuiltinApiAdminPassword: (password: string) =>
    ipcRenderer.invoke("runtime:verifyBuiltinApiAdminPassword", password),
};

const jimengAPI: JimengAPI = {
  writeFile: (filePath, content) =>
    ipcRenderer.invoke("jimeng:writeFile", { filePath, content }),
};

contextBridge.exposeInMainWorld("electronAPI", {
  jimeng: jimengAPI,
  runtime: runtimeAPI,
  storage: {
    getDefaultPath: () => ipcRenderer.invoke("storage:getDefaultPath"),
    selectFolder: () => ipcRenderer.invoke("storage:selectFolder"),
    openFolder: (folderPath: string) =>
      ipcRenderer.invoke("storage:openFolder", folderPath),
    openPath: (targetPath: string) =>
      ipcRenderer.invoke("storage:openPath", targetPath),
    exists: (filePath: string) => {
      try {
        return fs.existsSync(path.normalize(filePath));
      } catch {
        return false;
      }
    },
    writeText: (filePath: string, content: string) =>
      ipcRenderer.invoke("storage:writeText", { filePath, content }),
    saveBinaryFile: (params: {
      defaultFileName: string;
      filters?: { name: string; extensions: string[] }[];
      base64: string;
    }) => ipcRenderer.invoke("storage:saveBinaryFile", params),
    writeBase64File: (params: { filePath: string; base64: string }) =>
      ipcRenderer.invoke("storage:writeBase64File", params),
    copyFile: (sourcePath: string, destPath: string) =>
      ipcRenderer.invoke("storage:copyFile", { sourcePath, destPath }),
    readText: (filePath: string) =>
      ipcRenderer.invoke("storage:readText", { filePath }),
    readBase64: (filePath: string) =>
      ipcRenderer.invoke("storage:readBase64", { filePath }),
    listDir: (dirPath: string) =>
      ipcRenderer.invoke("storage:listDir", dirPath),
    deleteFile: (filePath: string) =>
      ipcRenderer.invoke("storage:deleteFile", filePath),
    deleteDir: (dirPath: string) =>
      ipcRenderer.invoke("storage:deleteDir", dirPath),
    selectFile: (params: { filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke("storage:selectFile", params),
    exportChatHistory: (params: { sourceDir: string; destDir: string; sessionJson: string; fileName: string }) =>
      ipcRenderer.invoke("storage:exportChatHistory", params),
    importChatHistory: (params: { filePath: string; targetProjectDir?: string }) =>
      ipcRenderer.invoke("storage:importChatHistory", params),
  } as StorageAPI,
  media: {
    extractVideoFrames: (params: { filePath: string; framePercents?: number[] }) =>
      ipcRenderer.invoke("media:extractVideoFrames", params),
  } as MediaAPI,
  ffmpeg: {
    concatSegments: (params: { inputPaths: string[]; outputPath: string }) =>
      ipcRenderer.invoke("ffmpeg:concatSegments", params),
    burnSubtitles: (params: {
      inputPath: string;
      outputPath: string;
      subtitleEntries: Array<{ startMs: number; endMs: number; text: string }>;
    }) => ipcRenderer.invoke("ffmpeg:burnSubtitles", params),
    smartConcat: (params: {
      inputPaths: string[];
      outputPath: string;
      transitions: Array<{ type: string; duration: number }>;
      addSubtitles: boolean;
      subtitleEntries?: Array<{ startMs: number; endMs: number; text: string }>;
      whisperModelPath?: string;
      language?: string;
    }) => ipcRenderer.invoke("ffmpeg:smartConcat", params),
  } as FfmpegAPI,
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => listener(...args));
  },
  off: (channel: string, listener: (...args: unknown[]) => void) => {
    ipcRenderer.removeListener(channel, listener as Parameters<typeof ipcRenderer.removeListener>[1]);
  },
});
