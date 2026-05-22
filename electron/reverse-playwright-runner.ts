import path from "node:path";
import fs from "node:fs";
import { app, session as electronSession } from "electron";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import {
  buildFillPromptScript,
  buildLocatePromptAreaScript,
  buildReadPromptScopeStateScript,
  buildReadPromptValueScript,
  buildSubmitCurrentPromptStrictScript,
  buildWaitForPromptScopeReadyScript,
} from "../src/lib/reverse-browserview-scripts";
import {
  selectAspectRatioInDom,
  selectFullReferenceInDom,
  selectModelInDom,
} from "../src/lib/reverse-playwright-dom";

export interface ReverseRunnerRefFile {
  fileName: string;
  url?: string;
  dataUrl?: string;
}

export interface ReverseRunnerPrepareParams {
  url: string;
  model: string;
  duration: string;
  aspectRatio?: string;
  prompt: string;
  refs: ReverseRunnerRefFile[];
  headless?: boolean;
}

export interface ReverseRunnerSegment {
  segmentKey: string;
  prompt: string;
  refs: ReverseRunnerRefFile[];
}

export interface ReverseRunnerRunParams {
  url: string;
  model: string;
  duration: string;
  aspectRatio?: string;
  segments: ReverseRunnerSegment[];
  headless?: boolean;
}

export interface ReverseRunnerSegmentResult {
  segmentKey: string;
  ok: boolean;
  uploadedCount?: number;
  promptLength?: number;
  error?: string;
}

interface ReversePromptContext {
  fileInputIndex: number;
  textboxIndex: number;
}

export interface ReverseRunnerResult {
  ok: boolean;
  logs: string[];
  currentModel?: string;
  currentDuration?: string;
  uploadedCount?: number;
  promptLength?: number;
  screenshotBase64?: string;
  error?: string;
  segments?: ReverseRunnerSegmentResult[];
}

