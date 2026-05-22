var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/uuid/dist/esm/stringify.js
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
var byteToHex;
var init_stringify = __esm({
  "node_modules/uuid/dist/esm/stringify.js"() {
    byteToHex = [];
    for (let i = 0; i < 256; ++i) {
      byteToHex.push((i + 256).toString(16).slice(1));
    }
  }
});

// node_modules/uuid/dist/esm/rng.js
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    (0, import_crypto.randomFillSync)(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}
var import_crypto, rnds8Pool, poolPtr;
var init_rng = __esm({
  "node_modules/uuid/dist/esm/rng.js"() {
    import_crypto = require("crypto");
    rnds8Pool = new Uint8Array(256);
    poolPtr = rnds8Pool.length;
  }
});

// node_modules/uuid/dist/esm/native.js
var import_crypto2, native_default;
var init_native = __esm({
  "node_modules/uuid/dist/esm/native.js"() {
    import_crypto2 = require("crypto");
    native_default = { randomUUID: import_crypto2.randomUUID };
  }
});

// node_modules/uuid/dist/esm/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random ?? options.rng?.() ?? rng();
  if (rnds.length < 16) {
    throw new Error("Random bytes length must be >= 16");
  }
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
var v4_default;
var init_v4 = __esm({
  "node_modules/uuid/dist/esm/v4.js"() {
    init_native();
    init_rng();
    init_stringify();
    v4_default = v4;
  }
});

// node_modules/uuid/dist/esm/index.js
var init_esm = __esm({
  "node_modules/uuid/dist/esm/index.js"() {
    init_v4();
  }
});

// src/lib/server-proxy.ts
function getServerProxyEndpoint(provider) {
  return SERVER_PROXY_ENDPOINTS[provider];
}
function isServerProxyEndpoint(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(`${SERVER_PROXY_PREFIX}/`)) {
    return true;
  }
  try {
    const parsed = typeof window !== "undefined" ? new URL(trimmed, window.location.href) : new URL(trimmed);
    return parsed.pathname.startsWith(`${SERVER_PROXY_PREFIX}/`);
  } catch {
    return false;
  }
}
function shouldUseServerProxyRouting() {
  if (typeof window === "undefined") return false;
  if (typeof window.electronAPI === "object" && window.electronAPI !== null) return false;
  const { protocol } = window.location;
  return protocol === "http:" || protocol === "https:";
}
function shouldPreferServerProxyDefaults() {
  if (!shouldUseServerProxyRouting()) return false;
  const { hostname } = window.location;
  return !/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(hostname);
}
var SERVER_PROXY_PREFIX, SERVER_PROXY_ENDPOINTS;
var init_server_proxy = __esm({
  "src/lib/server-proxy.ts"() {
    SERVER_PROXY_PREFIX = "/api/proxy";
    SERVER_PROXY_ENDPOINTS = {
      gemini: `${SERVER_PROXY_PREFIX}/gemini`,
      gpt: `${SERVER_PROXY_PREFIX}/gpt`,
      claude: `${SERVER_PROXY_PREFIX}/claude`,
      grok: `${SERVER_PROXY_PREFIX}/grok`,
      aliyun: `${SERVER_PROXY_PREFIX}/aliyun`,
      runninghub: `${SERVER_PROXY_PREFIX}/runninghub`,
      seedream: `${SERVER_PROXY_PREFIX}/seedream`,
      jimeng: `${SERVER_PROXY_PREFIX}/jimeng`,
      tuzi: `${SERVER_PROXY_PREFIX}/tuzi`
    };
  }
});

// src/lib/api-config.ts
function deobfuscate(value) {
  if (!value) return "";
  if (!value.startsWith(OBF_PREFIX)) return value;
  try {
    return decodeURIComponent(escape(atob(value.slice(OBF_PREFIX.length))));
  } catch {
    return value;
  }
}
function readEnvString(name) {
  const env = import_meta.env;
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}
function getPreferredProxyDefaults() {
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
    tuziEndpoint: getServerProxyEndpoint("tuzi")
  };
}
function getEnvDefaultApiConfig() {
  const proxyDefaults = getPreferredProxyDefaults();
  const unifiedKey = readEnvString("VITE_DEFAULT_UNIFIED_API_KEY");
  const textEndpoint = readEnvString("VITE_DEFAULT_TEXT_ENDPOINT");
  const imageEndpoint = readEnvString("VITE_DEFAULT_IMAGE_ENDPOINT") || textEndpoint;
  const videoEndpoint = readEnvString("VITE_DEFAULT_VIDEO_ENDPOINT") || imageEndpoint || textEndpoint;
  return {
    geminiEndpoint: readEnvString("VITE_DEFAULT_GEMINI_ENDPOINT") || proxyDefaults.geminiEndpoint || imageEndpoint,
    geminiKey: readEnvString("VITE_DEFAULT_GEMINI_KEY") || unifiedKey,
    aliyunEndpoint: readEnvString("VITE_DEFAULT_ALIYUN_ENDPOINT"),
    aliyunKey: readEnvString("VITE_DEFAULT_ALIYUN_KEY"),
    runninghubEndpoint: readEnvString("VITE_DEFAULT_RUNNINGHUB_ENDPOINT"),
    runninghubKey: readEnvString("VITE_DEFAULT_RUNNINGHUB_KEY"),
    gptEndpoint: readEnvString("VITE_DEFAULT_GPT_ENDPOINT") || proxyDefaults.gptEndpoint || textEndpoint,
    gptKey: readEnvString("VITE_DEFAULT_GPT_KEY") || unifiedKey,
    claudeEndpoint: readEnvString("VITE_DEFAULT_CLAUDE_ENDPOINT") || proxyDefaults.claudeEndpoint || textEndpoint,
    claudeKey: readEnvString("VITE_DEFAULT_CLAUDE_KEY") || unifiedKey,
    grokEndpoint: readEnvString("VITE_DEFAULT_GROK_ENDPOINT") || proxyDefaults.grokEndpoint || textEndpoint,
    grokKey: readEnvString("VITE_DEFAULT_GROK_KEY") || unifiedKey,
    seedreamEndpoint: readEnvString("VITE_DEFAULT_SEEDREAM_ENDPOINT") || proxyDefaults.seedreamEndpoint || imageEndpoint,
    seedreamKey: readEnvString("VITE_DEFAULT_SEEDREAM_KEY") || unifiedKey,
    jimengEndpoint: readEnvString("VITE_DEFAULT_JIMENG_ENDPOINT") || proxyDefaults.jimengEndpoint || videoEndpoint,
    jimengKey: readEnvString("VITE_DEFAULT_JIMENG_KEY") || unifiedKey,
    tuziEndpoint: readEnvString("VITE_DEFAULT_TUZI_ENDPOINT") || proxyDefaults.tuziEndpoint || textEndpoint,
    tuziKey: readEnvString("VITE_DEFAULT_TUZI_KEY") || unifiedKey
  };
}
function applyProxyEndpointFallbacks(config) {
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
    tuziEndpoint: config.tuziEndpoint || proxyDefaults.tuziEndpoint || ""
  };
}
function applyServerProxyEndpointRouting(config) {
  if (!shouldUseServerProxyRouting()) return config;
  return {
    ...config,
    ...SERVER_PROXY_ROUTE_ENDPOINTS
  };
}
function normalizeStoredConfig(config) {
  return {
    ...DEFAULT_API_CONFIG,
    ...config,
    apiMode: "builtin",
    geminiEndpoint: typeof config.geminiEndpoint === "string" ? config.geminiEndpoint.trim() : "",
    geminiKey: typeof config.geminiKey === "string" ? config.geminiKey.trim() : "",
    aliyunEndpoint: typeof config.aliyunEndpoint === "string" ? config.aliyunEndpoint.trim() : "",
    aliyunKey: typeof config.aliyunKey === "string" ? config.aliyunKey.trim() : "",
    runninghubEndpoint: typeof config.runninghubEndpoint === "string" ? config.runninghubEndpoint.trim() : "",
    runninghubKey: typeof config.runninghubKey === "string" ? config.runninghubKey.trim() : "",
    gptEndpoint: typeof config.gptEndpoint === "string" ? config.gptEndpoint.trim() : "",
    gptKey: typeof config.gptKey === "string" ? config.gptKey.trim() : "",
    claudeEndpoint: typeof config.claudeEndpoint === "string" ? config.claudeEndpoint.trim() : "",
    claudeKey: typeof config.claudeKey === "string" ? config.claudeKey.trim() : "",
    grokEndpoint: typeof config.grokEndpoint === "string" ? config.grokEndpoint.trim() : "",
    grokKey: typeof config.grokKey === "string" ? config.grokKey.trim() : "",
    seedreamEndpoint: typeof config.seedreamEndpoint === "string" ? config.seedreamEndpoint.trim() : "",
    seedreamKey: typeof config.seedreamKey === "string" ? config.seedreamKey.trim() : "",
    jimengEndpoint: typeof config.jimengEndpoint === "string" ? config.jimengEndpoint.trim() : "",
    jimengKey: typeof config.jimengKey === "string" ? config.jimengKey.trim() : "",
    jimengExecutionMode: config.jimengExecutionMode === "cli" ? "cli" : "api",
    tuziEndpoint: typeof config.tuziEndpoint === "string" ? config.tuziEndpoint.trim() : "",
    tuziKey: typeof config.tuziKey === "string" ? config.tuziKey.trim() : "",
    storagePath: "",
    modelMappings: normalizeModelMappings(config.modelMappings)
  };
}
function getBuiltinApiBundle() {
  if (builtinApiBundleCache !== void 0) {
    return builtinApiBundleCache;
  }
  try {
    builtinApiBundleCache = window.electronAPI?.runtime?.builtinApiBundle || null;
  } catch {
    builtinApiBundleCache = null;
  }
  return builtinApiBundleCache;
}
function getStoredApiConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    const envDefaults = getEnvDefaultApiConfig();
    let merged = {
      ...DEFAULT_API_CONFIG,
      ...envDefaults,
      ...parsed,
      modelMappings: normalizeModelMappings(parsed.modelMappings)
    };
    merged = applyLegacyCompatibility(parsed, merged);
    merged = decodeSensitiveFields(merged);
    merged = applyEmptyFieldFallbacks(merged, envDefaults);
    return applyProxyEndpointFallbacks(normalizeStoredConfig(merged));
  } catch {
    return applyProxyEndpointFallbacks(normalizeStoredConfig({
      ...DEFAULT_API_CONFIG,
      ...getEnvDefaultApiConfig()
    }));
  }
}
function normalizeModelMappings(value) {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value).map(([key, mapped]) => [key, typeof mapped === "string" ? mapped.trim() : ""]).filter(([, mapped]) => !!mapped);
  return Object.fromEntries(entries);
}
function applyLegacyCompatibility(parsed, merged) {
  if (typeof parsed.apiEndpoint === "string" && parsed.apiEndpoint && !merged.geminiEndpoint) {
    merged.geminiEndpoint = parsed.apiEndpoint;
  }
  if (typeof parsed.apiKey === "string" && parsed.apiKey && !merged.geminiKey) {
    merged.geminiKey = parsed.apiKey;
  }
  return merged;
}
function decodeSensitiveFields(config) {
  const next = { ...config };
  for (const key of SENSITIVE_KEYS) {
    const value = next[key];
    if (typeof value === "string" && value) {
      next[key] = deobfuscate(value);
    }
  }
  return next;
}
function applyEmptyFieldFallbacks(config, defaults) {
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
    "tuziKey"
  ]) {
    const currentValue = next[field];
    const fallbackValue = defaults[field];
    if (typeof currentValue === "string" && !currentValue.trim() && typeof fallbackValue === "string" && fallbackValue.trim()) {
      next[field] = fallbackValue.trim();
    }
  }
  return next;
}
function applyBuiltinOverlay(config) {
  const normalizedConfig = normalizeStoredConfig(config);
  const builtin = getBuiltinApiBundle();
  if (!builtin) {
    return {
      ...normalizedConfig,
      modelMappings: {
        ...STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS,
        ...normalizedConfig.modelMappings
      }
    };
  }
  const builtinMappings = normalizeModelMappings(builtin.modelMappings);
  const g = (field) => typeof builtin[field] === "string" ? builtin[field].trim() : "";
  const pick = (builtinField, configField) => {
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
      ...builtinMappings
    }
  };
}
function resolveApiConfigForRuntime(config) {
  return applyBuiltinOverlay(config);
}
function getApiConfig() {
  try {
    return applyServerProxyEndpointRouting(
      applyProxyEndpointFallbacks(resolveApiConfigForRuntime(getStoredApiConfig()))
    );
  } catch {
    return applyServerProxyEndpointRouting(
      applyProxyEndpointFallbacks(applyBuiltinOverlay(DEFAULT_API_CONFIG))
    );
  }
}
var import_meta, DEFAULT_NETWORK_RETRY_COUNT, DEFAULT_NETWORK_RETRY_DELAY_MS, STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS, STORAGE_KEY, OBF_PREFIX, builtinApiBundleCache, localProxySyncChain, SENSITIVE_KEYS, DEFAULT_API_CONFIG, SERVER_PROXY_ROUTE_ENDPOINTS;
var init_api_config = __esm({
  "src/lib/api-config.ts"() {
    init_server_proxy();
    import_meta = {};
    DEFAULT_NETWORK_RETRY_COUNT = 1;
    DEFAULT_NETWORK_RETRY_DELAY_MS = 800;
    STATIC_ARK_VIDEO_MODEL_MAPPING_FALLBACKS = {
      "doubao-seedance-1-5-pro_480p": "ep-m-20260414192742-59w88",
      "doubao-seedance-1-5-pro_720p": "ep-m-20260414192742-59w88",
      "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88"
    };
    STORAGE_KEY = "storyforge_api_config";
    OBF_PREFIX = "obf:";
    localProxySyncChain = Promise.resolve();
    SENSITIVE_KEYS = [
      "geminiKey",
      "aliyunKey",
      "runninghubKey",
      "gptKey",
      "claudeKey",
      "grokKey",
      "seedreamKey",
      "jimengKey",
      "tuziKey"
    ];
    DEFAULT_API_CONFIG = {
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
      storagePath: ""
    };
    SERVER_PROXY_ROUTE_ENDPOINTS = {
      geminiEndpoint: getServerProxyEndpoint("gemini"),
      gptEndpoint: getServerProxyEndpoint("gpt"),
      claudeEndpoint: getServerProxyEndpoint("claude"),
      grokEndpoint: getServerProxyEndpoint("grok"),
      aliyunEndpoint: getServerProxyEndpoint("aliyun"),
      runninghubEndpoint: getServerProxyEndpoint("runninghub"),
      seedreamEndpoint: getServerProxyEndpoint("seedream"),
      jimengEndpoint: getServerProxyEndpoint("jimeng"),
      tuziEndpoint: getServerProxyEndpoint("tuzi")
    };
  }
});

// src/lib/network-retry-settings.ts
function getNetworkRetrySettings() {
  const cfg = getApiConfig();
  const rawCount = Number(cfg.retryCount);
  const rawDelay = Number(cfg.retryDelayMs);
  const maxRetries = Number.isFinite(rawCount) ? Math.min(5, Math.max(0, Math.floor(rawCount))) : 1;
  const delayMs = Number.isFinite(rawDelay) ? Math.min(3e4, Math.max(500, Math.floor(rawDelay))) : 800;
  return { maxRetries, delayMs };
}
var init_network_retry_settings = __esm({
  "src/lib/network-retry-settings.ts"() {
    init_api_config();
  }
});

// src/lib/agent/api-client.ts
function getMaxOutputTokens(model) {
  return model.toLowerCase().includes("opus") ? MAX_OUTPUT_TOKENS_THINKING : MAX_OUTPUT_TOKENS_DEFAULT;
}
function buildSystemBlocks(systemPrompt) {
  if (systemPrompt.length === 0) return "";
  if (systemPrompt.length === 1) return systemPrompt[0];
  return systemPrompt.map((s) => ({ type: "text", text: s }));
}
function buildToolsParam(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.searchHint || t.name,
    input_schema: t.inputSchema()
  }));
}
function canUseElectronModelBridge() {
  return typeof window !== "undefined" && typeof window.electronAPI?.invoke === "function";
}
async function invokeElectronModelBridge(payload) {
  const response = await window.electronAPI.invoke("agent:callModelApi", payload);
  if (!response?.ok) {
    throw new Error(response?.error || "Electron model bridge failed");
  }
  return response.data;
}
function buildMessagesApiUrl(baseUrl) {
  const root = String(baseUrl || "https://api.anthropic.com").replace(/\/v1beta(\/.*)?$/i, "").replace(/\/v1(\/.*)?$/i, "").replace(/\/+$/i, "");
  return `${root}/v1/messages`;
}
function buildGeminiApiUrl(baseUrl, model, stream) {
  const root = String(baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/v1beta(\/.*)?$/i, "").replace(/\/v1(\/.*)?$/i, "").replace(/\/+$/i, "");
  return `${root}/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}
function isGeminiTransport(provider, model) {
  if (provider?.toLowerCase() === "gemini") return true;
  return /^gemini-/i.test(String(model || "").trim());
}
function isChatCompletionsTransport(provider, model) {
  const normalizedProvider = provider?.toLowerCase();
  if (normalizedProvider === "gpt" || normalizedProvider === "grok") return true;
  return /^(gpt-|grok-)/i.test(String(model || "").trim());
}
function buildChatCompletionsApiUrl(baseUrl) {
  const root = String(baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/v1beta(\/.*)?$/i, "").replace(/\/v1(\/.*)?$/i, "").replace(/\/+$/i, "");
  return `${root}/v1/chat/completions`;
}
function withOptionalAuthorization(headers, apiKey, url) {
  if (!apiKey || isServerProxyEndpoint(url)) {
    return headers;
  }
  return {
    ...headers,
    Authorization: `Bearer ${apiKey}`
  };
}
async function fetchWithRetry(opts) {
  const { maxRetries, delayMs } = getNetworkRetrySettings();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(opts.url, {
      method: "POST",
      headers: withOptionalAuthorization({
        "content-type": "application/json",
        ...opts.headers ?? {}
      }, opts.apiKey, opts.url),
      body: JSON.stringify(opts.body),
      signal: opts.signal
    });
    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs * 2 ** attempt, 6e4)));
  }
  throw new Error("Unreachable retry state");
}
async function fetchJsonWithRetry(opts) {
  return fetchWithRetry(opts);
}
function buildGeminiToolsParam(tools) {
  if (!tools.length) return void 0;
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.searchHint || tool.name,
      parameters: tool.inputSchema()
    }))
  }];
}
function buildChatCompletionsToolsParam(tools) {
  if (!tools.length) return void 0;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.searchHint || tool.name,
      parameters: tool.inputSchema()
    }
  }));
}
function normalizeGeminiFunctionArgs(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return {};
}
function buildFileFallbackText(block) {
  const summaryParts = [
    `\u6587\u4EF6: ${block.fileName}`,
    `MIME: ${block.mimeType}`,
    ...typeof block.size === "number" ? [`\u5927\u5C0F: ${block.size} bytes`] : [],
    ...block.extension ? [`\u6269\u5C55\u540D: ${block.extension}`] : []
  ];
  if (typeof block.extractedText === "string" && block.extractedText.trim()) {
    summaryParts.push(`\u63D0\u53D6\u6587\u672C:
${block.extractedText}`);
  } else if (typeof block.fallbackDigest === "string" && block.fallbackDigest.trim()) {
    summaryParts.push(`\u5143\u4FE1\u606F\u6458\u8981:
${block.fallbackDigest}`);
  }
  return summaryParts.join("\n");
}
function buildMediaFallbackText(block) {
  const label = block.type === "input_video" ? "\u89C6\u9891" : "\u56FE\u7247";
  return [
    `${label}: ${block.fileName || "\u672A\u547D\u540D\u9644\u4EF6"}`,
    `MIME: ${block.mimeType}`,
    ...block.type === "input_video" && block.fallbackText ? [block.fallbackText] : []
  ].join("\n");
}
function mapAnthropicContentBlock(block) {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input
    };
  }
  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error
    };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking
    };
  }
  if (block.type === "input_image" && block.base64) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.base64
      }
    };
  }
  if (block.type === "input_file" && block.base64) {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.base64
      },
      title: block.fileName,
      context: block.extractedText || block.fallbackDigest || ""
    };
  }
  if (block.type === "input_video") {
    return {
      type: "text",
      text: buildMediaFallbackText(block)
    };
  }
  if (block.type === "input_file") {
    return {
      type: "text",
      text: buildFileFallbackText(block)
    };
  }
  if (block.type === "input_image") {
    return {
      type: "text",
      text: buildMediaFallbackText(block)
    };
  }
  return null;
}
function buildAnthropicMessages(messages) {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const mappedBlocks = message.content.map((block) => mapAnthropicContentBlock(block)).filter((block) => Boolean(block));
    return {
      ...message,
      content: mappedBlocks
    };
  });
}
function buildGeminiContents(messages) {
  const contents = [];
  const toolNamesById = /* @__PURE__ */ new Map();
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof message.content === "string") {
      if (message.content.trim()) parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const normalizedBlock = block;
        if (normalizedBlock.type === "text" && typeof normalizedBlock.text === "string" && normalizedBlock.text.trim()) {
          parts.push({ text: normalizedBlock.text });
          continue;
        }
        if (normalizedBlock.type === "input_image") {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64
              }
            });
          } else {
            parts.push({ text: buildMediaFallbackText(normalizedBlock) });
          }
          continue;
        }
        if (normalizedBlock.type === "input_video") {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64
              }
            });
          }
          if (!normalizedBlock.base64 || normalizedBlock.fallbackText) {
            parts.push({ text: buildMediaFallbackText(normalizedBlock) });
          }
          continue;
        }
        if (normalizedBlock.type === "input_file") {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64
              }
            });
          }
          parts.push({ text: buildFileFallbackText(normalizedBlock) });
          continue;
        }
        if (normalizedBlock.type === "tool_use" && message.role === "assistant") {
          toolNamesById.set(normalizedBlock.id, normalizedBlock.name);
          parts.push({
            functionCall: {
              name: normalizedBlock.name,
              args: normalizeGeminiFunctionArgs(normalizedBlock.input)
            }
          });
          continue;
        }
        if (normalizedBlock.type === "tool_result" && message.role === "user") {
          const name = toolNamesById.get(normalizedBlock.tool_use_id) || "ToolResult";
          parts.push({
            functionResponse: {
              name,
              response: {
                result: typeof normalizedBlock.content === "string" ? normalizedBlock.content : JSON.stringify(normalizedBlock.content ?? ""),
                is_error: Boolean(normalizedBlock.is_error)
              }
            }
          });
        }
      }
    }
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }
  return contents;
}
function buildChatCompletionsMessages(messages, systemPrompt) {
  const result = [];
  if (systemPrompt.length > 0) {
    result.push({ role: "system", content: systemPrompt.join("\n\n") });
  }
  for (const message of messages) {
    if (typeof message.content === "string") {
      const content = message.content.trim();
      if (content) {
        result.push({
          role: message.role === "assistant" ? "assistant" : "user",
          content
        });
      }
      continue;
    }
    const textParts = [];
    const toolCalls = [];
    for (const block of message.content) {
      const normalizedBlock = block;
      if (normalizedBlock.type === "text" && typeof normalizedBlock.text === "string" && normalizedBlock.text.trim()) {
        textParts.push(normalizedBlock.text);
        continue;
      }
      if (normalizedBlock.type === "input_image" || normalizedBlock.type === "input_video") {
        textParts.push(buildMediaFallbackText(normalizedBlock));
        continue;
      }
      if (normalizedBlock.type === "input_file") {
        textParts.push(buildFileFallbackText(normalizedBlock));
        continue;
      }
      if (normalizedBlock.type === "tool_use" && message.role === "assistant") {
        toolCalls.push({
          id: normalizedBlock.id,
          type: "function",
          function: {
            name: normalizedBlock.name,
            arguments: JSON.stringify(normalizeGeminiFunctionArgs(normalizedBlock.input))
          }
        });
        continue;
      }
      if (normalizedBlock.type === "tool_result" && message.role === "user") {
        result.push({
          role: "tool",
          tool_call_id: normalizedBlock.tool_use_id,
          content: typeof normalizedBlock.content === "string" ? normalizedBlock.content : JSON.stringify(normalizedBlock.content ?? "")
        });
      }
    }
    if (textParts.length > 0 || toolCalls.length > 0) {
      result.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: textParts.join("\n\n"),
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
    }
  }
  return result;
}
function buildGeminiAssistantMessage(params) {
  const { model, parts, inputTokens = 0, outputTokens = 0 } = params;
  const contentBlocks = [];
  let aggregatedText = "";
  for (const part of parts) {
    if (typeof part.text === "string" && part.text) {
      aggregatedText += part.text;
      continue;
    }
    const functionCall = part.functionCall;
    if (functionCall?.name) {
      contentBlocks.push({
        type: "tool_use",
        id: v4_default(),
        name: functionCall.name,
        input: normalizeGeminiFunctionArgs(functionCall.args)
      });
    }
  }
  if (aggregatedText) {
    contentBlocks.unshift({ type: "text", text: aggregatedText });
  }
  return {
    type: "assistant",
    uuid: v4_default(),
    message: {
      role: "assistant",
      content: contentBlocks,
      model,
      stop_reason: contentBlocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    }
  };
}
async function callGeminiNative(opts) {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts;
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const response = await fetchJsonWithRetry({
    url: buildGeminiApiUrl(baseUrl, model, false),
    apiKey,
    body: {
      contents: buildGeminiContents(messages),
      ...systemPrompt.length > 0 ? {
        systemInstruction: {
          role: "system",
          parts: [{ text: systemPrompt.join("\n\n") }]
        }
      } : {},
      ...tools.length > 0 ? {
        tools: buildGeminiToolsParam(tools),
        toolConfig: {
          functionCallingConfig: { mode: "AUTO" }
        }
      } : {},
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens
      }
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`);
  }
  const parsed = await response.json();
  return buildGeminiAssistantMessage({
    model,
    parts: parsed.candidates?.[0]?.content?.parts ?? [],
    inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0
  });
}
async function* callGeminiNativeStream(opts) {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts;
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const response = await fetchWithRetry({
    url: buildGeminiApiUrl(baseUrl, model, true),
    apiKey,
    body: {
      contents: buildGeminiContents(messages),
      ...systemPrompt.length > 0 ? {
        systemInstruction: {
          role: "system",
          parts: [{ text: systemPrompt.join("\n\n") }]
        }
      } : {},
      ...tools.length > 0 ? {
        tools: buildGeminiToolsParam(tools),
        toolConfig: {
          functionCallingConfig: { mode: "AUTO" }
        }
      } : {},
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens
      }
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let emittedText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const seenToolCalls = /* @__PURE__ */ new Set();
  const toolUseBlocks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        inputTokens = parsed.usageMetadata?.promptTokenCount ?? inputTokens;
        outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? outputTokens;
        const parts = parsed.candidates?.[0]?.content?.parts ?? [];
        const chunkText = parts.filter((part) => typeof part.text === "string" && !part.thought).map((part) => String(part.text)).join("");
        if (chunkText) {
          const delta = chunkText.startsWith(accumulatedText) ? chunkText.slice(accumulatedText.length) : chunkText;
          if (delta) {
            accumulatedText += delta;
            emittedText += delta;
            yield { type: "delta", text: delta };
          }
        }
        for (const part of parts) {
          const functionCall = part.functionCall;
          if (!functionCall?.name) continue;
          const fingerprint = JSON.stringify({
            name: functionCall.name,
            args: normalizeGeminiFunctionArgs(functionCall.args)
          });
          if (seenToolCalls.has(fingerprint)) continue;
          seenToolCalls.add(fingerprint);
          toolUseBlocks.push({
            type: "tool_use",
            id: v4_default(),
            name: functionCall.name,
            input: normalizeGeminiFunctionArgs(functionCall.args)
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield {
    type: "message",
    message: {
      type: "assistant",
      uuid: v4_default(),
      message: {
        role: "assistant",
        content: [
          ...emittedText ? [{ type: "text", text: emittedText }] : [],
          ...toolUseBlocks
        ],
        model,
        stop_reason: toolUseBlocks.length > 0 ? "tool_use" : "end_turn",
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      }
    }
  };
}
async function callChatCompletionsNative(opts) {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl, provider } = opts;
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const response = await fetchJsonWithRetry({
    url: buildChatCompletionsApiUrl(baseUrl),
    apiKey,
    body: {
      model,
      messages: buildChatCompletionsMessages(messages, systemPrompt),
      ...tools.length > 0 ? { tools: buildChatCompletionsToolsParam(tools), tool_choice: "auto" } : {},
      max_tokens: effectiveMaxTokens,
      stream: false
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`);
  }
  const parsed = await response.json();
  const choice = parsed.choices?.[0]?.message;
  const contentBlocks = [];
  if (choice?.content) {
    contentBlocks.push({ type: "text", text: choice.content });
  }
  for (const toolCall of choice?.tool_calls ?? []) {
    const rawArgs = toolCall.function?.arguments ?? "{}";
    let input = {};
    try {
      input = JSON.parse(rawArgs);
    } catch {
      input = {};
    }
    if (toolCall.function?.name) {
      contentBlocks.push({
        type: "tool_use",
        id: toolCall.id || v4_default(),
        name: toolCall.function.name,
        input
      });
    }
  }
  return {
    type: "assistant",
    uuid: v4_default(),
    message: {
      role: "assistant",
      content: contentBlocks,
      model,
      stop_reason: contentBlocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      usage: {
        input_tokens: parsed.usage?.prompt_tokens ?? 0,
        output_tokens: parsed.usage?.completion_tokens ?? 0
      }
    }
  };
}
async function* callChatCompletionsNativeStream(opts) {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts;
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const response = await fetchWithRetry({
    url: buildChatCompletionsApiUrl(baseUrl),
    apiKey,
    body: {
      model,
      messages: buildChatCompletionsMessages(messages, systemPrompt),
      ...tools.length > 0 ? { tools: buildChatCompletionsToolsParam(tools), tool_choice: "auto" } : {},
      max_tokens: effectiveMaxTokens,
      stream: true
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  const toolCallMap = /* @__PURE__ */ new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        inputTokens = parsed.usage?.prompt_tokens ?? inputTokens;
        outputTokens = parsed.usage?.completion_tokens ?? outputTokens;
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          accumulatedText += delta.content;
          yield { type: "delta", text: delta.content };
        }
        for (const toolCall of delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const current = toolCallMap.get(index) ?? {
            id: toolCall.id || v4_default(),
            name: "",
            args: ""
          };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name = toolCall.function.name;
          if (typeof toolCall.function?.arguments === "string") {
            current.args += toolCall.function.arguments;
          }
          toolCallMap.set(index, current);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const contentBlocks = [];
  if (accumulatedText) {
    contentBlocks.push({ type: "text", text: accumulatedText });
  }
  for (const toolCall of toolCallMap.values()) {
    let input = {};
    try {
      input = JSON.parse(toolCall.args || "{}");
    } catch {
      input = {};
    }
    if (toolCall.name) {
      contentBlocks.push({
        type: "tool_use",
        id: toolCall.id || v4_default(),
        name: toolCall.name,
        input
      });
    }
  }
  yield {
    type: "message",
    message: {
      type: "assistant",
      uuid: v4_default(),
      message: {
        role: "assistant",
        content: contentBlocks,
        model,
        stop_reason: contentBlocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        }
      }
    }
  };
}
async function callModelAPI(opts) {
  const {
    messages,
    systemPrompt,
    model,
    provider,
    tools,
    thinkingConfig,
    maxTokens,
    apiKey,
    baseUrl
  } = opts;
  if (isGeminiTransport(provider, model)) {
    return callGeminiNative(opts);
  }
  if (isChatCompletionsTransport(provider, model)) {
    return callChatCompletionsNative(opts);
  }
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const systemBlock = buildSystemBlocks(systemPrompt);
  const toolsParam = tools.length > 0 ? buildToolsParam(tools) : void 0;
  const requestParams = {
    model,
    max_tokens: effectiveMaxTokens,
    messages: buildAnthropicMessages(messages),
    ...systemBlock ? { system: systemBlock } : {},
    ...toolsParam ? { tools: toolsParam } : {},
    ...thinkingConfig ? { thinking: thinkingConfig } : {}
  };
  const requestUrl = buildMessagesApiUrl(baseUrl);
  const parsed = canUseElectronModelBridge() ? await invokeElectronModelBridge({
    url: requestUrl,
    apiKey,
    requestParams
  }) : await (async () => {
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: withOptionalAuthorization({
        "content-type": "application/json"
      }, apiKey, requestUrl),
      body: JSON.stringify(requestParams)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`
      );
    }
    return await response.json();
  })();
  const contentBlocks = parsed.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input
      };
    }
    if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking };
    }
    return { type: "text", text: "" };
  });
  const usage = {
    inputTokens: parsed.usage.input_tokens,
    outputTokens: parsed.usage.output_tokens,
    cacheCreationInputTokens: parsed.usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: parsed.usage.cache_read_input_tokens ?? 0
  };
  return {
    type: "assistant",
    uuid: v4_default(),
    message: {
      role: "assistant",
      content: contentBlocks,
      model: parsed.model,
      stop_reason: parsed.stop_reason ?? "end_turn",
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens
      }
    }
  };
}
async function* callModelAPIStream(opts) {
  const { messages, systemPrompt, model, provider, tools, thinkingConfig, maxTokens, apiKey, baseUrl } = opts;
  if (isGeminiTransport(provider, model)) {
    yield* callGeminiNativeStream(opts);
    return;
  }
  if (isChatCompletionsTransport(provider, model)) {
    yield* callChatCompletionsNativeStream(opts);
    return;
  }
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model);
  const systemBlock = buildSystemBlocks(systemPrompt);
  const toolsParam = tools.length > 0 ? buildToolsParam(tools) : void 0;
  const requestParams = {
    model,
    max_tokens: effectiveMaxTokens,
    stream: true,
    messages: buildAnthropicMessages(messages),
    ...systemBlock ? { system: systemBlock } : {},
    ...toolsParam ? { tools: toolsParam } : {},
    ...thinkingConfig ? { thinking: thinkingConfig } : {}
  };
  const requestUrl = buildMessagesApiUrl(baseUrl);
  if (canUseElectronModelBridge()) {
    const streamId = Math.random().toString(36).slice(2);
    const electronAPI = window.electronAPI;
    const onFn = electronAPI.on;
    const offFn = electronAPI.off;
    if (onFn && offFn) {
      const deltaQueue = [];
      let resolveNext = null;
      let done = false;
      const listener = (...args) => {
        const payload = args[0];
        if (payload.streamId !== streamId) return;
        deltaQueue.push(payload.delta);
        resolveNext?.();
        resolveNext = null;
      };
      onFn("agent:stream-delta", listener);
      const invokePromise = window.electronAPI.invoke("agent:callModelApiStream", {
        url: requestUrl,
        apiKey,
        requestParams: { ...requestParams, stream: false },
        // main process adds stream:true
        streamId
      });
      invokePromise.then(() => {
        done = true;
        resolveNext?.();
        resolveNext = null;
      }).catch(() => {
        done = true;
        resolveNext?.();
        resolveNext = null;
      });
      while (true) {
        if (deltaQueue.length > 0) {
          yield { type: "delta", text: deltaQueue.shift() };
        } else if (done) {
          break;
        } else {
          await new Promise((resolve) => {
            resolveNext = resolve;
          });
        }
      }
      offFn("agent:stream-delta", listener);
      const result = await invokePromise;
      if (!result.ok || !result.data) {
        throw new Error(result.error || "Electron streaming bridge failed");
      }
      const parsed = result.data;
      const contentBlocks2 = parsed.content.map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
        return { type: "text", text: "" };
      });
      yield {
        type: "message",
        message: {
          type: "assistant",
          uuid: v4_default(),
          message: {
            role: "assistant",
            content: contentBlocks2,
            model: parsed.model,
            stop_reason: parsed.stop_reason ?? "end_turn",
            usage: { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens }
          }
        }
      };
      return;
    }
    const msg = await callModelAPI(opts);
    const text = (Array.isArray(msg.message.content) ? msg.message.content : []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (text) yield { type: "delta", text };
    yield { type: "message", message: msg };
    return;
  }
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: withOptionalAuthorization({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    }, apiKey, requestUrl),
    body: JSON.stringify(requestParams)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let accText = "";
  const contentBlocks = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  let currentToolUse = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        const type = event.type;
        if (type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use") {
            currentToolUse = { id: block.id, name: block.name, inputJson: "" };
          }
        } else if (type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta") {
            const chunk = delta.text;
            accText += chunk;
            yield { type: "delta", text: chunk };
          } else if (delta?.type === "input_json_delta" && currentToolUse) {
            currentToolUse.inputJson += delta.partial_json;
          }
        } else if (type === "content_block_stop") {
          if (currentToolUse) {
            let input = {};
            try {
              input = JSON.parse(currentToolUse.inputJson);
            } catch {
            }
            contentBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input });
            currentToolUse = null;
          }
        } else if (type === "message_delta") {
          const delta = event.delta;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          const usage = event.usage;
          if (usage?.output_tokens) outputTokens = usage.output_tokens;
        } else if (type === "message_start") {
          const msg = event.message;
          const usage = msg?.usage;
          if (usage?.input_tokens) inputTokens = usage.input_tokens;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (accText) contentBlocks.unshift({ type: "text", text: accText });
  yield {
    type: "message",
    message: {
      type: "assistant",
      uuid: v4_default(),
      message: {
        role: "assistant",
        content: contentBlocks,
        model,
        stop_reason: stopReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
      }
    }
  };
}
function toAPIMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.type === "user" || msg.type === "assistant") {
      const content = msg.message.content;
      if (typeof content === "string") {
        result.push({ role: msg.message.role, content });
      } else {
        const blocks = content.filter((b) => b.type !== "thinking");
        if (blocks.length > 0) {
          result.push({
            role: msg.message.role,
            content: blocks
          });
        }
      }
    }
  }
  return result;
}
var MAX_OUTPUT_TOKENS_DEFAULT, MAX_OUTPUT_TOKENS_THINKING, DEFAULT_GEMINI_BASE_URL, RETRYABLE_STATUS_CODES;
var init_api_client = __esm({
  "src/lib/agent/api-client.ts"() {
    init_esm();
    init_network_retry_settings();
    init_server_proxy();
    MAX_OUTPUT_TOKENS_DEFAULT = 16384;
    MAX_OUTPUT_TOKENS_THINKING = 32768;
    DEFAULT_GEMINI_BASE_URL = "https://api.tu-zi.com/v1beta";
    RETRYABLE_STATUS_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
  }
});

