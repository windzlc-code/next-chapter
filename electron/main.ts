/**
 * electron/main.ts
 *
 * Electron 涓昏繘绋嬶細
 *  - 閫氳繃 preload 鍚戞覆鏌撹繘绋嬫毚闇插畨鍏ㄧ殑 IPC API
 *  - 绐楀彛绠＄悊 + 绯荤粺鎵樼洏
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
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

// CJS 妯″紡涓?__dirname 鐢?Node.js 鑷姩鎻愪緵
// 娉ㄦ剰锛歮ain.ts 琚?esbuild 缂栬瘧涓?CJS锛宊_dirname 鍦ㄨ繍琛屾椂鍙敤
// __dirname 鎸囧悜 electron/ 鐩綍

// =========================== 閰嶇疆 ===========================

const BUILTIN_API_ADMIN_PASSWORD_HASH =
  "d4f31b6def1e6e11148cbab15b400e91528ab18880b25225d9a9f840d4d0d192";

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getPortableExecutableDir(): string | null {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  return portableDir ? path.resolve(portableDir) : null;
}

function getAppRootDir(): string {
  const overrideDir = String(process.env.INFINIO_APP_ROOT_DIR || "").trim();
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  if (app.isPackaged) {
    return getPortableExecutableDir() || path.dirname(process.execPath);
  }
  return path.resolve(__dirname, "..");
}

const APP_ROOT_DIR = getAppRootDir();
const APP_LOGS_DIR = ensureDir(path.join(APP_ROOT_DIR, "logs"));
const STARTUP_LOG_PATH = path.join(APP_LOGS_DIR, "infinio-startup.log");
const APP_TEMP_DIR = ensureDir(path.join(APP_ROOT_DIR, "temp"));
const APP_USER_DATA_DIR = ensureDir(path.join(APP_ROOT_DIR, "userData"));
const APP_DB_DIR = ensureDir(path.join(APP_ROOT_DIR, "db"));
const DEV_SERVER_WARMUP_POLL_INTERVAL_MS = 1000;
const DEV_SERVER_WARMUP_REQUEST_TIMEOUT_MS = 120_000;
const DEV_SERVER_WARMUP_TIMEOUT_MS = 5 * 60_000;

// =========================== 鐘舵€?===========================

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let devLauncherWatchdog: NodeJS.Timeout | null = null;
let watchedDevServerPid: number | null = null;

const allowTestMultiInstance = String(process.env.HOME_AGENT_ALLOW_TEST_MULTI_INSTANCE || "").trim() === "1";
const singleInstanceLock = allowTestMultiInstance ? true : app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

// 鈹€鈹€ 浣庨厤鍏煎鍒濆鍖栵紙蹇呴』鍦?app.whenReady() 涔嬪墠瀹屾垚锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

// 1. 灏嗚繍琛屾椂鍐欏叆鐩綍鍥哄畾鍦ㄥ簲鐢ㄦ牴鐩綍鍐?
const INFINIO_USER_DATA = (() => {
  try {
    app.setPath("userData", APP_USER_DATA_DIR);
    app.setPath("sessionData", ensureDir(path.join(APP_ROOT_DIR, "sessionData")));
    app.setPath("crashDumps", ensureDir(path.join(APP_ROOT_DIR, "crashDumps")));
    app.setPath("temp", APP_TEMP_DIR);
  } catch {
    /* 鍥為€€榛樿 */
  }
  return APP_USER_DATA_DIR;
})();

// 2. GPU 宕╂簝鑷姩闄嶇骇鏍囧織鏂囦欢
const GPU_DISABLE_FLAG = path.join(INFINIO_USER_DATA, ".disable-gpu");
const GPU_DISABLED = fs.existsSync(GPU_DISABLE_FLAG);

// 3. 鍩虹鍏煎鎬у紑鍏?
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("safebrowsing-disable-auto-update");

