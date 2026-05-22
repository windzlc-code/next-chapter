import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { ContentBlock, MessageInput, SDKMessage } from "@/lib/agent/types";
import type { AutoResearchPlan } from "@/lib/home-agent/auto-research";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type {
  ConversationArtifact,
  ConversationProjectSnapshot,
  HomeAgentMessage,
  StudioRuntimeState,
  StudioSessionState,
} from "@/lib/home-agent/types";
import { cloneConversationArtifact } from "@/lib/home-agent/message-artifact-snapshots";

type PushMessage = (
  role: HomeAgentMessage["role"],
  content: string,
  artifactIds?: string[],
  attachments?: ChatAttachment[],
  artifactSnapshots?: ConversationArtifact[],
) => void;
type ConversationMemoryModuleLike = typeof import("@/lib/home-agent/conversation-memory");
type ProjectStoreModuleLike = typeof import("@/lib/home-agent/project-store");
type StructuredQuestionParserModuleLike = typeof import("./structured-question-parser");

const ASSISTANT_META_PROGRESS_LINE =
  /^(?:正在|继续)(?:为你|帮你)?(?:生成|整理|分析|撰写|设计|构思|输出|处理|完善).*(?:\.{3,}|…+|。)?$/u;
const ASSISTANT_META_PREAMBLE_LINE =
  /^(?:(?:好的|收到|明白|可以|没问题|行|完美|太好了|很好)[！!。\s]*)?(?:(?:现在|接下来|下面|先)(?:我)?(?:来|会)?(?:为你|帮你)?(?:继续)?(?:生成|整理|分析|撰写|设计|构思|输出|处理|完善).*(?:请稍等|稍候|我会给你|马上给你|这就给你|如下|：)|(?:我会|我先|我将)(?:为你|帮你)?.*(?:生成|整理|分析|撰写|设计|构思|输出|处理|完善).*(?:请稍等|稍候|马上|接下来|如下|：))$/u;

function looksLikeAssistantMetaScaffold(line: string): boolean {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (ASSISTANT_META_PROGRESS_LINE.test(normalized)) return true;
  if (ASSISTANT_META_PREAMBLE_LINE.test(normalized)) return true;
  return /(?:请稍等|稍候|马上为你|这就为你|我会给你)/u.test(normalized) &&
    /(?:生成|整理|分析|撰写|设计|构思|输出|处理|完善)/u.test(normalized);
}

export function sanitizeAssistantReplyText(text: string): string {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return "";

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !looksLikeAssistantMetaScaffold(line));

  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (!collapsed.length || !collapsed[collapsed.length - 1]) continue;
      collapsed.push("");
      continue;
    }
    collapsed.push(line);
  }
  while (collapsed.length && !collapsed[0]) collapsed.shift();
  while (collapsed.length && !collapsed[collapsed.length - 1]) collapsed.pop();

  return collapsed.join("\n").trim();
}

