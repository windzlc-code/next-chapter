/**
 * Agent framework – unified exports.
 * Claude Code engine ported to TypeScript for next-chapter.
 */

// Core engine
export { QueryEngine } from './query-engine'
export type { QueryEngineConfig } from './query-engine'

export { ToolBase, ToolUseContext, findToolByName } from './tool'
export type { Tool, CanUseToolFn, ToolUseContextOptions } from './tool'

export { withRetry } from './retry'
export type { RetryOptions } from './retry'

export { callModelAPI, toAPIMessages } from './api-client'
export type { CallModelOptions } from './api-client'
export {
  buildAttachmentFallbackDigest,
  buildMessageInputFromAttachments,
  inferModelInputCapabilities,
  prepareChatAttachment,
  prepareChatAttachments,
  stripAttachmentPayloadForHistory,
} from './chat-attachments'
export type { ChatAttachment, ChatAttachmentKind, ModelInputCapabilities } from './chat-attachments'

export { queryLoop } from './query-loop'
export type { QueryParams } from './query-loop'

// Types
export type {
  SDKMessage, SDKInitMessage, SDKResultMessage,
  SDKAssistantMessage, SDKUserMessage, SDKProgressMessage,
  Message, UserMessage, AssistantMessage, SystemMessage, ProgressMessage,
  ToolResult, PermissionResult,
  ContentBlock, MessageInput, TextBlock, InputImageBlock, InputVideoBlock, InputFileBlock,
  ToolUseBlock, ToolResultBlock, ThinkingBlock,
  UsageStats,
} from './types'
export { EMPTY_USAGE, accumulateUsage } from './types'

// Built-in tools
export {
  FileReadTool, FileWriteTool, FileEditTool,
  GlobTool, GrepTool, BashTool,
  WebFetchTool, TodoWriteTool, AskUserQuestionTool,
  SleepTool, ConfigTool,
  AgentTool, TaskWriteTool, TaskStopTool, SendMessageTool,
  createDefaultTools,
  getCurrentTodos, resolveAskUserQuestion, rejectAskUserQuestion,
  getAllTasks,
} from './tools/index'
export type { Todo, TodoStatus, Task, TaskStatus, AskUserQuestionRequest } from './tools/index'

// Slash command system
export {
  registerCommand, findCommand, getAllCommands, parseSlashCommand,
} from './commands/registry'
export type { Command, CommandContext } from './commands/registry'
export { registerBuiltinCommands } from './commands/built-in'
export { loadSkillCommands } from './commands/skill-loader'

// MCP integration
export { mcpRegistry } from './mcp/registry'
export { connectMcpServer, disconnectMcpServer, callMcpTool, readMcpResource, initMcpFromSettings } from './mcp/client'
export { MCPTool, ListMcpResourcesTool, ReadMcpResourceTool } from './mcp/mcp-tool'
export type { McpServerConfig, McpTool, McpResource, McpServerState } from './mcp/types'
