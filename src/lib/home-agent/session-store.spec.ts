import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS } from "./image-models";
import {
  __resetSessionStoreCachesForTests,
  clearStudioSession,
  queueStudioSessionWrite,
  readStudioProjectSession,
  readStudioSession,
  removeProjectStudioSession,
  writeStudioSession,
} from "./session-store";
import type { StudioSessionState } from "./types";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "./video-models";

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";

function createSession(overrides?: Partial<StudioSessionState>): StudioSessionState {
  return {
    sessionId: "session-1",
    compactedMessageCount: 0,
    mode: "active",
    creationMode: "fast",
    automationMode: "manual",
    devMode: false,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Continue building the story plan.",
        createdAt: "2026-04-03T00:00:00.000Z",
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      },
    ],
    currentProjectSnapshot: {
      projectId: "project-1",
      projectKind: "script",
      automationMode: "manual",
      title: "Contract Marriage Reversal",
      currentObjective: "Complete the creative plan",
      derivedStage: "Creative plan",
      agentSummary: "The project is now in creative planning.",
      recommendedActions: ["Continue character design"],
      artifacts: [],
      updatedAt: undefined,
    },
    recentMessageSummary: "assistant: Continue building the story plan.",
    projectId: "project-1",
    imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
    videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
    draft: "Add a stronger villain motive",
    qState: {
      source: "restored",
      request: {
        id: "ask-1",
        description: "",
        allowCustomInput: true,
        submissionMode: "confirm",
        questions: [
          {
            header: "Genre",
            question: "Choose the genre",
            multiSelect: false,
            options: [
              { label: "Urban", value: "Urban", description: "", rationale: "" },
            ],
          },
        ],
      },
      currentIndex: 0,
      answers: {},
      displayAnswers: {},
    },
    pendingChoiceQuestion: null,
    fullAutoRun: null,
    selectedValues: ["Urban"],
    deferredQuestionState: null,
    deferredSelectedValues: [],
    deferredDraft: "",
    surfacedTaskIds: ["task-1"],
    surfacedTaskFollowupKeys: ["task-1,task-2"],
    surfacedProjectSuggestionKeys: ["project-1:creative-plan:script-project-1"],
    ...overrides,
  };
}

