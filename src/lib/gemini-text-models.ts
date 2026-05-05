export type DecomposeModel =
  | "gemini-3-pro-preview"
  | "gemini-3-pro-thinking"
  | "gemini-3-flash-preview"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "grok-4.1"
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-6-thinking"
  | "claude-opus-4-6";

export type ComplianceModel =
  | "gemini-3-pro-preview"
  | "gemini-3-flash-preview"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "grok-4.1"
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-6-thinking"
  | "claude-opus-4-6";

export const DEFAULT_DECOMPOSE_MODEL: DecomposeModel = "gemini-3-flash-preview";
export const DEFAULT_COMPLIANCE_MODEL: ComplianceModel = "gemini-3-flash-preview";

export const DECOMPOSE_MODEL_OPTIONS: Array<{
  value: DecomposeModel;
  label: string;
  group: string;
}> = [
  { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview", group: "Gemini" },
  { value: "gemini-3-pro-thinking", label: "Gemini 3 Pro Thinking", group: "Gemini" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", group: "Gemini" },
  { value: "gpt-5.4", label: "GPT-5.4", group: "GPT" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "GPT" },
  { value: "grok-4.1", label: "Grok 4.1", group: "Grok" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Claude" },
  { value: "claude-sonnet-4-6-thinking", label: "Claude Sonnet 4.6 Thinking", group: "Claude" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", group: "Claude" },
];

export const COMPLIANCE_MODEL_OPTIONS: Array<{
  value: ComplianceModel;
  label: string;
  group: string;
}> = DECOMPOSE_MODEL_OPTIONS.filter(
  (option): option is { value: ComplianceModel; label: string; group: string } =>
    option.value !== "gemini-3-pro-thinking",
);

const LEGACY_MODEL_MAP: Record<string, DecomposeModel> = {
  "gemini-3.1-pro-preview": "gemini-3-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-pro-preview-thinking": "gemini-3-pro-thinking",
  "gemini-3-pro-preview": "gemini-3-pro-preview",
  "gemini-3-flash-preview": "gemini-3-flash-preview",
  "gemini-3-pro-thinking": "gemini-3-pro-thinking",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "grok-4.1": "grok-4.1",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-sonnet-4-6-thinking": "claude-sonnet-4-6-thinking",
  "claude-opus-4-6": "claude-opus-4-6",
};

export function normalizeDecomposeModel(
  value: string | null | undefined,
): DecomposeModel {
  const normalized = value ? LEGACY_MODEL_MAP[value] || value : "";
  return DECOMPOSE_MODEL_OPTIONS.some((option) => option.value === normalized)
    ? (normalized as DecomposeModel)
    : DEFAULT_DECOMPOSE_MODEL;
}

export function normalizeComplianceModel(
  value: string | null | undefined,
): ComplianceModel {
  const normalized = normalizeDecomposeModel(value);
  return normalized === "gemini-3-pro-thinking"
    ? DEFAULT_COMPLIANCE_MODEL
    : normalized;
}

export function readStoredDecomposeModel(): DecomposeModel {
  try {
    const raw = localStorage.getItem("decompose-model");
    const normalized = normalizeDecomposeModel(raw);
    if (raw !== normalized) {
      localStorage.setItem("decompose-model", normalized);
    }
    return normalized;
  } catch {
    return DEFAULT_DECOMPOSE_MODEL;
  }
}

export function readStoredComplianceModel(): ComplianceModel {
  try {
    const raw = localStorage.getItem("compliance-model");
    const normalized = normalizeComplianceModel(raw);
    if (raw !== normalized) {
      localStorage.setItem("compliance-model", normalized);
    }
    return normalized;
  } catch {
    return DEFAULT_COMPLIANCE_MODEL;
  }
}
