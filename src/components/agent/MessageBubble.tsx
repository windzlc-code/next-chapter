/**
 * MessageBubble – renders a single agent conversation message.
 */

import { Bot, User } from 'lucide-react'
import { MessageAttachmentList } from '@/components/chat/attachment-ui'
import { ToolCallBlock } from './ToolCallBlock'
import type { AssistantMessage, ContentBlock, UserMessage, ToolUseBlock, ToolResultBlock } from '@/lib/agent/types'
import type { ChatAttachment } from '@/lib/agent/chat-attachments'

type Props = {
  message: AssistantMessage | UserMessage
  /** Pending tool calls (no result yet) for this assistant message */
  pendingToolUseIds?: Set<string>
  /** Map from tool_use_id → tool_result for this assistant message */
  toolResults?: Map<string, ToolResultBlock>
}

export function MessageBubble({ message, pendingToolUseIds, toolResults }: Props) {
  const isAssistant = message.type === 'assistant'
  const content = message.message.content

  if (typeof content === 'string') {
    return (
      <BubbleWrapper isAssistant={isAssistant}>
        <p className="whitespace-pre-wrap">{content}</p>
      </BubbleWrapper>
    )
  }

  // Filter out tool_result blocks from assistant messages (they are user messages)
  const displayBlocks = Array.isArray(content)
    ? content.filter(b => b.type !== 'tool_result' || !isAssistant)
    : []
  const attachmentBlocks = displayBlocks
    .map((block, index) => toAttachment(block, `${message.uuid}-${index}`))
    .filter((attachment): attachment is ChatAttachment => Boolean(attachment))

  const hasVisibleContent = displayBlocks.some(
    b => b.type === 'text' || b.type === 'tool_use',
  )
  if (!hasVisibleContent && attachmentBlocks.length === 0) return null

  return (
    <BubbleWrapper isAssistant={isAssistant}>
      {displayBlocks.map((block, i) => {
        if (block.type === 'text') {
          return block.text ? (
            <p key={i} className="whitespace-pre-wrap">{block.text}</p>
          ) : null
        }

        if (block.type === 'tool_use') {
          const toolUse = block as ToolUseBlock
          const toolResult = toolResults?.get(toolUse.id)
          const isPending = !toolResult && pendingToolUseIds?.has(toolUse.id)
          return (
            <ToolCallBlock
              key={i}
              toolUse={toolUse}
              toolResult={isPending ? undefined : toolResult}
            />
          )
        }

        return null
      })}
      {attachmentBlocks.length > 0 ? (
        <MessageAttachmentList
          attachments={attachmentBlocks}
          activeTheme
        />
      ) : null}
    </BubbleWrapper>
  )
}

function toAttachment(
  block: ContentBlock,
  id: string,
): ChatAttachment | null {
  if (block.type === 'input_image') {
    return {
      id,
      fileName: block.fileName || 'image',
      mimeType: block.mimeType,
      size: 0,
      kind: 'image',
      localPath: block.localPath,
      previewUrl: block.previewUrl || (block.base64 ? `data:${block.mimeType};base64,${block.base64}` : undefined),
    }
  }

  if (block.type === 'input_video') {
    return {
      id,
      fileName: block.fileName || 'video',
      mimeType: block.mimeType,
      size: 0,
      kind: 'video',
      localPath: block.localPath,
      previewUrl: block.previewUrl,
      fallbackDigest: block.fallbackText,
    }
  }

  if (block.type === 'input_file') {
    return {
      id,
      fileName: block.fileName,
      mimeType: block.mimeType,
      size: typeof block.size === 'number' ? block.size : 0,
      kind: block.extractedText
        ? (block.mimeType.startsWith('text/') ? 'text' : 'document')
        : 'binary',
      localPath: block.localPath,
      extractedText: block.extractedText,
      fallbackDigest: block.fallbackDigest,
    }
  }

  return null
}

function BubbleWrapper({ isAssistant, children }: {
  isAssistant: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`flex gap-3 ${isAssistant ? '' : 'flex-row-reverse'}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
        isAssistant
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground'
      }`}>
        {isAssistant
          ? <Bot className="w-4 h-4" />
          : <User className="w-4 h-4" />
        }
      </div>
      <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
        isAssistant
          ? 'bg-muted'
          : 'bg-primary text-primary-foreground'
      }`}>
        {children}
      </div>
    </div>
  )
}
