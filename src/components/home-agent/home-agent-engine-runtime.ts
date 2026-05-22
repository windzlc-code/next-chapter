import { QueryEngine } from "@/lib/agent/query-engine";
import type { Message as QueryMessage } from "@/lib/agent/types";
import { AgentTool } from "@/lib/agent/tools/agent-tool";
import { ToolUseContext } from "@/lib/agent/tool";
import {
  AUTO_COMPACT_KEEP_RECENT_MESSAGE_COUNT,
  buildCompactedHistoryPrompt,
  planConversationCompaction,
} from "@/lib/home-agent/conversation-compact";
import { buildAutoResearchPlan } from "@/lib/home-agent/auto-research";
import type { HomeAgentMessage, StudioRuntimeState } from "@/lib/home-agent/types";
import { resolveHomeAgentTextModelRuntime } from "@/lib/home-agent/text-models";
import { isServerProxyEndpoint } from "@/lib/server-proxy";

export type HomeAgentEngineDeps = {
  createDefaultTools: typeof import("@/lib/agent/tools").createDefaultTools;
};

export type HomeAgentApiConfigModule = typeof import("@/lib/api-config");

export async function getOrCreateHomeAgentEngine(params: {
  existingEngine: QueryEngine | null;
  loadEngineDeps: () => Promise<HomeAgentEngineDeps>;
  loadApiConfigModule: () => Promise<HomeAgentApiConfigModule>;
  messages: HomeAgentMessage[];
  compactedMessageCount: number;
  recentMessageSummary: string;
  systemPrompt: string;
  toQuery: (messages: HomeAgentMessage[]) => QueryMessage[];
  getAppState: () => StudioRuntimeState;
  setRuntime: (updater: (prev: StudioRuntimeState) => StudioRuntimeState) => void;
  setCompactedMessageCount: (count: number) => void;
  selectedTextModelKey: string;
}): Promise<QueryEngine> {
  const {
    existingEngine,
    loadEngineDeps,
    loadApiConfigModule,
    messages,
    compactedMessageCount,
    recentMessageSummary,
    systemPrompt,
    toQuery,
    getAppState,
    setRuntime,
    setCompactedMessageCount,
    selectedTextModelKey,
  } = params;

  const [deps, apiConfig] = await Promise.all([loadEngineDeps(), loadApiConfigModule()]);
  const tools = deps
    .createDefaultTools()
    .filter((tool) =>
      ["AskUserQuestion", "HomeStudioWorkflow", "Agent", "TaskOutput", "TaskStop"].includes(tool.name),
    );
  const resolvedRuntime = resolveHomeAgentTextModelRuntime(apiConfig, selectedTextModelKey);

  if (!resolvedRuntime.apiKey && !isServerProxyEndpoint(resolvedRuntime.baseUrl)) {
    throw new Error(`当前未配置 ${resolvedRuntime.option.supplierLabel} / ${resolvedRuntime.option.familyLabel} 的文本模型密钥，请先在设置中完成配置。`);
  }

  if (existingEngine) {
    existingEngine.updateRuntime({
      model: resolvedRuntime.model,
      provider: resolvedRuntime.provider,
      apiKey: resolvedRuntime.apiKey,
      baseUrl: resolvedRuntime.baseUrl,
    });
    return existingEngine;
  }

  const preflightPlan = planConversationCompaction(messages, compactedMessageCount, recentMessageSummary);

  let engineSummary = recentMessageSummary;
  let engineCompactedCount = compactedMessageCount;
  let engineInitialMessages = messages.slice(
    Math.min(compactedMessageCount, Math.max(0, messages.length - AUTO_COMPACT_KEEP_RECENT_MESSAGE_COUNT)),
  );

  if (preflightPlan.shouldCompact) {
    engineSummary = preflightPlan.nextSummary;
    engineCompactedCount = preflightPlan.nextCompactedMessageCount;
    engineInitialMessages = preflightPlan.retainedMessages;
    setCompactedMessageCount(engineCompactedCount);
    setRuntime((prev) => ({
      ...prev,
      recentMessageSummary: engineSummary,
    }));
  }

  const engineCompactedHistoryPrompt =
    engineCompactedCount > 0 ? buildCompactedHistoryPrompt(engineSummary) : undefined;

  return new QueryEngine({
    apiKey: resolvedRuntime.apiKey,
    baseUrl: resolvedRuntime.baseUrl,
    provider: resolvedRuntime.provider,
    model: resolvedRuntime.model,
    tools,
    systemPrompt,
    appendSystemPrompt: engineCompactedHistoryPrompt,
    initialMessages: toQuery(engineInitialMessages),
    maxTurns: 12,
    getAppState,
    setAppState: (updater) => setRuntime((prev) => updater(prev) as StudioRuntimeState),
  });
}