function hasWorkflowForwardGuidance(text: string): boolean {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return /(?:^|\n)(?:##\s*)?下一步(?:建议)?\s*[:：]/u.test(normalized);
}

function buildWorkflowForwardGuidance(
  snapshot: ConversationProjectSnapshot | null | undefined,
): string {
  const stage = snapshot?.derivedStage?.trim() || "当前阶段";
  const nextAction = snapshot?.recommendedActions?.find((action) => action.trim())?.trim();
  const objective = snapshot?.currentObjective?.trim();

  if (nextAction) {
    return `下一步建议：当前处于「${stage}」阶段，请先${nextAction}，不要跳到后续阶段。`;
  }

  if (objective) {
    return `下一步建议：当前处于「${stage}」阶段，请先围绕这个目标继续推进：${objective}。不要跳到后续阶段。`;
  }

  return `下一步建议：当前处于「${stage}」阶段，请先完成这一阶段，再继续后面的步骤。`;
}

export function ensureAssistantReplyHasWorkflowGuidance(params: {
  text: string;
  snapshot: ConversationProjectSnapshot | null | undefined;
  consumedStructuredPayload?: boolean;
}): string {
  const { text, snapshot, consumedStructuredPayload = false } = params;
  const normalized = String(text || "").trim();
  if (!normalized || !snapshot || consumedStructuredPayload) return normalized;
  if (hasWorkflowForwardGuidance(normalized)) return normalized;
  return `${normalized}\n\n${buildWorkflowForwardGuidance(snapshot)}`;
}

function createArtifactRevisionKey(
  artifact: ConversationProjectSnapshot["artifacts"][number],
): string {
  return JSON.stringify({
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    summary: artifact.summary,
    content: artifact.content,
    presentation: artifact.presentation,
    payload: artifact.payload,
    actions: artifact.actions,
    editor: artifact.editor,
  });
}

export function createArtifactSignatureMap(
  snapshot: ConversationProjectSnapshot | null | undefined,
): Map<string, string> {
  return new Map(
    snapshot?.artifacts.map((artifact) => [artifact.id, createArtifactRevisionKey(artifact)]) ?? [],
  );
}

function parseProjectSnapshotFromToolResultContent(
  content: string,
): ConversationProjectSnapshot | null {
  try {
    const parsed = JSON.parse(content) as
      | { projectSnapshot?: ConversationProjectSnapshot | null; data?: { projectSnapshot?: ConversationProjectSnapshot | null } }
      | null;
    const snapshot = parsed?.projectSnapshot ?? parsed?.data?.projectSnapshot ?? null;
    if (!snapshot || !Array.isArray(snapshot.artifacts)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function collectChangedArtifactIdsFromSdkUserMessage(
  event: SDKMessage,
  previousArtifactSignatures: Map<string, string>,
): string[] {
  if (event.type !== "user") return [];

  const blocks = event.message.message.content;
  if (!Array.isArray(blocks)) return [];

  const changedArtifactIds: string[] = [];

  for (const block of blocks) {
    if (block.type !== "tool_result" || typeof block.content !== "string") continue;
    const snapshot = parseProjectSnapshotFromToolResultContent(block.content);
    if (!snapshot) continue;

    for (const artifact of snapshot.artifacts) {
      const nextSignature = createArtifactRevisionKey(artifact);
      const previousSignature = previousArtifactSignatures.get(artifact.id);
      if (previousSignature === undefined || previousSignature !== nextSignature) {
        changedArtifactIds.push(artifact.id);
      }
      previousArtifactSignatures.set(artifact.id, nextSignature);
    }
  }

  return [...new Set(changedArtifactIds)];
}

export function collectChangedArtifactsFromSdkUserMessage(
  event: SDKMessage,
  previousArtifactSignatures: Map<string, string>,
): ConversationArtifact[] {
  if (event.type !== "user") return [];

  const blocks = event.message.message.content;
  if (!Array.isArray(blocks)) return [];

  const changedArtifacts: ConversationArtifact[] = [];

  for (const block of blocks) {
    if (block.type !== "tool_result" || typeof block.content !== "string") continue;
    const snapshot = parseProjectSnapshotFromToolResultContent(block.content);
    if (!snapshot) continue;

    for (const artifact of snapshot.artifacts) {
      const nextSignature = createArtifactRevisionKey(artifact);
      const previousSignature = previousArtifactSignatures.get(artifact.id);
      if (previousSignature === undefined || previousSignature !== nextSignature) {
        changedArtifacts.push(cloneConversationArtifact(artifact));
      }
      previousArtifactSignatures.set(artifact.id, nextSignature);
    }
  }

  return changedArtifacts;
}

export function beginSendFlow(params: {
  prompt: MessageInput;
  shown?: string;
  push: PushMessage;
  setPopoverOverride: (question: null) => void;
  setSuggested: (question: null) => void;
  setMode: (mode: "active") => void;
  resetComposerDraft: (value?: string) => void;
  attachments?: ChatAttachment[];
  /** When true, history already ends with the user turn (e.g. regenerate assistant). */
  skipUserBubble?: boolean;
}): { cleanedText: string; promptForEngine: MessageInput } | null {
  const {
    prompt,
    shown,
    push,
    setPopoverOverride,
    setSuggested,
    setMode,
    resetComposerDraft,
    attachments,
    skipUserBubble,
  } = params;
  const cleaned = textFromMessageInput(prompt).trim();
  const displayText = (shown || cleaned || "请先分析这条消息。").trim();
  const hasPromptPayload = typeof prompt === "string" ? Boolean(prompt.trim()) : prompt.length > 0;
  if (!hasPromptPayload) return null;

  if (!skipUserBubble) {
    push("user", displayText, undefined, attachments);
  }
  setPopoverOverride(null);
  setSuggested(null);
  setMode("active");
  resetComposerDraft("");
  return {
    cleanedText: cleaned || displayText,
    promptForEngine: prompt,
  };
}

export function textFromMessageInput(prompt: MessageInput): string {
  if (typeof prompt === "string") return prompt;

  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "input_file") {
        return block.extractedText || block.fallbackDigest || block.fileName;
      }
      if (block.type === "input_image") {
        return block.fileName || block.alt || "";
      }
      if (block.type === "input_video") {
        return block.fileName || block.fallbackText || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function parseImageBatchCountToken(token: string | undefined): number | null {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) return null;

  if (/^\d{1,2}$/.test(normalized)) return Number.parseInt(normalized, 10);

  const textCountMap: Record<string, number> = {
    一: 1,
    一个: 1,
    一张: 1,
    one: 1,
    二: 2,
    两: 2,
    two: 2,
    三: 3,
    three: 3,
    四: 4,
    four: 4,
    五: 5,
    five: 5,
    六: 6,
    six: 6,
    七: 7,
    seven: 7,
    八: 8,
    eight: 8,
    九: 9,
    nine: 9,
    十: 10,
    ten: 10,
  };

  return textCountMap[normalized] ?? null;
}

function resolveImageBatchCount(text: string): number | undefined {
  const countTokenPattern = "(\\d{1,2}|一|二|两|三|四|五|六|七|八|九|十|one|two|three|four|five|six|seven|eight|nine|ten)";
  const patterns = [
    new RegExp(`(?:生成|生|画|绘制|做|出)\\s*${countTokenPattern}\\s*(?:张|幅|个)?`, "i"),
    new RegExp(`${countTokenPattern}\\s*(?:张|幅|个)\\s*(?:图|图片|图像|插画|照片)`, "i"),
    new RegExp(`\\b(?:create|generate|draw|make)\\s+${countTokenPattern}\\s+(?:images?|pictures?|photos?|illustrations?)\\b`, "i"),
    new RegExp(`\\b${countTokenPattern}\\s+(?:images?|pictures?|photos?|illustrations?)\\b`, "i"),
  ];

  for (const pattern of patterns) {
    const token = text.match(pattern)?.[1];
    const count = parseImageBatchCountToken(token);
    if (count !== null) return Math.max(1, Math.min(8, count));
  }

  if (/(批量|连续|多张|several|multiple|batch)/i.test(text)) return 3;
  return undefined;
}

function isGenerationTroubleshootingQuery(
  text: string,
  medium: "image" | "video",
): boolean {
  const normalized = String(text || "").trim();
  if (!normalized) return false;

  const mediumPattern =
    medium === "video"
      ? /(?:瑙嗛|video|鍑虹墖|text-to-video|image-to-video|鍥剧敓瑙嗛|鏂囩敓瑙嗛)/i
      : /(?:鐢熷浘|鍥剧墖|鍥惧儚|鎻掔敾|鐓х墖|image|picture|photo|illustration)/i;
  if (!mediumPattern.test(normalized)) return false;

  return /(?:鎶ラ敊|閿欒|澶辫触|寮傚父|闂|鎺掓煡|淇|閾捐矾|鎺ュ彛|鏃ュ織|debug|diagnos|troubleshoot|fix|error|failed|failure|not found|failed to load resource|404|500|why|涓轰粈涔?|鎬庝箞|濡備綍|help|鏁欑▼|璇存槑)/i.test(
    normalized,
  );
}

function isInternalChoicePayload(text: string): boolean {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return /^(?:video|script|maintenance|auto-research|review):[a-z0-9_-]+(?::|$)/i.test(normalized);
}

function inferDirectImageKind(text: string): "character" | "scene" {
  return /(?:角色|人物|人像|肖像|头像|半身像|全身像|立绘|主角|女主|男主|portrait|character|person|people|face|hero|heroine|man|woman|girl|boy)/i.test(
    text,
  )
    ? "character"
    : "scene";
}

type DirectSceneTargetProjectLike = {
  scenes?: Array<{
    id: string;
    sceneNumber?: number;
    sceneName?: string;
    segmentLabel?: string;
  }>;
} | null;

function normalizeSceneLookupText(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[，。、《》【】（）()：:；;！!？?、]/g, " ")
    .replace(/\s+/g, " ");
}

function resolveExplicitSceneTargetIds(
  text: string,
  project?: DirectSceneTargetProjectLike,
): string[] | undefined {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  if (!scenes.length) return undefined;

  const normalized = normalizeSceneLookupText(text);
  if (!normalized) return undefined;

  const matchedIds = new Set<string>();
  const numberMatches = normalized.matchAll(
    /(?:第\s*(\d{1,3})\s*(?:个)?\s*(?:分镜图|分镜|镜头|scene|shot))|(?:(?:分镜图|分镜|镜头|scene|shot)\s*(\d{1,3}))/gi,
  );
  for (const match of numberMatches) {
    const rawNumber = match[1] || match[2];
    const sceneNumber = Number.parseInt(String(rawNumber || ""), 10);
    if (!Number.isFinite(sceneNumber)) continue;
    for (const scene of scenes) {
      if (scene.sceneNumber === sceneNumber) {
        matchedIds.add(scene.id);
      }
    }
  }

  const normalizedSceneEntries = scenes
    .map((scene) => ({
      id: scene.id,
      sceneName: normalizeSceneLookupText(scene.sceneName || ""),
      segmentLabel: normalizeSceneLookupText(scene.segmentLabel || ""),
    }))
    .filter((scene) => scene.sceneName.length >= 2 || scene.segmentLabel.length >= 2)
    .sort((a, b) => Math.max(b.sceneName.length, b.segmentLabel.length) - Math.max(a.sceneName.length, a.segmentLabel.length));

  for (const scene of normalizedSceneEntries) {
    if ((scene.sceneName && normalized.includes(scene.sceneName)) || (scene.segmentLabel && normalized.includes(scene.segmentLabel))) {
      matchedIds.add(scene.id);
    }
  }

  return matchedIds.size ? [...matchedIds] : undefined;
}

export function resolveDirectProjectImageIntent(
  text: string,
): { imagePrompt: string; imageKind: "character" | "scene"; batchCount?: number } | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (isInternalChoicePayload(trimmed)) return null;

  const normalized = trimmed.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (isGenerationTroubleshootingQuery(normalized, "image")) {
    return null;
  }

  if (/(视频|影片|出片|分镜|storyboard|reference image|reference asset|参考图|参考资产|角色参考|场景参考)/i.test(normalized)) {
    return null;
  }

  const vagueImageRequest =
    /^(?:请|帮我|给我|麻烦你|可以)?\s*(?:生成|生|画|绘制|做|出|create|generate|draw|make)\s*(?:一张|一幅|一个|张|幅|an?|one)?\s*(?:图片|图|图像|插画|照片|image|picture|photo|illustration)\s*(?:吧|一下|试试|看看|please)?[。.!！,，\s]*$/i;
  const vagueCountedImageRequest =
    /^(?:请|帮我|给我|麻烦你|可以)?\s*(?:生成|生|画|绘制|做|出|create|generate|draw|make)\s*(?:\d{1,2}|一|二|两|三|四|五|六|七|八|九|十|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:张|幅|个)?\s*(?:图片|图|图像|插画|照片|images?|pictures?|photos?|illustrations?)\s*(?:吧|一下|试试|看看|please)?[。.!！,，\s]*$/i;
  const vagueImageShortcut =
    /^(?:请|帮我|给我|麻烦你|可以)?\s*生图\s*(?:[。.!！,，\s]*(?:吧|一下|试试|看看|please))?[。.!！,，\s]*$/i;
  if (vagueImageRequest.test(normalized) || vagueCountedImageRequest.test(normalized) || vagueImageShortcut.test(normalized)) {
    return null;
  }

  const hasChineseImageIntent =
    /(?:帮我|请|给我|麻烦你)?\s*生图\s*(?:[:：，,。-]\s*)?[\s\S]{2,}/u.test(normalized) ||
    /(?:帮我|请|给我|麻烦你)?\s*(?:画|绘制|生成|生|做|出)\s*(?:一张|一幅|一个|张|幅)?[\s\S]{1,}(?:图|图片|图像|插画|照片)/u.test(normalized) ||
    /(?:帮我|请|给我|麻烦你)?\s*(?:画|绘制)\s*(?:一张|一幅|一个)?[\s\S]{1,}/u.test(normalized);

  const hasEnglishImageIntent =
    /\b(?:create|generate|draw|make)\s+(?:an?\s+|one\s+)?(?:image|picture|photo|illustration)\s+of\b/i.test(lower) ||
    /\b(?:create|generate|draw|make)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:images?|pictures?|photos?|illustrations?)\s+of\b/i.test(lower) ||
    /\b(?:create|generate|draw|make)\s+[\s\S]{1,}\s+(?:image|picture|photo|illustration)\b/i.test(lower);

  if (!hasChineseImageIntent && !hasEnglishImageIntent) return null;

  const batchCount = resolveImageBatchCount(normalized);
  const imageKind = inferDirectImageKind(normalized);
  return batchCount && batchCount > 1
    ? { imagePrompt: normalized, imageKind, batchCount }
    : { imagePrompt: normalized, imageKind };
}

export function resolveDirectStoryboardGenerationIntent(
  text: string,
  options?: {
    hasActiveVideoProject?: boolean;
    snapshot?: ConversationProjectSnapshot | null;
    videoProject?: DirectSceneTargetProjectLike;
  },
): { action: "generate_storyboard_frames"; targetIds?: string[] } | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (isInternalChoicePayload(trimmed)) return null;

  const hasActiveVideoProject =
    Boolean(options?.hasActiveVideoProject) || options?.snapshot?.projectKind === "video";
  if (!hasActiveVideoProject) return null;

  const normalized = trimmed.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (isGenerationTroubleshootingQuery(normalized, "image")) {
    return null;
  }

  if (
    /(?:\u5931\u8d25|\u62a5\u9519|\u9519\u8bef|\u5f02\u5e38|why|how to|debug|fix|troubleshoot|failed|error|404|401|500)/i.test(
      normalized,
    ) &&
    /(?:\u5206\u955c|storyboard)/i.test(normalized)
  ) {
    return null;
  }

  const asksHow =
    /(?:\u600e\u4e48|\u5982\u4f55|\u4e3a\u4ec0\u4e48|\u6559\u7a0b|\u8bf4\u660e|help|how to|what is|why)/i.test(lower) &&
    !/(?:\u751f\u6210|\u91cd\u751f\u6210|\u91cd\u65b0\u751f\u6210|\u91cd\u505a|generate|create|regenerate|redo).{0,24}(?:\u5206\u955c|storyboard)/i.test(
      normalized,
    );
  if (asksHow) return null;

  if (/(?:\u7528\u5206\u955c\u56fe\u751f\u6210\u89c6\u9891|\u5206\u955c\u56fe\u751f\u6210\u89c6\u9891|storyboard[\s\S]{0,24}video|image-to-video)/i.test(normalized)) {
    return null;
  }

  const hasStoryboardIntent =
    /(?:(?:\u751f\u6210|\u91cd\u751f\u6210|\u91cd\u65b0\u751f\u6210|\u91cd\u505a|\u8865\u9f50|\u7ee7\u7eed\u751f\u6210).{0,8}(?:\u5206\u955c\u56fe|\u5206\u955c\u5e27|\u5206\u955c))|(?:(?:\u5206\u955c\u56fe|\u5206\u955c\u5e27|\u5206\u955c).{0,8}(?:\u751f\u6210|\u91cd\u751f\u6210|\u91cd\u65b0\u751f\u6210|\u91cd\u505a|\u8865\u9f50))|(?:\b(?:generate|create|regenerate|redo)\b[\s\S]{0,24}\bstoryboard(?:\s+(?:frames?|images?))?\b)/i.test(
      normalized,
    );
  const targetIds = resolveExplicitSceneTargetIds(normalized, options?.videoProject);

  return hasStoryboardIntent
    ? {
        action: "generate_storyboard_frames",
        ...(targetIds?.length ? { targetIds } : {}),
      }
    : null;
}

