import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const DEFAULT_URL = process.env.HOME_AGENT_SMOKE_URL || "http://127.0.0.1:8080";
const DEV_SERVER_PORT = new URL(DEFAULT_URL).port || "8080";
const OUTPUT_DIR = path.join(process.cwd(), "output", "playwright");

const VIDEO_PROJECTS_KEY = "storyforge_projects";

const PROJECT_ID = "video-project-sixgrid-refresh-web";
const SOURCE_PROJECT_ID = "drama-project-sixgrid-refresh-web";
const SEGMENT_LABEL = "1-2";
const NOW_ISO = "2026-05-21T10:00:00.000Z";

const LOCAL_FILES_ROOT = "E:\\smoke-files";
const LOCAL_VIDEO_PATH = `${LOCAL_FILES_ROOT}\\projects\\${PROJECT_ID}\\media\\videos\\segment-1-2.mp4`;
const LOCAL_FRAME_PATHS = Array.from({ length: 6 }, (_, index) =>
  `${LOCAL_FILES_ROOT}\\frames\\segment-1-2-kf-${index + 1}.svg`,
);

function buildFrameFixture(index) {
  const colors = ["#1f2937", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#f59e0b"];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    `<rect width="1280" height="720" fill="${colors[index] || "#111827"}"/>`,
    `<text x="64" y="128" font-size="72" fill="#f8fafc" font-family="Arial, sans-serif">Refresh ${index + 1}</text>`,
    `<text x="64" y="232" font-size="42" fill="#e2e8f0" font-family="Arial, sans-serif">Segment ${SEGMENT_LABEL} continuity smoke</text>`,
    `</svg>`,
  ].join("");
  return {
    mimeType: "image/svg+xml",
    base64: Buffer.from(svg, "utf8").toString("base64"),
  };
}

const FRAME_FIXTURES = Object.fromEntries(
  LOCAL_FRAME_PATHS.map((framePath, index) => [framePath, buildFrameFixture(index)]),
);

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Ignore and retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
      killer.on("exit", resolve);
      killer.on("error", resolve);
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
    throw new Error(`Failed to start the local homepage dev server at ${DEFAULT_URL}`);
  }

  return {
    startedLocalServer: true,
    dispose: async () => {
      await stopProcessTree(devServer);
    },
  };
}

async function waitForHomepageWorkbench(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || "";
      return (
        bodyText.includes("和 Agent 说出你的目标") ||
        bodyText.includes("主对话模型尚未就绪") ||
        bodyText.includes("正在恢复首页工作台") ||
        bodyText.includes("首页外壳已经就绪") ||
        document.querySelectorAll("textarea").length > 0
      );
    },
    { timeout: timeoutMs },
  );
}

function createVideoProjectSeed() {
  return {
    id: PROJECT_ID,
    title: "Six-grid refresh web smoke",
    script: "苏辰被重创后倒在演武场深坑中，随着压迫逼近，他的力量开始苏醒。",
    targetPlatform: "Douyin",
    shotStyle: "cinematic live-action wuxia",
    outputGoal: "Validate the continuity refresh button",
    productionNotes: "Manual refresh should extract frames from the formal segment video and persist a continuity grid.",
    sourceProjectId: SOURCE_PROJECT_ID,
    artStyle: "live-action",
    currentStep: 6,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    scenes: [
      {
        id: "scene-2a",
        sceneNumber: 2,
        sceneName: "演武场压迫",
        description: "苏辰染血倒在演武场深坑边缘，围观压力持续逼近。",
        characters: ["苏辰", "叶昊"],
        dialogue: "",
        cameraDirection: "wide push-in",
        duration: 6,
        segmentLabel: SEGMENT_LABEL,
      },
      {
        id: "scene-2b",
        sceneNumber: 3,
        sceneName: "觉醒前兆",
        description: "苏辰握紧裂纹木剑缓慢抬头，空气中的灵气开始异常波动。",
        characters: ["苏辰", "叶昊"],
        dialogue: "苏辰：今天，你这废柴就彻底消失吧！",
        cameraDirection: "tight dramatic rise",
        duration: 6,
        segmentLabel: SEGMENT_LABEL,
      },
    ],
    segmentVideoPrompts: {
      [SEGMENT_LABEL]: {
        segmentLabel: SEGMENT_LABEL,
        prompt: [
          "全局风格：电影级古装玄幻短剧质感，15秒，烈日之下的压抑肃杀氛围。",
          "视觉锚点：陆家演武场青石台，苏辰染血倒地，萧家执事步步紧逼。",
          "起始衔接：本段从压迫逼近与苏辰强撑意识开始，镜头持续缓慢推进。",
          "衔接原则：同一长片时间线，按分镜顺序推进。",
          "镜头推进：",
          "分镜1（0-6秒）：苏辰倒在深坑边缘，围观者的嘲笑和压迫感逐步逼近。",
          "分镜2（6-12秒）：苏辰握紧裂纹木剑，空气中的尘土与灵气开始异常波动。",
          "环境细节：青石地面反光刺眼，衣摆和烟尘被气压带动，金属回响压住呼吸声。",
          "结尾钩子：苏辰缓慢抬头，压抑已久的力量即将彻底觉醒。",
          "通用后缀： 无字幕、无水印、无屏幕文字",
        ].join("\n"),
        duration: 12,
        targetDuration: 12,
        modelKey: "doubao-seedance-2-0-260128",
        maxDurationForModel: 15,
        sceneIds: ["scene-2a", "scene-2b"],
        generatedAt: NOW_ISO,
      },
    },
    segmentVideos: {
      [SEGMENT_LABEL]: LOCAL_VIDEO_PATH,
    },
    segmentContinuityGridImages: {},
    assetManifest: { items: [] },
    shotPackets: [],
    reviewQueue: [],
    characters: [],
    sceneSettings: [],
  };
}

