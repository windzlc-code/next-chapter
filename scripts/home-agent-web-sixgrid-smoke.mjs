import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const DEFAULT_URL = process.env.HOME_AGENT_SMOKE_URL || "http://127.0.0.1:8080";
const DEV_SERVER_PORT = new URL(DEFAULT_URL).port || "8080";
const MOCK_PORT = Number(process.env.HOME_AGENT_SIXGRID_MOCK_PORT || 4011);
const OUTPUT_DIR = path.join(process.cwd(), "output", "playwright");

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const VIDEO_PROJECTS_KEY = "storyforge_projects";
const CURRENT_PROJECT_KEY = "storyforge_current_project";
const VIDEO_PREFS_KEY = "storyforge-home-agent-video-prefs-v1";

const PROJECT_ID = "video-project-sixgrid-web";
const SOURCE_PROJECT_ID = "drama-project-sixgrid-web";
const SEGMENT_LABEL_PREVIOUS = "1-1";
const SEGMENT_LABEL_CURRENT = "1-2";
const NOW_ISO = "2026-05-18T10:00:00.000Z";

const GRID_IMAGE_URL = `http://127.0.0.1:${MOCK_PORT}/assets/segment-1-1-grid.jpg`;
const SCENE_IMAGE_URL = `http://127.0.0.1:${MOCK_PORT}/assets/courtyard-ref.jpg`;
const HERO_IMAGE_URL = `http://127.0.0.1:${MOCK_PORT}/assets/hero-ref.jpg`;
const GENERATED_VIDEO_URL = `http://127.0.0.1:${MOCK_PORT}/assets/generated-segment-1-2.mp4`;

const LOCAL_FILES_ROOT = "E:\\smoke-files";
const LOCAL_FRAME_PATHS = Array.from({ length: 6 }, (_, index) =>
  `${LOCAL_FILES_ROOT}\\frames\\segment-1-2-kf-${index + 1}.svg`,
);

const STATIC_IMAGE_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aR0AAAAASUVORK5CYII=",
  "base64",
);
const STATIC_VIDEO_BUFFER = Buffer.from("000000206674797069736F6D0000020069736F6D69736F3261766331", "hex");

function buildFrameFixture(index) {
  const colors = ["#1f2937", "#2563eb", "#7c3aed", "#059669", "#dc2626", "#f59e0b"];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
    `<rect width="1280" height="720" fill="${colors[index] || "#111827"}"/>`,
    `<text x="64" y="128" font-size="72" fill="#f8fafc" font-family="Arial, sans-serif">Frame ${index + 1}</text>`,
    `<text x="64" y="232" font-size="42" fill="#e2e8f0" font-family="Arial, sans-serif">Segment 1-2 continuity smoke</text>`,
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

function createCurrentProjectSnapshot() {
  return {
    projectId: PROJECT_ID,
    projectKind: "video",
    sourceProjectId: SOURCE_PROJECT_ID,
    title: "Six-grid continuity web smoke",
    currentObjective: "Verify segment 1-2 sends the previous segment six-grid as multi-reference image 1.",
    derivedStage: "视频生成",
    agentSummary: "This session validates the six-grid continuity submission chain.",
    recommendedActions: ["Generate segment 1-2 video"],
    artifacts: [],
    updatedAt: NOW_ISO,
  };
}

function createSessionSeed() {
  return {
    sessionId: "session-sixgrid-web",
    compactedMessageCount: 0,
    mode: "active",
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Continue validating the six-grid continuity submission chain.",
        createdAt: NOW_ISO,
      },
    ],
    currentProjectSnapshot: createCurrentProjectSnapshot(),
    recentMessageSummary: "assistant: Continue validating the six-grid continuity submission chain.",
    projectId: PROJECT_ID,
    draft: "",
    qState: null,
    selectedValues: [],
  };
}

function createVideoPrefsSeed() {
  return {
    modelKey: "doubao-seedance-2-0-260128",
    resolution: "2k",
    mode: "text-to-video",
    provider: "runninghub-seedance",
    aspectRatio: "16:9",
  };
}