// src/lib/agent/tool.ts
function findToolByName(tools, name) {
  return tools.find((t) => t.name === name || (t.aliases ?? []).includes(name));
}
var ToolUseContext;
var init_tool = __esm({
  "src/lib/agent/tool.ts"() {
    ToolUseContext = class {
      options;
      abortSignal;
      readFileState;
      messages;
      getAppState;
      setAppState;
      constructor(opts) {
        this.options = opts.options;
        this.abortSignal = opts.abortSignal;
        this.readFileState = opts.readFileState ?? /* @__PURE__ */ new Map();
        this.messages = opts.messages ?? [];
        this.getAppState = opts.getAppState;
        this.setAppState = opts.setAppState;
      }
    };
  }
});

// src/lib/agent/query-loop.ts
async function* queryLoop(params) {
  const { systemPrompt, canUseTool, toolUseContext, maxTurns, apiKey, baseUrl } = params;
  const model = toolUseContext.options.model;
  const tools = toolUseContext.options.tools;
  const state = {
    messages: [...params.messages],
    turnCount: 1
  };
  while (true) {
    if (toolUseContext.abortSignal?.aborted) return;
    yield { type: "stream_request_start" };
    const apiMessages = toAPIMessages(state.messages);
    let assistantMsg;
    try {
      const stream = callModelAPIStream({
        messages: apiMessages,
        systemPrompt,
        model,
        provider: toolUseContext.options.provider,
        tools,
        thinkingConfig: toolUseContext.options.thinkingConfig,
        apiKey,
        baseUrl
      });
      let finalMsg = null;
      for await (const event of stream) {
        if (toolUseContext.abortSignal?.aborted) break;
        if (event.type === "delta") {
          yield { type: "text_delta", delta: event.text };
        } else {
          finalMsg = event.message;
        }
      }
      if (!finalMsg) throw new Error("No message received from stream");
      assistantMsg = finalMsg;
    } catch (err) {
      const errorMsg = {
        type: "assistant",
        uuid: v4_default(),
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: String(err) }],
          stop_reason: "end_turn"
        }
      };
      yield errorMsg;
      return;
    }
    state.messages.push(assistantMsg);
    const content = assistantMsg.message.content;
    const toolUseBlocks = Array.isArray(content) ? content.filter((b) => b.type === "tool_use") : [];
    yield assistantMsg;
    if (toolUseContext.abortSignal?.aborted) return;
    if (toolUseBlocks.length === 0) {
      return;
    }
    const toolResultBlocks = [];
    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;
      const { id: toolUseId, name: toolName, input } = block;
      const toolInput = input;
      const tool = findToolByName(tools, toolName);
      if (!tool) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `Tool "${toolName}" not found`,
          is_error: true
        });
        continue;
      }
      if (canUseTool) {
        const perm = await canUseTool(
          tool,
          toolInput,
          toolUseContext,
          assistantMsg,
          toolUseId
        );
        if (perm.behavior === "deny") {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            content: perm.message ?? "Permission denied",
            is_error: true
          });
          continue;
        }
      }
      try {
        const result = await tool.call(
          toolInput,
          toolUseContext,
          canUseTool ?? defaultAllowAll,
          assistantMsg
        );
        const resultBlock = tool.mapToolResultToBlock(result.data, toolUseId);
        toolResultBlocks.push(resultBlock);
        if (result.contextModifier) {
          Object.assign(toolUseContext, result.contextModifier(toolUseContext));
        }
      } catch (err) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `Error: ${String(err)}`,
          is_error: true
        });
      }
      if (toolUseContext.abortSignal?.aborted) return;
    }
    const toolResultMsg = {
      type: "user",
      uuid: v4_default(),
      message: {
        role: "user",
        content: toolResultBlocks
      },
      sourceToolAssistantUuid: assistantMsg.uuid
    };
    state.messages.push(toolResultMsg);
    yield toolResultMsg;
    state.turnCount++;
    if (maxTurns != null && state.turnCount > maxTurns) {
      return;
    }
  }
}
async function defaultAllowAll(_tool, _input) {
  return { behavior: "allow" };
}
var init_query_loop = __esm({
  "src/lib/agent/query-loop.ts"() {
    init_esm();
    init_api_client();
    init_tool();
  }
});

// src/lib/agent/types.ts
function accumulateUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0)
  };
}
var EMPTY_USAGE;
var init_types = __esm({
  "src/lib/agent/types.ts"() {
    EMPTY_USAGE = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    };
  }
});

// src/lib/agent/query-engine.ts
var query_engine_exports = {};
__export(query_engine_exports, {
  QueryEngine: () => QueryEngine
});
var QueryEngine;
var init_query_engine = __esm({
  "src/lib/agent/query-engine.ts"() {
    init_esm();
    init_query_loop();
    init_tool();
    init_types();
    QueryEngine = class {
      config;
      messages;
      abortController;
      totalUsage;
      totalCostUsd;
      constructor(config) {
        this.config = config;
        this.messages = [...config.initialMessages ?? []];
        this.abortController = new AbortController();
        this.totalUsage = { ...EMPTY_USAGE };
        this.totalCostUsd = 0;
      }
      buildToolProgressMessage(message) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        const toolUseBlocks = content.filter((block) => block.type === "tool_use");
        const toolNames = toolUseBlocks.map((block) => block.name);
        if (toolNames.length === 0) return null;
        const firstTool = toolNames[0];
        const contentLabel = firstTool === "HomeStudioWorkflow" ? "\u6B63\u5728\u6267\u884C\u5DE5\u4F5C\u6D41" : firstTool === "AskUserQuestion" ? "\u6B63\u5728\u6574\u7406\u4E0B\u4E00\u6B65\u9009\u9879" : toolNames.length > 1 ? "\u6B63\u5728\u8C03\u7528\u591A\u4E2A\u5DE5\u5177" : "\u6B63\u5728\u8C03\u7528\u5DE5\u5177";
        const askBlock = toolUseBlocks.find((b) => b.name === "AskUserQuestion");
        return {
          type: "progress",
          uuid: v4_default(),
          content: contentLabel,
          data: {
            stage: "tool_use",
            toolNames,
            ...askBlock ? { askUserQuestionArgs: askBlock.input } : {}
          }
        };
      }
      async *submitMessage(prompt, opts = {}) {
        const cfg = this.config;
        const model = cfg.model ?? "claude-sonnet-4-6";
        const tools = cfg.tools ?? [];
        const sessionId = v4_default();
        const startTime = Date.now();
        this.abortController = new AbortController();
        const systemParts = [];
        if (cfg.systemPrompt) systemParts.push(cfg.systemPrompt);
        if (cfg.appendSystemPrompt) systemParts.push(cfg.appendSystemPrompt);
        const userMsg = {
          type: "user",
          uuid: opts.uuid ?? v4_default(),
          isMeta: opts.isMeta,
          message: {
            role: "user",
            content: prompt
          }
        };
        this.messages.push(userMsg);
        yield {
          type: "system",
          subtype: "init",
          sessionId,
          tools: tools.map((t) => t.name),
          model
        };
        const context = new ToolUseContext({
          options: {
            model,
            provider: cfg.provider,
            tools,
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            maxBudgetUsd: cfg.maxBudgetUsd,
            customSystemPrompt: cfg.systemPrompt,
            appendSystemPrompt: cfg.appendSystemPrompt
          },
          abortSignal: this.abortController.signal,
          messages: [...this.messages],
          getAppState: cfg.getAppState,
          setAppState: cfg.setAppState
        });
        let turnCount = 1;
        let lastStopReason;
        try {
          for await (const event of queryLoop({
            messages: [...this.messages],
            systemPrompt: systemParts,
            canUseTool: cfg.canUseTool,
            toolUseContext: context,
            maxTurns: cfg.maxTurns,
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl
          })) {
            if (event.type === "stream_request_start") continue;
            if (event.type === "text_delta") {
              yield {
                type: "text_delta",
                uuid: v4_default(),
                sessionId,
                delta: event.delta
              };
              continue;
            }
            if (event.type === "assistant") {
              this.messages.push(event);
              const msg = event;
              const content = msg.message.content;
              if (Array.isArray(content)) {
                const last = content[content.length - 1];
                if (last?.type === "text") lastStopReason = msg.message.stop_reason;
                if (msg.message.usage) {
                  this.totalUsage = accumulateUsage(this.totalUsage, {
                    inputTokens: msg.message.usage.input_tokens ?? 0,
                    outputTokens: msg.message.usage.output_tokens ?? 0,
                    cacheCreationInputTokens: msg.message.usage.cache_creation_input_tokens ?? 0,
                    cacheReadInputTokens: msg.message.usage.cache_read_input_tokens ?? 0
                  });
                }
              }
              if (msg.message.stop_reason === "tool_use") {
                const progress = this.buildToolProgressMessage(msg);
                if (progress) {
                  yield {
                    type: "progress",
                    uuid: progress.uuid,
                    sessionId,
                    message: progress
                  };
                }
              } else {
                yield {
                  type: "assistant",
                  uuid: msg.uuid,
                  sessionId,
                  message: msg
                };
              }
            } else if (event.type === "user") {
              const msg = event;
              this.messages.push(msg);
              turnCount++;
              yield {
                type: "user",
                uuid: msg.uuid,
                sessionId,
                message: msg
              };
            } else if (event.type === "progress") {
              yield {
                type: "progress",
                uuid: event.uuid ?? v4_default(),
                sessionId,
                message: event
              };
            }
            if (cfg.maxBudgetUsd != null && this.totalCostUsd >= cfg.maxBudgetUsd) {
              yield {
                type: "result",
                subtype: "error_max_budget_usd",
                isError: true,
                durationMs: Date.now() - startTime,
                numTurns: turnCount,
                sessionId,
                totalCostUsd: this.totalCostUsd,
                usage: { ...this.totalUsage },
                uuid: v4_default()
              };
              return;
            }
          }
        } catch (err) {
          yield {
            type: "result",
            subtype: "success",
            isError: true,
            durationMs: Date.now() - startTime,
            numTurns: turnCount,
            result: String(err),
            sessionId,
            totalCostUsd: this.totalCostUsd,
            usage: { ...this.totalUsage },
            uuid: v4_default()
          };
          return;
        }
        let textResult = "";
        for (let i = this.messages.length - 1; i >= 0; i--) {
          const msg = this.messages[i];
          if (msg.type === "assistant") {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              const last = content[content.length - 1];
              if (last?.type === "text") textResult = last.text;
            }
            break;
          }
        }
        yield {
          type: "result",
          subtype: "success",
          isError: false,
          durationMs: Date.now() - startTime,
          numTurns: turnCount,
          result: textResult,
          stopReason: lastStopReason,
          sessionId,
          totalCostUsd: this.totalCostUsd,
          usage: { ...this.totalUsage },
          uuid: v4_default()
        };
      }
      /** Abort the current query. */
      interrupt() {
        this.abortController.abort();
      }
      /** Return a copy of the conversation history. */
      getMessages() {
        return [...this.messages];
      }
      /** Switch the model for subsequent messages. */
      setModel(model) {
        this.config.model = model;
      }
      /** Update transport/runtime config for subsequent messages. */
      updateRuntime(runtime) {
        if (runtime.model !== void 0) this.config.model = runtime.model;
        if (runtime.provider !== void 0) this.config.provider = runtime.provider;
        if (runtime.apiKey !== void 0) this.config.apiKey = runtime.apiKey;
        if (runtime.baseUrl !== void 0) this.config.baseUrl = runtime.baseUrl;
      }
    };
  }
});

// node_modules/fast-glob/out/utils/array.js
var require_array = __commonJS({
  "node_modules/fast-glob/out/utils/array.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.splitWhen = exports2.flatten = void 0;
    function flatten(items) {
      return items.reduce((collection, item) => [].concat(collection, item), []);
    }
    exports2.flatten = flatten;
    function splitWhen(items, predicate) {
      const result = [[]];
      let groupIndex = 0;
      for (const item of items) {
        if (predicate(item)) {
          groupIndex++;
          result[groupIndex] = [];
        } else {
          result[groupIndex].push(item);
        }
      }
      return result;
    }
    exports2.splitWhen = splitWhen;
  }
});

// node_modules/fast-glob/out/utils/errno.js
var require_errno = __commonJS({
  "node_modules/fast-glob/out/utils/errno.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isEnoentCodeError = void 0;
    function isEnoentCodeError(error) {
      return error.code === "ENOENT";
    }
    exports2.isEnoentCodeError = isEnoentCodeError;
  }
});

// node_modules/fast-glob/out/utils/fs.js
var require_fs = __commonJS({
  "node_modules/fast-glob/out/utils/fs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createDirentFromStats = void 0;
    var DirentFromStats = class {
      constructor(name, stats) {
        this.name = name;
        this.isBlockDevice = stats.isBlockDevice.bind(stats);
        this.isCharacterDevice = stats.isCharacterDevice.bind(stats);
        this.isDirectory = stats.isDirectory.bind(stats);
        this.isFIFO = stats.isFIFO.bind(stats);
        this.isFile = stats.isFile.bind(stats);
        this.isSocket = stats.isSocket.bind(stats);
        this.isSymbolicLink = stats.isSymbolicLink.bind(stats);
      }
    };
    function createDirentFromStats(name, stats) {
      return new DirentFromStats(name, stats);
    }
    exports2.createDirentFromStats = createDirentFromStats;
  }
});

// node_modules/fast-glob/out/utils/path.js
var require_path = __commonJS({
  "node_modules/fast-glob/out/utils/path.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.convertPosixPathToPattern = exports2.convertWindowsPathToPattern = exports2.convertPathToPattern = exports2.escapePosixPath = exports2.escapeWindowsPath = exports2.escape = exports2.removeLeadingDotSegment = exports2.makeAbsolute = exports2.unixify = void 0;
    var os = require("os");
    var path2 = require("path");
    var IS_WINDOWS_PLATFORM = os.platform() === "win32";
    var LEADING_DOT_SEGMENT_CHARACTERS_COUNT = 2;
    var POSIX_UNESCAPED_GLOB_SYMBOLS_RE = /(\\?)([()*?[\]{|}]|^!|[!+@](?=\()|\\(?![!()*+?@[\]{|}]))/g;
    var WINDOWS_UNESCAPED_GLOB_SYMBOLS_RE = /(\\?)([()[\]{}]|^!|[!+@](?=\())/g;
    var DOS_DEVICE_PATH_RE = /^\\\\([.?])/;
    var WINDOWS_BACKSLASHES_RE = /\\(?![!()+@[\]{}])/g;
    function unixify(filepath) {
      return filepath.replace(/\\/g, "/");
    }
    exports2.unixify = unixify;
    function makeAbsolute(cwd, filepath) {
      return path2.resolve(cwd, filepath);
    }
    exports2.makeAbsolute = makeAbsolute;
    function removeLeadingDotSegment(entry) {
      if (entry.charAt(0) === ".") {
        const secondCharactery = entry.charAt(1);
        if (secondCharactery === "/" || secondCharactery === "\\") {
          return entry.slice(LEADING_DOT_SEGMENT_CHARACTERS_COUNT);
        }
      }
      return entry;
    }
    exports2.removeLeadingDotSegment = removeLeadingDotSegment;
    exports2.escape = IS_WINDOWS_PLATFORM ? escapeWindowsPath : escapePosixPath;
    function escapeWindowsPath(pattern) {
      return pattern.replace(WINDOWS_UNESCAPED_GLOB_SYMBOLS_RE, "\\$2");
    }
    exports2.escapeWindowsPath = escapeWindowsPath;
    function escapePosixPath(pattern) {
      return pattern.replace(POSIX_UNESCAPED_GLOB_SYMBOLS_RE, "\\$2");
    }
    exports2.escapePosixPath = escapePosixPath;
    exports2.convertPathToPattern = IS_WINDOWS_PLATFORM ? convertWindowsPathToPattern : convertPosixPathToPattern;
    function convertWindowsPathToPattern(filepath) {
      return escapeWindowsPath(filepath).replace(DOS_DEVICE_PATH_RE, "//$1").replace(WINDOWS_BACKSLASHES_RE, "/");
    }
    exports2.convertWindowsPathToPattern = convertWindowsPathToPattern;
    function convertPosixPathToPattern(filepath) {
      return escapePosixPath(filepath);
    }
    exports2.convertPosixPathToPattern = convertPosixPathToPattern;
  }
});

// node_modules/is-extglob/index.js
var require_is_extglob = __commonJS({
  "node_modules/is-extglob/index.js"(exports2, module2) {
    module2.exports = function isExtglob(str) {
      if (typeof str !== "string" || str === "") {
        return false;
      }
      var match;
      while (match = /(\\).|([@?!+*]\(.*\))/g.exec(str)) {
        if (match[2]) return true;
        str = str.slice(match.index + match[0].length);
      }
      return false;
    };
  }
});

// node_modules/is-glob/index.js
var require_is_glob = __commonJS({
  "node_modules/is-glob/index.js"(exports2, module2) {
    var isExtglob = require_is_extglob();
    var chars = { "{": "}", "(": ")", "[": "]" };
    var strictCheck = function(str) {
      if (str[0] === "!") {
        return true;
      }
      var index = 0;
      var pipeIndex = -2;
      var closeSquareIndex = -2;
      var closeCurlyIndex = -2;
      var closeParenIndex = -2;
      var backSlashIndex = -2;
      while (index < str.length) {
        if (str[index] === "*") {
          return true;
        }
        if (str[index + 1] === "?" && /[\].+)]/.test(str[index])) {
          return true;
        }
        if (closeSquareIndex !== -1 && str[index] === "[" && str[index + 1] !== "]") {
          if (closeSquareIndex < index) {
            closeSquareIndex = str.indexOf("]", index);
          }
          if (closeSquareIndex > index) {
            if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
              return true;
            }
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeSquareIndex) {
              return true;
            }
          }
        }
        if (closeCurlyIndex !== -1 && str[index] === "{" && str[index + 1] !== "}") {
          closeCurlyIndex = str.indexOf("}", index);
          if (closeCurlyIndex > index) {
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeCurlyIndex) {
              return true;
            }
          }
        }
        if (closeParenIndex !== -1 && str[index] === "(" && str[index + 1] === "?" && /[:!=]/.test(str[index + 2]) && str[index + 3] !== ")") {
          closeParenIndex = str.indexOf(")", index);
          if (closeParenIndex > index) {
            backSlashIndex = str.indexOf("\\", index);
            if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
              return true;
            }
          }
        }
        if (pipeIndex !== -1 && str[index] === "(" && str[index + 1] !== "|") {
          if (pipeIndex < index) {
            pipeIndex = str.indexOf("|", index);
          }
          if (pipeIndex !== -1 && str[pipeIndex + 1] !== ")") {
            closeParenIndex = str.indexOf(")", pipeIndex);
            if (closeParenIndex > pipeIndex) {
              backSlashIndex = str.indexOf("\\", pipeIndex);
              if (backSlashIndex === -1 || backSlashIndex > closeParenIndex) {
                return true;
              }
            }
          }
        }
        if (str[index] === "\\") {
          var open = str[index + 1];
          index += 2;
          var close = chars[open];
          if (close) {
            var n = str.indexOf(close, index);
            if (n !== -1) {
              index = n + 1;
            }
          }
          if (str[index] === "!") {
            return true;
          }
        } else {
          index++;
        }
      }
      return false;
    };
    var relaxedCheck = function(str) {
      if (str[0] === "!") {
        return true;
      }
      var index = 0;
      while (index < str.length) {
        if (/[*?{}()[\]]/.test(str[index])) {
          return true;
        }
        if (str[index] === "\\") {
          var open = str[index + 1];
          index += 2;
          var close = chars[open];
          if (close) {
            var n = str.indexOf(close, index);
            if (n !== -1) {
              index = n + 1;
            }
          }
          if (str[index] === "!") {
            return true;
          }
        } else {
          index++;
        }
      }
      return false;
    };
    module2.exports = function isGlob(str, options) {
      if (typeof str !== "string" || str === "") {
        return false;
      }
      if (isExtglob(str)) {
        return true;
      }
      var check = strictCheck;
      if (options && options.strict === false) {
        check = relaxedCheck;
      }
      return check(str);
    };
  }
});

// node_modules/fast-glob/node_modules/glob-parent/index.js
var require_glob_parent = __commonJS({
  "node_modules/fast-glob/node_modules/glob-parent/index.js"(exports2, module2) {
    "use strict";
    var isGlob = require_is_glob();
    var pathPosixDirname = require("path").posix.dirname;
    var isWin32 = require("os").platform() === "win32";
    var slash = "/";
    var backslash = /\\/g;
    var enclosure = /[\{\[].*[\}\]]$/;
    var globby = /(^|[^\\])([\{\[]|\([^\)]+$)/;
    var escaped = /\\([\!\*\?\|\[\]\(\)\{\}])/g;
    module2.exports = function globParent(str, opts) {
      var options = Object.assign({ flipBackslashes: true }, opts);
      if (options.flipBackslashes && isWin32 && str.indexOf(slash) < 0) {
        str = str.replace(backslash, slash);
      }
      if (enclosure.test(str)) {
        str += slash;
      }
      str += "a";
      do {
        str = pathPosixDirname(str);
      } while (isGlob(str) || globby.test(str));
      return str.replace(escaped, "$1");
    };
  }
});

// node_modules/braces/lib/utils.js
var require_utils = __commonJS({
  "node_modules/braces/lib/utils.js"(exports2) {
    "use strict";
    exports2.isInteger = (num) => {
      if (typeof num === "number") {
        return Number.isInteger(num);
      }
      if (typeof num === "string" && num.trim() !== "") {
        return Number.isInteger(Number(num));
      }
      return false;
    };
    exports2.find = (node, type) => node.nodes.find((node2) => node2.type === type);
    exports2.exceedsLimit = (min, max, step = 1, limit) => {
      if (limit === false) return false;
      if (!exports2.isInteger(min) || !exports2.isInteger(max)) return false;
      return (Number(max) - Number(min)) / Number(step) >= limit;
    };
    exports2.escapeNode = (block, n = 0, type) => {
      const node = block.nodes[n];
      if (!node) return;
      if (type && node.type === type || node.type === "open" || node.type === "close") {
        if (node.escaped !== true) {
          node.value = "\\" + node.value;
          node.escaped = true;
        }
      }
    };
    exports2.encloseBrace = (node) => {
      if (node.type !== "brace") return false;
      if (node.commas >> 0 + node.ranges >> 0 === 0) {
        node.invalid = true;
        return true;
      }
      return false;
    };
    exports2.isInvalidBrace = (block) => {
      if (block.type !== "brace") return false;
      if (block.invalid === true || block.dollar) return true;
      if (block.commas >> 0 + block.ranges >> 0 === 0) {
        block.invalid = true;
        return true;
      }
      if (block.open !== true || block.close !== true) {
        block.invalid = true;
        return true;
      }
      return false;
    };
    exports2.isOpenOrClose = (node) => {
      if (node.type === "open" || node.type === "close") {
        return true;
      }
      return node.open === true || node.close === true;
    };
    exports2.reduce = (nodes) => nodes.reduce((acc, node) => {
      if (node.type === "text") acc.push(node.value);
      if (node.type === "range") node.type = "text";
      return acc;
    }, []);
    exports2.flatten = (...args) => {
      const result = [];
      const flat = (arr) => {
        for (let i = 0; i < arr.length; i++) {
          const ele = arr[i];
          if (Array.isArray(ele)) {
            flat(ele);
            continue;
          }
          if (ele !== void 0) {
            result.push(ele);
          }
        }
        return result;
      };
      flat(args);
      return result;
    };
  }
});

// node_modules/braces/lib/stringify.js
var require_stringify = __commonJS({
  "node_modules/braces/lib/stringify.js"(exports2, module2) {
    "use strict";
    var utils = require_utils();
    module2.exports = (ast, options = {}) => {
      const stringify = (node, parent = {}) => {
        const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
        const invalidNode = node.invalid === true && options.escapeInvalid === true;
        let output = "";
        if (node.value) {
          if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) {
            return "\\" + node.value;
          }
          return node.value;
        }
        if (node.value) {
          return node.value;
        }
        if (node.nodes) {
          for (const child of node.nodes) {
            output += stringify(child);
          }
        }
        return output;
      };
      return stringify(ast);
    };
  }
});

// node_modules/is-number/index.js
var require_is_number = __commonJS({
  "node_modules/is-number/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function(num) {
      if (typeof num === "number") {
        return num - num === 0;
      }
      if (typeof num === "string" && num.trim() !== "") {
        return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);
      }
      return false;
    };
  }
});

// node_modules/to-regex-range/index.js
var require_to_regex_range = __commonJS({
  "node_modules/to-regex-range/index.js"(exports2, module2) {
    "use strict";
    var isNumber = require_is_number();
    var toRegexRange = (min, max, options) => {
      if (isNumber(min) === false) {
        throw new TypeError("toRegexRange: expected the first argument to be a number");
      }
      if (max === void 0 || min === max) {
        return String(min);
      }
      if (isNumber(max) === false) {
        throw new TypeError("toRegexRange: expected the second argument to be a number.");
      }
      let opts = { relaxZeros: true, ...options };
      if (typeof opts.strictZeros === "boolean") {
        opts.relaxZeros = opts.strictZeros === false;
      }
      let relax = String(opts.relaxZeros);
      let shorthand = String(opts.shorthand);
      let capture = String(opts.capture);
      let wrap = String(opts.wrap);
      let cacheKey = min + ":" + max + "=" + relax + shorthand + capture + wrap;
      if (toRegexRange.cache.hasOwnProperty(cacheKey)) {
        return toRegexRange.cache[cacheKey].result;
      }
      let a = Math.min(min, max);
      let b = Math.max(min, max);
      if (Math.abs(a - b) === 1) {
        let result = min + "|" + max;
        if (opts.capture) {
          return `(${result})`;
        }
        if (opts.wrap === false) {
          return result;
        }
        return `(?:${result})`;
      }
      let isPadded = hasPadding(min) || hasPadding(max);
      let state = { min, max, a, b };
      let positives = [];
      let negatives = [];
      if (isPadded) {
        state.isPadded = isPadded;
        state.maxLen = String(state.max).length;
      }
      if (a < 0) {
        let newMin = b < 0 ? Math.abs(b) : 1;
        negatives = splitToPatterns(newMin, Math.abs(a), state, opts);
        a = state.a = 0;
      }
      if (b >= 0) {
        positives = splitToPatterns(a, b, state, opts);
      }
      state.negatives = negatives;
      state.positives = positives;
      state.result = collatePatterns(negatives, positives, opts);
      if (opts.capture === true) {
        state.result = `(${state.result})`;
      } else if (opts.wrap !== false && positives.length + negatives.length > 1) {
        state.result = `(?:${state.result})`;
      }
      toRegexRange.cache[cacheKey] = state;
      return state.result;
    };
    function collatePatterns(neg, pos, options) {
      let onlyNegative = filterPatterns(neg, pos, "-", false, options) || [];
      let onlyPositive = filterPatterns(pos, neg, "", false, options) || [];
      let intersected = filterPatterns(neg, pos, "-?", true, options) || [];
      let subpatterns = onlyNegative.concat(intersected).concat(onlyPositive);
      return subpatterns.join("|");
    }
    function splitToRanges(min, max) {
      let nines = 1;
      let zeros = 1;
      let stop = countNines(min, nines);
      let stops = /* @__PURE__ */ new Set([max]);
      while (min <= stop && stop <= max) {
        stops.add(stop);
        nines += 1;
        stop = countNines(min, nines);
      }
      stop = countZeros(max + 1, zeros) - 1;
      while (min < stop && stop <= max) {
        stops.add(stop);
        zeros += 1;
        stop = countZeros(max + 1, zeros) - 1;
      }
      stops = [...stops];
      stops.sort(compare);
      return stops;
    }
    function rangeToPattern(start, stop, options) {
      if (start === stop) {
        return { pattern: start, count: [], digits: 0 };
      }
      let zipped = zip(start, stop);
      let digits = zipped.length;
      let pattern = "";
      let count = 0;
      for (let i = 0; i < digits; i++) {
        let [startDigit, stopDigit] = zipped[i];
        if (startDigit === stopDigit) {
          pattern += startDigit;
        } else if (startDigit !== "0" || stopDigit !== "9") {
          pattern += toCharacterClass(startDigit, stopDigit, options);
        } else {
          count++;
        }
      }
      if (count) {
        pattern += options.shorthand === true ? "\\d" : "[0-9]";
      }
      return { pattern, count: [count], digits };
    }
    function splitToPatterns(min, max, tok, options) {
      let ranges = splitToRanges(min, max);
      let tokens = [];
      let start = min;
      let prev;
      for (let i = 0; i < ranges.length; i++) {
        let max2 = ranges[i];
        let obj = rangeToPattern(String(start), String(max2), options);
        let zeros = "";
        if (!tok.isPadded && prev && prev.pattern === obj.pattern) {
          if (prev.count.length > 1) {
            prev.count.pop();
          }
          prev.count.push(obj.count[0]);
          prev.string = prev.pattern + toQuantifier(prev.count);
          start = max2 + 1;
          continue;
        }
        if (tok.isPadded) {
          zeros = padZeros(max2, tok, options);
        }
        obj.string = zeros + obj.pattern + toQuantifier(obj.count);
        tokens.push(obj);
        start = max2 + 1;
        prev = obj;
      }
      return tokens;
    }
    function filterPatterns(arr, comparison, prefix, intersection, options) {
      let result = [];
      for (let ele of arr) {
        let { string } = ele;
        if (!intersection && !contains(comparison, "string", string)) {
          result.push(prefix + string);
        }
        if (intersection && contains(comparison, "string", string)) {
          result.push(prefix + string);
        }
      }
      return result;
    }
    function zip(a, b) {
      let arr = [];
      for (let i = 0; i < a.length; i++) arr.push([a[i], b[i]]);
      return arr;
    }
    function compare(a, b) {
      return a > b ? 1 : b > a ? -1 : 0;
    }
    function contains(arr, key, val) {
      return arr.some((ele) => ele[key] === val);
    }
    function countNines(min, len) {
      return Number(String(min).slice(0, -len) + "9".repeat(len));
    }
    function countZeros(integer, zeros) {
      return integer - integer % Math.pow(10, zeros);
    }
    function toQuantifier(digits) {
      let [start = 0, stop = ""] = digits;
      if (stop || start > 1) {
        return `{${start + (stop ? "," + stop : "")}}`;
      }
      return "";
    }
    function toCharacterClass(a, b, options) {
      return `[${a}${b - a === 1 ? "" : "-"}${b}]`;
    }
    function hasPadding(str) {
      return /^-?(0+)\d/.test(str);
    }
    function padZeros(value, tok, options) {
      if (!tok.isPadded) {
        return value;
      }
      let diff = Math.abs(tok.maxLen - String(value).length);
      let relax = options.relaxZeros !== false;
      switch (diff) {
        case 0:
          return "";
        case 1:
          return relax ? "0?" : "0";
        case 2:
          return relax ? "0{0,2}" : "00";
        default: {
          return relax ? `0{0,${diff}}` : `0{${diff}}`;
        }
      }
    }
    toRegexRange.cache = {};
    toRegexRange.clearCache = () => toRegexRange.cache = {};
    module2.exports = toRegexRange;
  }
});

