/**
 * AgentChat – main chat panel for the Claude Code agent.
 *
 * QueryEngine runs directly in the renderer process so that tools
 * can call window.electronAPI.invoke('tool:execute', ...) naturally.
 * No IPC needed for the engine itself — only for file/process operations.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Paperclip, Send, Square, Trash2 } from 'lucide-react'
import { DraftAttachmentList } from '@/components/chat/attachment-ui'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { MessageBubble } from './MessageBubble'
import { PermissionDialog } from './PermissionDialog'
import { getAllCommands, parseSlashCommand, findCommand } from '@/lib/agent/commands/registry'
import { registerBuiltinCommands } from '@/lib/agent/commands/built-in'
import { QueryEngine } from '@/lib/agent/query-engine'
import { createDefaultTools } from '@/lib/agent/tools/index'
import { MCPTool, ListMcpResourcesTool, ReadMcpResourceTool } from '@/lib/agent/mcp/mcp-tool'
import {
  buildMessageInputFromAttachments,
  inferModelInputCapabilities,
  prepareChatAttachments,
} from '@/lib/agent/chat-attachments'
import type {
  AssistantMessage, MessageInput, UserMessage, ToolResultBlock, SDKResultMessage,
} from '@/lib/agent/types'
import type { Todo } from '@/lib/agent/tools/todo-write'

// Register built-in commands once at module load
registerBuiltinCommands()

type ChatMessage = AssistantMessage | UserMessage

export interface AgentChatProps {
  /** Anthropic API key */
  apiKey: string
  /** Optional base URL override */
  baseUrl?: string
  /** Model to use */
  model?: string
  /** System prompt */
  systemPrompt?: string
  /** Working directory passed to Bash/Glob tools */
  cwd?: string
  className?: string
}

