/**
 * AgentTool – spawn a sub-agent (nested QueryEngine).
 * Port of: hare/tools_impl/AgentTool/
 */

import { ToolBase, type ToolUseContext, type CanUseToolFn } from '../tool'
import type { AssistantMessage, ToolResult } from '../types'
import { QueryEngine } from '../query-engine'
import {
  clearTaskStopHandler,
  getTask,
  registerTaskStopHandler,
  updateTask,
  writeTask,
} from './task-tools'

// Background task registry
const backgroundTasks = new Map<string, { promise: Promise<string>; interrupt: () => void }>()

export function getBackgroundTaskResult(id: string): Promise<string> | undefined {
  return backgroundTasks.get(id)?.promise
}

export class AgentTool extends ToolBase {
  readonly name = 'Agent'
  readonly searchHint = 'Launch a new agent to handle complex multi-step tasks'

  inputSchema() {
    return {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task for the sub-agent' },
        description: { type: 'string', description: '3-5 word summary of what the agent will do' },
        subagent_type: {
          type: 'string',
          description: 'Type of agent (general-purpose, Explore, Plan, etc.)',
        },
        model: { type: 'string', description: 'Optional model override' },
        session_id: { type: 'string', description: 'Optional homepage conversation session id' },
        project_id: { type: 'string', description: 'Optional current project id' },
        run_in_background: {
          type: 'boolean',
          description: 'Run in background; returns task ID immediately',
        },
      },
      required: ['prompt', 'description'],
    }
  }

  async call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
  ): Promise<ToolResult> {
    const prompt = args.prompt as string
    const model = (args.model as string) ?? context.options.model
    const runInBackground = (args.run_in_background as boolean) ?? false
    const description = (args.description as string) ?? 'sub-task'
    const subagentType = (args.subagent_type as string) ?? 'general-purpose'
    const appState = context.getAppState?.() as
      | { sessionId?: string; currentProjectSnapshot?: { projectId?: string | null } | null }
      | undefined
    const sessionId =
      typeof args.session_id === 'string' ? args.session_id : appState?.sessionId
    const projectId =
      typeof args.project_id === 'string'
        ? args.project_id
        : appState?.currentProjectSnapshot?.projectId ?? undefined

    const apiKey = context.options.apiKey
    const baseUrl = context.options.baseUrl
    if (!apiKey) {
      throw new Error('Agent tool requires an API key in the current tool context.')
    }

    const subEngine = new QueryEngine({
      apiKey,
      baseUrl,
      provider: context.options.provider,
      model,
      tools: context.options.tools,
      systemPrompt: [
        'You are a focused sub-agent.',
        `Task type: ${subagentType}.`,
        `Mission summary: ${description}.`,
        'Complete the assigned task and return a concise, useful result for the parent agent.',
      ].join(' '),
    })

    const runTask = async (): Promise<string> => {
      let result = ''
      for await (const msg of subEngine.submitMessage(prompt)) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          result = msg.result ?? ''
        }
      }
      return result
    }

    if (runInBackground) {
      const taskId = crypto.randomUUID()
      writeTask({
        id: taskId,
        prompt: `${description}: ${prompt}`,
        status: 'running',
        sessionId,
        projectId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      registerTaskStopHandler(taskId, () => {
        subEngine.interrupt()
        updateTask(taskId, { status: 'cancelled', output: '任务已取消。' })
      })

      const promise = runTask()
        .then(result => {
          const current = getTask(taskId)
          if (current?.status !== 'cancelled') {
            updateTask(taskId, { status: 'completed', output: result })
          }
          clearTaskStopHandler(taskId)
          return result
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          const current = getTask(taskId)
          if (current?.status !== 'cancelled') {
            updateTask(taskId, { status: 'failed', output: message })
          }
          clearTaskStopHandler(taskId)
          throw error
        })

      backgroundTasks.set(taskId, { promise, interrupt: () => subEngine.interrupt() })
      return { data: `Background task started. Task ID: ${taskId}` }
    }

    const result = await runTask()
    return { data: result }
  }
}