export function resolveDirectVideoGenerationIntent(
  text: string,
  options?: {
    hasActiveVideoProject?: boolean;
    snapshot?: ConversationProjectSnapshot | null;
    videoProject?: DirectSceneTargetProjectLike;
  },
): { mode: "text-to-video" | "image-to-video"; targetIds?: string[] } | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (isInternalChoicePayload(trimmed)) return null;

  const hasActiveVideoProject =
    Boolean(options?.hasActiveVideoProject) || options?.snapshot?.projectKind === "video";

  const normalized = trimmed.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (isGenerationTroubleshootingQuery(normalized, "video")) {
    return null;
  }

  const asksHow =
    /(?:怎么|如何|为什么|教程|说明|help|how to|what is|why)/i.test(lower) &&
    !/(?:生成|出片|render|create|generate)/i.test(lower.replace(/how to generate video/gi, ""));
  if (asksHow) return null;

  const hasVideoGenerateIntent =
    /(?:生成视频|生成一个视频|开始出片|直接出片|图生视频|文生视频|用分镜图生成视频|用参考图生成视频)/i.test(normalized) ||
    /(?:生成|制作|创建|做|来一段).{0,24}(?:视频|短视频|片子)/i.test(normalized) ||
    /\b(?:generate|create|render)\b[\s\S]{0,40}\bvideo\b/i.test(lower) ||
    /\b(?:image-to-video|text-to-video)\b/i.test(lower);

  if (!hasVideoGenerateIntent) return null;

  const standalonePromptSeed = normalized
    .replace(
      /(?:请|帮我|给我|直接|立刻|马上|现在|来个|做个|做一段|生成|创建|制作|渲染|render|create|generate|video|视频|短视频|文生视频|图生视频|image-to-video|text-to-video|用分镜图|用参考图|首帧|storyboard|一个|一条|一段|一下|吧|呀|啊|啦|。|，|,|！|!|？|\?|:|：|\s)+/gi,
      "",
    )
    .trim();
  if (!hasActiveVideoProject && !standalonePromptSeed) return null;

  const wantsImageToVideo =
    /(?:图生视频|image-to-video|用分镜图|分镜图生成视频|参考图生成视频|用参考图|首帧|storyboard)/i.test(normalized);
  const wantsTextToVideo =
    /(?:文生视频|text-to-video|纯文字|只用文字)/i.test(normalized);

  const targetIds = hasActiveVideoProject
    ? resolveExplicitSceneTargetIds(normalized, options?.videoProject)
    : undefined;

  return {
    mode: wantsTextToVideo ? "text-to-video" : "image-to-video",
    ...(targetIds?.length ? { targetIds } : {}),
  };
}