export function AgentChat({
  apiKey,
  baseUrl,
  model = 'claude-sonnet-4-6',
  systemPrompt,
  cwd,
  className = '',
}: AgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [totalCost, setTotalCost] = useState(0)
  const [todos, setTodos] = useState<Todo[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [toolResults, setToolResults] = useState<Map<string, ToolResultBlock>>(new Map())
  const [pendingToolUseIds, setPendingToolUseIds] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachedFiles, setAttachedFiles] = useState<File[]>([])
  const [filesCollapsed, setFilesCollapsed] = useState(false)

  // ── QueryEngine instance (renderer process, recreated on config change) ──
  const engine = useMemo(() => {
    const tools = [
      ...createDefaultTools(),
      new MCPTool(),
      new ListMcpResourcesTool(),
      new ReadMcpResourceTool(),
    ]

    return new QueryEngine({
      apiKey,
      baseUrl,
      model,
      systemPrompt,
      tools,
      // Pass cwd to tools via options extension
      ...(cwd ? { appendSystemPrompt: `Working directory: ${cwd}` } : {}),
    })
  }, [apiKey, baseUrl, model, systemPrompt, cwd])

  // Update model on prop change without recreating engine
  useEffect(() => { engine.setModel(model) }, [model, engine])

  // Listen for todo updates from TodoWriteTool
  useEffect(() => {
    const handler = (e: Event) => setTodos((e as CustomEvent<Todo[]>).detail)
    window.addEventListener('agent:todos-updated', handler)
    return () => window.removeEventListener('agent:todos-updated', handler)
  }, [])

  const autoScroll = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  // ── Core send logic ──────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if ((!text.trim() && attachedFiles.length === 0) || isStreaming) return

    const currentFiles = [...attachedFiles]
    let effectiveText = text.trim() || `Please analyze these attachments: ${currentFiles.map(file => file.name).join(', ')}`
    let promptInput: MessageInput = effectiveText

    setInput('')
    setAttachedFiles([])
    setSuggestions([])

    // Slash command handling
    const parsed = parseSlashCommand(text.trim())
    if (parsed && currentFiles.length === 0) {
      const cmd = findCommand(parsed.name)
      if (cmd) {
        if (cmd.type === 'local' && cmd.handler) {
          cmd.handler(parsed.args, {
            clearMessages: () => {
              setMessages([])
              setToolResults(new Map())
              setTotalCost(0)
            },
            setModel: (m) => engine.setModel(m),
            getModel: () => model,
            getTotalCost: () => totalCost,
            getMessages: () => messages,
            sendMessage: (p) => sendMessage(p),
          })
          return
        }
        if (cmd.type === 'prompt' && cmd.promptTemplate) {
          text = cmd.promptTemplate.replace('{{args}}', parsed.args).trim()
          effectiveText = text
          promptInput = effectiveText
        }
      }
    }

    try {
      if (currentFiles.length > 0) {
        const preparedAttachments = await prepareChatAttachments(currentFiles)
        promptInput = await buildMessageInputFromAttachments({
          prompt: effectiveText,
          attachments: preparedAttachments,
          capabilities: inferModelInputCapabilities({ model }),
        })
      }
    } catch {
      promptInput = `${effectiveText}\n\nAttached files:\n${currentFiles.map(file => `- ${file.name} (${file.type || 'application/octet-stream'}, ${file.size} bytes)`).join('\n')}`
    }

    // Optimistic user message
    const userMsg: UserMessage = {
      type: 'user',
      uuid: crypto.randomUUID(),
      message: { role: 'user', content: promptInput },
    }
    setMessages(prev => [...prev, userMsg])
    setIsStreaming(true)
    autoScroll()

    try {
      // Run QueryEngine directly in renderer – tools call IPC as needed
      for await (const sdkMsg of engine.submitMessage(promptInput)) {
        const type = sdkMsg.type

        if (type === 'assistant') {
          const msg = (sdkMsg as { message: AssistantMessage }).message
          setMessages(prev => [...prev, msg])

          // Track pending tool_use blocks
          const content = msg.message?.content
          if (Array.isArray(content)) {
            const ids = content
              .filter(b => b.type === 'tool_use')
              .map(b => (b as { id: string }).id)
            if (ids.length) setPendingToolUseIds(prev => new Set([...prev, ...ids]))
          }
          autoScroll()

        } else if (type === 'user') {
          const msg = (sdkMsg as { message: UserMessage }).message
          setMessages(prev => [...prev, msg])

          // Collect tool results
          const content = msg.message?.content
          if (Array.isArray(content)) {
            content.filter(b => b.type === 'tool_result').forEach(b => {
              const block = b as ToolResultBlock
              setToolResults(prev => new Map([...prev, [block.tool_use_id, block]]))
              setPendingToolUseIds(prev => {
                const next = new Set(prev)
                next.delete(block.tool_use_id)
                return next
              })
            })
          }
          autoScroll()

        } else if (type === 'result') {
          const result = sdkMsg as SDKResultMessage
          setTotalCost(result.totalCostUsd ?? 0)
          setIsStreaming(false)
        }
      }
    } catch (err) {
      console.error('[AgentChat] engine error:', err)
      setIsStreaming(false)
    }
  }, [attachedFiles, autoScroll, engine, isStreaming, messages, model, totalCost])

  const interrupt = useCallback(() => {
    engine.interrupt()
    setIsStreaming(false)
  }, [engine])

  // Slash suggestions
  const handleInputChange = (value: string) => {
    setInput(value)
    if (value.startsWith('/') && !value.includes(' ')) {
      const q = value.slice(1).toLowerCase()
      setSuggestions(
        getAllCommands()
          .filter(c => c.name.startsWith(q))
          .map(c => `/${c.name} — ${c.description}`)
          .slice(0, 8),
      )
    } else {
      setSuggestions([])
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
    if (e.key === 'Escape') setSuggestions([])
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-full bg-background ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">Agent</span>
          <Badge variant="outline" className="text-xs">{model}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {totalCost > 0 && (
            <span className="text-xs text-muted-foreground">${totalCost.toFixed(4)}</span>
          )}
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => { setMessages([]); setToolResults(new Map()); setTotalCost(0) }}
            title="Clear conversation"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4">
        <div className="py-4 space-y-4" ref={scrollRef as React.RefObject<HTMLDivElement>}>
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-12">
              <p>Agent ready. Type a message or use{' '}
                <kbd className="px-1 py-0.5 bg-muted rounded text-xs">/help</kbd>{' '}
                for commands.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <MessageBubble
              key={(msg as { uuid?: string }).uuid ?? i}
              message={msg}
              pendingToolUseIds={msg.type === 'assistant' ? pendingToolUseIds : undefined}
              toolResults={msg.type === 'assistant' ? toolResults : undefined}
            />
          ))}
          {isStreaming && pendingToolUseIds.size === 0 && (
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0">
                <div className="w-2 h-2 bg-primary-foreground rounded-full animate-pulse" />
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Todo tracker */}
      {todos.length > 0 && (
        <div className="mx-4 mb-2 border rounded-lg p-2 bg-muted/40 text-xs shrink-0">
          <p className="font-medium mb-1.5 text-muted-foreground">Tasks</p>
          <ul className="space-y-1">
            {todos.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  t.status === 'completed' ? 'bg-green-500'
                    : t.status === 'in_progress' ? 'bg-blue-500 animate-pulse'
                    : 'bg-muted-foreground/40'
                }`} />
                <span className={t.status === 'completed' ? 'line-through text-muted-foreground' : ''}>
                  {t.status === 'in_progress' ? t.activeForm : t.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Slash suggestions */}
      {suggestions.length > 0 && (
        <div className="mx-4 mb-1 border rounded-lg overflow-hidden bg-popover shadow-md shrink-0">
          {suggestions.map((s, i) => (
            <button
              key={i}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors font-mono"
              onClick={() => {
                setInput(s.split(' — ')[0] + ' ')
                setSuggestions([])
                textareaRef.current?.focus()
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="px-4 pb-4 shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="*/*"
          className="hidden"
          onChange={event => {
            const nextFiles = Array.from(event.target.files ?? [])
            if (nextFiles.length > 0) {
              setAttachedFiles(prev => [...prev, ...nextFiles])
            }
            if (fileInputRef.current) {
              fileInputRef.current.value = ''
            }
          }}
        />
        <DraftAttachmentList
          files={attachedFiles}
          activeTheme={false}
          collapsed={filesCollapsed}
          onToggleCollapsed={() => setFilesCollapsed(value => !value)}
          onRemove={index => setAttachedFiles(prev => prev.filter((_, fileIndex) => fileIndex !== index))}
        />
        <div className="flex gap-2 items-end">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            title={attachedFiles.length > 0 ? `Attached ${attachedFiles.length} files` : 'Attach files'}
          >
            <Paperclip className="w-4 h-4" />
          </Button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent… (Enter to send, Shift+Enter newline, / for commands)"
            className="resize-none min-h-[44px] max-h-[200px] text-sm"
            rows={1}
          />
          {isStreaming ? (
            <Button size="icon" variant="destructive" onClick={interrupt} title="Stop">
              <Square className="w-4 h-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => sendMessage(input)} disabled={!input.trim() && attachedFiles.length === 0}>
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      <PermissionDialog />
    </div>
  )
}
