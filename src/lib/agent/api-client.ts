/**
 * Anthropic-compatible API client for the homepage agent.
 *
 * Uses a minimal fetch implementation instead of the official SDK so
 * browser-side Claude-compatible gateways can pass CORS preflight.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import { getNetworkRetrySettings } from '@/lib/network-retry-settings'
import type { Tool } from './tool'
import type { AssistantMessage, ContentBlock, UsageStats } from './types'

const MAX_OUTPUT_TOKENS_DEFAULT = 16384
const MAX_OUTPUT_TOKENS_THINKING = 32768
const DEFAULT_GEMINI_BASE_URL = 'https://api.tu-zi.com/v1beta'
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

function getMaxOutputTokens(model: string): number {
  return model.toLowerCase().includes('opus')
    ? MAX_OUTPUT_TOKENS_THINKING
    : MAX_OUTPUT_TOKENS_DEFAULT
}

function buildSystemBlocks(
  systemPrompt: string[],
): string | Anthropic.TextBlockParam[] {
  if (systemPrompt.length === 0) return ''
  if (systemPrompt.length === 1) return systemPrompt[0]
  return systemPrompt.map(s => ({ type: 'text' as const, text: s }))
}

function buildToolsParam(tools: Tool[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.searchHint || t.name,
    input_schema: t.inputSchema() as Anthropic.Tool.InputSchema,
  }))
}

type ModelApiBridgePayload = {
  url: string
  apiKey: string
  requestParams: Record<string, unknown>
}

function canUseElectronModelBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.invoke === 'function'
}

async function invokeElectronModelBridge(payload: ModelApiBridgePayload): Promise<Anthropic.Message> {
  const response = await window.electronAPI!.invoke('agent:callModelApi', payload) as
    | { ok: true; data: Anthropic.Message }
    | { ok: false; error: string }

  if (!response?.ok) {
    throw new Error((response as { error?: string } | undefined)?.error || 'Electron model bridge failed')
  }

  return response.data
}

function buildMessagesApiUrl(baseUrl?: string): string {
  const root = String(baseUrl || 'https://api.anthropic.com')
    .replace(/\/v1beta(\/.*)?$/i, '')
    .replace(/\/v1(\/.*)?$/i, '')
    .replace(/\/+$/i, '')
  return `${root}/v1/messages`
}

function buildGeminiApiUrl(baseUrl: string | undefined, model: string, stream: boolean): string {
  const root = String(baseUrl || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/i, '')
    .replace(/\/v1(\/.*)?$/i, '')
    .replace(/\/+$/i, '')

  return `${root}/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
}

function isGeminiTransport(provider: string | undefined, model: string): boolean {
  if (provider?.toLowerCase() === 'gemini') return true
  return /^gemini-/i.test(String(model || '').trim())
}

function isChatCompletionsTransport(provider: string | undefined, model: string): boolean {
  const normalizedProvider = provider?.toLowerCase()
  if (normalizedProvider === 'gpt' || normalizedProvider === 'grok') return true
  return /^(gpt-|grok-)/i.test(String(model || '').trim())
}

function resolveChatCompletionsService(provider: string | undefined, model: string): 'gpt' | 'grok' {
  if (provider?.toLowerCase() === 'grok') return 'grok'
  if (/^grok-/i.test(String(model || '').trim())) return 'grok'
  return 'gpt'
}

function buildChatCompletionsApiUrl(baseUrl?: string): string {
  const root = String(baseUrl || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta(\/.*)?$/i, '')
    .replace(/\/v1(\/.*)?$/i, '')
    .replace(/\/+$/i, '')
  return `${root}/v1/chat/completions`
}

async function fetchWithRetry(opts: {
  url: string
  apiKey: string
  headers?: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
}): Promise<Response> {
  const { maxRetries, delayMs } = getNetworkRetrySettings()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    })

    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
      return response
    }

    await new Promise(resolve => setTimeout(resolve, Math.min(delayMs * (2 ** attempt), 60_000)))
  }

  throw new Error('Unreachable retry state')
}

async function fetchJsonWithRetry(opts: {
  url: string
  apiKey: string
  headers?: Record<string, string>
  body: Record<string, unknown>
  signal?: AbortSignal
}): Promise<Response> {
  return fetchWithRetry(opts)
}

function buildGeminiToolsParam(tools: Tool[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools.length) return undefined

  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.searchHint || tool.name,
      parameters: tool.inputSchema(),
    })),
  }]
}

function buildChatCompletionsToolsParam(tools: Tool[]):
  | Array<{
      type: 'function'
      function: {
        name: string
        description: string
        parameters: Record<string, unknown>
      }
    }>
  | undefined {
  if (!tools.length) return undefined

  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.searchHint || tool.name,
      parameters: tool.inputSchema(),
    },
  }))
}

function normalizeGeminiFunctionArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function buildFileFallbackText(block: Extract<ContentBlock, { type: 'input_file' }>): string {
  const summaryParts = [
    `文件: ${block.fileName}`,
    `MIME: ${block.mimeType}`,
    ...(typeof block.size === 'number' ? [`大小: ${block.size} bytes`] : []),
    ...(block.extension ? [`扩展名: ${block.extension}`] : []),
  ]

  if (typeof block.extractedText === 'string' && block.extractedText.trim()) {
    summaryParts.push(`提取文本:\n${block.extractedText}`)
  } else if (typeof block.fallbackDigest === 'string' && block.fallbackDigest.trim()) {
    summaryParts.push(`元信息摘要:\n${block.fallbackDigest}`)
  }

  return summaryParts.join('\n')
}

function buildMediaFallbackText(
  block: Extract<ContentBlock, { type: 'input_image' | 'input_video' }>,
): string {
  const label = block.type === 'input_video' ? '视频' : '图片'
  return [
    `${label}: ${block.fileName || '未命名附件'}`,
    `MIME: ${block.mimeType}`,
    ...(block.type === 'input_video' && block.fallbackText ? [block.fallbackText] : []),
  ].join('\n')
}

function mapAnthropicContentBlock(block: ContentBlock): Anthropic.ContentBlockParam | null {
  if (block.type === 'text') {
    return { type: 'text', text: block.text } as Anthropic.ContentBlockParam
  }

  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      content: block.content,
      is_error: block.is_error,
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: block.thinking,
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'input_image' && block.base64) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.mimeType,
        data: block.base64,
      },
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'input_file' && block.base64) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: block.mimeType,
        data: block.base64,
      },
      title: block.fileName,
      context: block.extractedText || block.fallbackDigest || '',
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'input_video') {
    return {
      type: 'text',
      text: buildMediaFallbackText(block),
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'input_file') {
    return {
      type: 'text',
      text: buildFileFallbackText(block),
    } as Anthropic.ContentBlockParam
  }

  if (block.type === 'input_image') {
    return {
      type: 'text',
      text: buildMediaFallbackText(block),
    } as Anthropic.ContentBlockParam
  }

  return null
}

function buildAnthropicMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map(message => {
    if (typeof message.content === 'string') return message

    const mappedBlocks = message.content
      .map(block => mapAnthropicContentBlock(block as ContentBlock))
      .filter((block): block is Anthropic.ContentBlockParam => Boolean(block))

    return {
      ...message,
      content: mappedBlocks,
    }
  })
}

function buildGeminiContents(messages: Anthropic.MessageParam[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = []
  const toolNamesById = new Map<string, string>()

  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: Array<Record<string, unknown>> = []

    if (typeof message.content === 'string') {
      if (message.content.trim()) parts.push({ text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        const normalizedBlock = block as ContentBlock
        if (normalizedBlock.type === 'text' && typeof normalizedBlock.text === 'string' && normalizedBlock.text.trim()) {
          parts.push({ text: normalizedBlock.text })
          continue
        }

        if (normalizedBlock.type === 'input_image') {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64,
              },
            })
          } else {
            parts.push({ text: buildMediaFallbackText(normalizedBlock) })
          }
          continue
        }

        if (normalizedBlock.type === 'input_video') {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64,
              },
            })
          }
          if (!normalizedBlock.base64 || normalizedBlock.fallbackText) {
            parts.push({ text: buildMediaFallbackText(normalizedBlock) })
          }
          continue
        }

        if (normalizedBlock.type === 'input_file') {
          if (normalizedBlock.base64) {
            parts.push({
              inlineData: {
                mimeType: normalizedBlock.mimeType,
                data: normalizedBlock.base64,
              },
            })
          }
          parts.push({ text: buildFileFallbackText(normalizedBlock) })
          continue
        }

        if (normalizedBlock.type === 'tool_use' && message.role === 'assistant') {
          toolNamesById.set(normalizedBlock.id, normalizedBlock.name)
          parts.push({
            functionCall: {
              name: normalizedBlock.name,
              args: normalizeGeminiFunctionArgs(normalizedBlock.input),
            },
          })
          continue
        }

        if (normalizedBlock.type === 'tool_result' && message.role === 'user') {
          const name = toolNamesById.get(normalizedBlock.tool_use_id) || 'ToolResult'
          parts.push({
            functionResponse: {
              name,
              response: {
                result: typeof normalizedBlock.content === 'string' ? normalizedBlock.content : JSON.stringify(normalizedBlock.content ?? ''),
                is_error: Boolean(normalizedBlock.is_error),
              },
            },
          })
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

type ChatCompletionsMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: Array<Record<string, unknown>> }
  | { role: 'tool'; tool_call_id: string; content: string }

function buildChatCompletionsMessages(
  messages: Anthropic.MessageParam[],
  systemPrompt: string[],
): ChatCompletionsMessage[] {
  const result: ChatCompletionsMessage[] = []

  if (systemPrompt.length > 0) {
    result.push({ role: 'system', content: systemPrompt.join('\n\n') })
  }

  for (const message of messages) {
    if (typeof message.content === 'string') {
      const content = message.content.trim()
      if (content) {
        result.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content,
        })
      }
      continue
    }

    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []

    for (const block of message.content) {
      const normalizedBlock = block as ContentBlock
      if (normalizedBlock.type === 'text' && typeof normalizedBlock.text === 'string' && normalizedBlock.text.trim()) {
        textParts.push(normalizedBlock.text)
        continue
      }

      if (normalizedBlock.type === 'input_image' || normalizedBlock.type === 'input_video') {
        textParts.push(buildMediaFallbackText(normalizedBlock))
        continue
      }

      if (normalizedBlock.type === 'input_file') {
        textParts.push(buildFileFallbackText(normalizedBlock))
        continue
      }

      if (normalizedBlock.type === 'tool_use' && message.role === 'assistant') {
        toolCalls.push({
          id: normalizedBlock.id,
          type: 'function',
          function: {
            name: normalizedBlock.name,
            arguments: JSON.stringify(normalizeGeminiFunctionArgs(normalizedBlock.input)),
          },
        })
        continue
      }

      if (normalizedBlock.type === 'tool_result' && message.role === 'user') {
        result.push({
          role: 'tool',
          tool_call_id: normalizedBlock.tool_use_id,
          content: typeof normalizedBlock.content === 'string' ? normalizedBlock.content : JSON.stringify(normalizedBlock.content ?? ''),
        })
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      result.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: textParts.join('\n\n'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }

  return result
}

function buildGeminiAssistantMessage(params: {
  model: string
  parts: Array<Record<string, unknown>>
  inputTokens?: number
  outputTokens?: number
}): AssistantMessage {
  const { model, parts, inputTokens = 0, outputTokens = 0 } = params
  const contentBlocks: ContentBlock[] = []
  let aggregatedText = ''

  for (const part of parts) {
    if (typeof part.text === 'string' && part.text) {
      aggregatedText += part.text
      continue
    }

    const functionCall = part.functionCall as { name?: string; args?: unknown } | undefined
    if (functionCall?.name) {
      contentBlocks.push({
        type: 'tool_use',
        id: uuidv4(),
        name: functionCall.name,
        input: normalizeGeminiFunctionArgs(functionCall.args),
      })
    }
  }

  if (aggregatedText) {
    contentBlocks.unshift({ type: 'text', text: aggregatedText })
  }

  return {
    type: 'assistant',
    uuid: uuidv4(),
    message: {
      role: 'assistant',
      content: contentBlocks,
      model,
      stop_reason: contentBlocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    },
  }
}

async function callGeminiNative(opts: CallModelOptions): Promise<AssistantMessage> {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const response = await fetchJsonWithRetry({
    url: buildGeminiApiUrl(baseUrl, model, false),
    apiKey,
    body: {
      contents: buildGeminiContents(messages),
      ...(systemPrompt.length > 0
        ? {
            systemInstruction: {
              role: 'system',
              parts: [{ text: systemPrompt.join('\n\n') }],
            },
          }
        : {}),
      ...(tools.length > 0
        ? {
            tools: buildGeminiToolsParam(tools),
            toolConfig: {
              functionCallingConfig: { mode: 'AUTO' },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
      },
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
  }

  const parsed = await response.json() as {
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
  }

  return buildGeminiAssistantMessage({
    model,
    parts: parsed.candidates?.[0]?.content?.parts ?? [],
    inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
  })
}

async function* callGeminiNativeStream(
  opts: CallModelOptions,
): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'message'; message: AssistantMessage }> {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const response = await fetchWithRetry({
    url: buildGeminiApiUrl(baseUrl, model, true),
    apiKey,
    body: {
      contents: buildGeminiContents(messages),
      ...(systemPrompt.length > 0
        ? {
            systemInstruction: {
              role: 'system',
              parts: [{ text: systemPrompt.join('\n\n') }],
            },
          }
        : {}),
      ...(tools.length > 0
        ? {
            tools: buildGeminiToolsParam(tools),
            toolConfig: {
              functionCallingConfig: { mode: 'AUTO' },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: effectiveMaxTokens,
      },
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedText = ''
  let emittedText = ''
  let inputTokens = 0
  let outputTokens = 0
  const seenToolCalls = new Set<string>()
  const toolUseBlocks: ContentBlock[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue

        let parsed: {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
          candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
        }
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }

        inputTokens = parsed.usageMetadata?.promptTokenCount ?? inputTokens
        outputTokens = parsed.usageMetadata?.candidatesTokenCount ?? outputTokens

        const parts = parsed.candidates?.[0]?.content?.parts ?? []
        const chunkText = parts
          .filter(part => typeof part.text === 'string' && !part.thought)
          .map(part => String(part.text))
          .join('')

        if (chunkText) {
          const delta = chunkText.startsWith(accumulatedText)
            ? chunkText.slice(accumulatedText.length)
            : chunkText
          if (delta) {
            accumulatedText += delta
            emittedText += delta
            yield { type: 'delta', text: delta }
          }
        }

        for (const part of parts) {
          const functionCall = part.functionCall as { name?: string; args?: unknown } | undefined
          if (!functionCall?.name) continue

          const fingerprint = JSON.stringify({
            name: functionCall.name,
            args: normalizeGeminiFunctionArgs(functionCall.args),
          })
          if (seenToolCalls.has(fingerprint)) continue
          seenToolCalls.add(fingerprint)

          toolUseBlocks.push({
            type: 'tool_use',
            id: uuidv4(),
            name: functionCall.name,
            input: normalizeGeminiFunctionArgs(functionCall.args),
          })
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield {
    type: 'message',
    message: {
      type: 'assistant',
      uuid: uuidv4(),
      message: {
        role: 'assistant',
        content: [
          ...(emittedText ? [{ type: 'text', text: emittedText } satisfies ContentBlock] : []),
          ...toolUseBlocks,
        ],
        model,
        stop_reason: toolUseBlocks.length > 0 ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      },
    },
  }
}

async function callChatCompletionsNative(opts: CallModelOptions): Promise<AssistantMessage> {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl, provider } = opts
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const response = await fetchJsonWithRetry({
    url: buildChatCompletionsApiUrl(baseUrl),
    apiKey,
    body: {
      model,
      messages: buildChatCompletionsMessages(messages, systemPrompt),
      ...(tools.length > 0 ? { tools: buildChatCompletionsToolsParam(tools), tool_choice: 'auto' } : {}),
      max_tokens: effectiveMaxTokens,
      stream: false,
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
  }

  const parsed = await response.json() as {
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }>
  }

  const choice = parsed.choices?.[0]?.message
  const contentBlocks: ContentBlock[] = []
  if (choice?.content) {
    contentBlocks.push({ type: 'text', text: choice.content })
  }
  for (const toolCall of choice?.tool_calls ?? []) {
    const rawArgs = toolCall.function?.arguments ?? '{}'
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(rawArgs)
    } catch {
      input = {}
    }
    if (toolCall.function?.name) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id || uuidv4(),
        name: toolCall.function.name,
        input,
      })
    }
  }

  return {
    type: 'assistant',
    uuid: uuidv4(),
    message: {
      role: 'assistant',
      content: contentBlocks,
      model,
      stop_reason: contentBlocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: parsed.usage?.prompt_tokens ?? 0,
        output_tokens: parsed.usage?.completion_tokens ?? 0,
      },
    },
  }
}

async function* callChatCompletionsNativeStream(
  opts: CallModelOptions,
): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'message'; message: AssistantMessage }> {
  const { messages, systemPrompt, model, tools, maxTokens, apiKey, baseUrl } = opts
  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const response = await fetchWithRetry({
    url: buildChatCompletionsApiUrl(baseUrl),
    apiKey,
    body: {
      model,
      messages: buildChatCompletionsMessages(messages, systemPrompt),
      ...(tools.length > 0 ? { tools: buildChatCompletionsToolsParam(tools), tool_choice: 'auto' } : {}),
      max_tokens: effectiveMaxTokens,
      stream: true,
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulatedText = ''
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>()
  let inputTokens = 0
  let outputTokens = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue

        let parsed: {
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
        }
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }

        inputTokens = parsed.usage?.prompt_tokens ?? inputTokens
        outputTokens = parsed.usage?.completion_tokens ?? outputTokens

        const delta = parsed.choices?.[0]?.delta
        if (delta?.content) {
          accumulatedText += delta.content
          yield { type: 'delta', text: delta.content }
        }

        for (const toolCall of delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0
          const current = toolCallMap.get(index) ?? {
            id: toolCall.id || uuidv4(),
            name: '',
            args: '',
          }
          if (toolCall.id) current.id = toolCall.id
          if (toolCall.function?.name) current.name = toolCall.function.name
          if (typeof toolCall.function?.arguments === 'string') {
            current.args += toolCall.function.arguments
          }
          toolCallMap.set(index, current)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const contentBlocks: ContentBlock[] = []
  if (accumulatedText) {
    contentBlocks.push({ type: 'text', text: accumulatedText })
  }
  for (const toolCall of toolCallMap.values()) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(toolCall.args || '{}')
    } catch {
      input = {}
    }
    if (toolCall.name) {
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id || uuidv4(),
        name: toolCall.name,
        input,
      })
    }
  }

  yield {
    type: 'message',
    message: {
      type: 'assistant',
      uuid: uuidv4(),
      message: {
        role: 'assistant',
        content: contentBlocks,
        model,
        stop_reason: contentBlocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      },
    },
  }
}

export interface CallModelOptions {
  messages: Anthropic.MessageParam[]
  systemPrompt: string[]
  model: string
  provider?: string
  tools: Tool[]
  thinkingConfig?: Record<string, unknown>
  maxTokens?: number
  apiKey: string
  baseUrl?: string
}

export async function callModelAPI(opts: CallModelOptions): Promise<AssistantMessage> {
  const {
    messages,
    systemPrompt,
    model,
    provider,
    tools,
    thinkingConfig,
    maxTokens,
    apiKey,
    baseUrl,
  } = opts

  if (isGeminiTransport(provider, model)) {
    return callGeminiNative(opts)
  }

  if (isChatCompletionsTransport(provider, model)) {
    return callChatCompletionsNative(opts)
  }

  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const systemBlock = buildSystemBlocks(systemPrompt)
  const toolsParam = tools.length > 0 ? buildToolsParam(tools) : undefined

  const requestParams = {
    model,
    max_tokens: effectiveMaxTokens,
    messages: buildAnthropicMessages(messages),
    ...(systemBlock ? { system: systemBlock } : {}),
    ...(toolsParam ? { tools: toolsParam } : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig as unknown as Anthropic.ThinkingConfigParam } : {}),
  }

  const requestUrl = buildMessagesApiUrl(baseUrl)
  const parsed = canUseElectronModelBridge()
    ? await invokeElectronModelBridge({
        url: requestUrl,
        apiKey,
        requestParams,
      })
    : await (async () => {
        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestParams),
        })

        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(
            `Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`,
          )
        }

        return await response.json() as Anthropic.Message
      })()

  const contentBlocks: ContentBlock[] = parsed.content.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block.thinking }
    }
    return { type: 'text', text: '' }
  })

  const usage: UsageStats = {
    inputTokens: parsed.usage.input_tokens,
    outputTokens: parsed.usage.output_tokens,
    cacheCreationInputTokens: (parsed.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: (parsed.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
  }

  return {
    type: 'assistant',
    uuid: uuidv4(),
    message: {
      role: 'assistant',
      content: contentBlocks,
      model: parsed.model,
      stop_reason: parsed.stop_reason ?? 'end_turn',
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
      },
    },
  }
}

/** Streaming version: yields text deltas then the final AssistantMessage */
export async function* callModelAPIStream(opts: CallModelOptions): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'message'; message: AssistantMessage }> {
  const { messages, systemPrompt, model, provider, tools, thinkingConfig, maxTokens, apiKey, baseUrl } = opts

  if (isGeminiTransport(provider, model)) {
    yield* callGeminiNativeStream(opts)
    return
  }

  if (isChatCompletionsTransport(provider, model)) {
    yield* callChatCompletionsNativeStream(opts)
    return
  }

  const effectiveMaxTokens = maxTokens ?? getMaxOutputTokens(model)
  const systemBlock = buildSystemBlocks(systemPrompt)
  const toolsParam = tools.length > 0 ? buildToolsParam(tools) : undefined

  const requestParams = {
    model,
    max_tokens: effectiveMaxTokens,
    stream: true,
    messages: buildAnthropicMessages(messages),
    ...(systemBlock ? { system: systemBlock } : {}),
    ...(toolsParam ? { tools: toolsParam } : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig as unknown as Anthropic.ThinkingConfigParam } : {}),
  }

  const requestUrl = buildMessagesApiUrl(baseUrl)

  // Electron bridge: use streaming IPC handler
  if (canUseElectronModelBridge()) {
    const streamId = Math.random().toString(36).slice(2)
    const electronAPI = window.electronAPI as unknown as Record<string, unknown>
    const onFn = electronAPI.on as ((channel: string, listener: (...args: unknown[]) => void) => void) | undefined
    const offFn = electronAPI.off as ((channel: string, listener: (...args: unknown[]) => void) => void) | undefined

    if (onFn && offFn) {
      // Use streaming IPC
      const deltaQueue: string[] = []
      let resolveNext: (() => void) | null = null
      let done = false

      const listener = (...args: unknown[]) => {
        const payload = args[0] as { streamId: string; delta: string }
        if (payload.streamId !== streamId) return
        deltaQueue.push(payload.delta)
        resolveNext?.()
        resolveNext = null
      }

      onFn('agent:stream-delta', listener)

      // Start the streaming request (non-blocking)
      const invokePromise = window.electronAPI!.invoke('agent:callModelApiStream', {
        url: requestUrl,
        apiKey,
        requestParams: { ...requestParams, stream: false }, // main process adds stream:true
        streamId,
      }) as Promise<{ ok: boolean; data?: Anthropic.Message; error?: string }>

      invokePromise.then(() => {
        done = true
        resolveNext?.()
        resolveNext = null
      }).catch(() => {
        done = true
        resolveNext?.()
        resolveNext = null
      })

      // Yield deltas as they arrive
      while (true) {
        if (deltaQueue.length > 0) {
          yield { type: 'delta', text: deltaQueue.shift()! }
        } else if (done) {
          break
        } else {
          await new Promise<void>((resolve) => { resolveNext = resolve })
        }
      }

      offFn('agent:stream-delta', listener)

      // Yield final message
      const result = await invokePromise
      if (!result.ok || !result.data) {
        throw new Error(result.error || 'Electron streaming bridge failed')
      }
      const parsed = result.data
      const contentBlocks: ContentBlock[] = parsed.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text }
        if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> }
        if (block.type === 'thinking') return { type: 'thinking', thinking: (block as { thinking: string }).thinking }
        return { type: 'text', text: '' }
      })
      yield {
        type: 'message',
        message: {
          type: 'assistant',
          uuid: uuidv4(),
          message: {
            role: 'assistant',
            content: contentBlocks,
            model: parsed.model,
            stop_reason: parsed.stop_reason ?? 'end_turn',
            usage: { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens },
          },
        },
      }
      return
    }

    // Fallback: no on/off support, use non-streaming
    const msg = await callModelAPI(opts)
    const text = (Array.isArray(msg.message.content) ? msg.message.content : [])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    if (text) yield { type: 'delta', text }
    yield { type: 'message', message: msg }
    return
  }

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestParams),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Model ${model} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let accText = ''
  const contentBlocks: ContentBlock[] = []
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = 'end_turn'
  let currentToolUse: { id: string; name: string; inputJson: string } | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        let event: Record<string, unknown>
        try { event = JSON.parse(data) } catch { continue }

        const type = event.type as string
        if (type === 'content_block_start') {
          const block = event.content_block as Record<string, unknown>
          if (block?.type === 'tool_use') {
            currentToolUse = { id: block.id as string, name: block.name as string, inputJson: '' }
          }
        } else if (type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>
          if (delta?.type === 'text_delta') {
            const chunk = delta.text as string
            accText += chunk
            yield { type: 'delta', text: chunk }
          } else if (delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.inputJson += delta.partial_json as string
          }
        } else if (type === 'content_block_stop') {
          if (currentToolUse) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(currentToolUse.inputJson) } catch { /* ignore */ }
            contentBlocks.push({ type: 'tool_use', id: currentToolUse.id, name: currentToolUse.name, input })
            currentToolUse = null
          }
        } else if (type === 'message_delta') {
          const delta = event.delta as Record<string, unknown>
          if (delta?.stop_reason) stopReason = delta.stop_reason as string
          const usage = event.usage as Record<string, number> | undefined
          if (usage?.output_tokens) outputTokens = usage.output_tokens
        } else if (type === 'message_start') {
          const msg = event.message as Record<string, unknown>
          const usage = msg?.usage as Record<string, number> | undefined
          if (usage?.input_tokens) inputTokens = usage.input_tokens
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (accText) contentBlocks.unshift({ type: 'text', text: accText })

  yield {
    type: 'message',
    message: {
      type: 'assistant',
      uuid: uuidv4(),
      message: {
        role: 'assistant',
        content: contentBlocks,
        model,
        stop_reason: stopReason,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    },
  }
}

/** Convert internal messages to Anthropic API format */
export function toAPIMessages(messages: import('./types').Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.type === 'user' || msg.type === 'assistant') {
      const content = msg.message.content
      if (typeof content === 'string') {
        result.push({ role: msg.message.role, content })
      } else {
        const blocks = content.filter(b => b.type !== 'thinking')
        if (blocks.length > 0) {
          result.push({
            role: msg.message.role,
            content: blocks as Anthropic.ContentBlockParam[],
          })
        }
      }
    }
  }

  return result
}
