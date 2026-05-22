import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { _electron as electron } from "playwright";

const DEFAULT_URL = process.env.HOME_AGENT_SMOKE_URL || "http://127.0.0.1:8080";
const DEV_SERVER_PORT = new URL(DEFAULT_URL).port || "8080";
const HOME_AGENT_SMOKE_VERBOSE = process.env.HOME_AGENT_SMOKE_VERBOSE === "1";

function logSmokeStep(step, detail) {
  if (!HOME_AGENT_SMOKE_VERBOSE) return;
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[smoke] ${step}${suffix}`);
}

const API_CONFIG_KEY = "storyforge_api_config";
const TEXT_MODEL_KEY = "storyforge-home-agent-text-model-v1";
const VIDEO_PREFS_KEY = "storyforge-home-agent-video-prefs-v1";
const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
const DRAMA_PROJECTS_KEY = "storyforge_drama_projects";
const VIDEO_PROJECTS_KEY = "storyforge_projects";
const CURRENT_PROJECT_KEY = "storyforge_current_project";
const AUTOMATION_MODE_KEY = "storyforge-home-agent-automation-mode-v1";
const DEFAULT_TEXT_MODEL = "claude-sonnet-4-6";
const UI_POLL_INTERVAL_MS = 250;
const WORKFLOW_TEST_SCENARIO_KEY = "storyforge_home_agent_workflow_test_scenario";
const WORKFLOW_TEST_TRACE_KEY = "storyforge_home_agent_workflow_test_trace";
const FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO = "full-auto-original-script";
const FULL_AUTO_ADAPTATION_SMOKE_SCENARIO = "full-auto-adaptation";
const FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO = "full-auto-video-workflow";
const FULL_AUTO_ADAPTATION_REFERENCE_DOCX = String.raw`E:\Other\work\22\🎬 《烟火人间不及你》创作方案.docx`;
const REAL_FULL_AUTO_TIMEOUT_MS = Number(
  process.env.HOME_AGENT_REAL_FULL_AUTO_TIMEOUT_MS || 900_000,
);
const REAL_VIDEO_PREFS_SEED = {
  modelKey: "doubao-seedance-1-5-pro",
  resolution: "480p",
  mode: "text-to-video",
};
const REAL_TEXT_MODEL_SEED = "claude-sonnet-4-6";
const QUICK_TASK_LABELS = new Set([
  "\u539f\u521b\u5267\u672c",
  "\u53c2\u8003\u6539\u7f16",
  "\u89c6\u9891\u5de5\u4f5c\u6d41",
]);
const NEW_PROJECT_LABELS = ["\u65b0\u5efa\u9879\u76ee", "\u5f00\u59cb\u65b0\u9879\u76ee"];
const SETTINGS_TOGGLE_LABEL = "\u6253\u5f00\u6216\u5173\u95ed\u8bbe\u7f6e";
const MANUAL_MODE_LABEL = "\u666e\u901a\u6a21\u5f0f";
const FULL_AUTO_MODE_LABEL = "\u5168\u81ea\u52a8\u6a21\u5f0f";

let sharedJsonSeed = {};
let sharedRawSeed = {};
let sharedDesktopSeed = null;
let sharedDesktopApiConfigRaw = null;
let sharedVideoPrefsOverride = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSmokeVideoPrefsOverride() {
  const raw = trimString(process.env.HOME_AGENT_SMOKE_VIDEO_PREFS_JSON);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Keep polling until timeout so the script can start its own local dev server.
    }

    await sleep(UI_POLL_INTERVAL_MS);
  }

  return false;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonSafely(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function copyDirectorySnapshot(sourceDir, targetDir) {
  const normalizedSource = trimString(sourceDir);
  if (!normalizedSource || !(await pathExists(normalizedSource))) {
    return 0;
  }

  const files = await listFilesRecursive(normalizedSource);
  for (const file of files) {
    const destinationPath = path.join(targetDir, file.relativePath);
    await ensureDirectory(path.dirname(destinationPath));
    await fs.copyFile(file.path, destinationPath);
  }

  return files.length;
}

async function listFilesRecursive(rootDir) {
  const normalizedRoot = trimString(rootDir);
  if (!normalizedRoot || !(await pathExists(normalizedRoot))) return [];

  const files = [];
  const queue = [normalizedRoot];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath);
      files.push({
        path: fullPath,
        relativePath: path.relative(normalizedRoot, fullPath).replace(/\\/g, "/"),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((value) => {
    const normalized = trimString(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function listDesktopSessionCandidates() {
  const homeDir = os.homedir();
  const roamingDir = path.join(homeDir, "AppData", "Roaming");
  const localDir = path.join(homeDir, "AppData", "Local");
  return uniquePaths([
    path.join(process.cwd(), "sessionData"),
    path.join(process.cwd(), "userData"),
    path.join(roamingDir, "InFinio"),
    path.join(roamingDir, "vite_react_shadcn_ts"),
    path.join(localDir, "InFinio"),
    path.join(localDir, "vite_react_shadcn_ts"),
  ]);
}

function listProbeUrls(baseUrl) {
  const urls = [baseUrl];
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      const alt = new URL(baseUrl);
      alt.hostname = parsed.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
      urls.push(alt.toString());
    }
  } catch {
    // Keep the original URL only.
  }
  return uniquePaths(urls);
}

async function copyLevelDbSnapshot(sourceRoot, extractionRoot) {
  const sourceLevelDbDir = path.join(sourceRoot, "Local Storage", "leveldb");
  if (!(await pathExists(sourceLevelDbDir))) {
    return false;
  }

  const entries = await fs.readdir(sourceLevelDbDir, { withFileTypes: true });
  const targetLevelDbDirs = [
    path.join(extractionRoot, "sessionData", "Local Storage", "leveldb"),
    path.join(extractionRoot, "userData", "Local Storage", "leveldb"),
  ];
  await Promise.all(targetLevelDbDirs.map((dir) => fs.mkdir(dir, { recursive: true })));
  let copied = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.toUpperCase() === "LOCK") continue;
    const sourcePath = path.join(sourceLevelDbDir, entry.name);
    try {
      await Promise.all(
        targetLevelDbDirs.map((dir) => fs.copyFile(sourcePath, path.join(dir, entry.name))),
      );
      copied += 1;
    } catch {
      // Skip transiently locked LevelDB files and keep probing with the snapshot we could copy.
    }
  }

  return copied > 0;
}

async function readBuiltinApiConfig() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "config", "builtin-api.json"), "utf8");
    return parseJsonSafely(raw);
  } catch {
    return null;
  }
}

async function readSavedDesktopSeed(baseUrl) {
  const candidates = listDesktopSessionCandidates();
  const probeUrls = listProbeUrls(baseUrl);

  for (const candidateDir of candidates) {
    const localStorageDir = path.join(candidateDir, "Local Storage");
    if (!(await pathExists(localStorageDir))) continue;

    for (const probeUrl of probeUrls) {
      let electronApp = null;
      const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-config-probe-"));

      try {
        const copied = await copyLevelDbSnapshot(candidateDir, extractionRoot);
        if (!copied) continue;

        const env = {
          ...process.env,
          VITE_DEV_SERVER_URL: probeUrl,
          INFINIO_APP_ROOT_DIR: extractionRoot,
        };
        delete env.ELECTRON_RUN_AS_NODE;

        electronApp = await electron.launch({
          args: ["."],
          env,
        });

        const page = await electronApp.firstWindow();
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
        if (!page.url().startsWith(probeUrl)) {
          await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        }

        const stored = await page.evaluate(
          ({
            apiConfigKey,
            textModelKey,
            videoPrefsKey,
            sessionKey,
            projectSessionsKey,
            dramaProjectsKey,
            videoProjectsKey,
            currentProjectKey,
            automationModeKey,
          }) => ({
            apiConfigRaw: window.localStorage.getItem(apiConfigKey),
            textModelRaw: window.localStorage.getItem(textModelKey),
            videoPrefsRaw: window.localStorage.getItem(videoPrefsKey),
            sessionRaw: window.localStorage.getItem(sessionKey),
            projectSessionsRaw: window.localStorage.getItem(projectSessionsKey),
            dramaProjectsRaw: window.localStorage.getItem(dramaProjectsKey),
            videoProjectsRaw: window.localStorage.getItem(videoProjectsKey),
            currentProjectRaw: window.localStorage.getItem(currentProjectKey),
            automationModeRaw: window.localStorage.getItem(automationModeKey),
          }),
          {
            apiConfigKey: API_CONFIG_KEY,
            textModelKey: TEXT_MODEL_KEY,
            videoPrefsKey: VIDEO_PREFS_KEY,
            sessionKey: STUDIO_SESSION_KEY,
            projectSessionsKey: STUDIO_PROJECT_SESSIONS_KEY,
            dramaProjectsKey: DRAMA_PROJECTS_KEY,
            videoProjectsKey: VIDEO_PROJECTS_KEY,
            currentProjectKey: CURRENT_PROJECT_KEY,
            automationModeKey: AUTOMATION_MODE_KEY,
          },
        );

        if (
          trimString(stored.apiConfigRaw) ||
          trimString(stored.textModelRaw) ||
          trimString(stored.videoPrefsRaw) ||
          trimString(stored.sessionRaw) ||
          trimString(stored.projectSessionsRaw) ||
          trimString(stored.dramaProjectsRaw) ||
          trimString(stored.videoProjectsRaw) ||
          trimString(stored.currentProjectRaw) ||
          trimString(stored.automationModeRaw)
        ) {
          return {
            ...stored,
            sourceRoot: candidateDir,
          };
        }
      } catch {
        // Keep probing until one desktop session yields a usable local-storage snapshot.
      } finally {
        if (electronApp) {
          await electronApp.close().catch(() => {});
        }
        await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return null;
}

async function readSavedDesktopApiConfigRaw(baseUrl) {
  const candidates = listDesktopSessionCandidates();
  const probeUrls = listProbeUrls(baseUrl);

  for (const candidateDir of candidates) {
    const localStorageDir = path.join(candidateDir, "Local Storage");
    if (!(await pathExists(localStorageDir))) continue;

    for (const probeUrl of probeUrls) {
      let electronApp = null;
      const extractionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-config-probe-"));

      try {
        const copied = await copyLevelDbSnapshot(candidateDir, extractionRoot);
        if (!copied) continue;

        const env = {
          ...process.env,
          VITE_DEV_SERVER_URL: probeUrl,
          INFINIO_APP_ROOT_DIR: extractionRoot,
        };
        delete env.ELECTRON_RUN_AS_NODE;

        electronApp = await electron.launch({
          args: ["."],
          env,
        });

        const page = await electronApp.firstWindow();
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
        if (!page.url().startsWith(probeUrl)) {
          await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        }

        const apiConfigRaw = await page.evaluate(
          ([apiConfigKey]) => window.localStorage.getItem(apiConfigKey),
          [API_CONFIG_KEY],
        );

        if (trimString(apiConfigRaw)) {
          return apiConfigRaw;
        }
      } catch {
        // Keep probing until one desktop session yields a usable API config snapshot.
      } finally {
        if (electronApp) {
          await electronApp.close().catch(() => {});
        }
        await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return null;
}

async function resolveSharedLocalStorageSeed(baseUrl) {
  const builtinApiConfig = await readBuiltinApiConfig();
  const savedSeed = sharedDesktopSeed ?? await readSavedDesktopSeed(baseUrl);
  const savedApiConfigRaw =
    trimString(savedSeed?.apiConfigRaw) ||
    trimString(sharedDesktopApiConfigRaw) ||
    trimString(await readSavedDesktopApiConfigRaw(baseUrl));
  const jsonSeed = {};
  const rawSeed = {};

  const savedApiConfig = parseJsonSafely(savedApiConfigRaw);
  const savedVideoPrefs = sharedVideoPrefsOverride ?? parseJsonSafely(savedSeed?.videoPrefsRaw);
  const savedTextModel = trimString(savedSeed?.textModelRaw);

  if (savedApiConfig) {
    jsonSeed[API_CONFIG_KEY] = savedApiConfig;
  } else if (builtinApiConfig) {
    jsonSeed[API_CONFIG_KEY] = builtinApiConfig;
  }

  if (savedVideoPrefs) {
    jsonSeed[VIDEO_PREFS_KEY] = savedVideoPrefs;
  }

  rawSeed[TEXT_MODEL_KEY] = savedTextModel || DEFAULT_TEXT_MODEL;

  return { jsonSeed, rawSeed };
}

async function resetAndSeedFromSavedDesktopStudioState(page) {
  const savedSeed = sharedDesktopSeed;
  const session = parseJsonSafely(savedSeed?.sessionRaw);
  const projectSessions = parseJsonSafely(savedSeed?.projectSessionsRaw);
  const dramaProjects = parseJsonSafely(savedSeed?.dramaProjectsRaw);
  const videoProjects = parseJsonSafely(savedSeed?.videoProjectsRaw);
  const apiConfig = parseJsonSafely(
    trimString(savedSeed?.apiConfigRaw) || trimString(sharedDesktopApiConfigRaw),
  );
  const videoPrefs = sharedVideoPrefsOverride ?? parseJsonSafely(savedSeed?.videoPrefsRaw);

  const jsonPayload = {
    ...sharedJsonSeed,
    ...(apiConfig ? { [API_CONFIG_KEY]: apiConfig } : {}),
    ...(videoPrefs ? { [VIDEO_PREFS_KEY]: videoPrefs } : {}),
    ...(session ? { [STUDIO_SESSION_KEY]: session } : {}),
    ...(projectSessions ? { [STUDIO_PROJECT_SESSIONS_KEY]: projectSessions } : {}),
    ...(dramaProjects ? { [DRAMA_PROJECTS_KEY]: dramaProjects } : {}),
    ...(videoProjects ? { [VIDEO_PROJECTS_KEY]: videoProjects } : {}),
  };

  const rawPayload = {
    ...sharedRawSeed,
    ...(trimString(savedSeed?.textModelRaw) ? { [TEXT_MODEL_KEY]: savedSeed.textModelRaw } : {}),
    ...(trimString(savedSeed?.currentProjectRaw) ? { [CURRENT_PROJECT_KEY]: savedSeed.currentProjectRaw } : {}),
    ...(trimString(savedSeed?.automationModeRaw)
      ? { [AUTOMATION_MODE_KEY]: savedSeed.automationModeRaw }
      : {}),
  };

  const hasStudioState =
    Boolean(session) ||
    Boolean(projectSessions) ||
    Boolean((Array.isArray(dramaProjects) && dramaProjects.length) || (Array.isArray(videoProjects) && videoProjects.length));

  if (!hasStudioState) {
    throw new Error("No saved desktop studio state was available to seed the current-storage smoke scenario.");
  }

  await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(({ jsonPayload: nextJsonPayload, rawPayload: nextRawPayload }) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(nextJsonPayload)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    for (const [key, value] of Object.entries(nextRawPayload)) {
      localStorage.setItem(key, value);
    }
  }, {
    jsonPayload,
    rawPayload,
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
}

async function copySavedDesktopProjectStoresToIsolatedRoot(targetRoot) {
  const sourceRoot = trimString(sharedDesktopSeed?.sourceRoot);
  if (!sourceRoot) {
    return {
      copiedSessionFiles: 0,
      copiedConversationFiles: 0,
    };
  }

  const copiedSessionFiles = await copyDirectorySnapshot(
    path.join(sourceRoot, "db", "sessions"),
    path.join(targetRoot, "db", "sessions"),
  );
  const copiedConversationFiles = await copyDirectorySnapshot(
    path.join(sourceRoot, "files", "conversations"),
    path.join(targetRoot, "files", "conversations"),
  );

  return {
    copiedSessionFiles,
    copiedConversationFiles,
  };
}

async function stopProcessTree(child) {
  if (!child || child.killed) return;

  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
}

async function ensureServer() {
  if (await waitForServer(DEFAULT_URL, 2000)) {
    return { startedLocalServer: false, dispose: async () => {} };
  }

  const devServer =
    process.platform === "win32"
      ? spawn(
          "cmd.exe",
          ["/d", "/s", "/c", `npm run dev -- --host 127.0.0.1 --port ${DEV_SERVER_PORT}`],
          {
            stdio: "ignore",
            windowsHide: true,
            cwd: process.cwd(),
            env: process.env,
          },
        )
      : spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", DEV_SERVER_PORT], {
          stdio: "ignore",
          cwd: process.cwd(),
          env: process.env,
        });

  const ready = await waitForServer(DEFAULT_URL, 30000);
  if (!ready) {
    await stopProcessTree(devServer);
    throw new Error(`Failed to start homepage dev server at ${DEFAULT_URL}`);
  }

  return {
    startedLocalServer: true,
    dispose: async () => {
      await stopProcessTree(devServer);
    },
  };
}

function createQuestionRequest() {
  return {
    id: "ask-1",
    allowCustomInput: true,
    submissionMode: "immediate",
    questions: [
      {
        header: "题材",
        question: "继续选择题材",
        multiSelect: false,
        options: [{ label: "都市" }, { label: "悬疑" }],
      },
    ],
  };
}

function createSession() {
  return {
    sessionId: "session-current",
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "继续保留第 2 集的张力。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: "drama-project-1",
      projectKind: "script",
      title: "契约婚姻反转录",
      currentObjective: "继续完善创意方案。",
      derivedStage: "创意方案",
      agentSummary: "已进入创意方案阶段。",
      recommendedActions: ["继续推进角色设定", "重写创意方案"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 继续保留第 2 集的张力。",
    projectId: "drama-project-1",
    draft: "补充反派动机",
    qState: {
      request: createQuestionRequest(),
      currentIndex: 0,
      answers: {},
      displayAnswers: {},
    },
    selectedValues: ["都市"],
  };
}

function createFreshHomepageSession(overrides = {}) {
  return {
    sessionId: "session-homepage-fresh",
    compactedMessageCount: 0,
    mode: "idle",
    messages: [],
    currentProjectSnapshot: null,
    recentMessageSummary: "",
    draft: "",
    qState: null,
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
    selectedValues: [],
    ...overrides,
  };
}

function resolveRealSmokeVideoPrefsSeed() {
  const savedPrefs = sharedVideoPrefsOverride ?? parseJsonSafely(sharedDesktopSeed?.videoPrefsRaw);
  return savedPrefs && typeof savedPrefs === "object" ? savedPrefs : REAL_VIDEO_PREFS_SEED;
}

function resolveRealSmokeTextModelSeed() {
  return trimString(sharedDesktopSeed?.textModelRaw) || REAL_TEXT_MODEL_SEED;
}

function createCasualChatDramaProject(projectId = "casual-chat-project-manual") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: projectId === "casual-chat-project-full-auto" ? "全自动闲聊压测项目" : "普通闲聊压测项目",
    currentStep: "creative-plan",
  };
}

function buildCasualChatHistory(projectId) {
  return Array.from({ length: 18 }, (_, index) => {
    const turn = index + 1;
    const timestamp = `2026-04-${String((turn % 9) + 1).padStart(2, "0")}T${String((turn * 3) % 24).padStart(2, "0")}:00:00.000Z`;
    return [
      {
        id: `user-${projectId}-${turn}`,
        role: "user",
        content: `第 ${turn} 轮：先记一下这个项目的直觉感受。`,
        createdAt: timestamp,
      },
      {
        id: `assistant-${projectId}-${turn}`,
        role: "assistant",
        content: `收到，第 ${turn} 轮我先保持轻量交流，再把下一步建议留在当前项目上下文里。`,
        createdAt: timestamp,
      },
    ];
  }).flat();
}

function createCasualChatSession({
  projectId = "casual-chat-project-manual",
  automationMode = "manual",
} = {}) {
  const title = automationMode === "full-auto" ? "全自动闲聊压测项目" : "普通闲聊压测项目";
  const messages = buildCasualChatHistory(projectId);
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    automationMode,
    messages,
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      automationMode,
      title,
      currentObjective: "继续当前对话",
      derivedStage: "历史对话",
      agentSummary: "This session is seeded for casual-conversation streaming pressure tests.",
      recommendedActions: [],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 继续当前对话。",
    projectId,
    draft: "",
    qState: null,
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
    selectedValues: [],
  };
}

function createDramaProject(projectId = "drama-project-1") {
  return {
    id: projectId,
    dramaTitle: "契约婚姻反转录",
    currentStep: "creative-plan",
    updatedAt: "2026-04-02T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    setup: {
      genres: ["都市言情"],
      audience: "女频",
      tone: "甜虐",
      ending: "HE",
      totalEpisodes: 40,
      targetMarket: "cn",
      creativeInput: "替父还债的女主和冷面继承人签下契约婚姻。",
    },
  };
}

function createAutomationSwitchDramaProject(projectId = "manual-switch-project-1") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: "Manual Switch Project",
    currentStep: "creative-plan",
  };
}

function createAutomationSwitchSession(projectId = "manual-switch-project-1") {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    automationMode: "manual",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "manual seed history should disappear after switching to full-auto",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      title: "Manual Switch Project",
      currentObjective: "Continue manual script planning",
      derivedStage: "Creative Plan",
      agentSummary: "Manual session seeded for automation-mode isolation smoke coverage.",
      recommendedActions: ["Continue manual script planning"],
      artifacts: [],
      automationMode: "manual",
    },
    recentMessageSummary: "assistant: manual seed history should disappear after switching to full-auto",
    projectId,
    draft: "",
    qState: null,
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
    selectedValues: [],
  };
}

function createFullAutoSwitchDramaProject(projectId = "full-auto-switch-project-1") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: "Full Auto Switch Project",
    currentStep: "creative-plan",
  };
}

function createFullAutoSwitchSession(projectId = "full-auto-switch-project-1") {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    automationMode: "full-auto",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "full auto seed history should stay isolated from manual mode",
        createdAt: "2026-04-03T00:01:00.000Z",
      },
      {
        id: `user-${projectId}-1`,
        role: "user",
        content: "全自动：继续当前原创剧本项目",
        createdAt: "2026-04-03T00:01:01.000Z",
        automationOrigin: "full-auto",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      title: "Full Auto Switch Project",
      currentObjective: "Continue full-auto project planning",
      derivedStage: "Creative Plan",
      agentSummary: "Full-auto session seeded for repeated automation-mode switching smoke coverage.",
      recommendedActions: ["Continue full-auto project planning"],
      artifacts: [],
      automationMode: "full-auto",
    },
    recentMessageSummary: "assistant: full auto seed history should stay isolated from manual mode",
    projectId,
    draft: "",
    qState: null,
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
    selectedValues: [],
    fullAutoRun: {
      status: "running",
      plan: null,
      currentStepIndex: 0,
    },
  };
}

function createLongSession() {
  return {
    ...createSession(),
    qState: null,
    draft: "",
    selectedValues: [],
    recentMessageSummary: "",
    messages: Array.from({ length: 24 }, (_, index) => ({
      id: `long-msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `第 ${index + 1} 条长消息：围绕角色、市场、风格和分集推进的历史上下文。`,
      createdAt: `2026-04-03T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  };
}

function createVideoProject(projectId = "video-project-1") {
  return {
    id: projectId,
    title: "夜雨追击预告片",
    script: "女主在雨夜奔跑，回头看见追兵。",
    targetPlatform: "抖音",
    shotStyle: "电影感近景",
    outputGoal: "预告片",
    productionNotes: "保留主角红衣和夜雨气氛。",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "雨夜追击",
        description: "女主在雨夜奔跑，回头看见追兵。",
        characters: ["沈昭"],
        dialogue: "",
        cameraDirection: "中景，跟拍",
        duration: 5,
        storyboardUrl: "https://example.com/storyboard-1.jpg",
        videoUrl: "https://example.com/video-1.mp4",
        videoStatus: "completed",
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "沈昭",
        description: "红衣、清冷、警觉",
        imageUrl: "https://example.com/char-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "雨夜长街",
        description: "冷色夜雨中的长街",
        imageUrl: "https://example.com/scene-1.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    artStyle: "live-action",
    currentStep: 5,
    systemPrompt: "",
    analysisSummary: "已编译镜头指令包，等待审阅。",
    storyboardPlan: "镜头 1：雨夜追击。",
    videoPromptBatch: "镜头 1 提示词。",
    sourceProjectId: "drama-1",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:30:00.000Z",
    styleLock: null,
    worldModel: null,
    assetManifest: null,
    shotPackets: [
      {
        id: "packet:video-project-1:scene-1",
        sceneId: "scene-1",
        sceneNumber: 1,
        title: "雨夜追击",
        durationSec: 5,
        camera: {
          shotSize: "标准镜头",
          movement: "中景，跟拍",
        },
        characterRefs: [],
        sourceAssetIds: [],
        promptSeed: "女主在雨夜奔跑，回头看见追兵。",
        forbiddenChanges: ["不要改变主角色的识别特征和服装连续性。"],
        renderMode: "img2video",
        reviewStatus: "pending",
      },
    ],
    reviewQueue: [
      {
        id: "review:packet:video-project-1:scene-1",
        title: "审阅镜头 1 · 雨夜追击",
        summary: "镜头已有可审阅素材，确认是否通过或需要重做。",
        targetIds: ["packet:video-project-1:scene-1"],
        status: "pending",
        createdAt: "2026-04-03T00:30:00.000Z",
        updatedAt: "2026-04-03T00:30:00.000Z",
      },
    ],
  };
}

function createVideoStyleKickoffQuestion(projectId = "video-project-2") {
  return {
    id: `video-kickoff-prefs-style-${projectId}`,
    title: "选择画面风格类型",
    description: "直接选择预设风格，或在底部输入自定义风格说明；也可以上传参考图后发送，我会自动识别并继续下一步。",
    options: [
      {
        id: `${projectId}-video-kickoff-style-category-live-action`,
        label: "写实类",
        value: "video:kickoff:prefs:style-category:live-action",
        rationale: "适合真人影视与写实 CG 的镜头表达。",
        children: [
          {
            id: `${projectId}-video-kickoff-style-preset-film-noir`,
            label: "电影黑色质感",
            value: "video:kickoff:prefs:style-preset:film-noir",
            rationale: "强化低饱和、反差和悬疑氛围。",
          },
        ],
      },
      {
        id: `${projectId}-video-kickoff-style-category-animation-2d`,
        label: "二维动画类",
        value: "video:kickoff:prefs:style-category:animation-2d",
        rationale: "适合平面插画与卡通叙事。",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 1,
    totalSteps: 2,
    answerKey: "video-kickoff-prefs-style",
  };
}

function createVideoStyleProject(projectId = "video-project-2") {
  return {
    ...createVideoProject(projectId),
    title: "风格面板测试项目",
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    productionNotes: "用于验证风格面板的自定义输入与参考图上传。",
    scenes: [],
    characters: [],
    sceneSettings: [],
    currentStep: 1,
    analysisSummary: "",
    storyboardPlan: "",
    videoPromptBatch: "",
    shotPackets: [],
    reviewQueue: [],
  };
}

function createVideoStyleSession(projectId = "video-project-2") {
  const pendingChoiceQuestion = createVideoStyleKickoffQuestion(projectId);
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "先确认这支视频的画面风格类型。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "video",
      title: "风格面板测试项目",
      currentObjective: "选择画面风格类型",
      derivedStage: "视频生成模式",
      agentSummary: "等待确认画面风格。",
      recommendedActions: ["选择画面风格类型"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 先确认这支视频的画面风格类型。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion,
    interruptedChoiceQuestion: null,
  };
}

function createVideoAnalyzeDurationQuestion(projectId = "video-project-3") {
  return {
    id: `video-analyze-duration-${projectId}`,
    title: "请选择单集时长",
    description: "时长会影响镜头拆解的颗粒度和时长分配",
    options: [
      {
        id: `${projectId}-duration-60`,
        label: "60 秒",
        value: "video:bridge:analyze:dur:60",
        rationale: "快节奏短剧，每集约 60 秒",
      },
      {
        id: `${projectId}-duration-90`,
        label: "90 秒",
        value: "video:bridge:analyze:dur:90",
        rationale: "标准时长，适合大多数短剧类型",
      },
      {
        id: `${projectId}-duration-custom`,
        label: "自定义",
        value: "video:bridge:analyze:dur:custom",
        rationale: "手动输入自定义时长",
        childInput: {
          type: "number",
          actionPrefix: "video:bridge:analyze:dur:n:",
          min: 15,
          max: 600,
          placeholder: "输入时长（秒）",
          suffix: "秒",
          buttonLabel: "确认",
        },
      },
    ],
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 2,
    answerKey: "video-analyze-duration",
  };
}

function createVideoAnalyzeDurationProject(projectId = "video-project-3") {
  return {
    ...createVideoProject(projectId),
    title: "时长面板测试项目",
    currentStep: 0,
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    scenes: [],
    shotPackets: [],
    reviewQueue: [],
  };
}

function createVideoAnalyzeDurationSession(projectId = "video-project-3") {
  const pendingChoiceQuestion = createVideoAnalyzeDurationQuestion(projectId);
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "在拆解脚本前，先确认单集时长。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "video",
      title: "时长面板测试项目",
      currentObjective: "请选择单集时长",
      derivedStage: "剧本拆解",
      agentSummary: "等待确认剧本拆解时长参数。",
      recommendedActions: ["请选择单集时长"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 在拆解脚本前，先确认单集时长。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion,
    interruptedChoiceQuestion: null,
  };
}

function createVideoAnalyzeDurationSessionForMode(
  projectId = "video-project-3",
  automationMode = "manual",
) {
  const session = createVideoAnalyzeDurationSession(projectId);
  return {
    ...session,
    automationMode,
    currentProjectSnapshot: session.currentProjectSnapshot
      ? {
          ...session.currentProjectSnapshot,
          automationMode,
        }
      : session.currentProjectSnapshot,
  };
}

function createVideoEntryQuestion(projectId = "drama-project-video-entry") {
  return {
    id: `script-export-${projectId}`,
    title: "《视频入口串联测试剧本》导出与出片面板",
    description: "导出稿已准备完成，可继续接入视频工作流。",
    options: [
      {
        id: `${projectId}-export-video`,
        label: "用于视频创作",
        value: "script:export-video",
        rationale: "把当前剧本直接桥接到首页视频工作流，不再跳出当前会话。",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-export",
  };
}

function createVideoEntryDramaProject(projectId = "drama-project-video-entry") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: "视频入口串联测试剧本",
    currentStep: "export",
    creativePlan: "围绕雨夜追击和仓库反杀做出片导向的短剧预告。",
    exportDocument: [
      "第1集：雨夜追击",
      "沈昭在雨夜长街狂奔，回头看见追兵逼近。她躲入废弃仓库，听到父亲留下的暗号电话，决定反向设局。",
      "仓库入口灯光忽明忽暗，追兵分成两路包抄。沈昭借着货架和断电制造视线差，逐步把对方引进自己预设的死角。",
      "她在深处找到父亲留下的账本，同时从监控噪点里发现幕后主使一直在远程监听自己，决定先带着证据突围。",
    ].join("\n"),
  };
}

function createVideoEntrySession(projectId = "drama-project-video-entry") {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "导出稿已整理好，可以继续接入视频工作流。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      title: "视频入口串联测试剧本",
      currentObjective: "用于视频创作",
      derivedStage: "导出与出片",
      agentSummary: "当前导出稿已就绪，等待接入视频工作流。",
      recommendedActions: ["用于视频创作"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 导出稿已整理好，可以继续接入视频工作流。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: createVideoEntryQuestion(projectId),
    interruptedChoiceQuestion: null,
  };
}

function createSkipComplianceHistoryDramaProject(projectId = "drama-project-skip-history") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: "Skip Review Script",
    currentStep: "compliance",
    creativePlan: "Named script that should stay bound to the compliance skip action.",
    characters: "Lead protagonist and rival.",
    directoryRaw: "Episode 1: Conflict escalates.",
    exportDocument: "Export draft content for skip-review smoke coverage.",
    complianceReport: "Compliance report ready.",
    complianceMode: "dialogue",
  };
}

function createSkipComplianceHistoryVideoProject(projectId = "video-project-live-skip") {
  return {
    ...createVideoProject(projectId),
    title: "Live Video Bridge Project",
    sourceProjectId: "drama-project-skip-history",
  };
}

function createSkipComplianceQuestion(projectId = "drama-project-skip-history") {
  return {
    id: `skip-compliance-${projectId}`,
    title: "处理合规审查",
    description: "可以先修复风险，或直接跳过审查进入导出。",
    options: [
      {
        id: `${projectId}-skip-compliance`,
        label: "跳过审查",
        value: "script:skip-compliance-review",
        rationale: "直接进入导出，并标记本次合规审查已跳过。",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "script-compliance",
  };
}

function createSkipComplianceSidebarSession(projectId = "drama-project-skip-history") {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-history`,
        role: "assistant",
        content: "合规审查已完成，可继续跳过审查。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      title: "Skip Review Script",
      currentObjective: "跳过审查",
      derivedStage: "Compliance",
      agentSummary: "History-backed named script session.",
      recommendedActions: ["跳过审查"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 合规审查已完成，可继续跳过审查。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: createSkipComplianceQuestion(projectId),
    interruptedChoiceQuestion: null,
  };
}

function createSkipComplianceHistorySession(
  scriptProjectId = "drama-project-skip-history",
  videoProjectId = "video-project-live-skip",
) {
  return {
    sessionId: `session-${videoProjectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${videoProjectId}-compliance-history`,
        role: "assistant",
        content: "合规审查已完成，可继续跳过审查。",
        createdAt: "2026-04-03T00:00:00.000Z",
        artifactIds: ["compliance-history-artifact"],
        artifactSnapshots: [
          {
            id: "compliance-history-artifact",
            kind: "compliance",
            label: "合规工作台",
            summary: "Skip review should route back to the named script project.",
            updatedAt: "2026-04-03T00:00:00.000Z",
            actions: [
              {
                id: `${scriptProjectId}-skip-review`,
                label: "跳过审查",
                value: "script:skip-compliance-review",
              },
            ],
          },
        ],
        workflowRefresh: {
          mode: "shortcut",
          action: "review_export_compliance",
          input: { projectId: scriptProjectId },
          userBubble: "跳过审查",
          projectId: scriptProjectId,
        },
      },
    ],
    currentProjectSnapshot: {
      projectId: videoProjectId,
      projectKind: "video",
      title: "Live Video Bridge Project",
      currentObjective: "Continue video workflow",
      derivedStage: "角色与场景",
      agentSummary: "Video project is live while the history card still points back to the script.",
      recommendedActions: [],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 合规审查已完成，可继续跳过审查。",
    projectId: videoProjectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

function createDeleteBridgeDramaProject(projectId = "drama-project-delete-bridge") {
  return {
    ...createDramaProject(projectId),
    dramaTitle: "Delete Bridge Project",
    currentStep: "export",
    exportDocument: "Export draft for bridge-delete smoke coverage.",
  };
}

function createDeleteBridgeVideoProject(projectId = "video-project-delete-bridge") {
  return {
    ...createVideoProject(projectId),
    title: "Delete Bridge Project",
    sourceProjectId: "drama-project-delete-bridge",
  };
}

function createDeleteBridgeScriptSession(projectId = "drama-project-delete-bridge") {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "Bridge source script session",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      title: "Delete Bridge Project",
      currentObjective: "Bridge source script",
      derivedStage: "Export",
      agentSummary: "Source script behind the bridged video project.",
      recommendedActions: [],
      artifacts: [],
    },
    recentMessageSummary: "assistant: Bridge source script session",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

function createDeleteBridgeVideoSession(
  scriptProjectId = "drama-project-delete-bridge",
  videoProjectId = "video-project-delete-bridge",
) {
  return {
    sessionId: `session-${videoProjectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${videoProjectId}-1`,
        role: "assistant",
        content: "Video workflow is now active.",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: videoProjectId,
      projectKind: "video",
      sourceProjectId: scriptProjectId,
      title: "Delete Bridge Project",
      currentObjective: "Continue video workflow",
      derivedStage: "Role and Scene",
      agentSummary: "The bridged video project should delete cleanly in one pass.",
      recommendedActions: [],
      artifacts: [],
    },
    recentMessageSummary: "assistant: Video workflow is now active.",
    projectId: videoProjectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

function createStressDramaProjects(count = 180) {
  return Array.from({ length: count }, (_, index) => {
    const projectId = `stress-drama-${index + 1}`;
    return {
      ...createDramaProject(projectId),
      dramaTitle: `压力测试会话 ${index + 1}`,
      updatedAt: `2026-04-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    };
  });
}

function createStressDramaSession(project) {
  return {
    ...createSession(),
    sessionId: `session-${project.id}`,
    messages: [
      {
        id: `assistant-${project.id}`,
        role: "assistant",
        content: `已接入《${project.dramaTitle}》的创作上下文。`,
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: project.id,
      projectKind: "script",
      title: project.dramaTitle,
      currentObjective: "继续整理当前剧本项目",
      derivedStage: "创意方案",
      agentSummary: "等待继续推进当前项目。",
      recommendedActions: ["继续推进当前项目"],
      artifacts: [],
    },
    recentMessageSummary: `assistant: 已接入《${project.dramaTitle}》的创作上下文。`,
    projectId: project.id,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

const STRESS_IMAGE_RESPONSE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnQZTcAAAAASUVORK5CYII=";

function createStressAssetManifestItems(count = 220) {
  return Array.from({ length: count }, (_, index) => ({
    id: `stress-asset-${index + 1}`,
    kind: "character-reference",
    label: `压力素材 ${index + 1}`,
    url: `https://example.com/stress-assets/${index + 1}.jpg`,
    origin: "derived",
    meta: "角色",
    reusable: index % 2 === 0,
    status: "ready",
  }));
}

function createAssetStressVideoProject(projectId = "video-project-asset-stress", assetCount = 220) {
  return {
    ...createVideoProject(projectId),
    title: "素材压力测试项目",
    scenes: [],
    characters: Array.from({ length: assetCount }, (_, index) => ({
      id: `stress-char-${index + 1}`,
      name: `压力素材 ${index + 1}`,
      description: "用于压测素材库滚动与预览。",
      imageUrl: `https://example.com/stress-assets/${index + 1}.jpg`,
      isAIGenerated: false,
      source: "auto",
    })),
    sceneSettings: [],
    shotPackets: [],
    reviewQueue: [],
    assetManifest: {
      items: createStressAssetManifestItems(assetCount),
    },
  };
}

function createAssetStressSession(projectId = "video-project-asset-stress", assetCount = 220) {
  const manifestItems = createStressAssetManifestItems(assetCount);
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "素材库已同步完成，可继续检查与复用。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "video",
      title: "素材压力测试项目",
      currentObjective: "检查素材库与复用情况",
      derivedStage: "角色与场景",
      agentSummary: "素材库已准备完成。",
      recommendedActions: ["检查素材库"],
      artifacts: [],
      memory: {
        assetManifest: {
          items: manifestItems,
        },
      },
    },
    recentMessageSummary: "assistant: 素材库已同步完成，可继续检查与复用。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

async function readStoredVideoProject(page, projectId) {
  return page.evaluate(([projectsKey, id]) => {
    const raw = window.localStorage.getItem(projectsKey);
    if (!raw) return null;
    try {
      const projects = JSON.parse(raw);
      if (!Array.isArray(projects)) return null;
      return projects.find((project) => project?.id === id) ?? null;
    } catch {
      return null;
    }
  }, [VIDEO_PROJECTS_KEY, projectId]);
}

async function readStoredDramaProjects(page) {
  return page.evaluate(([projectsKey]) => {
    const raw = window.localStorage.getItem(projectsKey);
    if (!raw) return [];
    try {
      const projects = JSON.parse(raw);
      return Array.isArray(projects) ? projects : [];
    } catch {
      return [];
    }
  }, [DRAMA_PROJECTS_KEY]);
}

async function waitForCurrentVideoProjectId(page, timeout = 120000) {
  await page.waitForFunction(
    ([sessionKey]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw);
        return (
          session?.currentProjectSnapshot?.projectKind === "video" &&
          typeof session?.currentProjectSnapshot?.projectId === "string" &&
          session.currentProjectSnapshot.projectId.trim().length > 0
        );
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY],
    { timeout },
  );

  return page.evaluate(([sessionKey]) => {
    const raw = window.localStorage.getItem(sessionKey);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw);
      return session?.currentProjectSnapshot?.projectId ?? null;
    } catch {
      return null;
    }
  }, [STUDIO_SESSION_KEY]);
}

async function readStoredStudioSession(page) {
  return page.evaluate(([sessionKey]) => {
    const raw = window.localStorage.getItem(sessionKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [STUDIO_SESSION_KEY]);
}

async function waitForStoredProjectSessionSnapshot(page, sessionProjectId, snapshotProjectId, timeout = 10000) {
  await page.waitForFunction(
    ([projectSessionsKey, expectedSessionProjectId, expectedSnapshotProjectId]) => {
      const raw = window.localStorage.getItem(projectSessionsKey);
      if (!raw) return false;
      try {
        const sessions = JSON.parse(raw);
        const session = sessions?.[expectedSessionProjectId];
        return (
          session?.projectId === expectedSessionProjectId &&
          session?.currentProjectSnapshot?.projectId === expectedSnapshotProjectId &&
          !sessions?.[expectedSnapshotProjectId]
        );
      } catch {
        return false;
      }
    },
    [STUDIO_PROJECT_SESSIONS_KEY, sessionProjectId, snapshotProjectId],
    { timeout },
  );
}

async function waitForStoredStudioSessionShell(page, sessionProjectId, snapshotProjectId, timeout = 10000) {
  await page.waitForFunction(
    ([sessionKey, expectedSessionProjectId, expectedSnapshotProjectId]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw);
        return (
          session?.projectId === expectedSessionProjectId &&
          session?.currentProjectSnapshot?.projectId === expectedSnapshotProjectId
        );
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, sessionProjectId, snapshotProjectId],
    { timeout },
  );
}

async function readVisibleAssistantMessages(page, limit = 12) {
  return page.evaluate(([maxItems]) => {
    return Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']"))
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-maxItems);
  }, [limit]);
}

async function waitForLatestAssistantReply(page, previousAssistantCount, timeout = 180000) {
  await page.waitForFunction(
    ([expectedPreviousCount]) => {
      const rows = Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']"));
      if (rows.length <= expectedPreviousCount) return false;
      const lastRow = rows[rows.length - 1];
      const body =
        lastRow?.querySelector('[data-home-agent-assistant-body="true"]') ??
        lastRow?.querySelector("[data-home-agent-assistant-body]") ??
        null;
      const bodyText = (body?.textContent || "").replace(/\s+/g, " ").trim();
      const streamLabel = (
        lastRow?.querySelector('[data-testid="agent-streaming-label"]')?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      return bodyText.length > 0 && !streamLabel;
    },
    [previousAssistantCount],
    { timeout },
  );

  const visibleAssistantMessages = await readVisibleAssistantMessages(page, Math.max(previousAssistantCount + 2, 12));
  return visibleAssistantMessages[visibleAssistantMessages.length - 1] ?? "";
}

async function readVisibleUserMessages(page, limit = 20) {
  return page.evaluate(([maxItems]) => {
    return Array.from(document.querySelectorAll("[data-home-agent-message-role='user']"))
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(-maxItems);
  }, [limit]);
}

async function countVisibleUserMessagesMatching(page, text) {
  return page.evaluate(([expectedText]) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("[data-home-agent-message-role='user']"))
      .map((element) => normalize(element.textContent || ""))
      .filter((value) => value === expectedText)
      .length;
  }, [text]);
}

async function countStoredUserMessagesMatching(page, text) {
  return page.evaluate(([sessionKey, expectedText]) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const raw = window.localStorage.getItem(sessionKey);
    if (!raw) return 0;
    try {
      const session = JSON.parse(raw);
      if (!Array.isArray(session?.messages)) return 0;
      return session.messages.filter((message) =>
        message?.role === "user" && normalize(message?.content) === expectedText
      ).length;
    } catch {
      return 0;
    }
  }, [STUDIO_SESSION_KEY, text]);
}

async function readComposerValue(page) {
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  return textarea.inputValue();
}

async function readVisibleFullAutoChecklist(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid^="full-auto-checklist-item-"]')).map((element) => ({
      testId: element.getAttribute("data-testid") || "",
      status: element.getAttribute("data-full-auto-checklist-status") || "",
      text: (element.textContent || "").replace(/\s+/g, " ").trim(),
    }));
  });
}

async function waitForRealFullAutoCompletion(page, timeout = REAL_FULL_AUTO_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const session = await readStoredStudioSession(page);
    const run = session?.fullAutoRun ?? null;
    const snapshot = session?.currentProjectSnapshot ?? null;
    const hasVideoProject =
      snapshot?.projectKind === "video" &&
      typeof snapshot?.projectId === "string" &&
      snapshot.projectId.trim().length > 0;

    if (run?.status === "completed" && hasVideoProject) {
      return session;
    }

    if (run?.status === "failed") {
      throw new Error(
        `Real full-auto run failed at ${run.currentStepLabel || "unknown-step"}: ${run.lastError || "unknown error"}`,
      );
    }

    if (run?.status === "stopped") {
      throw new Error(
        `Real full-auto run stopped at ${run.currentStepLabel || "unknown-step"}${run.lastError ? `: ${run.lastError}` : ""}`,
      );
    }

    await page.waitForTimeout(2000);
  }

  const timeoutSession = await readStoredStudioSession(page);
  const timeoutRun = timeoutSession?.fullAutoRun ?? null;
  const timeoutSnapshot = timeoutSession?.currentProjectSnapshot ?? null;
  const timeoutAnswers = timeoutRun?.plan?.answers ?? {};
  throw new Error(
    `Real full-auto run timed out with status=${timeoutRun?.status || "missing"} step=${timeoutRun?.currentStepLabel || "unknown-step"} error=${timeoutRun?.lastError || "none"} projectKind=${timeoutSnapshot?.projectKind || "missing"} projectId=${timeoutSnapshot?.projectId || "missing"} adaptationEpisodeCount=${JSON.stringify(timeoutAnswers.adaptationEpisodeCount ?? null)} episodeWriting=${JSON.stringify(timeoutAnswers.episodeWriting ?? null)} scriptExportRoute=${JSON.stringify(timeoutAnswers.scriptExportRoute ?? null)}`,
  );
}

async function waitForExportArtifacts(rootDir, beforeCount = 0, timeout = REAL_FULL_AUTO_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const files = await listFilesRecursive(rootDir);
    if (files.length > beforeCount) {
      return files;
    }
    await sleep(1500);
  }
  return listFilesRecursive(rootDir);
}

function diffArtifactFiles(beforeFiles, afterFiles) {
  const beforeMap = new Map(
    (beforeFiles ?? []).map((entry) => [`${entry.relativePath}:${entry.size}:${entry.mtimeMs}`, entry]),
  );
  return (afterFiles ?? []).filter(
    (entry) => !beforeMap.has(`${entry.relativePath}:${entry.size}:${entry.mtimeMs}`),
  );
}

async function readStoredProjectSessions(page) {
  return page.evaluate(([sessionKey]) => {
    const raw = window.localStorage.getItem(sessionKey);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }, [STUDIO_PROJECT_SESSIONS_KEY]);
}

async function readWorkflowTestTrace(page) {
  return page.evaluate(([traceKey]) => {
    const raw = window.localStorage.getItem(traceKey);
    if (!raw) return [];
    try {
      const trace = JSON.parse(raw);
      return Array.isArray(trace) ? trace : [];
    } catch {
      return [];
    }
  }, [WORKFLOW_TEST_TRACE_KEY]);
}

async function waitForVideoProjectBreakdown(page, projectId, timeout = 180000) {
  await page.waitForFunction(
    ([projectsKey, id]) => {
      const raw = window.localStorage.getItem(projectsKey);
      if (!raw) return false;
      try {
        const projects = JSON.parse(raw);
        if (!Array.isArray(projects)) return false;
        const project = projects.find((item) => item?.id === id);
        return Boolean(
          project &&
            project.scriptBreakdownPassed === true &&
            Array.isArray(project.scenes) &&
            project.scenes.length > 0,
        );
      } catch {
        return false;
      }
    },
    [VIDEO_PROJECTS_KEY, projectId],
    { timeout },
  );
}

async function waitForVideoProjectEntities(page, projectId, timeout = 180000) {
  await page.waitForFunction(
    ([projectsKey, id]) => {
      const raw = window.localStorage.getItem(projectsKey);
      if (!raw) return false;
      try {
        const projects = JSON.parse(raw);
        if (!Array.isArray(projects)) return false;
        const project = projects.find((item) => item?.id === id);
        return Boolean(
          project &&
            ((Array.isArray(project.characters) && project.characters.length > 0) ||
              (Array.isArray(project.sceneSettings) && project.sceneSettings.length > 0)),
        );
      } catch {
        return false;
      }
    },
    [VIDEO_PROJECTS_KEY, projectId],
    { timeout },
  );
}

async function resetAndSeed(page, seed, options = {}) {
  await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(({ jsonPayload, rawPayload }) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(jsonPayload)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    for (const [key, value] of Object.entries(rawPayload)) {
      localStorage.setItem(key, value);
    }
  }, {
    jsonPayload: {
      ...(options.includeSharedJsonSeed === false ? {} : sharedJsonSeed),
      ...seed,
    },
    rawPayload: {
      ...(options.includeSharedRawSeed === false ? {} : sharedRawSeed),
      ...(options.rawSeed ?? {}),
    },
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
}

async function setWorkflowTestScenario(page, scenario) {
  await page.evaluate(
    ({ scenarioKey, traceKey, scenario }) => {
      if (scenario) {
        window.localStorage.setItem(scenarioKey, scenario);
      } else {
        window.localStorage.removeItem(scenarioKey);
      }
      window.localStorage.removeItem(traceKey);
    },
    {
      scenarioKey: WORKFLOW_TEST_SCENARIO_KEY,
      traceKey: WORKFLOW_TEST_TRACE_KEY,
      scenario,
    },
  );
}

async function readElectronSelectedFolder(page) {
  return page.evaluate(() => window.electronAPI?.storage?.selectFolder?.() ?? null);
}

function sendButtonLocator(page) {
  return page.locator('button[aria-label="发送消息"]:visible').last();
}

async function listVisibleButtons(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("button"))
      .map((button, index) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) return null;
        return {
          index,
          text: normalize(button.innerText || button.textContent || ""),
          ariaLabel: normalize(button.getAttribute("aria-label") || ""),
          disabled:
            button.hasAttribute("disabled") ||
            button.getAttribute("aria-disabled") === "true",
        };
      })
      .filter(Boolean)
      .filter((button) => button.text || button.ariaLabel);
  });
}

async function listVisibleHistoryEntries(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        const list = element.closest("[data-sidebar-history-list='true']");
        if (!(list instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const listStyle = window.getComputedStyle(list);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (listStyle.display === "none" || listStyle.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && listRect.width > 0 && listRect.height > 0;
      })
      .map((element) => ({
        projectId: element.getAttribute("data-sidebar-history-id") || "",
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
      })),
  );
}

async function readSidebarHistoryCountState(page) {
  return page.evaluate(() => {
    const countBadge = document.querySelector("[data-sidebar-history-count='true']");
    const historyList = document.querySelector("[data-sidebar-history-list='true']");
    const renderedCountRaw =
      historyList instanceof HTMLElement ? historyList.getAttribute("data-sidebar-history-rendered-count") : null;
    const totalCountRaw =
      historyList instanceof HTMLElement ? historyList.getAttribute("data-sidebar-history-total-count") : null;
    const parseCount = (value) => {
      const numeric = Number(String(value ?? "").trim());
      return Number.isFinite(numeric) ? numeric : null;
    };
    return {
      badgeText: (countBadge?.textContent || "").replace(/\s+/g, " ").trim() || null,
      renderedCount: parseCount(renderedCountRaw),
      totalCount: parseCount(totalCountRaw),
    };
  });
}

async function readVisibleHistoryEntries(page, limit = 6) {
  return page.evaluate((maxItems) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
      .map((element) => ({
        projectId: element.getAttribute("data-sidebar-history-id") || "",
        text: normalize(element.textContent || ""),
      }))
      .filter((entry) => entry.projectId)
      .slice(0, maxItems);
  }, limit);
}

async function readVisibleAssetRows(page, limit = 120) {
  return page.evaluate((maxItems) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const list = document.querySelector("[data-sidebar-asset-list='image']");
    if (!(list instanceof HTMLElement)) return [];
    return Array.from(list.querySelectorAll("[data-sidebar-asset-id]"))
      .map((element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) return null;
        const id = element.getAttribute("data-sidebar-asset-id") || "";
        const trigger = element.querySelector("button[aria-label]");
        const label = normalize(
          trigger?.getAttribute("aria-label") ||
            trigger?.textContent ||
            element.textContent ||
            "",
        );
        if (!id || !label || label.startsWith("删除 ")) return null;
        return { id, label };
      })
      .filter(Boolean)
      .slice(0, maxItems);
  }, limit);
}

async function clickHistoryById(page, projectId) {
  const target = page.locator(`[data-sidebar-history-id='${projectId}']`).first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click();
}

async function findFirstVisibleHistoryEntryForMode(page, mode) {
  return page.evaluate((expectedMode) => {
    const entries = Array.from(document.querySelectorAll("[data-sidebar-history-id]"));
    for (const element of entries) {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const entryMode = /AUTO/.test(text) ? "full-auto" : "manual";
      if (entryMode === expectedMode) {
        return {
          projectId: element.getAttribute("data-sidebar-history-id") || "",
          text,
        };
      }
    }
    return null;
  }, mode);
}

async function waitForStoredSessionProjectId(page, projectId, timeout = 10000) {
  await page.waitForFunction(
    ([sessionKey, expectedProjectId]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.currentProjectSnapshot?.projectId === expectedProjectId;
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, projectId],
    { timeout },
  );
}

async function readStoredAutomationModeValue(page) {
  return page.evaluate((automationModeKey) => window.localStorage.getItem(automationModeKey), AUTOMATION_MODE_KEY);
}

function pickSessionTextNeedle(session) {
  if (!Array.isArray(session?.messages)) return null;
  const ignoredPrefixes = [
    "已更新项目",
    "收到",
    "正在",
    "继续",
    "原创剧本",
    "参考改编",
    "视频工作流",
    "新建项目",
  ];
  for (const message of [...session.messages].reverse()) {
    const normalized = String(message?.content || "").replace(/\s+/g, " ").trim();
    if (normalized.length < 12) continue;
    if (ignoredPrefixes.some((prefix) => normalized.startsWith(prefix))) continue;
    const snippet = normalized.slice(0, 24).trim();
    if (snippet.length >= 10) return snippet;
  }
  return null;
}

async function switchAutomationMode(page, mode) {
  const targetLabel = mode === "full-auto" ? "全自动模式" : "普通模式";
  const targetButton = page.getByRole("button", { name: targetLabel }).last();
  if ((await targetButton.count()) === 0 || !(await targetButton.first().isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "打开或关闭设置" }).first().click();
  }
  try {
    await targetButton.waitFor({ state: "visible", timeout: 15000 });
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `targetMode=${mode}`,
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2200),
      ].join("\n"),
    );
  }
  await targetButton.click();
  await page.waitForFunction(
    ([targetMode]) => {
      const modeContainer = document.querySelector("[data-automation-mode]");
      return modeContainer?.getAttribute("data-automation-mode") === targetMode;
    },
    [mode],
    { timeout: 15000 },
  );
}

async function findVisibleElementsContainingText(page, needle) {
  return page.evaluate((rawNeedle) => {
    const needle = (rawNeedle || "").replace(/\s+/g, " ").trim();
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    if (!needle) return [];
    return Array.from(document.querySelectorAll("body *"))
      .map((element, index) => {
        const text = normalize(element.textContent || "");
        if (!text.includes(needle)) return null;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) return null;
        const childContainsNeedle = Array.from(element.children).some((child) =>
          normalize(child.textContent || "").includes(needle),
        );
        if (childContainsNeedle) return null;
        return {
          index,
          tag: element.tagName.toLowerCase(),
          role: normalize(element.getAttribute("role") || ""),
          ariaLabel: normalize(element.getAttribute("aria-label") || ""),
          text,
          className:
            typeof element.className === "string"
              ? normalize(element.className)
              : "",
        };
      })
      .filter(Boolean)
      .slice(0, 20);
  }, needle);
}

async function tryClickVisibleButtonByLabels(page, labels) {
  return page.evaluate((rawLabels) => {
    const labels = rawLabels
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll("button"))
      .map((button, index) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) return null;
        return {
          button,
          index,
          text: normalize(button.innerText || button.textContent || ""),
          ariaLabel: normalize(button.getAttribute("aria-label") || ""),
          disabled:
            button.hasAttribute("disabled") ||
            button.getAttribute("aria-disabled") === "true",
        };
      })
      .filter(Boolean);
    const target = candidates.find(
      (candidate) =>
        !candidate.disabled &&
        labels.some(
          (label) =>
            candidate.text.includes(label) || candidate.ariaLabel.includes(label),
        ),
    );
    if (!target) {
      return {
        clicked: false,
        buttons: candidates.slice(0, 80).map(({ index, text, ariaLabel, disabled }) => ({
          index,
          text,
          ariaLabel,
          disabled,
        })),
      };
    }
    target.button.click();
    return {
      clicked: true,
      text: target.text,
      ariaLabel: target.ariaLabel,
    };
  }, labels);
}

async function clickVisibleButtonByLabels(page, labels) {
  await maybeOpenFullAutoQuickTaskSurface(page, labels);
  const firstPass = await tryClickVisibleButtonByLabels(page, labels);
  if (firstPass.clicked) return firstPass;

  const expandPass = await tryClickVisibleButtonByLabels(page, ["展开选择窗"]);
  if (expandPass.clicked) {
    await waitForVisibleButtonLabels(page, labels, 5_000);
    const secondPass = await tryClickVisibleButtonByLabels(page, labels);
    if (secondPass.clicked) return secondPass;
  }

  throw new Error(
    [
      `Could not find a visible button for labels: ${labels.join(" / ")}`,
      "",
      JSON.stringify(firstPass.buttons ?? [], null, 2),
      "",
      `textMatches=${JSON.stringify(await findVisibleElementsContainingText(page, labels[0] || ""), null, 2)}`,
    ].join("\n"),
  );
}

async function waitForVisibleButtonLabels(page, labels, timeout = 120000) {
  await maybeOpenFullAutoQuickTaskSurface(page, labels);
  await page.waitForFunction(
    (rawLabels) => {
      const labels = rawLabels
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button")).some((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) return false;
        const text = normalize(button.innerText || button.textContent || "");
        const ariaLabel = normalize(button.getAttribute("aria-label") || "");
        return labels.some((label) => text.includes(label) || ariaLabel.includes(label));
      });
    },
    labels,
    { timeout },
  );
}

async function maybeOpenFullAutoQuickTaskSurface(page, labels) {
  const wantsQuickTask = labels.some((label) => QUICK_TASK_LABELS.has(String(label ?? "").trim()));
  if (!wantsQuickTask) return;

  const surfaceState = await page.evaluate(({ targetLabels, newProjectLabels }) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const visibleButtons = Array.from(document.querySelectorAll("button")).filter(isVisible);
    const getLabel = (button) => normalize(button.innerText || button.textContent || button.getAttribute("aria-label") || "");
    const mode = document.querySelector("[data-automation-mode]")?.getAttribute("data-automation-mode") || null;
    const hasTargetVisible = visibleButtons.some((button) => {
      const label = getLabel(button);
      return targetLabels.some((targetLabel) => label.includes(targetLabel));
    });
    const hasNewProjectVisible = visibleButtons.some((button) => {
      const label = getLabel(button);
      return newProjectLabels.some((targetLabel) => label.includes(targetLabel));
    });
    return {
      mode,
      hasTargetVisible,
      hasNewProjectVisible,
    };
  }, {
    targetLabels: labels,
    newProjectLabels: NEW_PROJECT_LABELS,
  });

  if (
    surfaceState?.mode === "full-auto" &&
    !surfaceState.hasTargetVisible &&
    surfaceState.hasNewProjectVisible
  ) {
    await tryClickVisibleButtonByLabels(page, NEW_PROJECT_LABELS);
  }
}

async function waitForStandardComposerQuestion(page, { title, buttonLabels = [], timeout = 30000 }) {
  await page.waitForFunction(
    ({ expectedTitle, expectedButtons }) => {
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      return Array.from(document.querySelectorAll('[data-composer-choice-modal="true"]')).some((modal) => {
        if (!isVisible(modal)) return false;
        const modalText = normalize(modal.textContent || "");
        if (expectedTitle && !modalText.includes(expectedTitle)) return false;

        return expectedButtons.every((label) =>
          Array.from(modal.querySelectorAll("button")).some((button) => {
            if (!isVisible(button)) return false;
            const text = normalize(button.innerText || button.textContent || "");
            const ariaLabel = normalize(button.getAttribute("aria-label") || "");
            return text.includes(label) || ariaLabel.includes(label);
          }),
        );
      });
    },
    {
      expectedTitle: title,
      expectedButtons: buttonLabels,
    },
    { timeout },
  );

  return page.evaluate((expectedTitle) => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const modal = Array.from(document.querySelectorAll('[data-composer-choice-modal="true"]')).find((candidate) => {
      if (!isVisible(candidate)) return false;
      const text = normalize(candidate.textContent || "");
      return !expectedTitle || text.includes(expectedTitle);
    });
    if (!(modal instanceof HTMLElement)) return null;

    const visibleButtons = Array.from(modal.querySelectorAll("button"))
      .filter((button) => isVisible(button))
      .map((button) => normalize(button.innerText || button.textContent || "") || normalize(button.getAttribute("aria-label") || ""))
      .filter(Boolean);

    return {
      answerKey: modal.getAttribute("data-composer-question-answer-key"),
      questionId: modal.getAttribute("data-composer-question-id"),
      text: normalize(modal.innerText || modal.textContent || ""),
      visibleButtons,
    };
  }, title);
}

async function readVisibleComposerQuestion(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const modal = Array.from(document.querySelectorAll('[data-composer-choice-modal="true"]')).find((candidate) =>
      isVisible(candidate),
    );
    if (!(modal instanceof HTMLElement)) return null;

    const visibleButtons = Array.from(modal.querySelectorAll("button"))
      .filter((button) => isVisible(button))
      .map((button) => normalize(button.innerText || button.textContent || "") || normalize(button.getAttribute("aria-label") || ""))
      .filter(Boolean);

    return {
      answerKey: modal.getAttribute("data-composer-question-answer-key"),
      questionId: modal.getAttribute("data-composer-question-id"),
      text: normalize(modal.innerText || modal.textContent || ""),
      visibleButtons,
    };
  });
}

function isComposerQuestionControlLabel(value) {
  const normalized = trimString(value);
  return (
    normalized.startsWith("返回上一步") ||
    normalized.startsWith("收起选择窗") ||
    normalized.startsWith("展开选择窗") ||
    normalized.startsWith("重置")
  );
}

function findVisibleComposerQuestionActionLabel(question, keywords) {
  const normalizedKeywords = Array.isArray(keywords)
    ? keywords
        .map((value) => trimString(value))
        .filter(Boolean)
    : [];
  if (!normalizedKeywords.length) return null;

  const visibleButtons = Array.isArray(question?.visibleButtons)
    ? question.visibleButtons
        .map((value) => trimString(value))
        .filter((value) => value && !isComposerQuestionControlLabel(value))
    : [];

  return (
    visibleButtons.find((label) =>
      normalizedKeywords.every((keyword) => label.includes(keyword)),
    ) ??
    visibleButtons.find((label) =>
      normalizedKeywords.some((keyword) => label.includes(keyword)),
    ) ??
    null
  );
}

async function clickVisibleComposerQuestionButton(page, labels) {
  const result = await page.evaluate((rawLabels) => {
    const labels = rawLabels
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const modal = Array.from(document.querySelectorAll('[data-composer-choice-modal="true"]')).find((candidate) =>
      isVisible(candidate),
    );
    if (!(modal instanceof HTMLElement)) {
      return { clicked: false, reason: "modal-missing", visibleButtons: [] };
    }

    const isControlButton = (text, ariaLabel) => {
      const combined = `${text} ${ariaLabel}`.trim();
      return (
        combined.startsWith("返回上一步") ||
        combined.startsWith("收起选择窗") ||
        combined.startsWith("展开选择窗") ||
        combined.startsWith("重置")
      );
    };

    const buttons = Array.from(modal.querySelectorAll("button"))
      .map((button) => ({
        button,
        visible: isVisible(button),
        text: normalize(button.innerText || button.textContent || ""),
        ariaLabel: normalize(button.getAttribute("aria-label") || ""),
        disabled:
          button.hasAttribute("disabled") ||
          button.getAttribute("aria-disabled") === "true",
        control: isControlButton(
          normalize(button.innerText || button.textContent || ""),
          normalize(button.getAttribute("aria-label") || ""),
        ),
      }))
      .filter((button) => button.text || button.ariaLabel);

    const target = buttons.find(
      (button) =>
        button.visible &&
        !button.disabled &&
        !button.control &&
        labels.some((label) => button.text.includes(label) || button.ariaLabel.includes(label)),
    ) || buttons.find(
      (button) =>
        button.visible &&
        !button.disabled &&
        !button.control &&
        labels.some((label) => button.text.includes(label) || button.ariaLabel.includes(label)),
    ) || buttons.find(
      (button) =>
        !button.disabled &&
        !button.control &&
        labels.some((label) => button.text.includes(label) || button.ariaLabel.includes(label)),
    );
    if (!target) {
      return {
        clicked: false,
        reason: "button-missing",
        visibleButtons: buttons.map(({ text, ariaLabel, disabled, visible }) => ({
          text,
          ariaLabel,
          disabled,
          visible,
        })),
      };
    }

    target.button.scrollIntoView({ block: "center", inline: "nearest" });
    target.button.click();
    return {
      clicked: true,
      text: target.text,
      ariaLabel: target.ariaLabel,
    };
  }, labels);

  if (result.clicked) return result;

  throw new Error(
    `Could not find a visible composer-question button for labels: ${labels.join(" / ")}\n${JSON.stringify(
      result.visibleButtons ?? [],
      null,
      2,
    )}`,
  );
}

async function submitVisibleComposerQuestionChildInput(page, optionLabels, value, confirmLabels = ["确认"]) {
  await clickVisibleComposerQuestionButton(page, optionLabels);
  const modal = page.locator('[data-composer-choice-modal="true"]').filter({ has: page.locator("input") }).last();
  const input = modal.locator('input:not([type="file"])').last();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill(String(value));
  await clickVisibleComposerQuestionButton(page, confirmLabels);
}

function getFirstActionableComposerButtonLabel(question) {
  return (
    question?.visibleButtons?.find((label) => {
      const normalized = String(label || "").trim();
      return (
        normalized &&
        !normalized.startsWith("返回上一步") &&
        !normalized.startsWith("收起选择窗") &&
        !normalized.startsWith("展开选择窗") &&
        !normalized.startsWith("重置")
      );
    }) ?? null
  );
}

function buildComposerQuestionRepeatSignature(question) {
  const answerKey = trimString(question?.answerKey || question?.questionId || question?.text || "unknown-question");
  const visibleButtons = Array.isArray(question?.visibleButtons)
    ? question.visibleButtons.map((label) => trimString(label)).filter(Boolean)
    : [];
  return `${answerKey}::${visibleButtons.join("|")}`;
}

async function assertNoVisibleButtonLabels(page, labels, message) {
  const visibleButtons = await listVisibleButtons(page);
  const hasUnexpectedButton = visibleButtons.some((button) =>
    labels.some((label) => button.text.includes(label) || button.ariaLabel.includes(label)));
  assert.equal(hasUnexpectedButton, false, message);
}

async function sendFreeformText(page, text) {
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  await textarea.fill(text);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  const sendButtonHandle = await sendButton.elementHandle();
  assert.ok(sendButtonHandle, "send button should resolve to a concrete visible element");
  await page.waitForFunction(
    (button) => button instanceof HTMLButtonElement && !button.disabled,
    sendButtonHandle,
    { timeout: 30000 },
  );
  await sendButton.click();
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 10000 });
}

async function sendFreeformTextReliable(page, text) {
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  await textarea.click();
  await textarea.press("Control+A").catch(() => {});
  await textarea.press("Backspace").catch(() => {});
  await textarea.type(text, { delay: 18 });
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  const sendButtonHandle = await sendButton.elementHandle();
  assert.ok(sendButtonHandle, "send button should resolve to a concrete visible element");
  await page.waitForFunction(
    (button) => button instanceof HTMLButtonElement && !button.disabled,
    sendButtonHandle,
    { timeout: 30000 },
  );
  await sendButton.click();
  await page.getByText(text).first().waitFor({ state: "visible", timeout: 10000 });
}

async function submitComposerTextWithoutEcho(page, text) {
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  await textarea.click();
  await textarea.press("Control+A").catch(() => {});
  await textarea.press("Backspace").catch(() => {});
  await textarea.fill(text);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  const sendButtonHandle = await sendButton.elementHandle();
  assert.ok(sendButtonHandle, "send button should resolve to a concrete visible element");
  await page.waitForFunction(
    (button) => button instanceof HTMLButtonElement && !button.disabled,
    sendButtonHandle,
    { timeout: 30000 },
  );
  await sendButton.click();
}

async function attachFilesWithChooser(page, filePaths) {
  const tryAttachButton = async () => {
    const attachButton = page.getByRole("button", { name: /上传文件|已附加 \d+ 个文件/ }).first();
    await attachButton.waitFor({ state: "visible", timeout: 10000 });
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15000 }),
      attachButton.click(),
    ]);
    return chooser;
  };

  try {
    const chooser = await tryAttachButton();
    await chooser.setFiles(filePaths);
    return;
  } catch (primaryError) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15000 }),
        page.evaluate(() => {
          const input = document.querySelector('input[type="file"]');
          if (!(input instanceof HTMLInputElement)) {
            throw new Error("file-input-missing");
          }
          input.click();
        }),
      ]);
      await chooser.setFiles(filePaths);
      return;
    } catch (fallbackError) {
      const debugState = await page.evaluate(() => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };
        return {
          visibleButtons: Array.from(document.querySelectorAll("button"))
            .filter((button) => isVisible(button))
            .map((button) => ({
              text: normalize(button.innerText || button.textContent || ""),
              ariaLabel: normalize(button.getAttribute("aria-label") || ""),
              disabled: button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true",
            })),
          fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((input) => ({
            disabled: input.disabled,
            visible: isVisible(input),
            multiple: input.multiple,
            accept: input.accept || "",
          })),
        };
      });
      throw new Error(
        `File chooser did not open.\nprimary=${String(primaryError?.message || primaryError)}\nfallback=${String(
          fallbackError?.message || fallbackError,
        )}\nstate=${JSON.stringify(debugState, null, 2)}`,
      );
    }
  }
}

async function captureLatestAssistantStreamSamples(page, {
  previousAssistantCount,
  previousAssistantRowId = null,
  timeoutMs = 120000,
  sampleIntervalMs = 16,
  settleSamples = 5,
} = {}) {
  return page.evaluate(
    async ({ previousAssistantCount, previousAssistantRowId, timeoutMs, sampleIntervalMs, settleSamples }) => {
      const startedAt = performance.now();
      const samples = [];
      let started = false;
      let stableSamples = 0;
      let lastSignature = "";

      const readSample = () => {
        const rows = Array.from(document.querySelectorAll('[data-home-agent-message-role="assistant"]'));
        const lastRow = rows[rows.length - 1] ?? null;
        const lastRowId = lastRow?.getAttribute("data-home-agent-message-row") || null;
        const body =
          lastRow?.querySelector('[data-home-agent-assistant-body="true"]') ??
          lastRow?.querySelector('[data-home-agent-assistant-body]') ??
          null;
        const bodyText = (body?.textContent || "").replace(/\s+/g, " ").trim();
        const streamLabel = (lastRow?.querySelector('[data-testid="agent-streaming-label"]')?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const container = document.querySelector(".app-main-container");
        const scrollTop = container instanceof HTMLElement ? container.scrollTop : 0;
        const clientHeight = container instanceof HTMLElement ? container.clientHeight : 0;
        const scrollHeight = container instanceof HTMLElement ? container.scrollHeight : 0;
        const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
        return {
          assistantCount: rows.length,
          hasNewAssistant: rows.length > previousAssistantCount,
          hasNewAssistantRow: Boolean(lastRowId && lastRowId !== previousAssistantRowId),
          lastRowId,
          length: bodyText.length,
          streaming: Boolean(streamLabel),
          scrollTop,
          maxScrollTop,
          bottomGap: Math.max(0, maxScrollTop - scrollTop),
          atMs: Math.round(performance.now() - startedAt),
        };
      };

      while (performance.now() - startedAt < timeoutMs) {
        const sample = readSample();
        if ((sample.hasNewAssistant || sample.hasNewAssistantRow) && (sample.streaming || sample.length > 0)) {
          started = true;
        }
        if (started) {
          samples.push(sample);
          const signature = `${sample.length}:${sample.streaming ? "streaming" : "idle"}`;
          stableSamples =
            !sample.streaming && sample.length > 0 && signature === lastSignature
              ? stableSamples + 1
              : 0;
          lastSignature = signature;
          if (!sample.streaming && sample.length > 0 && stableSamples >= settleSamples) {
            break;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, sampleIntervalMs));
      }

      return samples;
    },
    { previousAssistantCount, previousAssistantRowId, timeoutMs, sampleIntervalMs, settleSamples },
  );
}

function summarizeAssistantStreamSamples(samples) {
  const streamingSamples = samples.filter((sample) => sample.streaming);
  const progressionSamples = streamingSamples.length ? streamingSamples : samples;
  const positiveLengths = progressionSamples
    .map((sample) => sample.length)
    .filter((value) => Number.isFinite(value) && value > 0);
  const uniquePositiveLengths = [...new Set(positiveLengths)];
  let positiveStepCount = 0;
  let maxLengthJump = 0;
  let previousLength = positiveLengths[0] ?? 0;

  for (const length of positiveLengths.slice(1)) {
    const delta = length - previousLength;
    if (delta > 0) {
      positiveStepCount += 1;
      maxLengthJump = Math.max(maxLengthJump, delta);
    }
    previousLength = length;
  }

  const maxBottomGap = progressionSamples.reduce(
    (maxGap, sample) => Math.max(maxGap, Number(sample.bottomGap) || 0),
    0,
  );
  const lastSample = samples[samples.length - 1] ?? null;

  return {
    sampleCount: samples.length,
    streamingSampleCount: streamingSamples.length,
    uniquePositiveLengthCount: uniquePositiveLengths.length,
    positiveStepCount,
    maxLengthJump,
    maxBottomGap,
    finalLength: lastSample?.length ?? 0,
    finalBottomGap: lastSample?.bottomGap ?? 0,
  };
}

async function launchHomeShortcut(page, title) {
  await resetAndSeed(page, {});
  const shortcut = page.getByRole("button", { name: new RegExp(title) }).last();
  await shortcut.waitFor({ state: "visible", timeout: 10000 });
  await shortcut.click();
}

async function openHistoryProject(page, title) {
  await page.getByText("对话历史").first().waitFor({ state: "visible", timeout: 10000 });
  const button = page.getByRole("button", { name: new RegExp(title) }).first();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await button.click();
}

async function openHistoryProjectMenu(page, projectId) {
  const entry = page.locator(`[data-sidebar-history-id="${projectId}"]`).first();
  await entry.waitFor({ state: "visible", timeout: 10000 });
  await entry.scrollIntoViewIfNeeded().catch(() => {});
  await entry.hover().catch(() => {});

  const buttons = entry.locator("button");
  const buttonCount = await buttons.count();
  assert.ok(buttonCount >= 2, `history project ${projectId} should expose a menu button`);

  await buttons.nth(buttonCount - 1).click({ force: true });
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 10000 });
}

async function duplicateHistoryProjectFromMenu(page, projectId, expectedTitle, options = {}) {
  const {
    expectedDramaCountDelta = 1,
    expectedSessionCountDelta = 1,
  } = options;
  const beforeDramaProjects = await readStoredDramaProjects(page);
  const beforeProjectSessions = await readStoredProjectSessions(page);
  const beforeProjectIds = new Set(beforeDramaProjects.map((project) => project?.id).filter(Boolean));
  const beforeSessionIds = new Set(Object.keys(beforeProjectSessions ?? {}));
  const beforeSessionCount = Object.keys(beforeProjectSessions ?? {}).length;
  const expectedDramaCount = Math.max(beforeDramaProjects.length + expectedDramaCountDelta, 0);
  const expectedSessionCount = Math.max(beforeSessionCount + expectedSessionCountDelta, 0);

  await openHistoryProjectMenu(page, projectId);
  await page.getByRole("menuitem", { name: /复制对话|复制/ }).first().click({ force: true });
  await page.getByRole("menu").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

  try {
    await page.waitForFunction(
      ([dramaProjectsKey, sessionKey, title, expectedDramaCountValue, expectedSessionCountValue]) => {
        const parse = (value, fallback) => {
          try {
            return value ? JSON.parse(value) : fallback;
          } catch {
            return fallback;
          }
        };
        const dramaProjects = parse(window.localStorage.getItem(dramaProjectsKey), []);
        const projectSessions = parse(window.localStorage.getItem(sessionKey), {});
        if (!Array.isArray(dramaProjects)) return false;
        const visibleEntries = Array.from(document.querySelectorAll("[data-sidebar-history-id]")).map((element) =>
          (element.textContent || "").replace(/\s+/g, " ").trim(),
        );
        return (
          dramaProjects.length === expectedDramaCountValue &&
          Object.keys(projectSessions ?? {}).length === expectedSessionCountValue &&
          visibleEntries.some((text) => text.includes(title))
        );
      },
      [DRAMA_PROJECTS_KEY, STUDIO_PROJECT_SESSIONS_KEY, expectedTitle, expectedDramaCount, expectedSessionCount],
      { timeout: 15000 },
    );
  } catch (error) {
    const debugState = await page.evaluate(([dramaProjectsKey, sessionKey, title]) => {
      const parse = (value, fallback) => {
        try {
          return value ? JSON.parse(value) : fallback;
        } catch {
          return fallback;
        }
      };
      const dramaProjects = parse(window.localStorage.getItem(dramaProjectsKey), []);
      const projectSessions = parse(window.localStorage.getItem(sessionKey), {});
      const visibleEntries = Array.from(document.querySelectorAll("[data-sidebar-history-id]")).map((element) => ({
        projectId: element.getAttribute("data-sidebar-history-id") || "",
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
      }));
      return {
        expectedTitle: title,
        dramaProjectIds: Array.isArray(dramaProjects)
          ? dramaProjects.map((project) => ({ id: project?.id || "", title: project?.dramaTitle || "" }))
          : [],
        projectSessionIds: Object.keys(projectSessions ?? {}),
        projectSessionSnapshots: Object.fromEntries(
          Object.entries(projectSessions ?? {}).map(([id, session]) => [
            id,
            {
              projectId: session?.projectId ?? null,
              snapshotProjectId: session?.currentProjectSnapshot?.projectId ?? null,
              snapshotProjectKind: session?.currentProjectSnapshot?.projectKind ?? null,
              snapshotTitle: session?.currentProjectSnapshot?.title ?? null,
              snapshotSourceProjectId: session?.currentProjectSnapshot?.sourceProjectId ?? null,
            },
          ]),
        ),
        visibleEntries,
      };
    }, [DRAMA_PROJECTS_KEY, STUDIO_PROJECT_SESSIONS_KEY, expectedTitle]);
    throw new Error(
      [
        `duplicating ${projectId} did not reach the expected persisted drama+session state for ${expectedTitle}`,
        JSON.stringify(debugState, null, 2),
        error instanceof Error ? error.message : String(error),
      ].join("\n\n"),
    );
  }

  const afterDramaProjects = await readStoredDramaProjects(page);
  const duplicatedDramaProject =
    afterDramaProjects.find(
      (project) => project?.dramaTitle === expectedTitle && !beforeProjectIds.has(project?.id),
    ) ?? null;
  const afterProjectSessions = await readStoredProjectSessions(page);
  const duplicatedSessionEntry =
    Object.entries(afterProjectSessions ?? {}).find(
      ([id, session]) =>
        !beforeSessionIds.has(id) &&
        session?.currentProjectSnapshot?.title === expectedTitle,
    ) ?? null;
  const duplicatedProjectId =
    duplicatedDramaProject?.id ??
    duplicatedSessionEntry?.[0] ??
    null;
  const duplicatedTitle =
    duplicatedDramaProject?.dramaTitle ??
    duplicatedSessionEntry?.[1]?.currentProjectSnapshot?.title ??
    null;

  assert.ok(duplicatedProjectId, `duplicating ${projectId} should create a new project titled ${expectedTitle}`);
  await page.waitForFunction(
    (expectedProjectId) =>
      Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .includes(expectedProjectId),
    duplicatedProjectId,
    { timeout: 15000 },
  );
  return {
    projectId: duplicatedProjectId,
    title: duplicatedTitle,
    dramaProjectCount: afterDramaProjects.length,
    projectSessionCount: Object.keys(afterProjectSessions ?? {}).length,
    sessionOnly: !duplicatedDramaProject,
  };
}

async function deleteHistoryProjectFromMenu(page, projectId, options = {}) {
  const {
    expectedDramaCountDelta = -1,
    expectedSessionCountDelta = -1,
  } = options;
  const beforeDramaProjects = await readStoredDramaProjects(page);
  const beforeProjectSessions = await readStoredProjectSessions(page);
  const expectedDramaCount = Math.max(beforeDramaProjects.length + expectedDramaCountDelta, 0);
  const expectedSessionCount = Math.max(Object.keys(beforeProjectSessions ?? {}).length + expectedSessionCountDelta, 0);

  await openHistoryProjectMenu(page, projectId);
  await page.getByRole("menuitem", { name: /删除/ }).first().click({ force: true });
  await clickVisibleButtonByLabels(page, ["确认删除"]);
  await page.getByRole("menu").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

  await page.waitForFunction(
    ([dramaProjectsKey, projectSessionsKey, studioSessionKey, deletedProjectId, expectedDramaTotal, expectedSessionTotal]) => {
      const parse = (value, fallback) => {
        try {
          return value ? JSON.parse(value) : fallback;
        } catch {
          return fallback;
        }
      };

      const dramaProjects = parse(window.localStorage.getItem(dramaProjectsKey), []);
      const projectSessions = parse(window.localStorage.getItem(projectSessionsKey), {});
      const studioSession = parse(window.localStorage.getItem(studioSessionKey), null);
      if (!Array.isArray(dramaProjects)) return false;

      const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .filter((element) => {
          if (!(element instanceof HTMLElement)) return false;
          const list = element.closest("[data-sidebar-history-list='true']");
          if (!(list instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const listStyle = window.getComputedStyle(list);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (listStyle.display === "none" || listStyle.visibility === "hidden") return false;
          const rect = element.getBoundingClientRect();
          const listRect = list.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && listRect.width > 0 && listRect.height > 0;
        })
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .filter(Boolean);
      const storedProjectIds = dramaProjects.map((project) => project?.id || "").filter(Boolean);
      const sessionIds = Object.keys(projectSessions ?? {});

      return (
        dramaProjects.length === expectedDramaTotal &&
        sessionIds.length === expectedSessionTotal &&
        !storedProjectIds.includes(deletedProjectId) &&
        !sessionIds.includes(deletedProjectId) &&
        !visibleIds.includes(deletedProjectId) &&
        studioSession?.projectId !== deletedProjectId &&
        studioSession?.currentProjectSnapshot?.projectId !== deletedProjectId
      );
    },
    [DRAMA_PROJECTS_KEY, STUDIO_PROJECT_SESSIONS_KEY, STUDIO_SESSION_KEY, projectId, expectedDramaCount, expectedSessionCount],
    { timeout: 15000 },
  );

  const afterDramaProjects = await readStoredDramaProjects(page);
  const afterProjectSessions = await readStoredProjectSessions(page);
  const afterStudioSession = await readStoredStudioSession(page);
  const afterHistoryEntries = await listVisibleHistoryEntries(page);

  assert.equal(
    afterDramaProjects.some((project) => project?.id === projectId),
    false,
    `deleting ${projectId} should remove it from stored drama projects`,
  );
  assert.equal(
    Boolean(afterProjectSessions?.[projectId]),
    false,
    `deleting ${projectId} should remove its project-scoped session`,
  );
  assert.equal(
    afterHistoryEntries.some((entry) => entry.projectId === projectId),
    false,
    `deleting ${projectId} should remove its visible history card`,
  );
  assert.notEqual(
    afterStudioSession?.projectId,
    projectId,
    `deleting ${projectId} should move the active studio session away from the deleted project id`,
  );
  assert.notEqual(
    afterStudioSession?.currentProjectSnapshot?.projectId,
    projectId,
    `deleting ${projectId} should not leave the deleted project snapshot mounted as active`,
  );

  return {
    deletedProjectId: projectId,
    remainingDramaProjectCount: afterDramaProjects.length,
    remainingProjectSessionCount: Object.keys(afterProjectSessions ?? {}).length,
    activeProjectId: afterStudioSession?.projectId ?? null,
    activeSnapshotProjectId: afterStudioSession?.currentProjectSnapshot?.projectId ?? null,
  };
}

async function runSavedHistoryScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      "drama-project-1": createSession(),
    },
  });

  await openHistoryProject(page, "契约婚姻反转录");
  await page.getByText("继续选择题材").first().waitFor({ state: "visible", timeout: 10000 });
  const restoredDraft = await page.locator("textarea").last().inputValue();
  assert.equal(restoredDraft, "补充反派动机", "恢复历史剧本项目时应还原草稿输入");
  assert.equal(new URL(page.url()).pathname, "/", "恢复历史剧本项目时不应切换路由");

  return { restoredDraft };
}

async function runAnalysisRecoveryScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject("drama-project-2")],
  }, {
    includeSharedJsonSeed: false,
    includeSharedRawSeed: false,
  });

  await openHistoryProject(page, "契约婚姻反转录");
  const recoverySignal = await Promise.any([
    page.getByText(/我已对照当前项目(?:产物|状态)做了恢复分析/).first().waitFor({ state: "visible", timeout: 10000 }).then(() => "summary"),
    page.locator('[data-composer-question-answer-key="script-creative-plan"]').first().waitFor({ state: "visible", timeout: 10000 }).then(() => "script-creative-plan"),
  ]).catch(() => null);
  const visibleQuestion = recoverySignal ? null : await readVisibleComposerQuestion(page);
  const visibleButtons = recoverySignal ? [] : await listVisibleButtons(page);
  assert.ok(
    recoverySignal,
    `opening a project without a saved session should either surface the recovery summary or the standard script-creative-plan workflow panel; visibleQuestion=${JSON.stringify(visibleQuestion)}, visibleButtons=${JSON.stringify(visibleButtons.slice(0, 20))}`,
  );
  await page.getByText(/契约婚姻反转录/).first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(new URL(page.url()).pathname, "/", "无保存会话时应以首页摘要恢复而不是切页");

  return { recoverySignal };
}

async function runVideoHistoryScenario(page) {
  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoProject()],
  });

  await openHistoryProject(page, "夜雨追击预告片");
  await page.getByText(/进入预览与导出阶段/).first().waitFor({ state: "visible", timeout: 10000 });
  const continuationOptions = [
    page.getByRole("button", { name: /继续补生成剩余镜头/ }).first(),
    page.getByRole("button", { name: /指定镜头继续出片/ }).first(),
    page.getByRole("button", { name: /切回《分镜图》/ }).first(),
    page.getByRole("button", { name: /切回《视频生成》/ }).first(),
    page.getByRole("button", { name: /切回《角色和场景》/ }).first(),
  ];
  const optionVisible = await Promise.any(
    continuationOptions.map((locator) =>
      locator.waitFor({ state: "visible", timeout: 10000 }).then(() => true),
    ),
  ).catch(() => false);
  assert.equal(typeof optionVisible, "boolean");
  assert.equal(new URL(page.url()).pathname, "/", "恢复历史视频项目时不应切换路由");

  return { previewExportPanelVisible: true };
}

async function runRefreshPersistenceScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_SESSION_KEY]: createSession(),
  });

  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });
  const beforeReloadDraft = await page.locator("textarea").last().inputValue();
  assert.equal(beforeReloadDraft, "补充反派动机", "首页启动时应先恢复当前会话草稿");
  await page.getByText("继续选择题材").first().waitFor({ state: "visible", timeout: 10000 });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("继续选择题材").first().waitFor({ state: "visible", timeout: 10000 });
  const afterReloadDraft = await page.locator("textarea").last().inputValue();
  assert.equal(afterReloadDraft, "补充反派动机", "刷新后应保留首页当前会话草稿");
  assert.equal(new URL(page.url()).pathname, "/", "刷新恢复后仍应停留在首页");

  await page.getByRole("button", { name: "打开或关闭设置" }).first().click();
  await page.getByText("API 设置").first().waitFor({ state: "visible", timeout: 10000 });
  const afterSettingsDraft = await page.locator("textarea").last().inputValue();
  assert.equal(afterSettingsDraft, "补充反派动机", "打开设置后不应破坏当前首页会话草稿");

  return {
    beforeReloadDraft,
    afterReloadDraft,
    afterSettingsDraft,
  };
}

async function runLongConversationCompactionScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_SESSION_KEY]: createLongSession(),
  });

  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(
    ([sessionKey]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return (
          typeof parsed?.compactedMessageCount === "number" &&
          parsed.compactedMessageCount > 0 &&
          typeof parsed?.recentMessageSummary === "string" &&
          parsed.recentMessageSummary.trim().length > 0
        );
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY],
    { timeout: 30000 },
  );
  assert.equal(new URL(page.url()).pathname, "/", "长对话压缩后仍应停留在首页");

  const compactionState = await page.evaluate(([sessionKey]) => {
    const raw = window.localStorage.getItem(sessionKey);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return {
        compactedMessageCount: parsed?.compactedMessageCount ?? null,
        recentMessageSummary: parsed?.recentMessageSummary ?? "",
      };
    } catch {
      return null;
    }
  }, [STUDIO_SESSION_KEY]);

  return compactionState;
}

async function runSidebarCollapseScenario(page) {
  await resetAndSeed(page, {});
  const sidebar = page.locator("aside .fixed.inset-y-0.left-0").first();
  const collapseButton = page.getByRole("button", { name: "收起侧栏" });
  await collapseButton.waitFor({ state: "visible", timeout: 10000 });

  const before = await sidebar.boundingBox();
  await collapseButton.click();
  await page.getByRole("button", { name: "展开侧栏" }).waitFor({ state: "visible", timeout: 5000 });
  if (before?.width) {
    await page.waitForFunction(
      (previousWidth) => {
        const sidebarElement = document.querySelector("aside .fixed.inset-y-0.left-0");
        if (!(sidebarElement instanceof HTMLElement)) return false;
        return sidebarElement.getBoundingClientRect().width < previousWidth;
      },
      before.width,
      { timeout: 5_000 },
    );
  }
  const after = await sidebar.boundingBox();

  assert.ok(before?.width && after?.width && after.width < before.width, "侧栏收起后宽度应变小");

  return {
    beforeWidth: before?.width ?? null,
    afterWidth: after?.width ?? null,
  };
}

async function runCustomInputQuestionScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_SESSION_KEY]: createSession(),
  });

  const questionTitle = page.getByText("继续选择题材").first();
  await questionTitle.waitFor({ state: "visible", timeout: 10000 });

  const input = page.locator("textarea").last();
  const customReply = "我想先把反派动机写得更狠一点，再回到都市情感主线";
  await input.fill(customReply);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await sendButton.click();

  await page.getByText(customReply).first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(new URL(page.url()).pathname, "/", "弹窗自定义输入后仍应停留在首页工作流");

  const visibleQuestionCount = await page.getByText("继续选择题材").count();
  assert.equal(visibleQuestionCount > 0, true, "自定义输入后不应跳出当前工作流上下文");

  const randomUnexpectedActionVisible = await page.getByText("上传剧本文档").count();
  assert.equal(randomUnexpectedActionVisible, 0, "脚本工作流中不应突然出现视频入口选项");

  return {
    customReply,
    visibleQuestionCount,
    randomUnexpectedActionVisible,
  };
}

async function runOriginalShortcutScenario(page) {
  await launchHomeShortcut(page, "原创剧本");

  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);

  const offStepInput = "先别立项，直接帮我生成角色海报和视频。";
  await sendFreeformText(page, offStepInput);
  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);
  await assertNoVisibleButtonLabels(
    page,
    ["上传剧本文档", "完成剧本拆解", "图生视频", "文生视频"],
    "原创剧本首步被自由输入打断后，不应跳出视频或拆解类后续选项",
  );

  await clickVisibleButtonByLabels(page, ["选题创作"]);
  await waitForVisibleButtonLabels(page, ["国内（中文）"], 15000);

  await launchHomeShortcut(page, "原创剧本");
  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);
  await clickVisibleButtonByLabels(page, ["创意创作"]);
  await waitForVisibleButtonLabels(page, ["国内（中文）"], 15000);

  return {
    offStepInput,
    topicPathAnswer: "topic",
    creativePathAnswer: "creative",
  };
}

async function runManualToFullAutoIsolationScenario(page) {
  const projectId = "manual-switch-project-1";
  const manualSeedText = "manual seed history should disappear after switching to full-auto";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createAutomationSwitchDramaProject(projectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [projectId]: createAutomationSwitchSession(projectId),
    },
  });

  await openHistoryProject(page, "Manual Switch Project");
  await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });

  await page.getByRole("button", { name: "打开或关闭设置" }).first().click();
  await page.getByText("首页 Agent 模式").first().waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "全自动模式" }).first().click();

  await page.waitForFunction(
    () => Boolean(document.querySelector("[data-automation-mode='full-auto']")),
    undefined,
    { timeout: 10000 },
  );

  await page.getByRole("button", { name: "打开或关闭设置" }).first().click();
  await page.getByRole("button", { name: /原创剧本/ }).last().waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: /原创剧本/ }).last().click();

  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);

  const lingeringManualMessageCount = await page.getByText(manualSeedText).count();
  assert.equal(
    lingeringManualMessageCount,
    0,
    "切换到全自动后启动原创剧本时，不应继续带出普通模式会话里的旧消息历史",
  );

  const lingeringManualCardCount = await page.getByRole("button", { name: /Manual Switch Project/ }).count();
  assert.equal(
    lingeringManualCardCount,
    0,
    "切换到全自动后，普通模式会话卡不应继续显示在当前全自动历史列表里",
  );

  await page.waitForFunction(
    ([sessionKey]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        return Boolean(JSON.parse(raw));
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY],
    { timeout: 5000 },
  );

  const storedSession = await readStoredStudioSession(page);
  assert.equal(
    storedSession?.automationMode,
    "full-auto",
    "切换到全自动后，当前首页会话应写成 full-auto 模式",
  );
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId ?? null,
    null,
    "刚启动全自动原创剧本时，不应继续挂着旧的普通模式项目快照",
  );
  assert.equal(
    Array.isArray(storedSession?.messages)
      ? storedSession.messages.some((message) => String(message?.content || "").includes(manualSeedText))
      : false,
    false,
    "当前首页会话缓存里不应再残留旧的普通模式历史消息",
  );

  return {
    projectId,
    lingeringManualMessageCount,
    lingeringManualCardCount,
    storedAutomationMode: storedSession?.automationMode ?? null,
    storedProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
    storedMessageCount: Array.isArray(storedSession?.messages) ? storedSession.messages.length : 0,
  };
}

async function runRepeatedModeSwitchIsolationScenario(page) {
  const manualProjectId = "manual-switch-project-1";
  const fullAutoProjectId = "full-auto-switch-project-1";
  const manualTitle = "Manual Switch Project";
  const fullAutoTitle = "Full Auto Switch Project";
  const manualSeedText = "manual seed history should disappear after switching to full-auto";
  const fullAutoSeedText = "full auto seed history should stay isolated from manual mode";
  const cycles = 3;
  const cycleMetrics = [];

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [
      createAutomationSwitchDramaProject(manualProjectId),
      createFullAutoSwitchDramaProject(fullAutoProjectId),
    ],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [manualProjectId]: createAutomationSwitchSession(manualProjectId),
      [fullAutoProjectId]: createFullAutoSwitchSession(fullAutoProjectId),
    },
    [STUDIO_SESSION_KEY]: createAutomationSwitchSession(manualProjectId),
  });

  await openHistoryProject(page, manualTitle);
  await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });

  for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex += 1) {
    const toFullAutoStartedAt = Date.now();
    await switchAutomationMode(page, "full-auto");
    await page.getByText(fullAutoSeedText).first().waitFor({ state: "visible", timeout: 15000 });
    await openHistoryProject(page, fullAutoTitle);
    await page.getByText(fullAutoSeedText).first().waitFor({ state: "visible", timeout: 10000 });

    const fullAutoHistoryEntries = await listVisibleHistoryEntries(page);
    const fullAutoStudioSession = await readStoredStudioSession(page);
    const fullAutoSwitchDurationMs = Date.now() - toFullAutoStartedAt;

    assert.equal(
      await page.getByText(manualSeedText).count(),
      0,
      `cycle ${cycleIndex + 1}: manual message should not remain visible after switching to full-auto`,
    );
    assert.equal(
      fullAutoHistoryEntries.some((entry) => entry.projectId === manualProjectId),
      false,
      `cycle ${cycleIndex + 1}: manual card should not remain in the full-auto history list`,
    );
    assert.equal(
      fullAutoStudioSession?.automationMode,
      "full-auto",
      `cycle ${cycleIndex + 1}: active studio session should persist full-auto mode after switching`,
    );
    assert.equal(
      fullAutoStudioSession?.currentProjectSnapshot?.projectId,
      fullAutoProjectId,
      `cycle ${cycleIndex + 1}: active full-auto project should match the visible full-auto conversation`,
    );

    const toManualStartedAt = Date.now();
    await switchAutomationMode(page, "manual");
    try {
      await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      const debugState = await page.evaluate(
        ([sessionKey, projectSessionsKey, automationModeKey]) => {
          const safeParse = (value, fallback) => {
            try {
              return value ? JSON.parse(value) : fallback;
            } catch {
              return fallback;
            }
          };
          const session = safeParse(window.localStorage.getItem(sessionKey), null);
          const projectSessions = safeParse(window.localStorage.getItem(projectSessionsKey), {});
          const visibleHistoryEntries = Array.from(document.querySelectorAll("[data-sidebar-history-id]")).map((element) => ({
            projectId: element.getAttribute("data-sidebar-history-id") || "",
            text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          }));
          return {
            automationModeKey: window.localStorage.getItem(automationModeKey),
            session,
            projectSessionIds: Object.keys(projectSessions || {}),
            visibleHistoryEntries,
            bodyText: (document.body.innerText || "").slice(0, 2400),
          };
        },
        [STUDIO_SESSION_KEY, STUDIO_PROJECT_SESSIONS_KEY, "storyforge-home-agent-automation-mode-v1"],
      );
      throw new Error(
        [
          String(error?.stack || error),
          "",
          JSON.stringify(debugState, null, 2),
        ].join("\n"),
      );
    }
    await openHistoryProject(page, manualTitle);
    await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });

    const manualHistoryEntries = await listVisibleHistoryEntries(page);
    const manualStudioSession = await readStoredStudioSession(page);
    const manualSwitchDurationMs = Date.now() - toManualStartedAt;

    assert.equal(
      await page.getByText(fullAutoSeedText).count(),
      0,
      `cycle ${cycleIndex + 1}: full-auto message should not remain visible after switching back to manual`,
    );
    assert.equal(
      manualHistoryEntries.some((entry) => entry.projectId === fullAutoProjectId),
      false,
      `cycle ${cycleIndex + 1}: full-auto card should not remain in the manual history list`,
    );
    assert.equal(
      manualStudioSession?.automationMode,
      "manual",
      `cycle ${cycleIndex + 1}: active studio session should persist manual mode after switching back`,
    );
    assert.equal(
      manualStudioSession?.currentProjectSnapshot?.projectId,
      manualProjectId,
      `cycle ${cycleIndex + 1}: active manual project should match the visible manual conversation`,
    );

    cycleMetrics.push({
      cycle: cycleIndex + 1,
      fullAutoSwitchDurationMs,
      manualSwitchDurationMs,
      fullAutoHistoryCount: fullAutoHistoryEntries.length,
      manualHistoryCount: manualHistoryEntries.length,
    });
  }

  const maxFullAutoSwitchDurationMs = Math.max(...cycleMetrics.map((metric) => metric.fullAutoSwitchDurationMs));
  const maxManualSwitchDurationMs = Math.max(...cycleMetrics.map((metric) => metric.manualSwitchDurationMs));
  assert.ok(
    maxFullAutoSwitchDurationMs < 15000,
    `repeated full-auto switching should stay responsive, worst case took ${maxFullAutoSwitchDurationMs}ms`,
  );
  assert.ok(
    maxManualSwitchDurationMs < 15000,
    `repeated manual switching should stay responsive, worst case took ${maxManualSwitchDurationMs}ms`,
  );

  return {
    cycles,
    maxFullAutoSwitchDurationMs,
    maxManualSwitchDurationMs,
    cycleMetrics,
  };
}

async function runRepeatedFullAutoKickoffBounceScenario(page) {
  const projectId = "manual-switch-project-1";
  const manualTitle = "Manual Switch Project";
  const manualSeedText = "manual seed history should disappear after switching to full-auto";
  const cycles = 3;
  const cycleMetrics = [];

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createAutomationSwitchDramaProject(projectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [projectId]: createAutomationSwitchSession(projectId),
    },
    [STUDIO_SESSION_KEY]: createAutomationSwitchSession(projectId),
  });

  await openHistoryProject(page, manualTitle);
  await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });

  for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex += 1) {
    const toFullAutoStartedAt = Date.now();
    await switchAutomationMode(page, "full-auto");
    await page.getByRole("button", { name: /原创剧本/ }).last().waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: /原创剧本/ }).last().click();
    await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);
    await page.waitForFunction(
      ([sessionKey]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          return (
            session?.automationMode === "full-auto" &&
            !session?.currentProjectSnapshot?.projectId &&
            Array.isArray(session?.messages) &&
            session.messages.length >= 2
          );
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY],
      { timeout: 10000 },
    );

    const fullAutoStudioSession = await readStoredStudioSession(page);
    const fullAutoSwitchDurationMs = Date.now() - toFullAutoStartedAt;

    assert.equal(
      await page.getByText(manualSeedText).count(),
      0,
      `cycle ${cycleIndex + 1}: manual message should not remain visible after launching full-auto`,
    );
    assert.equal(
      await page.getByRole("button", { name: /Manual Switch Project/ }).count(),
      0,
      `cycle ${cycleIndex + 1}: manual card should stay hidden while full-auto mode is active`,
    );
    assert.equal(
      fullAutoStudioSession?.automationMode,
      "full-auto",
      `cycle ${cycleIndex + 1}: kickoff session should persist full-auto mode`,
    );
    assert.equal(
      fullAutoStudioSession?.currentProjectSnapshot?.projectId ?? null,
      null,
      `cycle ${cycleIndex + 1}: kickoff session should not keep the previous manual project snapshot`,
    );

    const toManualStartedAt = Date.now();
    await switchAutomationMode(page, "manual");
    try {
      await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      const debugState = await page.evaluate(
        ([sessionKey, projectSessionsKey, automationModeKey]) => {
          const safeParse = (value, fallback) => {
            try {
              return value ? JSON.parse(value) : fallback;
            } catch {
              return fallback;
            }
          };
          const session = safeParse(window.localStorage.getItem(sessionKey), null);
          const projectSessions = safeParse(window.localStorage.getItem(projectSessionsKey), {});
          const visibleHistoryEntries = Array.from(document.querySelectorAll("[data-sidebar-history-id]")).map((element) => ({
            projectId: element.getAttribute("data-sidebar-history-id") || "",
            text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          }));
          return {
            automationModeKey: window.localStorage.getItem(automationModeKey),
            session,
            projectSessionIds: Object.keys(projectSessions || {}),
            visibleHistoryEntries,
            bodyText: (document.body.innerText || "").slice(0, 2400),
          };
        },
        [STUDIO_SESSION_KEY, STUDIO_PROJECT_SESSIONS_KEY, "storyforge-home-agent-automation-mode-v1"],
      );
      throw new Error(
        [
          String(error?.stack || error),
          "",
          JSON.stringify(debugState, null, 2),
        ].join("\n"),
      );
    }
    await openHistoryProject(page, manualTitle);
    await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction(
      ([sessionKey, expectedProjectId]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          return (
            session?.automationMode === "manual" &&
            session?.currentProjectSnapshot?.projectId === expectedProjectId
          );
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, projectId],
      { timeout: 10000 },
    );

    const manualStudioSession = await readStoredStudioSession(page);
    const manualSwitchDurationMs = Date.now() - toManualStartedAt;

    assert.equal(
      await page.getByText("选题创作").count(),
      0,
      `cycle ${cycleIndex + 1}: full-auto kickoff options should not remain visible after switching back to manual`,
    );
    assert.equal(
      manualStudioSession?.automationMode,
      "manual",
      `cycle ${cycleIndex + 1}: switching back should restore manual session mode`,
    );
    assert.equal(
      manualStudioSession?.currentProjectSnapshot?.projectId,
      projectId,
      `cycle ${cycleIndex + 1}: switching back should restore the manual project snapshot`,
    );

    cycleMetrics.push({
      cycle: cycleIndex + 1,
      fullAutoSwitchDurationMs,
      manualSwitchDurationMs,
      fullAutoKickoffMessageCount: Array.isArray(fullAutoStudioSession?.messages)
        ? fullAutoStudioSession.messages.length
        : 0,
      manualMessageCount: Array.isArray(manualStudioSession?.messages)
        ? manualStudioSession.messages.length
        : 0,
    });
  }

  const maxFullAutoSwitchDurationMs = Math.max(...cycleMetrics.map((metric) => metric.fullAutoSwitchDurationMs));
  const maxManualSwitchDurationMs = Math.max(...cycleMetrics.map((metric) => metric.manualSwitchDurationMs));
  assert.ok(
    maxFullAutoSwitchDurationMs < 15000,
    `repeated full-auto kickoff switching should stay responsive, worst case took ${maxFullAutoSwitchDurationMs}ms`,
  );
  assert.ok(
    maxManualSwitchDurationMs < 15000,
    `repeated manual restoration switching should stay responsive, worst case took ${maxManualSwitchDurationMs}ms`,
  );

  return {
    cycles,
    maxFullAutoSwitchDurationMs,
    maxManualSwitchDurationMs,
    cycleMetrics,
  };
}

async function runAdaptationShortcutScenario(page) {
  await launchHomeShortcut(page, "参考改编");

  await waitForVisibleButtonLabels(page, ["上传参考文档", "直接开始对话"], 15000);

  const offStepInput = "先别问我改编方向，直接给我做角色设定。";
  await sendFreeformText(page, offStepInput);
  await waitForVisibleButtonLabels(page, ["上传参考文档", "直接开始对话"], 15000);
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "图生视频", "文生视频"],
    "参考改编入口被自由输入打断后，不应跳出后续视频阶段选项",
  );

  await clickVisibleButtonByLabels(page, ["上传参考文档"]);
  await page.getByText(/回形针按钮上传你的参考剧本文档|上传参考剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });

  await launchHomeShortcut(page, "参考改编");
  await waitForVisibleButtonLabels(page, ["上传参考文档", "直接开始对话"], 15000);
  await clickVisibleButtonByLabels(page, ["直接开始对话"]);
  await waitForVisibleButtonLabels(page, ["上传参考文档"], 15000);
  await assertNoVisibleButtonLabels(
    page,
    ["直接开始对话"],
    "参考改编进入直接对话后，应收敛到标准的下一步建议面板",
  );

  return {
    offStepInput,
    uploadPathVisible: true,
    directDialogFollowupVisible: true,
  };
}

async function runVideoShortcutScenario(page) {
  await launchHomeShortcut(page, "视频工作流");

  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);

  const offStepInput = "我还没准备剧本，直接先帮我出一版视频。";
  await sendFreeformText(page, offStepInput);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "图生视频", "文生视频", "提取角色与场景"],
    "视频工作流首步被自由输入打断后，不应提前出现拆解后或生成阶段选项",
  );

  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/回形针按钮上传你的剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });

  return {
    offStepInput,
    uploadPathVisible: true,
  };
}

async function runHomepageDirectConversationOriginalScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  const kickoffPrompt =
    "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。";
  await sendFreeformText(page, kickoffPrompt);

  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 120000);

  const offStepInput = "别继续问了，直接跳到角色设计和视频分镜。";
  await sendFreeformText(page, offStepInput);
  await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 30000);
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "主页直接对话进入原创立项后，不应被跳步输入带到后续阶段",
  );

  await clickVisibleButtonByLabels(page, ["创意创作"]);
  await waitForVisibleButtonLabels(page, ["国内（中文）"], 15000);

  return {
    kickoffPrompt,
    offStepInput,
    advancedTo: "目标市场",
  };
}

async function runHomepageDirectConversationOriginalStructuredScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  const kickoffPrompt =
    "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。";
  await sendFreeformText(page, kickoffPrompt);

  const kickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次想从哪种方式开始原创剧本？",
    buttonLabels: ["选题创作", "创意创作"],
    timeout: 120000,
  });
  assert.ok(
    kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
    "homepage direct original kickoff should open the standard composer modal",
  );

  const offStepInput = "别继续问了，直接跳到角色设计和视频分镜。";
  await sendFreeformText(page, offStepInput);
  const resumedKickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次想从哪种方式开始原创剧本？",
    buttonLabels: ["选题创作", "创意创作"],
    timeout: 30000,
  });
  assert.ok(
    resumedKickoffQuestion?.questionId || resumedKickoffQuestion?.answerKey,
    "homepage direct original kickoff should stay inside the standard kickoff modal after off-step text",
  );
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage direct original kickoff should not surface downstream breakdown or video actions before the kickoff finishes",
  );

  await clickVisibleButtonByLabels(page, ["创意创作"]);
  const targetMarketQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次原创剧本主要想打哪个目标市场？",
    buttonLabels: ["国内（中文）"],
    timeout: 15000,
  });
  assert.ok(
    targetMarketQuestion?.questionId || targetMarketQuestion?.answerKey,
    "homepage direct original workflow should keep using the standard composer modal after advancing to target market",
  );

  const stageOffStepInput = "还是别问了，直接给我角色海报和视频。";
  await sendFreeformText(page, stageOffStepInput);
  const resumedTargetMarketQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次原创剧本主要想打哪个目标市场？",
    buttonLabels: ["国内（中文）"],
    timeout: 30000,
  });
  assert.ok(
    resumedTargetMarketQuestion?.questionId || resumedTargetMarketQuestion?.answerKey,
    "homepage direct original workflow should preserve the standard target-market modal after off-step text",
  );
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage direct original workflow should not skip ahead after the user asks for later-stage work",
  );

  return {
    kickoffPrompt,
    offStepInput,
    stageOffStepInput,
    kickoffQuestion,
    targetMarketQuestion,
  };
}

function createHistorySwitchDramaProject({
  projectId,
  title,
  currentStep = "creative-plan",
  updatedAt = "2026-04-05T00:00:00.000Z",
}) {
  return {
    ...createDramaProject(projectId),
    dramaTitle: title,
    currentStep,
    updatedAt,
  };
}

function createHistorySwitchSession({
  projectId,
  title,
  assistantText,
  currentObjective,
  derivedStage,
  updatedAt = "2026-04-05T00:00:00.000Z",
}) {
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    automationMode: "manual",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: assistantText,
        createdAt: updatedAt,
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "script",
      automationMode: "manual",
      title,
      currentObjective,
      derivedStage,
      agentSummary: assistantText,
      recommendedActions: [currentObjective],
      artifacts: [],
      updatedAt,
    },
    recentMessageSummary: `assistant: ${assistantText}`,
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

function createPendingCharacterAudioReturnMenuQuestion(
  projectId = "video-project-audio-return-menu",
  characterId = "char-audio-return",
  characterName = "陆沉",
) {
  return {
    id: `video-bridge-panel:${projectId}:audio-return-menu`,
    title: `《${characterName}》角色与场景`,
    description: "当前停留在角色与场景阶段，可继续补角色主图、音频参考和变体素材。",
    options: [
      {
        id: `${characterId}-reference-image`,
        label: `重生成 ${characterName}`,
        value: `video:bridge:reference-assets:character-main:${characterId}`,
        rationale: "角色主参考图已具备，可继续重生成。",
        menuSection: "image",
      },
      {
        id: `${characterId}-audio-reference`,
        label: `更新${characterName}音频参考`,
        value: `video:bridge:reference-audio:character:${characterId}`,
        rationale: "上传 1 个音频文件即可覆盖当前角色音色。",
        menuSection: "audio",
      },
      {
        id: `${characterId}-variant`,
        label: "重生成 战损灰衣",
        value: `video:bridge:reference-assets:character-variant:${characterId}:variant-1`,
        rationale: "当前角色变体已生成，可继续重生成。",
        menuSection: "image",
      },
    ],
    allowCustomInput: true,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 1,
    totalSteps: 4,
    answerKey: "video-bridge-panel",
  };
}

function createPendingCharacterAudioReturnMenuProject(
  projectId = "video-project-audio-return-menu",
  characterId = "char-audio-return",
  characterName = "陆沉",
) {
  return {
    ...createVideoProject(projectId),
    title: "音频返回菜单验证项目",
    currentStep: 2,
    kickoffModeConfirmed: true,
    kickoffStyleConfirmed: true,
    scriptBreakdownPassed: true,
    characters: [
      {
        id: characterId,
        name: characterName,
        description: "黑发、冷静、带压迫感。",
        imageUrl: "https://example.com/char-audio-return.jpg",
        costumes: [
          {
            id: "variant-1",
            label: "战损灰衣",
            imageUrl: "https://example.com/char-audio-return-variant.jpg",
          },
        ],
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-audio-return",
        name: "走廊",
        description: "冷白灯走廊。",
        imageUrl: "https://example.com/scene-audio-return.jpg",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    shotPackets: [
      {
        id: `packet:${projectId}:scene-1`,
        sceneId: "scene-1",
        sceneNumber: 1,
        title: "走廊对峙",
        durationSec: 5,
        camera: {
          shotSize: "近景",
          movement: "轻推镜",
        },
        characterRefs: [],
        sourceAssetIds: [],
        promptSeed: "陆沉在冷白灯走廊里停下脚步，回头看向来人。",
        forbiddenChanges: ["保持角色面部识别特征和服装延续性。"],
        renderMode: "img2video",
        reviewStatus: "pending",
      },
    ],
    reviewQueue: [],
  };
}

function createPendingCharacterAudioReturnMenuSession(
  projectId = "video-project-audio-return-menu",
  characterId = "char-audio-return",
  characterName = "陆沉",
) {
  const pendingChoiceQuestion = createPendingCharacterAudioReturnMenuQuestion(
    projectId,
    characterId,
    characterName,
  );
  return {
    sessionId: `session-${projectId}`,
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: `assistant-${projectId}-1`,
        role: "assistant",
        content: "当前停留在角色与场景阶段，可以继续补单项素材。",
        createdAt: "2026-04-03T00:00:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId,
      projectKind: "video",
      title: "音频返回菜单验证项目",
      currentObjective: "继续补角色与场景",
      derivedStage: "角色与场景",
      agentSummary: "角色与场景弹窗已恢复，等待继续补素材。",
      recommendedActions: ["继续补角色与场景"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 当前停留在角色与场景阶段，可以继续补单项素材。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion,
    interruptedChoiceQuestion: pendingChoiceQuestion,
  };
}

function createBridgedVideoEntrySession(
  scriptProjectId = "drama-project-video-entry",
  videoProjectId = "video-project-video-entry-bridge",
  updatedAt = "2026-05-18T09:30:00.000Z",
) {
  return {
    ...createVideoEntrySession(scriptProjectId),
    sessionId: `session-${scriptProjectId}`,
    automationMode: "manual",
    messages: [
      {
        id: `assistant-${scriptProjectId}-bridge`,
        role: "assistant",
        content: "视频工作流已经接管当前剧本壳子，继续停留在脚本拆解阶段。",
        createdAt: updatedAt,
      },
    ],
    currentProjectSnapshot: {
      projectId: videoProjectId,
      projectKind: "video",
      automationMode: "manual",
      sourceProjectId: scriptProjectId,
      title: "视频入口串联测试剧本",
      currentObjective: "继续脚本拆解",
      derivedStage: "脚本拆解",
      agentSummary: "Video workflow now owns the source script shell.",
      recommendedActions: ["刷新拆解结果"],
      artifacts: [],
      updatedAt,
    },
    recentMessageSummary: "assistant: 视频工作流已经接管当前剧本壳子，继续停留在脚本拆解阶段。",
    projectId: scriptProjectId,
    pendingChoiceQuestion: null,
    interruptedChoiceQuestion: null,
  };
}

async function runHomepageStructuredQuestionNaturalLanguageGuideScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  const assertUserBubbleRightEdgesStayAligned = async (indexes, label) => {
    const bubbleLocator = page.locator(
      '[data-home-agent-message-role="user"] [data-home-agent-user-bubble="true"]',
    );
    const boxes = await Promise.all(
      indexes.map((index) => bubbleLocator.nth(index).boundingBox()),
    );
    assert.ok(
      boxes.every(Boolean),
      `${label} should keep the inspected user bubbles visible`,
    );
    const resolvedBoxes = boxes.filter(Boolean);
    const rightEdges = resolvedBoxes.map((box) => box.x + box.width);
    const delta = Math.max(...rightEdges) - Math.min(...rightEdges);
    assert.ok(
      delta <= 8,
      `${label} should keep right edges aligned, got delta ${delta.toFixed(2)}px`,
    );
    return {
      rightEdges,
      delta,
    };
  };

  const captureQuestionChatRound = async ({
    prompt,
    title,
    buttonLabels,
    label,
    minUniquePositiveLengthCount = 2,
    minPositiveStepCount = 1,
  }) => {
    const assistantLocator = page.locator(
      '[data-home-agent-message-role="assistant"]',
    );
    const previousAssistantCount = await assistantLocator.count();
    const previousAssistantRowId =
      previousAssistantCount > 0
        ? await assistantLocator
            .last()
            .getAttribute("data-home-agent-message-row")
        : null;

    const capturePromise = captureLatestAssistantStreamSamples(page, {
      previousAssistantCount,
      previousAssistantRowId,
      timeoutMs: 180000,
    });
    await sendFreeformText(page, prompt);
    const samples = await capturePromise;
    const summary = summarizeAssistantStreamSamples(samples);

    assert.ok(
      summary.sampleCount >= 4,
      `${label} should capture multiple UI samples, got ${summary.sampleCount}`,
    );
    assert.ok(
      summary.uniquePositiveLengthCount >= minUniquePositiveLengthCount,
      `${label} should reveal assistant text progressively, got ${summary.uniquePositiveLengthCount}`,
    );
    assert.ok(
      summary.positiveStepCount >= minPositiveStepCount,
      `${label} should grow assistant text in multiple steps, got ${summary.positiveStepCount}`,
    );
    assert.ok(
      summary.finalLength >= 12,
      `${label} should end with a visible assistant reply, got ${summary.finalLength}`,
    );
    const visibleAssistantMessages = await readVisibleAssistantMessages(
      page,
      Math.max(previousAssistantCount + 2, 10),
    );
    const assistantReplyText =
      visibleAssistantMessages[visibleAssistantMessages.length - 1] ?? "";

    let resumedQuestion;
    try {
      resumedQuestion = await waitForStandardComposerQuestion(page, {
        title,
        buttonLabels,
        timeout: 30000,
      });
    } catch (error) {
      const visibleQuestion = await readVisibleComposerQuestion(page).catch(() => null);
      const storedSession = await readStoredStudioSession(page).catch(() => null);
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `label=${label}`,
          `summary=${JSON.stringify(summary)}`,
          `visibleQuestion=${JSON.stringify(visibleQuestion)}`,
          `storedQState=${JSON.stringify(storedSession?.qState ?? null)}`,
          `storedDeferredQuestionState=${JSON.stringify(storedSession?.deferredQuestionState ?? null)}`,
          `storedPendingChoiceQuestion=${JSON.stringify(storedSession?.pendingChoiceQuestion ?? null)}`,
          `storedInterruptedChoiceQuestion=${JSON.stringify(storedSession?.interruptedChoiceQuestion ?? null)}`,
        ].join("\n"),
      );
    }
    assert.ok(
      resumedQuestion?.questionId || resumedQuestion?.answerKey,
      `${label} should restore the structured workflow question after the chat detour`,
    );

    return {
      prompt,
      summary,
      assistantReplyText,
      resumedQuestion,
    };
  };

  const kickoffPrompt =
    "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。";
  await sendFreeformText(page, kickoffPrompt);

  const kickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次想从哪种方式开始原创剧本？",
    buttonLabels: ["选题创作", "创意创作"],
    timeout: 120000,
  });
  assert.ok(
    kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
    "homepage natural-language guide scenario should open the standard original-script kickoff modal",
  );

  const kickoffRound = await captureQuestionChatRound({
    prompt:
      "先别急着让我点选，先用自然语言比较一下这两种开始方式各自适合什么情况。",
    title: "这次想从哪种方式开始原创剧本？",
    buttonLabels: ["选题创作", "创意创作"],
    label: "homepage kickoff natural-language detour",
    minUniquePositiveLengthCount: 2,
    minPositiveStepCount: 1,
  });
  assert.doesNotMatch(
    kickoffRound.assistantReplyText,
    /并行研究|快捷研究任务|结果会自动回流/u,
    "homepage kickoff natural-language detour should stay in normal assistant dialogue instead of launching auto research scaffolding",
  );
  const kickoffBubbleAlignment = await assertUserBubbleRightEdgesStayAligned(
    [0, 1],
    "homepage kickoff natural-language detour",
  );

  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage kickoff natural-language detour should not surface downstream workflow actions early",
  );

  await clickVisibleButtonByLabels(page, ["创意创作"]);
  const targetMarketQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次原创剧本主要想打哪个目标市场？",
    buttonLabels: ["国内（中文）"],
    timeout: 15000,
  });
  assert.ok(
    targetMarketQuestion?.questionId || targetMarketQuestion?.answerKey,
    "homepage natural-language guide scenario should advance into the standard target-market modal",
  );

  const targetMarketRound = await captureQuestionChatRound({
    prompt:
      "国内（中文）市场我还拿不准，你先用自然语言说说通常适合什么受众和节奏。",
    title: "这次原创剧本主要想打哪个目标市场？",
    buttonLabels: ["国内（中文）"],
    label: "homepage target-market natural-language detour",
    minUniquePositiveLengthCount: 1,
    minPositiveStepCount: 0,
  });
  assert.doesNotMatch(
    targetMarketRound.assistantReplyText,
    /并行研究|快捷研究任务|结果会自动回流/u,
    "homepage target-market natural-language detour should stay in normal assistant dialogue instead of launching auto research scaffolding",
  );
  const targetMarketBubbleAlignment = await assertUserBubbleRightEdgesStayAligned(
    [0, 1, 2],
    "homepage target-market natural-language detour",
  );

  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage target-market natural-language detour should stay inside the current workflow stage",
  );

  return {
    kickoffPrompt,
    kickoffQuestion,
    kickoffRound,
    kickoffBubbleAlignment,
    targetMarketQuestion,
    targetMarketRound,
    targetMarketBubbleAlignment,
  };
}

async function runHomepageDirectConversationAdaptationScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  const kickoffPrompt =
    "我要做参考改编。请先问我目标市场和改编方向，然后接收参考内容，在首页会话里继续推进结构转译和角色设计。";
  await sendFreeformText(page, kickoffPrompt);

  const kickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次参考改编想怎么开始？",
    buttonLabels: ["上传参考文档", "直接开始对话"],
    timeout: 120000,
  });
  assert.ok(
    kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
    "homepage direct adaptation kickoff should open the standard composer modal",
  );

  const offStepInput = "先别问改编方向，直接给我做角色设定。";
  await sendFreeformText(page, offStepInput);
  const resumedKickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "这次参考改编想怎么开始？",
    buttonLabels: ["上传参考文档", "直接开始对话"],
    timeout: 30000,
  });
  assert.ok(
    resumedKickoffQuestion?.questionId || resumedKickoffQuestion?.answerKey,
    "homepage direct adaptation kickoff should stay inside the standard kickoff modal after off-step text",
  );
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage direct adaptation kickoff should not surface later workflow actions before the kickoff finishes",
  );

  await clickVisibleButtonByLabels(page, ["直接开始对话"]);
  const followupQuestion = await waitForStandardComposerQuestion(page, {
    title: "需要时可以直接从这里上传参考剧本。",
    buttonLabels: ["上传参考文档"],
    timeout: 15000,
  });
  assert.ok(
    followupQuestion?.questionId || followupQuestion?.answerKey,
    "homepage direct adaptation dialog handoff should keep using the standard follow-up modal",
  );

  const stageOffStepInput = "别等参考文档了，直接给我做分镜和出片。";
  await sendFreeformText(page, stageOffStepInput);
  const resumedFollowupQuestion = await waitForStandardComposerQuestion(page, {
    title: "需要时可以直接从这里上传参考剧本。",
    buttonLabels: ["上传参考文档"],
    timeout: 30000,
  });
  assert.ok(
    resumedFollowupQuestion?.questionId || resumedFollowupQuestion?.answerKey,
    "homepage direct adaptation follow-up should preserve the standard modal after off-step text",
  );
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage direct adaptation flow should not skip into downstream video stages",
  );

  return {
    kickoffPrompt,
    offStepInput,
    stageOffStepInput,
    kickoffQuestion,
    followupQuestion,
  };
}

async function runHomepageDirectConversationVideoScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  const kickoffPrompt =
    "我要继续视频工作流。请先确认脚本来源，再在当前首页会话里继续推进分镜、提示词批次和出片准备。";
  await sendFreeformText(page, kickoffPrompt);

  const kickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "你的剧本来源是什么？",
    buttonLabels: ["上传剧本文档"],
    timeout: 120000,
  });
  assert.ok(
    kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
    "homepage direct video kickoff should open the standard composer modal",
  );
  assert.equal(
    kickoffQuestion?.visibleButtons?.some((label) => label.includes("使用当前剧本项目")),
    false,
    "homepage direct video kickoff should not offer current-project handoff when no script project is active",
  );

  const offStepInput = "我还没准备剧本，直接先帮我出视频。";
  await sendFreeformText(page, offStepInput);
  const resumedKickoffQuestion = await waitForStandardComposerQuestion(page, {
    title: "你的剧本来源是什么？",
    buttonLabels: ["上传剧本文档"],
    timeout: 30000,
  });
  assert.ok(
    resumedKickoffQuestion?.questionId || resumedKickoffQuestion?.answerKey,
    "homepage direct video kickoff should stay inside the standard kickoff modal after off-step text",
  );
  await assertNoVisibleButtonLabels(
    page,
    ["完成剧本拆解", "提取角色与场景", "图生视频", "文生视频"],
    "homepage direct video kickoff should not expose post-breakdown or generation actions before a script source is confirmed",
  );

  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/回形针按钮上传你的剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });

  return {
    kickoffPrompt,
    offStepInput,
    kickoffQuestion,
    uploadInstructionVisible: true,
  };
}

async function runHomepageAmbiguousConversationManualScenario(page) {
  const cases = [
    {
      firstPrompt: "你好",
      routePrompt: "那就先从原创剧本开始吧，我想做一个女性向悬疑短剧。",
      selectedRoute: "原创剧本",
      expectedTitle: "这次想从哪种方式开始原创剧本？",
      expectedButtons: ["选题创作", "创意创作"],
    },
    {
      firstPrompt: "我还没想好怎么开始，你先带我一下。",
      routePrompt: "那就先做参考改编。请先问我目标市场和改编方向，然后接住参考内容。",
      selectedRoute: "参考改编",
      expectedTitle: "这次参考改编想怎么开始？",
      expectedButtons: ["上传参考文档", "直接开始对话"],
    },
    {
      firstPrompt: "先聊聊你一般会怎么帮我梳理入口。",
      routePrompt: "我想继续视频工作流。请先确认脚本来源，再推进分镜、提示词批次和出片准备。",
      selectedRoute: "视频工作流",
      expectedTitle: "你的剧本来源是什么？",
      expectedButtons: ["上传剧本文档"],
    },
  ];
  const cycleMetrics = [];

  for (const [index, testCase] of cases.entries()) {
    await resetAndSeed(page, {
      [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
    });

    const startedAt = Date.now();
    const previousAssistantCount = await page.locator('[data-home-agent-message-role="assistant"]').count();
    await sendFreeformText(page, testCase.firstPrompt);
    const firstReplyText = await waitForLatestAssistantReply(page, previousAssistantCount, 180000);
    const visibleQuestionAfterGuidance = await readVisibleComposerQuestion(page);
    assert.equal(
      visibleQuestionAfterGuidance,
      null,
      `manual homepage greeting should stay in natural conversation mode on cycle ${index + 1}`,
    );
    assert.ok(
      firstReplyText.length >= 10,
      `manual homepage greeting should end with a visible assistant reply on cycle ${index + 1}, got ${firstReplyText.length}`,
    );

    await sendFreeformTextReliable(page, testCase.routePrompt);
    const kickoffQuestion = await waitForStandardComposerQuestion(page, {
      title: testCase.expectedTitle,
      buttonLabels: testCase.expectedButtons,
      timeout: 30000,
    });
    assert.ok(
      kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
      `manual homepage guidance should connect to ${testCase.selectedRoute} after explicit routing on cycle ${index + 1}`,
    );
    if (testCase.selectedRoute === "视频工作流") {
      assert.equal(
        kickoffQuestion?.visibleButtons?.some((label) => label.includes("使用当前剧本项目")),
        false,
        "manual homepage video routing should not surface current-project handoff on an empty homepage",
      );
    }

    const storedSession = await readStoredStudioSession(page);
    cycleMetrics.push({
      cycle: index + 1,
      selectedRoute: testCase.selectedRoute,
      routeOpenDurationMs: Date.now() - startedAt,
      firstRoundFinalLength: firstReplyText.length,
      kickoffAnswerKey: kickoffQuestion?.answerKey ?? null,
      storedAutomationMode: storedSession?.automationMode ?? "manual",
    });
  }

  return {
    cycles: cycleMetrics.length,
    maxRouteOpenDurationMs: Math.max(...cycleMetrics.map((metric) => metric.routeOpenDurationMs)),
    cycleMetrics,
  };
}

async function runHomepageIdentityIntroductionManualScenario(page) {
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
  });

  let previousAssistantCount = await page.locator('[data-home-agent-message-role="assistant"]').count();
  await sendFreeformText(page, "你好");
  const greetingReply = await waitForLatestAssistantReply(page, previousAssistantCount, 180000);
  assert.ok(greetingReply.length >= 8, `greeting reply should be visible, got ${greetingReply.length}`);
  assert.equal(
    await readVisibleComposerQuestion(page),
    null,
    "simple homepage greeting should not open a structured popup before the user states a need",
  );

  previousAssistantCount = await page.locator('[data-home-agent-message-role="assistant"]').count();
  await sendFreeformTextReliable(page, "你是谁");
  const identityReply = await waitForLatestAssistantReply(page, previousAssistantCount, 180000);

  assert.match(identityReply, /InFinio/u, "identity reply should mention the product name");
  assert.match(identityReply, /首页|工作台/u, "identity reply should describe the homepage/workbench role");
  assert.match(identityReply, /原创剧本|参考改编|视频工作流/u, "identity reply should explain the core workflow scope");
  assert.doesNotMatch(
    identityReply,
    /Claude|Anthropic|模型 ID|model id/i,
    "identity reply should not lead with raw model/provider details",
  );
  assert.equal(
    await readVisibleComposerQuestion(page),
    null,
    "identity introduction should stay in natural conversation mode",
  );

  return {
    greetingReply,
    identityReply,
  };
}

async function runHomepageAmbiguousConversationFullAutoScenario(page) {
  const cases = [
    {
      firstPrompt: "你好",
      routePrompt: "那就从原创剧本开始，用创意创作，我想先做一个都市悬疑方向。",
    },
  ];
  const cycleMetrics = [];

  for (const [index, testCase] of cases.entries()) {
    await resetAndSeed(page, {
      [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
    });
    await switchAutomationMode(page, "full-auto");

    const startedAt = Date.now();
    const previousAssistantCount = await page.locator('[data-home-agent-message-role="assistant"]').count();
    await sendFreeformText(page, testCase.firstPrompt);
    const firstReplyText = await waitForLatestAssistantReply(page, previousAssistantCount, 180000);
    const visibleQuestionAfterGuidance = await readVisibleComposerQuestion(page);
    assert.equal(
      visibleQuestionAfterGuidance,
      null,
      `full-auto homepage greeting should stay in natural conversation mode on cycle ${index + 1}`,
    );
    assert.ok(
      firstReplyText.length >= 10,
      `full-auto homepage greeting should end with a visible assistant reply on cycle ${index + 1}, got ${firstReplyText.length}`,
    );

    await page.waitForFunction(
      ([sessionKey]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          return JSON.parse(raw)?.automationMode === "full-auto";
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY],
      { timeout: 5000 },
    );
    const kickoffSession = await readStoredStudioSession(page);
    assert.equal(
      kickoffSession?.automationMode,
      "full-auto",
      `full-auto homepage guidance should persist full-auto mode on cycle ${index + 1}`,
    );

    await sendFreeformTextReliable(page, testCase.routePrompt);
    const resumedKickoffQuestion = await waitForStandardComposerQuestion(page, {
      title: "这次想从哪种方式开始原创剧本？",
      buttonLabels: ["选题创作", "创意创作"],
      timeout: 30000,
    });
    assert.ok(
      resumedKickoffQuestion?.questionId || resumedKickoffQuestion?.answerKey,
      `full-auto homepage guidance should open the original-script kickoff after explicit routing on cycle ${index + 1}`,
    );

    await clickVisibleButtonByLabels(page, ["创意创作"]);
    const targetMarketQuestion = await waitForStandardComposerQuestion(page, {
      title: "这次原创剧本主要想打哪个目标市场？",
      buttonLabels: ["国内（中文）"],
      timeout: 30000,
    });
    assert.ok(
      targetMarketQuestion?.questionId || targetMarketQuestion?.answerKey,
      `full-auto homepage guidance should continue into target-market collection on cycle ${index + 1}`,
    );

    cycleMetrics.push({
      cycle: index + 1,
      kickoffDurationMs: Date.now() - startedAt,
      firstRoundFinalLength: firstReplyText.length,
      kickoffAnswerKey: resumedKickoffQuestion?.answerKey ?? null,
      targetMarketAnswerKey: targetMarketQuestion?.answerKey ?? null,
    });
  }

  return {
    cycles: cycleMetrics.length,
    maxKickoffDurationMs: Math.max(...cycleMetrics.map((metric) => metric.kickoffDurationMs)),
    cycleMetrics,
  };
}

async function ensureSmokeAutomationMode(page, automationMode) {
  try {
    await page.waitForFunction(
      ([targetMode]) =>
        document.querySelector("[data-automation-mode]")?.getAttribute("data-automation-mode") === targetMode,
      [automationMode],
      { timeout: 5000 },
    );
  } catch {
    await switchAutomationMode(page, automationMode);
  }
}

async function resumePendingQuestionWithVaguePrompt(
  page,
  {
    prompt,
    title,
    buttonLabels,
    expectedAnswerKey,
    expectedAutomationMode,
    expectedProjectId,
  },
) {
  await sendFreeformTextReliable(page, prompt);
  const resumedQuestion = await waitForStandardComposerQuestion(page, {
    title,
    buttonLabels,
    timeout: 30000,
  });
  assert.equal(
    resumedQuestion?.answerKey,
    expectedAnswerKey,
    `vague prompt "${prompt}" should keep the ${expectedAnswerKey} popup active`,
  );
  await page.waitForFunction(
    ([sessionKey, answerKey, automationMode, projectId]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw);
        return (
          (session?.pendingChoiceQuestion?.answerKey ?? null) === answerKey &&
          (session?.automationMode ?? "manual") === automationMode &&
          (session?.currentProjectSnapshot?.projectId ?? null) === projectId
        );
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, expectedAnswerKey, expectedAutomationMode, expectedProjectId],
    { timeout: 5000 },
  );
  const storedSession = await readStoredStudioSession(page);
  assert.equal(
    storedSession?.pendingChoiceQuestion?.answerKey ?? null,
    expectedAnswerKey,
    `vague prompt "${prompt}" should keep the pending-choice answerKey aligned`,
  );
  assert.equal(
    storedSession?.automationMode ?? "manual",
    expectedAutomationMode,
    `vague prompt "${prompt}" should preserve ${expectedAutomationMode} mode`,
  );
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId ?? null,
    expectedProjectId,
    `vague prompt "${prompt}" should keep the same active project session`,
  );
  return resumedQuestion;
}

async function continueVideoAnalyzeBreakdownToRoleScene(page) {
  const breakdownQuestion = await waitForStandardComposerQuestion(page, {
    title: "完成剧本拆解",
    buttonLabels: ["完成剧本拆解"],
    timeout: 15000,
  });
  assert.ok(
    breakdownQuestion?.questionId || breakdownQuestion?.answerKey,
    "after duration and pace are confirmed, the workflow should advance into the breakdown popup",
  );
  await clickVisibleButtonByLabels(page, ["完成剧本拆解"]);

  const outcome = await Promise.any([
    waitForVisibleButtonLabels(page, ["刷新拆解结果", "提取角色与场景"], 300000).then((buttons) => ({
      kind: "success",
      buttons,
    })),
    waitForStandardComposerQuestion(page, {
      title: "继续剧本拆解",
      buttonLabels: ["继续剧本拆解"],
      timeout: 300000,
    }).then((question) => ({
      kind: "recovery",
      question,
    })),
  ]);

  if (outcome.kind === "recovery") {
    assert.equal(
      outcome.question?.answerKey,
      "video-analyze-resume",
      "script breakdown interruptions should recover into the standard continue-breakdown popup",
    );
    await clickVisibleButtonByLabels(page, ["继续剧本拆解"]);
    const buttons = await waitForVisibleButtonLabels(page, ["刷新拆解结果", "提取角色与场景"], 300000);
    return {
      nextStep: "role-and-scene",
      recoveredFromBreakdownInterruption: true,
      visibleButtons: buttons,
    };
  }

  return {
    nextStep: "role-and-scene",
    recoveredFromBreakdownInterruption: false,
    visibleButtons: outcome.buttons,
  };
}

async function runHomepageAmbiguousResumePendingStepScenario(page, automationMode = "manual") {
  const projectId =
    automationMode === "full-auto"
      ? "video-project-3-full-auto-ambiguous-resume"
      : "video-project-3-manual-ambiguous-resume";
  const seededSession = createVideoAnalyzeDurationSessionForMode(projectId, automationMode);
  const resumedDurationPrompts =
    automationMode === "full-auto"
      ? ["你来带", "继续吧", "下一步呢", "嗯"]
      : ["先继续", "你来定", "往下走", "嗯"];
  const resumedPacePrompts =
    automationMode === "full-auto"
      ? ["继续", "你决定", "后面怎么走", "然后呢"]
      : ["继续吧", "你来带", "下一步", "然后呢"];

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoAnalyzeDurationProject(projectId)],
    [STUDIO_SESSION_KEY]: seededSession,
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [projectId]: seededSession,
    },
    [AUTOMATION_MODE_KEY]: automationMode,
  });

  await ensureSmokeAutomationMode(page, automationMode);

  const durationQuestion = await waitForStandardComposerQuestion(page, {
    title: "请选择单集时长",
    buttonLabels: ["60 秒", "90 秒"],
    timeout: 30000,
  });
  assert.equal(
    durationQuestion?.answerKey,
    "video-analyze-duration",
    `${automationMode} ambiguous resume should start from the duration popup`,
  );

  for (const prompt of resumedDurationPrompts) {
    await resumePendingQuestionWithVaguePrompt(page, {
      prompt,
      title: "请选择单集时长",
      buttonLabels: ["60 秒", "90 秒"],
      expectedAnswerKey: "video-analyze-duration",
      expectedAutomationMode: automationMode,
      expectedProjectId: projectId,
    });
  }

  await clickVisibleButtonByLabels(page, ["60 秒"]);
  const paceQuestion = await waitForStandardComposerQuestion(page, {
    title: "请选择视频节奏",
    buttonLabels: ["慢节奏", "中等", "快节奏"],
    timeout: 15000,
  });
  assert.equal(
    paceQuestion?.answerKey,
    "video-analyze-pace",
    `${automationMode} ambiguous resume should advance into the pace popup after choosing duration`,
  );

  for (const prompt of resumedPacePrompts) {
    await resumePendingQuestionWithVaguePrompt(page, {
      prompt,
      title: "请选择视频节奏",
      buttonLabels: ["慢节奏", "中等", "快节奏"],
      expectedAnswerKey: "video-analyze-pace",
      expectedAutomationMode: automationMode,
      expectedProjectId: projectId,
    });
  }

  await clickVisibleButtonByLabels(page, ["中等"]);
  const breakdownQuestion = await waitForStandardComposerQuestion(page, {
    title: "完成剧本拆解",
    buttonLabels: ["完成剧本拆解"],
    timeout: 15000,
  });
  assert.ok(
    breakdownQuestion?.questionId || breakdownQuestion?.answerKey,
    `${automationMode} ambiguous pending-step resume should advance into the breakdown popup after choosing pace`,
  );
  const storedSession = await readStoredStudioSession(page);

  assert.equal(
    storedSession?.automationMode ?? "manual",
    automationMode,
    `${automationMode} ambiguous pending-step resume should keep the active session mode after continuing the workflow`,
  );
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId ?? null,
    projectId,
    `${automationMode} ambiguous pending-step resume should keep the same video project while continuing`,
  );

  return {
    automationMode,
    projectId,
    durationAnswerKey: durationQuestion?.answerKey ?? null,
    paceAnswerKey: paceQuestion?.answerKey ?? null,
    breakdownAnswerKey: breakdownQuestion?.answerKey ?? null,
    resumedDurationPrompts,
    resumedPacePrompts,
    nextStep: "script-breakdown",
  };
}

async function runCasualConversationStreamingScenario(page, automationMode = "manual") {
  const projectId =
    automationMode === "full-auto"
      ? "casual-chat-project-full-auto"
      : "casual-chat-project-manual";
  const title = automationMode === "full-auto" ? "全自动闲聊压测项目" : "普通闲聊压测项目";
  const prompts =
    automationMode === "full-auto"
      ? [
          "今天有点累，先随便聊聊就好。",
          "先不推进步骤，轻松说说它最打动人的地方。",
          "再随口说说这个故事最容易被记住的气质。",
        ]
      : [
          "今天有点累，先随便聊聊这个项目给人的感觉。",
          "先不赶流程，轻松说说它现在最有意思的地方。",
          "如果只是随口聊两句，你会怎么描述它的整体气质？",
        ];

  const roundMetrics = [];
  for (const [index, prompt] of prompts.entries()) {
    const seededSession = createCasualChatSession({ projectId, automationMode });
    await resetAndSeed(page, {
      [DRAMA_PROJECTS_KEY]: [createCasualChatDramaProject(projectId)],
      [STUDIO_SESSION_KEY]: seededSession,
      [STUDIO_PROJECT_SESSIONS_KEY]: {
        [projectId]: seededSession,
      },
    });

    if (automationMode === "full-auto") {
      await switchAutomationMode(page, "full-auto");
    }

    await page.getByText(title).first().waitFor({ state: "visible", timeout: 10000 });

    const previousAssistantCount = await page.locator('[data-home-agent-message-role="assistant"]').count();
    const previousAssistantRowId =
      await page.locator('[data-home-agent-message-role="assistant"]').last().getAttribute("data-home-agent-message-row");
    const roundStartedAt = Date.now();
    await sendFreeformText(page, prompt);
    const samples = await captureLatestAssistantStreamSamples(page, {
      previousAssistantCount,
      previousAssistantRowId,
      timeoutMs: 180000,
    });
    const summary = summarizeAssistantStreamSamples(samples);
    await page.waitForTimeout(180);
    const finalViewportState = await page.evaluate(() => {
      const container = document.querySelector(".app-main-container");
      if (!(container instanceof HTMLElement)) {
        return { bottomGap: Number.POSITIVE_INFINITY };
      }
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      return {
        bottomGap: Math.max(0, maxScrollTop - container.scrollTop),
      };
    });
    const storedSession = await readStoredStudioSession(page);

    assert.ok(
      summary.sampleCount >= 6,
      `${automationMode} casual chat round ${index + 1} should produce multiple UI samples, got ${summary.sampleCount}`,
    );
    assert.ok(
      summary.uniquePositiveLengthCount >= 4,
      `${automationMode} casual chat round ${index + 1} should reveal text in multiple increments, got ${summary.uniquePositiveLengthCount}`,
    );
    assert.ok(
      summary.positiveStepCount >= 3,
      `${automationMode} casual chat round ${index + 1} should not collapse into one large text jump, got ${summary.positiveStepCount}`,
    );
    assert.ok(
      summary.maxLengthJump <= 64,
      `${automationMode} casual chat round ${index + 1} should keep text growth smooth, max jump was ${summary.maxLengthJump}`,
    );
    assert.ok(
      summary.finalLength >= 12,
      `${automationMode} casual chat round ${index + 1} should end with a visible assistant reply, got ${summary.finalLength}`,
    );
    assert.ok(
      finalViewportState.bottomGap <= 12,
      `${automationMode} casual chat round ${index + 1} should keep auto-scroll near the bottom, gap was ${finalViewportState.bottomGap}`,
    );
    assert.equal(
      storedSession?.automationMode ?? automationMode,
      automationMode,
      `${automationMode} casual chat round ${index + 1} should preserve the active automation mode`,
    );

    roundMetrics.push({
      round: index + 1,
      prompt,
      durationMs: Date.now() - roundStartedAt,
      ...summary,
      finalBottomGap: finalViewportState.bottomGap,
    });
  }

  return {
    automationMode,
    rounds: roundMetrics.length,
    maxDurationMs: Math.max(...roundMetrics.map((metric) => metric.durationMs)),
    maxLengthJump: Math.max(...roundMetrics.map((metric) => metric.maxLengthJump)),
    maxBottomGap: Math.max(...roundMetrics.map((metric) => metric.maxBottomGap)),
    roundMetrics,
  };
}

async function openVideoStyleProject(page) {
  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoStyleProject()],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      "video-project-2": createVideoStyleSession("video-project-2"),
    },
  });

  await openHistoryProject(page, "风格面板测试项目");
  await page.getByText(/^选择画面风格类型$/).first().waitFor({
    state: "visible",
    timeout: 10000,
  });
}

async function openVideoAnalyzeDurationProject(page) {
  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoAnalyzeDurationProject()],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      "video-project-3": createVideoAnalyzeDurationSession("video-project-3"),
    },
  });

  await openHistoryProject(page, "时长面板测试项目");
  await page.getByText("请选择单集时长").first().waitFor({
    state: "visible",
    timeout: 10000,
  });
}

async function openVideoWorkflowEntryProject(page, options = {}) {
  const { seed = true } = options;

  if (seed) {
    await resetAndSeed(page, {
      [DRAMA_PROJECTS_KEY]: [createVideoEntryDramaProject()],
      [STUDIO_SESSION_KEY]: createVideoEntrySession(),
    });
  }

  await page.getByText("用于视频创作").first().waitFor({
    state: "visible",
    timeout: 10000,
  });
}

async function runVideoStyleCustomInputScenario(page) {
  await openVideoStyleProject(page);

  const customOptionCount = await page.getByRole("button", { name: "自定义" }).count();
  assert.equal(customOptionCount, 0, "风格面板不应再展示旧的自定义选项卡");

  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  const placeholder = await textarea.getAttribute("placeholder");
  assert.equal(
    placeholder,
    "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
    "风格面板激活时应替换输入框提示文案",
  );

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  assert.equal(highlightVisible, true, "风格面板激活时应高亮主输入框");

  const customPrompt = "电影级低饱和胶片质感，雨夜霓虹反射";
  await textarea.fill(customPrompt);
  await textarea.press("Enter");

  await page.getByText(/自定义说明已写入：/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });

  return {
    customOptionCount,
    placeholder,
    highlightVisible,
    customPrompt,
  };
}

async function runVideoStyleReferenceUploadScenario(page) {
  await openVideoStyleProject(page);

  const referenceImagePath = path.join(
    process.cwd(),
    "public",
    "home-agent-ai-avatar.png",
  );
  await page.locator('input[type="file"]').setInputFiles(referenceImagePath);
  await page.getByRole("button", { name: /已附加 1 个文件/ }).first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  await page.locator("textarea").last().focus();
  await page.locator("textarea").last().press("Enter");
  await page.waitForFunction(
    () => document.body.innerText.includes("参考图摘要："),
    undefined,
    { timeout: 60000 },
  );

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  const studioSession = await readStoredStudioSession(page);
  const latestUserMessage = [...(studioSession?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === "user");
  assert.equal(
    latestUserMessage?.content,
    "识别已上传参考图",
    "上传参考图后点击发送，应写入一条真实的用户发送消息",
  );
  assert.equal(
    styleReferenceAttachmentMessages.length,
    1,
    "完整视频链路里上传参考图后，参考图用户消息应只保留一条附件记录",
  );
  assert.ok(
    styleReferenceUserMessages.every((message) =>
      ["", "识别已上传参考图"].includes(String(message?.content ?? "").trim())),
    "完整视频链路里上传参考图后，不应写入额外自由文本用户消息",
  );
  assert.ok(
    Array.isArray(latestUserMessage?.attachments) && latestUserMessage.attachments.length > 0,
    "上传参考图后点击发送，应把附件写入用户消息历史",
  );

  return {
    referenceImagePath,
    highlightVisible,
    latestUserAttachmentCount: latestUserMessage?.attachments?.length ?? 0,
  };
}

/* async function runVideoStyleReferenceUploadRobustScenario(page) {
  await openVideoStyleProject(page);

  const referenceImagePath = path.join(
    process.cwd(),
    "public",
    "home-agent-ai-avatar.png",
  );
  await page.locator('input[type="file"]').setInputFiles(referenceImagePath);
  await page.getByRole("button", { name: /宸查檮鍔?1 涓枃浠? }).first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  const textarea = page.locator("textarea").last();
  await textarea.focus();
  await textarea.press("Enter");
  {
    await page.waitForFunction(() => {
    const body = document.body.innerText;
    return (
      body.includes("参考图摘要：") ||
      body.includes("补齐平台与镜头偏好") ||
      body.includes("继续补齐平台与镜头偏好") ||
      body.includes("请选择单集时长")
    );
  }, undefined, { timeout: 120000 });

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;

  return {
    referenceImagePath,
    highlightVisible,
  };
} */

async function runVideoStyleReferenceUploadReliableScenario(page) {
  await openVideoStyleProject(page);
  const studioSessionBeforeStyleCapture = await readStoredStudioSession(page);
  const userMessageCountBeforeStyleCapture = (studioSessionBeforeStyleCapture?.messages ?? [])
    .filter((message) => message?.role === "user").length;

  const referenceImagePath = path.join(
    process.cwd(),
    "public",
    "home-agent-ai-avatar.png",
  );
  await page.locator('input[type="file"]').setInputFiles(referenceImagePath);
  await page.getByText("已附加 1 个文件").first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  const textarea = page.locator("textarea").last();
  await textarea.focus();
  await textarea.press("Enter");
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes("正在识别参考图风格"),
      undefined,
      { timeout: 5000 },
    );
    await page.getByText(/^选择画面风格类型$/).first().waitFor({
      state: "hidden",
      timeout: 5000,
    });
    await page.locator('img[alt="home-agent-ai-avatar.png"]').first().waitFor({
      state: "visible",
      timeout: 5000,
    });
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return (
        body.includes("参考图摘要：") &&
        (
          body.includes("补齐平台与镜头偏好") ||
          body.includes("继续补齐平台与镜头偏好")
        )
      );
    }, undefined, { timeout: 120000 });
    await page.waitForFunction(
      () => !document.body.innerText.includes("已附加 1 个文件"),
      undefined,
      { timeout: 15000 },
    );
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const studioSession = await readStoredStudioSession(page).catch(() => null);
    throw new Error([
      String(error?.stack || error),
      "",
      JSON.stringify(
        {
          recentMessages: (studioSession?.messages ?? []).slice(-4),
          pendingChoiceQuestion: studioSession?.pendingChoiceQuestion?.answerKey ?? null,
          interruptedChoiceQuestion: studioSession?.interruptedChoiceQuestion?.answerKey ?? null,
          qState: studioSession?.qState?.request?.id ?? null,
        },
        null,
        2,
      ),
      "",
      bodyPreview.slice(0, 2200),
    ].join("\n"));
  }

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  await page.waitForTimeout(1600);
  const studioSessionAfterStyleCapture = await readStoredStudioSession(page);
  const userMessagesAfterStyleCapture = (studioSessionAfterStyleCapture?.messages ?? [])
    .filter((message) => message?.role === "user");
  const latestUserMessage = [...userMessagesAfterStyleCapture].reverse()[0];
  const latestAssistantMessage = [...(studioSessionAfterStyleCapture?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === "assistant");
  assert.equal(
    userMessagesAfterStyleCapture.length,
    userMessageCountBeforeStyleCapture + 1,
    "上传参考图后，不应额外新增右侧 user 消息",
  );
  assert.ok(
    Array.isArray(latestUserMessage?.attachments) &&
      latestUserMessage.attachments.some((attachment) => attachment.fileName === "home-agent-ai-avatar.png"),
    "上传参考图后，新增的用户消息应保留参考图附件",
  );
  assert.ok(
    ["", "识别已上传参考图"].includes(String(latestUserMessage?.content ?? "").trim()),
    "上传参考图后，新增的用户消息不应带入额外自由文本",
  );
  assert.ok(
    latestAssistantMessage?.content?.includes("参考图摘要"),
    "上传参考图后，assistant 应该给出风格识别摘要",
  );
  return {
    referenceImagePath,
    highlightVisible,
    userMessageCountBeforeStyleCapture,
    userMessageCountAfterStyleCapture: userMessagesAfterStyleCapture.length,
  };
}

async function runVideoAnalyzeDurationCustomInputScenario(page) {
  await openVideoAnalyzeDurationProject(page);

  const customOptionCount = await page.getByRole("button", { name: "自定义" }).count();
  assert.equal(customOptionCount, 0, "时长面板不应再展示旧的自定义选项卡");

  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  const placeholder = await textarea.getAttribute("placeholder");
  assert.equal(placeholder, "输入时长（秒）", "时长面板激活时应替换输入框提示文案");

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  assert.equal(highlightVisible, true, "时长面板激活时应高亮主输入框");

  await textarea.fill("75");
  await textarea.press("Enter");

  await page.getByText("请选择视频节奏").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "慢速" }).first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  return {
    customOptionCount,
    placeholder,
    highlightVisible,
  };
}

async function runVideoWorkflowEntryToRoleAndSceneScenario(page) {
  await openVideoWorkflowEntryProject(page);

  await page.getByRole("button", { name: "用于视频创作" }).last().click();
  await page.getByRole("button", { name: "使用当前剧本项目" }).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "使用当前剧本项目" }).last().click();

  await page.getByText("请选择单集时长").first().waitFor({
    state: "visible",
    timeout: 120000,
  });
  await page.getByRole("button", { name: "60 秒" }).last().click();
  await page.getByText("请选择视频节奏").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "中等" }).last().click();
  await page.getByText("完成剧本拆解").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "完成剧本拆解" }).last().click();

  const videoProjectId = await waitForCurrentVideoProjectId(page);
  try {
    await waitForVisibleButtonLabels(
      page,
      ["刷新拆解结果", "提取角色与场景"],
      300000,
    );
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    const studioSession = await readStoredStudioSession(page).catch(() => null);
    const storedProject = await readStoredVideoProject(page, videoProjectId).catch(() => null);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `videoProjectId=${videoProjectId}`,
        JSON.stringify(
          {
            sessionProjectKind: studioSession?.currentProjectSnapshot?.projectKind ?? null,
            sessionStage: studioSession?.currentProjectSnapshot?.derivedStage ?? null,
            sessionObjective: studioSession?.currentProjectSnapshot?.currentObjective ?? null,
            sessionRecommendedActions: studioSession?.currentProjectSnapshot?.recommendedActions ?? null,
            pendingChoiceQuestion: studioSession?.pendingChoiceQuestion?.answerKey ?? null,
            interruptedChoiceQuestion: studioSession?.interruptedChoiceQuestion?.answerKey ?? null,
            storedProjectId: storedProject?.id ?? null,
            storedProjectTitle: storedProject?.title ?? null,
            videoMode: storedProject?.videoGenerationPrefs?.mode ?? null,
            scriptBreakdownPassed: storedProject?.scriptBreakdownPassed ?? null,
            sceneCount: storedProject?.scenes?.length ?? null,
            characterCount: storedProject?.characters?.length ?? null,
            sceneSettingCount: storedProject?.sceneSettings?.length ?? null,
            analysisSummary: storedProject?.analysisSummary ?? null,
          },
          null,
          2,
        ),
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2600),
      ].join("\n"),
    );
  }
  assert.equal(typeof videoProjectId, "string", "剧本拆解启动后应该切到当前视频项目");

  await clickVisibleButtonByLabels(page, ["提取角色与场景"]);

  try {
    await page.getByText("先选择视频生成模式").first().waitFor({
      state: "visible",
      timeout: 300000,
    });
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    const studioSession = await readStoredStudioSession(page).catch(() => null);
    const storedProject = await readStoredVideoProject(page, videoProjectId).catch(() => null);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `videoProjectId=${videoProjectId}`,
        JSON.stringify(
          {
            sessionProjectKind: studioSession?.currentProjectSnapshot?.projectKind ?? null,
            sessionStage: studioSession?.currentProjectSnapshot?.derivedStage ?? null,
            sessionObjective: studioSession?.currentProjectSnapshot?.currentObjective ?? null,
            sessionRecommendedActions: studioSession?.currentProjectSnapshot?.recommendedActions ?? null,
            pendingChoiceQuestion: studioSession?.pendingChoiceQuestion?.answerKey ?? null,
            interruptedChoiceQuestion: studioSession?.interruptedChoiceQuestion?.answerKey ?? null,
            videoMode: storedProject?.videoGenerationPrefs?.mode ?? null,
            scriptBreakdownPassed: storedProject?.scriptBreakdownPassed ?? null,
            sceneCount: storedProject?.scenes?.length ?? null,
            characterCount: storedProject?.characters?.length ?? null,
            sceneSettingCount: storedProject?.sceneSettings?.length ?? null,
          },
          null,
          2,
        ),
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2600),
      ].join("\n"),
    );
  }
  await page.getByRole("button", { name: "图生视频" }).last().click();
  await page.getByText(/^选择画面风格类型$/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  const textarea = page.locator("textarea").last();
  const studioSessionBeforeStyleCapture = await readStoredStudioSession(page);
  const userMessageCountBeforeStyleCapture = (studioSessionBeforeStyleCapture?.messages ?? [])
    .filter((message) => message?.role === "user").length;
  const placeholder = await textarea.getAttribute("placeholder");
  assert.equal(
    placeholder,
    "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
    "完整视频链路里的风格面板也应该切到统一的自定义捕获输入态",
  );
  const referenceImagePath = path.join(
    process.cwd(),
    "public",
    "home-agent-ai-avatar.png",
  );
  await page.locator('input[type="file"]').setInputFiles(referenceImagePath);
  await page.getByText("已附加 1 个文件").first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await textarea.focus();
  await textarea.press("Enter");
  await page.waitForFunction(
    () => document.body.innerText.includes("正在识别参考图风格"),
    undefined,
    { timeout: 5000 },
  );
  await page.getByText(/^选择画面风格类型$/).first().waitFor({
    state: "hidden",
    timeout: 5000,
  });
  await page.locator('img[alt="home-agent-ai-avatar.png"]').first().waitFor({
    state: "visible",
    timeout: 5000,
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("参考图摘要："),
    undefined,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => !document.body.innerText.includes("已附加 1 个文件"),
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(1600);
  const studioSessionAfterStyleCapture = await readStoredStudioSession(page);
  const userMessagesAfterStyleCapture = (studioSessionAfterStyleCapture?.messages ?? [])
    .filter((message) => message?.role === "user");
  const styleReferenceUserMessages = userMessagesAfterStyleCapture.filter((message) => {
    const content = String(message?.content ?? "");
    return (
      content.includes("识别已上传参考图") ||
      (Array.isArray(message?.attachments) &&
        message.attachments.some((attachment) => attachment.fileName === "home-agent-ai-avatar.png"))
    );
  });
  const styleReferenceAttachmentMessages = styleReferenceUserMessages.filter((message) =>
    Array.isArray(message?.attachments) &&
    message.attachments.some((attachment) => attachment.fileName === "home-agent-ai-avatar.png"));
  const latestAssistantMessage = [...(studioSessionAfterStyleCapture?.messages ?? [])]
    .reverse()
    .find((message) => message?.role === "assistant");
  assert.equal(
    styleReferenceUserMessages.length,
    1,
    "完整视频链路里上传参考图后，不应额外新增参考图 user 消息或 user 附件",
  );
  assert.ok(
    latestAssistantMessage?.content?.includes("参考图摘要"),
    "完整视频链路里上传参考图后，assistant 应该给出风格识别摘要",
  );
  try {
    await waitForVisibleButtonLabels(
      page,
      [
        "补齐平台与镜头偏好",
        "继续补齐平台与镜头偏好",
        "补齐目标平台",
        "补齐镜头风格",
        "补齐出片目标",
      ],
      120000,
    );
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `videoProjectId=${videoProjectId}`,
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2600),
      ].join("\n"),
    );
  }

  const bridgeButtonsBeforeClick = await listVisibleButtons(page);
  const hasContinuePrefixButton = bridgeButtonsBeforeClick.some(
    (button) =>
      button.text.includes("继续补齐平台与镜头偏好") ||
      button.ariaLabel.includes("继续补齐平台与镜头偏好"),
  );

  if (hasContinuePrefixButton) {
    await clickVisibleButtonByLabels(page, ["继续补齐平台与镜头偏好"]);
  } else {
    await clickVisibleButtonByLabels(page, ["补齐平台与镜头偏好"]);
  }

  let roleAndSceneSignal;
  try {
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return (
        body.includes("批量执行") ||
        body.includes("单项处理") ||
        body.includes("Agent 正在处理「补齐平台与镜头偏好」") ||
        body.includes("正在生成，请稍候…")
      );
    }, undefined, { timeout: 120000 });
    const body = await page.locator("body").innerText();
    if (body.includes("批量执行") || body.includes("单项处理")) {
      const roleAndSceneButtons = await listVisibleButtons(page);
      roleAndSceneSignal = roleAndSceneButtons.some(
        (button) =>
          button.text.includes("推荐动作") || button.ariaLabel.includes("推荐动作"),
      )
        ? "role-and-scene-groups"
        : "role-and-scene-panel";
    } else {
      roleAndSceneSignal = "bridge-running";
    }
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `videoProjectId=${videoProjectId}`,
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2600),
      ].join("\n"),
    );
  }

  const storedProject = await readStoredVideoProject(page, videoProjectId);

  return {
    videoProjectId,
    nextStep: "role-and-scene",
    roleAndSceneSignal,
    sceneCount: storedProject?.scenes?.length ?? null,
    characterCount: storedProject?.characters?.length ?? null,
    sceneSettingCount: storedProject?.sceneSettings?.length ?? null,
    scriptBreakdownPassed: storedProject?.scriptBreakdownPassed ?? null,
  };
}

async function runSkipComplianceHistoryActionScenario(page) {
  const scriptProjectId = "drama-project-skip-history";
  const videoProjectId = "video-project-live-skip";
  const expectedTitle = "Skip Review Script";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createSkipComplianceHistoryDramaProject(scriptProjectId)],
    [VIDEO_PROJECTS_KEY]: [createSkipComplianceHistoryVideoProject(videoProjectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [scriptProjectId]: createSkipComplianceSidebarSession(scriptProjectId),
      [videoProjectId]: createSkipComplianceHistorySession(scriptProjectId, videoProjectId),
    },
    [STUDIO_SESSION_KEY]: createSkipComplianceHistorySession(scriptProjectId, videoProjectId),
  });

  await openHistoryProject(page, expectedTitle);
  await waitForVisibleButtonLabels(page, ["跳过审查"], 10000);
  await clickVisibleButtonByLabels(page, ["跳过审查"]);

  await page.waitForFunction(
    ([sessionKey, expectedProjectId, expectedProjectTitle]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const session = JSON.parse(raw);
        return (
          session?.currentProjectSnapshot?.projectId === expectedProjectId &&
          session?.currentProjectSnapshot?.projectKind === "script" &&
          session?.currentProjectSnapshot?.title === expectedProjectTitle
        );
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, scriptProjectId, expectedTitle],
    { timeout: 15000 },
  );

  const storedSession = await readStoredStudioSession(page);
  const storedDramaProjects = await readStoredDramaProjects(page);
  const sidebarSnapshot = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-sidebar-history-id]")).map((element) => ({
      projectId: element.getAttribute("data-sidebar-history-id") || "",
      text: (element.textContent || "").replace(/\s+/g, " ").trim(),
    })),
  );

  const namedProject = storedDramaProjects.find((project) => project?.id === scriptProjectId) ?? null;
  const unexpectedVideoDramaProject = storedDramaProjects.find((project) => project?.id === videoProjectId) ?? null;

  assert.equal(storedSession?.currentProjectSnapshot?.title, expectedTitle, "skip review should keep the original script title");
  assert.equal(storedSession?.currentProjectSnapshot?.projectId, scriptProjectId, "skip review should restore the original script project id");
  assert.equal(storedSession?.currentProjectSnapshot?.projectKind, "script", "skip review should land back on a script snapshot");
  assert.ok(namedProject, "named script project should still exist after skip review");
  assert.equal(namedProject?.dramaTitle, expectedTitle, "named script project should retain its original title");
  assert.equal(unexpectedVideoDramaProject, null, "skip review should not create a drama project under the live video id");
  assert.equal(
    storedDramaProjects.some((project) => !(project?.dramaTitle || "").trim()),
    false,
    "skip review should not persist unnamed drama projects",
  );
  assert.equal(
    sidebarSnapshot.some((entry) => entry.text.includes("未命名项目") || entry.text.includes("未命名剧本项目")),
    false,
    "sidebar should not show unnamed project cards after skip review",
  );

  return {
    restoredProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
    restoredTitle: storedSession?.currentProjectSnapshot?.title ?? null,
    sidebarEntries: sidebarSnapshot.length,
    storedDramaProjectCount: storedDramaProjects.length,
  };
}

async function runDeleteBridgedVideoProjectScenario(page) {
  const scriptProjectId = "drama-project-delete-bridge";
  const videoProjectId = "video-project-delete-bridge";
  const title = "Delete Bridge Project";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDeleteBridgeDramaProject(scriptProjectId)],
    [VIDEO_PROJECTS_KEY]: [createDeleteBridgeVideoProject(videoProjectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [scriptProjectId]: createDeleteBridgeScriptSession(scriptProjectId),
      [videoProjectId]: createDeleteBridgeVideoSession(scriptProjectId, videoProjectId),
    },
    [STUDIO_SESSION_KEY]: createDeleteBridgeVideoSession(scriptProjectId, videoProjectId),
  });

  await page.waitForFunction(
    ([videoId, scriptId]) => {
      const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .filter(Boolean);
      return visibleIds.includes(videoId) && !visibleIds.includes(scriptId);
    },
    [videoProjectId, scriptProjectId],
    { timeout: 15000 },
  );

  await openHistoryProjectMenu(page, videoProjectId);
  await page.getByRole("menuitem", { name: /删除/ }).first().click();
  await clickVisibleButtonByLabels(page, ["确认删除"]);

  try {
    await page.waitForFunction(
      ([videoId, scriptId]) => {
        const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
          .map((element) => element.getAttribute("data-sidebar-history-id") || "")
          .filter(Boolean);
        return !visibleIds.includes(videoId) && !visibleIds.includes(scriptId);
      },
      [videoProjectId, scriptProjectId],
      { timeout: 15000 },
    );
  } catch (error) {
    const debugState = await page.evaluate(([videoId, scriptId]) => {
      const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .filter(Boolean);
      const sidebarText = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const studioSession = JSON.parse(window.localStorage.getItem("storyforge-home-agent-session-v1") || "null");
      const projectSessions = JSON.parse(window.localStorage.getItem("storyforge-home-agent-project-sessions-v1") || "{}");
      const dramaProjects = JSON.parse(window.localStorage.getItem("storyforge_drama_projects") || "[]");
      const videoProjects = JSON.parse(window.localStorage.getItem("storyforge_projects") || "[]");
      return {
        expectedGone: [videoId, scriptId],
        visibleIds,
        sidebarText,
        currentProjectId: studioSession?.currentProjectSnapshot?.projectId ?? null,
        projectSessionIds: Object.keys(projectSessions || {}),
        dramaProjectIds: Array.isArray(dramaProjects) ? dramaProjects.map((project) => project?.id || "") : [],
        videoProjectIds: Array.isArray(videoProjects) ? videoProjects.map((project) => project?.id || "") : [],
      };
    }, [videoProjectId, scriptProjectId]);
    throw new Error(
      `deleteBridgedVideoProject sidebar ids did not disappear after delete: ${JSON.stringify(debugState, null, 2)}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const storedSession = await readStoredStudioSession(page);
  const storedDramaProjects = await readStoredDramaProjects(page);
  const sidebarIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
      .map((element) => element.getAttribute("data-sidebar-history-id") || "")
      .filter(Boolean),
  );

  assert.equal(
    storedDramaProjects.some((project) => project?.id === scriptProjectId),
    false,
    "deleting a bridged video project should also remove the linked source script when it is the only bridge target",
  );
  assert.equal(sidebarIds.includes(scriptProjectId), false, "source script card should not reappear after deleting the bridged video project");
  assert.equal(sidebarIds.includes(videoProjectId), false, "deleted video card should not reappear after deletion");
  assert.equal(
    storedSession?.currentProjectSnapshot?.title === title,
    false,
    "current session should not keep the deleted bridge project as the active snapshot",
  );

  return {
    sidebarEntries: sidebarIds.length,
    remainingDramaProjects: storedDramaProjects.length,
    activeProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
  };
}

async function runFullAutoOriginalScriptEndToEndScenario(page) {
  const assetProjectId = "video-project-full-auto-asset-stress";
  const assetCount = 220;
  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
    [DRAMA_PROJECTS_KEY]: [],
    [VIDEO_PROJECTS_KEY]: [],
  });
  await page.evaluate(([currentProjectKey]) => {
    window.localStorage.removeItem(currentProjectKey);
  }, [CURRENT_PROJECT_KEY]);
  await setWorkflowTestScenario(page, FULL_AUTO_ORIGINAL_SCRIPT_SMOKE_SCENARIO);
  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the smoke IPC override");

    await page.getByRole("button", { name: "打开或关闭设置" }).first().click();
    await page.getByText("首页 Agent 模式").first().waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: "全自动模式" }).first().click();
    await page.waitForFunction(
      () => Boolean(document.querySelector("[data-automation-mode='full-auto']")),
      undefined,
      { timeout: 10000 },
    );
    await page.getByRole("button", { name: "打开或关闭设置" }).first().click();

    await waitForVisibleButtonLabels(page, ["原创剧本"], 10000);
    await clickVisibleButtonByLabels(page, ["原创剧本"]);

    const creativeInput = "Full Auto Smoke Project 雨夜旧案重逢后，女主和冷面投资人联手反击幕后操盘者。";
    const customVideoStyle = "电影级写实雨夜霓虹，低饱和胶片质感，人物压迫感更强。";
    const handledQuestionKeys = [];
    const questionRepeatCounts = new Map();
    const fallbackEligibleQuestionKeys = new Set([
      "full-auto-preflight:outlineGeneration",
      "full-auto-preflight:episodeDuration",
      "full-auto-preflight:episodeWriting",
      "full-auto-preflight:videoAnalyze",
      "full-auto-preflight:videoAnalyzeDetail",
      "full-auto-preflight:videoGeneration",
    ]);
    let executionStarted = false;
    const deadline = Date.now() + 180000;

    while (Date.now() < deadline) {
      let completionVisible = 0;
      let completionState = null;
      try {
        completionVisible = await page.getByText("全自动链路已完成。历史记录已标记为全自动模式。").count();
      } catch (error) {
        throw new Error(
          `full-auto page became unavailable after questions ${JSON.stringify(handledQuestionKeys)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (
        completionVisible > 0 ||
        (
          completionState?.fullAutoStatus === "completed" &&
          completionState?.projectKind === "video" &&
          typeof completionState?.projectId === "string" &&
          completionState.projectId.trim().length > 0
        )
      ) {
        break;
      }

      const question = await readVisibleComposerQuestion(page);
      if (!question) {
        await page.waitForTimeout(200);
        continue;
      }

      const answerKey = question.answerKey || question.questionId || question.text;
      handledQuestionKeys.push(answerKey);
      questionRepeatCounts.set(answerKey, (questionRepeatCounts.get(answerKey) ?? 0) + 1);
      if (answerKey === "full-auto-preflight:videoStyle" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
        throw new Error(
          `videoStyle question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }
      if (answerKey === "full-auto-preflight:videoExportPath" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
        throw new Error(
          `videoExportPath question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }

      if (answerKey === "创作方式") {
        await clickVisibleComposerQuestionButton(page, ["创意创作"]);
      } else if (answerKey === "目标市场") {
        await clickVisibleComposerQuestionButton(page, ["国内（中文）"]);
      } else if (answerKey === "创意内容") {
        await sendFreeformText(page, creativeInput);
      } else if (answerKey === "目标受众") {
        await clickVisibleComposerQuestionButton(page, ["女频"]);
      } else if (answerKey === "故事基调") {
        await clickVisibleComposerQuestionButton(page, ["甜虐"]);
      } else if (answerKey === "结局类型") {
        await clickVisibleComposerQuestionButton(page, ["HE"]);
      } else if (String(question.questionId || "").includes(":word-count:")) {
        await clickVisibleComposerQuestionButton(page, ["60集（标准）"]);
      } else if (answerKey === "full-auto-preflight:episodeReview") {
        await clickVisibleComposerQuestionButton(page, ["跳过正文质检"]);
      } else if (answerKey === "full-auto-preflight:complianceReview") {
        await clickVisibleComposerQuestionButton(page, ["跳过合规审查"]);
      } else if (answerKey === "full-auto-preflight:scriptExportRoute") {
        await clickVisibleComposerQuestionButton(page, ["直接桥接视频工作流"]);
      } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
        await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
      } else if (answerKey === "full-auto-preflight:videoMode") {
        await clickVisibleComposerQuestionButton(page, ["文生视频"]);
      } else if (answerKey === "full-auto-preflight:videoStyle") {
        await submitComposerTextWithoutEcho(page, customVideoStyle);
      } else if (answerKey === "full-auto-preflight:referenceAssets") {
        await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
      } else if (answerKey === "full-auto-preflight:videoPrompts") {
        await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
      } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
        await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
      } else if (answerKey === "full-auto-preflight:videoExport") {
        await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
      } else if (answerKey === "full-auto-preflight:videoExportDetail") {
        await clickVisibleComposerQuestionButton(page, ["自动合并字幕"]);
      } else if (answerKey === "full-auto-preflight:videoExportPath") {
        if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
          await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
        } else {
          await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
        }
        executionStarted = true;
      } else if (fallbackEligibleQuestionKeys.has(answerKey)) {
        const fallbackLabel = getFirstActionableComposerButtonLabel(question);
        if (!fallbackLabel) {
          throw new Error(
            `No actionable composer button found for ${answerKey}: ${JSON.stringify(question.visibleButtons, null, 2)}`,
          );
        }
        await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
      } else if (executionStarted) {
        await page.waitForTimeout(200);
        continue;
      } else {
        throw new Error(`Unexpected composer question before execution: ${JSON.stringify(question, null, 2)}`);
      }

      await page.waitForTimeout(160);
    }

    const completionSessionState = await readStoredStudioSession(page);
    const completedBySessionState = Boolean(
      completionSessionState?.fullAutoRun?.status === "completed" &&
      completionSessionState?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(completionSessionState?.currentProjectSnapshot?.projectId),
    );
    const completionMessageVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']")).some((element) =>
        (element.textContent || "").includes("全自动链路已完成"),
      ),
    );
    if (!completionMessageVisible && !completedBySessionState) {
      const trace = await readWorkflowTestTrace(page).catch(() => []);
      const debugState = await page.evaluate(([sessionKey, projectsKey]) => {
        const parse = (key, fallback) => {
          try {
            const raw = window.localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        };

        const studioSession = parse(sessionKey, null);
        const videoProjects = parse(projectsKey, []);
        const assistantMessages = Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']"))
          .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);

        return {
          studioSession,
          videoProjectIds: Array.isArray(videoProjects) ? videoProjects.map((project) => project?.id || "") : [],
          messageTail: assistantMessages.slice(-6),
        };
      }, [STUDIO_SESSION_KEY, VIDEO_PROJECTS_KEY]);
      throw new Error(
        `full-auto original-script smoke did not finish in time; handled questions: ${JSON.stringify(handledQuestionKeys)}\ntrace: ${JSON.stringify(trace, null, 2)}\ndebug: ${JSON.stringify(debugState, null, 2)}`,
      );
    }
    if (!(completionMessageVisible || completedBySessionState)) {
    assert.ok(
      await page.getByText("全自动链路已完成。历史记录已标记为全自动模式。").count(),
      `full-auto original-script smoke did not finish in time; handled questions: ${JSON.stringify(handledQuestionKeys)}`,
    );
    }

    await page.waitForFunction(
      ([traceKey]) => {
        const raw = window.localStorage.getItem(traceKey);
        if (!raw) return false;
        try {
          const trace = JSON.parse(raw);
          return Array.isArray(trace) && trace.some((entry) => entry?.actionKind === "compile_segment_videos");
        } catch {
          return false;
        }
      },
      [WORKFLOW_TEST_TRACE_KEY],
      { timeout: 60000 },
    );

    const trace = await readWorkflowTestTrace(page);
    const actionKinds = trace
      .map((entry) => (typeof entry?.actionKind === "string" ? entry.actionKind : null))
      .filter(Boolean);
    assert.deepEqual(
      actionKinds,
      [
        "save_setup",
        "generate_creative_plan",
        "generate_characters",
        "generate_directory",
        "generate_outlines",
        "generate_episode_batch",
        "skip_compliance_review",
        "prepare_video_generation",
        "analyze_script_for_video",
        "extract_video_entities",
        "create_video_bridge_artifact",
        "compile_video_shot_packets",
        "prepare_segment_video_prompt",
        "generate_segment_video",
        "compile_segment_videos",
      ],
      `unexpected workflow trace:\n${JSON.stringify(trace, null, 2)}`,
    );

    const storedSession = await readStoredStudioSession(page);
    const finalSnapshot = storedSession?.currentProjectSnapshot ?? null;
    assert.equal(storedSession?.automationMode, "full-auto", "full-auto run should persist the session mode");
    assert.equal(finalSnapshot?.projectKind, "video", "full-auto run should land on a video snapshot");
    assert.ok(finalSnapshot?.projectId, "full-auto run should persist a final video project id");
    assert.ok(finalSnapshot?.sourceProjectId, "full-auto run should keep the source script project id");

    const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
    assert.ok(storedVideoProject, "full-auto run should persist the final video project");
    assert.equal(
      storedVideoProject?.sourceProjectId,
      finalSnapshot.sourceProjectId,
      "persisted video project should keep the source script linkage",
    );
    assert.equal(
      storedVideoProject?.segmentVideos?.["EP01-01"]?.includes("segment-1.mp4") ?? false,
      true,
      "persisted video project should contain the generated segment video",
    );

    await setWorkflowTestScenario(page, null);
    const seededAssetSessionBase = createAssetStressSession(assetProjectId, assetCount);
    const seededAssetSession = {
      ...seededAssetSessionBase,
      automationMode: "full-auto",
      currentProjectSnapshot: {
        ...seededAssetSessionBase.currentProjectSnapshot,
        automationMode: "full-auto",
      },
    };
    await page.evaluate(
      ({ projectsKey, sessionsKey, videoProject, assetSession }) => {
        const readArray = (key) => {
          try {
            const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        };
        const readObject = (key) => {
          try {
            const parsed = JSON.parse(window.localStorage.getItem(key) || "{}");
            return parsed && typeof parsed === "object" ? parsed : {};
          } catch {
            return {};
          }
        };

        const existingProjects = readArray(projectsKey).filter((project) => project?.id !== videoProject.id);
        const existingSessions = readObject(sessionsKey);
        window.localStorage.setItem(projectsKey, JSON.stringify([videoProject, ...existingProjects]));
        window.localStorage.setItem(
          sessionsKey,
          JSON.stringify({
            ...existingSessions,
            [assetSession.projectId]: assetSession,
          }),
        );
      },
      {
        projectsKey: VIDEO_PROJECTS_KEY,
        sessionsKey: STUDIO_PROJECT_SESSIONS_KEY,
        videoProject: createAssetStressVideoProject(assetProjectId, assetCount),
        assetSession: seededAssetSession,
      },
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(
      ([sessionKey, projectId]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          return JSON.parse(raw)?.currentProjectSnapshot?.projectId === projectId;
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, finalSnapshot.projectId],
      { timeout: 15000 },
    );

    const switchToAssetStartedAt = Date.now();
    await openHistoryProject(page, "素材压力测试项目");
    await page.locator("[data-sidebar-asset-list='image']").first().waitFor({
      state: "visible",
      timeout: 10000,
    });
    await page.waitForFunction(
      () => {
        const container = document.querySelector("[data-sidebar-asset-list='image']");
        return container instanceof HTMLElement && container.innerText.includes("压力素材");
      },
      undefined,
      { timeout: 15000 },
    );
    const visibleAssetLabels = await page.evaluate(() => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return [];
      return container.innerText
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line.includes("压力素材"));
    });
    assert.ok(
      visibleAssetLabels.length > 0 && visibleAssetLabels.length < assetCount,
      `heavy asset session should keep the asset list bounded, got ${visibleAssetLabels.length} for ${assetCount}`,
    );
    const switchToAssetMs = Date.now() - switchToAssetStartedAt;

    const finalTitle = finalSnapshot.title;
    const finalProjectId = finalSnapshot.projectId;
    const switchBackStartedAt = Date.now();
    await openHistoryProject(page, finalTitle);
    await page.waitForFunction(
      ([sessionKey, projectId]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          return JSON.parse(raw)?.currentProjectSnapshot?.projectId === projectId;
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, finalProjectId],
      { timeout: 15000 },
    );
    const switchBackMs = Date.now() - switchBackStartedAt;
    const switchBackRestored = await page.evaluate(([sessionKey, projectId]) => {
      try {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        const session = JSON.parse(raw);
        return (
          session?.currentProjectSnapshot?.projectId === projectId &&
          session?.currentProjectSnapshot?.projectKind === "video" &&
          session?.fullAutoRun?.status === "completed"
        );
      } catch {
        return false;
      }
    }, [STUDIO_SESSION_KEY, finalProjectId]);
    if (!switchBackRestored) {
    assert.equal(
      await page.getByText("全自动链路已完成。历史记录已标记为全自动模式。").count() > 0,
      true,
      "switching back from the heavy asset session should restore the completed full-auto conversation",
    );
    }

  return {
    handledQuestionKeys,
    workflowActions: actionKinds,
    finalProjectId,
    finalTitle,
    sourceProjectId: finalSnapshot.sourceProjectId ?? null,
    exportDir,
    visibleAssetCount: visibleAssetLabels.length,
    switchToAssetMs,
    switchBackMs,
  };
}

async function runFullAutoAdaptationEndToEndScenario(page) {
  const referenceScript = [
    "《参考改编烟测项目》",
    "第1集 雨夜重逢",
    "沈映在雨夜追查父亲旧案时，与一直暗中布局的顾承砚再度相遇。",
    "第2集 试探联手",
    "两人表面合作、暗地博弈，在仓库对峙中交换关键筹码。",
    "第3集 身份反咬",
    "反派通过舆论反咬女主，逼迫她公开站队，进一步激化情感与利益冲突。",
  ].join("\n");
  const customVideoStyle = "电影级写实雨夜霓虹，冷色胶片质感，人物压迫感更强。";
  let referenceFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  if (!(await pathExists(referenceFilePath))) {
    referenceFilePath = path.join(os.tmpdir(), `home-agent-full-auto-adaptation-${Date.now()}.txt`);
    await fs.writeFile(referenceFilePath, referenceScript, "utf8");
  }

  await resetAndSeed(page, {
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
    [DRAMA_PROJECTS_KEY]: [],
    [VIDEO_PROJECTS_KEY]: [],
  });
  await page.evaluate(([currentProjectKey]) => {
    window.localStorage.removeItem(currentProjectKey);
  }, [CURRENT_PROJECT_KEY]);
  await setWorkflowTestScenario(page, FULL_AUTO_ADAPTATION_SMOKE_SCENARIO);

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the smoke IPC override");

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["参考改编"], 10000);
  await clickVisibleButtonByLabels(page, ["参考改编"]);
  await waitForVisibleButtonLabels(page, ["上传参考文档", "直接开始对话"], 15000);
  await clickVisibleButtonByLabels(page, ["上传参考文档"]);
  await page.getByText(/上传参考剧本文档|上传参考文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, referenceFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  {
    const kickoffDeadline = Date.now() + 30000;
    let kickoffReady = false;
    while (Date.now() < kickoffDeadline) {
      const checklistVisible = await page
        .locator('[data-testid="full-auto-message-checklist"]')
        .first()
        .isVisible()
        .catch(() => false);
      const visibleQuestion = await readVisibleComposerQuestion(page);
      if (checklistVisible || visibleQuestion) {
        kickoffReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert.equal(
      kickoffReady,
      true,
      "real full-auto video run should surface either the checklist or the next question after upload",
    );
  }

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const completionState = await readStoredStudioSession(page);
    const completedBySessionState = Boolean(
      completionState?.fullAutoRun?.status === "completed" &&
      completionState?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(completionState?.currentProjectSnapshot?.projectId),
    );
    const completionVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-role='assistant']")).some((element) =>
        (element.textContent || "").includes("全自动链路已完成"),
      ),
    );
    if (completionVisible || completedBySessionState) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(200);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(answerKey, (questionRepeatCounts.get(answerKey) ?? 0) + 1);

    if (answerKey === "full-auto-preflight:videoStyle" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
      throw new Error(
        `videoStyle question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
      );
    }
    if (answerKey === "full-auto-preflight:videoExportPath" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
      throw new Error(
        `videoExportPath question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
      );
    }

    if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(
          `No actionable composer button found for ${answerKey}: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "script-reference-v2") {
      await clickVisibleComposerQuestionButton(page, ["分析参考剧本"]);
    } else if (
      [
        "full-auto-preflight:adaptationEpisodeCount",
        "full-auto-preflight:adaptationTargetMarket",
        "full-auto-preflight:adaptationGenres",
        "full-auto-preflight:outlineGeneration",
        "full-auto-preflight:episodeDuration",
        "full-auto-preflight:episodeWriting",
        "full-auto-preflight:videoAnalyze",
        "full-auto-preflight:videoAnalyzeDetail",
        "full-auto-preflight:videoGeneration",
      ].includes(answerKey)
    ) {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(
          `No actionable composer button found for ${answerKey}: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:episodeReview") {
      await clickVisibleComposerQuestionButton(page, ["跳过正文质检"]);
    } else if (answerKey === "full-auto-preflight:complianceReview") {
      await clickVisibleComposerQuestionButton(page, ["跳过合规审查"]);
    } else if (answerKey === "full-auto-preflight:scriptExportRoute") {
      await clickVisibleComposerQuestionButton(page, ["直接桥接视频工作流"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await submitComposerTextWithoutEcho(page, customVideoStyle);
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["自动合并字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(200);
      continue;
    } else {
      throw new Error(`Unexpected composer question before execution: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(160);
  }

  const completionSessionState = await readStoredStudioSession(page);
  const completedBySessionState = Boolean(
    completionSessionState?.fullAutoRun?.status === "completed" &&
    completionSessionState?.currentProjectSnapshot?.projectKind === "video" &&
    trimString(completionSessionState?.currentProjectSnapshot?.projectId),
  );
  const completionMessageVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-role='assistant']")).some((element) =>
      (element.textContent || "").includes("全自动链路已完成"),
    ),
  );
  if (!completionMessageVisible && !completedBySessionState) {
    const trace = await readWorkflowTestTrace(page).catch(() => []);
    throw new Error(
      `full-auto adaptation smoke did not finish in time; handled questions: ${JSON.stringify(handledQuestionKeys)}\ntrace: ${JSON.stringify(trace, null, 2)}\nsession: ${JSON.stringify(completionSessionState, null, 2)}`,
    );
  }

  await page.waitForFunction(
    ([traceKey]) => {
      const raw = window.localStorage.getItem(traceKey);
      if (!raw) return false;
      try {
        const trace = JSON.parse(raw);
        return Array.isArray(trace) && trace.some((entry) => entry?.actionKind === "compile_segment_videos");
      } catch {
        return false;
      }
    },
    [WORKFLOW_TEST_TRACE_KEY],
    { timeout: 60000 },
  );

  const trace = await readWorkflowTestTrace(page);
  const actionKinds = trace
    .map((entry) => (typeof entry?.actionKind === "string" ? entry.actionKind : null))
    .filter(Boolean);
  assert.deepEqual(
    actionKinds,
    [
      "save_setup",
      "analyze_reference_script",
      "confirm_adaptation_episode_count",
      "confirm_adaptation_target_market",
      "confirm_adaptation_genres",
      "generate_structure_transform",
      "generate_character_transform",
      "generate_directory",
      "generate_outlines",
      "generate_episode_batch",
      "skip_compliance_review",
      "prepare_video_generation",
      "analyze_script_for_video",
      "extract_video_entities",
      "create_video_bridge_artifact",
      "compile_video_shot_packets",
      "prepare_segment_video_prompt",
      "generate_segment_video",
      "compile_segment_videos",
    ],
    `unexpected workflow trace:\n${JSON.stringify(trace, null, 2)}`,
  );

  const storedSession = await readStoredStudioSession(page);
  const finalSnapshot = storedSession?.currentProjectSnapshot ?? null;
  assert.equal(storedSession?.automationMode, "full-auto", "full-auto adaptation run should persist the session mode");
  assert.equal(finalSnapshot?.projectKind, "video", "full-auto adaptation run should land on a video snapshot");
  assert.ok(finalSnapshot?.projectId, "full-auto adaptation run should persist a final video project id");
  assert.ok(finalSnapshot?.sourceProjectId, "full-auto adaptation run should keep the generated script project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "full-auto adaptation run should persist the final video project");
  assert.equal(
    storedVideoProject?.sourceProjectId,
    finalSnapshot.sourceProjectId,
    "persisted adaptation video project should keep the generated script linkage",
  );
  assert.equal(
    storedVideoProject?.segmentVideos?.["EP01-01"]?.includes("segment-1.mp4") ?? false,
    true,
    "persisted adaptation video project should contain the generated segment video",
  );

  await setWorkflowTestScenario(page, null);
  return {
    handledQuestionKeys,
    workflowActions: actionKinds,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    referenceFilePath,
  };
}

async function runFullAutoVideoWorkflowEndToEndScenario(page) {
  const fallbackVideoScript = [
    "《烟火人间不及你》",
    "第1集：命运序章",
    "1-1 夜 内 医院走廊",
    "林晓晓攥着缴费单，弟弟的手术倒计时逼得她喘不过气。",
    "1-2 夜 内 陆家老宅大厅",
    "陆寒沉冷眼审视林晓晓，要求她先通过一场试膳。",
    "1-3 夜 内 陆家餐厅",
    "林晓晓端出热汤面，陆寒沉第一次对食物产生反应。",
  ].join("\\n");
  let scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  if (!(await pathExists(scriptFilePath))) {
    scriptFilePath = path.join(os.tmpdir(), `home-agent-full-auto-video-${Date.now()}.txt`);
    await fs.writeFile(scriptFilePath, fallbackVideoScript, "utf8");
  }
  const customVideoStyle = "电影级写实雨夜霓虹，冷色胶片质感，人物压迫感更强。";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [],
    [STUDIO_PROJECT_SESSIONS_KEY]: {},
    [STUDIO_SESSION_KEY]: createFreshHomepageSession(),
    [VIDEO_PROJECTS_KEY]: [],
  });
  await page.evaluate(([currentProjectKey]) => {
    window.localStorage.removeItem(currentProjectKey);
  }, [CURRENT_PROJECT_KEY]);
  await setWorkflowTestScenario(page, FULL_AUTO_VIDEO_WORKFLOW_SMOKE_SCENARIO);

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the smoke IPC override");

  await switchAutomationMode(page, "full-auto");

  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  {
    const kickoffDeadline = Date.now() + 30000;
    let kickoffReady = false;
    while (Date.now() < kickoffDeadline) {
      const checklistVisible = await page
        .locator('[data-testid="full-auto-message-checklist"]')
        .first()
        .isVisible()
        .catch(() => false);
      const visibleQuestion = await readVisibleComposerQuestion(page);
      if (checklistVisible || visibleQuestion) {
        kickoffReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert.equal(
      kickoffReady,
      true,
      "real full-auto video run should surface either the checklist or the next question after upload",
    );
  }

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + 180000;

  while (Date.now() < deadline) {
    const completionState = await readStoredStudioSession(page);
    const completedBySessionState = Boolean(
      completionState?.fullAutoRun?.status === "completed" &&
      completionState?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(completionState?.currentProjectSnapshot?.projectId),
    );
    const completionVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-role='assistant']")).some((element) =>
        (element.textContent || "").includes("全自动链路已完成"),
      ),
    );
    if (completionVisible || completedBySessionState) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(200);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(answerKey, (questionRepeatCounts.get(answerKey) ?? 0) + 1);

    if (answerKey === "full-auto-preflight:videoStyle" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
      throw new Error(
        `videoStyle question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
      );
    }
    if (answerKey === "full-auto-preflight:videoExportPath" && (questionRepeatCounts.get(answerKey) ?? 0) >= 5) {
      throw new Error(
        `videoExportPath question did not advance; visible buttons: ${JSON.stringify(question.visibleButtons, null, 2)}`,
      );
    }

    if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(
          `No actionable composer button found for ${answerKey}: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (
      [
        "full-auto-preflight:videoAnalyze",
        "full-auto-preflight:videoAnalyzeDetail",
        "full-auto-preflight:videoGeneration",
      ].includes(answerKey)
    ) {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(
          `No actionable composer button found for ${answerKey}: ${JSON.stringify(question.visibleButtons, null, 2)}`,
        );
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await submitComposerTextWithoutEcho(page, customVideoStyle);
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["自动合并字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(200);
      continue;
    } else {
      throw new Error(`Unexpected composer question before execution: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(160);
  }

  const completionSessionState = await readStoredStudioSession(page);
  const completedBySessionState = Boolean(
    completionSessionState?.fullAutoRun?.status === "completed" &&
    completionSessionState?.currentProjectSnapshot?.projectKind === "video" &&
    trimString(completionSessionState?.currentProjectSnapshot?.projectId),
  );
  const completionMessageVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-role='assistant']")).some((element) =>
      (element.textContent || "").includes("鍏ㄨ嚜鍔ㄩ摼璺凡瀹屾垚"),
    ),
  );
  if (!completionMessageVisible && !completedBySessionState) {
    const trace = await readWorkflowTestTrace(page).catch(() => []);
    const debugState = await page.evaluate(([sessionKey, projectsKey]) => {
      const parse = (key, fallback) => {
        try {
          const raw = window.localStorage.getItem(key);
          if (!raw) return fallback;
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      };

      const studioSession = parse(sessionKey, null);
      const videoProjects = parse(projectsKey, []);
      const assistantMessages = Array.from(document.querySelectorAll("[data-role='assistant']"))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      return {
        studioSession,
        videoProjectIds: Array.isArray(videoProjects) ? videoProjects.map((project) => project?.id || "") : [],
        messageTail: assistantMessages.slice(-6),
      };
    }, [STUDIO_SESSION_KEY, VIDEO_PROJECTS_KEY]);
    throw new Error(
      `full-auto video smoke did not finish in time; handled questions: ${JSON.stringify(handledQuestionKeys)}\ntrace: ${JSON.stringify(trace, null, 2)}\ndebug: ${JSON.stringify(debugState, null, 2)}`,
    );
  }

  await page.waitForFunction(
    ([traceKey]) => {
      const raw = window.localStorage.getItem(traceKey);
      if (!raw) return false;
      try {
        const trace = JSON.parse(raw);
        return Array.isArray(trace) && trace.some((entry) => entry?.actionKind === "compile_segment_videos");
      } catch {
        return false;
      }
    },
    [WORKFLOW_TEST_TRACE_KEY],
    { timeout: 60000 },
  );

  const trace = await readWorkflowTestTrace(page);
  const actionKinds = trace
    .map((entry) => (typeof entry?.actionKind === "string" ? entry.actionKind : null))
    .filter(Boolean);
  assert.deepEqual(
    actionKinds,
    [
      "prepare_video_generation",
      "analyze_script_for_video",
      "extract_video_entities",
      "create_video_bridge_artifact",
      "compile_video_shot_packets",
      "prepare_segment_video_prompt",
      "generate_segment_video",
      "compile_segment_videos",
    ],
    `unexpected workflow trace:\n${JSON.stringify(trace, null, 2)}`,
  );

  const storedSession = await readStoredStudioSession(page);
  const finalSnapshot = storedSession?.currentProjectSnapshot ?? null;
  assert.equal(storedSession?.automationMode, "full-auto", "full-auto video run should persist the session mode");
  assert.equal(finalSnapshot?.projectKind, "video", "full-auto video run should land on a video snapshot");
  assert.ok(finalSnapshot?.projectId, "full-auto video run should persist a final video project id");
  assert.ok(finalSnapshot?.sourceProjectId, "full-auto video run should keep the uploaded script project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "full-auto video run should persist the final video project");
  assert.equal(
    storedVideoProject?.sourceProjectId,
    finalSnapshot.sourceProjectId,
    "persisted video project should keep the uploaded script linkage",
  );
  assert.equal(
    storedVideoProject?.segmentVideos?.["EP01-01"]?.includes("segment-1.mp4") ?? false,
    true,
    "persisted video project should contain the generated segment video",
  );

  const renderedVideoState = await page.evaluate(([sessionKey]) => {
    const parse = (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    };

    const session = parse(sessionKey, null);
    const assistantVideoMessages = Array.isArray(session?.messages)
      ? session.messages.filter(
          (message) =>
            message?.role === "assistant" &&
            Array.isArray(message.attachments) &&
            message.attachments.some(
              (attachment) => attachment?.kind === "video" && !attachment?.pending && !attachment?.cancelled,
            ),
        ).length
      : 0;
    const assistantVideoLabels = Array.isArray(session?.messages)
      ? session.messages.flatMap((message) =>
          message?.role === "assistant" && Array.isArray(message.attachments)
            ? message.attachments
                .filter(
                  (attachment) =>
                    attachment?.kind === "video" && !attachment?.pending && !attachment?.cancelled,
                )
                .map((attachment) =>
                  String(attachment?.label || attachment?.fileName || "")
                    .replace(/\.[^.]+$/, "")
                    .trim(),
                )
                .filter(Boolean)
            : [],
        )
      : [];
    const assistantTexts = Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']"))
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    return {
      assistantVideoMessages,
      renderedAssistantVideoLabels: assistantVideoLabels.filter((label) =>
        assistantTexts.some((text) => text.includes(label)),
      ),
    };
  }, [STUDIO_SESSION_KEY]);
  assert.ok(
    renderedVideoState.assistantVideoMessages > 0,
    `full-auto video smoke should persist at least one assistant video message, got ${JSON.stringify(renderedVideoState)}`,
  );
  assert.ok(
    renderedVideoState.renderedAssistantVideoLabels.length > 0,
    `full-auto video smoke should render at least one assistant video card, got ${JSON.stringify(renderedVideoState)}`,
  );

  await setWorkflowTestScenario(page, null);
  return {
    handledQuestionKeys,
    workflowActions: actionKinds,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
  };
}

async function runRealFullAutoVideoWorkflowEndToEndScenario(page) {
  let scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="full-auto-message-checklist"]')),
    undefined,
    { timeout: 15000 },
  );

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;
  const customVideoStyle = "电影级写实都市夜景，低饱和胶片质感，人物压迫感更强。";

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      const debugSession = await readStoredStudioSession(page);
      throw new Error(
        `Real full-auto video question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}\n${JSON.stringify(
          {
            fullAutoStatus: debugSession?.fullAutoRun?.status ?? null,
            collectedStrategies: debugSession?.fullAutoRun?.plan?.stageStrategies ?? null,
          },
          null,
          2,
        )}`,
      );
    }

    const shouldFallbackAdaptationEpisodeCount =
      answerKey === "full-auto-preflight:adaptationEpisodeCount";

    if (shouldFallbackAdaptationEpisodeCount) {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickVisibleComposerQuestionButton(page, ["60 秒"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickVisibleComposerQuestionButton(page, ["中节奏"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video style button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["不自动加字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto video question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto video run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto video run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto video run should persist a final video project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto video run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto video run should produce at least one segment video");

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runRealFullAutoVideoWorkflowReferenceAssetScenario(page) {
  const scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="full-auto-message-checklist"]')),
    undefined,
    { timeout: 15000 },
  );

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real full-auto video question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickVisibleComposerQuestionButton(page, ["60 秒"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickVisibleComposerQuestionButton(page, ["中节奏"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await sendFreeformText(page, "电影级冷蓝夜景，写实人物，镜头动势明确，适合短剧高张力预告。");
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["智能补齐全部参考资产"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["不自动加字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto video question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto video run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto video run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto video run should persist a final video project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto video run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto video run should produce at least one segment video");
  const manifestItems = Array.isArray(storedVideoProject?.assetManifest?.items)
    ? storedVideoProject.assetManifest.items.filter((item) => trimString(item?.url))
    : [];
  const referenceManifestItems = manifestItems.filter((item) =>
    [
      "character-reference",
      "costume-reference",
      "scene-reference",
      "time-variant",
    ].includes(item.kind),
  );
  const referenceSlots = [
    ...(storedVideoProject?.characters ?? []).flatMap((character) => [
      {
        kind: "character",
        label: character.name,
        url: trimString(character.imageUrl),
        historyCount: Array.isArray(character.imageHistory) ? character.imageHistory.length : 0,
      },
      ...((character.costumes ?? []).map((costume) => ({
        kind: "character-variant",
        label: `${character.name} · ${costume.label}`,
        url: trimString(costume.imageUrl),
        historyCount: Array.isArray(costume.imageHistory) ? costume.imageHistory.length : 0,
      }))),
    ]),
    ...(storedVideoProject?.sceneSettings ?? []).flatMap((sceneSetting) => [
      {
        kind: "scene",
        label: sceneSetting.name,
        url: trimString(sceneSetting.imageUrl),
        historyCount: Array.isArray(sceneSetting.imageHistory) ? sceneSetting.imageHistory.length : 0,
      },
      ...((sceneSetting.timeVariants ?? []).map((variant) => ({
        kind: "scene-variant",
        label: `${sceneSetting.name} · ${variant.label}`,
        url: trimString(variant.imageUrl),
        historyCount: Array.isArray(variant.imageHistory) ? variant.imageHistory.length : 0,
      }))),
    ]),
  ];
  const missingReferenceSlots = referenceSlots.filter((slot) => !slot.url);
  const regeneratedReferenceSlots = referenceSlots.filter((slot) => slot.historyCount > 0);
  if (referenceAssetMode !== "skip") {
    assert.equal(
      missingReferenceSlots.length,
      0,
      `real full-auto video run should auto-fill every reference asset slot, missing=${JSON.stringify(missingReferenceSlots)}`,
    );
    assert.equal(
      regeneratedReferenceSlots.length,
      0,
      `real full-auto video run should not regenerate already-filled reference assets in a later batch, regenerated=${JSON.stringify(regeneratedReferenceSlots)}`,
    );
    assert.equal(
      referenceManifestItems.length,
      referenceSlots.length,
      `real full-auto video run should archive every reference asset exactly once, manifest=${referenceManifestItems.length}, slots=${referenceSlots.length}`,
    );
  }

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
    referenceAssets: {
      mode: referenceAssetMode,
      manifestCount: referenceManifestItems.length,
      slotCount: referenceSlots.length,
    },
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runRealFullAutoVideoBridgePrefsVisualizedScenario(page) {
  let scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="full-auto-message-checklist"]')),
    undefined,
    { timeout: 15000 },
  );

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + Math.min(REAL_FULL_AUTO_TIMEOUT_MS, 300_000);

  while (Date.now() < deadline) {
    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      if (executionStarted) break;
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real bridge-pref scenario question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickVisibleComposerQuestionButton(page, ["60 秒"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickVisibleComposerQuestionButton(page, ["中节奏"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["先跳过，最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await sendFreeformText(page, "电影级冷蓝夜景，写实人物，镜头运动明确，适合短剧高张力预告。");
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["不自动加字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
      await page.waitForTimeout(300);
      break;
    } else {
      throw new Error(`Unexpected real bridge-pref question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(220);
  }

  assert.equal(executionStarted, true, "bridge-pref scenario should reach the execution phase");

  const initialVideoProjectId = await waitForCurrentVideoProjectId(page, 120000);
  assert.ok(initialVideoProjectId, "bridge-pref scenario should create a video project before the bridge-pref step");

  const bridgeFieldsBefore = await readStoredVideoProject(page, initialVideoProjectId);

  await page.waitForFunction(
    ([projectsKey, projectId]) => {
      const raw = window.localStorage.getItem(projectsKey);
      if (!raw) return false;
      try {
        const projects = JSON.parse(raw);
        if (!Array.isArray(projects)) return false;
        const project = projects.find((item) => item?.id === projectId);
        return Boolean(
          project &&
            typeof project.targetPlatform === "string" &&
            project.targetPlatform.trim() &&
            typeof project.shotStyle === "string" &&
            project.shotStyle.trim() &&
            typeof project.outputGoal === "string" &&
            project.outputGoal.trim(),
        );
      } catch {
        return false;
      }
    },
    [VIDEO_PROJECTS_KEY, initialVideoProjectId],
    { timeout: 180000 },
  );

  await page.waitForFunction(
    () => {
      const assistantMessages = Array.from(document.querySelectorAll("[data-role='assistant']"))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const checklist = Array.from(document.querySelectorAll('[data-testid^="full-auto-checklist-item-"]'))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      return (
        assistantMessages.some(
          (text) => text.includes("平台与镜头偏好已写入") || text.includes("前置参数已写入"),
        ) &&
        checklist.some((text) => text.includes("进入视频工作流")) &&
        checklist.some((text) => text.includes("补平台与镜头偏好")) &&
        checklist.some((text) => text.includes("执行剧本拆解"))
      );
    },
    undefined,
    { timeout: 180000 },
  );

  const storedVideoProject = await readStoredVideoProject(page, initialVideoProjectId);
  const assistantMessages = await readVisibleAssistantMessages(page, 16);
  const checklist = await readVisibleFullAutoChecklist(page);

  const checklistTexts = checklist.map((item) => item.text);
  const videoPrepareIndex = checklistTexts.findIndex((text) => text.includes("进入视频工作流"));
  const bridgePrefsIndex = checklistTexts.findIndex((text) => text.includes("补平台与镜头偏好"));
  const videoAnalyzeIndex = checklistTexts.findIndex((text) => text.includes("执行剧本拆解"));

  assert.ok(trimString(storedVideoProject?.targetPlatform), "bridge-pref scenario should persist targetPlatform");
  assert.ok(trimString(storedVideoProject?.shotStyle), "bridge-pref scenario should persist shotStyle");
  assert.ok(trimString(storedVideoProject?.outputGoal), "bridge-pref scenario should persist outputGoal");
  assert.ok(
    assistantMessages.some((text) => text.includes("平台与镜头偏好已写入") || text.includes("前置参数已写入")),
    `assistant messages should visualize the bridge-pref completion: ${JSON.stringify(assistantMessages, null, 2)}`,
  );
  assert.ok(videoPrepareIndex >= 0, `checklist should include 进入视频工作流: ${JSON.stringify(checklist, null, 2)}`);
  assert.ok(bridgePrefsIndex >= 0, `checklist should include 补平台与镜头偏好: ${JSON.stringify(checklist, null, 2)}`);
  assert.ok(videoAnalyzeIndex >= 0, `checklist should include 执行剧本拆解: ${JSON.stringify(checklist, null, 2)}`);
  assert.ok(
    videoPrepareIndex < bridgePrefsIndex && bridgePrefsIndex < videoAnalyzeIndex,
    `bridge-pref checklist order should align with workflow execution: ${JSON.stringify(checklist, null, 2)}`,
  );

  return {
    handledQuestionKeys,
    videoProjectId: initialVideoProjectId,
    bridgeFieldsBefore: {
      targetPlatform: trimString(bridgeFieldsBefore?.targetPlatform),
      shotStyle: trimString(bridgeFieldsBefore?.shotStyle),
      outputGoal: trimString(bridgeFieldsBefore?.outputGoal),
    },
    bridgeFieldsAfter: {
      targetPlatform: trimString(storedVideoProject?.targetPlatform),
      shotStyle: trimString(storedVideoProject?.shotStyle),
      outputGoal: trimString(storedVideoProject?.outputGoal),
    },
    assistantMessageTail: assistantMessages.slice(-6),
    checklistTail: checklist.slice(Math.max(0, bridgePrefsIndex - 2), bridgePrefsIndex + 3),
  };
}

async function runRealFullAutoAdaptationEndToEndScenario(page) {
  let referenceFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(referenceFilePath), `Missing real workflow input file: ${referenceFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [DRAMA_PROJECTS_KEY]: [],
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["参考改编"], 10000);
  await clickVisibleButtonByLabels(page, ["参考改编"]);
  await waitForVisibleButtonLabels(page, ["上传参考文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传参考文档"]);
  await page.getByText(/上传参考剧本文档|上传参考文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, referenceFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="发送消息"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30000 });
  await sendButton.click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="full-auto-message-checklist"]')),
    undefined,
    { timeout: 15000 },
  );

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real full-auto adaptation question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "script-reference-v2") {
      await clickVisibleComposerQuestionButton(page, ["分析参考剧本"]);
    } else if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      await sendFreeformText(page, "1");
    } else if (answerKey === "full-auto-preflight:adaptationTargetMarket") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable target-market button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (
      [
        "full-auto-preflight:adaptationGenres",
        "full-auto-preflight:outlineGeneration",
        "full-auto-preflight:episodeDuration",
        "full-auto-preflight:episodeWriting",
      ].includes(answerKey)
    ) {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable preflight button for ${answerKey}: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:episodeReview") {
      await clickVisibleComposerQuestionButton(page, ["批量正文质检"]);
    } else if (answerKey === "full-auto-preflight:complianceReview") {
      await clickVisibleComposerQuestionButton(page, ["文本合规审查"]);
    } else if (answerKey === "full-auto-preflight:complianceReviewStrictness") {
      await clickVisibleComposerQuestionButton(page, ["标准"]);
    } else if (answerKey === "full-auto-preflight:complianceReviewDialogue") {
      await clickVisibleComposerQuestionButton(page, ["关闭对话审查"]);
    } else if (answerKey === "full-auto-preflight:scriptExportRoute") {
      await clickVisibleComposerQuestionButton(page, ["直接桥接视频工作流"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickVisibleComposerQuestionButton(page, ["60 秒"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickVisibleComposerQuestionButton(page, ["中节奏"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickVisibleComposerQuestionButton(page, ["导出分镜 xlsx"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickVisibleComposerQuestionButton(page, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await sendFreeformText(page, "电影级冷蓝夜景，写实人物，镜头动势明确，适合短剧高张力预告。");
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickVisibleComposerQuestionButton(page, ["智能补齐全部参考资产"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["全部片段提示词"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickVisibleComposerQuestionButton(page, ["AI 自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickVisibleComposerQuestionButton(page, ["不自动加字幕"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickVisibleComposerQuestionButton(page, ["选择导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto adaptation question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto adaptation run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto adaptation run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto adaptation run should persist a final video project id");
  assert.ok(finalSnapshot?.sourceProjectId, "real full-auto adaptation run should keep a bridged script project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto adaptation run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto adaptation run should produce at least one segment video");
  const manifestItems = Array.isArray(storedVideoProject?.assetManifest?.items)
    ? storedVideoProject.assetManifest.items.filter((item) => trimString(item?.url))
    : [];
  const imageAssetItems = manifestItems.filter((item) =>
    [
      "character-reference",
      "costume-reference",
      "scene-reference",
      "time-variant",
      "storyboard-frame",
    ].includes(item.kind),
  );
  const videoAssetItems = manifestItems.filter((item) => item.kind === "video-segment");
  assert.ok(
    imageAssetItems.length > 0,
    "real full-auto adaptation run should auto-archive generated image assets into assetManifest",
  );
  assert.ok(
    videoAssetItems.length > 0,
    "real full-auto adaptation run should auto-archive generated videos into assetManifest",
  );

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    referenceFilePath,
    assetManifest: {
      total: manifestItems.length,
      imageCount: imageAssetItems.length,
      videoCount: videoAssetItems.length,
    },
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runFullAutoQuickTaskLaunchFreshHomeScenario(page) {
  const sourceProjectId = "drama-project-video-entry";
  const sourceSession = createVideoEntrySession(sourceProjectId);
  const sourceMessageCount = sourceSession.messages.length;
  const sourceSummary = sourceSession.recentMessageSummary;
  const cases = [
    {
      templateLabel: "参考改编",
      expectedButtons: ["上传参考文档", "直接开始对话"],
      expectedQuestionTitle: "参考改编入口",
    },
    {
      templateLabel: "视频工作流",
      expectedButtons: ["上传剧本文档"],
      expectedQuestionTitle: "视频工作流入口",
    },
  ];
  const results = [];

  for (const testCase of cases) {
    await resetAndSeed(page, {
      [DRAMA_PROJECTS_KEY]: [createVideoEntryDramaProject(sourceProjectId)],
      [STUDIO_PROJECT_SESSIONS_KEY]: {
        [sourceProjectId]: sourceSession,
      },
      [STUDIO_SESSION_KEY]: sourceSession,
      [VIDEO_PROJECTS_KEY]: [],
    });

    await switchAutomationMode(page, "full-auto");
    await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee", "\u5f00\u59cb\u65b0\u9879\u76ee"]);
    await waitForVisibleButtonLabels(page, [testCase.templateLabel], 10000);
    await clickVisibleButtonByLabels(page, [testCase.templateLabel]);
    await waitForVisibleButtonLabels(page, testCase.expectedButtons, 15000);
    await page.waitForFunction(() => {
      const modal = Array.from(document.querySelectorAll('[data-composer-choice-modal="true"]')).find((candidate) => {
        if (!(candidate instanceof HTMLElement)) return false;
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      });
      return modal instanceof HTMLElement;
    }, undefined, { timeout: 15000 });
    await page.waitForFunction(
      ([sessionKey]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          return session && !session?.currentProjectSnapshot?.projectId && !session?.projectId;
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY],
      { timeout: 5000 },
    );
    const kickoffQuestion = await readVisibleComposerQuestion(page);
    const kickoffSession = await readStoredStudioSession(page);
    const projectSessions = await readStoredProjectSessions(page);
    const preservedProjectSession = projectSessions?.[sourceProjectId] ?? null;

    assert.ok(
      kickoffQuestion?.questionId || kickoffQuestion?.answerKey,
      `${testCase.templateLabel} should open a visible kickoff question`,
    );
    assert.ok(
      testCase.expectedButtons.every((label) =>
        kickoffQuestion?.visibleButtons?.some((visibleLabel) => visibleLabel.includes(label)),
      ),
      `${testCase.templateLabel} should expose the expected kickoff buttons`,
    );
    assert.equal(
      kickoffSession?.currentProjectSnapshot?.projectId ?? null,
      null,
      `${testCase.templateLabel} should start from a fresh homepage session instead of reusing the selected session`,
    );
    assert.equal(
      kickoffSession?.projectId ?? null,
      null,
      `${testCase.templateLabel} should not immediately bind the active homepage session to the previously selected project`,
    );
    assert.ok(
      kickoffSession?.qState ||
        kickoffSession?.pendingChoiceQuestion ||
        (Array.isArray(kickoffSession?.messages) && kickoffSession.messages.length >= 1),
      `${testCase.templateLabel} should create a fresh kickoff state on the homepage surface`,
    );
    assert.equal(
      preservedProjectSession?.currentProjectSnapshot?.projectId ?? null,
      sourceProjectId,
      `${testCase.templateLabel} should preserve the previously selected project session`,
    );
    assert.equal(
      preservedProjectSession?.messages?.length ?? 0,
      sourceMessageCount,
      `${testCase.templateLabel} should not append kickoff messages into the previously selected project session`,
    );
    assert.equal(
      preservedProjectSession?.recentMessageSummary ?? null,
      sourceSummary,
      `${testCase.templateLabel} should keep the previous session summary untouched`,
    );

    results.push({
      templateLabel: testCase.templateLabel,
      kickoffAnswerKey: kickoffQuestion?.answerKey ?? null,
      kickoffMessageCount: kickoffSession?.messages?.length ?? 0,
    });
  }

  return {
    cases: results,
  };
}

async function runManualQuickTaskSurfaceIsolationScenario(page) {
  const sourceProjectId = "drama-project-video-entry";
  const sourceSession = createVideoEntrySession(sourceProjectId);

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createVideoEntryDramaProject(sourceProjectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [sourceProjectId]: sourceSession,
    },
    [STUDIO_SESSION_KEY]: sourceSession,
    [VIDEO_PROJECTS_KEY]: [],
  });
  await switchAutomationMode(page, "manual");

  const visibleButtonsInActiveManualSession = await listVisibleButtons(page);
  const visibleButtonSummary = visibleButtonsInActiveManualSession
    .map((button) => button.ariaLabel || button.text)
    .join(" | ");
  const manualAdaptationQuickTaskVisible = await page
    .getByRole("button", { name: "\u53c2\u8003\u6539\u7f16", exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  const manualVideoWorkflowQuickTaskVisible = await page
    .getByRole("button", { name: "\u89c6\u9891\u5de5\u4f5c\u6d41", exact: true })
    .first()
    .isVisible()
    .catch(() => false);
  assert.equal(
    manualAdaptationQuickTaskVisible,
    false,
    `manual active session should not show the adaptation quick task; visible buttons: ${visibleButtonSummary}`,
  );
  assert.equal(
    manualVideoWorkflowQuickTaskVisible,
    false,
    `manual active session should not show the video-workflow quick task; visible buttons: ${visibleButtonSummary}`,
  );

  await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee"]);
  await waitForVisibleButtonLabels(page, ["\u53c2\u8003\u6539\u7f16", "\u89c6\u9891\u5de5\u4f5c\u6d41"], 10000);

  await clickVisibleButtonByLabels(page, ["\u53c2\u8003\u6539\u7f16"]);
  await waitForVisibleButtonLabels(page, ["\u4e0a\u4f20\u53c2\u8003\u6587\u6863", "\u76f4\u63a5\u5f00\u59cb\u5bf9\u8bdd"], 15000);
  const adaptationQuestion = await readVisibleComposerQuestion(page);
  const adaptationSession = await readStoredStudioSession(page);

  assert.ok(
    adaptationQuestion?.visibleButtons?.some((label) => label.includes("\u4e0a\u4f20\u53c2\u8003\u6587\u6863")),
    "manual fresh home should still open the adaptation kickoff",
  );
  assert.equal(
    adaptationSession?.currentProjectSnapshot?.projectId ?? null,
    null,
    "manual fresh-home adaptation kickoff should stay on a projectless homepage session",
  );

  return {
    activeManualQuickTasksVisible: false,
    freshHomeAdaptationAnswerKey: adaptationQuestion?.answerKey ?? null,
  };
}

async function runManualHistoryRestoreAfterNewProjectScenario(page) {
  const manualProjectId = "manual-switch-project-1";
  const manualTitle = "Manual Switch Project";
  const manualSeedText = "manual seed history should disappear after switching to full-auto";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createAutomationSwitchDramaProject(manualProjectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [manualProjectId]: createAutomationSwitchSession(manualProjectId),
    },
    [STUDIO_SESSION_KEY]: createAutomationSwitchSession(manualProjectId),
  });
  await switchAutomationMode(page, "manual");
  await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });

  await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee"]);
  await waitForVisibleButtonLabels(page, ["\u53c2\u8003\u6539\u7f16"], 10000);
  await page.waitForFunction(
    (text) =>
      !Array.from(document.querySelectorAll("[data-home-agent-message-role='assistant']")).some((element) =>
        (element.textContent || "").includes(text),
      ),
    manualSeedText,
    { timeout: 10000 },
  );
  const idleSession = await readStoredStudioSession(page);
  const idleButtons = await listVisibleButtons(page);
  assert.equal(
    idleSession?.fullAutoRun ?? null,
    null,
    "manual new-project surface should not keep a stale full-auto run",
  );
  assert.equal(
    idleButtons.some((button) => (button.ariaLabel || button.text || "").includes("\u6536\u8d77\u5f85\u53d1\u6d88\u606f\u6e05\u5355")),
    false,
    "manual new-project surface should not keep the full-auto checklist chrome",
  );

  await openHistoryProject(page, manualTitle);
  await page.getByText(manualSeedText).first().waitFor({ state: "visible", timeout: 10000 });
  await waitForVisibleButtonLabels(page, ["\u65b0\u5efa\u9879\u76ee"], 10000);
  await page.waitForFunction(
    ([sessionKey, projectId]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.currentProjectSnapshot?.projectId === projectId;
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, manualProjectId],
    { timeout: 5000 },
  );

  const storedSession = await readStoredStudioSession(page);
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId ?? null,
    manualProjectId,
    "manual history item should restore its project after returning to the new-project surface",
  );
  assert.equal(
    storedSession?.automationMode ?? null,
    "manual",
    "manual history restore should keep the session in manual mode",
  );

  return {
    restoredProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
    restoredAutomationMode: storedSession?.automationMode ?? null,
  };
}

async function runFullAutoHistoryRestoreAfterNewProjectScenario(page) {
  const fullAutoProjectId = "full-auto-switch-project-1";
  const fullAutoTitle = "Full Auto Switch Project";
  const fullAutoSeedText = "full auto seed history should stay isolated from manual mode";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createFullAutoSwitchDramaProject(fullAutoProjectId)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [fullAutoProjectId]: createFullAutoSwitchSession(fullAutoProjectId),
    },
    [STUDIO_SESSION_KEY]: createFullAutoSwitchSession(fullAutoProjectId),
  });
  await switchAutomationMode(page, "full-auto");
  await openHistoryProject(page, fullAutoTitle);
  await page.getByText(fullAutoSeedText).first().waitFor({ state: "visible", timeout: 10000 });

  await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee"]);
  await waitForVisibleButtonLabels(page, ["\u53c2\u8003\u6539\u7f16", "\u89c6\u9891\u5de5\u4f5c\u6d41"], 10000);
  await page.waitForFunction(
    (text) =>
      !Array.from(document.querySelectorAll("[data-role='assistant']")).some((element) =>
        (element.textContent || "").includes(text),
      ),
    fullAutoSeedText,
    { timeout: 10000 },
  );
  const idleSession = await readStoredStudioSession(page);
  const idleButtons = await listVisibleButtons(page);
  assert.equal(
    idleSession?.fullAutoRun ?? null,
    null,
    "full-auto new-project surface should clear the previous full-auto run",
  );
  assert.equal(
    idleButtons.some((button) => (button.ariaLabel || button.text || "").includes("\u6536\u8d77\u5f85\u53d1\u6d88\u606f\u6e05\u5355")),
    false,
    "full-auto new-project surface should not keep the full-auto checklist chrome",
  );

  await openHistoryProject(page, fullAutoTitle);
  await page.getByText(fullAutoSeedText).first().waitFor({ state: "visible", timeout: 10000 });
  await waitForVisibleButtonLabels(page, ["\u65b0\u5efa\u9879\u76ee"], 10000);
  await page.waitForFunction(
    ([sessionKey, projectId]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        return parsed?.currentProjectSnapshot?.projectId === projectId;
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, fullAutoProjectId],
    { timeout: 5000 },
  );

  const storedSession = await readStoredStudioSession(page);
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId ?? null,
    fullAutoProjectId,
    "full-auto history item should restore its project after returning to the new-project surface",
  );
  assert.equal(
    storedSession?.automationMode ?? null,
    "full-auto",
    "full-auto history restore should keep the session in full-auto mode",
  );

  return {
    restoredProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
    restoredAutomationMode: storedSession?.automationMode ?? null,
  };
}

async function runCurrentStorageHistoryReopenParityScenario(page) {
  const results = [];
  await resetAndSeedFromSavedDesktopStudioState(page);

  for (const mode of ["manual", "full-auto"]) {
    await switchAutomationMode(page, mode);
    const visibleEntries = await listVisibleHistoryEntries(page);
    const sourceEntry = await findFirstVisibleHistoryEntryForMode(page, mode);
    if (!sourceEntry?.projectId) {
      results.push({
        mode,
        skipped: true,
        reason: "no visible history entry for mode",
        visibleEntries: visibleEntries.slice(0, 12),
      });
      continue;
    }

    await clickHistoryById(page, sourceEntry.projectId);
    await waitForStoredSessionProjectId(page, sourceEntry.projectId, 10000);

    const selectedSession = await readStoredStudioSession(page);
    const selectedButtons = await listVisibleButtons(page);

    await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee", "\u5f00\u59cb\u65b0\u9879\u76ee"]);
    const idleSession = await readStoredStudioSession(page);
    const idleButtons = await listVisibleButtons(page);

    await clickHistoryById(page, sourceEntry.projectId);
    await waitForStoredSessionProjectId(page, sourceEntry.projectId, 10000);

    const restoredSession = await readStoredStudioSession(page);
    const restoredButtons = await listVisibleButtons(page);

    results.push({
      mode,
      sourceEntry,
      selectedProjectId: selectedSession?.currentProjectSnapshot?.projectId ?? null,
      selectedButtons: selectedButtons.slice(0, 24).map((button) => button.ariaLabel || button.text),
      idleProjectId: idleSession?.currentProjectSnapshot?.projectId ?? null,
      idleButtons: idleButtons.slice(0, 24).map((button) => button.ariaLabel || button.text),
      restoredProjectId: restoredSession?.currentProjectSnapshot?.projectId ?? null,
      restoredAutomationMode: restoredSession?.automationMode ?? null,
      restoredButtons: restoredButtons.slice(0, 24).map((button) => button.ariaLabel || button.text),
    });
  }

  return { results };
}

async function runCurrentStorageRepeatedModeSwitchIsolationScenario(page) {
  const cycles = 3;
  const cycleMetrics = [];
  await resetAndSeedFromSavedDesktopStudioState(page);

  await switchAutomationMode(page, "manual");
  const manualEntry = await findFirstVisibleHistoryEntryForMode(page, "manual");
  assert.ok(manualEntry?.projectId, "current desktop history should expose at least one manual session card");

  await clickHistoryById(page, manualEntry.projectId);
  await waitForStoredSessionProjectId(page, manualEntry.projectId, 10000);

  const selectedManualSession = await readStoredStudioSession(page);
  const manualNeedle = pickSessionTextNeedle(selectedManualSession);
  const hadManualNeedleOnScreen = manualNeedle
    ? await page.evaluate((needle) => (document.body.innerText || "").includes(needle), manualNeedle)
    : false;

  for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex += 1) {
    const toFullAutoStartedAt = Date.now();
    await switchAutomationMode(page, "full-auto");
    await page.waitForFunction(
      ([automationModeKey]) => window.localStorage.getItem(automationModeKey) === "full-auto",
      [AUTOMATION_MODE_KEY],
      { timeout: 10000 },
    );

    const storedFullAutoEntry = await findFirstVisibleHistoryEntryForMode(page, "full-auto");
    const fullAutoHistoryBeforeKickoff = await listVisibleHistoryEntries(page);
    assert.equal(
      fullAutoHistoryBeforeKickoff.some((entry) => entry.projectId === manualEntry.projectId),
      false,
      `cycle ${cycleIndex + 1}: manual history card should stay hidden in full-auto mode`,
    );

    await clickVisibleButtonByLabels(page, ["新建项目", "开始新项目"]);
    await waitForVisibleButtonLabels(page, ["原创剧本", "参考改编", "视频工作流"], 10000);
    await clickVisibleButtonByLabels(page, ["原创剧本"]);
    await waitForVisibleButtonLabels(page, ["选题创作", "创意创作"], 15000);
    await page.waitForFunction(
      ([sessionKey, automationModeKey]) => {
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          return (
            session?.automationMode === "full-auto" &&
            !session?.currentProjectSnapshot?.projectId &&
            window.localStorage.getItem(automationModeKey) === "full-auto"
          );
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, AUTOMATION_MODE_KEY],
      { timeout: 10000 },
    );

    const kickoffSession = await readStoredStudioSession(page);
    const fullAutoHistoryAfterKickoff = await listVisibleHistoryEntries(page);
    const fullAutoSwitchDurationMs = Date.now() - toFullAutoStartedAt;

    assert.equal(
      kickoffSession?.automationMode,
      "full-auto",
      `cycle ${cycleIndex + 1}: kickoff session should persist full-auto mode`,
    );
    assert.equal(
      kickoffSession?.currentProjectSnapshot?.projectId ?? null,
      null,
      `cycle ${cycleIndex + 1}: kickoff session should not keep the previously selected manual project`,
    );
    assert.equal(
      await readStoredAutomationModeValue(page),
      "full-auto",
      `cycle ${cycleIndex + 1}: raw automation-mode key should stay in full-auto after switching`,
    );
    assert.equal(
      fullAutoHistoryAfterKickoff.some((entry) => entry.projectId === manualEntry.projectId),
      false,
      `cycle ${cycleIndex + 1}: manual history card should remain hidden after full-auto kickoff`,
    );
    if (hadManualNeedleOnScreen && manualNeedle) {
      assert.equal(
        await page.evaluate((needle) => (document.body.innerText || "").includes(needle), manualNeedle),
        false,
        `cycle ${cycleIndex + 1}: manual conversation text should not linger after full-auto kickoff`,
      );
    }

    const toManualStartedAt = Date.now();
    await switchAutomationMode(page, "manual");
    await page.waitForFunction(
      ([automationModeKey]) => window.localStorage.getItem(automationModeKey) === "manual",
      [AUTOMATION_MODE_KEY],
      { timeout: 10000 },
    );

    const manualHistoryEntries = await listVisibleHistoryEntries(page);
    assert.equal(
      manualHistoryEntries.some((entry) => entry.projectId === manualEntry.projectId),
      true,
      `cycle ${cycleIndex + 1}: manual history card should be visible again after returning to manual mode`,
    );
    if (storedFullAutoEntry?.projectId) {
      assert.equal(
        manualHistoryEntries.some((entry) => entry.projectId === storedFullAutoEntry.projectId),
        false,
        `cycle ${cycleIndex + 1}: saved full-auto history card should stay hidden in manual mode`,
      );
    }

    await clickHistoryById(page, manualEntry.projectId);
    await waitForStoredSessionProjectId(page, manualEntry.projectId, 10000);

    const restoredManualSession = await readStoredStudioSession(page);
    const manualSwitchDurationMs = Date.now() - toManualStartedAt;

    assert.equal(
      restoredManualSession?.automationMode,
      "manual",
      `cycle ${cycleIndex + 1}: restoring the manual history card should restore manual mode`,
    );
    assert.equal(
      restoredManualSession?.currentProjectSnapshot?.projectId,
      manualEntry.projectId,
      `cycle ${cycleIndex + 1}: restoring the manual history card should restore the same manual project`,
    );
    assert.equal(
      await readStoredAutomationModeValue(page),
      "manual",
      `cycle ${cycleIndex + 1}: raw automation-mode key should return to manual`,
    );
    assert.equal(
      await page.getByText("选题创作").count(),
      0,
      `cycle ${cycleIndex + 1}: full-auto kickoff options should not linger after restoring manual history`,
    );
    if (hadManualNeedleOnScreen && manualNeedle) {
      assert.equal(
        await page.evaluate((needle) => (document.body.innerText || "").includes(needle), manualNeedle),
        true,
        `cycle ${cycleIndex + 1}: manual conversation text should be visible again after restoring the manual session`,
      );
    }

    cycleMetrics.push({
      cycle: cycleIndex + 1,
      fullAutoSwitchDurationMs,
      manualSwitchDurationMs,
      manualProjectId: manualEntry.projectId,
      savedFullAutoProjectId: storedFullAutoEntry?.projectId ?? null,
      kickoffMessageCount: Array.isArray(kickoffSession?.messages) ? kickoffSession.messages.length : 0,
    });
  }

  return {
    cycles,
    manualProjectId: manualEntry.projectId,
    manualNeedle,
    cycleMetrics,
  };
}

async function runCurrentStorageVideoShortcutAndHistoryCountScenario(page) {
  await resetAndSeedFromSavedDesktopStudioState(page);
  const modeResults = [];

  for (const mode of ["manual", "full-auto"]) {
    await switchAutomationMode(page, mode);
    await page.waitForTimeout(300);
    const visibleEntries = await listVisibleHistoryEntries(page);
    const countState = await readSidebarHistoryCountState(page);

    assert.ok(
      countState.totalCount !== null,
      `${mode} history stream should expose a total-count data attribute`,
    );
    assert.equal(
      Number(countState.badgeText),
      countState.totalCount,
      `${mode} history badge should match the filtered stream count`,
    );
    assert.ok(
      countState.totalCount >= visibleEntries.length,
      `${mode} history total should be at least the rendered card count`,
    );

    modeResults.push({
      mode,
      visibleEntryCount: visibleEntries.length,
      historyCountBadge: countState.badgeText,
      historyTotalCount: countState.totalCount,
      historyRenderedCount: countState.renderedCount,
      firstEntry: visibleEntries[0] ?? null,
    });
  }

  const reusableEntry =
    modeResults.find((result) => result.mode === "manual" && result.firstEntry?.projectId) ??
    modeResults.find((result) => result.firstEntry?.projectId) ??
    null;
  assert.ok(reusableEntry?.firstEntry?.projectId, "current desktop history should expose at least one session card");

  await switchAutomationMode(page, reusableEntry.mode);
  await clickHistoryById(page, reusableEntry.firstEntry.projectId);
  await waitForStoredSessionProjectId(page, reusableEntry.firstEntry.projectId, 10000);

  await switchAutomationMode(page, "full-auto");
  await clickVisibleButtonByLabels(page, ["\u65b0\u5efa\u9879\u76ee", "\u5f00\u59cb\u65b0\u9879\u76ee"]);
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);

  const kickoffQuestion = await readVisibleComposerQuestion(page);
  const visibleButtons = kickoffQuestion?.visibleButtons ?? [];

  assert.ok(
    visibleButtons.some((label) => label.includes("上传剧本文档")),
    `video shortcut should still offer upload-document on the current desktop seed: ${JSON.stringify(visibleButtons)}`,
  );
  assert.equal(
    visibleButtons.some((label) => label.includes("使用当前剧本项目")),
    false,
    `video shortcut should not expose the current-project bridge option after selecting a saved history session: ${JSON.stringify(visibleButtons)}`,
  );

  return {
    modeResults,
    selectedSourceEntry: reusableEntry,
    kickoffAnswerKey: kickoffQuestion?.answerKey ?? null,
    kickoffButtons: visibleButtons,
  };
}

async function readConversationArchiveManifestMap(archiveRootDir) {
  const normalizedRoot = trimString(archiveRootDir);
  if (!normalizedRoot || !(await pathExists(normalizedRoot))) {
    return new Map();
  }

  const dirEntries = await fs.readdir(normalizedRoot, { withFileTypes: true });
  const manifestMap = new Map();

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(normalizedRoot, entry.name, "history-manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      const projectId = trimString(manifest?.projectId);
      if (!projectId) continue;
      manifestMap.set(projectId, manifest);
    } catch {
      // Ignore malformed or partially-written archives during smoke runs.
    }
  }

  return manifestMap;
}

async function runCurrentStorageConversationArchiveParityScenario(page, context = {}) {
  await resetAndSeedFromSavedDesktopStudioState(page);
  await page.waitForTimeout(1200);

  const archiveRootDir = path.join(context.electronAppRootDir || "", "files", "conversations");
  const modeResults = [];

  for (const mode of ["manual", "full-auto"]) {
    await switchAutomationMode(page, mode);
    await page.waitForTimeout(400);

    const visibleEntries = await listVisibleHistoryEntries(page);
    const countState = await readSidebarHistoryCountState(page);
    const manifestMap = await readConversationArchiveManifestMap(archiveRootDir);

    const missingProjectIds = visibleEntries
      .map((entry) => entry.projectId)
      .filter((projectId) => projectId && !manifestMap.has(projectId));

    const archiveCountForMode = [...manifestMap.values()].filter((manifest) => {
      const manifestMode = trimString(manifest?.automationMode) === "full-auto" ? "full-auto" : "manual";
      return manifestMode === mode;
    }).length;

    assert.equal(
      missingProjectIds.length,
      0,
      `${mode} visible history entries should all have a conversation archive folder: ${JSON.stringify(missingProjectIds)}`,
    );
    assert.ok(
      archiveCountForMode >= (countState.totalCount ?? 0),
      `${mode} conversation archive count should cover the sidebar history total (${archiveCountForMode} < ${countState.totalCount})`,
    );

    modeResults.push({
      mode,
      visibleEntryCount: visibleEntries.length,
      historyTotalCount: countState.totalCount,
      archiveCountForMode,
      firstEntry: visibleEntries[0] ?? null,
    });
  }

  return {
    archiveRootDir,
    modeResults,
  };
}

async function runCurrentStorageStartupAndSettingsPerformanceScenario(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  const coldLaunchNavigation = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0];
    if (!entry) return null;
    return {
      responseEndMs: Math.round(entry.responseEnd || 0),
      domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd || 0),
      loadEventMs: Math.round(entry.loadEventEnd || 0),
    };
  });

  await resetAndSeedFromSavedDesktopStudioState(page);

  const reloadStartedAt = Date.now();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForVisibleButtonLabels(page, NEW_PROJECT_LABELS, 15000);
  const homeVisibleMs = Date.now() - reloadStartedAt;

  await page.waitForFunction(() => {
    const historyList = document.querySelector("[data-sidebar-history-list='true']");
    if (!(historyList instanceof HTMLElement)) return false;
    return historyList.getAttribute("data-sidebar-history-total-count") !== null;
  }, undefined, { timeout: 20000 });
  const historyReadyMs = Date.now() - reloadStartedAt;
  const initialHistoryCount = await readSidebarHistoryCountState(page);

  const settingsToggle = page.getByRole("button", { name: SETTINGS_TOGGLE_LABEL }).first();
  await settingsToggle.waitFor({ state: "visible", timeout: 10000 });

  const firstOpenStartedAt = Date.now();
  await settingsToggle.click();
  await page.getByRole("button", { name: MANUAL_MODE_LABEL }).last().waitFor({
    state: "visible",
    timeout: 15000,
  });
  const settingsFirstOpenMs = Date.now() - firstOpenStartedAt;

  const toFullAutoStartedAt = Date.now();
  await switchAutomationMode(page, "full-auto");
  const fullAutoModeSwitchMs = Date.now() - toFullAutoStartedAt;
  const fullAutoHistoryCount = await readSidebarHistoryCountState(page);

  const toManualStartedAt = Date.now();
  await switchAutomationMode(page, "manual");
  const manualModeSwitchMs = Date.now() - toManualStartedAt;
  const manualHistoryCount = await readSidebarHistoryCountState(page);

  const closeStartedAt = Date.now();
  await settingsToggle.click();
  await page.getByRole("button", { name: MANUAL_MODE_LABEL }).last().waitFor({
    state: "hidden",
    timeout: 10000,
  });
  await waitForVisibleButtonLabels(page, NEW_PROJECT_LABELS, 10000);
  const settingsCloseMs = Date.now() - closeStartedAt;

  const secondOpenStartedAt = Date.now();
  await settingsToggle.click();
  await page.getByRole("button", { name: MANUAL_MODE_LABEL }).last().waitFor({
    state: "visible",
    timeout: 10000,
  });
  const settingsSecondOpenMs = Date.now() - secondOpenStartedAt;

  assert.ok(
    (coldLaunchNavigation?.domContentLoadedMs ?? 0) > 0,
    "cold launch navigation timing should expose a domContentLoaded measurement",
  );
  assert.ok(
    (coldLaunchNavigation?.domContentLoadedMs ?? Number.POSITIVE_INFINITY) < 4000,
    `cold launch domContentLoaded should stay responsive, got ${coldLaunchNavigation?.domContentLoadedMs}ms`,
  );
  assert.ok(homeVisibleMs < 4500, `home surface should become visible quickly, took ${homeVisibleMs}ms`);
  assert.ok(historyReadyMs < 6500, `history panel should hydrate quickly, took ${historyReadyMs}ms`);
  assert.ok(settingsFirstOpenMs < 3000, `settings panel should open promptly, took ${settingsFirstOpenMs}ms`);
  assert.ok(settingsCloseMs < 1200, `settings panel should close promptly, took ${settingsCloseMs}ms`);
  assert.ok(settingsSecondOpenMs < 1200, `settings panel should reopen promptly, took ${settingsSecondOpenMs}ms`);
  assert.ok(
    settingsSecondOpenMs <= settingsFirstOpenMs + 150,
    `cached settings reopen should not regress beyond the first open (${settingsSecondOpenMs}ms vs ${settingsFirstOpenMs}ms)`,
  );
  assert.ok(fullAutoModeSwitchMs < 2000, `full-auto mode switch should stay responsive, took ${fullAutoModeSwitchMs}ms`);
  assert.ok(manualModeSwitchMs < 2000, `manual mode switch should stay responsive, took ${manualModeSwitchMs}ms`);
  assert.ok(initialHistoryCount.totalCount !== null, "initial history count should be readable after startup");
  assert.ok(fullAutoHistoryCount.totalCount !== null, "full-auto history count should update while settings stay open");
  assert.ok(manualHistoryCount.totalCount !== null, "manual history count should update after switching back");

  return {
    coldLaunchNavigation,
    homeVisibleMs,
    historyReadyMs,
    settingsFirstOpenMs,
    settingsCloseMs,
    settingsSecondOpenMs,
    fullAutoModeSwitchMs,
    manualModeSwitchMs,
    initialHistoryCount,
    fullAutoHistoryCount,
    manualHistoryCount,
  };
}

async function runCurrentStorageUiInteractionResponsivenessScenario(page) {
  await resetAndSeedFromSavedDesktopStudioState(page);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForVisibleButtonLabels(page, NEW_PROJECT_LABELS, 15000);
  await page.waitForFunction(() => {
    const historyList = document.querySelector("[data-sidebar-history-list='true']");
    if (!(historyList instanceof HTMLElement)) return false;
    return historyList.getAttribute("data-sidebar-history-total-count") !== null;
  }, undefined, { timeout: 20000 });

  const settingsToggle = page.getByRole("button", { name: SETTINGS_TOGGLE_LABEL }).first();
  await settingsToggle.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(120);
  const settingsPanel = page.locator("[data-home-settings-panel='desktop'], [data-home-settings-panel='mobile']").first();
  const settingsShellOpenDurationsMs = [];
  const settingsOpenDurationsMs = [];
  const settingsCloseDurationsMs = [];

  for (let index = 0; index < 3; index += 1) {
    const openStartedAt = Date.now();
    await settingsToggle.click();
    await settingsPanel.waitFor({
      state: "visible",
      timeout: 4000,
    });
    settingsShellOpenDurationsMs.push(Date.now() - openStartedAt);
    await page.getByRole("button", { name: MANUAL_MODE_LABEL }).last().waitFor({
      state: "visible",
      timeout: 10000,
    });
    settingsOpenDurationsMs.push(Date.now() - openStartedAt);

    const closeStartedAt = Date.now();
    await settingsToggle.click();
    await page.getByRole("button", { name: MANUAL_MODE_LABEL }).last().waitFor({
      state: "hidden",
      timeout: 10000,
    });
    await waitForVisibleButtonLabels(page, NEW_PROJECT_LABELS, 10000);
    settingsCloseDurationsMs.push(Date.now() - closeStartedAt);
  }

  const sidebarCollapseDurationsMs = [];
  const sidebarExpandDurationsMs = [];
  for (let index = 0; index < 3; index += 1) {
    const collapseButton = page.getByRole("button", { name: "收起侧栏" }).first();
    await collapseButton.waitFor({ state: "visible", timeout: 10000 });
    const collapseStartedAt = Date.now();
    await collapseButton.click();
    await page.getByRole("button", { name: "展开侧栏" }).first().waitFor({
      state: "visible",
      timeout: 8000,
    });
    sidebarCollapseDurationsMs.push(Date.now() - collapseStartedAt);

    const expandButton = page.getByRole("button", { name: "展开侧栏" }).first();
    const expandStartedAt = Date.now();
    await expandButton.click();
    await page.getByRole("button", { name: "收起侧栏" }).first().waitFor({
      state: "visible",
      timeout: 8000,
    });
    sidebarExpandDurationsMs.push(Date.now() - expandStartedAt);
  }

  const visibleEntries = await readVisibleHistoryEntries(page, 4);
  assert.ok(visibleEntries.length >= 2, "current storage should expose at least two visible history entries");
  const [firstEntry, secondEntry] = visibleEntries;
  assert.ok(firstEntry?.projectId && secondEntry?.projectId, "history entries should include project ids");

  const historySwitchDurationsMs = [];
  for (let index = 0; index < 2; index += 1) {
    const secondStartedAt = Date.now();
    await clickHistoryById(page, secondEntry.projectId);
    await waitForStoredSessionProjectId(page, secondEntry.projectId, 15000);
    historySwitchDurationsMs.push(Date.now() - secondStartedAt);

    const firstStartedAt = Date.now();
    await clickHistoryById(page, firstEntry.projectId);
    await waitForStoredSessionProjectId(page, firstEntry.projectId, 15000);
    historySwitchDurationsMs.push(Date.now() - firstStartedAt);
  }

  const maxSettingsOpenMs = Math.max(...settingsOpenDurationsMs);
  const maxSettingsShellOpenMs = Math.max(...settingsShellOpenDurationsMs);
  const maxSettingsCloseMs = Math.max(...settingsCloseDurationsMs);
  const maxSidebarCollapseMs = Math.max(...sidebarCollapseDurationsMs);
  const maxSidebarExpandMs = Math.max(...sidebarExpandDurationsMs);
  const maxHistorySwitchMs = Math.max(...historySwitchDurationsMs);

  assert.ok(maxSettingsShellOpenMs < 1200, `settings panel shell should open promptly, took ${maxSettingsShellOpenMs}ms`);
  assert.ok(maxSettingsOpenMs < 1500, `settings repeated open should stay responsive, took ${maxSettingsOpenMs}ms`);
  assert.ok(maxSettingsCloseMs < 1200, `settings repeated close should stay responsive, took ${maxSettingsCloseMs}ms`);
  assert.ok(maxSidebarCollapseMs < 1200, `sidebar collapse should stay responsive, took ${maxSidebarCollapseMs}ms`);
  assert.ok(maxSidebarExpandMs < 1200, `sidebar expand should stay responsive, took ${maxSidebarExpandMs}ms`);
  assert.ok(maxHistorySwitchMs < 2500, `history card switching should stay responsive, took ${maxHistorySwitchMs}ms`);

  return {
    settingsShellOpenDurationsMs,
    settingsOpenDurationsMs,
    settingsCloseDurationsMs,
    sidebarCollapseDurationsMs,
    sidebarExpandDurationsMs,
    historySwitchDurationsMs,
    visibleHistoryEntries: visibleEntries.slice(0, 2),
  };
}

async function runCurrentStorageComposerInputStabilityScenario(page) {
  await resetAndSeedFromSavedDesktopStudioState(page);
  const modeResults = [];

  for (const mode of ["manual", "full-auto"]) {
    await switchAutomationMode(page, mode);
    const sourceEntry = await findFirstVisibleHistoryEntryForMode(page, mode);
    if (!sourceEntry?.projectId) {
      modeResults.push({
        mode,
        skipped: true,
        reason: "no visible history entry for mode",
      });
      continue;
    }

    await clickHistoryById(page, sourceEntry.projectId);
    await waitForStoredSessionProjectId(page, sourceEntry.projectId, 10000);

    const textarea = page.locator("textarea").last();
    await textarea.waitFor({ state: "visible", timeout: 15000 });

    const firstText = `${mode} input smoke first ${Date.now()}`;
    const secondText = `${mode} input smoke second ${Date.now() + 1}`;
    const editTail = " tail";
    const initialVisibleUserMessages = await readVisibleUserMessages(page, 16);

    await textarea.click();
    await textarea.press("Control+A").catch(() => {});
    await textarea.press("Backspace").catch(() => {});
    await textarea.type(firstText + editTail, { delay: 18 });
    for (let index = 0; index < editTail.length; index += 1) {
      await textarea.press("Backspace");
    }

    const afterEditValue = await readComposerValue(page);
    assert.equal(
      afterEditValue,
      firstText,
      `${mode} composer should keep the edited text after repeated Backspace trimming`,
    );

    const firstVisibleCountBefore = await countVisibleUserMessagesMatching(page, firstText);
    const firstStoredCountBefore = await countStoredUserMessagesMatching(page, firstText);
    await submitComposerTextWithoutEcho(page, firstText);

    await page.waitForFunction(
      ([expectedText, previousDomCount]) => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
        const currentCount = Array.from(document.querySelectorAll("[data-home-agent-message-role='user']"))
          .map((element) => normalize(element.textContent || ""))
          .filter((value) => value === expectedText)
          .length;
        return currentCount === previousDomCount + 1;
      },
      [firstText, firstVisibleCountBefore],
      { timeout: 20000 },
    );
    await page.waitForFunction(
      ([sessionKey, expectedText, previousStoredCount]) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          if (!Array.isArray(session?.messages)) return false;
          const currentCount = session.messages.filter((message) =>
            message?.role === "user" && normalize(message?.content) === expectedText
          ).length;
          return currentCount === previousStoredCount + 1;
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, firstText, firstStoredCountBefore],
      { timeout: 20000 },
    );
    await page.waitForFunction(() => {
      const textareas = document.querySelectorAll("textarea");
      const target = textareas.item(textareas.length - 1);
      return target instanceof HTMLTextAreaElement && target.value === "";
    }, undefined, { timeout: 10000 });

    const afterFirstSendValue = await readComposerValue(page);
    assert.equal(afterFirstSendValue, "", `${mode} composer should clear after the first send`);

    await textarea.click();
    await textarea.type(secondText + editTail, { delay: 18 });
    for (let index = 0; index < editTail.length; index += 1) {
      await textarea.press("Backspace");
    }

    const secondEditValue = await readComposerValue(page);
    assert.equal(
      secondEditValue,
      secondText,
      `${mode} composer should keep the second edited text after Backspace trimming`,
    );

    const secondVisibleCountBefore = await countVisibleUserMessagesMatching(page, secondText);
    const secondStoredCountBefore = await countStoredUserMessagesMatching(page, secondText);
    await submitComposerTextWithoutEcho(page, secondText);

    await page.waitForFunction(
      ([expectedText, previousDomCount]) => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
        const currentCount = Array.from(document.querySelectorAll("[data-home-agent-message-role='user']"))
          .map((element) => normalize(element.textContent || ""))
          .filter((value) => value === expectedText)
          .length;
        return currentCount === previousDomCount + 1;
      },
      [secondText, secondVisibleCountBefore],
      { timeout: 20000 },
    );
    await page.waitForFunction(
      ([sessionKey, expectedText, previousStoredCount]) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const raw = window.localStorage.getItem(sessionKey);
        if (!raw) return false;
        try {
          const session = JSON.parse(raw);
          if (!Array.isArray(session?.messages)) return false;
          const currentCount = session.messages.filter((message) =>
            message?.role === "user" && normalize(message?.content) === expectedText
          ).length;
          return currentCount === previousStoredCount + 1;
        } catch {
          return false;
        }
      },
      [STUDIO_SESSION_KEY, secondText, secondStoredCountBefore],
      { timeout: 20000 },
    );
    await page.waitForFunction(() => {
      const textareas = document.querySelectorAll("textarea");
      const target = textareas.item(textareas.length - 1);
      return target instanceof HTMLTextAreaElement && target.value === "";
    }, undefined, { timeout: 10000 });

    const afterSecondSendValue = await readComposerValue(page);
    const firstVisibleCountAfter = await countVisibleUserMessagesMatching(page, firstText);
    const secondVisibleCountAfter = await countVisibleUserMessagesMatching(page, secondText);
    const firstStoredCountAfter = await countStoredUserMessagesMatching(page, firstText);
    const secondStoredCountAfter = await countStoredUserMessagesMatching(page, secondText);
    const finalVisibleUserMessages = await readVisibleUserMessages(page, 20);

    assert.equal(afterSecondSendValue, "", `${mode} composer should clear after the second send`);
    assert.equal(
      firstVisibleCountAfter,
      firstVisibleCountBefore + 1,
      `${mode} should not duplicate the first user bubble after the second send`,
    );
    assert.equal(
      secondVisibleCountAfter,
      secondVisibleCountBefore + 1,
      `${mode} should append exactly one second user bubble`,
    );
    assert.equal(
      firstStoredCountAfter,
      firstStoredCountBefore + 1,
      `${mode} stored session should persist exactly one first user turn`,
    );
    assert.equal(
      secondStoredCountAfter,
      secondStoredCountBefore + 1,
      `${mode} stored session should persist exactly one second user turn`,
    );

    modeResults.push({
      mode,
      sourceEntry,
      initialVisibleUserMessages,
      finalVisibleUserMessages,
      firstText,
      secondText,
      firstVisibleCountBefore,
      firstVisibleCountAfter,
      secondVisibleCountBefore,
      secondVisibleCountAfter,
      firstStoredCountBefore,
      firstStoredCountAfter,
      secondStoredCountBefore,
      secondStoredCountAfter,
    });
  }

  return { modeResults };
}

async function runHeavyHistoryScenario(page) {
  const projects = createStressDramaProjects(180);
  const projectSessions = Object.fromEntries(
    projects.map((project) => [project.id, createStressDramaSession(project)]),
  );

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: projects,
    [STUDIO_PROJECT_SESSIONS_KEY]: projectSessions,
    [STUDIO_SESSION_KEY]: createStressDramaSession(projects[0]),
  });

  await page.locator("[data-sidebar-history-list='true']").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.waitForFunction(() => {
    const container = document.querySelector("[data-sidebar-history-list='true']");
    if (!(container instanceof HTMLElement)) return false;
    const matches = container.innerText.match(/压力测试会话 \d+/g) ?? [];
    return new Set(matches).size > 1;
  }, undefined, { timeout: 20000 });

  const visibleProjects = await page.evaluate(() => {
    const container = document.querySelector("[data-sidebar-history-list='true']");
    if (!(container instanceof HTMLElement)) return [];
    const matches = container.innerText.match(/压力测试会话 \d+/g) ?? [];
    return [...new Set(matches)];
  });
  const initialRenderedCount = visibleProjects.length;
  assert.ok(
    initialRenderedCount > 0 && initialRenderedCount < projects.length,
    `large history should keep initial DOM bounded, got ${initialRenderedCount} for ${projects.length} projects (${JSON.stringify(visibleProjects)})`,
  );
  const targetTitle = [...visibleProjects].reverse().find((title) => title !== "压力测试会话 1");
  assert.ok(targetTitle, `large history should keep at least one switchable session card visible (${JSON.stringify(visibleProjects)})`);
  const switchStartedAt = Date.now();
  await clickVisibleButtonByLabels(page, [targetTitle]);
  await page.waitForFunction(
    ([sessionKey, projectTitle]) => {
      const raw = window.localStorage.getItem(sessionKey);
      if (!raw) return false;
      try {
        return JSON.parse(raw)?.currentProjectSnapshot?.title === projectTitle;
      } catch {
        return false;
      }
    },
    [STUDIO_SESSION_KEY, targetTitle],
    { timeout: 15000 },
  );
  const switchDurationMs = Date.now() - switchStartedAt;

  assert.ok(
    switchDurationMs < 15000,
    `switching a large history session should stay responsive, took ${switchDurationMs}ms`,
  );

  return {
    totalProjects: projects.length,
    initialRenderedCount,
    visibleProjectCount: visibleProjects.length,
    targetProjectTitle: targetTitle,
    switchDurationMs,
  };
}

async function runHeavyAssetLibraryScenario(page) {
  const assetProjectId = "video-project-asset-stress";
  const assetCount = 220;
  const session = createAssetStressSession(assetProjectId, assetCount);

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createAssetStressVideoProject(assetProjectId, assetCount)],
    [STUDIO_SESSION_KEY]: session,
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [assetProjectId]: session,
    },
  });

  await page.locator("[data-sidebar-asset-list='image']").first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await page.waitForFunction(
    () => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return false;
      return container.innerText.includes("压力素材") || container.innerText.includes("加载更多素材");
    },
    undefined,
    { timeout: 10000 },
  );

  const listVisibleAssetLabels = async () =>
    page.evaluate(() => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return [];
      const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
      return Array.from(container.querySelectorAll("button"))
        .map((button) => {
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0";
          if (!visible) return null;
          const label = normalize(button.getAttribute("aria-label") || button.textContent || "");
          if (label.startsWith("删除 ")) return null;
          return label.includes("压力素材") ? label : null;
        })
        .filter(Boolean);
    });

  const initialAssetLabels = await listVisibleAssetLabels();
  if (!initialAssetLabels.length) {
    await page.waitForTimeout(300);
  }
  const stabilizedInitialAssetLabels = initialAssetLabels.length
    ? initialAssetLabels
    : await listVisibleAssetLabels();
  const initialRenderedCount = stabilizedInitialAssetLabels.length;
  const assetPanelText = await page
    .locator("[data-sidebar-asset-list='image']")
    .first()
    .innerText()
    .catch(() => "");
  assert.ok(
    initialRenderedCount > 0 && initialRenderedCount < assetCount,
    `large asset library should keep initial DOM bounded, got ${initialRenderedCount} for ${assetCount} assets. panel=${assetPanelText.slice(0, 400)}`,
  );

  const loadMoreButton = page.locator("[data-sidebar-load-more='image-assets']").first();
  if (await loadMoreButton.isVisible().catch(() => false)) {
    await loadMoreButton.click();
  }
  await page.waitForTimeout(200);
  const expandedAssetLabels = await listVisibleAssetLabels();
  assert.ok(
    expandedAssetLabels.length >= stabilizedInitialAssetLabels.length,
    "loading more assets should not reduce the number of visible asset cards",
  );
  const targetAssetLabel = expandedAssetLabels.at(-1) ?? stabilizedInitialAssetLabels.at(-1);
  assert.ok(targetAssetLabel, "asset library should keep at least one visible asset card");

  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(targetAssetLabel)}$`) }).first().click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(targetAssetLabel).first().waitFor({ state: "visible", timeout: 10000 });

  return {
    totalAssets: assetCount,
    initialRenderedCount,
    expandedRenderedCount: expandedAssetLabels.length,
    openedAssetLabel: targetAssetLabel,
  };
}

async function runVideoHistoryScenarioStable(page) {
  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoProject()],
  });

  await openHistoryProject(page, "夜雨追击预告片");
  const continuationLabels = [
    "继续补生成剩余镜头",
    "指定镜头继续出片",
    "切回《分镜图》",
    "切回《视频生成》",
    "切回《角色和场景》",
  ];
  const visibleButtons = await waitForVisibleButtonLabels(page, continuationLabels, 30000);
  const optionVisible = continuationLabels.some((label) =>
    visibleButtons.some((button) => button.text.includes(label) || button.ariaLabel.includes(label)),
  );
  assert.equal(
    optionVisible,
    true,
    `preview/export recovery should expose continuation options, got ${JSON.stringify(visibleButtons)}`,
  );
  assert.equal(
    new URL(page.url()).pathname,
    "/",
    "restoring a saved video project should keep the user on the home route",
  );

  return {
    previewExportPanelVisible: true,
    visibleButtons,
  };
}

async function runVideoStyleCustomInputScenarioStable(page) {
  await openVideoStyleProject(page);

  const customOptionCount = await page.getByRole("button", { name: "自定义" }).count();
  assert.equal(customOptionCount, 0, "style panels should no longer render a legacy custom option card");

  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  const placeholder = await textarea.getAttribute("placeholder");
  assert.equal(
    placeholder,
    "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
    "the style panel should swap the composer placeholder while capture mode is active",
  );

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  assert.equal(highlightVisible, true, "style capture mode should highlight the main composer shell");

  const customPrompt = "电影级低饱和和胶片质感，雨夜霓虹反差强";
  await textarea.fill(customPrompt);
  await textarea.press("Enter");

  await page.getByText(`自定义风格说明已写入：${customPrompt}`).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  const followupQuestion = await waitForStandardComposerQuestion(page, {
    title: "先补齐视频工作流前置参数",
    buttonLabels: ["补齐平台与镜头偏好"],
    timeout: 15000,
  });
  const captureModeStillVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  assert.equal(
    followupQuestion?.answerKey,
    "video-bridge-prefix",
    "custom style text should hand off to the standard bridge-prefix popup",
  );
  assert.equal(
    captureModeStillVisible,
    false,
    "style capture mode should exit once the next workflow popup is active",
  );

  return {
    customOptionCount,
    placeholder,
    highlightVisible,
    customPrompt,
    followupAnswerKey: followupQuestion?.answerKey ?? null,
  };
}

async function runVideoAnalyzeDurationCustomInputScenarioStable(page) {
  await openVideoAnalyzeDurationProject(page);

  const customOptionCount = await page.getByRole("button", { name: "自定义" }).count();
  assert.equal(customOptionCount, 0, "duration panels should no longer render a legacy custom option card");

  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  const placeholder = await textarea.getAttribute("placeholder");
  assert.equal(placeholder, "输入时长（秒）", "the duration panel should swap the composer placeholder");

  const highlightVisible =
    (await page.locator('[data-style-capture-mode="true"]').count()) > 0;
  assert.equal(highlightVisible, true, "duration capture mode should highlight the main composer shell");

  await textarea.fill("75");
  await textarea.press("Enter");

  const paceQuestion = await waitForStandardComposerQuestion(page, {
    title: "请选择视频节奏",
    buttonLabels: ["慢节奏", "中等", "快节奏"],
    timeout: 15000,
  });
  assert.equal(
    paceQuestion?.answerKey,
    "video-analyze-pace",
    "custom duration input should advance to the standard video pace popup",
  );

  return {
    customOptionCount,
    placeholder,
    highlightVisible,
    paceAnswerKey: paceQuestion?.answerKey ?? null,
  };
}

async function runHeavyAssetLibraryScenarioStable(page) {
  const assetProjectId = "video-project-asset-stress";
  const assetCount = 220;
  const session = createAssetStressSession(assetProjectId, assetCount);

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createAssetStressVideoProject(assetProjectId, assetCount)],
    [STUDIO_SESSION_KEY]: session,
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [assetProjectId]: session,
    },
  });

  await page.locator("[data-sidebar-asset-list='image']").first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await page.waitForFunction(
    () => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return false;
      return container.querySelectorAll("[data-sidebar-asset-id]").length > 0;
    },
    undefined,
    { timeout: 15000 },
  );
  await page.waitForTimeout(150);

  const initialAssetRows = await readVisibleAssetRows(page);
  const initialRenderedCount = initialAssetRows.length;
  const assetPanelText = await page
    .locator("[data-sidebar-asset-list='image']")
    .first()
    .innerText()
    .catch(() => "");
  assert.ok(
    initialRenderedCount > 0 && initialRenderedCount < assetCount,
    `large asset library should keep initial DOM bounded, got ${initialRenderedCount} for ${assetCount} assets. panel=${assetPanelText.slice(0, 400)}`,
  );

  const loadMoreButton = page.locator("[data-sidebar-load-more='image-assets']").first();
  if (await loadMoreButton.isVisible().catch(() => false)) {
    await loadMoreButton.click();
  }
  await page.waitForFunction(
    (baselineCount) => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return false;
      return container.querySelectorAll("[data-sidebar-asset-id]").length >= baselineCount;
    },
    initialRenderedCount,
    { timeout: 10000 },
  );
  await page.waitForTimeout(150);
  const expandedAssetRows = await readVisibleAssetRows(page);
  assert.ok(
    expandedAssetRows.length >= initialAssetRows.length,
    "loading more assets should not reduce the number of visible asset cards",
  );
  const targetAsset = expandedAssetRows.at(-1) ?? initialAssetRows.at(-1);
  assert.ok(targetAsset, "asset library should keep at least one visible asset card");

  await page
    .locator(`[data-sidebar-asset-id='${targetAsset.id}'] button[aria-label]`)
    .first()
    .click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(targetAsset.label).first().waitFor({ state: "visible", timeout: 10000 });

  return {
    totalAssets: assetCount,
    initialRenderedCount,
    expandedRenderedCount: expandedAssetRows.length,
    openedAssetLabel: targetAsset.label,
  };
}

async function runVideoHistoryScenarioSessionBacked(page) {
  const previewReviewQuestion = {
    id: "video-history-preview-stage-panel",
    title: "《夜雨追击预告片》进入预览与导出阶段",
    description: "可以继续补生成剩余镜头，或切回前面阶段补齐内容。",
    options: [
      { id: "video-history-generate-more", label: "继续补生成剩余镜头", value: "video:generate:first" },
      { id: "video-history-resume-by-scene", label: "指定镜头继续出片", value: "video:repair:pick" },
      { id: "video-history-back-storyboard", label: "切回《分镜图》", value: "video:step:storyboard" },
      { id: "video-history-back-video", label: "切回《视频生成》", value: "video:step:video-generation" },
      { id: "video-history-back-entities", label: "切回《角色和场景》", value: "video:step:entities" },
    ],
    presentation: "card",
    allowCustomInput: false,
    submissionMode: "immediate",
    multiSelect: false,
    stepIndex: 0,
    totalSteps: 1,
    answerKey: "video-history-preview-stage-panel",
  };
  const savedVideoHistorySession = {
    sessionId: "session-video-project-1",
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: "assistant-video-history-1",
        role: "assistant",
        content: "可以继续补生成剩余镜头，或切回前面的阶段补齐内容。",
        createdAt: "2026-04-03T00:30:00.000Z",
      },
    ],
    currentProjectSnapshot: {
      projectId: "video-project-1",
      projectKind: "video",
      title: "夜雨追击预告片",
      currentObjective: "进入预览与导出阶段",
      derivedStage: "预览与导出",
      agentSummary: "镜头已恢复到待审阅状态。",
      recommendedActions: ["继续补生成剩余镜头"],
      artifacts: [],
    },
    recentMessageSummary: "assistant: 可以继续补生成剩余镜头，或切回前面的阶段补齐内容。",
    projectId: "video-project-1",
    draft: "",
    qState: null,
    selectedValues: [],
    pendingChoiceQuestion: previewReviewQuestion,
    interruptedChoiceQuestion: null,
  };

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoProject()],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      "video-project-1": savedVideoHistorySession,
    },
  });

  await openHistoryProject(page, "夜雨追击预告片");
  const previewQuestion = await waitForStandardComposerQuestion(page, {
    title: "进入预览与导出阶段",
    buttonLabels: ["继续补生成剩余镜头", "指定镜头继续出片"],
    timeout: 30000,
  });
  assert.equal(previewQuestion?.answerKey, "video-history-preview-stage-panel");
  assert.equal(
    new URL(page.url()).pathname,
    "/",
    "restoring a saved video project should keep the user on the home route",
  );

  return {
    previewExportPanelVisible: true,
    answerKey: previewQuestion?.answerKey ?? null,
    visibleButtons: previewQuestion?.visibleButtons ?? [],
  };
}

async function runPendingCharacterAudioReturnMenuScenario(page) {
  const projectId = "video-project-audio-return-menu";
  const characterId = "char-audio-return";
  const characterName = "陆沉";
  const seededSession = createPendingCharacterAudioReturnMenuSession(
    projectId,
    characterId,
    characterName,
  );

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [
      createPendingCharacterAudioReturnMenuProject(
        projectId,
        characterId,
        characterName,
      ),
    ],
    [STUDIO_SESSION_KEY]: seededSession,
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [projectId]: seededSession,
    },
  });
  await openHistoryProject(page, "音频返回菜单验证项目");
  await sendFreeformTextReliable(page, "继续");

  logSmokeStep("pendingCharacterAudioReturnMenu", "seeded-and-requested");
  let restoredQuestion;
  try {
    await page.waitForFunction(
      () => {
        const modal = document.querySelector('[data-composer-choice-modal="true"]');
        if (!(modal instanceof HTMLElement)) return false;
        const rect = modal.getBoundingClientRect();
        const style = window.getComputedStyle(modal);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        return (
          visible &&
          modal.getAttribute("data-composer-question-answer-key") === "video-bridge-panel"
        );
      },
      undefined,
      { timeout: 30000 },
    );
    restoredQuestion = await readVisibleComposerQuestion(page);
  } catch (error) {
    const bodyPreview = await page.locator("body").innerText().catch(() => "");
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    const visibleQuestion = await readVisibleComposerQuestion(page).catch(() => null);
    const storedSession = await readStoredStudioSession(page).catch(() => null);
    const storedProject = await readStoredVideoProject(page, projectId).catch(() => null);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        JSON.stringify(
          {
            projectId,
            visibleQuestion,
            storedPendingChoiceAnswerKey:
              storedSession?.pendingChoiceQuestion?.answerKey ?? null,
            storedInterruptedChoiceAnswerKey:
              storedSession?.interruptedChoiceQuestion?.answerKey ?? null,
            storedCurrentStage:
              storedSession?.currentProjectSnapshot?.derivedStage ?? null,
            storedCurrentObjective:
              storedSession?.currentProjectSnapshot?.currentObjective ?? null,
            storedCharacterCount: storedProject?.characters?.length ?? null,
          },
          null,
          2,
        ),
        JSON.stringify(visibleButtons, null, 2),
        "",
        bodyPreview.slice(0, 2600),
      ].join("\n"),
    );
  }
  assert.equal(
    restoredQuestion?.answerKey,
    "video-bridge-panel",
    "seeded Electron role-and-scene scenario should start from the video bridge panel",
  );
  logSmokeStep("pendingCharacterAudioReturnMenu", "bridge-panel-visible");
  await clickVisibleComposerQuestionButton(page, ["单项处理"]);
  await clickVisibleComposerQuestionButton(page, ["单独整理角色资产"]);
  await clickVisibleComposerQuestionButton(page, [characterName]);
  await clickVisibleComposerQuestionButton(page, ["音频参考"]);
  logSmokeStep("pendingCharacterAudioReturnMenu", "pending-upload-opened");

  let pendingUploadQuestion;
  try {
    pendingUploadQuestion = await waitForStandardComposerQuestion(page, {
      title: `正在等待上传《${characterName}》的音频参考`,
      buttonLabels: ["返回菜单"],
      timeout: 15000,
    });
  } catch (error) {
    const visibleQuestion = await readVisibleComposerQuestion(page).catch(() => null);
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    const visibleUserMessages = await readVisibleUserMessages(page, 12).catch(() => []);
    const visibleAssistantMessages = await readVisibleAssistantMessages(page, 12).catch(() => []);
    const streamLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="agent-streaming-label"]'))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ).catch(() => []);
    const storedSession = await readStoredStudioSession(page).catch(() => null);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        JSON.stringify(
          {
            visibleQuestion,
            storedPendingChoiceAnswerKey:
              storedSession?.pendingChoiceQuestion?.answerKey ?? null,
            storedInterruptedChoiceAnswerKey:
              storedSession?.interruptedChoiceQuestion?.answerKey ?? null,
            storedCurrentStage:
              storedSession?.currentProjectSnapshot?.derivedStage ?? null,
            storedCurrentObjective:
              storedSession?.currentProjectSnapshot?.currentObjective ?? null,
            streamLabels,
            visibleUserMessages,
            visibleAssistantMessages,
          },
          null,
          2,
        ),
        JSON.stringify(visibleButtons, null, 2),
      ].join("\n"),
    );
  }
  assert.equal(
    pendingUploadQuestion?.answerKey,
    "pending-character-audio-upload",
    "opening character audio upload should swap to the pending-upload popup",
  );

  logSmokeStep("pendingCharacterAudioReturnMenu", "reload-before-return");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });

  const rehydratedPendingUploadQuestion = await waitForStandardComposerQuestion(page, {
    title: `正在等待上传《${characterName}》的音频参考`,
    buttonLabels: ["返回菜单"],
    timeout: 15000,
  });
  assert.equal(
    rehydratedPendingUploadQuestion?.answerKey,
    "pending-character-audio-upload",
    "after an Electron reload, the pending audio upload popup should still be recoverable",
  );
  logSmokeStep("pendingCharacterAudioReturnMenu", "pending-upload-rehydrated");

  const visibleReturnMenuUserCountBefore = await countVisibleUserMessagesMatching(
    page,
    "返回菜单",
  );
  const storedReturnMenuUserCountBefore = await countStoredUserMessagesMatching(
    page,
    "返回菜单",
  );
  const assistantMessagesBefore = await readVisibleAssistantMessages(page, 20);
  const interruptReplyCountBefore = assistantMessagesBefore.filter((message) =>
    message.includes("已停止当前执行，刚才的弹窗已恢复，你可以重新选择。"),
  ).length;

  logSmokeStep("pendingCharacterAudioReturnMenu", "click-return-menu");
  await clickVisibleComposerQuestionButton(page, ["返回菜单"]);

  let resumedQuestion;
  try {
    resumedQuestion = await waitForStandardComposerQuestion(page, {
      buttonLabels: ["单项处理"],
      timeout: 15000,
    });
  } catch (error) {
    const visibleQuestion = await readVisibleComposerQuestion(page).catch(() => null);
    const visibleButtons = await listVisibleButtons(page).catch(() => []);
    const visibleUserMessages = await readVisibleUserMessages(page, 12).catch(() => []);
    const visibleAssistantMessages = await readVisibleAssistantMessages(page, 12).catch(() => []);
    const streamLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="agent-streaming-label"]'))
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ).catch(() => []);
    const storedSession = await readStoredStudioSession(page).catch(() => null);
    throw new Error(
      [
        String(error?.stack || error),
        "",
        JSON.stringify(
          {
            visibleQuestion,
            storedPendingChoiceAnswerKey:
              storedSession?.pendingChoiceQuestion?.answerKey ?? null,
            storedInterruptedChoiceAnswerKey:
              storedSession?.interruptedChoiceQuestion?.answerKey ?? null,
            storedCurrentStage:
              storedSession?.currentProjectSnapshot?.derivedStage ?? null,
            storedCurrentObjective:
              storedSession?.currentProjectSnapshot?.currentObjective ?? null,
            streamLabels,
            visibleUserMessages,
            visibleAssistantMessages,
          },
          null,
          2,
        ),
        JSON.stringify(visibleButtons, null, 2),
      ].join("\n"),
    );
  }
  assert.equal(
    resumedQuestion?.answerKey,
    "video-bridge-panel",
    "returning from the pending audio upload popup should restore the current role-and-scene popup",
  );
  assert.equal(
    resumedQuestion?.text?.includes("补角色与场景") || resumedQuestion?.text?.includes("角色与场景"),
    true,
    "returning from the pending audio upload popup should land on the role-and-scene stage popup instead of a normal chat channel",
  );
  logSmokeStep("pendingCharacterAudioReturnMenu", "role-scene-restored");

  await page.waitForTimeout(1200);

  const visibleReturnMenuUserCountAfter = await countVisibleUserMessagesMatching(
    page,
    "返回菜单",
  );
  const storedReturnMenuUserCountAfter = await countStoredUserMessagesMatching(
    page,
    "返回菜单",
  );
  const assistantMessagesAfter = await readVisibleAssistantMessages(page, 20);
  const interruptReplyCountAfter = assistantMessagesAfter.filter((message) =>
    message.includes("已停止当前执行，刚才的弹窗已恢复，你可以重新选择。"),
  ).length;
  const streamLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="agent-streaming-label"]'))
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  const storedSession = await readStoredStudioSession(page);

  assert.equal(
    visibleReturnMenuUserCountAfter,
    visibleReturnMenuUserCountBefore,
    'clicking "返回菜单" should not append a visible user bubble that says "返回菜单"',
  );
  assert.equal(
    storedReturnMenuUserCountAfter,
    storedReturnMenuUserCountBefore,
    'clicking "返回菜单" should not persist a stored user message that says "返回菜单"',
  );
  assert.equal(
    interruptReplyCountAfter,
    interruptReplyCountBefore,
    'clicking "返回菜单" should not route through the interrupt assistant reply channel',
  );
  assert.equal(
    streamLabels.some((label) => label.includes("正在分析")),
    false,
    `clicking "返回菜单" should not start a normal LLM analysis stream, got ${JSON.stringify(streamLabels)}`,
  );
  assert.equal(
    storedSession?.pendingChoiceQuestion?.answerKey ?? null,
    "video-bridge-panel",
    "after returning from the audio upload popup, the stored pending-choice question should be the original bridge panel",
  );

  return {
    projectId,
    resumedAnswerKey: resumedQuestion?.answerKey ?? null,
    visibleReturnMenuUserCountBefore,
    visibleReturnMenuUserCountAfter,
    storedReturnMenuUserCountBefore,
    storedReturnMenuUserCountAfter,
    interruptReplyCountBefore,
    interruptReplyCountAfter,
    streamLabels,
    assistantMessageTail: assistantMessagesAfter.slice(-6),
  };
}

async function runVideoWorkflowEntryToRoleAndSceneScenarioResilient(page, options = {}) {
  const { seed = true } = options;
  await openVideoWorkflowEntryProject(page, { seed });

  await page.getByRole("button", { name: "用于视频创作" }).last().click();
  await page.getByRole("button", { name: "使用当前剧本项目" }).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "使用当前剧本项目" }).last().click();

  await page.getByText("请选择单集时长").first().waitFor({
    state: "visible",
    timeout: 120000,
  });
  await page.getByRole("button", { name: "60 秒" }).last().click();
  await page.getByText("请选择视频节奏").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "中等" }).last().click();
  await page.getByText("完成剧本拆解").first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "完成剧本拆解" }).last().click();

  const outcome = await Promise.any([
    waitForVisibleButtonLabels(page, ["刷新拆解结果", "提取角色与场景"], 300000).then((buttons) => ({
      kind: "success",
      buttons,
    })),
    waitForStandardComposerQuestion(page, {
      title: "继续剧本拆解",
      buttonLabels: ["继续剧本拆解"],
      timeout: 300000,
    }).then((question) => ({
      kind: "recovery",
      question,
    })),
  ]);

  if (outcome.kind === "recovery") {
    assert.equal(
      outcome.question?.answerKey,
      "video-analyze-resume",
      "script breakdown interruptions should recover into the standard continue-breakdown popup",
    );
    return {
      nextStep: "script-breakdown-recovery",
      recoveryAnswerKey: outcome.question?.answerKey ?? null,
    };
  }

  const videoProjectId = await waitForCurrentVideoProjectId(page);
  return {
    videoProjectId,
    nextStep: "role-and-scene",
    visibleButtons: outcome.buttons,
  };
}

async function ensureVideoWorkflowRoleAndSceneBridge(page, bridgeResult) {
  if (bridgeResult?.nextStep === "role-and-scene") {
    return bridgeResult;
  }
  assert.equal(
    bridgeResult?.nextStep,
    "script-breakdown-recovery",
    "video workflow bridge should either reach role-and-scene directly or pause on the standard continue-breakdown popup",
  );
  await clickVisibleButtonByLabels(page, ["继续剧本拆解"]);
  const visibleButtons = await waitForVisibleButtonLabels(page, ["刷新拆解结果", "提取角色与场景"], 300000);
  const videoProjectId = await waitForCurrentVideoProjectId(page);
  return {
    ...bridgeResult,
    videoProjectId,
    nextStep: "role-and-scene",
    recoveredFromBreakdownInterruption: true,
    visibleButtons,
  };
}

async function runVideoWorkflowUseCurrentProjectHistoryReuseScenario(page) {
  const scriptProjectId = "drama-project-video-entry";
  const bridgeResult = await ensureVideoWorkflowRoleAndSceneBridge(
    page,
    await runVideoWorkflowEntryToRoleAndSceneScenarioResilient(page),
  );
  assert.equal(
    bridgeResult?.nextStep,
    "role-and-scene",
    "use-current-project history scenario should complete the bridge into the role-and-scene stage",
  );

  const videoProjectId = bridgeResult?.videoProjectId;
  assert.notEqual(
    videoProjectId,
    scriptProjectId,
    "use-current-project bridge should activate a linked video project behind the source script session",
  );

  try {
    await waitForStoredProjectSessionSnapshot(page, scriptProjectId, videoProjectId, 15000);
  } catch (error) {
    const debugStoredSession = await readStoredStudioSession(page).catch(() => null);
    const debugStoredProjectSessions = await readStoredProjectSessions(page).catch(() => ({}));
    throw new Error(
      [
        String(error?.stack || error),
        "",
        `scriptProjectId=${scriptProjectId}`,
        `videoProjectId=${videoProjectId}`,
        `storedSession=${JSON.stringify(debugStoredSession, null, 2)}`,
        `storedProjectSessions=${JSON.stringify(debugStoredProjectSessions, null, 2)}`,
      ].join("\n"),
    );
  }

  const afterBridgeHistoryEntries = await listVisibleHistoryEntries(page);
  const afterBridgeHistoryCount = await readSidebarHistoryCountState(page);
  const storedSession = await readStoredStudioSession(page);
  const storedProjectSessions = await readStoredProjectSessions(page);

  assert.equal(
    afterBridgeHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "bridging into video workflow should not create a second visible history card for the linked video project",
  );
  assert.equal(
    afterBridgeHistoryEntries.filter((entry) => entry.projectId === scriptProjectId).length,
    1,
    "bridging into video workflow should keep exactly one visible source-script history card",
  );
  assert.equal(
    afterBridgeHistoryEntries[0]?.text?.includes("导出与出片"),
    false,
    "bridged source-script history card should stop showing the stale script export stage",
  );
  assert.equal(
    afterBridgeHistoryEntries[0]?.text?.includes("脚本拆解"),
    true,
    "bridged source-script history card should reflect the live video workflow stage",
  );
  assert.equal(
    afterBridgeHistoryCount.totalCount,
    1,
    "bridging into video workflow should keep the visible history count pinned to the source script card",
  );
  assert.equal(
    storedSession?.projectId,
    scriptProjectId,
    "the active studio session should stay keyed by the source script project id",
  );
  assert.equal(
    storedSession?.currentProjectSnapshot?.projectId,
    videoProjectId,
    "the active studio session should persist the bridged video snapshot under the source script history shell",
  );
  assert.equal(
    storedProjectSessions?.[scriptProjectId]?.currentProjectSnapshot?.projectId,
    videoProjectId,
    "project-scoped session storage should keep the bridged video snapshot on the source script entry",
  );
  assert.equal(
    Boolean(storedProjectSessions?.[videoProjectId]),
    false,
    "project-scoped session storage should not create an extra linked video history shell",
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  const reloadedVideoProjectId = await waitForCurrentVideoProjectId(page, 30000);
  assert.equal(
    reloadedVideoProjectId,
    videoProjectId,
    "reloading after the bridge should keep the linked video project active inside the source script history shell",
  );

  const reloadedHistoryEntries = await listVisibleHistoryEntries(page);
  assert.equal(
    reloadedHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "reloading after the bridge should still keep the linked video project hidden from visible history",
  );
  return {
    scriptProjectId,
    videoProjectId,
    bridgeResult,
    afterBridgeHistoryCount,
    afterBridgeHistoryEntries,
    reloadedHistoryEntries,
  };
}

async function runVideoWorkflowUseCurrentProjectMultiSessionSwitchScenario(page) {
  const bridgeScriptProjectId = "drama-project-video-entry";
  const siblingProjectA = "drama-project-history-switch-a";
  const siblingProjectB = "drama-project-history-switch-b";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [
      createVideoEntryDramaProject(bridgeScriptProjectId),
      createHistorySwitchDramaProject({
        projectId: siblingProjectA,
        title: "多会话切换测试 A",
        currentStep: "characters",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      createHistorySwitchDramaProject({
        projectId: siblingProjectB,
        title: "多会话切换测试 B",
        currentStep: "outlines",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    ],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [bridgeScriptProjectId]: createVideoEntrySession(bridgeScriptProjectId),
      [siblingProjectA]: createHistorySwitchSession({
        projectId: siblingProjectA,
        title: "多会话切换测试 A",
        assistantText: "A 会话停留在角色开发阶段，等待继续补角色设定。",
        currentObjective: "继续角色开发",
        derivedStage: "角色开发",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      [siblingProjectB]: createHistorySwitchSession({
        projectId: siblingProjectB,
        title: "多会话切换测试 B",
        assistantText: "B 会话停留在分集目录阶段，等待继续补齐目录。",
        currentObjective: "继续分集目录",
        derivedStage: "分集目录",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    },
    [STUDIO_SESSION_KEY]: createVideoEntrySession(bridgeScriptProjectId),
  });

  const seededDramaProjects = await readStoredDramaProjects(page);
  const seededProjectSessions = await readStoredProjectSessions(page);
  if (seededDramaProjects.length !== 3 || Object.keys(seededProjectSessions ?? {}).length !== 3) {
    throw new Error(
      [
        "multi-session switch scenario should preserve the seeded multi-session baseline before bridging",
        `seeded drama project ids: ${JSON.stringify(seededDramaProjects.map((project) => project?.id ?? null))}`,
        `seeded project session ids: ${JSON.stringify(Object.keys(seededProjectSessions ?? {}))}`,
      ].join("\n"),
    );
  }

  const bridgeResult = await ensureVideoWorkflowRoleAndSceneBridge(
    page,
    await runVideoWorkflowEntryToRoleAndSceneScenarioResilient(page, {
      seed: false,
    }),
  );
  assert.equal(
    bridgeResult?.nextStep,
    "role-and-scene",
    "multi-session switch scenario should complete the bridge into the role-and-scene stage",
  );

  const videoProjectId = bridgeResult?.videoProjectId;
  assert.notEqual(
    videoProjectId,
    bridgeScriptProjectId,
    "multi-session switch scenario should activate a linked video project behind the source script session",
  );

  await waitForStoredProjectSessionSnapshot(page, bridgeScriptProjectId, videoProjectId, 15000);
  await waitForStoredStudioSessionShell(page, bridgeScriptProjectId, videoProjectId, 15000);

  const baselineHistoryEntries = await listVisibleHistoryEntries(page);
  const baselineHistoryCount = await readSidebarHistoryCountState(page);
  if (baselineHistoryCount.totalCount !== 3) {
    const debugStoredSession = await readStoredStudioSession(page).catch(() => null);
    const debugStoredProjectSessions = await readStoredProjectSessions(page).catch(() => ({}));
    throw new Error(
      [
        "multi-session switch scenario should keep exactly three visible manual history cards after bridging",
        `received count: ${baselineHistoryCount.totalCount}`,
        `history entries: ${JSON.stringify(baselineHistoryEntries)}`,
        `stored session mode: ${debugStoredSession?.automationMode ?? null}`,
        `stored session project: ${debugStoredSession?.projectId ?? null}`,
        `stored snapshot project: ${debugStoredSession?.currentProjectSnapshot?.projectId ?? null}`,
        `stored project session ids: ${JSON.stringify(Object.keys(debugStoredProjectSessions ?? {}))}`,
      ].join("\n"),
    );
  }
  assert.equal(
    baselineHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "multi-session switch scenario should not show the linked video project as a separate history card",
  );

  const assertBridgeHistoryCard = async () => {
    const historyEntries = await listVisibleHistoryEntries(page);
    const historyCount = await readSidebarHistoryCountState(page);
    const bridgeEntry = historyEntries.find((entry) => entry.projectId === bridgeScriptProjectId) ?? null;
    if (historyCount.totalCount !== 3 || historyEntries.some((entry) => entry.projectId === videoProjectId)) {
      const debugStoredSession = await readStoredStudioSession(page).catch(() => null);
      const debugStoredProjectSessions = await readStoredProjectSessions(page).catch(() => ({}));
      throw new Error(
        [
          "switching between multiple sessions should keep the bridged script history list stable",
          `history count: ${historyCount.totalCount}`,
          `history entries: ${JSON.stringify(historyEntries)}`,
          `stored active session project: ${debugStoredSession?.projectId ?? null}`,
          `stored active snapshot project: ${debugStoredSession?.currentProjectSnapshot?.projectId ?? null}`,
          `stored bridged shell snapshot project: ${debugStoredProjectSessions?.[bridgeScriptProjectId]?.currentProjectSnapshot?.projectId ?? null}`,
          `stored bridged shell source project: ${debugStoredProjectSessions?.[bridgeScriptProjectId]?.currentProjectSnapshot?.sourceProjectId ?? null}`,
          `stored project session ids: ${JSON.stringify(Object.keys(debugStoredProjectSessions ?? {}))}`,
        ].join("\n"),
      );
    }
    assert.equal(
      bridgeEntry?.text?.includes("脚本拆解"),
      true,
      "the bridged source-script history card should keep the live video workflow stage while switching",
    );
    assert.equal(
      bridgeEntry?.text?.includes("导出与出片"),
      false,
      "the bridged source-script history card should not revert to the stale script export stage while switching",
    );
  };

  await assertBridgeHistoryCard();

  const switchingSequence = [
    { projectId: siblingProjectA, expectedSnapshotProjectId: siblingProjectA, stage: "角色开发" },
    { projectId: bridgeScriptProjectId, expectedSnapshotProjectId: videoProjectId, stage: "脚本拆解" },
    { projectId: siblingProjectB, expectedSnapshotProjectId: siblingProjectB, stage: "分集目录" },
    { projectId: bridgeScriptProjectId, expectedSnapshotProjectId: videoProjectId, stage: "脚本拆解" },
    { projectId: siblingProjectA, expectedSnapshotProjectId: siblingProjectA, stage: "角色开发" },
    { projectId: bridgeScriptProjectId, expectedSnapshotProjectId: videoProjectId, stage: "脚本拆解" },
  ];

  const cycleSummaries = [];

  for (const step of switchingSequence) {
    await clickHistoryById(page, step.projectId);
    await waitForStoredStudioSessionShell(page, step.projectId, step.expectedSnapshotProjectId, 15000);
    const storedSession = await readStoredStudioSession(page);
    const historyEntries = await listVisibleHistoryEntries(page);
    const activeEntry = historyEntries.find((entry) => entry.projectId === step.projectId) ?? null;

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `switching should persist ${step.projectId} as the active session shell`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.expectedSnapshotProjectId,
      `switching should restore ${step.projectId} with the expected live project snapshot`,
    );
    assert.equal(
      activeEntry?.text?.includes(step.stage),
      true,
      `history card ${step.projectId} should expose its latest stage after switching`,
    );

    await assertBridgeHistoryCard();

    cycleSummaries.push({
      projectId: step.projectId,
      snapshotProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
      activeEntryText: activeEntry?.text ?? null,
    });
  }

  const storedProjectSessions = await readStoredProjectSessions(page);
  assert.equal(
    storedProjectSessions?.[bridgeScriptProjectId]?.currentProjectSnapshot?.projectId,
    videoProjectId,
    "multi-session switching should keep the bridged video snapshot attached to the source script session entry",
  );
  assert.equal(
    Boolean(storedProjectSessions?.[videoProjectId]),
    false,
    "multi-session switching should still avoid creating a linked video history shell",
  );

  return {
    bridgeScriptProjectId,
    siblingProjectA,
    siblingProjectB,
    videoProjectId,
    baselineHistoryCount,
    baselineHistoryEntries,
    cycleSummaries,
  };
}

async function runDuplicateProjectsMultiSwitchScenario(page) {
  const sourceProjectAlpha = "duplicate-switch-alpha";
  const sourceProjectBeta = "duplicate-switch-beta";
  const titleAlpha = "Duplicate Switch Alpha";
  const titleBeta = "Duplicate Switch Beta";
  const assistantAlpha = "Alpha family should stay on character development while switching between duplicates.";
  const assistantBeta = "Beta family should stay on episode outlining while switching between duplicates.";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [
      createHistorySwitchDramaProject({
        projectId: sourceProjectAlpha,
        title: titleAlpha,
        currentStep: "characters",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }),
      createHistorySwitchDramaProject({
        projectId: sourceProjectBeta,
        title: titleBeta,
        currentStep: "outlines",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    ],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [sourceProjectAlpha]: createHistorySwitchSession({
        projectId: sourceProjectAlpha,
        title: titleAlpha,
        assistantText: assistantAlpha,
        currentObjective: "Continue alpha characters",
        derivedStage: "Character Dev",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }),
      [sourceProjectBeta]: createHistorySwitchSession({
        projectId: sourceProjectBeta,
        title: titleBeta,
        assistantText: assistantBeta,
        currentObjective: "Continue beta outlines",
        derivedStage: "Episode Outline",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    },
    [STUDIO_SESSION_KEY]: createHistorySwitchSession({
      projectId: sourceProjectAlpha,
      title: titleAlpha,
      assistantText: assistantAlpha,
      currentObjective: "Continue alpha characters",
      derivedStage: "Character Dev",
      updatedAt: "2026-04-08T00:00:00.000Z",
    }),
  });

  await page.waitForFunction(
    () => {
      const historyList = document.querySelector("[data-sidebar-history-list='true']");
      const totalCountRaw =
        historyList instanceof HTMLElement ? historyList.getAttribute("data-sidebar-history-total-count") : null;
      return Number(totalCountRaw) === 2;
    },
    undefined,
    { timeout: 15000 },
  );

  const baselineCount = await readSidebarHistoryCountState(page);
  assert.equal(
    baselineCount.totalCount,
    2,
    "duplicate multi-switch scenario should start from exactly two visible source history cards",
  );

  const alphaCopy1 = await duplicateHistoryProjectFromMenu(page, sourceProjectAlpha, `${titleAlpha} - 副本`);
  const alphaCopy2 = await duplicateHistoryProjectFromMenu(page, sourceProjectAlpha, `${titleAlpha} - 副本2`);
  const betaCopy1 = await duplicateHistoryProjectFromMenu(page, sourceProjectBeta, `${titleBeta} - 副本`);

  const afterDuplicateHistoryEntries = await listVisibleHistoryEntries(page);
  const afterDuplicateCount = await readSidebarHistoryCountState(page);
  const storedDramaProjects = await readStoredDramaProjects(page);
  const storedProjectSessions = await readStoredProjectSessions(page);

  assert.equal(
    afterDuplicateCount.totalCount,
    5,
    "duplicate multi-switch scenario should expose five visible history cards after creating three copies",
  );
  assert.equal(
    storedDramaProjects.length,
    5,
    "duplicate multi-switch scenario should persist five drama projects after duplication",
  );
  assert.equal(
    Object.keys(storedProjectSessions ?? {}).length,
    5,
    "duplicate multi-switch scenario should persist five project-scoped sessions after duplication",
  );

  const expectedCards = [
    { projectId: sourceProjectAlpha, title: titleAlpha, familyNeedle: assistantAlpha },
    { projectId: alphaCopy1.projectId, title: alphaCopy1.title, familyNeedle: assistantAlpha },
    { projectId: alphaCopy2.projectId, title: alphaCopy2.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectBeta, title: titleBeta, familyNeedle: assistantBeta },
    { projectId: betaCopy1.projectId, title: betaCopy1.title, familyNeedle: assistantBeta },
  ];

  for (const expected of expectedCards) {
    assert.equal(
      afterDuplicateHistoryEntries.some(
        (entry) => entry.projectId === expected.projectId && entry.text.includes(expected.title),
      ),
      true,
      `history should render ${expected.title} after duplication`,
    );
  }

  const switchingSequence = [
    { projectId: alphaCopy1.projectId, title: alphaCopy1.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectBeta, title: titleBeta, familyNeedle: assistantBeta },
    { projectId: alphaCopy2.projectId, title: alphaCopy2.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectAlpha, title: titleAlpha, familyNeedle: assistantAlpha },
    { projectId: betaCopy1.projectId, title: betaCopy1.title, familyNeedle: assistantBeta },
    { projectId: alphaCopy1.projectId, title: alphaCopy1.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectBeta, title: titleBeta, familyNeedle: assistantBeta },
    { projectId: alphaCopy2.projectId, title: alphaCopy2.title, familyNeedle: assistantAlpha },
  ];

  const cycleSummaries = [];

  for (const step of switchingSequence) {
    await clickHistoryById(page, step.projectId);
    await waitForStoredSessionProjectId(page, step.projectId, 15000);

    const storedSession = await readStoredStudioSession(page);
    const visibleAssistantMessages = await readVisibleAssistantMessages(page, 8);
    const historyEntries = await listVisibleHistoryEntries(page);
    const historyCount = await readSidebarHistoryCountState(page);

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `switching should persist ${step.projectId} as the active duplicated project session`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.projectId,
      `switching should keep ${step.projectId} aligned with its own project snapshot`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.title,
      step.title,
      `switching should restore the correct duplicated title for ${step.projectId}`,
    );
    assert.equal(
      visibleAssistantMessages.some((message) => message.includes(step.familyNeedle)),
      true,
      `switching to ${step.title} should surface its family-specific assistant history`,
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === step.projectId && entry.text.includes(step.title)),
      true,
      `history list should keep rendering ${step.title} while switching between duplicates`,
    );
    assert.equal(
      historyCount.totalCount,
      5,
      "switching between duplicated projects should keep the visible history count stable",
    );

    cycleSummaries.push({
      projectId: step.projectId,
      title: storedSession?.currentProjectSnapshot?.title ?? null,
      assistantMessage: visibleAssistantMessages.find((message) => message.includes(step.familyNeedle)) ?? null,
    });
  }

  const finalDramaProjects = await readStoredDramaProjects(page);
  const finalProjectSessions = await readStoredProjectSessions(page);
  assert.equal(
    finalDramaProjects.length,
    5,
    "switching between duplicated projects should not create extra persisted drama projects",
  );
  assert.equal(
    Object.keys(finalProjectSessions ?? {}).length,
    5,
    "switching between duplicated projects should not create extra persisted project sessions",
  );

  return {
    sourceProjectAlpha,
    sourceProjectBeta,
    titleAlpha,
    titleBeta,
    assistantAlpha,
    assistantBeta,
    alphaCopy1,
    alphaCopy2,
    betaCopy1,
    afterDuplicateCount,
    afterDuplicateHistoryEntries,
    cycleSummaries,
  };
}

async function runDuplicateProjectsDeleteThenDuplicateScenario(page) {
  const baseline = await runDuplicateProjectsMultiSwitchScenario(page);
  const {
    sourceProjectAlpha,
    sourceProjectBeta,
    titleAlpha,
    titleBeta,
    assistantAlpha,
    assistantBeta,
    alphaCopy1,
    alphaCopy2,
    betaCopy1,
  } = baseline;

  await clickHistoryById(page, alphaCopy1.projectId);
  await waitForStoredSessionProjectId(page, alphaCopy1.projectId, 15000);

  const deleteResult = await deleteHistoryProjectFromMenu(page, alphaCopy1.projectId);
  const afterDeleteHistoryEntries = await listVisibleHistoryEntries(page);
  const afterDeleteCount = await readSidebarHistoryCountState(page);

  assert.equal(
    afterDeleteCount.totalCount,
    4,
    "delete-then-duplicate scenario should show four visible history cards after removing one active duplicate",
  );
  assert.equal(
    afterDeleteHistoryEntries.some((entry) => entry.projectId === alphaCopy1.projectId),
    false,
    "delete-then-duplicate scenario should keep the deleted duplicate hidden from visible history",
  );

  const recycledAlphaCopy = await duplicateHistoryProjectFromMenu(page, sourceProjectAlpha, `${titleAlpha} - 副本`);
  const afterRecycleHistoryEntries = await listVisibleHistoryEntries(page);
  const afterRecycleCount = await readSidebarHistoryCountState(page);
  const afterRecycleDramaProjects = await readStoredDramaProjects(page);
  const afterRecycleProjectSessions = await readStoredProjectSessions(page);

  assert.notEqual(
    recycledAlphaCopy.projectId,
    alphaCopy1.projectId,
    "re-duplicating after delete should create a fresh project id instead of resurrecting the deleted duplicate",
  );
  assert.equal(
    afterRecycleCount.totalCount,
    5,
    "delete-then-duplicate scenario should return to five visible history cards after recreating the duplicate",
  );
  assert.equal(
    afterRecycleDramaProjects.length,
    5,
    "delete-then-duplicate scenario should persist five drama projects after recreating the duplicate",
  );
  assert.equal(
    Object.keys(afterRecycleProjectSessions ?? {}).length,
    5,
    "delete-then-duplicate scenario should persist five project-scoped sessions after recreating the duplicate",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === alphaCopy1.projectId),
    false,
    "recreating a deleted duplicate should not bring back the old history project id",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === recycledAlphaCopy.projectId),
    true,
    "recreating a deleted duplicate should surface the fresh duplicate in visible history",
  );

  const switchingSequence = [
    { projectId: recycledAlphaCopy.projectId, title: recycledAlphaCopy.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectBeta, title: titleBeta, familyNeedle: assistantBeta },
    { projectId: alphaCopy2.projectId, title: alphaCopy2.title, familyNeedle: assistantAlpha },
    { projectId: sourceProjectAlpha, title: titleAlpha, familyNeedle: assistantAlpha },
    { projectId: betaCopy1.projectId, title: betaCopy1.title, familyNeedle: assistantBeta },
    { projectId: recycledAlphaCopy.projectId, title: recycledAlphaCopy.title, familyNeedle: assistantAlpha },
  ];

  const recycleCycleSummaries = [];

  for (const step of switchingSequence) {
    await clickHistoryById(page, step.projectId);
    await waitForStoredSessionProjectId(page, step.projectId, 15000);

    const storedSession = await readStoredStudioSession(page);
    const visibleAssistantMessages = await readVisibleAssistantMessages(page, 8);
    const historyEntries = await listVisibleHistoryEntries(page);
    const historyCount = await readSidebarHistoryCountState(page);

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `delete-then-duplicate switching should persist ${step.projectId} as the active session shell`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.projectId,
      `delete-then-duplicate switching should keep ${step.projectId} aligned with its own project snapshot`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.title,
      step.title,
      `delete-then-duplicate switching should restore the correct title for ${step.projectId}`,
    );
    assert.equal(
      visibleAssistantMessages.some((message) => message.includes(step.familyNeedle)),
      true,
      `switching to ${step.title} after delete and re-duplicate should surface its expected assistant history`,
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === step.projectId && entry.text.includes(step.title)),
      true,
      `history should keep rendering ${step.title} after delete and re-duplicate switching`,
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === alphaCopy1.projectId),
      false,
      "the deleted duplicate should stay absent while switching after re-duplication",
    );
    assert.equal(
      historyCount.totalCount,
      5,
      "delete-then-duplicate switching should keep the visible history count stable",
    );

    recycleCycleSummaries.push({
      projectId: step.projectId,
      title: storedSession?.currentProjectSnapshot?.title ?? null,
      assistantMessage: visibleAssistantMessages.find((message) => message.includes(step.familyNeedle)) ?? null,
    });
  }

  return {
    ...baseline,
    deleteResult,
    recycledAlphaCopy,
    afterDeleteCount,
    afterDeleteHistoryEntries,
    afterRecycleCount,
    afterRecycleHistoryEntries,
    recycleCycleSummaries,
  };
}

async function runVideoWorkflowUseCurrentProjectDuplicateDeleteSwitchScenario(page) {
  const baseline = await runVideoWorkflowUseCurrentProjectMultiSessionSwitchScenario(page);
  const {
    bridgeScriptProjectId,
    siblingProjectA,
    siblingProjectB,
    videoProjectId,
  } = baseline;
  const bridgeTitle = "视频入口串联测试剧本";
  const siblingTitleA = "多会话切换测试 A";
  const siblingTitleB = "多会话切换测试 B";

  const baselineHistoryCount = await readSidebarHistoryCountState(page);
  assert.equal(
    baselineHistoryCount.totalCount,
    3,
    "bridge duplicate-delete scenario should begin from the three-card bridged multi-session baseline",
  );

  const bridgeCopy1 = await duplicateHistoryProjectFromMenu(page, bridgeScriptProjectId, `${bridgeTitle} - 副本`, {
    expectedDramaCountDelta: 0,
  });
  const bridgeCopy2 = await duplicateHistoryProjectFromMenu(page, bridgeScriptProjectId, `${bridgeTitle} - 副本2`, {
    expectedDramaCountDelta: 0,
  });
  const siblingCopyA = await duplicateHistoryProjectFromMenu(page, siblingProjectA, `${siblingTitleA} - 副本`);

  const afterDuplicateHistoryEntries = await listVisibleHistoryEntries(page);
  const afterDuplicateCount = await readSidebarHistoryCountState(page);
  assert.equal(
    afterDuplicateCount.totalCount,
    6,
    "bridge duplicate-delete scenario should show six visible history cards after creating three copies",
  );
  assert.equal(
    afterDuplicateHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "duplicating bridged sessions should still keep the linked video project hidden from visible history",
  );

  const bridgeStageNeedle = "脚本拆解";
  const siblingStageNeedleA = "角色开发";
  const siblingStageNeedleB = "分集目录";

  const switchingSequence = [
    { projectId: bridgeCopy1.projectId, title: bridgeCopy1.title, expectedSnapshotProjectId: bridgeCopy1.projectId, stage: bridgeStageNeedle },
    { projectId: siblingProjectB, title: siblingTitleB, expectedSnapshotProjectId: siblingProjectB, stage: siblingStageNeedleB },
    { projectId: bridgeCopy2.projectId, title: bridgeCopy2.title, expectedSnapshotProjectId: bridgeCopy2.projectId, stage: bridgeStageNeedle },
    { projectId: bridgeScriptProjectId, title: bridgeTitle, expectedSnapshotProjectId: videoProjectId, stage: bridgeStageNeedle },
    { projectId: siblingCopyA.projectId, title: siblingCopyA.title, expectedSnapshotProjectId: siblingCopyA.projectId, stage: siblingStageNeedleA },
    { projectId: siblingProjectA, title: siblingTitleA, expectedSnapshotProjectId: siblingProjectA, stage: siblingStageNeedleA },
  ];

  const preDeleteCycleSummaries = [];
  for (const step of switchingSequence) {
    await clickHistoryById(page, step.projectId);
    if (step.projectId === bridgeScriptProjectId) {
      await waitForStoredStudioSessionShell(page, step.projectId, step.expectedSnapshotProjectId, 15000);
    } else {
      await waitForStoredSessionProjectId(page, step.expectedSnapshotProjectId, 15000);
    }

    const storedSession = await readStoredStudioSession(page);
    const historyEntries = await listVisibleHistoryEntries(page);
    const activeEntry = historyEntries.find((entry) => entry.projectId === step.projectId) ?? null;
    const historyCount = await readSidebarHistoryCountState(page);

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `bridge duplicate-delete switching should keep ${step.projectId} as the active session shell`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.expectedSnapshotProjectId,
      `bridge duplicate-delete switching should restore the expected live snapshot for ${step.projectId}`,
    );
    assert.equal(
      activeEntry?.text?.includes(step.stage),
      true,
      `history card ${step.projectId} should keep exposing ${step.stage} before delete`,
    );
    assert.equal(
      historyCount.totalCount,
      6,
      "bridge duplicate-delete switching should keep the visible history count stable before delete",
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === videoProjectId),
      false,
      "bridge duplicate-delete switching should not surface the linked video project before delete",
    );

    preDeleteCycleSummaries.push({
      projectId: step.projectId,
      snapshotProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
      activeEntryText: activeEntry?.text ?? null,
    });
  }

  await clickHistoryById(page, bridgeCopy1.projectId);
  await waitForStoredSessionProjectId(page, bridgeCopy1.projectId, 15000);

  const deleteResult = await deleteHistoryProjectFromMenu(page, bridgeCopy1.projectId, {
    expectedDramaCountDelta: 0,
  });
  const afterDeleteHistoryEntries = await listVisibleHistoryEntries(page);
  const afterDeleteCount = await readSidebarHistoryCountState(page);
  const afterDeleteStoredProjectSessions = await readStoredProjectSessions(page);

  assert.equal(
    afterDeleteCount.totalCount,
    5,
    "bridge duplicate-delete scenario should show five visible history cards after deleting one bridged duplicate",
  );
  assert.equal(
    afterDeleteHistoryEntries.some((entry) => entry.projectId === bridgeCopy1.projectId),
    false,
    "the deleted bridged duplicate should disappear from visible history",
  );
  assert.equal(
    afterDeleteHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "deleting a bridged duplicate should not reveal the hidden linked video history card",
  );
  assert.equal(
    Boolean(afterDeleteStoredProjectSessions?.[videoProjectId]),
    false,
    "deleting a bridged duplicate should not create a project-scoped linked video history shell",
  );

  const recycledBridgeCopy = await duplicateHistoryProjectFromMenu(page, bridgeScriptProjectId, `${bridgeTitle} - 副本`, {
    expectedDramaCountDelta: 0,
  });
  const afterRecycleHistoryEntries = await listVisibleHistoryEntries(page);
  const afterRecycleCount = await readSidebarHistoryCountState(page);
  const afterRecycleStoredProjectSessions = await readStoredProjectSessions(page);

  assert.notEqual(
    recycledBridgeCopy.projectId,
    bridgeCopy1.projectId,
    "re-duplicating after deleting a bridged duplicate should create a fresh project id",
  );
  assert.equal(
    afterRecycleCount.totalCount,
    6,
    "bridge duplicate-delete scenario should return to six visible history cards after recreating the bridged duplicate",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === bridgeCopy1.projectId),
    false,
    "recreating a deleted bridged duplicate should not resurrect the old project id",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === recycledBridgeCopy.projectId),
    true,
    "the recreated bridged duplicate should appear as a visible history card",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "recreating a bridged duplicate should still keep the linked video card hidden",
  );
  assert.equal(
    Boolean(afterRecycleStoredProjectSessions?.[videoProjectId]),
    false,
    "recreating a bridged duplicate should still avoid creating a linked video project shell",
  );

  const postRecycleSwitchingSequence = [
    { projectId: recycledBridgeCopy.projectId, title: recycledBridgeCopy.title, expectedSnapshotProjectId: recycledBridgeCopy.projectId, stage: bridgeStageNeedle },
    { projectId: bridgeScriptProjectId, title: bridgeTitle, expectedSnapshotProjectId: videoProjectId, stage: bridgeStageNeedle },
    { projectId: bridgeCopy2.projectId, title: bridgeCopy2.title, expectedSnapshotProjectId: bridgeCopy2.projectId, stage: bridgeStageNeedle },
    { projectId: siblingProjectB, title: siblingTitleB, expectedSnapshotProjectId: siblingProjectB, stage: siblingStageNeedleB },
    { projectId: siblingCopyA.projectId, title: siblingCopyA.title, expectedSnapshotProjectId: siblingCopyA.projectId, stage: siblingStageNeedleA },
    { projectId: recycledBridgeCopy.projectId, title: recycledBridgeCopy.title, expectedSnapshotProjectId: recycledBridgeCopy.projectId, stage: bridgeStageNeedle },
  ];

  const postRecycleCycleSummaries = [];
  for (const step of postRecycleSwitchingSequence) {
    await clickHistoryById(page, step.projectId);
    if (step.projectId === bridgeScriptProjectId) {
      await waitForStoredStudioSessionShell(page, step.projectId, step.expectedSnapshotProjectId, 15000);
    } else {
      await waitForStoredSessionProjectId(page, step.expectedSnapshotProjectId, 15000);
    }

    const storedSession = await readStoredStudioSession(page);
    const historyEntries = await listVisibleHistoryEntries(page);
    const activeEntry = historyEntries.find((entry) => entry.projectId === step.projectId) ?? null;
    const historyCount = await readSidebarHistoryCountState(page);

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `bridge duplicate-delete switching should keep ${step.projectId} as the active shell after recycle`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.expectedSnapshotProjectId,
      `bridge duplicate-delete switching should restore the expected live snapshot for ${step.projectId} after recycle`,
    );
    assert.equal(
      activeEntry?.text?.includes(step.stage),
      true,
      `history card ${step.projectId} should keep exposing ${step.stage} after recycle`,
    );
    assert.equal(
      historyCount.totalCount,
      6,
      "bridge duplicate-delete switching should keep the visible history count stable after recycle",
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === videoProjectId),
      false,
      "bridge duplicate-delete switching should not surface the linked video project after recycle",
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === bridgeCopy1.projectId),
      false,
      "the deleted bridged duplicate should stay hidden after recycle switching",
    );

    postRecycleCycleSummaries.push({
      projectId: step.projectId,
      snapshotProjectId: storedSession?.currentProjectSnapshot?.projectId ?? null,
      activeEntryText: activeEntry?.text ?? null,
    });
  }

  return {
    ...baseline,
    bridgeCopy1,
    bridgeCopy2,
    siblingCopyA,
    deleteResult,
    recycledBridgeCopy,
    afterDuplicateCount,
    afterDuplicateHistoryEntries,
    afterDeleteCount,
    afterDeleteHistoryEntries,
    afterRecycleCount,
    afterRecycleHistoryEntries,
    preDeleteCycleSummaries,
    postRecycleCycleSummaries,
  };
}

async function runVideoWorkflowUseCurrentProjectDeleteOriginalBridgeAfterCopiesScenario(page) {
  const baseline = await runVideoWorkflowUseCurrentProjectMultiSessionSwitchScenario(page);
  const {
    bridgeScriptProjectId,
    siblingProjectA,
    siblingProjectB,
    videoProjectId,
  } = baseline;
  const bridgeTitle = "视频入口串联测试剧本";
  const siblingTitleA = "多会话切换测试 A";
  const siblingTitleB = "多会话切换测试 B";
  const bridgeStageNeedle = "脚本拆解";
  const siblingStageNeedleA = "角色开发";
  const siblingStageNeedleB = "分集目录";

  const bridgeCopy1 = await duplicateHistoryProjectFromMenu(page, bridgeScriptProjectId, `${bridgeTitle} - 副本`, {
    expectedDramaCountDelta: 0,
  });
  const bridgeCopy2 = await duplicateHistoryProjectFromMenu(page, bridgeScriptProjectId, `${bridgeTitle} - 副本2`, {
    expectedDramaCountDelta: 0,
  });
  const siblingCopyA = await duplicateHistoryProjectFromMenu(page, siblingProjectA, `${siblingTitleA} - 副本`);

  const beforeDeleteHistoryEntries = await listVisibleHistoryEntries(page);
  const beforeDeleteCount = await readSidebarHistoryCountState(page);

  assert.equal(
    beforeDeleteCount.totalCount,
    6,
    "bridge-original-delete scenario should show six visible history cards before deleting the original bridged shell",
  );
  assert.equal(
    beforeDeleteHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "the original bridged shell should keep the linked video project hidden before delete",
  );

  const preDeleteSwitchingSequence = [
    { projectId: bridgeCopy1.projectId, expectedSnapshotProjectId: bridgeCopy1.projectId, stage: bridgeStageNeedle },
    { projectId: siblingProjectB, expectedSnapshotProjectId: siblingProjectB, stage: siblingStageNeedleB },
    { projectId: bridgeScriptProjectId, expectedSnapshotProjectId: videoProjectId, stage: bridgeStageNeedle },
    { projectId: siblingCopyA.projectId, expectedSnapshotProjectId: siblingCopyA.projectId, stage: siblingStageNeedleA },
  ];

  for (const step of preDeleteSwitchingSequence) {
    await clickHistoryById(page, step.projectId);
    if (step.projectId === bridgeScriptProjectId) {
      await waitForStoredStudioSessionShell(page, step.projectId, step.expectedSnapshotProjectId, 15000);
    } else {
      await waitForStoredSessionProjectId(page, step.expectedSnapshotProjectId, 15000);
    }

    const historyEntries = await listVisibleHistoryEntries(page);
    const activeEntry = historyEntries.find((entry) => entry.projectId === step.projectId) ?? null;
    assert.equal(
      activeEntry?.text?.includes(step.stage),
      true,
      `history card ${step.projectId} should keep rendering ${step.stage} before deleting the original bridged shell`,
    );
  }

  await clickHistoryById(page, bridgeScriptProjectId);
  await waitForStoredStudioSessionShell(page, bridgeScriptProjectId, videoProjectId, 15000);

  const deleteResult = await deleteHistoryProjectFromMenu(page, bridgeScriptProjectId);
  const afterDeleteHistoryEntries = await listVisibleHistoryEntries(page);
  const afterDeleteCount = await readSidebarHistoryCountState(page);
  const afterDeleteDramaProjects = await readStoredDramaProjects(page);
  const afterDeleteStoredProjectSessions = await readStoredProjectSessions(page);

  assert.equal(
    afterDeleteCount.totalCount,
    5,
    "deleting the original bridged shell should reduce the visible history count to five instead of surfacing an extra linked video card",
  );
  assert.equal(
    afterDeleteHistoryEntries.some((entry) => entry.projectId === bridgeScriptProjectId),
    false,
    "deleting the original bridged shell should remove its visible history card",
  );
  assert.equal(
    afterDeleteHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "deleting the original bridged shell should keep the linked video project hidden from visible history",
  );
  assert.equal(
    afterDeleteDramaProjects.some((project) => project?.id === bridgeScriptProjectId),
    false,
    "deleting the original bridged shell should remove the source drama project from storage",
  );
  assert.equal(
    Boolean(afterDeleteStoredProjectSessions?.[videoProjectId]),
    false,
    "deleting the original bridged shell should not create a project-scoped linked video session shell",
  );

  const siblingCopyA2 = await duplicateHistoryProjectFromMenu(page, siblingProjectA, `${siblingTitleA} - 副本2`);
  const afterRecycleHistoryEntries = await listVisibleHistoryEntries(page);
  const afterRecycleCount = await readSidebarHistoryCountState(page);

  assert.equal(
    afterRecycleCount.totalCount,
    6,
    "deleting the original bridged shell and duplicating again should restore the visible history count to six without extra cards",
  );
  assert.equal(
    afterRecycleHistoryEntries.some((entry) => entry.projectId === videoProjectId),
    false,
    "duplicating after deleting the original bridged shell should still keep the linked video project hidden",
  );

  const postDeleteSwitchingSequence = [
    { projectId: bridgeCopy2.projectId, expectedSnapshotProjectId: bridgeCopy2.projectId, stage: bridgeStageNeedle },
    { projectId: siblingProjectB, expectedSnapshotProjectId: siblingProjectB, stage: siblingStageNeedleB },
    { projectId: siblingCopyA2.projectId, expectedSnapshotProjectId: siblingCopyA2.projectId, stage: siblingStageNeedleA },
    { projectId: bridgeCopy1.projectId, expectedSnapshotProjectId: bridgeCopy1.projectId, stage: bridgeStageNeedle },
  ];

  for (const step of postDeleteSwitchingSequence) {
    await clickHistoryById(page, step.projectId);
    await waitForStoredSessionProjectId(page, step.expectedSnapshotProjectId, 15000);

    const storedSession = await readStoredStudioSession(page);
    const historyEntries = await listVisibleHistoryEntries(page);
    const activeEntry = historyEntries.find((entry) => entry.projectId === step.projectId) ?? null;
    const historyCount = await readSidebarHistoryCountState(page);

    assert.equal(
      storedSession?.projectId,
      step.projectId,
      `switching after deleting the original bridged shell should keep ${step.projectId} as the active shell`,
    );
    assert.equal(
      storedSession?.currentProjectSnapshot?.projectId,
      step.expectedSnapshotProjectId,
      `switching after deleting the original bridged shell should keep ${step.projectId} aligned with its live snapshot`,
    );
    assert.equal(
      activeEntry?.text?.includes(step.stage),
      true,
      `history card ${step.projectId} should keep rendering ${step.stage} after deleting the original bridged shell`,
    );
    assert.equal(
      historyCount.totalCount,
      6,
      "switching after deleting the original bridged shell should keep the visible history count stable",
    );
    assert.equal(
      historyEntries.some((entry) => entry.projectId === videoProjectId),
      false,
      "switching after deleting the original bridged shell should not surface the linked video project",
    );
  }

  return {
    ...baseline,
    bridgeCopy1,
    bridgeCopy2,
    siblingCopyA,
    deleteResult,
    siblingCopyA2,
    afterDeleteCount,
    afterDeleteHistoryEntries,
    afterRecycleCount,
    afterRecycleHistoryEntries,
  };
}

async function runSeededBridgedHistoryOrderStableScenario(page) {
  const bridgeScriptProjectId = "drama-project-bridge-order-seeded";
  const videoProjectId = "video-project-bridge-order-seeded";
  const siblingProjectA = "drama-project-bridge-order-sibling-a";
  const siblingProjectB = "drama-project-bridge-order-sibling-b";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [
      createVideoEntryDramaProject(bridgeScriptProjectId),
      createHistorySwitchDramaProject({
        projectId: siblingProjectA,
        title: "多会话切换测试 A",
        currentStep: "characters",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      createHistorySwitchDramaProject({
        projectId: siblingProjectB,
        title: "多会话切换测试 B",
        currentStep: "outlines",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    ],
    [VIDEO_PROJECTS_KEY]: [
      {
        ...createVideoProject(videoProjectId),
        title: "视频入口串联测试剧本",
        sourceProjectId: bridgeScriptProjectId,
        updatedAt: "2026-05-18T09:30:00.000Z",
      },
    ],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [bridgeScriptProjectId]: createBridgedVideoEntrySession(bridgeScriptProjectId, videoProjectId),
      [siblingProjectA]: createHistorySwitchSession({
        projectId: siblingProjectA,
        title: "多会话切换测试 A",
        assistantText: "A 会话停留在角色开发阶段，等待继续补角色设定。",
        currentObjective: "继续角色开发",
        derivedStage: "角色开发",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      [siblingProjectB]: createHistorySwitchSession({
        projectId: siblingProjectB,
        title: "多会话切换测试 B",
        assistantText: "B 会话停留在分集目录阶段，等待继续补齐目录。",
        currentObjective: "继续分集目录",
        derivedStage: "分集目录",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    },
    [STUDIO_SESSION_KEY]: createBridgedVideoEntrySession(bridgeScriptProjectId, videoProjectId),
  });

  await page.waitForFunction(
    ([scriptId, hiddenVideoId]) => {
      const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .filter(Boolean);
      return visibleIds.includes(scriptId) && !visibleIds.includes(hiddenVideoId) && visibleIds.length === 3;
    },
    [bridgeScriptProjectId, videoProjectId],
    { timeout: 15000 },
  );

  const baselineEntries = await listVisibleHistoryEntries(page);
  const baselineOrder = baselineEntries.map((entry) => entry.projectId);
  assert.deepEqual(
    [...baselineOrder].sort(),
    [siblingProjectA, siblingProjectB, bridgeScriptProjectId].sort(),
    "seeded bridged history should expose exactly the bridged script shell plus the two visible sibling cards",
  );

  await clickHistoryById(page, siblingProjectA);
  await waitForStoredSessionProjectId(page, siblingProjectA, 15000);
  await clickHistoryById(page, bridgeScriptProjectId);
  await waitForStoredStudioSessionShell(page, bridgeScriptProjectId, videoProjectId, 15000);

  const afterSwitchEntries = await listVisibleHistoryEntries(page);
  const afterSwitchOrder = afterSwitchEntries.map((entry) => entry.projectId);
  assert.deepEqual(
    afterSwitchOrder,
    baselineOrder,
    "switching across a bridged script shell should not reshuffle visible history cards",
  );

  await clickHistoryById(page, bridgeScriptProjectId);
  await waitForStoredStudioSessionShell(page, bridgeScriptProjectId, videoProjectId, 15000);

  const deleteResult = await deleteHistoryProjectFromMenu(page, bridgeScriptProjectId);
  const afterDeleteEntries = await listVisibleHistoryEntries(page);
  const afterDeleteOrder = afterDeleteEntries.map((entry) => entry.projectId);

  assert.deepEqual(
    afterDeleteOrder,
    baselineOrder.filter((projectId) => projectId !== bridgeScriptProjectId),
    "deleting the bridged source-script shell should keep the remaining history cards in their prior relative order",
  );
  assert.equal(
    afterDeleteOrder.includes(videoProjectId),
    false,
    "deleting the bridged source-script shell should not surface the hidden linked video card",
  );

  return {
    baselineOrder,
    afterSwitchOrder,
    afterDeleteOrder,
    deleteResult,
  };
}

async function runVideoWorkflowUseCurrentProjectOrderStableOnClickScenario(page) {
  const bridgeScriptProjectId = "drama-project-bridge-order-click";
  const siblingProjectA = "drama-project-bridge-click-sibling-a";
  const siblingProjectB = "drama-project-bridge-click-sibling-b";

  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [
      createVideoEntryDramaProject(bridgeScriptProjectId),
      createHistorySwitchDramaProject({
        projectId: siblingProjectA,
        title: "多会话点击顺序测试 A",
        currentStep: "characters",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      createHistorySwitchDramaProject({
        projectId: siblingProjectB,
        title: "多会话点击顺序测试 B",
        currentStep: "outlines",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    ],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [bridgeScriptProjectId]: createVideoEntrySession(bridgeScriptProjectId),
      [siblingProjectA]: createHistorySwitchSession({
        projectId: siblingProjectA,
        title: "多会话点击顺序测试 A",
        assistantText: "A 会话停留在角色开发阶段，等待继续补角色设定。",
        currentObjective: "继续角色开发",
        derivedStage: "角色开发",
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
      [siblingProjectB]: createHistorySwitchSession({
        projectId: siblingProjectB,
        title: "多会话点击顺序测试 B",
        assistantText: "B 会话停留在分集目录阶段，等待继续补齐目录。",
        currentObjective: "继续分集目录",
        derivedStage: "分集目录",
        updatedAt: "2026-04-07T00:00:00.000Z",
      }),
    },
    [STUDIO_SESSION_KEY]: createVideoEntrySession(bridgeScriptProjectId),
    [VIDEO_PROJECTS_KEY]: [],
  });

  await page.waitForFunction(
    ([scriptId]) => {
      const visibleIds = Array.from(document.querySelectorAll("[data-sidebar-history-id]"))
        .map((element) => element.getAttribute("data-sidebar-history-id") || "")
        .filter(Boolean);
      return visibleIds.includes(scriptId) && visibleIds.length === 3;
    },
    [bridgeScriptProjectId],
    { timeout: 15000 },
  );

  const baselineEntries = await listVisibleHistoryEntries(page);
  const baselineOrder = baselineEntries.map((entry) => entry.projectId);
  assert.deepEqual(
    [...baselineOrder].sort(),
    [siblingProjectA, siblingProjectB, bridgeScriptProjectId].sort(),
    "pre-bridge history should expose exactly the active script plus the two seeded sibling cards",
  );

  await page.getByRole("button", { name: "用于视频创作" }).last().click();
  await page.getByRole("button", { name: "使用当前剧本项目" }).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await page.getByRole("button", { name: "使用当前剧本项目" }).last().click();

  await Promise.race([
    page.getByText("请选择单集时长").first().waitFor({ state: "visible", timeout: 15000 }),
    page.waitForTimeout(2500),
  ]);

  const afterClickEntries = await listVisibleHistoryEntries(page);
  const afterClickOrder = afterClickEntries.map((entry) => entry.projectId);
  const afterClickHistoryCount = await readSidebarHistoryCountState(page);

  assert.deepEqual(
    afterClickOrder,
    baselineOrder,
    "choosing use-current-script should not reshuffle the visible history cards before the next video step opens",
  );
  assert.equal(
    afterClickHistoryCount.totalCount,
    3,
    "choosing use-current-script should keep the same visible history-card count",
  );

  return {
    baselineOrder,
    afterClickOrder,
    afterClickHistoryCount,
  };
}

async function runHeavyAssetLibraryScenarioHistoryBacked(page) {
  const assetProjectId = "video-project-asset-stress";
  const assetCount = 220;
  const session = createAssetStressSession(assetProjectId, assetCount);

  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createAssetStressVideoProject(assetProjectId, assetCount)],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      [assetProjectId]: session,
    },
  });

  await openHistoryProject(page, "素材压力测试项目");
  await page.locator("[data-sidebar-asset-list='image']").first().waitFor({
    state: "visible",
    timeout: 10000,
  });

  const listVisibleAssetLabels = async () =>
    page.evaluate(() => {
      const container = document.querySelector("[data-sidebar-asset-list='image']");
      if (!(container instanceof HTMLElement)) return [];
      return container.innerText
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line.includes("压力素材"));
    });

  const initialAssetLabels = await listVisibleAssetLabels();
  if (!initialAssetLabels.length) {
    await page.waitForTimeout(300);
  }
  const stabilizedInitialAssetLabels = initialAssetLabels.length
    ? initialAssetLabels
    : await listVisibleAssetLabels();
  const initialRenderedCount = stabilizedInitialAssetLabels.length;
  assert.ok(
    initialRenderedCount > 0 && initialRenderedCount < assetCount,
    `large asset library should keep initial DOM bounded, got ${initialRenderedCount} for ${assetCount} assets`,
  );

  const loadMoreButton = page.locator("[data-sidebar-load-more='image-assets']").first();
  if (await loadMoreButton.isVisible().catch(() => false)) {
    await loadMoreButton.click();
  }
  await page.waitForTimeout(200);
  const expandedAssetLabels = await listVisibleAssetLabels();
  assert.ok(
    expandedAssetLabels.length >= stabilizedInitialAssetLabels.length,
    "loading more assets should not reduce the number of visible asset cards",
  );
  const targetAssetLabel = expandedAssetLabels.at(-1) ?? stabilizedInitialAssetLabels.at(-1);
  assert.ok(targetAssetLabel, "asset library should keep at least one visible asset card");

  await page.getByRole("button", { name: new RegExp(`^${escapeRegExp(targetAssetLabel)}$`) }).first().click();
  await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText(targetAssetLabel).first().waitFor({ state: "visible", timeout: 10000 });

  return {
    totalAssets: assetCount,
    initialRenderedCount,
    expandedRenderedCount: expandedAssetLabels.length,
    openedAssetLabel: targetAssetLabel,
  };
}

async function runRealFullAutoVideoWorkflowReferenceAssetScenarioV2(page) {
  const scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll("button")).some((candidate) => {
      if (!(candidate instanceof HTMLButtonElement)) return false;
      const name = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`;
      return name.includes("发送") && !candidate.disabled;
    });
  }, undefined, { timeout: 30000 });
  await sendButton.click();

  {
    const kickoffDeadline = Date.now() + 30000;
    let kickoffReady = false;
    while (Date.now() < kickoffDeadline) {
      const checklistVisible = await page
        .locator('[data-testid="full-auto-message-checklist"]')
        .first()
        .isVisible()
        .catch(() => false);
      const visibleQuestion = await readVisibleComposerQuestion(page);
      if (checklistVisible || visibleQuestion) {
        kickoffReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert.equal(
      kickoffReady,
      true,
      "real full-auto video run should surface either the checklist or the next question after upload",
    );
  }

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;

  const clickQuestionButtonContaining = async (question, keywords) => {
    const label = findVisibleComposerQuestionActionLabel(question, keywords);
    if (!label) {
      throw new Error(`No matching button for keywords ${keywords.join(", ")}: ${JSON.stringify(question, null, 2)}`);
    }
    await clickVisibleComposerQuestionButton(page, [label]);
  };

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real full-auto video question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickQuestionButtonContaining(question, ["60"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickQuestionButtonContaining(question, ["中", "默认"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickQuestionButtonContaining(question, ["跳过", "最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickQuestionButtonContaining(question, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await sendFreeformText(page, "电影级冷蓝夜景，写实人物，镜头动势明确，适合短剧高张力预告。");
    } else if (answerKey === "full-auto-preflight:referenceAssets" && referenceAssetMode === "skip") {
      await clickVisibleComposerQuestionButton(page, ["跳过参考资产，直接文生视频"]);
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickQuestionButtonContaining(question, ["智能", "补齐", "参考资产"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await submitComposerTextWithoutEcho(page, "镜头提示词路线");
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else if (question.visibleButtons.some((label) => label.includes("全部镜头提示词"))) {
        await clickQuestionButtonContaining(question, ["全部镜头提示词", "全部镜头"]);
      } else {
        await clickQuestionButtonContaining(question, ["全部片段提示词", "全部"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickQuestionButtonContaining(question, ["AI", "自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickQuestionButtonContaining(question, ["不自动加字幕", "不自动"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickQuestionButtonContaining(question, ["选择导出目录", "导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto video question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto video run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto video run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto video run should persist a final video project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto video run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto video run should produce at least one segment video");
  const manifestItems = Array.isArray(storedVideoProject?.assetManifest?.items)
    ? storedVideoProject.assetManifest.items.filter((item) => trimString(item?.url))
    : [];
  const referenceManifestItems = manifestItems.filter((item) =>
    [
      "character-reference",
      "costume-reference",
      "scene-reference",
      "time-variant",
    ].includes(item.kind),
  );
  const referenceSlots = [
    ...(storedVideoProject?.characters ?? []).flatMap((character) => [
      {
        kind: "character",
        label: character.name,
        url: trimString(character.imageUrl),
        historyCount: Array.isArray(character.imageHistory) ? character.imageHistory.length : 0,
      },
      ...((character.costumes ?? []).map((costume) => ({
        kind: "character-variant",
        label: `${character.name} · ${costume.label}`,
        url: trimString(costume.imageUrl),
        historyCount: Array.isArray(costume.imageHistory) ? costume.imageHistory.length : 0,
      }))),
    ]),
    ...(storedVideoProject?.sceneSettings ?? []).flatMap((sceneSetting) => [
      {
        kind: "scene",
        label: sceneSetting.name,
        url: trimString(sceneSetting.imageUrl),
        historyCount: Array.isArray(sceneSetting.imageHistory) ? sceneSetting.imageHistory.length : 0,
      },
      ...((sceneSetting.timeVariants ?? []).map((variant) => ({
        kind: "scene-variant",
        label: `${sceneSetting.name} · ${variant.label}`,
        url: trimString(variant.imageUrl),
        historyCount: Array.isArray(variant.imageHistory) ? variant.imageHistory.length : 0,
      }))),
    ]),
  ];
  const missingReferenceSlots = referenceSlots.filter((slot) => !slot.url);
  const regeneratedReferenceSlots = referenceSlots.filter((slot) => slot.historyCount > 0);
  if (referenceAssetMode !== "skip") {
    assert.equal(
      missingReferenceSlots.length,
      0,
      `real full-auto video run should auto-fill every reference asset slot, missing=${JSON.stringify(missingReferenceSlots)}`,
    );
    assert.equal(
      regeneratedReferenceSlots.length,
      0,
      `real full-auto video run should not regenerate already-filled reference assets in a later batch, regenerated=${JSON.stringify(regeneratedReferenceSlots)}`,
    );
    assert.equal(
      referenceManifestItems.length,
      referenceSlots.length,
      `real full-auto video run should archive every reference asset exactly once, manifest=${referenceManifestItems.length}, slots=${referenceSlots.length}`,
    );
  }

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
    referenceAssets: {
      mode: referenceAssetMode,
      manifestCount: referenceManifestItems.length,
      slotCount: referenceSlots.length,
    },
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runRealFullAutoVideoWorkflowReferenceAssetScenarioV3(page) {
  const scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll("button")).some((candidate) => {
      if (!(candidate instanceof HTMLButtonElement)) return false;
      const name = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`;
      return name.includes("发送") && !candidate.disabled;
    });
  }, undefined, { timeout: 30000 });
  await sendButton.click();

  {
    const kickoffDeadline = Date.now() + 30000;
    let kickoffReady = false;
    while (Date.now() < kickoffDeadline) {
      const checklistVisible = await page
        .locator('[data-testid="full-auto-message-checklist"]')
        .first()
        .isVisible()
        .catch(() => false);
      const visibleQuestion = await readVisibleComposerQuestion(page);
      if (checklistVisible || visibleQuestion) {
        kickoffReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert.equal(
      kickoffReady,
      true,
      "real full-auto video run should surface either the checklist or the next question after upload",
    );
  }

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;

  const clickQuestionButtonContaining = async (question, keywords) => {
    const label = findVisibleComposerQuestionActionLabel(question, keywords);
    if (!label) {
      throw new Error(`No matching button for keywords ${keywords.join(", ")}: ${JSON.stringify(question, null, 2)}`);
    }
    await clickVisibleComposerQuestionButton(page, [label]);
  };

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real full-auto video question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickQuestionButtonContaining(question, ["60"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickQuestionButtonContaining(question, ["中", "默认"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickQuestionButtonContaining(question, ["跳过", "最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickQuestionButtonContaining(question, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await sendFreeformTextReliable(page, "电影级冷蓝夜景，写实人物，镜头动势明确，适合短剧高张力预告。");
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickQuestionButtonContaining(question, ["智能", "补齐", "参考资产"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickQuestionButtonContaining(question, ["全部片段提示词", "全部"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickQuestionButtonContaining(question, ["AI", "自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickQuestionButtonContaining(question, ["不自动加字幕", "不自动"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickQuestionButtonContaining(question, ["选择导出目录", "导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto video question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto video run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto video run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto video run should persist a final video project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto video run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto video run should produce at least one segment video");
  const manifestItems = Array.isArray(storedVideoProject?.assetManifest?.items)
    ? storedVideoProject.assetManifest.items.filter((item) => trimString(item?.url))
    : [];
  const referenceManifestItems = manifestItems.filter((item) =>
    [
      "character-reference",
      "costume-reference",
      "scene-reference",
      "time-variant",
    ].includes(item.kind),
  );
  const referenceSlots = [
    ...(storedVideoProject?.characters ?? []).flatMap((character) => [
      {
        kind: "character",
        label: character.name,
        url: trimString(character.imageUrl),
        historyCount: Array.isArray(character.imageHistory) ? character.imageHistory.length : 0,
      },
      ...((character.costumes ?? []).map((costume) => ({
        kind: "character-variant",
        label: `${character.name} · ${costume.label}`,
        url: trimString(costume.imageUrl),
        historyCount: Array.isArray(costume.imageHistory) ? costume.imageHistory.length : 0,
      }))),
    ]),
    ...(storedVideoProject?.sceneSettings ?? []).flatMap((sceneSetting) => [
      {
        kind: "scene",
        label: sceneSetting.name,
        url: trimString(sceneSetting.imageUrl),
        historyCount: Array.isArray(sceneSetting.imageHistory) ? sceneSetting.imageHistory.length : 0,
      },
      ...((sceneSetting.timeVariants ?? []).map((variant) => ({
        kind: "scene-variant",
        label: `${sceneSetting.name} · ${variant.label}`,
        url: trimString(variant.imageUrl),
        historyCount: Array.isArray(variant.imageHistory) ? variant.imageHistory.length : 0,
      }))),
    ]),
  ];
  const missingReferenceSlots = referenceSlots.filter((slot) => !slot.url);
  const regeneratedReferenceSlots = referenceSlots.filter((slot) => slot.historyCount > 0);
  assert.equal(
    missingReferenceSlots.length,
    0,
    `real full-auto video run should auto-fill every reference asset slot, missing=${JSON.stringify(missingReferenceSlots)}`,
  );
  assert.equal(
    regeneratedReferenceSlots.length,
    0,
    `real full-auto video run should not regenerate already-filled reference assets in a later batch, regenerated=${JSON.stringify(regeneratedReferenceSlots)}`,
  );
  assert.equal(
    referenceManifestItems.length,
    referenceSlots.length,
    `real full-auto video run should archive every reference asset exactly once, manifest=${referenceManifestItems.length}, slots=${referenceSlots.length}`,
  );

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
    referenceAssets: {
      manifestCount: referenceManifestItems.length,
      slotCount: referenceSlots.length,
    },
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runRealFullAutoVideoWorkflowReferenceAssetScenarioV4(page, options = {}) {
  const referenceAssetMode = options.referenceAssetMode === "skip" ? "skip" : "smart-fill";
  const scriptFilePath = FULL_AUTO_ADAPTATION_REFERENCE_DOCX;
  assert.ok(await pathExists(scriptFilePath), `Missing real workflow input file: ${scriptFilePath}`);
  const realVideoPrefsSeed = resolveRealSmokeVideoPrefsSeed();
  const realTextModelSeed = resolveRealSmokeTextModelSeed();

  await resetAndSeed(
    page,
    {
      [DRAMA_PROJECTS_KEY]: [],
      [STUDIO_PROJECT_SESSIONS_KEY]: {},
      [STUDIO_SESSION_KEY]: createFreshHomepageSession({
        selectedTextModelKey: realTextModelSeed,
        selectedVideoModelKey:
          typeof realVideoPrefsSeed?.modelKey === "string" ? realVideoPrefsSeed.modelKey : undefined,
        videoGenerationPrefs: realVideoPrefsSeed,
      }),
      [VIDEO_PROJECTS_KEY]: [],
      [VIDEO_PREFS_KEY]: realVideoPrefsSeed,
    },
    {
      rawSeed: {
        [TEXT_MODEL_KEY]: realTextModelSeed,
      },
    },
  );
  await page.evaluate(
    ([currentProjectKey, scenarioKey, traceKey]) => {
      window.localStorage.removeItem(currentProjectKey);
      window.localStorage.removeItem(scenarioKey);
      window.localStorage.removeItem(traceKey);
    },
    [CURRENT_PROJECT_KEY, WORKFLOW_TEST_SCENARIO_KEY, WORKFLOW_TEST_TRACE_KEY],
  );

  const exportDir = await readElectronSelectedFolder(page);
  assert.ok(exportDir, "electron storage.selectFolder should resolve through the configured export directory");
  await ensureDirectory(exportDir);
  const exportFilesBefore = await listFilesRecursive(exportDir);

  await switchAutomationMode(page, "full-auto");
  await waitForVisibleButtonLabels(page, ["视频工作流"], 10000);
  await clickVisibleButtonByLabels(page, ["视频工作流"]);
  await waitForVisibleButtonLabels(page, ["上传剧本文档"], 15000);
  await clickVisibleButtonByLabels(page, ["上传剧本文档"]);
  await page.getByText(/上传你的剧本文档|上传剧本文档/).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  await attachFilesWithChooser(page, scriptFilePath);
  const sendButton = sendButtonLocator(page);
  await sendButton.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll("button")).some((candidate) => {
      if (!(candidate instanceof HTMLButtonElement)) return false;
      const name = `${candidate.getAttribute("aria-label") || ""} ${candidate.textContent || ""}`;
      return name.includes("发送") && !candidate.disabled;
    });
  }, undefined, { timeout: 30000 });
  await sendButton.click();

  {
    const kickoffDeadline = Date.now() + 30000;
    let kickoffReady = false;
    while (Date.now() < kickoffDeadline) {
      const checklistVisible = await page
        .locator('[data-testid="full-auto-message-checklist"]')
        .first()
        .isVisible()
        .catch(() => false);
      const visibleQuestion = await readVisibleComposerQuestion(page);
      if (checklistVisible || visibleQuestion) {
        kickoffReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert.equal(
      kickoffReady,
      true,
      "real full-auto video run should surface either the checklist or the next question after upload",
    );
  }

  const handledQuestionKeys = [];
  const questionRepeatCounts = new Map();
  let executionStarted = false;
  const deadline = Date.now() + REAL_FULL_AUTO_TIMEOUT_MS;
  const customVideoStyle = "电影级写实都市夜景，低饱和胶片质感，人物压迫感更强。";

  const clickQuestionButtonContaining = async (question, keywords) => {
    const label = findVisibleComposerQuestionActionLabel(question, keywords);
    if (!label) {
      throw new Error(`No matching button for keywords ${keywords.join(", ")}: ${JSON.stringify(question, null, 2)}`);
    }
    await clickVisibleComposerQuestionButton(page, [label]);
  };

  while (Date.now() < deadline) {
    const currentSession = await readStoredStudioSession(page);
    if (
      currentSession?.fullAutoRun?.status === "completed" &&
      currentSession?.currentProjectSnapshot?.projectKind === "video" &&
      trimString(currentSession?.currentProjectSnapshot?.projectId)
    ) {
      break;
    }

    const question = await readVisibleComposerQuestion(page);
    if (!question) {
      await page.waitForTimeout(250);
      continue;
    }

    const answerKey = question.answerKey || question.questionId || question.text;
    const questionRepeatSignature = buildComposerQuestionRepeatSignature(question);
    handledQuestionKeys.push(answerKey);
    questionRepeatCounts.set(
      questionRepeatSignature,
      (questionRepeatCounts.get(questionRepeatSignature) ?? 0) + 1,
    );

    if ((questionRepeatCounts.get(questionRepeatSignature) ?? 0) >= 6 && !executionStarted) {
      throw new Error(
        `Real full-auto video question did not advance: ${answerKey}\n${JSON.stringify(question, null, 2)}`,
      );
    }

    if (answerKey === "full-auto-preflight:adaptationEpisodeCount") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable adaptationEpisodeCount button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "recovery") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable recovery button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoAnalyze") {
      await clickQuestionButtonContaining(question, ["60"]);
    } else if (answerKey === "full-auto-preflight:videoAnalyzeDetail") {
      await clickQuestionButtonContaining(question, ["中", "默认"]);
    } else if (answerKey === "full-auto-preflight:storyboardXlsxExport") {
      await clickQuestionButtonContaining(question, ["跳过", "最后一起导出"]);
    } else if (answerKey === "full-auto-preflight:videoMode") {
      await clickQuestionButtonContaining(question, ["文生视频"]);
    } else if (answerKey === "full-auto-preflight:videoStyle") {
      await submitComposerTextWithoutEcho(page, customVideoStyle);
    } else if (answerKey === "full-auto-preflight:referenceAssets") {
      await clickQuestionButtonContaining(question, ["智能", "补齐", "参考资产"]);
    } else if (answerKey === "full-auto-preflight:videoPrompts") {
      await clickVisibleComposerQuestionButton(page, ["片段提示词路线"]);
    } else if (answerKey === "full-auto-preflight:videoPromptsDetail") {
      if (question.visibleButtons.some((label) => label.includes("按集生成片段提示词"))) {
        await submitVisibleComposerQuestionChildInput(page, ["按集生成片段提示词"], "EP01", ["确认集数"]);
      } else {
        await clickQuestionButtonContaining(question, ["全部片段提示词", "全部"]);
      }
    } else if (answerKey === "full-auto-preflight:videoGeneration") {
      const fallbackLabel = getFirstActionableComposerButtonLabel(question);
      if (!fallbackLabel) {
        throw new Error(`No actionable video generation button: ${JSON.stringify(question, null, 2)}`);
      }
      await clickVisibleComposerQuestionButton(page, [fallbackLabel]);
    } else if (answerKey === "full-auto-preflight:videoExport") {
      await clickQuestionButtonContaining(question, ["AI", "自动处理导出"]);
    } else if (answerKey === "full-auto-preflight:videoExportDetail") {
      await clickQuestionButtonContaining(question, ["不自动加字幕", "不自动"]);
    } else if (answerKey === "full-auto-preflight:videoExportPath") {
      if (question.visibleButtons.some((label) => label.includes("确认使用该导出目录"))) {
        await clickVisibleComposerQuestionButton(page, ["确认使用该导出目录"]);
      } else {
        await clickQuestionButtonContaining(question, ["选择导出目录", "导出目录"]);
      }
      executionStarted = true;
    } else if (executionStarted) {
      await page.waitForTimeout(500);
      continue;
    } else {
      throw new Error(`Unexpected real full-auto video question: ${JSON.stringify(question, null, 2)}`);
    }

    await page.waitForTimeout(200);
  }

  const completionSession = await waitForRealFullAutoCompletion(page);
  const finalSnapshot = completionSession?.currentProjectSnapshot ?? null;
  assert.equal(completionSession?.automationMode, "full-auto", "real full-auto video run should persist full-auto mode");
  assert.equal(finalSnapshot?.projectKind, "video", "real full-auto video run should end on a video project");
  assert.ok(finalSnapshot?.projectId, "real full-auto video run should persist a final video project id");

  const storedVideoProject = await readStoredVideoProject(page, finalSnapshot.projectId);
  assert.ok(storedVideoProject, "real full-auto video run should persist the final video project");
  const segmentVideoEntries = Object.entries(storedVideoProject?.segmentVideos ?? {}).filter(([, value]) =>
    trimString(value),
  );
  assert.ok(segmentVideoEntries.length > 0, "real full-auto video run should produce at least one segment video");
  const manifestItems = Array.isArray(storedVideoProject?.assetManifest?.items)
    ? storedVideoProject.assetManifest.items.filter((item) => trimString(item?.url))
    : [];
  const referenceManifestItems = manifestItems.filter((item) =>
    [
      "character-reference",
      "costume-reference",
      "scene-reference",
      "time-variant",
    ].includes(item.kind),
  );
  const referenceSlots = [
    ...(storedVideoProject?.characters ?? []).flatMap((character) => [
      {
        kind: "character",
        label: character.name,
        url: trimString(character.imageUrl),
        historyCount: Array.isArray(character.imageHistory) ? character.imageHistory.length : 0,
      },
      ...((character.costumes ?? []).map((costume) => ({
        kind: "character-variant",
        label: `${character.name} · ${costume.label}`,
        url: trimString(costume.imageUrl),
        historyCount: Array.isArray(costume.imageHistory) ? costume.imageHistory.length : 0,
      }))),
    ]),
    ...(storedVideoProject?.sceneSettings ?? []).flatMap((sceneSetting) => [
      {
        kind: "scene",
        label: sceneSetting.name,
        url: trimString(sceneSetting.imageUrl),
        historyCount: Array.isArray(sceneSetting.imageHistory) ? sceneSetting.imageHistory.length : 0,
      },
      ...((sceneSetting.timeVariants ?? []).map((variant) => ({
        kind: "scene-variant",
        label: `${sceneSetting.name} · ${variant.label}`,
        url: trimString(variant.imageUrl),
        historyCount: Array.isArray(variant.imageHistory) ? variant.imageHistory.length : 0,
      }))),
    ]),
  ];
  const missingReferenceSlots = referenceSlots.filter((slot) => !slot.url);
  const regeneratedReferenceSlots = referenceSlots.filter((slot) => slot.historyCount > 0);
  assert.equal(
    missingReferenceSlots.length,
    0,
    `real full-auto video run should auto-fill every reference asset slot, missing=${JSON.stringify(missingReferenceSlots)}`,
  );
  assert.equal(
    regeneratedReferenceSlots.length,
    0,
    `real full-auto video run should not regenerate already-filled reference assets in a later batch, regenerated=${JSON.stringify(regeneratedReferenceSlots)}`,
  );
  assert.equal(
    referenceManifestItems.length,
    referenceSlots.length,
    `real full-auto video run should archive every reference asset exactly once, manifest=${referenceManifestItems.length}, slots=${referenceSlots.length}`,
  );

  const exportFilesAfter = await waitForExportArtifacts(exportDir, exportFilesBefore.length, 120_000);
  const exportedFiles = diffArtifactFiles(exportFilesBefore, exportFilesAfter);

  return {
    handledQuestionKeys,
    finalProjectId: finalSnapshot?.projectId ?? null,
    sourceProjectId: finalSnapshot?.sourceProjectId ?? null,
    exportDir,
    scriptFilePath,
    referenceAssets: {
      manifestCount: referenceManifestItems.length,
      slotCount: referenceSlots.length,
    },
    segmentVideos: segmentVideoEntries.map(([label, value]) => ({ label, value })),
    exportedFiles: exportedFiles.map((entry) => entry.relativePath),
  };
}

async function runRealFullAutoVideoWorkflowSkipReferenceAssetScenario(page) {
  return runRealFullAutoVideoWorkflowReferenceAssetScenarioV4(page, {
    referenceAssetMode: "skip",
  });
}

async function main() {
  const server = await ensureServer();
  const consoleLogs = [];
  const pageErrors = [];

  try {
    sharedDesktopSeed = await readSavedDesktopSeed(DEFAULT_URL);
    sharedDesktopApiConfigRaw =
      trimString(sharedDesktopSeed?.apiConfigRaw) || await readSavedDesktopApiConfigRaw(DEFAULT_URL);
    sharedVideoPrefsOverride = parseSmokeVideoPrefsOverride();
    const resolvedSharedSeed = await resolveSharedLocalStorageSeed(DEFAULT_URL);
    sharedJsonSeed = resolvedSharedSeed.jsonSeed;
    sharedRawSeed = resolvedSharedSeed.rawSeed;

    const runIsolated = async (
      scenario,
      viewport = { width: 1440, height: 980 },
      options = {},
    ) => {
      const electronAppRootDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "home-agent-electron-root-"),
      );
      let electronApp = null;
      const outcome = {
        result: null,
        closeDurationMs: null,
      };

      try {
        const copiedDesktopStores = options.copyDesktopProjectStores
          ? await copySavedDesktopProjectStoresToIsolatedRoot(electronAppRootDir)
          : { copiedSessionFiles: 0, copiedConversationFiles: 0 };
        const smokeSelectFolder = trimString(process.env.HOME_AGENT_SMOKE_SELECT_FOLDER)
          || path.join(electronAppRootDir, "smoke-selected-folder");
        await ensureDirectory(smokeSelectFolder);
        const env = {
          ...process.env,
          VITE_DEV_SERVER_URL: DEFAULT_URL,
          INFINIO_APP_ROOT_DIR: electronAppRootDir,
          HOME_AGENT_SMOKE_SELECT_FOLDER: smokeSelectFolder,
          HOME_AGENT_ALLOW_TEST_MULTI_INSTANCE: "1",
        };
        delete env.ELECTRON_RUN_AS_NODE;

        electronApp = await electron.launch({
          args: ["."],
          env,
        });

        const page = await electronApp.firstWindow();
        await page.setViewportSize(viewport);
        await page.route("https://example.com/stress-assets/**", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "image/png",
            body: Buffer.from(STRESS_IMAGE_RESPONSE_BASE64, "base64"),
          });
        });
        page.on("console", (message) => {
          consoleLogs.push(`[${message.type()}] ${message.text()}`);
        });
        page.on("pageerror", (error) => {
          pageErrors.push(String(error?.stack || error));
        });
        page.on("close", () => {
          consoleLogs.push("[event] page closed");
        });
        outcome.result = await scenario(page, {
          electronAppRootDir,
          copiedDesktopStores,
        });
        return outcome;
      } finally {
        if (electronApp) {
          const closeStartedAt = Date.now();
          await electronApp.close();
          outcome.closeDurationMs = Date.now() - closeStartedAt;
        }
        await fs.rm(electronAppRootDir, { recursive: true, force: true });
      }
    };

    const scenarioEntries = [
      ["savedHistory", runSavedHistoryScenario],
      ["analysisRecovery", runAnalysisRecoveryScenario],
      ["videoHistory", runVideoHistoryScenarioSessionBacked],
      ["refreshPersistence", runRefreshPersistenceScenario],
      ["longConversationCompaction", runLongConversationCompactionScenario],
      ["sidebarCollapse", runSidebarCollapseScenario],
      ["customInputQuestion", runCustomInputQuestionScenario],
      ["originalShortcut", runOriginalShortcutScenario],
      ["manualToFullAutoIsolation", runManualToFullAutoIsolationScenario],
      ["repeatedModeSwitchIsolation", runRepeatedModeSwitchIsolationScenario],
      ["repeatedFullAutoKickoffBounce", runRepeatedFullAutoKickoffBounceScenario],
      ["adaptationShortcut", runAdaptationShortcutScenario],
      ["videoShortcut", runVideoShortcutScenario],
      ["homepageDirectConversationOriginal", runHomepageDirectConversationOriginalScenario],
      ["homepageDirectConversationOriginalStructured", runHomepageDirectConversationOriginalStructuredScenario],
      ["homepageStructuredQuestionNaturalLanguageGuide", runHomepageStructuredQuestionNaturalLanguageGuideScenario],
      ["homepageIdentityIntroductionManual", runHomepageIdentityIntroductionManualScenario],
      ["homepageDirectConversationAdaptation", runHomepageDirectConversationAdaptationScenario],
      ["homepageDirectConversationVideo", runHomepageDirectConversationVideoScenario],
      ["homepageAmbiguousConversationManual", runHomepageAmbiguousConversationManualScenario],
      ["homepageAmbiguousConversationFullAuto", runHomepageAmbiguousConversationFullAutoScenario],
      ["homepageAmbiguousResumePendingStepManual", (page) => runHomepageAmbiguousResumePendingStepScenario(page, "manual")],
      ["homepageAmbiguousResumePendingStepFullAuto", (page) => runHomepageAmbiguousResumePendingStepScenario(page, "full-auto")],
      ["casualConversationStreamingManual", (page) => runCasualConversationStreamingScenario(page, "manual")],
      ["casualConversationStreamingFullAuto", (page) => runCasualConversationStreamingScenario(page, "full-auto")],
      ["videoStyleCustomInput", runVideoStyleCustomInputScenarioStable],
      ["videoStyleReferenceUpload", runVideoStyleReferenceUploadReliableScenario],
      ["videoAnalyzeDurationCustomInput", runVideoAnalyzeDurationCustomInputScenarioStable],
      ["pendingCharacterAudioReturnMenu", runPendingCharacterAudioReturnMenuScenario],
      ["videoWorkflowEntryToRoleAndScene", runVideoWorkflowEntryToRoleAndSceneScenario],
      ["videoWorkflowUseCurrentProjectHistoryReuse", runVideoWorkflowUseCurrentProjectHistoryReuseScenario],
      ["videoWorkflowUseCurrentProjectMultiSessionSwitch", runVideoWorkflowUseCurrentProjectMultiSessionSwitchScenario],
      ["videoWorkflowUseCurrentProjectDuplicateDeleteSwitch", runVideoWorkflowUseCurrentProjectDuplicateDeleteSwitchScenario],
      ["videoWorkflowUseCurrentProjectDeleteOriginalBridgeAfterCopies", runVideoWorkflowUseCurrentProjectDeleteOriginalBridgeAfterCopiesScenario],
      ["videoWorkflowUseCurrentProjectOrderStableOnClick", runVideoWorkflowUseCurrentProjectOrderStableOnClickScenario],
      ["seededBridgedHistoryOrderStable", runSeededBridgedHistoryOrderStableScenario],
      ["duplicateProjectsMultiSwitch", runDuplicateProjectsMultiSwitchScenario],
      ["duplicateProjectsDeleteThenDuplicateSwitch", runDuplicateProjectsDeleteThenDuplicateScenario],
      ["skipComplianceHistoryAction", runSkipComplianceHistoryActionScenario],
      ["deleteBridgedVideoProject", runDeleteBridgedVideoProjectScenario],
      ["fullAutoOriginalScriptEndToEnd", runFullAutoOriginalScriptEndToEndScenario],
      ["fullAutoAdaptationEndToEnd", runFullAutoAdaptationEndToEndScenario],
      ["fullAutoVideoWorkflowEndToEnd", runFullAutoVideoWorkflowEndToEndScenario],
      ["realFullAutoVideoBridgePrefsVisualized", runRealFullAutoVideoBridgePrefsVisualizedScenario],
      ["realFullAutoAdaptationEndToEnd", runRealFullAutoAdaptationEndToEndScenario],
      ["realFullAutoVideoWorkflowEndToEnd", runRealFullAutoVideoWorkflowReferenceAssetScenarioV4],
      ["realFullAutoVideoWorkflowSkipReferenceAssetsEndToEnd", runRealFullAutoVideoWorkflowSkipReferenceAssetScenario],
      ["fullAutoQuickTaskLaunchFreshHome", runFullAutoQuickTaskLaunchFreshHomeScenario],
      ["manualQuickTaskSurfaceIsolation", runManualQuickTaskSurfaceIsolationScenario],
      ["manualHistoryRestoreAfterNewProject", runManualHistoryRestoreAfterNewProjectScenario],
      ["fullAutoHistoryRestoreAfterNewProject", runFullAutoHistoryRestoreAfterNewProjectScenario],
      ["currentStorageHistoryReopenParity", runCurrentStorageHistoryReopenParityScenario],
      ["currentStorageRepeatedModeSwitchIsolation", runCurrentStorageRepeatedModeSwitchIsolationScenario],
      ["currentStorageVideoShortcutAndHistoryCount", runCurrentStorageVideoShortcutAndHistoryCountScenario],
      ["currentStorageConversationArchiveParity", runCurrentStorageConversationArchiveParityScenario, { copyDesktopProjectStores: true }],
      ["currentStorageStartupAndSettingsPerformance", runCurrentStorageStartupAndSettingsPerformanceScenario, { copyDesktopProjectStores: true }],
      ["currentStorageUiInteractionResponsiveness", runCurrentStorageUiInteractionResponsivenessScenario, { copyDesktopProjectStores: true }],
      ["currentStorageComposerInputStability", runCurrentStorageComposerInputStabilityScenario, { copyDesktopProjectStores: true }],
      ["heavyHistory", runHeavyHistoryScenario],
      ["heavyAssetLibrary", runHeavyAssetLibraryScenarioStable],
    ];

    const scenarioFilter = process.env.HOME_AGENT_SMOKE_SCENARIO?.trim();
    const scenarios = {};
    for (const [name, scenario, options] of scenarioEntries) {
      if (scenarioFilter && name !== scenarioFilter) {
        continue;
      }
      try {
        const isolatedRun = await runIsolated(scenario, undefined, options);
        scenarios[name] = {
          ok: true,
          result: isolatedRun.result,
          closeDurationMs: isolatedRun.closeDurationMs,
        };
      } catch (error) {
        scenarios[name] = {
          ok: false,
          error: String(error?.stack || error),
        };
      }
    }

    const allScenarioOk = Object.values(scenarios).every((scenario) => scenario.ok);

    console.log(
      JSON.stringify(
        {
          ok: pageErrors.length === 0 && allScenarioOk,
          baseUrl: DEFAULT_URL,
          startedLocalServer: server.startedLocalServer,
          consoleLogCount: consoleLogs.length,
          consoleLogTail: consoleLogs.slice(-80),
          pageErrors,
          scenarios,
        },
        null,
        2,
      ),
    );
  } finally {
    await server.dispose();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: DEFAULT_URL,
        error: String(error?.stack || error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
