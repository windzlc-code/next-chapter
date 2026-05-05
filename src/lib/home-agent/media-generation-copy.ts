import type { StudioRuntimeState } from "@/lib/home-agent/types";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";

type MediaKind = "image" | "video";

const VIEW_PATTERNS: Array<[string, RegExp]> = [
  ["三视图", /三视图|三面图|front view|side view|back view/i],
  ["正面", /正面|正视|front view|front-facing/i],
  ["侧面", /侧面|侧视|profile|side view/i],
  ["背面", /背面|背视|rear view|back view/i],
  ["特写", /特写|close[- ]?up/i],
  ["近景", /近景|close shot/i],
  ["中景", /中景|medium shot/i],
  ["远景", /远景|long shot/i],
  ["全景", /全景|wide shot|panoramic/i],
  ["俯视", /俯视|鸟瞰|top view/i],
  ["仰视", /仰视|low angle/i],
  ["半身", /半身|half[- ]?body|waist up/i],
  ["全身", /全身|full[- ]?body|full body/i],
];

const VARIANT_PATTERNS: Array<[string, RegExp]> = [
  ["夜景", /夜景|夜晚|night/i],
  ["白天", /白天|日景|daylight|daytime/i],
  ["黄昏", /黄昏|夕阳|sunset|dusk/i],
  ["清晨", /清晨|黎明|dawn|sunrise/i],
  ["雨夜", /雨夜|rainy night/i],
  ["雪景", /雪景|snow/i],
];

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function truncateLabel(value: string, max = 22): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

function normalizePromptText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function localizePromptKind(action?: string, imageKind?: string): string {
  if (action === "generate_storyboard_frames") return "分镜";
  if (action === "generate_video_assets") return "镜头";
  if (action === "generate_video_reference_assets") return "参考素材";
  if (imageKind === "character") return "角色";
  if (imageKind === "scene") return "场景";
  return "内容";
}

function extractQuotedSubject(prompt: string): string {
  const patterns = [
    /《([^》]{2,24})》/,
    /"([^"]{2,24})"/,
    /'([^']{2,24})'/,
    /「([^」]{2,24})」/,
    /『([^』]{2,24})』/,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match?.[1]) return truncateLabel(match[1]);
  }
  return "";
}

function stripPromptVerbs(prompt: string): string {
  return prompt
    .replace(/^(请|请帮我|帮我|麻烦|现在|继续|直接|先|我要|我想|我需要|根据|按|把|将)+/u, "")
    .replace(/^(生成|创建|做|画|补齐|刷新|继续生成|重新生成|制作|产出)+/u, "")
    .replace(/^(一张|一幅|一个|一条|一段|一组|几张|几条|一些)+/u, "")
    .trim();
}

function extractPromptSubject(prompt: string): string {
  const quoted = extractQuotedSubject(prompt);
  if (quoted) return quoted;

  const firstClause = stripPromptVerbs(prompt)
    .split(/[，。,.;；\n]/)[0]
    ?.replace(/\b(default)\b/gi, "默认")
    .trim();
  if (!firstClause) return "";

  const cleaned = firstClause
    .replace(/(参考图|视频参考素材|分镜图|分镜帧|图片|图像|视频|镜头|素材)$/u, "")
    .replace(/(特写|近景|中景|远景|全景|俯视|仰视|正面|侧面|背面|半身|全身|三视图|夜景|白天|黄昏|清晨|雨夜|雪景)$/u, "")
    .replace(/^(一个|一位|一名)/u, "")
    .trim();

  return truncateLabel(cleaned || firstClause);
}

function collectPromptTags(prompt: string, patterns: Array<[string, RegExp]>): string[] {
  return unique(
    patterns
      .filter(([, pattern]) => pattern.test(prompt))
      .map(([label]) => label),
  ).slice(0, 2);
}

function detectPromptVariant(prompt: string): string {
  const match = prompt.match(/变体\s*([A-Za-z0-9一二三四五六七八九十]+)/u);
  return match?.[1] ? `变体 ${match[1]}` : "";
}

function formatSceneLabel(scene: PersistedVideoProject["scenes"][number]): string {
  return `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}`;
}

function matchesRuntimeEntityLabel(label: string | null | undefined, subject: string): boolean {
  const normalizedLabel = String(label || "").trim().toLowerCase();
  const normalizedSubject = String(subject || "").trim().toLowerCase();
  if (!normalizedLabel || !normalizedSubject) return false;
  return (
    normalizedLabel === normalizedSubject ||
    normalizedLabel.includes(normalizedSubject) ||
    normalizedSubject.includes(normalizedLabel)
  );
}

