import type {
  ArtStyle,
  VideoImageAspectRatio,
  VideoImageGenerationPrefs,
  VideoImageModelFamilyKey,
  VideoImageResolution,
  VideoImageStyleCategory,
  VideoImageStylePreset,
} from "@/types/project";

export const HOME_AGENT_IMAGE_PREFS_STORAGE_KEY = "storyforge-home-agent-image-prefs-v1";

export const DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS: VideoImageGenerationPrefs = {
  familyKey: "gpt-image-2",
  resolution: "default",
  aspectRatio: "16:9",
  styleCategory: "realistic",
  stylePreset: "live-action",
  viewMode: "three",
};

export interface HomeAgentImageModelFamilyOption {
  key: VideoImageModelFamilyKey;
  label: string;
  description: string;
  maxImagesPerRun: number;
}

export interface HomeAgentImageStyleCategoryOption {
  key: VideoImageStyleCategory;
  label: string;
  description: string;
}

export interface HomeAgentImageStylePresetOption {
  key: VideoImageStylePreset;
  category: VideoImageStyleCategory;
  label: string;
  description: string;
}

export interface ResolvedVideoImageGenerationModel {
  prefs: VideoImageGenerationPrefs;
  family: HomeAgentImageModelFamilyOption;
  resolvedModel: string;
  transportModel: string;
  fallbackModel: string;
  successFamily: VideoImageModelFamilyKey;
  providerAspectRatio: VideoImageAspectRatio;
  providerImageSize: "1K" | "2K" | "4K";
  usesAsyncTransport: boolean;
  usesImageGenerationsEndpoint: boolean;
}

const FAMILY_OPTIONS: HomeAgentImageModelFamilyOption[] = [
  {
    key: "nano-banana-pro",
    label: "nano-banana-pro",
    description: "Tuzi image generation production route for stable Gemini native images.",
    maxImagesPerRun: 4,
  },
  {
    key: "nano-banana-2",
    label: "nano-banana 2",
    description: "Production Gemini 3 Pro Image route through /v1/images/generations.",
    maxImagesPerRun: 4,
  },
  {
    key: "nano-banana-2-async",
    label: "nano-banana 2-async",
    description: "Async Gemini 3 Pro Image test route through /v1/videos polling.",
    maxImagesPerRun: 3,
  },
  {
    key: "gpt-image-2",
    label: "gpt-image-2",
    description: "OpenAI-compatible image generation route through /v1/images/generations.",
    maxImagesPerRun: 8,
  },
];

const STYLE_CATEGORY_OPTIONS: HomeAgentImageStyleCategoryOption[] = [
  {
    key: "realistic",
    label: "写实类",
    description: "适合真人影视与超写实 CG 的镜头表达。",
  },
  {
    key: "animation-3d",
    label: "三维动画类",
    description: "适合 3D 卡通、绘本感和三渲二画面。",
  },
  {
    key: "animation-2d",
    label: "二维动画类",
    description: "适合赛璐璐和美式复古漫画等平面动画风格。",
  },
  {
    key: "custom",
    label: "自定义",
    description: "通过对话和上传图片告诉 agent 你的专属画面风格。",
  },
];

const STYLE_PRESET_OPTIONS: HomeAgentImageStylePresetOption[] = [
  {
    key: "live-action",
    category: "realistic",
    label: "真人影视",
    description: "自然镜头语言、真实布光和影视摄影质感。",
  },
  {
    key: "hyper-cg",
    category: "realistic",
    label: "超写实CG",
    description: "写实比例与材质细节，强调高精度 CG 渲染感。",
  },
  {
    key: "3d-cartoon",
    category: "animation-3d",
    label: "3D欧美卡通",
    description: "欧美动画电影常见的高完成度三维卡通风格。",
  },
  {
    key: "2.5d-stylized",
    category: "animation-3d",
    label: "2.5D绘本风",
    description: "介于绘本与三维之间，强调层次感和柔和造型。",
  },
  {
    key: "anime-3d",
    category: "animation-3d",
    label: "三渲二动漫",
    description: "三维建模结合二维动漫渲染表现。",
  },
  {
    key: "cel-animation",
    category: "animation-2d",
    label: "传统赛璐璐",
    description: "传统二维动画的清晰线稿与分层上色效果。",
  },
  {
    key: "retro-comic",
    category: "animation-2d",
    label: "美式复古漫画风",
    description: "复古美漫印刷感、网点与强烈轮廓线。",
  },
  {
    key: "custom",
    category: "custom",
    label: "自定义",
    description: "通过对话描述和上传参考图来驱动画面风格。",
  },
];

