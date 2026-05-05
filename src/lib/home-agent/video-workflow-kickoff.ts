import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import { invokeFunction } from "@/lib/invoke-with-key";

export const VIDEO_WORKFLOW_TEMPLATE_ID = "video";
const VIDEO_KICKOFF_PREFIX = "video-workflow-kickoff";

export type VideoKickoffSource = "upload-document" | "use-current-project" | "start-fresh";

export interface VideoWorkflowKickoffCompletion {
  source: VideoKickoffSource;
  userBubble: string;
}

export interface VideoWorkflowUploadScriptPayload {
  script: string;
  title?: string;
  fileNames: string[];
  extractionSummary?: string;
}

interface VideoUploadScriptRecognitionResult {
  script?: string;
  title?: string;
  summary?: string;
}

const VIDEO_WORKFLOW_EPISODE_HEADER_RE =
  /(?:^|\n)\s*(?:#\s*)?(?:EP\s*\d+|第\s*[零一二三四五六七八九十百千万\d]+\s*[集话期章]|Episode\s+\d+)\s*(?:[：:\-—].*)?(?=\n|$)/gim;
/* eslint-disable no-useless-escape */
// eslint-disable-next-line no-useless-escape
const VIDEO_WORKFLOW_SCRIPT_BODY_MARKER_RE =
  /(?:^|\n)\s*(?:△|[0-9]+\s*-\s*[0-9]+|(?!第\s*[零一二三四五六七八九十百千万\d]+\s*[集话期章]|EP\s*\d+|Episode\s+\d+)[^\s：:\[\]【】#]{1,20}[：:][^\n]{2,})/m;

/* eslint-enable no-useless-escape */

function stripAttachmentExtension(fileName: string): string {
  return fileName.trim().replace(/\.[^./\\]+$/, "");
}

const STRICT_EPISODE_HEADER_RE =
  /(?:^|\n)\s*(?:#\s*)?(?:EP\s*0*(\d+)|Episode\s+0*(\d+)|\u7b2c\s*([\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\d]+)\s*[\u96c6\u8bdd\u671f\u7ae0])/gim;
const STRICT_EPISODE_HEADER_LINE_RE =
  /^\s*(?:#\s*)?(?:EP\s*0*(\d+)|Episode\s+0*(\d+)|\u7b2c\s*([\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\d]+)\s*[\u96c6\u8bdd\u671f\u7ae0])/i;
const SEGMENT_SCENE_LINE_RE = /^\s*(\d+)\s*-\s*(\d+)\s+\S/;

export function extractVideoWorkflowUploadScript(
  attachments: ReadonlyArray<Pick<ChatAttachment, "fileName" | "kind" | "extractedText">>,
): VideoWorkflowUploadScriptPayload | null {
  const usableAttachments = attachments.filter(
    (attachment) =>
      (attachment.kind === "document" || attachment.kind === "text") &&
      typeof attachment.extractedText === "string" &&
      attachment.extractedText.trim().length > 0,
  );

  if (!usableAttachments.length) {
    return null;
  }

  const includeFileLabels = usableAttachments.length > 1;
  const script = usableAttachments
    .map((attachment) => {
      const text = attachment.extractedText!.trim();
      return includeFileLabels ? `【${attachment.fileName}】\n${text}` : text;
    })
    .join("\n\n");

  const title = stripAttachmentExtension(usableAttachments[0]?.fileName || "");

  return {
    script,
    title: title || undefined,
    fileNames: usableAttachments.map((attachment) => attachment.fileName),
  };
}

export function countEpisodes(script: string): number {
  const normalized = String(script || "").trim();
  if (!normalized) return 0;
  const segmentEpisodeKeys = normalized
    .split("\n")
    .map((line) => line.match(SEGMENT_SCENE_LINE_RE)?.[1]?.trim())
    .filter((key): key is string => Boolean(key));
  if (segmentEpisodeKeys.length) return new Set(segmentEpisodeKeys).size;
  const keys = [...normalized.matchAll(STRICT_EPISODE_HEADER_RE)]
    .map((match) => (match[1] || match[2] || match[3] || "").trim())
    .filter(Boolean);
  if (keys.length) return new Set(keys).size;
  const re = new RegExp(VIDEO_WORKFLOW_EPISODE_HEADER_RE.source, VIDEO_WORKFLOW_EPISODE_HEADER_RE.flags);
  return [...normalized.matchAll(re)].length;
}

export function trimToLikelyEpisodeScriptBody(script: string): string {
  const normalized = String(script || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const sceneIndex = lines.findIndex((line) => SEGMENT_SCENE_LINE_RE.test(line));
  if (sceneIndex < 0) return normalized;

  let startIndex = sceneIndex;
  for (let cursor = sceneIndex - 1; cursor >= Math.max(0, sceneIndex - 24); cursor -= 1) {
    if (STRICT_EPISODE_HEADER_LINE_RE.test(lines[cursor] || "")) {
      startIndex = cursor;
      break;
    }
  }

  return lines.slice(startIndex).join("\n").trim();
}

export function buildVideoUploadExtractionSummary(payload: VideoWorkflowUploadScriptPayload): string {
  const episodeCount = countEpisodes(payload.script);
  const charCount = payload.script.replace(/\s+/g, "").length;

  const title =
    payload.title
      ? `《${payload.title}》`
      : payload.fileNames.length === 1
        ? `《${stripAttachmentExtension(payload.fileNames[0])}》`
        : `${payload.fileNames.length} 个文件`;

  const parts = [`已从 ${title} 中提取到剧本正文`];
  if (episodeCount > 0) parts.push(`识别到 ${episodeCount} 集`);
  parts.push(`共约 ${charCount.toLocaleString("zh-CN")} 字`);
  parts.push("正在进入视频工作流…");

  return parts.join("，");
}

export async function recognizeVideoWorkflowUploadScript(
  payload: VideoWorkflowUploadScriptPayload,
  options?: { abortSignal?: AbortSignal },
): Promise<VideoWorkflowUploadScriptPayload> {
  const localScript = trimToLikelyEpisodeScriptBody(payload.script);
  if (!localScript) return payload;

  if (hasEpisodeScriptBody(localScript)) {
    return {
      ...payload,
      script: localScript,
      extractionSummary: payload.extractionSummary || "已按分场编号定位到上传文档中的剧本正文。",
    };
  }

  const { data, error } = await invokeFunction<VideoUploadScriptRecognitionResult>(
    "extract-video-upload-script",
    {
      script: localScript,
      title: payload.title,
      fileNames: payload.fileNames,
    },
    { abortSignal: options?.abortSignal },
  );
  if (error) throw error;

  const recognizedScript = data?.script?.trim();
  if (!recognizedScript) {
    throw new Error("AI 未能从上传文档中识别到可用的剧本正文。");
  }

  return {
    ...payload,
    script: recognizedScript,
    title: data?.title?.trim() || payload.title,
    extractionSummary: data?.summary?.trim() || payload.extractionSummary,
  };
}

export function hasEpisodeScriptBody(script: string): boolean {
  const normalized = String(script || "").trim();
  if (!normalized) return false;

  const segmentSceneCount = normalized
    .split("\n")
    .filter((line) => SEGMENT_SCENE_LINE_RE.test(line)).length;
  if (segmentSceneCount > 0) return true;

  const strictHeaderMatches = [...normalized.matchAll(STRICT_EPISODE_HEADER_RE)];
  if (strictHeaderMatches.length) return false;

  const headerMatches = [...normalized.matchAll(VIDEO_WORKFLOW_EPISODE_HEADER_RE)];
  if (!headerMatches.length) return false;
  if (VIDEO_WORKFLOW_SCRIPT_BODY_MARKER_RE.test(normalized)) return true;

  const bodyLengths = headerMatches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end =
      index + 1 < headerMatches.length ? (headerMatches[index + 1].index ?? normalized.length) : normalized.length;
    return normalized.slice(start, end).replace(/\s+/g, "").length;
  });

  return bodyLengths.some((length) => length >= 180);
}

export function buildVideoWorkflowKickoffIntro(): string {
  return "视频工作流已启动。我会引导你完成脚本拆解、角色与场景整理、分镜图生成和视频出片的完整流程。请先告诉我你的剧本来源。";
}

export function buildVideoWorkflowKickoffRequest(hasDramaProject: boolean): AskUserQuestionRequest {
  const flowId = crypto.randomUUID();
  const options = [
    ...(hasDramaProject
      ? [
          {
            label: "使用当前剧本项目",
            value: "use-current-project",
            rationale: "直接把当前剧本工作流的内容接入视频工作流，无需重新上传。",
          },
        ]
      : []),
    {
      label: "上传剧本文档",
      value: "upload-document",
      rationale: "上传 txt、docx、pdf 等格式的剧本文件，LLM 会严格按照剧本内容推进视频工作流。",
    },
    {
      label: "直接开始",
      value: "start-fresh",
      rationale: "没有现成剧本，由 Agent 引导你从头开始视频工作流。",
    },
  ];

  return {
    id: `${VIDEO_KICKOFF_PREFIX}:${flowId}:source`,
    title: "视频工作流入口",
    description: "先确定剧本来源，再由 Agent 引导你完成完整的视频生产流程。",
    allowCustomInput: false,
    submissionMode: "immediate",
    questions: [
      {
        header: "剧本来源",
        question: "你的剧本来源是什么？",
        multiSelect: false,
        options,
      },
    ],
  };
}

export function isVideoWorkflowKickoffRequest(
  request: Pick<AskUserQuestionRequest, "id"> | null | undefined,
): boolean {
  return Boolean(request?.id?.startsWith(VIDEO_KICKOFF_PREFIX));
}

export function advanceVideoWorkflowKickoff(params: {
  value: string;
  label?: string;
}): VideoWorkflowKickoffCompletion | null {
  const { value, label } = params;
  const source = value.trim() as VideoKickoffSource;
  if (!["upload-document", "use-current-project", "start-fresh"].includes(source)) {
    return null;
  }
  const displayLabel = (label || value).trim();
  return {
    source,
    userBubble: `视频工作流入口：${displayLabel}`,
  };
}

export function buildVideoWorkflowStartPrompt(source: VideoKickoffSource, scriptTitle?: string): string {
  switch (source) {
    case "use-current-project":
      return [
        `我要把当前剧本项目《${scriptTitle || "当前项目"}》接入视频工作流。`,
        "请先分析当前剧本内容，并自动补齐 targetPlatform、shotStyle、outputGoal 三个前置参数。",
        "前置参数写入后，只回复简短摘要，然后直接进入视频工作流的脚本拆解。",
      ].join("\n");
    case "upload-document":
      return [
        "我已上传剧本文档，请严格按照剧本已有的内容进行分析和扩展，不要自行添加剧本中没有的情节。",
        "请自动补齐 targetPlatform、shotStyle、outputGoal 三个前置参数。",
        "前置参数写入后，只回复简短摘要，然后直接进入视频工作流的脚本拆解。",
      ].join("\n");
    case "start-fresh":
    default:
      return [
        "我要开始一个新的视频工作流项目。",
        "请通过 AskUserQuestion 逐步询问我：1）是否有剧本内容；2）目标平台；3）镜头风格；4）出片目标。",
        "收集完信息后再推进脚本拆解，每一步都需要先确认我的选择。",
      ].join("\n");
  }
}