function createVideoProjectSeed() {
  return {
    id: PROJECT_ID,
    title: "Six-grid continuity web smoke",
    script: "The previous segment recaps the kneeling buildup, and this segment continues with the forward surge.",
    targetPlatform: "Douyin",
    shotStyle: "cinematic live-action wuxia",
    outputGoal: "Validate the continuity submit chain",
    productionNotes: "Strict text-to-video. Multi-reference images should include only the previous six-grid plus role and scene anchors.",
    sourceProjectId: SOURCE_PROJECT_ID,
    artStyle: "live-action",
    currentStep: 6,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    scenes: [
      {
        id: "scene-1",
        sceneNumber: 1,
        sceneName: "Courtyard Fall",
        description: "Hero drops to one knee and locks eyes with the enemy.",
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "wide push-in",
        duration: 6,
        segmentLabel: SEGMENT_LABEL_PREVIOUS,
        storyboardUrl: `http://127.0.0.1:${MOCK_PORT}/assets/segment-1-1-tail.jpg`,
      },
      {
        id: "scene-2",
        sceneNumber: 2,
        sceneName: "Courtyard Counter",
        description: "Hero surges forward from the kneeling stance.",
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "tracking shot",
        duration: 6,
        segmentLabel: SEGMENT_LABEL_CURRENT,
        storyboardUrl: `http://127.0.0.1:${MOCK_PORT}/assets/segment-1-2-head.jpg`,
      },
      {
        id: "scene-3",
        sceneNumber: 3,
        sceneName: "Courtyard Clash",
        description: "Hero finishes the lunge and locks blades for the next beat.",
        characters: ["Hero"],
        dialogue: "",
        cameraDirection: "tight clash close-up",
        duration: 6,
        segmentLabel: SEGMENT_LABEL_CURRENT,
        storyboardUrl: `http://127.0.0.1:${MOCK_PORT}/assets/segment-1-2-tail.jpg`,
      },
    ],
    characters: [
      {
        id: "hero-1",
        name: "Hero",
        description: "Lead actor reference.",
        imageUrl: HERO_IMAGE_URL,
        isAIGenerated: false,
        source: "auto",
      },
    ],
    sceneSettings: [
      {
        id: "setting-courtyard",
        name: "Courtyard",
        description: "Stormy martial courtyard.",
        imageUrl: SCENE_IMAGE_URL,
        isAIGenerated: false,
        source: "auto",
      },
    ],
    videoGenerationPrefs: createVideoPrefsSeed(),
    segmentVideoPrompts: {
      [SEGMENT_LABEL_PREVIOUS]: {
        segmentLabel: SEGMENT_LABEL_PREVIOUS,
        prompt: [
          "全局风格：电影级真人武侠风格，6秒，烈日压场，空气里有扬尘和压迫感。",
          "视觉锚点：青石演武场深坑边缘，主角半跪在坑边，反派居高临下施压，金色剑光与扬尘保持一致。",
          "分镜1（0-3秒）：广角镜头缓慢推进，主角半跪在深坑边缘，肩背绷紧，反派继续压制，围观者的压迫感持续逼近。",
          "分镜2（3-6秒）：中近景转近景，主角抬眼锁定前方，右手木剑微微上提，情绪从压抑转向即将反击。",
          "环境细节：风压掀动衣摆，尘土绕着深坑盘旋，远处金属回响和短促呼吸持续压迫场面。",
          "结尾钩子：最后一帧停在主角抬眼蓄力、木剑将起未起的瞬间，为下一段直接接拍留出势能。",
          "通用后缀： 无字幕、无水印、无屏幕文字",
        ].join("\n"),
        duration: 6,
        targetDuration: 6,
        modelKey: "doubao-seedance-2-0-260128",
        maxDurationForModel: 15,
        sceneIds: ["scene-1"],
        generatedAt: NOW_ISO,
      },
      [SEGMENT_LABEL_CURRENT]: {
        segmentLabel: SEGMENT_LABEL_CURRENT,
        prompt: [
          "全局风格：电影级真人武侠风格，6秒，高反差光影与轻微手持压迫感并存。",
          "视觉锚点：同一座青石演武场，同一组主角、反派、扬尘和剑光关系保持连续。",
          "分镜1（0-3秒）：从上一段停住的位置直接接拍，主角猛地前冲起势，身体重心前压，视线死死锁定反派。",
          "分镜2（3-6秒）：镜头迅速贴近冲刺后的逼杀瞬间，动作余势继续向前，保留下一段能直接接上的爆发前停点。",
          "环境细节：脚步掀起碎尘，兵刃未碰先有风压挤开空气，压抑呼吸和衣摆破风感持续叠加。",
          "结尾钩子：最后一帧停在前冲势能尚未收完、兵刃即将正面碰撞的瞬间。",
          "通用后缀： 无字幕、无水印、无屏幕文字",
        ].join("\n"),
        duration: 6,
        targetDuration: 6,
        modelKey: "doubao-seedance-2-0-260128",
        maxDurationForModel: 15,
        sceneIds: ["scene-2", "scene-3"],
        generatedAt: NOW_ISO,
      },
    },
    segmentVideos: {
      [SEGMENT_LABEL_PREVIOUS]: `http://127.0.0.1:${MOCK_PORT}/assets/generated-segment-1-1.mp4`,
    },
    segmentContinuityGridImages: {
      [SEGMENT_LABEL_PREVIOUS]: {
        imageUrl: GRID_IMAGE_URL,
        recapText: "Recap: the previous segment moves from kneeling restraint into a rising counterattack.",
        frameUrls: Array.from({ length: 6 }, (_, index) =>
          `http://127.0.0.1:${MOCK_PORT}/assets/segment-1-1-kf-${index + 1}.jpg`,
        ),
        createdAt: NOW_ISO,
      },
    },
    assetManifest: { items: [] },
    shotPackets: [],
    reviewQueue: [],
  };
}

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

