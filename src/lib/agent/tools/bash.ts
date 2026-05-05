/**
 * BashTool – execute shell commands.
 * Port of: hare/tools_impl/BashTool/
 */

import { ToolBase, type ToolUseContext, type CanUseToolFn } from '../tool'
import type { AssistantMessage, ToolResult } from '../types'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

export class BashTool extends ToolBase {
  readonly name = 'Bash'
  readonly searchHint = 'Execute shell commands in a persistent bash session'

  inputSchema() {
    return {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        description: { type: 'string', description: 'Short description of what the command does' },
        timeout: { type: 'number', description: `Timeout in ms (max ${MAX_TIMEOUT_MS})` },
        run_in_background: { type: 'boolean', description: 'Run the command in the background' },
      },
      required: ['command'],
    }
  }

  async call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
  ): Promise<ToolResult> {
    const timeout = Math.min(
      (args.timeout as number) ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    const result = await window.electronAPI?.invoke('tool:execute', {
      toolName: 'Bash',
      args: {
        command: args.command,
        timeout,
        runInBackground: args.run_in_background ?? false,
        cwd: (context.options as unknown as Record<string, unknown>).cwd as string | undefined,
      },
    })

    if (result?.error) throw new Error(result.error)
    return { data: result?.output ?? '' }
  }
}
