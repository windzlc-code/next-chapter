export interface Scene {
  id: string;
  sceneNumber: number;
  sceneName: string;
  description: string;
  characters: string[];
  dialogue: string;
  cameraDirection: string;
  segmentLabel?: string; // e.g. "1-1", "1-2"
  duration: number; // seconds
  storyboardUrl?: string;
  storyboardHistory?: string[]; // previously generated reference images
  panoramaUrl?: string; // panoramic positioning reference for scene group
  videoUrl?: string;
  videoTaskId?: string;
  videoProvider?: string;
  videoStatus?: string; // queued | processing | completed | failed
  videoFailure?: VideoFailureInfo;
  videoHistory?: VideoHistoryEntry[];
  recommendedDuration?: number;
  isManualDuration?: boolean; // true when user manually set duration
  characterCostumes?: Record<string, string>; // { characterName: costumeId }
  sceneTimeVariantId?: string; // explicit time variant chosen for this shot
  enhancedVideoPrompt?: string; // cached result from prepare_video_prompt_batch
}

export interface VideoFailureInfo {
  message: string;
  provider?: string;
  stage?: "submit" | "status" | string;
  updatedAt: string;
}

export interface VideoHistoryEntry {
  videoUrl: string;
  createdAt: string;
}

export interface ImageHistoryEntry {
  imageUrl: string;
  description: string;
  createdAt: string;
}

export interface CostumeSetting {
  id: string;
  label: string;
  description: string;
  imageUrl?: string;
  isAIGenerated: boolean;
  imageHistory?: ImageHistoryEntry[];
}

export interface CharacterSetting {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  audioUrl?: string;
  audioFileName?: string;
  threeViewUrls?: {
    front?: string;
    side?: string;
    back?: string;
    closeUp?: string;
  };
  isAIGenerated: boolean;
  isGenerating?: boolean;
  source: 'auto' | 'manual'; // auto = detected from script
  imageHistory?: ImageHistoryEntry[];
  costumes?: CostumeSetting[];
  activeCostumeId?: string;
}

export interface TimeVariantSetting {
  id: string;
  label: string;       // e.g. "黄昏", "夜间", "清晨"
  description: string;
  imageUrl?: string;
  isAIGenerated: boolean;
  imageHistory?: ImageHistoryEntry[];
}

export interface SceneSetting {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  isAIGenerated: boolean;
  isGenerating?: boolean;
  source: 'auto' | 'manual';
  imageHistory?: ImageHistoryEntry[];
  timeVariants?: TimeVariantSetting[];
  activeTimeVariantId?: string;
}

export type ProductionAssetKind =
  | "character-reference"
  | "character-sheet"
  | "image"
  | "costume-reference"
  | "scene-reference"
  | "time-variant"
  | "storyboard-frame"
  | "video-segment";

export type ProductionAssetStatus = "ready" | "needs-review" | "failed";