export function resolveBlockedWorkflowMediaAction(
  text: string,
): "image" | "storyboard" | "video" | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (isInternalChoicePayload(trimmed)) return null;

  const normalized = trimmed.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const asksHowOrWhy =
    /(?:\u600e\u4e48|\u5982\u4f55|\u4e3a\u4ec0\u4e48|\u6559\u7a0b|\u8bf4\u660e|help|how to|what is|why)/i.test(lower);
  const mentionsMedia =
    /(?:\u751f\u56fe|\u56fe(?:\u7247)?|\u56fe\u50cf|\u63d2\u753b|\u5c01\u9762|\u6d77\u62a5|\u5206\u955c|storyboard|\u89c6\u9891|\u77ed\u89c6\u9891|trailer|video)/i.test(
      normalized,
    );
  if (asksHowOrWhy && mentionsMedia) return null;

  if (resolveDirectStoryboardGenerationIntent(normalized, { hasActiveVideoProject: true })) {
    return "storyboard";
  }
  if (resolveDirectVideoGenerationIntent(normalized, { hasActiveVideoProject: true })) {
    return "video";
  }
  if (resolveDirectProjectImageIntent(normalized)) {
    return "image";
  }

  const storyboardShortcut =
    /(?:(?:\u7ed9\u6211|\u5e2e\u6211|\u6765(?:\u4e00(?:\u5957|\u7ec4|\u4e2a))?|\u76f4\u63a5)?\s*(?:\u51fa|\u505a|\u751f\u6210|\u8865)?\s*(?:\u4e00(?:\u5957|\u7ec4)|\u51e0\u7ec4)?\s*(?:\u5206\u955c(?:\u56fe|\u5e27)?|storyboard(?:\s+frames?)?)|(?:\u5206\u955c(?:\u56fe|\u5e27)?|storyboard)(?:\s*(?:\u7ed9\u6211|\u6765(?:\u4e00(?:\u5957|\u7ec4|\u4e2a))?|\u51fa(?:\u4e00(?:\u5957|\u7ec4))?)))$/i;
  if (storyboardShortcut.test(normalized)) {
    return "storyboard";
  }

  const videoShortcut =
    /(?:(?:\u7ed9\u6211|\u5e2e\u6211|\u6765(?:\u4e00|\u6761|\u6bb5)?|\u76f4\u63a5)?\s*(?:\u51fa\u7247|\u505a|\u751f\u6210|\u6e32\u67d3|\u51fa(?:\u4e00|\u4e2a)?)\s*(?:\u4e00(?:\u6761|\u6bb5|\u4e2a)|\u51e0(?:\u6761|\u6bb5))?\s*(?:\u89c6\u9891|\u77ed\u89c6\u9891|\u9884\u544a\u7247|trailer|video)|(?:\u89c6\u9891|\u77ed\u89c6\u9891|\u9884\u544a\u7247|trailer)(?:\s*(?:\u7ed9\u6211|\u6765(?:\u4e00|\u6761|\u6bb5)?|\u51fa(?:\u4e00|\u4e2a)?))|(?:\u56fe\u751f\u89c6\u9891|\u6587\u751f\u89c6\u9891|image-to-video|text-to-video))$/i;
  if (videoShortcut.test(normalized)) {
    return "video";
  }

  const imageShortcut =
    /(?:(?:\u7ed9\u6211|\u5e2e\u6211|\u6765(?:\u4e00|\u5f20)?|\u76f4\u63a5)?\s*(?:\u751f\u6210|\u753b|\u505a|\u6574|\u51fa)\s*(?:\u4e00(?:\u4e2a|\u5f20|\u7ec4|\u5957)|\u51e0(?:\u4e2a|\u5f20|\u7ec4))?\s*(?:\u56fe(?:\u7247)?|\u56fe\u50cf|\u63d2\u753b|image|picture|photo|illustration)|(?:\u7ed9\u6211|\u6765)(?:\u4e00|\u51e0)?(?:\u4e2a|\u5f20)?\s*(?:\u56fe(?:\u7247)?|\u5c01\u9762|\u6d77\u62a5|\u89d2\u8272\u6982\u5ff5\u56fe|\u573a\u666f\u53c2\u8003\u56fe)|(?:\u751f\u56fe))$/i;
  return imageShortcut.test(normalized) ? "image" : null;
}

