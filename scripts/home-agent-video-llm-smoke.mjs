import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium, _electron as electron } from "playwright";

const DEFAULT_URL = process.env.HOME_AGENT_SMOKE_URL || "http://127.0.0.1:8080";
const DEV_SERVER_PORT = new URL(DEFAULT_URL).port || "8080";
const POLL_TIMEOUT_MS = Number(process.env.HOME_AGENT_SMOKE_POLL_TIMEOUT_MS || 120_000);
const SMOKE_MODE = process.env.HOME_AGENT_SMOKE_MODE || "electron";
const SMOKE_VIDEO_MODEL_KEY = trimString(process.env.HOME_AGENT_SMOKE_VIDEO_MODEL_KEY);
const SMOKE_VIDEO_RESOLUTION = trimString(process.env.HOME_AGENT_SMOKE_VIDEO_RESOLUTION);
const SMOKE_VIDEO_MODE = trimString(process.env.HOME_AGENT_SMOKE_VIDEO_MODE);
const SMOKE_VIDEO_ENDPOINT = trimString(process.env.HOME_AGENT_SMOKE_JIMENG_ENDPOINT);
const UI_POLL_INTERVAL_MS = 250;
const PANEL_POLL_INTERVAL_MS = 100;
const VIDEO_PROGRESS_POLL_INTERVAL_MS = 2_500;

const API_CONFIG_KEY = "storyforge_api_config";
const TEXT_MODEL_KEY = "storyforge-home-agent-text-model-v1";
const VIDEO_PREFS_KEY = "storyforge-home-agent-video-prefs-v1";
const CURRENT_PROJECT_KEY = "storyforge_current_project";
const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
const VIDEO_PROJECTS_KEY = "storyforge_projects";
const OBF_PREFIX = "obf:";
const DEFAULT_TEXT_MODEL = "claude-sonnet-4-6";
const VIDEO_WORKFLOW_FREEFORM_PROMPT =
  "\u6211\u5148\u8f93\u5165\u4e00\u53e5\u81ea\u7531\u6587\u672c\uff0c\u8bf7\u7ee7\u7eed\u5f15\u5bfc\u6211\u5b8c\u6210\u5f53\u524d\u89c6\u9891\u5de5\u4f5c\u6d41\u3002";
const VIDEO_DIRECT_FOLLOWUP_PROMPTS = [
  "\u7ee7\u7eed\u5f53\u524d\u89c6\u9891\u751f\u6210\u6d41\u7a0b\uff0c\u5982\u679c\u8fd8\u6ca1\u63d0\u4ea4\u4efb\u52a1\uff0c\u5c31\u5148\u751f\u6210\u5f53\u524d\u5f85\u5904\u7406\u7247\u6bb5\u89c6\u9891\u3002",
  "\u5982\u679c\u5f53\u524d\u6709\u8fdb\u884c\u4e2d\u7684\u7247\u6bb5\u89c6\u9891\u4efb\u52a1\uff0c\u5c31\u5237\u65b0\u5b83\u7684\u72b6\u6001\uff1b\u5982\u679c\u8fd8\u6ca1\u6709\u63d0\u4ea4\u4efb\u52a1\uff0c\u5c31\u5148\u751f\u6210\u5f53\u524d\u5f85\u5904\u7406\u7247\u6bb5\u89c6\u9891\u3002",
];
const VIDEO_PANEL_GROUP_PATTERNS = [
  /^\u63a8\u8350\u52a8\u4f5c/u,
  /^\u6279\u91cf\u6267\u884c/u,
  /^\u5355\u9879\u5904\u7406/u,
  /^\u81ea\u52a8\u63a8\u8fdb\/\u5bfc\u51fa/u,
];
const DEFAULT_VIDEO_PREFS = {
  modelKey: "doubao-seedance-1-5-pro",
  resolution: "720p",
  mode: "text-to-video",
};
const DEFAULT_SMOKE_API_CONFIG = {
  claudeEndpoint: "https://api.tu-zi.com/v1",
  claudeKey: "",
  geminiEndpoint: "https://api.tu-zi.com/v1beta",
  geminiKey: "",
  gptEndpoint: "https://api.tu-zi.com/v1",
  gptKey: "",
  grokEndpoint: "https://api.tu-zi.com/v1",
  grokKey: "",
  aliyunEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
  aliyunKey: "",
  jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
  jimengKey: "",
  jimengExecutionMode: "api",
  tuziEndpoint: "",
  tuziKey: "",
  modelMappings: {
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "gemini-3-flash-preview": "gemini-3-pro",
    "doubao-seedance-1-5-pro_720p": "ep-m-20260414192742-59w88",
    "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88",
    "doubao-seedance-2-0-260128": "doubao-seedance-2-0-260128",
    "doubao-seedance-2-0-fast-260128": "doubao-seedance-2-0-fast-260128",
  },
};
const SERVER_PROXY_PREFIX = "/api/proxy";

const STORYBOARD_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#0c1220"/>
      <stop offset="100%" stop-color="#1a2336"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#bg)"/>
  <rect x="0" y="370" width="960" height="170" fill="#111827"/>
  <rect x="40" y="110" width="120" height="260" fill="#1f2937"/>
  <rect x="180" y="80" width="150" height="290" fill="#111827"/>
  <rect x="740" y="120" width="140" height="250" fill="#1f2937"/>
  <rect x="540" y="95" width="140" height="275" fill="#172033"/>
  <circle cx="710" cy="155" r="38" fill="#f8fafc" opacity="0.12"/>
  <polygon points="420,360 470,255 505,360" fill="#dbeafe" opacity="0.2"/>
  <rect x="460" y="220" width="42" height="120" rx="18" fill="#ef4444"/>
  <rect x="700" y="250" width="24" height="95" rx="10" fill="#cbd5e1" opacity="0.5"/>
  <rect x="730" y="255" width="20" height="85" rx="9" fill="#cbd5e1" opacity="0.38"/>
  <path d="M40 110 L120 540 M140 90 L220 540 M260 70 L330 540 M520 100 L600 540 M670 100 L760 540 M800 110 L900 540" stroke="#e0f2fe" stroke-width="4" opacity="0.18"/>
  <path d="M0 420 C260 350 410 360 960 435" stroke="#93c5fd" stroke-width="6" opacity="0.12" fill="none"/>
  <text x="44" y="60" fill="#e5e7eb" font-size="30" font-family="Arial, sans-serif">Rainy alley storyboard: red-coated woman runs, turns back, distant pursuers approach</text>
