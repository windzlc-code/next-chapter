/**
 * electron/main.ts
 *
 * Electron 主进程：
 *  - 通过 preload 向渲染进程暴露安全的 IPC API
 *  - 窗口管理 + 系统托盘
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");
const crypto = require("node:crypto");
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
} = require("electron");
const fs = require("node:fs");
const os = require("node:os");

// CJS 模式下 __dirname 由 Node.js 自动提供
// 注意：main.ts 被 esbuild 编译为 CJS，__dirname 在运行时可用
// __dirname 指向 electron/ 目录

// =========================== 配置 ===========================

const BUILTIN_API_ADMIN_PASSWORD_HASH =
  "d4f31b6def1e6e11148cbab15b400e91528ab18880b25225d9a9f840d4d0d192";
const STARTUP_LOG_PATH = path.join(
  process.env.TEMP || process.cwd(),
  "infinio-startup.log",
);

// =========================== 状态 ===========================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// ── 低配兼容初始化（必须在 app.whenReady() 之前完成）──────────────────

// 1. 固定 userData 到可写目录（%APPDATA%\InFinio），跨机器保证写权限
const INFINIO_USER_DATA = (() => {
  const p = path.join(os.homedir(), "AppData", "Roaming", "InFinio");
  try { fs.mkdirSync(p, { recursive: true }); app.setPath("userData", p); } catch { /* 回退默认 */ }
  return p;
})();

// 2. GPU 崩溃自动降级标志文件
const GPU_DISABLE_FLAG = path.join(INFINIO_USER_DATA, ".disable-gpu");
const GPU_DISABLED = fs.existsSync(GPU_DISABLE_FLAG);

// 3. 基础兼容性开关
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("safebrowsing-disable-auto-update");

// 4. 若上次 GPU 进程崩溃，本次启动切换为软件渲染（SwiftShader）
if (GPU_DISABLED) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.warn("[main] GPU 已禁用，使用软件渲染模式");
}

function getUserDataPath(): string {
  return app.getPath("userData");
}

/**
 * 默认缓存目录：与程序同级的 files/
 * - 开发：项目根目录/files（main 在 electron/，上一级为仓库根）
 * - 打包：可执行文件所在目录/files
 */
function getDefaultFilesDir(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged && portableDir) {
    return path.join(portableDir, "files");
  }
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "files");
  }
  return path.join(__dirname, "..", "files");
}

function getBundledFilesDir(): string | null {
  if (!app.isPackaged) return null;
  return path.join(process.resourcesPath, "files");
}