// node_modules/fill-range/index.js
var require_fill_range = __commonJS({
  "node_modules/fill-range/index.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var toRegexRange = require_to_regex_range();
    var isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
    var transform = (toNumber) => {
      return (value) => toNumber === true ? Number(value) : String(value);
    };
    var isValidValue = (value) => {
      return typeof value === "number" || typeof value === "string" && value !== "";
    };
    var isNumber = (num) => Number.isInteger(+num);
    var zeros = (input) => {
      let value = `${input}`;
      let index = -1;
      if (value[0] === "-") value = value.slice(1);
      if (value === "0") return false;
      while (value[++index] === "0") ;
      return index > 0;
    };
    var stringify = (start, end, options) => {
      if (typeof start === "string" || typeof end === "string") {
        return true;
      }
      return options.stringify === true;
    };
    var pad = (input, maxLength, toNumber) => {
      if (maxLength > 0) {
        let dash = input[0] === "-" ? "-" : "";
        if (dash) input = input.slice(1);
        input = dash + input.padStart(dash ? maxLength - 1 : maxLength, "0");
      }
      if (toNumber === false) {
        return String(input);
      }
      return input;
    };
    var toMaxLen = (input, maxLength) => {
      let negative = input[0] === "-" ? "-" : "";
      if (negative) {
        input = input.slice(1);
        maxLength--;
      }
      while (input.length < maxLength) input = "0" + input;
      return negative ? "-" + input : input;
    };
    var toSequence = (parts, options, maxLen) => {
      parts.negatives.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      parts.positives.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      let prefix = options.capture ? "" : "?:";
      let positives = "";
      let negatives = "";
      let result;
      if (parts.positives.length) {
        positives = parts.positives.map((v) => toMaxLen(String(v), maxLen)).join("|");
      }
      if (parts.negatives.length) {
        negatives = `-(${prefix}${parts.negatives.map((v) => toMaxLen(String(v), maxLen)).join("|")})`;
      }
      if (positives && negatives) {
        result = `${positives}|${negatives}`;
      } else {
        result = positives || negatives;
      }
      if (options.wrap) {
        return `(${prefix}${result})`;
      }
      return result;
    };
    var toRange = (a, b, isNumbers, options) => {
      if (isNumbers) {
        return toRegexRange(a, b, { wrap: false, ...options });
      }
      let start = String.fromCharCode(a);
      if (a === b) return start;
      let stop = String.fromCharCode(b);
      return `[${start}-${stop}]`;
    };
    var toRegex = (start, end, options) => {
      if (Array.isArray(start)) {
        let wrap = options.wrap === true;
        let prefix = options.capture ? "" : "?:";
        return wrap ? `(${prefix}${start.join("|")})` : start.join("|");
      }
      return toRegexRange(start, end, options);
    };
    var rangeError = (...args) => {
      return new RangeError("Invalid range arguments: " + util.inspect(...args));
    };
    var invalidRange = (start, end, options) => {
      if (options.strictRanges === true) throw rangeError([start, end]);
      return [];
    };
    var invalidStep = (step, options) => {
      if (options.strictRanges === true) {
        throw new TypeError(`Expected step "${step}" to be a number`);
      }
      return [];
    };
    var fillNumbers = (start, end, step = 1, options = {}) => {
      let a = Number(start);
      let b = Number(end);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        if (options.strictRanges === true) throw rangeError([start, end]);
        return [];
      }
      if (a === 0) a = 0;
      if (b === 0) b = 0;
      let descending = a > b;
      let startString = String(start);
      let endString = String(end);
      let stepString = String(step);
      step = Math.max(Math.abs(step), 1);
      let padded = zeros(startString) || zeros(endString) || zeros(stepString);
      let maxLen = padded ? Math.max(startString.length, endString.length, stepString.length) : 0;
      let toNumber = padded === false && stringify(start, end, options) === false;
      let format = options.transform || transform(toNumber);
      if (options.toRegex && step === 1) {
        return toRange(toMaxLen(start, maxLen), toMaxLen(end, maxLen), true, options);
      }
      let parts = { negatives: [], positives: [] };
      let push = (num) => parts[num < 0 ? "negatives" : "positives"].push(Math.abs(num));
      let range = [];
      let index = 0;
      while (descending ? a >= b : a <= b) {
        if (options.toRegex === true && step > 1) {
          push(a);
        } else {
          range.push(pad(format(a, index), maxLen, toNumber));
        }
        a = descending ? a - step : a + step;
        index++;
      }
      if (options.toRegex === true) {
        return step > 1 ? toSequence(parts, options, maxLen) : toRegex(range, null, { wrap: false, ...options });
      }
      return range;
    };
    var fillLetters = (start, end, step = 1, options = {}) => {
      if (!isNumber(start) && start.length > 1 || !isNumber(end) && end.length > 1) {
        return invalidRange(start, end, options);
      }
      let format = options.transform || ((val) => String.fromCharCode(val));
      let a = `${start}`.charCodeAt(0);
      let b = `${end}`.charCodeAt(0);
      let descending = a > b;
      let min = Math.min(a, b);
      let max = Math.max(a, b);
      if (options.toRegex && step === 1) {
        return toRange(min, max, false, options);
      }
      let range = [];
      let index = 0;
      while (descending ? a >= b : a <= b) {
        range.push(format(a, index));
        a = descending ? a - step : a + step;
        index++;
      }
      if (options.toRegex === true) {
        return toRegex(range, null, { wrap: false, options });
      }
      return range;
    };
    var fill = (start, end, step, options = {}) => {
      if (end == null && isValidValue(start)) {
        return [start];
      }
      if (!isValidValue(start) || !isValidValue(end)) {
        return invalidRange(start, end, options);
      }
      if (typeof step === "function") {
        return fill(start, end, 1, { transform: step });
      }
      if (isObject(step)) {
        return fill(start, end, 0, step);
      }
      let opts = { ...options };
      if (opts.capture === true) opts.wrap = true;
      step = step || opts.step || 1;
      if (!isNumber(step)) {
        if (step != null && !isObject(step)) return invalidStep(step, opts);
        return fill(start, end, 1, step);
      }
      if (isNumber(start) && isNumber(end)) {
        return fillNumbers(start, end, step, opts);
      }
      return fillLetters(start, end, Math.max(Math.abs(step), 1), opts);
    };
    module2.exports = fill;
  }
});

// node_modules/braces/lib/compile.js
var require_compile = __commonJS({
  "node_modules/braces/lib/compile.js"(exports2, module2) {
    "use strict";
    var fill = require_fill_range();
    var utils = require_utils();
    var compile = (ast, options = {}) => {
      const walk = (node, parent = {}) => {
        const invalidBlock = utils.isInvalidBrace(parent);
        const invalidNode = node.invalid === true && options.escapeInvalid === true;
        const invalid = invalidBlock === true || invalidNode === true;
        const prefix = options.escapeInvalid === true ? "\\" : "";
        let output = "";
        if (node.isOpen === true) {
          return prefix + node.value;
        }
        if (node.isClose === true) {
          console.log("node.isClose", prefix, node.value);
          return prefix + node.value;
        }
        if (node.type === "open") {
          return invalid ? prefix + node.value : "(";
        }
        if (node.type === "close") {
          return invalid ? prefix + node.value : ")";
        }
        if (node.type === "comma") {
          return node.prev.type === "comma" ? "" : invalid ? node.value : "|";
        }
        if (node.value) {
          return node.value;
        }
        if (node.nodes && node.ranges > 0) {
          const args = utils.reduce(node.nodes);
          const range = fill(...args, { ...options, wrap: false, toRegex: true, strictZeros: true });
          if (range.length !== 0) {
            return args.length > 1 && range.length > 1 ? `(${range})` : range;
          }
        }
        if (node.nodes) {
          for (const child of node.nodes) {
            output += walk(child, node);
          }
        }
        return output;
      };
      return walk(ast);
    };
    module2.exports = compile;
  }
});

// node_modules/braces/lib/expand.js
var require_expand = __commonJS({
  "node_modules/braces/lib/expand.js"(exports2, module2) {
    "use strict";
    var fill = require_fill_range();
    var stringify = require_stringify();
    var utils = require_utils();
    var append = (queue = "", stash = "", enclose = false) => {
      const result = [];
      queue = [].concat(queue);
      stash = [].concat(stash);
      if (!stash.length) return queue;
      if (!queue.length) {
        return enclose ? utils.flatten(stash).map((ele) => `{${ele}}`) : stash;
      }
      for (const item of queue) {
        if (Array.isArray(item)) {
          for (const value of item) {
            result.push(append(value, stash, enclose));
          }
        } else {
          for (let ele of stash) {
            if (enclose === true && typeof ele === "string") ele = `{${ele}}`;
            result.push(Array.isArray(ele) ? append(item, ele, enclose) : item + ele);
          }
        }
      }
      return utils.flatten(result);
    };
    var expand = (ast, options = {}) => {
      const rangeLimit = options.rangeLimit === void 0 ? 1e3 : options.rangeLimit;
      const walk = (node, parent = {}) => {
        node.queue = [];
        let p = parent;
        let q = parent.queue;
        while (p.type !== "brace" && p.type !== "root" && p.parent) {
          p = p.parent;
          q = p.queue;
        }
        if (node.invalid || node.dollar) {
          q.push(append(q.pop(), stringify(node, options)));
          return;
        }
        if (node.type === "brace" && node.invalid !== true && node.nodes.length === 2) {
          q.push(append(q.pop(), ["{}"]));
          return;
        }
        if (node.nodes && node.ranges > 0) {
          const args = utils.reduce(node.nodes);
          if (utils.exceedsLimit(...args, options.step, rangeLimit)) {
            throw new RangeError("expanded array length exceeds range limit. Use options.rangeLimit to increase or disable the limit.");
          }
          let range = fill(...args, options);
          if (range.length === 0) {
            range = stringify(node, options);
          }
          q.push(append(q.pop(), range));
          node.nodes = [];
          return;
        }
        const enclose = utils.encloseBrace(node);
        let queue = node.queue;
        let block = node;
        while (block.type !== "brace" && block.type !== "root" && block.parent) {
          block = block.parent;
          queue = block.queue;
        }
        for (let i = 0; i < node.nodes.length; i++) {
          const child = node.nodes[i];
          if (child.type === "comma" && node.type === "brace") {
            if (i === 1) queue.push("");
            queue.push("");
            continue;
          }
          if (child.type === "close") {
            q.push(append(q.pop(), queue, enclose));
            continue;
          }
          if (child.value && child.type !== "open") {
            queue.push(append(queue.pop(), child.value));
            continue;
          }
          if (child.nodes) {
            walk(child, node);
          }
        }
        return queue;
      };
      return utils.flatten(walk(ast));
    };
    module2.exports = expand;
  }
});

// node_modules/braces/lib/constants.js
var require_constants = __commonJS({
  "node_modules/braces/lib/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      MAX_LENGTH: 1e4,
      // Digits
      CHAR_0: "0",
      /* 0 */
      CHAR_9: "9",
      /* 9 */
      // Alphabet chars.
      CHAR_UPPERCASE_A: "A",
      /* A */
      CHAR_LOWERCASE_A: "a",
      /* a */
      CHAR_UPPERCASE_Z: "Z",
      /* Z */
      CHAR_LOWERCASE_Z: "z",
      /* z */
      CHAR_LEFT_PARENTHESES: "(",
      /* ( */
      CHAR_RIGHT_PARENTHESES: ")",
      /* ) */
      CHAR_ASTERISK: "*",
      /* * */
      // Non-alphabetic chars.
      CHAR_AMPERSAND: "&",
      /* & */
      CHAR_AT: "@",
      /* @ */
      CHAR_BACKSLASH: "\\",
      /* \ */
      CHAR_BACKTICK: "`",
      /* ` */
      CHAR_CARRIAGE_RETURN: "\r",
      /* \r */
      CHAR_CIRCUMFLEX_ACCENT: "^",
      /* ^ */
      CHAR_COLON: ":",
      /* : */
      CHAR_COMMA: ",",
      /* , */
      CHAR_DOLLAR: "$",
      /* . */
      CHAR_DOT: ".",
      /* . */
      CHAR_DOUBLE_QUOTE: '"',
      /* " */
      CHAR_EQUAL: "=",
      /* = */
      CHAR_EXCLAMATION_MARK: "!",
      /* ! */
      CHAR_FORM_FEED: "\f",
      /* \f */
      CHAR_FORWARD_SLASH: "/",
      /* / */
      CHAR_HASH: "#",
      /* # */
      CHAR_HYPHEN_MINUS: "-",
      /* - */
      CHAR_LEFT_ANGLE_BRACKET: "<",
      /* < */
      CHAR_LEFT_CURLY_BRACE: "{",
      /* { */
      CHAR_LEFT_SQUARE_BRACKET: "[",
      /* [ */
      CHAR_LINE_FEED: "\n",
      /* \n */
      CHAR_NO_BREAK_SPACE: "\xA0",
      /* \u00A0 */
      CHAR_PERCENT: "%",
      /* % */
      CHAR_PLUS: "+",
      /* + */
      CHAR_QUESTION_MARK: "?",
      /* ? */
      CHAR_RIGHT_ANGLE_BRACKET: ">",
      /* > */
      CHAR_RIGHT_CURLY_BRACE: "}",
      /* } */
      CHAR_RIGHT_SQUARE_BRACKET: "]",
      /* ] */
      CHAR_SEMICOLON: ";",
      /* ; */
      CHAR_SINGLE_QUOTE: "'",
      /* ' */
      CHAR_SPACE: " ",
      /*   */
      CHAR_TAB: "	",
      /* \t */
      CHAR_UNDERSCORE: "_",
      /* _ */
      CHAR_VERTICAL_LINE: "|",
      /* | */
      CHAR_ZERO_WIDTH_NOBREAK_SPACE: "\uFEFF"
      /* \uFEFF */
    };
  }
});

// node_modules/braces/lib/parse.js
var require_parse = __commonJS({
  "node_modules/braces/lib/parse.js"(exports2, module2) {
    "use strict";
    var stringify = require_stringify();
    var {
      MAX_LENGTH,
      CHAR_BACKSLASH,
      /* \ */
      CHAR_BACKTICK,
      /* ` */
      CHAR_COMMA,
      /* , */
      CHAR_DOT,
      /* . */
      CHAR_LEFT_PARENTHESES,
      /* ( */
      CHAR_RIGHT_PARENTHESES,
      /* ) */
      CHAR_LEFT_CURLY_BRACE,
      /* { */
      CHAR_RIGHT_CURLY_BRACE,
      /* } */
      CHAR_LEFT_SQUARE_BRACKET,
      /* [ */
      CHAR_RIGHT_SQUARE_BRACKET,
      /* ] */
      CHAR_DOUBLE_QUOTE,
      /* " */
      CHAR_SINGLE_QUOTE,
      /* ' */
      CHAR_NO_BREAK_SPACE,
      CHAR_ZERO_WIDTH_NOBREAK_SPACE
    } = require_constants();
    var parse = (input, options = {}) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected a string");
      }
      const opts = options || {};
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      if (input.length > max) {
        throw new SyntaxError(`Input length (${input.length}), exceeds max characters (${max})`);
      }
      const ast = { type: "root", input, nodes: [] };
      const stack = [ast];
      let block = ast;
      let prev = ast;
      let brackets = 0;
      const length = input.length;
      let index = 0;
      let depth = 0;
      let value;
      const advance = () => input[index++];
      const push = (node) => {
        if (node.type === "text" && prev.type === "dot") {
          prev.type = "text";
        }
        if (prev && prev.type === "text" && node.type === "text") {
          prev.value += node.value;
          return;
        }
        block.nodes.push(node);
        node.parent = block;
        node.prev = prev;
        prev = node;
        return node;
      };
      push({ type: "bos" });
      while (index < length) {
        block = stack[stack.length - 1];
        value = advance();
        if (value === CHAR_ZERO_WIDTH_NOBREAK_SPACE || value === CHAR_NO_BREAK_SPACE) {
          continue;
        }
        if (value === CHAR_BACKSLASH) {
          push({ type: "text", value: (options.keepEscaping ? value : "") + advance() });
          continue;
        }
        if (value === CHAR_RIGHT_SQUARE_BRACKET) {
          push({ type: "text", value: "\\" + value });
          continue;
        }
        if (value === CHAR_LEFT_SQUARE_BRACKET) {
          brackets++;
          let next;
          while (index < length && (next = advance())) {
            value += next;
            if (next === CHAR_LEFT_SQUARE_BRACKET) {
              brackets++;
              continue;
            }
            if (next === CHAR_BACKSLASH) {
              value += advance();
              continue;
            }
            if (next === CHAR_RIGHT_SQUARE_BRACKET) {
              brackets--;
              if (brackets === 0) {
                break;
              }
            }
          }
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_LEFT_PARENTHESES) {
          block = push({ type: "paren", nodes: [] });
          stack.push(block);
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_RIGHT_PARENTHESES) {
          if (block.type !== "paren") {
            push({ type: "text", value });
            continue;
          }
          block = stack.pop();
          push({ type: "text", value });
          block = stack[stack.length - 1];
          continue;
        }
        if (value === CHAR_DOUBLE_QUOTE || value === CHAR_SINGLE_QUOTE || value === CHAR_BACKTICK) {
          const open = value;
          let next;
          if (options.keepQuotes !== true) {
            value = "";
          }
          while (index < length && (next = advance())) {
            if (next === CHAR_BACKSLASH) {
              value += next + advance();
              continue;
            }
            if (next === open) {
              if (options.keepQuotes === true) value += next;
              break;
            }
            value += next;
          }
          push({ type: "text", value });
          continue;
        }
        if (value === CHAR_LEFT_CURLY_BRACE) {
          depth++;
          const dollar = prev.value && prev.value.slice(-1) === "$" || block.dollar === true;
          const brace = {
            type: "brace",
            open: true,
            close: false,
            dollar,
            depth,
            commas: 0,
            ranges: 0,
            nodes: []
          };
          block = push(brace);
          stack.push(block);
          push({ type: "open", value });
          continue;
        }
        if (value === CHAR_RIGHT_CURLY_BRACE) {
          if (block.type !== "brace") {
            push({ type: "text", value });
            continue;
          }
          const type = "close";
          block = stack.pop();
          block.close = true;
          push({ type, value });
          depth--;
          block = stack[stack.length - 1];
          continue;
        }
        if (value === CHAR_COMMA && depth > 0) {
          if (block.ranges > 0) {
            block.ranges = 0;
            const open = block.nodes.shift();
            block.nodes = [open, { type: "text", value: stringify(block) }];
          }
          push({ type: "comma", value });
          block.commas++;
          continue;
        }
        if (value === CHAR_DOT && depth > 0 && block.commas === 0) {
          const siblings = block.nodes;
          if (depth === 0 || siblings.length === 0) {
            push({ type: "text", value });
            continue;
          }
          if (prev.type === "dot") {
            block.range = [];
            prev.value += value;
            prev.type = "range";
            if (block.nodes.length !== 3 && block.nodes.length !== 5) {
              block.invalid = true;
              block.ranges = 0;
              prev.type = "text";
              continue;
            }
            block.ranges++;
            block.args = [];
            continue;
          }
          if (prev.type === "range") {
            siblings.pop();
            const before = siblings[siblings.length - 1];
            before.value += prev.value + value;
            prev = before;
            block.ranges--;
            continue;
          }
          push({ type: "dot", value });
          continue;
        }
        push({ type: "text", value });
      }
      do {
        block = stack.pop();
        if (block.type !== "root") {
          block.nodes.forEach((node) => {
            if (!node.nodes) {
              if (node.type === "open") node.isOpen = true;
              if (node.type === "close") node.isClose = true;
              if (!node.nodes) node.type = "text";
              node.invalid = true;
            }
          });
          const parent = stack[stack.length - 1];
          const index2 = parent.nodes.indexOf(block);
          parent.nodes.splice(index2, 1, ...block.nodes);
        }
      } while (stack.length > 0);
      push({ type: "eos" });
      return ast;
    };
    module2.exports = parse;
  }
});

// node_modules/braces/index.js
var require_braces = __commonJS({
  "node_modules/braces/index.js"(exports2, module2) {
    "use strict";
    var stringify = require_stringify();
    var compile = require_compile();
    var expand = require_expand();
    var parse = require_parse();
    var braces = (input, options = {}) => {
      let output = [];
      if (Array.isArray(input)) {
        for (const pattern of input) {
          const result = braces.create(pattern, options);
          if (Array.isArray(result)) {
            output.push(...result);
          } else {
            output.push(result);
          }
        }
      } else {
        output = [].concat(braces.create(input, options));
      }
      if (options && options.expand === true && options.nodupes === true) {
        output = [...new Set(output)];
      }
      return output;
    };
    braces.parse = (input, options = {}) => parse(input, options);
    braces.stringify = (input, options = {}) => {
      if (typeof input === "string") {
        return stringify(braces.parse(input, options), options);
      }
      return stringify(input, options);
    };
    braces.compile = (input, options = {}) => {
      if (typeof input === "string") {
        input = braces.parse(input, options);
      }
      return compile(input, options);
    };
    braces.expand = (input, options = {}) => {
      if (typeof input === "string") {
        input = braces.parse(input, options);
      }
      let result = expand(input, options);
      if (options.noempty === true) {
        result = result.filter(Boolean);
      }
      if (options.nodupes === true) {
        result = [...new Set(result)];
      }
      return result;
    };
    braces.create = (input, options = {}) => {
      if (input === "" || input.length < 3) {
        return [input];
      }
      return options.expand !== true ? braces.compile(input, options) : braces.expand(input, options);
    };
    module2.exports = braces;
  }
});

// node_modules/micromatch/node_modules/picomatch/lib/constants.js
var require_constants2 = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/lib/constants.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    var WIN_SLASH = "\\\\/";
    var WIN_NO_SLASH = `[^${WIN_SLASH}]`;
    var DOT_LITERAL = "\\.";
    var PLUS_LITERAL = "\\+";
    var QMARK_LITERAL = "\\?";
    var SLASH_LITERAL = "\\/";
    var ONE_CHAR = "(?=.)";
    var QMARK = "[^/]";
    var END_ANCHOR = `(?:${SLASH_LITERAL}|$)`;
    var START_ANCHOR = `(?:^|${SLASH_LITERAL})`;
    var DOTS_SLASH = `${DOT_LITERAL}{1,2}${END_ANCHOR}`;
    var NO_DOT = `(?!${DOT_LITERAL})`;
    var NO_DOTS = `(?!${START_ANCHOR}${DOTS_SLASH})`;
    var NO_DOT_SLASH = `(?!${DOT_LITERAL}{0,1}${END_ANCHOR})`;
    var NO_DOTS_SLASH = `(?!${DOTS_SLASH})`;
    var QMARK_NO_DOT = `[^.${SLASH_LITERAL}]`;
    var STAR = `${QMARK}*?`;
    var POSIX_CHARS = {
      DOT_LITERAL,
      PLUS_LITERAL,
      QMARK_LITERAL,
      SLASH_LITERAL,
      ONE_CHAR,
      QMARK,
      END_ANCHOR,
      DOTS_SLASH,
      NO_DOT,
      NO_DOTS,
      NO_DOT_SLASH,
      NO_DOTS_SLASH,
      QMARK_NO_DOT,
      STAR,
      START_ANCHOR
    };
    var WINDOWS_CHARS = {
      ...POSIX_CHARS,
      SLASH_LITERAL: `[${WIN_SLASH}]`,
      QMARK: WIN_NO_SLASH,
      STAR: `${WIN_NO_SLASH}*?`,
      DOTS_SLASH: `${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$)`,
      NO_DOT: `(?!${DOT_LITERAL})`,
      NO_DOTS: `(?!(?:^|[${WIN_SLASH}])${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      NO_DOT_SLASH: `(?!${DOT_LITERAL}{0,1}(?:[${WIN_SLASH}]|$))`,
      NO_DOTS_SLASH: `(?!${DOT_LITERAL}{1,2}(?:[${WIN_SLASH}]|$))`,
      QMARK_NO_DOT: `[^.${WIN_SLASH}]`,
      START_ANCHOR: `(?:^|[${WIN_SLASH}])`,
      END_ANCHOR: `(?:[${WIN_SLASH}]|$)`
    };
    var POSIX_REGEX_SOURCE = {
      alnum: "a-zA-Z0-9",
      alpha: "a-zA-Z",
      ascii: "\\x00-\\x7F",
      blank: " \\t",
      cntrl: "\\x00-\\x1F\\x7F",
      digit: "0-9",
      graph: "\\x21-\\x7E",
      lower: "a-z",
      print: "\\x20-\\x7E ",
      punct: "\\-!\"#$%&'()\\*+,./:;<=>?@[\\]^_`{|}~",
      space: " \\t\\r\\n\\v\\f",
      upper: "A-Z",
      word: "A-Za-z0-9_",
      xdigit: "A-Fa-f0-9"
    };
    module2.exports = {
      MAX_LENGTH: 1024 * 64,
      POSIX_REGEX_SOURCE,
      // regular expressions
      REGEX_BACKSLASH: /\\(?![*+?^${}(|)[\]])/g,
      REGEX_NON_SPECIAL_CHARS: /^[^@![\].,$*+?^{}()|\\/]+/,
      REGEX_SPECIAL_CHARS: /[-*+?.^${}(|)[\]]/,
      REGEX_SPECIAL_CHARS_BACKREF: /(\\?)((\W)(\3*))/g,
      REGEX_SPECIAL_CHARS_GLOBAL: /([-*+?.^${}(|)[\]])/g,
      REGEX_REMOVE_BACKSLASH: /(?:\[.*?[^\\]\]|\\(?=.))/g,
      // Replace globs with equivalent patterns to reduce parsing time.
      REPLACEMENTS: {
        "***": "*",
        "**/**": "**",
        "**/**/**": "**"
      },
      // Digits
      CHAR_0: 48,
      /* 0 */
      CHAR_9: 57,
      /* 9 */
      // Alphabet chars.
      CHAR_UPPERCASE_A: 65,
      /* A */
      CHAR_LOWERCASE_A: 97,
      /* a */
      CHAR_UPPERCASE_Z: 90,
      /* Z */
      CHAR_LOWERCASE_Z: 122,
      /* z */
      CHAR_LEFT_PARENTHESES: 40,
      /* ( */
      CHAR_RIGHT_PARENTHESES: 41,
      /* ) */
      CHAR_ASTERISK: 42,
      /* * */
      // Non-alphabetic chars.
      CHAR_AMPERSAND: 38,
      /* & */
      CHAR_AT: 64,
      /* @ */
      CHAR_BACKWARD_SLASH: 92,
      /* \ */
      CHAR_CARRIAGE_RETURN: 13,
      /* \r */
      CHAR_CIRCUMFLEX_ACCENT: 94,
      /* ^ */
      CHAR_COLON: 58,
      /* : */
      CHAR_COMMA: 44,
      /* , */
      CHAR_DOT: 46,
      /* . */
      CHAR_DOUBLE_QUOTE: 34,
      /* " */
      CHAR_EQUAL: 61,
      /* = */
      CHAR_EXCLAMATION_MARK: 33,
      /* ! */
      CHAR_FORM_FEED: 12,
      /* \f */
      CHAR_FORWARD_SLASH: 47,
      /* / */
      CHAR_GRAVE_ACCENT: 96,
      /* ` */
      CHAR_HASH: 35,
      /* # */
      CHAR_HYPHEN_MINUS: 45,
      /* - */
      CHAR_LEFT_ANGLE_BRACKET: 60,
      /* < */
      CHAR_LEFT_CURLY_BRACE: 123,
      /* { */
      CHAR_LEFT_SQUARE_BRACKET: 91,
      /* [ */
      CHAR_LINE_FEED: 10,
      /* \n */
      CHAR_NO_BREAK_SPACE: 160,
      /* \u00A0 */
      CHAR_PERCENT: 37,
      /* % */
      CHAR_PLUS: 43,
      /* + */
      CHAR_QUESTION_MARK: 63,
      /* ? */
      CHAR_RIGHT_ANGLE_BRACKET: 62,
      /* > */
      CHAR_RIGHT_CURLY_BRACE: 125,
      /* } */
      CHAR_RIGHT_SQUARE_BRACKET: 93,
      /* ] */
      CHAR_SEMICOLON: 59,
      /* ; */
      CHAR_SINGLE_QUOTE: 39,
      /* ' */
      CHAR_SPACE: 32,
      /*   */
      CHAR_TAB: 9,
      /* \t */
      CHAR_UNDERSCORE: 95,
      /* _ */
      CHAR_VERTICAL_LINE: 124,
      /* | */
      CHAR_ZERO_WIDTH_NOBREAK_SPACE: 65279,
      /* \uFEFF */
      SEP: path2.sep,
      /**
       * Create EXTGLOB_CHARS
       */
      extglobChars(chars) {
        return {
          "!": { type: "negate", open: "(?:(?!(?:", close: `))${chars.STAR})` },
          "?": { type: "qmark", open: "(?:", close: ")?" },
          "+": { type: "plus", open: "(?:", close: ")+" },
          "*": { type: "star", open: "(?:", close: ")*" },
          "@": { type: "at", open: "(?:", close: ")" }
        };
      },
      /**
       * Create GLOB_CHARS
       */
      globChars(win32) {
        return win32 === true ? WINDOWS_CHARS : POSIX_CHARS;
      }
    };
  }
});

// node_modules/micromatch/node_modules/picomatch/lib/utils.js
var require_utils2 = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/lib/utils.js"(exports2) {
    "use strict";
    var path2 = require("path");
    var win32 = process.platform === "win32";
    var {
      REGEX_BACKSLASH,
      REGEX_REMOVE_BACKSLASH,
      REGEX_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_GLOBAL
    } = require_constants2();
    exports2.isObject = (val) => val !== null && typeof val === "object" && !Array.isArray(val);
    exports2.hasRegexChars = (str) => REGEX_SPECIAL_CHARS.test(str);
    exports2.isRegexChar = (str) => str.length === 1 && exports2.hasRegexChars(str);
    exports2.escapeRegex = (str) => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, "\\$1");
    exports2.toPosixSlashes = (str) => str.replace(REGEX_BACKSLASH, "/");
    exports2.removeBackslashes = (str) => {
      return str.replace(REGEX_REMOVE_BACKSLASH, (match) => {
        return match === "\\" ? "" : match;
      });
    };
    exports2.supportsLookbehinds = () => {
      const segs = process.version.slice(1).split(".").map(Number);
      if (segs.length === 3 && segs[0] >= 9 || segs[0] === 8 && segs[1] >= 10) {
        return true;
      }
      return false;
    };
    exports2.isWindows = (options) => {
      if (options && typeof options.windows === "boolean") {
        return options.windows;
      }
      return win32 === true || path2.sep === "\\";
    };
    exports2.escapeLast = (input, char, lastIdx) => {
      const idx = input.lastIndexOf(char, lastIdx);
      if (idx === -1) return input;
      if (input[idx - 1] === "\\") return exports2.escapeLast(input, char, idx - 1);
      return `${input.slice(0, idx)}\\${input.slice(idx)}`;
    };
    exports2.removePrefix = (input, state = {}) => {
      let output = input;
      if (output.startsWith("./")) {
        output = output.slice(2);
        state.prefix = "./";
      }
      return output;
    };
    exports2.wrapOutput = (input, state = {}, options = {}) => {
      const prepend = options.contains ? "" : "^";
      const append = options.contains ? "" : "$";
      let output = `${prepend}(?:${input})${append}`;
      if (state.negated === true) {
        output = `(?:^(?!${output}).*$)`;
      }
      return output;
    };
  }
});

