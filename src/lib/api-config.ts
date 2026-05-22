import {
  getServerProxyEndpoint,
  shouldPreferServerProxyDefaults,
  shouldUseServerProxyRouting,
  isServerProxyEndpoint,
} from "@/lib/server-proxy";

export type ApiMode = "builtin";
export type JimengExecutionMode = "api" | "cli";
const DEFAULT_NETWORK_RETRY_COUNT = 1;
const DEFAULT_NETWORK_RETRY_DELAY_MS = 800;

export interface BuiltinApiBundle {
  geminiEndpoint?: string;
  geminiKey?: string;
  aliyunEndpoint?: string;
  aliyunKey?: string;
  runninghubEndpoint?: string;
  runninghubKey?: string;
  gptEndpoint?: string;
  gptKey?: string;
  claudeEndpoint?: string;
  claudeKey?: string;
  grokEndpoint?: string;
  grokKey?: string;
  seedreamEndpoint?: string;
  seedreamKey?: string;
  jimengEndpoint?: string;
  jimengKey?: string;
  tuziEndpoint?: string;
  tuziKey?: string;
  modelMappings?: Record<string, string>;
}

export interface SupportedModelMapping {
  key: string;
  label: string;
  provider: "gemini" | "gpt" | "claude" | "grok" | "seedream" | "jimeng" | "aliyun" | "tuzi";
  category: "text" | "image" | "video";
  defaultModelName: string;
}

export interface ApiConfig {
  apiMode: ApiMode;
  geminiEndpoint: string;
  geminiKey: string;
  aliyunEndpoint: string;
  aliyunKey: string;
  runninghubEndpoint: string;
  runninghubKey: string;
  gptEndpoint: string;
  gptKey: string;
  claudeEndpoint: string;
  claudeKey: string;
  grokEndpoint: string;
  grokKey: string;
  seedreamEndpoint: string;
  seedreamKey: string;
  jimengEndpoint: string;
  jimengKey: string;
  jimengExecutionMode: JimengExecutionMode;
  tuziEndpoint: string;
  tuziKey: string;
  modelMappings: Record<string, string>;
  firstFrameMaxDim: number;
  firstFrameMaxKB: number;
  retryCount: number;
  retryDelayMs: number;
  storagePath?: string;
}

export const API_CONFIG_UPDATED_EVENT = "storyforge:api-config-updated";

