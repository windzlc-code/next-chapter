import type {
  VideoGenerationModelKey,
  VideoGenerationPrefs,
  VideoGenerationResolution,
  VideoImageAspectRatio,
} from "@/types/project";

export const HOME_AGENT_VIDEO_PREFS_STORAGE_KEY = "storyforge-home-agent-video-prefs-v1";
export const HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT = 3;
export const SEEDANCE_1_5_PRO_MODEL_KEY = "doubao-seedance-1-5-pro";
export const SEEDANCE_2_0_MODEL_KEY = "doubao-seedance-2-0-260128";
export const SEEDANCE_2_0_FAST_MODEL_KEY = "doubao-seedance-2-0-fast-260128";
export const HAPPYHORSE_1_0_MODEL_KEY = "happyhorse-1.0";

export type HomeAgentVideoAspectRatio =
  | Exclude<VideoImageAspectRatio, "2:3" | "3:2">
  | "21:9";

export const DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS: VideoGenerationPrefs = {
  modelKey: SEEDANCE_1_5_PRO_MODEL_KEY,
  resolution: "720p",
  mode: "text-to-video",
};

export interface HomeAgentVideoModelOption {
  key: VideoGenerationModelKey;
  label: string;
  description: string;
  provider: "jimeng" | "aliyun";
  maxVideosPerRun: number;
  maxConcurrentGenerations: number;
}

export interface HomeAgentVideoResolutionOption {
  value: VideoGenerationResolution;
  label: string;
  description: string;
  disabledLabel?: string;
}

const VIDEO_MODEL_OPTIONS: HomeAgentVideoModelOption[] = [
  {
    key: SEEDANCE_1_5_PRO_MODEL_KEY,
    label: "seedance-1-5-pro",
    description: "Ark contents/generations/tasks route for Seedance 1.5 Pro video generation.",
    provider: "jimeng",
    maxVideosPerRun: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
    maxConcurrentGenerations: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
  },
  {
    key: SEEDANCE_2_0_MODEL_KEY,
    label: "seedance-2.0",
    description: "Official Ark Seedance 2.0 model id with 480p, 720p, 1080p, plus 2K/4K through the RunningHub fallback path.",
    provider: "jimeng",
    maxVideosPerRun: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
    maxConcurrentGenerations: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
  },
  {
    key: SEEDANCE_2_0_FAST_MODEL_KEY,
    label: "seedance-2.0-fast",
    description: "Official Ark Seedance 2.0 Fast model id with 480p and 720p support.",
    provider: "jimeng",
    maxVideosPerRun: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
    maxConcurrentGenerations: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
  },
  {
    key: HAPPYHORSE_1_0_MODEL_KEY,
    label: "HappyHorse-1.0",
    description: "Aliyun HappyHorse auto-routes text, first-frame, and multi-reference video generation under one model.",
    provider: "aliyun",
    maxVideosPerRun: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
    maxConcurrentGenerations: HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
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
    disabledLabel: "Not supported by the current video model yet",
  },
  {
    value: "4k",
    label: "4K",
    description: "Reserved ultra-high-resolution video slot.",
    disabledLabel: "Not supported by the current video model yet",
  },
];

const VIDEO_MODEL_RESOLUTION_SUPPORT: Record<
  VideoGenerationModelKey,
  readonly VideoGenerationResolution[]
> = {
  [SEEDANCE_1_5_PRO_MODEL_KEY]: ["480p", "720p", "1080p"],
  [SEEDANCE_2_0_MODEL_KEY]: ["480p", "720p", "1080p", "2k", "4k"],
  [SEEDANCE_2_0_FAST_MODEL_KEY]: ["480p", "720p"],
  [HAPPYHORSE_1_0_MODEL_KEY]: ["720p", "1080p"],
};

const VIDEO_ASPECT_RATIO_OPTIONS: HomeAgentVideoAspectRatio[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "21:9",
];

const VIDEO_MODEL_ASPECT_RATIO_SUPPORT: Record<
  VideoGenerationModelKey,
  readonly HomeAgentVideoAspectRatio[]
> = {
  [SEEDANCE_1_5_PRO_MODEL_KEY]: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  [SEEDANCE_2_0_MODEL_KEY]: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  [SEEDANCE_2_0_FAST_MODEL_KEY]: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  [HAPPYHORSE_1_0_MODEL_KEY]: ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4"],
};