// node_modules/micromatch/node_modules/picomatch/lib/scan.js
var require_scan = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/lib/scan.js"(exports2, module2) {
    "use strict";
    var utils = require_utils2();
    var {
      CHAR_ASTERISK,
      /* * */
      CHAR_AT,
      /* @ */
      CHAR_BACKWARD_SLASH,
      /* \ */
      CHAR_COMMA,
      /* , */
      CHAR_DOT,
      /* . */
      CHAR_EXCLAMATION_MARK,
      /* ! */
      CHAR_FORWARD_SLASH,
      /* / */
      CHAR_LEFT_CURLY_BRACE,
      /* { */
      CHAR_LEFT_PARENTHESES,
      /* ( */
      CHAR_LEFT_SQUARE_BRACKET,
      /* [ */
      CHAR_PLUS,
      /* + */
      CHAR_QUESTION_MARK,
      /* ? */
      CHAR_RIGHT_CURLY_BRACE,
      /* } */
      CHAR_RIGHT_PARENTHESES,
      /* ) */
      CHAR_RIGHT_SQUARE_BRACKET
      /* ] */
    } = require_constants2();
    var isPathSeparator = (code) => {
      return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
    };
    var depth = (token) => {
      if (token.isPrefix !== true) {
        token.depth = token.isGlobstar ? Infinity : 1;
      }
    };
    var scan = (input, options) => {
      const opts = options || {};
      const length = input.length - 1;
      const scanToEnd = opts.parts === true || opts.scanToEnd === true;
      const slashes = [];
      const tokens = [];
      const parts = [];
      let str = input;
      let index = -1;
      let start = 0;
      let lastIndex = 0;
      let isBrace = false;
      let isBracket = false;
      let isGlob = false;
      let isExtglob = false;
      let isGlobstar = false;
      let braceEscaped = false;
      let backslashes = false;
      let negated = false;
      let negatedExtglob = false;
      let finished = false;
      let braces = 0;
      let prev;
      let code;
      let token = { value: "", depth: 0, isGlob: false };
      const eos = () => index >= length;
      const peek = () => str.charCodeAt(index + 1);
      const advance = () => {
        prev = code;
        return str.charCodeAt(++index);
      };
      while (index < length) {
        code = advance();
        let next;
        if (code === CHAR_BACKWARD_SLASH) {
          backslashes = token.backslashes = true;
          code = advance();
          if (code === CHAR_LEFT_CURLY_BRACE) {
            braceEscaped = true;
          }
          continue;
        }
        if (braceEscaped === true || code === CHAR_LEFT_CURLY_BRACE) {
          braces++;
          while (eos() !== true && (code = advance())) {
            if (code === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (code === CHAR_LEFT_CURLY_BRACE) {
              braces++;
              continue;
            }
            if (braceEscaped !== true && code === CHAR_DOT && (code = advance()) === CHAR_DOT) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (braceEscaped !== true && code === CHAR_COMMA) {
              isBrace = token.isBrace = true;
              isGlob = token.isGlob = true;
              finished = true;
              if (scanToEnd === true) {
                continue;
              }
              break;
            }
            if (code === CHAR_RIGHT_CURLY_BRACE) {
              braces--;
              if (braces === 0) {
                braceEscaped = false;
                isBrace = token.isBrace = true;
                finished = true;
                break;
              }
            }
          }
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_FORWARD_SLASH) {
          slashes.push(index);
          tokens.push(token);
          token = { value: "", depth: 0, isGlob: false };
          if (finished === true) continue;
          if (prev === CHAR_DOT && index === start + 1) {
            start += 2;
            continue;
          }
          lastIndex = index + 1;
          continue;
        }
        if (opts.noext !== true) {
          const isExtglobChar = code === CHAR_PLUS || code === CHAR_AT || code === CHAR_ASTERISK || code === CHAR_QUESTION_MARK || code === CHAR_EXCLAMATION_MARK;
          if (isExtglobChar === true && peek() === CHAR_LEFT_PARENTHESES) {
            isGlob = token.isGlob = true;
            isExtglob = token.isExtglob = true;
            finished = true;
            if (code === CHAR_EXCLAMATION_MARK && index === start) {
              negatedExtglob = true;
            }
            if (scanToEnd === true) {
              while (eos() !== true && (code = advance())) {
                if (code === CHAR_BACKWARD_SLASH) {
                  backslashes = token.backslashes = true;
                  code = advance();
                  continue;
                }
                if (code === CHAR_RIGHT_PARENTHESES) {
                  isGlob = token.isGlob = true;
                  finished = true;
                  break;
                }
              }
              continue;
            }
            break;
          }
        }
        if (code === CHAR_ASTERISK) {
          if (prev === CHAR_ASTERISK) isGlobstar = token.isGlobstar = true;
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_QUESTION_MARK) {
          isGlob = token.isGlob = true;
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (code === CHAR_LEFT_SQUARE_BRACKET) {
          while (eos() !== true && (next = advance())) {
            if (next === CHAR_BACKWARD_SLASH) {
              backslashes = token.backslashes = true;
              advance();
              continue;
            }
            if (next === CHAR_RIGHT_SQUARE_BRACKET) {
              isBracket = token.isBracket = true;
              isGlob = token.isGlob = true;
              finished = true;
              break;
            }
          }
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
        if (opts.nonegate !== true && code === CHAR_EXCLAMATION_MARK && index === start) {
          negated = token.negated = true;
          start++;
          continue;
        }
        if (opts.noparen !== true && code === CHAR_LEFT_PARENTHESES) {
          isGlob = token.isGlob = true;
          if (scanToEnd === true) {
            while (eos() !== true && (code = advance())) {
              if (code === CHAR_LEFT_PARENTHESES) {
                backslashes = token.backslashes = true;
                code = advance();
                continue;
              }
              if (code === CHAR_RIGHT_PARENTHESES) {
                finished = true;
                break;
              }
            }
            continue;
          }
          break;
        }
        if (isGlob === true) {
          finished = true;
          if (scanToEnd === true) {
            continue;
          }
          break;
        }
      }
      if (opts.noext === true) {
        isExtglob = false;
        isGlob = false;
      }
      let base = str;
      let prefix = "";
      let glob = "";
      if (start > 0) {
        prefix = str.slice(0, start);
        str = str.slice(start);
        lastIndex -= start;
      }
      if (base && isGlob === true && lastIndex > 0) {
        base = str.slice(0, lastIndex);
        glob = str.slice(lastIndex);
      } else if (isGlob === true) {
        base = "";
        glob = str;
      } else {
        base = str;
      }
      if (base && base !== "" && base !== "/" && base !== str) {
        if (isPathSeparator(base.charCodeAt(base.length - 1))) {
          base = base.slice(0, -1);
        }
      }
      if (opts.unescape === true) {
        if (glob) glob = utils.removeBackslashes(glob);
        if (base && backslashes === true) {
          base = utils.removeBackslashes(base);
        }
      }
      const state = {
        prefix,
        input,
        start,
        base,
        glob,
        isBrace,
        isBracket,
        isGlob,
        isExtglob,
        isGlobstar,
        negated,
        negatedExtglob
      };
      if (opts.tokens === true) {
        state.maxDepth = 0;
        if (!isPathSeparator(code)) {
          tokens.push(token);
        }
        state.tokens = tokens;
      }
      if (opts.parts === true || opts.tokens === true) {
        let prevIndex;
        for (let idx = 0; idx < slashes.length; idx++) {
          const n = prevIndex ? prevIndex + 1 : start;
          const i = slashes[idx];
          const value = input.slice(n, i);
          if (opts.tokens) {
            if (idx === 0 && start !== 0) {
              tokens[idx].isPrefix = true;
              tokens[idx].value = prefix;
            } else {
              tokens[idx].value = value;
            }
            depth(tokens[idx]);
            state.maxDepth += tokens[idx].depth;
          }
          if (idx !== 0 || value !== "") {
            parts.push(value);
          }
          prevIndex = i;
        }
        if (prevIndex && prevIndex + 1 < input.length) {
          const value = input.slice(prevIndex + 1);
          parts.push(value);
          if (opts.tokens) {
            tokens[tokens.length - 1].value = value;
            depth(tokens[tokens.length - 1]);
            state.maxDepth += tokens[tokens.length - 1].depth;
          }
        }
        state.slashes = slashes;
        state.parts = parts;
      }
      return state;
    };
    module2.exports = scan;
  }
});

// node_modules/micromatch/node_modules/picomatch/lib/parse.js
var require_parse2 = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/lib/parse.js"(exports2, module2) {
    "use strict";
    var constants = require_constants2();
    var utils = require_utils2();
    var {
      MAX_LENGTH,
      POSIX_REGEX_SOURCE,
      REGEX_NON_SPECIAL_CHARS,
      REGEX_SPECIAL_CHARS_BACKREF,
      REPLACEMENTS
    } = constants;
    var expandRange = (args, options) => {
      if (typeof options.expandRange === "function") {
        return options.expandRange(...args, options);
      }
      args.sort();
      const value = `[${args.join("-")}]`;
      try {
        new RegExp(value);
      } catch (ex) {
        return args.map((v) => utils.escapeRegex(v)).join("..");
      }
      return value;
    };
    var syntaxError = (type, char) => {
      return `Missing ${type}: "${char}" - use "\\\\${char}" to match literal characters`;
    };
    var parse = (input, options) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected a string");
      }
      input = REPLACEMENTS[input] || input;
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      let len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      const bos = { type: "bos", value: "", output: opts.prepend || "" };
      const tokens = [bos];
      const capture = opts.capture ? "" : "?:";
      const win32 = utils.isWindows(options);
      const PLATFORM_CHARS = constants.globChars(win32);
      const EXTGLOB_CHARS = constants.extglobChars(PLATFORM_CHARS);
      const {
        DOT_LITERAL,
        PLUS_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOT_SLASH,
        NO_DOTS_SLASH,
        QMARK,
        QMARK_NO_DOT,
        STAR,
        START_ANCHOR
      } = PLATFORM_CHARS;
      const globstar = (opts2) => {
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      };
      const nodot = opts.dot ? "" : NO_DOT;
      const qmarkNoDot = opts.dot ? QMARK : QMARK_NO_DOT;
      let star = opts.bash === true ? globstar(opts) : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      if (typeof opts.noext === "boolean") {
        opts.noextglob = opts.noext;
      }
      const state = {
        input,
        index: -1,
        start: 0,
        dot: opts.dot === true,
        consumed: "",
        output: "",
        prefix: "",
        backtrack: false,
        negated: false,
        brackets: 0,
        braces: 0,
        parens: 0,
        quotes: 0,
        globstar: false,
        tokens
      };
      input = utils.removePrefix(input, state);
      len = input.length;
      const extglobs = [];
      const braces = [];
      const stack = [];
      let prev = bos;
      let value;
      const eos = () => state.index === len - 1;
      const peek = state.peek = (n = 1) => input[state.index + n];
      const advance = state.advance = () => input[++state.index] || "";
      const remaining = () => input.slice(state.index + 1);
      const consume = (value2 = "", num = 0) => {
        state.consumed += value2;
        state.index += num;
      };
      const append = (token) => {
        state.output += token.output != null ? token.output : token.value;
        consume(token.value);
      };
      const negate = () => {
        let count = 1;
        while (peek() === "!" && (peek(2) !== "(" || peek(3) === "?")) {
          advance();
          state.start++;
          count++;
        }
        if (count % 2 === 0) {
          return false;
        }
        state.negated = true;
        state.start++;
        return true;
      };
      const increment = (type) => {
        state[type]++;
        stack.push(type);
      };
      const decrement = (type) => {
        state[type]--;
        stack.pop();
      };
      const push = (tok) => {
        if (prev.type === "globstar") {
          const isBrace = state.braces > 0 && (tok.type === "comma" || tok.type === "brace");
          const isExtglob = tok.extglob === true || extglobs.length && (tok.type === "pipe" || tok.type === "paren");
          if (tok.type !== "slash" && tok.type !== "paren" && !isBrace && !isExtglob) {
            state.output = state.output.slice(0, -prev.output.length);
            prev.type = "star";
            prev.value = "*";
            prev.output = star;
            state.output += prev.output;
          }
        }
        if (extglobs.length && tok.type !== "paren") {
          extglobs[extglobs.length - 1].inner += tok.value;
        }
        if (tok.value || tok.output) append(tok);
        if (prev && prev.type === "text" && tok.type === "text") {
          prev.value += tok.value;
          prev.output = (prev.output || "") + tok.value;
          return;
        }
        tok.prev = prev;
        tokens.push(tok);
        prev = tok;
      };
      const extglobOpen = (type, value2) => {
        const token = { ...EXTGLOB_CHARS[value2], conditions: 1, inner: "" };
        token.prev = prev;
        token.parens = state.parens;
        token.output = state.output;
        const output = (opts.capture ? "(" : "") + token.open;
        increment("parens");
        push({ type, value: value2, output: state.output ? "" : ONE_CHAR });
        push({ type: "paren", extglob: true, value: advance(), output });
        extglobs.push(token);
      };
      const extglobClose = (token) => {
        let output = token.close + (opts.capture ? ")" : "");
        let rest;
        if (token.type === "negate") {
          let extglobStar = star;
          if (token.inner && token.inner.length > 1 && token.inner.includes("/")) {
            extglobStar = globstar(opts);
          }
          if (extglobStar !== star || eos() || /^\)+$/.test(remaining())) {
            output = token.close = `)$))${extglobStar}`;
          }
          if (token.inner.includes("*") && (rest = remaining()) && /^\.[^\\/.]+$/.test(rest)) {
            const expression = parse(rest, { ...options, fastpaths: false }).output;
            output = token.close = `)${expression})${extglobStar})`;
          }
          if (token.prev.type === "bos") {
            state.negatedExtglob = true;
          }
        }
        push({ type: "paren", extglob: true, value, output });
        decrement("parens");
      };
      if (opts.fastpaths !== false && !/(^[*!]|[/()[\]{}"])/.test(input)) {
        let backslashes = false;
        let output = input.replace(REGEX_SPECIAL_CHARS_BACKREF, (m, esc, chars, first, rest, index) => {
          if (first === "\\") {
            backslashes = true;
            return m;
          }
          if (first === "?") {
            if (esc) {
              return esc + first + (rest ? QMARK.repeat(rest.length) : "");
            }
            if (index === 0) {
              return qmarkNoDot + (rest ? QMARK.repeat(rest.length) : "");
            }
            return QMARK.repeat(chars.length);
          }
          if (first === ".") {
            return DOT_LITERAL.repeat(chars.length);
          }
          if (first === "*") {
            if (esc) {
              return esc + first + (rest ? star : "");
            }
            return star;
          }
          return esc ? m : `\\${m}`;
        });
        if (backslashes === true) {
          if (opts.unescape === true) {
            output = output.replace(/\\/g, "");
          } else {
            output = output.replace(/\\+/g, (m) => {
              return m.length % 2 === 0 ? "\\\\" : m ? "\\" : "";
            });
          }
        }
        if (output === input && opts.contains === true) {
          state.output = input;
          return state;
        }
        state.output = utils.wrapOutput(output, state, options);
        return state;
      }
      while (!eos()) {
        value = advance();
        if (value === "\0") {
          continue;
        }
        if (value === "\\") {
          const next = peek();
          if (next === "/" && opts.bash !== true) {
            continue;
          }
          if (next === "." || next === ";") {
            continue;
          }
          if (!next) {
            value += "\\";
            push({ type: "text", value });
            continue;
          }
          const match = /^\\+/.exec(remaining());
          let slashes = 0;
          if (match && match[0].length > 2) {
            slashes = match[0].length;
            state.index += slashes;
            if (slashes % 2 !== 0) {
              value += "\\";
            }
          }
          if (opts.unescape === true) {
            value = advance();
          } else {
            value += advance();
          }
          if (state.brackets === 0) {
            push({ type: "text", value });
            continue;
          }
        }
        if (state.brackets > 0 && (value !== "]" || prev.value === "[" || prev.value === "[^")) {
          if (opts.posix !== false && value === ":") {
            const inner = prev.value.slice(1);
            if (inner.includes("[")) {
              prev.posix = true;
              if (inner.includes(":")) {
                const idx = prev.value.lastIndexOf("[");
                const pre = prev.value.slice(0, idx);
                const rest2 = prev.value.slice(idx + 2);
                const posix = POSIX_REGEX_SOURCE[rest2];
                if (posix) {
                  prev.value = pre + posix;
                  state.backtrack = true;
                  advance();
                  if (!bos.output && tokens.indexOf(prev) === 1) {
                    bos.output = ONE_CHAR;
                  }
                  continue;
                }
              }
            }
          }
          if (value === "[" && peek() !== ":" || value === "-" && peek() === "]") {
            value = `\\${value}`;
          }
          if (value === "]" && (prev.value === "[" || prev.value === "[^")) {
            value = `\\${value}`;
          }
          if (opts.posix === true && value === "!" && prev.value === "[") {
            value = "^";
          }
          prev.value += value;
          append({ value });
          continue;
        }
        if (state.quotes === 1 && value !== '"') {
          value = utils.escapeRegex(value);
          prev.value += value;
          append({ value });
          continue;
        }
        if (value === '"') {
          state.quotes = state.quotes === 1 ? 0 : 1;
          if (opts.keepQuotes === true) {
            push({ type: "text", value });
          }
          continue;
        }
        if (value === "(") {
          increment("parens");
          push({ type: "paren", value });
          continue;
        }
        if (value === ")") {
          if (state.parens === 0 && opts.strictBrackets === true) {
            throw new SyntaxError(syntaxError("opening", "("));
          }
          const extglob = extglobs[extglobs.length - 1];
          if (extglob && state.parens === extglob.parens + 1) {
            extglobClose(extglobs.pop());
            continue;
          }
          push({ type: "paren", value, output: state.parens ? ")" : "\\)" });
          decrement("parens");
          continue;
        }
        if (value === "[") {
          if (opts.nobracket === true || !remaining().includes("]")) {
            if (opts.nobracket !== true && opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("closing", "]"));
            }
            value = `\\${value}`;
          } else {
            increment("brackets");
          }
          push({ type: "bracket", value });
          continue;
        }
        if (value === "]") {
          if (opts.nobracket === true || prev && prev.type === "bracket" && prev.value.length === 1) {
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          if (state.brackets === 0) {
            if (opts.strictBrackets === true) {
              throw new SyntaxError(syntaxError("opening", "["));
            }
            push({ type: "text", value, output: `\\${value}` });
            continue;
          }
          decrement("brackets");
          const prevValue = prev.value.slice(1);
          if (prev.posix !== true && prevValue[0] === "^" && !prevValue.includes("/")) {
            value = `/${value}`;
          }
          prev.value += value;
          append({ value });
          if (opts.literalBrackets === false || utils.hasRegexChars(prevValue)) {
            continue;
          }
          const escaped = utils.escapeRegex(prev.value);
          state.output = state.output.slice(0, -prev.value.length);
          if (opts.literalBrackets === true) {
            state.output += escaped;
            prev.value = escaped;
            continue;
          }
          prev.value = `(${capture}${escaped}|${prev.value})`;
          state.output += prev.value;
          continue;
        }
        if (value === "{" && opts.nobrace !== true) {
          increment("braces");
          const open = {
            type: "brace",
            value,
            output: "(",
            outputIndex: state.output.length,
            tokensIndex: state.tokens.length
          };
          braces.push(open);
          push(open);
          continue;
        }
        if (value === "}") {
          const brace = braces[braces.length - 1];
          if (opts.nobrace === true || !brace) {
            push({ type: "text", value, output: value });
            continue;
          }
          let output = ")";
          if (brace.dots === true) {
            const arr = tokens.slice();
            const range = [];
            for (let i = arr.length - 1; i >= 0; i--) {
              tokens.pop();
              if (arr[i].type === "brace") {
                break;
              }
              if (arr[i].type !== "dots") {
                range.unshift(arr[i].value);
              }
            }
            output = expandRange(range, opts);
            state.backtrack = true;
          }
          if (brace.comma !== true && brace.dots !== true) {
            const out = state.output.slice(0, brace.outputIndex);
            const toks = state.tokens.slice(brace.tokensIndex);
            brace.value = brace.output = "\\{";
            value = output = "\\}";
            state.output = out;
            for (const t of toks) {
              state.output += t.output || t.value;
            }
          }
          push({ type: "brace", value, output });
          decrement("braces");
          braces.pop();
          continue;
        }
        if (value === "|") {
          if (extglobs.length > 0) {
            extglobs[extglobs.length - 1].conditions++;
          }
          push({ type: "text", value });
          continue;
        }
        if (value === ",") {
          let output = value;
          const brace = braces[braces.length - 1];
          if (brace && stack[stack.length - 1] === "braces") {
            brace.comma = true;
            output = "|";
          }
          push({ type: "comma", value, output });
          continue;
        }
        if (value === "/") {
          if (prev.type === "dot" && state.index === state.start + 1) {
            state.start = state.index + 1;
            state.consumed = "";
            state.output = "";
            tokens.pop();
            prev = bos;
            continue;
          }
          push({ type: "slash", value, output: SLASH_LITERAL });
          continue;
        }
        if (value === ".") {
          if (state.braces > 0 && prev.type === "dot") {
            if (prev.value === ".") prev.output = DOT_LITERAL;
            const brace = braces[braces.length - 1];
            prev.type = "dots";
            prev.output += value;
            prev.value += value;
            brace.dots = true;
            continue;
          }
          if (state.braces + state.parens === 0 && prev.type !== "bos" && prev.type !== "slash") {
            push({ type: "text", value, output: DOT_LITERAL });
            continue;
          }
          push({ type: "dot", value, output: DOT_LITERAL });
          continue;
        }
        if (value === "?") {
          const isGroup = prev && prev.value === "(";
          if (!isGroup && opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("qmark", value);
            continue;
          }
          if (prev && prev.type === "paren") {
            const next = peek();
            let output = value;
            if (next === "<" && !utils.supportsLookbehinds()) {
              throw new Error("Node.js v10 or higher is required for regex lookbehinds");
            }
            if (prev.value === "(" && !/[!=<:]/.test(next) || next === "<" && !/<([!=]|\w+>)/.test(remaining())) {
              output = `\\${value}`;
            }
            push({ type: "text", value, output });
            continue;
          }
          if (opts.dot !== true && (prev.type === "slash" || prev.type === "bos")) {
            push({ type: "qmark", value, output: QMARK_NO_DOT });
            continue;
          }
          push({ type: "qmark", value, output: QMARK });
          continue;
        }
        if (value === "!") {
          if (opts.noextglob !== true && peek() === "(") {
            if (peek(2) !== "?" || !/[!=<:]/.test(peek(3))) {
              extglobOpen("negate", value);
              continue;
            }
          }
          if (opts.nonegate !== true && state.index === 0) {
            negate();
            continue;
          }
        }
        if (value === "+") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            extglobOpen("plus", value);
            continue;
          }
          if (prev && prev.value === "(" || opts.regex === false) {
            push({ type: "plus", value, output: PLUS_LITERAL });
            continue;
          }
          if (prev && (prev.type === "bracket" || prev.type === "paren" || prev.type === "brace") || state.parens > 0) {
            push({ type: "plus", value });
            continue;
          }
          push({ type: "plus", value: PLUS_LITERAL });
          continue;
        }
        if (value === "@") {
          if (opts.noextglob !== true && peek() === "(" && peek(2) !== "?") {
            push({ type: "at", extglob: true, value, output: "" });
            continue;
          }
          push({ type: "text", value });
          continue;
        }
        if (value !== "*") {
          if (value === "$" || value === "^") {
            value = `\\${value}`;
          }
          const match = REGEX_NON_SPECIAL_CHARS.exec(remaining());
          if (match) {
            value += match[0];
            state.index += match[0].length;
          }
          push({ type: "text", value });
          continue;
        }
        if (prev && (prev.type === "globstar" || prev.star === true)) {
          prev.type = "star";
          prev.star = true;
          prev.value += value;
          prev.output = star;
          state.backtrack = true;
          state.globstar = true;
          consume(value);
          continue;
        }
        let rest = remaining();
        if (opts.noextglob !== true && /^\([^?]/.test(rest)) {
          extglobOpen("star", value);
          continue;
        }
        if (prev.type === "star") {
          if (opts.noglobstar === true) {
            consume(value);
            continue;
          }
          const prior = prev.prev;
          const before = prior.prev;
          const isStart = prior.type === "slash" || prior.type === "bos";
          const afterStar = before && (before.type === "star" || before.type === "globstar");
          if (opts.bash === true && (!isStart || rest[0] && rest[0] !== "/")) {
            push({ type: "star", value, output: "" });
            continue;
          }
          const isBrace = state.braces > 0 && (prior.type === "comma" || prior.type === "brace");
          const isExtglob = extglobs.length && (prior.type === "pipe" || prior.type === "paren");
          if (!isStart && prior.type !== "paren" && !isBrace && !isExtglob) {
            push({ type: "star", value, output: "" });
            continue;
          }
          while (rest.slice(0, 3) === "/**") {
            const after = input[state.index + 4];
            if (after && after !== "/") {
              break;
            }
            rest = rest.slice(3);
            consume("/**", 3);
          }
          if (prior.type === "bos" && eos()) {
            prev.type = "globstar";
            prev.value += value;
            prev.output = globstar(opts);
            state.output = prev.output;
            state.globstar = true;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && !afterStar && eos()) {
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = globstar(opts) + (opts.strictSlashes ? ")" : "|$)");
            prev.value += value;
            state.globstar = true;
            state.output += prior.output + prev.output;
            consume(value);
            continue;
          }
          if (prior.type === "slash" && prior.prev.type !== "bos" && rest[0] === "/") {
            const end = rest[1] !== void 0 ? "|$" : "";
            state.output = state.output.slice(0, -(prior.output + prev.output).length);
            prior.output = `(?:${prior.output}`;
            prev.type = "globstar";
            prev.output = `${globstar(opts)}${SLASH_LITERAL}|${SLASH_LITERAL}${end})`;
            prev.value += value;
            state.output += prior.output + prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          if (prior.type === "bos" && rest[0] === "/") {
            prev.type = "globstar";
            prev.value += value;
            prev.output = `(?:^|${SLASH_LITERAL}|${globstar(opts)}${SLASH_LITERAL})`;
            state.output = prev.output;
            state.globstar = true;
            consume(value + advance());
            push({ type: "slash", value: "/", output: "" });
            continue;
          }
          state.output = state.output.slice(0, -prev.output.length);
          prev.type = "globstar";
          prev.output = globstar(opts);
          prev.value += value;
          state.output += prev.output;
          state.globstar = true;
          consume(value);
          continue;
        }
        const token = { type: "star", value, output: star };
        if (opts.bash === true) {
          token.output = ".*?";
          if (prev.type === "bos" || prev.type === "slash") {
            token.output = nodot + token.output;
          }
          push(token);
          continue;
        }
        if (prev && (prev.type === "bracket" || prev.type === "paren") && opts.regex === true) {
          token.output = value;
          push(token);
          continue;
        }
        if (state.index === state.start || prev.type === "slash" || prev.type === "dot") {
          if (prev.type === "dot") {
            state.output += NO_DOT_SLASH;
            prev.output += NO_DOT_SLASH;
          } else if (opts.dot === true) {
            state.output += NO_DOTS_SLASH;
            prev.output += NO_DOTS_SLASH;
          } else {
            state.output += nodot;
            prev.output += nodot;
          }
          if (peek() !== "*") {
            state.output += ONE_CHAR;
            prev.output += ONE_CHAR;
          }
        }
        push(token);
      }
      while (state.brackets > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "]"));
        state.output = utils.escapeLast(state.output, "[");
        decrement("brackets");
      }
      while (state.parens > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", ")"));
        state.output = utils.escapeLast(state.output, "(");
        decrement("parens");
      }
      while (state.braces > 0) {
        if (opts.strictBrackets === true) throw new SyntaxError(syntaxError("closing", "}"));
        state.output = utils.escapeLast(state.output, "{");
        decrement("braces");
      }
      if (opts.strictSlashes !== true && (prev.type === "star" || prev.type === "bracket")) {
        push({ type: "maybe_slash", value: "", output: `${SLASH_LITERAL}?` });
      }
      if (state.backtrack === true) {
        state.output = "";
        for (const token of state.tokens) {
          state.output += token.output != null ? token.output : token.value;
          if (token.suffix) {
            state.output += token.suffix;
          }
        }
      }
      return state;
    };
    parse.fastpaths = (input, options) => {
      const opts = { ...options };
      const max = typeof opts.maxLength === "number" ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
      const len = input.length;
      if (len > max) {
        throw new SyntaxError(`Input length: ${len}, exceeds maximum allowed length: ${max}`);
      }
      input = REPLACEMENTS[input] || input;
      const win32 = utils.isWindows(options);
      const {
        DOT_LITERAL,
        SLASH_LITERAL,
        ONE_CHAR,
        DOTS_SLASH,
        NO_DOT,
        NO_DOTS,
        NO_DOTS_SLASH,
        STAR,
        START_ANCHOR
      } = constants.globChars(win32);
      const nodot = opts.dot ? NO_DOTS : NO_DOT;
      const slashDot = opts.dot ? NO_DOTS_SLASH : NO_DOT;
      const capture = opts.capture ? "" : "?:";
      const state = { negated: false, prefix: "" };
      let star = opts.bash === true ? ".*?" : STAR;
      if (opts.capture) {
        star = `(${star})`;
      }
      const globstar = (opts2) => {
        if (opts2.noglobstar === true) return star;
        return `(${capture}(?:(?!${START_ANCHOR}${opts2.dot ? DOTS_SLASH : DOT_LITERAL}).)*?)`;
      };
      const create = (str) => {
        switch (str) {
          case "*":
            return `${nodot}${ONE_CHAR}${star}`;
          case ".*":
            return `${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*.*":
            return `${nodot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "*/*":
            return `${nodot}${star}${SLASH_LITERAL}${ONE_CHAR}${slashDot}${star}`;
          case "**":
            return nodot + globstar(opts);
          case "**/*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${ONE_CHAR}${star}`;
          case "**/*.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${slashDot}${star}${DOT_LITERAL}${ONE_CHAR}${star}`;
          case "**/.*":
            return `(?:${nodot}${globstar(opts)}${SLASH_LITERAL})?${DOT_LITERAL}${ONE_CHAR}${star}`;
          default: {
            const match = /^(.*?)\.(\w+)$/.exec(str);
            if (!match) return;
            const source2 = create(match[1]);
            if (!source2) return;
            return source2 + DOT_LITERAL + match[2];
          }
        }
      };
      const output = utils.removePrefix(input, state);
      let source = create(output);
      if (source && opts.strictSlashes !== true) {
        source += `${SLASH_LITERAL}?`;
      }
      return source;
    };
    module2.exports = parse;
  }
});