export const SUPPORTED_MODEL_MAPPINGS: SupportedModelMapping[] = [
  {
    key: "gemini-3-pro",
    label: "Gemini 3 Pro",
    provider: "gemini",
    category: "text",
    defaultModelName: "gemini-3-pro",
  },
  {
    key: "gemini-3-pro-preview",
    label: "Gemini 3 Pro Preview",
    provider: "gemini",
    category: "text",
    defaultModelName: "gemini-3-pro-preview",
  },
  {
    key: "gemini-3-pro-thinking",
    label: "Gemini 3 Pro Thinking",
    provider: "gemini",
    category: "text",
    defaultModelName: "gemini-3-pro-thinking",
  },
  {
    key: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    provider: "gemini",
    category: "text",
    defaultModelName: "gemini-3-flash-preview",
  },
  {
    key: "gpt-5.4",
    label: "GPT-5.4",
    provider: "gpt",
    category: "text",
    defaultModelName: "gpt-5.4",
  },
  {
    key: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    provider: "gpt",
    category: "text",
    defaultModelName: "gpt-5.4-mini",
  },
  {
    key: "gpt-image-2",
    label: "GPT Image 2",
    provider: "gpt",
    category: "image",
    defaultModelName: "gpt-image-2",
  },
  {
    key: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "claude",
    category: "text",
    defaultModelName: "claude-sonnet-4-6",
  },
  {
    key: "claude-sonnet-4-6-thinking",
    label: "Claude Sonnet 4.6 Thinking",
    provider: "claude",
    category: "text",
    defaultModelName: "claude-sonnet-4-6-thinking",
  },
  {
    key: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    provider: "claude",
    category: "text",
    defaultModelName: "claude-opus-4-6",
  },
  {
    key: "grok-4.1",
    label: "Grok 4.1",
    provider: "grok",
    category: "text",
    defaultModelName: "grok-4.1",
  },
  {
    key: "nano-banana-pro",
    label: "nano-banana-pro",
    provider: "gemini",
    category: "image",
    defaultModelName: "nano-banana-pro",
  },
  {
    key: "nano-banana-pro-2k",
    label: "nano-banana-pro 2K",
    provider: "gemini",
    category: "image",
    defaultModelName: "nano-banana-pro-2k",
  },
  {
    key: "nano-banana-pro-4k",
    label: "nano-banana-pro 4K",
    provider: "gemini",
    category: "image",
    defaultModelName: "nano-banana-pro-4k",
  },
  {
    key: "gemini-3-pro-image-preview",
    label: "nano-banana 2",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview",
  },
  {
    key: "gemini-3-pro-image-preview-2k",
    label: "nano-banana 2 2K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-2k",
  },
  {
    key: "gemini-3-pro-image-preview-4k",
    label: "nano-banana 2 4K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-4k",
  },
  {
    key: "nano-banana-2",
    label: "nano-banana 2",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview",
  },
  {
    key: "nano-banana-2-2k",
    label: "nano-banana 2 2K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-2k",
  },
  {
    key: "nano-banana-2-4k",
    label: "nano-banana 2 4K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-4k",
  },
  {
    key: "gemini-3-pro-image-preview-async",
    label: "nano-banana 2-async",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-async",
  },
  {
    key: "gemini-3-pro-image-preview-2k-async",
    label: "nano-banana 2-async 2K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-2k-async",
  },
  {
    key: "gemini-3-pro-image-preview-4k-async",
    label: "nano-banana 2-async 4K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-4k-async",
  },
  {
    key: "nano-banana-2-async",
    label: "nano-banana 2-async",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-async",
  },
  {
    key: "nano-banana-2-2k-async",
    label: "nano-banana 2-async 2K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-2k-async",
  },
  {
    key: "nano-banana-2-4k-async",
    label: "nano-banana 2-async 4K",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3-pro-image-preview-4k-async",
  },
  {
    key: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image Preview",
    provider: "gemini",
    category: "image",
    defaultModelName: "gemini-3.1-flash-image-preview",
  },
  {
    key: "doubao-seedream-5-0-260128",
    label: "Seedream 5.0",
    provider: "seedream",
    category: "image",
    defaultModelName: "doubao-seedream-5-0-260128",
  },
  {
    key: "doubao-seedance-1-5-pro_480p",
    label: "Seedance 1.5 Pro 480P",
    provider: "jimeng",
    category: "video",
    defaultModelName: "doubao-seedance-1-5-pro_480p",
  },
  {
    key: "doubao-seedance-1-5-pro_720p",
    label: "Seedance 1.5 Pro 720P",
    provider: "jimeng",
    category: "video",
    defaultModelName: "doubao-seedance-1-5-pro_720p",
  },
  {
    key: "doubao-seedance-1-5-pro_1080p",
    label: "Seedance 1.5 Pro 1080P",
    provider: "jimeng",
    category: "video",
    defaultModelName: "doubao-seedance-1-5-pro_1080p",
  },
  {
    key: "doubao-seedance-2-0-260128",
    label: "Seedance 2.0",
    provider: "jimeng",
    category: "video",
    defaultModelName: "doubao-seedance-2-0-260128",
  },
  {
    key: "doubao-seedance-2-0-fast-260128",
    label: "Seedance 2.0 Fast",
    provider: "jimeng",
    category: "video",
    defaultModelName: "doubao-seedance-2-0-fast-260128",
  },
  {
    key: "happyhorse-1.0",
    label: "HappyHorse 1.0",
    provider: "aliyun",
    category: "video",
    defaultModelName: "happyhorse-1.0",
  },
  {
    key: "sora-2",
    label: "Sora 2 (720p)",
    provider: "tuzi",
    category: "video",
    defaultModelName: "sora-2",
  },
  {
    key: "sora-2-pro",
    label: "Sora 2 Pro (1080p)",
    provider: "tuzi",
    category: "video",
    defaultModelName: "sora-2-pro",
  },
];

const STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS: Record<string, string> = {
  "doubao-seedance-1-5-pro_480p": "ep-m-20260414192742-59w88",
  "doubao-seedance-1-5-pro_720p": "ep-m-20260414192742-59w88",
  "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88",
};

export function isArkJimengEndpoint(value: string | undefined): boolean {
  const trimmed = String(value || "").trim().replace(/\/$/, "");
  if (!trimmed) return false;
  return (
    /\/contents\/generations\/tasks$/i.test(trimmed) ||
    /\/api\/v3$/i.test(trimmed) ||
    /ark\.cn-beijing\.volces\.com/i.test(trimmed)
  );
}

export function resolveJimengApiKey(config: Pick<ApiConfig, "jimengEndpoint" | "jimengKey" | "geminiKey">): string {
  const jimengKey = String(config.jimengKey || "").trim();
  if (jimengKey) return jimengKey;

  if (isArkJimengEndpoint(config.jimengEndpoint)) {
    return "";
  }

  return String(config.geminiKey || "").trim();
}

