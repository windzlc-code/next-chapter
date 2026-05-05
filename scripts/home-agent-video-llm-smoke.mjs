import assert from "node:assert/strict";
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

const API_CONFIG_KEY = "storyforge_api_config";
const TEXT_MODEL_KEY = "storyforge-home-agent-text-model-v1";
const VIDEO_PREFS_KEY = "storyforge-home-agent-video-prefs-v1";
const CURRENT_PROJECT_KEY = "storyforge_current_project";
const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
const VIDEO_PROJECTS_KEY = "storyforge_projects";

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

async function resolveSmokeCredentials() {
  const builtin = await readBuiltinApiConfig();
  const apiKey = process.env.HOME_AGENT_SMOKE_API_KEY || "";

  return {
    textApiKey: pickFirstNonEmpty(
      process.env.HOME_AGENT_SMOKE_TEXT_API_KEY,
      apiKey,
      builtin.claudeKey,
      builtin.geminiKey,
      builtin.gptKey,
      builtin.grokKey,
      builtin.jimengKey,
    ),
    videoApiKey: pickFirstNonEmpty(
      process.env.HOME_AGENT_SMOKE_VIDEO_API_KEY,
      apiKey,
      builtin.jimengKey,
      builtin.geminiKey,
    ),
  };
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
    await new Promise((resolve) => setTimeout(resolve, 500));
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

function createSeedPayload({ textApiKey, videoApiKey }) {
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
        sceneName: "雨夜追击",
        description:
          "雨夜小巷中，穿红色风衣的女主在镜头前方疾跑，跑动中突然回头，后方追兵身影逐渐逼近，路面反光，氛围紧张。",
        characters: ["女主", "追兵"],
        dialogue: "",
        cameraDirection: "中景跟拍，随后轻微推近到回头瞬间",
        duration: 4,
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
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "素材库已有分镜图，可直接从分镜图拆解 prompt 并发起视频生成。",
    storyboardPlan: "镜头1：雨夜追击，女主奔跑后猛然回头。",
    videoPromptBatch: "",
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
        renderMode: "img2video",
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
  };

  const apiConfig = {
    claudeEndpoint: "https://api.tu-zi.com/v1",
    claudeKey: textApiKey,
    geminiEndpoint: "https://api.tu-zi.com/v1beta",
    geminiKey: textApiKey,
    jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    jimengKey: videoApiKey,
    jimengExecutionMode: "api",
    modelMappings: {
      "claude-sonnet-4-6": "claude-sonnet-4-6",
      "gemini-3-flash-preview": "gemini-3-pro",
      "doubao-seedance-1-5-pro_720p": "ep-m-20260414192742-59w88",
      "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88",
    },
  };

  return {
    projectId,
    project,
    session,
    snapshot,
    localStorageSeed: {
      [API_CONFIG_KEY]: apiConfig,
      [TEXT_MODEL_KEY]: "claude-sonnet-4-6",
      [VIDEO_PREFS_KEY]: {
        modelKey: "doubao-seedance-1-5-pro",
        resolution: "720p",
      },
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
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, payload.localStorageSeed);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
}

async function waitForVisible(page, locator, timeout = 20_000) {
  await locator.first().waitFor({ state: "visible", timeout });
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

function sendButtonLocator(page) {
  return page.locator("button").filter({ has: page.locator(".lucide-send, .lucide-loader2") }).first();
}

async function maybeSendRefreshPrompt(page) {
  const textarea = page.locator("textarea").last();
  await waitForVisible(page, textarea, 10_000);
  await textarea.fill("继续调用 refresh_video_assets 轮询当前视频任务，直到视频在聊天框中显示出来。");
  const sendButton = sendButtonLocator(page);
  await waitForVisible(page, sendButton, 10_000);
  await sendButton.click();
}

async function readProjectState(page, projectId) {
  return page.evaluate((id) => {
    const raw = localStorage.getItem("storyforge_projects");
    const projects = raw ? JSON.parse(raw) : [];
    return projects.find((project) => project.id === id) || null;
  }, projectId);
}

async function main() {
  const { textApiKey, videoApiKey } = await resolveSmokeCredentials();

  if (!textApiKey.trim()) {
    throw new Error("HOME_AGENT_SMOKE_TEXT_API_KEY or HOME_AGENT_SMOKE_API_KEY is required");
  }
  if (!videoApiKey.trim()) {
    throw new Error("HOME_AGENT_SMOKE_VIDEO_API_KEY or HOME_AGENT_SMOKE_API_KEY is required");
  }

  const server = await ensureServer();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-video-smoke-"));
  const electronAppDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "home-agent-video-electron-"));
  let browser = null;
  let electronApp = null;
  let page;

  if (SMOKE_MODE === "electron") {
    const env = {
      ...process.env,
      VITE_DEV_SERVER_URL: DEFAULT_URL,
      APPDATA: electronAppDataDir,
      LOCALAPPDATA: electronAppDataDir,
      XDG_CONFIG_HOME: electronAppDataDir,
      XDG_DATA_HOME: electronAppDataDir,
      HOME: electronAppDataDir,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    electronApp = await electron.launch({
      args: [`--user-data-dir=${electronAppDataDir}`, "."],
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

  try {
    const payload = createSeedPayload({ textApiKey, videoApiKey });
    logProgress("seeding isolated browser session");
    await seedPage(page, payload);

    const textarea = page.locator("textarea").last();
    await waitForVisible(page, textarea, 20_000);
    const projectVisible = await ensureProjectVisible(page, payload.project.title);
    logProgress("homepage ready with seeded video project", {
      projectId: payload.projectId,
      projectVisible,
    });

    const prompt =
      "当前视频项目素材已经准备好，请不要追问，也不要让我去别的页面。你必须先调用 HomeStudioWorkflow 的 query_asset_status 确认素材库，再直接调用 generate_video_assets，用当前分镜图做视觉拆解生成文生视频提示词，喂给默认 seedance-1-5-pro 和 720p；不要把图片直接提交给视频模型。请使用支持的最短时长 4 秒。如果任务进入排队或处理中，请继续调用 refresh_video_assets 轮询，直到视频在聊天框中显示出来。";

    await textarea.fill(prompt);
    const sendButton = sendButtonLocator(page);
    await waitForVisible(page, sendButton, 10_000);
    await sendButton.click();
    logProgress("user prompt sent to homepage llm");

    await page.getByText(prompt).first().waitFor({ state: "visible", timeout: 20_000 });

    const toolCall = page.getByText("workflow:generate_video_assets").first();
    let toolCallVisible = false;
    try {
      await toolCall.waitFor({ state: "visible", timeout: 90_000 });
      toolCallVisible = true;
    } catch {
      toolCallVisible = false;
    }
    logProgress("tool call wait completed", { toolCallVisible });

    let pendingBubbleVisible = false;
    try {
      await page.getByText("正在生成视频，请稍等…").first().waitFor({ state: "visible", timeout: 90_000 });
      pendingBubbleVisible = true;
    } catch {
      pendingBubbleVisible = false;
    }
    logProgress("pending bubble wait completed", { pendingBubbleVisible });

    let projectState = await readProjectState(page, payload.projectId);
    let videoTaskId = projectState?.scenes?.[0]?.videoTaskId || null;
    let videoUrl = projectState?.scenes?.[0]?.videoUrl || null;
    logProgress("initial project state after llm run", {
      videoTaskId,
      videoUrl,
      videoStatus: projectState?.scenes?.[0]?.videoStatus || null,
    });

    if (!videoTaskId) {
      await page.waitForTimeout(10_000);
      projectState = await readProjectState(page, payload.projectId);
      videoTaskId = projectState?.scenes?.[0]?.videoTaskId || null;
      videoUrl = projectState?.scenes?.[0]?.videoUrl || null;
      logProgress("project state after retry", {
        videoTaskId,
        videoUrl,
        videoStatus: projectState?.scenes?.[0]?.videoStatus || null,
      });
    }

    const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    let refreshPromptSent = false;
    while (!videoUrl && Date.now() < pollDeadline) {
      await page.waitForTimeout(10_000);
      projectState = await readProjectState(page, payload.projectId);
      videoTaskId = projectState?.scenes?.[0]?.videoTaskId || null;
      videoUrl = projectState?.scenes?.[0]?.videoUrl || null;
      logProgress("polling project state", {
        videoTaskId,
        videoUrl,
        videoStatus: projectState?.scenes?.[0]?.videoStatus || null,
      });

      if (!videoUrl && videoTaskId && !refreshPromptSent && Date.now() + 120_000 < pollDeadline) {
        await maybeSendRefreshPrompt(page);
        refreshPromptSent = true;
        logProgress("sent explicit refresh prompt");
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
      /generate_video_assets|refresh_video_assets|HomeStudioWorkflow|video-generating-start|video-generated/i.test(line),
    );

    if (!videoTaskId && !videoUrl) {
      throw new Error(
        JSON.stringify(
          {
            reason: "LLM did not submit a real video task",
            toolCallVisible,
            pendingBubbleVisible,
            refreshPromptSent,
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
          completed: Boolean(videoUrl),
          hasVideoElement,
          transcriptShowsSuccess,
          inferredFromTranscript: false,
          bodyEvidence: transcriptShowsSuccess ? bodyText.slice(-1200) : "",
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
    await fs.rm(electronAppDataDir, { recursive: true, force: true });
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
