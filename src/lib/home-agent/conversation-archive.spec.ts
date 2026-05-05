import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteConversationArchive,
  invalidateConversationArchiveScanCache,
  scanConversationArchives,
  writeConversationArchiveFull,
} from "./conversation-archive";
import type { StudioSessionState } from "./types";

function createSession(messageCount = 3): StudioSessionState {
  return {
    sessionId: "session-1",
    compactedMessageCount: 0,
    mode: "active",
    creationMode: "fast",
    devMode: false,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index} ${"content ".repeat(30)}`,
      createdAt: `2026-04-03T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    })),
    currentProjectSnapshot: {
      projectId: "project-1",
      projectKind: "script",
      title: "Contract Marriage",
      currentObjective: "Keep writing",
      derivedStage: "Drafting",
      agentSummary: "A long project is being preserved.",
      recommendedActions: ["Continue"],
      artifacts: [],
      updatedAt: "2026-04-03T01:00:00.000Z",
    },
    recentMessageSummary: "summary",
    projectId: "project-1",
  };
}

function installStorageMock(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const deletedDirs: string[] = [];
  const getDefaultPath = vi.fn(async () => ({
    files: "C:/Storyforge/files",
    db: "C:/Storyforge/db",
  }));
  const writeText = vi.fn(async (filePath: string, content: string) => {
    files.set(filePath.replace(/\\/g, "/"), content);
    return { ok: true };
  });
  const readText = vi.fn(async (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const content = files.get(normalized);
    return { ok: true, exists: content !== undefined, content };
  });
  const listDir = vi.fn(async (dirPath: string) => {
    const normalizedDir = dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const entriesByName = new Map<string, boolean>();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(`${normalizedDir}/`)) continue;
      const rest = filePath.slice(normalizedDir.length + 1);
      const parts = rest.split("/");
      const name = parts[0];
      if (!name) continue;
      entriesByName.set(name, (entriesByName.get(name) ?? false) || parts.length > 1);
    }
    return {
      ok: true,
      entries: [...entriesByName.entries()].map(([name, isDirectory]) => ({ name, isDirectory })),
    };
  });
  const copyFile = vi.fn(async (sourcePath: string, destPath: string) => {
    const source = sourcePath.replace(/\\/g, "/");
    const dest = destPath.replace(/\\/g, "/");
    const content = files.get(source);
    if (content === undefined) return { ok: false, error: "missing source" };
    files.set(dest, content);
    return { ok: true };
  });
  const deleteDir = vi.fn(async (dirPath: string) => {
    const normalizedDir = dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
    deletedDirs.push(normalizedDir);
    for (const filePath of [...files.keys()]) {
      if (filePath === normalizedDir || filePath.startsWith(`${normalizedDir}/`)) {
        files.delete(filePath);
      }
    }
    return { ok: true };
  });

  (window as typeof window & { electronAPI?: unknown }).electronAPI = {
    storage: {
      getDefaultPath,
      writeText,
      readText,
      listDir,
      copyFile,
      deleteDir,
    },
  };

  return { files, deletedDirs, getDefaultPath, writeText, readText, listDir, copyFile, deleteDir };
}

describe("conversation archive", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateConversationArchiveScanCache();
    delete (window as typeof window & { electronAPI?: unknown }).electronAPI;
  });

  it("writes a full untruncated session under a project-title archive folder", async () => {
    const storage = installStorageMock();
    const session = createSession(130);

    await expect(writeConversationArchiveFull(session)).resolves.toBe(true);

    const historyPath = "C:/Storyforge/files/conversations/Contract-Marriage--project-1/chat-history.full.json";
    const manifestPath = "C:/Storyforge/files/conversations/Contract-Marriage--project-1/history-manifest.json";
    const full = JSON.parse(storage.files.get(historyPath) ?? "{}") as StudioSessionState;
    const manifest = JSON.parse(storage.files.get(manifestPath) ?? "{}") as { messageCount?: number; title?: string };

    expect(full.messages).toHaveLength(130);
    expect(full.messages[0]?.content.length).toBeGreaterThan(100);
    expect(manifest).toMatchObject({ messageCount: 130, title: "Contract Marriage" });
  });

  it("scans external legacy chat-history folders without a manual import step", async () => {
    const legacySession = createSession(4);
    installStorageMock({
      "C:/Storyforge/files/conversations/Imported-Project--imported-1/chat-history.json": JSON.stringify({
        ...legacySession,
        projectId: "imported-1",
        currentProjectSnapshot: {
          ...legacySession.currentProjectSnapshot,
          projectId: "imported-1",
          title: "Imported Project",
        },
      }),
    });

    const records = await scanConversationArchives({ refresh: true });

    expect(records).toHaveLength(1);
    expect(records[0].manifest).toMatchObject({
      projectId: "imported-1",
      title: "Imported Project",
      messageCount: 4,
    });
  });

  it("migrates an archive folder to the latest safe project title on write", async () => {
    const oldSession = createSession(2);
    const storage = installStorageMock({
      "C:/Storyforge/files/conversations/Old-Name--project-1/chat-history.full.json": JSON.stringify(oldSession),
      "C:/Storyforge/files/conversations/Old-Name--project-1/media/image.png": "image",
    });
    const renamedSession = {
      ...oldSession,
      currentProjectSnapshot: {
        ...oldSession.currentProjectSnapshot,
        title: "New Name",
      },
    };

    await expect(writeConversationArchiveFull(renamedSession)).resolves.toBe(true);

    expect(storage.copyFile).toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Old-Name--project-1/chat-history.full.json",
      "C:/Storyforge/files/conversations/New-Name--project-1/chat-history.full.json",
    );
    expect(storage.deletedDirs).toContain("C:/Storyforge/files/conversations/Old-Name--project-1");
    expect(storage.files.has("C:/Storyforge/files/conversations/New-Name--project-1/media/image.png")).toBe(true);
  });

  it("deletes every archive folder that belongs to a project id", async () => {
    const storage = installStorageMock({
      "C:/Storyforge/files/conversations/Old-Name--project-1/chat-history.full.json": JSON.stringify(createSession()),
      "C:/Storyforge/files/conversations/Other--project-2/chat-history.full.json": JSON.stringify(
        createSession(1),
      ),
    });

    await expect(deleteConversationArchive("project-1")).resolves.toBe(true);

    expect(storage.deletedDirs).toEqual(["C:/Storyforge/files/conversations/Old-Name--project-1"]);
    expect(storage.files.has("C:/Storyforge/files/conversations/Other--project-2/chat-history.full.json")).toBe(true);
  });
});