function resolveModelMappingWithConfig(config: Pick<ApiConfig, "jimengEndpoint" | "modelMappings">, model: string): string {
  const trimmed = String(model || "").trim();
  if (!trimmed) return trimmed;

  const mapped = config.modelMappings[trimmed]?.trim();
  const isArkVideoAlias = Object.prototype.hasOwnProperty.call(
    STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS,
    trimmed,
  );
  if (mapped) {
    if (isArkVideoAlias && !isArkJimengEndpoint(config.jimengEndpoint)) {
      return trimmed;
    }
    return mapped;
  }

  if (isArkVideoAlias && isArkJimengEndpoint(config.jimengEndpoint)) {
    return STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS[trimmed] || trimmed;
  }

  return trimmed;
}

const STORAGE_KEY = "storyforge_api_config";
const OBF_PREFIX = "obf:";
const WORKFLOW_SESSION_ENDPOINT = "/api/workflow/session";
const WORKFLOW_CONFIG_ENDPOINT = "/api/workflow/config";
let builtinApiBundleCache: BuiltinApiBundle | null | undefined;
let localProxySessionPromise: Promise<void> | null = null;
let localProxySyncChain: Promise<void> = Promise.resolve();
let lastLocalProxyConfigSnapshot = "";

function emitApiConfigUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(API_CONFIG_UPDATED_EVENT));
}

function obfuscate(value: string): string {
  if (!value) return "";
  if (value.startsWith(OBF_PREFIX)) return value;
  try {
    return OBF_PREFIX + btoa(unescape(encodeURIComponent(value)));
  } catch {
    return value;
  }
}

function deobfuscate(value: string): string {
  if (!value) return "";
  if (!value.startsWith(OBF_PREFIX)) return value;
  try {
    return decodeURIComponent(escape(atob(value.slice(OBF_PREFIX.length))));
  } catch {
    return value;
  }
}

const SENSITIVE_KEYS: (keyof ApiConfig)[] = [
  "geminiKey",
  "aliyunKey",
  "runninghubKey",
  "gptKey",
  "claudeKey",
  "grokKey",
  "seedreamKey",
  "jimengKey",
  "tuziKey",
];

export const DEFAULT_API_CONFIG: ApiConfig = {
  apiMode: "builtin",
  geminiEndpoint: "",
  geminiKey: "",
  aliyunEndpoint: "",
  aliyunKey: "",
  runninghubEndpoint: "",
  runninghubKey: "",
  gptEndpoint: "",
  gptKey: "",
  claudeEndpoint: "",
  claudeKey: "",
  grokEndpoint: "",
  grokKey: "",
  seedreamEndpoint: "",
  seedreamKey: "",
  jimengEndpoint: "",
  jimengKey: "",
  jimengExecutionMode: "api",
  tuziEndpoint: "",
  tuziKey: "",
  modelMappings: {},
  firstFrameMaxDim: 2048,
  firstFrameMaxKB: 1024,
  retryCount: DEFAULT_NETWORK_RETRY_COUNT,
  retryDelayMs: DEFAULT_NETWORK_RETRY_DELAY_MS,
  storagePath: "",
};

const SERVER_PROXY_ROUTE_ENDPOINTS: Record<
  | "geminiEndpoint"
  | "gptEndpoint"
  | "claudeEndpoint"
  | "grokEndpoint"
  | "aliyunEndpoint"
  | "runninghubEndpoint"
  | "seedreamEndpoint"
  | "jimengEndpoint"
  | "tuziEndpoint",
  string
> = {
  geminiEndpoint: getServerProxyEndpoint("gemini"),
  gptEndpoint: getServerProxyEndpoint("gpt"),
  claudeEndpoint: getServerProxyEndpoint("claude"),
  grokEndpoint: getServerProxyEndpoint("grok"),
  aliyunEndpoint: getServerProxyEndpoint("aliyun"),
  runninghubEndpoint: getServerProxyEndpoint("runninghub"),
  seedreamEndpoint: getServerProxyEndpoint("seedream"),
  jimengEndpoint: getServerProxyEndpoint("jimeng"),
  tuziEndpoint: getServerProxyEndpoint("tuzi"),
};

const SERVER_PROXY_SYNC_FIELDS: (keyof ApiConfig)[] = [
  "geminiEndpoint",
  "geminiKey",
  "gptEndpoint",
  "gptKey",
  "claudeEndpoint",
  "claudeKey",
  "grokEndpoint",
  "grokKey",
  "aliyunEndpoint",
  "aliyunKey",
  "runninghubEndpoint",
  "runninghubKey",
  "seedreamEndpoint",
  "seedreamKey",
  "jimengEndpoint",
  "jimengKey",
  "tuziEndpoint",
  "tuziKey",
  "jimengExecutionMode",
];

