/**
 * Agent framework type definitions.
 * Port of: hare/types/message.py + hare/types/permissions.py
 */

// ---------------------------------------------------------------------------
// Permission types
// ---------------------------------------------------------------------------

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface PermissionAllowDecision {
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
}

export interface PermissionDenyDecision {
  behavior: 'deny'
  message?: string
}

export type PermissionResult = PermissionAllowDecision | PermissionDenyDecision

// ---------------------------------------------------------------------------
// Message content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface InputImageBlock {
  type: 'input_image'
  mimeType: string
  fileName?: string
  base64?: string
  localPath?: string
  previewUrl?: string
  alt?: string
}

export interface InputVideoBlock {
  type: 'input_video'
  mimeType: string
  fileName?: string
  base64?: string
  localPath?: string
  previewUrl?: string
  fallbackText?: string
}

export interface InputFileBlock {
  type: 'input_file'
  mimeType: string
  fileName: string
  size?: number
  extension?: string
  base64?: string
  localPath?: string
  extractedText?: string
  fallbackDigest?: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export type ContentBlock =
  | TextBlock
  | InputImageBlock
  | InputVideoBlock
  | InputFileBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

export type MessageInput = string | ContentBlock[]

// ---------------------------------------------------------------------------
// API message format (sent to/from Anthropic API)
// ---------------------------------------------------------------------------

export interface APIMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  stop_reason?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Internal message types
// ---------------------------------------------------------------------------

export interface UserMessage {
  type: 'user'
  uuid: string
  message: APIMessage
  isMeta?: boolean
  toolUseResult?: string
  sourceToolAssistantUuid?: string
}

export interface AssistantMessage {
  type: 'assistant'
  uuid: string
  message: APIMessage
  isApiErrorMessage?: boolean
}

export interface SystemMessage {
  type: 'system'
  subtype: 'init' | 'compact_boundary' | 'api_error'
  uuid: string
  content?: string
}

export interface ProgressMessage {
  type: 'progress'
  uuid: string
  data?: Record<string, unknown>
  content?: string
}

export interface AttachmentMessage {
  type: 'attachment'
  uuid: string
  attachment: Record<string, unknown>
}

export interface RequestStartEvent {
  type: 'stream_request_start'
}

export interface TextDeltaEvent {
  type: 'text_delta'
  delta: string
}

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage

// ---------------------------------------------------------------------------
// ToolResult
// ---------------------------------------------------------------------------

export interface ToolResult {
  data: unknown
  newMessages?: Message[]
  contextModifier?: (ctx: import('./tool').ToolUseContext) => import('./tool').ToolUseContext
}

// ---------------------------------------------------------------------------
// SDKMessage – all events yielded by QueryEngine.submitMessage()
// ---------------------------------------------------------------------------

export interface SDKInitMessage {
  type: 'system'
  subtype: 'init'
  sessionId: string
  tools: string[]
  model: string
}

export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  sessionId: string
  uuid: string
}

export interface SDKResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd'
  isError: boolean
  durationMs: number
  numTurns: number
  result?: string
  stopReason?: string
  sessionId: string
  totalCostUsd: number
  usage: UsageStats
  uuid: string
}

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid: string
  sessionId: string
  message: AssistantMessage
}

export interface SDKUserMessage {
  type: 'user'
  uuid: string
  sessionId: string
  message: UserMessage
}

export interface SDKProgressMessage {
  type: 'progress'
  uuid: string
  sessionId: string
  message: ProgressMessage
}

export interface SDKTextDeltaMessage {
  type: 'text_delta'
  uuid: string
  sessionId: string
  delta: string
}

export type SDKMessage =
  | SDKInitMessage
  | SDKCompactBoundaryMessage
  | SDKResultMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKProgressMessage
  | SDKTextDeltaMessage

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export const EMPTY_USAGE: UsageStats = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
}

export function accumulateUsage(a: UsageStats, b: UsageStats): UsageStats {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
  }
}
