/**
 * QueryEngine – owns the query lifecycle and session state for a conversation.
 * Port of: hare/query_engine.py
 *
 * One QueryEngine per conversation. submitMessage() starts a new turn within
 * the same conversation. State (messages, usage) persists across turns.
 */

import { v4 as uuidv4 } from 'uuid'
import { queryLoop } from './query-loop'
import { ToolUseContext, type CanUseToolFn, type Tool } from './tool'
import {
  EMPTY_USAGE,
  accumulateUsage,
  type AssistantMessage,
  type Message,
  type MessageInput,
  type ProgressMessage,
  type SDKMessage,
  type ToolUseBlock,
  type UsageStats,
  type UserMessage,
} from './types'

// ---------------------------------------------------------------------------
// QueryEngineConfig
// ---------------------------------------------------------------------------

export interface QueryEngineConfig {
  /** Anthropic API key */
  apiKey: string
  /** Optional custom base URL (e.g. proxy) */
  baseUrl?: string
  /** Optional provider hint for provider-native transports */
  provider?: string
  /** Model ID, e.g. 'claude-sonnet-4-6' */
  model?: string
  /** Tools available to the agent */
  tools?: Tool[]
  /** Permission check callback */
  canUseTool?: CanUseToolFn
  /** System prompt prepended to every request */
  systemPrompt?: string
  /** Additional system prompt appended after the main one */
  appendSystemPrompt?: string
  /** Seed messages (e.g. from a previous session) */
  initialMessages?: Message[]
  /** Maximum number of agentic turns per submitMessage() call */
  maxTurns?: number
  /** Stop if total API cost exceeds this amount (USD) */
  maxBudgetUsd?: number
  /** Getter for external app state (passed to ToolUseContext) */
  getAppState?: () => unknown
  /** Setter for external app state */
  setAppState?: (updater: (prev: unknown) => unknown) => void
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
  private config: QueryEngineConfig
  private messages: Message[]
  private abortController: AbortController
  private totalUsage: UsageStats
  private totalCostUsd: number

  constructor(config: QueryEngineConfig) {
    this.config = config
    this.messages = [...(config.initialMessages ?? [])]
    this.abortController = new AbortController()
    this.totalUsage = { ...EMPTY_USAGE }
    this.totalCostUsd = 0
  }

  private buildToolProgressMessage(message: AssistantMessage): ProgressMessage | null {
    const content = Array.isArray(message.message.content) ? message.message.content : []
    const toolUseBlocks = content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    const toolNames = toolUseBlocks.map((block) => block.name)

    if (toolNames.length === 0) return null

    const firstTool = toolNames[0]
    const contentLabel =
      firstTool === 'HomeStudioWorkflow'
        ? '正在执行工作流'
        : firstTool === 'AskUserQuestion'
          ? '正在整理下一步选项'
          : toolNames.length > 1
            ? '正在调用多个工具'
            : '正在调用工具'

    // 将 AskUserQuestion 的参数透传给 UI，用于在聊天流中渲染兜底文本
    const askBlock = toolUseBlocks.find(b => b.name === 'AskUserQuestion')

    return {
      type: 'progress',
      uuid: uuidv4(),
      content: contentLabel,
      data: {
        stage: 'tool_use',
        toolNames,
        ...(askBlock ? { askUserQuestionArgs: askBlock.input } : {}),
      },
    }
  }