export function appendTextOverlayToInput(prompt: MessageInput, overlay: string): MessageInput {
  const normalizedOverlay = overlay.trim();
  if (!normalizedOverlay) return prompt;

  if (typeof prompt === "string") {
    return `${prompt.trim()}\n\n${normalizedOverlay}`.trim();
  }

  const blocks = [...prompt];
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.type === "text") {
    blocks[blocks.length - 1] = {
      type: "text",
      text: `${lastBlock.text.trim()}\n\n${normalizedOverlay}`.trim(),
    } satisfies ContentBlock;
    return blocks;
  }

  blocks.push({ type: "text", text: normalizedOverlay });
  return blocks;
}

export async function applyAutoResearchOverlay(params: {
  cleaned: string;
  launchAutoResearchTasks: (prompt: string) => Promise<{ plan?: AutoResearchPlan; taskIds: string[] } | null>;
  push: PushMessage;
  buildResearchPromptOverlay: (plan: AutoResearchPlan, taskIds: string[]) => string;
}): Promise<string> {
  const { cleaned, launchAutoResearchTasks, push, buildResearchPromptOverlay } = params;

  try {
    const research = await launchAutoResearchTasks(cleaned);
    if (!research) return cleaned;
    push("assistant", research.plan.kickoff);
    return `${cleaned}\n\n${buildResearchPromptOverlay(research.plan, research.taskIds)}`;
  } catch {
    return cleaned;
  }
}