function copyMissingFiles(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) return;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingFiles(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(targetPath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function seedRuntimeFilesDirFromBundle(filesDir: string): void {
  const bundledFilesDir = getBundledFilesDir();
  if (!bundledFilesDir) return;

  const markerPath = path.join(filesDir, ".seeded-from-bundle-v1");
  if (fs.existsSync(markerPath)) return;

  try {
    const source = path.resolve(bundledFilesDir);
    const target = path.resolve(filesDir);
    if (source === target || !fs.existsSync(source)) return;

    copyMissingFiles(source, target);
    fs.writeFileSync(markerPath, new Date().toISOString(), "utf8");
    log("info", `seeded runtime files from bundled resources: ${source} -> ${target}`);
  } catch (error) {
    log("warn", `failed to seed bundled files: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =========================== 日志 ===========================

function log(level: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(STARTUP_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

process.on("uncaughtException", (error) => {
  log(
    "fatal",
    `uncaughtException: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }`,
  );
});

process.on("unhandledRejection", (reason) => {
  log(
    "fatal",
    `unhandledRejection: ${
      reason instanceof Error ? reason.stack || reason.message : String(reason)
    }`,
  );
});

function verifyBuiltinApiAdminPassword(password: string): boolean {
  if (typeof password !== "string" || !password) {
    return false;
  }
  const actualHash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(BUILTIN_API_ADMIN_PASSWORD_HASH, "hex");
  const actualBuffer = Buffer.from(actualHash, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getDreaminaCandidatePaths(): string[] {
  const homeDir = os.homedir();
  const executableName = process.platform === "win32" ? "dreamina.exe" : "dreamina";
  return Array.from(
    new Set([
      path.join(homeDir, "bin", executableName),
      path.join(homeDir, ".local", "bin", executableName),
      path.join(path.dirname(process.execPath), executableName),
    ]),
  );
}

// =========================== IPC 处理 ===========================

function setupIPC() {
  // 🛡️ 读取崩溃日志
  ipcMain.handle(
    "runtime:verifyBuiltinApiAdminPassword",
    (_event, password: string) => verifyBuiltinApiAdminPassword(password),
  );

  // 查询当前渲染模式（供设置页展示）
  ipcMain.handle("runtime:getGpuMode", () => ({
    softwareRendering: GPU_DISABLED,
    flagPath: GPU_DISABLE_FLAG,
  }));

  // 重置 GPU 降级标志，下次启动恢复硬件加速
  ipcMain.handle("runtime:resetGpuFlag", () => {
    try {
      if (fs.existsSync(GPU_DISABLE_FLAG)) fs.unlinkSync(GPU_DISABLE_FLAG);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("crash:getLogs", () => {
    const crashLogPath = path.join(getUserDataPath(), "crash-log.json");
    try {
      if (fs.existsSync(crashLogPath)) {
        const logs = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
        return { ok: true, logs };
      }
      return { ok: true, logs: [] };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "jimeng:writeFile",
    async (
      _event,
      { filePath, content }: { filePath: string; content: string },
    ) => {
      try {
        // Normalize path to handle mixed slashes
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(content, "base64"));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "dreamina:exec",
    async (
      _event,
      { args, stdin }: { args: string[]; stdin?: string },
    ) => {
      const executablePath = await resolveDreaminaExecutable();
      if (!executablePath) {
        return {
          ok: false,
          installed: false,
          error: "未检测到 dreamina CLI，请先执行官方安装脚本安装。",
        };
      }

      const safeArgs = Array.isArray(args)
        ? args.filter((value) => typeof value === "string" && value.length > 0)
        : [];

      return await new Promise((resolve) => {
        const proc = spawn(executablePath, safeArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        proc.on("error", (error: Error) => {
          resolve({
            ok: false,
            installed: true,
            path: executablePath,
            error: error.message,
            stdout,
            stderr,
          });
        });

        proc.on("close", (code: number | null) => {
          resolve({
            ok: code === 0,
            installed: true,
            path: executablePath,
            code: code ?? -1,
            stdout,
            stderr,
          });
        });

        if (typeof stdin === "string" && stdin.length > 0) {
          proc.stdin.write(stdin);
        }
        proc.stdin.end();
      });
    },
  );

  // ===== 存储路径 ============================

  ipcMain.handle("storage:getDefaultPath", () => {
    const filesDir = getDefaultFilesDir();
    try {
      fs.mkdirSync(filesDir, { recursive: true });
      seedRuntimeFilesDirFromBundle(filesDir);
    } catch {
      /* ignore */
    }
    const userData = app.getPath("userData");
    return {
      files: filesDir,
      db: path.join(userData, "db"),
    };
  });

  ipcMain.handle("storage:selectFolder", async () => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
      title: "选择存储文件夹",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("storage:openFolder", (_event, folderPath: string) => {
    const normalizedPath = path.normalize(folderPath);
    return shell.openPath(normalizedPath);
  });

  ipcMain.handle("storage:openPath", (_event, targetPath: string) => {
    const normalizedPath = path.normalize(targetPath);
    // 如果是文件，用 showItemInFolder 在资源管理器中高亮显示；否则直接打开目录
    try {
      const stat = fs.statSync(normalizedPath);
      if (stat.isFile()) {
        shell.showItemInFolder(normalizedPath);
        return Promise.resolve("");
      }
    } catch {
      // 路径不存在时回退到 openPath
    }
    return shell.openPath(normalizedPath);
  });

  ipcMain.handle(
    "storage:writeText",
    async (
      _event,
      { filePath, content }: { filePath: string; content: string },
    ) => {
      try {
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, content, "utf8");
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "storage:saveBinaryFile",
    async (
      _event,
      params: {
        defaultFileName: string;
        filters?: { name: string; extensions: string[] }[];
        base64: string;
      },
    ) => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showSaveDialog(mainWindow!, {
          title: "保存文件",
          defaultPath: params.defaultFileName,
          filters: Array.isArray(params.filters) ? params.filters : undefined,
        });
        if (result.canceled || !result.filePath) {
          return { ok: true, cancelled: true, filePath: null };
        }

        const normalizedPath = path.normalize(result.filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(params.base64, "base64"));
        return { ok: true, cancelled: false, filePath: normalizedPath };
      } catch (error) {
        return {
          ok: false,
          cancelled: false,
          filePath: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "storage:copyFile",
    async (
      _event,
      { sourcePath, destPath }: { sourcePath: string; destPath: string },
    ) => {
      try {
        const normalizedSource = path.normalize(sourcePath);
        const normalizedDest = path.normalize(destPath);
        fs.mkdirSync(path.dirname(normalizedDest), { recursive: true });
        fs.copyFileSync(normalizedSource, normalizedDest);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "storage:readText",
    async (_event, { filePath }: { filePath: string }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        if (!fs.existsSync(normalizedPath)) {
          return { ok: true, exists: false, content: "" };
        }
        return {
          ok: true,
          exists: true,
          content: fs.readFileSync(normalizedPath, "utf8"),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "storage:readBase64",
    async (_event, { filePath }: { filePath: string }) => {
      try {
        // Normalize path to handle mixed slashes
        const normalizedPath = path.normalize(filePath);

        if (!fs.existsSync(normalizedPath)) {
          return { ok: true, exists: false, base64: "" };
        }

        const ext = path.extname(normalizedPath).toLowerCase();
        const mimeType =
          ext === ".png"
            ? "image/png"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".gif"
                ? "image/gif"
                : ext === ".mp4"
                  ? "video/mp4"
                  : "image/jpeg";

        return {
          ok: true,
          exists: true,
          base64: fs.readFileSync(normalizedPath).toString("base64"),
          mimeType,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle("storage:listDir", (_event, dirPath: string) => {
    try {
      const normalizedPath = path.normalize(dirPath);
      if (!fs.existsSync(normalizedPath)) return { ok: true, entries: [] };
      const entries = fs.readdirSync(normalizedPath, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      }));
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("storage:deleteFile", (_event, filePath: string) => {
    try {
      const normalizedPath = path.normalize(filePath);
      if (!fs.existsSync(normalizedPath)) return { ok: true };
      fs.unlinkSync(normalizedPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("storage:deleteDir", (_event, dirPath: string) => {
    try {
      const normalizedPath = path.normalize(dirPath);
      if (!fs.existsSync(normalizedPath)) return { ok: true };
      fs.rmSync(normalizedPath, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // 选择单个文件对话框
  ipcMain.handle(
    "storage:selectFile",
    async (_event, { filters }: { filters?: { name: string; extensions: string[] }[] }) => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ["openFile"],
        filters: filters ?? [],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );

  // 导出聊天记录：写入聊天记录 JSON，并按当前协议复制媒体目录
  ipcMain.handle(
    "storage:exportChatHistory",
    async (
      _event,
      { sourceDir, destDir, sessionJson, fileName }: { sourceDir: string; destDir: string; sessionJson: string; fileName: string },
    ) => {
      try {
        const normalizedDest = path.normalize(destDir);
        const chatHistoryFilePath = path.join(normalizedDest, `${fileName}.json`);
        fs.mkdirSync(normalizedDest, { recursive: true });
        fs.writeFileSync(chatHistoryFilePath, sessionJson, "utf8");

        const normalizedSource = typeof sourceDir === "string" && sourceDir.trim().length > 0
          ? path.normalize(sourceDir)
          : "";
        if (normalizedSource && fs.existsSync(normalizedSource)) {
          const mediaDir = path.join(normalizedDest, "media");
          fs.cpSync(normalizedSource, mediaDir, { recursive: true });
        }

        return { ok: true, destDir: normalizedDest, chatHistoryFilePath };
      } catch (error) {
        return {
          ok: false,
          reason: "write-failed",
          destDir: "",
          chatHistoryFilePath: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // 导入聊天记录：直接读取用户选择的 chat-history.json，并把同级 media/ 复制回当前项目目录
  ipcMain.handle(
    "storage:importChatHistory",
    async (_event, { filePath, targetProjectDir }: { filePath: string; targetProjectDir?: string }) => {
      try {
        const normalizedFilePath = path.normalize(filePath);
        if (!fs.existsSync(normalizedFilePath)) {
          return { ok: false, reason: "chat-history-missing", error: "chat-history.json 文件不存在" };
        }

        const content = fs.readFileSync(normalizedFilePath, "utf8");
        const normalizedDir = path.dirname(normalizedFilePath);

        let importedMediaDir: string | undefined;
        const mediaDir = path.join(normalizedDir, "media");
        const normalizedTargetProjectDir = typeof targetProjectDir === "string" && targetProjectDir.trim()
          ? path.normalize(targetProjectDir)
          : "";
        if (normalizedTargetProjectDir && fs.existsSync(mediaDir)) {
          try {
            fs.mkdirSync(normalizedTargetProjectDir, { recursive: true });
            fs.cpSync(mediaDir, normalizedTargetProjectDir, { recursive: true, force: true });
            importedMediaDir = normalizedTargetProjectDir;
          } catch (error) {
            return {
              ok: false,
              reason: "import-copy-failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        return { ok: true, content, importedMediaDir };
      } catch (error) {
        return { ok: false, reason: "unknown", error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // =========================== Agent IPC ===========================
  // Manages QueryEngine instances keyed by sessionId.
  // Renders invoke agent:submitMessage → receives streamed agent:event messages.

  const { QueryEngine } = require("../src/lib/agent/query-engine");

  const agentSessions = new Map<string, InstanceType<typeof QueryEngine>>();

  ipcMain.handle(
    "agent:callModelApi",
    async (
      _event,
      {
        url,
        apiKey,
        requestParams,
      }: {
        url: string;
        apiKey: string;
        requestParams: Record<string, unknown>;
      },
    ) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestParams),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return {
            ok: false,
            error: `Model request failed (${response.status}): ${text.slice(0, 300) || response.statusText}`,
          };
        }

        return {
          ok: true,
          data: await response.json(),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // Streaming version: sends text deltas back via agent:stream-delta events
  ipcMain.handle(
    "agent:callModelApiStream",
    async (
      event,
      {
        url,
        apiKey,
        requestParams,
        streamId,
      }: {
        url: string;
        apiKey: string;
        requestParams: Record<string, unknown>;
        streamId: string;
      },
    ) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ ...requestParams, stream: true }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return {
            ok: false,
            error: `Model request failed (${response.status}): ${text.slice(0, 300) || response.statusText}`,
          };
        }

        const reader = (response.body as any)?.getReader();
        if (!reader) return { ok: false, error: "No response body" };

        const decoder = new TextDecoder();
        let buffer = "";
        let accText = "";
        const contentBlocks: any[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason = "end_turn";
        let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (event.sender.isDestroyed()) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            let evt: any;
            try { evt = JSON.parse(data); } catch { continue; }

            const type = evt.type as string;
            if (type === "content_block_start") {
              if (evt.content_block?.type === "tool_use") {
                currentToolUse = { id: evt.content_block.id, name: evt.content_block.name, inputJson: "" };
              }
            } else if (type === "content_block_delta") {
              if (evt.delta?.type === "text_delta") {
                const chunk = evt.delta.text as string;
                accText += chunk;
                if (!event.sender.isDestroyed()) {
                  event.sender.send("agent:stream-delta", { streamId, delta: chunk });
                }
              } else if (evt.delta?.type === "input_json_delta" && currentToolUse) {
                currentToolUse.inputJson += evt.delta.partial_json ?? "";
              }
            } else if (type === "content_block_stop") {
              if (currentToolUse) {
                let input: any = {};
                try { input = JSON.parse(currentToolUse.inputJson); } catch { /* ignore */ }
                contentBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input });
                currentToolUse = null;
              }
            } else if (type === "message_delta") {
              if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
            } else if (type === "message_start") {
              if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens;
            }
          }
        }

        if (accText) contentBlocks.unshift({ type: "text", text: accText });

        return {
          ok: true,
          data: {
            id: "stream",
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: requestParams.model,
            stop_reason: stopReason,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    "agent:submitMessage",
    async (
      event,
      {
        sessionId,
        prompt,
        config,
      }: {
        sessionId: string;
        prompt: string;
        config: {
          apiKey: string;
          baseUrl?: string;
          model?: string;
          systemPrompt?: string;
          appendSystemPrompt?: string;
          maxTurns?: number;
          maxBudgetUsd?: number;
        };
      },
    ) => {
      // Reuse existing session or create a new one
      let engine = agentSessions.get(sessionId);
      if (!engine) {
        engine = new QueryEngine(config);
        agentSessions.set(sessionId, engine);
      } else {
        // Update API key / model if provided
        if (config.apiKey) engine["config"].apiKey = config.apiKey;
        if (config.model) engine.setModel(config.model);
      }

      try {
        for await (const sdkMsg of engine.submitMessage(prompt)) {
          if (event.sender.isDestroyed()) break;
          event.sender.send("agent:event", { sessionId, message: sdkMsg });
        }
      } catch (err) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:event", {
            sessionId,
            message: {
              type: "result",
              subtype: "success",
              isError: true,
              result: String(err),
              durationMs: 0,
              numTurns: 0,
              sessionId,
              totalCostUsd: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              uuid: crypto.randomUUID(),
            },
          });
        }
      }

      return { ok: true };
    },
  );

  ipcMain.handle("agent:interrupt", (_event, { sessionId }: { sessionId: string }) => {
    agentSessions.get(sessionId)?.interrupt();
    return { ok: true };
  });

  ipcMain.handle("agent:clearSession", (_event, { sessionId }: { sessionId: string }) => {
    agentSessions.delete(sessionId);
    return { ok: true };
  });

  // =========================== Tool Execute IPC ===========================
  // Unified handler for all built-in tools that require main-process access.

  const glob = require("fast-glob");
  const { exec, execFile, spawn } = require("node:child_process");
  const { promisify } = require("node:util");
  const execAsync = promisify(exec);
  const execFileAsync = promisify(execFile);

  async function resolveBinaryExecutable(binaryName: string): Promise<string | null> {
    const executableName =
      process.platform === "win32" && !binaryName.toLowerCase().endsWith(".exe")
        ? `${binaryName}.exe`
        : binaryName;

    // 优先使用打包进 extraResources 的 vendor/ffmpeg
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.resolve(__dirname, "..");
    const vendorCandidate = path.join(resourcesDir, "vendor", "ffmpeg", executableName);
    if (fs.existsSync(vendorCandidate)) return vendorCandidate;

    // 开发环境回退：系统安装路径
    const bundledDir = "C:\\Program Files\\ffmpeg\\bin";
    const directCandidate = path.join(bundledDir, executableName);
    if (fs.existsSync(directCandidate)) return directCandidate;

    try {
      const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(lookupCommand, [binaryName], {
        windowsHide: true,
      });
      return (
        String(stdout)
          .split(/\r?\n/)
          .map((line: string) => line.trim())
          .find((line: string) => !!line && fs.existsSync(line)) || null
      );
    } catch {
      return null;
    }
  }

  async function resolveDreaminaExecutable(): Promise<string | null> {
    for (const candidate of getDreaminaCandidatePaths()) {
      if (fs.existsSync(candidate)) return candidate;
    }

    try {
      const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(
        lookupCommand,
        ["dreamina"],
        { windowsHide: true },
      );
      return String(stdout)
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .find((line: string) => !!line && fs.existsSync(line)) || null;
    } catch {
      return null;
    }
  }

  ipcMain.handle(
    "media:extractVideoFrames",
    async (
      _event,
      {
        filePath,
        framePercents,
      }: {
        filePath: string;
        framePercents?: number[];
      },
    ) => {
      try {
        const normalizedPath = path.normalize(String(filePath || ""));
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
          return { ok: false, error: `Video file not found: ${normalizedPath}` };
        }

        const ffmpegPath = await resolveBinaryExecutable("ffmpeg");
        const ffprobePath = await resolveBinaryExecutable("ffprobe");
        if (!ffmpegPath || !ffprobePath) {
          return { ok: false, error: "ffmpeg or ffprobe is not available" };
        }

        const probe = await execFileAsync(
          ffprobePath,
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            normalizedPath,
          ],
          {
            windowsHide: true,
          },
        );

        const duration = Number.parseFloat(String(probe.stdout || "").trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          return { ok: false, error: "Failed to read video duration" };
        }

        const percents = Array.isArray(framePercents) && framePercents.length
          ? framePercents
              .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
              .map((value) => Math.min(100, Math.max(0, value)))
          : [0, 15, 30, 50, 70, 90];

        const frameDir = path.join(
          app.getPath("temp"),
          "infinio-video-frames",
          crypto.randomUUID(),
        );
        fs.mkdirSync(frameDir, { recursive: true });

        const framePaths: string[] = [];
        for (let index = 0; index < percents.length; index += 1) {
          const percent = percents[index] ?? 0;
          const seconds = Math.max(
            0,
            Math.min(duration * (percent / 100), Math.max(duration - 0.1, 0)),
          );
          const outputPath = path.join(frameDir, `frame-${index + 1}.jpg`);
          await execFileAsync(
            ffmpegPath,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-ss",
              seconds.toFixed(3),
              "-i",
              normalizedPath,
              "-frames:v",
              "1",
              outputPath,
            ],
            {
              windowsHide: true,
            },
          );

          if (fs.existsSync(outputPath)) {
            framePaths.push(outputPath);
          }
        }

        if (!framePaths.length) {
          return { ok: false, error: "No frames were extracted" };
        }

        return {
          ok: true,
          framePaths,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // ── ffmpeg: 片段视频拼接 ──────────────────────────────────────────────
  ipcMain.handle(
    "ffmpeg:concatSegments",
    async (
      _event,
      {
        inputPaths,
        outputPath,
      }: {
        inputPaths: string[];
        outputPath: string;
      },
    ) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg 未找到，请确认已安装或重新打包。" };

        const validPaths = inputPaths
          .map((p: string) => path.normalize(p))
          .filter((p: string) => fs.existsSync(p));
        if (validPaths.length === 0) return { ok: false, error: "没有可用的输入视频文件。" };

        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });

        // 写 concat 列表文件
        const listFile = path.join(app.getPath("temp"), `infinio-concat-${Date.now()}.txt`);
        const listContent = validPaths.map((p: string) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
        fs.writeFileSync(listFile, listContent, "utf8");

        await execFileAsync(
          ffmpegBin,
          ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", path.normalize(outputPath)],
          { windowsHide: true },
        );

        try { fs.unlinkSync(listFile); } catch { /* 清理失败不影响结果 */ }

        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // ── ffmpeg: 烧录字幕 ──────────────────────────────────────────────────
  ipcMain.handle(
    "ffmpeg:burnSubtitles",
    async (
      _event,
      {
        inputPath,
        outputPath,
        subtitleEntries,
      }: {
        inputPath: string;
        outputPath: string;
        subtitleEntries: Array<{ startMs: number; endMs: number; text: string }>;
      },
    ) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg 未找到。" };

        const normalizedInput = path.normalize(inputPath);
        if (!fs.existsSync(normalizedInput)) return { ok: false, error: `输入文件不存在: ${normalizedInput}` };

        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });

        // 生成 SRT 文件
        const srtFile = path.join(app.getPath("temp"), `infinio-subs-${Date.now()}.srt`);
        const toSrtTime = (ms: number) => {
          const h = Math.floor(ms / 3600000);
          const m = Math.floor((ms % 3600000) / 60000);
          const s = Math.floor((ms % 60000) / 1000);
          const ms2 = ms % 1000;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms2).padStart(3, "0")}`;
        };
        const srtContent = subtitleEntries
          .map((entry: { startMs: number; endMs: number; text: string }, i: number) =>
            `${i + 1}\n${toSrtTime(entry.startMs)} --> ${toSrtTime(entry.endMs)}\n${entry.text}\n`,
          )
          .join("\n");
        fs.writeFileSync(srtFile, srtContent, "utf8");

        // 烧录字幕（使用 subtitles filter，路径需转义冒号）
        const escapedSrt = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:");
        await execFileAsync(
          ffmpegBin,
          ["-y", "-i", normalizedInput, "-vf", `subtitles='${escapedSrt}'`, "-c:a", "copy", path.normalize(outputPath)],
          { windowsHide: true },
        );

        try { fs.unlinkSync(srtFile); } catch { /* 清理失败不影响结果 */ }

        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // ── SRT 后处理：过滤非对话内容 + 去重 + 修复重叠时间戳 ──────────────────
  function cleanSrtDialogue(srtContent: string): string {
    const parseMs = (ts: string): number => {
      const [h, m, rest] = ts.split(":");
      const [s, ms] = rest.split(",");
      return +h * 3600000 + +m * 60000 + +s * 1000 + +ms;
    };
    const fmtMs = (ms: number): string => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      const r = ms % 1000;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
    };

    const blocks = srtContent.trim().split(/\n\n+/);
    const entries: Array<{ startMs: number; endMs: number; text: string }> = [];

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 3) continue;
      const textLines = lines.slice(2).join("\n").trim();
      // 过滤括号内容（音效、幻觉、片头字幕等）
      if (/^[\s(（\[【♪♫]*[\)）\]】♪♫\s]*$/.test(textLines)) continue;
      if (/^[\s(（\[【].*[\)）\]】]\s*$/.test(textLines)) continue;
      // 过滤纯标点或空内容
      if (textLines.replace(/[\s\p{P}]/gu, "").length < 1) continue;
      const [startStr, endStr] = lines[1].split(" --> ");
      entries.push({ startMs: parseMs(startStr.trim()), endMs: parseMs(endStr.trim()), text: textLines });
    }

    // 去重：时间戳重叠且文本相同或被包含 → 跳过
    const deduped: typeof entries = [];
    for (const entry of entries) {
      const prev = deduped[deduped.length - 1];
      if (prev && entry.startMs < prev.endMs) {
        if (entry.text === prev.text || prev.text.includes(entry.text)) continue;
      }
      deduped.push(entry);
    }

    // 修复重叠时间戳：确保每条结束 <= 下一条开始
    for (let i = 0; i < deduped.length - 1; i++) {
      if (deduped[i].endMs > deduped[i + 1].startMs) {
        deduped[i].endMs = deduped[i + 1].startMs;
      }
    }

    return deduped.map((e, i) => `${i + 1}\n${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}\n${e.text}`).join("\n\n") + "\n";
  }

  // ── ffmpeg: AI 智能拼接（xfade 转场 + whisper 字幕识别）────────────────
  ipcMain.handle(
    "ffmpeg:smartConcat",
    async (
      _event,
      {
        inputPaths,
        outputPath,
        transitions,
        addSubtitles,
        subtitleEntries,
        whisperModelPath,
        language,
      }: {
        inputPaths: string[];
        outputPath: string;
        transitions: Array<{ type: string; duration: number }>;
        addSubtitles: boolean;
        subtitleEntries?: Array<{ startMs: number; endMs: number; text: string }>;
        whisperModelPath?: string;
        language?: string;
      },
    ) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg 未找到。" };

        const validPaths = inputPaths
          .map((p: string) => path.normalize(p))
          .filter((p: string) => fs.existsSync(p));
        if (validPaths.length === 0) return { ok: false, error: "没有可用的输入视频文件。" };

        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });

        const tempDir = app.getPath("temp");
        const ts = Date.now();

        // ── 步骤1：用 ffprobe 获取每段时长 ──────────────────────────────
        const ffprobeBin = await resolveBinaryExecutable("ffprobe");
        const durations: number[] = [];
        if (ffprobeBin) {
          for (const vp of validPaths) {
            try {
              const { stdout } = await execFileAsync(
                ffprobeBin,
                ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", vp],
                { windowsHide: true },
              );
              durations.push(parseFloat(stdout.trim()) || 5);
            } catch {
              durations.push(5);
            }
          }
        } else {
          validPaths.forEach(() => durations.push(5));
        }

        // ── 步骤2：构建 xfade 滤镜图 ────────────────────────────────────
        // 每段转场时长默认 0.5s，offset = 累计时长 - 转场时长
        const concatOutput = path.join(tempDir, `infinio-smart-concat-${ts}.mp4`);

        if (validPaths.length === 1) {
          // 单段直接复制
          await execFileAsync(
            ffmpegBin,
            ["-y", "-i", validPaths[0], "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", concatOutput],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 },
          );
        } else {
          // 构建 xfade 滤镜链
          const effectiveTransitions = transitions.slice(0, validPaths.length - 1);
          while (effectiveTransitions.length < validPaths.length - 1) {
            effectiveTransitions.push({ type: "fade", duration: 0.5 });
          }

          const inputArgs: string[] = [];
          for (const vp of validPaths) {
            inputArgs.push("-i", vp);
          }

          // 计算每个 xfade 的 offset（前段结束时间 - 转场时长）
          const offsets: number[] = [];
          let cumulative = 0;
          for (let i = 0; i < validPaths.length - 1; i++) {
            cumulative += durations[i];
            const xfadeDur = effectiveTransitions[i].duration;
            offsets.push(Math.max(0, cumulative - xfadeDur));
            // 下一段的起始时间要减去转场重叠部分
            cumulative -= xfadeDur;
          }

          // 构建滤镜图：[0:v][1:v]xfade=...,offset=...[v01]; [v01][2:v]xfade=...
          let filterGraph = "";
          let prevLabel = "[0:v]";
          for (let i = 0; i < validPaths.length - 1; i++) {
            const t = effectiveTransitions[i];
            const outLabel = i === validPaths.length - 2 ? "[vout]" : `[v${i + 1}]`;
            filterGraph += `${prevLabel}[${i + 1}:v]xfade=transition=${t.type}:duration=${t.duration}:offset=${offsets[i].toFixed(3)}${outLabel}`;
            if (i < validPaths.length - 2) filterGraph += ";";
            prevLabel = outLabel;
          }

          // 音频：acrossfade 链
          let audioFilter = "";
          let prevALabel = "[0:a]";
          for (let i = 0; i < validPaths.length - 1; i++) {
            const t = effectiveTransitions[i];
            const outALabel = i === validPaths.length - 2 ? "[aout]" : `[a${i + 1}]`;
            audioFilter += `${prevALabel}[${i + 1}:a]acrossfade=d=${t.duration}${outALabel}`;
            if (i < validPaths.length - 2) audioFilter += ";";
            prevALabel = outALabel;
          }

          const fullFilter = audioFilter ? `${filterGraph};${audioFilter}` : filterGraph;
          const mapArgs = audioFilter
            ? ["-map", "[vout]", "-map", "[aout]"]
            : ["-map", "[vout]", "-map", "0:a?"];

          await execFileAsync(
            ffmpegBin,
            [
              "-y",
              ...inputArgs,
              "-filter_complex", fullFilter,
              ...mapArgs,
              "-c:v", "libx264", "-preset", "fast", "-crf", "18",
              "-pix_fmt", "yuv420p",
              "-c:a", "aac", "-b:a", "192k",
              concatOutput,
            ],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 },
          );
        }

        if (!fs.existsSync(concatOutput)) {
          return { ok: false, error: "视频拼接失败，输出文件未生成。" };
        }

        // ── 步骤3：字幕处理 ──────────────────────────────────────────────────
        let finalOutput = path.normalize(outputPath);

        const burnSrt = async (srtEntries: Array<{ startMs: number; endMs: number; text: string }>) => {
          const toSrtTime = (ms: number) => {
            const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
            const s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
          };
          const srtContent = srtEntries.map((e, i) => `${i + 1}\n${toSrtTime(e.startMs)} --> ${toSrtTime(e.endMs)}\n${e.text}`).join("\n\n") + "\n";
          const srtFile = path.join(tempDir, `infinio-subs-${ts}.srt`);
          fs.writeFileSync(srtFile, srtContent, "utf8");
          const subtitledOutput = path.join(tempDir, `infinio-subtitled-${ts}.mp4`);
          const escapedSrt = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:");
          await execFileAsync(
            ffmpegBin,
            ["-y", "-i", concatOutput,
              "-vf", `subtitles='${escapedSrt}':force_style='FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=1,Alignment=2'`,
              "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
              "-c:a", "copy", subtitledOutput],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 },
          );
          try { fs.unlinkSync(srtFile); } catch { /* ignore */ }
          return subtitledOutput;
        };

        if (addSubtitles) {
          // whisper 语音识别：JSON 格式输出，精确去重合并
          const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
          const resolvedModelPath = whisperModelPath
            ? path.normalize(whisperModelPath)
            : path.join(resourcesDir, "vendor", "ffmpeg", "ggml-small-q5_1.bin");

          if (!fs.existsSync(resolvedModelPath)) {
            fs.copyFileSync(concatOutput, finalOutput);
            try { fs.unlinkSync(concatOutput); } catch { /* ignore */ }
            return { ok: true, outputPath: finalOutput, subtitleWarning: `whisper 模型未找到（${resolvedModelPath}），已输出无字幕版本。` };
          }

          const modelBasename = `ggml-model-${ts}.bin`;
          const modelInTemp = path.join(tempDir, modelBasename);
          const jsonBasename = `infinio-whisper-${ts}.json`;
          const jsonOutput = path.join(tempDir, jsonBasename);
          fs.copyFileSync(resolvedModelPath, modelInTemp);

          try {
            await execFileAsync(
              ffmpegBin,
              ["-y", "-i", concatOutput,
                "-af", `whisper=model=${modelBasename}:language=${language || "zh"}:format=json:destination=${jsonBasename}:max_len=15:queue=1`,
                "-f", "null", "-"],
              { windowsHide: true, maxBuffer: 100 * 1024 * 1024, timeout: 300_000, cwd: tempDir },
            );
          } catch { /* 失败时 jsonOutput 不存在，后续降级 */ }
          try { fs.unlinkSync(modelInTemp); } catch { /* ignore */ }

          let srtEntries: Array<{ startMs: number; endMs: number; text: string }> = [];
          if (fs.existsSync(jsonOutput)) {
            const jsonLines = fs.readFileSync(jsonOutput, "utf8");
            try { fs.unlinkSync(jsonOutput); } catch { /* ignore */ }

            // 解析 JSON 行，三步过滤：括号幻觉 → 被包含重复 → 紧邻合并
            const raw = jsonLines.trim().split("\n")
              .map((l) => { try { return JSON.parse(l.trim()) as { start: number; end: number; text: string }; } catch { return null; } })
              .filter((e): e is { start: number; end: number; text: string } => !!e);

            // Step 1: 过滤括号内容（音效/幻觉）
            let entries = raw.filter((e) => {
              const t = e.text.trim();
              if (/^[\s(（\[【♪♫]*[\)）\]】♪♫\s]*$/.test(t)) return false;
              if (/^[\s(（\[【].*[\)）\]】]\s*$/.test(t)) return false;
              if (t.replace(/[\s\p{P}]/gu, "").length < 1) return false;
              return true;
            });

            // Step 2: 删除被其他相同文本条目完全包含的条目（时间窗口重叠幻觉）
            entries = entries.filter((e, i) => {
              const selfDur = e.end - e.start;
              return !entries.some((other, j) => {
                if (j === i || other.text !== e.text) return false;
                const overlap = Math.max(0, Math.min(e.end, other.end) - Math.max(e.start, other.start));
                return overlap / selfDur >= 0.95 && (other.end - other.start) > selfDur;
              });
            });

            // Step 3: 合并相邻文本相同且 gap < 200ms 的条目
            const merged: Array<{ start: number; end: number; text: string }> = [];
            for (const e of entries) {
              const prev = merged[merged.length - 1];
              if (prev && e.text === prev.text && (e.start - prev.end) < 200) {
                prev.end = Math.max(prev.end, e.end);
                continue;
              }
              merged.push({ ...e });
            }

            // Step 4: 修复时间戳重叠
            for (let i = 0; i < merged.length - 1; i++) {
              if (merged[i].end > merged[i + 1].start) merged[i].end = merged[i + 1].start;
            }

            // Step 5: 频率幻觉过滤 — 同一文本（≥4字）在非重叠时间段出现 ≥3 次视为幻觉循环
            const textFreq = new Map<string, number>();
            for (const e of merged) textFreq.set(e.text.trim(), (textFreq.get(e.text.trim()) ?? 0) + 1);
            const deHallucinated = merged.filter((e) => {
              const key = e.text.trim();
              const charLen = key.replace(/\s/g, "").length;
              return charLen <= 3 || (textFreq.get(key) ?? 0) < 3;
            });

            // Step 6: 文本内部重复短语过滤 — "ABAB" 或 "AB,AB" 模式为幻觉特征
            const deRepeat = deHallucinated.filter((e) => {
              const t = e.text.trim();
              const parts = t.split(/[,，。.、；;]/).map((p) => p.trim()).filter(Boolean);
              if (parts.length >= 2 && parts[0] === parts[1]) return false;
              const clean = t.replace(/[,，。.、；;\s]/g, "");
              const half = Math.floor(clean.length / 2);
              if (half >= 3 && clean.slice(0, half) === clean.slice(half)) return false;
              return true;
            });

            srtEntries = deRepeat.map((e) => ({ startMs: e.start, endMs: e.end, text: e.text }));
          }

          if (srtEntries.length > 0) {
            try {
              const subtitledOutput = await burnSrt(srtEntries);
              if (fs.existsSync(subtitledOutput)) {
                fs.copyFileSync(subtitledOutput, finalOutput);
                try { fs.unlinkSync(subtitledOutput); } catch { /* ignore */ }
              } else {
                fs.copyFileSync(concatOutput, finalOutput);
              }
            } catch {
              fs.copyFileSync(concatOutput, finalOutput);
            }
          } else {
            fs.copyFileSync(concatOutput, finalOutput);
          }
        } else if (subtitleEntries && subtitleEntries.length > 0) {
          // 分镜台词字幕（备用路径）
          try {
            const subtitledOutput = await burnSrt(subtitleEntries.map((e) => ({ startMs: e.startMs, endMs: e.endMs, text: e.text })));
            if (fs.existsSync(subtitledOutput)) {
              fs.copyFileSync(subtitledOutput, finalOutput);
              try { fs.unlinkSync(subtitledOutput); } catch { /* ignore */ }
            } else {
              fs.copyFileSync(concatOutput, finalOutput);
            }
          } catch {
            fs.copyFileSync(concatOutput, finalOutput);
          }
        } else {
          fs.copyFileSync(concatOutput, finalOutput);
        }

        try { fs.unlinkSync(concatOutput); } catch { /* ignore */ }

        return { ok: true, outputPath: finalOutput };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    "tool:execute",
    async (_event, { toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
      try {
        switch (toolName) {
          // ── FileRead ──────────────────────────────────────────────────
          case "FileRead": {
            const filePath = String(args.filePath);
            const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
            const ext = path.extname(filePath).toLowerCase();
            if (IMAGE_EXTS.has(ext)) {
              if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
              const base64 = fs.readFileSync(filePath).toString("base64");
              return { content: `[Image: data:image/${ext.slice(1)};base64,${base64}]` };
            }
            if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
            const raw = fs.readFileSync(filePath, "utf8");
            const lines = raw.split("\n");
            const offset = Number(args.offset ?? 0);
            const limit = args.limit ? Number(args.limit) : undefined;
            const slice = limit ? lines.slice(offset, offset + limit) : lines.slice(offset);
            const numbered = slice
              .map((line: string, i: number) => `${offset + i + 1}\t${line}`)
              .join("\n");
            return { content: numbered };
          }

          // ── FileWrite ─────────────────────────────────────────────────
          case "FileWrite": {
            const filePath = String(args.filePath);
            const content = String(args.content ?? "");
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf8");
            return { ok: true };
          }

          // ── FileEdit ──────────────────────────────────────────────────
          case "FileEdit": {
            const filePath = String(args.filePath);
            if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
            let content = fs.readFileSync(filePath, "utf8");
            const oldStr = String(args.oldString);
            const newStr = String(args.newString ?? "");
            const replaceAll = Boolean(args.replaceAll);
            if (!content.includes(oldStr)) {
              return { error: `old_string not found in ${filePath}` };
            }
            if (replaceAll) {
              content = content.split(oldStr).join(newStr);
            } else {
              const idx = content.indexOf(oldStr);
              content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
            }
            fs.writeFileSync(filePath, content, "utf8");
            return { ok: true, message: `Edited ${filePath}` };
          }

          // ── Glob ──────────────────────────────────────────────────────
          case "Glob": {
            const pattern = String(args.pattern);
            const cwd = args.path ? String(args.path) : process.cwd();
            const files: string[] = await glob(pattern, {
              cwd,
              absolute: true,
              dot: false,
              ignore: ["**/node_modules/**", "**/.git/**"],
            });
            // Sort by mtime descending
            const withStat = files.map((f: string) => ({
              f,
              mtime: fs.statSync(f).mtimeMs,
            }));
            withStat.sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
            return { files: withStat.map((x: { f: string }) => x.f) };
          }

          // ── Grep ──────────────────────────────────────────────────────
          case "Grep": {
            const pattern = String(args.pattern);
            const searchPath = args.path ? String(args.path) : process.cwd();
            const globFilter = args.glob ? String(args.glob) : undefined;
            const outputMode = String(args.output_mode ?? "files_with_matches");
            const caseInsensitive = Boolean(args["-i"]);
            const contextLines = Number(args.context ?? 0);
            const headLimit = Number(args.head_limit ?? 250);

            // Use ripgrep if available, else fallback to node regex
            let rgCmd = `rg --no-heading`;
            if (caseInsensitive) rgCmd += ` -i`;
            if (contextLines > 0) rgCmd += ` -C ${contextLines}`;
            if (globFilter) rgCmd += ` --glob "${globFilter}"`;
            if (outputMode === "files_with_matches") rgCmd += ` -l`;
            else if (outputMode === "count") rgCmd += ` --count`;
            else rgCmd += ` -n`;
            rgCmd += ` "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;

            try {
              const { stdout } = await execAsync(rgCmd, { maxBuffer: 10 * 1024 * 1024 });
              const lines = stdout.split("\n").filter(Boolean).slice(0, headLimit);
              return { output: lines.join("\n") };
            } catch (e: unknown) {
              // ripgrep exits 1 when no matches, that's fine
              const exitCode = (e as { code?: number }).code;
              if (exitCode === 1) return { output: "" };
              // rg not found – fallback
              const { stdout } = await execAsync(
                `grep -r ${caseInsensitive ? "-i" : ""} -l "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`,
                { maxBuffer: 5 * 1024 * 1024 },
              ).catch(() => ({ stdout: "" }));
              return { output: stdout.trim() };
            }
          }

          // ── Bash ──────────────────────────────────────────────────────
          case "Bash": {
            const command = String(args.command);
            const timeout = Math.min(Number(args.timeout ?? 120_000), 600_000);
            const cwd = args.cwd ? String(args.cwd) : process.cwd();
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout,
                maxBuffer: 10 * 1024 * 1024,
                shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
              });
              const output = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
              return { output: output || "(no output)" };
            } catch (e: unknown) {
              const err = e as { stdout?: string; stderr?: string; message?: string };
              const output = [err.stdout, err.stderr, err.message]
                .filter(Boolean)
                .join("\n")
                .trimEnd();
              return { output: output || "Command failed" };
            }
          }

          default:
            return { error: `Unknown tool: ${toolName}` };
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // =========================== MCP IPC ===========================
  // Manages stdio MCP server subprocesses.

  const mcpProcesses = new Map<string, {
    proc: ReturnType<typeof spawn>;
    pending: Map<number, {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }>;
    nextId: number;
  }>();

  function sendMcpRequest(
    name: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const session = mcpProcesses.get(name);
    if (!session) throw new Error(`MCP server "${name}" not connected`);
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      session.proc.stdin.write(msg);
      setTimeout(() => {
        if (session.pending.has(id)) {
          session.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  ipcMain.handle("mcp:connect", async (_event, { config }: { config: {
    name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>;
  }}) => {
    try {
      if (config.transport !== "stdio" || !config.command) {
        return { error: "Only stdio transport supported currently" };
      }
      if (mcpProcesses.has(config.name)) {
        mcpProcesses.get(config.name)?.proc.kill();
        mcpProcesses.delete(config.name);
      }
      const proc = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...(config.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const session = {
        proc,
        pending: new Map<
          number,
          { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
        >(),
        nextId: 1,
      };
      mcpProcesses.set(config.name, session);

      let buffer = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const pend = session.pending.get(msg.id);
            if (pend) {
              session.pending.delete(msg.id);
              if (msg.error) pend.reject(new Error(msg.error.message));
              else pend.resolve(msg.result);
            }
          } catch {
            // Ignore non-JSON or partial stdio frames until the buffer completes.
          }
        }
      });

      // Initialize
      await sendMcpRequest(config.name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "next-chapter", version: "1.0.0" },
      });

      // List tools
      const toolsResult = await sendMcpRequest(config.name, "tools/list", {}) as { tools?: unknown[] };
      const tools = (toolsResult?.tools ?? []).map((t: unknown) => {
        const tool = t as { name: string; description?: string; inputSchema?: unknown };
        return { serverName: config.name, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} };
      });

      // List resources
      const resResult = await sendMcpRequest(config.name, "resources/list", {}) as { resources?: unknown[] };
      const resources = (resResult?.resources ?? []).map((r: unknown) => {
        const res = r as { uri: string; name: string; description?: string; mimeType?: string };
        return { serverName: config.name, uri: res.uri, name: res.name, description: res.description, mimeType: res.mimeType };
      });

      return { ok: true, tools, resources };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp:disconnect", (_event, { name }: { name: string }) => {
    mcpProcesses.get(name)?.proc.kill();
    mcpProcesses.delete(name);
    return { ok: true };
  });

  ipcMain.handle("mcp:call-tool", async (_event, {
    serverName, toolName, args,
  }: { serverName: string; toolName: string; args: Record<string, unknown> }) => {
    try {
      const result = await sendMcpRequest(serverName, "tools/call", { name: toolName, arguments: args });
      const content = (result as { content?: unknown })?.content;
      return { ok: true, content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("mcp:read-resource", async (_event, {
    serverName, uri,
  }: { serverName: string; uri: string }) => {
    try {
      const result = await sendMcpRequest(serverName, "resources/read", { uri });
      const content = (result as { contents?: Array<{ text?: string }> })?.contents?.[0]?.text ?? "";
      return { ok: true, content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// =========================== 窗口 & 托盘 ===========================

async function prepareWindowSession(win: Electron.BrowserWindow): Promise<void> {
  try {
    await win.webContents.session.clearCache();
    log("info", "window session cache cleared");
  } catch (error) {
    log("warn", `failed to clear window cache: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await win.webContents.session.clearStorageData({
      storages: ["cachestorage", "shadercache", "serviceworkers"],
    });
    log("info", "window cache storage cleared");
  } catch (error) {
    log("warn", `failed to clear cache storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 为外部媒体资源（如火山引擎 TOS）注入 CORS 响应头，解决视频播放跨域问题
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (!headers["access-control-allow-origin"] && !headers["Access-Control-Allow-Origin"]) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = ["GET, HEAD, OPTIONS"];
      headers["Access-Control-Allow-Headers"] = ["*"];
    }
    callback({ responseHeaders: headers });
  });
  log("info", "CORS headers injection configured");
}

async function createWindow() {
  log("info", "createWindow start");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, "../build/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      spellcheck: false,           // 低配优化：禁用拼写检查
      backgroundThrottling: true,  // 后台节流，减少低配机器资源占用
    },
    show: false,
    title: "InFinio-一站式智能体自动化平台",
  });

  mainWindow.once("ready-to-show", () => {
    log("info", "main window ready-to-show");
    mainWindow?.show();
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log("info", "main window did-finish-load");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("error", `main window did-fail-load code=${code} description=${description} url=${url}`);
  });

  // 🛡️ 监听渲染进程崩溃
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    log("error", `========== 渲染进程崩溃 ==========`);
    log("error", `原因: ${details.reason}`);
    log("error", `退出码: ${details.exitCode}`);
    console.error("渲染进程崩溃详情:", details);

    // 保存崩溃信息到文件，包含更多上下文
    const crashInfo = {
      timestamp: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
      // 添加内存使用信息
      memoryUsage: process.memoryUsage(),
      // 添加系统信息
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    };

    const crashLogPath = path.join(getUserDataPath(), "crash-log.json");
    try {
      let logs = [];
      if (fs.existsSync(crashLogPath)) {
        logs = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
      }
      logs.unshift(crashInfo);
      if (logs.length > 20) logs.length = 20;
      fs.writeFileSync(crashLogPath, JSON.stringify(logs, null, 2));
      log("info", `崩溃日志已保存到: ${crashLogPath}`);
    } catch (err) {
      log("error", `无法保存崩溃日志: ${err}`);
    }
  });

  // 🛡️ 监听未响应
  mainWindow.webContents.on("unresponsive", () => {
    log("warn", "渲染进程未响应");
  });

  // 🛡️ 监听恢复响应
  mainWindow.webContents.on("responsive", () => {
    log("info", "渲染进程已恢复响应");
  });

  await prepareWindowSession(mainWindow);

  // 加载 Vite dev server 或打包后的 index.html
  if (process.env.VITE_DEV_SERVER_URL) {
    log("info", `loading dev url: ${process.env.VITE_DEV_SERVER_URL}`);
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools();
    }
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    log("info", `loading file: ${indexPath}`);
    await mainWindow.loadFile(indexPath);
  }
}

function createTray() {
  // 加载图标
  const icon = nativeImage.createFromPath(path.join(__dirname, "../build/icon.ico"));
  log("info", `createTray icon empty=${icon.isEmpty()}`);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);

  tray.setToolTip("InFinio-一站式智能体自动化平台");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}

// =========================== App 入口 ===========================

app.whenReady().then(async () => {
  log("info", "========== Electron 主进程启动 ==========");
  log("info", `渲染模式: ${GPU_DISABLED ? "软件渲染(SwiftShader)" : "硬件加速"}`);

  // GPU 崩溃自动降级：写入标志文件，下次启动切换软件渲染
  app.on("gpu-process-crashed", (_event, killed) => {
    log("warn", `GPU 进程崩溃 killed=${killed}，下次启动将自动切换软件渲染`);
    try { fs.writeFileSync(GPU_DISABLE_FLAG, "1"); } catch { /* ignore */ }
  });

  setupIPC();
  await createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Cleanup if needed
});
