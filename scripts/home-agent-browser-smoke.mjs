import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_URL = process.env.HOME_AGENT_SMOKE_URL || "http://127.0.0.1:8080";
const DEV_SERVER_PORT = new URL(DEFAULT_URL).port || "8080";

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";
const DRAMA_PROJECTS_KEY = "storyforge_drama_projects";
const VIDEO_PROJECTS_KEY = "storyforge_projects";

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // Keep polling until timeout so the script can start its own local dev server.
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
    throw new Error(`未能在 ${DEFAULT_URL} 拉起首页开发服务器`);
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
    currentStep: 4,
    systemPrompt: "",
    analysisSummary: "已编译镜头指令包，等待审阅。",
    storyboardPlan: "镜头 1：雨夜追击",
    videoPromptBatch: "镜头 1 提示词",
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
        forbiddenChanges: ["不要改变主角色的识别特征和服装连续性"],
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

function sendButtonLocator(page) {
  return page.locator("button").filter({ has: page.locator(".lucide-send, .lucide-loader2") }).first();
}

async function openHistoryProject(page, title) {
  await page.getByText("对话历史").first().waitFor({ state: "visible", timeout: 10000 });
  const button = page.getByRole("button", { name: new RegExp(title) }).first();
  await button.waitFor({ state: "visible", timeout: 10000 });
  await button.click();
}

async function runIdleToActiveScenario(page) {
  await resetAndSeed(page, {});
  const textarea = page.getByPlaceholder(/和 Agent 说出你的目标/).first();
  await textarea.waitFor({ state: "visible", timeout: 10000 });

  const idleBottomGap = await textarea.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return window.innerHeight - rect.bottom;
  });

  await textarea.fill("我想做一个新项目");
  const sendButton = sendButtonLocator(page);
  assert.equal(await sendButton.isEnabled(), true, "发送按钮在输入后应可用");
  await sendButton.click();

  await page.getByText("我想做一个新项目").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(
    (previousGap) => {
      const areas = Array.from(document.querySelectorAll("textarea"));
      const textarea = areas.at(-1);
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      const rect = textarea.getBoundingClientRect();
      return window.innerHeight - rect.bottom < previousGap;
    },
    idleBottomGap,
    { timeout: 5000 },
  );

  const activeBottomGap = await page.locator("textarea").last().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return window.innerHeight - rect.bottom;
  });

  assert.equal(new URL(page.url()).pathname, "/", "首页发送后不应切换路由");
  assert.equal(activeBottomGap < idleBottomGap, true, "会话启动后输入框应更靠近底部");

  return {
    idleBottomGap,
    activeBottomGap,
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
  await page.getByText("继续保留第 2 集的张力。").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("继续选择题材").first().waitFor({ state: "visible", timeout: 10000 });
  const restoredDraft = await page.locator("textarea").last().inputValue();
  assert.equal(restoredDraft, "补充反派动机", "恢复历史剧本项目时应还原草稿输入");

  assert.equal(new URL(page.url()).pathname, "/", "恢复历史剧本项目时不应切换路由");

  return {
    restoredDraft,
  };
}

async function runAnalysisRecoveryScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject("drama-project-2")],
  });

  await openHistoryProject(page, "契约婚姻反转录");
  const recoverySignal = await Promise.any([
    page.getByText(/我已对照当前项目(?:产物|状态)做了恢复分析/).first().waitFor({ state: "visible", timeout: 10000 }).then(() => "summary"),
    page.locator('[data-composer-question-answer-key="script-creative-plan"]').first().waitFor({ state: "visible", timeout: 10000 }).then(() => "script-creative-plan"),
  ]).catch(() => null);
  assert.ok(
    recoverySignal,
    "opening a project without a saved session should either surface the recovery summary or the standard script-creative-plan workflow panel",
  );

  assert.equal(new URL(page.url()).pathname, "/", "无保存会话时应以首页摘要恢复而不是切页");

  return {
    recoverySignal,
  };
}