function readEnvString(name: string): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function getPreferredProxyDefaults(): Partial<ApiConfig> {
  if (!shouldPreferServerProxyDefaults()) return {};
  return {
    geminiEndpoint: getServerProxyEndpoint("gemini"),
    gptEndpoint: getServerProxyEndpoint("gpt"),
    claudeEndpoint: getServerProxyEndpoint("claude"),
    grokEndpoint: getServerProxyEndpoint("grok"),
    aliyunEndpoint: getServerProxyEndpoint("aliyun"),
    runninghubEndpoint: getServerProxyEndpoint("runninghub"),
    seedreamEndpoint: getServerProxyEndpoint("seedream"),
    jimengEndpoint: getServerProxyEndpoint("jimeng"),
    tuziEndpoint: getServerProxyEndpoint("tuzi"),
  };
}

function getEnvDefaultApiConfig(): Partial<ApiConfig> {
  const proxyDefaults = getPreferredProxyDefaults();
  const unifiedKey = readEnvString("VITE_DEFAULT_UNIFIED_API_KEY");
  const textEndpoint = readEnvString("VITE_DEFAULT_TEXT_ENDPOINT");
  const imageEndpoint = readEnvString("VITE_DEFAULT_IMAGE_ENDPOINT") || textEndpoint;
  const videoEndpoint = readEnvString("VITE_DEFAULT_VIDEO_ENDPOINT") || imageEndpoint || textEndpoint;

  return {
    geminiEndpoint:
      readEnvString("VITE_DEFAULT_GEMINI_ENDPOINT") ||
      proxyDefaults.geminiEndpoint ||
      imageEndpoint,
    geminiKey: readEnvString("VITE_DEFAULT_GEMINI_KEY") || unifiedKey,
    aliyunEndpoint: readEnvString("VITE_DEFAULT_ALIYUN_ENDPOINT"),
    aliyunKey: readEnvString("VITE_DEFAULT_ALIYUN_KEY"),
    runninghubEndpoint: readEnvString("VITE_DEFAULT_RUNNINGHUB_ENDPOINT"),
    runninghubKey: readEnvString("VITE_DEFAULT_RUNNINGHUB_KEY"),
    gptEndpoint:
      readEnvString("VITE_DEFAULT_GPT_ENDPOINT") ||
      proxyDefaults.gptEndpoint ||
      textEndpoint,
    gptKey: readEnvString("VITE_DEFAULT_GPT_KEY") || unifiedKey,
    claudeEndpoint:
      readEnvString("VITE_DEFAULT_CLAUDE_ENDPOINT") ||
      proxyDefaults.claudeEndpoint ||
      textEndpoint,
    claudeKey: readEnvString("VITE_DEFAULT_CLAUDE_KEY") || unifiedKey,
    grokEndpoint:
      readEnvString("VITE_DEFAULT_GROK_ENDPOINT") ||
      proxyDefaults.grokEndpoint ||
      textEndpoint,
    grokKey: readEnvString("VITE_DEFAULT_GROK_KEY") || unifiedKey,
    seedreamEndpoint:
      readEnvString("VITE_DEFAULT_SEEDREAM_ENDPOINT") ||
      proxyDefaults.seedreamEndpoint ||
      imageEndpoint,
    seedreamKey: readEnvString("VITE_DEFAULT_SEEDREAM_KEY") || unifiedKey,
    jimengEndpoint:
      readEnvString("VITE_DEFAULT_JIMENG_ENDPOINT") ||
      proxyDefaults.jimengEndpoint ||
      videoEndpoint,
    jimengKey: readEnvString("VITE_DEFAULT_JIMENG_KEY") || unifiedKey,
    tuziEndpoint:
      readEnvString("VITE_DEFAULT_TUZI_ENDPOINT") ||
      proxyDefaults.tuziEndpoint ||
      textEndpoint,
    tuziKey: readEnvString("VITE_DEFAULT_TUZI_KEY") || unifiedKey,
  };
}

function applyProxyEndpointFallbacks(config: ApiConfig): ApiConfig {
  const proxyDefaults = getPreferredProxyDefaults();
  if (!Object.keys(proxyDefaults).length) return config;

  return {
    ...config,
    geminiEndpoint: config.geminiEndpoint || proxyDefaults.geminiEndpoint || "",
    aliyunEndpoint: config.aliyunEndpoint || proxyDefaults.aliyunEndpoint || "",
    gptEndpoint: config.gptEndpoint || proxyDefaults.gptEndpoint || "",
    claudeEndpoint: config.claudeEndpoint || proxyDefaults.claudeEndpoint || "",
    grokEndpoint: config.grokEndpoint || proxyDefaults.grokEndpoint || "",
    seedreamEndpoint: config.seedreamEndpoint || proxyDefaults.seedreamEndpoint || "",
    jimengEndpoint: config.jimengEndpoint || proxyDefaults.jimengEndpoint || "",
    tuziEndpoint: config.tuziEndpoint || proxyDefaults.tuziEndpoint || "",
  };
}

