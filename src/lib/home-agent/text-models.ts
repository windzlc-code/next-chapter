import {
  SUPPORTED_MODEL_MAPPINGS,
  type ApiConfig,
  type SupportedModelMapping,
} from "@/lib/api-config";

const HOME_AGENT_TEXT_MODEL_STORAGE_KEY = "storyforge-home-agent-text-model-v1";
export const DEFAULT_HOME_AGENT_TEXT_MODEL_KEY = "claude-sonnet-4-6";

const PROVIDER_META = {
  claude: { supplierLabel: "Anthropic", familyLabel: "Claude" },
  gemini: { supplierLabel: "Google", familyLabel: "Gemini" },
  gpt: { supplierLabel: "OpenAI", familyLabel: "GPT" },
  grok: { supplierLabel: "xAI", familyLabel: "Grok" },
} as const satisfies Partial<
  Record<SupportedModelMapping["provider"], { supplierLabel: string; familyLabel: string }>
>;

const PROVIDER_ORDER = ["claude", "gemini", "gpt", "grok"] as const;

const MODEL_META = {
  "claude-sonnet-4-6": {
    shortLabel: "Sonnet 4.6",
    description: "稳定均衡，适合首页主线创作和长链路推进。",
  },
  "claude-sonnet-4-6-thinking": {
    shortLabel: "Sonnet 4.6 Thinking",
    description: "更强分析和推演，适合复杂结构拆解与方案比较。",
  },
  "claude-opus-4-6": {
    shortLabel: "Opus 4.6",
    description: "更高上限，适合高复杂度创作、审校和重构任务。",
  },
  "gemini-3-pro": {
    shortLabel: "3 Pro",
    description: "通用均衡，适合长轮对话、创意扩展和整体规划。",
  },
  "gemini-3-pro-preview": {
    shortLabel: "3 Pro Preview",
    description: "更新预览版本，适合尝试更积极的分析和生成表现。",
  },
  "gemini-3-pro-thinking": {
    shortLabel: "3 Pro Thinking",
    description: "更偏推理，适合复杂提纲、结构规划和深度分析。",
  },
  "gemini-3-flash-preview": {
    shortLabel: "3 Flash",
    description: "更快更轻，适合高频追问、快速改稿和日常推进。",
  },
  "gpt-5.4": {
    shortLabel: "5.4",
    description: "综合能力强，适合规划、改写、工具协作和细节收口。",
  },
  "gpt-5.4-mini": {
    shortLabel: "5.4 Mini",
    description: "速度更快，适合日常推进、快速问答和轻量创作。",
  },
  "grok-4.1": {
    shortLabel: "4.1",
    description: "更偏开放探索，适合脑暴、风格发散和方向试探。",
  },
} as const satisfies Partial<Record<string, { shortLabel: string; description: string }>>;

export interface HomeAgentTextModelOption {
  key: string;
  provider: "claude" | "gemini" | "gpt" | "grok";
  providerLabel: string;
  supplierLabel: string;
  familyLabel: string;
  label: string;
  shortLabel: string;
  description: string;
}

export interface HomeAgentTextModelGroup {
  provider: HomeAgentTextModelOption["provider"];
  providerLabel: string;
  supplierLabel: string;
  familyLabel: string;
  options: HomeAgentTextModelOption[];
}

export interface HomeAgentTextModelRuntimeConfig {
  provider: HomeAgentTextModelOption["provider"];
  model: string;
  apiKey: string;
  baseUrl: string;
  option: HomeAgentTextModelOption;
}

const PROVIDER_CREDENTIAL_KEYS = {
  claude: {
    apiKey: "claudeKey",
    baseUrl: "claudeEndpoint",
  },
  gemini: {
    apiKey: "geminiKey",
    baseUrl: "geminiEndpoint",
  },
  gpt: {
    apiKey: "gptKey",
    baseUrl: "gptEndpoint",
  },
  grok: {
    apiKey: "grokKey",
    baseUrl: "grokEndpoint",
  },
} as const satisfies Record<
  HomeAgentTextModelOption["provider"],
  {
    apiKey: keyof ApiConfig;
    baseUrl: keyof ApiConfig;
  }
>;

function isTextProvider(
  provider: SupportedModelMapping["provider"],
): provider is HomeAgentTextModelOption["provider"] {
  return provider === "claude" || provider === "gemini" || provider === "gpt" || provider === "grok";
}