export async function applyConversationMemoryOverlay(params: {
  cleaned: string;
  promptForEngine: string;
  runtime: StudioRuntimeState;
  loadConversationMemoryModule: () => Promise<ConversationMemoryModuleLike>;
  loadProjectStore: () => Promise<ProjectStoreModuleLike>;
  readProjectSession: (projectId: string) => StudioSessionState | null;
  flashMaintenanceHint: (message: string, duration?: number) => void;
}): Promise<string> {
  const {
    cleaned,
    promptForEngine,
    runtime,
    loadConversationMemoryModule,
    loadProjectStore,
    readProjectSession,
    flashMaintenanceHint,
  } = params;

  if (runtime.suppressHistoricalMemory) {
    return promptForEngine;
  }

  try {
    const memoryModule = await loadConversationMemoryModule();
    let memoryRuntime = runtime;
    if (!memoryRuntime.recentProjects.length) {
      try {
        const store = await loadProjectStore();
        const snapshots = await store.listRecentConversationSnapshots(8);
        memoryRuntime = {
          ...memoryRuntime,
          recentProjects: snapshots,
        };
      } catch {
        memoryRuntime = runtime;
      }
    }

    const recentProjectSessions = memoryRuntime.recentProjects
      .map((snapshot) => readProjectSession(snapshot.projectId))
      .filter((session): session is StudioSessionState => Boolean(session));
    const memoryCorpus = memoryModule.buildConversationMemoryCorpus({
      ...memoryRuntime,
      recentProjectSessions,
    });
    const preferCurrentProject = memoryModule.isProjectInternalMemoryQuery(cleaned);
    const memoryHits = memoryModule.searchConversationMemory(
      cleaned,
      memoryCorpus,
      runtime.currentProjectSnapshot?.projectId,
      { preferCurrentProject },
    ).filter((document) =>
      preferCurrentProject ? true : document.projectId !== runtime.currentProjectSnapshot?.projectId,
    );
    const memoryPrompt = memoryModule.buildConversationMemoryPrompt(memoryHits);
    if (!memoryPrompt) return promptForEngine;

    flashMaintenanceHint(memoryModule.buildConversationMemoryHint(memoryHits) ?? "已参考历史经验", 1800);
    return `${promptForEngine}\n\n${memoryPrompt}`;
  } catch {
    return promptForEngine;
  }
}

type LearningOverlayModuleLike = typeof import("@/lib/home-agent/agent-learning-overlay");