// node_modules/micromatch/node_modules/picomatch/lib/picomatch.js
var require_picomatch = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/lib/picomatch.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    var scan = require_scan();
    var parse = require_parse2();
    var utils = require_utils2();
    var constants = require_constants2();
    var isObject = (val) => val && typeof val === "object" && !Array.isArray(val);
    var picomatch = (glob, options, returnState = false) => {
      if (Array.isArray(glob)) {
        const fns = glob.map((input) => picomatch(input, options, returnState));
        const arrayMatcher = (str) => {
          for (const isMatch of fns) {
            const state2 = isMatch(str);
            if (state2) return state2;
          }
          return false;
        };
        return arrayMatcher;
      }
      const isState = isObject(glob) && glob.tokens && glob.input;
      if (glob === "" || typeof glob !== "string" && !isState) {
        throw new TypeError("Expected pattern to be a non-empty string");
      }
      const opts = options || {};
      const posix = utils.isWindows(options);
      const regex = isState ? picomatch.compileRe(glob, options) : picomatch.makeRe(glob, options, false, true);
      const state = regex.state;
      delete regex.state;
      let isIgnored = () => false;
      if (opts.ignore) {
        const ignoreOpts = { ...options, ignore: null, onMatch: null, onResult: null };
        isIgnored = picomatch(opts.ignore, ignoreOpts, returnState);
      }
      const matcher = (input, returnObject = false) => {
        const { isMatch, match, output } = picomatch.test(input, regex, options, { glob, posix });
        const result = { glob, state, regex, posix, input, output, match, isMatch };
        if (typeof opts.onResult === "function") {
          opts.onResult(result);
        }
        if (isMatch === false) {
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (isIgnored(input)) {
          if (typeof opts.onIgnore === "function") {
            opts.onIgnore(result);
          }
          result.isMatch = false;
          return returnObject ? result : false;
        }
        if (typeof opts.onMatch === "function") {
          opts.onMatch(result);
        }
        return returnObject ? result : true;
      };
      if (returnState) {
        matcher.state = state;
      }
      return matcher;
    };
    picomatch.test = (input, regex, options, { glob, posix } = {}) => {
      if (typeof input !== "string") {
        throw new TypeError("Expected input to be a string");
      }
      if (input === "") {
        return { isMatch: false, output: "" };
      }
      const opts = options || {};
      const format = opts.format || (posix ? utils.toPosixSlashes : null);
      let match = input === glob;
      let output = match && format ? format(input) : input;
      if (match === false) {
        output = format ? format(input) : input;
        match = output === glob;
      }
      if (match === false || opts.capture === true) {
        if (opts.matchBase === true || opts.basename === true) {
          match = picomatch.matchBase(input, regex, options, posix);
        } else {
          match = regex.exec(output);
        }
      }
      return { isMatch: Boolean(match), match, output };
    };
    picomatch.matchBase = (input, glob, options, posix = utils.isWindows(options)) => {
      const regex = glob instanceof RegExp ? glob : picomatch.makeRe(glob, options);
      return regex.test(path2.basename(input));
    };
    picomatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
    picomatch.parse = (pattern, options) => {
      if (Array.isArray(pattern)) return pattern.map((p) => picomatch.parse(p, options));
      return parse(pattern, { ...options, fastpaths: false });
    };
    picomatch.scan = (input, options) => scan(input, options);
    picomatch.compileRe = (state, options, returnOutput = false, returnState = false) => {
      if (returnOutput === true) {
        return state.output;
      }
      const opts = options || {};
      const prepend = opts.contains ? "" : "^";
      const append = opts.contains ? "" : "$";
      let source = `${prepend}(?:${state.output})${append}`;
      if (state && state.negated === true) {
        source = `^(?!${source}).*$`;
      }
      const regex = picomatch.toRegex(source, options);
      if (returnState === true) {
        regex.state = state;
      }
      return regex;
    };
    picomatch.makeRe = (input, options = {}, returnOutput = false, returnState = false) => {
      if (!input || typeof input !== "string") {
        throw new TypeError("Expected a non-empty string");
      }
      let parsed = { negated: false, fastpaths: true };
      if (options.fastpaths !== false && (input[0] === "." || input[0] === "*")) {
        parsed.output = parse.fastpaths(input, options);
      }
      if (!parsed.output) {
        parsed = parse(input, options);
      }
      return picomatch.compileRe(parsed, options, returnOutput, returnState);
    };
    picomatch.toRegex = (source, options) => {
      try {
        const opts = options || {};
        return new RegExp(source, opts.flags || (opts.nocase ? "i" : ""));
      } catch (err) {
        if (options && options.debug === true) throw err;
        return /$^/;
      }
    };
    picomatch.constants = constants;
    module2.exports = picomatch;
  }
});

// node_modules/micromatch/node_modules/picomatch/index.js
var require_picomatch2 = __commonJS({
  "node_modules/micromatch/node_modules/picomatch/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_picomatch();
  }
});

// node_modules/micromatch/index.js
var require_micromatch = __commonJS({
  "node_modules/micromatch/index.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var braces = require_braces();
    var picomatch = require_picomatch2();
    var utils = require_utils2();
    var isEmptyString = (v) => v === "" || v === "./";
    var hasBraces = (v) => {
      const index = v.indexOf("{");
      return index > -1 && v.indexOf("}", index) > -1;
    };
    var micromatch = (list, patterns, options) => {
      patterns = [].concat(patterns);
      list = [].concat(list);
      let omit = /* @__PURE__ */ new Set();
      let keep = /* @__PURE__ */ new Set();
      let items = /* @__PURE__ */ new Set();
      let negatives = 0;
      let onResult = (state) => {
        items.add(state.output);
        if (options && options.onResult) {
          options.onResult(state);
        }
      };
      for (let i = 0; i < patterns.length; i++) {
        let isMatch = picomatch(String(patterns[i]), { ...options, onResult }, true);
        let negated = isMatch.state.negated || isMatch.state.negatedExtglob;
        if (negated) negatives++;
        for (let item of list) {
          let matched = isMatch(item, true);
          let match = negated ? !matched.isMatch : matched.isMatch;
          if (!match) continue;
          if (negated) {
            omit.add(matched.output);
          } else {
            omit.delete(matched.output);
            keep.add(matched.output);
          }
        }
      }
      let result = negatives === patterns.length ? [...items] : [...keep];
      let matches = result.filter((item) => !omit.has(item));
      if (options && matches.length === 0) {
        if (options.failglob === true) {
          throw new Error(`No matches found for "${patterns.join(", ")}"`);
        }
        if (options.nonull === true || options.nullglob === true) {
          return options.unescape ? patterns.map((p) => p.replace(/\\/g, "")) : patterns;
        }
      }
      return matches;
    };
    micromatch.match = micromatch;
    micromatch.matcher = (pattern, options) => picomatch(pattern, options);
    micromatch.isMatch = (str, patterns, options) => picomatch(patterns, options)(str);
    micromatch.any = micromatch.isMatch;
    micromatch.not = (list, patterns, options = {}) => {
      patterns = [].concat(patterns).map(String);
      let result = /* @__PURE__ */ new Set();
      let items = [];
      let onResult = (state) => {
        if (options.onResult) options.onResult(state);
        items.push(state.output);
      };
      let matches = new Set(micromatch(list, patterns, { ...options, onResult }));
      for (let item of items) {
        if (!matches.has(item)) {
          result.add(item);
        }
      }
      return [...result];
    };
    micromatch.contains = (str, pattern, options) => {
      if (typeof str !== "string") {
        throw new TypeError(`Expected a string: "${util.inspect(str)}"`);
      }
      if (Array.isArray(pattern)) {
        return pattern.some((p) => micromatch.contains(str, p, options));
      }
      if (typeof pattern === "string") {
        if (isEmptyString(str) || isEmptyString(pattern)) {
          return false;
        }
        if (str.includes(pattern) || str.startsWith("./") && str.slice(2).includes(pattern)) {
          return true;
        }
      }
      return micromatch.isMatch(str, pattern, { ...options, contains: true });
    };
    micromatch.matchKeys = (obj, patterns, options) => {
      if (!utils.isObject(obj)) {
        throw new TypeError("Expected the first argument to be an object");
      }
      let keys = micromatch(Object.keys(obj), patterns, options);
      let res = {};
      for (let key of keys) res[key] = obj[key];
      return res;
    };
    micromatch.some = (list, patterns, options) => {
      let items = [].concat(list);
      for (let pattern of [].concat(patterns)) {
        let isMatch = picomatch(String(pattern), options);
        if (items.some((item) => isMatch(item))) {
          return true;
        }
      }
      return false;
    };
    micromatch.every = (list, patterns, options) => {
      let items = [].concat(list);
      for (let pattern of [].concat(patterns)) {
        let isMatch = picomatch(String(pattern), options);
        if (!items.every((item) => isMatch(item))) {
          return false;
        }
      }
      return true;
    };
    micromatch.all = (str, patterns, options) => {
      if (typeof str !== "string") {
        throw new TypeError(`Expected a string: "${util.inspect(str)}"`);
      }
      return [].concat(patterns).every((p) => picomatch(p, options)(str));
    };
    micromatch.capture = (glob, input, options) => {
      let posix = utils.isWindows(options);
      let regex = picomatch.makeRe(String(glob), { ...options, capture: true });
      let match = regex.exec(posix ? utils.toPosixSlashes(input) : input);
      if (match) {
        return match.slice(1).map((v) => v === void 0 ? "" : v);
      }
    };
    micromatch.makeRe = (...args) => picomatch.makeRe(...args);
    micromatch.scan = (...args) => picomatch.scan(...args);
    micromatch.parse = (patterns, options) => {
      let res = [];
      for (let pattern of [].concat(patterns || [])) {
        for (let str of braces(String(pattern), options)) {
          res.push(picomatch.parse(str, options));
        }
      }
      return res;
    };
    micromatch.braces = (pattern, options) => {
      if (typeof pattern !== "string") throw new TypeError("Expected a string");
      if (options && options.nobrace === true || !hasBraces(pattern)) {
        return [pattern];
      }
      return braces(pattern, options);
    };
    micromatch.braceExpand = (pattern, options) => {
      if (typeof pattern !== "string") throw new TypeError("Expected a string");
      return micromatch.braces(pattern, { ...options, expand: true });
    };
    micromatch.hasBraces = hasBraces;
    module2.exports = micromatch;
  }
});

// node_modules/fast-glob/out/utils/pattern.js
var require_pattern = __commonJS({
  "node_modules/fast-glob/out/utils/pattern.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.removeDuplicateSlashes = exports2.matchAny = exports2.convertPatternsToRe = exports2.makeRe = exports2.getPatternParts = exports2.expandBraceExpansion = exports2.expandPatternsWithBraceExpansion = exports2.isAffectDepthOfReadingPattern = exports2.endsWithSlashGlobStar = exports2.hasGlobStar = exports2.getBaseDirectory = exports2.isPatternRelatedToParentDirectory = exports2.getPatternsOutsideCurrentDirectory = exports2.getPatternsInsideCurrentDirectory = exports2.getPositivePatterns = exports2.getNegativePatterns = exports2.isPositivePattern = exports2.isNegativePattern = exports2.convertToNegativePattern = exports2.convertToPositivePattern = exports2.isDynamicPattern = exports2.isStaticPattern = void 0;
    var path2 = require("path");
    var globParent = require_glob_parent();
    var micromatch = require_micromatch();
    var GLOBSTAR = "**";
    var ESCAPE_SYMBOL = "\\";
    var COMMON_GLOB_SYMBOLS_RE = /[*?]|^!/;
    var REGEX_CHARACTER_CLASS_SYMBOLS_RE = /\[[^[]*]/;
    var REGEX_GROUP_SYMBOLS_RE = /(?:^|[^!*+?@])\([^(]*\|[^|]*\)/;
    var GLOB_EXTENSION_SYMBOLS_RE = /[!*+?@]\([^(]*\)/;
    var BRACE_EXPANSION_SEPARATORS_RE = /,|\.\./;
    var DOUBLE_SLASH_RE = /(?!^)\/{2,}/g;
    function isStaticPattern(pattern, options = {}) {
      return !isDynamicPattern(pattern, options);
    }
    exports2.isStaticPattern = isStaticPattern;
    function isDynamicPattern(pattern, options = {}) {
      if (pattern === "") {
        return false;
      }
      if (options.caseSensitiveMatch === false || pattern.includes(ESCAPE_SYMBOL)) {
        return true;
      }
      if (COMMON_GLOB_SYMBOLS_RE.test(pattern) || REGEX_CHARACTER_CLASS_SYMBOLS_RE.test(pattern) || REGEX_GROUP_SYMBOLS_RE.test(pattern)) {
        return true;
      }
      if (options.extglob !== false && GLOB_EXTENSION_SYMBOLS_RE.test(pattern)) {
        return true;
      }
      if (options.braceExpansion !== false && hasBraceExpansion(pattern)) {
        return true;
      }
      return false;
    }
    exports2.isDynamicPattern = isDynamicPattern;
    function hasBraceExpansion(pattern) {
      const openingBraceIndex = pattern.indexOf("{");
      if (openingBraceIndex === -1) {
        return false;
      }
      const closingBraceIndex = pattern.indexOf("}", openingBraceIndex + 1);
      if (closingBraceIndex === -1) {
        return false;
      }
      const braceContent = pattern.slice(openingBraceIndex, closingBraceIndex);
      return BRACE_EXPANSION_SEPARATORS_RE.test(braceContent);
    }
    function convertToPositivePattern(pattern) {
      return isNegativePattern(pattern) ? pattern.slice(1) : pattern;
    }
    exports2.convertToPositivePattern = convertToPositivePattern;
    function convertToNegativePattern(pattern) {
      return "!" + pattern;
    }
    exports2.convertToNegativePattern = convertToNegativePattern;
    function isNegativePattern(pattern) {
      return pattern.startsWith("!") && pattern[1] !== "(";
    }
    exports2.isNegativePattern = isNegativePattern;
    function isPositivePattern(pattern) {
      return !isNegativePattern(pattern);
    }
    exports2.isPositivePattern = isPositivePattern;
    function getNegativePatterns(patterns) {
      return patterns.filter(isNegativePattern);
    }
    exports2.getNegativePatterns = getNegativePatterns;
    function getPositivePatterns(patterns) {
      return patterns.filter(isPositivePattern);
    }
    exports2.getPositivePatterns = getPositivePatterns;
    function getPatternsInsideCurrentDirectory(patterns) {
      return patterns.filter((pattern) => !isPatternRelatedToParentDirectory(pattern));
    }
    exports2.getPatternsInsideCurrentDirectory = getPatternsInsideCurrentDirectory;
    function getPatternsOutsideCurrentDirectory(patterns) {
      return patterns.filter(isPatternRelatedToParentDirectory);
    }
    exports2.getPatternsOutsideCurrentDirectory = getPatternsOutsideCurrentDirectory;
    function isPatternRelatedToParentDirectory(pattern) {
      return pattern.startsWith("..") || pattern.startsWith("./..");
    }
    exports2.isPatternRelatedToParentDirectory = isPatternRelatedToParentDirectory;
    function getBaseDirectory(pattern) {
      return globParent(pattern, { flipBackslashes: false });
    }
    exports2.getBaseDirectory = getBaseDirectory;
    function hasGlobStar(pattern) {
      return pattern.includes(GLOBSTAR);
    }
    exports2.hasGlobStar = hasGlobStar;
    function endsWithSlashGlobStar(pattern) {
      return pattern.endsWith("/" + GLOBSTAR);
    }
    exports2.endsWithSlashGlobStar = endsWithSlashGlobStar;
    function isAffectDepthOfReadingPattern(pattern) {
      const basename = path2.basename(pattern);
      return endsWithSlashGlobStar(pattern) || isStaticPattern(basename);
    }
    exports2.isAffectDepthOfReadingPattern = isAffectDepthOfReadingPattern;
    function expandPatternsWithBraceExpansion(patterns) {
      return patterns.reduce((collection, pattern) => {
        return collection.concat(expandBraceExpansion(pattern));
      }, []);
    }
    exports2.expandPatternsWithBraceExpansion = expandPatternsWithBraceExpansion;
    function expandBraceExpansion(pattern) {
      const patterns = micromatch.braces(pattern, { expand: true, nodupes: true, keepEscaping: true });
      patterns.sort((a, b) => a.length - b.length);
      return patterns.filter((pattern2) => pattern2 !== "");
    }
    exports2.expandBraceExpansion = expandBraceExpansion;
    function getPatternParts(pattern, options) {
      let { parts } = micromatch.scan(pattern, Object.assign(Object.assign({}, options), { parts: true }));
      if (parts.length === 0) {
        parts = [pattern];
      }
      if (parts[0].startsWith("/")) {
        parts[0] = parts[0].slice(1);
        parts.unshift("");
      }
      return parts;
    }
    exports2.getPatternParts = getPatternParts;
    function makeRe(pattern, options) {
      return micromatch.makeRe(pattern, options);
    }
    exports2.makeRe = makeRe;
    function convertPatternsToRe(patterns, options) {
      return patterns.map((pattern) => makeRe(pattern, options));
    }
    exports2.convertPatternsToRe = convertPatternsToRe;
    function matchAny(entry, patternsRe) {
      return patternsRe.some((patternRe) => patternRe.test(entry));
    }
    exports2.matchAny = matchAny;
    function removeDuplicateSlashes(pattern) {
      return pattern.replace(DOUBLE_SLASH_RE, "/");
    }
    exports2.removeDuplicateSlashes = removeDuplicateSlashes;
  }
});

// node_modules/merge2/index.js
var require_merge2 = __commonJS({
  "node_modules/merge2/index.js"(exports2, module2) {
    "use strict";
    var Stream = require("stream");
    var PassThrough = Stream.PassThrough;
    var slice = Array.prototype.slice;
    module2.exports = merge2;
    function merge2() {
      const streamsQueue = [];
      const args = slice.call(arguments);
      let merging = false;
      let options = args[args.length - 1];
      if (options && !Array.isArray(options) && options.pipe == null) {
        args.pop();
      } else {
        options = {};
      }
      const doEnd = options.end !== false;
      const doPipeError = options.pipeError === true;
      if (options.objectMode == null) {
        options.objectMode = true;
      }
      if (options.highWaterMark == null) {
        options.highWaterMark = 64 * 1024;
      }
      const mergedStream = PassThrough(options);
      function addStream() {
        for (let i = 0, len = arguments.length; i < len; i++) {
          streamsQueue.push(pauseStreams(arguments[i], options));
        }
        mergeStream();
        return this;
      }
      function mergeStream() {
        if (merging) {
          return;
        }
        merging = true;
        let streams = streamsQueue.shift();
        if (!streams) {
          process.nextTick(endStream);
          return;
        }
        if (!Array.isArray(streams)) {
          streams = [streams];
        }
        let pipesCount = streams.length + 1;
        function next() {
          if (--pipesCount > 0) {
            return;
          }
          merging = false;
          mergeStream();
        }
        function pipe(stream) {
          function onend() {
            stream.removeListener("merge2UnpipeEnd", onend);
            stream.removeListener("end", onend);
            if (doPipeError) {
              stream.removeListener("error", onerror);
            }
            next();
          }
          function onerror(err) {
            mergedStream.emit("error", err);
          }
          if (stream._readableState.endEmitted) {
            return next();
          }
          stream.on("merge2UnpipeEnd", onend);
          stream.on("end", onend);
          if (doPipeError) {
            stream.on("error", onerror);
          }
          stream.pipe(mergedStream, { end: false });
          stream.resume();
        }
        for (let i = 0; i < streams.length; i++) {
          pipe(streams[i]);
        }
        next();
      }
      function endStream() {
        merging = false;
        mergedStream.emit("queueDrain");
        if (doEnd) {
          mergedStream.end();
        }
      }
      mergedStream.setMaxListeners(0);
      mergedStream.add = addStream;
      mergedStream.on("unpipe", function(stream) {
        stream.emit("merge2UnpipeEnd");
      });
      if (args.length) {
        addStream.apply(null, args);
      }
      return mergedStream;
    }
    function pauseStreams(streams, options) {
      if (!Array.isArray(streams)) {
        if (!streams._readableState && streams.pipe) {
          streams = streams.pipe(PassThrough(options));
        }
        if (!streams._readableState || !streams.pause || !streams.pipe) {
          throw new Error("Only readable stream can be merged.");
        }
        streams.pause();
      } else {
        for (let i = 0, len = streams.length; i < len; i++) {
          streams[i] = pauseStreams(streams[i], options);
        }
      }
      return streams;
    }
  }
});

// node_modules/fast-glob/out/utils/stream.js
var require_stream = __commonJS({
  "node_modules/fast-glob/out/utils/stream.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.merge = void 0;
    var merge2 = require_merge2();
    function merge(streams) {
      const mergedStream = merge2(streams);
      streams.forEach((stream) => {
        stream.once("error", (error) => mergedStream.emit("error", error));
      });
      mergedStream.once("close", () => propagateCloseEventToSources(streams));
      mergedStream.once("end", () => propagateCloseEventToSources(streams));
      return mergedStream;
    }
    exports2.merge = merge;
    function propagateCloseEventToSources(streams) {
      streams.forEach((stream) => stream.emit("close"));
    }
  }
});

// node_modules/fast-glob/out/utils/string.js
var require_string = __commonJS({
  "node_modules/fast-glob/out/utils/string.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isEmpty = exports2.isString = void 0;
    function isString(input) {
      return typeof input === "string";
    }
    exports2.isString = isString;
    function isEmpty(input) {
      return input === "";
    }
    exports2.isEmpty = isEmpty;
  }
});

// node_modules/fast-glob/out/utils/index.js
var require_utils3 = __commonJS({
  "node_modules/fast-glob/out/utils/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.string = exports2.stream = exports2.pattern = exports2.path = exports2.fs = exports2.errno = exports2.array = void 0;
    var array = require_array();
    exports2.array = array;
    var errno = require_errno();
    exports2.errno = errno;
    var fs2 = require_fs();
    exports2.fs = fs2;
    var path2 = require_path();
    exports2.path = path2;
    var pattern = require_pattern();
    exports2.pattern = pattern;
    var stream = require_stream();
    exports2.stream = stream;
    var string = require_string();
    exports2.string = string;
  }
});

// node_modules/fast-glob/out/managers/tasks.js
var require_tasks = __commonJS({
  "node_modules/fast-glob/out/managers/tasks.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.convertPatternGroupToTask = exports2.convertPatternGroupsToTasks = exports2.groupPatternsByBaseDirectory = exports2.getNegativePatternsAsPositive = exports2.getPositivePatterns = exports2.convertPatternsToTasks = exports2.generate = void 0;
    var utils = require_utils3();
    function generate(input, settings) {
      const patterns = processPatterns(input, settings);
      const ignore = processPatterns(settings.ignore, settings);
      const positivePatterns = getPositivePatterns(patterns);
      const negativePatterns = getNegativePatternsAsPositive(patterns, ignore);
      const staticPatterns = positivePatterns.filter((pattern) => utils.pattern.isStaticPattern(pattern, settings));
      const dynamicPatterns = positivePatterns.filter((pattern) => utils.pattern.isDynamicPattern(pattern, settings));
      const staticTasks = convertPatternsToTasks(
        staticPatterns,
        negativePatterns,
        /* dynamic */
        false
      );
      const dynamicTasks = convertPatternsToTasks(
        dynamicPatterns,
        negativePatterns,
        /* dynamic */
        true
      );
      return staticTasks.concat(dynamicTasks);
    }
    exports2.generate = generate;
    function processPatterns(input, settings) {
      let patterns = input;
      if (settings.braceExpansion) {
        patterns = utils.pattern.expandPatternsWithBraceExpansion(patterns);
      }
      if (settings.baseNameMatch) {
        patterns = patterns.map((pattern) => pattern.includes("/") ? pattern : `**/${pattern}`);
      }
      return patterns.map((pattern) => utils.pattern.removeDuplicateSlashes(pattern));
    }
    function convertPatternsToTasks(positive, negative, dynamic) {
      const tasks = [];
      const patternsOutsideCurrentDirectory = utils.pattern.getPatternsOutsideCurrentDirectory(positive);
      const patternsInsideCurrentDirectory = utils.pattern.getPatternsInsideCurrentDirectory(positive);
      const outsideCurrentDirectoryGroup = groupPatternsByBaseDirectory(patternsOutsideCurrentDirectory);
      const insideCurrentDirectoryGroup = groupPatternsByBaseDirectory(patternsInsideCurrentDirectory);
      tasks.push(...convertPatternGroupsToTasks(outsideCurrentDirectoryGroup, negative, dynamic));
      if ("." in insideCurrentDirectoryGroup) {
        tasks.push(convertPatternGroupToTask(".", patternsInsideCurrentDirectory, negative, dynamic));
      } else {
        tasks.push(...convertPatternGroupsToTasks(insideCurrentDirectoryGroup, negative, dynamic));
      }
      return tasks;
    }
    exports2.convertPatternsToTasks = convertPatternsToTasks;
    function getPositivePatterns(patterns) {
      return utils.pattern.getPositivePatterns(patterns);
    }
    exports2.getPositivePatterns = getPositivePatterns;
    function getNegativePatternsAsPositive(patterns, ignore) {
      const negative = utils.pattern.getNegativePatterns(patterns).concat(ignore);
      const positive = negative.map(utils.pattern.convertToPositivePattern);
      return positive;
    }
    exports2.getNegativePatternsAsPositive = getNegativePatternsAsPositive;
    function groupPatternsByBaseDirectory(patterns) {
      const group = {};
      return patterns.reduce((collection, pattern) => {
        const base = utils.pattern.getBaseDirectory(pattern);
        if (base in collection) {
          collection[base].push(pattern);
        } else {
          collection[base] = [pattern];
        }
        return collection;
      }, group);
    }
    exports2.groupPatternsByBaseDirectory = groupPatternsByBaseDirectory;
    function convertPatternGroupsToTasks(positive, negative, dynamic) {
      return Object.keys(positive).map((base) => {
        return convertPatternGroupToTask(base, positive[base], negative, dynamic);
      });
    }
    exports2.convertPatternGroupsToTasks = convertPatternGroupsToTasks;
    function convertPatternGroupToTask(base, positive, negative, dynamic) {
      return {
        dynamic,
        positive,
        negative,
        base,
        patterns: [].concat(positive, negative.map(utils.pattern.convertToNegativePattern))
      };
    }
    exports2.convertPatternGroupToTask = convertPatternGroupToTask;
  }
});

// node_modules/@nodelib/fs.stat/out/providers/async.js
var require_async = __commonJS({
  "node_modules/@nodelib/fs.stat/out/providers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.read = void 0;
    function read(path2, settings, callback) {
      settings.fs.lstat(path2, (lstatError, lstat) => {
        if (lstatError !== null) {
          callFailureCallback(callback, lstatError);
          return;
        }
        if (!lstat.isSymbolicLink() || !settings.followSymbolicLink) {
          callSuccessCallback(callback, lstat);
          return;
        }
        settings.fs.stat(path2, (statError, stat) => {
          if (statError !== null) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              callFailureCallback(callback, statError);
              return;
            }
            callSuccessCallback(callback, lstat);
            return;
          }
          if (settings.markSymbolicLink) {
            stat.isSymbolicLink = () => true;
          }
          callSuccessCallback(callback, stat);
        });
      });
    }
    exports2.read = read;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, result) {
      callback(null, result);
    }
  }
});

// node_modules/@nodelib/fs.stat/out/providers/sync.js
var require_sync = __commonJS({
  "node_modules/@nodelib/fs.stat/out/providers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.read = void 0;
    function read(path2, settings) {
      const lstat = settings.fs.lstatSync(path2);
      if (!lstat.isSymbolicLink() || !settings.followSymbolicLink) {
        return lstat;
      }
      try {
        const stat = settings.fs.statSync(path2);
        if (settings.markSymbolicLink) {
          stat.isSymbolicLink = () => true;
        }
        return stat;
      } catch (error) {
        if (!settings.throwErrorOnBrokenSymbolicLink) {
          return lstat;
        }
        throw error;
      }
    }
    exports2.read = read;
  }
});

// node_modules/@nodelib/fs.stat/out/adapters/fs.js
var require_fs2 = __commonJS({
  "node_modules/@nodelib/fs.stat/out/adapters/fs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createFileSystemAdapter = exports2.FILE_SYSTEM_ADAPTER = void 0;
    var fs2 = require("fs");
    exports2.FILE_SYSTEM_ADAPTER = {
      lstat: fs2.lstat,
      stat: fs2.stat,
      lstatSync: fs2.lstatSync,
      statSync: fs2.statSync
    };
    function createFileSystemAdapter(fsMethods) {
      if (fsMethods === void 0) {
        return exports2.FILE_SYSTEM_ADAPTER;
      }
      return Object.assign(Object.assign({}, exports2.FILE_SYSTEM_ADAPTER), fsMethods);
    }
    exports2.createFileSystemAdapter = createFileSystemAdapter;
  }
});

// node_modules/@nodelib/fs.stat/out/settings.js
var require_settings = __commonJS({
  "node_modules/@nodelib/fs.stat/out/settings.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var fs2 = require_fs2();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.followSymbolicLink = this._getValue(this._options.followSymbolicLink, true);
        this.fs = fs2.createFileSystemAdapter(this._options.fs);
        this.markSymbolicLink = this._getValue(this._options.markSymbolicLink, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, true);
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports2.default = Settings;
  }
});

// node_modules/@nodelib/fs.stat/out/index.js
var require_out = __commonJS({
  "node_modules/@nodelib/fs.stat/out/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.statSync = exports2.stat = exports2.Settings = void 0;
    var async = require_async();
    var sync = require_sync();
    var settings_1 = require_settings();
    exports2.Settings = settings_1.default;
    function stat(path2, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        async.read(path2, getSettings(), optionsOrSettingsOrCallback);
        return;
      }
      async.read(path2, getSettings(optionsOrSettingsOrCallback), callback);
    }
    exports2.stat = stat;
    function statSync(path2, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      return sync.read(path2, settings);
    }
    exports2.statSync = statSync;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// node_modules/queue-microtask/index.js
var require_queue_microtask = __commonJS({
  "node_modules/queue-microtask/index.js"(exports2, module2) {
    var promise;
    module2.exports = typeof queueMicrotask === "function" ? queueMicrotask.bind(typeof window !== "undefined" ? window : global) : (cb) => (promise || (promise = Promise.resolve())).then(cb).catch((err) => setTimeout(() => {
      throw err;
    }, 0));
  }
});

// node_modules/run-parallel/index.js
var require_run_parallel = __commonJS({
  "node_modules/run-parallel/index.js"(exports2, module2) {
    module2.exports = runParallel;
    var queueMicrotask2 = require_queue_microtask();
    function runParallel(tasks, cb) {
      let results, pending, keys;
      let isSync = true;
      if (Array.isArray(tasks)) {
        results = [];
        pending = tasks.length;
      } else {
        keys = Object.keys(tasks);
        results = {};
        pending = keys.length;
      }
      function done(err) {
        function end() {
          if (cb) cb(err, results);
          cb = null;
        }
        if (isSync) queueMicrotask2(end);
        else end();
      }
      function each(i, err, result) {
        results[i] = result;
        if (--pending === 0 || err) {
          done(err);
        }
      }
      if (!pending) {
        done(null);
      } else if (keys) {
        keys.forEach(function(key) {
          tasks[key](function(err, result) {
            each(key, err, result);
          });
        });
      } else {
        tasks.forEach(function(task, i) {
          task(function(err, result) {
            each(i, err, result);
          });
        });
      }
      isSync = false;
    }
  }
});

// node_modules/@nodelib/fs.scandir/out/constants.js
var require_constants3 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/constants.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.IS_SUPPORT_READDIR_WITH_FILE_TYPES = void 0;
    var NODE_PROCESS_VERSION_PARTS = process.versions.node.split(".");
    if (NODE_PROCESS_VERSION_PARTS[0] === void 0 || NODE_PROCESS_VERSION_PARTS[1] === void 0) {
      throw new Error(`Unexpected behavior. The 'process.versions.node' variable has invalid value: ${process.versions.node}`);
    }
    var MAJOR_VERSION = Number.parseInt(NODE_PROCESS_VERSION_PARTS[0], 10);
    var MINOR_VERSION = Number.parseInt(NODE_PROCESS_VERSION_PARTS[1], 10);
    var SUPPORTED_MAJOR_VERSION = 10;
    var SUPPORTED_MINOR_VERSION = 10;
    var IS_MATCHED_BY_MAJOR = MAJOR_VERSION > SUPPORTED_MAJOR_VERSION;
    var IS_MATCHED_BY_MAJOR_AND_MINOR = MAJOR_VERSION === SUPPORTED_MAJOR_VERSION && MINOR_VERSION >= SUPPORTED_MINOR_VERSION;
    exports2.IS_SUPPORT_READDIR_WITH_FILE_TYPES = IS_MATCHED_BY_MAJOR || IS_MATCHED_BY_MAJOR_AND_MINOR;
  }
});

// node_modules/@nodelib/fs.scandir/out/utils/fs.js
var require_fs3 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/utils/fs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createDirentFromStats = void 0;
    var DirentFromStats = class {
      constructor(name, stats) {
        this.name = name;
        this.isBlockDevice = stats.isBlockDevice.bind(stats);
        this.isCharacterDevice = stats.isCharacterDevice.bind(stats);
        this.isDirectory = stats.isDirectory.bind(stats);
        this.isFIFO = stats.isFIFO.bind(stats);
        this.isFile = stats.isFile.bind(stats);
        this.isSocket = stats.isSocket.bind(stats);
        this.isSymbolicLink = stats.isSymbolicLink.bind(stats);
      }
    };
    function createDirentFromStats(name, stats) {
      return new DirentFromStats(name, stats);
    }
    exports2.createDirentFromStats = createDirentFromStats;
  }
});

// node_modules/@nodelib/fs.scandir/out/utils/index.js
var require_utils4 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/utils/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.fs = void 0;
    var fs2 = require_fs3();
    exports2.fs = fs2;
  }
});

// node_modules/@nodelib/fs.scandir/out/providers/common.js
var require_common = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/providers/common.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.joinPathSegments = void 0;
    function joinPathSegments(a, b, separator) {
      if (a.endsWith(separator)) {
        return a + b;
      }
      return a + separator + b;
    }
    exports2.joinPathSegments = joinPathSegments;
  }
});