function isHomeAgentTextModelMapping(
  mapping: SupportedModelMapping,
): mapping is SupportedModelMapping & { provider: HomeAgentTextModelOption["provider"] } {
  return mapping.category === "text" && isTextProvider(mapping.provider);
}

export function listHomeAgentTextModelOptions(): HomeAgentTextModelOption[] {
  return SUPPORTED_MODEL_MAPPINGS.filter(isHomeAgentTextModelMapping)
    .map((mapping) => {
      const providerMeta = PROVIDER_META[mapping.provider];
      const modelMeta = MODEL_META[mapping.key];

      return {
        key: mapping.key,
        provider: mapping.provider,
        providerLabel: providerMeta.familyLabel,
        supplierLabel: providerMeta.supplierLabel,
        familyLabel: providerMeta.familyLabel,
        label: mapping.label,
        shortLabel: modelMeta?.shortLabel || mapping.label,
        description: modelMeta?.description || `${mapping.label} 可用于首页主会话。`,
      };
    });
}

export function groupHomeAgentTextModelOptions(): HomeAgentTextModelGroup[] {
  const options = listHomeAgentTextModelOptions();
  return PROVIDER_ORDER.map((provider) => {
    const grouped = options.filter((option) => option.provider === provider);
    if (!grouped.length) return null;

    return {
      provider,
      providerLabel: grouped[0].providerLabel,
      supplierLabel: grouped[0].supplierLabel,
      familyLabel: grouped[0].familyLabel,
      options: grouped,
    } satisfies HomeAgentTextModelGroup;
  }).filter((group): group is HomeAgentTextModelGroup => Boolean(group));
}

export function normalizeHomeAgentTextModelKey(value?: string | null): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return DEFAULT_HOME_AGENT_TEXT_MODEL_KEY;
  return listHomeAgentTextModelOptions().some((option) => option.key === normalized)
    ? normalized
    : DEFAULT_HOME_AGENT_TEXT_MODEL_KEY;
}

export function getHomeAgentTextModelOption(value?: string | null): HomeAgentTextModelOption {
  const normalized = normalizeHomeAgentTextModelKey(value);
  return (
    listHomeAgentTextModelOptions().find((option) => option.key === normalized) ||
    listHomeAgentTextModelOptions()[0]
  );
}

const PROVIDER_DEFAULT_BASE_URLS: Record<HomeAgentTextModelOption["provider"], string> = {
  claude: "https://api.tu-zi.com/v1",
  gemini: "https://api.tu-zi.com/v1beta",
  gpt: "https://api.tu-zi.com/v1",
  grok: "https://api.tu-zi.com/v1",
};

export function resolveHomeAgentTextModelRuntime(
  apiConfigModule: Pick<typeof import("@/lib/api-config"), "getApiConfig" | "resolveConfiguredModelName">,
  value?: string | null,
): HomeAgentTextModelRuntimeConfig {
  const option = getHomeAgentTextModelOption(value);
  const config = apiConfigModule.getApiConfig();
  const providerKeys = PROVIDER_CREDENTIAL_KEYS[option.provider];
  const storedBaseUrl = String(config[providerKeys.baseUrl] || "").trim();

  return {
    provider: option.provider,
    model: apiConfigModule.resolveConfiguredModelName(option.key),
    apiKey: String(config[providerKeys.apiKey] || "").trim(),
    baseUrl: storedBaseUrl || PROVIDER_DEFAULT_BASE_URLS[option.provider],
    option,
  };
}

export function readStoredHomeAgentTextModelKey(): string {
  if (typeof window === "undefined") return DEFAULT_HOME_AGENT_TEXT_MODEL_KEY;

  try {
    return normalizeHomeAgentTextModelKey(window.localStorage.getItem(HOME_AGENT_TEXT_MODEL_STORAGE_KEY));
  } catch {
    return DEFAULT_HOME_AGENT_TEXT_MODEL_KEY;
  }
}

export function writeStoredHomeAgentTextModelKey(value: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      HOME_AGENT_TEXT_MODEL_STORAGE_KEY,
      normalizeHomeAgentTextModelKey(value),
    );
  } catch {
    // Ignore persistence failures and keep the in-memory choice.
  }
}
