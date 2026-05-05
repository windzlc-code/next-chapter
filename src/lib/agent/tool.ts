/**
 * Tool protocol, ToolBase, and ToolUseContext.
 * Port of: hare/tool.py
 */

import type {
  AssistantMessage,
  Message,
  PermissionResult,
  ToolResult,
} from './types'

// ---------------------------------------------------------------------------
// ToolUseContext
// ---------------------------------------------------------------------------

export interface ToolUseContextOptions {
  model: string
  provider?: string
  tools: Tool[]
  apiKey?: string
  baseUrl?: string
  verbose?: boolean
  thinkingConfig?: Record<string, unknown>
  isNonInteractiveSession?: boolean
  maxBudgetUsd?: number
  customSystemPrompt?: string
  appendSystemPrompt?: string
}

export class ToolUseContext {
  options: ToolUseContextOptions
  abortSignal?: AbortSignal
  readFileState: Map<string, unknown>
  messages: Message[]
  getAppState?: () => unknown
  setAppState?: (updater: (prev: unknown) => unknown) => void

  constructor(opts: {
    options: ToolUseContextOptions
    abortSignal?: AbortSignal
    readFileState?: Map<string, unknown>
    messages?: Message[]
    getAppState?: () => unknown
    setAppState?: (updater: (prev: unknown) => unknown) => void
  }) {
    this.options = opts.options
    this.abortSignal = opts.abortSignal
    this.readFileState = opts.readFileState ?? new Map()
    this.messages = opts.messages ?? []
    this.getAppState = opts.getAppState
    this.setAppState = opts.setAppState
  }
}

// ---------------------------------------------------------------------------
// CanUseToolFn – permission check callback
// ---------------------------------------------------------------------------

export type CanUseToolFn = (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseId: string,
  forceDecision?: string,
) => Promise<PermissionResult>

// ---------------------------------------------------------------------------
// Tool interface
// ---------------------------------------------------------------------------

export interface Tool {
  readonly name: string
  readonly aliases?: string[]
  readonly maxResultSizeChars?: number
  readonly searchHint?: string

  call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: (data: unknown) => void,
  ): Promise<ToolResult>

  inputSchema(): Record<string, unknown>

  isEnabled(): boolean
  isReadOnly(input: Record<string, unknown>): boolean
  isConcurrencySafe(input: Record<string, unknown>): boolean

  checkPermissions(
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  userFacingName(input?: Record<string, unknown>): string

  mapToolResultToBlock(content: unknown, toolUseId: string): Record<string, unknown>
}

// ---------------------------------------------------------------------------
// ToolBase – abstract base class with safe defaults
// ---------------------------------------------------------------------------

export abstract class ToolBase implements Tool {
  abstract readonly name: string
  readonly aliases: string[] = []
  readonly maxResultSizeChars: number = 100_000
  readonly searchHint: string = ''

  abstract call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: (data: unknown) => void,
  ): Promise<ToolResult>

  abstract inputSchema(): Record<string, unknown>

  isEnabled(): boolean {
    return true
  }

  isReadOnly(_input: Record<string, unknown>): boolean {
    return false
  }

  isConcurrencySafe(_input: Record<string, unknown>): boolean {
    return false
  }

  async checkPermissions(
    _input: Record<string, unknown>,
    _context: ToolUseContext,
  ): Promise<PermissionResult> {
    return { behavior: 'allow' }
  }

  userFacingName(_input?: Record<string, unknown>): string {
    return this.name
  }

  mapToolResultToBlock(content: unknown, toolUseId: string): Record<string, unknown> {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: content != null ? String(content) : '',
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findToolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name || (t.aliases ?? []).includes(name))
}
