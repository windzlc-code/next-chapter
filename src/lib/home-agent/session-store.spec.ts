import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS } from "./image-models";
import { buildStoryboardBreakdownMessage } from "./storyboard-breakdown";
import {
  __resetSessionStoreCachesForTests,
  clearStudioSession,
  queueStudioSessionWrite,
  readProjectSessionFromFile,
  readStudioProjectSession,
  readStudioSession,
  readStudioSessionBootstrap,
  removeProjectStudioSession,
  writeStudioSession,
  writeProjectStudioSession,
} from "./session-store";
import type { StudioSessionState } from "./types";
import { DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS } from "./video-models";
import type { Scene } from "@/types/project";

const STUDIO_SESSION_KEY = "storyforge-home-agent-session-v1";
const STUDIO_SESSION_BOOTSTRAP_KEY = "storyforge-home-agent-session-bootstrap-v1";
const STUDIO_PROJECT_SESSIONS_KEY = "storyforge-home-agent-project-sessions-v1";

function createSession(overrides?: Partial<StudioSessionState>): StudioSessionState {
  return {
    sessionId: "session-1",
    compactedMessageCount: 0,
    mode: "active",
    creationMode: "fast",
    automationMode: "manual",
    devMode: false,
    suppressHistoricalMemory: false,
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
      sourceProjectId: undefined,
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
    pendingWorkflowUploadKind: null,
    interruptedChoiceQuestion: null,
    fullAutoRun: null,
    fullAutoChecklistCollapsed: true,
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

function createLargeStoryboardMessage(): string {
  const scenes: Scene[] = Array.from({ length: 12 }, (_, index) => ({
    id: `scene-${index + 1}`,
    sceneNumber: index + 1,
    sceneName: "深夜食堂",
    description: `镜头 ${index + 1}：${"暴雨夜霓虹与人物动作交织，".repeat(14)}`,
    characters: ["苏暖", "陆沉渊"],
    dialogue: index % 2 === 0 ? `苏暖：${"你终于来了。".repeat(6)}` : "",
    cameraDirection: "缓慢推进并保持压迫感",
    duration: 5,
    segmentLabel: `1-${Math.floor(index / 3) + 1}`,
  }));

  return buildStoryboardBreakdownMessage({
    title: "测试项目",
    scenes,
    characters: [],
    sceneSettings: [],
  });
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

  it("persists a lightweight bootstrap cache alongside the active session", () => {
    const session = createSession({
      messages: Array.from({ length: 18 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        content: `Message ${index} ${"x".repeat(220)}`,
        createdAt: "2026-04-03T00:00:00.000Z",
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      })),
      currentProjectSnapshot: {
        ...createSession().currentProjectSnapshot!,
        artifacts: Array.from({ length: 7 }, (_, index) => ({
          id: `artifact-${index}`,
          kind: "script" as const,
          label: `Artifact ${index}`,
          summary: `Summary ${index}`,
          content: `Content ${index}`,
          updatedAt: "2026-04-03T00:00:00.000Z",
        })),
      },
    });

    writeStudioSession(session);

    const bootstrap = JSON.parse(localStorage.getItem(STUDIO_SESSION_BOOTSTRAP_KEY) ?? "null");
    expect(bootstrap?.rawMessageCount).toBe(18);
    expect(bootstrap?.rawArtifactCount).toBe(7);
    expect(Array.isArray(bootstrap?.session?.messages)).toBe(true);
    expect(bootstrap.session.messages).toHaveLength(12);
    expect(bootstrap.session.currentProjectSnapshot.artifacts).toHaveLength(4);
  });

  it("keeps a larger in-browser message window for the active and project-scoped session caches", () => {
    const session = createSession({
      messages: Array.from({ length: 220 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        content: `History message ${index} ${"z".repeat(80)}`,
        createdAt: `2026-04-03T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      })),
    });

    writeStudioSession(session);

    const storedSession = JSON.parse(localStorage.getItem(STUDIO_SESSION_KEY) ?? "null");
    const storedProjectSessions = JSON.parse(localStorage.getItem(STUDIO_PROJECT_SESSIONS_KEY) ?? "null");
    expect(storedSession?.messages).toHaveLength(180);
    expect(storedProjectSessions?.["project-1"]?.messages).toHaveLength(180);
    expect(storedSession.messages[0]?.content).toContain("History message 40");
  });

  it("keeps a compact asset manifest in the bootstrap cache for resource recovery", () => {
    const baseSnapshot = createSession().currentProjectSnapshot!;
    const session = createSession({
      projectId: "video-project-1",
      currentProjectSnapshot: {
        ...baseSnapshot,
        projectId: "video-project-1",
        projectKind: "video",
        memory: {
          assetManifest: {
            version: "1",
            summary: "Generated assets",
            items: Array.from({ length: 10 }, (_, index) => ({
              id: `asset-${index}`,
              kind: index % 2 === 0 ? "character-reference" : "video-segment",
              label: `Asset ${index}`,
              url: `https://example.com/asset-${index}.${index % 2 === 0 ? "jpg" : "mp4"}`,
              meta: `Generated asset ${index}`,
              reusable: index % 2 === 0,
              status: "ready" as const,
              source: index % 2 === 0 ? "image-generator" : "segment-video",
              sourceEntityId: `segment-${index}`,
              version: 1,
              createdAt: "2026-04-03T00:00:00.000Z",
            })),
          },
        },
      },
    });

    writeStudioSession(session);

    const restored = readStudioSessionBootstrap();
    const bootstrap = JSON.parse(localStorage.getItem(STUDIO_SESSION_BOOTSTRAP_KEY) ?? "null");
    expect(bootstrap?.rawAssetManifestCount).toBe(10);
    expect(restored.session?.currentProjectSnapshot?.memory?.assetManifest?.items.length).toBeGreaterThan(0);
    expect(restored.session?.currentProjectSnapshot?.memory?.assetManifest?.items.length).toBeLessThanOrEqual(6);
    expect(restored.needsHydration).toBe(true);
    expect(restored.session?.currentProjectSnapshot?.memory?.assetManifest?.items.at(-1)).toMatchObject({
      id: "asset-9",
      kind: "video-segment",
      source: "segment-video",
      sourceEntityId: "segment-9",
    });
  });

  it("restores the startup seed from the bootstrap cache without parsing the full session payload", () => {
    const session = createSession({
      messages: Array.from({ length: 16 }, (_, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        content: `Long bootstrap message ${index} ${"y".repeat(240)}`,
        createdAt: "2026-04-03T00:00:00.000Z",
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      })),
    });

    writeStudioSession(session);
    localStorage.setItem(STUDIO_SESSION_KEY, "{broken json");
    __resetSessionStoreCachesForTests();

    const restored = readStudioSessionBootstrap();

    expect(restored.session?.projectId).toBe("project-1");
    expect(restored.session?.messages).toHaveLength(12);
    expect(restored.needsHydration).toBe(true);
  });

  it("preserves storyboard breakdown messages in the bootstrap cache without truncating the fenced json block", () => {
    const storyboardContent = createLargeStoryboardMessage();
    expect(storyboardContent.length).toBeGreaterThan(900);

    const session = createSession({
      messages: [
        {
          id: "assistant-storyboard",
          role: "assistant",
          content: storyboardContent,
          createdAt: "2026-04-03T00:00:00.000Z",
          attachments: undefined,
          artifactSnapshots: undefined,
          feedback: undefined,
        },
      ],
    });

    writeStudioSession(session);

    const restored = readStudioSessionBootstrap();
    expect(restored.session?.messages[0]?.content).toBe(storyboardContent.trim());
    expect(restored.session?.messages[0]?.content).toContain("```json");
    expect(restored.session?.messages[0]?.content).toContain("```");
  });

  it("preserves storyboard breakdown messages in the active session cache without truncating the fenced json block", () => {
    const storyboardContent = createLargeStoryboardMessage();
    expect(storyboardContent.length).toBeGreaterThan(3200);

    const session = createSession({
      messages: [
        {
          id: "assistant-storyboard",
          role: "assistant",
          content: storyboardContent,
          createdAt: "2026-04-03T00:00:00.000Z",
          attachments: undefined,
          artifactSnapshots: undefined,
          feedback: undefined,
        },
      ],
    });

    writeStudioSession(session);

    const restored = readStudioSession();
    expect(restored?.messages[0]?.content).toBe(storyboardContent.trim());
    expect(restored?.messages[0]?.content).toContain("```json");
    expect(restored?.messages[0]?.content.endsWith("```")).toBe(true);
  });

  it("persists the full-auto checklist collapsed state with the project session", () => {
    const session = createSession({
      automationMode: "full-auto",
      fullAutoChecklistCollapsed: false,
    });

    writeStudioSession(session);

    expect(readStudioSession()?.fullAutoChecklistCollapsed).toBe(false);
    expect(readStudioProjectSession("project-1")?.fullAutoChecklistCollapsed).toBe(false);
  });

  it("drops a mismatched project snapshot from project-scoped session storage", () => {
    localStorage.setItem(
      STUDIO_PROJECT_SESSIONS_KEY,
      JSON.stringify({
        "project-2": createSession({
          projectId: "project-2",
          messages: [
            {
              id: "assistant-2",
              role: "assistant",
              content: "Restore the mecha workflow.",
              createdAt: "2026-05-07T07:00:00.000Z",
              attachments: undefined,
              artifactSnapshots: undefined,
              feedback: undefined,
            },
          ],
          currentProjectSnapshot: {
            ...(createSession().currentProjectSnapshot ?? {
              projectId: "project-1",
              projectKind: "script",
              automationMode: "manual",
              title: "wrong snapshot",
              currentObjective: "",
              derivedStage: "",
              agentSummary: "",
              recommendedActions: [],
              artifacts: [],
            }),
            projectId: "project-1",
            title: "wrong snapshot",
          },
        }),
      }),
    );

    const restored = readStudioProjectSession("project-2");

    expect(restored?.projectId).toBe("project-2");
    expect(restored?.currentProjectSnapshot).toBeNull();
    expect(restored?.messages[0]?.content).toBe("Restore the mecha workflow.");
  });

  it("keeps a bridged video snapshot on the source script session", () => {
    const bridgedSession = createSession({
      projectId: "script-project-bridge",
      currentProjectSnapshot: {
        ...(createSession().currentProjectSnapshot ?? {
          projectId: "video-project-bridge",
          projectKind: "video",
          automationMode: "manual",
          title: "Bridge Snapshot",
          currentObjective: "",
          derivedStage: "",
          agentSummary: "",
          recommendedActions: [],
          artifacts: [],
        }),
        projectId: "video-project-bridge",
        projectKind: "video",
        sourceProjectId: "script-project-bridge",
        title: "Bridge Snapshot",
      },
    });

    writeStudioSession(bridgedSession);

    expect(readStudioSession()?.projectId).toBe("script-project-bridge");
    expect(readStudioSession()?.currentProjectSnapshot?.projectId).toBe("video-project-bridge");
    expect(readStudioProjectSession("script-project-bridge")?.currentProjectSnapshot).toMatchObject({
      projectId: "video-project-bridge",
      projectKind: "video",
      sourceProjectId: "script-project-bridge",
    });
  });

  it("persists interrupted workflow questions for natural-language resume", () => {
    const interruptedChoiceQuestion = {
      id: "script-characters-project-1",
      title: "Resume character design",
      options: [
        {
          id: "resume-characters",
          label: "Resume character design",
          value: "script:step-enter-characters",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "script-characters",
    };
    const session = createSession({
      interruptedChoiceQuestion,
    });

    writeStudioSession(session);

    expect(readStudioSession()?.interruptedChoiceQuestion).toMatchObject(interruptedChoiceQuestion);
    expect(readStudioProjectSession("project-1")?.interruptedChoiceQuestion).toMatchObject(interruptedChoiceQuestion);
  });

  it("prefers a newer interrupted video bridge panel over a stale pending one during restore", () => {
    const stalePendingChoiceQuestion = {
      id: "video-bridge-stale",
      title: "《未命名视频项目》正在完成脚本拆解",
      options: [
        {
          id: "video-bridge-entities",
          label: "提取角色与场景",
          value: "video:bridge:entities",
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-bridge-panel",
    };
    const interruptedChoiceQuestion = {
      id: "video-bridge-fresh",
      title: "《未命名视频项目》正在补角色与场景",
      options: [
        {
          id: "video-panel-bulk",
          label: "批量执行",
          value: "video:panel:video-bridge-panel-bulk",
          children: [
            {
              id: "reference-assets-full",
              label: "智能补图 剩余3（本轮3）",
              value: "video:bridge:reference-assets:full",
            },
          ],
        },
      ],
      allowCustomInput: true,
      submissionMode: "immediate" as const,
      multiSelect: false,
      stepIndex: 0,
      totalSteps: 1,
      answerKey: "video-bridge-panel",
      statusBadges: [
        { label: "角色", value: "2", tone: "success" as const },
        { label: "场景", value: "1", tone: "success" as const },
        { label: "缺参考图", value: "3", tone: "warning" as const },
      ],
    };
    const staleSession = createSession({
      pendingChoiceQuestion: stalePendingChoiceQuestion,
      interruptedChoiceQuestion,
    });

    localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(staleSession));
    localStorage.setItem(STUDIO_PROJECT_SESSIONS_KEY, JSON.stringify({ "project-1": staleSession }));
    localStorage.setItem(
      STUDIO_SESSION_BOOTSTRAP_KEY,
      JSON.stringify({
        version: 1,
        session: staleSession,
        rawMessageCount: staleSession.messages.length,
        rawArtifactCount: staleSession.currentProjectSnapshot?.artifacts.length ?? 0,
        rawAssetManifestCount: staleSession.currentProjectSnapshot?.memory?.assetManifest?.items.length ?? 0,
      }),
    );

    expect(readStudioSession()?.pendingChoiceQuestion).toMatchObject(interruptedChoiceQuestion);
    expect(readStudioProjectSession("project-1")?.pendingChoiceQuestion).toMatchObject(interruptedChoiceQuestion);
    expect(readStudioSessionBootstrap().session?.pendingChoiceQuestion).toMatchObject(interruptedChoiceQuestion);
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
        label: undefined,
        localPath: "D:\\StoryForgeFiles\\projects\\project-1\\media\\videos\\local.mp4",
        previewUrl: "file:///D:/StoryForgeFiles/projects/project-1/media/videos/local.mp4",
        createdAt: "2026-04-28T11:30:00.000Z",
      },
    ]);
    expect(projectAttachment).toEqual(attachment);
  });

  it("rewrites inline media previews to file urls before writing file backups", async () => {
    const inlinePreview = `data:image/jpeg;base64,${"a".repeat(4000)}`;
    const localPath = "D:\\StoryForgeFiles\\projects\\project-1\\media\\images\\generated\\still.jpg";
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    const getDefaultPath = vi.fn().mockResolvedValue({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" });
    const listDir = vi.fn().mockResolvedValue({ ok: true, entries: [] });
    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      storage: {
        getDefaultPath,
        listDir,
        writeText,
      },
    };

    writeStudioSession(
      createSession({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "Generated a reference image.",
            createdAt: "2026-04-28T11:00:00.000Z",
            attachments: [
              {
                id: "image-1",
                fileName: "still.jpg",
                mimeType: "image/jpeg",
                size: 1024,
                kind: "image",
                localPath,
                previewUrl: inlinePreview,
              },
            ],
            feedback: undefined,
          },
        ],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const dbWrite = writeText.mock.calls.find(
      ([filePath]) =>
        String(filePath).endsWith("/project-1.json") || String(filePath).endsWith("\\project-1.json"),
    );
    expect(dbWrite).toBeTruthy();
    expect(dbWrite?.[1]).toContain("file:///D:/StoryForgeFiles/projects/project-1/media/images/generated/still.jpg");
    expect(dbWrite?.[1]).not.toContain("data:image/jpeg;base64");
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
      suppressHistoricalMemory: true,
      messages: [],
      currentProjectSnapshot: null,
      recentMessageSummary: "",
      projectId: undefined,
      imageGenerationPrefs: DEFAULT_HOME_AGENT_IMAGE_GENERATION_PREFS,
      videoGenerationPrefs: DEFAULT_HOME_AGENT_VIDEO_GENERATION_PREFS,
      draft: "",
      qState: null,
      pendingChoiceQuestion: null,
      pendingWorkflowUploadKind: null,
      interruptedChoiceQuestion: null,
      fullAutoRun: null,
      fullAutoChecklistCollapsed: true,
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

  it("upgrades a manual-tagged session to full-auto when the message history contains full-auto lineage", () => {
    localStorage.setItem(
      STUDIO_SESSION_KEY,
      JSON.stringify({
        ...createSession({
          automationMode: "manual",
          currentProjectSnapshot: {
            ...(createSession().currentProjectSnapshot ?? {
              projectId: "project-1",
              projectKind: "script",
              automationMode: "manual",
              title: "Contract Marriage Reversal",
              currentObjective: "",
              derivedStage: "",
              agentSummary: "",
              recommendedActions: [],
              artifacts: [],
            }),
            automationMode: "manual",
          },
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "已切换为全自动原创剧本。请先一次性确认立项参数；确认完毕后我会代替用户连续发送指令并自动执行到视频导出。",
              createdAt: "2026-05-10T18:00:00.000Z",
            },
            {
              id: "user-1",
              role: "user",
              content: "生成创作方案",
              createdAt: "2026-05-10T18:00:01.000Z",
              automationOrigin: "full-auto",
            },
          ],
        }),
      }),
    );

    expect(readStudioSession()).toMatchObject({
      automationMode: "full-auto",
      currentProjectSnapshot: expect.objectContaining({
        automationMode: "full-auto",
      }),
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
    expect(restored?.currentProjectSnapshot?.memory?.assetManifest?.items.length).toBeGreaterThan(0);
    expect(restored?.currentProjectSnapshot?.memory?.assetManifest?.items.length).toBeLessThanOrEqual(32);
    expect(restored?.currentProjectSnapshot?.memory?.assetManifest?.items.at(-1)).toMatchObject({
      id: "asset-39",
      kind: "character-sheet",
      url: "file:///C:/tmp/asset-39.jpg",
    });
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

  it("falls back to an emergency bootstrap snapshot when the bootstrap cache exceeds quota", () => {
    const originalSetItem = Storage.prototype.setItem;
    const quotaError = new DOMException("quota", "QuotaExceededError");
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === STUDIO_SESSION_BOOTSTRAP_KEY && value.length > 9000) {
          throw quotaError;
        }
        return originalSetItem.call(this, key, value);
      });

    const session = createSession({
      messages: Array.from({ length: 18 }, (_, index) => ({
        id: `bootstrap-message-${index}`,
        role: "assistant" as const,
        content: `Bootstrap content ${index} ${"z".repeat(1800)}`,
        createdAt: "2026-04-03T00:00:00.000Z",
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      })),
      currentProjectSnapshot: {
        ...createSession().currentProjectSnapshot!,
        recommendedActions: Array.from({ length: 8 }, (_, index) => `Action ${index} ${"w".repeat(240)}`),
        artifacts: Array.from({ length: 6 }, (_, index) => ({
          id: `artifact-${index}`,
          kind: "script" as const,
          label: `Artifact ${index}`,
          summary: `Summary ${"m".repeat(600)}`,
          content: `Content ${"n".repeat(1200)}`,
          updatedAt: "2026-04-03T00:00:00.000Z",
        })),
      },
      recentMessageSummary: "Summary ".repeat(4000),
      draft: "Draft ".repeat(2400),
    });

    expect(() => writeStudioSession(session)).not.toThrow();

    const bootstrap = JSON.parse(localStorage.getItem(STUDIO_SESSION_BOOTSTRAP_KEY) ?? "null");
    expect(bootstrap).not.toBeNull();
    expect(bootstrap.session.messages.length).toBeLessThanOrEqual(4);
    expect(bootstrap.session.currentProjectSnapshot.artifacts.length).toBeLessThanOrEqual(1);
    expect(bootstrap.session.recentMessageSummary.length).toBeLessThanOrEqual(240);
    expect(bootstrap.session.draft.length).toBeLessThanOrEqual(160);
    expect(spy).toHaveBeenCalled();
  });

  it("does not throw when bootstrap cache still cannot be written after fallback", () => {
    const originalSetItem = Storage.prototype.setItem;
    const quotaError = new DOMException("quota", "QuotaExceededError");
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === STUDIO_SESSION_BOOTSTRAP_KEY) {
          throw quotaError;
        }
        return originalSetItem.call(this, key, value);
      });

    const session = createSession({
      messages: Array.from({ length: 14 }, (_, index) => ({
        id: `message-${index}`,
        role: "assistant" as const,
        content: `Persistent message ${index} ${"q".repeat(1200)}`,
        createdAt: "2026-04-03T00:00:00.000Z",
        attachments: undefined,
        artifactSnapshots: undefined,
        feedback: undefined,
      })),
    });

    expect(() => writeStudioSession(session)).not.toThrow();
    expect(localStorage.getItem(STUDIO_SESSION_BOOTSTRAP_KEY)).toBeNull();
    expect(readStudioSession()?.projectId).toBe("project-1");
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

  it("sanitizes bloated inline image previews when restoring a project session from file", async () => {
    const inlinePreview = `data:image/jpeg;base64,${"b".repeat(4000)}`;
    const localPath = "D:\\StoryForgeFiles\\projects\\project-1\\media\\images\\generated\\restored.jpg";
    const rawSession = createSession({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "Restored an image-heavy session.",
          createdAt: "2026-04-28T11:00:00.000Z",
          attachments: [
            {
              id: "image-1",
              fileName: "restored.jpg",
              mimeType: "image/jpeg",
              size: 2048,
              kind: "image",
              localPath,
              previewUrl: inlinePreview,
            },
          ],
          feedback: undefined,
        },
      ],
    });
    const readText = vi.fn(async (filePath: string) => {
      if (filePath === "C:/Storyforge/db/sessions/project-1.json") {
        return { ok: true, exists: true, content: JSON.stringify(rawSession) };
      }
      return { ok: false, exists: false, content: null };
    });
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    const getDefaultPath = vi.fn().mockResolvedValue({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" });
    const listDir = vi.fn().mockResolvedValue({ ok: true, entries: [] });
    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      storage: {
        getDefaultPath,
        listDir,
        readText,
        writeText,
      },
    };

    const restored = await readProjectSessionFromFile("project-1");

    expect(restored?.messages[0]?.attachments?.[0]?.previewUrl).toBe(
      "file:///D:/StoryForgeFiles/projects/project-1/media/images/generated/restored.jpg",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rewrittenSession = writeText.mock.calls.find(
      ([filePath]) =>
        String(filePath).endsWith("/project-1.json") || String(filePath).endsWith("\\project-1.json"),
    );
    expect(rewrittenSession).toBeTruthy();
    expect(rewrittenSession?.[1]).toContain(
      "file:///D:/StoryForgeFiles/projects/project-1/media/images/generated/restored.jpg",
    );
    expect(rewrittenSession?.[1]).not.toContain("data:image/jpeg;base64");
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

  it("backfills a missing conversation archive when restoring a db-only project session", async () => {
    const dbOnlySession = createSession({
      recentMessageSummary: "Recovered from the db session backup only.",
    });
    const readText = vi.fn(async (filePath: string) => {
      if (filePath === "C:/Storyforge/db/sessions/project-1.json") {
        return { ok: true, exists: true, content: JSON.stringify(dbOnlySession) };
      }
      return { ok: true, exists: false, content: "" };
    });
    const writeText = vi.fn().mockResolvedValue({ ok: true });
    const getDefaultPath = vi.fn().mockResolvedValue({ files: "C:/Storyforge/files", db: "C:/Storyforge/db" });
    const listDir = vi.fn(async (dirPath: string) => {
      if (dirPath === "C:/Storyforge/files/conversations") {
        return { ok: true, entries: [] };
      }
      return { ok: true, entries: [] };
    });
    (window as typeof window & { electronAPI?: unknown }).electronAPI = {
      storage: {
        getDefaultPath,
        listDir,
        readText,
        writeText,
      },
    };

    const restored = await readProjectSessionFromFile("project-1");

    expect(restored?.projectId).toBe("project-1");

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Contract-Marriage-Reversal--project-1/chat-history.full.json",
      expect.stringContaining("\"projectId\": \"project-1\""),
    );
    expect(writeText).toHaveBeenCalledWith(
      "C:/Storyforge/files/conversations/Contract-Marriage-Reversal--project-1/history-manifest.json",
      expect.stringContaining("\"projectId\": \"project-1\""),
    );
  });

  it("clears the global active session cache when deleting the active project", () => {
    const session = createSession();
    writeStudioSession(session);

    removeProjectStudioSession("project-1");
    __resetSessionStoreCachesForTests();

    expect(localStorage.getItem(STUDIO_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(STUDIO_SESSION_BOOTSTRAP_KEY)).toBeNull();
    expect(readStudioSession()).toBeNull();
    expect(readStudioSessionBootstrap()).toEqual({
      session: null,
      needsHydration: false,
    });
  });

  it("does not allow project-only writes to revive a reset-marked session", async () => {
    const session = createSession();
    writeStudioSession(session);
    removeProjectStudioSession("project-1");

    await writeProjectStudioSession(session);
    __resetSessionStoreCachesForTests();

    expect(readStudioProjectSession("project-1")).toBeNull();
    expect(readStudioSession()).toBeNull();
  });
});
