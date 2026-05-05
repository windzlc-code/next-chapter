import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoGenerationResolution,
} from "@/types/project";

export const HOME_AGENT_VIDEO_PREFS_STORAGE_KEY = "storyforge-home-agent-video-prefs-v1";

export const DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS: VideoGenerationPrefs = {
  modelKey: "doubao-seedance-1-5-pro",
  resolution: "480p",
  mode: "text-to-video",
};

export interface HomeAgentVideoModelOption {
  key: VideoGenerationModelKey;
  label: string;
  description: string;
  provider: "jimeng";
}

export interface HomeAgentVideoResolutionOption {
  value: VideoGenerationResolution;
  label: string;
  description: string;
  disabledLabel?: string;
}

const VIDEO_MODEL_OPTIONS: HomeAgentVideoModelOption[] = [
  {
    key: "doubao-seedance-1-5-pro",
    label: "seedance-1-5-pro",
    description: "Ark contents/generations/tasks route for Seedance 1.5 Pro video generation.",
    provider: "jimeng",
  },
];

const VIDEO_RESOLUTION_OPTIONS: HomeAgentVideoResolutionOption[] = [
  {
    value: "480p",
    label: "480p",
    description: "Fast preview output with lower bandwidth cost.",
  },
  {
    value: "720p",
    label: "720p",
    description: "Balanced quality and speed.",
  },
  {
    value: "1080p",
    label: "1080p",
    description: "Full HD output for the current supported high-quality path.",
  },
  {
    value: "2k",
    label: "2K",
    description: "Reserved high-resolution video slot.",
    disabledLabel: "Not supported by Seedance 1.5 Pro yet",
  },
  {
    value: "4k",
    label: "4K",
    description: "Reserved ultra-high-resolution video slot.",
    disabledLabel: "Not supported by Seedance 1.5 Pro yet",
  },
];

const VIDEO_MODEL_RESOLUTION_SUPPORT: Record<
  VideoGenerationModelKey,
  readonly VideoGenerationResolution[]
> = {
  "doubao-seedance-1-5-pro": ["480p", "720p", "1080p"],
};

export function listHomeAgentVideoModels(): HomeAgentVideoModelOption[] {
  return VIDEO_MODEL_OPTIONS;
}

export function listHomeAgentVideoResolutions(): HomeAgentVideoResolutionOption[] {
  return VIDEO_RESOLUTION_OPTIONS;
}

export function videoModelSupportsResolution(
  modelKey?: string | null,
  resolution?: string | null,
): boolean {
  const normalizedModel = normalizeHomeAgentVideoModelKey(modelKey);
  const normalizedResolution = String(resolution || "").trim().toLowerCase();
  return VIDEO_MODEL_RESOLUTION_SUPPORT[normalizedModel].includes(
    normalizedResolution as VideoGenerationResolution,
  );
}

export function normalizeHomeAgentVideoModelKey(
  value?: string | null,
): VideoGenerationModelKey {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "doubao-seedance-1-5-pro" ||
    normalized === "doubao-seedance-1-5-pro_480p" ||
    normalized === "doubao-seedance-1-5-pro_720p" ||
    normalized === "doubao-seedance-1-5-pro_1080p" ||
    normalized === "doubao-seedance-1-5-pro_2k" ||
    normalized === "doubao-seedance-1-5-pro_4k" ||
    normalized === "seedance-1-5-pro" ||
    normalized === "seedance-1.5-pro"
  ) {
    return "doubao-seedance-1-5-pro";
  }
  return DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.modelKey;
}

export function normalizeVideoGenerationResolution(
  value?: string | null,
): VideoGenerationResolution {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "480p" ||
    normalized === "720p" ||
    normalized === "1080p" ||
    normalized === "2k" ||
    normalized === "4k"
    ? (normalized as VideoGenerationResolution)
    : DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.resolution;
}