const RESOLUTION_MODEL_MAP: Record<
  VideoImageModelFamilyKey,
  Record<VideoImageResolution, string>
> = {
  "nano-banana-pro": {
    default: "nano-banana-pro",
    "2k": "nano-banana-pro-2k",
    "4k": "nano-banana-pro-4k",
  },
  "nano-banana-2": {
    default: "gemini-3-pro-image-preview",
    "2k": "gemini-3-pro-image-preview-2k",
    "4k": "gemini-3-pro-image-preview-4k",
  },
  "nano-banana-2-async": {
    default: "gemini-3-pro-image-preview",
    "2k": "gemini-3-pro-image-preview-2k",
    "4k": "gemini-3-pro-image-preview-4k",
  },
  "gpt-image-2": {
    default: "gpt-image-2",
    "2k": "gpt-image-2",
    "4k": "gpt-image-2",
  },
};

const GEMINI_TRANSPORT_MODEL_MAP: Record<VideoImageResolution, string> = {
  default: "gemini-3-pro-image-preview-async",
  "2k": "gemini-3-pro-image-preview-2k-async",
  "4k": "gemini-3-pro-image-preview-4k-async",
};

const LEGACY_MODEL_TO_PREFS: Record<string, Partial<VideoImageGenerationPrefs>> = {
  "ano-banana-pro": { familyKey: "nano-banana-pro" },
  "nano-banana-pro": { familyKey: "nano-banana-pro", resolution: "default" },
  "nano-banana-pro-2k": { familyKey: "nano-banana-pro", resolution: "2k" },
  "nano-banana-pro-4k": { familyKey: "nano-banana-pro", resolution: "4k" },
  "nano-banana-2": { familyKey: "nano-banana-2", resolution: "default" },
  "nano-banana-2-2k": { familyKey: "nano-banana-2", resolution: "2k" },
  "nano-banana-2-4k": { familyKey: "nano-banana-2", resolution: "4k" },
  "nano-banana-2-async": { familyKey: "nano-banana-2-async", resolution: "default" },
  "nano-banana-2-2k-async": { familyKey: "nano-banana-2-async", resolution: "2k" },
  "nano-banana-2-4k-async": { familyKey: "nano-banana-2-async", resolution: "4k" },
  "gemini-3-pro-image-preview": { familyKey: "nano-banana-2", resolution: "default" },
  "gemini-3-pro-image-preview-2k": { familyKey: "nano-banana-2", resolution: "2k" },
  "gemini-3-pro-image-preview-4k": { familyKey: "nano-banana-2", resolution: "4k" },
  "gemini-3-pro-image-preview-async": { familyKey: "nano-banana-2-async", resolution: "default" },
  "gemini-3-pro-image-preview-2k-async": { familyKey: "nano-banana-2-async", resolution: "2k" },
  "gemini-3-pro-image-preview-4k-async": { familyKey: "nano-banana-2-async", resolution: "4k" },
  "gpt-image-2": { familyKey: "gpt-image-2", resolution: "default" },
};

const STYLE_CATEGORY_DEFAULT_PRESET: Record<VideoImageStyleCategory, VideoImageStylePreset> = {
  realistic: "live-action",
  "animation-3d": "3d-cartoon",
  "animation-2d": "cel-animation",
  custom: "custom",
};

const RESOLUTION_LABELS: Record<VideoImageResolution, string> = {
  default: "1K",
  "2k": "2K",
  "4k": "4K",
};

const SUPPORTED_ASPECT_RATIOS: VideoImageAspectRatio[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "2:3",
  "3:2",
];
const SINGLE_VIEW_SUPPORTED_ASPECT_RATIOS: VideoImageAspectRatio[] = [
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
  "2:3",
  "3:2",
];

function normalizeVideoImageViewMode(
  value?: string | null,
): NonNullable<VideoImageGenerationPrefs["viewMode"]> {
  return value === "single" ? "single" : "three";
}

export function listHomeAgentImageModelFamilies(): HomeAgentImageModelFamilyOption[] {
  return FAMILY_OPTIONS;
}