async function evaluateWithNavigationRetry(page, fn, arg, attempts = 3) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed/i.test(message) || index === attempts - 1) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await waitForHomepageWorkbench(page, 15000).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
  throw lastError ?? new Error("Failed to evaluate on page.");
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

async function createMockServer() {
  const records = {
    submitRequests: [],
    queryRequests: [],
    uploadRequests: [],
  };

  const server = http.createServer((req, res) => {
    const sendJson = (statusCode, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(statusCode, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-api-key",
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    };

    const sendBuffer = (statusCode, buffer, contentType) => {
      res.writeHead(statusCode, {
        "access-control-allow-origin": "*",
        "content-type": contentType,
        "content-length": buffer.length,
      });
      res.end(buffer);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-api-key",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/assets/")) {
      if (req.url.endsWith(".mp4")) {
        sendBuffer(200, STATIC_VIDEO_BUFFER, "video/mp4");
        return;
      }
      sendBuffer(200, STATIC_IMAGE_BUFFER, "image/png");
      return;
    }

    if (req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        if (req.url?.endsWith("/multimodal-video")) {
          const json = raw ? JSON.parse(raw) : {};
          records.submitRequests.push({ path: req.url, body: json });
          sendJson(200, { taskId: "mock-task-1", status: "RUNNING" });
          return;
        }
        if (req.url === "/openapi/v2/query") {
          const json = raw ? JSON.parse(raw) : {};
          records.queryRequests.push({ path: req.url, body: json });
          sendJson(200, {
            status: "SUCCEEDED",
            results: [{ type: "video", url: GENERATED_VIDEO_URL }],
          });
          return;
        }
        if (req.url === "/openapi/v2/media/upload/binary") {
          records.uploadRequests.push({ path: req.url, bodyLength: raw.length });
          sendJson(200, { download_url: `http://127.0.0.1:${MOCK_PORT}/assets/uploaded-reference.jpg` });
          return;
        }
        sendJson(404, { error: "Not found" });
      });
      return;
    }

    sendJson(404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve());
  });

  return {
    records,
    close: async () =>
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function buildElectronInitPayload() {
  return {
    builtinApiBundle: {
      runninghubEndpoint: `http://127.0.0.1:${MOCK_PORT}`,
      runninghubKey: "smoke-runninghub-key",
      jimengEndpoint: "",
      jimengKey: "",
    },
    filesRoot: LOCAL_FILES_ROOT,
    frameFixtures: FRAME_FIXTURES,
  };
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const server = await ensureServer();
  const mockServer = await createMockServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 980 },
    });

    await context.addInitScript(
      (payload) => {
        const fileStore = new Map();
        const frameFixtures = payload.frameFixtures;

        for (const [filePath, fixture] of Object.entries(frameFixtures)) {
          fileStore.set(filePath, fixture);
        }

        Object.defineProperty(window, "electronAPI", {
          configurable: true,
          writable: true,
          value: {
            runtime: {
              builtinApiBundle: payload.builtinApiBundle,
              builtinApiBundlePath: "",
            },
            jimeng: {
              writeFile: async (filePath, content) => {
                fileStore.set(String(filePath), {
                  mimeType: "video/mp4",
                  base64: String(content || ""),
                });
                return { ok: true };
              },
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
                if (!hit) {
                  return { ok: true, exists: false };
                }
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

        const sessionSeed = {
          sessionId: "session-sixgrid-web",
          compactedMessageCount: 0,
          mode: "active",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "Continue validating the six-grid continuity submission chain.",
              createdAt: "2026-05-18T10:00:00.000Z",
            },
          ],
          currentProjectSnapshot: {
            projectId: "video-project-sixgrid-web",
            projectKind: "video",
            sourceProjectId: "drama-project-sixgrid-web",
            title: "Six-grid continuity segment web smoke",
            currentObjective: "Verify segment 1-2 submits the previous six-grid as image 1 to the video model.",
            derivedStage: "视频生成",
            agentSummary: "This session validates the six-grid continuity segment chain.",
            recommendedActions: ["生成片段 1-2 视频"],
            artifacts: [],
            updatedAt: "2026-05-18T10:00:00.000Z",
          },
          recentMessageSummary: "assistant: Continue validating the six-grid continuity submission chain.",
          projectId: "video-project-sixgrid-web",
          draft: "",
          qState: null,
          selectedValues: [],
        };

        const videoPrefsSeed = {
          modelKey: "doubao-seedance-2-0-260128",
          resolution: "2k",
          mode: "text-to-video",
          provider: "runninghub-seedance",
          aspectRatio: "16:9",
        };

        window.localStorage.setItem("storyforge-home-agent-session-v1", JSON.stringify(sessionSeed));
        window.localStorage.setItem("storyforge-home-agent-video-prefs-v1", JSON.stringify(videoPrefsSeed));
      },
      buildElectronInitPayload(),
    );

    const page = await context.newPage();
    const browserLogs = [];
    page.on("console", (message) => {
      browserLogs.push(message.text());
    });

    await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForHomepageWorkbench(page, 20000);
    await page.waitForTimeout(800);

    const execution = await evaluateWithNavigationRetry(
      page,
      async ({ project, currentProjectSnapshot }) => {
        const { getApiConfig } = await import("/src/lib/api-config.ts");
        const {
          generateSegmentVideoAction,
          __setVideoWorkflowMediaSubmissionGuardDelayForTests,
        } = await import("/src/lib/home-agent/services/video-workflow-service.ts");

        __setVideoWorkflowMediaSubmissionGuardDelayForTests(0);

        window.localStorage.setItem("storyforge_projects", JSON.stringify([project]));
        window.localStorage.setItem("storyforge_current_project", project.id);

        const runtime = {
          sessionId: "session-video-1",
          currentProjectSnapshot,
          currentDramaProject: null,
          currentVideoProject: project,
          currentSetupDraft: null,
          skillDrafts: [],
          maintenanceReports: [],
          recentProjects: [currentProjectSnapshot],
          recentMessageSummary: "assistant: Continue validating the six-grid continuity submission chain.",
        };

        const result = await generateSegmentVideoAction({ segmentLabel: "1-2" }, runtime);

        if (result.imageUrls?.length) {
          window.dispatchEvent(
            new CustomEvent("agent:image-generated", {
              detail: {
                imageUrls: result.imageUrls,
                imageLabels: result.imageLabels,
                action: "generate_segment_video",
                actionLabel: "segment continuity smoke",
                count: result.imageUrls.length,
                contentSummary: "片段 1-2 · 前情六宫格",
              },
            }),
          );
        }

        __setVideoWorkflowMediaSubmissionGuardDelayForTests(null);

        return {
          apiConfig: getApiConfig(),
          resultSummary: result.summary,
          imageLabels: result.imageLabels ?? [],
          imageUrls: result.imageUrls ?? [],
          savedProject: result.data?.videoProject ?? null,
          savedGridImageUrl:
            result.data?.videoProject?.segmentContinuityGridImages?.["1-2"]?.imageUrl ?? null,
          savedGridImageBase64: result.data?.videoProject?.segmentContinuityGridImages?.["1-2"]?.imageUrl
            ? (await window.electronAPI?.storage?.readBase64?.(
                result.data.videoProject.segmentContinuityGridImages["1-2"].imageUrl,
              ))?.base64 ?? null
            : null,
        };
      },
      {
        project: createVideoProjectSeed(),
        currentProjectSnapshot: createCurrentProjectSnapshot(),
      },
    );
    await page.waitForTimeout(1500);

    const pageTextAfterExecution = await page.locator("body").innerText();
    assert.ok(
      !pageTextAfterExecution.includes("\u7247\u6bb5 1-2 \u00b7 \u524d\u60c5\u516d\u5bab\u683c"),
      "six-grid should not be rendered into the chat timeline",
    );

    await page.locator('[data-sidebar-special-toggle="continuity"]').click();
    await page.locator('[data-sidebar-special-panel="continuity"]').waitFor({ state: "visible", timeout: 15000 });
    const continuityDiagnostics = await page.evaluate(() => {
      const projects = JSON.parse(window.localStorage.getItem("storyforge_projects") || "[]");
      const storedProject = projects.find((project) => project?.id === "video-project-sixgrid-web") || null;
      const session = JSON.parse(window.localStorage.getItem("storyforge-home-agent-session-v1") || "null");
      const continuityPanel = document.querySelector('[data-sidebar-special-panel="continuity"]');
      return {
        currentProjectId: window.localStorage.getItem("storyforge_current_project"),
        storedAssetIds: Array.isArray(storedProject?.assetManifest?.items)
          ? storedProject.assetManifest.items.map((item) => item?.id).filter(Boolean)
          : [],
        sessionSnapshotProjectId: session?.currentProjectSnapshot?.projectId || null,
        sessionAssetIds: Array.isArray(session?.currentProjectSnapshot?.memory?.assetManifest?.items)
          ? session.currentProjectSnapshot.memory.assetManifest.items.map((item) => item?.id).filter(Boolean)
          : [],
        continuityPanelText: continuityPanel?.textContent || "",
      };
    });
    const executionDiagnostics = {
      resultSummary: execution.resultSummary,
      imageLabels: execution.imageLabels,
      imageUrls: execution.imageUrls,
      savedGridImageUrl: execution.savedGridImageUrl,
      savedProjectAssetIds: Array.isArray(execution.savedProject?.assetManifest?.items)
        ? execution.savedProject.assetManifest.items.map((item) => item?.id).filter(Boolean)
        : [],
      savedProjectSegmentVideoKeys: execution.savedProject?.segmentVideos
        ? Object.keys(execution.savedProject.segmentVideos)
        : [],
      savedProjectGridKeys: execution.savedProject?.segmentContinuityGridImages
        ? Object.keys(execution.savedProject.segmentContinuityGridImages)
        : [],
      submittedPrompt:
        mockServer.records.submitRequests[0]?.body?.prompt
          ? String(mockServer.records.submitRequests[0].body.prompt)
          : null,
    };
    try {
      await page
        .locator('[data-sidebar-asset-id="segment:1-2:continuity-grid"]')
        .first()
        .waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      throw new Error(
        `continuity asset was not visible: ${JSON.stringify(
          {
            message: error instanceof Error ? error.message : String(error),
            diagnostics: continuityDiagnostics,
            execution: executionDiagnostics,
          },
          null,
          2,
        )}`,
      );
    }

    const screenshotPath = path.join(OUTPUT_DIR, "home-agent-sixgrid-web-smoke.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    assert.equal(execution.apiConfig.runninghubKey, "smoke-runninghub-key");
    assert.equal(execution.apiConfig.runninghubEndpoint, `http://127.0.0.1:${MOCK_PORT}`);
    assert.equal(mockServer.records.submitRequests.length, 1, "expected exactly one provider submit request");
    assert.equal(mockServer.records.queryRequests.length, 1, "expected exactly one provider query request");
    assert.equal(mockServer.records.uploadRequests.length, 0, "did not expect reference upload fallback");

    const submitRequest = mockServer.records.submitRequests[0];
    const submitPayload = submitRequest.body;
    const submitPrompt = String(submitPayload.prompt || "");
    const submitImageUrls = Array.isArray(submitPayload.imageUrls) ? submitPayload.imageUrls : [];

    assert.ok(
      submitRequest.path.includes("/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video"),
      `unexpected submit path: ${submitRequest.path}`,
    );
    assert.deepEqual(submitImageUrls, [GRID_IMAGE_URL, SCENE_IMAGE_URL, HERO_IMAGE_URL]);
    assert.ok(submitPrompt.includes("逐图参考："), "expected prompt to include per-image explanation");
    assert.ok(submitPrompt.includes("图1：上一片段六宫格前情图"), "expected prompt to explain grid as 图1");
    assert.ok(!submitPrompt.includes("图1：上一片段真实末帧"), "prompt should not use previous tail frame as 图1");
    assert.ok(!submitPrompt.includes("上一片段真实末帧"), "prompt should not mention previous tail frame");
    assert.ok(submitPrompt.includes("图2：场景资产图"), "expected prompt to include scene anchor");
    assert.ok(submitPrompt.includes("图3：角色资产图"), "expected prompt to include role anchor");
    assert.deepEqual(execution.imageLabels, [], "segment workflow should not return six-grid chat labels");
    assert.deepEqual(execution.imageUrls, [], "segment workflow should not return six-grid chat images");
    assert.ok(execution.savedGridImageUrl, "expected continuity grid image to be persisted for segment 1-2");
    assert.ok(execution.savedGridImageBase64, "expected continuity grid image bytes to be readable");

    const exportedGridImagePath = path.join(OUTPUT_DIR, "home-agent-sixgrid-web-grid.jpg");
    await fs.writeFile(exportedGridImagePath, Buffer.from(execution.savedGridImageBase64, "base64"));

    const report = {
      ok: true,
      baseUrl: DEFAULT_URL,
      mockProviderBaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      startedLocalServer: server.startedLocalServer,
      runninghubConfig: {
        endpoint: execution.apiConfig.runninghubEndpoint,
        hasKey: Boolean(execution.apiConfig.runninghubKey),
      },
      submit: {
        path: submitRequest.path,
        imageUrlCount: submitImageUrls.length,
        imageUrls: submitImageUrls,
        conversionSlots: submitPayload.conversionSlots,
        containsGridFigure: submitPrompt.includes("图1：上一片段六宫格前情图"),
        containsTailFrameText: submitPrompt.includes("上一片段真实末帧"),
      },
      result: {
        summary: execution.resultSummary,
        imageLabels: execution.imageLabels,
        imageUrls: execution.imageUrls,
        savedGridImageUrl: execution.savedGridImageUrl,
        exportedGridImagePath,
        continuityPanelVisible: true,
      },
      artifacts: {
        screenshotPath,
      },
    };

    const reportPath = path.join(OUTPUT_DIR, "home-agent-sixgrid-web-smoke-report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));

    await context.close();
  } finally {
    await browser.close();
    await mockServer.close();
    await server.dispose();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: DEFAULT_URL,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