export async function launchHomeAgentAutoResearchTasks(params: {
  prompt: string;
  runtime: Pick<StudioRuntimeState, "sessionId" | "currentProjectSnapshot">;
  loadApiConfigModule: () => Promise<HomeAgentApiConfigModule>;
  selectedTextModelKey: string;
  planOverride?: ReturnType<typeof buildAutoResearchPlan>;
  taskIdFilter?: string[];
  taskPromptPrefix?: string;
  sequential?: boolean;
}): Promise<{ plan?: ReturnType<typeof buildAutoResearchPlan>; taskIds: string[] } | null> {
  const {
    prompt,
    runtime,
    loadApiConfigModule,
    selectedTextModelKey,
    planOverride,
    taskIdFilter,
    taskPromptPrefix,
    sequential,
  } = params;
  const plan = planOverride ?? buildAutoResearchPlan(prompt, runtime.currentProjectSnapshot);
  if (!plan) return null;
  // 改编研究（改编路线/受众适配/角色重塑）暂时隐藏，不触发后台任务
  if (plan.reason === "adaptation-research") return null;

  const apiConfig = await loadApiConfigModule();
  const resolvedRuntime = resolveHomeAgentTextModelRuntime(apiConfig, selectedTextModelKey);
  if (!resolvedRuntime.apiKey && !isServerProxyEndpoint(resolvedRuntime.baseUrl)) return null;

  const tool = new AgentTool();
  const context = new ToolUseContext({
    options: {
      model: resolvedRuntime.model,
      provider: resolvedRuntime.provider,
      tools: [],
      apiKey: resolvedRuntime.apiKey,
      baseUrl: resolvedRuntime.baseUrl,
    },
  });

  const parentMessage = {
    type: "assistant" as const,
    uuid: crypto.randomUUID(),
    message: {
      role: "assistant" as const,
      content: "auto-research-launch",
    },
  };

  const targetTasks = taskIdFilter?.length
    ? plan.tasks.filter((task) => taskIdFilter.includes(task.id))
    : plan.tasks;
  if (!targetTasks.length) return null;

  const taskIds: string[] = [];
  const runTask = async (task: (typeof targetTasks)[number]) =>
    tool.call(
      {
        prompt: `${taskPromptPrefix || ""}${task.prompt}`,
        description: `并行研究 ${task.title}`,
        session_id: runtime.sessionId,
        project_id: runtime.currentProjectSnapshot?.projectId,
        subagent_type: "research",
        run_in_background: true,
      },
      context,
      async () => ({ behavior: "allow" }),
      parentMessage,
    );

  if (sequential) {
    for (const task of targetTasks) {
      const result = await runTask(task);
      const taskId = String(result.data).match(/Task ID:\s*([a-f0-9-]+)/i)?.[1];
      if (taskId) taskIds.push(taskId);
    }
  } else {
    const results = await Promise.all(targetTasks.map((task) => runTask(task)));
    for (const result of results) {
      const taskId = String(result.data).match(/Task ID:\s*([a-f0-9-]+)/i)?.[1];
      if (taskId) taskIds.push(taskId);
    }
  }

  if (!taskIds.length) return null;
  return { plan, taskIds };
}