function buildElectronInitPayload() {
  return {
    videoProjectsKey: VIDEO_PROJECTS_KEY,
    filesRoot: LOCAL_FILES_ROOT,
    localVideoPath: LOCAL_VIDEO_PATH,
    frameFixtures: FRAME_FIXTURES,
    projectSeed: createVideoProjectSeed(),
  };
}

async function resetAndSeed(page, seed) {
  await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate((payload) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(payload)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }, seed);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
}

async function openHistoryProject(page, title) {
  await page.getByText("对话历史").first().waitFor({ state: "visible", timeout: 10000 });
  const button = page.getByRole("button", { name: new RegExp(title) }).first();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await button.click();
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const server = await ensureServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
    });

    await context.addInitScript((payload) => {
      const fileStore = new Map();
      const frameFixtures = payload.frameFixtures;
      for (const [filePath, fixture] of Object.entries(frameFixtures)) {
        fileStore.set(filePath, fixture);
      }

      fileStore.set(payload.localVideoPath, {
        mimeType: "video/mp4",
        base64: "AA==",
      });

      Object.defineProperty(window, "electronAPI", {
        configurable: true,
        writable: true,
        value: {
          runtime: {
            builtinApiBundle: {
              runninghubEndpoint: "",
              runninghubKey: "",
              jimengEndpoint: "",
              jimengKey: "",
            },
            builtinApiBundlePath: "",
          },
          media: {
            extractVideoFrames: async () => ({
              ok: true,
              framePaths: Object.keys(frameFixtures),
            }),
          },
          storage: {
            getDefaultPath: async () => ({ files: payload.filesRoot, db: `${payload.filesRoot}\\db` }),
            exists: async (filePath) => ({ ok: true, exists: fileStore.has(String(filePath)) }),
            writeText: async () => ({ ok: true }),
            readText: async () => ({ ok: true, exists: false, content: "" }),
            listDir: async () => ({ ok: true, entries: [] }),
            copyFile: async () => ({ ok: true }),
            readBase64: async (filePath) => {
              const hit = fileStore.get(String(filePath));
              if (!hit) return { ok: true, exists: false };
              return {
                ok: true,
                exists: true,
                base64: hit.base64,
                mimeType: hit.mimeType,
              };
            },
            writeBase64File: async ({ filePath, base64 }) => {
              fileStore.set(String(filePath), {
                mimeType: "image/jpeg",
                base64: String(base64 || ""),
              });
              return { ok: true, filePath };
            },
          },
        },
      });

    }, buildElectronInitPayload());

    const page = await context.newPage();
    const browserLogs = [];
    page.on("console", (message) => {
      browserLogs.push(message.text());
    });

    await resetAndSeed(page, {
      [VIDEO_PROJECTS_KEY]: [createVideoProjectSeed()],
    });
    await waitForHomepageWorkbench(page, 20000);
    await page.waitForTimeout(1200);
    await openHistoryProject(page, "Six-grid refresh web smoke");
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const events = [];
      window.__segmentContinuitySmokeEvents = events;
      window.addEventListener("agent:segment-continuity-extraction", (event) => {
        events.push(event.detail);
      });
    });

    const videoTab = page.getByRole("button", { name: /^视频(?:\s+\d+)?$/ }).first();
    await videoTab.click();

    const segmentRow = page.locator(`[data-sidebar-asset-id="segment:${SEGMENT_LABEL}:video"]`).first();
    await segmentRow.waitFor({ state: "visible", timeout: 15000 });

    await segmentRow.locator('[data-sidebar-asset-menu-trigger="true"]').click();
    const refreshButton = page.locator('[role="menuitem"][data-sidebar-segment-refresh="true"]').first();
    await refreshButton.waitFor({ state: "visible", timeout: 10000 });
    await refreshButton.click();

    await page.waitForFunction(
      ({ projectId, segmentLabel }) => {
        const events = window.__segmentContinuitySmokeEvents || [];
        const hasExtracting = events.some(
          (detail) =>
            detail?.projectId === projectId &&
            detail?.segmentLabel === segmentLabel &&
            detail?.status === "extracting",
        );
        const hasCompleted = events.some(
          (detail) =>
            detail?.projectId === projectId &&
            detail?.segmentLabel === segmentLabel &&
            detail?.status === "completed",
        );
        const projects = JSON.parse(window.localStorage.getItem("storyforge_projects") || "[]");
        const project = projects.find((entry) => entry?.id === projectId);
        const grid = project?.segmentContinuityGridImages?.[segmentLabel];
        const assetIds = Array.isArray(project?.assetManifest?.items)
          ? project.assetManifest.items.map((item) => item?.id)
          : [];
        return (
          hasExtracting &&
          hasCompleted &&
          grid?.imageUrl &&
          typeof grid?.recapText === "string" &&
          grid.recapText.trim().length > 0 &&
          assetIds.includes(`segment:${segmentLabel}:continuity-grid`)
        );
      },
      { projectId: PROJECT_ID, segmentLabel: SEGMENT_LABEL },
      { timeout: 20000 },
    );

    await page.locator('[data-sidebar-special-toggle="continuity"]').click();
    await page.locator('[data-sidebar-special-panel="continuity"]').waitFor({ state: "visible", timeout: 10000 });
    const gridTile = page.locator(`[data-sidebar-asset-id="segment:${SEGMENT_LABEL}:continuity-grid"]`).first();
    await gridTile.waitFor({ state: "visible", timeout: 10000 });

    const diagnostics = await page.evaluate(({ projectId, segmentLabel }) => {
      const projects = JSON.parse(window.localStorage.getItem("storyforge_projects") || "[]");
      const project = projects.find((entry) => entry?.id === projectId) || null;
      const continuityPanel = document.querySelector('[data-sidebar-special-panel="continuity"]');
      return {
        projectId: project?.id || null,
        grid: project?.segmentContinuityGridImages?.[segmentLabel] || null,
        assetIds: Array.isArray(project?.assetManifest?.items)
          ? project.assetManifest.items.map((item) => item?.id).filter(Boolean)
          : [],
        events: window.__segmentContinuitySmokeEvents || [],
        continuityPanelText: continuityPanel?.textContent || "",
      };
    }, { projectId: PROJECT_ID, segmentLabel: SEGMENT_LABEL });

    const screenshotPath = path.join(OUTPUT_DIR, "home-agent-sixgrid-refresh-web-smoke.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    assert.equal(diagnostics.projectId, PROJECT_ID);
    assert.ok(diagnostics.grid?.imageUrl, "expected continuity grid image url to be persisted");
    assert.ok(diagnostics.grid?.recapText?.includes("苏辰"), "expected persisted recap text to describe the plot");
    assert.ok(
      diagnostics.assetIds.includes(`segment:${SEGMENT_LABEL}:continuity-grid`),
      "expected continuity grid asset to be added to the manifest",
    );
    assert.ok(
      diagnostics.events.some((detail) => detail?.status === "extracting"),
      "expected extraction progress events",
    );
    assert.ok(
      diagnostics.events.some((detail) => detail?.status === "completed"),
      "expected extraction completion events",
    );

    const report = {
      ok: true,
      baseUrl: DEFAULT_URL,
      startedLocalServer: server.startedLocalServer,
      diagnostics,
      screenshotPath,
      consoleErrors: browserLogs.filter((entry) => /error/i.test(entry)),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    await server.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
