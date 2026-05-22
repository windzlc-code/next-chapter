import { callGemini, extractText, fetchImageAsBase64 } from "@/lib/gemini-client";
import { buildSegmentVideoGoldenSamplePromptContext, VIDEO_QA_GOLDEN_SAMPLE_VERSION } from "@/lib/home-agent/video-qa-golden-samples";
import type { Scene } from "@/types/project";

const VIDEO_QA_FRAME_PERCENTS = [12, 50, 88] as const;
const VIDEO_QA_MODEL = "gemini-3-flash-preview";

type GeminiInlinePart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

export interface SegmentVideoVisualQualityReport {
  inspected: boolean;
  frameCount: number;
  summary: string;
  continuityScore: number;
  identityScore: number;
  semanticScore: number;
  visualScore: number;
  subtitleVisible: boolean;
  watermarkVisible: boolean;
  deliverableReady: boolean;
  qualityTier?: "golden" | "usable" | "borderline" | "fail";
  goldenSampleVersion?: string;
  strengths: string[];
  goldenSignals: string[];
  fixPriorities: string[];
  issues: string[];
}

function clampScore(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function parseJsonPayload(rawText: string): Record<string, unknown> {
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
      throw new Error("Video visual QA returned an invalid JSON payload.");
    }
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function parseStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseQualityTier(
  value: unknown,
): SegmentVideoVisualQualityReport["qualityTier"] | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "golden" || normalized === "usable" || normalized === "borderline" || normalized === "fail") {
    return normalized;
  }
  return undefined;
}