export function listHomeAgentImageStyleCategories(): HomeAgentImageStyleCategoryOption[] {
  return STYLE_CATEGORY_OPTIONS;
}

export function listHomeAgentImageStylePresets(
  category?: VideoImageStyleCategory | null,
): HomeAgentImageStylePresetOption[] {
  const normalizedCategory = category ? normalizeVideoImageStyleCategory(category) : null;
  return normalizedCategory
    ? STYLE_PRESET_OPTIONS.filter((option) => option.category === normalizedCategory)
    : STYLE_PRESET_OPTIONS;
}

export function listHomeAgentImageResolutions(): Array<{ value: VideoImageResolution; label: string }> {
  return (Object.keys(RESOLUTION_LABELS) as VideoImageResolution[]).map((value) => ({
    value,
    label: RESOLUTION_LABELS[value],
  }));
}

export function listHomeAgentImageAspectRatios(): VideoImageAspectRatio[] {
  return [...SUPPORTED_ASPECT_RATIOS];
}

export function listHomeAgentImageAspectRatiosForViewMode(
  viewMode?: string | null,
): VideoImageAspectRatio[] {
  return normalizeVideoImageViewMode(viewMode) === "single"
    ? [...SINGLE_VIEW_SUPPORTED_ASPECT_RATIOS]
    : [...SUPPORTED_ASPECT_RATIOS];
}

export function normalizeHomeAgentImageModelFamilyKey(
  value?: string | null,
): VideoImageModelFamilyKey {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey;
  if (normalized === "ano-banana-pro") return "nano-banana-pro";
  if (
    normalized === "gemini-3-pro-image-preview" ||
    normalized === "gemini-3-pro-image-preview-2k" ||
    normalized === "gemini-3-pro-image-preview-4k"
  ) {
    return "nano-banana-2";
  }
  if (
    normalized === "gemini-3-pro-image-preview-async" ||
    normalized === "gemini-3-pro-image-preview-2k-async" ||
    normalized === "gemini-3-pro-image-preview-4k-async"
  ) {
    return "nano-banana-2-async";
  }
  return FAMILY_OPTIONS.some((option) => option.key === normalized)
    ? (normalized as VideoImageModelFamilyKey)
    : DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.familyKey;
}

export function normalizeVideoImageResolution(value?: string | null): VideoImageResolution {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "default" || normalized === "2k" || normalized === "4k"
    ? (normalized as VideoImageResolution)
    : DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.resolution;
}

export function normalizeVideoImageAspectRatio(value?: string | null): VideoImageAspectRatio {
  const normalized = String(value || "").trim();
  return SUPPORTED_ASPECT_RATIOS.includes(normalized as VideoImageAspectRatio)
    ? (normalized as VideoImageAspectRatio)
    : DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.aspectRatio;
}

export function imageViewModeSupportsAspectRatio(
  viewMode?: string | null,
  aspectRatio?: string | null,
): boolean {
  const normalizedAspectRatio = normalizeVideoImageAspectRatio(aspectRatio);
  return listHomeAgentImageAspectRatiosForViewMode(viewMode).includes(normalizedAspectRatio);
}

export function resolveVideoImageAspectRatioForViewMode(
  viewMode?: string | null,
  aspectRatio?: string | null,
): VideoImageAspectRatio {
  const normalizedAspectRatio = normalizeVideoImageAspectRatio(aspectRatio);
  if (imageViewModeSupportsAspectRatio(viewMode, normalizedAspectRatio)) {
    return normalizedAspectRatio;
  }
  return normalizeVideoImageViewMode(viewMode) === "single"
    ? SINGLE_VIEW_SUPPORTED_ASPECT_RATIOS[0]
    : normalizedAspectRatio;
}

export function applyVideoImageViewModeConstraints(
  value?: Partial<VideoImageGenerationPrefs> | null,
): VideoImageGenerationPrefs {
  const normalized = normalizeVideoImageGenerationPrefs(value);
  if (normalized.viewMode !== "single") {
    return normalized;
  }
  return {
    ...normalized,
    aspectRatio: resolveVideoImageAspectRatioForViewMode(
      normalized.viewMode,
      normalized.aspectRatio,
    ),
  };
}

export function inferVideoImageStyleCategoryFromPreset(
  preset?: string | null,
): VideoImageStyleCategory {
  const normalized = String(preset || "").trim() as VideoImageStylePreset;
  return (
    STYLE_PRESET_OPTIONS.find((option) => option.key === normalized)?.category ??
    DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.styleCategory
  );
}