function collectRuntimeTargetContext(
  runtime: StudioRuntimeState | null | undefined,
  targetIds: string[] | undefined,
  promptSubject?: string,
  labelLimit = 2,
): { labels: string[]; sourceTexts: string[] } {
  const project = runtime?.currentVideoProject;
  if (!project) {
    return { labels: [], sourceTexts: [] };
  }

  const labels: string[] = [];
  const sourceTexts: string[] = [];
  const pushContext = (label: string, ...texts: Array<string | null | undefined>) => {
    labels.push(label);
    for (const text of texts) {
      const normalized = normalizePromptText(text);
      if (normalized) {
        sourceTexts.push(normalized);
      }
    }
  };

  if (targetIds?.length) {
    for (const targetId of targetIds) {
      // Strip reference prefixes (e.g. "reference-scene:id", "reference-character:id")
      let entityId = targetId;
      if (targetId.startsWith("reference-scene:")) {
        entityId = targetId.slice("reference-scene:".length);
      } else if (targetId.startsWith("reference-character-variant:")) {
        entityId = targetId.split(":")[2] ?? targetId;
      } else if (targetId.startsWith("reference-character:")) {
        entityId = targetId.slice("reference-character:".length);
      }

      const scene = project.scenes.find((item) => item.id === entityId);
      if (scene) {
        pushContext(formatSceneLabel(scene), scene.description, scene.cameraDirection, scene.sceneName);
        continue;
      }

      const character = project.characters.find((item) => item.id === entityId);
      if (character) {
        pushContext(`角色 ${character.name}`, character.description, character.name);
        continue;
      }

      const costumeOwner = project.characters.find((item) => item.costumes?.some((costume) => costume.id === entityId));
      const costume = costumeOwner?.costumes?.find((item) => item.id === entityId);
      if (costumeOwner && costume) {
        pushContext(`角色 ${costumeOwner.name} · 服装 ${costume.label}`, costumeOwner.description, costume.description, costume.label);
        continue;
      }

      const sceneSetting = project.sceneSettings.find((item) => item.id === entityId);
      if (sceneSetting) {
        const activeVariant = sceneSetting.timeVariants?.find((item) => item.id === sceneSetting.activeTimeVariantId);
        pushContext(`场景 ${sceneSetting.name}`, sceneSetting.description, activeVariant?.label, activeVariant?.description);
        continue;
      }

      const sceneVariantOwner = project.sceneSettings.find((item) =>
        item.timeVariants?.some((variant) => variant.id === entityId),
      );
      const sceneVariant = sceneVariantOwner?.timeVariants?.find((item) => item.id === entityId);
      if (sceneVariantOwner && sceneVariant) {
        pushContext(`场景 ${sceneVariantOwner.name} · 变体 ${sceneVariant.label}`, sceneVariantOwner.description, sceneVariant.label, sceneVariant.description);
      }
    }

    return {
      labels: unique(labels).slice(0, labelLimit),
      sourceTexts: unique(sourceTexts).slice(0, 4),
    };
  }

  if (promptSubject) {
    const matchingCharacter = project.characters.find((item) => matchesRuntimeEntityLabel(item.name, promptSubject));
    if (matchingCharacter) {
      pushContext(`角色 ${matchingCharacter.name}`, matchingCharacter.description, matchingCharacter.name);
    }

    const matchingScene = project.sceneSettings.find((item) => matchesRuntimeEntityLabel(item.name, promptSubject));
    if (matchingScene) {
      const activeVariant = matchingScene.timeVariants?.find((item) => item.id === matchingScene.activeTimeVariantId);
      pushContext(`场景 ${matchingScene.name}`, matchingScene.description, activeVariant?.label, activeVariant?.description);
    }

    for (const character of project.characters) {
      const matchingCostume = character.costumes?.find((item) => matchesRuntimeEntityLabel(item.label, promptSubject));
      if (matchingCostume) {
        pushContext(`角色 ${character.name} · 服装 ${matchingCostume.label}`, character.description, matchingCostume.description, matchingCostume.label);
      }
    }
  }

  return {
    labels: unique(labels).slice(0, labelLimit),
    sourceTexts: unique(sourceTexts).slice(0, 4),
  };
}

export function localizeMediaSettingValue(
  value: string | null | undefined,
  kind?: "mode" | "resolution" | "provider",
): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();

  if (lower === "default") return "默认";
  if (kind === "mode") {
    if (lower === "image-to-video") return "图生视频";
    if (lower === "text-to-video") return "文生视频";
  }
  if (kind === "provider") {
    if (lower === "jimeng" || lower === "dreamina") return "即梦";
  }

  return normalized;
}