export async function applyAllOverlaysParallel(params: {
  cleaned: string;
  launchAutoResearchTasks: (prompt: string) => Promise<{ plan?: AutoResearchPlan; taskIds: string[] } | null>;
  push: PushMessage;
  buildResearchPromptOverlay: (plan: AutoResearchPlan, taskIds: string[]) => string;
  runtime: StudioRuntimeState;
  loadConversationMemoryModule: () => Promise<ConversationMemoryModuleLike>;
  loadProjectStore: () => Promise<ProjectStoreModuleLike>;
  readProjectSession: (projectId: string) => StudioSessionState | null;
  flashMaintenanceHint: (message: string, duration?: number) => void;
  currentProjectSnapshot: ConversationProjectSnapshot | null;
  loadLearningOverlayModule?: () => Promise<LearningOverlayModuleLike>;
}): Promise<{ promptForEngine: string }> {
  const {
    cleaned,
    launchAutoResearchTasks,
    push,
    buildResearchPromptOverlay,
    runtime,
    loadConversationMemoryModule,
    loadProjectStore,
    readProjectSession,
    flashMaintenanceHint,
    currentProjectSnapshot,
    loadLearningOverlayModule,
  } = params;

  // 四路并行：研究任务、记忆检索、Dreamina 能力检查、学习记忆注入
  const allowHistoricalMemory = !runtime.suppressHistoricalMemory;
  const [researchResult, memoryData, learningOverlay] = await Promise.all([
    launchAutoResearchTasks(cleaned).catch(() => null),
    !allowHistoricalMemory
      ? Promise.resolve(null)
      : (async () => {
      try {
        const memoryModule = await loadConversationMemoryModule();
        let memoryRuntime = runtime;
        if (!memoryRuntime.recentProjects.length) {
          try {
            const store = await loadProjectStore();
            const snapshots = await store.listRecentConversationSnapshots(8);
            memoryRuntime = { ...memoryRuntime, recentProjects: snapshots };
          } catch { /* ignore */ }
        }
        const recentProjectSessions = memoryRuntime.recentProjects
          .map((snapshot) => readProjectSession(snapshot.projectId))
          .filter((session): session is StudioSessionState => Boolean(session));
        const memoryCorpus = memoryModule.buildConversationMemoryCorpus({ ...memoryRuntime, recentProjectSessions });
        const preferCurrentProject = memoryModule.isProjectInternalMemoryQuery(cleaned);
        const memoryHits = memoryModule.searchConversationMemory(
          cleaned,
          memoryCorpus,
          runtime.currentProjectSnapshot?.projectId,
          { preferCurrentProject },
        ).filter((doc) =>
          preferCurrentProject ? true : doc.projectId !== runtime.currentProjectSnapshot?.projectId,
        );
        const memoryPrompt = memoryModule.buildConversationMemoryPrompt(memoryHits);
        if (!memoryPrompt) return null;
        return {
          prompt: memoryPrompt,
          hint: memoryModule.buildConversationMemoryHint(memoryHits) ?? "已参考历史经验",
        };
      } catch { return null; }
    })(),
    allowHistoricalMemory && loadLearningOverlayModule
      ? (async () => {
          try {
            const mod = await loadLearningOverlayModule();
            return mod.buildLearningMemoryOverlay({ currentProjectSnapshot, prompt: cleaned });
          } catch { return null; }
        })()
      : Promise.resolve(null),
  ]);

  // 串行组合 prompt（顺序与原逻辑一致）
  let promptForEngine = cleaned;
  if (researchResult) {
    push("assistant", researchResult.plan.kickoff);
    promptForEngine = `${promptForEngine}\n\n${buildResearchPromptOverlay(researchResult.plan, researchResult.taskIds)}`;
  }
  if (memoryData) {
    flashMaintenanceHint(memoryData.hint, 1800);
    promptForEngine = `${promptForEngine}\n\n${memoryData.prompt}`;
  }
  if (learningOverlay) {
    promptForEngine = `${promptForEngine}\n\n${learningOverlay}`;
  }

  return { promptForEngine };
}

/**
 * 将 AskUserQuestion 请求格式化为聊天消息兜底文本。
 * 当弹窗未能正常弹出时，用户仍可在聊天流中看到问题和选项。
 */
export function formatAskUserQuestionFallback(args: AskUserQuestionRequest): string {
  const parts: string[] = [];

  if (args.title) parts.push(args.title.trim());
  if (args.description?.trim()) parts.push(args.description.trim());

  for (const q of args.questions) {
    const block: string[] = [];
    // 多问题时每个问题单独显示标题；单问题且已有 title 时不重复
    const questionText = q.question?.trim();
    if (
      questionText &&
      normalizeWorkflowFallbackLine(questionText) !== normalizeWorkflowFallbackLine(args.title)
    ) {
      block.push(questionText);
    }
    for (const option of q.options) {
      const detail = option.rationale?.trim() || option.description?.trim();
      block.push(detail ? `- ${option.label}：${detail}` : `- ${option.label}`);
    }
    if (block.length) parts.push(block.join("\n"));
  }

  parts.push(buildAskUserQuestionClosingSuggestion(args));
  return parts.filter(Boolean).join("\n\n");
}

function normalizeWorkflowFallbackLine(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\s+/g, "");
}

function buildAskUserQuestionClosingSuggestion(args: AskUserQuestionRequest): string {
  if (args.questions.length > 1) {
    return args.allowCustomInput
      ? "下一步建议：先完成当前这一步；如果上面的选项都不完全合适，再直接补充你的具体偏好。"
      : "下一步建议：先完成当前这一步，我会在你确认后继续下一项。";
  }

  return args.allowCustomInput
    ? "下一步建议：优先选择最贴近当前步骤的一项；如果都不完全合适，再直接补充你的具体偏好。"
    : "下一步建议：优先选择最贴近当前步骤的一项，我会据此继续推进。";
}

