const LLM_PARAMS_STORAGE_KEY = "infinio-llm-params-v1";

export interface LlmParamPreset {
  key: string;
  label: string;
  temperature: number;
  maxOutputTokens: number;
  valueSummary: string;
  description: string;
  badge?: string;
}

export const LLM_PARAM_PRESETS: LlmParamPreset[] = [
  {
    key: "precise",
    label: "精确",
    temperature: 0.1,
    maxOutputTokens: 6144,
    valueSummary: "0.1 / 6K",
    description: "结构化输出、JSON 解析、数据提取。",
  },
  {
    key: "balanced",
    label: "均衡",
    temperature: 0.5,
    maxOutputTokens: 8192,
    valueSummary: "0.5 / 8K",
    description: "通用创作与对话推进。",
    badge: "默认",
  },
  {
    key: "creative",
    label: "创意",
    temperature: 0.8,
    maxOutputTokens: 8192,
    valueSummary: "0.8 / 8K",
    description: "剧情发散与风格探索。",
  },
  {
    key: "free",
    label: "自由",
    temperature: 1.0,
    maxOutputTokens: 16384,
    valueSummary: "1.0 / 16K",
    description: "高自由度创意扩展。",
  },
];

export const DEFAULT_LLM_PARAM_PRESET_KEY = "balanced";

export function normalizeLlmParamPresetKey(value?: string | null): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return DEFAULT_LLM_PARAM_PRESET_KEY;
  return LLM_PARAM_PRESETS.some((preset) => preset.key === normalized)
    ? normalized
    : DEFAULT_LLM_PARAM_PRESET_KEY;
}

export function getLlmParamPreset(key?: string | null): LlmParamPreset {
  const normalized = normalizeLlmParamPresetKey(key);
  return LLM_PARAM_PRESETS.find((preset) => preset.key === normalized) ?? LLM_PARAM_PRESETS[1];
}

// The preset picker is no longer user-facing. Keep the helpers for service-layer defaults only.
export function readStoredLlmParamPresetKey(): string {
  void LLM_PARAMS_STORAGE_KEY;
  return DEFAULT_LLM_PARAM_PRESET_KEY;
}

export function writeStoredLlmParamPresetKey(key: string): void {
  void key;
}

export function readStoredLlmParams(): { temperature: number; maxOutputTokens: number } {
  const preset = getLlmParamPreset(readStoredLlmParamPresetKey());
  return { temperature: preset.temperature, maxOutputTokens: preset.maxOutputTokens };
}
