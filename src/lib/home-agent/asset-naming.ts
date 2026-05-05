import type { Scene } from "@/types/project";

function cleanSegment(value: string | null | undefined, fallback = "未命名"): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function sanitizeFileSegment(value: string | null | undefined, fallback = "未命名"): string {
  const normalized = cleanSegment(value, fallback)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function padNumber(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value)) return "00";
  return String(Math.max(0, Number(value))).padStart(digits, "0");
}

function viewLabel(view: string): string {
  const normalized = cleanSegment(view);
  const lookup: Record<string, string> = {
    front: "正面",
    side: "侧面",
    back: "背面",
    closeUp: "近景",
  };
  return lookup[normalized] || normalized;
}

function joinLabel(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => cleanSegment(part, ""))
    .filter(Boolean)
    .join(" · ");
}

function joinFileStem(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => sanitizeFileSegment(part, ""))
    .filter(Boolean)
    .join("_");
}

function buildShotLabel(scene: Pick<Scene, "sceneNumber" | "segmentLabel">): string {
  const shot = `镜头${padNumber(scene.sceneNumber)}`;
  return scene.segmentLabel ? `${shot} · 片段${cleanSegment(scene.segmentLabel)}` : shot;
}

function buildShotFileSegment(scene: Pick<Scene, "sceneNumber" | "segmentLabel">): string {
  const shot = `镜头${padNumber(scene.sceneNumber)}`;
  return scene.segmentLabel ? `${shot}_片段${sanitizeFileSegment(scene.segmentLabel)}` : shot;
}

export function buildCharacterAssetLabel(
  name: string,
  options?: {
    view?: string;
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinLabel([
    "角色",
    name,
    options?.view ? `视角-${viewLabel(options.view)}` : null,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `版本${padNumber(options.version)}` : null,
  ]);
}

export function buildSceneAssetLabel(
  name: string,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinLabel([
    "场景",
    name,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `版本${padNumber(options.version)}` : null,
  ]);
}

export function buildStoryboardAssetLabel(
  scene: Pick<Scene, "sceneNumber" | "segmentLabel" | "sceneName">,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinLabel([
    "分镜",
    buildShotLabel(scene),
    scene.sceneName,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `版本${padNumber(options.version)}` : null,
  ]);
}

export function buildVideoAssetLabel(
  scene: Pick<Scene, "sceneNumber" | "segmentLabel" | "sceneName">,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinLabel([
    buildShotLabel(scene),
    scene.sceneName,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `版本${padNumber(options.version)}` : null,
  ]);
}

export function buildCharacterAssetFileStem(
  name: string,
  options?: {
    view?: string;
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinFileStem([
    "角色",
    name,
    options?.view ? `视角-${viewLabel(options.view)}` : null,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `v${padNumber(options.version)}` : null,
  ]);
}

export function buildSceneAssetFileStem(
  name: string,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinFileStem([
    "场景",
    name,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `v${padNumber(options.version)}` : null,
  ]);
}

export function buildStoryboardAssetFileStem(
  scene: Pick<Scene, "sceneNumber" | "segmentLabel" | "sceneName">,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinFileStem([
    "分镜",
    buildShotFileSegment(scene),
    scene.sceneName,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `v${padNumber(options.version)}` : null,
  ]);
}

export function buildVideoAssetFileStem(
  scene: Pick<Scene, "sceneNumber" | "segmentLabel" | "sceneName">,
  options?: {
    variantLabel?: string;
    version?: number;
  },
): string {
  return joinFileStem([
    buildShotFileSegment(scene),
    scene.sceneName,
    options?.variantLabel ? `变体-${options.variantLabel}` : null,
    options?.version ? `v${padNumber(options.version)}` : null,
  ]);
}

function buildEpisodePrefix(segmentLabel: string): string {
  const match = segmentLabel.match(/^(\d+)-/);
  return match ? `第${match[1]}集` : "";
}

export function buildSegmentVideoLabel(segmentLabel: string): string {
  const ep = buildEpisodePrefix(segmentLabel);
  return joinLabel([ep || null, `片段${cleanSegment(segmentLabel)}`]);
}

export function buildSegmentVideoFileStem(segmentLabel: string): string {
  const ep = buildEpisodePrefix(segmentLabel);
  return joinFileStem([ep || null, `片段${sanitizeFileSegment(segmentLabel)}`]);
}

export function resolveNextAssetVersion(
  currentUrl: string | null | undefined,
  history: ReadonlyArray<unknown> | null | undefined,
): number {
  return (history?.length ?? 0) + (currentUrl ? 2 : 1);
}

export function appendDuplicateLabelSequence<T extends { label: string }>(items: T[]): T[] {
  const totals = new Map<string, number>();
  items.forEach((item) => {
    const key = item.label.trim();
    totals.set(key, (totals.get(key) || 0) + 1);
  });

  const positions = new Map<string, number>();
  return items.map((item) => {
    const key = item.label.trim();
    const total = totals.get(key) || 0;
    if (total <= 1) return item;
    const position = (positions.get(key) || 0) + 1;
    positions.set(key, position);
    return {
      ...item,
      label: `${item.label} · ${padNumber(position)}`,
    };
  });
}