// node_modules/@nodelib/fs.scandir/out/providers/async.js
var require_async2 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/providers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.readdir = exports2.readdirWithFileTypes = exports2.read = void 0;
    var fsStat = require_out();
    var rpl = require_run_parallel();
    var constants_1 = require_constants3();
    var utils = require_utils4();
    var common = require_common();
    function read(directory, settings, callback) {
      if (!settings.stats && constants_1.IS_SUPPORT_READDIR_WITH_FILE_TYPES) {
        readdirWithFileTypes(directory, settings, callback);
        return;
      }
      readdir(directory, settings, callback);
    }
    exports2.read = read;
    function readdirWithFileTypes(directory, settings, callback) {
      settings.fs.readdir(directory, { withFileTypes: true }, (readdirError, dirents) => {
        if (readdirError !== null) {
          callFailureCallback(callback, readdirError);
          return;
        }
        const entries = dirents.map((dirent) => ({
          dirent,
          name: dirent.name,
          path: common.joinPathSegments(directory, dirent.name, settings.pathSegmentSeparator)
        }));
        if (!settings.followSymbolicLinks) {
          callSuccessCallback(callback, entries);
          return;
        }
        const tasks = entries.map((entry) => makeRplTaskEntry(entry, settings));
        rpl(tasks, (rplError, rplEntries) => {
          if (rplError !== null) {
            callFailureCallback(callback, rplError);
            return;
          }
          callSuccessCallback(callback, rplEntries);
        });
      });
    }
    exports2.readdirWithFileTypes = readdirWithFileTypes;
    function makeRplTaskEntry(entry, settings) {
      return (done) => {
        if (!entry.dirent.isSymbolicLink()) {
          done(null, entry);
          return;
        }
        settings.fs.stat(entry.path, (statError, stats) => {
          if (statError !== null) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              done(statError);
              return;
            }
            done(null, entry);
            return;
          }
          entry.dirent = utils.fs.createDirentFromStats(entry.name, stats);
          done(null, entry);
        });
      };
    }
    function readdir(directory, settings, callback) {
      settings.fs.readdir(directory, (readdirError, names) => {
        if (readdirError !== null) {
          callFailureCallback(callback, readdirError);
          return;
        }
        const tasks = names.map((name) => {
          const path2 = common.joinPathSegments(directory, name, settings.pathSegmentSeparator);
          return (done) => {
            fsStat.stat(path2, settings.fsStatSettings, (error, stats) => {
              if (error !== null) {
                done(error);
                return;
              }
              const entry = {
                name,
                path: path2,
                dirent: utils.fs.createDirentFromStats(name, stats)
              };
              if (settings.stats) {
                entry.stats = stats;
              }
              done(null, entry);
            });
          };
        });
        rpl(tasks, (rplError, entries) => {
          if (rplError !== null) {
            callFailureCallback(callback, rplError);
            return;
          }
          callSuccessCallback(callback, entries);
        });
      });
    }
    exports2.readdir = readdir;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, result) {
      callback(null, result);
    }
  }
});

// node_modules/@nodelib/fs.scandir/out/providers/sync.js
var require_sync2 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/providers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.readdir = exports2.readdirWithFileTypes = exports2.read = void 0;
    var fsStat = require_out();
    var constants_1 = require_constants3();
    var utils = require_utils4();
    var common = require_common();
    function read(directory, settings) {
      if (!settings.stats && constants_1.IS_SUPPORT_READDIR_WITH_FILE_TYPES) {
        return readdirWithFileTypes(directory, settings);
      }
      return readdir(directory, settings);
    }
    exports2.read = read;
    function readdirWithFileTypes(directory, settings) {
      const dirents = settings.fs.readdirSync(directory, { withFileTypes: true });
      return dirents.map((dirent) => {
        const entry = {
          dirent,
          name: dirent.name,
          path: common.joinPathSegments(directory, dirent.name, settings.pathSegmentSeparator)
        };
        if (entry.dirent.isSymbolicLink() && settings.followSymbolicLinks) {
          try {
            const stats = settings.fs.statSync(entry.path);
            entry.dirent = utils.fs.createDirentFromStats(entry.name, stats);
          } catch (error) {
            if (settings.throwErrorOnBrokenSymbolicLink) {
              throw error;
            }
          }
        }
        return entry;
      });
    }
    exports2.readdirWithFileTypes = readdirWithFileTypes;
    function readdir(directory, settings) {
      const names = settings.fs.readdirSync(directory);
      return names.map((name) => {
        const entryPath = common.joinPathSegments(directory, name, settings.pathSegmentSeparator);
        const stats = fsStat.statSync(entryPath, settings.fsStatSettings);
        const entry = {
          name,
          path: entryPath,
          dirent: utils.fs.createDirentFromStats(name, stats)
        };
        if (settings.stats) {
          entry.stats = stats;
        }
        return entry;
      });
    }
    exports2.readdir = readdir;
  }
});

// node_modules/@nodelib/fs.scandir/out/adapters/fs.js
var require_fs4 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/adapters/fs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createFileSystemAdapter = exports2.FILE_SYSTEM_ADAPTER = void 0;
    var fs2 = require("fs");
    exports2.FILE_SYSTEM_ADAPTER = {
      lstat: fs2.lstat,
      stat: fs2.stat,
      lstatSync: fs2.lstatSync,
      statSync: fs2.statSync,
      readdir: fs2.readdir,
      readdirSync: fs2.readdirSync
    };
    function createFileSystemAdapter(fsMethods) {
      if (fsMethods === void 0) {
        return exports2.FILE_SYSTEM_ADAPTER;
      }
      return Object.assign(Object.assign({}, exports2.FILE_SYSTEM_ADAPTER), fsMethods);
    }
    exports2.createFileSystemAdapter = createFileSystemAdapter;
  }
});

// node_modules/@nodelib/fs.scandir/out/settings.js
var require_settings2 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/settings.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var path2 = require("path");
    var fsStat = require_out();
    var fs2 = require_fs4();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.followSymbolicLinks = this._getValue(this._options.followSymbolicLinks, false);
        this.fs = fs2.createFileSystemAdapter(this._options.fs);
        this.pathSegmentSeparator = this._getValue(this._options.pathSegmentSeparator, path2.sep);
        this.stats = this._getValue(this._options.stats, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, true);
        this.fsStatSettings = new fsStat.Settings({
          followSymbolicLink: this.followSymbolicLinks,
          fs: this.fs,
          throwErrorOnBrokenSymbolicLink: this.throwErrorOnBrokenSymbolicLink
        });
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports2.default = Settings;
  }
});

// node_modules/@nodelib/fs.scandir/out/index.js
var require_out2 = __commonJS({
  "node_modules/@nodelib/fs.scandir/out/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Settings = exports2.scandirSync = exports2.scandir = void 0;
    var async = require_async2();
    var sync = require_sync2();
    var settings_1 = require_settings2();
    exports2.Settings = settings_1.default;
    function scandir(path2, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        async.read(path2, getSettings(), optionsOrSettingsOrCallback);
        return;
      }
      async.read(path2, getSettings(optionsOrSettingsOrCallback), callback);
    }
    exports2.scandir = scandir;
    function scandirSync(path2, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      return sync.read(path2, settings);
    }
    exports2.scandirSync = scandirSync;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// node_modules/reusify/reusify.js
var require_reusify = __commonJS({
  "node_modules/reusify/reusify.js"(exports2, module2) {
    "use strict";
    function reusify(Constructor) {
      var head = new Constructor();
      var tail = head;
      function get() {
        var current = head;
        if (current.next) {
          head = current.next;
        } else {
          head = new Constructor();
          tail = head;
        }
        current.next = null;
        return current;
      }
      function release(obj) {
        tail.next = obj;
        tail = obj;
      }
      return {
        get,
        release
      };
    }
    module2.exports = reusify;
  }
});

// node_modules/fastq/queue.js
var require_queue = __commonJS({
  "node_modules/fastq/queue.js"(exports2, module2) {
    "use strict";
    var reusify = require_reusify();
    function fastqueue(context, worker, _concurrency) {
      if (typeof context === "function") {
        _concurrency = worker;
        worker = context;
        context = null;
      }
      if (!(_concurrency >= 1)) {
        throw new Error("fastqueue concurrency must be equal to or greater than 1");
      }
      var cache = reusify(Task);
      var queueHead = null;
      var queueTail = null;
      var _running = 0;
      var errorHandler = null;
      var self = {
        push,
        drain: noop,
        saturated: noop,
        pause,
        paused: false,
        get concurrency() {
          return _concurrency;
        },
        set concurrency(value) {
          if (!(value >= 1)) {
            throw new Error("fastqueue concurrency must be equal to or greater than 1");
          }
          _concurrency = value;
          if (self.paused) return;
          for (; queueHead && _running < _concurrency; ) {
            _running++;
            release();
          }
        },
        running,
        resume,
        idle,
        length,
        getQueue,
        unshift,
        empty: noop,
        kill,
        killAndDrain,
        error
      };
      return self;
      function running() {
        return _running;
      }
      function pause() {
        self.paused = true;
      }
      function length() {
        var current = queueHead;
        var counter = 0;
        while (current) {
          current = current.next;
          counter++;
        }
        return counter;
      }
      function getQueue() {
        var current = queueHead;
        var tasks = [];
        while (current) {
          tasks.push(current.value);
          current = current.next;
        }
        return tasks;
      }
      function resume() {
        if (!self.paused) return;
        self.paused = false;
        if (queueHead === null) {
          _running++;
          release();
          return;
        }
        for (; queueHead && _running < _concurrency; ) {
          _running++;
          release();
        }
      }
      function idle() {
        return _running === 0 && self.length() === 0;
      }
      function push(value, done) {
        var current = cache.get();
        current.context = context;
        current.release = release;
        current.value = value;
        current.callback = done || noop;
        current.errorHandler = errorHandler;
        if (_running >= _concurrency || self.paused) {
          if (queueTail) {
            queueTail.next = current;
            queueTail = current;
          } else {
            queueHead = current;
            queueTail = current;
            self.saturated();
          }
        } else {
          _running++;
          worker.call(context, current.value, current.worked);
        }
      }
      function unshift(value, done) {
        var current = cache.get();
        current.context = context;
        current.release = release;
        current.value = value;
        current.callback = done || noop;
        current.errorHandler = errorHandler;
        if (_running >= _concurrency || self.paused) {
          if (queueHead) {
            current.next = queueHead;
            queueHead = current;
          } else {
            queueHead = current;
            queueTail = current;
            self.saturated();
          }
        } else {
          _running++;
          worker.call(context, current.value, current.worked);
        }
      }
      function release(holder) {
        if (holder) {
          cache.release(holder);
        }
        var next = queueHead;
        if (next && _running <= _concurrency) {
          if (!self.paused) {
            if (queueTail === queueHead) {
              queueTail = null;
            }
            queueHead = next.next;
            next.next = null;
            worker.call(context, next.value, next.worked);
            if (queueTail === null) {
              self.empty();
            }
          } else {
            _running--;
          }
        } else if (--_running === 0) {
          self.drain();
        }
      }
      function kill() {
        queueHead = null;
        queueTail = null;
        self.drain = noop;
      }
      function killAndDrain() {
        queueHead = null;
        queueTail = null;
        self.drain();
        self.drain = noop;
      }
      function error(handler) {
        errorHandler = handler;
      }
    }
    function noop() {
    }
    function Task() {
      this.value = null;
      this.callback = noop;
      this.next = null;
      this.release = noop;
      this.context = null;
      this.errorHandler = null;
      var self = this;
      this.worked = function worked(err, result) {
        var callback = self.callback;
        var errorHandler = self.errorHandler;
        var val = self.value;
        self.value = null;
        self.callback = noop;
        if (self.errorHandler) {
          errorHandler(err, val);
        }
        callback.call(self.context, err, result);
        self.release(self);
      };
    }
    function queueAsPromised(context, worker, _concurrency) {
      if (typeof context === "function") {
        _concurrency = worker;
        worker = context;
        context = null;
      }
      function asyncWrapper(arg, cb) {
        worker.call(this, arg).then(function(res) {
          cb(null, res);
        }, cb);
      }
      var queue = fastqueue(context, asyncWrapper, _concurrency);
      var pushCb = queue.push;
      var unshiftCb = queue.unshift;
      queue.push = push;
      queue.unshift = unshift;
      queue.drained = drained;
      return queue;
      function push(value) {
        var p = new Promise(function(resolve, reject) {
          pushCb(value, function(err, result) {
            if (err) {
              reject(err);
              return;
            }
            resolve(result);
          });
        });
        p.catch(noop);
        return p;
      }
      function unshift(value) {
        var p = new Promise(function(resolve, reject) {
          unshiftCb(value, function(err, result) {
            if (err) {
              reject(err);
              return;
            }
            resolve(result);
          });
        });
        p.catch(noop);
        return p;
      }
      function drained() {
        if (queue.idle()) {
          return new Promise(function(resolve) {
            resolve();
          });
        }
        var previousDrain = queue.drain;
        var p = new Promise(function(resolve) {
          queue.drain = function() {
            previousDrain();
            resolve();
          };
        });
        return p;
      }
    }
    module2.exports = fastqueue;
    module2.exports.promise = queueAsPromised;
  }
});

// node_modules/@nodelib/fs.walk/out/readers/common.js
var require_common2 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/readers/common.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.joinPathSegments = exports2.replacePathSegmentSeparator = exports2.isAppliedFilter = exports2.isFatalError = void 0;
    function isFatalError(settings, error) {
      if (settings.errorFilter === null) {
        return true;
      }
      return !settings.errorFilter(error);
    }
    exports2.isFatalError = isFatalError;
    function isAppliedFilter(filter, value) {
      return filter === null || filter(value);
    }
    exports2.isAppliedFilter = isAppliedFilter;
    function replacePathSegmentSeparator(filepath, separator) {
      return filepath.split(/[/\\]/).join(separator);
    }
    exports2.replacePathSegmentSeparator = replacePathSegmentSeparator;
    function joinPathSegments(a, b, separator) {
      if (a === "") {
        return b;
      }
      if (a.endsWith(separator)) {
        return a + b;
      }
      return a + separator + b;
    }
    exports2.joinPathSegments = joinPathSegments;
  }
});

// node_modules/@nodelib/fs.walk/out/readers/reader.js
var require_reader = __commonJS({
  "node_modules/@nodelib/fs.walk/out/readers/reader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var common = require_common2();
    var Reader = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._root = common.replacePathSegmentSeparator(_root, _settings.pathSegmentSeparator);
      }
    };
    exports2.default = Reader;
  }
});

// node_modules/@nodelib/fs.walk/out/readers/async.js
var require_async3 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/readers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var events_1 = require("events");
    var fsScandir = require_out2();
    var fastq = require_queue();
    var common = require_common2();
    var reader_1 = require_reader();
    var AsyncReader = class extends reader_1.default {
      constructor(_root, _settings) {
        super(_root, _settings);
        this._settings = _settings;
        this._scandir = fsScandir.scandir;
        this._emitter = new events_1.EventEmitter();
        this._queue = fastq(this._worker.bind(this), this._settings.concurrency);
        this._isFatalError = false;
        this._isDestroyed = false;
        this._queue.drain = () => {
          if (!this._isFatalError) {
            this._emitter.emit("end");
          }
        };
      }
      read() {
        this._isFatalError = false;
        this._isDestroyed = false;
        setImmediate(() => {
          this._pushToQueue(this._root, this._settings.basePath);
        });
        return this._emitter;
      }
      get isDestroyed() {
        return this._isDestroyed;
      }
      destroy() {
        if (this._isDestroyed) {
          throw new Error("The reader is already destroyed");
        }
        this._isDestroyed = true;
        this._queue.killAndDrain();
      }
      onEntry(callback) {
        this._emitter.on("entry", callback);
      }
      onError(callback) {
        this._emitter.once("error", callback);
      }
      onEnd(callback) {
        this._emitter.once("end", callback);
      }
      _pushToQueue(directory, base) {
        const queueItem = { directory, base };
        this._queue.push(queueItem, (error) => {
          if (error !== null) {
            this._handleError(error);
          }
        });
      }
      _worker(item, done) {
        this._scandir(item.directory, this._settings.fsScandirSettings, (error, entries) => {
          if (error !== null) {
            done(error, void 0);
            return;
          }
          for (const entry of entries) {
            this._handleEntry(entry, item.base);
          }
          done(null, void 0);
        });
      }
      _handleError(error) {
        if (this._isDestroyed || !common.isFatalError(this._settings, error)) {
          return;
        }
        this._isFatalError = true;
        this._isDestroyed = true;
        this._emitter.emit("error", error);
      }
      _handleEntry(entry, base) {
        if (this._isDestroyed || this._isFatalError) {
          return;
        }
        const fullpath = entry.path;
        if (base !== void 0) {
          entry.path = common.joinPathSegments(base, entry.name, this._settings.pathSegmentSeparator);
        }
        if (common.isAppliedFilter(this._settings.entryFilter, entry)) {
          this._emitEntry(entry);
        }
        if (entry.dirent.isDirectory() && common.isAppliedFilter(this._settings.deepFilter, entry)) {
          this._pushToQueue(fullpath, base === void 0 ? void 0 : entry.path);
        }
      }
      _emitEntry(entry) {
        this._emitter.emit("entry", entry);
      }
    };
    exports2.default = AsyncReader;
  }
});

// node_modules/@nodelib/fs.walk/out/providers/async.js
var require_async4 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/providers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var async_1 = require_async3();
    var AsyncProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new async_1.default(this._root, this._settings);
        this._storage = [];
      }
      read(callback) {
        this._reader.onError((error) => {
          callFailureCallback(callback, error);
        });
        this._reader.onEntry((entry) => {
          this._storage.push(entry);
        });
        this._reader.onEnd(() => {
          callSuccessCallback(callback, this._storage);
        });
        this._reader.read();
      }
    };
    exports2.default = AsyncProvider;
    function callFailureCallback(callback, error) {
      callback(error);
    }
    function callSuccessCallback(callback, entries) {
      callback(null, entries);
    }
  }
});

// node_modules/@nodelib/fs.walk/out/providers/stream.js
var require_stream2 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/providers/stream.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var stream_1 = require("stream");
    var async_1 = require_async3();
    var StreamProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new async_1.default(this._root, this._settings);
        this._stream = new stream_1.Readable({
          objectMode: true,
          read: () => {
          },
          destroy: () => {
            if (!this._reader.isDestroyed) {
              this._reader.destroy();
            }
          }
        });
      }
      read() {
        this._reader.onError((error) => {
          this._stream.emit("error", error);
        });
        this._reader.onEntry((entry) => {
          this._stream.push(entry);
        });
        this._reader.onEnd(() => {
          this._stream.push(null);
        });
        this._reader.read();
        return this._stream;
      }
    };
    exports2.default = StreamProvider;
  }
});

// node_modules/@nodelib/fs.walk/out/readers/sync.js
var require_sync3 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/readers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var fsScandir = require_out2();
    var common = require_common2();
    var reader_1 = require_reader();
    var SyncReader = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._scandir = fsScandir.scandirSync;
        this._storage = [];
        this._queue = /* @__PURE__ */ new Set();
      }
      read() {
        this._pushToQueue(this._root, this._settings.basePath);
        this._handleQueue();
        return this._storage;
      }
      _pushToQueue(directory, base) {
        this._queue.add({ directory, base });
      }
      _handleQueue() {
        for (const item of this._queue.values()) {
          this._handleDirectory(item.directory, item.base);
        }
      }
      _handleDirectory(directory, base) {
        try {
          const entries = this._scandir(directory, this._settings.fsScandirSettings);
          for (const entry of entries) {
            this._handleEntry(entry, base);
          }
        } catch (error) {
          this._handleError(error);
        }
      }
      _handleError(error) {
        if (!common.isFatalError(this._settings, error)) {
          return;
        }
        throw error;
      }
      _handleEntry(entry, base) {
        const fullpath = entry.path;
        if (base !== void 0) {
          entry.path = common.joinPathSegments(base, entry.name, this._settings.pathSegmentSeparator);
        }
        if (common.isAppliedFilter(this._settings.entryFilter, entry)) {
          this._pushToStorage(entry);
        }
        if (entry.dirent.isDirectory() && common.isAppliedFilter(this._settings.deepFilter, entry)) {
          this._pushToQueue(fullpath, base === void 0 ? void 0 : entry.path);
        }
      }
      _pushToStorage(entry) {
        this._storage.push(entry);
      }
    };
    exports2.default = SyncReader;
  }
});

// node_modules/@nodelib/fs.walk/out/providers/sync.js
var require_sync4 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/providers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var sync_1 = require_sync3();
    var SyncProvider = class {
      constructor(_root, _settings) {
        this._root = _root;
        this._settings = _settings;
        this._reader = new sync_1.default(this._root, this._settings);
      }
      read() {
        return this._reader.read();
      }
    };
    exports2.default = SyncProvider;
  }
});

// node_modules/@nodelib/fs.walk/out/settings.js
var require_settings3 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/settings.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var path2 = require("path");
    var fsScandir = require_out2();
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.basePath = this._getValue(this._options.basePath, void 0);
        this.concurrency = this._getValue(this._options.concurrency, Number.POSITIVE_INFINITY);
        this.deepFilter = this._getValue(this._options.deepFilter, null);
        this.entryFilter = this._getValue(this._options.entryFilter, null);
        this.errorFilter = this._getValue(this._options.errorFilter, null);
        this.pathSegmentSeparator = this._getValue(this._options.pathSegmentSeparator, path2.sep);
        this.fsScandirSettings = new fsScandir.Settings({
          followSymbolicLinks: this._options.followSymbolicLinks,
          fs: this._options.fs,
          pathSegmentSeparator: this._options.pathSegmentSeparator,
          stats: this._options.stats,
          throwErrorOnBrokenSymbolicLink: this._options.throwErrorOnBrokenSymbolicLink
        });
      }
      _getValue(option, value) {
        return option !== null && option !== void 0 ? option : value;
      }
    };
    exports2.default = Settings;
  }
});

// node_modules/@nodelib/fs.walk/out/index.js
var require_out3 = __commonJS({
  "node_modules/@nodelib/fs.walk/out/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Settings = exports2.walkStream = exports2.walkSync = exports2.walk = void 0;
    var async_1 = require_async4();
    var stream_1 = require_stream2();
    var sync_1 = require_sync4();
    var settings_1 = require_settings3();
    exports2.Settings = settings_1.default;
    function walk(directory, optionsOrSettingsOrCallback, callback) {
      if (typeof optionsOrSettingsOrCallback === "function") {
        new async_1.default(directory, getSettings()).read(optionsOrSettingsOrCallback);
        return;
      }
      new async_1.default(directory, getSettings(optionsOrSettingsOrCallback)).read(callback);
    }
    exports2.walk = walk;
    function walkSync(directory, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      const provider = new sync_1.default(directory, settings);
      return provider.read();
    }
    exports2.walkSync = walkSync;
    function walkStream(directory, optionsOrSettings) {
      const settings = getSettings(optionsOrSettings);
      const provider = new stream_1.default(directory, settings);
      return provider.read();
    }
    exports2.walkStream = walkStream;
    function getSettings(settingsOrOptions = {}) {
      if (settingsOrOptions instanceof settings_1.default) {
        return settingsOrOptions;
      }
      return new settings_1.default(settingsOrOptions);
    }
  }
});

// node_modules/fast-glob/out/readers/reader.js
var require_reader2 = __commonJS({
  "node_modules/fast-glob/out/readers/reader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var path2 = require("path");
    var fsStat = require_out();
    var utils = require_utils3();
    var Reader = class {
      constructor(_settings) {
        this._settings = _settings;
        this._fsStatSettings = new fsStat.Settings({
          followSymbolicLink: this._settings.followSymbolicLinks,
          fs: this._settings.fs,
          throwErrorOnBrokenSymbolicLink: this._settings.followSymbolicLinks
        });
      }
      _getFullEntryPath(filepath) {
        return path2.resolve(this._settings.cwd, filepath);
      }
      _makeEntry(stats, pattern) {
        const entry = {
          name: pattern,
          path: pattern,
          dirent: utils.fs.createDirentFromStats(pattern, stats)
        };
        if (this._settings.stats) {
          entry.stats = stats;
        }
        return entry;
      }
      _isFatalError(error) {
        return !utils.errno.isEnoentCodeError(error) && !this._settings.suppressErrors;
      }
    };
    exports2.default = Reader;
  }
});

// node_modules/fast-glob/out/readers/stream.js
var require_stream3 = __commonJS({
  "node_modules/fast-glob/out/readers/stream.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var stream_1 = require("stream");
    var fsStat = require_out();
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var ReaderStream = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkStream = fsWalk.walkStream;
        this._stat = fsStat.stat;
      }
      dynamic(root, options) {
        return this._walkStream(root, options);
      }
      static(patterns, options) {
        const filepaths = patterns.map(this._getFullEntryPath, this);
        const stream = new stream_1.PassThrough({ objectMode: true });
        stream._write = (index, _enc, done) => {
          return this._getEntry(filepaths[index], patterns[index], options).then((entry) => {
            if (entry !== null && options.entryFilter(entry)) {
              stream.push(entry);
            }
            if (index === filepaths.length - 1) {
              stream.end();
            }
            done();
          }).catch(done);
        };
        for (let i = 0; i < filepaths.length; i++) {
          stream.write(i);
        }
        return stream;
      }
      _getEntry(filepath, pattern, options) {
        return this._getStat(filepath).then((stats) => this._makeEntry(stats, pattern)).catch((error) => {
          if (options.errorFilter(error)) {
            return null;
          }
          throw error;
        });
      }
      _getStat(filepath) {
        return new Promise((resolve, reject) => {
          this._stat(filepath, this._fsStatSettings, (error, stats) => {
            return error === null ? resolve(stats) : reject(error);
          });
        });
      }
    };
    exports2.default = ReaderStream;
  }
});

// node_modules/fast-glob/out/readers/async.js
var require_async5 = __commonJS({
  "node_modules/fast-glob/out/readers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var stream_1 = require_stream3();
    var ReaderAsync = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkAsync = fsWalk.walk;
        this._readerStream = new stream_1.default(this._settings);
      }
      dynamic(root, options) {
        return new Promise((resolve, reject) => {
          this._walkAsync(root, options, (error, entries) => {
            if (error === null) {
              resolve(entries);
            } else {
              reject(error);
            }
          });
        });
      }
      async static(patterns, options) {
        const entries = [];
        const stream = this._readerStream.static(patterns, options);
        return new Promise((resolve, reject) => {
          stream.once("error", reject);
          stream.on("data", (entry) => entries.push(entry));
          stream.once("end", () => resolve(entries));
        });
      }
    };
    exports2.default = ReaderAsync;
  }
});

// node_modules/fast-glob/out/providers/matchers/matcher.js
var require_matcher = __commonJS({
  "node_modules/fast-glob/out/providers/matchers/matcher.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils = require_utils3();
    var Matcher = class {
      constructor(_patterns, _settings, _micromatchOptions) {
        this._patterns = _patterns;
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
        this._storage = [];
        this._fillStorage();
      }
      _fillStorage() {
        for (const pattern of this._patterns) {
          const segments = this._getPatternSegments(pattern);
          const sections = this._splitSegmentsIntoSections(segments);
          this._storage.push({
            complete: sections.length <= 1,
            pattern,
            segments,
            sections
          });
        }
      }
      _getPatternSegments(pattern) {
        const parts = utils.pattern.getPatternParts(pattern, this._micromatchOptions);
        return parts.map((part) => {
          const dynamic = utils.pattern.isDynamicPattern(part, this._settings);
          if (!dynamic) {
            return {
              dynamic: false,
              pattern: part
            };
          }
          return {
            dynamic: true,
            pattern: part,
            patternRe: utils.pattern.makeRe(part, this._micromatchOptions)
          };
        });
      }
      _splitSegmentsIntoSections(segments) {
        return utils.array.splitWhen(segments, (segment) => segment.dynamic && utils.pattern.hasGlobStar(segment.pattern));
      }
    };
    exports2.default = Matcher;
  }
});

// node_modules/fast-glob/out/providers/matchers/partial.js
var require_partial = __commonJS({
  "node_modules/fast-glob/out/providers/matchers/partial.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var matcher_1 = require_matcher();
    var PartialMatcher = class extends matcher_1.default {
      match(filepath) {
        const parts = filepath.split("/");
        const levels = parts.length;
        const patterns = this._storage.filter((info) => !info.complete || info.segments.length > levels);
        for (const pattern of patterns) {
          const section = pattern.sections[0];
          if (!pattern.complete && levels > section.length) {
            return true;
          }
          const match = parts.every((part, index) => {
            const segment = pattern.segments[index];
            if (segment.dynamic && segment.patternRe.test(part)) {
              return true;
            }
            if (!segment.dynamic && segment.pattern === part) {
              return true;
            }
            return false;
          });
          if (match) {
            return true;
          }
        }
        return false;
      }
    };
    exports2.default = PartialMatcher;
  }
});

// node_modules/fast-glob/out/providers/filters/deep.js
var require_deep = __commonJS({
  "node_modules/fast-glob/out/providers/filters/deep.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils = require_utils3();
    var partial_1 = require_partial();
    var DeepFilter = class {
      constructor(_settings, _micromatchOptions) {
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
      }
      getFilter(basePath, positive, negative) {
        const matcher = this._getMatcher(positive);
        const negativeRe = this._getNegativePatternsRe(negative);
        return (entry) => this._filter(basePath, entry, matcher, negativeRe);
      }
      _getMatcher(patterns) {
        return new partial_1.default(patterns, this._settings, this._micromatchOptions);
      }
      _getNegativePatternsRe(patterns) {
        const affectDepthOfReadingPatterns = patterns.filter(utils.pattern.isAffectDepthOfReadingPattern);
        return utils.pattern.convertPatternsToRe(affectDepthOfReadingPatterns, this._micromatchOptions);
      }
      _filter(basePath, entry, matcher, negativeRe) {
        if (this._isSkippedByDeep(basePath, entry.path)) {
          return false;
        }
        if (this._isSkippedSymbolicLink(entry)) {
          return false;
        }
        const filepath = utils.path.removeLeadingDotSegment(entry.path);
        if (this._isSkippedByPositivePatterns(filepath, matcher)) {
          return false;
        }
        return this._isSkippedByNegativePatterns(filepath, negativeRe);
      }
      _isSkippedByDeep(basePath, entryPath) {
        if (this._settings.deep === Infinity) {
          return false;
        }
        return this._getEntryLevel(basePath, entryPath) >= this._settings.deep;
      }
      _getEntryLevel(basePath, entryPath) {
        const entryPathDepth = entryPath.split("/").length;
        if (basePath === "") {
          return entryPathDepth;
        }
        const basePathDepth = basePath.split("/").length;
        return entryPathDepth - basePathDepth;
      }
      _isSkippedSymbolicLink(entry) {
        return !this._settings.followSymbolicLinks && entry.dirent.isSymbolicLink();
      }
      _isSkippedByPositivePatterns(entryPath, matcher) {
        return !this._settings.baseNameMatch && !matcher.match(entryPath);
      }
      _isSkippedByNegativePatterns(entryPath, patternsRe) {
        return !utils.pattern.matchAny(entryPath, patternsRe);
      }
    };
    exports2.default = DeepFilter;
  }
});

// node_modules/fast-glob/out/providers/filters/entry.js
var require_entry = __commonJS({
  "node_modules/fast-glob/out/providers/filters/entry.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils = require_utils3();
    var EntryFilter = class {
      constructor(_settings, _micromatchOptions) {
        this._settings = _settings;
        this._micromatchOptions = _micromatchOptions;
        this.index = /* @__PURE__ */ new Map();
      }
      getFilter(positive, negative) {
        const positiveRe = utils.pattern.convertPatternsToRe(positive, this._micromatchOptions);
        const negativeRe = utils.pattern.convertPatternsToRe(negative, Object.assign(Object.assign({}, this._micromatchOptions), { dot: true }));
        return (entry) => this._filter(entry, positiveRe, negativeRe);
      }
      _filter(entry, positiveRe, negativeRe) {
        const filepath = utils.path.removeLeadingDotSegment(entry.path);
        if (this._settings.unique && this._isDuplicateEntry(filepath)) {
          return false;
        }
        if (this._onlyFileFilter(entry) || this._onlyDirectoryFilter(entry)) {
          return false;
        }
        if (this._isSkippedByAbsoluteNegativePatterns(filepath, negativeRe)) {
          return false;
        }
        const isDirectory = entry.dirent.isDirectory();
        const isMatched = this._isMatchToPatterns(filepath, positiveRe, isDirectory) && !this._isMatchToPatterns(filepath, negativeRe, isDirectory);
        if (this._settings.unique && isMatched) {
          this._createIndexRecord(filepath);
        }
        return isMatched;
      }
      _isDuplicateEntry(filepath) {
        return this.index.has(filepath);
      }
      _createIndexRecord(filepath) {
        this.index.set(filepath, void 0);
      }
      _onlyFileFilter(entry) {
        return this._settings.onlyFiles && !entry.dirent.isFile();
      }
      _onlyDirectoryFilter(entry) {
        return this._settings.onlyDirectories && !entry.dirent.isDirectory();
      }
      _isSkippedByAbsoluteNegativePatterns(entryPath, patternsRe) {
        if (!this._settings.absolute) {
          return false;
        }
        const fullpath = utils.path.makeAbsolute(this._settings.cwd, entryPath);
        return utils.pattern.matchAny(fullpath, patternsRe);
      }
      _isMatchToPatterns(filepath, patternsRe, isDirectory) {
        const isMatched = utils.pattern.matchAny(filepath, patternsRe);
        if (!isMatched && isDirectory) {
          return utils.pattern.matchAny(filepath + "/", patternsRe);
        }
        return isMatched;
      }
    };
    exports2.default = EntryFilter;
  }
});

// node_modules/fast-glob/out/providers/filters/error.js
var require_error = __commonJS({
  "node_modules/fast-glob/out/providers/filters/error.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils = require_utils3();
    var ErrorFilter = class {
      constructor(_settings) {
        this._settings = _settings;
      }
      getFilter() {
        return (error) => this._isNonFatalError(error);
      }
      _isNonFatalError(error) {
        return utils.errno.isEnoentCodeError(error) || this._settings.suppressErrors;
      }
    };
    exports2.default = ErrorFilter;
  }
});