describe("session-store", () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    __resetSessionStoreCachesForTests();
    delete (window as typeof window & { electronAPI?: unknown }).electronAPI;
  });

  it("writes the homepage session to both global and project-scoped storage", () => {
    const session = createSession();

    writeStudioSession(session);

    expect(readStudioSession()).toEqual(session);
    expect(readStudioProjectSession("project-1")).toEqual(session);
  });

  it("strips expired signed video media from persisted session attachments", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));

    const session = createSession({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Generated a video draft.",
          createdAt: "2026-04-28T11:00:00.000Z",
          attachments: [
            {
              id: "video-1",
              fileName: "draft.mp4",
              mimeType: "video/mp4",
              size: 1024,
              kind: "video",
              previewUrl:
                "https://example.com/draft.mp4?X-Tos-Date=20260425T010000Z&X-Tos-Expires=86400",
              localPath:
                "https://example.com/draft-local.mp4?X-Tos-Date=20260425T010000Z&X-Tos-Expires=86400",
              history: [
                {
                  id: "expired-1",
                  fileName: "expired.mp4",
                  previewUrl:
                    "https://example.com/expired.mp4?X-Tos-Date=20260425T010000Z&X-Tos-Expires=86400",
                  createdAt: "2026-04-25T01:00:00.000Z",
                },
                {
                  id: "local-1",
                  fileName: "local.mp4",
                  localPath: "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\local.mp4",
                  createdAt: "2026-04-28T11:30:00.000Z",
                },
              ],
            },
          ],
          feedback: undefined,
        },
      ],
    });

    writeStudioSession(session);

    const restored = readStudioSession();
    const projectRestored = readStudioProjectSession("project-1");
    const attachment = restored?.messages[0]?.attachments?.[0];
    const projectAttachment = projectRestored?.messages[0]?.attachments?.[0];

    expect(attachment?.previewUrl).toBeUndefined();
    expect(attachment?.localPath).toBeUndefined();
    expect(attachment?.history).toEqual([
      {
        id: "local-1",
        fileName: "local.mp4",
        localPath: "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\local.mp4",
        createdAt: "2026-04-28T11:30:00.000Z",
      },
    ]);
    expect(projectAttachment).toEqual(attachment);
  });

  it("normalizes malformed stored data on read", () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        mode: "broken",
        messages: "bad",
        recentMessageSummary: 123,
        selectedValues: ["ok", 1, null],
      }),
    );

    expect(readStudioSession()).toEqual({
      sessionId: undefined,
      compactedMessageCount: 0,
      mode: "idle",
      creationMode: "fast",
      automationMode: "manual",
      devMode: false,
      messages: [],
      currentProjectSnapshot: null,
      recentMessageSummary: "",
      projectId: undefined,
      imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
      videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
      draft: "",
      qState: null,
      pendingChoiceQuestion: null,
      fullAutoRun: null,
      selectedValues: ["ok"],
      deferredQuestionState: null,
      deferredSelectedValues: [],
      deferredDraft: "",
      surfacedTaskIds: [],
      surfacedTaskFollowupKeys: [],
      surfacedProjectSuggestionKeys: [],
    });
  });

  it("migrates legacy agentControlMode into creationMode and devMode", () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        mode: "active",
        messages: [],
        agentControlMode: "script-dev",
      }),
    );

    expect(readStudioSession()).toMatchObject({
      creationMode: "fast",
      devMode: true,
    });
  });

  it("keeps project-scoped sessions available when clearing only the active homepage session", () => {
    const session = createSession();
    writeStudioSession(session);

    clearStudioSession();

    expect(readStudioSession()).toBeNull();
    expect(readStudioProjectSession("project-1")).toEqual(session);
  });

  it("ignores invalid project-scoped session entries while preserving valid ones", () => {
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        valid: createSession({ projectId: "valid" }),
        invalid: "bad",
      }),
    );

    expect(readStudioProjectSession("valid")?.projectId).toBe("valid");
    expect(readStudioProjectSession("invalid")).toBeNull();
  });

  it("compacts oversized sessions before persisting them", () => {
    const largeText = "Long content ".repeat(1600);
    const session = createSession({
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        content: `${index}-${largeText}`,
        createdAt: "2026-04-03T00:00:00.000Z",
      })),
      currentProjectSnapshot: {
        ...createSession().currentProjectSnapshot,
        artifacts: Array.from({ length: 14 }, (_, index) => ({
          id: `artifact-${index}`,
          kind: "plan" as const,
          label: `Artifact ${index}`,
          summary: largeText,
          content: largeText,
          updatedAt: "2026-04-03T00:00:00.000Z",
        })),
        memory: {
          assetManifest: {
            version: "1",
            items: Array.from({ length: 40 }, (_, index) => ({
              id: `asset-${index}`,
              kind: "character-sheet" as const,
              label: `Character ${index}`,
              url: `file:///C:/tmp/asset-${index}.jpg`,
              meta: largeText,
              reusable: true,
              status: "ready" as const,
            })),
          },
        },
      },
      recentMessageSummary: largeText,
      draft: largeText,
    });

    writeStudioSession(session);

    const restored = readStudioSession();
    expect(restored).not.toBeNull();
    expect(restored?.messages.length).toBeLessThanOrEqual(40);
    expect(restored?.messages.at(-1)?.content.length ?? 0).toBeLessThanOrEqual(3200);
    expect(restored?.currentProjectSnapshot?.artifacts.length).toBeLessThanOrEqual(10);
    expect(restored?.currentProjectSnapshot?.memory).toBeUndefined();
    expect(restored?.recentMessageSummary.length ?? 0).toBeLessThanOrEqual(3200);
    expect(restored?.draft.length ?? 0).toBeLessThanOrEqual(2400);
  });

  it("retries with a smaller payload when storage quota is exceeded", () => {
    const originalSetItem = Storage.prototype.setItem;
    const quotaError = new DOMException("quota", "QuotaExceededError");
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === STUDIO_SESSION_KEY && value.length > 20000) {
          throw quotaError;
        }
        return originalSetItem.call(this, key, value);
      });

    const hugeSession = createSession({
      messages: Array.from({ length: 18 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        content: "Expanded content ".repeat(900),
        createdAt: "2026-04-03T00:00:00.000Z",
      })),
      recentMessageSummary: "Summary ".repeat(4000),
      draft: "Draft ".repeat(2400),
    });

    expect(() => writeStudioSession(hugeSession)).not.toThrow();
    __resetSessionStoreCachesForTests();

    const restored = readStudioSession();
    expect(restored).not.toBeNull();
    expect(restored?.messages.length).toBeGreaterThan(0);
    expect(restored?.draft).not.toBe("");
    expect(restored?.recentMessageSummary.length ?? 0).toBeLessThanOrEqual(1000);
    expect(restored?.draft.length ?? 0).toBeLessThanOrEqual(400);
    expect(spy).toHaveBeenCalled();
  });

  it("writes the debounced session snapshot to the file backup layer", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    const getDefaultPath = vi.fn().mockResolvedValue({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" });
    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      storage: {
        getDefaultPath,
        writeText,
      },
    };

    queueStudioSessionWrite(createSession(), 10);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(getDefaultPath).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Contract-Marriage-Reversal--project-1/chat-history.full.json",
      expect.stringContaining("\"projectId\": \"project-1\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Contract-Marriage-Reversal--project-1/history-manifest.json",
      expect.stringContaining("\"messageCount\": 1"),
    );
    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/db/sessions/project-1.json",
      expect.stringContaining("\"projectId\":\"project-1\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/db/sessions/_last.json",
      expect.stringContaining("\"projectId\":\"project-1\""),
    );
  });

  it("does not resurrect a deleted project from the debounced backup queue", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    const getDefaultPath = vi.fn().mockResolvedValue({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" });
    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      storage: {
        getDefaultPath,
        writeText,
      },
    };

    queueStudioSessionWrite(createSession(), 10);
    removeProjectStudioSession("project-1");
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(readStudioProjectSession("project-1")).toBeNull();
    expect(localStorage.getItem(STUDIO_PROJECT_SESSIONS_KEY)).toBe("{}");
    expect(writeText).not.toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Contract-Marriage-Reversal--project-1/chat-history.full.json",
      expect.any(String),
    );
    expect(writeText).not.toHaveBeenCalledWith(
      "C:/Storyforge/db/sessions/project-1.json",
      expect.stringContaining("\"projectId\":\"project-1\""),
    );
    expect(writeText).not.toHaveBeenCalledWith(
      "C:/Storyforge/db/sessions/_last.json",
      expect.stringContaining("\"projectId\":\"project-1\""),
    );
  });
});
