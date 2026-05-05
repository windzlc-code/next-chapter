/**
 * AskUserQuestionTool – prompt the user for a decision.
 * Port of: hare/tools_impl/AskUserQuestionTool/
 *
 * Blocks until the user responds via the active UI consumer.
 * Homepage mode resolves through the embedded composer popover; legacy chat can
 * still resolve through a compatibility dialog.
 */

import { ToolBase, type ToolUseContext, type CanUseToolFn } from '../tool'
import type { AssistantMessage, ToolResult } from '../types'

export interface AskUserQuestionRequest {
  id: string
  title?: string
  description?: string
  allowCustomInput?: boolean
  submissionMode?: 'immediate' | 'confirm'
  questions: Array<{
    question: string
    header: string
    multiSelect: boolean
    presentation?: 'auto' | 'chip' | 'card'
    options: Array<{
      label: string
      value?: string
      description?: string
      rationale?: string
      confirmDialog?: {
        title: string
        description: string
        confirmLabel?: string
        cancelLabel?: string
        summaryRows?: string[]
      }
    }>
  }>
}

export interface AskUserQuestionResponse {
  id: string
  answers: Record<string, string>
}

// Pending request map: id → { resolve, reject }
const pendingRequests = new Map<string, {
  resolve: (answer: string) => void
  reject: (err: Error) => void
}>()

/** Called by the active UI consumer when the user submits an answer */
export function resolveAskUserQuestion(id: string, answer: string): boolean {
  const pending = pendingRequests.get(id)
  if (!pending) {
    return false
  }
  pending.resolve(answer)
  pendingRequests.delete(id)
  return true
}

export function rejectAskUserQuestion(id: string, reason = '已取消'): boolean {
  const pending = pendingRequests.get(id)
  if (!pending) {
    return false
  }
  pending.reject(new Error(reason))
  pendingRequests.delete(id)
  return true
}

export class AskUserQuestionTool extends ToolBase {
  readonly name = 'AskUserQuestion'
  readonly searchHint = 'Ask the user a question and wait for their response'

  inputSchema() {
    return {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Single question title shown above the composer',
        },
        description: {
          type: 'string',
          description: 'Optional short explanation',
        },
        allowCustomInput: {
          type: 'boolean',
          description: 'Whether the user can ignore options and type a custom answer',
        },
        submissionMode: {
          type: 'string',
          description: 'Use immediate for option click to submit instantly, or confirm to require manual send',
        },
        questions: {
          type: 'array',
          description: 'Questions to ask (1-4)',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: 'Short label (max 12 chars)' },
              multiSelect: { type: 'boolean' },
              presentation: {
                type: 'string',
                description: 'Optional UI hint: auto, chip, or card',
              },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    value: { type: 'string' },
                    description: { type: 'string' },
                    rationale: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    }
  }

  async call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
  ): Promise<ToolResult> {
    const id = crypto.randomUUID()
    const request: AskUserQuestionRequest = {
      id,
      title: typeof args.title === 'string' ? args.title : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
      allowCustomInput:
        typeof args.allowCustomInput === 'boolean' ? args.allowCustomInput : true,
      submissionMode:
        args.submissionMode === 'confirm' ? 'confirm' : 'immediate',
      questions: args.questions as AskUserQuestionRequest['questions'],
    }

    // Emit event so the active UI can collect the answer inline.
    window.dispatchEvent(new CustomEvent('agent:ask-user-question', { detail: request }))

    const answer = await new Promise<string>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })

      // 当引擎被中断时（interrupt() → abortController.abort()），同步取消等待
      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          pendingRequests.delete(id)
          reject(new Error('Aborted'))
          return
        }
        context.abortSignal.addEventListener(
          'abort',
          () => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id)
              reject(new Error('Aborted'))
            }
          },
          { once: true },
        )
      }

      // Timeout after 10 minutes
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id)
          reject(new Error('Timeout waiting for user response'))
        }
      }, 10 * 60 * 1000)
    })

    return { data: answer }
  }
}