export function normalizeVideoImageStyleCategory(
  value?: string | null,
  preset?: string | null,
): VideoImageStyleCategory {
  const normalized = String(value || "").trim() as VideoImageStyleCategory;
  if (STYLE_CATEGORY_OPTIONS.some((option) => option.key === normalized)) {
    return normalized;
  }
  return inferVideoImageStyleCategoryFromPreset(preset);
}

export function normalizeVideoImageStylePreset(
  value?: string | null,
  category?: string | null,
): VideoImageStylePreset {
  const normalized = String(value || "").trim() as VideoImageStylePreset;
  if (STYLE_PRESET_OPTIONS.some((option) => option.key === normalized)) {
    return normalized;
  }
  const resolvedCategory = normalizeVideoImageStyleCategory(category, normalized);
  return STYLE_CATEGORY_DEFAULT_PRESET[resolvedCategory];
}

export function normalizeVideoImageCustomStylePrompt(value?: string | null): string | undefined {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 600) : undefined;
}

export function getHomeAgentImageStylePresetOption(
  value?: string | null,
): HomeAgentImageStylePresetOption {
  const normalized = normalizeVideoImageStylePreset(value);
  return (
    STYLE_PRESET_OPTIONS.find((option) => option.key === normalized) ??
    STYLE_PRESET_OPTIONS[0]
  );
}

export function buildLegacyVideoImageStylePrefs(
  artStyle?: ArtStyle | null,
): Partial<VideoImageGenerationPrefs> {
  const stylePreset = normalizeVideoImageStylePreset(artStyle);
  const styleCategory = inferVideoImageStyleCategoryFromPreset(stylePreset);
  return { styleCategory, stylePreset };
}

export function resolveVideoImageProjectArtStyle(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
  fallback: ArtStyle = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.stylePreset,
): ArtStyle {
  const normalized = normalizeVideoImageGenerationPrefs({
    ...buildLegacyVideoImageStylePrefs(fallback),
    ...(prefs ?? {}),
  });
  return normalized.stylePreset;
}

export function resolveVideoImagePromptStyle(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
  fallback: ArtStyle = DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.stylePreset,
): string {
  const normalized = normalizeVideoImageGenerationPrefs({
    ...buildLegacyVideoImageStylePrefs(fallback),
    ...(prefs ?? {}),
  });
  if (normalized.stylePreset !== "custom") return normalized.stylePreset;
  const customStylePrompt = normalizeVideoImageCustomStylePrompt(normalized.customStylePrompt);
  if (customStylePrompt) {
    return `custom:${customStylePrompt}`;
  }
  return fallback === "custom" ? DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS.stylePreset : fallback;
}

export function buildVideoImageStyleSummary(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
): string {
  const normalized = normalizeVideoImageGenerationPrefs(prefs);
  const categoryLabel =
    STYLE_CATEGORY_OPTIONS.find((option) => option.key === normalized.styleCategory)?.label ??
    STYLE_CATEGORY_OPTIONS[0].label;
  const presetLabel = getHomeAgentImageStylePresetOption(normalized.stylePreset).label;
  return normalized.stylePreset === "custom" && normalized.customStylePrompt?.trim()
    ? `${categoryLabel} · 自定义`
    : `${categoryLabel} · ${presetLabel}`;
}

export function normalizeVideoImageGenerationPrefs(
  value?: Partial<VideoImageGenerationPrefs> | null,
): VideoImageGenerationPrefs {
  const styleCategory = normalizeVideoImageStyleCategory(
    value?.styleCategory,
    value?.stylePreset,
  );
  const stylePreset = normalizeVideoImageStylePreset(value?.stylePreset, styleCategory);
  const customStylePrompt = normalizeVideoImageCustomStylePrompt(value?.customStylePrompt);
  return {
    familyKey: normalizeHomeAgentImageModelFamilyKey(value?.familyKey),
    resolution: normalizeVideoImageResolution(value?.resolution),
    aspectRatio: normalizeVideoImageAspectRatio(value?.aspectRatio),
    styleCategory,
    stylePreset,
    viewMode: normalizeVideoImageViewMode(value?.viewMode),
    ...(customStylePrompt ? { customStylePrompt } : {}),
  };
}