async function runVideoHistoryScenario(page) {
  await resetAndSeed(page, {
    [VIDEO_PROJECTS_KEY]: [createVideoProject()],
  });

  await openHistoryProject(page, "夜雨追击预告片");
  await page.getByRole("button", { name: "整理待审阅项" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "通过稳定项" }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: "逐条审阅" }).waitFor({ state: "visible", timeout: 10000 });

  assert.equal(new URL(page.url()).pathname, "/", "恢复历史视频项目时不应切换路由");

  return {
    reviewPromptVisible: true,
  };
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

  await page.getByRole("button", { name: "打开设置" }).first().click();
  await page.getByText("API 设置").first().waitFor({ state: "visible", timeout: 10000 });
  const afterSettingsDraft = await page.locator("textarea").last().inputValue();
  assert.equal(afterSettingsDraft, "补充反派动机", "打开设置后不应破坏当前首页会话草稿");

  return {
    beforeReloadDraft,
    afterReloadDraft,
    afterSettingsDraft,
  };
}

async function runMobileSidebarScenario(page) {
  await page.setViewportSize({ width: 430, height: 932 });
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_PROJECT_SESSIONS_KEY]: {
      "drama-project-1": createSession(),
    },
  });

  const menuButton = page.locator("header button").first();
  await menuButton.waitFor({ state: "visible", timeout: 10000 });
  await menuButton.click();

  await page.getByText("对话历史").last().waitFor({ state: "visible", timeout: 10000 });
  await page.locator('button[aria-label="契约婚姻反转录"]').last().click();

  await page.getByText("继续保留第 2 集的张力。").waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("继续选择题材").first().waitFor({ state: "visible", timeout: 10000 });
  await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });
  const restoredDraft = await page.locator("textarea").last().inputValue();
  assert.equal(restoredDraft, "补充反派动机", "移动端侧栏打开历史项目后应在首页恢复会话草稿");
  assert.equal(new URL(page.url()).pathname, "/", "移动端历史恢复后仍应停留在首页");

  return {
    restoredMessage: true,
    restoredQuestion: true,
    restoredDraft,
  };
}

async function runLongConversationCompactionScenario(page) {
  await resetAndSeed(page, {
    [DRAMA_PROJECTS_KEY]: [createDramaProject()],
    [STUDIO_SESSION_KEY]: createLongSession(),
  });

  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  await textarea.fill("继续往下推进");
  const sendButton = sendButtonLocator(page);
  assert.equal(await sendButton.isEnabled(), true, "长对话继续发送时按钮应保持可用");
  await sendButton.click();

  await page.getByText("继续往下推进").first().waitFor({ state: "visible", timeout: 10000 });
  await page.getByText("较早对话已静默整理").first().waitFor({ state: "visible", timeout: 10000 });
  assert.equal(new URL(page.url()).pathname, "/", "长对话压缩后仍应停留在首页");

  return {
    compactionHintVisible: true,
  };
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
      { timeout: 5000 },
    );
  }
  const after = await sidebar.boundingBox();

  assert.ok(before?.width && after?.width && after.width < before.width, "侧栏收起后宽度应变小");

  return {
    beforeWidth: before?.width ?? null,
    afterWidth: after?.width ?? null,
  };
}

async function main() {
  const server = await ensureServer();
  const browser = await chromium.launch({ headless: true });

  try {
    const runIsolated = async (scenario, viewport = { width: 1440, height: 980 }) => {
      const page = await browser.newPage({ viewport });
      try {
        return await scenario(page);
      } finally {
        await page.close();
      }
    };

    const idleToActive = await runIsolated(runIdleToActiveScenario);
    const sidebarCollapse = await runIsolated(runSidebarCollapseScenario);
    const savedHistory = await runIsolated(runSavedHistoryScenario);
    const analysisRecovery = await runIsolated(runAnalysisRecoveryScenario);
    const videoHistory = await runIsolated(runVideoHistoryScenario);
    const refreshPersistence = await runIsolated(runRefreshPersistenceScenario);
    const mobileSidebar = await runIsolated(runMobileSidebarScenario, { width: 430, height: 932 });
    const longConversationCompaction = await runIsolated(runLongConversationCompactionScenario);

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: DEFAULT_URL,
          startedLocalServer: server.startedLocalServer,
          scenarios: {
            idleToActive,
            sidebarCollapse,
            savedHistory,
            analysisRecovery,
            videoHistory,
            refreshPersistence,
            mobileSidebar,
            longConversationCompaction,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
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
