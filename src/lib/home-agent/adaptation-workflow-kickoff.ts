import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";

const ADAPTATION_KICKOFF_PREFIX = "adaptation-workflow-kickoff";

export type AdaptationKickoffSource = "upload-document" | "start-dialog";

export interface AdaptationWorkflowKickoffCompletion {
  source: AdaptationKickoffSource;
  userBubble: string;
}

export interface AdaptationReferenceUploadPayload {
  referenceScript: string;
  title?: string;
  fileNames: string[];
}

function stripAttachmentExtension(fileName: string): string {
  return fileName.trim().replace(/\.[^./\\]+$/, "");
}

export function extractAdaptationReferenceUpload(
  attachments: ReadonlyArray<Pick<ChatAttachment, "fileName" | "kind" | "extractedText">>,
): AdaptationReferenceUploadPayload | null {
  const usableAttachments = attachments.filter(
    (attachment) =>
      (attachment.kind === "document" || attachment.kind === "text") &&
      typeof attachment.extractedText === "string" &&
      attachment.extractedText.trim().length > 0,
  );

  if (!usableAttachments.length) return null;

  const includeFileLabels = usableAttachments.length > 1;
  const referenceScript = usableAttachments
    .map((attachment) => {
      const text = attachment.extractedText!.trim();
      return includeFileLabels ? `《${attachment.fileName}》\n${text}` : text;
    })
    .join("\n\n");

  const title = stripAttachmentExtension(usableAttachments[0]?.fileName || "");

  return {
    referenceScript,
    title: title || undefined,
    fileNames: usableAttachments.map((attachment) => attachment.fileName),
  };
}

export function buildAdaptationUploadExtractionSummary(payload: AdaptationReferenceUploadPayload): string {
  const charCount = payload.referenceScript.replace(/\s+/g, "").length;
  const title =
    payload.title
      ? `《${payload.title}》`
      : payload.fileNames.length === 1
        ? `《${stripAttachmentExtension(payload.fileNames[0])}》`
        : `${payload.fileNames.length} 个文件`;

  return `已从 ${title} 中提取到参考文本，共约 ${charCount.toLocaleString("zh-CN")} 字。接下来按参考改编原有步骤继续推进。`;
}

export function buildAdaptationWorkflowKickoffIntro(): string {
  return "参考改编入口已准备好。你可以先上传参考剧本文档，由我把文本写入改编项目后继续原有步骤；也可以直接开始和 Agent 对话。";
}

export function buildAdaptationWorkflowKickoffRequest(): AskUserQuestionRequest {
  const flowId = crypto.randomUUID();
  return {
    id: `${ADAPTATION_KICKOFF_PREFIX}:${flowId}:source`,
    title: "参考改编入口",
    description: "先选择参考剧本的进入方式；只有选择直接对话时才会启动 LLM 对话。",
    allowCustomInput: false,
    submissionMode: "immediate",
    questions: [
      {
        header: "进入方式",
        question: "这次参考改编想怎么开始？",
        multiSelect: false,
        options: [
          {
            label: "上传参考文档",
            value: "upload-document",
            rationale: "上传 txt、docx、pdf 等参考剧本文档，写入项目后回到原有步骤面板继续选择执行。",
          },
          {
            label: "直接开始对话",
            value: "start-dialog",
            rationale: "不先上传文档，直接和 Agent 讨论目标市场、改编方向和参考内容。",
          },
        ],
      },
    ],
  };
}

export function isAdaptationWorkflowKickoffRequest(
  request: Pick<AskUserQuestionRequest, "id"> | null | undefined,
): boolean {
  return Boolean(request?.id?.startsWith(ADAPTATION_KICKOFF_PREFIX));
}

export function advanceAdaptationWorkflowKickoff(params: {
  value: string;
  label?: string;
}): AdaptationWorkflowKickoffCompletion | null {
  const source = params.value.trim() as AdaptationKickoffSource;
  if (!["upload-document", "start-dialog"].includes(source)) return null;
  const displayLabel = (params.label || params.value).trim();
  return {
    source,
    userBubble: `参考改编入口：${displayLabel}`,
  };
}

export function buildAdaptationWorkflowStartPrompt(): string {
  return [
    "我要做参考改编。请先和我确认目标市场、受众、改编方向和参考内容来源。",
    "不要直接执行工作流动作；如果需要用户输入，请通过 AskUserQuestion 逐步提问。",
    "等参考文本或足够明确的改编目标齐备后，再引导我回到首页参考改编工作流继续推进。",
  ].join("\n");
}
