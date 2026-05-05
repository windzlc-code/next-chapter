import type { Task as RuntimeTask } from "@/lib/agent/tools/task-tools";

export type BackgroundResearchGroup = {
  id: string;
  kind: "video-bridge-platform";
  projectId?: string;
  taskIds: string[];
  status: "pending" | "forwarding" | "cancelled";
  onFinish?: (result: "completed" | "cancelled") => void;
};

export function truncateCopy(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function parseTaskHeading(prompt: string): string | null {
  const matched =
    prompt.match(/^并行研究\s+([^:：]+)[:：]/) ??
    prompt.match(/^并行研究[:：]\s*(.+)$/);
  return matched?.[1]?.trim() ?? null;
}

export function isBackgroundResearchTask(task: Pick<RuntimeTask, "prompt">): boolean {
  return Boolean(parseTaskHeading(task.prompt));
}

export function parseTaskPreview(prompt: string): string {
  const heading = parseTaskHeading(prompt);
  if (!heading) return truncateCopy(prompt, 84);
  const stripped = prompt
    .replace(/^并行研究\s+[^:：]+[:：]\s*/, "")
    .replace(/^并行研究[:：]\s*.+$/, "")
    .trim();
  return truncateCopy(stripped, 96);
}

export function taskStatusLabel(status: RuntimeTask["status"]): string {
  switch (status) {
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已停止";
    default:
      return "待处理";
  }
}

export function taskStatusClass(status: RuntimeTask["status"]): string {
  switch (status) {
    case "running":
      return "border-primary/24 bg-primary/10 text-primary";
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400";
    case "cancelled":
      return "border-border bg-muted/50 text-muted-foreground";
    default:
      return "border-border bg-muted/50 text-foreground/70";
  }
}

export function isTerminalTask(task: RuntimeTask): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

export function formatTaskDockTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildTaskResultMessage(task: RuntimeTask): string {
  const heading = parseTaskHeading(task.prompt);
  const summary = heading ? `并行研究 ${heading}` : truncateCopy(task.prompt, 84);
  const output = truncateCopy((task.output ?? "").trim(), 240);

  if (task.status === "completed") {
    return output
      ? `后台研究已完成：${summary}\n\n${output}`
      : `后台研究已完成：${summary}`;
  }

  if (task.status === "failed") {
    return output
      ? `后台任务执行失败：${summary}\n\n${output}`
      : `后台任务执行失败：${summary}`;
  }

  return "";
}

export function isTaskVisibleForSession(task: RuntimeTask, sessionId: string): boolean {
  return task.sessionId === sessionId;
}

export function areTaskListsEquivalent(nextTasks: RuntimeTask[], prevTasks: RuntimeTask[]): boolean {
  if (nextTasks === prevTasks) return true;
  if (nextTasks.length !== prevTasks.length) return false;

  return nextTasks.every((task, index) => {
    const previous = prevTasks[index];
    return (
      previous &&
      task.id === previous.id &&
      task.status === previous.status &&
      task.sessionId === previous.sessionId &&
      task.projectId === previous.projectId &&
      task.prompt === previous.prompt &&
      task.output === previous.output &&
      task.updatedAt === previous.updatedAt
    );
  });
}