const DEFAULT_HOME_AGENT_VIDEO_ASPECT_RATIO: HomeAgentVideoAspectRatio = "16:9";

export function listHomeAgentVideoModels(): HomeAgentVideoModelOption[] {
  return VIDEO_MODEL_OPTIONS;
}

export function listHomeAgentVideoResolutions(): HomeAgentVideoResolutionOption[] {
  return VIDEO_RESOLUTION_OPTIONS;
}

export function listHomeAgentVideoAspectRatios(): HomeAgentVideoAspectRatio[] {
  return [...VIDEO_ASPECT_RATIO_OPTIONS];
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

export function videoModelSupportsAspectRatio(
  modelKey?: string | null,
  aspectRatio?: string | null,
): boolean {
  const normalizedModel = normalizeHomeAgentVideoModelKey(modelKey);
  const normalizedAspectRatio = String(aspectRatio || "").trim();
  return VIDEO_MODEL_ASPECT_RATIO_SUPPORT[normalizedModel].includes(
    normalizedAspectRatio as HomeAgentVideoAspectRatio,
  );
}

export function normalizeVideoGenerationAspectRatio(
  value?: string | null,
): HomeAgentVideoAspectRatio {
  const normalized = String(value || "").trim();
  return VIDEO_ASPECT_RATIO_OPTIONS.includes(normalized as HomeAgentVideoAspectRatio)
    ? (normalized as HomeAgentVideoAspectRatio)
    : DEFAULT_HOME_AGENT_VIDEO_ASPECT_RATIO;
}

function resolveSupportedVideoAspectRatio(
  modelKey?: string | null,
  aspectRatio?: string | null,
): HomeAgentVideoAspectRatio {
  const normalizedModel = normalizeHomeAgentVideoModelKey(modelKey);
  const normalizedAspectRatio = normalizeVideoGenerationAspectRatio(aspectRatio);
  if (videoModelSupportsAspectRatio(normalizedModel, normalizedAspectRatio)) {
    return normalizedAspectRatio;
  }
  return VIDEO_MODEL_ASPECT_RATIO_SUPPORT[normalizedModel][0] ?? DEFAULT_HOME_AGENT_VIDEO_ASPECT_RATIO;
}

export function normalizeHomeAgentVideoModelKey(
  value?: string | null,
): VideoGenerationModelKey {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === SEEDANCE_1_5_PRO_MODEL_KEY ||
    normalized === "doubao-seedance-1-5-pro_480p" ||
    normalized === "doubao-seedance-1-5-pro_720p" ||
    normalized === "doubao-seedance-1-5-pro_1080p" ||
    normalized === "doubao-seedance-1-5-pro_2k" ||
    normalized === "doubao-seedance-1-5-pro_4k" ||
    normalized === "seedance-1-5-pro" ||
    normalized === "seedance-1.5-pro"
  ) {
    return SEEDANCE_1_5_PRO_MODEL_KEY;
  }
  if (
    normalized === SEEDANCE_2_0_MODEL_KEY ||
    normalized === "seedance-2-0" ||
    normalized === "seedance-2.0" ||
    normalized === "seedance2.0"
  ) {
    return SEEDANCE_2_0_MODEL_KEY;
  }
  if (
    normalized === SEEDANCE_2_0_FAST_MODEL_KEY ||
    normalized === "seedance-2-0-fast" ||
    normalized === "seedance-2.0-fast" ||
    normalized === "seedance2.0fast"
  ) {
    return SEEDANCE_2_0_FAST_MODEL_KEY;
  }
  if (
    normalized === HAPPYHORSE_1_0_MODEL_KEY ||
    normalized === "happyhorse_1_0" ||
    normalized === "happyhorse-1.0-t2v" ||
    normalized === "happyhorse-1.0-i2v" ||
    normalized === "happyhorse-1.0-r2v"
  ) {
    return HAPPYHORSE_1_0_MODEL_KEY;
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
  const aspectRatio =
    typeof value?.aspectRatio === "string" && value.aspectRatio.trim()
      ? resolveSupportedVideoAspectRatio(modelKey, value.aspectRatio)
      : undefined;
  return {
    modelKey,
    resolution: videoModelSupportsResolution(modelKey, resolution)
      ? resolution
      : DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS.resolution,
    mode: normalizeVideoGenerationMode(value?.mode),
    ...(aspectRatio ? { aspectRatio } : {}),
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

export function getHomeAgentVideoGenerationBatchLimit(
  prefs?: Partial<VideoGenerationPrefs> | null,
): number {
  const normalized = normalizeVideoGenerationPrefs(prefs);
  return Math.max(
    1,
    Math.min(
      HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
      getHomeAgentVideoModelOption(normalized.modelKey).maxVideosPerRun,
    ),
  );
}

export function getHomeAgentVideoGenerationConcurrencyLimit(
  prefs?: Partial<VideoGenerationPrefs> | null,
): number {
  const normalized = normalizeVideoGenerationPrefs(prefs);
  return Math.max(
    1,
    Math.min(
      HOME_AGENT_VIDEO_GENERATION_BATCH_LIMIT,
      getHomeAgentVideoModelOption(normalized.modelKey).maxConcurrentGenerations,
    ),
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
  if (normalized.modelKey === SEEDANCE_1_5_PRO_MODEL_KEY) {
    return `${normalized.modelKey}_${normalized.resolution}`;
  }
  return normalized.modelKey;
}

export function resolveVideoGenerationProvider(
  prefs?: Partial<VideoGenerationPrefs> | null,
): HomeAgentVideoModelOption["provider"] {
  return getHomeAgentVideoModelOption(normalizeVideoGenerationPrefs(prefs).modelKey).provider;
}

export function videoModelSupportsRunningHubFallback(value?: string | null): boolean {
  const normalized = normalizeHomeAgentVideoModelKey(value);
  return (
    normalized === SEEDANCE_2_0_MODEL_KEY ||
    normalized === SEEDANCE_2_0_FAST_MODEL_KEY ||
    normalized === HAPPYHORSE_1_0_MODEL_KEY
  );
}

export function videoModelRequiresRunningHubTransport(
  prefs?: Partial<VideoGenerationPrefs> | null,
): boolean {
  const normalized = normalizeVideoGenerationPrefs(prefs);
  return (
    normalized.modelKey === SEEDANCE_2_0_MODEL_KEY &&
    (normalized.resolution === "2k" || normalized.resolution === "4k")
  );
}

export function videoModelSupportsDirectReferenceImage(value?: string | null): boolean {
  const normalized = normalizeHomeAgentVideoModelKey(value);
  switch (normalized) {
    case SEEDANCE_1_5_PRO_MODEL_KEY:
    case SEEDANCE_2_0_MODEL_KEY:
    case SEEDANCE_2_0_FAST_MODEL_KEY:
      return true;
    default:
      return true;
  }
}

export function videoModelSupportsMultiReferenceImages(value?: string | null): boolean {
  const normalized = normalizeHomeAgentVideoModelKey(value);
  switch (normalized) {
    case SEEDANCE_2_0_MODEL_KEY:
    case SEEDANCE_2_0_FAST_MODEL_KEY:
    case HAPPYHORSE_1_0_MODEL_KEY:
      return true;
    default:
      return false;
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

const VIDEO_MODEL_MIN_DURATION: Record<VideoGenerationModelKey, number> = {
  [SEEDANCE_1_5_PRO_MODEL_KEY]: 5,
  [SEEDANCE_2_0_MODEL_KEY]: 4,
  [SEEDANCE_2_0_FAST_MODEL_KEY]: 4,
  [HAPPYHORSE_1_0_MODEL_KEY]: 3,
};

const VIDEO_MODEL_MAX_DURATION: Record<VideoGenerationModelKey, number> = {
  [SEEDANCE_1_5_PRO_MODEL_KEY]: 12,
  [SEEDANCE_2_0_MODEL_KEY]: 15,
  [SEEDANCE_2_0_FAST_MODEL_KEY]: 15,
  [HAPPYHORSE_1_0_MODEL_KEY]: 15,
};

export function getVideoModelMinDuration(modelKey?: string | null): number {
  const normalized = normalizeHomeAgentVideoModelKey(modelKey);
  return VIDEO_MODEL_MIN_DURATION[normalized] ?? 4;
}

export function getVideoModelMaxDuration(modelKey?: string | null): number {
  const normalized = normalizeHomeAgentVideoModelKey(modelKey);
  return VIDEO_MODEL_MAX_DURATION[normalized] ?? 12;
}