export function readStoredHomeAgentImageGenerationPrefs(): VideoImageGenerationPrefs {
  if (typeof window === "undefined") return DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS;

  try {
    const raw = window.localStorage.getItem(HOME_AGENT_IMAGE_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS;
    return normalizeVideoImageGenerationPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS;
  }
}

export function writeStoredHomeAgentImageGenerationPrefs(
  prefs: Partial<VideoImageGenerationPrefs> | null | undefined,
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      HOME_AGENT_IMAGE_PREFS_STORAGE_KEY,
      JSON.stringify(normalizeVideoImageGenerationPrefs(prefs)),
    );
  } catch {
    // Ignore persistence failures and keep the in-memory choice.
  }
}

export function getHomeAgentImageModelFamilyOption(
  value?: string | null,
): HomeAgentImageModelFamilyOption {
  const normalized = normalizeHomeAgentImageModelFamilyKey(value);
  return (
    FAMILY_OPTIONS.find((option) => option.key === normalized) ??
    FAMILY_OPTIONS[0]
  );
}

export function getVideoImageGenerationBatchLimit(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
): number {
  const normalized = normalizeVideoImageGenerationPrefs(prefs);
  const family = getHomeAgentImageModelFamilyOption(normalized.familyKey);
  if (normalized.resolution === "4k") return Math.max(1, Math.min(family.maxImagesPerRun, 2));
  if (normalized.resolution === "2k") return Math.max(1, Math.min(family.maxImagesPerRun, 3));
  return Math.max(1, family.maxImagesPerRun);
}

export function getVideoImageResolutionLabel(value?: string | null): string {
  return RESOLUTION_LABELS[normalizeVideoImageResolution(value)];
}

export function buildVideoImageGenerationSummary(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
): string {
  const normalized = normalizeVideoImageGenerationPrefs(prefs);
  return `${getVideoImageResolutionLabel(normalized.resolution)} · ${normalized.aspectRatio}`;
}

export function resolveLegacyVideoImageModelPrefs(
  value?: string | null,
): Partial<VideoImageGenerationPrefs> | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized ? LEGACY_MODEL_TO_PREFS[normalized] ?? null : null;
}

export function resolveVideoImageGenerationPrefs(
  prefs?: Partial<VideoImageGenerationPrefs> | null,
): ResolvedVideoImageGenerationModel {
  const normalized = normalizeVideoImageGenerationPrefs(prefs);
  const family = getHomeAgentImageModelFamilyOption(normalized.familyKey);
  const resolvedModel = RESOLUTION_MODEL_MAP[normalized.familyKey][normalized.resolution];
  const isAsyncFamily = normalized.familyKey === "nano-banana-2-async";

  return {
    prefs: normalized,
    family,
    resolvedModel,
    transportModel: isAsyncFamily
      ? GEMINI_TRANSPORT_MODEL_MAP[normalized.resolution]
      : resolvedModel,
    fallbackModel: resolvedModel,
    successFamily: normalized.familyKey,
    providerAspectRatio: normalized.aspectRatio,
    providerImageSize:
      normalized.resolution === "4k"
        ? "4K"
        : normalized.resolution === "default"
          ? "1K"
          : "2K",
    usesAsyncTransport: isAsyncFamily,
    usesImageGenerationsEndpoint: true,
  };
}

export function resolveVideoImageRequestPrefs(input: {
  model?: string | null;
  modelFamily?: string | null;
  resolution?: string | null;
  aspectRatio?: string | null;
  imageGenerationPrefs?: Partial<VideoImageGenerationPrefs> | null;
}): ResolvedVideoImageGenerationModel {
  const legacyPrefs = resolveLegacyVideoImageModelPrefs(input.model);
  const requestPrefs: Partial<VideoImageGenerationPrefs> = {
    ...legacyPrefs,
    ...(input.imageGenerationPrefs ?? {}),
  };
  if (input.modelFamily) {
    requestPrefs.familyKey = normalizeHomeAgentImageModelFamilyKey(input.modelFamily);
  }
  if (input.resolution) {
    requestPrefs.resolution = normalizeVideoImageResolution(input.resolution);
  }
  if (input.aspectRatio) {
    requestPrefs.aspectRatio = normalizeVideoImageAspectRatio(input.aspectRatio);
  }
  return resolveVideoImageGenerationPrefs(requestPrefs);
}
