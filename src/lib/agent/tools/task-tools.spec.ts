import { beforeEach, describe, expect, it, vi } from "vitest";

const TASK_STORAGE_KEY = "storyforge-home-agent-tasks-v1";

describe("task-tools persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("persists tasks to localStorage and restores them on a fresh module load", async () => {
    const first = await import("./task-tools");

    first.writeTask({
      id: "task-persist-1",
      prompt: "并行研究: 恢复首页任务",
      status: "running",
      sessionId: "session-home-1",
      projectId: "project-home-1",
      createdAt: 1,
      updatedAt: 1,
    });

    const stored = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe("task-persist-1");

    vi.resetModules();
    const second = await import("./task-tools");
    const restored = second.getTask("task-persist-1");

    expect(restored?.prompt).toContain("恢复首页任务");
    expect(restored?.sessionId).toBe("session-home-1");
    expect(second.getAllTasks()).toHaveLength(1);
  });

  it("updates persisted task records when task status changes", async () => {
    const mod = await import("./task-tools");

    mod.writeTask({
      id: "task-persist-2",
      prompt: "并行研究: 任务状态变化",
      status: "running",
      createdAt: 2,
      updatedAt: 2,
    });

    mod.updateTask("task-persist-2", {
      status: "completed",
      output: "已完成结论",
    });

    const stored = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || "[]");
    expect(stored[0]?.status).toBe("completed");
    expect(stored[0]?.output).toBe("已完成结论");
  });

  it("clears persisted tasks when the registry is cleared", async () => {
    const mod = await import("./task-tools");

    mod.writeTask({
      id: "task-persist-3",
      prompt: "并行研究: 清空任务",
      status: "pending",
      createdAt: 3,
      updatedAt: 3,
    });
    mod.clearTaskRegistry();

    expect(mod.getAllTasks()).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || "[]")).toHaveLength(0);
  });

  it("uses a localized default message when a task is cancelled", async () => {
    const mod = await import("./task-tools");

    mod.writeTask({
      id: "task-cancel-1",
      prompt: "并行研究: 取消默认文案",
      status: "running",
      createdAt: 4,
      updatedAt: 4,
    });

    expect(mod.stopTask("task-cancel-1")).toBe(true);
    expect(mod.getTask("task-cancel-1")?.output).toBe("任务已取消。");
  });
});