// node_modules/fast-glob/out/providers/transformers/entry.js
var require_entry2 = __commonJS({
  "node_modules/fast-glob/out/providers/transformers/entry.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var utils = require_utils3();
    var EntryTransformer = class {
      constructor(_settings) {
        this._settings = _settings;
      }
      getTransformer() {
        return (entry) => this._transform(entry);
      }
      _transform(entry) {
        let filepath = entry.path;
        if (this._settings.absolute) {
          filepath = utils.path.makeAbsolute(this._settings.cwd, filepath);
          filepath = utils.path.unixify(filepath);
        }
        if (this._settings.markDirectories && entry.dirent.isDirectory()) {
          filepath += "/";
        }
        if (!this._settings.objectMode) {
          return filepath;
        }
        return Object.assign(Object.assign({}, entry), { path: filepath });
      }
    };
    exports2.default = EntryTransformer;
  }
});

// node_modules/fast-glob/out/providers/provider.js
var require_provider = __commonJS({
  "node_modules/fast-glob/out/providers/provider.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var path2 = require("path");
    var deep_1 = require_deep();
    var entry_1 = require_entry();
    var error_1 = require_error();
    var entry_2 = require_entry2();
    var Provider = class {
      constructor(_settings) {
        this._settings = _settings;
        this.errorFilter = new error_1.default(this._settings);
        this.entryFilter = new entry_1.default(this._settings, this._getMicromatchOptions());
        this.deepFilter = new deep_1.default(this._settings, this._getMicromatchOptions());
        this.entryTransformer = new entry_2.default(this._settings);
      }
      _getRootDirectory(task) {
        return path2.resolve(this._settings.cwd, task.base);
      }
      _getReaderOptions(task) {
        const basePath = task.base === "." ? "" : task.base;
        return {
          basePath,
          pathSegmentSeparator: "/",
          concurrency: this._settings.concurrency,
          deepFilter: this.deepFilter.getFilter(basePath, task.positive, task.negative),
          entryFilter: this.entryFilter.getFilter(task.positive, task.negative),
          errorFilter: this.errorFilter.getFilter(),
          followSymbolicLinks: this._settings.followSymbolicLinks,
          fs: this._settings.fs,
          stats: this._settings.stats,
          throwErrorOnBrokenSymbolicLink: this._settings.throwErrorOnBrokenSymbolicLink,
          transform: this.entryTransformer.getTransformer()
        };
      }
      _getMicromatchOptions() {
        return {
          dot: this._settings.dot,
          matchBase: this._settings.baseNameMatch,
          nobrace: !this._settings.braceExpansion,
          nocase: !this._settings.caseSensitiveMatch,
          noext: !this._settings.extglob,
          noglobstar: !this._settings.globstar,
          posix: true,
          strictSlashes: false
        };
      }
    };
    exports2.default = Provider;
  }
});

// node_modules/fast-glob/out/providers/async.js
var require_async6 = __commonJS({
  "node_modules/fast-glob/out/providers/async.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var async_1 = require_async5();
    var provider_1 = require_provider();
    var ProviderAsync = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new async_1.default(this._settings);
      }
      async read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const entries = await this.api(root, task, options);
        return entries.map((entry) => options.transform(entry));
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports2.default = ProviderAsync;
  }
});

// node_modules/fast-glob/out/providers/stream.js
var require_stream4 = __commonJS({
  "node_modules/fast-glob/out/providers/stream.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var stream_1 = require("stream");
    var stream_2 = require_stream3();
    var provider_1 = require_provider();
    var ProviderStream = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new stream_2.default(this._settings);
      }
      read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const source = this.api(root, task, options);
        const destination = new stream_1.Readable({ objectMode: true, read: () => {
        } });
        source.once("error", (error) => destination.emit("error", error)).on("data", (entry) => destination.emit("data", options.transform(entry))).once("end", () => destination.emit("end"));
        destination.once("close", () => source.destroy());
        return destination;
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports2.default = ProviderStream;
  }
});

// node_modules/fast-glob/out/readers/sync.js
var require_sync5 = __commonJS({
  "node_modules/fast-glob/out/readers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var fsStat = require_out();
    var fsWalk = require_out3();
    var reader_1 = require_reader2();
    var ReaderSync = class extends reader_1.default {
      constructor() {
        super(...arguments);
        this._walkSync = fsWalk.walkSync;
        this._statSync = fsStat.statSync;
      }
      dynamic(root, options) {
        return this._walkSync(root, options);
      }
      static(patterns, options) {
        const entries = [];
        for (const pattern of patterns) {
          const filepath = this._getFullEntryPath(pattern);
          const entry = this._getEntry(filepath, pattern, options);
          if (entry === null || !options.entryFilter(entry)) {
            continue;
          }
          entries.push(entry);
        }
        return entries;
      }
      _getEntry(filepath, pattern, options) {
        try {
          const stats = this._getStat(filepath);
          return this._makeEntry(stats, pattern);
        } catch (error) {
          if (options.errorFilter(error)) {
            return null;
          }
          throw error;
        }
      }
      _getStat(filepath) {
        return this._statSync(filepath, this._fsStatSettings);
      }
    };
    exports2.default = ReaderSync;
  }
});

// node_modules/fast-glob/out/providers/sync.js
var require_sync6 = __commonJS({
  "node_modules/fast-glob/out/providers/sync.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var sync_1 = require_sync5();
    var provider_1 = require_provider();
    var ProviderSync = class extends provider_1.default {
      constructor() {
        super(...arguments);
        this._reader = new sync_1.default(this._settings);
      }
      read(task) {
        const root = this._getRootDirectory(task);
        const options = this._getReaderOptions(task);
        const entries = this.api(root, task, options);
        return entries.map(options.transform);
      }
      api(root, task, options) {
        if (task.dynamic) {
          return this._reader.dynamic(root, options);
        }
        return this._reader.static(task.patterns, options);
      }
    };
    exports2.default = ProviderSync;
  }
});

// node_modules/fast-glob/out/settings.js
var require_settings4 = __commonJS({
  "node_modules/fast-glob/out/settings.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DEFAULT_FILE_SYSTEM_ADAPTER = void 0;
    var fs2 = require("fs");
    var os = require("os");
    var CPU_COUNT = Math.max(os.cpus().length, 1);
    exports2.DEFAULT_FILE_SYSTEM_ADAPTER = {
      lstat: fs2.lstat,
      lstatSync: fs2.lstatSync,
      stat: fs2.stat,
      statSync: fs2.statSync,
      readdir: fs2.readdir,
      readdirSync: fs2.readdirSync
    };
    var Settings = class {
      constructor(_options = {}) {
        this._options = _options;
        this.absolute = this._getValue(this._options.absolute, false);
        this.baseNameMatch = this._getValue(this._options.baseNameMatch, false);
        this.braceExpansion = this._getValue(this._options.braceExpansion, true);
        this.caseSensitiveMatch = this._getValue(this._options.caseSensitiveMatch, true);
        this.concurrency = this._getValue(this._options.concurrency, CPU_COUNT);
        this.cwd = this._getValue(this._options.cwd, process.cwd());
        this.deep = this._getValue(this._options.deep, Infinity);
        this.dot = this._getValue(this._options.dot, false);
        this.extglob = this._getValue(this._options.extglob, true);
        this.followSymbolicLinks = this._getValue(this._options.followSymbolicLinks, true);
        this.fs = this._getFileSystemMethods(this._options.fs);
        this.globstar = this._getValue(this._options.globstar, true);
        this.ignore = this._getValue(this._options.ignore, []);
        this.markDirectories = this._getValue(this._options.markDirectories, false);
        this.objectMode = this._getValue(this._options.objectMode, false);
        this.onlyDirectories = this._getValue(this._options.onlyDirectories, false);
        this.onlyFiles = this._getValue(this._options.onlyFiles, true);
        this.stats = this._getValue(this._options.stats, false);
        this.suppressErrors = this._getValue(this._options.suppressErrors, false);
        this.throwErrorOnBrokenSymbolicLink = this._getValue(this._options.throwErrorOnBrokenSymbolicLink, false);
        this.unique = this._getValue(this._options.unique, true);
        if (this.onlyDirectories) {
          this.onlyFiles = false;
        }
        if (this.stats) {
          this.objectMode = true;
        }
        this.ignore = [].concat(this.ignore);
      }
      _getValue(option, value) {
        return option === void 0 ? value : option;
      }
      _getFileSystemMethods(methods = {}) {
        return Object.assign(Object.assign({}, exports2.DEFAULT_FILE_SYSTEM_ADAPTER), methods);
      }
    };
    exports2.default = Settings;
  }
});

// node_modules/fast-glob/out/index.js
var require_out4 = __commonJS({
  "node_modules/fast-glob/out/index.js"(exports2, module2) {
    "use strict";
    var taskManager = require_tasks();
    var async_1 = require_async6();
    var stream_1 = require_stream4();
    var sync_1 = require_sync6();
    var settings_1 = require_settings4();
    var utils = require_utils3();
    async function FastGlob(source, options) {
      assertPatternsInput(source);
      const works = getWorks(source, async_1.default, options);
      const result = await Promise.all(works);
      return utils.array.flatten(result);
    }
    (function(FastGlob2) {
      FastGlob2.glob = FastGlob2;
      FastGlob2.globSync = sync;
      FastGlob2.globStream = stream;
      FastGlob2.async = FastGlob2;
      function sync(source, options) {
        assertPatternsInput(source);
        const works = getWorks(source, sync_1.default, options);
        return utils.array.flatten(works);
      }
      FastGlob2.sync = sync;
      function stream(source, options) {
        assertPatternsInput(source);
        const works = getWorks(source, stream_1.default, options);
        return utils.stream.merge(works);
      }
      FastGlob2.stream = stream;
      function generateTasks(source, options) {
        assertPatternsInput(source);
        const patterns = [].concat(source);
        const settings = new settings_1.default(options);
        return taskManager.generate(patterns, settings);
      }
      FastGlob2.generateTasks = generateTasks;
      function isDynamicPattern(source, options) {
        assertPatternsInput(source);
        const settings = new settings_1.default(options);
        return utils.pattern.isDynamicPattern(source, settings);
      }
      FastGlob2.isDynamicPattern = isDynamicPattern;
      function escapePath(source) {
        assertPatternsInput(source);
        return utils.path.escape(source);
      }
      FastGlob2.escapePath = escapePath;
      function convertPathToPattern(source) {
        assertPatternsInput(source);
        return utils.path.convertPathToPattern(source);
      }
      FastGlob2.convertPathToPattern = convertPathToPattern;
      let posix;
      (function(posix2) {
        function escapePath2(source) {
          assertPatternsInput(source);
          return utils.path.escapePosixPath(source);
        }
        posix2.escapePath = escapePath2;
        function convertPathToPattern2(source) {
          assertPatternsInput(source);
          return utils.path.convertPosixPathToPattern(source);
        }
        posix2.convertPathToPattern = convertPathToPattern2;
      })(posix = FastGlob2.posix || (FastGlob2.posix = {}));
      let win32;
      (function(win322) {
        function escapePath2(source) {
          assertPatternsInput(source);
          return utils.path.escapeWindowsPath(source);
        }
        win322.escapePath = escapePath2;
        function convertPathToPattern2(source) {
          assertPatternsInput(source);
          return utils.path.convertWindowsPathToPattern(source);
        }
        win322.convertPathToPattern = convertPathToPattern2;
      })(win32 = FastGlob2.win32 || (FastGlob2.win32 = {}));
    })(FastGlob || (FastGlob = {}));
    function getWorks(source, _Provider, options) {
      const patterns = [].concat(source);
      const settings = new settings_1.default(options);
      const tasks = taskManager.generate(patterns, settings);
      const provider = new _Provider(settings);
      return tasks.map(provider.read, provider);
    }
    function assertPatternsInput(input) {
      const source = [].concat(input);
      const isValidSource = source.every((item) => utils.string.isString(item) && !utils.string.isEmpty(item));
      if (!isValidSource) {
        throw new TypeError("Patterns must be a string (non empty) or an array of strings");
      }
    }
    module2.exports = FastGlob;
  }
});