function applyServerProxyEndpointRouting(config: ApiConfig): ApiConfig {
  if (!shouldUseServerProxyRouting()) return config;
  return {
    ...config,
    ...SERVER_PROXY_ROUTE_ENDPOINTS,
  };
}

function normalizeStoredConfig(config: Partial<ApiConfig>): ApiConfig {
  return {
    ...DEFAULT_API_CONFIG,
    ...config,
    apiMode: "builtin",
    geminiEndpoint:
      typeof config.geminiEndpoint === "string" ? config.geminiEndpoint.trim() : "",
    geminiKey: typeof config.geminiKey === "string" ? config.geminiKey.trim() : "",
    aliyunEndpoint:
      typeof config.aliyunEndpoint === "string" ? config.aliyunEndpoint.trim() : "",
    aliyunKey: typeof config.aliyunKey === "string" ? config.aliyunKey.trim() : "",
    runninghubEndpoint:
      typeof config.runninghubEndpoint === "string" ? config.runninghubEndpoint.trim() : "",
    runninghubKey:
      typeof config.runninghubKey === "string" ? config.runninghubKey.trim() : "",
    gptEndpoint: typeof config.gptEndpoint === "string" ? config.gptEndpoint.trim() : "",
    gptKey: typeof config.gptKey === "string" ? config.gptKey.trim() : "",
    claudeEndpoint:
      typeof config.claudeEndpoint === "string" ? config.claudeEndpoint.trim() : "",
    claudeKey: typeof config.claudeKey === "string" ? config.claudeKey.trim() : "",
    grokEndpoint: typeof config.grokEndpoint === "string" ? config.grokEndpoint.trim() : "",
    grokKey: typeof config.grokKey === "string" ? config.grokKey.trim() : "",
    seedreamEndpoint:
      typeof config.seedreamEndpoint === "string" ? config.seedreamEndpoint.trim() : "",
    seedreamKey:
      typeof config.seedreamKey === "string" ? config.seedreamKey.trim() : "",
    jimengEndpoint:
      typeof config.jimengEndpoint === "string" ? config.jimengEndpoint.trim() : "",
    jimengKey: typeof config.jimengKey === "string" ? config.jimengKey.trim() : "",
    jimengExecutionMode: config.jimengExecutionMode === "cli" ? "cli" : "api",
    tuziEndpoint: typeof config.tuziEndpoint === "string" ? config.tuziEndpoint.trim() : "",
    tuziKey: typeof config.tuziKey === "string" ? config.tuziKey.trim() : "",
    storagePath: "",
    modelMappings: normalizeModelMappings(config.modelMappings),
  };
}

function getBuiltinApiBundle(): BuiltinApiBundle | null {
  if (builtinApiBundleCache !== undefined) {
    return builtinApiBundleCache;
  }
  try {
    builtinApiBundleCache = window.electronAPI?.runtime?.builtinApiBundle || null;
  } catch {
    builtinApiBundleCache = null;
  }
  return builtinApiBundleCache;
}

function getLatestBuiltinApiBundleForHydration(): BuiltinApiBundle | null {
  try {
    const runtimeBundle = window.electronAPI?.runtime?.builtinApiBundle;
    if (runtimeBundle && typeof runtimeBundle === "object") {
      const sanitized = sanitizeBuiltinApiBundle(runtimeBundle);
      builtinApiBundleCache = sanitized;
      return sanitized;
    }
  } catch {
    // Fall through to the cached bundle below.
  }
  return getBuiltinApiBundle();
}

function sanitizeBuiltinApiBundle(input: Partial<BuiltinApiBundle>): BuiltinApiBundle {
  return {
    geminiEndpoint: typeof input.geminiEndpoint === "string" ? input.geminiEndpoint.trim() : "",
    geminiKey: typeof input.geminiKey === "string" ? input.geminiKey.trim() : "",
    aliyunEndpoint: typeof input.aliyunEndpoint === "string" ? input.aliyunEndpoint.trim() : "",
    aliyunKey: typeof input.aliyunKey === "string" ? input.aliyunKey.trim() : "",
    runninghubEndpoint:
      typeof input.runninghubEndpoint === "string" ? input.runninghubEndpoint.trim() : "",
    runninghubKey: typeof input.runninghubKey === "string" ? input.runninghubKey.trim() : "",
    gptEndpoint: typeof input.gptEndpoint === "string" ? input.gptEndpoint.trim() : "",
    gptKey: typeof input.gptKey === "string" ? input.gptKey.trim() : "",
    claudeEndpoint: typeof input.claudeEndpoint === "string" ? input.claudeEndpoint.trim() : "",
    claudeKey: typeof input.claudeKey === "string" ? input.claudeKey.trim() : "",
    grokEndpoint: typeof input.grokEndpoint === "string" ? input.grokEndpoint.trim() : "",
    grokKey: typeof input.grokKey === "string" ? input.grokKey.trim() : "",
    seedreamEndpoint: typeof input.seedreamEndpoint === "string" ? input.seedreamEndpoint.trim() : "",
    seedreamKey: typeof input.seedreamKey === "string" ? input.seedreamKey.trim() : "",
    jimengEndpoint: typeof input.jimengEndpoint === "string" ? input.jimengEndpoint.trim() : "",
    jimengKey: typeof input.jimengKey === "string" ? input.jimengKey.trim() : "",
    tuziEndpoint: typeof input.tuziEndpoint === "string" ? input.tuziEndpoint.trim() : "",
    tuziKey: typeof input.tuziKey === "string" ? input.tuziKey.trim() : "",
    modelMappings: normalizeModelMappings(input.modelMappings),
  };
}