function normalize(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function normalizeModelText(text: string): string {
  const normalized = normalize(text);
  if (/^Seedance 2\.0 Fast\b/i.test(normalized)) return "Seedance 2.0 Fast";
  if (/^Seedance 2\.0\b/i.test(normalized)) return "Seedance 2.0";
  return normalized;
}

function normalizeDurationText(text: string): string {
  const normalized = normalize(text);
  const match = normalized.match(/\b(\d+s)\b/i);
  return match ? match[1] : normalized;
}

function normalizePromptValue(text: string): string {
  return String(text || "").replace(/\r\n?/g, "\n");
}

const UI_TIMINGS = {
  pollMs: 80,
  overlaySettleMs: 120,
  modeDetectMs: 900,
  modeSwitchMs: 1400,
  selectionMs: 1600,
  uploadMs: 800,
  promptFillMs: 1200,
  postSubmitMs: 180,
} as const;

export class ReversePlaywrightRunner {
  private context: BrowserContext | null = null;

  private page: Page | null = null;

  private headless = true;

  private getUserDataDir(): string {
    return path.join(app.getPath("userData"), "reverse_playwright_profile");
  }

  private logLine(logs: string[], step: string, message: string) {
    logs.push(`[${step}] ${message}`);
  }

  private async clickLocator(
    locator: Locator,
    logs: string[],
    label: string,
  ) {
    try {
      await locator.click({ timeout: 5000 });
      return;
    } catch (error) {
      this.logLine(
        logs,
        label,
        `normal click failed, retry with force: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await locator.evaluate((el) => {
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
        }
      });
      return;
    } catch (error) {
      this.logLine(
        logs,
        label,
        `dom click failed, retry with force: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await locator.click({ timeout: 5000, force: true });
  }

  private async dismissInterferingOverlays(page: Page, logs: string[]) {
    const candidates = [
      page.getByRole("button", { name: /(?:\u540c\u610f|accept)/i }).first(),
      page.getByRole("button", { name: /(?:\u77e5\u9053\u4e86|ok|got it)/i }).first(),
      page.getByRole("button", { name: /(?:\u5173\u95ed|close)/i }).first(),
      page.getByRole("button", { name: /(?:\u53d6\u6d88|cancel)/i }).first(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await this.clickLocator(locator, logs, "overlay");
        await page.waitForTimeout(UI_TIMINGS.overlaySettleMs);
      }
    }

    await page.keyboard.press("Escape").catch(() => {});

    const neutralized = await page.evaluate(() => {
      const blockers = Array.from(
        document.querySelectorAll(
          ".lv-modal-mask, .lv-modal-wrapper, .dialog-wrapper-gzPtjx, .side-drawer-panel, .header-video-SDyhiM, video",
        ),
      );
      for (const node of blockers) {
        if (!(node instanceof HTMLElement)) continue;
        node.style.pointerEvents = "none";
      }
      return blockers.length;
    }).catch(() => {});
    if (typeof neutralized === "number" && neutralized > 0) {
      this.logLine(logs, "overlay", `neutralized ${neutralized} overlay blockers`);
    }
  }

  private async waitForPageCondition(
    page: Page,
    check: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = UI_TIMINGS.pollMs,
  ): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (await check()) return true;
      await page.waitForTimeout(intervalMs);
    }
    return false;
  }

  private async waitForVideoGeneratorToolbar(
    page: Page,
    timeoutMs: number = UI_TIMINGS.modeDetectMs,
  ): Promise<boolean> {
    return this.waitForPageCondition(
      page,
      async () => {
        const texts = await this.getVisibleComboboxTexts(page);
        return texts.some((text) => text.includes("Seedance 2.0"));
      },
      timeoutMs,
    );
  }

  private async waitForSelectionValue(
    page: Page,
    key: "currentModel" | "currentDuration" | "currentReference",
    predicate: (value: string) => boolean,
    timeoutMs: number = UI_TIMINGS.selectionMs,
  ): Promise<boolean> {
    return this.waitForPageCondition(
      page,
      async () => predicate((await this.readSelections(page))[key] || ""),
      timeoutMs,
    );
  }

  private async waitForPromptValue(
    page: Page,
    textboxIndex: number,
    expectedPrompt: string,
    timeoutMs: number = UI_TIMINGS.promptFillMs,
  ): Promise<string> {
    const normalizedExpected = normalizePromptValue(expectedPrompt);
    let latestValue = "";
    const matched = await this.waitForPageCondition(
      page,
      async () => {
        latestValue = await page
          .evaluate(
            (source) => eval(source),
            buildReadPromptValueScript(textboxIndex),
          )
          .catch(() => "");
        return normalizePromptValue(latestValue) === normalizedExpected;
      },
      timeoutMs,
    );
    return matched ? latestValue : "";
  }

  private async waitForFileInputsToSettle(
    page: Page,
    fileInputIndex: number,
    expectedUploads: number,
    timeoutMs: number = UI_TIMINGS.uploadMs,
  ): Promise<boolean> {
    const expectedVisibleInputs = Math.max(1, Math.min(expectedUploads, 2));
    return this.waitForPageCondition(
      page,
      async () =>
        page.evaluate(
          ({ fileInputIndex: startIndex, expectedVisibleInputs: expectedCount }) => {
            const inputs = Array.from(
              document.querySelectorAll("input[type='file']"),
            ) as HTMLInputElement[];
            let readyCount = 0;
            for (
              let offset = 0;
              offset < expectedCount && startIndex + offset < inputs.length;
              offset += 1
            ) {
              const input = inputs[startIndex + offset];
              if (input?.files?.length) {
                readyCount += 1;
              }
            }
            return readyCount >= expectedCount;
          },
          { fileInputIndex, expectedVisibleInputs },
        ),
      timeoutMs,
    );
  }

  private async syncCookiesFromElectron(logs: string[]) {
    if (!this.context) return;
    try {
      const cookies = await electronSession.defaultSession.cookies.get({});
      const filtered = cookies
        .filter((cookie) =>
          /jianying\.com|dreamina\.cn|doubao\.com/i.test(cookie.domain),
        )
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expirationDate,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite:
            cookie.sameSite === "strict"
              ? "Strict"
              : cookie.sameSite === "lax"
                ? "Lax"
                : "None",
        })) as Parameters<BrowserContext["addCookies"]>[0];
      if (filtered.length > 0) {
        await this.context.addCookies(filtered);
        this.logLine(
          logs,
          "cookies",
          `synced ${filtered.length} cookies from electron session`,
        );
      }
    } catch (error) {
      this.logLine(
        logs,
        "cookies",
        `cookie sync skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureContext(
    url: string,
    headless = true,
    logs: string[],
  ): Promise<Page> {
    const needsRestart = !this.context || this.headless !== headless;
    if (needsRestart) {
      await this.close();
      const userDataDir = this.getUserDataDir();
      fs.mkdirSync(userDataDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        viewport: { width: 1440, height: 1100 },
        locale: "zh-CN",
      });
      this.headless = headless;
      this.logLine(
        logs,
        "launch",
        `started playwright (${headless ? "headless" : "headed"})`,
      );
      await this.syncCookiesFromElectron(logs);
    }

    if (!this.page || this.page.isClosed()) {
      this.page = this.context!.pages()[0] || (await this.context!.newPage());
    }

    if (!this.page.url() || this.page.url() !== url) {
      this.logLine(logs, "navigate", url);
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    await this.page.waitForLoadState("domcontentloaded");
    return this.page;
  }

  private async getVisibleComboboxTexts(page: Page): Promise<string[]> {
    return await page.evaluate(() => {
      const isVisible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      return Array.from(document.querySelectorAll("[role='combobox']"))
        .filter(isVisible)
        .map((node) => (node instanceof HTMLElement ? node.innerText : ""))
        .map((text) => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    });
  }

  private async readSelections(page: Page) {
    const texts = await this.getVisibleComboboxTexts(page);
    const rawModel = texts.find((text) => text.includes("Seedance 2.0")) || "";
    const rawDuration =
      texts.find((text) => /^\d+s$/.test(text) || /\b\d+s\b/.test(text)) || "";
    const rawReference =
      texts.find((text) => /reference/i.test(text)) || "";
    return {
      currentModel: normalizeModelText(rawModel),
      currentDuration: normalizeDurationText(rawDuration),
      currentReference: normalize(rawReference),
    };
  }

  private async clickComboboxByPredicate(
    page: Page,
    predicate: (text: string) => boolean,
    logs?: string[],
  ) {
    const combos = page.locator("[role='combobox']");
    const count = await combos.count();
    for (let i = 0; i < count; i += 1) {
      const combo = combos.nth(i);
      if (!(await combo.isVisible().catch(() => false))) continue;
      const text = normalize(await combo.innerText().catch(() => ""));
      if (predicate(text)) {
        if (logs) {
          await this.clickLocator(combo, logs, "combobox");
        } else {
          await combo.click({ timeout: 5000 });
        }
        return combo;
      }
    }
    return null;
  }

  private async ensureVideoGeneratorMode(page: Page, logs: string[]) {
    await this.dismissInterferingOverlays(page, logs);
    if (await this.waitForVideoGeneratorToolbar(page)) {
      this.logLine(logs, "mode", "video generator toolbar already visible");
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.dismissInterferingOverlays(page, logs);
      const leftGenerate = page.getByText(/^(?:\u751f\u6210|generate)$/i).nth(0);
      if (await leftGenerate.isVisible().catch(() => false)) {
        await this.clickLocator(leftGenerate, logs, "mode");
      }

      const videoEntry = page.getByText(/(?:\u89c6\u9891\u751f\u6210|video generation|video generator)/i).last();
      if (await videoEntry.isVisible().catch(() => false)) {
        await this.clickLocator(videoEntry, logs, "mode");
      }

      if (await this.waitForVideoGeneratorToolbar(page, UI_TIMINGS.modeSwitchMs)) {
        const combosAfter = await this.getVisibleComboboxTexts(page);
        this.logLine(
          logs,
          "mode",
          `attempt ${attempt}: ${combosAfter.join(" | ") || "no-combobox"}`,
        );
        return;
      }

      const combosAfter = await this.getVisibleComboboxTexts(page);
      this.logLine(
        logs,
        "mode",
        `attempt ${attempt}: ${combosAfter.join(" | ") || "no-combobox"}`,
      );
      if (combosAfter.some((text) => text.includes("Seedance 2.0"))) {
        return;
      }
    }

    throw new Error("video generator mode not found");
  }

  private async chooseModel(page: Page, targetModel: string, logs: string[]) {
    const current = await this.readSelections(page);
    if (current.currentModel === targetModel) {
      this.logLine(logs, "model", `already ${targetModel}`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.dismissInterferingOverlays(page, logs);
      const scriptedResult = await page
        .evaluate(selectModelInDom, { targetModel })
        .catch((error) => ({
          ok: false,
          step: error instanceof Error ? error.message : String(error),
          currentModel: "",
          debug: "",
        }));
      const matched = await this.waitForSelectionValue(
        page,
        "currentModel",
        (value) =>
          value === targetModel ||
          (targetModel === "Seedance 2.0 Fast" && value === "Seedance 2.0"),
      );

      const latest = await this.readSelections(page);
      this.logLine(
        logs,
        "model",
        `attempt ${attempt}: ${scriptedResult?.step || "unknown"} -> ${latest.currentModel || "unknown"}${scriptedResult?.debug ? ` / ${scriptedResult.debug}` : ""}`,
      );
      if (matched && latest.currentModel === targetModel) return;
      if (
        matched &&
        targetModel === "Seedance 2.0 Fast" &&
        latest.currentModel === "Seedance 2.0"
      ) {
        this.logLine(logs, "model", "fallback to Seedance 2.0");
        return;
      }
    }

    throw new Error(`failed to set model to ${targetModel}`);
  }

  private async chooseDuration(page: Page, targetDuration: string, logs: string[]) {
    const current = await this.readSelections(page);
    if (current.currentDuration === targetDuration) {
      this.logLine(logs, "duration", `already ${targetDuration}`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.dismissInterferingOverlays(page, logs);
      const combo = await this.clickComboboxByPredicate(
        page,
        (text) => /^\d+s$/.test(text) || /\b\d+s\b/.test(text),
        logs,
      );
      if (!combo) throw new Error("duration combobox not found");

      const option = page
        .getByRole("option")
        .filter({
          hasText: new RegExp(
            `\\b${targetDuration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          ),
        })
        .first();

      await option.waitFor({ state: "visible", timeout: 5000 });
      await this.clickLocator(option, logs, "duration");
      await this.waitForSelectionValue(
        page,
        "currentDuration",
        (value) => value === targetDuration,
      );

      const latest = await this.readSelections(page);
      this.logLine(
        logs,
        "duration",
        `attempt ${attempt}: ${latest.currentDuration || "unknown"}`,
      );
      if (latest.currentDuration === targetDuration) return;
    }

    throw new Error(`failed to set duration to ${targetDuration}`);
  }

  private async ensureFullReference(page: Page, logs: string[]) {
    const current = await this.readSelections(page);
    if (
      current.currentReference?.toLowerCase().includes("full reference")
    ) {
      this.logLine(logs, "reference", "already full reference");
      return;
    }
    await this.dismissInterferingOverlays(page, logs);
    const scriptedResult = await page.evaluate(selectFullReferenceInDom).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
      currentReference: "",
    }));
    if (scriptedResult?.ok) {
      await this.waitForSelectionValue(
        page,
        "currentReference",
        (value) => Boolean(value.trim()),
      );
      this.logLine(logs, "reference", `scripted full reference ready: ${scriptedResult.step}`);
      return;
    }
    const result = await page.evaluate(() => {
      const normalize = (value: string | null | undefined) =>
        (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const clickNode = (node: Element | null) => {
        const clickable =
          node instanceof HTMLElement
            ? node.closest("button, [role='button'], [role='tab'], [role='option'], [role='menuitem'], [role='combobox'], label, li, a") || node
            : null;
        if (!(clickable instanceof HTMLElement)) return "";
        clickable.scrollIntoView({ block: "center", inline: "center" });
        clickable.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        clickable.click();
        return normalize(clickable.innerText || clickable.textContent || "");
      };

      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], [role='tab'], [role='option'], [role='menuitem'], [role='combobox'], div, span, label, li"),
      ).filter(isVisible);

      const currentMode = nodes.find((node) => /reference/i.test(normalize(node.textContent || "")));
      if (!currentMode) return { ok: false, step: "reference-not-found" };

      clickNode(currentMode);
      const fullReference = nodes.find((node) => /full reference/i.test(normalize(node.textContent || "")));
      if (fullReference) {
        clickNode(fullReference);
        return { ok: true, step: "full-reference-selected" };
      }
      return { ok: false, step: "full-reference-option-not-found" };
    }).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
    }));

    if (result.ok) {
      await this.waitForSelectionValue(
        page,
        "currentReference",
        (value) => Boolean(value.trim()),
      );
      this.logLine(logs, "reference", "full reference ready");
      return;
    }

    this.logLine(logs, "reference", `keep current mode: ${result.step}`);
  }

  private async ensureAspectRatio(
    page: Page,
    targetAspectRatio: string,
    logs: string[],
  ) {
    await this.dismissInterferingOverlays(page, logs);
    const result = await page.evaluate(selectAspectRatioInDom, {
      targetAspectRatio,
    }).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
    }));

    if (!result.ok) {
      throw new Error(
        `aspect ratio control not found: ${targetAspectRatio} (${result.step})`,
      );
    }
    this.logLine(logs, "ratio", `${targetAspectRatio} ${result.step}`);
  }

  private async locatePromptContext(page: Page, logs: string[]) {
    const textarea = page
      .locator(
        "textarea",
      )
      .first();
    await textarea.waitFor({ state: "visible", timeout: 15000 });
    const fileInputIndex = await page.evaluate(() => {
      const isVisible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const textbox = Array.from(
        document.querySelectorAll("textarea,[role='textbox'],[contenteditable='true']"),
      ).find(isVisible) as HTMLElement | undefined;
      if (!textbox) return 0;
      const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
      const section = textbox.closest("[class*='section-generator']") || document;
      const targetInput =
        section.querySelector("input[type='file']") || fileInputs[0] || null;
      return targetInput
        ? Math.max(0, fileInputs.findIndex((item) => item === targetInput))
        : 0;
    });
    this.logLine(logs, "context", `resolved file input index ${fileInputIndex}`);
    return { textarea, fileInputIndex };
  }

  private async locatePromptContextViaScript(
    page: Page,
    logs: string[],
  ): Promise<ReversePromptContext> {
    const located = await page.evaluate(
      (source) => eval(source),
      buildLocatePromptAreaScript(),
    ).catch((error) => ({
      ok: false,
      fileInputIndex: 0,
      textboxIndex: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (!located?.ok) {
      throw new Error(
        `prompt context not found${located?.error ? `: ${located.error}` : ""}`,
      );
    }
    const fileInputIndex = Math.max(0, Number(located.fileInputIndex || 0));
    const textboxIndex = Math.max(0, Number(located.textboxIndex || 0));
    this.logLine(logs, "context", `resolved file input index ${fileInputIndex}`);
    this.logLine(logs, "context", `resolved textbox index ${textboxIndex}`);
    return { fileInputIndex, textboxIndex };
  }

  private async refsToPayloads(refs: ReverseRunnerRefFile[]) {
    return await Promise.all(
      refs.map(async (ref, index) => {
        if (ref.dataUrl) {
          const match = ref.dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
          if (!match) throw new Error(`invalid data url for ${ref.fileName}`);
          return {
            name: ref.fileName || `reference-${index + 1}.png`,
            mimeType: match[1],
            buffer: Buffer.from(match[2], "base64"),
          };
        }

        if (!ref.url) throw new Error(`missing ref source: ${ref.fileName}`);
        const response = await fetch(ref.url);
        if (!response.ok) {
          throw new Error(`failed to fetch ref: ${ref.url}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          name: ref.fileName || `reference-${index + 1}.jpg`,
          mimeType: response.headers.get("content-type") || "image/jpeg",
          buffer,
        };
      }),
    );
  }

  private async uploadRefs(
    page: Page,
    refs: ReverseRunnerRefFile[],
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    if (refs.length === 0) return 0;
    const { fileInputIndex } = promptContext;
    const payloads = await this.refsToPayloads(refs);
    const allInputs = page.locator("input[type='file']");
    const count = await allInputs.count();
    const firstInput = allInputs.nth(Math.max(0, Math.min(fileInputIndex, Math.max(0, count - 1))));
    await firstInput.setInputFiles([payloads[0]]);
    if (payloads.length > 1 && count > fileInputIndex + 1) {
      const secondInput = allInputs.nth(fileInputIndex + 1);
      await secondInput.setInputFiles([payloads[1]]);
    }
    await this.waitForFileInputsToSettle(page, fileInputIndex, payloads.length);
    await this.dismissInterferingOverlays(page, logs);
    this.logLine(logs, "upload", `uploaded ${Math.min(payloads.length, Math.max(1, count - fileInputIndex))} refs`);
    return payloads.length;
  }

  private async fillPrompt(
    page: Page,
    prompt: string,
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    const { fileInputIndex, textboxIndex } = promptContext;
    const result = await page.evaluate(
      (source) => eval(source),
      buildFillPromptScript(prompt, [], fileInputIndex, textboxIndex),
    ).catch((error) => ({
      ok: false,
      promptLength: 0,
      currentValue: "",
      message: error instanceof Error ? error.message : String(error),
    }));
    const immediateValue = typeof result?.currentValue === "string" ? result.currentValue : "";
    const readBack =
      (await this.waitForPromptValue(page, textboxIndex, prompt)) ||
      (await page.evaluate(
        (source) => eval(source),
        buildReadPromptValueScript(textboxIndex),
      ).catch(() => ""));
    if (!result?.ok) {
      throw new Error(`prompt fill failed: ${result?.message || "unknown"}`);
    }
    const normalizedPrompt = normalizePromptValue(prompt);
    const normalizedImmediate = normalizePromptValue(immediateValue);
    const normalizedReadBack = normalizePromptValue(readBack);
    const verified =
      normalizedImmediate === normalizedPrompt
        ? immediateValue
        : normalizedReadBack === normalizedPrompt
          ? readBack
          : "";
    if (!verified) {
      this.logLine(
        logs,
        "prompt",
        `verification mismatch expected=${normalizedPrompt.length} immediate=${normalizedImmediate.length} readBack=${normalizedReadBack.length}`,
      );
      throw new Error("prompt verification failed");
    }
    this.logLine(logs, "prompt", `filled ${prompt.length} chars`);
    return verified.length;
  }

  private async getVisibleSubmitButton(page: Page) {
    const textarea = page
      .locator("textarea")
      .filter({ hasNotText: /^$/ })
      .first();
    const textareaBox = await textarea.boundingBox().catch(() => null);
    const buttons = page.locator("button");
    const count = await buttons.count();
    let best: { index: number; score: number } | null = null;
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      const disabled = await button.isDisabled().catch(() => false);
      const box = await button.boundingBox().catch(() => null);
      if (!box) continue;
      const text = normalize(await button.innerText().catch(() => ""));
      let score = 0;
      if (box.width >= 24 && box.width <= 80 && box.height >= 24 && box.height <= 80) score += 120;
      if (!text) score += 150;
      if (/(?:submit|send|generate|\u63d0\u4ea4|\u53d1\u9001|\u751f\u6210)/i.test(text)) score += 60;
      if (/(?:Agent|\u81ea\u52a8|\u7075\u611f\u641c\u7d22|\u521b\u610f\u8bbe\u8ba1|\u53bb\u67e5\u770b|\u9996\u5e27|\u5c3e\u5e27|16:9|9:16|15s|5s)/.test(text)) score -= 300;
      if (disabled) score -= 10;
      if (textareaBox) {
        const verticalNear = box.top >= textareaBox.top - 24 && box.top <= textareaBox.bottom + 48;
        const rightSide = box.left >= textareaBox.x + textareaBox.width * 0.75;
        if (verticalNear) score += 100;
        if (rightSide) score += 140;
      }
      if (!best || score > best.score) {
        best = { index: i, score };
      }
    }
    return best ? buttons.nth(best.index) : null;
  }

  private async getPreferredSubmitButton(page: Page, logs?: string[]) {
    const best = await page.evaluate(() => {
      const normalize = (value: string | null | undefined) =>
        (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (node: Element) => {
        if (!(node instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const textarea = Array.from(document.querySelectorAll("textarea")).find(
        isVisible,
      ) as HTMLTextAreaElement | undefined;
      const textareaBox = textarea?.getBoundingClientRect() || null;
      const allButtons = Array.from(
        document.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      const scored = allButtons.flatMap((button, domIndex) => {
        if (!isVisible(button)) return [];
        const rect = button.getBoundingClientRect();
        const text = normalize(button.innerText || button.textContent || "");
        const cls = normalize(button.className || "");
        const aria = normalize(button.getAttribute("aria-label") || "");
        let score = 0;
        if (/submit-button|send|generate/i.test(cls)) score += 600;
        if (/swap-button|button-YBvLch|button-vIZAMt/.test(cls)) score -= 500;
        if (button.disabled) score -= 200;
        if (rect.width >= 28 && rect.width <= 52 && rect.height >= 28 && rect.height <= 52) score += 160;
        if (rect.width >= 24 && rect.width <= 80 && rect.height >= 24 && rect.height <= 80) score += 80;
        if (!text && /submit-button/i.test(cls)) score += 140;
        if (!text && !/submit-button/i.test(cls)) score -= 120;
        if (/submit|send|generate/i.test(`${text} ${aria} ${cls}`)) score += 120;
        if (/(?:Agent|\u81ea\u52a8|\u7075\u611f\u641c\u7d22|\u521b\u610f\u8bbe\u8ba1|\u53bb\u67e5\u770b|\u9996\u5e27|\u5c3e\u5e27|16:9|9:16|15s|5s)/.test(text)) score -= 300;
        if (textareaBox) {
          const verticalNear =
            rect.top >= textareaBox.top - 24 &&
            rect.top <= textareaBox.bottom + 48;
          const rightSide =
            rect.left >= textareaBox.left + textareaBox.width * 0.75;
          const farLeft =
            rect.left <= textareaBox.left + textareaBox.width * 0.25;
          if (verticalNear) score += 120;
          if (rightSide) score += 200;
          if (farLeft) score -= 120;
        }
        return {
          domIndex,
          score,
          text,
          cls,
          disabled: button.disabled,
        };
      }).sort((a, b) => b.score - a.score);
      return scored[0] || null;
    });
    if (best && logs) {
      this.logLine(
        logs,
        "submit",
        `candidate domIndex=${best.domIndex} score=${best.score} text="${best.text}" cls="${best.cls}" disabled=${best.disabled}`,
      );
    }
    if (!best) return null;
    return page.locator("button").nth(best.domIndex);
  }

  private async readPromptScopeState(
    page: Page,
    promptContext: ReversePromptContext,
  ) {
    return await page.evaluate(
      (source) => eval(source),
      buildReadPromptScopeStateScript(promptContext.textboxIndex),
    ).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
      promptValue: "",
      signalTextKey: "",
      signalTexts: [],
      taskIndicatorCount: 0,
      hasPostSubmitSignals: false,
      submitButton: null,
    }));
  }

  private hasPromptScopeSubmissionAdvanced(
    beforeState: Awaited<ReturnType<ReversePlaywrightRunner["readPromptScopeState"]>>,
    afterState: Awaited<ReturnType<ReversePlaywrightRunner["readPromptScopeState"]>>,
  ) {
    if (!afterState?.ok) return false;
    const submitChanged =
      !!beforeState?.submitButton !== !!afterState?.submitButton ||
      beforeState?.submitButton?.disabled !== afterState?.submitButton?.disabled ||
      beforeState?.submitButton?.className !== afterState?.submitButton?.className ||
      beforeState?.submitButton?.text !== afterState?.submitButton?.text;
    const signalsChanged =
      beforeState?.signalTextKey !== afterState?.signalTextKey ||
      beforeState?.taskIndicatorCount !== afterState?.taskIndicatorCount;
    const promptChanged =
      normalizePromptValue(beforeState?.promptValue || "") !==
      normalizePromptValue(afterState?.promptValue || "");
    const submitDisappeared =
      !!beforeState?.submitButton && !afterState?.submitButton;
    return (
      ((submitChanged || signalsChanged) &&
        (afterState?.hasPostSubmitSignals || !!afterState?.submitButton?.disabled)) ||
      (promptChanged && (afterState?.hasPostSubmitSignals || signalsChanged || submitDisappeared)) ||
      (submitDisappeared && promptChanged)
    );
  }

  private async confirmPromptScopeSubmission(
    page: Page,
    promptContext: ReversePromptContext,
    beforeState: Awaited<ReturnType<ReversePlaywrightRunner["readPromptScopeState"]>>,
    timeoutMs = 4000,
  ) {
    const startedAt = Date.now();
    let latestState = beforeState;
    while (Date.now() - startedAt <= timeoutMs) {
      await page.waitForTimeout(UI_TIMINGS.pollMs);
      latestState = await this.readPromptScopeState(page, promptContext);
      if (this.hasPromptScopeSubmissionAdvanced(beforeState, latestState)) {
        return { ok: true, state: latestState };
      }
    }
    return { ok: false, state: latestState };
  }

  private async submitCurrentPrompt(
    page: Page,
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    await this.dismissInterferingOverlays(page, logs);
    const textarea = page
      .locator(
        "textarea",
      )
      .first();
    const beforeValue = await page.evaluate(
      (source) => eval(source),
      buildReadPromptValueScript(promptContext.textboxIndex),
    ).catch(() => "");
    const scriptedResult = await page.evaluate(
      (source) => eval(source),
      buildSubmitCurrentPromptStrictScript(promptContext.textboxIndex),
    ).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
    }));
    if (scriptedResult?.ok) {
      this.logLine(logs, "submit", `scripted submit accepted: ${scriptedResult.step}`);
      await page.waitForTimeout(UI_TIMINGS.postSubmitMs);
      return;
    }
    const submitButton = await this.getPreferredSubmitButton(page, logs);
    if (!submitButton) throw new Error("submit button not found");

    let beforeDisabled = await submitButton.isDisabled().catch(() => false);
    if (beforeDisabled) {
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll("button")).find(
            (node) =>
              /submit-button|send|generate/i.test(
                (node as HTMLElement).className || "",
              ),
          ) as HTMLButtonElement | undefined;
          return !!button && !button.disabled;
        },
        { timeout: 10000 },
      ).catch(() => {});
      beforeDisabled = await submitButton.isDisabled().catch(() => false);
    }
    await this.dismissInterferingOverlays(page, logs);
    await this.clickLocator(submitButton, logs, "submit");
    this.logLine(logs, "submit", `clicked submit button (beforeDisabled=${beforeDisabled})`);
    await page.waitForFunction(
      (previous) => {
        const textareaNode = document.querySelector("textarea");
        const buttons = Array.from(document.querySelectorAll("button")).filter(
          (node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 0,
        ) as HTMLButtonElement[];
        const button = buttons.find((node) => {
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          const rect = node.getBoundingClientRect();
          return (
            rect.width >= 24 &&
            rect.width <= 80 &&
            rect.height >= 24 &&
            rect.height <= 80 &&
            !/(?:Agent|\u81ea\u52a8|\u7075\u611f\u641c\u7d22|\u521b\u610f\u8bbe\u8ba1|\u53bb\u67e5\u770b|\u9996\u5e27|\u5c3e\u5e27|16:9|9:16|15s|5s)/.test(text)
          );
        });
        const currentValue =
          textareaNode instanceof HTMLTextAreaElement ? textareaNode.value : "";
        return (
          currentValue !== previous ||
          !!button?.disabled ||
          /(?:processing|queued|generating|submit)/i.test(document.body.innerText)
        );
      },
      beforeValue,
      { timeout: 10000 },
    );
    await page.waitForTimeout(UI_TIMINGS.postSubmitMs);
    this.logLine(logs, "submit", "submission accepted");
  }

  private async waitUntilFormReady(
    page: Page,
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    await this.locatePromptContextViaScript(page, logs);
    const preferredSubmitButton = await this.getPreferredSubmitButton(page, logs);
    if (preferredSubmitButton) {
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll("button")).find(
            (node) =>
              /submit-button|send|generate/i.test(
                (node as HTMLElement).className || "",
              ),
          ) as HTMLButtonElement | undefined;
          return !!button && !button.disabled;
        },
        { timeout: 30000 },
      );
    }
    this.logLine(logs, "ready", "form ready for next segment");
    return;
    const textarea = page
      .locator(
        "textarea",
      )
      .first();
    await textarea.waitFor({ state: "visible", timeout: 15000 });
    const submitButton = await this.getPreferredSubmitButton(page, logs);
    if (submitButton) {
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll("button")).find(
            (node) =>
              /submit-button|send|generate/i.test(
                (node as HTMLElement).className || "",
              ),
          ) as HTMLButtonElement | undefined;
          return !!button && !button.disabled;
        },
        { timeout: 30000 },
      );
    }
    this.logLine(logs, "ready", "form ready for next segment");
  }

  private async submitCurrentPromptStrict(
    page: Page,
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    await this.dismissInterferingOverlays(page, logs);
    const beforeState = await this.readPromptScopeState(page, promptContext);
    const beforeValue = normalizePromptValue(beforeState?.promptValue || "");

    const submitButton = await this.getPreferredSubmitButton(page, logs);
    if (!submitButton) throw new Error("submit button not found");

    let beforeDisabled = await submitButton.isDisabled().catch(() => false);
    if (beforeDisabled) {
      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll("button")).find(
            (node) =>
              /submit-button|send|generate/i.test(
                (node as HTMLElement).className || "",
              ),
          ) as HTMLButtonElement | undefined;
          return !!button && !button.disabled;
        },
        { timeout: 10000 },
      ).catch(() => {});
      beforeDisabled = await submitButton.isDisabled().catch(() => false);
    }
    await this.dismissInterferingOverlays(page, logs);
    await this.clickLocator(submitButton, logs, "submit");
    this.logLine(logs, "submit", `clicked submit button (beforeDisabled=${beforeDisabled})`);
    const confirmation = await this.confirmPromptScopeSubmission(
      page,
      promptContext,
      beforeState,
      4500,
    );
    if (!confirmation.ok) {
      throw new Error(
        `submit not confirmed after click: signalTextKey=${confirmation.state?.signalTextKey || ""} taskIndicatorCount=${confirmation.state?.taskIndicatorCount || 0} beforeValueLength=${beforeValue.length}`,
      );
    }
    await page.waitForTimeout(UI_TIMINGS.postSubmitMs);
    this.logLine(logs, "submit", "submission accepted");
  }

  private async waitUntilFormReadyStrict(
    page: Page,
    logs: string[],
    promptContext: ReversePromptContext,
  ) {
    const readyResult = await page.evaluate(
      (source) => eval(source),
      buildWaitForPromptScopeReadyScript(promptContext.textboxIndex, 30000),
    ).catch((error) => ({
      ok: false,
      step: error instanceof Error ? error.message : String(error),
    }));
    if (!readyResult?.ok) {
      throw new Error(`form not ready: ${readyResult?.step || "unknown"}`);
    }
    this.logLine(logs, "ready", "form ready for next segment");
  }

  private async resetPageForNextSegment(
    page: Page,
    url: string,
    logs: string[],
  ) {
    this.logLine(logs, "navigate", `reset ${url}`);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForLoadState("domcontentloaded");
    await this.waitForVideoGeneratorToolbar(page, UI_TIMINGS.modeSwitchMs).catch(() => false);
  }

  private async prepareSingleSegment(
    page: Page,
    model: string,
    duration: string,
    aspectRatio: string,
    segment: ReverseRunnerSegment,
    logs: string[],
    waitForReadyAfterSubmit = true,
  ): Promise<ReverseRunnerSegmentResult> {
    await this.ensureVideoGeneratorMode(page, logs);
    await this.ensureFullReference(page, logs).catch((error) => {
      this.logLine(logs, "reference", `skip full reference: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.chooseModel(page, model, logs);
    await this.chooseDuration(page, duration, logs);
    await this.ensureAspectRatio(page, aspectRatio, logs);
    const promptContext = await this.locatePromptContextViaScript(page, logs);
    const uploadedCount = await this.uploadRefs(page, segment.refs, logs, promptContext);
    const promptLength = await this.fillPrompt(page, segment.prompt, logs, promptContext);
    await this.submitCurrentPromptStrict(page, logs, promptContext);
    if (waitForReadyAfterSubmit) {
      await this.waitUntilFormReadyStrict(page, logs, promptContext);
    }
    return {
      segmentKey: segment.segmentKey,
      ok: true,
      uploadedCount,
      promptLength,
    };
  }

  async prepareSegment(
    params: ReverseRunnerPrepareParams,
  ): Promise<ReverseRunnerResult> {
    const logs: string[] = [];
    try {
      const page = await this.ensureContext(
        params.url,
        params.headless ?? true,
        logs,
      );
      await page.bringToFront().catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await this.ensureVideoGeneratorMode(page, logs);
      await this.ensureFullReference(page, logs).catch((error) => {
        this.logLine(logs, "reference", `skip full reference: ${error instanceof Error ? error.message : String(error)}`);
      });
      await this.chooseModel(page, params.model, logs);
      await this.chooseDuration(page, params.duration, logs);
      await this.ensureAspectRatio(page, params.aspectRatio || "16:9", logs);
      const promptContext = await this.locatePromptContextViaScript(page, logs);
      const uploadedCount = await this.uploadRefs(page, params.refs, logs, promptContext);
      const promptLength = await this.fillPrompt(page, params.prompt, logs, promptContext);
      await this.submitCurrentPromptStrict(page, logs, promptContext);
      const selections = await this.readSelections(page);
      const screenshot = await page.screenshot({ type: "png" });
      return {
        ok: true,
        logs,
        currentModel: selections.currentModel,
        currentDuration: selections.currentDuration,
        uploadedCount,
        promptLength,
        screenshotBase64: screenshot.toString("base64"),
      };
    } catch (error) {
      let screenshotBase64: string | undefined;
      try {
        if (this.page && !this.page.isClosed()) {
          screenshotBase64 = (
            await this.page.screenshot({ type: "png" })
          ).toString("base64");
        }
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        logs,
        screenshotBase64,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runSegments(params: ReverseRunnerRunParams): Promise<ReverseRunnerResult> {
    const logs: string[] = [];
    const segmentResults: ReverseRunnerSegmentResult[] = [];
    try {
      const page = await this.ensureContext(
        params.url,
        params.headless ?? true,
        logs,
      );
      await page.bringToFront().catch(() => {});
      await page.waitForLoadState("domcontentloaded");

      for (const segment of params.segments) {
        this.logLine(logs, "segment", `start ${segment.segmentKey}`);
        try {
          const result = await this.prepareSingleSegment(
            page,
            params.model,
            params.duration,
            params.aspectRatio || "16:9",
            segment,
            logs,
            false,
          );
          segmentResults.push(result);
          this.logLine(logs, "segment", `done ${segment.segmentKey}`);
          if (segment !== params.segments[params.segments.length - 1]) {
            await this.resetPageForNextSegment(page, params.url, logs);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          segmentResults.push({
            segmentKey: segment.segmentKey,
            ok: false,
            error: message,
          });
          throw new Error(`segment ${segment.segmentKey}: ${message}`);
        }
      }

      const selections = await this.readSelections(page);
      const screenshot = await page.screenshot({ type: "png" });
      return {
        ok: true,
        logs,
        currentModel: selections.currentModel,
        currentDuration: selections.currentDuration,
        screenshotBase64: screenshot.toString("base64"),
        segments: segmentResults,
      };
    } catch (error) {
      let screenshotBase64: string | undefined;
      try {
        if (this.page && !this.page.isClosed()) {
          screenshotBase64 = (
            await this.page.screenshot({ type: "png" })
          ).toString("base64");
        }
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        logs,
        screenshotBase64,
        error: error instanceof Error ? error.message : String(error),
        segments: segmentResults,
      };
    }
  }

  async capture(): Promise<{ ok: boolean; base64?: string; error?: string }> {
    try {
      if (!this.page || this.page.isClosed()) {
        return { ok: false, error: "runner page unavailable" };
      }
      const screenshot = await this.page.screenshot({ type: "png" });
      return { ok: true, base64: screenshot.toString("base64") };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    this.context = null;
    this.page = null;
  }
}

export const reversePlaywrightRunner = new ReversePlaywrightRunner();
