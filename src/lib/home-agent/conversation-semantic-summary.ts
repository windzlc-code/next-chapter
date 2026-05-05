import { callModelAPI } from "@/lib/agent/api-client";
import type { ConversationProjectSnapshot, HomeAgentMessage } from "./types";
import { buildFallbackCompactedConversationSummary } from "./conversation-compact";

interface RefineCompactedConversationSummaryInput {
  existingSummary: string;
  compactedMessages: HomeAgentMessage[];
  projectSnapshot?: ConversationProjectSnapshot | null;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

function normalizeModelOutput(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && "type" in block)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildTranscript(messages: HomeAgentMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "用户" : "Agent"}：${message.content.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

function uniqueLines(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function summarizeArtifactLabels(snapshot: ConversationProjectSnapshot): string {
  return snapshot.artifacts
    .slice(0, 4)
    .map((artifact) => artifact.label)
    .filter(Boolean)
    .join("、");
}

function buildProjectMemoryHints(snapshot: ConversationProjectSnapshot): string[] {
  const hints: string[] = [
    `项目标题：${snapshot.title}`,
    `项目类型：${snapshot.projectKind}`,
    `当前阶段：${snapshot.derivedStage}`,
    `当前目标：${snapshot.currentObjective || "未明确"}`,
    snapshot.agentSummary ? `阶段摘要：${snapshot.agentSummary}` : "",
    snapshot.recommendedActions.length
      ? `推荐动作：${snapshot.recommendedActions.slice(0, 3).join("；")}`
      : "",
    snapshot.artifacts.length ? `关键产物：${summarizeArtifactLabels(snapshot)}` : "",
  ];

  const memory = snapshot.memory;
  if (!memory) return uniqueLines(hints);

  if (snapshot.projectKind === "video") {
    hints.push(
      memory.shotPackets?.length ? `镜头指令包：${memory.shotPackets.length} 个` : "",
      memory.assetManifest ? `素材资产：${memory.assetManifest.items.length} 项` : "",
      memory.styleLock ? `风格锁定：${memory.styleLock.tone} / ${memory.styleLock.visualStyle}` : "",
    );
  } else {
    hints.push(
      memory.characterStateCards?.length ? `角色状态卡：${memory.characterStateCards.length} 张` : "",
      memory.storyBeatPackets?.length ? `剧情 beat：${memory.storyBeatPackets.length} 条` : "",
      memory.complianceRevisionPackets?.length
        ? `合规修订：${memory.complianceRevisionPackets.length} 条`
        : "",
      snapshot.projectKind === "adaptation"
        ? "改编重点：保留参考拆解、结构转译和人物重塑的稳定结论"
        : "剧本重点：保留角色弧线、剧情推进和合规修订的稳定结论",
    );
  }

  return uniqueLines(hints);
}

export function buildProjectAwareFallbackSummary(
  summary: string,
  projectSnapshot?: ConversationProjectSnapshot | null,
): string {
  const normalizedSummary = summary.trim();
  if (!projectSnapshot) return normalizedSummary;

  const projectMemory = buildProjectMemoryHints(projectSnapshot);
  if (!projectMemory.length) return normalizedSummary;

  return [normalizedSummary, `关键项目记忆\n- ${projectMemory.join("\n- ")}`]
    .filter(Boolean)
    .join("\n");
}

export function buildProjectAwareSummaryPrompt(
  projectSnapshot?: ConversationProjectSnapshot | null,
): {
  systemPrompt: string[];
  projectContext: string;
} {
  if (!projectSnapshot) {
    return {
      systemPrompt: [
        "你是首页 Agent 会话的静默上下文压缩器。",
        "你的职责是生成一份供后续推理继续使用的高密度工作摘要。",
        "摘要要强调用户目标、明确偏好、已确认结论、已产出内容和下一步待办。",
      ],
      projectContext: "项目上下文：未绑定具体项目",
    };
  }

  const projectMemory = buildProjectMemoryHints(projectSnapshot).join("\n");
  const projectSpecificInstruction =
    projectSnapshot.projectKind === "video"
      ? "视频项目要优先保留镜头意图、素材资产、待审阅项、风格锁定和下一步出片准备。"
      : projectSnapshot.projectKind === "adaptation"
        ? "改编项目要优先保留参考拆解、结构转译、人物关系重塑和不可偏离的改编边界。"
        : "剧本项目要优先保留目标市场、角色状态卡、剧情 beat、合规修订和待写集数。";

  return {
    systemPrompt: [
      "你是首页 Agent 会话的静默上下文压缩器。",
      "你的职责是生成一份供后续推理继续使用的高密度工作摘要。",
      "摘要要强调用户目标、明确偏好、已确认结论、已产出内容和下一步待办。",
      projectSpecificInstruction,
    ],
    projectContext: [projectMemory ? "项目稳定记忆：" : "", projectMemory].filter(Boolean).join("\n"),
  };
}

export async function refineCompactedConversationSummary(
  input: RefineCompactedConversationSummaryInput,
): Promise<string> {
  const fallback = buildProjectAwareFallbackSummary(
    buildFallbackCompactedConversationSummary(input.existingSummary, input.compactedMessages),
    input.projectSnapshot,
  );
  const apiKey = input.apiKey?.trim();
  const model = input.model?.trim();

  if (!apiKey || !model || !input.compactedMessages.length) {
    return fallback;
  }

  const { systemPrompt, projectContext } = buildProjectAwareSummaryPrompt(input.projectSnapshot);

  const userPrompt = [
    "请把“既有摘要”与“新增旧会话片段”融合成一份更高质量的继续工作摘要。",
    "输出要求：",
    "1. 使用简体中文。",
    "2. 只保留稳定信息，不保留寒暄、重复追问、逐轮措辞。",
    "3. 必须覆盖：目标与约束、已确认内容、待继续推进。",
    "4. 控制在 220 到 320 字之间。",
    "5. 输出纯文本，不要加前言、不要加代码块。",
    "6. 如果项目上下文里存在稳定记忆，优先保留它们，不要遗漏关键制作状态。",
    "",
    projectContext,
    "",
    "既有摘要：",
    input.existingSummary.trim() || "暂无",
    "",
    "新增旧会话片段：",
    buildTranscript(input.compactedMessages),
  ].join("\n");

  const assistant = await callModelAPI({
    apiKey,
    baseUrl: input.baseUrl,
    model,
    tools: [],
    maxTokens: 700,
    systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const refined = normalizeModelOutput(extractAssistantText(assistant.message.content));
  return buildProjectAwareFallbackSummary(refined || fallback, input.projectSnapshot);
}