// electron/main.ts
var path = require("node:path");
var crypto = require("node:crypto");
var http = require("node:http");
var {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell
} = require("electron");
var fs = require("node:fs");
var BUILTIN_API_ADMIN_PASSWORD_HASH = "d4f31b6def1e6e11148cbab15b400e91528ab18880b25225d9a9f840d4d0d192";
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}
function getPortableExecutableDir() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  return portableDir ? path.resolve(portableDir) : null;
}
function getAppRootDir() {
  const overrideDir = String(process.env.INFINIO_APP_ROOT_DIR || "").trim();
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  if (app.isPackaged) {
    return getPortableExecutableDir() || path.dirname(process.execPath);
  }
  return path.resolve(__dirname, "..");
}
var APP_ROOT_DIR = getAppRootDir();
var APP_LOGS_DIR = ensureDir(path.join(APP_ROOT_DIR, "logs"));
var STARTUP_LOG_PATH = path.join(APP_LOGS_DIR, "infinio-startup.log");
var APP_TEMP_DIR = ensureDir(path.join(APP_ROOT_DIR, "temp"));
var APP_USER_DATA_DIR = ensureDir(path.join(APP_ROOT_DIR, "userData"));
var APP_DB_DIR = ensureDir(path.join(APP_ROOT_DIR, "db"));
var DEV_SERVER_WARMUP_POLL_INTERVAL_MS = 1e3;
var DEV_SERVER_WARMUP_REQUEST_TIMEOUT_MS = 12e4;
var DEV_SERVER_WARMUP_TIMEOUT_MS = 5 * 6e4;
var mainWindow = null;
var tray = null;
var devLauncherWatchdog = null;
var watchedDevServerPid = null;
var allowTestMultiInstance = String(process.env.HOME_AGENT_ALLOW_TEST_MULTI_INSTANCE || "").trim() === "1";
var singleInstanceLock = allowTestMultiInstance ? true : app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}
var INFINIO_USER_DATA = (() => {
  try {
    app.setPath("userData", APP_USER_DATA_DIR);
    app.setPath("sessionData", ensureDir(path.join(APP_ROOT_DIR, "sessionData")));
    app.setPath("crashDumps", ensureDir(path.join(APP_ROOT_DIR, "crashDumps")));
    app.setPath("temp", APP_TEMP_DIR);
  } catch {
  }
  return APP_USER_DATA_DIR;
})();
var GPU_DISABLE_FLAG = path.join(INFINIO_USER_DATA, ".disable-gpu");
var GPU_DISABLED = fs.existsSync(GPU_DISABLE_FLAG);
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("safebrowsing-disable-auto-update");
var REMOTE_DEBUGGING_PORT = String(process.env.HOME_AGENT_ELECTRON_REMOTE_DEBUGGING_PORT || "").trim();
if (/^\d+$/.test(REMOTE_DEBUGGING_PORT)) {
  app.commandLine.appendSwitch("remote-debugging-port", REMOTE_DEBUGGING_PORT);
}
if (GPU_DISABLED) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  console.warn("[main] GPU \u5BB8\u832C\uE6E6\u9422\uE7D2\u7D1D\u6D63\u8DE8\u6564\u675E\uE219\u6B22\u5A13\u53C9\u714B\u59AF\u2033\u7D21");
}
function getUserDataPath() {
  return app.getPath("userData");
}
function parseEnvPid(value) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function readSmokeSelectFolderOverride() {
  const raw = String(process.env.HOME_AGENT_SMOKE_SELECT_FOLDER || "").trim();
  if (!raw) return null;
  return path.resolve(raw);
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function killProcessTree(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      const { spawn } = require("node:child_process");
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", () => {
      });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
  }
}
function stopDevLauncherWatchdog() {
  if (devLauncherWatchdog) {
    clearInterval(devLauncherWatchdog);
    devLauncherWatchdog = null;
  }
}
function startDevLauncherWatchdog() {
  if (app.isPackaged) return;
  const launcherPid = parseEnvPid(process.env.INFINIO_DEV_LAUNCH_PID);
  watchedDevServerPid = parseEnvPid(process.env.INFINIO_DEV_SERVER_PID);
  if (!launcherPid) return;
  stopDevLauncherWatchdog();
  devLauncherWatchdog = setInterval(() => {
    if (processExists(launcherPid)) return;
    stopDevLauncherWatchdog();
    if (watchedDevServerPid) {
      killProcessTree(watchedDevServerPid);
      watchedDevServerPid = null;
    }
    app.quit();
  }, 2e3);
}
function getDefaultFilesDir() {
  return path.join(APP_ROOT_DIR, "files");
}
function getBundledFilesDir() {
  if (!app.isPackaged) return null;
  return path.join(process.resourcesPath, "files");
}
function copyMissingFiles(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  const stat = fs.statSync(sourceDir);
  if (!stat.isDirectory()) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingFiles(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || fs.existsSync(targetPath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}
function seedRuntimeFilesDirFromBundle(filesDir) {
  const bundledFilesDir = getBundledFilesDir();
  if (!bundledFilesDir) return;
  const markerPath = path.join(filesDir, ".seeded-from-bundle-v1");
  if (fs.existsSync(markerPath)) return;
  try {
    const source = path.resolve(bundledFilesDir);
    const target = path.resolve(filesDir);
    if (source === target || !fs.existsSync(source)) return;
    copyMissingFiles(source, target);
    fs.writeFileSync(markerPath, (/* @__PURE__ */ new Date()).toISOString(), "utf8");
    log("info", `seeded runtime files from bundled resources: ${source} -> ${target}`);
  } catch (error) {
    log("warn", `failed to seed bundled files: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function log(level, msg) {
  const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(STARTUP_LOG_PATH, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
function isExpectedDevServer(body) {
  return body.includes('<div id="root"></div>') && body.includes("/src/main.tsx");
}
function isExpectedMainModule(body) {
  return body.includes("createRoot") && body.includes("App from") && body.includes("/src/App.tsx");
}
function probeDevServerOnce(devUrl) {
  return new Promise((resolve) => {
    const mainModuleUrl = new URL("/src/main.tsx", devUrl).toString();
    const requestTextOnce = (targetUrl) => new Promise((innerResolve) => {
      const request = http.get(targetUrl, (response) => {
        const chunks = [];
        response.on("data", (chunk) => {
          if (typeof chunk === "undefined") return;
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          innerResolve({
            reachable: true,
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      });
      request.setTimeout(DEV_SERVER_WARMUP_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error("probe timeout"));
      });
      request.on("error", () => {
        innerResolve({
          reachable: false,
          statusCode: 0,
          body: ""
        });
      });
    });
    void (async () => {
      const pageProbe = await requestTextOnce(devUrl);
      const pageReusable = pageProbe.reachable && pageProbe.statusCode >= 200 && pageProbe.statusCode < 300 && isExpectedDevServer(pageProbe.body);
      if (!pageReusable) {
        resolve({
          reachable: pageProbe.reachable,
          reusable: false
        });
        return;
      }
      const mainModuleProbe = await requestTextOnce(mainModuleUrl);
      const mainModuleReusable = mainModuleProbe.reachable && mainModuleProbe.statusCode >= 200 && mainModuleProbe.statusCode < 300 && isExpectedMainModule(mainModuleProbe.body);
      resolve({
        reachable: true,
        reusable: mainModuleReusable
      });
    })();
  });
}
async function waitForReusableDevServer(devUrl, win) {
  const deadline = Date.now() + DEV_SERVER_WARMUP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (win.isDestroyed()) {
      return false;
    }
    const probe = await probeDevServerOnce(devUrl);
    if (probe.reusable) {
      return true;
    }
    if (win.isDestroyed()) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_WARMUP_POLL_INTERVAL_MS));
  }
  return false;
}
async function loadDevWarmupPage(win) {
  const warmupPath = path.join(__dirname, "dev-warmup.html");
  log("info", `loading dev warmup page: ${warmupPath}`);
  await win.loadFile(warmupPath);
}
async function transitionWarmupWindowToDevServer(win, devUrl) {
  const ready = await waitForReusableDevServer(devUrl, win);
  if (!ready) {
    if (!win.isDestroyed()) {
      log("error", `timed out waiting for reusable dev server at ${devUrl}`);
    }
    return;
  }
  if (win.isDestroyed()) {
    return;
  }
  try {
    log("info", `dev warmup complete, loading live url: ${devUrl}`);
    await win.loadURL(devUrl);
    if (process.env.ELECTRON_OPEN_DEVTOOLS === "1" && !win.isDestroyed()) {
      win.webContents.openDevTools();
    }
  } catch (error) {
    if (!win.isDestroyed()) {
      log("error", `failed to load live dev url: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
process.on("uncaughtException", (error) => {
  log(
    "fatal",
    `uncaughtException: ${error instanceof Error ? error.stack || error.message : String(error)}`
  );
});
process.on("unhandledRejection", (reason) => {
  log(
    "fatal",
    `unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`
  );
});
function verifyBuiltinApiAdminPassword(password) {
  if (typeof password !== "string" || !password) {
    return false;
  }
  const actualHash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(BUILTIN_API_ADMIN_PASSWORD_HASH, "hex");
  const actualBuffer = Buffer.from(actualHash, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
function setupIPC() {
  ipcMain.handle(
    "runtime:verifyBuiltinApiAdminPassword",
    (_event, password) => verifyBuiltinApiAdminPassword(password)
  );
  ipcMain.handle("runtime:getGpuMode", () => ({
    softwareRendering: GPU_DISABLED,
    flagPath: GPU_DISABLE_FLAG
  }));
  ipcMain.handle("runtime:resetGpuFlag", () => {
    try {
      if (fs.existsSync(GPU_DISABLE_FLAG)) fs.unlinkSync(GPU_DISABLE_FLAG);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle("crash:getLogs", () => {
    const crashLogPath = path.join(getUserDataPath(), "crash-log.json");
    try {
      if (fs.existsSync(crashLogPath)) {
        const logs = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
        return { ok: true, logs };
      }
      return { ok: true, logs: [] };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle(
    "jimeng:writeFile",
    async (_event, { filePath, content }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(content, "base64"));
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle("storage:getDefaultPath", () => {
    const filesDir = getDefaultFilesDir();
    try {
      fs.mkdirSync(filesDir, { recursive: true });
      seedRuntimeFilesDirFromBundle(filesDir);
    } catch {
    }
    return {
      files: filesDir,
      db: APP_DB_DIR
    };
  });
  ipcMain.handle("storage:selectFolder", async () => {
    const smokeFolderOverride = readSmokeSelectFolderOverride();
    if (smokeFolderOverride) {
      fs.mkdirSync(smokeFolderOverride, { recursive: true });
      return smokeFolderOverride;
    }
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "\u9009\u62E9\u5B58\u50A8\u6587\u4EF6\u5939"
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle("storage:openFolder", (_event, folderPath) => {
    const normalizedPath = path.normalize(folderPath);
    return shell.openPath(normalizedPath);
  });
  ipcMain.handle("storage:openPath", (_event, targetPath) => {
    const normalizedPath = path.normalize(targetPath);
    try {
      const stat = fs.statSync(normalizedPath);
      if (stat.isFile()) {
        shell.showItemInFolder(normalizedPath);
        return Promise.resolve("");
      }
    } catch {
    }
    return shell.openPath(normalizedPath);
  });
  ipcMain.handle(
    "storage:writeText",
    async (_event, { filePath, content }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, content, "utf8");
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:saveBinaryFile",
    async (_event, params) => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showSaveDialog(mainWindow, {
          title: "\u6DC7\u6FC6\u74E8\u93C2\u56E6\u6B22",
          defaultPath: params.defaultFileName,
          filters: Array.isArray(params.filters) ? params.filters : void 0
        });
        if (result.canceled || !result.filePath) {
          return { ok: true, cancelled: true, filePath: null };
        }
        const normalizedPath = path.normalize(result.filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(params.base64, "base64"));
        return { ok: true, cancelled: false, filePath: normalizedPath };
      } catch (error) {
        return {
          ok: false,
          cancelled: false,
          filePath: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:writeBase64File",
    async (_event, { filePath, base64 }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
        fs.writeFileSync(normalizedPath, Buffer.from(base64, "base64"));
        return { ok: true, filePath: normalizedPath };
      } catch (error) {
        return {
          ok: false,
          filePath: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:copyFile",
    async (_event, { sourcePath, destPath }) => {
      try {
        const normalizedSource = path.normalize(sourcePath);
        const normalizedDest = path.normalize(destPath);
        fs.mkdirSync(path.dirname(normalizedDest), { recursive: true });
        fs.copyFileSync(normalizedSource, normalizedDest);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:readText",
    async (_event, { filePath }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        if (!fs.existsSync(normalizedPath)) {
          return { ok: true, exists: false, content: "" };
        }
        return {
          ok: true,
          exists: true,
          content: fs.readFileSync(normalizedPath, "utf8")
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:readBase64",
    async (_event, { filePath }) => {
      try {
        const normalizedPath = path.normalize(filePath);
        if (!fs.existsSync(normalizedPath)) {
          return { ok: true, exists: false, base64: "" };
        }
        const ext = path.extname(normalizedPath).toLowerCase();
        const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : ext === ".mp4" ? "video/mp4" : "image/jpeg";
        return {
          ok: true,
          exists: true,
          base64: fs.readFileSync(normalizedPath).toString("base64"),
          mimeType
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle("storage:listDir", (_event, dirPath) => {
    try {
      const normalizedPath = path.normalize(dirPath);
      if (!fs.existsSync(normalizedPath)) return { ok: true, entries: [] };
      const entries = fs.readdirSync(normalizedPath, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory()
      }));
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("storage:deleteFile", (_event, filePath) => {
    try {
      const normalizedPath = path.normalize(filePath);
      if (!fs.existsSync(normalizedPath)) return { ok: true };
      fs.unlinkSync(normalizedPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("storage:deleteDir", (_event, dirPath) => {
    try {
      const normalizedPath = path.normalize(dirPath);
      if (!fs.existsSync(normalizedPath)) return { ok: true };
      fs.rmSync(normalizedPath, { recursive: true, force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(
    "storage:selectFile",
    async (_event, { filters }) => {
      const { dialog } = require("electron");
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openFile"],
        filters: filters ?? []
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    }
  );
  ipcMain.handle(
    "storage:exportChatHistory",
    async (_event, { sourceDir, destDir, sessionJson, fileName }) => {
      try {
        const normalizedDest = path.normalize(destDir);
        const chatHistoryFilePath = path.join(normalizedDest, `${fileName}.json`);
        fs.mkdirSync(normalizedDest, { recursive: true });
        fs.writeFileSync(chatHistoryFilePath, sessionJson, "utf8");
        const normalizedSource = typeof sourceDir === "string" && sourceDir.trim().length > 0 ? path.normalize(sourceDir) : "";
        if (normalizedSource && fs.existsSync(normalizedSource)) {
          const mediaDir = path.join(normalizedDest, "media");
          fs.cpSync(normalizedSource, mediaDir, { recursive: true });
        }
        return { ok: true, destDir: normalizedDest, chatHistoryFilePath };
      } catch (error) {
        return {
          ok: false,
          reason: "write-failed",
          destDir: "",
          chatHistoryFilePath: "",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "storage:importChatHistory",
    async (_event, { filePath, targetProjectDir }) => {
      try {
        const normalizedFilePath = path.normalize(filePath);
        if (!fs.existsSync(normalizedFilePath)) {
          return { ok: false, reason: "chat-history-missing", error: "chat-history.json \u6587\u4EF6\u4E0D\u5B58\u5728" };
        }
        const content = fs.readFileSync(normalizedFilePath, "utf8");
        const normalizedDir = path.dirname(normalizedFilePath);
        let importedMediaDir;
        const mediaDir = path.join(normalizedDir, "media");
        const normalizedTargetProjectDir = typeof targetProjectDir === "string" && targetProjectDir.trim() ? path.normalize(targetProjectDir) : "";
        if (normalizedTargetProjectDir && fs.existsSync(mediaDir)) {
          try {
            fs.mkdirSync(normalizedTargetProjectDir, { recursive: true });
            fs.cpSync(mediaDir, normalizedTargetProjectDir, { recursive: true, force: true });
            importedMediaDir = normalizedTargetProjectDir;
          } catch (error) {
            return {
              ok: false,
              reason: "import-copy-failed",
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        return { ok: true, content, importedMediaDir };
      } catch (error) {
        return { ok: false, reason: "unknown", error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  const { QueryEngine: QueryEngine2 } = (init_query_engine(), __toCommonJS(query_engine_exports));
  const agentSessions = /* @__PURE__ */ new Map();
  ipcMain.handle(
    "agent:callModelApi",
    async (_event, {
      url,
      apiKey,
      requestParams
    }) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestParams)
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return {
            ok: false,
            error: `Model request failed (${response.status}): ${text.slice(0, 300) || response.statusText}`
          };
        }
        return {
          ok: true,
          data: await response.json()
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "agent:callModelApiStream",
    async (event, {
      url,
      apiKey,
      requestParams,
      streamId
    }) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({ ...requestParams, stream: true })
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return {
            ok: false,
            error: `Model request failed (${response.status}): ${text.slice(0, 300) || response.statusText}`
          };
        }
        const reader = response.body?.getReader();
        if (!reader) return { ok: false, error: "No response body" };
        const decoder = new TextDecoder();
        let buffer = "";
        let accText = "";
        const contentBlocks = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let stopReason = "end_turn";
        let currentToolUse = null;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (event.sender.isDestroyed()) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              continue;
            }
            const type = evt.type;
            if (type === "content_block_start") {
              if (evt.content_block?.type === "tool_use") {
                currentToolUse = { id: evt.content_block.id, name: evt.content_block.name, inputJson: "" };
              }
            } else if (type === "content_block_delta") {
              if (evt.delta?.type === "text_delta") {
                const chunk = evt.delta.text;
                accText += chunk;
                if (!event.sender.isDestroyed()) {
                  event.sender.send("agent:stream-delta", { streamId, delta: chunk });
                }
              } else if (evt.delta?.type === "input_json_delta" && currentToolUse) {
                currentToolUse.inputJson += evt.delta.partial_json ?? "";
              }
            } else if (type === "content_block_stop") {
              if (currentToolUse) {
                let input = {};
                try {
                  input = JSON.parse(currentToolUse.inputJson);
                } catch {
                }
                contentBlocks.push({ type: "tool_use", id: currentToolUse.id, name: currentToolUse.name, input });
                currentToolUse = null;
              }
            } else if (type === "message_delta") {
              if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
            } else if (type === "message_start") {
              if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens;
            }
          }
        }
        if (accText) contentBlocks.unshift({ type: "text", text: accText });
        return {
          ok: true,
          data: {
            id: "stream",
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: requestParams.model,
            stop_reason: stopReason,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens }
          }
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "agent:submitMessage",
    async (event, {
      sessionId,
      prompt,
      config
    }) => {
      let engine = agentSessions.get(sessionId);
      if (!engine) {
        engine = new QueryEngine2(config);
        agentSessions.set(sessionId, engine);
      } else {
        if (config.apiKey) engine["config"].apiKey = config.apiKey;
        if (config.model) engine.setModel(config.model);
      }
      try {
        for await (const sdkMsg of engine.submitMessage(prompt)) {
          if (event.sender.isDestroyed()) break;
          event.sender.send("agent:event", { sessionId, message: sdkMsg });
        }
      } catch (err) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("agent:event", {
            sessionId,
            message: {
              type: "result",
              subtype: "success",
              isError: true,
              result: String(err),
              durationMs: 0,
              numTurns: 0,
              sessionId,
              totalCostUsd: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              uuid: crypto.randomUUID()
            }
          });
        }
      }
      return { ok: true };
    }
  );
  ipcMain.handle("agent:interrupt", (_event, { sessionId }) => {
    agentSessions.get(sessionId)?.interrupt();
    return { ok: true };
  });
  ipcMain.handle("agent:clearSession", (_event, { sessionId }) => {
    agentSessions.delete(sessionId);
    return { ok: true };
  });
  const glob = require_out4();
  const { exec, execFile, spawn } = require("node:child_process");
  const { promisify } = require("node:util");
  const execAsync = promisify(exec);
  const execFileAsync = promisify(execFile);
  async function resolveBinaryExecutable(binaryName) {
    const executableName = process.platform === "win32" && !binaryName.toLowerCase().endsWith(".exe") ? `${binaryName}.exe` : binaryName;
    const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
    const vendorCandidate = path.join(resourcesDir, "vendor", "ffmpeg", executableName);
    if (fs.existsSync(vendorCandidate)) return vendorCandidate;
    const bundledDir = "C:\\Program Files\\ffmpeg\\bin";
    const directCandidate = path.join(bundledDir, executableName);
    if (fs.existsSync(directCandidate)) return directCandidate;
    try {
      const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(lookupCommand, [binaryName], {
        windowsHide: true
      });
      return String(stdout).split(/\r?\n/).map((line) => line.trim()).find((line) => !!line && fs.existsSync(line)) || null;
    } catch {
      return null;
    }
  }
  ipcMain.handle(
    "media:extractVideoFrames",
    async (_event, {
      filePath,
      framePercents
    }) => {
      try {
        const normalizedPath = path.normalize(String(filePath || ""));
        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
          return { ok: false, error: `Video file not found: ${normalizedPath}` };
        }
        const ffmpegPath = await resolveBinaryExecutable("ffmpeg");
        const ffprobePath = await resolveBinaryExecutable("ffprobe");
        if (!ffmpegPath || !ffprobePath) {
          return { ok: false, error: "ffmpeg or ffprobe is not available" };
        }
        const probe = await execFileAsync(
          ffprobePath,
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            normalizedPath
          ],
          {
            windowsHide: true
          }
        );
        const duration = Number.parseFloat(String(probe.stdout || "").trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          return { ok: false, error: "Failed to read video duration" };
        }
        const percents = Array.isArray(framePercents) && framePercents.length ? framePercents.filter((value) => typeof value === "number" && Number.isFinite(value)).map((value) => Math.min(100, Math.max(0, value))) : [0, 15, 30, 50, 70, 90];
        const frameDir = path.join(
          app.getPath("temp"),
          "infinio-video-frames",
          crypto.randomUUID()
        );
        fs.mkdirSync(frameDir, { recursive: true });
        const framePaths = [];
        for (let index = 0; index < percents.length; index += 1) {
          const percent = percents[index] ?? 0;
          const seconds = Math.max(
            0,
            Math.min(duration * (percent / 100), Math.max(duration - 0.1, 0))
          );
          const outputPath = path.join(frameDir, `frame-${index + 1}.jpg`);
          await execFileAsync(
            ffmpegPath,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-ss",
              seconds.toFixed(3),
              "-i",
              normalizedPath,
              "-frames:v",
              "1",
              outputPath
            ],
            {
              windowsHide: true
            }
          );
          if (fs.existsSync(outputPath)) {
            framePaths.push(outputPath);
          }
        }
        if (!framePaths.length) {
          return { ok: false, error: "No frames were extracted" };
        }
        return {
          ok: true,
          framePaths
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  );
  ipcMain.handle(
    "ffmpeg:concatSegments",
    async (_event, {
      inputPaths,
      outputPath
    }) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg \u672A\u627E\u5230\uFF0C\u8BF7\u786E\u8BA4\u5DF2\u5B89\u88C5\u6216\u91CD\u65B0\u6253\u5305\u3002" };
        const validPaths = inputPaths.map((p) => path.normalize(p)).filter((p) => fs.existsSync(p));
        if (validPaths.length === 0) return { ok: false, error: "\u6CA1\u6709\u53EF\u7528\u7684\u8F93\u5165\u89C6\u9891\u6587\u4EF6\u3002" };
        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });
        const listFile = path.join(app.getPath("temp"), `infinio-concat-${Date.now()}.txt`);
        const listContent = validPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
        fs.writeFileSync(listFile, listContent, "utf8");
        await execFileAsync(
          ffmpegBin,
          ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", path.normalize(outputPath)],
          { windowsHide: true }
        );
        try {
          fs.unlinkSync(listFile);
        } catch {
        }
        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  ipcMain.handle(
    "ffmpeg:burnSubtitles",
    async (_event, {
      inputPath,
      outputPath,
      subtitleEntries
    }) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg \u672A\u627E\u5230\u3002" };
        const normalizedInput = path.normalize(inputPath);
        if (!fs.existsSync(normalizedInput)) return { ok: false, error: `\u6748\u64B3\u53C6\u93C2\u56E6\u6B22\u6D93\u5D85\u74E8\u9366? ${normalizedInput}` };
        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });
        const srtFile = path.join(app.getPath("temp"), `infinio-subs-${Date.now()}.srt`);
        const toSrtTime = (ms) => {
          const h = Math.floor(ms / 36e5);
          const m = Math.floor(ms % 36e5 / 6e4);
          const s = Math.floor(ms % 6e4 / 1e3);
          const ms2 = ms % 1e3;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms2).padStart(3, "0")}`;
        };
        const srtContent = subtitleEntries.map(
          (entry, i) => `${i + 1}
${toSrtTime(entry.startMs)} --> ${toSrtTime(entry.endMs)}
${entry.text}
`
        ).join("\n");
        fs.writeFileSync(srtFile, srtContent, "utf8");
        const escapedSrt = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:");
        await execFileAsync(
          ffmpegBin,
          ["-y", "-i", normalizedInput, "-vf", `subtitles='${escapedSrt}'`, "-c:a", "copy", path.normalize(outputPath)],
          { windowsHide: true }
        );
        try {
          fs.unlinkSync(srtFile);
        } catch {
        }
        return { ok: true, outputPath: path.normalize(outputPath) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  function cleanSrtDialogue(srtContent) {
    const parseMs = (ts) => {
      const [h, m, rest] = ts.split(":");
      const [s, ms] = rest.split(",");
      return +h * 36e5 + +m * 6e4 + +s * 1e3 + +ms;
    };
    const fmtMs = (ms) => {
      const h = Math.floor(ms / 36e5);
      const m = Math.floor(ms % 36e5 / 6e4);
      const s = Math.floor(ms % 6e4 / 1e3);
      const r = ms % 1e3;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
    };
    const blocks = srtContent.trim().split(/\n\n+/);
    const entries = [];
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 3) continue;
      const textLines = lines.slice(2).join("\n").trim();
      if (/^[\s(锛圽[銆愨櫔鈾玗*[\)锛塡]銆戔櫔鈾玕s]*$/.test(textLines)) continue;
      if (/^[\s(锛圽[銆怾.*[\)锛塡]銆慮\s*$/.test(textLines)) continue;
      if (textLines.replace(/[\s\p{P}]/gu, "").length < 1) continue;
      const [startStr, endStr] = lines[1].split(" --> ");
      entries.push({ startMs: parseMs(startStr.trim()), endMs: parseMs(endStr.trim()), text: textLines });
    }
    const deduped = [];
    for (const entry of entries) {
      const prev = deduped[deduped.length - 1];
      if (prev && entry.startMs < prev.endMs) {
        if (entry.text === prev.text || prev.text.includes(entry.text)) continue;
      }
      deduped.push(entry);
    }
    for (let i = 0; i < deduped.length - 1; i++) {
      if (deduped[i].endMs > deduped[i + 1].startMs) {
        deduped[i].endMs = deduped[i + 1].startMs;
      }
    }
    return deduped.map((e, i) => `${i + 1}
${fmtMs(e.startMs)} --> ${fmtMs(e.endMs)}
${e.text}`).join("\n\n") + "\n";
  }
  ipcMain.handle(
    "ffmpeg:smartConcat",
    async (_event, {
      inputPaths,
      outputPath,
      transitions,
      addSubtitles,
      subtitleEntries,
      whisperModelPath,
      language
    }) => {
      try {
        const ffmpegBin = await resolveBinaryExecutable("ffmpeg");
        if (!ffmpegBin) return { ok: false, error: "ffmpeg \u672A\u627E\u5230\u3002" };
        const validPaths = inputPaths.map((p) => path.normalize(p)).filter((p) => fs.existsSync(p));
        if (validPaths.length === 0) return { ok: false, error: "\u6CA1\u6709\u53EF\u7528\u7684\u8F93\u5165\u89C6\u9891\u6587\u4EF6\u3002" };
        fs.mkdirSync(path.dirname(path.normalize(outputPath)), { recursive: true });
        const tempDir = app.getPath("temp");
        const ts = Date.now();
        const ffprobeBin = await resolveBinaryExecutable("ffprobe");
        const durations = [];
        if (ffprobeBin) {
          for (const vp of validPaths) {
            try {
              const { stdout } = await execFileAsync(
                ffprobeBin,
                ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", vp],
                { windowsHide: true }
              );
              durations.push(parseFloat(stdout.trim()) || 5);
            } catch {
              durations.push(5);
            }
          }
        } else {
          validPaths.forEach(() => durations.push(5));
        }
        const concatOutput = path.join(tempDir, `infinio-smart-concat-${ts}.mp4`);
        if (validPaths.length === 1) {
          await execFileAsync(
            ffmpegBin,
            ["-y", "-i", validPaths[0], "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", concatOutput],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 }
          );
        } else {
          const effectiveTransitions = transitions.slice(0, validPaths.length - 1);
          while (effectiveTransitions.length < validPaths.length - 1) {
            effectiveTransitions.push({ type: "fade", duration: 0.5 });
          }
          const inputArgs = [];
          for (const vp of validPaths) {
            inputArgs.push("-i", vp);
          }
          const offsets = [];
          let cumulative = 0;
          for (let i = 0; i < validPaths.length - 1; i++) {
            cumulative += durations[i];
            const xfadeDur = effectiveTransitions[i].duration;
            offsets.push(Math.max(0, cumulative - xfadeDur));
            cumulative -= xfadeDur;
          }
          let filterGraph = "";
          let prevLabel = "[0:v]";
          for (let i = 0; i < validPaths.length - 1; i++) {
            const t = effectiveTransitions[i];
            const outLabel = i === validPaths.length - 2 ? "[vout]" : `[v${i + 1}]`;
            filterGraph += `${prevLabel}[${i + 1}:v]xfade=transition=${t.type}:duration=${t.duration}:offset=${offsets[i].toFixed(3)}${outLabel}`;
            if (i < validPaths.length - 2) filterGraph += ";";
            prevLabel = outLabel;
          }
          let audioFilter = "";
          let prevALabel = "[0:a]";
          for (let i = 0; i < validPaths.length - 1; i++) {
            const t = effectiveTransitions[i];
            const outALabel = i === validPaths.length - 2 ? "[aout]" : `[a${i + 1}]`;
            audioFilter += `${prevALabel}[${i + 1}:a]acrossfade=d=${t.duration}${outALabel}`;
            if (i < validPaths.length - 2) audioFilter += ";";
            prevALabel = outALabel;
          }
          const fullFilter = audioFilter ? `${filterGraph};${audioFilter}` : filterGraph;
          const mapArgs = audioFilter ? ["-map", "[vout]", "-map", "[aout]"] : ["-map", "[vout]", "-map", "0:a?"];
          await execFileAsync(
            ffmpegBin,
            [
              "-y",
              ...inputArgs,
              "-filter_complex",
              fullFilter,
              ...mapArgs,
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "18",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-b:a",
              "192k",
              concatOutput
            ],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 }
          );
        }
        if (!fs.existsSync(concatOutput)) {
          return { ok: false, error: "\u89C6\u9891\u62FC\u63A5\u5931\u8D25\uFF0C\u8F93\u51FA\u6587\u4EF6\u672A\u751F\u6210\u3002" };
        }
        let finalOutput = path.normalize(outputPath);
        const burnSrt = async (srtEntries) => {
          const toSrtTime = (ms) => {
            const h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4);
            const s = Math.floor(ms % 6e4 / 1e3), r = ms % 1e3;
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
          };
          const srtContent = srtEntries.map((e, i) => `${i + 1}
${toSrtTime(e.startMs)} --> ${toSrtTime(e.endMs)}
${e.text}`).join("\n\n") + "\n";
          const srtFile = path.join(tempDir, `infinio-subs-${ts}.srt`);
          fs.writeFileSync(srtFile, srtContent, "utf8");
          const subtitledOutput = path.join(tempDir, `infinio-subtitled-${ts}.mp4`);
          const escapedSrt = srtFile.replace(/\\/g, "/").replace(/:/g, "\\:");
          await execFileAsync(
            ffmpegBin,
            [
              "-y",
              "-i",
              concatOutput,
              "-vf",
              `subtitles='${escapedSrt}':force_style='FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=1,Shadow=1,Alignment=2'`,
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "18",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "copy",
              subtitledOutput
            ],
            { windowsHide: true, maxBuffer: 100 * 1024 * 1024 }
          );
          try {
            fs.unlinkSync(srtFile);
          } catch {
          }
          return subtitledOutput;
        };
        if (addSubtitles) {
          const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
          const resolvedModelPath = whisperModelPath ? path.normalize(whisperModelPath) : path.join(resourcesDir, "vendor", "ffmpeg", "ggml-small-q5_1.bin");
          if (!fs.existsSync(resolvedModelPath)) {
            fs.copyFileSync(concatOutput, finalOutput);
            try {
              fs.unlinkSync(concatOutput);
            } catch {
            }
            return { ok: true, outputPath: finalOutput, subtitleWarning: `whisper \u6A21\u578B\u672A\u627E\u5230\uFF08${resolvedModelPath}\uFF09\uFF0C\u5DF2\u8F93\u51FA\u65E0\u5B57\u5E55\u7248\u672C\u3002` };
          }
          const modelBasename = `ggml-model-${ts}.bin`;
          const modelInTemp = path.join(tempDir, modelBasename);
          const jsonBasename = `infinio-whisper-${ts}.json`;
          const jsonOutput = path.join(tempDir, jsonBasename);
          fs.copyFileSync(resolvedModelPath, modelInTemp);
          try {
            await execFileAsync(
              ffmpegBin,
              [
                "-y",
                "-i",
                concatOutput,
                "-af",
                `whisper=model=${modelBasename}:language=${language || "zh"}:format=json:destination=${jsonBasename}:max_len=15:queue=1`,
                "-f",
                "null",
                "-"
              ],
              { windowsHide: true, maxBuffer: 100 * 1024 * 1024, timeout: 3e5, cwd: tempDir }
            );
          } catch {
          }
          try {
            fs.unlinkSync(modelInTemp);
          } catch {
          }
          let srtEntries = [];
          if (fs.existsSync(jsonOutput)) {
            const jsonLines = fs.readFileSync(jsonOutput, "utf8");
            try {
              fs.unlinkSync(jsonOutput);
            } catch {
            }
            const raw = jsonLines.trim().split("\n").map((l) => {
              try {
                return JSON.parse(l.trim());
              } catch {
                return null;
              }
            }).filter((e) => !!e);
            let entries = raw.filter((e) => {
              const t = e.text.trim();
              if (/^[\s(锛圽[銆愨櫔鈾玗*[\)锛塡]銆戔櫔鈾玕s]*$/.test(t)) return false;
              if (/^[\s(锛圽[銆怾.*[\)锛塡]銆慮\s*$/.test(t)) return false;
              if (t.replace(/[\s\p{P}]/gu, "").length < 1) return false;
              return true;
            });
            entries = entries.filter((e, i) => {
              const selfDur = e.end - e.start;
              return !entries.some((other, j) => {
                if (j === i || other.text !== e.text) return false;
                const overlap = Math.max(0, Math.min(e.end, other.end) - Math.max(e.start, other.start));
                return overlap / selfDur >= 0.95 && other.end - other.start > selfDur;
              });
            });
            const merged = [];
            for (const e of entries) {
              const prev = merged[merged.length - 1];
              if (prev && e.text === prev.text && e.start - prev.end < 200) {
                prev.end = Math.max(prev.end, e.end);
                continue;
              }
              merged.push({ ...e });
            }
            for (let i = 0; i < merged.length - 1; i++) {
              if (merged[i].end > merged[i + 1].start) merged[i].end = merged[i + 1].start;
            }
            const textFreq = /* @__PURE__ */ new Map();
            for (const e of merged) textFreq.set(e.text.trim(), (textFreq.get(e.text.trim()) ?? 0) + 1);
            const deHallucinated = merged.filter((e) => {
              const key = e.text.trim();
              const charLen = key.replace(/\s/g, "").length;
              return charLen <= 3 || (textFreq.get(key) ?? 0) < 3;
            });
            const deRepeat = deHallucinated.filter((e) => {
              const t = e.text.trim();
              const parts = t.split(/[,锛屻€?銆侊紱;]/).map((p) => p.trim()).filter(Boolean);
              if (parts.length >= 2 && parts[0] === parts[1]) return false;
              const clean = t.replace(/[,锛屻€?銆侊紱;\s]/g, "");
              const half = Math.floor(clean.length / 2);
              if (half >= 3 && clean.slice(0, half) === clean.slice(half)) return false;
              return true;
            });
            srtEntries = deRepeat.map((e) => ({ startMs: e.start, endMs: e.end, text: e.text }));
          }
          if (srtEntries.length > 0) {
            try {
              const subtitledOutput = await burnSrt(srtEntries);
              if (fs.existsSync(subtitledOutput)) {
                fs.copyFileSync(subtitledOutput, finalOutput);
                try {
                  fs.unlinkSync(subtitledOutput);
                } catch {
                }
              } else {
                fs.copyFileSync(concatOutput, finalOutput);
              }
            } catch {
              fs.copyFileSync(concatOutput, finalOutput);
            }
          } else {
            fs.copyFileSync(concatOutput, finalOutput);
          }
        } else if (subtitleEntries && subtitleEntries.length > 0) {
          try {
            const subtitledOutput = await burnSrt(subtitleEntries.map((e) => ({ startMs: e.startMs, endMs: e.endMs, text: e.text })));
            if (fs.existsSync(subtitledOutput)) {
              fs.copyFileSync(subtitledOutput, finalOutput);
              try {
                fs.unlinkSync(subtitledOutput);
              } catch {
              }
            } else {
              fs.copyFileSync(concatOutput, finalOutput);
            }
          } catch {
            fs.copyFileSync(concatOutput, finalOutput);
          }
        } else {
          fs.copyFileSync(concatOutput, finalOutput);
        }
        try {
          fs.unlinkSync(concatOutput);
        } catch {
        }
        return { ok: true, outputPath: finalOutput };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
  ipcMain.handle(
    "tool:execute",
    async (_event, { toolName, args }) => {
      try {
        switch (toolName) {
          // 鈹€鈹€ FileRead 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "FileRead": {
            const filePath = String(args.filePath);
            const IMAGE_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]);
            const ext = path.extname(filePath).toLowerCase();
            if (IMAGE_EXTS.has(ext)) {
              if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
              const base64 = fs.readFileSync(filePath).toString("base64");
              return { content: `[Image: data:image/${ext.slice(1)};base64,${base64}]` };
            }
            if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
            const raw = fs.readFileSync(filePath, "utf8");
            const lines = raw.split("\n");
            const offset = Number(args.offset ?? 0);
            const limit = args.limit ? Number(args.limit) : void 0;
            const slice = limit ? lines.slice(offset, offset + limit) : lines.slice(offset);
            const numbered = slice.map((line, i) => `${offset + i + 1}	${line}`).join("\n");
            return { content: numbered };
          }
          // 鈹€鈹€ FileWrite 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "FileWrite": {
            const filePath = String(args.filePath);
            const content = String(args.content ?? "");
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf8");
            return { ok: true };
          }
          // 鈹€鈹€ FileEdit 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "FileEdit": {
            const filePath = String(args.filePath);
            if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
            let content = fs.readFileSync(filePath, "utf8");
            const oldStr = String(args.oldString);
            const newStr = String(args.newString ?? "");
            const replaceAll = Boolean(args.replaceAll);
            if (!content.includes(oldStr)) {
              return { error: `old_string not found in ${filePath}` };
            }
            if (replaceAll) {
              content = content.split(oldStr).join(newStr);
            } else {
              const idx = content.indexOf(oldStr);
              content = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
            }
            fs.writeFileSync(filePath, content, "utf8");
            return { ok: true, message: `Edited ${filePath}` };
          }
          // 鈹€鈹€ Glob 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "Glob": {
            const pattern = String(args.pattern);
            const cwd = args.path ? String(args.path) : process.cwd();
            const files = await glob(pattern, {
              cwd,
              absolute: true,
              dot: false,
              ignore: ["**/node_modules/**", "**/.git/**"]
            });
            const withStat = files.map((f) => ({
              f,
              mtime: fs.statSync(f).mtimeMs
            }));
            withStat.sort((a, b) => b.mtime - a.mtime);
            return { files: withStat.map((x) => x.f) };
          }
          // 鈹€鈹€ Grep 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "Grep": {
            const pattern = String(args.pattern);
            const searchPath = args.path ? String(args.path) : process.cwd();
            const globFilter = args.glob ? String(args.glob) : void 0;
            const outputMode = String(args.output_mode ?? "files_with_matches");
            const caseInsensitive = Boolean(args["-i"]);
            const contextLines = Number(args.context ?? 0);
            const headLimit = Number(args.head_limit ?? 250);
            let rgCmd = `rg --no-heading`;
            if (caseInsensitive) rgCmd += ` -i`;
            if (contextLines > 0) rgCmd += ` -C ${contextLines}`;
            if (globFilter) rgCmd += ` --glob "${globFilter}"`;
            if (outputMode === "files_with_matches") rgCmd += ` -l`;
            else if (outputMode === "count") rgCmd += ` --count`;
            else rgCmd += ` -n`;
            rgCmd += ` "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
            try {
              const { stdout } = await execAsync(rgCmd, { maxBuffer: 10 * 1024 * 1024 });
              const lines = stdout.split("\n").filter(Boolean).slice(0, headLimit);
              return { output: lines.join("\n") };
            } catch (e) {
              const exitCode = e.code;
              if (exitCode === 1) return { output: "" };
              const { stdout } = await execAsync(
                `grep -r ${caseInsensitive ? "-i" : ""} -l "${pattern.replace(/"/g, '\\"')}" "${searchPath}"`,
                { maxBuffer: 5 * 1024 * 1024 }
              ).catch(() => ({ stdout: "" }));
              return { output: stdout.trim() };
            }
          }
          // 鈹€鈹€ Bash 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
          case "Bash": {
            const command = String(args.command);
            const timeout = Math.min(Number(args.timeout ?? 12e4), 6e5);
            const cwd = args.cwd ? String(args.cwd) : process.cwd();
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd,
                timeout,
                maxBuffer: 10 * 1024 * 1024,
                shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash"
              });
              const output = [stdout, stderr].filter(Boolean).join("\n").trimEnd();
              return { output: output || "(no output)" };
            } catch (e) {
              const err = e;
              const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").trimEnd();
              return { output: output || "Command failed" };
            }
          }
          default:
            return { error: `Unknown tool: ${toolName}` };
        }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
  const mcpProcesses = /* @__PURE__ */ new Map();
  function sendMcpRequest(name, method, params) {
    const session = mcpProcesses.get(name);
    if (!session) throw new Error(`MCP server "${name}" not connected`);
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      session.proc.stdin.write(msg);
      setTimeout(() => {
        if (session.pending.has(id)) {
          session.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 3e4);
    });
  }
  ipcMain.handle("mcp:connect", async (_event, { config }) => {
    try {
      if (config.transport !== "stdio" || !config.command) {
        return { error: "Only stdio transport supported currently" };
      }
      if (mcpProcesses.has(config.name)) {
        mcpProcesses.get(config.name)?.proc.kill();
        mcpProcesses.delete(config.name);
      }
      const proc = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...config.env ?? {} },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const session = {
        proc,
        pending: /* @__PURE__ */ new Map(),
        nextId: 1
      };
      mcpProcesses.set(config.name, session);
      let buffer = "";
      proc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const pend = session.pending.get(msg.id);
            if (pend) {
              session.pending.delete(msg.id);
              if (msg.error) pend.reject(new Error(msg.error.message));
              else pend.resolve(msg.result);
            }
          } catch {
          }
        }
      });
      await sendMcpRequest(config.name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "next-chapter", version: "1.0.0" }
      });
      const toolsResult = await sendMcpRequest(config.name, "tools/list", {});
      const tools = (toolsResult?.tools ?? []).map((t) => {
        const tool = t;
        return { serverName: config.name, name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} };
      });
      const resResult = await sendMcpRequest(config.name, "resources/list", {});
      const resources = (resResult?.resources ?? []).map((r) => {
        const res = r;
        return { serverName: config.name, uri: res.uri, name: res.name, description: res.description, mimeType: res.mimeType };
      });
      return { ok: true, tools, resources };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("mcp:disconnect", (_event, { name }) => {
    mcpProcesses.get(name)?.proc.kill();
    mcpProcesses.delete(name);
    return { ok: true };
  });
  ipcMain.handle("mcp:call-tool", async (_event, {
    serverName,
    toolName,
    args
  }) => {
    try {
      const result = await sendMcpRequest(serverName, "tools/call", { name: toolName, arguments: args });
      const content = result?.content;
      return { ok: true, content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("mcp:read-resource", async (_event, {
    serverName,
    uri
  }) => {
    try {
      const result = await sendMcpRequest(serverName, "resources/read", { uri });
      const content = result?.contents?.[0]?.text ?? "";
      return { ok: true, content };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
async function prepareWindowSession(win) {
  try {
    await win.webContents.session.clearCache();
    log("info", "window session cache cleared");
  } catch (error) {
    log("warn", `failed to clear window cache: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await win.webContents.session.clearStorageData({
      storages: ["cachestorage", "shadercache", "serviceworkers"]
    });
    log("info", "window cache storage cleared");
  } catch (error) {
    log("warn", `failed to clear cache storage: ${error instanceof Error ? error.message : String(error)}`);
  }
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (!headers["access-control-allow-origin"] && !headers["Access-Control-Allow-Origin"]) {
      headers["Access-Control-Allow-Origin"] = ["*"];
      headers["Access-Control-Allow-Methods"] = ["GET, HEAD, OPTIONS"];
      headers["Access-Control-Allow-Headers"] = ["*"];
    }
    callback({ responseHeaders: headers });
  });
  log("info", "CORS headers injection configured");
}
async function createWindow() {
  log("info", "createWindow start");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    icon: path.join(__dirname, "../build/icon.ico"),
    backgroundColor: "#090b11",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      spellcheck: false,
      // 浣庨厤浼樺寲锛氱鐢ㄦ嫾鍐欐鏌?
      backgroundThrottling: true,
      // 鍚庡彴鑺傛祦锛屽噺灏戜綆閰嶆満鍣ㄨ祫婧愬崰鐢?
      paintWhenInitiallyHidden: true
    },
    show: false,
    title: "InFinio - \u4E00\u7AD9\u5F0F\u667A\u80FD\u4F53\u81EA\u52A8\u5316\u5E73\u53F0"
  });
  let hasRevealedMainWindow = false;
  let startupRevealTimer = setTimeout(() => {
    revealMainWindow("startup-timeout");
  }, 1200);
  const revealMainWindow = (reason) => {
    if (!mainWindow || mainWindow.isDestroyed() || hasRevealedMainWindow) return;
    hasRevealedMainWindow = true;
    if (startupRevealTimer) {
      clearTimeout(startupRevealTimer);
      startupRevealTimer = null;
    }
    log("info", `main window revealed via ${reason}`);
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", () => {
    log("info", "main window ready-to-show");
    revealMainWindow("ready-to-show");
  });
  mainWindow.webContents.once("dom-ready", () => {
    log("info", "main window dom-ready");
    revealMainWindow("dom-ready");
  });
  mainWindow.webContents.on("did-finish-load", () => {
    log("info", "main window did-finish-load");
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log("error", `main window did-fail-load code=${code} description=${description} url=${url}`);
  });
  mainWindow.on("closed", () => {
    if (startupRevealTimer) {
      clearTimeout(startupRevealTimer);
      startupRevealTimer = null;
    }
  });
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    log("error", `========== \u5A13\u53C9\u714B\u6769\u6D9A\u25BC\u5B95\u2542\u7C1D ==========`);
    log("error", `\u9358\u71B7\u6D1C: ${details.reason}`);
    log("error", `\u95AB\u20AC\u9351\u8679\u721C: ${details.exitCode}`);
    console.error("\u5A13\u53C9\u714B\u6769\u6D9A\u25BC\u5B95\u2542\u7C1D\u7487\uFE3D\u510F:", details);
    const crashInfo = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      reason: details.reason,
      exitCode: details.exitCode,
      // 娣诲姞鍐呭瓨浣跨敤淇℃伅
      memoryUsage: process.memoryUsage(),
      // 娣诲姞绯荤粺淇℃伅
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    };
    const crashLogPath = path.join(getUserDataPath(), "crash-log.json");
    try {
      let logs = [];
      if (fs.existsSync(crashLogPath)) {
        logs = JSON.parse(fs.readFileSync(crashLogPath, "utf8"));
      }
      logs.unshift(crashInfo);
      if (logs.length > 20) logs.length = 20;
      fs.writeFileSync(crashLogPath, JSON.stringify(logs, null, 2));
      log("info", `\u5B95\u2542\u7C1D\u93C3\u30E5\u7E54\u5BB8\u8E6D\u7E5A\u701B\u6A3A\u57CC: ${crashLogPath}`);
    } catch (err) {
      log("error", `\u93C3\u72B3\u7876\u6DC7\u6FC6\u74E8\u5B95\u2542\u7C1D\u93C3\u30E5\u7E54: ${err}`);
    }
  });
  mainWindow.webContents.on("unresponsive", () => {
    log("warn", "\u6E32\u67D3\u8FDB\u7A0B\u672A\u54CD\u5E94");
  });
  mainWindow.webContents.on("responsive", () => {
    log("info", "\u6E32\u67D3\u8FDB\u7A0B\u5DF2\u6062\u590D\u54CD\u5E94");
  });
  await prepareWindowSession(mainWindow);
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    try {
      await loadDevWarmupPage(mainWindow);
    } catch (error) {
      log("warn", `failed to load dev warmup page: ${error instanceof Error ? error.message : String(error)}`);
    }
    void transitionWarmupWindowToDevServer(mainWindow, devUrl);
  } else {
    const indexPath = path.join(__dirname, "../dist/index.html");
    log("info", `loading file: ${indexPath}`);
    await mainWindow.loadFile(indexPath);
  }
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "../build/icon.ico"));
  log("info", `createTray icon empty=${icon.isEmpty()}`);
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: "\u663E\u793A\u7A97\u53E3", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "\u9000\u51FA", click: () => app.quit() }
  ]);
  tray.setToolTip("InFinio - \u4E00\u7AD9\u5F0F\u667A\u80FD\u4F53\u81EA\u52A8\u5316\u5E73\u53F0");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow?.show());
}
function configureApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "\u6587\u4EF6",
        submenu: [
          { role: "close", label: "\u5173\u95ED\u7A97\u53E3" },
          { type: "separator" },
          { role: "quit", label: "\u9000\u51FA" }
        ]
      },
      {
        label: "\u7F16\u8F91",
        submenu: [
          { role: "undo", label: "\u64A4\u9500" },
          { role: "redo", label: "\u91CD\u505A" },
          { type: "separator" },
          { role: "cut", label: "\u526A\u5207" },
          { role: "copy", label: "\u590D\u5236" },
          { role: "paste", label: "\u7C98\u8D34" },
          { role: "selectAll", label: "\u5168\u9009" }
        ]
      },
      {
        label: "\u89C6\u56FE",
        submenu: [
          { role: "reload", label: "\u91CD\u65B0\u52A0\u8F7D" },
          { role: "forceReload", label: "\u5F3A\u5236\u91CD\u65B0\u52A0\u8F7D" },
          { role: "toggleDevTools", label: "\u5F00\u53D1\u8005\u5DE5\u5177" },
          { type: "separator" },
          { role: "resetZoom", label: "\u91CD\u7F6E\u7F29\u653E" },
          { role: "zoomIn", label: "\u653E\u5927" },
          { role: "zoomOut", label: "\u7F29\u5C0F" },
          { type: "separator" },
          { role: "togglefullscreen", label: "\u5207\u6362\u5168\u5C4F" }
        ]
      },
      {
        label: "\u7A97\u53E3",
        submenu: [
          { role: "minimize", label: "\u6700\u5C0F\u5316" },
          { role: "close", label: "\u5173\u95ED\u7A97\u53E3" }
        ]
      },
      {
        label: "\u5E2E\u52A9",
        submenu: [
          {
            label: "\u6253\u5F00\u6570\u636E\u76EE\u5F55",
            click: () => {
              void shell.openPath(app.getPath("userData"));
            }
          }
        ]
      }
    ])
  );
}
app.whenReady().then(async () => {
  log("info", "========== Electron \u6D93\u660F\u7E58\u7ECB\u5B2A\u60CE\u9354?==========");
  log("info", `\u6E32\u67D3\u6A21\u5F0F: ${GPU_DISABLED ? "\u8F6F\u4EF6\u6E32\u67D3(SwiftShader)" : "\u786C\u4EF6\u52A0\u901F"}`);
  app.on("gpu-process-crashed", (_event, killed) => {
    log("warn", `GPU \u6769\u6D9A\u25BC\u5B95\u2542\u7C1D killed=${killed}\u951B\u5C7C\u7B05\u5A06\u2033\u60CE\u9354\u3125\u76A2\u9477\uE044\u59E9\u9352\u56E8\u5D32\u675E\uE219\u6B22\u5A13\u53C9\u714B`);
    try {
      fs.writeFileSync(GPU_DISABLE_FLAG, "1");
    } catch {
    }
  });
  setupIPC();
  configureApplicationMenu();
  await createWindow();
  createTray();
  startDevLauncherWatchdog();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  stopDevLauncherWatchdog();
  if (watchedDevServerPid) {
    killProcessTree(watchedDevServerPid);
    watchedDevServerPid = null;
  }
});
/*! Bundled license information:

is-extglob/index.js:
  (*!
   * is-extglob <https://github.com/jonschlinkert/is-extglob>
   *
   * Copyright (c) 2014-2016, Jon Schlinkert.
   * Licensed under the MIT License.
   *)

is-glob/index.js:
  (*!
   * is-glob <https://github.com/jonschlinkert/is-glob>
   *
   * Copyright (c) 2014-2017, Jon Schlinkert.
   * Released under the MIT License.
   *)

is-number/index.js:
  (*!
   * is-number <https://github.com/jonschlinkert/is-number>
   *
   * Copyright (c) 2014-present, Jon Schlinkert.
   * Released under the MIT License.
   *)

to-regex-range/index.js:
  (*!
   * to-regex-range <https://github.com/micromatch/to-regex-range>
   *
   * Copyright (c) 2015-present, Jon Schlinkert.
   * Released under the MIT License.
   *)

fill-range/index.js:
  (*!
   * fill-range <https://github.com/jonschlinkert/fill-range>
   *
   * Copyright (c) 2014-present, Jon Schlinkert.
   * Licensed under the MIT License.
   *)

queue-microtask/index.js:
  (*! queue-microtask. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)

run-parallel/index.js:
  (*! run-parallel. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> *)
*/