export function buildMediaContentSummary(params: {
  action?: string;
  promptText?: string | null;
  imageKind?: string | null;
  runtime?: StudioRuntimeState | null;
  targetIds?: string[];
}): string {
  const prompt = normalizePromptText(params.promptText);
  const subject = prompt ? extractPromptSubject(prompt) : "";
  const runtimeContext = collectRuntimeTargetContext(params.runtime, params.targetIds, subject);
  const runtimeLabels = runtimeContext.labels;
  const parts = [...runtimeLabels];
  const analysisText = [prompt, ...runtimeContext.sourceTexts].filter(Boolean).join(" ");

  if (analysisText) {
    const viewTags = collectPromptTags(analysisText, VIEW_PATTERNS);
    const variantTags = unique([
      ...collectPromptTags(analysisText, VARIANT_PATTERNS),
      detectPromptVariant(analysisText),
    ].filter(Boolean)).slice(0, 2);

    if (!runtimeLabels.length && subject) {
      parts.push(`${localizePromptKind(params.action, String(params.imageKind || ""))} ${subject}`);
    }
    if (viewTags.length) {
      parts.push(`视图 ${viewTags.join(" / ")}`);
    }
    if (variantTags.length) {
      parts.push(`变体 ${variantTags.join(" / ")}`);
    }
  }

  return unique(parts).slice(0, 3).join(" · ");
}

// 返回完整的 target 标签列表（不截断），用于生成时第二行全量展示
export function buildMediaTargetLabels(params: {
  runtime?: StudioRuntimeState | null;
  targetIds?: string[];
}): string[] {
  const context = collectRuntimeTargetContext(params.runtime, params.targetIds, undefined, Infinity);
  return context.labels;
}

export function buildWorkflowMediaTargetLabels(params: {
  action?: string;
  runtime?: StudioRuntimeState | null;
  targetIds?: string[];
}): string[] {
  const explicitLabels = buildMediaTargetLabels({
    runtime: params.runtime,
    targetIds: params.targetIds,
  });
  if (explicitLabels.length) return explicitLabels;

  const project = params.runtime?.currentVideoProject;
  if (!project) return [];

  if (params.action === "generate_video_reference_assets") {
    return [
      ...(project.characters ?? []).map((character) => `角色 ${character.name}`),
      ...(project.sceneSettings ?? []).map((sceneSetting) => `场景 ${sceneSetting.name}`),
    ];
  }

  if (params.action === "generate_storyboard_frames" || params.action === "generate_video_assets") {
    return (project.scenes ?? []).map((scene) =>
      `镜头 ${scene.sceneNumber}${scene.segmentLabel ? ` / ${scene.segmentLabel}` : ""} · ${scene.sceneName}`,
    );
  }

  if (params.action === "generate_segment_video" && params.targetIds?.length) {
    return params.targetIds.map((targetId) => `片段${targetId}`);
  }

  return [];
}

export function extractCompactMediaContentLabel(contentSummary?: string | null): string {
  const summary = String(contentSummary || "").trim();
  if (!summary) return "";

  const parts = summary
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return summary;

  const [first, second] = parts;
  if (
    /^镜头\s+\d+$/u.test(first) &&
    second &&
    !/^(视图|变体|模式|模型|分辨率|比例|通道)\s+/u.test(second)
  ) {
    return `${first} · ${second}`;
  }

  return first;
}

export function buildCompactMediaStatusHeading(params: {
  phase: "start" | "done";
  fallbackLabel: string;
  contentSummary?: string | null;
}): string {
  const primaryLabel = extractCompactMediaContentLabel(params.contentSummary);
  if (params.phase === "start") {
    return primaryLabel ? `正在生成${primaryLabel}，请稍等…` : `正在生成${params.fallbackLabel}，请稍等…`;
  }

  return primaryLabel ? `已生成${primaryLabel}` : `${params.fallbackLabel}已生成`;
}

export function buildPendingMediaStreamLabel(params: {
  fallbackLabel: string;
  contentSummary?: string | null;
}): string {
  const primaryLabel = extractCompactMediaContentLabel(params.contentSummary);
  return primaryLabel ? `正在生成${primaryLabel}` : `正在生成${params.fallbackLabel}`;
}

function buildPendingMediaAttachmentStem(contentSummary?: string | null): string {
  const primaryLabel = extractCompactMediaContentLabel(contentSummary);
  if (!primaryLabel) return "";
  return primaryLabel
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

export function buildPendingMediaAttachmentName(
  kind: MediaKind,
  count: number,
  index: number,
  contentSummary?: string | null,
): string {
  const compactStem = buildPendingMediaAttachmentStem(contentSummary);
  const fallbackStem = kind === "video" ? "生成中视频" : "生成中图片";
  const stem = compactStem || fallbackStem;
  if (kind === "video") {
    return count > 1 ? `${stem}-${index + 1}.mp4` : `${stem}.mp4`;
  }
  return count > 1 ? `${stem}-${index + 1}.jpg` : `${stem}.jpg`;
}

export function buildGeneratedMediaFallbackName(kind: MediaKind, total: number, index: number): string {
  if (kind === "video") {
    return total > 1 ? `已生成视频-${index + 1}.mp4` : "已生成视频.mp4";
  }
  return total > 1 ? `已生成图片-${index + 1}.jpg` : "已生成图片.jpg";
}
