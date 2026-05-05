import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import { getInlineData } from "@/lib/gemini-client";

type DreaminaExecResult = {
  ok: boolean;
  installed?: boolean;
  path?: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type DreaminaCliStatus = "processing" | "succeeded" | "failed";
type DreaminaCliActionResult = {
  ok: boolean;
  installed: boolean;
  message: string;
  path?: string;
};

function extractFirstJsonObject(raw: string): string {
  const cleaned = String(raw || "").replace(/^\uFEFF/, "").trim();
  const fenceMatch =
    cleaned.match(/```json\s*([\s\S]*?)```/i) ||
    cleaned.match(/```\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

function parseLooseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(extractFirstJsonObject(raw)) as T;
  } catch {
    return null;
  }
}

function pickDreaminaMessage(result: DreaminaExecResult): string {
  return result.stderr?.trim() || result.stdout?.trim() || result.error?.trim() || "Dreamina CLI 执行失败";
}

function findFirstMediaUrl(payload: unknown): string | undefined {
  if (!payload) return undefined;
  if (typeof payload === "string") {
    return /^https?:\/\//i.test(payload) ? payload : undefined;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstMediaUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof payload === "object") {
    for (const value of Object.values(payload as Record<string, unknown>)) {
      const found = findFirstMediaUrl(value);
      if (found) return found;
    }
  }
  return undefined;
}

function normalizeDreaminaStatus(raw: unknown): DreaminaCliStatus {
  const value = String(raw ?? "").toLowerCase();
  if (/(success|succeeded|completed|done|finish)/.test(value)) return "succeeded";
  if (/(fail|failed|error|cancel)/.test(value)) return "failed";
  return "processing";
}

function resolveDreaminaModelVersion(hasImage: boolean): "seedance2.0" | "seedance2.0fast" {
  return hasImage ? "seedance2.0" : "seedance2.0fast";
}

async function execDreamina(args: string[], stdin?: string): Promise<DreaminaExecResult> {
  const api = window.electronAPI?.dreaminaCli;
  if (!api?.exec) {
    return {
      ok: false,
      installed: false,
      error: "当前环境不支持 Dreamina CLI，本能力仅在 Electron 桌面端可用。",
    };
  }
  return api.exec(args, stdin);
}

async function persistDreaminaInputImage(imageUrl: string): Promise<string | null> {
  const inline = await getInlineData(imageUrl);
  if (!inline?.data) return null;

  const filesRoot = await getResolvedFilesStoragePath();
  const writer = window.electronAPI?.jimeng?.writeFile;
  if (!filesRoot || !writer) return null;

  const extension =
    inline.mimeType === "image/png"
      ? "png"
      : inline.mimeType === "image/webp"
        ? "webp"
        : "jpg";
  const filePath = `${filesRoot.replace(/[\\/]+$/, "")}/dreamina-cli/inputs/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${extension}`;

  const result = await writer(filePath, inline.data);
  if (!result?.ok) {
    throw new Error(result?.error || "写入 Dreamina CLI 首帧图片失败");
  }
  return filePath;
}

export async function isDreaminaCliAvailable(): Promise<boolean> {
  const result = await execDreamina(["version"]);
  return !!result.ok;
}

export async function dreaminaCliGetStatus() {
  const result = await execDreamina(["user_credit"]);
  return {
    ok: result.ok,
    installed: result.installed ?? false,
    loggedIn: result.ok,
    message: result.ok ? (result.stdout?.trim() || "已登录 Dreamina CLI") : pickDreaminaMessage(result),
    path: result.path,
  };
}

async function runDreaminaAction(
  args: string[],
  successMessage: string,
): Promise<DreaminaCliActionResult> {
  const result = await execDreamina(args);
  return {
    ok: result.ok,
    installed: result.installed ?? false,
    message: result.ok ? (result.stdout?.trim() || successMessage) : pickDreaminaMessage(result),
    path: result.path,
  };
}

export async function dreaminaCliLogin(): Promise<DreaminaCliActionResult> {
  return runDreaminaAction(
    ["login"],
    "Dreamina 浏览器登录流程已启动，请按浏览器提示完成授权。",
  );
}

export async function dreaminaCliRelogin(): Promise<DreaminaCliActionResult> {
  return runDreaminaAction(
    ["relogin"],
    "Dreamina 重新登录流程已启动，请按浏览器提示完成授权。",
  );
}

export async function dreaminaCliGenerateVideo(params: {
  prompt: string;
  imageUrl?: string;
  duration?: number;
  aspectRatio?: string;
}): Promise<{ task_id: string; status: string; provider: "dreamina-cli" }> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("缺少视频描述 (prompt)");

  const hasImage = typeof params.imageUrl === "string" && params.imageUrl.trim().length > 0;
  const modelVersion = resolveDreaminaModelVersion(hasImage);
  const duration = Math.max(4, Math.min(15, Number(params.duration) || 5));
  const persistedImagePath = hasImage
    ? await persistDreaminaInputImage(params.imageUrl!)
    : null;
  if (hasImage && !persistedImagePath) {
    throw new Error("Dreamina CLI 首帧图片准备失败");
  }

  const args = hasImage
    ? [
        "image2video",
        `--image=${persistedImagePath}`,
        `--prompt=${prompt}`,
        `--model_version=${modelVersion}`,
        `--duration=${duration}`,
        "--video_resolution=720p",
        "--poll=0",
      ]
    : [
        "text2video",
        `--prompt=${prompt}`,
        `--model_version=${modelVersion}`,
        `--duration=${duration}`,
        "--video_resolution=720p",
        ...(params.aspectRatio ? [`--ratio=${params.aspectRatio}`] : []),
        "--poll=0",
      ];

  const result = await execDreamina(args);
  if (!result.ok) throw new Error(pickDreaminaMessage(result));

  const payload = parseLooseJson<Record<string, unknown>>(result.stdout || "");
  const taskId =
    String(payload?.submit_id ?? payload?.task_id ?? payload?.id ?? "").trim() ||
    result.stdout?.match(/\bsubmit_id\b["':=\s]*([a-zA-Z0-9_-]+)/i)?.[1] ||
    result.stdout?.match(/\b([a-f0-9]{12,})\b/i)?.[1];

  if (!taskId) {
    throw new Error(`Dreamina CLI 返回成功，但未解析到 submit_id：${result.stdout?.trim() || "empty output"}`);
  }

  return {
    task_id: taskId,
    status: String(payload?.gen_status ?? payload?.status ?? "submitted"),
    provider: "dreamina-cli",
  };
}

export async function dreaminaCliQueryResult(taskId: string): Promise<{
  status: DreaminaCliStatus;
  video_url?: string;
  state?: string;
  raw?: unknown;
}> {
  const result = await execDreamina(["query_result", `--submit_id=${taskId}`]);
  if (!result.ok) throw new Error(pickDreaminaMessage(result));

  const payload = parseLooseJson<Record<string, unknown>>(result.stdout || "");
  const state = String(payload?.gen_status ?? payload?.status ?? payload?.state ?? "");

  return {
    status: normalizeDreaminaStatus(state),
    state: state || undefined,
    video_url: findFirstMediaUrl(payload) ?? findFirstMediaUrl(result.stdout || ""),
    raw: payload ?? result.stdout,
  };
}

function isDreaminaUnknownCommandMessage(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("unknown command") ||
    lowered.includes("invalid choice") ||
    lowered.includes("unrecognized arguments") ||
    lowered.includes("no such command") ||
    lowered.includes("not recognized") ||
    lowered.includes("未知命令") ||
    lowered.includes("未找到命令")
  );
}

export async function dreaminaCliCancelVideo(taskId: string): Promise<{
  task_id: string;
  status: "cancelled";
  provider: "dreamina-cli";
}> {
  const trimmedTaskId = taskId.trim();
  if (!trimmedTaskId) throw new Error("缺少 Dreamina submit_id");

  const commandCandidates = [
    ["cancel", `--submit_id=${trimmedTaskId}`],
    ["cancel_task", `--submit_id=${trimmedTaskId}`],
  ];

  let lastResult: DreaminaExecResult | null = null;
  for (const args of commandCandidates) {
    const result = await execDreamina(args);
    lastResult = result;
    if (result.ok) {
      return {
        task_id: trimmedTaskId,
        status: "cancelled",
        provider: "dreamina-cli",
      };
    }

    const message = pickDreaminaMessage(result);
    if (!isDreaminaUnknownCommandMessage(message)) {
      throw new Error(message);
    }
  }

  throw new Error(
    pickDreaminaMessage(lastResult || {
      ok: false,
      installed: true,
      error: "Dreamina CLI 当前不支持取消视频任务",
    }),
  );
}

export function getDreaminaCliModelCatalog() {
  return [
    { id: "seedance2.0", label: "Seedance 2.0", provider: "dreamina-cli" },
    { id: "seedance2.0fast", label: "Seedance 2.0 Fast", provider: "dreamina-cli" },
  ];
}