</svg>
`.trim();

function toDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProgress(message, extra) {
  if (extra === undefined) {
    console.error(`[smoke] ${message}`);
    return;
  }
  console.error(`[smoke] ${message}`, extra);
}

async function readBuiltinApiConfig() {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "config", "builtin-api.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function pickFirstNonEmpty(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonSafely(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deobfuscate(value) {
  const normalized = trimString(value);
  if (!normalized.startsWith(OBF_PREFIX)) return normalized;
  try {
    return Buffer.from(normalized.slice(OBF_PREFIX.length), "base64").toString("utf8");
  } catch {
    return normalized;
  }
}

function normalizeModelMappings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [trimString(key), trimString(value)])
      .filter(([key, value]) => key && value),
  );
}

function normalizeStoredApiConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const legacyEndpoint = trimString(raw.apiEndpoint);
  const legacyKey = deobfuscate(raw.apiKey);
  return {
    claudeEndpoint: trimString(raw.claudeEndpoint),
    claudeKey: deobfuscate(raw.claudeKey),
    geminiEndpoint: trimString(raw.geminiEndpoint) || legacyEndpoint,
    geminiKey: deobfuscate(raw.geminiKey) || legacyKey,
    gptEndpoint: trimString(raw.gptEndpoint),
    gptKey: deobfuscate(raw.gptKey),
    grokEndpoint: trimString(raw.grokEndpoint),
    grokKey: deobfuscate(raw.grokKey),
    aliyunEndpoint: trimString(raw.aliyunEndpoint),
    aliyunKey: deobfuscate(raw.aliyunKey),
    jimengEndpoint: trimString(raw.jimengEndpoint),
    jimengKey: deobfuscate(raw.jimengKey),
    jimengExecutionMode: trimString(raw.jimengExecutionMode) === "cli" ? "cli" : "api",
    tuziEndpoint: trimString(raw.tuziEndpoint),
    tuziKey: deobfuscate(raw.tuziKey),
    modelMappings: normalizeModelMappings(raw.modelMappings),
  };
}

function normalizeStoredVideoPrefs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_VIDEO_PREFS };
  }
  const modelKey = trimString(raw.modelKey) || DEFAULT_VIDEO_PREFS.modelKey;
  const resolution = trimString(raw.resolution) || DEFAULT_VIDEO_PREFS.resolution;
  const mode = raw.mode === "image-to-video" ? "image-to-video" : DEFAULT_VIDEO_PREFS.mode;
  return { modelKey, resolution, mode };
}

function applySmokeVideoPrefsOverride(basePrefs) {
  const effective = normalizeStoredVideoPrefs(basePrefs);
  return {
    ...effective,
    modelKey: SMOKE_VIDEO_MODEL_KEY || effective.modelKey,
    resolution: SMOKE_VIDEO_RESOLUTION || effective.resolution,
    mode:
      SMOKE_VIDEO_MODE === "image-to-video" || SMOKE_VIDEO_MODE === "text-to-video"
        ? SMOKE_VIDEO_MODE
        : effective.mode,
  };
}

function mergeSmokeApiConfig({
  builtinConfig,
  savedConfig,
  explicitTextApiKey,
  explicitVideoApiKey,
}) {
  const merged = {
    ...DEFAULT_SMOKE_API_CONFIG,
    ...(builtinConfig || {}),
    ...(savedConfig || {}),
    modelMappings: {
      ...DEFAULT_SMOKE_API_CONFIG.modelMappings,
      ...(builtinConfig?.modelMappings || {}),
      ...(savedConfig?.modelMappings || {}),
    },
  };

  if (explicitTextApiKey) {
    if (!trimString(merged.claudeKey)) merged.claudeKey = explicitTextApiKey;
    if (!trimString(merged.geminiKey)) merged.geminiKey = explicitTextApiKey;
    if (!trimString(merged.gptKey)) merged.gptKey = explicitTextApiKey;
    if (!trimString(merged.grokKey)) merged.grokKey = explicitTextApiKey;
    if (!trimString(merged.tuziKey)) merged.tuziKey = explicitTextApiKey;
  }

  if (explicitVideoApiKey && !trimString(merged.jimengKey)) {
    merged.jimengKey = explicitVideoApiKey;
  }
  if (explicitVideoApiKey && !trimString(merged.aliyunKey)) {
    merged.aliyunKey = explicitVideoApiKey;
  }

  if (SMOKE_VIDEO_ENDPOINT) {
    merged.jimengEndpoint = SMOKE_VIDEO_ENDPOINT;
    merged.aliyunEndpoint = SMOKE_VIDEO_ENDPOINT;
  }

  return merged;
}

function pickConfiguredTextApiKey(config) {
  return pickFirstNonEmpty(
    config?.claudeKey,
    config?.geminiKey,
    config?.gptKey,
    config?.grokKey,
    config?.tuziKey,
  );
}

function pickConfiguredVideoApiKey(config) {
  return pickFirstNonEmpty(config?.aliyunKey, config?.jimengKey, config?.geminiKey);
}

function isServerProxyEndpoint(value) {
  const normalized = trimString(value);
  if (!normalized) return false;
  if (normalized.startsWith(`${SERVER_PROXY_PREFIX}/`)) return true;
  try {
    return new URL(normalized, DEFAULT_URL).pathname.startsWith(`${SERVER_PROXY_PREFIX}/`);
  } catch {
    return false;
  }
}

function hasUsableApiCredential(endpoint, apiKey) {
  return isServerProxyEndpoint(endpoint) || Boolean(trimString(apiKey));
}

function isArkJimengEndpoint(value) {
  const normalized = trimString(value).replace(/\/$/, "");
  if (!normalized) return false;
  return (
    /\/contents\/generations\/tasks$/i.test(normalized) ||
    /\/api\/v3$/i.test(normalized) ||
    /ark\.cn-beijing\.volces\.com/i.test(normalized)
  );
}

function resolveJimengApiKeyForSmoke(config) {
  const jimengKey = trimString(config?.jimengKey);
  if (jimengKey) return jimengKey;
  if (isArkJimengEndpoint(config?.jimengEndpoint)) {
    return "";
  }
  return trimString(config?.geminiKey);
}

function inferTextProvider(modelKey) {
  const normalized = trimString(modelKey).toLowerCase();
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("gpt")) return "gpt";
  if (normalized.startsWith("grok")) return "grok";
  return "claude";
}

function hasUsableTextCredential(config, textModel) {
  const provider = inferTextProvider(textModel);
  switch (provider) {
    case "gemini":
      return hasUsableApiCredential(config?.geminiEndpoint, config?.geminiKey);
    case "gpt":
      return hasUsableApiCredential(config?.gptEndpoint, config?.gptKey);
    case "grok":
      return hasUsableApiCredential(config?.grokEndpoint, config?.grokKey);
    case "claude":
    default:
      return hasUsableApiCredential(config?.claudeEndpoint, config?.claudeKey);
  }
}

function hasUsableVideoCredential(config) {
  return (
    isServerProxyEndpoint(config?.aliyunEndpoint) ||
    isServerProxyEndpoint(config?.jimengEndpoint) ||
    Boolean(trimString(config?.aliyunKey)) ||
    Boolean(resolveJimengApiKeyForSmoke(config))
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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
        targetLevelDbDirs.map((dir) =>
          fs.copyFile(sourcePath, path.join(dir, entry.name)),
        ),
      );
      copied += 1;
    } catch {
      // Skip transiently locked LevelDB files and keep probing with the snapshot we could copy.
    }
  }

  return copied > 0;
}

async function readSavedDesktopSettings(baseUrl) {
  const candidates = listDesktopSessionCandidates();
  const probeUrls = listProbeUrls(baseUrl);
  let fallbackMatch = null;

  logProgress("probing desktop session candidates", {
    candidateCount: candidates.length,
    probeUrls,
  });

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
        await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
        if (!page.url().startsWith(probeUrl)) {
          await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }

        const stored = await page.evaluate(({ apiConfigKey, textModelKey, videoPrefsKey }) => {
          return {
            apiConfigRaw: window.localStorage.getItem(apiConfigKey),
            textModelRaw: window.localStorage.getItem(textModelKey),
            videoPrefsRaw: window.localStorage.getItem(videoPrefsKey),
          };
        }, {
          apiConfigKey: API_CONFIG_KEY,
          textModelKey: TEXT_MODEL_KEY,
          videoPrefsKey: VIDEO_PREFS_KEY,
        });

        logProgress("desktop config probe snapshot", {
          candidateDir,
          probeUrl,
          hasApiConfigRaw: Boolean(trimString(stored.apiConfigRaw)),
          hasTextModelRaw: Boolean(trimString(stored.textModelRaw)),
          hasVideoPrefsRaw: Boolean(trimString(stored.videoPrefsRaw)),
        });

        const parsedApiConfig = parseJsonSafely(stored.apiConfigRaw);
        const apiConfig = normalizeStoredApiConfig(parsedApiConfig);
        if (!apiConfig) continue;

        logProgress("desktop config parsed", {
          candidateDir,
          probeUrl,
          parsedApiConfigKeys:
            parsedApiConfig && typeof parsedApiConfig === "object" && !Array.isArray(parsedApiConfig)
              ? Object.keys(parsedApiConfig).slice(0, 20)
              : [],
          hasLegacyApiEndpoint:
            Boolean(parsedApiConfig && typeof parsedApiConfig === "object" && trimString(parsedApiConfig.apiEndpoint)),
          hasLegacyApiKey:
            Boolean(parsedApiConfig && typeof parsedApiConfig === "object" && trimString(parsedApiConfig.apiKey)),
          claudeEndpoint: trimString(apiConfig.claudeEndpoint),
          geminiEndpoint: trimString(apiConfig.geminiEndpoint),
          gptEndpoint: trimString(apiConfig.gptEndpoint),
          jimengEndpoint: trimString(apiConfig.jimengEndpoint),
          hasClaudeKey: Boolean(trimString(apiConfig.claudeKey)),
          hasGeminiKey: Boolean(trimString(apiConfig.geminiKey)),
          hasGptKey: Boolean(trimString(apiConfig.gptKey)),
          hasJimengKey: Boolean(trimString(apiConfig.jimengKey)),
          hasTuziKey: Boolean(trimString(apiConfig.tuziKey)),
        });

        const match = {
          apiConfigRaw: trimString(stored.apiConfigRaw),
          apiConfig,
          textModelRaw: trimString(stored.textModelRaw),
          textModel: trimString(stored.textModelRaw) || DEFAULT_TEXT_MODEL,
          videoPrefsRaw: trimString(stored.videoPrefsRaw),
          videoPrefs: normalizeStoredVideoPrefs(parseJsonSafely(stored.videoPrefsRaw)),
          source: `desktop-session:${candidateDir}`,
        };
        const hasTextKey = Boolean(pickConfiguredTextApiKey(apiConfig));
        const hasVideoKey = Boolean(pickConfiguredVideoApiKey(apiConfig));

        if (hasTextKey || hasVideoKey) {
          logProgress("found saved desktop api config", {
            candidateDir,
            probeUrl,
            hasTextKey,
            hasVideoKey,
          });
          return match;
        }

        if (!fallbackMatch) {
          fallbackMatch = match;
        }
      } catch (error) {
        logProgress("failed to probe desktop api config", {
          candidateDir,
          probeUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (electronApp) {
          await electronApp.close().catch(() => {});
        }
        await fs.rm(extractionRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return fallbackMatch;
}

async function resolveSmokeSettings(baseUrl) {
  const builtin = await readBuiltinApiConfig();
  const builtinConfig = normalizeStoredApiConfig(builtin) || {};
  const savedSettings = await readSavedDesktopSettings(baseUrl);
  const apiKey = trimString(process.env.HOME_AGENT_SMOKE_API_KEY);
  const explicitTextApiKey = pickFirstNonEmpty(
    process.env.HOME_AGENT_SMOKE_TEXT_API_KEY,
    apiKey,
    builtin.claudeKey,
    builtin.geminiKey,
    builtin.gptKey,
    builtin.grokKey,
    builtin.tuziKey,
  );
  const explicitVideoApiKey = pickFirstNonEmpty(
    process.env.HOME_AGENT_SMOKE_VIDEO_API_KEY,
    apiKey,
    builtin.jimengKey,
    builtin.geminiKey,
  );
  const apiConfig = mergeSmokeApiConfig({
    builtinConfig,
    savedConfig: savedSettings?.apiConfig || null,
    explicitTextApiKey,
    explicitVideoApiKey,
  });
  const savedVideoPrefs = savedSettings?.videoPrefs || { ...DEFAULT_VIDEO_PREFS };
  const savedVideoPrefsSeed =
    savedSettings?.videoPrefsRaw || savedSettings?.videoPrefs || { ...DEFAULT_VIDEO_PREFS };
  const effectiveVideoPrefs = applySmokeVideoPrefsOverride(savedVideoPrefs);
  const effectiveVideoPrefsSeed =
    typeof savedVideoPrefsSeed === "string"
      ? JSON.stringify(applySmokeVideoPrefsOverride(parseJsonSafely(savedVideoPrefsSeed)))
      : applySmokeVideoPrefsOverride(savedVideoPrefsSeed);
  const desktopSessionSource =
    Boolean(savedSettings?.apiConfigRaw) && String(savedSettings?.source || "").startsWith("desktop-session:");
  const mergedTextModel = savedSettings?.textModel || DEFAULT_TEXT_MODEL;

  return {
    textApiKey: pickConfiguredTextApiKey(apiConfig),
    videoApiKey: pickConfiguredVideoApiKey(apiConfig),
    apiConfig,
    // Seed the effective merged config so the isolated smoke run uses the
    // same endpoint/key fallback logic that passed readiness checks.
    apiConfigSeed: apiConfig,
    textModel: savedSettings?.textModel || DEFAULT_TEXT_MODEL,
    textModelSeed: savedSettings?.textModelRaw || savedSettings?.textModel || DEFAULT_TEXT_MODEL,
    videoPrefs: effectiveVideoPrefs,
    videoPrefsSeed: effectiveVideoPrefsSeed,
    trustSavedDesktopConfig:
      desktopSessionSource &&
      (hasUsableTextCredential(apiConfig, mergedTextModel) || hasUsableVideoCredential(apiConfig)),
    credentialSource:
      (trimString(process.env.HOME_AGENT_SMOKE_TEXT_API_KEY) ||
        trimString(process.env.HOME_AGENT_SMOKE_VIDEO_API_KEY) ||
        apiKey)
        ? "env"
        : savedSettings?.apiConfig
          ? savedSettings.source
          : Object.keys(builtinConfig).length
            ? "builtin-config"
            : "missing",
  };
}

function isInterestingVideoRequest(url) {
  const normalized = trimString(url);
  return /\/v1\/videos(?:\/|$)/i.test(normalized) ||
    /\/contents\/generations\/tasks(?:\/|$)/i.test(normalized);
}

function summarizeVideoRequestBody(postData) {
  if (!trimString(postData)) return null;
  try {
    const parsed = JSON.parse(postData);
    return {
      bodyType: "json",
      keys: Object.keys(parsed || {}),
      model: parsed?.model || null,
      resolution: parsed?.resolution || null,
      duration: parsed?.duration || null,
      ratio: parsed?.ratio || null,
      hasContent: Array.isArray(parsed?.content),
      contentPreview: Array.isArray(parsed?.content)
        ? parsed.content.map((item) => ({
            type: item?.type || null,
            role: item?.role || null,
            hasText: typeof item?.text === "string" && item.text.length > 0,
            textPreview:
              typeof item?.text === "string" ? item.text.slice(0, 120) : null,
          }))
        : null,
    };
  } catch {
    return {
      bodyType: "raw",
      preview: postData.slice(0, 500),
    };
  }
}

function detectVideoQuotaBlock(videoNetworkEvents = []) {
  return videoNetworkEvents.find((event) =>
    event?.phase === "response" &&
    typeof event?.bodyPreview === "string" &&
    /pre_consume_quota_failed/i.test(event.bodyPreview),
  ) || null;
}

function detectCompletedVideoResponse(videoNetworkEvents = []) {
  return [...videoNetworkEvents]
    .reverse()
    .find((event) =>
      event?.phase === "response" &&
      typeof event?.bodyPreview === "string" &&
      /"status"\s*:\s*"completed"/i.test(event.bodyPreview),
    ) || null;
}

function extractVideoUrlFromNetworkEvent(event) {
  const bodyPreview = trimString(event?.bodyPreview);
  if (!bodyPreview) return null;
  try {
    const parsed = JSON.parse(bodyPreview);
    return trimString(parsed?.video_url || parsed?.output?.video_url || parsed?.data?.video_url) || null;
  } catch {
    const match = bodyPreview.match(/https?:\/\/[^\s"\\]+/i);
    return match ? match[0] : null;
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // keep polling
    }
    await sleep(UI_POLL_INTERVAL_MS);
  }
  return false;
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
  if (await waitForServer(DEFAULT_URL, 2_000)) {
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

  const ready = await waitForServer(DEFAULT_URL, 30_000);
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

function createSeedPayload({ apiConfigSeed, textModelSeed, videoPrefsSeed }) {
  const effectiveVideoPrefs =
    typeof videoPrefsSeed === "string"
      ? normalizeStoredVideoPrefs(parseJsonSafely(videoPrefsSeed))
      : normalizeStoredVideoPrefs(videoPrefsSeed);
  const projectId = "video-smoke-text2video-1";
  const storyboardUrl = toDataUrl(STORYBOARD_SVG);
  const createdAt = nowIso();
  const assetManifest = {
    version: "1",
    summary: "1 storyboard asset ready for video generation",
    items: [
      {
        id: "asset-storyboard-1",
        kind: "storyboard-frame",
        label: "镜头1 分镜图",
        url: storyboardUrl,
        meta: "scene-1",
        reusable: true,
        status: "ready",
        version: 1,
        createdAt,
      },
    ],
  };

  const project = {
    id: projectId,
    title: "Seedance 文生视频烟测",
    script:
      "雨夜窄巷里，穿红色风衣的女主急促奔跑，回头时看见远处有人追来，地面有雨水反光，镜头有明显速度感和压迫感。",
    targetPlatform: "抖音",
    shotStyle: "电影感追逐预告",
    outputGoal: "5 秒预告镜头",
    productionNotes: "使用分镜图做视觉拆解，但最终只提交文字 prompt 给 Seedance 1.5 Pro。使用支持的最短时长 4 秒。",
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        segmentLabel: "1-1",
        sceneName: "雨夜追击",
        description:
          "雨夜小巷中，穿红色风衣的女主在镜头前方疾跑，跑动中突然回头，后方追兵身影逐渐逼近，路面反光，氛围紧张。",
        characters: ["女主", "追兵"],
        dialogue: "",
        cameraDirection: "中景跟拍，随后轻微推近到回头瞬间",
        duration: 4,
        recommendedDuration: 4,
        enhancedVideoPrompt:
          "Rainy neon alley at night, a young woman in a red trench coat sprints toward camera, suddenly turns back in panic as distant pursuers emerge through the rain haze; cinematic live-action look, wet pavement reflections, strong speed, pressure, and handheld pursuit energy.",
        storyboardUrl,
      },
    ],
    characters: [
      {
        id: "char-1",
        name: "女主",
        description: "年轻女性，红色风衣，短发，表情警觉，动作敏捷。",
        imageUrl: "",
        isAIGenerated: false,
        source: "auto",
      },
      {
        id: "char-2",
        name: "追兵",
        description: "远处模糊追逐者，深色服装，形成压迫感。",
        imageUrl: "",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-1",
        name: "雨夜小巷",
        description: "狭窄城市巷道，冷色夜景，路面有积水反光，远处车灯与霓虹形成轮廓光。",
        imageUrl: "",
        isAIGenerated: false,
        source: "auto",
      },
    ],
    artStyle: "live-action",
    videoGenerationPrefs: effectiveVideoPrefs,
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "素材库已有分镜图，可直接从分镜图拆解 prompt 并发起视频生成。",
    storyboardPlan: "镜头1：雨夜追击，女主奔跑后猛然回头。",
    videoPromptBatch:
      "片段 1-1：Rainy neon alley at night, a young woman in a red trench coat runs toward camera and suddenly turns back as distant pursuers emerge. Keep the live-action cinematic look, cold wet reflections, urgent forward momentum, and escalating threat across the full 4-second beat.",
    segmentVideoPrompts: {
      "1-1": {
        segmentLabel: "1-1",
        prompt:
          "Rainy neon alley at night, a young woman in a red trench coat runs toward camera and suddenly turns back as distant pursuers emerge. Keep the live-action cinematic look, cold wet reflections, urgent forward momentum, and escalating threat across the full 4-second beat.",
        duration: 4,
        targetDuration: 4,
        modelKey: effectiveVideoPrefs.modelKey,
        maxDurationForModel: 4,
        sceneIds: ["scene-1"],
        generatedAt: createdAt,
      },
    },
    sourceProjectId: "video-smoke-source-1",
    createdAt,
    updatedAt: createdAt,
    styleLock: null,
    worldModel: null,
    assetManifest,
    shotPackets: [
      {
        id: "packet:video-smoke-text2video-1:scene-1",
        sceneId: "scene-1",
        sceneNumber: 1,
        title: "雨夜追击",
        durationSec: 4,
        camera: {
          shotSize: "中景",
          movement: "跟拍后推近",
        },
        characterRefs: [],
        sourceAssetIds: ["asset-storyboard-1"],
        promptSeed: "女主在雨夜巷道奔跑后回头，后方追兵逼近。",
        forbiddenChanges: ["不要改变女主红色风衣的核心识别特征。"],
        renderMode: "text2video",
        reviewStatus: "pending",
      },
    ],
    reviewQueue: [],
  };

  const snapshot = {
    projectId,
    projectKind: "video",
    title: project.title,
    currentObjective: "直接生成视频并展示结果",
    derivedStage: "视频生成",
    agentSummary: "分镜图与素材库已准备好，可直接调用工作流生成视频。",
    recommendedActions: ["生成视频", "轮询视频结果"],
    artifacts: [],
    updatedAt: createdAt,
    memory: {
      styleLock: null,
      worldModel: null,
      assetManifest,
      shotPackets: project.shotPackets,
      reviewQueue: project.reviewQueue,
    },
    selectedVideoModelKey: effectiveVideoPrefs.modelKey,
  };

  const session = {
    sessionId: "session-video-smoke-1",
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: "assistant-bootstrap-1",
        role: "assistant",
        content: "当前视频项目素材已经就绪，可以直接生成视频。",
        createdAt,
      },
    ],
    currentProjectSnapshot: snapshot,
    recentMessageSummary: "assistant: 当前视频项目素材已经就绪，可以直接生成视频。",
    projectId,
    draft: "",
    qState: null,
    selectedValues: [],
    selectedVideoModelKey: effectiveVideoPrefs.modelKey,
  };

  return {
    projectId,
    project,
    session,
    snapshot,
    localStorageSeed: {
      [API_CONFIG_KEY]: apiConfigSeed,
      [TEXT_MODEL_KEY]: textModelSeed,
      [VIDEO_PREFS_KEY]: videoPrefsSeed,
      [CURRENT_PROJECT_KEY]: projectId,
      [VIDEO_PROJECTS_KEY]: [project],
      [STUDIO_SESSION_KEY]: session,
      [STUDIO_PROJECT_SESSIONS_KEY]: {
        [projectId]: session,
      },
    },
  };
}

async function seedPage(page, payload) {
  await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.evaluate((seed) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(seed)) {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }, payload.localStorageSeed);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
}

async function waitForVisible(page, locator, timeout = 20_000) {
  await locator.first().waitFor({ state: "visible", timeout });
}

function normalizeComparableValue(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function hasGenerationStateProgress(nextState, previousState) {
  if (!nextState) return false;
  const keys = [
    "sceneVideoTaskId",
    "sceneVideoUrl",
    "sceneVideoStatus",
    "segmentVideoTaskId",
    "segmentVideoUrl",
    "segmentVideoStatus",
  ];

  return keys.some((key) => {
    const nextValue = normalizeComparableValue(nextState[key]);
    const previousValue = normalizeComparableValue(previousState?.[key]);
    return Boolean(nextValue) && nextValue !== previousValue;
  });
}

function hasGenerationActivity(generationState) {
  return Boolean(
    generationState?.sceneVideoTaskId ||
      generationState?.segmentVideoTaskId ||
      generationState?.sceneVideoUrl ||
      generationState?.segmentVideoUrl ||
      (generationState?.sceneVideoStatus &&
        normalizeComparableValue(generationState.sceneVideoStatus).toLowerCase() !== "failed") ||
      (generationState?.segmentVideoStatus &&
        normalizeComparableValue(generationState.segmentVideoStatus).toLowerCase() !== "failed"),
  );
}

function hasChoicePanelActions(panelState) {
  return Boolean(
    panelState?.primaryButtons?.length ||
      panelState?.secondaryButtons?.length ||
      panelState?.tertiaryButtons?.length ||
      panelState?.quaternaryButtons?.length,
  );
}

async function ensureProjectVisible(page, title) {
  const titleLocator = page.getByText(title).first();
  try {
    await titleLocator.waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    const historyEntry = page.getByRole("button", { name: new RegExp(title) }).first();
    if ((await historyEntry.count()) > 0) {
      await historyEntry.click();
      await titleLocator.waitFor({ state: "visible", timeout: 10_000 });
      return true;
    }
    return false;
  }
}

async function waitForChoicePanelActions(page, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const panelState = await readChoicePanelState(page);
    if (hasChoicePanelActions(panelState)) {
      return panelState;
    }
    await sleep(PANEL_POLL_INTERVAL_MS);
  }
  return readChoicePanelState(page);
}

async function waitForSecondaryChoicePanel(page, timeoutMs = 1_500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const secondaryButtons = page.locator('[data-testid="nested-secondary-panel"] button[type="button"]');
    const secondaryCount = await secondaryButtons.count().catch(() => 0);
    if (secondaryCount > 0) {
      return secondaryCount;
    }
    await sleep(PANEL_POLL_INTERVAL_MS);
  }
  return 0;
}

function sendButtonLocator(page) {
  return page.locator("button").filter({ has: page.locator(".lucide-send, .lucide-loader2") }).first();
}

async function maybeSendRefreshPrompt(page) {
  const textarea = page.locator("textarea").last();
  await waitForVisible(page, textarea, 10_000);
  await textarea.fill("继续调用 refresh_video_assets 轮询当前视频任务，直到视频在聊天框中显示出来。");
  const sendButton = sendButtonLocator(page);
  await waitForVisible(page, sendButton, 10_000);
  await sendButton.click({ force: true });
}

async function readProjectState(page, projectId) {
  return page.evaluate((id) => {
    const raw = localStorage.getItem("storyforge_projects");
    const projects = raw ? JSON.parse(raw) : [];
    return projects.find((project) => project.id === id) || null;
  }, projectId);
}

async function submitComposerPrompt(page, text) {
  const textarea = page.locator("textarea").last();
  await waitForVisible(page, textarea, 10_000);
  await textarea.fill(text);
  const sendButton = sendButtonLocator(page);
  await waitForVisible(page, sendButton, 10_000);
  await sendButton.click({ force: true });
}

async function waitForGenerationSignals(page, timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const sceneToolCallVisible = await page
      .getByText("workflow:generate_video_assets")
      .first()
      .isVisible()
      .catch(() => false);
    const segmentToolCallVisible = await page
      .getByText("workflow:generate_segment_video")
      .first()
      .isVisible()
      .catch(() => false);
    const pendingBubbleVisible =
      (await page.getByText(/姝ｅ湪.*瑙嗛.*绋嶇瓑/u).first().isVisible().catch(() => false)) ||
      (await page.getByText(/姝ｅ湪.*鐗囨.*瑙嗛/u).first().isVisible().catch(() => false));

    if (sceneToolCallVisible || segmentToolCallVisible || pendingBubbleVisible) {
      return {
        sceneToolCallVisible,
        segmentToolCallVisible,
        pendingBubbleVisible,
      };
    }

    await sleep(UI_POLL_INTERVAL_MS);
  }

  return {
    sceneToolCallVisible: false,
    segmentToolCallVisible: false,
    pendingBubbleVisible: false,
  };
}

async function clickFirstMatchingButton(page, patterns) {
  for (const pattern of patterns) {
    const button = page.getByRole("button", { name: pattern }).first();
    const count = await button.count().catch(() => 0);
    if (!count) continue;
    await button.click({ force: true });
    return pattern.toString();
  }
  return null;
}

async function maybeTriggerVideoGenerationFollowup(page) {
  const followupPrompts = [
    "鍏堢敓鎴愬綋鍓嶇墖娈佃棰戙€?",
    "缁х画鎺ㄨ繘褰撳墠瑙嗛鐢熸垚锛屽厛鐢熸垚褰撳墠鐗囨瑙嗛銆?",
  ];

  for (const followupPrompt of followupPrompts) {
    await submitComposerPrompt(page, followupPrompt);
    const signals = await waitForGenerationSignals(page, 45_000);
    if (signals.sceneToolCallVisible || signals.segmentToolCallVisible || signals.pendingBubbleVisible) {
      return { method: `prompt:${followupPrompt}`, ...signals };
    }
  }

  const clickedPattern = await clickFirstMatchingButton(page, [
    /鐢熸垚.*鐗囨/u,
    /褰撳墠鐗囨/u,
    /鍓?1.*鐗囨/u,
    /鐢熸垚.*闀滃ご/u,
    /褰撳墠闀滃ご/u,
  ]);
  if (!clickedPattern) return null;

  const signals = await waitForGenerationSignals(page, 45_000);
  return { method: `click:${clickedPattern}`, ...signals };
}

async function readGenerationState(page, projectId) {
  const project = await readProjectState(page, projectId);
  const firstScene = project?.scenes?.[0] || null;
  const segmentLabel =
    Object.keys(project?.segmentVideoStatuses ?? {})[0] ||
    Object.keys(project?.segmentVideoPrompts ?? {})[0] ||
    null;

  return {
    project,
    sceneVideoTaskId: firstScene?.videoTaskId || null,
    sceneVideoUrl: firstScene?.videoUrl || null,
    sceneVideoStatus: firstScene?.videoStatus || null,
    segmentLabel,
    segmentVideoTaskId: segmentLabel
      ? project?.segmentVideoStatuses?.[segmentLabel]?.taskId || null
      : null,
    segmentVideoUrl: segmentLabel ? project?.segmentVideos?.[segmentLabel] || null : null,
    segmentVideoStatus: segmentLabel
      ? project?.segmentVideoStatuses?.[segmentLabel]?.status || null
      : null,
  };
}

async function readChoicePanelState(page) {
  return page.evaluate(() => {
    const collectVisibleTexts = (selector) => {
      const seen = new Set();
      return Array.from(document.querySelectorAll(selector))
        .map((node) => {
          if (!(node instanceof HTMLElement)) return "";
          if (node.offsetParent === null) return "";
          return node.innerText.replace(/\s+/g, " ").trim();
        })
        .filter((value) => {
          if (!value || seen.has(value)) return false;
          seen.add(value);
          return true;
        });
    };

    return {
      primaryButtons: collectVisibleTexts("[data-choice-mode] button"),
      secondaryButtons: collectVisibleTexts('[data-testid="nested-secondary-panel"] button'),
      tertiaryButtons: collectVisibleTexts('[data-testid="nested-tertiary-panel"] button'),
      quaternaryButtons: collectVisibleTexts('[data-testid="nested-quaternary-panel"] button'),
    };
  });
}

async function waitForWorkflowProgress(
  page,
  projectId,
  previousState = null,
  timeoutMs = 45_000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const generationState = await readGenerationState(page, projectId);
    const stateChanged = hasGenerationStateProgress(generationState, previousState);
    const hasRunningTask = hasGenerationActivity(generationState);
    if (stateChanged || hasRunningTask) {
      return {
        sceneToolCallVisible: false,
        segmentToolCallVisible: false,
        refreshToolCallVisible: false,
        pendingBubbleVisible: hasRunningTask,
        generationState,
      };
    }
    await sleep(UI_POLL_INTERVAL_MS);
  }

  const generationState = await readGenerationState(page, projectId);
  return {
    sceneToolCallVisible: false,
    segmentToolCallVisible: false,
    refreshToolCallVisible: false,
    pendingBubbleVisible: Boolean(
      generationState?.sceneVideoTaskId ||
      generationState?.segmentVideoTaskId ||
      generationState?.sceneVideoUrl ||
      generationState?.segmentVideoUrl,
    ),
    generationState,
  };
}

async function waitForVideoProgressTick(
  page,
  projectId,
  videoNetworkEvents,
  previousState = null,
  timeoutMs = VIDEO_PROGRESS_POLL_INTERVAL_MS,
) {
  const startedAt = Date.now();
  let generationState = await readGenerationState(page, projectId);

  while (Date.now() - startedAt < timeoutMs) {
    const completedVideoEvent = detectCompletedVideoResponse(videoNetworkEvents);
    const inferredVideoUrlFromNetwork = extractVideoUrlFromNetworkEvent(completedVideoEvent);
    const quotaBlockedEvent = detectVideoQuotaBlock(videoNetworkEvents);
    generationState = await readGenerationState(page, projectId);

    if (
      hasGenerationStateProgress(generationState, previousState) ||
      generationState?.sceneVideoUrl ||
      generationState?.segmentVideoUrl ||
      inferredVideoUrlFromNetwork ||
      quotaBlockedEvent
    ) {
      return {
        generationState,
        completedVideoEvent,
        inferredVideoUrlFromNetwork,
        quotaBlockedEvent,
      };
    }

    await sleep(UI_POLL_INTERVAL_MS);
  }

  return {
    generationState,
    completedVideoEvent: detectCompletedVideoResponse(videoNetworkEvents),
    inferredVideoUrlFromNetwork: extractVideoUrlFromNetworkEvent(
      detectCompletedVideoResponse(videoNetworkEvents),
    ),
    quotaBlockedEvent: detectVideoQuotaBlock(videoNetworkEvents),
  };
}

async function clickChoicePanelPrimaryAction(page, projectId) {
  const baselineState = await readGenerationState(page, projectId);
  const panelStateBefore = await readChoicePanelState(page);

  for (const pattern of VIDEO_PANEL_GROUP_PATTERNS) {
    const groupButton = page.getByRole("button", { name: pattern }).first();
    const groupVisible = await groupButton.isVisible().catch(() => false);
    if (!groupVisible) continue;

    const groupLabel =
      normalizeComparableValue(await groupButton.innerText().catch(() => "")) ||
      pattern.toString();
    await groupButton.click({ force: true });
    const secondaryCount = await waitForSecondaryChoicePanel(page);

    if (secondaryCount > 0) {
      const secondaryButtons = page.locator('[data-testid="nested-secondary-panel"] button[type="button"]');
      const childButton = secondaryButtons.first();
      const childLabel =
        normalizeComparableValue(await childButton.innerText().catch(() => "")) ||
        "child-1";
      await childButton.click({ force: true });
      const signals = await waitForWorkflowProgress(page, projectId, baselineState, 45_000);
      return {
        method: `panel:${groupLabel}->${childLabel}`,
        panelStateBefore,
        panelStateAfter: await readChoicePanelState(page),
        ...signals,
      };
    }
  }

  return null;
}

async function continueVideoGenerationFromUi(page, projectId) {
  const panelAction = await clickChoicePanelPrimaryAction(page, projectId);
  if (panelAction) {
    return panelAction;
  }

  const legacyFollowup = await maybeTriggerVideoGenerationFollowup(page);
  if (!legacyFollowup) {
    return {
      method: null,
      panelStateBefore: await readChoicePanelState(page),
      panelStateAfter: await readChoicePanelState(page),
      sceneToolCallVisible: false,
      segmentToolCallVisible: false,
      refreshToolCallVisible: false,
      pendingBubbleVisible: false,
      generationState: await readGenerationState(page, projectId),
    };
  }

  return {
    ...legacyFollowup,
    refreshToolCallVisible: false,
    panelStateBefore: await readChoicePanelState(page),
    panelStateAfter: await readChoicePanelState(page),
    generationState: await readGenerationState(page, projectId),
  };
}

async function refreshVideoGenerationFromUi(page, projectId) {
  const panelAction = await clickChoicePanelPrimaryAction(page, projectId);
  if (panelAction) {
    return panelAction;
  }

  const baselineState = await readGenerationState(page, projectId);
  await maybeSendRefreshPrompt(page);
  const signals = await waitForWorkflowProgress(page, projectId, baselineState, 45_000);
  return {
    method: "prompt:refresh_video_assets",
    panelStateBefore: await readChoicePanelState(page),
    panelStateAfter: await readChoicePanelState(page),
    ...signals,
  };
}

async function main() {
  const server = await ensureServer();
  const {
    textApiKey,
    videoApiKey,
    apiConfig,
    apiConfigSeed,
    textModel,
    textModelSeed,
    videoPrefs,
    videoPrefsSeed,
    trustSavedDesktopConfig,
    credentialSource,
  } =
    await resolveSmokeSettings(DEFAULT_URL);

  const textCredentialReady =
    hasUsableTextCredential(apiConfig, textModel) || trustSavedDesktopConfig;
  const videoCredentialReady =
    hasUsableVideoCredential(apiConfig) || trustSavedDesktopConfig;

  if (!textCredentialReady) {
    throw new Error("No usable homepage text credential found for the selected text model in env, config/builtin-api.json, or the saved Electron session");
  }
  if (!videoCredentialReady) {
    throw new Error("No usable video credential found in env, config/builtin-api.json, or the saved Electron session");
  }
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-video-smoke-"));
  const electronAppRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-video-electron-root-"));
  let browser = null;
  let electronApp = null;
  let page;
  const videoNetworkEvents = [];

  if (SMOKE_MODE === "electron") {
    const env = {
      ...process.env,
      VITE_DEV_SERVER_URL: DEFAULT_URL,
      INFINIO_APP_ROOT_DIR: electronAppRootDir,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    electronApp = await electron.launch({
      args: ["."],
      env,
    });
    page = await electronApp.firstWindow();
    await page.setViewportSize({ width: 1440, height: 980 });
  } else {
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1440, height: 980 },
    });
    page = browser.pages()[0] || (await browser.newPage());
  }
  const consoleLogs = [];
  const errors = [];

  page.on("console", (message) => {
    const text = message.text();
    consoleLogs.push(`[${message.type()}] ${text}`);
  });
  page.on("pageerror", (error) => {
    errors.push(String(error));
  });
  page.on("request", (request) => {
    const url = request.url();
    if (!isInterestingVideoRequest(url)) return;
    videoNetworkEvents.push({
      phase: "request",
      method: request.method(),
      url,
      postDataSummary: summarizeVideoRequestBody(request.postData()),
    });
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (!isInterestingVideoRequest(url)) return;
    let bodyPreview = "";
    try {
      bodyPreview = (await response.text()).slice(0, 500);
    } catch {
      bodyPreview = "";
    }
    videoNetworkEvents.push({
      phase: "response",
      status: response.status(),
      url,
      bodyPreview,
    });
  });

  try {
    const payload = createSeedPayload({ apiConfigSeed, textModelSeed, videoPrefsSeed });
    logProgress("resolved smoke credentials", {
      credentialSource,
      textModel,
      videoPrefs,
      jimengEndpoint: apiConfig?.jimengEndpoint || null,
      geminiEndpoint: apiConfig?.geminiEndpoint || null,
      usesArkJimengEndpoint: isArkJimengEndpoint(apiConfig?.jimengEndpoint),
      hasUsableTextCredential: textCredentialReady,
      hasUsableVideoCredential: videoCredentialReady,
      hasJimengKey: Boolean(trimString(apiConfig.jimengKey)),
      hasGeminiKey: Boolean(trimString(apiConfig.geminiKey)),
      trustSavedDesktopConfig,
    });
    logProgress("seeding isolated browser session");
    await seedPage(page, payload);

    const textarea = page.locator("textarea").last();
    await waitForVisible(page, textarea, 20_000);
    const projectVisible = await ensureProjectVisible(page, payload.project.title);
    logProgress("homepage ready with seeded video project", {
      projectId: payload.projectId,
      projectVisible,
    });

    const prompt = VIDEO_WORKFLOW_FREEFORM_PROMPT;

    await submitComposerPrompt(page, prompt);
    logProgress("freeform recovery prompt sent to homepage", { prompt });
    await page.getByText(prompt).first().waitFor({ state: "visible", timeout: 20_000 });
    await waitForChoicePanelActions(page, 5_000);

    let panelState = await readChoicePanelState(page);
    logProgress("choice panel state after freeform prompt", panelState);

    let toolCallVisible = false;
    let pendingBubbleVisible = false;
    let refreshPromptSent = false;
    let generationState = await readGenerationState(page, payload.projectId);
    let projectState = generationState.project;
    let videoTaskId =
      generationState.segmentVideoTaskId ||
      generationState.sceneVideoTaskId ||
      projectState?.scenes?.[0]?.videoTaskId ||
      null;
    let videoUrl =
      generationState.segmentVideoUrl ||
      generationState.sceneVideoUrl ||
      projectState?.scenes?.[0]?.videoUrl ||
      null;
    logProgress("initial cross-mode generation state", {
      videoTaskId,
      videoUrl,
      sceneVideoStatus: generationState.sceneVideoStatus,
      segmentVideoStatus: generationState.segmentVideoStatus,
      segmentLabel: generationState.segmentLabel,
      panelState,
    });

    if (!videoTaskId) {
      const followupResult = await continueVideoGenerationFromUi(page, payload.projectId);
      toolCallVisible =
        toolCallVisible ||
        Boolean(followupResult?.sceneToolCallVisible) ||
        Boolean(followupResult?.segmentToolCallVisible) ||
        Boolean(followupResult?.refreshToolCallVisible);
      pendingBubbleVisible = pendingBubbleVisible || Boolean(followupResult?.pendingBubbleVisible);
      if (followupResult?.panelStateAfter) {
        panelState = followupResult.panelStateAfter;
      }
      logProgress("video generation followup completed", followupResult);
      generationState = followupResult?.generationState || (await readGenerationState(page, payload.projectId));
      projectState = generationState.project;
      videoTaskId =
        generationState.segmentVideoTaskId ||
        generationState.sceneVideoTaskId ||
        projectState?.scenes?.[0]?.videoTaskId ||
        null;
      videoUrl =
        generationState.segmentVideoUrl ||
        generationState.sceneVideoUrl ||
        projectState?.scenes?.[0]?.videoUrl ||
        null;
      logProgress("cross-mode generation state after followup", {
        videoTaskId,
        videoUrl,
        sceneVideoStatus: generationState.sceneVideoStatus,
        segmentVideoStatus: generationState.segmentVideoStatus,
        segmentLabel: generationState.segmentLabel,
        panelState,
      });
    }

    const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    let lastRefreshAt = 0;
    while (!videoUrl && Date.now() < pollDeadline) {
      if (!videoTaskId && detectVideoQuotaBlock(videoNetworkEvents)) {
        break;
      }
      const progressSnapshot = await waitForVideoProgressTick(
        page,
        payload.projectId,
        videoNetworkEvents,
        generationState,
      );
      generationState = progressSnapshot.generationState;
      projectState = generationState.project;
      videoTaskId =
        generationState.segmentVideoTaskId ||
        generationState.sceneVideoTaskId ||
        projectState?.scenes?.[0]?.videoTaskId ||
        null;
      videoUrl =
        generationState.segmentVideoUrl ||
        generationState.sceneVideoUrl ||
        progressSnapshot.inferredVideoUrlFromNetwork ||
        projectState?.scenes?.[0]?.videoUrl ||
        null;
      logProgress("polling cross-mode generation state", {
        videoTaskId,
        videoUrl,
        sceneVideoStatus: generationState.sceneVideoStatus,
        segmentVideoStatus: generationState.segmentVideoStatus,
        segmentLabel: generationState.segmentLabel,
        inferredVideoUrlFromNetwork: progressSnapshot.inferredVideoUrlFromNetwork,
      });

      if (
        !videoUrl &&
        videoTaskId &&
        Date.now() - lastRefreshAt >= 25_000 &&
        Date.now() + 20_000 < pollDeadline
      ) {
        const refreshResult = await refreshVideoGenerationFromUi(page, payload.projectId);
        refreshPromptSent = refreshPromptSent || Boolean(refreshResult?.method);
        toolCallVisible =
          toolCallVisible ||
          Boolean(refreshResult?.sceneToolCallVisible) ||
          Boolean(refreshResult?.segmentToolCallVisible) ||
          Boolean(refreshResult?.refreshToolCallVisible);
        pendingBubbleVisible = pendingBubbleVisible || Boolean(refreshResult?.pendingBubbleVisible);
        if (refreshResult?.panelStateAfter) {
          panelState = refreshResult.panelStateAfter;
        }
        lastRefreshAt = Date.now();
        logProgress("video generation refresh completed", refreshResult);
        generationState = refreshResult?.generationState || (await readGenerationState(page, payload.projectId));
        projectState = generationState.project;
        videoTaskId =
          generationState.segmentVideoTaskId ||
          generationState.sceneVideoTaskId ||
          projectState?.scenes?.[0]?.videoTaskId ||
          null;
        videoUrl =
          generationState.segmentVideoUrl ||
          generationState.sceneVideoUrl ||
          projectState?.scenes?.[0]?.videoUrl ||
          null;
      }

      if (!videoTaskId && progressSnapshot.quotaBlockedEvent) {
        break;
      }
    }

    const hasVideoElement = (await page.locator("video").count()) > 0;
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const transcriptShowsSuccess =
      /(素材库状态确认|素材库清单)/.test(bodyText) &&
      /(正在生成视频，请稍等|正在轮询视频生成状态|正在轮询生成结果)/.test(bodyText) &&
      (/(视频已生成|视频已自动显示在聊天框中|视频已显示在聊天框中|视频生成完成|已生成完成)/.test(bodyText) ||
        hasVideoElement);
    const consoleHighlights = consoleLogs.filter((line) =>
      /\[video\]|generate_video_assets|generate_segment_video|refresh_segment_video|refresh_video_assets|HomeStudioWorkflow|video-generating-start|video-generated/i.test(line),
    );
    const quotaBlockedEvent = detectVideoQuotaBlock(videoNetworkEvents);
    const completedVideoEvent = detectCompletedVideoResponse(videoNetworkEvents);
    const inferredVideoUrlFromNetwork = extractVideoUrlFromNetworkEvent(completedVideoEvent);

    if (!videoUrl && inferredVideoUrlFromNetwork) {
      videoUrl = inferredVideoUrlFromNetwork;
    }

    const inferredSuccess =
      Boolean(videoUrl) || hasVideoElement || transcriptShowsSuccess || Boolean(inferredVideoUrlFromNetwork);

    if (!videoTaskId && !inferredSuccess) {
      throw new Error(
        JSON.stringify(
          {
            reason: quotaBlockedEvent
              ? "Video submission reached the provider but was blocked by quota"
              : "Video workflow did not submit a real video task",
            quotaBlocked: Boolean(quotaBlockedEvent),
            quotaBlockedEvent,
            toolCallVisible,
            pendingBubbleVisible,
            refreshPromptSent,
            panelState,
            generationState,
            completedVideoEvent,
            videoNetworkEvents,
            consoleHighlights,
            pageErrors: errors,
            bodyTail: bodyText.slice(-2500),
          },
          null,
          2,
        ),
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: DEFAULT_URL,
          mode: SMOKE_MODE,
          startedLocalServer: server.startedLocalServer,
          projectId: payload.projectId,
          toolCallVisible,
          pendingBubbleVisible,
          refreshPromptSent,
          videoTaskId,
          videoUrl,
          completed: inferredSuccess,
          hasVideoElement,
          transcriptShowsSuccess,
          inferredFromTranscript: !generationState.segmentVideoUrl && !generationState.sceneVideoUrl && inferredSuccess,
          bodyEvidence: inferredSuccess ? bodyText.slice(-1200) : "",
          completedVideoEvent,
          videoNetworkEvents,
          consoleHighlights,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    if (browser) {
      await browser.close();
    }
    if (electronApp) {
      await electronApp.close();
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.rm(electronAppRootDir, { recursive: true, force: true });
    await server.dispose();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: DEFAULT_URL,
        mode: SMOKE_MODE,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
