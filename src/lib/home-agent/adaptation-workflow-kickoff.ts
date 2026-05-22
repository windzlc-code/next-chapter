import type { ChatAttachment } from "@/lib/agent/chat-attachments";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";

const ADAPTATION_KICKOFF_PREFIX = "adaptation-workflow-kickoff";
const ADAPTATION_UPLOAD_SUGGESTION_PREFIX = "adaptation-workflow-upload-suggestion";

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

export function buildAdaptationWorkflowUploadSuggestionRequest(): AskUserQuestionRequest {
  const flowId = crypto.randomUUID();
  return {
    id: `${ADAPTATION_UPLOAD_SUGGESTION_PREFIX}:${flowId}:action`,
    title: "\u4e0b\u4e00\u6b65\u5efa\u8bae",
    description:
      "\u4f60\u53ef\u4ee5\u5148\u7ee7\u7eed\u548c Agent \u5bf9\u8bdd\uff1b\u5982\u679c\u5df2\u7ecf\u51c6\u5907\u597d\u53c2\u8003\u5267\u672c\uff0c\u4e5f\u53ef\u4ee5\u968f\u65f6\u4e0a\u4f20\u53c2\u8003\u6587\u6863\u3002",
    allowCustomInput: false,
    submissionMode: "immediate",
    questions: [
      {
        header: "\u5feb\u6377\u5165\u53e3",
        question: "\u9700\u8981\u65f6\u53ef\u4ee5\u76f4\u63a5\u4ece\u8fd9\u91cc\u4e0a\u4f20\u53c2\u8003\u5267\u672c\u3002",
        multiSelect: false,
        options: [
          {
            id: "upload-reference-document",
            label: "\u4e0a\u4f20\u53c2\u8003\u6587\u6863",
            value: "upload-document",
            rationale:
              "\u4e0a\u4f20 txt\u3001docx\u3001pdf \u540e\u76f4\u63a5\u53d1\u9001\uff0c\u6211\u4f1a\u5148\u63d0\u53d6\u53c2\u8003\u6587\u672c\uff0c\u518d\u56de\u5230\u5f53\u524d\u6539\u7f16\u63a8\u8fdb\u3002",
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

export function isAdaptationWorkflowUploadSuggestionRequest(
  request: Pick<AskUserQuestionRequest, "id"> | null | undefined,
): boolean {
  return Boolean(request?.id?.startsWith(ADAPTATION_UPLOAD_SUGGESTION_PREFIX));
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

export function advanceAdaptationWorkflowUploadSuggestion(params: {
  value: string;
  label?: string;
}): AdaptationWorkflowKickoffCompletion | null {
  const source = params.value.trim() as AdaptationKickoffSource;
  if (source !== "upload-document") return null;
  const displayLabel = (params.label || params.value).trim();
  return {
    source,
    userBubble: `\u4e0b\u4e00\u6b65\u5efa\u8bae\uff1a${displayLabel}`,
  };
}

export function buildAdaptationUploadInstruction(): string {
  return "\u597d\u7684\uff0c\u8bf7\u901a\u8fc7\u4e0b\u65b9\u7684\u56de\u5f62\u9488\u6309\u94ae\u4e0a\u4f20\u53c2\u8003\u5267\u672c\u6587\u6863\uff08\u652f\u6301 txt\u3001docx\u3001pdf \u683c\u5f0f\uff09\uff0c\u4e0a\u4f20\u540e\u76f4\u63a5\u53d1\u9001\u5373\u53ef\u3002\u6211\u4f1a\u5148\u5199\u5165\u53c2\u8003\u6587\u672c\uff0c\u518d\u6253\u5f00\u5f53\u524d\u6b65\u9aa4\u539f\u6709\u7684\u9009\u62e9\u9762\u677f\u3002";
}

export function isAdaptationUploadInstructionMessage(content: string | null | undefined): boolean {
  return String(content || "").includes("\u8bf7\u901a\u8fc7\u4e0b\u65b9\u7684\u56de\u5f62\u9488\u6309\u94ae\u4e0a\u4f20\u53c2\u8003\u5267\u672c\u6587\u6863");
}

export function buildAdaptationWorkflowStartPrompt(): string {
  return [
    "请从零开始和我对话，先确认目标市场、受众、改编方向和参考内容来源。",
    "不要默认我已经准备好参考文本或清晰改编方案，也不要直接执行工作流动作；如果需要用户输入，请通过 AskUserQuestion 逐步提问。",
    "每次只收集当前步骤最必要的信息，并明确告诉我现在对应的是哪一个改编工作流步骤。",
    "等参考文本或足够明确的改编目标齐备后，再引导我回到首页参考改编工作流继续推进。",
  ].join("\n");
}

export function buildAdaptationWorkflowStartDialogPrompt(): string {
  return [
    "\u8bf7\u4ece\u96f6\u5f00\u59cb\u548c\u6211\u5bf9\u8bdd\uff0c\u5148\u786e\u8ba4\u76ee\u6807\u5e02\u573a\u3001\u53d7\u4f17\u3001\u6539\u7f16\u65b9\u5411\u548c\u53c2\u8003\u5185\u5bb9\u6765\u6e90\u3002",
    "\u4e0d\u8981\u9ed8\u8ba4\u6211\u5df2\u7ecf\u51c6\u5907\u597d\u53c2\u8003\u6587\u672c\u6216\u6e05\u6670\u6539\u7f16\u65b9\u6848\uff0c\u4e5f\u4e0d\u8981\u76f4\u63a5\u6267\u884c\u5de5\u4f5c\u6d41\u52a8\u4f5c\uff1b\u5982\u679c\u9700\u8981\u7528\u6237\u8f93\u5165\uff0c\u8bf7\u901a\u8fc7 AskUserQuestion \u9010\u6b65\u63d0\u95ee\u3002",
    "\u9996\u8f6e\u56de\u590d\u5148\u7528\u7b80\u77ed\u81ea\u7136\u8bed\u8a00\u8bf4\u660e\u4f60\u4f1a\u600e\u4e48\u5e2e\u6211\uff0c\u5e76\u7ed9\u51fa\u63a5\u4e0b\u6765\u6700\u63a8\u8350\u7684 1 \u5230 2 \u4e2a\u52a8\u4f5c\u5efa\u8bae\u3002",
    "\u5728\u8fd9\u4e00\u8f6e\u91cc\u4e0d\u8981\u7acb\u5373\u8c03\u7528 AskUserQuestion\uff1b\u7b49\u6211\u7ee7\u7eed\u56de\u590d\u6216\u4e0a\u4f20\u53c2\u8003\u6587\u6863\u540e\uff0c\u518d\u8fdb\u5165\u7ed3\u6784\u5316\u8ffd\u95ee\u3002",
    "\u6bcf\u6b21\u53ea\u6536\u96c6\u5f53\u524d\u6b65\u9aa4\u6700\u5fc5\u8981\u7684\u4fe1\u606f\uff0c\u5e76\u660e\u786e\u544a\u8bc9\u6211\u73b0\u5728\u5bf9\u5e94\u7684\u662f\u54ea\u4e00\u4e2a\u6539\u7f16\u5de5\u4f5c\u6d41\u6b65\u9aa4\u3002",
    "\u7b49\u53c2\u8003\u6587\u672c\u6216\u8db3\u591f\u660e\u786e\u7684\u6539\u7f16\u76ee\u6807\u9f50\u5907\u540e\uff0c\u518d\u5f15\u5bfc\u6211\u56de\u5230\u9996\u9875\u53c2\u8003\u6539\u7f16\u5de5\u4f5c\u6d41\u7ee7\u7eed\u63a8\u8fdb\u3002",
  ].join("\n");
}