export function getBuiltinApiBundleMeta() {
  return {
    path: window.electronAPI?.runtime?.builtinApiBundlePath || "",
    loaded: !!getBuiltinApiBundle(),
  };
}

export async function loadBuiltinApiBundleFromDisk(): Promise<BuiltinApiBundle | null> {
  const filePath = getBuiltinApiBundleMeta().path;
  if (!filePath || !window.electronAPI?.storage?.readText) {
    builtinApiBundleCache = getBuiltinApiBundle();
    return builtinApiBundleCache;
  }
  const result = await window.electronAPI.storage.readText(filePath);
  if (!result.ok) {
    throw new Error(result.error || "读取内置 API 配置失败");
  }
  if (!result.exists || !result.content?.trim()) {
    builtinApiBundleCache = null;
    return builtinApiBundleCache;
  }
  const parsed = JSON.parse(result.content) as Partial<BuiltinApiBundle>;
  builtinApiBundleCache = sanitizeBuiltinApiBundle(parsed);
  return builtinApiBundleCache;
}

export async function saveBuiltinApiBundle(
  bundle: Partial<BuiltinApiBundle>,
): Promise<BuiltinApiBundle> {
  const filePath = getBuiltinApiBundleMeta().path;
  if (!filePath || !window.electronAPI?.storage?.writeText) {
    throw new Error("当前环境不支持写入内置 API 配置");
  }
  const nextBundle = sanitizeBuiltinApiBundle(bundle);
  const result = await window.electronAPI.storage.writeText(
    filePath,
    JSON.stringify(nextBundle, null, 2),
  );
  if (!result.ok) {
    throw new Error(result.error || "写入内置 API 配置失败");
  }
  builtinApiBundleCache = nextBundle;
  emitApiConfigUpdated();
  return nextBundle;
}

export function getStoredApiConfig(): ApiConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? (JSON.parse(saved) as Record<string, unknown>) : {};
    const envDefaults = getEnvDefaultApiConfig();
    let merged = {
      ...DEFAULT_API_CONFIG,
      ...envDefaults,
      ...parsed,
      modelMappings: normalizeModelMappings(parsed.modelMappings),
    } as ApiConfig;
    merged = applyLegacyCompatibility(parsed, merged);
    merged = decodeSensitiveFields(merged);
    merged = applyEmptyFieldFallbacks(merged, envDefaults);
    return applyProxyEndpointFallbacks(normalizeStoredConfig(merged));
  } catch {
    return applyProxyEndpointFallbacks(normalizeStoredConfig({
      ...DEFAULT_API_CONFIG,
      ...getEnvDefaultApiConfig(),
    }));
  }
}

function normalizeModelMappings(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, mapped]) => [key, typeof mapped === "string" ? mapped.trim() : ""] as const)
    .filter(([, mapped]) => !!mapped);
  return Object.fromEntries(entries);
}

function applyLegacyCompatibility(
  parsed: Record<string, unknown>,
  merged: ApiConfig,
): ApiConfig {
  if (
    typeof parsed.apiEndpoint === "string" &&
    parsed.apiEndpoint &&
    !merged.geminiEndpoint
  ) {
    merged.geminiEndpoint = parsed.apiEndpoint;
  }
  if (
    typeof parsed.apiKey === "string" &&
    parsed.apiKey &&
    !merged.geminiKey
  ) {
    merged.geminiKey = parsed.apiKey;
  }
  return merged;
}

function decodeSensitiveFields(config: ApiConfig): ApiConfig {
  const next = { ...config };
  for (const key of SENSITIVE_KEYS) {
    const value = next[key];
    if (typeof value === "string" && value) {
      (next as Record<string, unknown>)[key] = deobfuscate(value);
    }
  }
  return next;
}