export function normalizeVideoGenerationMode(
  value?: string | null,
): VideoGenerationPrefs["mode"] {
  if (value === "text-to-video" || value === "image-to-video") return value;
  return DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.mode;
}

export function normalizeVideoGenerationPrefs(
  value?: Partial<VideoGenerationPrefs> | null,
): VideoGenerationPrefs {
  const modelKey = normalizeHomeAgentVideoModelKey(value?.modelKey);
  const resolution = normalizeVideoGenerationResolution(value?.resolution);
  return {
    modelKey,
    resolution: videoModelSupportsResolution(modelKey, resolution)
      ? resolution
      : DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.resolution,
    mode: normalizeVideoGenerationMode(value?.mode),
  };
}

export function getHomeAgentVideoModelOption(
  value?: string | null,
): HomeAgentVideoModelOption {
  const normalized = normalizeHomeAgentVideoModelKey(value);
  return (
    VIDEO_MODEL_OPTIONS.find((option) => option.key === normalized) ??
    VIDEO_MODEL_OPTIONS[0]
  );
}

export function getVideoGenerationResolutionOption(
  value?: string | null,
): HomeAgentVideoResolutionOption {
  const normalized = normalizeVideoGenerationResolution(value);
  return (
    VIDEO_RESOLUTION_OPTIONS.find((option) => option.value === normalized) ??
    VIDEO_RESOLUTION_OPTIONS[0]
  );
}

export function getVideoGenerationResolutionLabel(value?: string | null): string {
  return getVideoGenerationResolutionOption(value).label;
}

export function resolveVideoGenerationModelName(
  prefs?: Partial<VideoGenerationPrefs> | null,
): string {
  const normalized = normalizeVideoGenerationPrefs(prefs);
  return `${normalized.modelKey}_${normalized.resolution}`;
}

export function resolveVideoGenerationProvider(
  prefs?: Partial<VideoGenerationPrefs> | null,
): HomeAgentVideoModelOption["provider"] {
  return getHomeAgentVideoModelOption(normalizeVideoGenerationPrefs(prefs).modelKey).provider;
}

export function videoModelSupportsDirectReferenceImage(value?: string | null): boolean {
  const normalized = normalizeHomeAgentVideoModelKey(value);
  switch (normalized) {
    case "doubao-seedance-1-5-pro":
      return true;
    default:
      return true;
  }
}

export function buildVideoGenerationSummary(
  prefs?: Partial<VideoGenerationPrefs> | null,
): string {
  const normalized = normalizeVideoGenerationPrefs(prefs);
  const model = getHomeAgentVideoModelOption(normalized.modelKey);
  return `${model.label} 路 ${getVideoGenerationResolutionLabel(normalized.resolution)}`;
}

export function readStoredHomeAgentVideoGenerationPrefs(): VideoGenerationPrefs {
  if (typeof window === "undefined") return DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS;

  try {
    const raw = window.localStorage.getItem(HOME_AGENT_VIDEO_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS;
    return normalizeVideoGenerationPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS;
  }
}

export function writeStoredHomeAgentVideoGenerationPrefs(
  prefs: Partial<VideoGenerationPrefs> | null | undefined,
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      HOME_AGENT_VIDEO_PREFS_STORAGE_KEY,
      JSON.stringify(normalizeVideoGenerationPrefs(prefs)),
    );
  } catch {
    // Keep the in-memory selection if persistence is unavailable.
  }
}

export const VIDEO_SEGMENT_DESIGN_DURATION = 15;

const VIDEO_MODEL_MAX_DURATION: Record<VideoGenerationModelKey, number> = {
  "doubao-seedance-1-5-pro": 12,
};

export function getVideoModelMaxDuration(modelKey?: string | null): number {
  const normalized = normalizeHomeAgentVideoModelKey(modelKey);
  return VIDEO_MODEL_MAX_DURATION[normalized] ?? 12;
}