const REMOTE_DEBUGGING_PORT = String(process.env.HOME_AGENT_ELECTRON_REMOTE_DEBUGGING_PORT || "").trim();
if (/^\d+$/.test(REMOTE_DEBUGGING_PORT)) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);
}

// 4. 鑻ヤ笂娆?GPU 杩涚▼宕╂簝锛屾湰娆″惎鍔ㄥ垏鎹负杞欢娓叉煋锛圫wiftShader锛?
if (GPU_DISABLED) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.warn("[main] GPU 宸茬鐢紝浣跨敤杞欢娓叉煋妯″紡");
}

function getUserDataPath(): string {
  return app.getPath("userData");
}

function parseEnvPid(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readSmokeSelectFolderOverride(): string | null {
  const raw = String(process.env.HOME_AGENT_SMOKE_SELECT_FOLDER || "").trim();
  if (!raw) return null;
  return path.resolve(raw);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  try {
    if (process.platform === "win32") {
      const { spawn } = require("node:child_process");
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
      return;
    }

    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore cleanup failures during shutdown.
  }
}

function stopDevLauncherWatchdog(): void {
  if (devLauncherWatchdog) {
    clearInterval(devLauncherWatchdog);
    devLauncherWatchdog = null;
  }
}

function startDevLauncherWatchdog(): void {
  if (app.isPackaged) return;

  const launcherPid = parseEnvPid(process.env.INFINIO_DEV_LAUNCH_PID);
  watchedDevServerPid = parseEnvPid(process.env.INFINIO_DEV_SERVER_PID);
  if (!launcherPid) return;

  stopDevLauncherWatchdog();
  devLauncherWatchdog = setInterval(() => {
    if (processExists(launcherPid)) return;
    stopDevLauncherWatchdog();
    if (watchedDevServerPid) {
      killProcessTree(watchedDevServerPid);
      watchedDevServerPid = null;
    }
    app.quit();
  }, 2000);
}

/**
 * 榛樿缂撳瓨鐩綍锛氫笌绋嬪簭鍚岀骇鐨?files/
 * - 寮€鍙戯細椤圭洰鏍圭洰褰?files锛坢ain 鍦?electron/锛屼笂涓€绾т负浠撳簱鏍癸級
 * - 鎵撳寘锛氬彲鎵ц鏂囦欢鎵€鍦ㄧ洰褰?files
 */
function getDefaultFilesDir(): string {
  return path.join(APP_ROOT_DIR, "files");
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

// =========================== 鏃ュ織 ===========================

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

function isExpectedDevServer(body: string): boolean {
  return body.includes('<div id="root"></div>') && body.includes("/src/main.tsx");
}

function isExpectedMainModule(body: string): boolean {
  return body.includes("createRoot") && body.includes("App from") && body.includes("/src/App.tsx");
}

function probeDevServerOnce(devUrl: string): Promise<{ reachable: boolean; reusable: boolean }> {
  return new Promise((resolve) => {
    const mainModuleUrl = new URL("/src/main.tsx", devUrl).toString();
    const requestTextOnce = (targetUrl: string) =>
      new Promise<{ reachable: boolean; statusCode: number; body: string }>((innerResolve) => {
        const request = http.get(targetUrl, (response: { statusCode?: number; on: (event: string, listener: (chunk?: Buffer | string) => void) => void }) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk?: Buffer | string) => {
            if (typeof chunk === "undefined") return;
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            innerResolve({
              reachable: true,
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        });

        request.setTimeout(DEV_SERVER_WARMUP_REQUEST_TIMEOUT_MS, () => {
          request.destroy(new Error("probe timeout"));
        });

        request.on("error", () => {
          innerResolve({
            reachable: false,
            statusCode: 0,
            body: "",
          });
        });
      });

    void (async () => {
      const pageProbe = await requestTextOnce(devUrl);
      const pageReusable =
        pageProbe.reachable &&
        pageProbe.statusCode >= 200 &&
        pageProbe.statusCode < 300 &&
        isExpectedDevServer(pageProbe.body);

      if (!pageReusable) {
        resolve({
          reachable: pageProbe.reachable,
          reusable: false,
        });
        return;
      }

      const mainModuleProbe = await requestTextOnce(mainModuleUrl);
      const mainModuleReusable =
        mainModuleProbe.reachable &&
        mainModuleProbe.statusCode >= 200 &&
        mainModuleProbe.statusCode < 300 &&
        isExpectedMainModule(mainModuleProbe.body);

      resolve({
        reachable: true,
        reusable: mainModuleReusable,
      });
    })();
  });
}

async function waitForReusableDevServer(devUrl: string, win: BrowserWindow): Promise<boolean> {
  const deadline = Date.now() + DEV_SERVER_WARMUP_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    if (win.isDestroyed()) {
      return false;
    }

    const probe = await probeDevServerOnce(devUrl);
    if (probe.reusable) {
      return true;
    }

    if (win.isDestroyed()) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_WARMUP_POLL_INTERVAL_MS));
  }

  return false;
}

