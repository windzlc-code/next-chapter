import { callGemini, extractText } from "@/lib/gemini-client";
import { compressImage } from "@/lib/image-compress";
import {
  buildVideoImageStyleSummary,
  getHomeAgentImageStylePresetOption,
  normalizeVideoImageGenerationPrefs,
} from "@/lib/home-agent/image-models";
import type {
  VideoImageGenerationPrefs,
  VideoImageStyleCategory,
  VideoImageStylePreset,
} from "@/types/project";

const MAX_ANALYSIS_IMAGES = 4;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const IMAGE_FILE_NAME_PATTERN = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export interface HomeAgentImageStyleRecognitionImageSummary {
  fileName: string;
  summary: string;
  stylePreset: VideoImageStylePreset;
  confidence: number;
}

export interface HomeAgentImageStyleRecognitionResult {
  styleCategory: VideoImageStyleCategory;
  stylePreset: VideoImageStylePreset;
  customStylePrompt?: string;
  summary: string;
  confidence: number;
  reasons: string[];
  imageSummaries: HomeAgentImageStyleRecognitionImageSummary[];
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 8192;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

async function fileToDataUrl(file: File): Promise<string> {
  const blob = file as Blob;
  const arrayBuffer =
    typeof blob.arrayBuffer === "function"
      ? await blob.arrayBuffer()
      : await new Response(blob).arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const mimeType = file.type || "image/png";
  return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

function dataUrlToInlinePart(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Failed to prepare image data for style analysis.");
  }
  return {
    mimeType: match[1] || "image/jpeg",
    data: match[2] || "",
  };
}

async function fileToInlinePart(file: File): Promise<{ mimeType: string; data: string }> {
  const originalDataUrl = await fileToDataUrl(file);
  const compressedDataUrl =
    file.size > MAX_IMAGE_BYTES
      ? await compressImage(originalDataUrl, MAX_IMAGE_BYTES, { maxDim: 1536, minQuality: 0.3 })
      : originalDataUrl;
  return dataUrlToInlinePart(compressedDataUrl);
}

function parseRecognitionPayload(rawText: string): Record<string, unknown> {
  const cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Image style recognition returned an invalid JSON payload.");
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.6;
  return Math.max(0, Math.min(1, numeric));
}

export function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_FILE_NAME_PATTERN.test(file.name);
}

export function buildImagePrefsPatchFromRecognition(
  result: HomeAgentImageStyleRecognitionResult,
): Partial<VideoImageGenerationPrefs> {
  const normalized = normalizeVideoImageGenerationPrefs({
    styleCategory: result.styleCategory,
    stylePreset: result.stylePreset,
    customStylePrompt: result.customStylePrompt,
  });
  return {
    styleCategory: normalized.styleCategory,
    stylePreset: normalized.stylePreset,
    ...(normalized.customStylePrompt ? { customStylePrompt: normalized.customStylePrompt } : {}),
  };
}

export function buildHomeAgentImageAnalysisContext(
  result: HomeAgentImageStyleRecognitionResult,
): string {
  const lines = [
    "以下是用户上传图片的多模态识别结果，可作为风格和参考图理解依据：",
    `- 推荐风格：${buildVideoImageStyleSummary({
      styleCategory: result.styleCategory,
      stylePreset: result.stylePreset,
      customStylePrompt: result.customStylePrompt,
    })}`,
    `- 整体总结：${result.summary}`,
    `- 置信度：${Math.round(result.confidence * 100)}%`,
  ];

  if (result.reasons.length) {
    lines.push(`- 判断依据：${result.reasons.join("；")}`);
  }

  if (result.customStylePrompt?.trim()) {
    lines.push(`- 自定义风格提示词：${result.customStylePrompt.trim()}`);
  }

  if (result.imageSummaries.length) {
    lines.push("- 分图摘要：");
    for (const item of result.imageSummaries) {
      const styleLabel = getHomeAgentImageStylePresetOption(item.stylePreset).label;
      lines.push(
        `  - ${item.fileName}：${item.summary}（${styleLabel}，${Math.round(item.confidence * 100)}%）`,
      );
    }
  }

  return lines.join("\n");
}

