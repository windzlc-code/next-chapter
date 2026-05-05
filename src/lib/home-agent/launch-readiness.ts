import {
  getApiConfig,
  isArkJimengEndpoint,
  resolveJimengExecutionMode,
  resolveJimengApiKey,
  type JimengExecutionMode,
} from "@/lib/api-config";
import { dreaminaCliGetStatus } from "@/lib/dreamina-cli";
import { hasUsableApiCredential, isServerProxyEndpoint } from "@/lib/server-proxy";

export type HomeAgentLaunchActionId =
  | "open_settings"
  | "switch_to_api"
  | "switch_to_cli"
  | "continue_script_only";

export type HomeAgentLaunchNotice = {
  level: "warning" | "critical";
  title: string;
  description: string;
  actions: Array<{
    id: HomeAgentLaunchActionId;
    label: string;
  }>;
};

export type HomeAgentLaunchReadiness = {
  checkedAt: string;
  textReady: boolean;
  textMessage: string;
  image: {
    ready: boolean;
    label: string;
    detail: string;
    tone: "neutral" | "ready" | "warning";
  };
  video: {
    mode: JimengExecutionMode;
    ready: boolean;
    label: string;
    detail: string;
    tone: "neutral" | "ready" | "warning";
  };
  notice: HomeAgentLaunchNotice | null;
};

const READINESS_CACHE_TTL_MS = 15_000;
let readinessCache:
  | {
      key: string;
      expiresAt: number;
      value: HomeAgentLaunchReadiness;
    }
  | null = null;
let readinessInflightPromise: Promise<HomeAgentLaunchReadiness> | null = null;

function hasUsableTextModelKey(): boolean {
  const config = getApiConfig();
  return (
    hasUsableApiCredential(config.claudeEndpoint, config.claudeKey) ||
    hasUsableApiCredential(config.geminiEndpoint, config.geminiKey) ||
    hasUsableApiCredential(config.gptEndpoint, config.gptKey)
  );
}

function hasUsableSeedanceApiKey(): boolean {
  const config = getApiConfig();
  return isServerProxyEndpoint(config.jimengEndpoint) || Boolean(resolveJimengApiKey(config));
}

function hasUsableImageModelKey(): boolean {
  const config = getApiConfig();
  return (
    hasUsableApiCredential(config.geminiEndpoint, config.geminiKey) ||
    hasUsableApiCredential(config.tuziEndpoint, config.tuziKey)
  );
}

function buildImageState(): HomeAgentLaunchReadiness["image"] {
  if (hasUsableImageModelKey()) {
    return {
      ready: true,
      label: "图像生成已就绪",
      detail: "Tuzi / Gemini 图像链路",
      tone: "ready",
    };
  }

  return {
    ready: false,
    label: "图像生成待配置",
    detail: "缺少 Gemini 或 Tuzi Key，参考图与分镜图会卡住",
    tone: "warning",
  };
}

async function buildVideoState(mode: JimengExecutionMode): Promise<HomeAgentLaunchReadiness["video"]> {
  const config = getApiConfig();
  const usesArkSeedanceApi = isArkJimengEndpoint(config.jimengEndpoint);

  if (mode === "api") {
    if (hasUsableSeedanceApiKey()) {
      return {
        mode,
        ready: true,
        label: "当前实际走 API",
        detail: usesArkSeedanceApi ? "Ark / Seedance API" : "Seedance API",
        tone: "neutral",
      };
    }

    return {
      mode,
      ready: false,
      label: "当前默认走 API",
      detail: usesArkSeedanceApi ? "缺少 Seedance / Ark 专用 Key" : "缺少 Seedance / Gemini 可用 Key",
      tone: "warning",
    };
  }

  if (!window.electronAPI?.dreaminaCli?.exec) {
    return {
      mode,
      ready: false,
      label: "当前选择 CLI",
      detail: "当前环境不支持 Dreamina CLI",
      tone: "warning",
    };
  }

  try {
    const status = await dreaminaCliGetStatus();
    if (status.loggedIn) {
      return {
        mode,
        ready: true,
        label: "当前实际走 CLI",
        detail: "Dreamina CLI / Seedance 2.0",
        tone: "ready",
      };
    }

    return {
      mode,
      ready: false,
      label: "当前选择 CLI",
      detail: status.installed ? "Dreamina CLI 尚未登录" : "Dreamina CLI 未安装",
      tone: "warning",
    };
  } catch (error) {
    return {
      mode,
      ready: false,
      label: "当前选择 CLI",
      detail: error instanceof Error ? error.message : "Dreamina CLI 状态检查失败",
      tone: "warning",
    };
  }
}

