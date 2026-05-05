/**
 * TaskTools – persistent task management (create/update/list/cancel).
 * Port of: hare/tools_impl/TaskTools/
 *
 * More advanced than TodoWrite: tasks persist across sub-agents,
 * support output files and status tracking.
 */

import { ToolBase, type ToolUseContext, type CanUseToolFn } from '../tool'
import type { AssistantMessage, ToolResult } from '../types'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  sessionId?: string
  projectId?: string
  output?: string
  createdAt: number
  updatedAt: number
}

const TASK_STORAGE_KEY = 'storyforge-home-agent-tasks-v1'
const tasks = new Map<string, Task>()
const stopHandlers = new Map<string, () => void>()
let hydrated = false

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function normalizeTask(task: Partial<Task>): Task | null {
  if (!task || typeof task.id !== 'string' || !task.id.trim()) return null
  if (typeof task.prompt !== 'string') return null

  const status = task.status
  const normalizedStatus: TaskStatus =
    status === 'pending' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled'
      ? status
      : 'pending'

  return {
    id: task.id,
    prompt: task.prompt,
    status: normalizedStatus,
    sessionId: typeof task.sessionId === 'string' ? task.sessionId : undefined,
    projectId: typeof task.projectId === 'string' ? task.projectId : undefined,
    output: typeof task.output === 'string' ? task.output : undefined,
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : Date.now(),
  }
}

function persistTasks() {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify([...tasks.values()]))
  } catch {
    // Ignore persistence failures and keep runtime tasks alive in memory.
  }
}

function hydrateTasks(force = false) {
  if (hydrated && !force) return
  hydrated = true
  if (!canUseStorage()) return

  try {
    const raw = window.localStorage.getItem(TASK_STORAGE_KEY)
    if (force) {
      tasks.clear()
    }
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return

    for (const entry of parsed) {
      const task = normalizeTask(entry)
      if (task) {
        tasks.set(task.id, task)
      }
    }
  } catch {
    // Ignore malformed persisted tasks.
  }
}

function notifyTaskUpdate() {
  persistTasks()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agent:tasks-updated', { detail: [...tasks.values()] }))
  }
}

export function getAllTasks(): Task[] {
  hydrateTasks(tasks.size === 0)
  return [...tasks.values()]
}

export function getTask(taskId: string): Task | undefined {
  hydrateTasks(tasks.size === 0)
  return tasks.get(taskId)
}

export function writeTask(task: Task): Task {
  hydrateTasks(tasks.size === 0)
  tasks.set(task.id, task)
  notifyTaskUpdate()
  return task
}

export function updateTask(
  taskId: string,
  patch: Partial<Pick<Task, 'status' | 'output' | 'prompt' | 'sessionId' | 'projectId'>>,
): Task | undefined {
  hydrateTasks(tasks.size === 0)
  const current = tasks.get(taskId)
  if (!current) return undefined

  const next: Task = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  }
  tasks.set(taskId, next)
  notifyTaskUpdate()
  return next
}

export function registerTaskStopHandler(taskId: string, stop: () => void): void {
  hydrateTasks(tasks.size === 0)
  stopHandlers.set(taskId, stop)
}

export function clearTaskStopHandler(taskId: string): void {
  stopHandlers.delete(taskId)
}

export function clearTaskRegistry(): void {
  hydrateTasks(tasks.size === 0)
  tasks.clear()
  stopHandlers.clear()
  if (canUseStorage()) {
    window.localStorage.removeItem(TASK_STORAGE_KEY)
  }
  notifyTaskUpdate()
}

export function stopTask(taskId: string): boolean {
  hydrateTasks(tasks.size === 0)
  const task = tasks.get(taskId)
  if (!task) return false

  const stop = stopHandlers.get(taskId)
  stop?.()
  stopHandlers.delete(taskId)
  updateTask(taskId, { status: 'cancelled', output: task.output ?? '任务已取消。' })
  return true
}

export class TaskWriteTool extends ToolBase {
  readonly name = 'TaskOutput'
  readonly searchHint = 'Read output from a background task'

  inputSchema() {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to retrieve output for' },
        block: { type: 'boolean', description: 'Wait for task completion (default true)' },
        timeout: { type: 'number', description: 'Max wait time in ms (default 30000)' },
      },
      required: ['task_id'],
    }
  }

  async call(
    args: Record<string, unknown>,
    _context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
  ): Promise<ToolResult> {
    const taskId = args.task_id as string
    const task = tasks.get(taskId)
    if (!task) return { data: `Task ${taskId} not found` }
    return { data: JSON.stringify(task, null, 2) }
  }
}

export class TaskStopTool extends ToolBase {
  readonly name = 'TaskStop'
  readonly searchHint = 'Stop a running background task'

  inputSchema() {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to stop' },
      },
      required: ['task_id'],
    }
  }

  async call(
    args: Record<string, unknown>,
    _context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
  ): Promise<ToolResult> {
    const taskId = args.task_id as string
    if (!stopTask(taskId)) return { data: `Task ${taskId} not found` }
    return { data: `Task ${taskId} cancelled` }
  }
}