function applyEmptyFieldFallbacks(
  config: ApiConfig,
  defaults: Partial<ApiConfig>,
): ApiConfig {
  const next = { ...config };
  for (const field of [
    "geminiEndpoint",
    "geminiKey",
    "aliyunEndpoint",
    "aliyunKey",
    "runninghubEndpoint",
    "runninghubKey",
    "gptEndpoint",
    "gptKey",
    "claudeEndpoint",
    "claudeKey",
    "grokEndpoint",
    "grokKey",
    "seedreamEndpoint",
    "seedreamKey",
    "jimengEndpoint",
    "jimengKey",
    "tuziEndpoint",
    "tuziKey",
  ] satisfies Array<keyof ApiConfig>) {
    const currentValue = next[field];
    const fallbackValue = defaults[field];
    if (
      typeof currentValue === "string" &&
      !currentValue.trim() &&
      typeof fallbackValue === "string" &&
      fallbackValue.trim()
    ) {
      next[field] = fallbackValue.trim() as ApiConfig[typeof field];
    }
  }
  return next;
}

function applyBuiltinOverlay(config: ApiConfig): ApiConfig {
  const normalizedConfig = normalizeStoredConfig(config);
  const builtin = getBuiltinApiBundle();
  if (!builtin) {
    return {
      ...normalizedConfig,
      modelMappings: {
        ...STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS,
        ...normalizedConfig.modelMappings,
      },
    };
  }
  const builtinMappings = normalizeModelMappings(builtin.modelMappings);

  const g = (field: keyof BuiltinApiBundle) =>
    typeof builtin[field] === "string" ? (builtin[field] as string).trim() : "";

  const pick = (
    builtinField: keyof BuiltinApiBundle,
    configField: keyof ApiConfig,
  ): string => {
    const builtinValue = g(builtinField);
    if (builtinValue) return builtinValue;
    const configValue = normalizedConfig[configField];
    return typeof configValue === "string" ? configValue.trim() : "";
  };

  const geminiEndpoint = pick("geminiEndpoint", "geminiEndpoint");
  const geminiKey = pick("geminiKey", "geminiKey");

  return {
    ...normalizedConfig,
    geminiEndpoint,
    geminiKey,
    aliyunEndpoint: pick("aliyunEndpoint", "aliyunEndpoint"),
    aliyunKey: pick("aliyunKey", "aliyunKey"),
    runninghubEndpoint: pick("runninghubEndpoint", "runninghubEndpoint"),
    runninghubKey: pick("runninghubKey", "runninghubKey"),
    gptEndpoint: pick("gptEndpoint", "gptEndpoint") || geminiEndpoint,
    gptKey: pick("gptKey", "gptKey") || geminiKey,
    claudeEndpoint: pick("claudeEndpoint", "claudeEndpoint") || geminiEndpoint,
    claudeKey: pick("claudeKey", "claudeKey") || geminiKey,
    grokEndpoint: pick("grokEndpoint", "grokEndpoint") || geminiEndpoint,
    grokKey: pick("grokKey", "grokKey") || geminiKey,
    seedreamEndpoint: pick("seedreamEndpoint", "seedreamEndpoint") || geminiEndpoint,
    seedreamKey: pick("seedreamKey", "seedreamKey") || geminiKey,
    jimengEndpoint: pick("jimengEndpoint", "jimengEndpoint") || geminiEndpoint,
    jimengKey: pick("jimengKey", "jimengKey") || geminiKey,
    jimengExecutionMode: "api",
    tuziEndpoint: pick("tuziEndpoint", "tuziEndpoint"),
    tuziKey: pick("tuziKey", "tuziKey"),
    modelMappings: {
      ...STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS,
      ...normalizedConfig.modelMappings,
      ...builtinMappings,
    },
  };
}

export function resolveApiConfigForRuntime(config: ApiConfig): ApiConfig {
  return applyBuiltinOverlay(config);
}

export function resolveJimengExecutionMode(
  config: Pick<ApiConfig, "jimengExecutionMode">,
  options?: object,
): JimengExecutionMode {
  void config;
  void options;
  return "api";
}

export function getApiConfig(): ApiConfig {
  try {
    return applyServerProxyEndpointRouting(
      applyProxyEndpointFallbacks(resolveApiConfigForRuntime(getStoredApiConfig())),
    );
  } catch {
    return applyServerProxyEndpointRouting(
      applyProxyEndpointFallbacks(applyBuiltinOverlay(DEFAULT_API_CONFIG)),
    );
  }
}