function buildNotice(params: {
  textReady: boolean;
  image: HomeAgentLaunchReadiness["image"];
  video: HomeAgentLaunchReadiness["video"];
}): HomeAgentLaunchNotice | null {
  const { textReady, image, video } = params;

  if (!textReady) {
    return {
      level: "critical",
      title: "主对话模型尚未就绪",
      description: "当前首页还没有可用的文本模型 Key，先去设置补齐内置 API 配置，再开始真实会话最稳妥。",
      actions: [{ id: "open_settings", label: "去设置补齐" }],
    };
  }

  if (!image.ready && !video.ready) {
    return {
      level: "warning",
      title: "图像与视频链路都还没完全就绪",
      description:
        video.mode === "cli"
          ? "文本对话还能继续，但当前缺少 Gemini 图像配置，角色参考图、场景图、分镜图会卡住；Dreamina CLI 也还不能直接出片。现在最多只适合继续推进到拆镜和实体阶段。"
          : "文本对话还能继续，但当前既缺少 Gemini 图像配置，也没有可直接出片的视频通道。现在最多只适合继续推进到拆镜和实体阶段；参考图、分镜图和视频生成都会被卡住。",
      actions: [
        { id: "open_settings", label: "去设置补齐" },
        ...(video.mode === "cli"
          ? [{ id: "switch_to_api" as const, label: "切到 API" }]
          : [{ id: "switch_to_cli" as const, label: "尝试切到 CLI" }]),
        { id: "continue_script_only", label: "先做拆镜/实体" },
      ],
    };
  }

  if (!image.ready) {
    return {
      level: "warning",
      title: "图像生成尚未就绪",
      description:
        "文本对话可以继续，剧本拆解和角色/场景实体提取也能继续；但角色参考图、场景参考图、分镜图生成会卡住，后续视频生成链路也会因此受阻。当前最多适合推进到拆镜/实体阶段。",
      actions: [
        { id: "open_settings", label: "去设置补齐" },
        { id: "continue_script_only", label: "先做拆镜/实体" },
      ],
    };
  }

  if (video.ready) {
    return null;
  }

  if (video.mode === "cli") {
    return {
      level: "warning",
      title: "视频默认走 CLI，但当前还不能直接出片",
      description: "你可以先去设置完成 Dreamina 登录，也可以切回 API 继续视频工作流；如果暂时只做剧本和改编，也可以直接继续。",
      actions: [
        { id: "open_settings", label: "去设置检查" },
        { id: "switch_to_api", label: "切到 API" },
        { id: "continue_script_only", label: "先做剧本/改编" },
      ],
    };
  }

  return {
    level: "warning",
    title: "视频默认走 API，但当前还不能直接出片",
    description: video.detail.includes("Ark")
      ? "当前 Ark 直连缺少 Seedance / Ark 专用 Key。你可以去设置里补齐专用 Key，或切到已登录的 CLI；如果只是先做剧本和改编，也可以直接继续。"
      : "当前缺少 Seedance / Gemini 可用 Key。你可以去设置补齐，或切到已登录的 CLI；如果只是先做剧本和改编，也可以直接继续。",
    actions: [
      { id: "open_settings", label: "去设置补齐" },
      { id: "switch_to_cli", label: "尝试切到 CLI" },
      { id: "continue_script_only", label: "先做剧本/改编" },
    ],
  };
}

export async function readHomeAgentLaunchReadiness(): Promise<HomeAgentLaunchReadiness> {
  const config = getApiConfig();
  const mode = resolveJimengExecutionMode(config, {
    dreaminaCliAccessible: Boolean(window.electronAPI?.dreaminaCli?.exec),
  });
  const cacheKey = JSON.stringify({
    mode,
    claude: hasUsableApiCredential(config.claudeEndpoint, config.claudeKey),
    gemini: hasUsableApiCredential(config.geminiEndpoint, config.geminiKey),
    gpt: hasUsableApiCredential(config.gptEndpoint, config.gptKey),
    tuzi: hasUsableApiCredential(config.tuziEndpoint, config.tuziKey),
    jimeng: isServerProxyEndpoint(config.jimengEndpoint) || Boolean(resolveJimengApiKey(config)),
    endpoint: config.jimengEndpoint || "",
    cliAccessible: Boolean(window.electronAPI?.dreaminaCli?.exec),
  });
  const now = Date.now();

  if (readinessCache && readinessCache.key === cacheKey && readinessCache.expiresAt > now) {
    return readinessCache.value;
  }

  if (readinessInflightPromise) {
    return readinessInflightPromise;
  }

  readinessInflightPromise = (async () => {
  const textReady = hasUsableTextModelKey();
  const textMessage = textReady
    ? "主对话模型已就绪"
    : "当前没有可用的文本模型 Key，请先在设置中补齐内置 API 配置。";
  const image = buildImageState();
  const video = await buildVideoState(mode);

    const result = {
      checkedAt: new Date().toISOString(),
      textReady,
      textMessage,
      image,
      video,
      notice: buildNotice({ textReady, image, video }),
    };

    readinessCache = {
      key: cacheKey,
      expiresAt: Date.now() + READINESS_CACHE_TTL_MS,
      value: result,
    };
    return result;
  })();

  try {
    return await readinessInflightPromise;
  } finally {
    readinessInflightPromise = null;
  }
}
