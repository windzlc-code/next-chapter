import type { Message as QueryMessage } from "@/lib/agent/types";
import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import type { HomeAgentMessage, StudioQuestionState } from "@/lib/home-agent/types";

export function stripHiddenThoughtBlocks(text: string): string {
  return String(text || "")
    .replace(/<think>\s*[\s\S]*?\s*<\/think>/gi, "")
    .replace(/^\s*<\/?think>\s*$/gim, "")
    // 移除完整的 <function_calls>...</function_calls> 工具调用块（含多行）
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    // 移除未闭合的 <function_calls> 残段，避免把参数正文漏到前台
    .replace(/<function_calls>[\s\S]*$/gi, "")
    // 移除残留的 <invoke ...>...</invoke> 块
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
    // 移除未闭合的 <invoke ...> 残段
    .replace(/<invoke[\s\S]*$/gi, "")
    // 移除完整或未闭合的 parameter 块，避免露出英文 prompt 正文
    .replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<parameter[^>]*>[\s\S]*$/gi, "")
    // 移除残留的单个工具调用标签行
    .replace(/<\/?(function_calls|invoke|parameter)[^>]*>/gi, "")
    // 移除 LLM 暴露的工具调用描述行，如 "执行动作:" / "执行操作:"
    .replace(/^[执行动作操作]{2,4}[：:]\s*$/gim, "")
    // 移除独立的工具名称行（LLM 把工具名当文本输出）
    .replace(/^\s*(AskUserQuestion|HomeStudioWorkflow|TaskOutput|TaskStop|Agent)\s*$/gm, "")
    // 移除 "label ->" 后紧跟的纯 snake_case/camelCase 值行（选项 value 泄漏）
    .replace(/^[a-z][a-z0-9_]{2,}$/gm, (match, offset, str) => {
      // 只移除紧跟在 "->" 行之后的值行
      const before = str.slice(0, offset).trimEnd();
      return before.endsWith("->") ? "" : match;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textOf(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && "type" in block)
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text?.trim() ?? "")
            .filter(Boolean)
            .join("\n\n")
        : "";
  return stripHiddenThoughtBlocks(text);
}

export function toQuery(messages: HomeAgentMessage[]): QueryMessage[] {
  return messages.flatMap((message) =>
    message.role === "system"
      ? []
      : [
          {
            type: message.role,
            uuid: message.id,
            message: { role: message.role, content: message.content },
          } as QueryMessage,
        ],
  );
}

export function createQuestionState(
  request: AskUserQuestionRequest,
  source: StudioQuestionState["source"] = "live",
): StudioQuestionState {
  return {
    source,
    request,
    currentIndex: 0,
    answers: {},
    displayAnswers: {},
  };
}