function toComparableApiConfigSnapshot(config: ApiConfig): string {
  const normalized = normalizeStoredConfig(config);
  const sortedModelMappings = Object.fromEntries(
    Object.entries(normalizeModelMappings(normalized.modelMappings)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return JSON.stringify({
    ...normalized,
    modelMappings: sortedModelMappings,
  });
}

export function hydrateStoredApiConfigFromBuiltinBundle(): boolean {
  const builtin = getLatestBuiltinApiBundleForHydration();
  if (!builtin) return false;

  const current = getStoredApiConfig();
  const resolved = resolveApiConfigForRuntime(current);
  const next = normalizeStoredConfig({
    ...current,
    geminiEndpoint: resolved.geminiEndpoint,
    geminiKey: resolved.geminiKey,
    aliyunEndpoint: resolved.aliyunEndpoint,
    aliyunKey: resolved.aliyunKey,
    runninghubEndpoint: resolved.runninghubEndpoint,
    runninghubKey: resolved.runninghubKey,
    gptEndpoint: resolved.gptEndpoint,
    gptKey: resolved.gptKey,
    claudeEndpoint: resolved.claudeEndpoint,
    claudeKey: resolved.claudeKey,
    grokEndpoint: resolved.grokEndpoint,
    grokKey: resolved.grokKey,
    seedreamEndpoint: resolved.seedreamEndpoint,
    seedreamKey: resolved.seedreamKey,
    jimengEndpoint: resolved.jimengEndpoint,
    jimengKey: resolved.jimengKey,
    tuziEndpoint: resolved.tuziEndpoint,
    tuziKey: resolved.tuziKey,
    modelMappings: resolved.modelMappings,
  });

  if (toComparableApiConfigSnapshot(current) === toComparableApiConfigSnapshot(next)) {
    return false;
  }

  saveApiConfig(next);
  return true;
}

export function saveApiConfig(config: Partial<ApiConfig>): void {
  const current = getStoredApiConfig();
  const updated = normalizeStoredConfig({
    ...current,
    ...config,
  });
  const toStore = { ...updated } as Record<string, unknown>;
  for (const key of SENSITIVE_KEYS) {
    const value = toStore[key];
    if (typeof value === "string" && value) {
      toStore[key] = obfuscate(value);
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  emitApiConfigUpdated();
}

function canSyncApiConfigToServerProxy(): boolean {
  return shouldUseServerProxyRouting() && typeof fetch === "function";
}

function sanitizeServerProxySyncEndpoint(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return isServerProxyEndpoint(trimmed) ? "" : trimmed;
}

function buildServerProxySyncPayload(config: ApiConfig): Partial<ApiConfig> {
  return SERVER_PROXY_SYNC_FIELDS.reduce<Partial<ApiConfig>>((acc, field) => {
    const value = config[field];
    if (typeof value === "string") {
      acc[field] = field.endsWith("Endpoint")
        ? sanitizeServerProxySyncEndpoint(value)
        : value.trim();
    }
    return acc;
  }, {});
}

async function ensureServerProxyWorkflowSession(): Promise<void> {
  if (!canSyncApiConfigToServerProxy()) return;
  if (!localProxySessionPromise) {
    localProxySessionPromise = (async () => {
      const response = await fetch(WORKFLOW_SESSION_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`Failed to initialize local proxy session (${response.status})`);
      }
    })().catch((error) => {
      localProxySessionPromise = null;
      throw error;
    });
  }
  await localProxySessionPromise;
}

export async function syncApiConfigToServerProxy(
  config?: Partial<ApiConfig>,
): Promise<boolean> {
  if (!canSyncApiConfigToServerProxy()) return false;

  const merged = normalizeStoredConfig({
    ...getStoredApiConfig(),
    ...(config || {}),
  });
  const runtimeConfig = resolveApiConfigForRuntime(merged);
  const payload = buildServerProxySyncPayload(runtimeConfig);
  const snapshot = JSON.stringify(payload);
  if (snapshot === lastLocalProxyConfigSnapshot) {
    return true;
  }

  await ensureServerProxyWorkflowSession();
  const response = await fetch(WORKFLOW_CONFIG_ENDPOINT, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: snapshot,
  });
  if (!response.ok) {
    throw new Error(`Failed to sync API config to local proxy (${response.status})`);
  }
  lastLocalProxyConfigSnapshot = snapshot;
  return true;
}

export function queueApiConfigSyncToServerProxy(config?: Partial<ApiConfig>): void {
  if (!canSyncApiConfigToServerProxy()) return;
  localProxySyncChain = localProxySyncChain
    .catch(() => undefined)
    .then(() => syncApiConfigToServerProxy(config))
    .catch((error) => {
      console.warn("Failed to sync API config to local proxy:", error);
    });
}

export function clearApiConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
  lastLocalProxyConfigSnapshot = "";
  emitApiConfigUpdated();
}

export function resolveConfiguredModelName(model: string): string {
  const config = getApiConfig();
  return resolveModelMappingWithConfig(config, model);
}

export function resolveConfiguredModelNameFromConfig(
  config: ApiConfig,
  model: string,
): string {
  return resolveModelMappingWithConfig(config, model);
}

export function prefersJimengCli(config: Pick<ApiConfig, "jimengExecutionMode">): boolean {
  void config;
  return false;
}