function formatAskUserQuestionPromptOnly(args: AskUserQuestionRequest | null | undefined): string {
  if (!args?.questions?.length) return "";

  const parts: string[] = [];
  if (args.title) parts.push(args.title);
  for (const question of args.questions) {
    const text = question.question?.trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

function mergeAssistantQuestionFallbackText(
  baseText: string,
  request: AskUserQuestionRequest | null | undefined,
): string {
  if (!request?.questions?.length) return baseText.trim();

  const fallbackText = formatAskUserQuestionFallback(request).trim();
  if (!fallbackText) return baseText.trim();

  const cleanedBase = baseText.trim();
  if (!cleanedBase) return fallbackText;

  const normalizedBase = normalizeWorkflowFallbackLine(cleanedBase);
  const questionTexts = request.questions
    .map((question) => question.question?.trim())
    .filter((question): question is string => Boolean(question));
  const optionLabels = request.questions.flatMap((question) =>
    question.options.map((option) => option.label.trim()).filter(Boolean),
  );
  const hasQuestionText = questionTexts.some((question) =>
    normalizedBase.includes(normalizeWorkflowFallbackLine(question)),
  );
  const optionLabelHits = optionLabels.filter((label) =>
    normalizedBase.includes(normalizeWorkflowFallbackLine(label)),
  ).length;

  if (hasQuestionText && optionLabelHits >= Math.min(2, optionLabels.length)) {
    return cleanedBase;
  }

  return `${cleanedBase}\n\n${fallbackText}`.trim();
}

export async function handleSendEngineEvent(params: {
  event: SDKMessage;
  loadStructuredQuestionParser: () => Promise<StructuredQuestionParserModuleLike>;
  getCurrentProjectSnapshot?: () => ConversationProjectSnapshot | null | undefined;
  textOf: (content: unknown) => string;
  push: PushMessage;
  appendStreamingDelta: (delta: string) => void;
  updateStreamingLabel: (label?: string) => void;
  replaceStreamingWithProgressLabel?: (label?: string) => void;
  finalizeStreamingMessage: (
    finalText?: string,
    artifactIds?: string[],
    artifactSnapshots?: ConversationArtifact[],
  ) => void;
  setQuestionRequest?: (request: AskUserQuestionRequest) => void;
  consumePendingArtifacts?: () => ConversationArtifact[] | undefined;
  consumePendingArtifactIds?: () => string[] | undefined;
  getFallbackQuestionRequest?: () => AskUserQuestionRequest | null | undefined;
}): Promise<void> {
  const {
    event,
    loadStructuredQuestionParser,
    getCurrentProjectSnapshot,
    textOf,
    push,
    appendStreamingDelta,
    updateStreamingLabel,
    replaceStreamingWithProgressLabel,
    finalizeStreamingMessage,
    setQuestionRequest,
    consumePendingArtifacts,
    consumePendingArtifactIds,
    getFallbackQuestionRequest,
  } = params;

  if (event.type === 'text_delta') {
    updateStreamingLabel("继续分析中");
    appendStreamingDelta((event as { type: 'text_delta'; delta: string }).delta);
    return;
  }

  if (event.type === "progress") {
    const data = event.message.data as {
      stage?: string;
      toolNames?: string[];
      askUserQuestionArgs?: unknown;
    } | undefined;

    if (data?.askUserQuestionArgs) {
      // AskUserQuestion 工具调用：落地已流式输出的文本；问题文本由 agent:ask-user-question 事件监听器追加
      finalizeStreamingMessage();
    } else {
      const label = textOf(event.message.content) || "继续分析中";
      if (replaceStreamingWithProgressLabel) {
        replaceStreamingWithProgressLabel(label);
      } else {
        updateStreamingLabel(label);
      }
    }
    return;
  }

  if (event.type === "assistant") {
    const parser = await loadStructuredQuestionParser();
    const parsed = parser.extractStructuredQuestion(textOf(event.message.message.content));
    const fallbackRequest =
      !parsed.request && !parsed.workflowCall ? getFallbackQuestionRequest?.() ?? null : null;
    const cleanedText = parsed.cleanedText.trim();
    const consumedStructuredPayload = Boolean(parsed.request || parsed.workflowCall || fallbackRequest);
    const textFallbackRequest = parsed.request ?? fallbackRequest;
    const pendingArtifacts = consumePendingArtifacts?.();
    const pendingArtifactIds =
      pendingArtifacts?.map((artifact) => artifact.id) ?? consumePendingArtifactIds?.();
    const finalText = consumedStructuredPayload
      ? mergeAssistantQuestionFallbackText(cleanedText, textFallbackRequest) || undefined
      : cleanedText || undefined;
    if (pendingArtifactIds?.length) {
      finalizeStreamingMessage(finalText, pendingArtifactIds, pendingArtifacts);
    } else {
      finalizeStreamingMessage(finalText);
    }
    if (parsed.request) {
      setQuestionRequest?.(parsed.request);
    } else if (fallbackRequest) {
      setQuestionRequest?.(fallbackRequest);
    }
    return;
  }

  if (event.type === "result" && event.isError && event.result) {
    finalizeStreamingMessage();
    push("assistant", formatSendError(event.result));
  }
}

export function formatSendError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    (error instanceof Error && error.name === "AbortError") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("超时")
  ) {
    return "分析超时，请稍后重试。";
  }
  if (
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("fetch") ||
    msg.includes("connection") ||
    msg.includes("net::") ||
    msg.includes("网络")
  ) {
    return "网络连接异常，请检查网络后重试。";
  }
  return "分析出错，请稍后重试。";
}
