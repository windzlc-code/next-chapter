import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import { chromium } from "playwright";

const BASE_URL = process.env.HOME_AGENT_PERF_URL || "http://127.0.0.1:8080/";
const DEV_SERVER_PORT = new URL(BASE_URL).port || "8080";

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // keep polling
    }
    await sleep(250);
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
  if (await waitForServer(BASE_URL, 2000)) {
    return { startedLocalServer: false, dispose: async () => {} };
  }

  const devServer =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `npm run dev -- --host 127.0.0.1 --port ${DEV_SERVER_PORT}`], {
          stdio: "ignore",
          windowsHide: true,
          cwd: process.cwd(),
          env: process.env,
        })
      : spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", DEV_SERVER_PORT], {
          stdio: "ignore",
          cwd: process.cwd(),
          env: process.env,
        });

  const ready = await waitForServer(BASE_URL, 30000);
  if (!ready) {
    await stopProcessTree(devServer);
    throw new Error(`Could not start dev server at ${BASE_URL}`);
  }

  return {
    startedLocalServer: true,
    dispose: async () => {
      await stopProcessTree(devServer);
    },
  };
}

function summarize(samples) {
  if (!samples.length) return { count: 0, avg: 0, max: 0, min: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    count: samples.length,
    avg: Number((total / samples.length).toFixed(2)),
    max: Number(sorted.at(-1).toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    p95: Number(sorted[p95Index].toFixed(2)),
  };
}

async function getStartupMetrics(page) {
  return await page.evaluate(async () => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const nodes = document.querySelectorAll("*").length;
    const memory = performance.memory?.usedJSHeapSize ?? null;
    return {
      domContentLoadedMs: nav ? Number(nav.domContentLoadedEventEnd.toFixed(2)) : null,
      loadMs: nav ? Number(nav.loadEventEnd.toFixed(2)) : null,
      firstContentfulPaintMs: fcp ? Number(fcp.startTime.toFixed(2)) : null,
      domNodes: nodes,
      jsHeapBytes: memory,
    };
  });
}

async function clickAndMeasure(page, locator, settle) {
  const startedAt = Date.now();
  await locator.click();
  await settle();
  return Date.now() - startedAt;
}

async function measureSettingsToggle(page, iterations = 20) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const open = page.locator('[data-home-settings-panel="desktop"]:not([aria-hidden="true"]), [data-home-settings-panel="mobile"]');
    const isOpen = await open.count().then((count) => count > 0 && open.first().isVisible().catch(() => false));
    const button = page.getByRole("button", { name: /打开或关闭设置/ }).first();
    if (!(await button.isVisible().catch(() => false))) {
      break;
    }
    const duration = await clickAndMeasure(page, button, async () => {
      await page.waitForFunction(
        (expected) => {
          const desktop = document.querySelector('[data-home-settings-panel="desktop"]');
          const mobile = document.querySelector('[data-home-settings-panel="mobile"]');
          const visible =
            (desktop instanceof HTMLElement &&
              desktop.getAttribute("aria-hidden") !== "true" &&
              getComputedStyle(desktop).visibility !== "hidden") ||
            (mobile instanceof HTMLElement && getComputedStyle(mobile).display !== "none");
          return expected ? visible : !visible;
        },
        !isOpen,
        { timeout: 3000 },
      );
    });
    samples.push(duration);
  }
  return summarize(samples);
}

async function measureSidebarToggle(page, iterations = 20) {
  const candidates = [/收起侧栏/, /展开侧栏/];
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    let button = null;
    for (const name of candidates) {
      const candidate = page.getByRole("button", { name }).first();
      if (await candidate.isVisible().catch(() => false)) {
        button = candidate;
        break;
      }
    }
    if (!button) break;
    const ariaLabel = await button.getAttribute("aria-label");
    const collapsing = /收起/.test(ariaLabel || "");
    const duration = await clickAndMeasure(page, button, async () => {
      await page.waitForFunction(
        (expectedCollapsed) => {
          const nextButton =
            document.querySelector('button[aria-label="展开侧栏"]') ||
            document.querySelector('button[aria-label="收起侧栏"]');
          const label = nextButton?.getAttribute("aria-label") || "";
          return expectedCollapsed ? /展开侧栏/.test(label) : /收起侧栏/.test(label);
        },
        collapsing,
        { timeout: 3000 },
      );
    });
    samples.push(duration);
  }
  return summarize(samples);
}