function isLikelyLocalFilePath(value: string | undefined): boolean {
  const trimmed = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

async function buildFrameInlineParts(videoPath: string): Promise<GeminiInlinePart[]> {
  const extractFrames = window.electronAPI?.media?.extractVideoFrames;
  const readBase64 = window.electronAPI?.storage?.readBase64;
  if (!extractFrames || !readBase64 || !isLikelyLocalFilePath(videoPath)) {
    return [];
  }

  const result = await extractFrames({
    filePath: videoPath,
    framePercents: [...VIDEO_QA_FRAME_PERCENTS],
  });
  if (!result?.ok || !result.framePaths?.length) return [];

  const parts: GeminiInlinePart[] = [];
  for (let index = 0; index < result.framePaths.length; index += 1) {
    const framePath = result.framePaths[index];
    if (!framePath) continue;
    const frameResult = await readBase64(framePath);
    if (!frameResult?.ok || !frameResult.exists || !frameResult.base64) continue;
    const percent = VIDEO_QA_FRAME_PERCENTS[index] ?? 50;
    parts.push({ text: `Current segment keyframe ${index + 1} (about ${percent}% of runtime).` });
    parts.push({
      inlineData: {
        mimeType: frameResult.mimeType || "image/jpeg",
        data: frameResult.base64,
      },
    });
  }
  return parts;
}

function buildSceneSummary(scenes: Scene[]): string {
  return scenes
    .map((scene) => {
      const pieces = [
        scene.sceneName?.trim(),
        scene.description?.trim(),
        scene.cameraDirection?.trim() ? `camera: ${scene.cameraDirection.trim()}` : "",
        scene.characters?.length ? `characters: ${scene.characters.join(", ")}` : "",
      ].filter(Boolean);
      return pieces.join(" | ");
    })
    .filter(Boolean)
    .join("\n");
}

export async function analyzeSegmentVideoVisualQuality(params: {
  videoUrl: string;
  scenes: Scene[];
  submittedPrompt: string;
  previousContinuityFrameUrl?: string;
  segmentStartContinuityText?: string;
  segmentFlowContinuityText?: string;
}): Promise<SegmentVideoVisualQualityReport | null> {
  if (
    typeof window === "undefined" ||
    !window.electronAPI?.media?.extractVideoFrames ||
    !window.electronAPI?.storage?.readBase64
  ) {
    return null;
  }

  const videoPath = String(params.videoUrl || "").trim();
  if (!videoPath || !isLikelyLocalFilePath(videoPath)) {
    return null;
  }

  const frameParts = await buildFrameInlineParts(videoPath);
  if (!frameParts.length) return null;

  const parts: GeminiInlinePart[] = [
    {
      text: [
        "You are a strict film/video quality inspector for long-form AI drama generation.",
        "Judge whether the current segment is visually coherent, story-readable, and ready to be stitched directly into the previous/next segment.",
        buildSegmentVideoGoldenSamplePromptContext(),
        "Return JSON only with this schema:",
        "{",
        '  "summary": "short audit summary",',
        '  "continuityScore": 0,',
        '  "identityScore": 0,',
        '  "semanticScore": 0,',
        '  "visualScore": 0,',
        '  "subtitleVisible": false,',
        '  "watermarkVisible": false,',
        '  "deliverableReady": false,',
        '  "qualityTier": "golden | usable | borderline | fail",',
        '  "strengths": ["strength 1"],',
        '  "goldenSignals": ["matched positive anchor"],',
        '  "fixPriorities": ["repair priority 1"],',
        '  "issues": ["issue 1", "issue 2"]',
        "}",
        "Scoring criteria:",
        "- continuityScore: does this segment continue smoothly from the prior segment and remain internally coherent?",
        "- identityScore: do the same characters, wardrobe, props, and scene anchors remain stable?",
        "- semanticScore: is the dramatic action readable and clearly aligned with the intended story beat?",
        "- visualScore: composition, motion stability, sharpness, and absence of unwanted on-screen text.",
        '- qualityTier: "golden" only when the clip is stitch-ready and clearly matches the golden-sample standard, "usable" when it is basically shippable with minor caveats, "borderline" when it needs local repair, "fail" when it should be regenerated.',
        "- strengths: concise concrete positives visible in the sampled frames.",
        "- goldenSignals: which high-quality signals from the golden sample library are actually matched.",
        "- fixPriorities: the first repairs needed before the segment can reach the golden standard.",
        "If visible subtitles, watermarks, broken faces/hands, abrupt motion resets, spatial jumps, or unreadable story flow appear, lower the scores and include them in issues.",
        params.segmentStartContinuityText?.trim()
          ? `Start continuity requirement: ${params.segmentStartContinuityText.trim()}`
          : "",
        params.segmentFlowContinuityText?.trim()
          ? `Segment flow requirement: ${params.segmentFlowContinuityText.trim()}`
          : "",
        params.scenes.length ? `Scene/story intent:\n${buildSceneSummary(params.scenes)}` : "",
        `Submitted prompt excerpt:\n${params.submittedPrompt.slice(0, 1600)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];

  if (params.previousContinuityFrameUrl?.trim()) {
    const previousFrame = await fetchImageAsBase64(params.previousContinuityFrameUrl.trim()).catch(
      () => null,
    );
    if (previousFrame?.base64) {
      parts.push({ text: "Previous segment real last frame reference." });
      parts.push({
        inlineData: {
          mimeType: previousFrame.mimeType || "image/jpeg",
          data: previousFrame.base64,
        },
      });
    }
  }

  parts.push(...frameParts);

  try {
    const response = await callGemini(
      VIDEO_QA_MODEL,
      [{ role: "user", parts }],
      {
        temperature: 0.1,
        maxOutputTokens: 1400,
        responseMimeType: "application/json",
      },
    );
    const payload = parseJsonPayload(extractText(response));
    return {
      inspected: true,
      frameCount: frameParts.filter((part) => part.inlineData).length,
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : "Visual QA completed.",
      continuityScore: clampScore(payload.continuityScore, 70),
      identityScore: clampScore(payload.identityScore, 70),
      semanticScore: clampScore(payload.semanticScore, 70),
      visualScore: clampScore(payload.visualScore, 70),
      subtitleVisible: payload.subtitleVisible === true,
      watermarkVisible: payload.watermarkVisible === true,
      deliverableReady: payload.deliverableReady === true,
      qualityTier: parseQualityTier(payload.qualityTier),
      goldenSampleVersion: VIDEO_QA_GOLDEN_SAMPLE_VERSION,
      strengths: parseStringArray(payload.strengths, 4),
      goldenSignals: parseStringArray(payload.goldenSignals, 4),
      fixPriorities: parseStringArray(payload.fixPriorities, 4),
      issues: parseStringArray(payload.issues, 6),
    };
  } catch {
    return null;
  }
}
