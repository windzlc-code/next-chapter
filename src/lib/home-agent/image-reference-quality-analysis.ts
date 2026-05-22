import { callGemini, extractText, fetchImageAsBase64 } from "@/lib/gemini-client";
import {
  buildReferenceImageGoldenSamplePromptContext,
  VIDEO_QA_GOLDEN_SAMPLE_VERSION,
} from "@/lib/home-agent/video-qa-golden-samples";

type GeminiInlinePart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

export interface ReferenceImageQualityReport {
  inspected: boolean;
  summary: string;
  overallScore: number;
  identityScore: number;
  visualScore: number;
  consistencyScore: number;
  styleMismatchVisible?: boolean;
  unintendedDuplicatePeopleVisible?: boolean;
  textPollutionVisible: boolean;
  watermarkVisible: boolean;
  deliverableReady: boolean;
  qualityTier?: "golden" | "usable" | "borderline" | "fail";
  goldenSampleVersion?: string;
  strengths: string[];
  goldenSignals: string[];
  fixPriorities: string[];
  issues: string[];
}

export interface ReferenceVariantDistinctnessReport {
  inspected: boolean;
  summary: string;
  distinctEnough: boolean;
  similarityTier?: "distinct" | "borderline" | "duplicate";
  comparedSiblingLabels: string[];
  duplicateSiblingLabels: string[];
  issues: string[];
  fixPriorities: string[];
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
      throw new Error("Reference image QA returned an invalid JSON payload.");
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
): ReferenceImageQualityReport["qualityTier"] | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "golden" || normalized === "usable" || normalized === "borderline" || normalized === "fail") {
    return normalized;
  }
  return undefined;
}

function parseSimilarityTier(
  value: unknown,
): ReferenceVariantDistinctnessReport["similarityTier"] | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "distinct" || normalized === "borderline" || normalized === "duplicate") {
    return normalized;
  }
  return undefined;
}

const EXPLICIT_IDENTICAL_PEOPLE_REQUEST_PATTERN =
  /(?:双胞胎|孪生|孪生兄弟|孪生姐妹|克隆(?:体)?|复制人|分身|镜像分身|同一人(?:物)?重复出现|同一张脸|一模一样(?:的)?(?:两个人|人物|双人|角色)?|完全相同(?:的)?(?:两个人|人物|双人|角色)?|identical\s+(?:twins?|people|characters?|pair|duo)|same\s+person\s+repeated|same\s+face|clones?|mirror(?:ed)?\s+double|matching\s+twins?)/i;

const MULTI_PERSON_COMPOSITION_PATTERN =
  /(?:双人|两人|二人|双角色|双主角|两位|二位|两名|二名|一对|pair|duo|two\s+people|two\s+characters|two-person|double\s+portrait|multi-person)/i;

const DUPLICATE_PEOPLE_ISSUE_PATTERN =
  /(?:重复人物|重复角色|一模一样|同脸|同一张脸|复制人|克隆|identical|duplicate\s+(?:person|people|character)|same\s+face|clone)/i;

function buildReferenceImageDuplicatePeopleQaContext(params: {
  mode: "character" | "scene";
  name: string;
  description: string;
}): string[] {
  if (params.mode !== "character") return [];

  const targetText = `${params.name}\n${params.description}`;
  const lines = [
    "A normal single-character turnaround sheet is allowed to show the same one character across front / side / back / close-up panels. Do not mistake that expected multi-view layout for an accidental duplicate-person failure.",
  ];

  if (EXPLICIT_IDENTICAL_PEOPLE_REQUEST_PATTERN.test(targetText)) {
    lines.push(
      "The target text explicitly allows identical-looking people such as twins, clones, mirrored doubles, or the same person repeated. In that special case, do not fail the image just because two co-present people share the same face or outfit.",
    );
    return lines;
  }

  if (MULTI_PERSON_COMPOSITION_PATTERN.test(targetText)) {
    lines.push(
      "The target text appears to call for a two-person or multi-person composition. Unless the text explicitly requests twins, clones, or identical doubles, the co-present people should remain visually distinguishable in face, build, costume details, silhouette, or age.",
    );
  } else {
    lines.push(
      "If the candidate introduces two or more co-present human figures, do not allow them to read like duplicated copies of the same person unless the target text explicitly requests twins, clones, or identical doubles.",
    );
  }

  lines.push(
    '- Set "unintendedDuplicatePeopleVisible": true when multiple co-present people look like accidental cloned copies of the same character rather than intentionally distinct individuals.',
  );
  return lines;
}