export interface ProductionAssetRecord {
  id: string;
  kind: ProductionAssetKind;
  label: string;
  url?: string;
  meta?: string;
  reusable?: boolean;
  status: ProductionAssetStatus;
  source?: string;
  origin?: "derived" | "manual";
  sourceEntityId?: string;
  sceneId?: string;
  sceneNumber?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductionAssetManifest {
  version?: string;
  summary?: string;
  updatedAt?: string;
  items: ProductionAssetRecord[];
}

export interface VideoStyleLock {
  genre: string[];
  tone: string;
  visualStyle: string;
  cameraLanguage?: string | string[];
  performanceDirection?: string;
  negativeRules?: string[];
  updatedAt?: string;
  colorMood?: string;
  cinematography?: string;
  forbidden?: string[];
  referencePromptTemplate?: string;
}

export interface VideoWorldModelCharacter {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  currentState: string;
  constraints: string[];
  referenceAssetIds: string[];
}

export interface VideoWorldModelScene {
  id: string;
  name: string;
  description: string;
  timeVariantLabels: string[];
  referenceAssetIds: string[];
}

export interface VideoWorldModel {
  version: string;
  synopsis: string;
  continuityRules: string[];
  characters: VideoWorldModelCharacter[];
  scenes: VideoWorldModelScene[];
}

export interface ShotPacketCharacterRef {
  characterId: string;
  name: string;
  assetIds: string[];
  mustPreserve: string[];
}

export interface ShotPacketBackgroundRef {
  sceneSettingId?: string;
  name: string;
  assetIds: string[];
  timeVariant?: string;
}

export interface VideoShotPacket {
  id: string;
  sceneId: string;
  sceneNumber: number;
  title: string;
  durationSec: number;
  camera: {
    shotSize: string;
    movement: string;
  };
  characterRefs: ShotPacketCharacterRef[];
  backgroundRef?: ShotPacketBackgroundRef;
  sourceAssetIds: string[];
  promptSeed: string;
  forbiddenChanges: string[];
  renderMode: "img2video" | "text2video";
  reviewStatus?: string;
}

export interface VideoProductionBundleMeta {
  directoryPath: string;
  overviewPath: string;
  filePaths: string[];
  exportedCount: number;
  exportedAt: string;
}

export type VideoImageModelFamilyKey =
  | "nano-banana-pro"
  | "nano-banana-2"
  | "nano-banana-2-async"
  | "gpt-image-2";

export type VideoImageResolution = "default" | "2k" | "4k";

export type VideoImageAspectRatio =
  | "16:9"
  | "9:16"
  | "1:1"
  | "2:3"
  | "3:2";

export type VideoImageStyleCategory =
  | "realistic"
  | "animation-3d"
  | "animation-2d"
  | "custom";

export type VideoImageStylePreset =
  | "live-action"
  | "hyper-cg"
  | "3d-cartoon"
  | "2.5d-stylized"
  | "anime-3d"
  | "cel-animation"
  | "retro-comic"
  | "custom";

export interface VideoImageGenerationPrefs {
  familyKey: VideoImageModelFamilyKey;
  resolution: VideoImageResolution;
  aspectRatio: VideoImageAspectRatio;
  styleCategory: VideoImageStyleCategory;
  stylePreset: VideoImageStylePreset;
  viewMode?: "single" | "three";
  customStylePrompt?: string;
}

export type VideoGenerationModelKey = "doubao-seedance-1-5-pro";

export type VideoGenerationResolution = "480p" | "720p" | "1080p" | "2k" | "4k";

export type VideoGenerationMode = "text-to-video" | "image-to-video";

export interface VideoGenerationPrefs {
  modelKey: VideoGenerationModelKey;
  resolution: VideoGenerationResolution;
  mode: VideoGenerationMode;
  provider?: string;
  aspectRatio?: string;
}

export interface Project {
  id: string;
  title: string;
  script: string;
  scenes: Scene[];
  characters: CharacterSetting[];
  sceneSettings: SceneSetting[];
  currentStep: number;
  createdAt: string;
  updatedAt: string;
}

export type ArtStyle = VideoImageStylePreset | string;

export const ART_STYLE_LABELS: Record<VideoImageStylePreset, string> = {
  'live-action': '真人影视',
  'hyper-cg': '超写实 CG',
  '3d-cartoon': '3D欧美卡通',
  '2.5d-stylized': '2.5D绘本风',
  'anime-3d': '三渲二动漫',
  'cel-animation': '传统赛璐璐',
  'retro-comic': '美式复古漫画风',
  'custom': '自定义',
};

export type VideoModel = 'seedance-1.5-pro' | 'seedance-2.0' | 'seedance-2.0-fast' | 'sora-2';

export const VIDEO_MODEL_LABELS: Record<VideoModel, string> = {
  'seedance-1.5-pro': '即梦 1.5 Pro',
  'seedance-2.0': '即梦 Seedance 2.0',
  'seedance-2.0-fast': '即梦 Seedance 2.0 Fast',
  'sora-2': 'Sora 2',
};

export const VIDEO_MODEL_API_MAP: Record<VideoModel, string> = {
  'seedance-1.5-pro': 'doubao-seedance-1-5-pro', // Will be mapped based on resolution
  'seedance-2.0': 'seedance2.0',
  'seedance-2.0-fast': 'seedance2.0fast',
  'sora-2': 'sora-2', // Will be mapped to sora-2 or sora-2-pro based on resolution
};

export type EpisodeDuration = '60' | '90' | '120' | 'custom';

export const EPISODE_DURATION_OPTIONS: { value: EpisodeDuration; label: string }[] = [
  { value: '60', label: '60s' },
  { value: '90', label: '90s' },
  { value: '120', label: '120s' },
  { value: 'custom', label: '自定义' },
];

export function getSegmentsForDuration(duration: EpisodeDuration, customSeconds?: number): number | null {
  if (duration === 'custom') {
    return customSeconds ? Math.floor(customSeconds / 15) + 1 : null;
  }
  return Math.floor(Number(duration) / 15) + 1;
}

export interface SegmentVideoPrompt {
  segmentLabel: string;
  prompt: string;
  duration: number;
  targetDuration: number;
  modelKey: string;
  maxDurationForModel: number;
  sceneIds: string[];
  generatedAt: string;
}

export interface SegmentVideoStatus {
  segmentLabel: string;
  status: string; // queued | processing | completed | failed
  taskId?: string;
  provider?: string;
  failure?: VideoFailureInfo;
  updatedAt: string;
}

export type VideoPace = 'slow' | 'medium' | 'fast';

export const VIDEO_PACE_OPTIONS: { value: VideoPace; label: string; desc: string }[] = [
  { value: 'slow', label: '慢速', desc: '1句≤22字 2句≤18字 3句≤14字' },
  { value: 'medium', label: '中等', desc: '1句≤27字 2句≤22字 3句≤17字' },
  { value: 'fast', label: '快速', desc: '1句≤32字 2句≤26字 3句≤20字' },
];