async function measureChoicePanelToggle(page, iterations = 20) {
  const candidates = [/收起选择窗/, /展开选择窗/];
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    let button = null;
    for (const name of candidates) {
      const candidate = page.getByRole("button", { name }).first();
      if (await candidate.isVisible().catch(() => false)) {
        button = candidate;
        break;
      }
    }
    if (!button) break;
    const label = await button.getAttribute("aria-label");
    const collapsing = /收起/.test(label || "");
    const duration = await clickAndMeasure(page, button, async () => {
      await page.waitForFunction(
        (expectedCollapsed) => {
          const nextButton =
            document.querySelector('button[aria-label="展开选择窗"]') ||
            document.querySelector('button[aria-label="收起选择窗"]');
          const nextLabel = nextButton?.getAttribute("aria-label") || "";
          return expectedCollapsed ? /展开选择窗/.test(nextLabel) : /收起选择窗/.test(nextLabel);
        },
        collapsing,
        { timeout: 3000 },
      );
    });
    samples.push(duration);
  }
  return summarize(samples);
}

async function measureTextareaInput(page, iterations = 60) {
  const textarea = page.locator("textarea").last();
  await textarea.waitFor({ state: "visible", timeout: 10000 });
  return await page.evaluate(async (count) => {
    const textarea = document.querySelector("textarea:last-of-type") || document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return { count: 0, avg: 0, max: 0, min: 0, p95: 0 };
    }
    textarea.focus();
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const samples = [];
    for (let index = 0; index < count; index += 1) {
      const startedAt = performance.now();
      textarea.value += String(index % 10);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push(performance.now() - startedAt);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const total = samples.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      count: samples.length,
      avg: Number((total / samples.length).toFixed(2)),
      max: Number(sorted.at(-1).toFixed(2)),
      min: Number(sorted[0].toFixed(2)),
      p95: Number(sorted[p95Index].toFixed(2)),
    };
  }, iterations);
}

async function measureLongRunDrift(page) {
  const before = await page.evaluate(() => ({
    domNodes: document.querySelectorAll("*").length,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  }));
  const settings = await measureSettingsToggle(page, 40);
  const sidebar = await measureSidebarToggle(page, 40);
  const after = await page.evaluate(() => ({
    domNodes: document.querySelectorAll("*").length,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  }));
  return {
    settings,
    sidebar,
    domNodeDelta: after.domNodes - before.domNodes,
    jsHeapDeltaBytes:
      typeof before.jsHeapBytes === "number" && typeof after.jsHeapBytes === "number"
        ? after.jsHeapBytes - before.jsHeapBytes
        : null,
  };
}

async function main() {
  const server = await ensureServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 30000 });
    await page.locator("textarea").last().waitFor({ state: "visible", timeout: 10000 });

    const startup = await getStartupMetrics(page);
    const settingsToggle = await measureSettingsToggle(page, 20);
    const sidebarToggle = await measureSidebarToggle(page, 20);
    const choicePanelToggle = await measureChoicePanelToggle(page, 20);
    const textareaInput = await measureTextareaInput(page, 80);
    const longRun = await measureLongRunDrift(page);

    assert.equal(consoleErrors.length, 0, `Console errors detected: ${consoleErrors.join(" | ")}`);
    assert.equal(pageErrors.length, 0, `Page errors detected: ${pageErrors.join(" | ")}`);
    assert.ok((startup.loadMs ?? 0) < 6000, `Startup load too slow: ${startup.loadMs}ms`);
    assert.ok(settingsToggle.avg < 300, `Settings toggle avg too slow: ${settingsToggle.avg}ms`);
    assert.ok(settingsToggle.p95 < 450, `Settings toggle p95 too slow: ${settingsToggle.p95}ms`);
    assert.ok(sidebarToggle.avg < 350, `Sidebar toggle avg too slow: ${sidebarToggle.avg}ms`);
    assert.ok(sidebarToggle.p95 < 550, `Sidebar toggle p95 too slow: ${sidebarToggle.p95}ms`);
    if (choicePanelToggle.count > 0) {
      assert.ok(choicePanelToggle.avg < 250, `Choice panel toggle avg too slow: ${choicePanelToggle.avg}ms`);
    }
    assert.ok(textareaInput.avg < 20, `Textarea input avg too slow: ${textareaInput.avg}ms`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl: BASE_URL,
          startedLocalServer: server.startedLocalServer,
          startup,
          console: {
            warnings: consoleWarnings,
            errors: consoleErrors,
            pageErrors,
          },
          interactions: {
            settingsToggle,
            sidebarToggle,
            choicePanelToggle,
            textareaInput,
            longRun,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close();
    await browser.close();
    await server.dispose();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: BASE_URL,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
