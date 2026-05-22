import {
  getApiConfig,
  hydrateStoredApiConfigFromBuiltinBundle,
  isArkJimengEndpoint,
  resolveJimengApiKey,
  type JimengExecutionMode,
} from "@/lib/api-config";
import { hasUsableApiCredential, isServerProxyEndpoint } from "@/lib/server-proxy";

export type HomeAgentLaunchActionId =
  | "open_settings"
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

function hasUsableAliyunVideoKey(): boolean {
  const config = getApiConfig();
  return hasUsableApiCredential(config.aliyunEndpoint, config.aliyunKey);
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
    detail: "缺少 Gemini 或 Tuzi Key，角色参考图、场景图和分镜图会卡住。",
    tone: "warning",
  };
}

function buildVideoState(mode: JimengExecutionMode): HomeAgentLaunchReadiness["video"] {
  const config = getApiConfig();
  const usesArkSeedanceApi = isArkJimengEndpoint(config.jimengEndpoint);
  const hasSeedance = hasUsableSeedanceApiKey();
  const hasAliyun = hasUsableAliyunVideoKey();

  if (hasSeedance || hasAliyun) {
    const providers = [
      ...(hasSeedance ? [usesArkSeedanceApi ? "Ark / Seedance API" : "Seedance API"] : []),
      ...(hasAliyun ? ["Aliyun HappyHorse API"] : []),
    ];
    return {
      mode,
      ready: true,
      label: "当前默认走 API",
      detail: providers.join(" / "),
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
      description: "当前首页还没有可用的文本模型 Key，先去设置补齐内置 API 配置会更稳。",
      actions: [{ id: "open_settings", label: "去设置补齐" }],
    };
  }

  if (!image.ready && !video.ready) {
    return {
      level: "warning",
      title: "图像与视频链路都还没有完全就绪",
      description:
        "文本对话还能继续，但当前既缺少图像生成配置，也没有可直接出片的视频通道。现在更适合先推进到拆镜和实体阶段。",
      actions: [
        { id: "open_settings", label: "去设置补齐" },
        { id: "continue_script_only", label: "先做拆镜/实体" },
      ],
    };
  }

  if (!image.ready) {
    return {
      level: "warning",
      title: "图像生成尚未就绪",
      description:
        "文本对话、剧本拆解和角色/场景实体提取可以继续，但参考图与分镜图生成会卡住，后续视频流程也会受影响。",
      actions: [
        { id: "open_settings", label: "去设置补齐" },
        { id: "continue_script_only", label: "先做拆镜/实体" },
      ],
    };
  }

  if (video.ready) {
    return null;
  }

  return {
    level: "warning",
    title: "视频通道尚未就绪",
    description: video.detail.includes("Ark")
      ? "当前 Ark 直连缺少 Seedance / Ark 专用 Key。补齐后即可继续视频工作流。"
      : "当前缺少 Seedance / Gemini 可用 Key。补齐后即可继续视频工作流。",
    actions: [
      { id: "open_settings", label: "去设置补齐" },
      { id: "continue_script_only", label: "先做剧本/改编" },
    ],
  };
}

export async function readHomeAgentLaunchReadiness(): Promise<HomeAgentLaunchReadiness> {
  hydrateStoredApiConfigFromBuiltinBundle();
  const config = getApiConfig();
  const mode: JimengExecutionMode = "api";
  const cacheKey = JSON.stringify({
    mode,
    claude: hasUsableApiCredential(config.claudeEndpoint, config.claudeKey),
    gemini: hasUsableApiCredential(config.geminiEndpoint, config.geminiKey),
    gpt: hasUsableApiCredential(config.gptEndpoint, config.gptKey),
    tuzi: hasUsableApiCredential(config.tuziEndpoint, config.tuziKey),
    aliyun: hasUsableApiCredential(config.aliyunEndpoint, config.aliyunKey),
    jimeng: isServerProxyEndpoint(config.jimengEndpoint) || Boolean(resolveJimengApiKey(config)),
    aliyunEndpoint: config.aliyunEndpoint || "",
    endpoint: config.jimengEndpoint || "",
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
    const video = buildVideoState(mode);

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