export async function analyzeHomeAgentImageStyleFiles(
  files: File[],
  options: { userPrompt?: string } = {},
): Promise<HomeAgentImageStyleRecognitionResult> {
  const imageFiles = files.filter(isSupportedImageFile).slice(0, MAX_ANALYSIS_IMAGES);
  if (!imageFiles.length) {
    throw new Error("No supported image files were provided for style recognition.");
  }

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: [
        "You are analyzing visual reference images for a video creation workflow.",
        "Return JSON only with this schema:",
        '{',
        '  "styleCategory": "realistic|animation-3d|animation-2d|custom",',
        '  "stylePreset": "live-action|hyper-cg|3d-cartoon|2.5d-stylized|anime-3d|cel-animation|retro-comic|custom",',
        '  "customStylePrompt": "optional concise style prompt for generation",',
        '  "summary": "overall visual style summary in Chinese",',
        '  "confidence": 0.0,',
        '  "reasons": ["short reason 1", "short reason 2"],',
        '  "imageSummaries": [{"fileName": "name", "summary": "brief summary in Chinese", "stylePreset": "live-action", "confidence": 0.0}]',
        "}",
        "Choose the closest built-in preset when possible.",
        "Use stylePreset=custom only when the references intentionally mix styles, rely on a very specific house style, or need a stronger custom prompt to preserve the look.",
        "Do not mention copyrighted IP names in customStylePrompt.",
        options.userPrompt?.trim()
          ? `User request context: ${options.userPrompt.trim()}`
          : "User request context: general image style recognition for homepage agent.",
      ].join("\n"),
    },
  ];

  for (const file of imageFiles) {
    parts.push({ text: `Reference image: ${file.name}` });
    parts.push({ inlineData: await fileToInlinePart(file) });
  }

  const response = await callGemini(
    "gemini-3-flash-preview",
    [{ role: "user", parts }],
    {
      temperature: 0.2,
      maxOutputTokens: 1400,
      responseMimeType: "application/json",
    },
  );

  const payload = parseRecognitionPayload(extractText(response));
  const normalizedPrefs = normalizeVideoImageGenerationPrefs({
    styleCategory: payload.styleCategory as never,
    stylePreset: payload.stylePreset as never,
    customStylePrompt:
      typeof payload.customStylePrompt === "string" ? payload.customStylePrompt : undefined,
  });

  const imageSummaries = Array.isArray(payload.imageSummaries)
    ? payload.imageSummaries
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item, index) => ({
          fileName:
            typeof item.fileName === "string" && item.fileName.trim()
              ? item.fileName.trim()
              : imageFiles[index]?.name || `image-${index + 1}`,
          summary:
            typeof item.summary === "string" && item.summary.trim()
              ? item.summary.trim()
              : "已识别参考图的主要风格和画面特征。",
          stylePreset: normalizeVideoImageGenerationPrefs({
            stylePreset: item.stylePreset as never,
          }).stylePreset,
          confidence: normalizeConfidence(item.confidence),
        }))
    : imageFiles.map((file) => ({
        fileName: file.name,
        summary: "已识别参考图的主要风格和画面特征。",
        stylePreset: normalizedPrefs.stylePreset,
        confidence: normalizeConfidence(payload.confidence),
      }));

  return {
    styleCategory: normalizedPrefs.styleCategory,
    stylePreset: normalizedPrefs.stylePreset,
    customStylePrompt: normalizedPrefs.customStylePrompt,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : "已识别上传图片的整体画面风格，可直接作为视频创作参考。",
    confidence: normalizeConfidence(payload.confidence),
    reasons: Array.isArray(payload.reasons)
      ? payload.reasons
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 4)
      : [],
    imageSummaries,
  };
}