function mergeDuplicatePeopleIssue(issues: string[], unintendedDuplicatePeopleVisible: boolean): string[] {
  if (!unintendedDuplicatePeopleVisible) return issues;
  if (issues.some((issue) => DUPLICATE_PEOPLE_ISSUE_PATTERN.test(issue))) {
    return issues.slice(0, 6);
  }
  return ["图中出现未被需求明确允许的重复同脸人物。", ...issues].slice(0, 6);
}

export async function analyzeReferenceImageQuality(params: {
  imageUrl: string;
  mode: "character" | "scene";
  name: string;
  description: string;
  referenceImageUrl?: string;
  projectStyleContext?: string;
}): Promise<ReferenceImageQualityReport | null> {
  const imageUrl = String(params.imageUrl || "").trim();
  if (!imageUrl) return null;

  try {
    const candidateImage = await fetchImageAsBase64(imageUrl);
    if (!candidateImage?.data) return null;

    const parts: GeminiInlinePart[] = [
      {
        text: [
          "You are a strict QA inspector for reusable visual reference images in a long-form AI drama workflow.",
          "Judge whether the candidate image is stable enough to become a reference asset for later storyboard and video generation.",
          buildReferenceImageGoldenSamplePromptContext(params.mode),
          "Return JSON only with this schema:",
          "{",
          '  "summary": "short QA summary in Chinese",',
          '  "overallScore": 0,',
          '  "identityScore": 0,',
          '  "visualScore": 0,',
          '  "consistencyScore": 0,',
          '  "styleMismatchVisible": false,',
          '  "unintendedDuplicatePeopleVisible": false,',
          '  "textPollutionVisible": false,',
          '  "watermarkVisible": false,',
          '  "deliverableReady": false,',
          '  "qualityTier": "golden | usable | borderline | fail",',
          '  "strengths": ["strength 1"],',
          '  "goldenSignals": ["matched positive anchor"],',
          '  "fixPriorities": ["repair priority 1"],',
          '  "issues": ["issue 1", "issue 2"]',
          "}",
          `Target type: ${params.mode === "character" ? "character reference" : "scene reference"}.`,
          `Target name: ${params.name}.`,
          `Target description: ${params.description}.`,
          params.projectStyleContext?.trim()
            ? `Current project style lock:\n${params.projectStyleContext.trim()}`
            : "No explicit project style lock is attached beyond the target description.",
          params.referenceImageUrl?.trim()
            ? "A trusted reference image is also attached. Compare the candidate against that anchor first."
            : "No trusted reference image is attached. Judge only against the written target description.",
          "Scoring criteria:",
          "- overallScore: overall suitability as a reusable production reference image.",
          "- identityScore: character identity / costume / face stability, or scene identity / geography / era consistency.",
          "- visualScore: clarity, composition, subject completeness, readable lighting, and absence of artifacts.",
          "- consistencyScore: stability against the requested target description and any attached trusted reference image.",
          "- styleMismatchVisible: true when the candidate clearly clashes with the selected project style, era, genre, or rendering mode even if the image looks polished in isolation.",
          '- unintendedDuplicatePeopleVisible: true when the image shows multiple co-present human figures that look like accidental cloned copies of the same person even though the target text did not explicitly request twins, clones, or identical doubles.',
          '- qualityTier: "golden" only when this is strong enough to act like a trusted production anchor, "usable" when it can be reused with minor caveats, "borderline" when it needs another pass, "fail" when it should not be reused.',
          "- strengths: concise concrete positives visible in the image.",
          "- goldenSignals: which positive anchors from the golden sample library are actually matched by this image.",
          "- fixPriorities: the first concrete things to repair before this image can become a stable reference.",
          "Treat clear style drift as a blocking failure: for example a modern live-action urban project should not output an ancient-costume, wuxia, cel-animation, or fantasy-illustration-looking reference unless the project style lock explicitly asks for it.",
          "Visible subtitles, on-screen text, UI overlays, logos, or watermarks should be recorded when present, but they should not by themselves force failure if the image is otherwise production-usable and style-consistent.",
          "Lower the score if the face is unstable, the subject is cropped incorrectly, the scene drifts away from the target, lighting is confused, or the candidate breaks the requested style/world consistency.",
          ...buildReferenceImageDuplicatePeopleQaContext(params),
        ].join("\n"),
      },
    ];

    if (params.referenceImageUrl?.trim()) {
      const trustedReference = await fetchImageAsBase64(params.referenceImageUrl.trim()).catch(() => null);
      if (trustedReference?.data) {
        parts.push({ text: "Trusted reference image." });
        parts.push({
          inlineData: {
            mimeType: trustedReference.mimeType || "image/jpeg",
            data: trustedReference.data,
          },
        });
      }
    }

    parts.push({ text: "Candidate image to inspect." });
    parts.push({
      inlineData: {
        mimeType: candidateImage.mimeType || "image/jpeg",
        data: candidateImage.data,
      },
    });

    const response = await callGemini(
      "gemini-3-flash-preview",
      [{ role: "user", parts }],
      {
        temperature: 0.1,
        maxOutputTokens: 1100,
        responseMimeType: "application/json",
      },
    );

    const payload = parseJsonPayload(extractText(response));
    const unintendedDuplicatePeopleVisible = payload.unintendedDuplicatePeopleVisible === true;
    const parsedIssues = mergeDuplicatePeopleIssue(
      parseStringArray(payload.issues, 6),
      unintendedDuplicatePeopleVisible,
    );
    return {
      inspected: true,
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : "参考图质检完成。",
      overallScore: clampScore(payload.overallScore, 76),
      identityScore: clampScore(payload.identityScore, 76),
      visualScore: clampScore(payload.visualScore, 76),
      consistencyScore: clampScore(payload.consistencyScore, 76),
      styleMismatchVisible: payload.styleMismatchVisible === true,
      unintendedDuplicatePeopleVisible,
      textPollutionVisible: payload.textPollutionVisible === true,
      watermarkVisible: payload.watermarkVisible === true,
      deliverableReady: payload.deliverableReady === true && !unintendedDuplicatePeopleVisible,
      qualityTier: unintendedDuplicatePeopleVisible ? "fail" : parseQualityTier(payload.qualityTier),
      goldenSampleVersion: VIDEO_QA_GOLDEN_SAMPLE_VERSION,
      strengths: parseStringArray(payload.strengths, 4),
      goldenSignals: parseStringArray(payload.goldenSignals, 4),
      fixPriorities: parseStringArray(payload.fixPriorities, 4),
      issues: parsedIssues,
    };
  } catch {
    return null;
  }
}