  async *submitMessage(
    prompt: MessageInput,
    opts: { uuid?: string; isMeta?: boolean } = {},
  ): AsyncGenerator<SDKMessage> {
    const cfg = this.config
    const model = cfg.model ?? 'claude-sonnet-4-6'
    const tools = cfg.tools ?? []
    const sessionId = uuidv4()
    const startTime = Date.now()

    // Reset abort controller for new message
    this.abortController = new AbortController()

    // Build system prompt
    const systemParts: string[] = []
    if (cfg.systemPrompt) systemParts.push(cfg.systemPrompt)
    if (cfg.appendSystemPrompt) systemParts.push(cfg.appendSystemPrompt)

    // Add user message
    const userMsg: UserMessage = {
      type: 'user',
      uuid: opts.uuid ?? uuidv4(),
      isMeta: opts.isMeta,
      message: {
        role: 'user',
        content: prompt,
      },
    }
    this.messages.push(userMsg)

    // Yield init event
    yield {
      type: 'system',
      subtype: 'init',
      sessionId,
      tools: tools.map(t => t.name),
      model,
    } satisfies SDKMessage

    // Build ToolUseContext
    const context = new ToolUseContext({
      options: {
        model,
        provider: cfg.provider,
        tools,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        maxBudgetUsd: cfg.maxBudgetUsd,
        customSystemPrompt: cfg.systemPrompt,
        appendSystemPrompt: cfg.appendSystemPrompt,
      },
      abortSignal: this.abortController.signal,
      messages: [...this.messages],
      getAppState: cfg.getAppState,
      setAppState: cfg.setAppState,
    })

    // Run query loop
    let turnCount = 1
    let lastStopReason: string | undefined

    try {
      for await (const event of queryLoop({
        messages: [...this.messages],
        systemPrompt: systemParts,
        canUseTool: cfg.canUseTool,
        toolUseContext: context,
        maxTurns: cfg.maxTurns,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
      })) {
        if (event.type === 'stream_request_start') continue

        if (event.type === 'text_delta') {
          yield {
            type: 'text_delta',
            uuid: uuidv4(),
            sessionId,
            delta: (event as import('./types').TextDeltaEvent).delta,
          } satisfies SDKMessage
          continue
        }

        if (event.type === 'assistant') {
          this.messages.push(event as AssistantMessage)
          const msg = event as AssistantMessage
          const content = msg.message.content
          if (Array.isArray(content)) {
            const last = content[content.length - 1]
            if (last?.type === 'text') lastStopReason = msg.message.stop_reason

            // Accumulate usage
            if (msg.message.usage) {
              this.totalUsage = accumulateUsage(this.totalUsage, {
                inputTokens: msg.message.usage.input_tokens ?? 0,
                outputTokens: msg.message.usage.output_tokens ?? 0,
                cacheCreationInputTokens: msg.message.usage.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: msg.message.usage.cache_read_input_tokens ?? 0,
              })
            }
          }

          if (msg.message.stop_reason === 'tool_use') {
            const progress = this.buildToolProgressMessage(msg)
            if (progress) {
              yield {
                type: 'progress',
                uuid: progress.uuid,
                sessionId,
                message: progress,
              } satisfies SDKMessage
            }
          } else {
            yield {
              type: 'assistant',
              uuid: msg.uuid,
              sessionId,
              message: msg,
            } satisfies SDKMessage
          }

        } else if (event.type === 'user') {
          const msg = event as UserMessage
          this.messages.push(msg)
          turnCount++
          yield {
            type: 'user',
            uuid: msg.uuid,
            sessionId,
            message: msg,
          } satisfies SDKMessage

        } else if (event.type === 'progress') {
          yield {
            type: 'progress',
            uuid: (event as { uuid?: string }).uuid ?? uuidv4(),
            sessionId,
            message: event as import('./types').ProgressMessage,
          } satisfies SDKMessage
        }

        // Budget check
        if (cfg.maxBudgetUsd != null && this.totalCostUsd >= cfg.maxBudgetUsd) {
          yield {
            type: 'result',
            subtype: 'error_max_budget_usd',
            isError: true,
            durationMs: Date.now() - startTime,
            numTurns: turnCount,
            sessionId,
            totalCostUsd: this.totalCostUsd,
            usage: { ...this.totalUsage },
            uuid: uuidv4(),
          } satisfies SDKMessage
          return
        }
      }
    } catch (err) {
      yield {
        type: 'result',
        subtype: 'success',
        isError: true,
        durationMs: Date.now() - startTime,
        numTurns: turnCount,
        result: String(err),
        sessionId,
        totalCostUsd: this.totalCostUsd,
        usage: { ...this.totalUsage },
        uuid: uuidv4(),
      } satisfies SDKMessage
      return
    }

    // Extract final text result
    let textResult = ''
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
      if (msg.type === 'assistant') {
        const content = msg.message.content
        if (Array.isArray(content)) {
          const last = content[content.length - 1]
          if (last?.type === 'text') textResult = last.text
        }
        break
      }
    }

    yield {
      type: 'result',
      subtype: 'success',
      isError: false,
      durationMs: Date.now() - startTime,
      numTurns: turnCount,
      result: textResult,
      stopReason: lastStopReason,
      sessionId,
      totalCostUsd: this.totalCostUsd,
      usage: { ...this.totalUsage },
      uuid: uuidv4(),
    } satisfies SDKMessage
  }

  /** Abort the current query. */
  interrupt(): void {
    this.abortController.abort()
  }

  /** Return a copy of the conversation history. */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /** Switch the model for subsequent messages. */
  setModel(model: string): void {
    this.config.model = model
  }

  /** Update transport/runtime config for subsequent messages. */
  updateRuntime(runtime: {
    model?: string
    provider?: string
    apiKey?: string
    baseUrl?: string
  }): void {
    if (runtime.model !== undefined) this.config.model = runtime.model
    if (runtime.provider !== undefined) this.config.provider = runtime.provider
    if (runtime.apiKey !== undefined) this.config.apiKey = runtime.apiKey
    if (runtime.baseUrl !== undefined) this.config.baseUrl = runtime.baseUrl
  }
}
