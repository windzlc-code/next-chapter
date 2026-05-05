import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseChatHistoryPreview, exportChatHistory } from "./chat-history-io";
import type { StudioSessionState } from "./types";

type TestWindow = Window & { electronAPI?: unknown };

function makeSession(overrides: Partial<StudioSessionState> = {}): StudioSessionState {
  return {
    projectId: "test-project-id",
    messages: [{ id: "m1", role: "user", content: "hello" } as never],
    mode: "idle",
    currentProjectSnapshot: {
      projectId: "test-project-id",
      title: "测试项目",
      artifacts: [{ id: "a1", kind: "setup", label: "设定", content: "内容" } as never],
    } as never,
    ...overrides,
  } as StudioSessionState;
}

function makeStorageMock(content: string, ok = true) {
  return {
    importChatHistory: vi.fn().mockResolvedValue({ ok, content, importedMediaDir: undefined }),
    exportChatHistory: vi.fn().mockResolvedValue({ ok: true, destDir: "/dest", chatHistoryFilePath: "/dest/chat-history.json" }),
    selectFolder: vi.fn().mockResolvedValue("/dest"),
    selectFile: vi.fn().mockResolvedValue("/path/to/chat-history.json"),
    readText: vi.fn(),
    writeText: vi.fn(),
    openPath: vi.fn(),
    listDir: vi.fn(),
    deleteFile: vi.fn(),
    deleteDir: vi.fn(),
  };
}

describe("parseChatHistoryPreview", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", { value: undefined, writable: true, configurable: true });
  });

  it("returns null when electronAPI is unavailable", async () => {
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result).toBeNull();
  });

  it("returns null when storage.importChatHistory fails", async () => {
    const storage = makeStorageMock("", false);
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const storage = makeStorageMock("not-json");
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result).toBeNull();
  });

  it("returns null when messages is not an array", async () => {
    const storage = makeStorageMock(JSON.stringify({ messages: "not-array" }));
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result).toBeNull();
  });

  it("parses a valid v2 full export", async () => {
    const session = makeSession();
    const content = JSON.stringify({
      exportVersion: 2,
      isFullVersion: true,
      ...session,
    });
    const storage = makeStorageMock(content);
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("测试项目");
    expect(result!.messageCount).toBe(1);
    expect(result!.artifactCount).toBe(1);
    expect(result!.exportVersion).toBe(2);
    expect(result!.isFullVersion).toBe(true);
    expect(result!.projectId).toBe("test-project-id");
  });

  it("defaults exportVersion to 1 and isFullVersion to false for old exports", async () => {
    const session = makeSession();
    const storage = makeStorageMock(JSON.stringify(session));
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result!.exportVersion).toBe(1);
    expect(result!.isFullVersion).toBe(false);
  });

  it("returns title as '未命名项目' when snapshot has no title", async () => {
    const session = makeSession({ currentProjectSnapshot: undefined });
    const storage = makeStorageMock(JSON.stringify(session));
    (window as TestWindow).electronAPI = { storage };
    const result = await parseChatHistoryPreview("/some/path.json");
    expect(result!.title).toBe("未命名项目");
  });
});

describe("exportChatHistory — exportVersion injection", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", { value: undefined, writable: true, configurable: true });
  });

  it("injects exportVersion and isFullVersion when options provided", async () => {
    const storage = makeStorageMock("");
    (window as TestWindow).electronAPI = { storage };
    const session = makeSession();
    await exportChatHistory(session, "测试项目", { exportVersion: 2, isFullVersion: true });
    const call = storage.exportChatHistory.mock.calls[0][0];
    const parsed = JSON.parse(call.sessionJson);
    expect(parsed.exportVersion).toBe(2);
    expect(parsed.isFullVersion).toBe(true);
  });

  it("defaults exportVersion to 2 and isFullVersion to true when options not provided", async () => {
    const storage = makeStorageMock("");
    (window as TestWindow).electronAPI = { storage };
    const session = makeSession();
    await exportChatHistory(session, "测试项目");
    const call = storage.exportChatHistory.mock.calls[0][0];
    const parsed = JSON.parse(call.sessionJson);
    expect(parsed.exportVersion).toBe(2);
    expect(parsed.isFullVersion).toBe(true);
  });
});
