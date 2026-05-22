/// <reference types="vite/client" />

/**
 * Electron API 类型声明（由 electron/preload.ts 暴露）
 */

interface BuiltinApiBundle {
  geminiEndpoint?: string;
  geminiKey?: string;
  aliyunEndpoint?: string;
  aliyunKey?: string;
  jimengEndpoint?: string;
  jimengKey?: string;
  viduEndpoint?: string;
  viduKey?: string;
  klingEndpoint?: string;
  klingKey?: string;
  modelMappings?: Record<string, string>;
}

interface ElectronAPI {
  jimeng?: {
    writeFile: (
      filePath: string,
      content: string,
    ) => Promise<{ ok: boolean; error?: string }>;
  };
  storage?: {
    getDefaultPath?: () => Promise<{ files: string; db: string }>;
    selectFolder?: () => Promise<string | null>;
    openFolder?: (folderPath: string) => Promise<void>;
    openPath?: (targetPath: string) => Promise<string>;
    exists?: (filePath: string) => boolean;
    writeText?: (
      filePath: string,
      content: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    saveBinaryFile?: (params: {
      defaultFileName: string;
      filters?: { name: string; extensions: string[] }[];
      base64: string;
    }) => Promise<
      | { ok: true; cancelled: false; filePath: string; error?: string }
      | { ok: true; cancelled: true; filePath: null; error?: string }
      | { ok: false; cancelled: false; filePath: null; error?: string }
    >;
    writeBase64File?: (params: {
      filePath: string;
      base64: string;
    }) => Promise<
      | { ok: true; filePath: string; error?: string }
      | { ok: false; filePath: null; error?: string }
    >;
    copyFile?: (
      sourcePath: string,
      destPath: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    readText?: (filePath: string) => Promise<{
      ok: boolean;
      exists?: boolean;
      content?: string;
      error?: string;
    }>;
    readBase64?: (filePath: string) => Promise<{
      ok: boolean;
      exists?: boolean;
      base64?: string;
      mimeType?: string;
      error?: string;
    }>;
    listDir?: (dirPath: string) => Promise<{
      ok: boolean;
      entries: Array<{ name: string; isDirectory: boolean }>;
      error?: string;
    }>;
    deleteFile?: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
    deleteDir?: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
    selectFile?: (params: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
    exportChatHistory?: (params: {
      sourceDir: string;
      destDir: string;
      sessionJson: string;
      fileName: string;
    }) => Promise<
      | { ok: true; destDir: string; chatHistoryFilePath: string; reason?: string; error?: string }
      | {
          ok: false;
          reason?: "write-failed" | "unknown";
          destDir: string;
          chatHistoryFilePath: string;
          error?: string;
        }
    >;
    importChatHistory?: (params: {
      filePath: string;
      targetProjectDir?: string;
    }) => Promise<
      | { ok: true; content?: string; importedMediaDir?: string; reason?: string; error?: string }
      | {
          ok: false;
          reason?: "directory-not-found" | "chat-history-missing" | "import-copy-failed" | "unknown";
          content?: string;
          importedMediaDir?: string;
          error?: string;
        }
    >;
  };
  media?: {
    extractVideoFrames: (params: {
      filePath: string;
      framePercents?: number[];
    }) => Promise<{
      ok: boolean;
      framePaths?: string[];
      error?: string;
    }>;
  };
  ffmpeg?: {
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
      subtitleEntries?: Array<{ startMs: number; endMs: number; text: string }>;
      whisperModelPath?: string;
      language?: string;
    }) => Promise<{ ok: boolean; outputPath?: string; error?: string; subtitleWarning?: string }>;
  };
  runtime?: {
    builtinApiBundle: BuiltinApiBundle | null;
    builtinApiBundlePath: string;
    verifyBuiltinApiAdminPassword: (password: string) => Promise<boolean>;
  };
  invoke?: (channel: string, ...args: unknown[]) => Promise<any>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