export async function analyzeReferenceVariantDistinctness(params: {
  imageUrl: string;
  mode: "character" | "scene";
  name: string;
  variantLabel: string;
  variantDescription: string;
  primaryReferenceImageUrl: string;
  siblingVariants?: Array<{
    label: string;
    description?: string;
    imageUrl: string;
  }>;
}): Promise<ReferenceVariantDistinctnessReport | null> {
  const imageUrl = String(params.imageUrl || "").trim();
  const primaryReferenceImageUrl = String(params.primaryReferenceImageUrl || "").trim();
  if (!imageUrl || !primaryReferenceImageUrl) return null;

  try {
    const [candidateImage, primaryReference] = await Promise.all([
      fetchImageAsBase64(imageUrl),
      fetchImageAsBase64(primaryReferenceImageUrl),
    ]);
    if (!candidateImage?.data || !primaryReference?.data) return null;

    const siblingVariants = (params.siblingVariants || [])
      .map((variant) => ({
        label: String(variant.label || "").trim(),
        description: String(variant.description || "").trim(),
        imageUrl: String(variant.imageUrl || "").trim(),
      }))
      .filter((variant) => variant.label && variant.imageUrl)
      .slice(0, 4);

    const parts: GeminiInlinePart[] = [
      {
        text: [
          "You are a strict QA inspector for visual distinctness between reusable reference variants in a long-form AI drama workflow.",
          buildReferenceImageGoldenSamplePromptContext(params.mode),
          "Return JSON only with this schema:",
          "{",
          '  "summary": "short QA summary in Chinese",',
          '  "distinctEnough": false,',
          '  "similarityTier": "distinct | borderline | duplicate",',
          '  "comparedSiblingLabels": ["sibling label 1"],',
          '  "duplicateSiblingLabels": ["label that looks too similar"],',
          '  "issues": ["issue 1", "issue 2"],',
          '  "fixPriorities": ["repair priority 1"]',
          "}",
          `Target type: ${params.mode === "character" ? "character variant reference" : "scene variant reference"}.`,
          `Target name: ${params.name}.`,
          `Variant label: ${params.variantLabel}.`,
          `Variant description: ${params.variantDescription}.`,
          "Rules:",
          "- The candidate must preserve the same core identity or location as the primary reference image.",
          params.mode === "character"
            ? "- It must still read as the same character, but the requested costume / styling / damage / accessory difference must be obvious enough that production would not reuse the primary image."
            : "- It must still read as the same place, but the requested time / weather / lighting / destruction / atmosphere difference must be obvious enough that production would not reuse the primary image.",
          "- Compare the candidate against the primary reference first, then against every attached sibling variant reference.",
          '- Mark similarityTier as "duplicate" when a human reviewer would likely say two labels can share the same image.',
          '- Mark similarityTier as "borderline" when the difference exists but is too weak, ambiguous, or easy to confuse in downstream production.',
          '- distinctEnough should be true only when the candidate is clearly separable from the primary reference and every attached sibling variant reference.',
          "- Prefer concrete visual observations over abstract wording.",
        ].join("\n"),
      },
      { text: "Primary reference image." },
      {
        inlineData: {
          mimeType: primaryReference.mimeType || "image/jpeg",
          data: primaryReference.data,
        },
      },
    ];

    siblingVariants.forEach((variant) => {
      parts.push({
        text: variant.description
          ? `Sibling variant reference: ${variant.label}. ${variant.description}`
          : `Sibling variant reference: ${variant.label}.`,
      });
    });

    const siblingImages = await Promise.all(
      siblingVariants.map((variant) => fetchImageAsBase64(variant.imageUrl).catch(() => null)),
    );
    siblingImages.forEach((siblingImage) => {
      if (!siblingImage?.data) return;
      parts.push({
        inlineData: {
          mimeType: siblingImage.mimeType || "image/jpeg",
          data: siblingImage.data,
        },
      });
    });

    parts.push({ text: "Candidate variant image to inspect." });
    parts.push({
      inlineData: {
        mimeType: candidateImage.mimeType || "image/jpeg",
        data: candidateImage.data,
      },
    });

    const response = await callGemini(
      "gemini-3-flash-preview",
      [{ role: "user", parts }],
      {
        temperature: 0.1,
        maxOutputTokens: 900,
        responseMimeType: "application/json",
      },
    );

    const payload = parseJsonPayload(extractText(response));
    return {
      inspected: true,
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : "变体区分度质检完成。",
      distinctEnough: payload.distinctEnough === true,
      similarityTier: parseSimilarityTier(payload.similarityTier),
      comparedSiblingLabels: parseStringArray(payload.comparedSiblingLabels, 6),
      duplicateSiblingLabels: parseStringArray(payload.duplicateSiblingLabels, 6),
      issues: parseStringArray(payload.issues, 6),
      fixPriorities: parseStringArray(payload.fixPriorities, 4),
    };
  } catch {
    return null;
  }
}