async function loadDevWarmupPage(win: BrowserWindow): Promise<void> {
  const warmupPath = path.join(__dirname, "dev-warmup.html");
  log("info", `loading dev warmup page: ${warmupPath}`);
  await win.loadFile(warmupPath);
}

async function transitionWarmupWindowToDevServer(win: BrowserWindow, devUrl: string): Promise<void> {
  const ready = await waitForReusableDevServer(devUrl, win);
  if (!ready) {
    if (!win.isDestroyed()) {
      log("error", `timed out waiting for reusable dev server at ${devUrl}`);
    }
    return;
  }

  if (win.isDestroyed()) {
    return;
  }

  try {
    log("info", `dev warmup complete, loading live url: ${devUrl}`);
    await win.loadURL(devUrl);
    if (process.env.ELECTRON_OPEN_DEVTOOLS === "1" && !win.isDestroyed()) {
      win.webContents.openDevTools();
    }
  } catch (error) {
    if (!win.isDestroyed()) {
      log("error", `failed to load live dev url: ${error instanceof Error ? error.message : String(error)}`);
    }
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


// =========================== IPC 澶勭悊 ===========================

function setupIPC() {
  // 馃洝锔?璇诲彇宕╂簝鏃ュ織
  ipcMain.handle(
    "runtime:verifyBuiltinApiAdminPassword",
    (_event, password: string) => verifyBuiltinApiAdminPassword(password),
  );

  // 鏌ヨ褰撳墠娓叉煋妯″紡锛堜緵璁剧疆椤靛睍绀猴級
  ipcMain.handle("runtime:getGpuMode", () => ({
    softwareRendering: GPU_DISABLED,
    flagPath: GPU_DISABLE_FLAG,
  }));

  // 閲嶇疆 GPU 闄嶇骇鏍囧織锛屼笅娆″惎鍔ㄦ仮澶嶇‖浠跺姞閫?
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


  // ===== 瀛樺偍璺緞 ============================

  ipcMain.handle("storage:getDefaultPath", () => {
    const filesDir = getDefaultFilesDir();
    try {
      fs.mkdirSync(filesDir, { recursive: true });
      seedRuntimeFilesDirFromBundle(filesDir);
    } catch {
      /* ignore */
    }
    return {
      files: filesDir,
      db: APP_DB_DIR,
    };
  });

  ipcMain.handle("storage:selectFolder", async () => {
    const smokeFolderOverride = readSmokeSelectFolderOverride();
    if (smokeFolderOverride) {
      fs.mkdirSync(smokeFolderOverride, { recursive: true });
      return smokeFolderOverride;
    }
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
    // 濡傛灉鏄枃浠讹紝鐢?showItemInFolder 鍦ㄨ祫婧愮鐞嗗櫒涓珮浜樉绀猴紱鍚﹀垯鐩存帴鎵撳紑鐩綍
    try {
      const stat = fs.statSync(normalizedPath);
      if (stat.isFile()) {
        shell.showItemInFolder(normalizedPath);
        return Promise.resolve("");
      }
    } catch {
      // 璺緞涓嶅瓨鍦ㄦ椂鍥為€€鍒?openPath
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
          title: "淇濆瓨鏂囦欢",
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
    "storage:writeBase64File",
    async (
      _event,
      { filePath, base64 }: { filePath: string; base64: string },
    ) => {
      try {
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(base64, "base64"));
        return { ok: true, filePath: normalizedPath };
      } catch (error) {
        return {
          ok: false,
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

  // 閫夋嫨鍗曚釜鏂囦欢瀵硅瘽妗?
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

  // 瀵煎嚭鑱婂ぉ璁板綍锛氬啓鍏ヨ亰澶╄褰?JSON锛屽苟鎸夊綋鍓嶅崗璁鍒跺獟浣撶洰褰?
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

  // 瀵煎叆鑱婂ぉ璁板綍锛氱洿鎺ヨ鍙栫敤鎴烽€夋嫨鐨?chat-history.json锛屽苟鎶婂悓绾?media/ 澶嶅埗鍥炲綋鍓嶉」鐩洰褰?
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
  // Renders invoke agent:submitMessage 鈫?receives streamed agent:event messages.

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

    // 浼樺厛浣跨敤鎵撳寘杩?extraResources 鐨?vendor/ffmpeg
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.resolve(__dirname, "..");
    const vendorCandidate = path.join(resourcesDir, "vendor", "ffmpeg", executableName);
    if (fs.existsSync(vendorCandidate)) return vendorCandidate;

    // 寮€鍙戠幆澧冨洖閫€锛氱郴缁熷畨瑁呰矾寰?
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

  // 鈹€鈹€ ffmpeg: 鐗囨瑙嗛鎷兼帴 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

        // 鍐?concat 鍒楄〃鏂囦欢
        const listFile = path.join(app.getPath("temp"), `infinio-concat-${Date.now()}.txt`);
        const listContent = validPaths.map((p: string) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
        fs.writeFileSync(listFile, listContent, "utf8");

        await execFileAsync(
          ffmpegBin,
          ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", path.normalize(outputPath)],
          { windowsHide: true },
        );

        try { fs.unlinkSync(listFile); } catch { /* 娓呯悊澶辫触涓嶅奖鍝嶇粨鏋?*/ }

        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // 鈹€鈹€ ffmpeg: 鐑у綍瀛楀箷 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
        if (!fs.existsSync(normalizedInput)) return { ok: false, error: `杈撳叆鏂囦欢涓嶅瓨鍦? ${normalizedInput}` };

        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });

        // 鐢熸垚 SRT 鏂囦欢
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

        // 鐑у綍瀛楀箷锛堜娇鐢?subtitles filter锛岃矾寰勯渶杞箟鍐掑彿锛?
        const escapedSrt = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:");
        await execFileAsync(
          ffmpegBin,
          ["-y", "-i", normalizedInput, "-vf", `subtitles='${escapedSrt}'`, "-c:a", "copy", path.normalize(outputPath)],
          { windowsHide: true },
        );

        try { fs.unlinkSync(srtFile); } catch { /* 娓呯悊澶辫触涓嶅奖鍝嶇粨鏋?*/ }

        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // 鈹€鈹€ SRT 鍚庡鐞嗭細杩囨护闈炲璇濆唴瀹?+ 鍘婚噸 + 淇閲嶅彔鏃堕棿鎴?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      // 杩囨护鎷彿鍐呭锛堥煶鏁堛€佸够瑙夈€佺墖澶村瓧骞曠瓑锛?
      if (/^[\s(锛圽[銆愨櫔鈾玗*[\)锛塡]銆戔櫔鈾玕s]*$/.test(textLines)) continue;
      if (/^[\s(锛圽[銆怾.*[\)锛塡]銆慮\s*$/.test(textLines)) continue;
      // 杩囨护绾爣鐐规垨绌哄唴瀹?
      if (textLines.replace(/[\s\p{P}]/gu, "").length < 1) continue;
      const [startStr, endStr] = lines[1].split(" --> ");
      entries.push({ startMs: parseMs(startStr.trim()), endMs: parseMs(endStr.trim()), text: textLines });
    }

    // 鍘婚噸锛氭椂闂存埑閲嶅彔涓旀枃鏈浉鍚屾垨琚寘鍚?鈫?璺宠繃
    const deduped: typeof entries = [];
    for (const entry of entries) {
      const prev = deduped[deduped.length - 1];
      if (prev && entry.startMs < prev.endMs) {
        if (entry.text === prev.text || prev.text.includes(entry.text)) continue;
      }
      deduped.push(entry);
    }

    // 淇閲嶅彔鏃堕棿鎴筹細纭繚姣忔潯缁撴潫 <= 涓嬩竴鏉″紑濮?
    for (let i = 0; i < deduped.length - 1; i++) {
      if (deduped[i].endMs > deduped[i + 1].startMs) {
        deduped[i].endMs = deduped[i + 1].startMs;
      }
    }

    return deduped.map((e, i) => `${i + 1}\n${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}\n${e.text}`).join("\n\n") + "\n";
  }

  // 鈹€鈹€ ffmpeg: AI 鏅鸿兘鎷兼帴锛坸fade 杞満 + whisper 瀛楀箷璇嗗埆锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

        // 鈹€鈹€ 姝ラ1锛氱敤 ffprobe 鑾峰彇姣忔鏃堕暱 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

        // 鈹€鈹€ 姝ラ2锛氭瀯寤?xfade 婊ら暅鍥?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        // 姣忔杞満鏃堕暱榛樿 0.5s锛宱ffset = 绱鏃堕暱 - 杞満鏃堕暱
        const concatOutput = path.join(tempDir, `infinio-smart-concat-${ts}.mp4`);

        if (validPaths.length === 1) {
          // 鍗曟鐩存帴澶嶅埗
          await execFileAsync(
            ffmpegBin,
            ["-y", "-i", validPaths[0], "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", concatOutput],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 },
          );
        } else {
          // 鏋勫缓 xfade 婊ら暅閾?
          const effectiveTransitions = transitions.slice(0, validPaths.length - 1);
          while (effectiveTransitions.length < validPaths.length - 1) {
            effectiveTransitions.push({ type: "fade", duration: 0.5 });
          }

          const inputArgs: string[] = [];
          for (const vp of validPaths) {
            inputArgs.push("-i", vp);
          }

          // 璁＄畻姣忎釜 xfade 鐨?offset锛堝墠娈电粨鏉熸椂闂?- 杞満鏃堕暱锛?
          const offsets: number[] = [];
          let cumulative = 0;
          for (let i = 0; i < validPaths.length - 1; i++) {
            cumulative += durations[i];
            const xfadeDur = effectiveTransitions[i].duration;
            offsets.push(Math.max(0, cumulative - xfadeDur));
            // 涓嬩竴娈电殑璧峰鏃堕棿瑕佸噺鍘昏浆鍦洪噸鍙犻儴鍒?
            cumulative -= xfadeDur;
          }

          // 鏋勫缓婊ら暅鍥撅細[0:v][1:v]xfade=...,offset=...[v01]; [v01][2:v]xfade=...
          let filterGraph = "";
          let prevLabel = "[0:v]";
          for (let i = 0; i < validPaths.length - 1; i++) {
            const t = effectiveTransitions[i];
            const outLabel = i === validPaths.length - 2 ? "[vout]" : `[v${i + 1}]`;
            filterGraph += `${prevLabel}[${i + 1}:v]xfade=transition=${t.type}:duration=${t.duration}:offset=${offsets[i].toFixed(3)}${outLabel}`;
            if (i < validPaths.length - 2) filterGraph += ";";
            prevLabel = outLabel;
          }

          // 闊抽锛歛crossfade 閾?
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

        // 鈹€鈹€ 姝ラ3锛氬瓧骞曞鐞?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
          // whisper 璇煶璇嗗埆锛欽SON 鏍煎紡杈撳嚭锛岀簿纭幓閲嶅悎骞?
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
          } catch { /* 澶辫触鏃?jsonOutput 涓嶅瓨鍦紝鍚庣画闄嶇骇 */ }
          try { fs.unlinkSync(modelInTemp); } catch { /* ignore */ }

          let srtEntries: Array<{ startMs: number; endMs: number; text: string }> = [];
          if (fs.existsSync(jsonOutput)) {
            const jsonLines = fs.readFileSync(jsonOutput, "utf8");
            try { fs.unlinkSync(jsonOutput); } catch { /* ignore */ }

            // 瑙ｆ瀽 JSON 琛岋紝涓夋杩囨护锛氭嫭鍙峰够瑙?鈫?琚寘鍚噸澶?鈫?绱ч偦鍚堝苟
            const raw = jsonLines.trim().split("\n")
              .map((l) => { try { return JSON.parse(l.trim()) as { start: number; end: number; text: string }; } catch { return null; } })
              .filter((e): e is { start: number; end: number; text: string } => !!e);

            // Step 1: 杩囨护鎷彿鍐呭锛堥煶鏁?骞昏锛?
            let entries = raw.filter((e) => {
              const t = e.text.trim();
              if (/^[\s(锛圽[銆愨櫔鈾玗*[\)锛塡]銆戔櫔鈾玕s]*$/.test(t)) return false;
              if (/^[\s(锛圽[銆怾.*[\)锛塡]銆慮\s*$/.test(t)) return false;
              if (t.replace(/[\s\p{P}]/gu, "").length < 1) return false;
              return true;
            });

            // Step 2: 鍒犻櫎琚叾浠栫浉鍚屾枃鏈潯鐩畬鍏ㄥ寘鍚殑鏉＄洰锛堟椂闂寸獥鍙ｉ噸鍙犲够瑙夛級
            entries = entries.filter((e, i) => {
              const selfDur = e.end - e.start;
              return !entries.some((other, j) => {
                if (j === i || other.text !== e.text) return false;
                const overlap = Math.max(0, Math.min(e.end, other.end) - Math.max(e.start, other.start));
                return overlap / selfDur >= 0.95 && (other.end - other.start) > selfDur;
              });
            });

            // Step 3: 鍚堝苟鐩搁偦鏂囨湰鐩稿悓涓?gap < 200ms 鐨勬潯鐩?
            const merged: Array<{ start: number; end: number; text: string }> = [];
            for (const e of entries) {
              const prev = merged[merged.length - 1];
              if (prev && e.text === prev.text && (e.start - prev.end) < 200) {
                prev.end = Math.max(prev.end, e.end);
                continue;
              }
              merged.push({ ...e });
            }

            // Step 4: 淇鏃堕棿鎴抽噸鍙?
            for (let i = 0; i < merged.length - 1; i++) {
              if (merged[i].end > merged[i + 1].start) merged[i].end = merged[i + 1].start;
            }

            // Step 5: 棰戠巼骞昏杩囨护 鈥?鍚屼竴鏂囨湰锛堚墺4瀛楋級鍦ㄩ潪閲嶅彔鏃堕棿娈靛嚭鐜?鈮? 娆¤涓哄够瑙夊惊鐜?
            const textFreq = new Map<string, number>();
            for (const e of merged) textFreq.set(e.text.trim(), (textFreq.get(e.text.trim()) ?? 0) + 1);
            const deHallucinated = merged.filter((e) => {
              const key = e.text.trim();
              const charLen = key.replace(/\s/g, "").length;
              return charLen <= 3 || (textFreq.get(key) ?? 0) < 3;
            });

            // Step 6: 鏂囨湰鍐呴儴閲嶅鐭杩囨护 鈥?"ABAB" 鎴?"AB,AB" 妯″紡涓哄够瑙夌壒寰?
            const deRepeat = deHallucinated.filter((e) => {
              const t = e.text.trim();
              const parts = t.split(/[,锛屻€?銆侊紱;]/).map((p) => p.trim()).filter(Boolean);
              if (parts.length >= 2 && parts[0] === parts[1]) return false;
              const clean = t.replace(/[,锛屻€?銆侊紱;\s]/g, "");
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
          // 鍒嗛暅鍙拌瘝瀛楀箷锛堝鐢ㄨ矾寰勶級
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
          // 鈹€鈹€ FileRead 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

          // 鈹€鈹€ FileWrite 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "FileWrite": {
            const filePath = String(args.filePath);
            const content = String(args.content ?? "");
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf8");
            return { ok: true };
          }

          // 鈹€鈹€ FileEdit 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

          // 鈹€鈹€ Glob 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

          // 鈹€鈹€ Grep 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
              // rg not found 鈥?fallback
              const { stdout } = await execAsync(
                `grep -r ${caseInsensitive ? "-i" : ""} -l "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`,
                { maxBuffer: 5 * 1024 * 1024 },
              ).catch(() => ({ stdout: "" }));
              return { output: stdout.trim() };
            }
          }

          // 鈹€鈹€ Bash 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

// =========================== 绐楀彛 & 鎵樼洏 ===========================

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

  // 涓哄閮ㄥ獟浣撹祫婧愶紙濡傜伀灞卞紩鎿?TOS锛夋敞鍏?CORS 鍝嶅簲澶达紝瑙ｅ喅瑙嗛鎾斁璺ㄥ煙闂
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
    backgroundColor: "#090b11",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      spellcheck: false,           // 浣庨厤浼樺寲锛氱鐢ㄦ嫾鍐欐鏌?
      backgroundThrottling: true,  // 鍚庡彴鑺傛祦锛屽噺灏戜綆閰嶆満鍣ㄨ祫婧愬崰鐢?
      paintWhenInitiallyHidden: true,
    },
    show: false,
    title: "InFinio - 一站式智能体自动化平台",
  });

  let hasRevealedMainWindow = false;
  let startupRevealTimer: NodeJS.Timeout | null = setTimeout(() => {
    revealMainWindow("startup-timeout");
  }, 1200);

  const revealMainWindow = (reason: string) => {
    if (!mainWindow || mainWindow.isDestroyed() || hasRevealedMainWindow) return;
    hasRevealedMainWindow = true;
    if (startupRevealTimer) {
      clearTimeout(startupRevealTimer);
      startupRevealTimer = null;
    }
    log("info", `main window revealed via ${reason}`);
    mainWindow.show();
  };

  mainWindow.once("ready-to-show", () => {
    log("info", "main window ready-to-show");
    revealMainWindow("ready-to-show");
  });

  mainWindow.webContents.once("dom-ready", () => {
    log("info", "main window dom-ready");
    revealMainWindow("dom-ready");
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log("info", "main window did-finish-load");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("error", `main window did-fail-load code=${code} description=${description} url=${url}`);
  });

  mainWindow.on("closed", () => {
    if (startupRevealTimer) {
      clearTimeout(startupRevealTimer);
      startupRevealTimer = null;
    }
  });

  // 馃洝锔?鐩戝惉娓叉煋杩涚▼宕╂簝
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    log("error", `========== 娓叉煋杩涚▼宕╂簝 ==========`);
    log("error", `鍘熷洜: ${details.reason}`);
    log("error", `閫€鍑虹爜: ${details.exitCode}`);
    console.error("娓叉煋杩涚▼宕╂簝璇︽儏:", details);

    // 淇濆瓨宕╂簝淇℃伅鍒版枃浠讹紝鍖呭惈鏇村涓婁笅鏂?
    const crashInfo = {
      timestamp: new Date().toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
      // 娣诲姞鍐呭瓨浣跨敤淇℃伅
      memoryUsage: process.memoryUsage(),
      // 娣诲姞绯荤粺淇℃伅
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
      log("info", `宕╂簝鏃ュ織宸蹭繚瀛樺埌: ${crashLogPath}`);
    } catch (err) {
      log("error", `鏃犳硶淇濆瓨宕╂簝鏃ュ織: ${err}`);
    }
  });

  // 馃洝锔?鐩戝惉鏈搷搴?
  mainWindow.webContents.on("unresponsive", () => {
    log("warn", "渲染进程未响应");
  });

  // 馃洝锔?鐩戝惉鎭㈠鍝嶅簲
  mainWindow.webContents.on("responsive", () => {
    log("info", "渲染进程已恢复响应");
  });

  await prepareWindowSession(mainWindow);

  // 鍔犺浇 Vite dev server 鎴栨墦鍖呭悗鐨?index.html
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = process.env.VITE_DEV_SERVER_URL;

    try {
      await loadDevWarmupPage(mainWindow);
    } catch (error) {
      log("warn", `failed to load dev warmup page: ${error instanceof Error ? error.message : String(error)}`);
    }

    void transitionWarmupWindowToDevServer(mainWindow, devUrl);
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    log("info", `loading file: ${indexPath}`);
    await mainWindow.loadFile(indexPath);
  }
}

function createTray() {
  // 鍔犺浇鍥炬爣
  const icon = nativeImage.createFromPath(path.join(__dirname, "../build/icon.ico"));
  log("info", `createTray icon empty=${icon.isEmpty()}`);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);

  tray.setToolTip("InFinio - 一站式智能体自动化平台");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}

function configureApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          { role: "close", label: "关闭窗口" },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新加载" },
          { role: "forceReload", label: "强制重新加载" },
          { role: "toggleDevTools", label: "开发者工具" },
          { type: "separator" },
          { role: "resetZoom", label: "重置缩放" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "切换全屏" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize", label: "最小化" },
          { role: "close", label: "关闭窗口" },
        ],
      },
      {
        label: "帮助",
        submenu: [
          {
            label: "打开数据目录",
            click: () => {
              void shell.openPath(app.getPath("userData"));
            },
          },
        ],
      },
    ]),
  );
}

// =========================== App 鍏ュ彛 ===========================

app.whenReady().then(async () => {
  log("info", "========== Electron 涓昏繘绋嬪惎鍔?==========");
  log("info", `渲染模式: ${GPU_DISABLED ? "软件渲染(SwiftShader)" : "硬件加速"}`);

  // GPU 宕╂簝鑷姩闄嶇骇锛氬啓鍏ユ爣蹇楁枃浠讹紝涓嬫鍚姩鍒囨崲杞欢娓叉煋
  app.on("gpu-process-crashed", (_event, killed) => {
    log("warn", `GPU 杩涚▼宕╂簝 killed=${killed}锛屼笅娆″惎鍔ㄥ皢鑷姩鍒囨崲杞欢娓叉煋`);
    try { fs.writeFileSync(GPU_DISABLE_FLAG, "1"); } catch { /* ignore */ }
  });

  setupIPC();
  configureApplicationMenu();
  await createWindow();
  createTray();
  startDevLauncherWatchdog();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopDevLauncherWatchdog();
  if (watchedDevServerPid) {
    killProcessTree(watchedDevServerPid);
    watchedDevServerPid = null;
  }
});



